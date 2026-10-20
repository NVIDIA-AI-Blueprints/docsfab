#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Ratchet keyword and regex decisions over operator request text.
 *
 * Request wording may only narrow authority. Writes, targets, and routes come
 * from the declared workflow, `do` routing, flags, or an admitted request
 * intent. This check fails when product code adds a wording decision over a
 * request subject that is neither a baselined existing site nor an allowlisted
 * narrowing guard or kept-by-decision route. The baseline can only shrink:
 * removing a site without removing its entry fails as stale.
 *
 * Detection (one TypeScript program over SCAN_ROOTS, same-file resolution):
 * - Subject: an identifier named in SUBJECT_NAMES, a member read whose final
 *   name is in SUBJECT_NAMES, or a SEED_PARAMETERS parameter. A member read of
 *   any other name is not a subject, so `request.workflow === "x"` (declared
 *   structure) stays clean.
 * - Taint: results of string and array methods on a subject, indexed reads,
 *   concatenation, same-file helper parameters and results, array-method
 *   callback parameters, for-of bindings, array-destructured bindings, and
 *   parameters of same-file object or class methods reached by name
 *   (`route.match(text)` reaches every `match:` arrow in the file).
 * - Static pattern: a regex or string literal, `new RegExp(<static>)`, a
 *   `String.raw` or template composition of static parts, a same-file const or
 *   const array, Set, Map, or object of those, a const built by a same-file
 *   call with static arguments, and a loop or callback variable over a
 *   same-file const lexicon. `new RegExp(X.source, …)` is an alias of `X`.
 * - Wording: a pattern is wording only if its decoded literal content holds a
 *   letter (`\p{L}`). Shorthand escapes are not letters; `\uXXXX` and `\xXX`
 *   count as the character they encode. Letter-free calls only propagate taint.
 * - Site: `P.test|exec(s)`, `s.match|matchAll|search|replace|replaceAll|split(P)`,
 *   `s.includes|startsWith|endsWith|indexOf|lastIndexOf(P)`, `===`/`!==`/`==`/`!=`
 *   in either order, `switch (s) { case P }`, and `C.has|get|includes|indexOf(s)`
 *   for a static collection `C`, where `s` is tainted and `P` is wording.
 * - Not a site: dynamic needles (`instruction.includes(quote)`), letter-free
 *   patterns, and files under test or fixture paths.
 * - Fingerprint: `path|function|pattern`, counted as a multiset, with no line
 *   numbers. A named const is `NAME#<sha256>` over its syntax tree, with
 *   referenced same-file consts and functions folded in by their own digests,
 *   so reformatting is stable and extending a lexicon in place is a new site.
 *
 * Known limits: taint and pattern resolution stop at file boundaries (an
 * imported lexicon or helper is not followed); object-rest and computed-key
 * destructuring do not carry taint; computed property names and patterns built
 * from configuration or other dynamic values are not resolved; a pattern held
 * in `let`, a class static, or a conditional expression is not static; text
 * carried through `new Set`/`new Map`, an object literal, `localeCompare`, or
 * `fn.call` is not tainted; `Object.values(LEXICON)` is not a lexicon; subject
 * names outside SUBJECT_NAMES (`prompt`, `operatorRequest`) are unseen by
 * design; `packages/host` is not scanned; and a hand-added baseline entry is
 * caught only in review.
 * The runtime CI rules trigger on every path `requestWordingCiPathPatterns`
 * (request-wording-scan-roots.mjs) names, so an MR that changes only a scan
 * root outside `packages/runtime` still runs this check before it merges.
 *
 * Usage: node scripts/check-request-wording.mjs --check
 *        [--repo-root <dir>] [--baseline <file>]
 */

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";

import { SCAN_ROOTS } from "./request-wording-scan-roots.mjs";

const scriptPath = fileURLToPath(import.meta.url);
const packageRoot = dirname(dirname(scriptPath));
const DEFAULT_REPO_ROOT = dirname(dirname(packageRoot));
const DEFAULT_BASELINE = join(packageRoot, "scripts", "request-wording-baseline.json");

/** Re-exported so callers that run the check need one import. */
export { SCAN_ROOTS };

/**
 * Names that carry operator request text. The list is closed so a new
 * carrier name is a reviewed edit here, not a silent widening by a heuristic.
 */
export const SUBJECT_NAMES = Object.freeze(["instruction", "request", "requestText"]);

/**
 * Generically named parameters that carry request text. Matching is by path,
 * function, and parameter together, because a name-wide `outcome` would flag
 * unrelated record fields.
 */
export const SEED_PARAMETERS = Object.freeze([
  Object.freeze({
    path: "packages/runtime/src/cli/commands/do-delegated.ts",
    function: "parseDelegatedRequestedChecks",
    parameter: "outcome",
  }),
  Object.freeze({
    path: "packages/runtime/src/cli/commands/do-delegated.ts",
    function: "deriveDelegatedPauseTargets",
    parameter: "outcome",
  }),
]);

export const CODES = Object.freeze({
  newSite: "request-wording-new-site",
  stale: "request-wording-baseline-stale",
  baselineInvalid: "request-wording-baseline-invalid",
  rootMissing: "request-wording-root-missing",
  allowlistInvalid: "request-wording-allowlist-invalid",
  usage: "request-wording-usage",
});

export const ALLOWLIST_CATEGORIES = Object.freeze(["narrowing", "kept-by-decision"]);

const REMEDIATION =
  "Derive this from the admitted request intent, the declared workflow, `do` routing, or flags; a narrowing guard needs an allowlist entry with category and rationale.";

// Process exit statuses: plumbing, not bounds.
const EXIT_OK = 0;
const EXIT_FINDINGS = 1;
const EXIT_REFUSED = 2;

const SOURCE_EXTENSIONS = [".ts", ".mts", ".cts", ".tsx", ".js", ".mjs", ".cjs", ".jsx"];
const DECLARATION_SUFFIXES = [".d.ts", ".d.mts", ".d.cts"];
const EXCLUDED_DIRECTORIES = new Set(["test", "tests", "fixtures", "__fixtures__", "node_modules"]);

// Modifier letters (`\p{Lm}`, such as U+02BC) are apostrophes and diacritics,
// not words, so an apostrophe fold is not wording.
const LETTER = /[\p{Lu}\p{Ll}\p{Lt}\p{Lo}]/u;
const subjectNames = new Set(SUBJECT_NAMES);

/** String and array methods whose result carries the receiver's text. */
const PROPAGATING_METHODS = new Set([
  "at",
  "charAt",
  "concat",
  "exec",
  "filter",
  "find",
  "findLast",
  "flat",
  "flatMap",
  "join",
  "map",
  "match",
  "matchAll",
  "normalize",
  "padEnd",
  "padStart",
  "repeat",
  "replace",
  "replaceAll",
  "reverse",
  "slice",
  "sort",
  "split",
  "substr",
  "substring",
  "toLocaleLowerCase",
  "toLocaleUpperCase",
  "toLowerCase",
  "toReversed",
  "toSorted",
  "toString",
  "toUpperCase",
  "trim",
  "trimEnd",
  "trimStart",
  "valueOf",
]);

/** Array methods whose callback receives elements of the receiver. */
const CALLBACK_METHODS = new Set([
  "every",
  "filter",
  "find",
  "findIndex",
  "findLast",
  "findLastIndex",
  "flatMap",
  "forEach",
  "map",
  "reduce",
  "reduceRight",
  "some",
]);

const REGEX_RECEIVER_SINKS = new Set(["test", "exec"]);
const PATTERN_ARGUMENT_SINKS = new Set([
  "match",
  "matchAll",
  "search",
  "replace",
  "replaceAll",
  "split",
  "includes",
  "startsWith",
  "endsWith",
  "indexOf",
  "lastIndexOf",
]);
const COLLECTION_SINKS = new Set(["has", "get", "includes", "indexOf", "lastIndexOf"]);
const EQUALITY_OPERATORS = new Set([
  ts.SyntaxKind.EqualsEqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsEqualsToken,
  ts.SyntaxKind.EqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsToken,
]);

/**
 * @typedef {{ fingerprint: string; wording: boolean; display: string; rows?: Pattern[] }} Pattern
 * @typedef {{
 *   code: string;
 *   path?: string;
 *   function?: string;
 *   pattern?: string;
 *   fingerprint?: string;
 *   line?: number;
 *   display?: string;
 *   list?: string;
 *   id?: string;
 *   count?: number;
 *   message: string;
 * }} Finding
 * @typedef {{
 *   path: string;
 *   function: string;
 *   pattern: string;
 *   fingerprint: string;
 *   line: number;
 *   display: string;
 * }} Site
 */

/**
 * @param {string} value
 * @returns {string}
 */
function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * @param {string} relativePath
 * @returns {boolean}
 */
function isScannedFile(relativePath) {
  const posix = relativePath.split(sep).join("/");
  const name = posix.slice(posix.lastIndexOf("/") + 1);
  if (!SOURCE_EXTENSIONS.some((extension) => name.endsWith(extension))) return false;
  if (DECLARATION_SUFFIXES.some((suffix) => name.endsWith(suffix))) return false;
  // Test files are excluded by name segment, so `product-test.ts` stays scanned.
  if (name.split(".").includes("test") || name.split(".").includes("spec")) return false;
  return !posix.split("/").some((segment) => EXCLUDED_DIRECTORIES.has(segment));
}

/**
 * @param {string} directory
 * @param {string} repoRoot
 * @returns {string[]}
 */
function walk(directory, repoRoot) {
  /** @type {string[]} */
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (EXCLUDED_DIRECTORIES.has(entry.name)) continue;
      files.push(...walk(path, repoRoot));
    } else if (entry.isFile() && isScannedFile(relative(repoRoot, path))) {
      files.push(path);
    }
  }
  return files;
}

/**
 * Decodes regex source to the characters it matches literally, dropping
 * shorthand classes, group syntax, named-group labels, and backreferences.
 *
 * @param {string} source
 * @returns {string}
 */
function regexLiteralCharacters(source) {
  let text = "";
  let inClass = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (inClass && character === "]") {
      inClass = false;
      continue;
    }
    if (!inClass && character === "[") {
      inClass = true;
      continue;
    }
    // A range such as `a-z` is a character class like `\w`, not a word; a
    // class listing single letters (`[Yy]`) still counts.
    if (
      inClass &&
      source[index + 1] === "-" &&
      source[index + 2] !== undefined &&
      source[index + 2] !== "]"
    ) {
      index += 2;
      if (source[index] === "\\") index += 1;
      continue;
    }
    if (character === "(" && source[index + 1] === "?") {
      const named = /^\(\?<([A-Za-z_$][\w$]*)>/u.exec(source.slice(index));
      if (named) {
        index += named[0].length - 1;
        continue;
      }
      const lookaround = /^\(\?(?:<=|<!|=|!|:)/u.exec(source.slice(index));
      if (lookaround) {
        index += lookaround[0].length - 1;
        continue;
      }
      continue;
    }
    if (character !== "\\") {
      text += character;
      continue;
    }
    const next = source[index + 1];
    if (next === undefined) break;
    if (next === "p" || next === "P" || next === "k") {
      const close = source.indexOf(next === "k" ? ">" : "}", index);
      index = close === -1 ? source.length : close;
      continue;
    }
    if (next === "u" && source[index + 2] === "{") {
      const close = source.indexOf("}", index);
      const hex = source.slice(index + 3, close === -1 ? source.length : close);
      const codePoint = Number.parseInt(hex, 16);
      if (Number.isFinite(codePoint)) text += String.fromCodePoint(codePoint);
      index = close === -1 ? source.length : close;
      continue;
    }
    const hexWidth = next === "u" ? 4 : next === "x" ? 2 : 0;
    if (hexWidth > 0) {
      const hex = source.slice(index + 2, index + 2 + hexWidth);
      if (/^[0-9A-Fa-f]+$/u.test(hex) && hex.length === hexWidth) {
        text += String.fromCodePoint(Number.parseInt(hex, 16));
        index += 1 + hexWidth;
        continue;
      }
    }
    if (next === "c") {
      index += 2;
      continue;
    }
    // Shorthand classes and control escapes are not wording.
    if ("bBdDsSwWnrtfv0123456789".includes(next)) {
      index += 1;
      continue;
    }
    text += next;
    index += 1;
  }
  return text;
}

/**
 * @param {string} source
 * @returns {boolean}
 */
function regexHasWording(source) {
  return LETTER.test(regexLiteralCharacters(source));
}

/**
 * @param {ts.Node} node
 * @returns {ts.Node}
 */
function unwrap(node) {
  let current = node;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isNonNullExpression(current) ||
    ts.isTypeAssertionExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isAwaitExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

/**
 * @param {ts.Node} node
 * @returns {boolean}
 */
function isFunctionLike(node) {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node)
  );
}

/**
 * @param {ts.PropertyName | ts.BindingName | undefined} name
 * @returns {string | undefined}
 */
function staticName(name) {
  if (!name) return undefined;
  if (ts.isIdentifier(name) || ts.isPrivateIdentifier(name)) return name.text;
  if (ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text;
  if (ts.isNoSubstitutionTemplateLiteral(name)) return name.text;
  return undefined;
}

/**
 * @param {ts.Node} node
 * @returns {boolean}
 */
function isConstDeclaration(node) {
  return (
    ts.isVariableDeclaration(node) &&
    ts.isVariableDeclarationList(node.parent) &&
    (node.parent.flags & ts.NodeFlags.Const) !== 0
  );
}

/**
 * Names the function a site belongs to without line numbers. An arrow inside
 * an object literal is keyed by the object's first string-literal property,
 * so `FIXED_ROUTES[workflow=create-documentation].match` survives reordering.
 *
 * @param {ts.Node} node
 * @returns {string}
 */
function enclosingFunctionName(node) {
  for (let current = node.parent; current; current = current.parent) {
    if (!isFunctionLike(current)) continue;
    const named = functionLikeName(current);
    if (named) return named;
  }
  return "<module>";
}

/**
 * @param {ts.Node} fn
 * @returns {string | undefined}
 */
function functionLikeName(fn) {
  if (ts.isFunctionDeclaration(fn) && fn.name) return fn.name.text;
  if (ts.isConstructorDeclaration(fn)) return `${className(fn.parent)}.constructor`;
  if (
    (ts.isMethodDeclaration(fn) ||
      ts.isGetAccessorDeclaration(fn) ||
      ts.isSetAccessorDeclaration(fn)) &&
    ts.isClassLike(fn.parent)
  ) {
    return `${className(fn.parent)}.${staticName(fn.name) ?? "<computed>"}`;
  }
  if (ts.isMethodDeclaration(fn) && ts.isObjectLiteralExpression(fn.parent)) {
    return objectMemberPath(fn.parent, staticName(fn.name) ?? "<computed>");
  }
  if (!ts.isFunctionExpression(fn) && !ts.isArrowFunction(fn)) return undefined;
  if (ts.isFunctionExpression(fn) && fn.name) return fn.name.text;
  const parent = fn.parent;
  if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) return parent.name.text;
  if (ts.isPropertyDeclaration(parent) && ts.isClassLike(parent.parent)) {
    return `${className(parent.parent)}.${staticName(parent.name) ?? "<computed>"}`;
  }
  if (ts.isPropertyAssignment(parent) && ts.isObjectLiteralExpression(parent.parent)) {
    return objectMemberPath(parent.parent, staticName(parent.name) ?? "<computed>");
  }
  return undefined;
}

/**
 * @param {ts.Node} node
 * @returns {string}
 */
function className(node) {
  return ts.isClassLike(node) && node.name ? node.name.text : "<class>";
}

/**
 * @param {ts.ObjectLiteralExpression} object
 * @param {string} member
 * @returns {string}
 */
function objectMemberPath(object, member) {
  let path = `${objectKey(object)}.${member}`;
  let current = /** @type {ts.Node} */ (object);
  for (;;) {
    const parent = current.parent;
    if (!parent) return `<module>${path}`;
    if (
      ts.isParenthesizedExpression(parent) ||
      ts.isAsExpression(parent) ||
      ts.isSatisfiesExpression(parent) ||
      ts.isArrayLiteralExpression(parent) ||
      (ts.isCallExpression(parent) && parent.arguments.includes(/** @type {any} */ (current)))
    ) {
      current = parent;
      continue;
    }
    if (ts.isPropertyAssignment(parent) && ts.isObjectLiteralExpression(parent.parent)) {
      path = `${objectKey(parent.parent)}.${staticName(parent.name) ?? "<computed>"}${path}`;
      current = parent.parent;
      continue;
    }
    if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) {
      return `${parent.name.text}${path}`;
    }
    return `${enclosingFunctionName(current)}${path}`;
  }
}

/**
 * @param {ts.ObjectLiteralExpression} object
 * @returns {string}
 */
function objectKey(object) {
  if (!ts.isArrayLiteralExpression(skipCallWrappers(object.parent))) return "";
  for (const property of object.properties) {
    if (!ts.isPropertyAssignment(property)) continue;
    const value = unwrap(property.initializer);
    if (ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value)) {
      return `[${staticName(property.name) ?? "<computed>"}=${value.text}]`;
    }
  }
  return "[]";
}

/**
 * @param {ts.Node} node
 * @returns {ts.Node}
 */
function skipCallWrappers(node) {
  let current = node;
  while (current && (ts.isParenthesizedExpression(current) || ts.isAsExpression(current))) {
    current = current.parent;
  }
  return current;
}

/**
 * Analyzes one source file. Resolution never leaves the file.
 */
class FileAnalysis {
  /**
   * @param {ts.SourceFile} sourceFile
   * @param {ts.TypeChecker} checker
   * @param {string} path
   */
  constructor(sourceFile, checker, path) {
    this.sourceFile = sourceFile;
    this.checker = checker;
    this.path = path;
    /** @type {Set<ts.Node>} */
    this.tainted = new Set();
    /** @type {Map<ts.Node, Pattern>} */
    this.bound = new Map();
    /** @type {Map<ts.Node, Pattern | null>} */
    this.constPatterns = new Map();
    /** @type {Map<ts.Node, string>} */
    this.digests = new Map();
    /**
     * Digests of referenced consts and functions, reused while the pattern
     * bindings stay the same. Only an expansion that met no cycle is kept,
     * since it does not depend on the path that reached it; without this,
     * each reference re-expanded its whole referenced tree.
     *
     * @type {Map<ts.Node, string>}
     */
    this.referenceDigests = new Map();
    this.cycleReferences = 0;
    /** @type {Map<string, ts.Node[]>} */
    this.membersByName = new Map();
    /** @type {Set<ts.Node>} */
    this.returning = new Set();
    this.changed = false;
  }

  /** @returns {Site[]} */
  run() {
    this.collectMembers(this.sourceFile);
    this.seed(this.sourceFile);
    do {
      this.changed = false;
      this.propagate(this.sourceFile);
    } while (this.changed);
    /** @type {Site[]} */
    const sites = [];
    this.collectSites(this.sourceFile, sites);
    return sites;
  }

  /**
   * Indexes object-literal and class members that are functions, for
   * name-resolved property calls such as `route.match(text)`.
   *
   * @param {ts.Node} node
   */
  collectMembers(node) {
    /** @type {[string | undefined, ts.Node] | undefined} */
    let entry;
    if (
      ts.isPropertyAssignment(node) &&
      (ts.isArrowFunction(unwrap(node.initializer)) ||
        ts.isFunctionExpression(unwrap(node.initializer)))
    ) {
      entry = [staticName(node.name), unwrap(node.initializer)];
    } else if (ts.isMethodDeclaration(node)) {
      entry = [staticName(node.name), node];
    } else if (
      ts.isPropertyDeclaration(node) &&
      node.initializer &&
      (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))
    ) {
      entry = [staticName(node.name), node.initializer];
    }
    if (entry?.[0]) {
      const list = this.membersByName.get(entry[0]) ?? [];
      list.push(entry[1]);
      this.membersByName.set(entry[0], list);
    }
    ts.forEachChild(node, (child) => this.collectMembers(child));
  }

  /**
   * @param {ts.Node} node
   */
  seed(node) {
    if (ts.isParameter(node) && ts.isIdentifier(node.name)) {
      const fn = node.parent;
      const name = functionLikeName(fn);
      if (
        SEED_PARAMETERS.some(
          (seed) =>
            seed.path === this.path && seed.function === name && seed.parameter === node.name.text,
        )
      ) {
        this.taintBinding(node.name);
      }
    }
    ts.forEachChild(node, (child) => this.seed(child));
  }

  /**
   * @param {ts.Node} node
   * @returns {ts.Node | undefined}
   */
  declarationOf(node) {
    const symbol = ts.isShorthandPropertyAssignment(node.parent)
      ? this.checker.getShorthandAssignmentValueSymbol(node.parent)
      : this.checker.getSymbolAtLocation(node);
    const declaration = symbol?.valueDeclaration ?? symbol?.declarations?.[0];
    if (!declaration || declaration.getSourceFile() !== this.sourceFile) return undefined;
    return declaration;
  }

  /**
   * @param {ts.BindingName} name
   */
  taintBinding(name) {
    if (ts.isIdentifier(name)) {
      const declaration = name.parent;
      if (!this.tainted.has(declaration)) {
        this.tainted.add(declaration);
        this.changed = true;
      }
      return;
    }
    if (ts.isArrayBindingPattern(name)) {
      for (const element of name.elements) {
        if (ts.isBindingElement(element)) this.taintBinding(element.name);
      }
    }
    // Object binding: a member of a tainted value is not tainted.
  }

  /**
   * @param {ts.BindingName} name
   * @param {Pattern} pattern
   */
  bindPattern(name, pattern) {
    if (ts.isIdentifier(name)) {
      if (!this.bound.has(name.parent)) {
        this.bound.set(name.parent, pattern);
        // A binding changes how references serialize.
        this.referenceDigests.clear();
        this.changed = true;
      }
      return;
    }
    for (const element of name.elements) {
      if (ts.isBindingElement(element)) this.bindPattern(element.name, pattern);
    }
  }

  /**
   * @param {ts.Node} node
   * @returns {ts.Node | undefined}
   */
  sameFileFunction(node) {
    const target = unwrap(node);
    if (!ts.isIdentifier(target)) return undefined;
    const declaration = this.declarationOf(target);
    if (!declaration) return undefined;
    if (ts.isFunctionDeclaration(declaration)) return declaration;
    if (ts.isVariableDeclaration(declaration) && declaration.initializer) {
      const initializer = unwrap(declaration.initializer);
      if (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer)) {
        return initializer;
      }
    }
    return undefined;
  }

  /**
   * @param {ts.Node} fn
   * @param {readonly ts.Expression[]} args
   * @param {number} [offset]
   */
  taintParameters(fn, args, offset = 0) {
    const parameters = /** @type {ts.SignatureDeclaration} */ (fn).parameters ?? [];
    args.forEach((argument, index) => {
      if (ts.isSpreadElement(argument) || !this.isTainted(argument)) return;
      const parameter = parameters[index + offset];
      if (parameter) this.taintBinding(parameter.name);
      const rest = parameters.at(-1);
      if (!parameter && rest?.dotDotDotToken) this.taintBinding(rest.name);
    });
  }

  /**
   * @param {ts.Node} node
   */
  propagate(node) {
    if (ts.isVariableDeclaration(node) && node.initializer) {
      if (this.isTainted(node.initializer)) this.taintBinding(node.name);
    }
    if (ts.isBindingElement(node) && ts.isIdentifier(node.name)) {
      const property = staticName(node.propertyName) ?? node.name.text;
      if (subjectNames.has(property) && ts.isObjectBindingPattern(node.parent)) {
        this.taintBinding(node.name);
      }
    }
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isIdentifier(node.left) &&
      this.isTainted(node.right)
    ) {
      const declaration = this.declarationOf(node.left);
      if (declaration && ts.isVariableDeclaration(declaration)) {
        this.taintBinding(declaration.name);
      }
    }
    if (ts.isForOfStatement(node) && ts.isVariableDeclarationList(node.initializer)) {
      const binding = node.initializer.declarations[0]?.name;
      if (binding) {
        if (this.isTainted(node.expression)) this.taintBinding(binding);
        const lexicon = this.staticPattern(node.expression);
        if (lexicon) this.bindPattern(binding, lexicon);
      }
    }
    if (ts.isCallExpression(node)) this.propagateCall(node);
    ts.forEachChild(node, (child) => this.propagate(child));
  }

  /**
   * @param {ts.CallExpression} node
   */
  propagateCall(node) {
    const helper = this.sameFileFunction(node.expression);
    if (helper) {
      this.taintParameters(helper, node.arguments);
      return;
    }
    const callee = unwrap(node.expression);
    if (!ts.isPropertyAccessExpression(callee)) return;
    const method = callee.name.text;
    const receiver = callee.expression;
    const receiverTainted = this.isTainted(receiver);
    const receiverPattern = this.staticPattern(receiver);
    if (CALLBACK_METHODS.has(method)) {
      const callback = node.arguments[0] && unwrap(node.arguments[0]);
      if (callback && (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback))) {
        const index = method === "reduce" || method === "reduceRight" ? 1 : 0;
        const parameter = callback.parameters[index];
        if (parameter && receiverTainted) this.taintBinding(parameter.name);
        if (parameter && receiverPattern) this.bindPattern(parameter.name, receiverPattern);
      }
    }
    // `route.match(text)` on an untainted, non-pattern receiver is a call
    // edge to same-file members named `match`, not a String.prototype sink.
    if (!receiverTainted && !receiverPattern) {
      for (const member of this.membersByName.get(method) ?? []) {
        this.taintParameters(member, node.arguments);
      }
    }
  }

  /**
   * @param {ts.Node} input
   * @returns {boolean}
   */
  isTainted(input) {
    const node = unwrap(input);
    if (ts.isIdentifier(node)) {
      const declaration = this.declarationOf(node);
      if (subjectNames.has(node.text)) {
        // A const built only from literals cannot hold operator text, so a
        // carrier name on a provenance enum is not a subject.
        return !(
          declaration &&
          isConstDeclaration(declaration) &&
          this.isLiteralOnly(/** @type {ts.VariableDeclaration} */ (declaration).initializer)
        );
      }
      return declaration !== undefined && this.tainted.has(declaration);
    }
    if (ts.isPropertyAccessExpression(node)) return subjectNames.has(node.name.text);
    if (ts.isElementAccessExpression(node)) {
      const key = unwrap(node.argumentExpression);
      if (ts.isStringLiteral(key) || ts.isNoSubstitutionTemplateLiteral(key)) {
        return subjectNames.has(key.text);
      }
      // An indexed read of derived text (`match[1]`, `lines[0]`) carries it; a
      // dynamic-key read of a carrier-named object (`request[key]`) is a member.
      const object = unwrap(node.expression);
      if (ts.isIdentifier(object) && subjectNames.has(object.text)) {
        const declaration = this.declarationOf(object);
        return declaration !== undefined && this.tainted.has(declaration);
      }
      return this.isTainted(node.expression);
    }
    if (ts.isCallExpression(node)) {
      const callee = unwrap(node.expression);
      if (ts.isPropertyAccessExpression(callee)) {
        const method = callee.name.text;
        if (PROPAGATING_METHODS.has(method) && this.isTainted(callee.expression)) return true;
        if (method === "exec" && node.arguments.some((argument) => this.isTainted(argument))) {
          return true;
        }
        if (method === "from" && ts.isIdentifier(callee.expression)) {
          return node.arguments.some((argument) => this.isTainted(argument));
        }
      }
      if (ts.isIdentifier(callee) && callee.text === "String") {
        return node.arguments.some((argument) => this.isTainted(argument));
      }
      const helper = this.sameFileFunction(callee);
      if (helper) {
        const fed =
          node.arguments.some((argument) => this.isTainted(argument)) ||
          /** @type {ts.SignatureDeclaration} */ (helper).parameters.length === 0;
        return fed && this.returnsTaint(helper);
      }
      return false;
    }
    if (ts.isTemplateExpression(node)) {
      return node.templateSpans.some((span) => this.isTainted(span.expression));
    }
    if (ts.isBinaryExpression(node)) {
      const kind = node.operatorToken.kind;
      if (
        kind === ts.SyntaxKind.PlusToken ||
        kind === ts.SyntaxKind.QuestionQuestionToken ||
        kind === ts.SyntaxKind.BarBarToken ||
        kind === ts.SyntaxKind.AmpersandAmpersandToken
      ) {
        return this.isTainted(node.left) || this.isTainted(node.right);
      }
      return false;
    }
    if (ts.isConditionalExpression(node)) {
      return this.isTainted(node.whenTrue) || this.isTainted(node.whenFalse);
    }
    if (ts.isArrayLiteralExpression(node)) {
      return node.elements.some((element) =>
        this.isTainted(ts.isSpreadElement(element) ? element.expression : element),
      );
    }
    if (ts.isSpreadElement(node)) return this.isTainted(node.expression);
    return false;
  }

  /**
   * A same-file helper's result carries taint only when one of its return
   * expressions does, so a helper that maps request text to a status enum
   * does not taint the enum.
   *
   * @param {ts.Node} fn
   * @returns {boolean}
   */
  returnsTaint(fn) {
    if (this.returning.has(fn)) return false;
    this.returning.add(fn);
    try {
      const body = /** @type {ts.FunctionLikeDeclaration} */ (fn).body;
      if (!body) return false;
      if (!ts.isBlock(body)) return this.isTainted(body);
      let found = false;
      /** @param {ts.Node} node */
      const visit = (node) => {
        if (found || isFunctionLike(node)) return;
        if (ts.isReturnStatement(node) && node.expression && this.isTainted(node.expression)) {
          found = true;
          return;
        }
        ts.forEachChild(node, visit);
      };
      ts.forEachChild(body, visit);
      return found;
    } finally {
      this.returning.delete(fn);
    }
  }

  /**
   * @param {ts.Node | undefined} input
   * @returns {boolean}
   */
  isLiteralOnly(input) {
    if (!input) return false;
    const node = unwrap(input);
    if (ts.isConditionalExpression(node)) {
      return this.isLiteralOnly(node.whenTrue) && this.isLiteralOnly(node.whenFalse);
    }
    return this.staticPattern(node) !== undefined;
  }

  /**
   * Resolves an expression to a static pattern, or undefined when any part is
   * dynamic.
   *
   * @param {ts.Node} input
   * @param {Set<ts.Node>} [visiting]
   * @returns {Pattern | undefined}
   */
  staticPattern(input, visiting = new Set()) {
    const node = unwrap(input);
    if (ts.isRegularExpressionLiteral(node)) {
      const text = node.text;
      const source = text.slice(1, text.lastIndexOf("/"));
      return {
        fingerprint: `regex#${sha256(text)}`,
        wording: regexHasWording(source),
        display: text,
      };
    }
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      return {
        fingerprint: `string#${sha256(node.text)}`,
        wording: LETTER.test(node.text),
        display: JSON.stringify(node.text),
      };
    }
    if (
      ts.isNumericLiteral(node) ||
      node.kind === ts.SyntaxKind.NullKeyword ||
      node.kind === ts.SyntaxKind.TrueKeyword ||
      node.kind === ts.SyntaxKind.FalseKeyword
    ) {
      return {
        fingerprint: `literal#${sha256(node.getText())}`,
        wording: false,
        display: node.getText(),
      };
    }
    if (ts.isIdentifier(node)) {
      const declaration = this.declarationOf(node);
      if (!declaration) return undefined;
      const bound = this.bound.get(declaration);
      if (bound) return bound;
      if (isConstDeclaration(declaration)) return this.namedConst(declaration, visiting);
      return undefined;
    }
    if (ts.isPropertyAccessExpression(node)) {
      return this.staticPattern(node.expression, visiting);
    }
    if (ts.isTemplateExpression(node) || ts.isTaggedTemplateExpression(node)) {
      return this.templatePattern(node, visiting);
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      const left = this.staticPattern(node.left, visiting);
      const right = left && this.staticPattern(node.right, visiting);
      if (!left || !right) return undefined;
      return this.anonymous(node, left.wording || right.wording, visiting);
    }
    if (ts.isArrayLiteralExpression(node)) {
      const parts = node.elements.map((element) =>
        this.staticPattern(ts.isSpreadElement(element) ? element.expression : element, visiting),
      );
      if (parts.some((part) => !part)) return undefined;
      return this.anonymous(
        node,
        parts.some((part) => part?.wording),
        visiting,
      );
    }
    if (ts.isObjectLiteralExpression(node)) {
      const parts = node.properties.map((property) =>
        ts.isPropertyAssignment(property) && staticName(property.name) !== undefined
          ? this.staticPattern(property.initializer, visiting)
          : undefined,
      );
      if (parts.some((part) => !part)) return undefined;
      return this.anonymous(
        node,
        parts.some((part) => part?.wording),
        visiting,
      );
    }
    if (ts.isNewExpression(node) || ts.isCallExpression(node)) {
      return this.constructedPattern(node, visiting);
    }
    return undefined;
  }

  /**
   * @param {ts.TemplateExpression | ts.TaggedTemplateExpression} node
   * @param {Set<ts.Node>} visiting
   * @returns {Pattern | undefined}
   */
  templatePattern(node, visiting) {
    let raw = false;
    let template = /** @type {ts.TemplateLiteral} */ (node);
    if (ts.isTaggedTemplateExpression(node)) {
      if (node.tag.getText(this.sourceFile) !== "String.raw") return undefined;
      raw = true;
      template = node.template;
    }
    if (ts.isNoSubstitutionTemplateLiteral(template)) {
      const text = template.rawText ?? template.text;
      return this.anonymous(node, raw ? regexHasWording(text) : LETTER.test(text), visiting);
    }
    const literals = [template.head, ...template.templateSpans.map((span) => span.literal)];
    let wording = literals.some((literal) => {
      const text = raw ? (literal.rawText ?? literal.text) : literal.text;
      return raw ? regexHasWording(text) : LETTER.test(text);
    });
    for (const span of template.templateSpans) {
      const part = this.staticPattern(span.expression, visiting);
      if (!part) return undefined;
      wording ||= part.wording;
    }
    return this.anonymous(node, wording, visiting);
  }

  /**
   * @param {ts.NewExpression | ts.CallExpression} node
   * @param {Set<ts.Node>} visiting
   * @returns {Pattern | undefined}
   */
  constructedPattern(node, visiting) {
    const callee = unwrap(node.expression);
    const args = node.arguments ?? [];
    const calleeName = ts.isIdentifier(callee)
      ? callee.text
      : ts.isPropertyAccessExpression(callee)
        ? callee.getText(this.sourceFile)
        : undefined;
    if (calleeName === "RegExp") {
      const source = args[0];
      if (!source) return undefined;
      const sourceNode = unwrap(source);
      // `new RegExp(X.source, X.flags)` is a reuse of `X`, fingerprinted by X.
      if (
        ts.isPropertyAccessExpression(sourceNode) &&
        sourceNode.name.text === "source" &&
        args.slice(1).every((flag) => this.staticPattern(flag, visiting))
      ) {
        return this.staticPattern(sourceNode.expression, visiting);
      }
      const parts = args.map((argument) => this.staticPattern(argument, visiting));
      if (parts.some((part) => !part)) return undefined;
      const wording = this.regexArgumentWording(sourceNode, visiting);
      return this.anonymous(node, wording, visiting);
    }
    // Value-preserving wrappers keep the wrapped pattern's own fingerprint.
    if (calleeName === "String" || calleeName === "Object.freeze") {
      return args.length === 1 ? this.staticPattern(args[0], visiting) : undefined;
    }
    if (calleeName === "Set" || calleeName === "Map") {
      if (args.length === 0) return undefined;
      const inner = this.staticPattern(args[0], visiting);
      return inner && this.anonymous(node, inner.wording, visiting);
    }
    if (ts.isCallExpression(node)) {
      const helper = this.sameFileFunction(callee);
      if (!helper) return undefined;
      const parts = args.map((argument) => this.staticPattern(argument, visiting));
      if (parts.some((part) => !part)) return undefined;
      return this.anonymous(
        node,
        parts.some((part) => part?.wording),
        visiting,
      );
    }
    return undefined;
  }

  /**
   * A string handed to `RegExp` is regex source, so its escapes decode as
   * regex escapes.
   *
   * @param {ts.Node} node
   * @param {Set<ts.Node>} visiting
   * @returns {boolean}
   */
  regexArgumentWording(node, visiting) {
    const value = unwrap(node);
    if (ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value)) {
      return regexHasWording(value.text);
    }
    return this.staticPattern(value, visiting)?.wording ?? false;
  }

  /**
   * @param {ts.VariableDeclaration} declaration
   * @param {Set<ts.Node>} visiting
   * @returns {Pattern | undefined}
   */
  namedConst(declaration, visiting) {
    if (this.constPatterns.has(declaration)) {
      return this.constPatterns.get(declaration) ?? undefined;
    }
    if (!declaration.initializer || !ts.isIdentifier(declaration.name)) return undefined;
    if (visiting.has(declaration)) return undefined;
    visiting.add(declaration);
    const initializer = unwrap(declaration.initializer);
    const inner = this.staticPattern(initializer, visiting);
    visiting.delete(declaration);
    /** @type {Pattern | undefined} */
    let pattern;
    if (inner && this.isRegExpAlias(initializer)) {
      pattern = inner;
    } else if (inner) {
      const name = declaration.name.text;
      pattern = {
        fingerprint: `${name}#${this.digest(declaration)}`,
        wording: inner.wording,
        display: name,
        rows: this.labelledRows(declaration, initializer),
      };
    }
    this.constPatterns.set(declaration, pattern ?? null);
    return pattern;
  }

  /**
   * A lexicon of tuples that each start with a string label is fingerprinted
   * per row, so one row (a narrowing guard) can be allowlisted while its
   * siblings stay baselined debt.
   *
   * @param {ts.VariableDeclaration} declaration
   * @param {ts.Node} initializer
   * @returns {Pattern[] | undefined}
   */
  labelledRows(declaration, initializer) {
    let list = initializer;
    if (ts.isCallExpression(list) && list.expression.getText(this.sourceFile) === "Object.freeze") {
      list = list.arguments[0] ? unwrap(list.arguments[0]) : list;
    }
    if (!ts.isArrayLiteralExpression(list) || list.elements.length === 0) return undefined;
    /** @type {Pattern[]} */
    const rows = [];
    for (const element of list.elements) {
      const row = unwrap(element);
      const label = ts.isArrayLiteralExpression(row) ? row.elements[0] : undefined;
      if (!label || !(ts.isStringLiteral(label) || ts.isNoSubstitutionTemplateLiteral(label))) {
        return undefined;
      }
      const name = `${declaration.name.getText(this.sourceFile)}[${label.text}]`;
      // The label names the row and is never matched, so its letters do not
      // make a letter-free pattern row a wording site.
      const matched = /** @type {ts.ArrayLiteralExpression} */ (row).elements.slice(1);
      rows.push({
        fingerprint: `${name}#${sha256(this.serialize(row, new Set([declaration])))}`,
        wording: matched.some(
          (element) =>
            this.staticPattern(ts.isSpreadElement(element) ? element.expression : element)
              ?.wording ?? false,
        ),
        display: name,
      });
    }
    return rows;
  }

  /**
   * @param {ts.Node} node
   * @returns {boolean}
   */
  isRegExpAlias(node) {
    if (!ts.isNewExpression(node) && !ts.isCallExpression(node)) return false;
    const callee = unwrap(node.expression);
    const source = node.arguments?.[0] && unwrap(node.arguments[0]);
    return (
      ts.isIdentifier(callee) &&
      callee.text === "RegExp" &&
      source !== undefined &&
      ts.isPropertyAccessExpression(source) &&
      source.name.text === "source"
    );
  }

  /**
   * @param {ts.Node} node
   * @param {boolean} wording
   * @param {Set<ts.Node>} visiting
   * @returns {Pattern}
   */
  anonymous(node, wording, visiting) {
    return {
      fingerprint: `expr#${sha256(this.serialize(node, visiting))}`,
      wording,
      display: node.getText(this.sourceFile),
    };
  }

  /**
   * Digest of a declaration's syntax tree. Comments, whitespace, quote style,
   * trailing commas, and type annotations do not change it; each referenced
   * same-file const or function contributes its own digest.
   *
   * @param {ts.Node} declaration
   * @returns {string}
   */
  digest(declaration) {
    const known = this.digests.get(declaration);
    if (known) return known;
    const body = ts.isVariableDeclaration(declaration) ? declaration.initializer : declaration;
    const value = sha256(body ? this.serialize(body, new Set([declaration])) : "");
    this.digests.set(declaration, value);
    return value;
  }

  /**
   * @param {ts.Node} node
   * @param {Set<ts.Node>} visiting
   * @returns {string}
   */
  serialize(node, visiting) {
    if (ts.isTypeNode(node) || ts.isTypeParameterDeclaration(node)) return "";
    if (ts.isParenthesizedExpression(node)) return this.serialize(node.expression, visiting);
    if (ts.isIdentifier(node)) return this.serializeReference(node, visiting);
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      return `s${JSON.stringify(node.text)}`;
    }
    if (ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) {
      return `t${JSON.stringify(node.rawText ?? node.text)}`;
    }
    if (ts.isRegularExpressionLiteral(node) || ts.isNumericLiteral(node)) {
      return `l${JSON.stringify(node.text)}`;
    }
    const operator =
      ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)
        ? String(node.operator)
        : "";
    /** @type {string[]} */
    const children = [];
    ts.forEachChild(node, (child) => {
      children.push(this.serialize(child, visiting));
    });
    return `${ts.SyntaxKind[node.kind]}${operator}(${children.join(",")})`;
  }

  /**
   * @param {ts.Identifier} node
   * @param {Set<ts.Node>} visiting
   * @returns {string}
   */
  serializeReference(node, visiting) {
    const isReference =
      !ts.isPropertyAccessExpression(node.parent) || node.parent.expression === node;
    const declaration = isReference ? this.declarationOf(node) : undefined;
    const bound = declaration && this.bound.get(declaration);
    if (bound) return `b${bound.fingerprint}`;
    const referenced =
      declaration &&
      ((isConstDeclaration(declaration) &&
        /** @type {ts.VariableDeclaration} */ (declaration).name !== node) ||
        (ts.isFunctionDeclaration(declaration) && declaration.name !== node))
        ? declaration
        : undefined;
    if (!referenced) return `i${node.text}`;
    if (visiting.has(referenced)) {
      this.cycleReferences += 1;
      return `r${node.text}#cycle`;
    }
    if (this.digests.has(referenced)) return `r${node.text}#${this.digests.get(referenced)}`;
    const reused = this.referenceDigests.get(referenced);
    if (reused !== undefined) return `r${node.text}#${reused}`;
    const cyclesBefore = this.cycleReferences;
    visiting.add(referenced);
    const body = ts.isVariableDeclaration(referenced) ? referenced.initializer : referenced;
    const value = sha256(body ? this.serialize(body, visiting) : "");
    visiting.delete(referenced);
    if (this.cycleReferences === cyclesBefore) this.referenceDigests.set(referenced, value);
    return `r${node.text}#${value}`;
  }

  /**
   * @param {ts.Node} node
   * @param {ts.Node} subject
   * @param {Pattern | undefined} pattern
   * @param {Site[]} sites
   */
  record(node, subject, pattern, sites) {
    if (!pattern?.wording || !this.isTainted(subject)) return;
    const fn = enclosingFunctionName(node);
    const { line } = this.sourceFile.getLineAndCharacterOfPosition(node.getStart(this.sourceFile));
    for (const part of pattern.rows ?? [pattern]) {
      if (!part.wording) continue;
      sites.push({
        path: this.path,
        function: fn,
        pattern: part.fingerprint,
        fingerprint: [this.path, fn, part.fingerprint].join("|"),
        line: line + 1,
        display: part.display,
      });
    }
  }

  /**
   * @param {ts.Node} node
   * @param {Site[]} sites
   */
  collectSites(node, sites) {
    if (ts.isCallExpression(node)) {
      const callee = unwrap(node.expression);
      const first = node.arguments[0];
      if (ts.isPropertyAccessExpression(callee) && first) {
        const method = callee.name.text;
        const receiver = callee.expression;
        if (REGEX_RECEIVER_SINKS.has(method)) {
          this.record(node, first, this.staticPattern(receiver), sites);
        } else if (PATTERN_ARGUMENT_SINKS.has(method) && this.isTainted(receiver)) {
          this.record(node, receiver, this.staticPattern(first), sites);
        } else if (COLLECTION_SINKS.has(method)) {
          this.record(node, first, this.staticPattern(receiver), sites);
        }
      }
    }
    if (ts.isBinaryExpression(node) && EQUALITY_OPERATORS.has(node.operatorToken.kind)) {
      if (this.isTainted(node.left)) {
        this.record(node, node.left, this.staticPattern(node.right), sites);
      } else if (this.isTainted(node.right)) {
        this.record(node, node.right, this.staticPattern(node.left), sites);
      }
    }
    if (ts.isSwitchStatement(node)) {
      for (const clause of node.caseBlock.clauses) {
        if (ts.isCaseClause(clause)) {
          this.record(clause, node.expression, this.staticPattern(clause.expression), sites);
        }
      }
    }
    ts.forEachChild(node, (child) => this.collectSites(child, sites));
  }
}

/**
 * @param {{ roots?: readonly string[]; repoRoot?: string }} [options]
 * @returns {Site[]}
 */
export function scanRequestWording(options = {}) {
  const repoRoot = options.repoRoot ?? DEFAULT_REPO_ROOT;
  const roots = (options.roots ?? SCAN_ROOTS).map((root) => resolve(repoRoot, root));
  const files = roots.filter((root) => existsSync(root)).flatMap((root) => walk(root, repoRoot));
  files.sort();
  const program = ts.createProgram(files, {
    allowJs: true,
    noLib: true,
    noResolve: true,
    noEmit: true,
    types: [],
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.ESNext,
  });
  const checker = program.getTypeChecker();
  /** @type {Site[]} */
  const sites = [];
  for (const file of files) {
    const sourceFile = program.getSourceFile(file);
    if (!sourceFile) continue;
    const path = relative(repoRoot, file).split(sep).join("/");
    sites.push(...new FileAnalysis(sourceFile, checker, path).run());
  }
  return sites;
}

/**
 * @param {string} path
 * @returns {{ ok: true; baseline: any } | { ok: false; finding: Finding }}
 */
function loadBaseline(path) {
  if (!existsSync(path)) {
    return {
      ok: false,
      finding: {
        code: CODES.baselineInvalid,
        message: `${CODES.baselineInvalid}: baseline ${path} is missing. Restore scripts/request-wording-baseline.json from main; a missing baseline is never read as empty.`,
      },
    };
  }
  /** @type {any} */
  let baseline;
  try {
    baseline = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    return {
      ok: false,
      finding: {
        code: CODES.baselineInvalid,
        message: `${CODES.baselineInvalid}: baseline ${path} is not valid JSON (${error instanceof Error ? error.message : String(error)}). Fix the file so it parses.`,
      },
    };
  }
  const shaped =
    baseline !== null &&
    typeof baseline === "object" &&
    Array.isArray(baseline.sites) &&
    Array.isArray(baseline.allowlist) &&
    [...baseline.sites, ...baseline.allowlist].every(
      (entry) =>
        entry !== null && typeof entry === "object" && typeof entry.fingerprint === "string",
    );
  if (!shaped) {
    return {
      ok: false,
      finding: {
        code: CODES.baselineInvalid,
        message: `${CODES.baselineInvalid}: baseline ${path} must hold "sites" and "allowlist" arrays of entries with a string "fingerprint". Restore the documented shape.`,
      },
    };
  }
  return { ok: true, baseline };
}

/**
 * @param {any} baseline
 * @param {string} path
 * @returns {Finding[]}
 */
function allowlistProblems(baseline, path) {
  /** @type {Finding[]} */
  const problems = [];
  const debt = new Set(baseline.sites.map((/** @type {any} */ entry) => entry.fingerprint));
  for (const entry of baseline.allowlist) {
    if (debt.has(entry.fingerprint)) {
      problems.push({
        code: CODES.allowlistInvalid,
        fingerprint: entry.fingerprint,
        message: `${CODES.allowlistInvalid}: ${entry.fingerprint} is in both "sites" and "allowlist" of ${path}. Keep it in exactly one list.`,
      });
    }
    if (!ALLOWLIST_CATEGORIES.includes(entry.category)) {
      problems.push({
        code: CODES.allowlistInvalid,
        fingerprint: entry.fingerprint,
        message: `${CODES.allowlistInvalid}: allowlist entry ${entry.fingerprint} in ${path} needs "category" set to one of ${ALLOWLIST_CATEGORIES.join(", ")}.`,
      });
    }
    if (typeof entry.rationale !== "string" || entry.rationale.trim() === "") {
      problems.push({
        code: CODES.allowlistInvalid,
        fingerprint: entry.fingerprint,
        message: `${CODES.allowlistInvalid}: allowlist entry ${entry.fingerprint} in ${path} needs a non-empty "rationale" saying why it only narrows authority or was kept by decision.`,
      });
    }
  }
  return problems;
}

/**
 * @param {readonly string[]} values
 * @returns {Map<string, number>}
 */
function counts(values) {
  const map = new Map();
  for (const value of values) map.set(value, (map.get(value) ?? 0) + 1);
  return map;
}

/**
 * @param {Map<string, number>} left
 * @param {Map<string, number>} right
 * @returns {Map<string, number>}
 */
function subtract(left, right) {
  const result = new Map();
  for (const [key, value] of left) {
    const remaining = value - (right.get(key) ?? 0);
    if (remaining > 0) result.set(key, remaining);
  }
  return result;
}

/**
 * @param {readonly Finding[]} findings
 * @param {number} status
 * @param {Site[]} sites
 * @returns {{ status: number; findings: Finding[]; sites: Site[]; stdout: string; stderr: string }}
 */
function failure(findings, status, sites) {
  return {
    status,
    findings: [...findings],
    sites,
    stdout: "",
    stderr: `${findings.map((finding) => finding.message).join("\n")}\n`,
  };
}

/**
 * Compares the scanned sites with the baseline and allowlist.
 *
 * @param {{ roots?: readonly string[]; repoRoot?: string; baseline?: string }} [options]
 * @returns {{ status: number; findings: Finding[]; sites: Site[]; stdout: string; stderr: string }}
 */
export function runRequestWordingCheck(options = {}) {
  const repoRoot = options.repoRoot ?? DEFAULT_REPO_ROOT;
  const baselinePath = options.baseline ?? DEFAULT_BASELINE;
  const loaded = loadBaseline(baselinePath);
  if (!loaded.ok) return failure([loaded.finding], EXIT_REFUSED, []);
  const integrity = allowlistProblems(loaded.baseline, baselinePath);
  if (integrity.length > 0) return failure(integrity, EXIT_REFUSED, []);

  const roots = options.roots ?? SCAN_ROOTS;
  const missing = roots.filter((root) => !existsSync(resolve(repoRoot, root)));
  if (missing.length > 0) {
    return failure(
      missing.map((root) => ({
        code: CODES.rootMissing,
        message: `${CODES.rootMissing}: scan root ${root} does not exist under ${repoRoot}. Run from a full checkout or pass --repo-root; a missing root is never skipped.`,
      })),
      EXIT_REFUSED,
      [],
    );
  }
  const sites = scanRequestWording({ roots, repoRoot });
  return compareRequestWordingSites(sites, loaded.baseline, repoRoot, baselinePath);
}

/**
 * Compare an already scanned inventory with a validated baseline. The public
 * checker validates inputs and scans current source before calling this seam.
 *
 * @param {Site[]} sites
 * @param {any} baseline
 * @param {string} repoRoot
 * @param {string} baselinePath
 * @returns {{ status: number; findings: Finding[]; sites: Site[]; stdout: string; stderr: string }}
 */
export function compareRequestWordingSites(sites, baseline, repoRoot, baselinePath) {
  /** @type {Map<string, { list: string; id?: string }>} */
  const entries = new Map();
  for (const entry of baseline.sites)
    entries.set(entry.fingerprint, { list: "sites", id: entry.id });
  for (const entry of baseline.allowlist) {
    entries.set(entry.fingerprint, { list: "allowlist", id: entry.inventoryRow });
  }
  const expected = counts(
    [...baseline.sites, ...baseline.allowlist].map((/** @type {any} */ entry) => entry.fingerprint),
  );
  const current = counts(sites.map((site) => site.fingerprint));
  const novel = subtract(current, expected);
  const stale = subtract(expected, current);

  /** @type {Finding[]} */
  const findings = [];
  for (const site of sites) {
    const remaining = novel.get(site.fingerprint);
    if (!remaining) continue;
    novel.set(site.fingerprint, remaining - 1);
    findings.push({
      code: CODES.newSite,
      path: site.path,
      function: site.function,
      pattern: site.pattern,
      fingerprint: site.fingerprint,
      line: site.line,
      display: site.display,
      message: `${CODES.newSite}: ${site.path}:${site.line} in ${site.function} decides on request wording with ${site.display} (fingerprint ${site.fingerprint}). ${REMEDIATION}`,
    });
  }
  for (const [fingerprint, count] of [...stale.entries()].sort((a, b) =>
    a[0].localeCompare(b[0]),
  )) {
    const entry = entries.get(fingerprint);
    findings.push({
      code: CODES.stale,
      fingerprint,
      list: entry?.list,
      id: entry?.id,
      count,
      message: `${CODES.stale}: shrink the baseline: remove ${fingerprint} from "${entry?.list}" in ${relative(repoRoot, baselinePath) || baselinePath}${count > 1 ? ` (${count} entries)` : ""}; the scan no longer finds it.`,
    });
  }
  if (findings.length > 0) return failure(findings, EXIT_FINDINGS, sites);

  const narrowing = baseline.allowlist.filter(
    (/** @type {any} */ entry) => entry.category === "narrowing",
  ).length;
  const kept = baseline.allowlist.length - narrowing;
  return {
    status: EXIT_OK,
    findings,
    sites,
    stdout: `OK: ${sites.length} request-wording sites match the baseline (${baseline.sites.length} debt sites; allowlist ${narrowing} narrowing, ${kept} kept-by-decision).\n`,
    stderr: "",
  };
}

const USAGE =
  "Usage: node scripts/check-request-wording.mjs --check [--repo-root <dir>] [--baseline <file>]";

/**
 * @param {readonly string[]} argv
 * @returns {{ status: number; stdout: string; stderr: string }}
 */
export function main(argv) {
  let check = false;
  /** @type {string | undefined} */
  let repoRoot;
  /** @type {string | undefined} */
  let baseline;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = argv[index + 1];
    if (arg === "--check") {
      check = true;
    } else if ((arg === "--repo-root" || arg === "--baseline") && value !== undefined) {
      if (arg === "--repo-root") repoRoot = resolve(value);
      else baseline = resolve(value);
      index += 1;
    } else {
      return {
        status: EXIT_REFUSED,
        stdout: "",
        stderr: `${CODES.usage}: unknown or incomplete argument ${JSON.stringify(arg)}. ${USAGE}\n`,
      };
    }
  }
  if (!check) {
    return {
      status: EXIT_REFUSED,
      stdout: "",
      stderr: `${CODES.usage}: nothing was checked; pass --check. ${USAGE}\n`,
    };
  }
  return runRequestWordingCheck({ repoRoot, baseline });
}

function isEntryPoint() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(scriptPath);
  } catch {
    // argv[1] names no existing file (an inline `-e` importer), so this
    // module was imported, not run.
    return false;
  }
}

if (isEntryPoint()) {
  const result = main(process.argv.slice(2));
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  process.exitCode = result.status;
}
