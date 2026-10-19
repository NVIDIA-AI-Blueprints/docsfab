// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Every model-key sender in the runtime reads its key through the release path.
 *
 * A sender is code that puts a key on a request: Pi's `setRuntimeApiKey(...)`,
 * a `Bearer ${...}` header in any letter case, or an `x-api-key` header.
 * Each one under `packages/runtime/src` must read its key through
 * `credentialForRequest()` from `security/model-credential-release.js`:
 * inline, or through a `const` assigned from that call in the sender's own
 * function. That keeps one release path, so a model key reaches only the
 * endpoint the operator configured, and a new sender that skips it fails here.
 *
 * Senders and their keys are found in the TypeScript syntax tree, so comments
 * and strings never count, and a key name resolves in its lexical scope: a
 * parameter, or a declaration outside the sender's function, is never a
 * released key.
 *
 * A named exception carries a credential that is never a model key. Each one
 * names exactly one sender, by its file, kind, enclosing function, and key
 * expression. An exception that matches no sender, or more than one, fails the
 * check, so the list cannot go stale or cover a new sender.
 *
 * Only senders are checked. The exact-match screen and redaction read the raw
 * key on purpose and never put it on a request, so they need no entry: the
 * screen registration, `forbiddenCredential`, the request screen, and the
 * payload finalizers in `model/provider.ts`, redaction in `harness/pi.ts`, and
 * response redaction in `profile/probe-core.js`.
 *
 * Usage: node scripts/check-credential-senders.mjs --check [--root <package root>]
 */

import { readdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";

const scriptPath = fileURLToPath(import.meta.url);
const defaultPackageRoot = dirname(dirname(scriptPath));

const EXIT_OK = 0;
const EXIT_FINDINGS = 1;
const EXIT_REFUSED = 2;

export const CODES = Object.freeze({
  unreleased: "credential-sender-unreleased",
  staleException: "credential-sender-exception-stale",
  ambiguousException: "credential-sender-exception-ambiguous",
  usage: "credential-sender-usage",
});

const USAGE = "Usage: node scripts/check-credential-senders.mjs --check [--root <package root>]";
const SCAN_ROOT = "src";
const RELEASE_CALL = "credentialForRequest";
const X_API_KEY = "x-api-key";
/** The authorization scheme, compared in lowercase: scheme names are case-insensitive. */
const BEARER_PREFIX = "bearer ";
const MODULE_SCOPE = "<module>";
/** Text every file with a sender holds; other files are not parsed. */
const SENDER_TEXT = /setRuntimeApiKey|Bearer |x-api-key/iu;

/** Senders that carry a credential other than a model key. */
export const NAMED_EXCEPTIONS = Object.freeze([
  {
    path: "src/cli/review-delivery-auth.ts",
    sender: "bearer-header",
    within: "authorization",
    key: "token",
    reason: "the selected GitHub CLI user token, which is never a model credential",
  },
  {
    path: "src/cli/review-delivery-auth.ts",
    sender: "bearer-header",
    within: "request",
    key: "token",
    reason: "the selected GitLab CLI user token, which is never a model credential",
  },
  {
    path: "src/model/inference-hub-metadata.ts",
    sender: "x-api-key-header",
    within: "boundedPageRequest",
    key: "input.credential",
    reason:
      "the Inference Hub Metadata API key (INFERENCE_HUB_METADATA_API_KEY), a distinct credential that is never a model key",
  },
]);

/** The expression under parentheses, type assertions, non-null marks, and `await`. */
function unwrap(expression) {
  let current = expression;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isTypeAssertionExpression(current) ||
    ts.isNonNullExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isAwaitExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function isReleaseCall(expression) {
  const call = unwrap(expression);
  return (
    ts.isCallExpression(call) &&
    ts.isIdentifier(unwrap(call.expression)) &&
    unwrap(call.expression).text === RELEASE_CALL
  );
}

function bindsName(name, wanted) {
  if (ts.isIdentifier(name)) return name.text === wanted;
  return name.elements.some(
    (element) => !ts.isOmittedExpression(element) && bindsName(element.name, wanted),
  );
}

/**
 * How a scope declares `wanted`, if it does: `released` for a `const` whose
 * initializer is a `credentialForRequest()` call and that precedes the use,
 * `other` for any other declaration.
 */
function declarationIn(scope, wanted, use) {
  if (ts.isFunctionLike(scope)) {
    return scope.parameters.some((parameter) => bindsName(parameter.name, wanted))
      ? "other"
      : undefined;
  }
  if (ts.isCatchClause(scope)) {
    return scope.variableDeclaration && bindsName(scope.variableDeclaration.name, wanted)
      ? "other"
      : undefined;
  }
  if (
    (ts.isForStatement(scope) || ts.isForOfStatement(scope) || ts.isForInStatement(scope)) &&
    scope.initializer &&
    ts.isVariableDeclarationList(scope.initializer)
  ) {
    return scope.initializer.declarations.some((declaration) => bindsName(declaration.name, wanted))
      ? "other"
      : undefined;
  }
  if (!("statements" in scope) || !Array.isArray(scope.statements)) return undefined;
  for (const statement of scope.statements) {
    if (ts.isVariableStatement(statement)) {
      const constant = (statement.declarationList.flags & ts.NodeFlags.Const) !== 0;
      for (const declaration of statement.declarationList.declarations) {
        if (!bindsName(declaration.name, wanted)) continue;
        return constant &&
          ts.isIdentifier(declaration.name) &&
          declaration.initializer !== undefined &&
          isReleaseCall(declaration.initializer) &&
          declaration.end <= use.getStart()
          ? "released"
          : "other";
      }
    } else if (
      (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) &&
      statement.name?.text === wanted
    ) {
      return "other";
    } else if (ts.isImportDeclaration(statement) && importsName(statement, wanted)) {
      return "other";
    }
  }
  return undefined;
}

function importsName(statement, wanted) {
  const clause = statement.importClause;
  if (!clause) return false;
  if (clause.name?.text === wanted) return true;
  const bindings = clause.namedBindings;
  if (!bindings) return false;
  if (ts.isNamespaceImport(bindings)) return bindings.name.text === wanted;
  return bindings.elements.some((element) => element.name.text === wanted);
}

/**
 * Whether an identifier resolves, inside the sender's own function, to a
 * released `const`. The walk stops at the first scope that declares the name,
 * and at the sender's function: a parameter, or a declaration in an outer
 * function or the module, does not count.
 */
function resolvesToReleasedConstant(identifier) {
  for (let scope = identifier.parent; scope; scope = scope.parent) {
    const found = declarationIn(scope, identifier.text, identifier);
    if (found !== undefined) return found === "released";
    if (ts.isFunctionLike(scope) || ts.isClassStaticBlockDeclaration(scope)) return false;
  }
  return false;
}

function readsReleasedKey(key) {
  if (key === undefined) return false;
  if (isReleaseCall(key)) return true;
  const inner = unwrap(key);
  return ts.isIdentifier(inner) && resolvesToReleasedConstant(inner);
}

/** The name of a function-like node, or of the binding or property that holds it. */
function functionName(node) {
  if (ts.isConstructorDeclaration(node)) return "constructor";
  if (node.name && (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name))) {
    return node.name.text;
  }
  const holder = node.parent;
  if (
    holder &&
    (ts.isVariableDeclaration(holder) || ts.isPropertyAssignment(holder)) &&
    (ts.isIdentifier(holder.name) || ts.isStringLiteral(holder.name))
  ) {
    return holder.name.text;
  }
  return undefined;
}

/** The innermost named function around a node, or the module. */
function enclosingFunction(node) {
  for (let current = node.parent; current; current = current.parent) {
    if (!ts.isFunctionLike(current)) continue;
    const name = functionName(current);
    if (name !== undefined) return name;
  }
  return MODULE_SCOPE;
}

/** The text of a string literal, or undefined for any other expression. */
function literalText(expression) {
  const inner = unwrap(expression);
  return ts.isStringLiteral(inner) || ts.isNoSubstitutionTemplateLiteral(inner)
    ? inner.text
    : undefined;
}

/** A property name written as a string, plainly or computed. */
function headerName(name) {
  return ts.isComputedPropertyName(name) ? literalText(name.expression) : literalText(name);
}

/** Each sender in a syntax tree: its kind, the node to report, and its key expression. */
function sendersIn(sourceFile) {
  const found = [];
  const visit = (node) => {
    if (ts.isCallExpression(node)) {
      const callee = unwrap(node.expression);
      const name = ts.isPropertyAccessExpression(callee)
        ? callee.name
        : ts.isIdentifier(callee)
          ? callee
          : undefined;
      if (name?.text === "setRuntimeApiKey") {
        found.push({
          sender: "pi-runtime-key",
          at: name,
          key: node.arguments.at(1) ?? node.arguments.at(0),
        });
      }
    } else if (ts.isTemplateExpression(node)) {
      node.templateSpans.forEach((span, index) => {
        const before = index === 0 ? node.head.text : node.templateSpans[index - 1].literal.text;
        if (before.toLowerCase().endsWith(BEARER_PREFIX)) {
          found.push({ sender: "bearer-header", at: span.expression, key: span.expression });
        }
      });
    } else if (
      ts.isPropertyAssignment(node) &&
      headerName(node.name)?.toLowerCase() === X_API_KEY
    ) {
      found.push({ sender: "x-api-key-header", at: node.name, key: node.initializer });
    } else if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isElementAccessExpression(node.left) &&
      literalText(node.left.argumentExpression)?.toLowerCase() === X_API_KEY
    ) {
      found.push({
        sender: "x-api-key-header",
        at: node.left.argumentExpression,
        key: node.right,
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return found;
}

function scriptKind(file) {
  return file.endsWith(".ts") ? ts.ScriptKind.TS : ts.ScriptKind.JS;
}

function sourceFiles(directory) {
  const found = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      found.push(...sourceFiles(path));
    } else if (
      entry.isFile() &&
      /\.(?:ts|js|mjs)$/u.test(entry.name) &&
      !entry.name.endsWith(".d.ts") &&
      !/\.test\.[cm]?[jt]s$/u.test(entry.name)
    ) {
      found.push(path);
    }
  }
  return found.sort();
}

function sameOccurrence(exception, entry) {
  return (
    exception.path === entry.path &&
    exception.sender === entry.sender &&
    exception.within === entry.within &&
    exception.key === entry.key
  );
}

/**
 * Every sender under `<packageRoot>/src`, with whether it reads a released
 * key, and the findings: unreleased senders that no exception names, and
 * exceptions that match no sender or more than one.
 */
export function scanCredentialSenders({
  packageRoot = defaultPackageRoot,
  exceptions = NAMED_EXCEPTIONS,
} = {}) {
  const senders = [];
  for (const file of sourceFiles(join(packageRoot, SCAN_ROOT))) {
    const text = readFileSync(file, "utf8");
    if (!SENDER_TEXT.test(text)) continue;
    const path = relative(packageRoot, file).split(sep).join("/");
    const sourceFile = ts.createSourceFile(
      file,
      text,
      ts.ScriptTarget.Latest,
      true,
      scriptKind(file),
    );
    for (const found of sendersIn(sourceFile)) {
      senders.push({
        path,
        line: sourceFile.getLineAndCharacterOfPosition(found.at.getStart(sourceFile)).line + 1,
        sender: found.sender,
        within: enclosingFunction(found.at),
        key: found.key ? found.key.getText(sourceFile).replace(/\s+/gu, " ") : "",
        released: readsReleasedKey(found.key),
      });
    }
  }
  const unreleased = senders.filter((entry) => !entry.released);
  const matches = exceptions.map((exception) =>
    unreleased.filter((entry) => sameOccurrence(exception, entry)),
  );
  const covered = new Set(matches.filter((matched) => matched.length === 1).flat());
  const findings = [
    ...unreleased
      .filter((entry) => !covered.has(entry))
      .map(
        (entry) =>
          `${CODES.unreleased}: ${entry.path}:${entry.line} ${entry.sender} in ${entry.within} puts a model key on a request without credentialForRequest(); release it with releaseModelCredential() for the configured endpoint.`,
      ),
    ...exceptions.flatMap((exception, index) => {
      const count = matches[index].length;
      if (count === 1) return [];
      return count === 0
        ? [
            `${CODES.staleException}: ${exception.path} has no unreleased ${exception.sender} in ${exception.within} sending ${exception.key}; remove its exception.`,
          ]
        : [
            `${CODES.ambiguousException}: the exception for ${exception.path} ${exception.sender} in ${exception.within} sending ${exception.key} matches ${count} senders; each exception names exactly one.`,
          ];
    }),
  ];
  return { senders, findings };
}

export function main(argv, { packageRoot = defaultPackageRoot, exceptions } = {}) {
  let root = packageRoot;
  let check = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--check") {
      check = true;
    } else if (argument === "--root" && argv[index + 1] && !argv[index + 1].startsWith("--")) {
      root = resolve(argv[index + 1]);
      index += 1;
    } else {
      return { status: EXIT_REFUSED, stdout: "", stderr: `${CODES.usage}: ${USAGE}\n` };
    }
  }
  if (!check) {
    return {
      status: EXIT_REFUSED,
      stdout: "",
      stderr: `${CODES.usage}: nothing was checked; pass --check. ${USAGE}\n`,
    };
  }
  const { senders, findings } = scanCredentialSenders({
    packageRoot: root,
    ...(exceptions ? { exceptions } : {}),
  });
  if (findings.length > 0) {
    return { status: EXIT_FINDINGS, stdout: "", stderr: `${findings.join("\n")}\n` };
  }
  const released = senders.filter((entry) => entry.released).length;
  return {
    status: EXIT_OK,
    stdout: `OK: ${released} model-key senders read a released key; ${senders.length - released} named exception sender(s).\n`,
    stderr: "",
  };
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
