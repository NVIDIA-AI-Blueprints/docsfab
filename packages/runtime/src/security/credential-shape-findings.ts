// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { AsyncLocalStorage } from "node:async_hooks";

import {
  type ConfiguredCredentialMatch,
  findConfiguredCredential,
  findConfiguredCredentialInValue,
} from "./configured-credentials.js";
import type { CredentialFinding } from "./credential-findings.js";
import { SECURITY_RULE_IDS } from "./repository-scanner.js";
import {
  CREDENTIAL_TOKEN_SHAPES,
  DOCUMENT_CREDENTIAL_SHAPES,
  TEXT_CREDENTIAL_SHAPES,
} from "./text-credential-shapes.js";

/**
 * Flag-and-continue screens for text that only looks like a credential (#1807).
 *
 * Under the owner decision on #1807, any string can be a password, so a shape
 * match never stops, refuses, or withholds. A screen that used to refuse on a
 * shape now calls `screenCredentialText` or `screenCredentialValue`:
 *
 * - DocsFab's own configured credential, matched exactly, is returned, and the
 *   caller refuses with its existing code.
 * - Every rule the screen's detector reports becomes a `credential-like-content`
 *   finding that names the location and the rule, never the text. The text
 *   continues.
 *
 * A recorded finding goes to every open finding scope. A flow with a place to
 * tell the maintainers opens one and renders what it collects, or builds its
 * findings directly with `credentialFindingsAt`, as the MR description does.
 * With no scope open, the finding is written to stderr as one content-free line,
 * so it is never silently lost.
 */

/**
 * The finding code, and the order findings are kept in. `credential-findings.ts`
 * declares both, but it imports the limits module, which plain
 * `node --experimental-strip-types` cannot load. This module is in the hosted
 * wire's hook-free graph, so it imports only that module's types; a test keeps
 * the two orders the same.
 */
const CREDENTIAL_LIKE_CONTENT: CredentialFinding["code"] = "credential-like-content";

/** Findings sorted by location, then rule, with duplicates removed. */
function sortCredentialFindings(findings: readonly CredentialFinding[]): CredentialFinding[] {
  const unique = new Map<string, CredentialFinding>();
  for (const finding of findings) {
    unique.set(`${finding.location}\0${finding.rule}`, {
      code: CREDENTIAL_LIKE_CONTENT,
      location: finding.location,
      rule: finding.rule,
    });
  }
  return [...unique.values()].sort(
    (left, right) =>
      compareText(left.location, right.location) || compareText(left.rule, right.rule),
  );
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** The rule for a bearer value, which the repository scanner has no rule for. */
export const BEARER_VALUE_RULE_ID = "credential.bearer-value";
/** The rule for a URL that carries a user name and password, such as `https://user:password@host`. */
export const URL_USERINFO_RULE_ID = "credential.url-userinfo";
/** The rule for text shaped like an HTTP `Authorization:` header. */
export const AUTHORIZATION_HEADER_RULE_ID = "credential.authorization-header";
/** The rule for GitLab's `PRIVATE-TOKEN` header name, in any case or separator. */
export const PRIVATE_TOKEN_HEADER_RULE_ID = "credential.private-token-header";

/** A detector: the rule ids that match one text. */
export type CredentialRuleDetector = (text: string) => Iterable<string>;

const TOKEN_SHAPE_RULE_IDS: ReadonlyMap<RegExp, string> = new Map([
  [CREDENTIAL_TOKEN_SHAPES.gitlab, SECURITY_RULE_IDS.gitlabToken],
  [CREDENTIAL_TOKEN_SHAPES.github, SECURITY_RULE_IDS.githubToken],
  [CREDENTIAL_TOKEN_SHAPES.slack, SECURITY_RULE_IDS.slackToken],
  [CREDENTIAL_TOKEN_SHAPES.slackRefresh, SECURITY_RULE_IDS.slackToken],
  [CREDENTIAL_TOKEN_SHAPES.slackApp, SECURITY_RULE_IDS.slackToken],
  [CREDENTIAL_TOKEN_SHAPES.nvidia, SECURITY_RULE_IDS.nvidiaApiKey],
  [CREDENTIAL_TOKEN_SHAPES.openai, SECURITY_RULE_IDS.openAiApiKey],
  [CREDENTIAL_TOKEN_SHAPES.googleOauth, SECURITY_RULE_IDS.googleOauthToken],
  [CREDENTIAL_TOKEN_SHAPES.googleApiKey, SECURITY_RULE_IDS.googleApiKey],
  [CREDENTIAL_TOKEN_SHAPES.aws, SECURITY_RULE_IDS.awsAccessKey],
  [CREDENTIAL_TOKEN_SHAPES.jwt, SECURITY_RULE_IDS.jwt],
]);

/**
 * The rule for a shape in the shared lists. Issuer token shapes are matched by
 * identity; the four others are the assignment, bearer, JWT-prefix, and PEM
 * banner shapes, named by what each one matches.
 */
function shapeRule(shape: RegExp): string {
  const token = TOKEN_SHAPE_RULE_IDS.get(shape);
  if (token !== undefined) return token;
  if (shape.source.includes("PRIVATE KEY")) return SECURITY_RULE_IDS.privateKey;
  if (shape.source.includes("Bearer")) return BEARER_VALUE_RULE_ID;
  if (shape.source.includes("eyJ")) return SECURITY_RULE_IDS.jwt;
  if (shape.source.includes("password")) return SECURITY_RULE_IDS.assignedSecret;
  throw new Error("credential-shape-findings: a shared credential shape has no rule.");
}

const DOCUMENT_SHAPE_RULES = DOCUMENT_CREDENTIAL_SHAPES.map(
  (shape) => [shape, shapeRule(shape)] as const,
);
const TEXT_SHAPE_RULES = TEXT_CREDENTIAL_SHAPES.map((shape) => [shape, shapeRule(shape)] as const);

function matchingRules(text: string, rules: readonly (readonly [RegExp, string])[]): string[] {
  const matched = new Set<string>();
  for (const [shape, rule] of rules) if (shape.test(text)) matched.add(rule);
  return [...matched].sort();
}

/** Rule ids of the `DOCUMENT_CREDENTIAL_SHAPES` that match: the hosted record list. */
export function documentShapeRuleIds(text: string): string[] {
  return matchingRules(text, DOCUMENT_SHAPE_RULES);
}

/** Rule ids of the `TEXT_CREDENTIAL_SHAPES` that match: the shared-channel list. */
export function textShapeRuleIds(text: string): string[] {
  return matchingRules(text, TEXT_SHAPE_RULES);
}

const TOKEN_PREFIX_RULES: readonly (readonly [string, string])[] = [
  ["glpat-", SECURITY_RULE_IDS.gitlabToken],
  ["github_pat_", SECURITY_RULE_IDS.githubToken],
  ["gh[pousr]_", SECURITY_RULE_IDS.githubToken],
  ["nvapi-", SECURITY_RULE_IDS.nvidiaApiKey],
  ["sk-(?:proj-)?", SECURITY_RULE_IDS.openAiApiKey],
  ["xox[baprs]-", SECURITY_RULE_IDS.slackToken],
];
const PREFIX_SHAPES = new Map<string, readonly (readonly [RegExp, string])[]>();

/**
 * Rule ids for the issuer prefixes the roadmap identifier screens test:
 * `glpat-`, `github_pat_`, `gh[pousr]_`, `nvapi-`, `sk-`, and `xox[baprs]-`.
 * `anchored` tests only the start of the text, and `ignoreCase` ignores case.
 * Elsewhere a prefix starts after a character other than an ASCII letter or
 * digit, so `task-list` does not name an `sk-` key: a finding only tunes how
 * noisy the screen is, and the refusal this replaced matched inside words.
 */
export function tokenPrefixRuleIds(
  text: string,
  options: { readonly anchored?: boolean; readonly ignoreCase?: boolean } = {},
): string[] {
  const key = `${options.anchored === true ? "^" : ""}${options.ignoreCase === true ? "i" : ""}`;
  let shapes = PREFIX_SHAPES.get(key);
  if (shapes === undefined) {
    shapes = TOKEN_PREFIX_RULES.map(
      ([prefix, rule]) =>
        [
          new RegExp(
            `${options.anchored === true ? "^" : "(?<![A-Za-z0-9])"}${prefix}`,
            options.ignoreCase ? "iu" : "u",
          ),
          rule,
        ] as const,
    );
    PREFIX_SHAPES.set(key, shapes);
  }
  return matchingRules(text, shapes);
}

/** Rule ids a per-text detector reports for any string value in a structure. */
export function ruleIdsInValue(value: unknown, detect: CredentialRuleDetector): string[] {
  const matched = new Set<string>();
  visitStringValues(value, (text) => {
    for (const rule of detect(text)) matched.add(rule);
  });
  return [...matched].sort();
}

/** One finding at `location` for each rule, sorted and without duplicates. */
export function credentialFindingsAt(
  location: string,
  rules: Iterable<string>,
): CredentialFinding[] {
  return sortCredentialFindings(
    [...rules].map((rule) => ({ code: CREDENTIAL_LIKE_CONTENT, location, rule })),
  );
}

type FindingScope = CredentialFinding[];

/**
 * One store for every module instance: the host can load this file through
 * both its ESM graph and a tsx CommonJS require, and a scope one opens must
 * collect what the other records.
 */
const SCOPE_STORAGE = Symbol.for("docsfab.credential-finding-scopes");

function scopeStorage(): AsyncLocalStorage<readonly FindingScope[]> {
  const holder = globalThis as { [SCOPE_STORAGE]?: AsyncLocalStorage<readonly FindingScope[]> };
  holder[SCOPE_STORAGE] ??= new AsyncLocalStorage<readonly FindingScope[]>();
  return holder[SCOPE_STORAGE];
}

/**
 * A location that can be shown as written: the delivery changed-path rule
 * (no leading `/`, no `..` segment, no backtick, `<` or `>`), extended to
 * every control character (Cc: tab, LF and CR included), every format
 * character (Cf: bidi controls included), and every separator (Z: the ASCII
 * space, line and paragraph separators included). A repository file name can
 * hold any of these. In a merge request description, a backtick ends a code
 * span and a line break starts a GitLab quick action; a space lets a closing
 * keyword sit beside an issue reference, which GitLab reads even inside code.
 * In a log line, a line break starts a forged line.
 */
const SHOWABLE_LOCATION = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[^\p{Cc}\p{Cf}\p{Z}`<>]+$/u;
/** A rule that can be shown as written: the scanner's dotted, hyphenated rule ids. */
const SHOWABLE_RULE = /^[A-Za-z0-9._-]+$/u;

/**
 * Whether a finding's location and rule can be shown as written in a merge
 * request description or a log line (#1807). A finding that fails is never
 * shown raw: the description counts it, and the stderr line escapes it.
 */
export function isShowableCredentialFinding(finding: CredentialFinding): boolean {
  return SHOWABLE_LOCATION.test(finding.location) && SHOWABLE_RULE.test(finding.rule);
}

/**
 * `value` as a JSON string with every character outside printable ASCII
 * escaped as `\uXXXX`, one escape per UTF-16 code unit.
 */
function escapedForLog(value: string): string {
  return JSON.stringify(value).replace(/[^\x20-\x7e]/gu, (character) =>
    Array.from(
      { length: character.length },
      (_unit, index) => `\\u${character.charCodeAt(index).toString(16).padStart(4, "0")}`,
    ).join(""),
  );
}

/**
 * Record findings in every open scope. With none open, write them to stderr as
 * one content-free line: a location and a rule each, never a value. A finding
 * that cannot be shown as written is printed as an escaped JSON string, so a
 * file name cannot start a new log line.
 */
export function recordCredentialFindings(findings: readonly CredentialFinding[]): void {
  if (findings.length === 0) return;
  const scopes = scopeStorage().getStore();
  if (scopes !== undefined && scopes.length > 0) {
    for (const scope of scopes) scope.push(...findings);
    return;
  }
  const listed = sortCredentialFindings(findings)
    .map((finding) =>
      isShowableCredentialFinding(finding)
        ? `${finding.location} (${finding.rule})`
        : `${escapedForLog(finding.location)} (${escapedForLog(finding.rule)})`,
    )
    .join(", ");
  process.stderr.write(
    `docsfab: ${CREDENTIAL_LIKE_CONTENT} flagged for maintainers; DocsFab did not remove it: ${listed}\n`,
  );
}

/**
 * Run `operation` in a new finding scope and return its result with what was
 * recorded while it ran. Enclosing scopes still receive every finding.
 */
export function collectCredentialFindings<T>(operation: () => T): {
  readonly result: T;
  readonly findings: CredentialFinding[];
} {
  const scope: FindingScope = [];
  const storage = scopeStorage();
  const result = storage.run([...(storage.getStore() ?? []), scope], operation);
  return { result, findings: sortCredentialFindings(scope) };
}

/** `collectCredentialFindings` for asynchronous work: it collects until the work settles. */
export async function collectCredentialFindingsAsync<T>(operation: () => Promise<T>): Promise<{
  readonly result: T;
  readonly findings: CredentialFinding[];
}> {
  const scope: FindingScope = [];
  const storage = scopeStorage();
  const result = await storage.run([...(storage.getStore() ?? []), scope], operation);
  return { result, findings: sortCredentialFindings(scope) };
}

/**
 * Screen one text a check used to refuse for its shape. Returns DocsFab's own
 * configured credential when the text carries one, for the caller to refuse
 * with its existing code. Otherwise records a finding at `location` for each
 * rule `detect` reports and returns null: the text continues.
 */
export function screenCredentialText(
  text: string,
  location: string,
  detect: CredentialRuleDetector,
): ConfiguredCredentialMatch | null {
  const match = findConfiguredCredential(text);
  if (match !== null) return match;
  recordCredentialFindings(credentialFindingsAt(location, detect(text)));
  return null;
}

/**
 * `screenCredentialText` for a structured value. The configured match covers
 * every string key and value; `detect` sees the whole value, so a detector for
 * credential-named fields keeps its context.
 */
export function screenCredentialValue(
  value: unknown,
  location: string,
  detect: (value: unknown) => Iterable<string>,
): ConfiguredCredentialMatch | null {
  const match = findConfiguredCredentialInValue(value);
  if (match !== null) return match;
  recordCredentialFindings(credentialFindingsAt(location, detect(value)));
  return null;
}

/** Call `visit` on every string value, not key, in a structure. A cycle is visited once. */
function visitStringValues(value: unknown, visit: (text: string) => void): void {
  const seen = new WeakSet<object>();
  const pending: unknown[] = [value];
  while (pending.length > 0) {
    const current = pending.pop();
    if (typeof current === "string") {
      visit(current);
      continue;
    }
    if (current === null || typeof current !== "object" || seen.has(current)) continue;
    seen.add(current);
    for (const item of Array.isArray(current) ? current : Object.values(current)) {
      pending.push(item);
    }
  }
}
