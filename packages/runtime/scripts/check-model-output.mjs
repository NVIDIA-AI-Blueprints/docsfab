#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Generate and verify the model-output rule catalog (ADR
 * planning/design/model-output-rule-catalog-decision.md).
 *
 * Every rule the host enforces on model output is one record under
 * config/model-output/. This generator validates the catalog and renders:
 *
 * - runtime bindings (`src/contracts/model-output.generated.ts`): the rule
 *   table, the typed code, family, and location unions, grammars, replay-mode
 *   statements, host text, response contracts, and the raise functions;
 * - knowledge bindings (`packages/knowledge/src/model-output.generated.mjs`);
 * - the response-contract key vocabulary mirror; and
 * - the generated rule reference (`docs/reference/contracts/model-output-rules.md`).
 *
 * Usage:
 *   node scripts/check-model-output.mjs                  # write
 *   node scripts/check-model-output.mjs --check          # verify mirrors (drift)
 *   node scripts/check-model-output.mjs --check --gate   # plus coverage and conformance
 *   node scripts/check-model-output.mjs --check --committed-only   # committed mirrors only
 *   node scripts/check-model-output.mjs --print-mirror-paths
 *
 * Dependency-free: `runtime:derived:preflight` runs it before `npm ci`, so it
 * prefers the npm `yaml` parser and falls back to `lib/yaml-subset.mjs`, and it
 * renders TypeScript that Biome leaves unchanged instead of calling Biome.
 * It reads canonical sources only (config/, packages/quality/schemas,
 * packages/skills, packages/runtime/workflows, and the failure-class list), so
 * it runs before the skill-crate and quality-pack products and depends on neither.
 */
import { createRequire } from "node:module";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  RESPONSE_CONTRACT_KEY_SETS,
  renderResponseContractVocabularyMirror,
} from "../src/execution/response-contract-keys.js";
import { loadLimitDefinitions, parseLimitsYamlSubset } from "./check-limits.mjs";
import { parseYamlSubset } from "./lib/yaml-subset.mjs";

const require = createRequire(new URL("../package.json", import.meta.url));

export function loadYamlParse() {
  try {
    return require("yaml").parse;
  } catch (error) {
    if (error?.code === "MODULE_NOT_FOUND" || error?.code === "ERR_MODULE_NOT_FOUND") return null;
    throw error;
  }
}

const runtimeRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const DEFAULT_REPO_ROOT = resolve(runtimeRoot, "../..");

export const CATALOG_ROOT = "config/model-output";
export const ALLOWLIST_PATH = "config/model-output-allowlist.json";
export const RECORDED_CODES_PATH = `${CATALOG_ROOT}/recorded-codes.yaml`;
export const RUNTIME_GENERATED = "packages/runtime/src/contracts/model-output.generated.ts";
export const KNOWLEDGE_GENERATED = "packages/knowledge/src/model-output.generated.mjs";
export const VOCABULARY_GENERATED =
  "packages/runtime/src/execution/response-contract-vocabulary.generated.json";
export const REFERENCE_GENERATED =
  "packages/runtime/docs/reference/contracts/model-output-rules.md";
/**
 * Code mirrors the build generates (`scripts/ensure-derived.mjs`, which runs
 * after this check); `--committed-only` checks every other mirror.
 */
export const BUILD_GENERATED_MIRRORS = Object.freeze([
  RUNTIME_GENERATED,
  KNOWLEDGE_GENERATED,
  VOCABULARY_GENERATED,
]);
export const FAILURE_CLASS_SOURCE = "packages/runtime/src/operator/failure-class.ts";
const LIMITS_PATH = "config/limits.yaml";
const SCHEMA_ROOT = "packages/quality/schemas";
const WORKFLOW_ROOT = "packages/runtime/workflows";
const SKILL_ROOT = "packages/skills";
const GENERATOR = "packages/runtime/scripts/check-model-output.mjs";
const REPAIR = "npm run generate:model-output";
/** The limits the recorded code and location grammars read (config/inference-rejection-limits.ts). */
const SEGMENT_LIMIT = "inference.rejectionSegmentLength";
const REASON_LIMIT = "inference.rejectionReasonLength";

/** Rule kinds. The first four may be model-correctable; the last four always stop. */
export const RULE_KINDS = Object.freeze([
  "syntax",
  "shape",
  "content",
  "size",
  "authority",
  "disclosure",
  "integrity",
  "host",
]);
export const CORRECTABLE_KINDS = Object.freeze(["syntax", "shape", "content", "size"]);
export const TERMINAL_KINDS = Object.freeze(["authority", "disclosure", "integrity", "host"]);
/** Kinds a pinned code may carry (ADR "Pinned terminal codes"). */
export const PINNED_KINDS = Object.freeze(["authority", "disclosure"]);
const RETRY_DISPOSITIONS = Object.freeze(["model-correctable", "terminal"]);
/** Failure class a kind defaults to. `integrity` and `host` must declare one. */
const DEFAULT_FAILURE_CLASS = Object.freeze({
  syntax: "contract-shape",
  shape: "contract-shape",
  content: "model-content",
  size: "bound",
  authority: "model-content",
  disclosure: "model-content",
});
/**
 * Security and authority stems. A new code containing one must be kind
 * `disclosure` or `authority`; relabelling needs a rationale in the allowlist
 * (`pinned-terminal`). Recorded codes are pinned by identity in
 * recorded-codes.yaml; the stems catch a new code that is not yet pinned.
 */
export const PINNED_TERMINAL_STEMS = Object.freeze([
  "unsafe-disclosure",
  "credential",
  "source-authority",
  "target-authority",
  "unauthorized-source",
  "source-locator-membership",
  "unsafe-target",
]);
const OPERATOR_KINDS = Object.freeze(["correct", "recover", "redirect", "supply", "resume"]);
export const REPLAY_MODES = Object.freeze(["read-only", "disabled-write-step", "reset-write-step"]);
/** What a retry rule decides; the record's `retryDecision` vocabulary. */
export const RETRY_RULE_DECISIONS = Object.freeze([
  "retried",
  "declined",
  "exhausted",
  "not-applicable",
]);
const BACKOFF_FORMULAS = Object.freeze(["exponential-honour-retry-after"]);
const CONTRACT_OWNERS = Object.freeze(["runtime", "knowledge", "quality"]);
// `submit-tool` is the whole-answer tool; `records` submits judgment records
// and needs a `canonical` declaration (closed-schema-answer-records-decision.md §1.1).
const OUTPUT_MODES = Object.freeze(["text-final", "submit-tool", "records"]);

const KEBAB = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;
const PREFIX_CODE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*-$/u;
const LIMIT_NAME = /^[a-z][A-Za-z0-9]*(?:\.[a-z][A-Za-z0-9]*)+$/u;
const PLACEHOLDER = /\{(limit|grammar):([^{}]+)\}/gu;
const NUMERAL = /(?:[A-Za-z]+ )?\d+(?:[.,]\d+)*/gu;
const TS_LINE_WIDTH = 100;

/**
 * The recorded rejection code grammar, built exactly as
 * `INFERENCE_REJECTION_CODE_GRAMMAR` in config/inference-rejection-limits.ts
 * builds it; a runtime test holds the two sources equal.
 */
export function recordedCodeGrammar(segmentLength) {
  return new RegExp(`^[a-z](?:[a-z0-9-]{0,${segmentLength - 2}}[a-z0-9])?$`, "u");
}

/** The recorded rejection location grammar (`INFERENCE_REJECTION_LOCATION_GRAMMAR`). */
export function recordedLocationGrammar(segmentLength) {
  return new RegExp(
    `^\\$(?:response|(?:\\.[A-Za-z][A-Za-z0-9_]{0,${segmentLength - 1}}(?:\\[\\])*)*)$`,
    "u",
  );
}

class CatalogError extends Error {}

function fail(source, message) {
  throw new CatalogError(`${source}: ${message}`);
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(source, value, required, optional = []) {
  if (!isPlainObject(value)) fail(source, "must be a mapping");
  for (const key of required) {
    if (!Object.hasOwn(value, key)) fail(source, `missing required field ${key}`);
  }
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail(source, `unknown field ${key}`);
  }
}

function text(source, value, field) {
  if (typeof value !== "string" || value.trim() === "") {
    fail(source, `${field} must be non-empty text`);
  }
  if (value !== value.trim() || value.includes("\n")) {
    fail(source, `${field} must be one line without surrounding whitespace`);
  }
  return value;
}

function kebab(source, value, field) {
  if (typeof value !== "string" || !KEBAB.test(value)) {
    fail(source, `${field} must be a kebab-case name`);
  }
  return value;
}

function oneOf(source, value, allowed, field) {
  if (!allowed.includes(value)) fail(source, `${field} must be one of ${allowed.join(", ")}`);
  return value;
}

function list(source, value, field, { nonEmpty = true } = {}) {
  if (!Array.isArray(value) || (nonEmpty && value.length === 0)) {
    fail(source, `${field} must be a${nonEmpty ? " non-empty" : ""} list`);
  }
  return value;
}

function distinct(source, values, field) {
  if (new Set(values).size !== values.length) fail(source, `${field} repeats a value`);
  return values;
}

// ---------------------------------------------------------------------------
// Loading

function readText(root, path) {
  return readFileSync(join(root, path), "utf8");
}

function parseDocument(root, path, parseYaml) {
  const source = readText(root, path);
  const parsed = parseYaml ? parseYaml(source) : parseYamlSubset(source, path);
  if (!isPlainObject(parsed)) fail(path, "must be a YAML mapping");
  if (parsed.schemaVersion !== 1) fail(path, "must declare schemaVersion 1");
  return parsed;
}

function yamlFiles(root, directory) {
  const absolute = join(root, directory);
  if (!existsSync(absolute)) return [];
  return readdirSync(absolute)
    .filter((entry) => entry.endsWith(".yaml"))
    .sort()
    .map((entry) => `${directory}/${entry}`);
}

/**
 * Limit names and default values in the operational-limits catalog: the
 * config/limits.yaml registry and the per-owner fragments under
 * config/limits/. Read through the limits generator's own loader, so
 * this product sees exactly the limits, and the refusals, that product does.
 * `parseYaml` null selects the dependency-free subset parser.
 */
export function declaredLimits(root, parseYaml) {
  const definitions = loadLimitDefinitions({
    repoRoot: root,
    parseYaml: parseYaml ? (text) => parseYaml(text) : parseLimitsYamlSubset,
  });
  return new Map(definitions.map(({ name, value }) => [name, value]));
}

/** The `FAILURE_CLASSES` tuple, read from its one declaration. */
export function declaredFailureClasses(source) {
  const block = /export const FAILURE_CLASSES = Object\.freeze\(\[([^\]]*)\]/u.exec(source);
  if (!block) fail(FAILURE_CLASS_SOURCE, "does not declare FAILURE_CLASSES as a frozen tuple");
  const classes = [...block[1].matchAll(/"([a-z-]+)"/gu)].map((match) => match[1]);
  if (classes.length === 0) fail(FAILURE_CLASS_SOURCE, "FAILURE_CLASSES is empty");
  return classes;
}

/** Every step id a workflow manifest declares, at any depth. */
function manifestStepIds(manifest) {
  const ids = new Set();
  const walk = (value) => {
    if (Array.isArray(value)) {
      for (const item of value) walk(item);
      return;
    }
    if (!isPlainObject(value)) return;
    if (Array.isArray(value.steps)) {
      for (const step of value.steps) if (isPlainObject(step) && step.id) ids.add(step.id);
    }
    for (const nested of Object.values(value)) walk(nested);
  };
  walk(manifest);
  return ids;
}

function findManifestStep(manifest, stepId) {
  let found;
  const walk = (value) => {
    if (found) return;
    if (Array.isArray(value)) {
      for (const item of value) walk(item);
      return;
    }
    if (!isPlainObject(value)) return;
    if (Array.isArray(value.steps)) {
      for (const step of value.steps) if (isPlainObject(step) && step.id === stepId) found = step;
    }
    for (const nested of Object.values(value)) walk(nested);
  };
  walk(manifest);
  return found;
}

/**
 * Read every catalog document under `root`. Returns the raw parsed documents
 * and the repository facts validation needs, so `validateCatalog` stays pure.
 */
export function readCatalogSources(root = DEFAULT_REPO_ROOT, options = {}) {
  const parseYaml = options.parseYaml === undefined ? loadYamlParse() : options.parseYaml;
  const documents = (directory) =>
    yamlFiles(root, directory).map((path) => ({
      path,
      document: parseDocument(root, path, parseYaml),
    }));
  const single = (path) => ({ path, document: parseDocument(root, path, parseYaml) });
  const manifests = new Map();
  const workflowRoot = join(root, WORKFLOW_ROOT);
  if (existsSync(workflowRoot)) {
    for (const entry of readdirSync(workflowRoot).sort()) {
      if (!entry.endsWith(".json") || entry === "workflow.schema.json") continue;
      manifests.set(
        entry.slice(0, -".json".length),
        JSON.parse(readText(root, `${WORKFLOW_ROOT}/${entry}`)),
      );
    }
  }
  return {
    rules: documents(`${CATALOG_ROOT}/rules`),
    contracts: documents(`${CATALOG_ROOT}/contracts`),
    grammars: single(`${CATALOG_ROOT}/grammars.yaml`),
    retryPolicy: single(`${CATALOG_ROOT}/retry-policy.yaml`),
    recordedCodes: single(RECORDED_CODES_PATH),
    limits: declaredLimits(root, parseYaml),
    failureClasses: declaredFailureClasses(readText(root, FAILURE_CLASS_SOURCE)),
    manifests,
    readFixture: (path) => {
      if (!existsSync(join(root, path))) return undefined;
      return JSON.parse(readText(root, path));
    },
    // Canonical members of records-mode contracts: frozen JSON Schemas and
    // the response-contract key registry.
    readCanonical: (path) => {
      if (!path.startsWith(`${SCHEMA_ROOT}/`) || !existsSync(join(root, path))) return undefined;
      return JSON.parse(readText(root, path));
    },
    keyRegistry: RESPONSE_CONTRACT_KEY_SETS,
  };
}

// ---------------------------------------------------------------------------
// Validation

function placeholders(source, value, field, context) {
  for (const match of value.matchAll(PLACEHOLDER)) {
    const [, type, name] = match;
    if (type === "limit" && !context.limits.has(name)) {
      fail(source, `${field} names unknown limit ${name}`);
    }
    if (type === "grammar" && !context.grammarIds.has(name)) {
      fail(source, `${field} names unknown grammar ${name}`);
    }
  }
  const stripped = value.replaceAll(PLACEHOLDER, "");
  if (stripped.includes("{") || stripped.includes("}")) {
    fail(source, `${field} may use braces only for {limit:<name>} and {grammar:<id>}`);
  }
  return value;
}

function recordedCode(source, code, field, context) {
  if (!context.codeGrammar.test(code)) {
    fail(
      source,
      `${field} ${code} is outside the recorded code grammar (${SEGMENT_LIMIT} ${context.segmentLength}); the writer would record it as unretainable`,
    );
  }
  return code;
}

function recordedLocation(source, location, context) {
  if (
    typeof location !== "string" ||
    !context.locationGrammar.test(location) ||
    location.length > context.reasonLength
  ) {
    fail(source, `location ${String(location)} is outside the recorded location grammar`);
  }
  return location;
}

function atLocationSentences(source, value, locations, context) {
  const sentences = {};
  if (!isPlainObject(value)) fail(source, "atLocation must be a mapping");
  for (const [location, sentence] of Object.entries(value)) {
    if (!locations.includes(location)) {
      fail(source, `atLocation names ${location}, which is not one of the rule's locations`);
    }
    sentences[location] = placeholders(
      source,
      text(source, sentence, `atLocation ${location}`),
      `atLocation ${location}`,
      context,
    );
  }
  return sentences;
}

function validateRule(path, family, entry, context) {
  const source = `${path} rule ${entry?.code ?? "?"}`;
  exactKeys(
    source,
    entry,
    ["code", "locations", "kind", "retry", "reason", "operator", "fixtures", "docs"],
    [
      "statement",
      "failureClass",
      "failureClassReason",
      "hint",
      "outer",
      "pattern",
      "members",
      "catchAll",
      "aliases",
    ],
  );
  const pattern = entry.pattern === undefined ? false : entry.pattern;
  const catchAll = entry.catchAll === undefined ? false : entry.catchAll;
  if (typeof pattern !== "boolean") fail(source, "pattern must be true or false");
  if (typeof catchAll !== "boolean") fail(source, "catchAll must be true or false");
  const code = entry.code;
  if (typeof code !== "string" || !(pattern ? PREFIX_CODE : KEBAB).test(code)) {
    fail(
      source,
      pattern
        ? "a pattern rule's code is its kebab-case prefix, ending in -"
        : "code must be closed kebab-case",
    );
  }
  if (family.recordedPrefix) {
    if (!code.startsWith(family.recordedPrefix) || code.length === family.recordedPrefix.length) {
      fail(
        source,
        `code must be the family's recorded prefix ${family.recordedPrefix} plus a diagnostic code`,
      );
    }
  }
  let members = [];
  if (pattern) {
    members = distinct(
      source,
      list(source, entry.members, "members").map((member) => kebab(source, member, "member")),
      "members",
    );
    for (const member of members) recordedCode(source, `${code}${member}`, "member code", context);
  } else {
    if (entry.members !== undefined) fail(source, "members belong to a pattern rule only");
    recordedCode(source, code, "code", context);
  }
  const locations = distinct(
    source,
    list(source, entry.locations, "locations").map((location) =>
      recordedLocation(source, location, context),
    ),
    "locations",
  );
  const kind = oneOf(source, entry.kind, RULE_KINDS, "kind");
  const retry = oneOf(source, entry.retry, RETRY_DISPOSITIONS, "retry");
  if (TERMINAL_KINDS.includes(kind) && retry !== "terminal") {
    fail(source, `kind ${kind} is always terminal and cannot be declared ${retry}`);
  }
  const reason = text(source, entry.reason, "reason");
  let failureClass = DEFAULT_FAILURE_CLASS[kind];
  let failureClassReason = null;
  if (entry.failureClass !== undefined) {
    failureClass = oneOf(source, entry.failureClass, context.failureClasses, "failureClass");
    failureClassReason = text(source, entry.failureClassReason, "failureClassReason");
  } else if (entry.failureClassReason !== undefined) {
    fail(source, "failureClassReason explains a declared failureClass");
  }
  if (failureClass === undefined) {
    fail(source, `kind ${kind} must declare failureClass with a failureClassReason`);
  }
  const unstated = kind === "host" || catchAll;
  let statement = null;
  if (unstated) {
    if (entry.statement !== undefined) {
      fail(
        source,
        catchAll
          ? "the catch-all has no statement; its hint is host text"
          : "a host rule is never stated to the model and has no statement",
      );
    }
  } else {
    if (entry.statement === undefined) fail(source, "missing required field statement");
    statement = placeholders(
      source,
      text(source, entry.statement, "statement"),
      "statement",
      context,
    );
  }
  if (catchAll) {
    if (pattern) fail(source, "the catch-all is one exact code");
    if (retry !== "model-correctable") fail(source, "the catch-all is model-correctable");
    if (failureClass !== "unknown") fail(source, "the catch-all has failureClass unknown");
  }
  let atLocation = {};
  let hostDetail = null;
  if (entry.hint !== undefined) {
    if (unstated) fail(source, "a rule without a statement has no hint");
    exactKeys(`${source} hint`, entry.hint, [], ["atLocation", "hostDetail"]);
    if (entry.hint.atLocation !== undefined) {
      atLocation = atLocationSentences(source, entry.hint.atLocation, locations, context);
    }
    if (entry.hint.hostDetail !== undefined) {
      hostDetail = kebab(source, entry.hint.hostDetail, "hint.hostDetail");
    }
    if (Object.keys(atLocation).length === 0 && hostDetail === null) {
      fail(source, "hint must declare atLocation or hostDetail");
    }
  }
  exactKeys(`${source} operator`, entry.operator, ["kind", "meaning", "next"]);
  const operator = {
    kind: oneOf(source, entry.operator.kind, OPERATOR_KINDS, "operator.kind"),
    meaning: text(source, entry.operator.meaning, "operator.meaning"),
    next: text(source, entry.operator.next, "operator.next"),
  };
  const expanded = pattern ? members.map((member) => `${code}${member}`) : [code];
  const fixtures = distinct(
    source,
    list(source, entry.fixtures, "fixtures").map((fixturePath) => {
      if (typeof fixturePath !== "string") fail(source, "each fixture must be a repository path");
      const fixture = context.readFixture(fixturePath);
      if (fixture === undefined) fail(source, `fixture ${fixturePath} does not exist`);
      if (!isPlainObject(fixture) || fixture.kind !== "docsfab-output-rule-fixture") {
        fail(source, `fixture ${fixturePath} is not a docsfab-output-rule-fixture`);
      }
      if (!expanded.includes(fixture.code)) {
        fail(source, `fixture ${fixturePath} records code ${fixture.code}`);
      }
      if (!locations.includes(fixture.location)) {
        fail(source, `fixture ${fixturePath} fires at undeclared location ${fixture.location}`);
      }
      return fixturePath;
    }),
    "fixtures",
  );
  const docs = kebab(source, entry.docs, "docs");
  if (docs !== code.replace(/-$/u, "")) {
    fail(source, `docs must be the generated reference anchor ${code.replace(/-$/u, "")}`);
  }
  const outer = entry.outer === undefined ? null : kebab(source, entry.outer, "outer");
  const aliases = distinct(
    source,
    (entry.aliases === undefined ? [] : list(source, entry.aliases, "aliases")).map((alias) =>
      recordedCode(source, kebab(source, alias, "alias"), "alias", context),
    ),
    "aliases",
  );
  if (pattern && aliases.length > 0) fail(source, "aliases name one exact code");
  const record = {
    family: family.name,
    pattern: pattern ? code : null,
    locations,
    kind,
    retry,
    reason,
    failureClass,
    failureClassReason,
    statement,
    atLocation,
    hostDetail,
    outer,
    catchAll,
    operator,
    fixtures,
    docs,
  };
  for (const recorded of expanded) {
    for (const stem of PINNED_TERMINAL_STEMS) {
      if (recorded.includes(stem) && !PINNED_KINDS.includes(kind)) {
        context.findings.push({ check: "pinned-terminal", path, subject: recorded, lexeme: stem });
      }
    }
  }
  return expanded.map((recorded) => ({
    ...record,
    code: recorded,
    aliases: recorded === code ? aliases : [],
  }));
}

function validateRuleFile({ path, document }, context) {
  exactKeys(
    path,
    document,
    ["schemaVersion", "kind", "family", "rules"],
    ["replay", "recordedPrefix", "uses", "hostText"],
  );
  if (document.kind !== "docsfab-output-rules") fail(path, "kind must be docsfab-output-rules");
  const name = kebab(path, document.family, "family");
  if (path !== `${CATALOG_ROOT}/rules/${name}.yaml`) {
    fail(path, `family ${name} must live in ${CATALOG_ROOT}/rules/${name}.yaml`);
  }
  const replay =
    document.replay === undefined ? null : oneOf(path, document.replay, REPLAY_MODES, "replay");
  let recordedPrefix = null;
  if (document.recordedPrefix !== undefined) {
    if (typeof document.recordedPrefix !== "string" || !PREFIX_CODE.test(document.recordedPrefix)) {
      fail(path, "recordedPrefix must be kebab-case ending in -");
    }
    recordedPrefix = document.recordedPrefix;
  }
  const uses = (document.uses === undefined ? [] : list(path, document.uses, "uses")).map(
    (entry) => {
      exactKeys(`${path} uses`, entry, ["code"], ["locations", "atLocation"]);
      return {
        code: kebab(path, entry.code, "uses code"),
        locations: (entry.locations === undefined
          ? []
          : list(path, entry.locations, "uses locations")
        ).map((location) => recordedLocation(`${path} uses ${entry.code}`, location, context)),
        atLocation: entry.atLocation === undefined ? {} : entry.atLocation,
      };
    },
  );
  distinct(
    path,
    uses.map((entry) => entry.code),
    "uses",
  );
  const hostText = (
    document.hostText === undefined ? [] : list(path, document.hostText, "hostText")
  ).map((entry) => {
    exactKeys(`${path} hostText`, entry, ["id", "text"]);
    return {
      id: kebab(path, entry.id, "hostText id"),
      text: placeholders(path, text(path, entry.text, `hostText ${entry.id}`), "hostText", context),
    };
  });
  distinct(
    path,
    hostText.map((entry) => entry.id),
    "hostText ids",
  );
  const family = { name, replay, recordedPrefix };
  const rules = list(path, document.rules, "rules").flatMap((entry) =>
    validateRule(path, family, entry, context),
  );
  return { family: { ...family, uses, hostText }, rules };
}

function charClass(source, value, field) {
  if (typeof value !== "string" || value.length === 0) fail(source, `${field} must be a class`);
  const chars = new Set();
  for (let index = 0; index < value.length; index += 1) {
    const start = value[index];
    if (value[index + 1] === "-" && index + 2 < value.length) {
      const end = value[index + 2];
      if (!/[a-zA-Z0-9]/u.test(start) || !/[a-zA-Z0-9]/u.test(end) || end < start) {
        fail(source, `${field} has an invalid range ${start}-${end}`);
      }
      for (let code = start.charCodeAt(0); code <= end.charCodeAt(0); code += 1) {
        chars.add(String.fromCharCode(code));
      }
      index += 2;
      continue;
    }
    chars.add(start);
  }
  return [...chars].sort();
}

function escapeClassChar(char) {
  return /[\\\]^-]/u.test(char) ? `\\${char}` : char;
}

/** A character class, with runs of three or more digits or letters written as ranges. */
function classSource(chars) {
  const kind = (char) =>
    /[0-9]/u.test(char)
      ? "digit"
      : /[a-z]/u.test(char)
        ? "lower"
        : /[A-Z]/u.test(char)
          ? "upper"
          : null;
  const parts = [];
  for (let index = 0; index < chars.length; ) {
    let end = index;
    while (
      end + 1 < chars.length &&
      kind(chars[index]) !== null &&
      kind(chars[end + 1]) === kind(chars[index]) &&
      chars[end + 1].charCodeAt(0) === chars[end].charCodeAt(0) + 1
    ) {
      end += 1;
    }
    if (end - index >= 2) {
      parts.push(`${chars[index]}-${chars[end]}`);
    } else {
      for (let cursor = index; cursor <= end; cursor += 1) {
        parts.push(escapeClassChar(chars[cursor]));
      }
    }
    index = end + 1;
  }
  return `[${parts.join("")}]`;
}

function escapeLiteral(value) {
  return value.replaceAll(/[.*+?^${}()|[\]\\/]/gu, "\\$&");
}

/** One token: the first class, then at most `maxLength - 1` characters of the rest class. */
function tokenSource(grammar) {
  return `${classSource(grammar.first)}${classSource(grammar.rest)}{0,${grammar.maxLengthValue - 1}}`;
}

function validateGrammars({ path, document }, context) {
  exactKeys(path, document, ["schemaVersion", "kind", "grammars"]);
  if (document.kind !== "docsfab-output-grammars") {
    fail(path, "kind must be docsfab-output-grammars");
  }
  const grammars = list(path, document.grammars, "grammars", { nonEmpty: false });
  const byId = new Map();
  for (const entry of grammars) {
    const source = `${path} grammar ${entry?.id ?? "?"}`;
    exactKeys(
      source,
      entry,
      ["id", "form", "statement", "examples"],
      ["first", "rest", "maxLength", "parts", "separators", "flowsInto"],
    );
    const id = kebab(source, entry.id, "id");
    if (byId.has(id)) fail(source, "repeats a grammar id");
    const form = oneOf(source, entry.form, ["token", "composite"], "form");
    const grammar = { id, form, statement: text(source, entry.statement, "statement") };
    if (form === "token") {
      if (entry.parts !== undefined || entry.separators !== undefined) {
        fail(source, "a token grammar declares first, rest, and maxLength only");
      }
      grammar.first = charClass(source, entry.first, "first");
      grammar.rest = charClass(source, entry.rest, "rest");
      if (typeof entry.maxLength !== "string" || !context.limits.has(entry.maxLength)) {
        fail(source, "maxLength must name a config/limits.yaml limit");
      }
      grammar.maxLength = entry.maxLength;
      grammar.maxLengthValue = context.limits.get(entry.maxLength);
      if (!Number.isInteger(grammar.maxLengthValue) || grammar.maxLengthValue < 1) {
        fail(source, `maxLength ${entry.maxLength} must be a positive integer limit`);
      }
      grammar.pattern = `^${tokenSource(grammar)}$`;
    } else {
      if (entry.first !== undefined || entry.rest !== undefined || entry.maxLength !== undefined) {
        fail(source, "a composite grammar declares parts and separators only");
      }
      grammar.parts = list(source, entry.parts, "parts").map((part) => kebab(source, part, "part"));
      grammar.separators = list(source, entry.separators, "separators", { nonEmpty: false });
      if (grammar.separators.length !== grammar.parts.length - 1) {
        fail(source, "a composite grammar needs one separator between each pair of parts");
      }
      grammar.maxLength = null;
    }
    exactKeys(`${source} examples`, entry.examples, ["accept", "reject"], ["illustrative"]);
    grammar.examples = {
      accept: list(source, entry.examples.accept, "examples.accept").map(String),
      reject: list(source, entry.examples.reject, "examples.reject").map(String),
      illustrative: (entry.examples.illustrative === undefined
        ? []
        : list(source, entry.examples.illustrative, "examples.illustrative")
      ).map(String),
    };
    grammar.flowsInto = (
      entry.flowsInto === undefined ? [] : list(source, entry.flowsInto, "flowsInto")
    ).map((target) => kebab(source, target, "flowsInto"));
    byId.set(id, grammar);
  }
  for (const grammar of byId.values()) {
    const source = `${path} grammar ${grammar.id}`;
    if (grammar.form === "composite") {
      const parts = grammar.parts.map((part) => {
        const target = byId.get(part);
        if (!target || target.form !== "token") fail(source, `part ${part} is not a token grammar`);
        return target;
      });
      grammar.pattern = `^${parts
        .map(
          (part, index) =>
            `${index === 0 ? "" : escapeLiteral(grammar.separators[index - 1])}${tokenSource(part)}`,
        )
        .join("")}$`;
    }
    const regex = new RegExp(grammar.pattern, "u");
    for (const value of [...grammar.examples.accept, ...grammar.examples.illustrative]) {
      if (!regex.test(value)) fail(source, `example ${value} must be accepted but is refused`);
    }
    for (const value of grammar.examples.reject) {
      if (regex.test(value)) fail(source, `example ${value} must be refused but is accepted`);
    }
    for (const targetId of grammar.flowsInto) {
      const target = byId.get(targetId);
      if (!target) fail(source, `flowsInto names unknown grammar ${targetId}`);
      if (grammar.form !== "token" || target.form !== "token") {
        fail(
          source,
          "flowsInto is proven for token grammars only until #1290 lands composite edges",
        );
      }
      const within = (inner, outer) => inner.every((char) => outer.includes(char));
      if (!within(grammar.first, target.first) || !within(grammar.rest, target.rest)) {
        fail(
          source,
          `admits characters that ${targetId} refuses, so it cannot flow into it (#1268)`,
        );
      }
      if (grammar.maxLengthValue > target.maxLengthValue) {
        fail(
          source,
          `admits values up to ${grammar.maxLength} (${grammar.maxLengthValue}) but ${targetId} stops at ${target.maxLength} (${target.maxLengthValue}), so it cannot flow into it`,
        );
      }
    }
    placeholders(source, grammar.statement, "statement", {
      ...context,
      grammarIds: new Set(byId.keys()),
    });
  }
  return [...byId.values()];
}

function validateRetryPolicy({ path, document }, context) {
  exactKeys(
    path,
    document,
    ["schemaVersion", "kind", "replayModes"],
    ["stepRetry", "providerTurnReplay", "workflowCapabilities", "retryRules", "recordedRetryRules"],
  );
  if (document.kind !== "docsfab-retry-policy") fail(path, "kind must be docsfab-retry-policy");
  const limitName = (source, value, field) => {
    if (typeof value !== "string" || !LIMIT_NAME.test(value) || !context.limits.has(value)) {
      fail(source, `${field} must name a config/limits.yaml limit`);
    }
    return value;
  };
  if (document.stepRetry !== undefined) {
    const source = `${path} stepRetry`;
    exactKeys(source, document.stepRetry, [
      "budget",
      "baseDelay",
      "maxDelay",
      "backoff",
      "retryableCategories",
    ]);
    limitName(source, document.stepRetry.budget, "budget");
    limitName(source, document.stepRetry.baseDelay, "baseDelay");
    limitName(source, document.stepRetry.maxDelay, "maxDelay");
    oneOf(source, document.stepRetry.backoff, BACKOFF_FORMULAS, "backoff");
    for (const category of list(
      source,
      document.stepRetry.retryableCategories,
      "retryableCategories",
    )) {
      kebab(source, category, "retryable category");
    }
  }
  if (document.providerTurnReplay !== undefined) {
    const source = `${path} providerTurnReplay`;
    exactKeys(source, document.providerTurnReplay, ["attempts", "backoff", "errorClasses"]);
    limitName(source, document.providerTurnReplay.attempts, "attempts");
    oneOf(source, document.providerTurnReplay.backoff, BACKOFF_FORMULAS, "backoff");
    for (const entry of list(source, document.providerTurnReplay.errorClasses, "errorClasses")) {
      kebab(source, entry, "error class");
    }
  }
  if (document.workflowCapabilities !== undefined) {
    for (const entry of list(path, document.workflowCapabilities, "workflowCapabilities")) {
      const source = `${path} workflowCapabilities ${entry?.id ?? "?"}`;
      exactKeys(source, entry, ["id", "workflows"]);
      kebab(source, entry.id, "id");
      for (const workflow of list(source, entry.workflows, "workflows")) {
        if (!context.manifests.has(workflow)) fail(source, `names unknown workflow ${workflow}`);
      }
    }
  }
  const modes = list(path, document.replayModes, "replayModes").map((entry) => {
    const source = `${path} replay mode ${entry?.id ?? "?"}`;
    exactKeys(source, entry, ["id"], ["statement"]);
    return {
      id: oneOf(source, entry.id, REPLAY_MODES, "id"),
      statement:
        entry.statement === undefined
          ? null
          : placeholders(source, text(source, entry.statement, "statement"), "statement", context),
    };
  });
  distinct(
    path,
    modes.map((mode) => mode.id),
    "replayModes",
  );
  return { replayModes: modes, ...validateRetryRules(path, document, context, limitName) };
}

/**
 * The retry rules every step decision records, and the append-only
 * list of every rule id ever recorded. A recorded id is a value in saved run
 * records, so it may leave `retryRules` but never `recordedRetryRules`.
 */
function validateRetryRules(path, document, context, limitName) {
  if (document.retryRules === undefined && document.recordedRetryRules === undefined) {
    return { retryRules: [], recordedRetryRules: [] };
  }
  const rules = list(path, document.retryRules, "retryRules").map((entry) => {
    const source = `${path} retry rule ${entry?.id ?? "?"}`;
    exactKeys(
      source,
      entry,
      ["id", "decision", "budget", "summary", "reason", "next"],
      ["statement", "concludeNow"],
    );
    const id = recordedCode(source, kebab(source, entry.id, "id"), "id", context);
    const decision = oneOf(source, entry.decision, RETRY_RULE_DECISIONS, "decision");
    if (decision !== "not-applicable" && !id.startsWith(decision)) {
      fail(source, `id must begin with its decision ${decision}`);
    }
    const budget = entry.budget === "none" ? null : limitName(source, entry.budget, "budget");
    const statement =
      entry.statement === undefined
        ? null
        : placeholders(source, text(source, entry.statement, "statement"), "statement", context);
    if (statement !== null && decision !== "retried") {
      fail(source, "only a retried rule carries a statement for the retry prompt");
    }
    if (entry.concludeNow !== undefined && entry.concludeNow !== true) {
      fail(source, "concludeNow is either true or absent");
    }
    const concludeNow = entry.concludeNow === true;
    if (concludeNow && (decision !== "retried" || statement === null)) {
      fail(source, "only a retried rule with a statement may conclude now");
    }
    return {
      id,
      decision,
      budget,
      summary: text(source, entry.summary, "summary"),
      reason: text(source, entry.reason, "reason"),
      statement,
      concludeNow,
      next: text(source, entry.next, "next"),
    };
  });
  distinct(
    path,
    rules.map((rule) => rule.id),
    "retryRules",
  );
  const recorded = distinct(
    path,
    list(path, document.recordedRetryRules, "recordedRetryRules").map((id) =>
      kebab(path, id, "recorded retry rule"),
    ),
    "recordedRetryRules",
  );
  for (const rule of rules) {
    if (!recorded.includes(rule.id)) {
      fail(path, `retry rule ${rule.id} is missing from recordedRetryRules (append-only)`);
    }
  }
  return { retryRules: rules, recordedRetryRules: recorded };
}

/**
 * The append-only record of every recorded code (ADR question 8). A code once
 * recorded keeps its spelling: it must stay declared, or be listed as an alias
 * of the rule that replaced it. A pinned entry also fixes its kind.
 */
function validateRecordedCodes({ path, document }, context) {
  exactKeys(path, document, ["schemaVersion", "kind", "codes"]);
  if (document.kind !== "docsfab-recorded-codes") fail(path, "kind must be docsfab-recorded-codes");
  const entries = list(path, document.codes, "codes").map((entry) => {
    exactKeys(`${path} code`, entry, ["code"], ["pinned"]);
    return {
      code: recordedCode(path, kebab(path, entry.code, "code"), "code", context),
      pinned: entry.pinned === undefined ? null : oneOf(path, entry.pinned, PINNED_KINDS, "pinned"),
    };
  });
  distinct(
    path,
    entries.map((entry) => entry.code),
    "codes",
  );
  return entries;
}

/** Walk `shape` (a JSON Schema subset) to the node a contract location names. */
export function shapeNodeAt(shape, location) {
  if (location === "$" || location === "$response") return shape;
  let node = shape;
  const segments = location.replace(/^\$/u, "").match(/\.[A-Za-z_][A-Za-z0-9_]*|\[\]/gu);
  for (const segment of segments ?? []) {
    if (!isPlainObject(node)) return undefined;
    if (segment === "[]") {
      node = node.type === "array" ? node.items : undefined;
    } else {
      node = node.type === "object" ? node.properties?.[segment.slice(1)] : undefined;
    }
  }
  return node;
}

function validateShape(source, shape) {
  const walk = (node, at) => {
    exactKeys(`${source} shape ${at}`, node, ["type"], ["properties", "items", "enum", "required"]);
    oneOf(
      `${source} shape ${at}`,
      node.type,
      ["object", "array", "string", "integer", "boolean"],
      "type",
    );
    if (node.type === "object") {
      if (!isPlainObject(node.properties)) fail(source, `shape ${at} object needs properties`);
      for (const [key, child] of Object.entries(node.properties)) walk(child, `${at}.${key}`);
    }
    if (node.type === "array") walk(node.items, `${at}[]`);
    if (node.enum !== undefined) {
      for (const value of list(source, node.enum, `shape ${at} enum`)) {
        text(source, value, "enum value");
      }
    }
  };
  walk(shape, "$");
  return shape;
}

/** Property names and enum values a contract's shape declares, at any depth. */
export function shapeVocabulary(shape) {
  const keys = new Set();
  const enums = new Set();
  const walk = (node) => {
    if (!isPlainObject(node)) return;
    for (const [key, child] of Object.entries(node.properties ?? {})) {
      keys.add(key);
      walk(child);
    }
    if (node.items) walk(node.items);
    for (const value of node.enum ?? []) enums.add(value);
  };
  walk(shape);
  return { keys: [...keys].sort(), enums: [...enums].sort() };
}

// ---------------------------------------------------------------------------
// Answer-record declarations (closed-schema-answer-records-decision.md §1)
//
// A contract that declares `canonical` classifies every member of its canonical
// artifact as exactly one of: a model record field, host-minted, host-derived
// by a named rule, resolved by reference, or composed from ordered host and
// model parts. The generator builds each record's shape from the canonical
// schema (or key registry) minus every host-owned member, and refuses the
// declaration when a check G1-G6 fails.

/**
 * Host inputs a declaration may name as a skeleton, a host-minted source, a
 * narrowing, an `add` enum, or the profile selector (G3). Each name is
 * resolved at run time by the contract owner's host-input provider; the core
 * in `src/harness/answer-records.ts` never reads a profile or a run itself.
 * `ledger.*` sources are resolved by the core from the ledger.
 */
export const ANSWER_RECORD_HOST_INPUTS = Object.freeze({
  "contract.evaluation-version": "The contract's evaluation version constant.",
  "evaluate-step-evidence": "The evaluator identity rendered from EvaluateStepEvidenceV1 (O8).",
  "host.clock-at-assembly": "The host clock when the ledger is assembled.",
  "ledger.finding-order": "The host-serial key of an open-set record, in ledger order.",
  "ledger.record-key": "The ledger key of the record that fills the member.",
  "profile.applicability.documentation_set.required_dimensions_by_layer":
    "The profile's required dimensions, by layer, in profile order.",
  "profile.applicability.documentation_set.required_dimensions_by_layer.keys":
    "The profile's layer keys, in profile order.",
  "profile.confidence_anchors.below-one": "The profile's confidence anchors below 1 (O6).",
  "profile.hard_gates": "The profile's hard-gate vocabulary.",
  "profile.required-excludes-not-applicable":
    "The assessment values a required dimension may take (no not-applicable).",
  "quality-evaluation-target": "The host-bound evaluation target of this run.",
  "quality-policy.constraint-keys": "The constraint keys and members from the quality rule module.",
  "quality-policy.d3-residual-decisions":
    "The layer decisions a model may judge when the rules leave a layer open (O2).",
  "run.step-attempt-id": "The run's step attempt identity.",
  "selection-receipt.profile": "The selected quality profile identity.",
  "selection-receipt.profileModel": "The selected quality profile's model version.",
  "selection-receipt.repositoryRevision": "The repository revision the selection receipt binds.",
  "selection-receipt.scopeType": "The review scope type the selection receipt binds.",
  "source-obligation.dimensions": "The source-obligation dimension skeleton, in declared order.",
  "source-obligation.plan-locators": "The source locators the bound plan admits.",
  "workflow.finding-owner": "The workflow's finding owner constant.",
  "workflow.finding-status": "The workflow's new-finding status constant.",
});

/** Key subsets a derive `field` may select with `{<name>}`, resolved per run. */
export const ANSWER_RECORD_SELECTORS = Object.freeze({
  required: "The keys of the keyed member that the selected profile requires.",
});

/** Earlier-step artifacts a reference may resolve against, as `step:<step>.<artifact>`. */
export const ANSWER_RECORD_STEP_ARTIFACTS = Object.freeze([
  "attempts",
  "reviewResult",
  "sourceObligations",
  "technicalVerification",
]);

const RECORD_DECLARATION_FIELDS = Object.freeze([
  "type",
  "from",
  "at",
  "key",
  "slotFrom",
  "open",
  "closedBy",
  "optional",
  "default",
  "nullable",
  "narrow",
  "add",
]);
const RECORD_DEFAULTS = Object.freeze(["empty"]);
const RECORD_LIMIT_ROLES = Object.freeze([
  "openRecords",
  "refusalsPerKey",
  "recordBytes",
  "messageBytes",
]);
const RULE_REFERENCE = /^([a-z][a-z0-9-]*):([a-z][a-z0-9-]*)$/u;
const LOCATION_SEGMENT = /\.(?:[A-Za-z_][A-Za-z0-9_]*|\*|\{[a-z][a-z0-9-]*\})|\[\]/gu;

/** Parse a canonical location such as `$.evaluation.layers.*.dimensions[]`. */
export function parseCanonicalLocation(source, location, field) {
  if (typeof location !== "string" || !location.startsWith("$.")) {
    fail(source, `${field} must be a $-rooted canonical location`);
  }
  const body = location.slice(1);
  const segments = body.match(LOCATION_SEGMENT) ?? [];
  if (segments.join("") !== body) fail(source, `${field} ${location} is not a canonical location`);
  return segments.map((segment) => {
    if (segment === "[]") return { items: true };
    const name = segment.slice(1);
    if (name === "*") return { any: true };
    if (name.startsWith("{")) return { selector: name.slice(1, -1) };
    return { prop: name };
  });
}

function locationText(segments) {
  return `$${segments
    .map((segment) =>
      segment.items
        ? "[]"
        : segment.any
          ? ".*"
          : segment.selector
            ? `.{${segment.selector}}`
            : `.${segment.prop}`,
    )
    .join("")}`;
}

// The canonical tree: { kind: "object", props: Map, schema } |
// { kind: "array", items, schema } | { kind: "leaf", schema }. `schema` is the
// dereferenced JSON Schema node, or a key-registry node, and is the identity
// the `from` and `at` pointers are compared by.

function dereference(root, node, source) {
  let current = node;
  const seen = new Set();
  while (isPlainObject(current) && typeof current.$ref === "string") {
    if (seen.has(current.$ref)) fail(source, `canonical schema $ref cycle at ${current.$ref}`);
    seen.add(current.$ref);
    const match = /^#\/\$defs\/([A-Za-z0-9_-]+)$/u.exec(current.$ref);
    if (!match || !isPlainObject(root.$defs?.[match[1]])) {
      fail(source, `canonical schema $ref ${current.$ref} does not resolve`);
    }
    current = root.$defs[match[1]];
  }
  return current;
}

/**
 * A canonical schema node as a tree. Parsed JSON is a tree, so only a `$ref`
 * can loop: `active` holds the dereferenced nodes on the current path, and
 * meeting one again is a cycle. No depth bound is needed.
 */
function schemaTree(root, node, source, active = new Set()) {
  const schema = dereference(root, node, source);
  if (!isPlainObject(schema)) fail(source, "canonical schema node must be an object");
  if (active.has(schema))
    fail(source, "canonical schema $ref cycle; a canonical member must be finite");
  const path = new Set(active).add(schema);
  if (isPlainObject(schema.properties)) {
    const props = new Map();
    for (const [name, child] of Object.entries(schema.properties)) {
      props.set(name, schemaTree(root, child, source, path));
    }
    return { kind: "object", props, schema };
  }
  if (schema.type === "array" && isPlainObject(schema.items)) {
    return { kind: "array", items: schemaTree(root, schema.items, source, path), schema };
  }
  return { kind: "leaf", schema };
}

function registryTree(keySets, setName, nested, at, source) {
  const keys = keySets[setName];
  if (!Array.isArray(keys)) fail(source, `canonical names unknown key set ${setName}`);
  const schema = { keySet: setName };
  const props = new Map();
  for (const key of keys) {
    const childAt = `${at}.${key}`;
    const child = nested.get(`${childAt}[]`) ?? nested.get(childAt);
    if (child === undefined) {
      props.set(key, { kind: "leaf", schema: { keySet: setName, key } });
    } else if (nested.has(`${childAt}[]`)) {
      const items = registryTree(keySets, child, nested, `${childAt}[]`, source);
      props.set(key, { kind: "array", items, schema: { arrayOf: child } });
    } else {
      props.set(key, registryTree(keySets, child, nested, childAt, source));
    }
  }
  return { kind: "object", props, schema };
}

/** Resolve a `<member>#<pointer>` (`from`, `add.schema`) to its canonical node. */
function resolveCanonicalPointer(source, canonical, pointer, field) {
  if (typeof pointer !== "string") fail(source, `${field} must be a canonical pointer`);
  const [member, path, ...rest] = pointer.split("#");
  if (rest.length > 0 || path === undefined || !canonical.members.has(member)) {
    fail(source, `${field} ${pointer} does not resolve in the canonical members (G2)`);
  }
  const entry = canonical.members.get(member);
  if (entry.registry) {
    // `keys:<set>` names a key set; `keys:<set>/<key>` one member of it.
    const match = /^keys:([A-Za-z][A-Za-z0-9]*)(?:\/([A-Za-z][A-Za-z0-9_]*))?$/u.exec(path);
    const set = match ? entry.bySet.get(match[1]) : undefined;
    const node = match?.[2] === undefined ? set : set?.props.get(match[2]);
    if (!node) fail(source, `${field} ${pointer} does not resolve in the key registry (G2)`);
    return node;
  }
  if (path !== "" && !path.startsWith("/")) {
    fail(source, `${field} ${pointer} does not resolve in the canonical schema (G2)`);
  }
  let node = entry.root;
  for (const raw of path === "" ? [] : path.slice(1).split("/")) {
    const part = raw.replaceAll("~1", "/").replaceAll("~0", "~");
    node = isPlainObject(node) ? dereference(entry.root, node, source)?.[part] : undefined;
    if (node === undefined) {
      fail(source, `${field} ${pointer} does not resolve in the canonical schema (G2)`);
    }
  }
  const schema = dereference(entry.root, node, source);
  const found = entry.bySchema.get(schema);
  if (!found) fail(source, `${field} ${pointer} names no canonical member (G2)`);
  return found;
}

/** Every canonical node a location names; refuses one that does not resolve (G2). */
function nodesAt(source, canonical, segments, field) {
  const [head, ...rest] = segments;
  if (!head?.prop || !canonical.members.has(head.prop)) {
    fail(source, `${field} ${locationText(segments)} names no canonical member (G2)`);
  }
  let nodes = [canonical.members.get(head.prop).tree];
  for (const segment of rest) {
    const next = [];
    for (const node of nodes) {
      if (segment.items) {
        if (node.kind === "array") next.push(node.items);
      } else if (segment.selector && node.kind === "array") {
        // A finite host selector can stand for one array item in a record
        // placement path. Runtime resolves its value only from the plan.
        next.push(node.items);
      } else if (node.kind === "object") {
        if (segment.prop) {
          if (node.props.has(segment.prop)) next.push(node.props.get(segment.prop));
        } else {
          next.push(...node.props.values());
        }
      }
    }
    if (next.length === 0 || next.length < nodes.length) {
      fail(
        source,
        `${field} ${locationText(segments)} does not resolve in the canonical schema (G2)`,
      );
    }
    nodes = next;
  }
  return nodes;
}

/** Every leaf member of the canonical tree, as concrete segment paths. */
function canonicalLeaves(canonical) {
  const leaves = [];
  const walk = (node, path) => {
    if (node.kind === "object" && node.props.size > 0) {
      for (const [name, child] of node.props) walk(child, [...path, { prop: name }]);
    } else if (node.kind === "array") {
      walk(node.items, [...path, { items: true }]);
    } else {
      leaves.push(path);
    }
  };
  for (const [name, entry] of canonical.members) walk(entry.tree, [{ prop: name }]);
  return leaves;
}

/** Whether `pattern` names the concrete prefix `path` (same length); `partial` when by selector. */
function matchConcrete(pattern, path) {
  if (pattern.length !== path.length) return null;
  let partial = null;
  for (let index = 0; index < pattern.length; index += 1) {
    const want = pattern[index];
    const have = path[index];
    if (want.items || have.items) {
      if (!(want.items && have.items)) return null;
    } else if (want.prop) {
      if (want.prop !== have.prop) return null;
    } else if (want.selector) {
      partial = want.selector;
    }
  }
  return { partial };
}

/**
 * The relative member path of `claim` under the record location `at`, or null
 * when the claim is not under it. `when` is set when the claim owns the member
 * only for some keys of a keyed location: by selector, or for one key.
 */
function relativeUnder(at, claim) {
  if (claim.length <= at.length) return null;
  let when = null;
  for (let index = 0; index < at.length; index += 1) {
    const base = at[index];
    const segment = claim[index];
    if (base.items || segment.items) {
      if (!(base.items && segment.items)) return null;
    } else if (base.prop) {
      if (segment.prop !== undefined && segment.prop !== base.prop) return null;
    } else if (segment.selector) {
      when = { selector: segment.selector };
    } else if (segment.prop) {
      when = { key: segment.prop };
    }
  }
  return { rest: claim.slice(at.length), when };
}

/** A schema node with every `$ref` inlined; a `$ref` cycle is refused, as in `schemaTree`. */
function inlineSchema(root, node, source, active = new Set()) {
  const schema = dereference(root, node, source);
  if (Array.isArray(schema)) return schema.map((item) => inlineSchema(root, item, source, active));
  if (!isPlainObject(schema)) return schema;
  if (active.has(schema))
    fail(source, "canonical schema $ref cycle; a record shape must be finite");
  const path = new Set(active).add(schema);
  const copy = {};
  for (const [key, value] of Object.entries(schema)) {
    if (key === "$schema" || key === "$id" || key === "$defs" || key === "title") continue;
    copy[key] =
      isPlainObject(value) || Array.isArray(value)
        ? inlineSchema(root, value, source, path)
        : value;
  }
  return copy;
}

function registryShape(node) {
  if (node.kind === "array") return { type: "array", items: registryShape(node.items) };
  if (node.kind === "object") {
    return {
      type: "object",
      additionalProperties: false,
      properties: Object.fromEntries(
        [...node.props].map(([key, child]) => [key, registryShape(child)]),
      ),
    };
  }
  return {};
}

/** The property node at `rest` inside a generated shape, descending arrays implicitly. */
function shapeMember(shape, rest) {
  let parent = null;
  let node = shape;
  let name = null;
  for (const segment of rest) {
    while (node?.type === "array" && segment.prop !== undefined) node = node.items;
    if (segment.items) {
      if (node?.type !== "array") return null;
      node = node.items;
      continue;
    }
    if (!isPlainObject(node?.properties)) return null;
    if (segment.prop === undefined) return null;
    parent = node;
    name = segment.prop;
    node = node.properties[name];
    if (node === undefined) return null;
  }
  return parent ? { parent, name, node } : null;
}

function removeShapeMember(shape, rest) {
  const found = shapeMember(shape, rest);
  if (!found) return false;
  delete found.parent.properties[found.name];
  if (Array.isArray(found.parent.required)) {
    found.parent.required = found.parent.required.filter((key) => key !== found.name);
  }
  return true;
}

function memberText(rest) {
  return rest
    .map((segment, index) =>
      segment.items
        ? "[]"
        : `${index === 0 ? "" : "."}${segment.prop ?? (segment.any ? "*" : `{${segment.selector}}`)}`,
    )
    .join("");
}

/** Whether two canonical nodes are the same schema member (or the same key set). */
function sameMember(left, right) {
  if (left.schema === right.schema) return true;
  const set = (node) => (node.kind === "object" ? node.schema.keySet : undefined);
  return set(left) !== undefined && set(left) === set(right);
}

/** Read and validate the `canonical` block; returns the canonical model. */
function canonicalModel(path, document, context) {
  exactKeys(`${path} canonical`, document.canonical, ["members"], ["profile", "nested"]);
  const members = new Map();
  const nested = new Map();
  for (const entry of list(path, document.canonical.nested ?? [], "canonical nested", {
    nonEmpty: false,
  })) {
    exactKeys(`${path} canonical nested`, entry, ["at", "keys"]);
    nested.set(text(path, entry.at, "nested at"), text(path, entry.keys, "nested keys"));
  }
  const declared = document.canonical.members;
  if (!isPlainObject(declared) || Object.keys(declared).length === 0) {
    fail(path, "canonical members must name at least one member");
  }
  for (const [name, value] of Object.entries(declared)) {
    if (!/^[a-z][A-Za-z0-9]*$/u.test(name)) fail(path, `canonical member ${name} is not a name`);
    const target = text(path, value, `canonical member ${name}`);
    const registry = /^keys:([A-Za-z][A-Za-z0-9]*)$/u.exec(target);
    if (registry) {
      const tree = registryTree(context.keyRegistry, registry[1], nested, `$.${name}`, path);
      const bySet = new Map();
      const index = (node) => {
        if (node.kind === "object") {
          if (node.schema.keySet && !bySet.has(node.schema.keySet))
            bySet.set(node.schema.keySet, node);
          for (const child of node.props.values()) index(child);
        } else if (node.kind === "array") index(node.items);
      };
      index(tree);
      members.set(name, { registry: registry[1], tree, bySet, source: target });
      continue;
    }
    const root = context.readCanonical(target);
    if (!isPlainObject(root)) fail(path, `canonical member ${name} names no schema file ${target}`);
    const tree = schemaTree(root, root, path);
    const bySchema = new Map();
    const index = (node) => {
      if (!bySchema.has(node.schema)) bySchema.set(node.schema, node);
      if (node.kind === "object") for (const child of node.props.values()) index(child);
      if (node.kind === "array") index(node.items);
    };
    index(tree);
    members.set(name, { root, tree, bySchema, source: target });
  }
  for (const at of nested.keys()) {
    const used = [...members.values()].some((entry) => entry.registry);
    if (!used) fail(path, `canonical nested ${at} applies only to a key-registry member`);
  }
  const profile =
    document.canonical.profile === undefined
      ? null
      : hostInput(path, document.canonical.profile, "canonical profile");
  return { members, profile };
}

function hostInput(source, name, field) {
  const value = text(source, name, field);
  if (!Object.hasOwn(ANSWER_RECORD_HOST_INPUTS, value)) {
    fail(source, `${field} ${value} is not a registered host input (G3)`);
  }
  return value;
}

/**
 * Validate a records-mode declaration (`canonical` present) and generate its
 * record shapes. Returns the normalized declaration the generated tables carry.
 */
function validateRecordsDeclaration(path, document, context, base) {
  const canonical = canonicalModel(path, document, context);

  // Skeletons: named host inputs, never literals (G3).
  const skeleton = {};
  for (const [name, value] of Object.entries(document.skeleton ?? {})) {
    kebab(path, name, "skeleton name");
    skeleton[name] = hostInput(path, value, `skeleton ${name}`);
  }

  // Limits: names only (G5).
  const limits = {};
  if (document.limits !== undefined && !isPlainObject(document.limits)) {
    fail(path, "limits must be a mapping of limit roles to limit names");
  }
  for (const [role, value] of Object.entries(document.limits ?? {})) {
    oneOf(path, role, RECORD_LIMIT_ROLES, "limits role");
    if (typeof value !== "string" || !LIMIT_NAME.test(value)) {
      fail(path, `limits ${role} must name a declared limit, not a literal (G5)`);
    }
    if (!context.limits.has(value)) fail(path, `limits ${role} names undeclared limit ${value}`);
    limits[role] = value;
  }

  // References: `field` references own a member; `part` references are host
  // parts of a compose entry. Sources are sealed earlier-step artifacts.
  const namespaces = new Set();
  const parts = new Set();
  const references = list(path, document.references ?? [], "references", { nonEmpty: false }).map(
    (entry) => {
      const where = `${path} references`;
      const keys = Object.keys(entry ?? {});
      exactKeys(where, entry, ["namespace", "source", "unresolved"], ["field", "part", "ids"]);
      if (keys.includes("field") === keys.includes("part")) {
        fail(where, "a reference names exactly one of field or part");
      }
      const namespace = kebab(where, entry.namespace, "namespace");
      if (namespaces.has(namespace)) fail(where, `repeats namespace ${namespace}`);
      namespaces.add(namespace);
      const sourceName = text(where, entry.source, "source");
      const step = /^step:([a-z][a-z0-9-]*)\.([A-Za-z][A-Za-z0-9]*)$/u.exec(sourceName);
      if (!step) fail(where, `source ${sourceName} is not a sealed step artifact (G3)`);
      const known = base.bindings.some((binding) =>
        manifestStepIds(context.manifests.get(binding.workflow)).has(step[1]),
      );
      if (!known || !ANSWER_RECORD_STEP_ARTIFACTS.includes(step[2])) {
        fail(where, `source ${sourceName} is not a registered host input (G3)`);
      }
      const normalized = {
        field: null,
        part: null,
        namespace,
        source: sourceName,
        ids: entry.ids === undefined ? null : text(where, entry.ids, "ids"),
        unresolved: kebab(where, entry.unresolved, "unresolved"),
      };
      if (entry.field !== undefined) {
        normalized.field = text(where, entry.field, "field");
      } else {
        normalized.part = kebab(where, entry.part, "part");
        parts.add(normalized.part);
      }
      return normalized;
    },
  );

  const ruleName = (where, value) => {
    const rule = text(where, value, "rule");
    const match = RULE_REFERENCE.exec(rule);
    if (!match || !CONTRACT_OWNERS.includes(match[1])) {
      fail(where, `rule ${rule} must be <owner>:<rule>`);
    }
    // Each rule is implemented once by its owner: quality rules in
    // quality_decision_policy.RULES (held equal by test/answer-records.test.ts),
    // runtime rules in src/contracts/derivations/ (by the generated type).
    if (match[1] !== base.owner) fail(where, `rule ${rule} is not owned by ${base.owner}`);
    return rule;
  };

  // Records.
  const types = new Map();
  const recordEntries = list(path, document.records, "records").map((entry) => {
    const where = `${path} records`;
    exactKeys(where, entry, ["type", "from", "key"], RECORD_DECLARATION_FIELDS);
    const type = kebab(where, entry.type, "type");
    if (types.has(type)) fail(where, `repeats record type ${type}`);
    const fromNode =
      entry.from === "none"
        ? null
        : resolveCanonicalPointer(path, canonical, entry.from, `records ${type} from`);
    const at = (entry.at === undefined ? [] : list(where, entry.at, `${type} at`)).map((location) =>
      parseCanonicalLocation(path, location, `records ${type} at`),
    );
    if (fromNode === null && at.length > 0) fail(where, `${type} has from none and an at location`);
    if (fromNode !== null && at.length === 0) fail(where, `${type} needs at least one at location`);
    for (const location of at) {
      for (const node of nodesAt(path, canonical, location, `records ${type} at`)) {
        if (!sameMember(node, fromNode)) {
          fail(
            path,
            `records ${type} at ${locationText(location)} does not hold its from ${entry.from} (G2)`,
          );
        }
      }
    }
    const key = text(where, entry.key, `${type} key`);
    let keyParts = [];
    if (key.startsWith("skeleton:")) {
      keyParts = key.slice("skeleton:".length).split("+");
      for (const name of keyParts) {
        if (!Object.hasOwn(skeleton, name))
          fail(path, `records ${type} key names undeclared skeleton ${name} (G3)`);
      }
      if (at.length > 0 && at.length !== keyParts.length) {
        fail(
          path,
          `records ${type} pairs ${keyParts.length} skeleton(s) with ${at.length} at location(s)`,
        );
      }
    } else if (key !== "singleton" && key !== "host-serial") {
      fail(path, `records ${type} key must be singleton, host-serial, or skeleton:<name>`);
    }
    const open = entry.open === undefined ? false : entry.open;
    if (typeof open !== "boolean") fail(where, `${type} open must be a boolean`);
    if (open && key !== "host-serial") fail(path, `records ${type} is open but not host-serial`);
    if (!open && key === "host-serial") fail(path, `records ${type} is host-serial but not open`);
    const optional = entry.optional === undefined ? false : entry.optional;
    if (typeof optional !== "boolean") fail(where, `${type} optional must be a boolean`);
    const nullable = entry.nullable === undefined ? false : entry.nullable;
    if (typeof nullable !== "boolean") fail(where, `${type} nullable must be a boolean`);
    const record = {
      type,
      from: entry.from === "none" ? null : entry.from,
      fromNode,
      at,
      key,
      slotFrom:
        entry.slotFrom === undefined ? null : text(where, entry.slotFrom, `${type} slotFrom`),
      keyParts,
      open,
      closedBy:
        entry.closedBy === undefined ? null : text(where, entry.closedBy, `${type} closedBy`),
      optional,
      default:
        entry.default === undefined
          ? null
          : oneOf(where, entry.default, RECORD_DEFAULTS, `${type} default`),
      nullable,
      narrowSource: entry.narrow ?? {},
      addSource: entry.add ?? {},
    };
    types.set(type, record);
    return record;
  });

  // Owner claims on canonical members, for G1 and G4.
  const claims = [];
  for (const record of recordEntries) {
    for (const location of record.at) {
      claims.push({ segments: location, owner: "record", id: record.type });
    }
  }
  const claim = (owner, id, field, label) => {
    const segments = parseCanonicalLocation(path, field, label);
    nodesAt(path, canonical, segments, label);
    for (const segment of segments) {
      if (segment.selector && !Object.hasOwn(ANSWER_RECORD_SELECTORS, segment.selector)) {
        fail(path, `${label} selects undeclared key subset {${segment.selector}} (G3)`);
      }
    }
    claims.push({ segments, owner, id });
    return field;
  };
  const hostMinted = list(path, document.hostMinted ?? [], "hostMinted", { nonEmpty: false }).map(
    (entry) => {
      exactKeys(`${path} hostMinted`, entry, ["field", "source"]);
      const source = hostInput(path, entry.source, "hostMinted source");
      return { field: claim("hostMinted", source, entry.field, "hostMinted field"), source };
    },
  );
  const derive = list(path, document.derive ?? [], "derive", { nonEmpty: false }).map((entry) => {
    exactKeys(`${path} derive`, entry, ["field", "rule"], ["reads"]);
    const rule = ruleName(`${path} derive`, entry.rule);
    const reads =
      entry.reads === undefined
        ? []
        : list(path, entry.reads, "derive reads").map((value) => text(path, value, "reads"));
    return { field: claim("derive", rule, entry.field, "derive field"), rule, reads };
  });
  for (const reference of references) {
    if (reference.field)
      claim("reference", reference.namespace, reference.field, "references field");
  }
  const compose = list(path, document.compose ?? [], "compose", { nonEmpty: false }).map(
    (entry) => {
      const where = `${path} compose`;
      exactKeys(where, entry, ["field", "parts"]);
      const field = claim("compose", entry.field, entry.field, "compose field");
      const composeParts = list(where, entry.parts, "parts").map((part) => {
        exactKeys(where, part, [], ["host", "model"]);
        if ((part.host === undefined) === (part.model === undefined)) {
          fail(where, "a compose part is exactly one of host or model");
        }
        if (part.host !== undefined) {
          const host = text(where, part.host, "host part");
          if (host.startsWith("reference:")) {
            if (!parts.has(host.slice("reference:".length))) {
              fail(path, `compose ${field} host part ${host} has no matching references part (G3)`);
            }
          } else {
            ruleName(where, host);
          }
          return { host };
        }
        const model = text(where, part.model, "model part");
        const match = /^([a-z][a-z0-9-]*)\.([a-z_][a-z0-9_]*)$/u.exec(model);
        if (!match || !types.has(match[1]))
          fail(path, `compose ${field} model part ${model} names no record type (G2)`);
        return { model, type: match[1], name: match[2] };
      });
      if (!composeParts.some((part) => part.model)) {
        // A compose member with no model part is host-derived; declare it in derive.
        fail(path, `compose ${field} has no model part; declare a host-only member in derive`);
      }
      return { field, parts: composeParts };
    },
  );

  // Generate each record's shape per `at` location (§1.1): from minus every
  // member owned by hostMinted, derive, references or compose, except the
  // record's own field a compose entry names as its model part; plus `add`;
  // with `narrow` applied.
  const records = recordEntries.map((record) => {
    const where = `${path} records ${record.type}`;
    const add = {};
    // An add field is optional, except a const flag, which closes an open set.
    const requiredAdds = [];
    const fromProperties =
      record.fromNode === null
        ? new Set()
        : new Set(record.fromNode.kind === "object" ? record.fromNode.props.keys() : []);
    for (const [name, form] of Object.entries(record.addSource)) {
      if (!/^[a-z_][A-Za-z0-9_]*$/u.test(name))
        fail(where, `add field ${name} is not a field name`);
      if (fromProperties.has(name)) {
        fail(
          path,
          `records ${record.type} add field ${name} collides with a canonical member of its from (G2)`,
        );
      }
      if (!isPlainObject(form))
        fail(path, `records ${record.type} add ${name} is not in a declared form (G2)`);
      const keys = Object.keys(form).sort().join(",");
      let schema;
      if (keys === "schema" || keys === "array,schema") {
        schema = inlineSchemaNode(
          path,
          canonical,
          form.schema,
          `records ${record.type} add ${name}`,
        );
      } else if (keys === "enum" || keys === "array,enum") {
        schema = {
          type: "string",
          "x-docsfab-enum-source": enumSource(
            path,
            form.enum,
            { skeleton, namespaces },
            `records ${record.type} add ${name}`,
          ),
        };
      } else if (keys === "const") {
        if (typeof form.const !== "boolean" && typeof form.const !== "string") {
          fail(path, `records ${record.type} add ${name} const must be a boolean or a string (G5)`);
        }
        schema = { const: form.const };
        requiredAdds.push(name);
      } else {
        fail(path, `records ${record.type} add ${name} is not in a declared form (G2)`);
      }
      if (form.array !== undefined) {
        if (form.array !== true)
          fail(path, `records ${record.type} add ${name} array must be true`);
        schema = { type: "array", items: schema };
      }
      add[name] = schema;
    }
    const ownFields = new Set(
      compose
        .flatMap((entry) =>
          entry.parts.filter((part) => part.type === record.type).map((part) => ({ entry, part })),
        )
        .filter(({ part }) => !Object.hasOwn(add, part.name))
        .map(({ entry, part }) => {
          // A model part that is not an add field must be the record's own
          // field at the composed member.
          const segments = parseCanonicalLocation(path, entry.field, "compose field");
          const own = record.at.some((location) => {
            const relative = relativeUnder(location, segments);
            return (
              relative &&
              relative.when === null &&
              relative.rest.length === 1 &&
              relative.rest[0].prop === part.name
            );
          });
          if (!own) {
            fail(
              path,
              `compose ${entry.field} model part ${part.model} is neither an add field nor the record's own field there (G2)`,
            );
          }
          return entry.field;
        }),
    );
    const shapes = record.at.map((location) => {
      const shape =
        record.fromNode === null
          ? null
          : canonical.members.get(location[0].prop).registry
            ? registryShape(record.fromNode)
            : inlineSchema(
                canonical.members.get(location[0].prop).root,
                record.fromNode.schema,
                path,
              );
      const owned = [];
      for (const entry of claims) {
        if (entry.owner === "record" && entry.segments === location) continue;
        const relative = relativeUnder(location, entry.segments);
        if (!relative) continue;
        if (entry.owner === "compose" && ownFields.has(entry.id)) continue;
        owned.push({
          member: memberText(relative.rest),
          rest: relative.rest,
          owner: entry.owner,
          id: entry.id,
          when: relative.when,
        });
      }
      const conditional = [];
      for (const member of owned) {
        if (member.when) {
          conditional.push({
            member: member.member,
            owner: `${member.owner} ${member.id}`,
            when: member.when,
          });
        } else {
          removeShapeMember(shape, member.rest);
        }
      }
      return { at: locationText(location), shape, owned, conditional };
    });
    if (shapes.length === 0) shapes.push({ at: null, shape: null, owned: [], conditional: [] });
    for (const entry of shapes) {
      entry.shape ??= { type: "object", additionalProperties: false, properties: {} };
      entry.shape.properties = { ...entry.shape.properties, ...add };
      if (requiredAdds.length > 0) {
        entry.shape.required = [...(entry.shape.required ?? []), ...requiredAdds];
      }
    }
    // Narrowing: field enums or subsets from named sources, at a member of
    // the generated shape.
    const narrow = {};
    for (const [field, source] of Object.entries(record.narrowSource)) {
      const rest = field.split(".").map((prop) => ({ prop }));
      const value = enumSource(
        path,
        source,
        { skeleton, namespaces, subset: true },
        `records ${record.type} narrow ${field}`,
      );
      for (const entry of shapes) {
        const found = shapeMember(entry.shape, rest);
        if (!found)
          fail(
            path,
            `records ${record.type} narrow ${field} names no member of its record shape (G2)`,
          );
        found.parent.properties[found.name] = { ...found.node, "x-docsfab-narrow": value };
      }
      narrow[field] = value;
    }
    if (
      record.slotFrom !== null &&
      (!record.open || !Object.hasOwn(record.addSource, record.slotFrom))
    ) {
      fail(where, `${type} slotFrom must name an add field on an open record (G3)`);
    }
    return {
      type: record.type,
      from: record.from,
      key: record.key,
      slotFrom: record.slotFrom,
      skeletons: record.keyParts,
      open: record.open,
      closedBy: record.closedBy,
      optional: record.optional,
      default: record.default,
      nullable: record.nullable,
      narrow,
      add: Object.keys(add),
      shapes,
    };
  });
  checkRecordShapes(path, records);

  // G6: an open set closes by a declared flag and has an open-set limit; an
  // optional record has a default.
  for (const record of records) {
    if (record.open) {
      if (!record.closedBy || !limits.openRecords) {
        fail(
          path,
          `records ${record.type} is an open set without closedBy and limits openRecords (G6)`,
        );
      }
      const [closer, flag] = record.closedBy.split(".");
      const closing = records.find((candidate) => candidate.type === closer);
      const flagShape = closing?.shapes[0].shape.properties[flag];
      if (!closing || flagShape?.const !== true) {
        fail(
          path,
          `records ${record.type} closedBy ${record.closedBy} names no const true add field (G6)`,
        );
      }
    } else if (record.closedBy) {
      fail(path, `records ${record.type} declares closedBy but is not open`);
    }
    if (record.optional && record.default === null) {
      fail(path, `records ${record.type} is optional without a default (G6)`);
    }
    if (!record.optional && record.default !== null) {
      fail(path, `records ${record.type} declares a default but is not optional`);
    }
  }

  // G4: every canonical leaf member has exactly one owner. A member inherits
  // its nearest claimed ancestor's owner; a deeper claim carves it out of a
  // record only. A selector claim splits a member by key: both halves need
  // one owner. A compose member counts once.
  const problems = [];
  for (const leaf of canonicalLeaves(canonical)) {
    const chain = [];
    for (let depth = 1; depth <= leaf.length; depth += 1) {
      const prefix = leaf.slice(0, depth);
      for (const entry of claims) {
        const match = matchConcrete(entry.segments, prefix);
        if (match) chain.push({ ...entry, depth, partial: match.partial });
      }
    }
    const worlds = chain.some((entry) => entry.partial)
      ? [chain, chain.filter((entry) => !entry.partial)]
      : [chain];
    for (const world of worlds) {
      const label = `${locationText(leaf)}${world.length < chain.length ? " (keys outside the selector)" : ""}`;
      if (world.length === 0) {
        problems.push(`${label} has no owner`);
        continue;
      }
      const byDepth = new Map();
      for (const entry of world)
        byDepth.set(entry.depth, [...(byDepth.get(entry.depth) ?? []), entry]);
      const depths = [...byDepth.keys()].sort((left, right) => left - right);
      const describe = (entry) => `${entry.owner} ${entry.id}`;
      if (depths.some((depth) => byDepth.get(depth).length > 1)) {
        problems.push(`${label} has more than one owner (${world.map(describe).join(", ")})`);
        continue;
      }
      const ancestors = depths.slice(0, -1).map((depth) => byDepth.get(depth)[0]);
      const owner = byDepth.get(depths.at(-1))[0];
      if (
        ancestors.some((entry) => entry.owner !== "record") ||
        (ancestors.length > 0 && owner.owner === "record")
      ) {
        problems.push(`${label} has more than one owner (${world.map(describe).join(", ")})`);
      }
    }
  }
  if (problems.length > 0) {
    fail(
      path,
      `canonical coverage (G4): ${problems.slice(0, 8).join("; ")}${problems.length > 8 ? `; and ${problems.length - 8} more` : ""}`,
    );
  }
  return {
    canonical: {
      members: Object.fromEntries(
        [...canonical.members].map(([name, entry]) => [name, entry.source]),
      ),
      profile: canonical.profile,
    },
    skeleton,
    records: records.map(({ shapes, ...record }) => ({
      ...record,
      shapes: shapes.map(({ at, shape, conditional }) => ({ at, shape, conditional })),
    })),
    hostMinted,
    derive,
    references,
    compose: compose.map((entry) => ({
      field: entry.field,
      parts: entry.parts.map((part) => (part.host ? { host: part.host } : { model: part.model })),
    })),
    limits,
  };
}

/**
 * G1: no generated record shape contains a member that hostMinted, derive,
 * references or compose owns, except the record's own field a compose entry
 * names as its model part (exempted when the shape is generated). A member
 * owned only for some keys must be listed as conditional instead.
 */
export function checkRecordShapes(path, records) {
  for (const record of records) {
    for (const entry of record.shapes) {
      for (const member of entry.owned) {
        const present = shapeMember(entry.shape, member.rest) !== null;
        const listed = entry.conditional.some((item) => item.member === member.member);
        if (member.when ? !listed : present) {
          fail(
            path,
            `records ${record.type} shape at ${entry.at} contains ${member.member}, owned by ${member.owner} ${member.id} (G1)`,
          );
        }
      }
    }
  }
}

function inlineSchemaNode(path, canonical, pointer, field) {
  const node = resolveCanonicalPointer(path, canonical, pointer, field);
  const member = canonical.members.get(pointer.split("#")[0]);
  return member.registry ? registryShape(node) : inlineSchema(member.root, node.schema, path);
}

/**
 * A narrowing or `add` enum source: `subset-of:<host input>`,
 * `skeleton:<name>+<name>`, `references:<namespace>+<namespace>`, or a
 * registered host input (G3). A literal is refused (G5).
 */
function enumSource(path, value, { skeleton, namespaces, subset = false }, field) {
  if (typeof value === "number") fail(path, `${field} is a literal number (G5)`);
  const source = text(path, value, field);
  if (/^-?\d+(?:\.\d+)?$/u.test(source)) fail(path, `${field} is a literal number (G5)`);
  if (source.startsWith("subset-of:")) {
    if (!subset) fail(path, `${field} uses subset-of outside a narrowing`);
    hostInput(path, source.slice("subset-of:".length), field);
    return source;
  }
  if (source.startsWith("skeleton:")) {
    for (const name of source.slice("skeleton:".length).split("+")) {
      if (!Object.hasOwn(skeleton, name))
        fail(path, `${field} names undeclared skeleton ${name} (G3)`);
    }
    return source;
  }
  if (source.startsWith("references:")) {
    for (const name of source.slice("references:".length).split("+")) {
      if (!namespaces.has(name))
        fail(path, `${field} narrows to undeclared reference namespace ${name} (G3)`);
    }
    return source;
  }
  return hostInput(path, source, field);
}

/** Rules the model is told about: every rule except `host` rules and the catch-all. */
function isStated(rule) {
  return rule.statement !== null;
}

function validateContract({ path, document }, context, familyByName, ruleByCode) {
  const kind = oneOf(
    path,
    document.kind,
    ["docsfab-response-contract", "docsfab-prose-step"],
    "kind",
  );
  const id = kebab(path, document.id, "id");
  if (path !== `${CATALOG_ROOT}/contracts/${id}.yaml`) {
    fail(path, `contract ${id} must live in ${CATALOG_ROOT}/contracts/${id}.yaml`);
  }
  const binding = (source, value) => {
    exactKeys(source, value, ["workflow", "step"]);
    const manifest = context.manifests.get(value.workflow);
    if (!manifest) fail(source, `names unknown workflow ${value.workflow}`);
    if (!manifestStepIds(manifest).has(value.step)) {
      fail(source, `workflow ${value.workflow} has no step ${value.step}`);
    }
    return { workflow: value.workflow, step: value.step };
  };
  if (kind === "docsfab-prose-step") {
    exactKeys(path, document, [
      "schemaVersion",
      "kind",
      "id",
      "step",
      "rationale",
      "owner",
      "revisit",
    ]);
    return {
      kind,
      id,
      step: binding(`${path} step`, document.step),
      rationale: text(path, document.rationale, "rationale"),
      owner: oneOf(path, document.owner, CONTRACT_OWNERS, "owner"),
      revisit: text(path, document.revisit, "revisit"),
    };
  }
  const declaresCanonical = document.canonical !== undefined;
  exactKeys(
    path,
    document,
    [
      "schemaVersion",
      "kind",
      "id",
      "version",
      "owner",
      "bindings",
      "placement",
      "outputMode",
      "decoders",
      ...(declaresCanonical ? ["canonical", "records"] : ["title", "shape", "render"]),
    ],
    declaresCanonical
      ? ["skeleton", "hostMinted", "derive", "references", "compose", "limits"]
      : ["hostMinted"],
  );
  if (!Number.isInteger(document.version) || document.version < 1) {
    fail(path, "version must be a positive integer");
  }
  const placement =
    document.placement === "outer" || /^nested-in:[a-z][a-z0-9-]*$/u.test(document.placement ?? "")
      ? document.placement
      : fail(path, "placement must be outer or nested-in:<contract-id>");
  const decoders = distinct(
    path,
    list(path, document.decoders, "decoders").map((name) => {
      if (!familyByName.has(name)) fail(path, `decoders names unknown rule family ${name}`);
      return name;
    }),
    "decoders",
  );
  const owner = oneOf(path, document.owner, CONTRACT_OWNERS, "owner");
  // A host call that precedes every workflow step, such as the request
  // interpretation, binds to no step.
  const bindings = list(path, document.bindings, "bindings", { nonEmpty: false }).map((value) =>
    binding(`${path} binding`, value),
  );
  const outputMode = oneOf(path, document.outputMode, OUTPUT_MODES, "outputMode");
  if (declaresCanonical) {
    // The record shapes are generated from the canonical members, so the
    // contract states no shape and no render of its own; the record plan is
    // rendered by the runtime (design §4.1).
    return {
      kind,
      id,
      version: document.version,
      owner,
      bindings,
      placement,
      outputMode,
      decoders,
      records: validateRecordsDeclaration(path, document, context, { owner, bindings }),
    };
  }
  if (outputMode === "records") {
    fail(path, "outputMode records needs a canonical declaration (design §1.1)");
  }
  const shape = validateShape(path, document.shape);
  const hostMinted = (
    document.hostMinted === undefined
      ? []
      : list(path, document.hostMinted, "hostMinted", { nonEmpty: false })
  ).map((field) => text(path, field, "hostMinted field"));
  const shapeKeys = shapeVocabulary(shape).keys;
  for (const field of hostMinted) {
    if (shapeKeys.includes(field)) fail(path, `shape contains host-minted field ${field}`);
  }
  const familyCodes = new Set(decoders.flatMap((name) => familyByName.get(name).codes));
  const renderedRules = [];
  const hostBlocks = [];
  const render = list(path, document.render, "render").map((entry) => {
    const keys = Object.keys(entry ?? {});
    if (keys.includes("rule")) {
      exactKeys(`${path} render`, entry, ["rule"]);
      const rule = ruleByCode.get(entry.rule);
      if (!rule) fail(path, `render names undeclared rule ${entry.rule}`);
      if (!familyCodes.has(entry.rule)) {
        fail(path, `render names ${entry.rule}, which no decoder family of this contract raises`);
      }
      if (!isStated(rule))
        fail(path, `render names ${entry.rule}, which is never stated to the model`);
      renderedRules.push(entry.rule);
      // A rule's location-specific sentence replaces its statement in a
      // contract whose shape holds that location (ADR, Rule Record: hint).
      const overrides = rule.locations
        .filter((location) => shapeNodeAt(shape, location) !== undefined)
        .map((location) => rule.atLocation[location]);
      const sentence =
        overrides.length > 0 && overrides.every(Boolean)
          ? [...new Set(overrides)].join(" ")
          : rule.statement;
      return { rule: entry.rule, text: sentence };
    }
    if (keys.includes("host")) {
      exactKeys(`${path} render`, entry, ["host", "label"]);
      const name = kebab(path, entry.host, "host block");
      hostBlocks.push(name);
      return { host: name, label: text(path, entry.label, `host ${name} label`) };
    }
    exactKeys(`${path} render`, entry, ["note"]);
    return { note: placeholders(path, text(path, entry.note, "note"), "note", context) };
  });
  distinct(path, renderedRules, "render rules");
  distinct(path, hostBlocks, "render host blocks");
  for (const code of familyCodes) {
    const rule = ruleByCode.get(code);
    if (!isStated(rule)) continue;
    const inside = rule.locations.filter((location) => shapeNodeAt(shape, location) !== undefined);
    const outside = rule.locations.filter((location) => !inside.includes(location));
    context.reach.push({ contract: id, code, outside });
    if (inside.length > 0 && !renderedRules.includes(code)) {
      fail(
        path,
        `rule ${code} can be raised inside this contract's shape but is not stated (#1248)`,
      );
    }
  }
  return {
    kind,
    id,
    version: document.version,
    owner,
    bindings,
    placement,
    outputMode,
    decoders,
    title: text(path, document.title, "title"),
    shape,
    hostMinted,
    render,
  };
}

/**
 * Validate every catalog document. Pure: `sources` is `readCatalogSources()`
 * output or a test's in-memory equivalent. Returns the normalized catalog and
 * the findings (numeric literals, pinned codes) the gate compares with the
 * allowlist.
 */
export function validateCatalog(sources) {
  const findings = [];
  const segmentLength = sources.limits.get(SEGMENT_LIMIT);
  const reasonLength = sources.limits.get(REASON_LIMIT);
  if (!Number.isInteger(segmentLength) || !Number.isInteger(reasonLength)) {
    fail(LIMITS_PATH, `must declare ${SEGMENT_LIMIT} and ${REASON_LIMIT}`);
  }
  const context = {
    limits: sources.limits,
    failureClasses: sources.failureClasses,
    segmentLength,
    reasonLength,
    codeGrammar: recordedCodeGrammar(segmentLength),
    locationGrammar: recordedLocationGrammar(segmentLength),
    grammarIds: new Set(),
    manifests: sources.manifests,
    readFixture: sources.readFixture,
    readCanonical: sources.readCanonical ?? (() => undefined),
    keyRegistry: sources.keyRegistry ?? {},
    findings,
    reach: [],
  };
  const grammars = validateGrammars(sources.grammars, context);
  context.grammarIds = new Set(grammars.map((grammar) => grammar.id));
  const retryPolicy = validateRetryPolicy(sources.retryPolicy, context);
  const families = [];
  const rules = [];
  const ruleByCode = new Map();
  const pathOfFamily = new Map();
  for (const file of sources.rules) {
    const { family, rules: familyRules } = validateRuleFile(file, context);
    if (pathOfFamily.has(family.name)) fail(file.path, `repeats family ${family.name}`);
    pathOfFamily.set(family.name, file.path);
    for (const rule of familyRules) {
      if (ruleByCode.has(rule.code)) {
        fail(file.path, `repeats code ${rule.code}, declared elsewhere`);
      }
      ruleByCode.set(rule.code, rule);
      rules.push(rule);
    }
    families.push({ ...family, own: familyRules.map((rule) => rule.code) });
  }
  const catchAlls = rules.filter((rule) => rule.catchAll);
  if (catchAlls.length > 1) {
    fail("rules", `declare one catch-all, not ${catchAlls.map((rule) => rule.code).join(", ")}`);
  }
  // A family's `uses` adds its own locations and sentences to a shared code.
  for (const family of families) {
    const path = pathOfFamily.get(family.name);
    for (const use of family.uses) {
      const rule = ruleByCode.get(use.code);
      if (!rule) fail(path, `uses names undeclared code ${use.code}`);
      if (rule.family === family.name) fail(path, `uses names its own code ${use.code}`);
      rule.locations = [...new Set([...rule.locations, ...use.locations])];
      const sentences = atLocationSentences(
        `${path} uses ${use.code}`,
        use.atLocation,
        rule.locations,
        context,
      );
      if (Object.keys(sentences).length > 0 && !isStated(rule)) {
        fail(path, `uses ${use.code} adds a sentence to a rule that is never stated`);
      }
      for (const [location, sentence] of Object.entries(sentences)) {
        if (Object.hasOwn(rule.atLocation, location) && rule.atLocation[location] !== sentence) {
          fail(path, `uses ${use.code} gives ${location} a second sentence`);
        }
        rule.atLocation = { ...rule.atLocation, [location]: sentence };
      }
    }
  }
  const aliasOwner = new Map();
  for (const rule of rules) {
    for (const alias of rule.aliases) {
      if (ruleByCode.has(alias) || aliasOwner.has(alias)) {
        fail(`rule ${rule.code}`, `alias ${alias} is already a declared code or alias`);
      }
      aliasOwner.set(alias, rule);
    }
    if (rule.outer !== null) {
      const outer = ruleByCode.get(rule.outer);
      if (!outer) fail(`rule ${rule.code}`, `outer names undeclared code ${rule.outer}`);
      if (outer.outer !== null) {
        fail(`rule ${rule.code}`, "an outer code cannot itself be an inner reason");
      }
      const terminal = (entry) => TERMINAL_KINDS.includes(entry.kind) || entry.retry === "terminal";
      if (terminal(rule) !== terminal(outer)) {
        fail(
          `rule ${rule.code}`,
          `inner reason is ${rule.retry} (${rule.kind}) under ${outer.retry} (${outer.kind}) outer code ${outer.code}; they must agree`,
        );
      }
    }
  }
  // Recorded codes are immutable (ADR question 8): every recorded code stays
  // declared or aliased, every declared code is recorded, and pins hold.
  const recorded = validateRecordedCodes(sources.recordedCodes, context);
  const recordedSet = new Set(recorded.map((entry) => entry.code));
  for (const rule of rules) {
    if (!recordedSet.has(rule.code)) {
      fail(
        RECORDED_CODES_PATH,
        `does not record ${rule.code}; append "- code: ${rule.code}" (recorded codes are never removed)`,
      );
    }
  }
  for (const entry of recorded) {
    const rule = ruleByCode.get(entry.code) ?? aliasOwner.get(entry.code);
    if (!rule) {
      fail(
        RECORDED_CODES_PATH,
        `recorded code ${entry.code} disappeared from the catalog; keep it, or list it in the replacing rule's aliases`,
      );
    }
    if (ruleByCode.has(entry.code) && aliasOwner.has(entry.code)) {
      fail(RECORDED_CODES_PATH, `${entry.code} is both declared and an alias`);
    }
    if (entry.pinned !== null && (rule.kind !== entry.pinned || rule.retry !== "terminal")) {
      findings.push({
        check: "pinned-code",
        path: RECORDED_CODES_PATH,
        subject: entry.code,
        lexeme: `${rule.code} ${rule.kind} ${rule.retry}`,
      });
    }
  }
  const familyByName = new Map();
  for (const family of families) {
    const path = pathOfFamily.get(family.name);
    if (family.replay !== null) {
      const mode = retryPolicy.replayModes.find((entry) => entry.id === family.replay);
      if (!mode) fail(path, `replay mode ${family.replay} is not declared in retry-policy.yaml`);
    }
    familyByName.set(family.name, {
      ...family,
      codes: [...family.own, ...family.uses.map((use) => use.code)],
    });
  }
  const contracts = sources.contracts.map((file) =>
    validateContract(file, context, familyByName, ruleByCode),
  );
  distinct(
    "contracts",
    contracts.map((contract) => contract.id),
    "contract ids",
  );
  // Stated-rule reach: a location a contract's decoder raises must lie inside
  // the shape of some contract that decodes the family.
  for (const rule of rules) {
    const reaches = context.reach.filter((entry) => entry.code === rule.code);
    if (reaches.length === 0) continue;
    for (const location of rule.locations) {
      if (reaches.every((entry) => entry.outside.includes(location))) {
        fail(
          `rule ${rule.code}`,
          `location ${location} lies outside every contract shape that raises it`,
        );
      }
    }
  }
  collectNumeralFindings(
    { rules, grammars, retryPolicy, contracts, families, pathOfFamily },
    findings,
  );
  return {
    catalog: {
      families: [...familyByName.values()].map(
        ({ name, replay, recordedPrefix, codes, own, uses, hostText }) => ({
          name,
          replay,
          recordedPrefix,
          codes,
          own,
          uses: uses.map((use) => use.code),
          hostText,
        }),
      ),
      rules,
      grammars,
      replayModes: retryPolicy.replayModes,
      retryRules: retryPolicy.retryRules,
      recordedRetryRules: retryPolicy.recordedRetryRules,
      contracts,
      recorded,
    },
    findings,
  };
}

function collectNumeralFindings(
  { rules, grammars, retryPolicy, contracts, families, pathOfFamily },
  findings,
) {
  const scan = (path, subject, value) => {
    const withoutPlaceholders = value.replaceAll(PLACEHOLDER, "");
    for (const match of withoutPlaceholders.matchAll(NUMERAL)) {
      findings.push({ check: "numeric-literal", path, subject, lexeme: match[0] });
    }
  };
  const seenPattern = new Set();
  for (const rule of rules) {
    const path = pathOfFamily.get(rule.family);
    const subject = rule.pattern ?? rule.code;
    if (rule.pattern) {
      if (seenPattern.has(rule.pattern)) continue;
      seenPattern.add(rule.pattern);
    }
    if (rule.statement) scan(path, subject, rule.statement);
    for (const [location, value] of Object.entries(rule.atLocation)) {
      scan(path, `${subject} ${location}`, value);
    }
  }
  for (const family of families) {
    for (const entry of family.hostText) {
      scan(pathOfFamily.get(family.name), `hostText ${entry.id}`, entry.text);
    }
  }
  for (const grammar of grammars) {
    scan(`${CATALOG_ROOT}/grammars.yaml`, grammar.id, grammar.statement);
  }
  for (const mode of retryPolicy.replayModes) {
    if (mode.statement) scan(`${CATALOG_ROOT}/retry-policy.yaml`, mode.id, mode.statement);
  }
  for (const rule of retryPolicy.retryRules) {
    if (rule.statement) scan(`${CATALOG_ROOT}/retry-policy.yaml`, rule.id, rule.statement);
  }
  for (const contract of contracts) {
    // A records-mode contract states no sentences of its own (§4.1).
    if (contract.kind !== "docsfab-response-contract" || contract.records) continue;
    const path = `${CATALOG_ROOT}/contracts/${contract.id}.yaml`;
    scan(path, `${contract.id} title`, contract.title);
    for (const entry of contract.render) {
      if (entry.note) scan(path, `${contract.id} note`, entry.note);
      if (entry.label) scan(path, `${contract.id} ${entry.host}`, entry.label);
    }
  }
}

// ---------------------------------------------------------------------------
// Rendering

/** A TypeScript string literal as Biome prints it (double quotes unless more escapes). */
export function tsString(value) {
  const doubles = (value.match(/"/gu) ?? []).length;
  const singles = (value.match(/'/gu) ?? []).length;
  const json = JSON.stringify(value);
  if (doubles <= singles) return json;
  const inner = json.slice(1, -1).replaceAll('\\"', '"').replaceAll("'", "\\'");
  return `'${inner}'`;
}

function tsKey(key) {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/u.test(key) ? key : JSON.stringify(key);
}

function tsNullable(value) {
  return value === null ? "null" : tsString(value);
}

/** One `key: value,` property at `indent`, broken after the colon when too long. */
function tsProperty(indent, key, rendered) {
  const pad = " ".repeat(indent);
  const printedKey = tsKey(key);
  const inline = `${pad}${printedKey}: ${rendered},`;
  // Biome, like Prettier, never breaks after a key narrower than five columns.
  if (inline.length <= TS_LINE_WIDTH || printedKey.length < 5) return inline;
  return `${pad}${printedKey}:\n${pad}  ${rendered},`;
}

function tsUnion(name, members) {
  const quoted = members.map((member) => JSON.stringify(member));
  const inline = `export type ${name} = ${quoted.join(" | ")};`;
  if (inline.length <= TS_LINE_WIDTH) return inline;
  return `export type ${name} =\n${quoted.map((member) => `  | ${member}`).join("\n")};`;
}

function tsStringArray(indent, key, values) {
  const pad = " ".repeat(indent);
  const items = values.map(tsString);
  const inline = `${pad}${tsKey(key)}: [${items.join(", ")}],`;
  if (inline.length <= TS_LINE_WIDTH) return inline;
  return `${pad}${tsKey(key)}: [\n${items.map((item) => `${pad}  ${item},`).join("\n")}\n${pad}],`;
}

/** An always-expanded object, which Biome keeps expanded. */
function tsObject(indent, key, lines) {
  const pad = " ".repeat(indent);
  if (lines.length === 0) return `${pad}${tsKey(key)}: {},`;
  return `${pad}${tsKey(key)}: {\n${lines.join("\n")}\n${pad}},`;
}

function renderRuleTs(rule) {
  const lines = [
    tsProperty(4, "code", tsString(rule.code)),
    tsProperty(4, "family", tsString(rule.family)),
    tsProperty(4, "pattern", tsNullable(rule.pattern)),
    tsStringArray(4, "locations", rule.locations),
    tsProperty(4, "kind", tsString(rule.kind)),
    tsProperty(4, "retry", tsString(rule.retry)),
    tsProperty(4, "reason", tsString(rule.reason)),
    tsProperty(4, "failureClass", tsString(rule.failureClass)),
    tsProperty(4, "failureClassReason", tsNullable(rule.failureClassReason)),
    tsProperty(4, "statement", tsNullable(rule.statement)),
    tsObject(
      4,
      "atLocation",
      Object.entries(rule.atLocation).map(([location, value]) =>
        tsProperty(6, location, tsString(value)),
      ),
    ),
    tsProperty(4, "hostDetail", tsNullable(rule.hostDetail)),
    tsProperty(4, "outer", tsNullable(rule.outer)),
    tsProperty(4, "catchAll", String(rule.catchAll)),
    tsStringArray(4, "aliases", rule.aliases),
    tsObject(4, "operator", [
      tsProperty(6, "kind", tsString(rule.operator.kind)),
      tsProperty(6, "meaning", tsString(rule.operator.meaning)),
      tsProperty(6, "next", tsString(rule.operator.next)),
    ]),
    tsStringArray(4, "fixtures", rule.fixtures),
    tsProperty(4, "docs", tsString(rule.docs)),
  ];
  return `  ${tsKey(rule.code)}: {\n${lines.join("\n")}\n  },`;
}

function renderFamilyTs(family) {
  const lines = [
    tsProperty(4, "replay", tsNullable(family.replay)),
    tsProperty(4, "recordedPrefix", tsNullable(family.recordedPrefix)),
    tsStringArray(4, "codes", family.codes),
  ];
  return `  ${tsKey(family.name)}: {\n${lines.join("\n")}\n  },`;
}

function renderGrammarTs(grammar) {
  const lines = [
    tsProperty(4, "form", tsString(grammar.form)),
    tsProperty(4, "statement", tsString(grammar.statement)),
    tsProperty(4, "pattern", tsString(grammar.pattern)),
    tsProperty(4, "maxLength", tsNullable(grammar.maxLength)),
    tsStringArray(4, "illustrative", grammar.examples.illustrative),
    tsStringArray(4, "flowsInto", grammar.flowsInto),
  ];
  return `  ${tsKey(grammar.id)}: {\n${lines.join("\n")}\n  },`;
}

/** An array element object: inline when it fits, otherwise expanded. */
function tsElementObject(indent, fields) {
  const pad = " ".repeat(indent);
  const inline = `${pad}{ ${fields.map(([key, value]) => `${tsKey(key)}: ${value}`).join(", ")} },`;
  if (inline.length <= TS_LINE_WIDTH) return inline;
  const lines = fields.map(([key, value]) => tsProperty(indent + 2, key, value));
  return `${pad}{\n${lines.join("\n")}\n${pad}},`;
}

function renderContractTs(contract) {
  const render = contract.render.map((entry) => {
    if (entry.rule) {
      return tsElementObject(6, [
        ["rule", tsString(entry.rule)],
        ["text", tsString(entry.text)],
      ]);
    }
    if (entry.note) return tsElementObject(6, [["note", tsString(entry.note)]]);
    return tsElementObject(6, [
      ["host", tsString(entry.host)],
      ["label", tsString(entry.label)],
    ]);
  });
  const lines = [
    tsProperty(4, "version", String(contract.version)),
    tsProperty(4, "owner", tsString(contract.owner)),
    tsStringArray(4, "decoders", contract.decoders),
    tsProperty(4, "title", tsString(contract.title)),
    `    render: [\n${render.join("\n")}\n    ],`,
  ];
  return `  ${tsKey(contract.id)}: {\n${lines.join("\n")}\n  },`;
}

/** The generated table entry for one records-mode contract (design §1.1). */
function recordContractEntry(contract) {
  const { records } = contract;
  return {
    version: contract.version,
    owner: contract.owner,
    bindings: contract.bindings,
    outputMode: contract.outputMode,
    decoders: contract.decoders,
    canonical: records.canonical,
    skeleton: records.skeleton,
    records: records.records,
    hostMinted: records.hostMinted,
    derive: records.derive,
    references: records.references,
    compose: records.compose,
    limits: records.limits,
  };
}

function recordContracts(catalog) {
  return catalog.contracts.filter((contract) => contract.records !== undefined);
}

function renderRetryRuleTs(rule) {
  return [
    `  ${tsKey(rule.id)}: {`,
    tsProperty(4, "decision", tsString(rule.decision)),
    tsProperty(4, "budget", tsNullable(rule.budget)),
    tsProperty(4, "summary", tsString(rule.summary)),
    tsProperty(4, "reason", tsString(rule.reason)),
    tsProperty(4, "statement", tsNullable(rule.statement)),
    tsProperty(4, "concludeNow", String(rule.concludeNow)),
    tsProperty(4, "next", tsString(rule.next)),
    "  },",
  ].join("\n");
}

function tsConstObject(name, entries, satisfies) {
  if (entries.length === 0) return `export const ${name} = {} as const satisfies ${satisfies};`;
  return `export const ${name} = {\n${entries.join("\n")}\n} as const satisfies ${satisfies};`;
}

function hostTextEntries(catalog) {
  return catalog.families.flatMap((family) =>
    // Long host text wraps the way every other generated property does.
    family.hostText.map((entry) => tsProperty(2, entry.id, tsString(entry.text))),
  );
}

export function renderRuntimeTypeScript(catalog) {
  const responseContracts = catalog.contracts.filter(
    (contract) => contract.kind === "docsfab-response-contract" && contract.records === undefined,
  );
  const records = recordContracts(catalog);
  const recordTable = JSON.stringify(
    Object.fromEntries(records.map((contract) => [contract.id, recordContractEntry(contract)])),
    null,
    2,
  );
  const aliases = catalog.rules.flatMap((rule) =>
    rule.aliases.map((alias) => `  ${tsKey(alias)}: ${tsString(rule.code)},`),
  );
  // Record shapes carry JSON Schema's \`if\`/\`then\` keywords as data.
  const thenKeyword = records.some((contract) =>
    JSON.stringify(contract.records.records).includes('"then":'),
  );
  return `// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
${thenKeyword ? "// biome-ignore-all lint/suspicious/noThenProperty: generated record shapes hold JSON Schema if/then keywords as data\n" : ""}/**
 * Generated by ${GENERATOR} from ${CATALOG_ROOT}/.
 * Do not hand-edit; change the catalog and run \`${REPAIR}\`.
 */

import type { FailureClass } from "../operator/failure-class.js";

${tsUnion("OutputRuleKind", RULE_KINDS)}
export type OutputRuleRetry = "model-correctable" | "terminal";
${tsUnion("OutputOperatorKind", OPERATOR_KINDS)}
${tsUnion("OutputReplayMode", REPLAY_MODES)}
${tsUnion("RetryRuleDecision", RETRY_RULE_DECISIONS)}

/** One retry rule: what a step decided about a failed attempt, and why. */
export interface RetryRuleDeclaration {
  readonly decision: RetryRuleDecision;
  /** The config/limits.yaml count the rule spends or reports; \`null\` when none. */
  readonly budget: string | null;
  /** The operator clause for the decision token. */
  readonly summary: string;
  readonly reason: string;
  /** Host feedback the retry prompt carries; only a \`retried\` rule has one. */
  readonly statement: string | null;
  /** The retry withdraws the tools at the first withheld re-read and asks for the answer. */
  readonly concludeNow: boolean;
  readonly next: string;
}

/** The catalog record of one recorded code. */
export interface OutputRuleDeclaration {
  readonly code: string;
  readonly family: string;
  /** For a member of a pattern family, the family's prefix. */
  readonly pattern: string | null;
  readonly locations: readonly string[];
  readonly kind: OutputRuleKind;
  readonly retry: OutputRuleRetry;
  readonly reason: string;
  readonly failureClass: FailureClass;
  readonly failureClassReason: string | null;
  /** The model-facing rule sentence; \`null\` for a host rule and the catch-all. */
  readonly statement: string | null;
  /** Replaces \`statement\` for one location. */
  readonly atLocation: Readonly<Record<string, string>>;
  readonly hostDetail: string | null;
  /** The outer code this code is recorded under as an inner reason. */
  readonly outer: string | null;
  readonly catchAll: boolean;
  /** Earlier recorded spellings, for read-side decoding only. */
  readonly aliases: readonly string[];
  readonly operator: {
    readonly kind: OutputOperatorKind;
    readonly meaning: string;
    readonly next: string;
  };
  readonly fixtures: readonly string[];
  readonly docs: string;
}

export interface OutputRuleFamilyDeclaration {
  readonly replay: OutputReplayMode | null;
  readonly recordedPrefix: string | null;
  /** The family's own codes, then the codes it uses from other families. */
  readonly codes: readonly string[];
}

export interface OutputGrammarDeclaration {
  readonly form: "token" | "composite";
  readonly statement: string;
  readonly pattern: string;
  readonly maxLength: string | null;
  readonly illustrative: readonly string[];
  readonly flowsInto: readonly string[];
}

export type OutputContractRenderEntry =
  | { readonly rule: string; readonly text: string }
  | { readonly host: string; readonly label: string }
  | { readonly note: string };

export interface OutputContractDeclaration {
  readonly version: number;
  readonly owner: "runtime" | "knowledge" | "quality";
  readonly decoders: readonly string[];
  readonly title: string;
  readonly render: readonly OutputContractRenderEntry[];
}

/** A records-mode contract's host input names (design §1.3, G3). */
${tsUnion("AnswerRecordHostInput", Object.keys(ANSWER_RECORD_HOST_INPUTS))}

/** One generated record shape at one canonical location (design §1.1). */
export interface AnswerRecordShapeDeclaration {
  /** The canonical location the record fills; \`null\` for a record that fills none. */
  readonly at: string | null;
  /** The record's JSON Schema there: the canonical member minus host-owned members, plus \`add\`. */
  readonly shape: Readonly<Record<string, unknown>>;
  /** Members the host owns for some keys only, by selector or key. */
  readonly conditional: readonly {
    readonly member: string;
    readonly owner: string;
    readonly when: { readonly selector: string } | { readonly key: string };
  }[];
}

/** One record type a records-mode contract declares. */
export interface AnswerRecordTypeDeclaration {
  readonly type: string;
  readonly from: string | null;
  /** \`singleton\`, \`host-serial\`, or \`skeleton:<name>+<name>\`. */
  readonly key: string;
  /** Routing member on an open record; it must resolve to a host-planned slot. */
  readonly slotFrom: string | null;
  /** The skeletons a \`skeleton:\` key names, paired in order with \`shapes\`. */
  readonly skeletons: readonly string[];
  readonly open: boolean;
  /** \`<type>.<flag>\` that closes an open set. */
  readonly closedBy: string | null;
  readonly optional: boolean;
  readonly default: "empty" | null;
  readonly nullable: boolean;
  /** Field enums or subsets, by record-relative member, from named host sources. */
  readonly narrow: Readonly<Record<string, string>>;
  /** Fields that exist only in the record. */
  readonly add: readonly string[];
  readonly shapes: readonly AnswerRecordShapeDeclaration[];
}

/** A contract whose answer is submitted as judgment records and assembled by the host. */
export interface AnswerRecordContractDeclaration {
  readonly version: number;
  readonly owner: "runtime" | "knowledge" | "quality";
  readonly bindings: readonly { readonly workflow: string; readonly step: string }[];
  readonly outputMode: "text-final" | "submit-tool" | "records";
  readonly decoders: readonly string[];
  readonly canonical: {
    readonly members: Readonly<Record<string, string>>;
    readonly profile: string | null;
  };
  readonly skeleton: Readonly<Record<string, string>>;
  readonly records: readonly AnswerRecordTypeDeclaration[];
  readonly hostMinted: readonly { readonly field: string; readonly source: string }[];
  readonly derive: readonly {
    readonly field: string;
    readonly rule: string;
    readonly reads: readonly string[];
  }[];
  readonly references: readonly {
    readonly field: string | null;
    readonly part: string | null;
    readonly namespace: string;
    readonly source: string;
    readonly ids: string | null;
    readonly unresolved: string;
  }[];
  readonly compose: readonly {
    readonly field: string;
    readonly parts: readonly ({ readonly host: string } | { readonly model: string })[];
  }[];
  readonly limits: Readonly<
    Partial<Record<"openRecords" | "refusalsPerKey" | "recordBytes" | "messageBytes", string>>
  >;
}

type RuleTable = Readonly<Record<string, OutputRuleDeclaration>>;
type FamilyTable = Readonly<Record<string, OutputRuleFamilyDeclaration>>;
type GrammarTable = Readonly<Record<string, OutputGrammarDeclaration>>;
type ReplayModeTable = Readonly<Record<OutputReplayMode, { readonly statement: string | null }>>;
type ContractTable = Readonly<Record<string, OutputContractDeclaration>>;
type RecordContractTable = Readonly<Record<string, AnswerRecordContractDeclaration>>;
type TextTable = Readonly<Record<string, string>>;
type RetryRuleTable = Readonly<Record<string, RetryRuleDeclaration>>;

${tsConstObject("OUTPUT_RULES", catalog.rules.map(renderRuleTs), "RuleTable")}

${tsConstObject("OUTPUT_RULE_FAMILIES", catalog.families.map(renderFamilyTs), "FamilyTable")}

/** Earlier recorded spellings and the code each now decodes as. */
${tsConstObject("OUTPUT_RULE_ALIASES", aliases, "TextTable")}

/** Host-authored sentences that are not rules, such as fallback guidance. */
${tsConstObject("OUTPUT_HOST_TEXT", hostTextEntries(catalog), "TextTable")}

${tsConstObject("OUTPUT_GRAMMARS", catalog.grammars.map(renderGrammarTs), "GrammarTable")}

${tsConstObject(
  "OUTPUT_REPLAY_MODES",
  catalog.replayModes.map(
    (mode) =>
      `  ${tsKey(mode.id)}: {\n${tsProperty(4, "statement", tsNullable(mode.statement))}\n  },`,
  ),
  "ReplayModeTable",
)}

${tsConstObject("OUTPUT_CONTRACTS", responseContracts.map(renderContractTs), "ContractTable")}

/**
 * Records-mode contracts: record shapes, host-owned members, and limits
 * (design §1). Rendered as JSON: the record shapes are JSON Schema data, whose
 * numbers (\`minItems\`, \`maximum\`) are schema keywords, not operational
 * bounds, so the table keeps JSON's quoted keys and is not reformatted.
 */
// biome-ignore format: generated JSON Schema data keeps its JSON layout and quoted keys
export const OUTPUT_RECORD_CONTRACTS = ${recordTable} as const satisfies RecordContractTable;

/** Every retry rule; \`projectRetryRules\` (records/inference-retry-rule.ts) decides among them. */
${tsConstObject("RETRY_RULES", catalog.retryRules.map(renderRetryRuleTs), "RetryRuleTable")}

/** Every retry-rule id ever recorded; append-only. */
export const RECORDED_RETRY_RULES = [
${catalog.recordedRetryRules.map((id) => `  ${tsString(id)},`).join("\n")}
] as const;

export type RetryRuleId = keyof typeof RETRY_RULES;

/** Every recorded code the catalog declares; pattern families are expanded. */
export type OutputRuleCode = keyof typeof OUTPUT_RULES;
export type OutputRuleFamily = keyof typeof OUTPUT_RULE_FAMILIES;
/** A family's own codes and the codes it uses. */
export type RuleCodeOf<F extends OutputRuleFamily> =
  (typeof OUTPUT_RULE_FAMILIES)[F]["codes"][number];
type CodesWithRetry<R extends OutputRuleRetry> = {
  [C in OutputRuleCode]: (typeof OUTPUT_RULES)[C]["retry"] extends R ? C : never;
}[OutputRuleCode];
/** Codes the model may correct. */
export type CorrectableOutputRuleCode = CodesWithRetry<"model-correctable">;
/** Codes that always stop: the generator refuses a correctable declaration of a terminal kind. */
export type TerminalOutputRuleCode = CodesWithRetry<"terminal">;
export type CorrectableCodeOf<F extends OutputRuleFamily> = Extract<
  RuleCodeOf<F>,
  CorrectableOutputRuleCode
>;
export type TerminalCodeOf<F extends OutputRuleFamily> = Extract<
  RuleCodeOf<F>,
  TerminalOutputRuleCode
>;
export type LocationOf<C extends OutputRuleCode> = (typeof OUTPUT_RULES)[C]["locations"][number];
export type HostDetailOf<C extends OutputRuleCode> = Exclude<
  (typeof OUTPUT_RULES)[C]["hostDetail"],
  null
>;
export type OutputContractId = keyof typeof OUTPUT_CONTRACTS;
export type RecordContractId = keyof typeof OUTPUT_RECORD_CONTRACTS;
/** The derivation rules a records-mode contract names, in \`derive\` and as compose host parts. */
export type DerivationRuleOf<C extends RecordContractId> =
  | (typeof OUTPUT_RECORD_CONTRACTS)[C]["derive"][number]["rule"]
  | Exclude<
      Extract<
        (typeof OUTPUT_RECORD_CONTRACTS)[C]["compose"][number]["parts"][number],
        { readonly host: string }
      >["host"],
      \`reference:\${string}\`
    >;
/** The host-minted sources a records-mode contract names. */
export type HostMintedSourceOf<C extends RecordContractId> =
  (typeof OUTPUT_RECORD_CONTRACTS)[C]["hostMinted"][number]["source"];
/** The host blocks a contract's binder must supply. */
export type HostBlockOf<K extends OutputContractId> = Extract<
  (typeof OUTPUT_CONTRACTS)[K]["render"][number],
  { readonly host: string }
>["host"];

/** The structured rejection a validator records for one catalog rule. */
export interface OutputRuleRejection<C extends OutputRuleCode = OutputRuleCode> {
  readonly code: C;
  readonly location: LocationOf<C>;
}

/**
 * Name a catalog rule a validator refused: an undeclared code, or a location
 * not declared for that code, does not compile. Retryability comes from the
 * table, never from the call site.
 */
export function rejectOutput<C extends OutputRuleCode>(
  code: C,
  location: LocationOf<C>,
): OutputRuleRejection<C> {
  return Object.freeze({ code, location });
}

/** Refuse through a model-correctable code of \`family\` only. */
export function rejectCorrectable<F extends OutputRuleFamily, C extends CorrectableCodeOf<F>>(
  _family: F,
  code: C,
  location: LocationOf<C>,
): OutputRuleRejection<C> {
  return rejectOutput(code, location);
}

/**
 * Refuse through a terminal code of \`family\` only. A security or authority
 * predicate raises here, so it cannot raise a correctable code or fall back to
 * the correctable catch-all.
 */
export function rejectTerminal<F extends OutputRuleFamily, C extends TerminalCodeOf<F>>(
  _family: F,
  code: C,
  location: LocationOf<C>,
): OutputRuleRejection<C> {
  return rejectOutput(code, location);
}

/**
 * The declaration a persisted or thrown code resolves to, through its declared
 * aliases, or \`undefined\` for a code outside the catalog, which stays visible
 * as unknown (#1186).
 */
export function outputRuleFor(code: unknown): OutputRuleDeclaration | undefined {
  if (typeof code !== "string") return undefined;
  const rules = OUTPUT_RULES as RuleTable;
  const aliases = OUTPUT_RULE_ALIASES as TextTable;
  if (Object.hasOwn(rules, code)) return rules[code];
  return Object.hasOwn(aliases, code) ? rules[aliases[code]!] : undefined;
}

/** Whether \`code\` is a code the catalog declares. */
export function isOutputRuleCode(code: unknown): code is OutputRuleCode {
  return typeof code === "string" && Object.hasOwn(OUTPUT_RULES, code);
}
`;
}

export function renderKnowledgeModule(catalog) {
  const rules = Object.fromEntries(
    catalog.rules.map((rule) => [
      rule.code,
      {
        code: rule.code,
        family: rule.family,
        pattern: rule.pattern,
        locations: rule.locations,
        kind: rule.kind,
        retry: rule.retry,
        reason: rule.reason,
        failureClass: rule.failureClass,
        statement: rule.statement,
        atLocation: rule.atLocation,
        hostDetail: rule.hostDetail,
        outer: rule.outer,
        catchAll: rule.catchAll,
        aliases: rule.aliases,
        operator: rule.operator,
      },
    ]),
  );
  const families = Object.fromEntries(
    catalog.families.map((family) => [
      family.name,
      { replay: family.replay, recordedPrefix: family.recordedPrefix, codes: family.codes },
    ]),
  );
  const grammars = Object.fromEntries(
    catalog.grammars.map((grammar) => [
      grammar.id,
      {
        form: grammar.form,
        statement: grammar.statement,
        pattern: grammar.pattern,
        maxLength: grammar.maxLength ?? null,
        illustrative: grammar.examples.illustrative,
        flowsInto: grammar.flowsInto,
      },
    ]),
  );
  const replayModes = Object.fromEntries(
    catalog.replayModes.map((mode) => [mode.id, { statement: mode.statement }]),
  );
  const hostText = Object.fromEntries(
    catalog.families.flatMap((family) => family.hostText.map((entry) => [entry.id, entry.text])),
  );
  const recordContractTable = Object.fromEntries(
    recordContracts(catalog).map((contract) => [contract.id, recordContractEntry(contract)]),
  );
  const json = (value) => JSON.stringify(value, null, 2);
  return `/**
 * Generated by ${GENERATOR} from ${CATALOG_ROOT}/.
 * Do not hand-edit; change the catalog and run \`${REPAIR}\` from packages/runtime.
 *
 * Plain JavaScript for the knowledge package, which must not import runtime
 * sources. The first knowledge consumer is the first-pass family (#1289).
 */

function deepFreeze(value) {
  if (value && typeof value === "object") {
    for (const nested of Object.values(value)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}

/** Every rule on model output, keyed by its recorded code. */
export const OUTPUT_RULES = deepFreeze(${json(rules)});

/** Each family's replay mode, recorded prefix, and codes (own, then used). */
export const OUTPUT_RULE_FAMILIES = deepFreeze(${json(families)});

/** Host-authored sentences that are not rules. */
export const OUTPUT_HOST_TEXT = deepFreeze(${json(hostText)});

/** Shared grammars for values a model authors or cites. */
export const OUTPUT_GRAMMARS = deepFreeze(${json(grammars)});

/** Replay modes and the statement each adds to a retry hint. */
export const OUTPUT_REPLAY_MODES = deepFreeze(${json(replayModes)});

/** Records-mode contracts: record shapes, host-owned members, and limits. */
export const OUTPUT_RECORD_CONTRACTS = deepFreeze(${json(recordContractTable)});
`;
}

function markdownCell(value) {
  return value.replaceAll("|", "\\|");
}

export function renderReference(catalog) {
  const lines = [
    "# Model Output Rules",
    "",
    `<!-- Generated by ${GENERATOR} from ${CATALOG_ROOT}/. Do not hand-edit; run \`${REPAIR}\` from packages/runtime. -->`,
    "",
    "Every rule the host enforces on model output, by family. The catalog is",
    `\`${CATALOG_ROOT}/\`; its format is described in \`${CATALOG_ROOT}/README.md\`.`,
    "A `model-correctable` rule re-asks the model within the step's retry budget",
    "(`retry.maxRetries`) with its statement as the hint. A `terminal` rule stops",
    "the step.",
    "",
  ];
  const byCode = new Map(catalog.rules.map((rule) => [rule.code, rule]));
  for (const family of catalog.families) {
    // One entry per exact code, and one per pattern family.
    const entries = [];
    const seen = new Set();
    for (const code of family.own) {
      const rule = byCode.get(code);
      const key = rule.pattern ?? rule.code;
      if (seen.has(key)) continue;
      seen.add(key);
      entries.push({
        rule,
        label: rule.pattern ? `${rule.pattern}*` : rule.code,
        members: rule.pattern
          ? family.own.filter((member) => byCode.get(member).pattern === rule.pattern)
          : [],
      });
    }
    lines.push(`## ${family.name}`, "");
    lines.push(`- Replay mode: ${family.replay ? `\`${family.replay}\`` : "none declared"}`);
    if (family.recordedPrefix) lines.push(`- Recorded prefix: \`${family.recordedPrefix}\``);
    if (family.uses.length > 0) {
      lines.push(`- Uses: ${family.uses.map((code) => `\`${code}\``).join(", ")}`);
    }
    lines.push("");
    lines.push(
      "| Code | Kind | Retry | Failure class | Operator |",
      "| --- | --- | --- | --- | --- |",
    );
    for (const { rule, label } of entries) {
      lines.push(
        `| [\`${label}\`](#${rule.docs}) | ${rule.kind} | ${rule.retry} | ${rule.failureClass} | ${rule.operator.kind} |`,
      );
    }
    lines.push("");
    for (const { rule, members } of entries) {
      lines.push(`### ${rule.docs}`, "");
      if (members.length > 0) {
        lines.push(`- Members: ${members.map((member) => `\`${member}\``).join(", ")}`);
      }
      lines.push(`- Locations: ${rule.locations.map((location) => `\`${location}\``).join(", ")}`);
      lines.push(`- Retry: ${rule.retry}. ${markdownCell(rule.reason)}`);
      if (rule.failureClassReason) {
        lines.push(`- Failure class: ${markdownCell(rule.failureClassReason)}`);
      }
      lines.push(
        `- Rule stated to the model: ${rule.statement ? markdownCell(rule.statement) : "none (never stated)"}`,
      );
      for (const [location, value] of Object.entries(rule.atLocation)) {
        lines.push(`- At \`${location}\`: ${markdownCell(value)}`);
      }
      if (rule.hostDetail) lines.push(`- Host detail: \`${rule.hostDetail}\``);
      if (rule.outer) lines.push(`- Recorded under: \`${rule.outer}\``);
      if (rule.aliases.length > 0) {
        lines.push(
          `- Earlier spellings: ${rule.aliases.map((alias) => `\`${alias}\``).join(", ")}`,
        );
      }
      lines.push(`- Meaning: ${markdownCell(rule.operator.meaning)}`);
      lines.push(`- Next: ${markdownCell(rule.operator.next)}`);
      lines.push("");
    }
  }
  if (catalog.retryRules.length > 0) {
    lines.push(
      "## Retry rules",
      "",
      "A step records one of these rules on every attempt as `retryRule`. The rows are not in decision order; `projectRetryRules` in `src/records/inference-retry-rule.ts` documents that order. `docsfab runs show` prints the rule as the attempt's retry decision. Condition budgets nest inside `retry.maxRetries`, so a step's worst case stays (1 + `retry.maxRetries`) contract attempts, each at most one attempt timer and one per-attempt output allowance, plus the transport retries `retry.maxTransportRetries` allows.",
      "",
      "| Rule | Decision | Budget | Meaning |",
      "| --- | --- | --- | --- |",
    );
    for (const rule of catalog.retryRules) {
      lines.push(
        `| \`${rule.id}\` | ${rule.decision} | ${rule.budget ? `\`${rule.budget}\`` : "-"} | ${markdownCell(rule.reason)} |`,
      );
    }
    lines.push("");
    for (const rule of catalog.retryRules.filter((entry) => entry.statement)) {
      lines.push(`- \`${rule.id}\` retry feedback: ${markdownCell(rule.statement)}`);
    }
    lines.push("");
  }
  const replay = catalog.replayModes.filter((mode) => mode.statement);
  if (replay.length > 0) {
    lines.push("## Replay-mode statements", "");
    for (const mode of replay) lines.push(`- \`${mode.id}\`: ${markdownCell(mode.statement)}`);
    lines.push("");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

/** Every generated output, keyed by repository path. */
export function renderMirrors(catalog, root = DEFAULT_REPO_ROOT) {
  const readSchema = (name) => JSON.parse(readText(root, `${SCHEMA_ROOT}/${name}`));
  return {
    [RUNTIME_GENERATED]: renderRuntimeTypeScript(catalog),
    [KNOWLEDGE_GENERATED]: renderKnowledgeModule(catalog),
    [VOCABULARY_GENERATED]: renderResponseContractVocabularyMirror(readSchema),
    [REFERENCE_GENERATED]: renderReference(catalog),
  };
}

// ---------------------------------------------------------------------------
// Gate: conformance scans and the allowlist

const SCAN_ROOTS = Object.freeze([
  { root: "packages/runtime/src", extensions: [".ts", ".js", ".mjs"] },
  { root: "packages/knowledge/src", extensions: [".mjs", ".js"] },
]);
/**
 * Hand-written per-code tables of the kind the catalog replaces: retry tables,
 * hint and correction catalogs, and failure-class rows, as an object literal
 * or a `Map`. A new one fails the gate; each existing one is an allowlist
 * entry until its family migrates. The name is a heuristic; the row checks
 * below catch a catalog code keyed into a table of any name.
 */
const LEGACY_TABLE =
  /\b(?:const|let|var)\s+([A-Z][A-Z0-9_]*(?:_RETRYABILITY|_RETRY|_RETRY_TABLE|_RULE_HINTS|_RULES|_HINTS|_CORRECTIONS|_REJECTION_CLASSES|_FAILURE_CLASSES))\b[^=;]*=\s*(?:Object\.freeze\(\s*)?(?:\{|new\s+Map\b)/gu;

function walkFiles(root, relativeRoot, extensions, files = []) {
  const absolute = join(root, relativeRoot);
  if (!existsSync(absolute)) return files;
  for (const entry of readdirSync(absolute, { withFileTypes: true })) {
    const path = `${relativeRoot}/${entry.name}`;
    if (entry.isDirectory()) {
      if (entry.name === "node_modules") continue;
      walkFiles(root, path, extensions, files);
    } else if (extensions.some((extension) => entry.name.endsWith(extension))) {
      files.push(path);
    }
  }
  return files.sort();
}

function isGeneratedSource(path) {
  return /\.generated\.[a-z]+$/u.test(path);
}

/** A quoted `key:` or a `Map` entry `["key",` for `code`. */
function rowPattern(code) {
  const literal = escapeLiteral(code);
  return new RegExp(`(["'\`])${literal}\\1\\s*:|\\[\\s*(["'\`])${literal}\\2\\s*,`, "u");
}

/** Conformance findings over product sources, skills, and manifests. */
export function scanConformance(catalog, root = DEFAULT_REPO_ROOT) {
  const findings = [];
  const recordedCodes = catalog.rules.map((rule) => rule.code);
  // A prefixed family's diagnostic codes, the form the retired tables keyed.
  const diagnosticCodes = catalog.families.flatMap((family) =>
    family.recordedPrefix
      ? family.own.map((code) => ({ code, diagnostic: code.slice(family.recordedPrefix.length) }))
      : [],
  );
  const grammarLiterals = catalog.grammars.map((grammar) => ({
    id: grammar.id,
    literal: grammar.pattern,
  }));
  for (const { root: scanRoot, extensions } of SCAN_ROOTS) {
    for (const path of walkFiles(root, scanRoot, extensions)) {
      if (isGeneratedSource(path)) continue;
      const source = readText(root, path);
      for (const code of recordedCodes) {
        if (rowPattern(code).test(source)) {
          findings.push({ check: "hand-written-row", path, subject: code, lexeme: code });
        }
      }
      for (const { code, diagnostic } of diagnosticCodes) {
        if (rowPattern(diagnostic).test(source)) {
          findings.push({ check: "hand-written-row", path, subject: code, lexeme: diagnostic });
        }
      }
      for (const match of source.matchAll(LEGACY_TABLE)) {
        findings.push({ check: "legacy-table", path, subject: match[1], lexeme: match[1] });
      }
      for (const { id, literal } of grammarLiterals) {
        if (source.includes(literal) || source.includes(literal.slice(1, -1))) {
          findings.push({ check: "grammar-literal", path, subject: id, lexeme: literal });
        }
      }
    }
  }
  for (const contract of catalog.contracts) {
    if (contract.kind !== "docsfab-response-contract") continue;
    const { keys, enums } = shapeVocabulary(contract.shape);
    const hostKeys = keys.filter((key) => /[A-Z]/u.test(key));
    const texts = [];
    for (const binding of contract.bindings) {
      const manifestPath = `${WORKFLOW_ROOT}/${binding.workflow}.json`;
      const step = findManifestStep(JSON.parse(readText(root, manifestPath)), binding.step);
      if (typeof step?.prompt === "string") texts.push({ path: manifestPath, text: step.prompt });
      if (typeof step?.skill === "string") {
        for (const path of walkFiles(root, `${SKILL_ROOT}/${step.skill}`, [".md"])) {
          texts.push({ path, text: readText(root, path) });
        }
      }
    }
    for (const { path, text: body } of texts) {
      const lexemes = new Set();
      for (const key of hostKeys) {
        if (new RegExp(`\\b${escapeLiteral(key)}\\b`, "u").test(body)) lexemes.add(key);
      }
      for (const value of enums) {
        if (body.includes(`"${value}"`)) lexemes.add(`"${value}"`);
      }
      for (const grammar of catalog.grammars) {
        for (const example of grammar.examples.illustrative) {
          if (body.includes(example)) lexemes.add(example);
        }
      }
      if (/```json/u.test(body) && hostKeys.some((key) => body.includes(`"${key}"`))) {
        lexemes.add("```json");
      }
      for (const lexeme of [...lexemes].sort()) {
        findings.push({ check: "skill-shape", path, subject: contract.id, lexeme });
      }
    }
  }
  return findings;
}

function findingKey(finding) {
  return [finding.check, finding.path, finding.subject, finding.lexeme].join("\t");
}

export function loadAllowlist(root = DEFAULT_REPO_ROOT) {
  const path = join(root, ALLOWLIST_PATH);
  if (!existsSync(path)) fail(ALLOWLIST_PATH, "is missing");
  const parsed = JSON.parse(readFileSync(path, "utf8"));
  exactKeys(ALLOWLIST_PATH, parsed, ["schemaVersion", "kind", "entries"]);
  if (parsed.schemaVersion !== 1 || parsed.kind !== "docsfab-model-output-allowlist") {
    fail(ALLOWLIST_PATH, "must declare schemaVersion 1 and kind docsfab-model-output-allowlist");
  }
  const entries = list(ALLOWLIST_PATH, parsed.entries, "entries", { nonEmpty: false });
  for (const entry of entries) {
    exactKeys(`${ALLOWLIST_PATH} entry`, entry, [
      "check",
      "path",
      "subject",
      "lexeme",
      "rationale",
    ]);
    text(ALLOWLIST_PATH, entry.rationale, `rationale for ${findingKey(entry)}`);
  }
  distinct(ALLOWLIST_PATH, entries.map(findingKey), "entries");
  return entries;
}

/** Findings the allowlist does not cover, and allowlist entries nothing matches. */
export function compareAllowlist(findings, entries) {
  const found = new Set(findings.map(findingKey));
  const allowed = new Set(entries.map(findingKey));
  const unexpected = [];
  const seen = new Set();
  for (const finding of findings) {
    const key = findingKey(finding);
    if (!allowed.has(key) && !seen.has(key)) unexpected.push(finding);
    seen.add(key);
  }
  return { unexpected, stale: entries.filter((entry) => !found.has(findingKey(entry))) };
}

// ---------------------------------------------------------------------------
// CLI

export function parseArgs(argv) {
  const options = { checkOnly: false, gate: false, printMirrorPaths: false, committedOnly: false };
  for (const argument of argv) {
    if (argument === "--check") options.checkOnly = true;
    else if (argument === "--gate") options.gate = true;
    else if (argument === "--print-mirror-paths") options.printMirrorPaths = true;
    else if (argument === "--committed-only") options.committedOnly = true;
    else throw new Error(`Unknown argument: ${argument}`);
  }
  if (options.committedOnly && !options.checkOnly) {
    throw new Error("--committed-only narrows --check and does not apply to generation");
  }
  return options;
}

/**
 * The validated catalog `runModelOutputTool` works from. A caller that lists
 * the mirrors and then checks them passes one result to both calls, so the
 * catalog is read once. Takes the `root` and `parseYaml` options.
 */
export function prepareModelOutputTool(options = {}) {
  const root = options.root ?? DEFAULT_REPO_ROOT;
  const { catalog, findings } = validateCatalog(readCatalogSources(root, options));
  return { root, catalog, findings };
}

/**
 * Prepare only the untracked code mirrors needed by tools that import runtime
 * source. Committed outputs remain untouched so their drift is still visible
 * to the checks that follow. Returns the paths written.
 */
export function writeBuildGeneratedMirrors(prepared = prepareModelOutputTool()) {
  const { root, catalog } = prepared;
  const mirrors = renderMirrors(catalog, root);
  const written = [];
  for (const path of BUILD_GENERATED_MIRRORS) {
    const absolute = join(root, path);
    if (existsSync(absolute) && readText(root, path) === mirrors[path]) continue;
    // A concurrent importer sees complete old or new bytes after the rename.
    const staging = `${absolute}.${process.pid}.staging`;
    try {
      mkdirSync(dirname(absolute), { recursive: true });
      writeFileSync(staging, mirrors[path]);
      renameSync(staging, absolute);
    } finally {
      rmSync(staging, { force: true });
    }
    written.push(path);
  }
  return written;
}

export function runModelOutputTool(options = {}, prepared = prepareModelOutputTool(options)) {
  const { root, catalog, findings } = prepared;
  const mirrors = renderMirrors(catalog, root);
  if (options.printMirrorPaths) return { status: "mirror-paths", paths: Object.keys(mirrors) };
  if (!options.checkOnly) {
    for (const [path, contents] of Object.entries(mirrors)) {
      const absolute = join(root, path);
      mkdirSync(dirname(absolute), { recursive: true });
      writeFileSync(absolute, contents);
    }
    return { status: "generated", paths: Object.keys(mirrors) };
  }
  const checked = Object.entries(mirrors).filter(
    ([path]) => !options.committedOnly || !BUILD_GENERATED_MIRRORS.includes(path),
  );
  const failures = [];
  for (const [path, contents] of checked) {
    if (!existsSync(join(root, path)) || readText(root, path) !== contents) {
      failures.push(`${path} drifted from ${CATALOG_ROOT}/; run ${REPAIR}`);
    }
  }
  if (options.gate) {
    const all = [...findings, ...scanConformance(catalog, root)];
    const { unexpected, stale } = compareAllowlist(all, loadAllowlist(root));
    for (const finding of unexpected) {
      failures.push(
        `${finding.check}: ${finding.path} ${finding.subject} ${JSON.stringify(finding.lexeme)} is not allowlisted in ${ALLOWLIST_PATH}`,
      );
    }
    for (const entry of stale) {
      failures.push(
        `${ALLOWLIST_PATH} has a stale ${entry.check} entry for ${entry.path} ${entry.subject} ${JSON.stringify(entry.lexeme)}; remove it`,
      );
    }
  }
  if (failures.length > 0) {
    const error = new Error(failures.join("\n"));
    error.failures = failures;
    throw error;
  }
  return {
    status: "checked",
    rules: catalog.rules.length,
    contracts: catalog.contracts.length,
    gate: options.gate === true,
    unchecked: options.committedOnly ? [...BUILD_GENERATED_MIRRORS] : [],
  };
}

function isMain() {
  const real = (value) => {
    try {
      return realpathSync(value);
    } catch {
      return value;
    }
  };
  const invoked = process.argv[1] ? real(resolve(process.argv[1])) : "";
  return invoked === real(fileURLToPath(import.meta.url));
}

if (isMain()) {
  try {
    const result = runModelOutputTool(parseArgs(process.argv.slice(2)));
    if (result.status === "mirror-paths") {
      process.stdout.write(`${result.paths.join("\n")}\n`);
    } else if (result.status === "generated") {
      console.log(`Updated model-output mirrors: ${result.paths.join(", ")}`);
    } else {
      console.log(
        `Model-output catalog is current (${result.rules} rules, ${result.contracts} contracts${result.gate ? ", coverage and conformance gate passed" : ""})`,
      );
      for (const path of result.unchecked) {
        console.log(
          `${path}: not checked here, the build generates it (scripts/ensure-derived.mjs)`,
        );
      }
    }
  } catch (error) {
    console.error(`check:model-output failed: ${error.message}`);
    process.exitCode = 1;
  }
}
