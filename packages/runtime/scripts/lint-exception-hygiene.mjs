#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Ratchet exception hygiene without rewriting DocsFab's existing debt.
 *
 * Scans production TypeScript for public-scope static throw messages with fewer
 * than eight words or no final punctuation. CLI-reachable `throw new Error("…")`
 * (and `throw Error("…")`) also fail unless they already go through an envelope
 * helper, a `*ContractError` / `*OperatorError` constructor, or an explicit
 * `// hygiene: envelope` / `// hygiene: ok` justification. Existing debt stays
 * in the baseline; new CLI paths must map rather than grow the baseline.
 *
 * Fingerprints exclude line numbers, so moving code does not churn the
 * baseline. Fixing a finding makes the baseline stale until `--write-baseline`
 * runs in the same change.
 *
 * Refresh deliberately:
 *   node scripts/lint-exception-hygiene.mjs --write-baseline
 * See docs/reference/operations/exception-hygiene.md.
 */

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const DEFAULT_SOURCE = join(root, "src");
const DEFAULT_BASELINE = join(root, "scripts", "exception-hygiene-baseline.json");
const MIN_WORDS = 8;
const HYGIENE_MARKER = /\/\/\s*hygiene:\s*(envelope|ok)\b/iu;
const ENVELOPE_HELPERS = new Set([
  "toOperatorErrorEnvelope",
  "formatOperatorErrorEnvelope",
  "serializeOperatorErrorEnvelope",
  "reportOperatorFailure",
  "formatDoctorFailure",
  "serializeDoctorFailure",
  "mapDoctorFailure",
  "formatInitFailure",
  "serializeInitFailure",
  "mapInitFailure",
  "wrapKnowledgeAdapterFailure",
]);

/**
 * @typedef {{
 *   rule: string;
 *   path: string;
 *   scope: string;
 *   evidence: string;
 *   line: number;
 * }} Violation
 */

/**
 * @param {Violation} item
 * @returns {string}
 */
function fingerprint(item) {
  return [item.rule, item.path, item.scope, item.evidence].join("|");
}

/**
 * @param {Violation} item
 * @returns {string}
 */
function display(item) {
  const scope = item.scope ? ` (${item.scope})` : "";
  return `${item.path}:${item.line}: ${item.rule}${scope}: ${item.evidence}`;
}

/**
 * @param {string} directory
 * @returns {string[]}
 */
function walkTypeScript(directory) {
  /** @type {string[]} */
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "dist") continue;
      files.push(...walkTypeScript(path));
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) {
      files.push(path);
    }
  }
  return files.sort();
}

/**
 * @param {string[]} scopes
 * @returns {boolean}
 */
function isPrivateScope(scopes) {
  for (let index = scopes.length - 1; index >= 0; index -= 1) {
    const name = scopes[index];
    if (name.startsWith("__") && name.endsWith("__")) return false;
    return name.startsWith("_");
  }
  return false;
}

/**
 * @param {ts.Node} node
 * @returns {string | undefined}
 */
function staticText(node) {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return node.text;
  }
  if (ts.isTemplateExpression(node)) {
    let text = node.head.text;
    for (const span of node.templateSpans) {
      text += " <value> ";
      text += span.literal.text;
    }
    return text;
  }
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = staticText(node.left);
    const right = staticText(node.right);
    if (left === undefined && right === undefined) return undefined;
    return `${left ?? ""}${right ?? ""}`;
  }
  return undefined;
}

/**
 * @param {string} text
 * @returns {string | undefined}
 */
function raiseEvidence(text) {
  const stripped = text.split(/\s+/u).filter(Boolean).join(" ");
  /** @type {string[]} */
  const problems = [];
  if (!stripped) {
    problems.push("empty message");
  } else {
    if (!/[.?]$/u.test(stripped)) problems.push("missing final punctuation");
    const words = stripped.split(" ").length;
    if (words < MIN_WORDS) problems.push(`${words} words (minimum ${MIN_WORDS})`);
  }
  if (problems.length === 0) return undefined;
  return `${problems.join("; ")}; message=${JSON.stringify(stripped)}`;
}

/**
 * @param {string[]} lines
 * @param {number} line
 * @returns {boolean}
 */
function hasHygieneJustification(lines, line) {
  const current = lines[line - 1] ?? "";
  if (HYGIENE_MARKER.test(current)) return true;
  const previous = line > 1 ? (lines[line - 2] ?? "") : "";
  return HYGIENE_MARKER.test(previous);
}

/**
 * @param {string} relativePath
 * @returns {boolean}
 */
function isCliReachablePath(relativePath) {
  if (relativePath.endsWith(".test.ts") || relativePath.endsWith(".ts.test.ts")) return false;
  return relativePath === "src/cli.ts" || relativePath.startsWith("src/cli/");
}

/**
 * @param {ts.Expression} expression
 * @returns {boolean}
 */
function isBareErrorThrow(expression) {
  if (ts.isNewExpression(expression) && ts.isIdentifier(expression.expression)) {
    return expression.expression.text === "Error";
  }
  if (ts.isCallExpression(expression) && ts.isIdentifier(expression.expression)) {
    return expression.expression.text === "Error";
  }
  return false;
}

/**
 * @param {ts.Expression} expression
 * @returns {boolean}
 */
function isEnvelopeUsage(expression) {
  if (ts.isCallExpression(expression)) {
    const callee = expression.expression;
    if (ts.isIdentifier(callee) && ENVELOPE_HELPERS.has(callee.text)) return true;
    if (ts.isPropertyAccessExpression(callee) && ENVELOPE_HELPERS.has(callee.name.text)) {
      return true;
    }
  }
  if (ts.isNewExpression(expression)) {
    // ContractError-style constructors are mapped through the envelope at CLI
    // boundaries; treat code-bearing contract rejects as envelope-backed.
    const ctor = expression.expression;
    if (ts.isIdentifier(ctor) && /ContractError$|OperatorError$/u.test(ctor.text)) {
      return true;
    }
  }
  return false;
}

/**
 * @param {string} path
 * @param {string} repoRoot
 * @returns {Violation[]}
 */
function scanFile(path, repoRoot) {
  const sourceText = readFileSync(path, "utf8");
  const lines = sourceText.split(/\r?\n/u);
  const source = ts.createSourceFile(
    path,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  /** @type {Violation[]} */
  const findings = [];
  /** @type {string[]} */
  const scopes = [];
  const relativePath = relative(repoRoot, path).split("\\").join("/");

  /**
   * @param {ts.Node} node
   */
  function visit(node) {
    const enter =
      (ts.isFunctionDeclaration(node) ||
        ts.isMethodDeclaration(node) ||
        ts.isFunctionExpression(node) ||
        ts.isArrowFunction(node) ||
        ts.isConstructorDeclaration(node) ||
        ts.isGetAccessor(node) ||
        ts.isSetAccessor(node)) &&
      (node.name && ts.isIdentifier(node.name)
        ? node.name.text
        : ts.isConstructorDeclaration(node)
          ? "constructor"
          : ts.isArrowFunction(node) || ts.isFunctionExpression(node)
            ? "<anonymous>"
            : undefined);

    const classEnter = ts.isClassDeclaration(node) && node.name ? node.name.text : undefined;

    if (classEnter) scopes.push(classEnter);
    if (enter) scopes.push(enter);

    if (ts.isThrowStatement(node) && node.expression && !isPrivateScope(scopes)) {
      const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
      if (!hasHygieneJustification(lines, line) && !isEnvelopeUsage(node.expression)) {
        let messageNode;
        if (ts.isNewExpression(node.expression) && node.expression.arguments?.length) {
          messageNode = node.expression.arguments[0];
        } else if (
          ts.isCallExpression(node.expression) &&
          ts.isIdentifier(node.expression.expression) &&
          node.expression.expression.text === "Error" &&
          node.expression.arguments?.length
        ) {
          messageNode = node.expression.arguments[0];
        }
        const text = messageNode ? staticText(messageNode) : undefined;
        if (text !== undefined) {
          const evidence = raiseEvidence(text);
          if (evidence) {
            findings.push({
              rule: "raise-message",
              path: relativePath,
              scope: scopes.join("."),
              evidence,
              line,
            });
          }
        }
        if (isCliReachablePath(relativePath) && isBareErrorThrow(node.expression)) {
          findings.push({
            rule: "unmapped-cli-throw",
            path: relativePath,
            scope: scopes.join("."),
            evidence: `CLI-reachable throw new Error without catalog or frozen-stem mapping; message=${JSON.stringify(text ?? "<dynamic>")}`,
            line,
          });
        }
      }
    }

    ts.forEachChild(node, visit);

    if (enter) scopes.pop();
    if (classEnter) scopes.pop();
  }

  visit(source);
  return findings;
}

/**
 * @param {string} source
 * @param {string} repoRoot
 * @returns {Violation[]}
 */
export function scan(source, repoRoot) {
  const sourcePath = resolve(source);
  const files = statSync(sourcePath).isFile() ? [sourcePath] : walkTypeScript(sourcePath);
  const findings = files.flatMap((file) => scanFile(file, repoRoot));
  return findings.sort(
    (left, right) => fingerprint(left).localeCompare(fingerprint(right)) || left.line - right.line,
  );
}

/**
 * @param {string} path
 * @returns {string[]}
 */
function loadBaseline(path) {
  if (!existsSync(path)) return [];
  const raw = JSON.parse(readFileSync(path, "utf8"));
  if (!raw || typeof raw !== "object" || !Array.isArray(raw.fingerprints)) {
    throw new TypeError(
      `Invalid exception hygiene baseline ${path}; expected a fingerprints list.`,
    );
  }
  if (!raw.fingerprints.every((item) => typeof item === "string")) {
    throw new TypeError(`Invalid exception hygiene baseline ${path}; entries must be strings.`);
  }
  return [...raw.fingerprints].sort();
}

/**
 * @param {string} path
 * @param {Violation[]} findings
 */
function writeBaseline(path, findings) {
  const payload = {
    description:
      "Existing exception-hygiene debt; new or stale entries fail CI. Refresh with `node scripts/lint-exception-hygiene.mjs --write-baseline` after deliberate review.",
    fingerprints: findings.map((item) => fingerprint(item)).sort(),
  };
  writeFileSync(path, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

/**
 * @param {string[]} values
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
 * @param {{
 *   source?: string;
 *   baseline?: string;
 *   writeBaseline?: boolean;
 *   repoRoot?: string;
 * }} [options]
 * @returns {{
 *   status: number;
 *   findings: Violation[];
 *   stdout: string;
 *   stderr: string;
 * }}
 */
export function runExceptionHygiene(options = {}) {
  const repoRoot = options.repoRoot ?? root;
  const source = options.source ?? DEFAULT_SOURCE;
  const baseline = options.baseline ?? DEFAULT_BASELINE;
  const findings = scan(source, repoRoot);

  if (options.writeBaseline) {
    writeBaseline(baseline, findings);
    return {
      status: 0,
      findings,
      stdout: `Wrote ${findings.length} exception-hygiene fingerprints to ${relative(repoRoot, baseline) || baseline}.\n`,
      stderr: "",
    };
  }

  const expected = loadBaseline(baseline);
  const current = findings.map((item) => fingerprint(item)).sort();
  const expectedCounts = counts(expected);
  const currentCounts = counts(current);
  const novel = subtract(currentCounts, expectedCounts);
  const stale = subtract(expectedCounts, currentCounts);

  /** @type {string[]} */
  const stderrLines = [];
  if (novel.size > 0) {
    const byFingerprint = new Map(findings.map((item) => [fingerprint(item), item]));
    stderrLines.push("New exception-hygiene violations:");
    for (const [value, count] of [...novel.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      const item = byFingerprint.get(value);
      const suffix = count > 1 ? ` (${count} occurrences)` : "";
      stderrLines.push(`  ${item ? display(item) : value}${suffix}`);
    }
  }
  if (stale.size > 0) {
    stderrLines.push("Stale exception-hygiene baseline entries:");
    for (const [value, count] of [...stale.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      const suffix = count > 1 ? ` (${count} occurrences)` : "";
      stderrLines.push(`  ${value}${suffix}`);
    }
  }
  if (novel.size > 0 || stale.size > 0) {
    stderrLines.push(
      "Fix the finding or run `node scripts/lint-exception-hygiene.mjs --write-baseline` after deliberate review.",
    );
    return {
      status: 1,
      findings,
      stdout: "",
      stderr: `${stderrLines.join("\n")}\n`,
    };
  }

  const digest = createHash("sha256").update(current.join("\n")).digest("hex").slice(0, 12);
  return {
    status: 0,
    findings,
    stdout: `OK: ${findings.length} known findings; no exception-hygiene drift (baseline ${digest}).\n`,
    stderr: "",
  };
}

function main(argv = process.argv.slice(2)) {
  let source = DEFAULT_SOURCE;
  let baseline = DEFAULT_BASELINE;
  let write = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--write-baseline") write = true;
    else if (arg === "--source") source = resolve(argv[++index] ?? "");
    else if (arg === "--baseline") baseline = resolve(argv[++index] ?? "");
    else if (arg === "--help" || arg === "-h") {
      process.stdout.write(
        "Usage: node scripts/lint-exception-hygiene.mjs [--source <dir>] [--baseline <file>] [--write-baseline]\n",
      );
      return 0;
    } else {
      process.stderr.write(`Unknown option: ${arg}\n`);
      return 2;
    }
  }

  const result = runExceptionHygiene({ source, baseline, writeBaseline: write });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  return result.status;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main();
}
