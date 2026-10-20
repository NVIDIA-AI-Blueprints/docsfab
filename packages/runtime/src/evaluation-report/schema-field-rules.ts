// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Field rules a locked JSON Schema states, rendered as model-facing sentences.
 *
 * The final quality evaluator receives the whole evaluation schema, yet hosted
 * models still break its enum and pattern rules deep inside the evaluation.
 * These helpers restate those rules by field name, read from the same schema
 * object, so the contract and the retry never carry a hand-copied value list.
 */

import { OUTPUT_RECORD_CONTRACTS } from "../contracts/model-output.generated.js";

type SchemaNode = Readonly<Record<string, unknown>>;

// These derive outputs are also inputs to the quality host's derivation. Keep
// them model-authored: applicability is explicitly required by the evaluator
// contract, gate arrays feed textPathGates, and layer decision is only a
// conditional residual for an open layer.
const QUALITY_EVALUATION_DERIVATION_INPUT_PATHS = new Set([
  "$.evaluation.layers.*.dimensions[].applicability",
  "$.evaluation.constraints.{required}.applicability",
  "$.evaluation.layers.*.hard_gate_failures",
  "$.evaluation.hard_gate_failures",
  "$.evaluation.layers.*.decision",
]);
const QUALITY_EVALUATION_CONDITIONALLY_AUTHORED_PATHS = ["evaluation.layers.*.decision"] as const;

export function qualityEvaluationRequiredKeyProjection(hostWrittenFields: readonly string[]): {
  hostWritten: string[];
  hostDerived: string[];
  conditionallyAuthored: string[];
} {
  return {
    // This evaluator has no bound audience-evaluation artifact; the host
    // writes empty outcomes lists after response submission.
    hostWritten: [
      ...hostWrittenFields.map((field) => `evaluation.${field}`),
      "evaluation.outcomes",
    ],
    hostDerived: OUTPUT_RECORD_CONTRACTS["quality-evaluation"].derive
      .map((entry) => entry.field)
      .filter(
        (field) =>
          field.startsWith("$.evaluation.") &&
          !QUALITY_EVALUATION_DERIVATION_INPUT_PATHS.has(field) &&
          !QUALITY_EVALUATION_CONDITIONALLY_AUTHORED_PATHS.some(
            (conditional) => `$.${conditional}` === field,
          ),
      )
      .map((field) => field.slice(2)),
    conditionallyAuthored: [...QUALITY_EVALUATION_CONDITIONALLY_AUTHORED_PATHS],
  };
}

function isNode(value: unknown): value is SchemaNode {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** The node a local `#/...` reference names, or `undefined`. */
function resolveLocal(root: SchemaNode, reference: string): SchemaNode | undefined {
  if (!reference.startsWith("#/")) return undefined;
  let current: unknown = root;
  for (const token of reference.slice(2).split("/")) {
    if (!isNode(current)) return undefined;
    current = current[token.replaceAll("~1", "/").replaceAll("~0", "~")];
  }
  return isNode(current) ? current : undefined;
}

function dereference(root: SchemaNode, node: SchemaNode): SchemaNode {
  let current = node;
  for (const seen = new Set<string>(); typeof current.$ref === "string"; ) {
    if (seen.has(current.$ref)) break;
    seen.add(current.$ref);
    const target = resolveLocal(root, current.$ref);
    if (!target) break;
    current = target;
  }
  return current;
}

/** Terms for the character-class members a simple identifier pattern uses. */
const CLASS_MEMBERS: ReadonlyArray<readonly [string, string, string]> = [
  ["a-z", "lowercase letter", "lowercase letters"],
  ["A-Z", "uppercase letter", "uppercase letters"],
  ["0-9", "digit", "digits"],
  ["_", "underscore", "underscores"],
  ["-", "hyphen", "hyphens"],
  [".", "dot", "dots"],
  [":", "colon", "colons"],
];

function classMembers(body: string): Array<readonly [string, string, string]> | undefined {
  const members: Array<readonly [string, string, string]> = [];
  let rest = body;
  while (rest.length > 0) {
    // Ranges first, so `a-z` is never read as `a`, `-`, `z`.
    const member =
      CLASS_MEMBERS.find(([token]) => token.length === 3 && rest.startsWith(token)) ??
      CLASS_MEMBERS.find(([token]) => token.length === 1 && rest.startsWith(token));
    if (!member) return undefined;
    // A hyphen between two members is a range, which this reader never guesses.
    if (member[0] === "-" && members.length > 0 && rest.length > 1) return undefined;
    members.push(member);
    rest = rest.slice(member[0].length);
  }
  return members.length > 0 ? members : undefined;
}

function list(words: readonly string[], conjunction: "and" | "or"): string {
  if (words.length <= 1) return words.join("");
  if (words.length === 2) return `${words[0]} ${conjunction} ${words[1]}`;
  return `${words.slice(0, -1).join(", ")}, ${conjunction} ${words.at(-1)}`;
}

/**
 * Plain words for an identifier pattern of the form `^[first][rest]*$`, such as
 * `^[a-z0-9][a-z0-9-]*$`; `undefined` for any other pattern, which is then
 * stated only as written.
 */
export function describeIdentifierPattern(pattern: string): string | undefined {
  const match = /^\^\[([^\]\\^]+)\]\[([^\]\\^]+)\]\*\$$/u.exec(pattern);
  if (!match) return undefined;
  const first = classMembers(match[1]!);
  const rest = classMembers(match[2]!);
  if (!first || !rest) return undefined;
  const allowed = new Set(rest.map(([token]) => token));
  // The two characters a snake_case or camelCase habit adds, when excluded.
  const excluded = CLASS_MEMBERS.filter(
    ([token]) => (token === "_" || token === "A-Z") && !allowed.has(token),
  ).map(([, , plural]) => plural);
  const opening = list(
    first.map(([, singular]) => singular),
    "or",
  );
  return `it starts with ${/^[aeiou]/u.test(opening) ? "an" : "a"} ${opening} and then uses only ${list(
    rest.map(([, , plural]) => plural),
    "and",
  )}, with no ${list([...excluded, "spaces"], "or")}`;
}

/** The sentence for one pattern rule, with its plain words when they exist. */
export function patternRuleSentence(pattern: string): string {
  const words = describeIdentifierPattern(pattern);
  return words ? `${pattern}: ${words}` : pattern;
}

type FieldRule =
  | {
      readonly kind: "enum";
      readonly values: readonly unknown[];
      readonly each: boolean;
    }
  | {
      readonly kind: "pattern";
      readonly pattern: string;
      readonly each: boolean;
    }
  | {
      readonly kind: "format";
      readonly format: string;
      readonly each: boolean;
    };

function fieldRules(node: SchemaNode, root: SchemaNode, each = false): FieldRule[] {
  const rules: FieldRule[] = [];
  if (Array.isArray(node.enum)) rules.push({ kind: "enum", values: node.enum, each });
  if (typeof node.pattern === "string") {
    rules.push({ kind: "pattern", pattern: node.pattern, each });
  }
  if (typeof node.format === "string") rules.push({ kind: "format", format: node.format, each });
  if (!each && isNode(node.items))
    rules.push(...fieldRules(dereference(root, node.items), root, true));
  return rules;
}

function ruleText(rule: FieldRule): string {
  switch (rule.kind) {
    case "enum":
      return `is exactly one of ${rule.values.map((value) => JSON.stringify(value)).join(", ")}`;
    case "pattern":
      return `matches ${patternRuleSentence(rule.pattern)}`;
    case "format":
      return rule.format === "date-time"
        ? "is an RFC 3339 date-time string"
        : `is a string in format ${rule.format}`;
  }
}

/** Where a field is declared: its shared definition, or its path from the root. */
function ownerOf(raw: SchemaNode, path: string): string {
  const reference = typeof raw.$ref === "string" ? /^#\/\$defs\/([^/]+)$/u.exec(raw.$ref) : null;
  return reference ? `$defs.${reference[1]}` : path;
}

/**
 * One line per field name the schema constrains by an enum, a pattern, or a
 * format, in the order the schema first reaches it. When a name carries a
 * different rule, or no rule, somewhere else, each ruled line names where it
 * applies (a shared definition or a path), so no line claims a field it does
 * not govern. Values come from the schema only.
 */
export function schemaFieldRuleLines(schema: unknown, prefix: string): string[] {
  if (!isNode(schema)) return [];
  const root = schema;
  // Every declaration of each name, keyed by where it is declared.
  const byName = new Map<string, Map<string, string | null>>();
  const visited = new Set<SchemaNode>();
  const visit = (raw: SchemaNode, path: string): void => {
    const node = dereference(root, raw);
    // A shared definition is read once; its fields are keyed by that definition.
    if (visited.has(node)) return;
    visited.add(node);
    const owner = ownerOf(raw, path);
    if (isNode(node.properties)) {
      for (const [name, child] of Object.entries(node.properties)) {
        if (!isNode(child)) continue;
        const field = dereference(root, child);
        const texts = fieldRules(field, root).map((rule) =>
          rule.each ? `entry ${ruleText(rule)}` : ruleText(rule),
        );
        const declarations = byName.get(name) ?? new Map<string, string | null>();
        const where = `${owner}.${name}`;
        if (!declarations.has(where)) declarations.set(where, texts.join("; ") || null);
        byName.set(name, declarations);
        visit(child, `${path}.${name}`);
      }
    }
    if (isNode(node.items)) visit(node.items, `${path}[]`);
    // A conditional branch's rule is not unconditional, so it is not stated.
    for (const branch of Array.isArray(node.allOf) ? node.allOf : []) {
      if (isNode(branch) && !isNode(branch.if)) visit(branch, path);
    }
  };
  visit(root, prefix);
  const lines: string[] = [];
  for (const [name, declarations] of byName) {
    const texts = new Set(declarations.values());
    const [text] = texts;
    if (texts.size === 1 && typeof text === "string") {
      lines.push(text.startsWith("entry ") ? `- Each ${name} ${text}.` : `- ${name} ${text}.`);
      continue;
    }
    for (const [where, text] of declarations) {
      if (text === null) continue;
      lines.push(text.startsWith("entry ") ? `- Each ${where} ${text}.` : `- ${where} ${text}.`);
    }
  }
  return lines;
}

/** The keys an object node requires, as the schema lists them. */
function requiredKeys(node: SchemaNode): string[] | undefined {
  if (!Array.isArray(node.required)) return undefined;
  const keys = node.required.filter((key): key is string => typeof key === "string");
  return keys.length > 0 ? keys : undefined;
}

/** Path segments; a `[]` stays on the segment it follows. */
function segments(path: string): string[] {
  return path.split(".");
}

/**
 * Merge paths that differ in exactly one segment into `{a,b}` at that
 * segment, repeatedly, so three layers' paths read as one. The merge keeps
 * every path the walk reached; it only spells them shorter.
 */
export function compressPaths(paths: readonly string[]): string[] {
  let current = [...paths];
  for (let changed = true; changed; ) {
    changed = false;
    const groups = new Map<string, { index: number; at: number; values: string[] }>();
    current.forEach((path, at) => {
      const parts = segments(path);
      parts.forEach((part, index) => {
        const key = `${index}|${parts.length}|${parts.map((p, i) => (i === index ? "*" : p)).join(".")}`;
        const group = groups.get(key) ?? { index, at, values: [] };
        if (!group.values.includes(part)) group.values.push(part);
        groups.set(key, group);
      });
    });
    const merge = [...groups.entries()].find(([, group]) => group.values.length > 1);
    if (!merge) break;
    const [key, group] = merge;
    const pattern = key.split("|")[2]!;
    const merged = pattern
      .split(".")
      .map((part, i) => (i === group.index ? `{${group.values.join(",")}}` : part))
      .join(".");
    const kept = current.filter((path) => {
      const parts = segments(path);
      return (
        parts.length !== pattern.split(".").length ||
        parts.map((p, i) => (i === group.index ? "*" : p)).join(".") !== pattern
      );
    });
    // The merged path takes the place of the first path it replaces.
    current = [...kept.slice(0, group.at), merged, ...kept.slice(group.at)];
    changed = true;
  }
  return current;
}

/**
 * What a conditional branch adds, when its `if` fixes one property to one
 * value: the keys it requires, and the arrays it gives a minimum entry count.
 * Any other conditional is not stated, because it is not unconditional and no
 * simple sentence states it.
 */
function conditionalRequirements(node: SchemaNode): Array<{
  key: string;
  value: unknown;
  required: string[];
  minItems: Array<readonly [string, number]>;
}> {
  const branches = [node, ...(Array.isArray(node.allOf) ? node.allOf.filter(isNode) : [])];
  const found: Array<{
    key: string;
    value: unknown;
    required: string[];
    minItems: Array<readonly [string, number]>;
  }> = [];
  for (const branch of branches) {
    const condition = isNode(branch.if) ? branch.if : undefined;
    const consequence = isNode(branch.then) ? branch.then : undefined;
    if (!condition || !consequence || !isNode(condition.properties)) continue;
    const tests = Object.entries(condition.properties);
    if (tests.length !== 1) continue;
    const [key, test] = tests[0]!;
    if (!isNode(test) || !("const" in test)) continue;
    const required = requiredKeys(consequence) ?? [];
    const minItems = isNode(consequence.properties)
      ? Object.entries(consequence.properties).flatMap(([name, child]) =>
          isNode(child) && typeof child.minItems === "number"
            ? [[name, child.minItems] as const]
            : [],
        )
      : [];
    if (required.length === 0 && minItems.length === 0) continue;
    found.push({ key, value: test.const, required, minItems });
  }
  return found;
}

/**
 * One line per object the schema gives a required key list: the keys it must
 * contain, in the schema's order; the keys a single-value condition adds; and,
 * when the object admits no undeclared key, the optional keys it may also
 * contain. A shared definition is one line naming every path the walk reaches
 * it at, so a layer's keys are stated where each layer is written. A field in
 * `hostWritten` (a full path such as `evaluation.target.paths`) is left out of
 * the keys the model writes and named as the host's. Keys come from the
 * schema only.
 */
export function schemaRequiredKeyLines(
  schema: unknown,
  prefix: string,
  hostWritten: readonly string[] = [],
  projection: {
    readonly hostDerived?: readonly string[];
    readonly conditionallyAuthored?: readonly string[];
  } = {},
): string[] {
  if (!isNode(schema)) return [];
  const root = schema;
  const entries = new Map<string, { node: SchemaNode; paths: string[]; text: string }>();
  const ids = new Map<SchemaNode, number>();
  const walking = new Set<SchemaNode>();
  const matchesPath = (selector: string, path: string): boolean => {
    const expected = segments(selector);
    const actual = segments(path);
    return (
      expected.length === actual.length &&
      expected.every((segment, index) => segment === "*" || segment === actual[index])
    );
  };
  const matchesAny = (selectors: readonly string[], path: string): boolean =>
    selectors.some((selector) => matchesPath(selector, path));
  const visit = (raw: SchemaNode, path: string): void => {
    // A host-written object must not generate evaluator instructions for its
    // descendants. Keep this path-specific: a shared schema definition can
    // still be model-written at another path.
    if (matchesAny(hostWritten, path) || matchesAny(projection.hostDerived ?? [], path)) return;
    const node = dereference(root, raw);
    // A recursive definition stops at its own repeat.
    if (walking.has(node)) return;
    const required = requiredKeys(node);
    if (required) {
      const host = (key: string) => matchesAny(hostWritten, `${path}.${key}`);
      const derived = (key: string) => matchesAny(projection.hostDerived ?? [], `${path}.${key}`);
      const conditional = (key: string) =>
        matchesAny(projection.conditionallyAuthored ?? [], `${path}.${key}`);
      const declared = isNode(node.properties) ? Object.keys(node.properties) : [];
      const conditions = conditionalRequirements(node).flatMap((condition) => {
        const required = condition.required.filter(
          (key) => !host(key) && !derived(key) && !conditional(key),
        );
        const minItems = condition.minItems.filter(
          ([key]) => !host(key) && !derived(key) && !conditional(key),
        );
        // Keep a conditional obligation when its discriminator is host-owned
        // but the consequence still requires model-authored fields. A branch
        // with no remaining model obligation (such as host-derived conditions)
        // does not belong in the evaluator's answer contract.
        if (required.length === 0 && minItems.length === 0) {
          return [];
        }
        return [{ ...condition, required, minItems }];
      });
      const optional = declared.filter(
        (key) =>
          (!required.includes(key) || conditional(key)) &&
          !conditions.some((condition) => condition.required.includes(key)) &&
          !host(key) &&
          !derived(key),
      );
      const written = required.filter((key) => !host(key) && !derived(key) && !conditional(key));
      const hosted = declared.filter(host);
      const derivedFields = declared.filter(derived);
      const conditionalFields = declared.filter(conditional);
      const closed = node.additionalProperties === false;
      const exact = closed && optional.length === 0 && conditions.length === 0;
      const clauses = [
        `${exact ? "exactly these keys" : "these keys"}: ${written.join(", ")}`,
        ...conditions.map(({ key, value, required: added, minItems }) => {
          const keys = added.filter((item) => !host(item));
          const counts = minItems.map(
            ([name, count]) => `${name} has at least ${count} ${count === 1 ? "entry" : "entries"}`,
          );
          return `when ${key} is ${JSON.stringify(value)}, ${[
            ...(keys.length > 0 ? [`also ${keys.join(", ")}`] : []),
            ...counts,
          ].join(" and ")}`;
        }),
        ...(closed && optional.length > 0 ? [`it may also contain ${optional.join(", ")}`] : []),
        ...(closed && !exact ? ["no other key"] : []),
        ...(hosted.length > 0 ? [`leave out ${hosted.join(", ")}, which the host writes`] : []),
        ...(derivedFields.length > 0
          ? [`leave out ${derivedFields.join(", ")}, which the host derives`]
          : []),
        ...(conditionalFields.length > 0
          ? [
              `include ${conditionalFields.join(", ")} only when the response contract below requires it`,
            ]
          : []),
      ];
      if (!ids.has(node)) ids.set(node, ids.size);
      const text = clauses.join("; ");
      // A shared definition can have different ownership at each path. Keep
      // separately rendered clauses when the projected ownership differs.
      const signature = `${ids.get(node)}|${text}`;
      const entry = entries.get(signature) ?? { node, paths: [], text };
      if (!entry.paths.includes(path)) entry.paths.push(path);
      entries.set(signature, entry);
    }
    walking.add(node);
    if (isNode(node.properties)) {
      for (const [name, child] of Object.entries(node.properties)) {
        if (isNode(child)) visit(child, `${path}.${name}`);
      }
    }
    if (isNode(node.items)) visit(node.items, `${path}[]`);
    for (const branch of Array.isArray(node.allOf) ? node.allOf : []) {
      if (isNode(branch) && !isNode(branch.if)) visit(branch, path);
    }
    walking.delete(node);
  };
  visit(root, prefix);
  return [...entries.values()].map(({ paths, text }) => {
    const where = compressPaths(paths);
    return `- ${where.join(" and ")} ${paths.length === 1 ? "must contain" : "each must contain"} ${text}.`;
  });
}

/**
 * The profile constraint id each schema constraint key carries as its
 * `dimension_id`. Schema keys use underscores and profile ids use hyphens, so a
 * key maps to the one listed profile id that spells it with hyphens. A key with
 * no such id is left out rather than guessed.
 */
export function constraintDimensionIds(
  schema: unknown,
  profile: unknown,
): Array<readonly [string, string]> {
  if (!isNode(schema) || !isNode(profile)) return [];
  const constraintsNode = isNode(schema.properties) ? schema.properties.constraints : undefined;
  if (!isNode(constraintsNode)) return [];
  const constraints = dereference(schema, constraintsNode);
  const policy = profile.constraints;
  if (!isNode(constraints.properties) || !isNode(policy)) return [];
  const ids = [policy.required, policy.conditional]
    .flatMap((value) => (Array.isArray(value) ? value : []))
    .filter((value): value is string => typeof value === "string");
  const pairs: Array<readonly [string, string]> = [];
  for (const key of Object.keys(constraints.properties)) {
    const matches = ids.filter((id) => id.replaceAll("-", "_") === key);
    if (matches.length === 1) pairs.push([key, matches[0]!]);
  }
  return pairs;
}
