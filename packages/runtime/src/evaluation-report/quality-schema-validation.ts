// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs";

export type StagedQualitySchema =
  | "review-result.schema.json"
  | "documentation-quality-evaluation.schema.json"
  | "quality-report.schema.json"
  | "quality-report-projection.schema.json";
export type SchemaValidation = "valid" | "invalid" | "schema-unavailable";

interface JsonSchema {
  readonly $ref?: string;
  readonly $defs?: Record<string, JsonSchema>;
  readonly type?: string | readonly string[];
  readonly enum?: readonly unknown[];
  readonly const?: unknown;
  readonly required?: readonly string[];
  readonly properties?: Record<string, JsonSchema>;
  readonly additionalProperties?: boolean;
  readonly items?: JsonSchema;
  readonly minItems?: number;
  readonly maxItems?: number;
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly pattern?: string;
  readonly format?: string;
  readonly uniqueItems?: boolean;
  readonly minimum?: number;
  readonly maximum?: number;
  readonly exclusiveMinimum?: number | boolean;
  readonly allOf?: readonly JsonSchema[];
  readonly if?: JsonSchema;
  readonly then?: JsonSchema;
}

const schemaCache = new Map<StagedQualitySchema, JsonSchema>();
const SUPPORTED_SCHEMA_KEYS = new Set([
  "$schema",
  "$id",
  "$defs",
  "$ref",
  "title",
  "type",
  "enum",
  "const",
  "required",
  "properties",
  "additionalProperties",
  "items",
  "minItems",
  "maxItems",
  "minLength",
  "maxLength",
  "pattern",
  "format",
  "uniqueItems",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "allOf",
  "if",
  "then",
  // Annotation only: per-value prose that generated skill references render; it never validates.
  "x-docsfab-enum-descriptions",
  // Generated contract annotations are enforced by the host's locked
  // narrowing/policy checks, not by the structural JSON Schema evaluator.
  "x-docsfab-enum-source",
  "x-docsfab-narrow",
]);

/** Validate only the frozen quality schemas shipped with this package. */
export function validateStagedQualityArtifact(
  schemaName: StagedQualitySchema,
  value: unknown,
): SchemaValidation {
  try {
    const schema = loadSchema(schemaName);
    return matchesSchema(value, schema) ? "valid" : "invalid";
  } catch {
    return "schema-unavailable";
  }
}

function loadSchema(name: StagedQualitySchema): JsonSchema {
  const cached = schemaCache.get(name);
  if (cached) return cached;
  const path = new URL(`../../quality/schemas/${name}`, import.meta.url);
  const parsed = JSON.parse(readFileSync(path, "utf8")) as JsonSchema;
  assertSupportedSchema(parsed);
  deepFreeze(parsed);
  schemaCache.set(name, parsed);
  return parsed;
}

function assertSupportedSchema(schema: JsonSchema): void {
  for (const key of Object.keys(schema)) {
    if (!SUPPORTED_SCHEMA_KEYS.has(key)) {
      throw new Error(
        "Unsupported JSON Schema keyword encountered while loading a frozen contract.",
      );
    }
  }
  if (schema.$defs) {
    for (const definition of Object.values(schema.$defs)) assertSupportedSchema(definition);
  }
  if (schema.properties) {
    for (const child of Object.values(schema.properties)) assertSupportedSchema(child);
  }
  if (schema.items) assertSupportedSchema(schema.items);
  for (const child of schema.allOf ?? []) assertSupportedSchema(child);
  if (schema.if) assertSupportedSchema(schema.if);
  if (schema.then) assertSupportedSchema(schema.then);
}

/**
 * Every kebab-case keyword `describeStagedQualityArtifactMismatch` can name.
 * Closed: `mismatch()` accepts only these, so a new keyword must be listed
 * here, and consumers keyed on this list (the review-schema retry hints) fail
 * to typecheck until they handle it.
 */
export const STAGED_QUALITY_SCHEMA_MISMATCH_KEYWORDS = Object.freeze([
  "const",
  "enum",
  "type",
  "required",
  "additional-properties",
  "min-items",
  "max-items",
  "unique-items",
  "min-length",
  "max-length",
  "pattern",
  "format",
  "minimum",
  "maximum",
  "exclusive-minimum",
] as const);

export type StagedQualitySchemaMismatchKeyword =
  (typeof STAGED_QUALITY_SCHEMA_MISMATCH_KEYWORDS)[number];

/**
 * The first rule a value breaks, and where. `location` is `$`-rooted with
 * array members as `[]`. Both fields come from the frozen schema, never from
 * the value: an undeclared key is reported at its parent object, not by name.
 */
export interface StagedQualitySchemaMismatch {
  readonly keyword: StagedQualitySchemaMismatchKeyword;
  readonly location: string;
}

/**
 * Validate a generated record sub-shape with the same deliberately closed
 * JSON Schema dialect used by the frozen artifact validators. The schema is
 * supplied by the generated contract; this helper does not load or trust
 * model-provided schema text.
 */
export function validateGeneratedQualitySubshape(
  value: unknown,
  generatedSchema: unknown,
):
  | { readonly status: "valid" }
  | { readonly status: "invalid"; readonly mismatch: StagedQualitySchemaMismatch }
  | { readonly status: "unsupported-schema" } {
  try {
    if (!isRecord(generatedSchema)) return { status: "unsupported-schema" };
    const schema = generatedSchema as JsonSchema;
    assertSupportedSchema(schema);
    deepFreeze(schema);
    const mismatch = firstSchemaMismatch(value, schema, "$", schema);
    return mismatch ? { status: "invalid", mismatch } : { status: "valid" };
  } catch {
    return { status: "unsupported-schema" };
  }
}

/** Describe why `value` fails a frozen schema; undefined when it matches or the schema is unavailable. */
export function describeStagedQualityArtifactMismatch(
  schemaName: StagedQualitySchema,
  value: unknown,
): StagedQualitySchemaMismatch | undefined {
  try {
    return firstSchemaMismatch(value, loadSchema(schemaName), "$");
  } catch {
    return undefined;
  }
}

/**
 * What a frozen schema permits at a mismatch location: the allowed values for
 * `enum` and `const`, the declared keys for `additional-properties`, or, for
 * `required`, the keys the parent object requires (only when that list names
 * the missing key, so a key only a conditional branch requires gets none).
 * Schema vocabulary only, never a checked value; `undefined` when the location
 * does not resolve or the keyword names no such list there.
 */
export function stagedQualitySchemaVocabulary(
  schemaName: StagedQualitySchema,
  mismatch: StagedQualitySchemaMismatch,
): readonly unknown[] | undefined {
  try {
    const root = loadSchema(schemaName);
    if (mismatch.keyword === "required") {
      const missing = /^(.*)\.([^.[\]]+)$/u.exec(mismatch.location);
      if (!missing) return undefined;
      const required = schemaAtLocation(root, missing[1]!)?.required;
      return required?.includes(missing[2]!) ? required : undefined;
    }
    const node = schemaAtLocation(root, mismatch.location);
    if (!node) return undefined;
    switch (mismatch.keyword) {
      case "enum":
        return node.enum;
      case "const":
        return node.const === undefined ? undefined : [node.const];
      case "additional-properties":
        return node.properties ? Object.keys(node.properties) : undefined;
      default:
        return undefined;
    }
  } catch {
    return undefined;
  }
}

/** The schema member that states each bound keyword's number. */
const SCHEMA_BOUND_MEMBERS = Object.freeze({
  "min-items": "minItems",
  "max-items": "maxItems",
  "min-length": "minLength",
  "max-length": "maxLength",
  minimum: "minimum",
  maximum: "maximum",
  "exclusive-minimum": "exclusiveMinimum",
} as const satisfies Partial<Record<StagedQualitySchemaMismatchKeyword, keyof JsonSchema>>);

/**
 * The number a frozen schema states at a mismatch location for a bound
 * keyword (`min-items`, `max-length`, `minimum`, ...), with the schema member
 * that states it. Schema vocabulary only, never a checked value; `undefined`
 * when the location does not resolve, the keyword is not a bound, or the node
 * states no number there (for example a bound that only a conditional branch
 * adds).
 */
export function stagedQualitySchemaBound(
  schemaName: StagedQualitySchema,
  mismatch: StagedQualitySchemaMismatch,
): { readonly member: string; readonly value: number } | undefined {
  if (!Object.hasOwn(SCHEMA_BOUND_MEMBERS, mismatch.keyword)) return undefined;
  const member = SCHEMA_BOUND_MEMBERS[mismatch.keyword as keyof typeof SCHEMA_BOUND_MEMBERS];
  try {
    const value = schemaAtLocation(loadSchema(schemaName), mismatch.location)?.[member];
    return typeof value === "number" && Number.isFinite(value) ? { member, value } : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The pattern or format a frozen schema states at a `pattern` or `format`
 * mismatch location. Schema vocabulary only, never the checked value;
 * `undefined` for any other keyword or when the node states neither.
 */
export function stagedQualitySchemaStringRule(
  schemaName: StagedQualitySchema,
  mismatch: StagedQualitySchemaMismatch,
): { readonly pattern: string } | { readonly format: string } | undefined {
  if (mismatch.keyword !== "pattern" && mismatch.keyword !== "format") return undefined;
  try {
    const node = schemaAtLocation(loadSchema(schemaName), mismatch.location);
    if (mismatch.keyword === "pattern") {
      return typeof node?.pattern === "string" ? { pattern: node.pattern } : undefined;
    }
    return typeof node?.format === "string" ? { format: node.format } : undefined;
  } catch {
    return undefined;
  }
}

/** The schema node a `$`-rooted mismatch location names, through `$ref`. */
function schemaAtLocation(root: JsonSchema, location: string): JsonSchema | undefined {
  if (!location.startsWith("$")) return undefined;
  const segments = location.slice(1).match(/\.[^.[\]]+|\[\]/gu) ?? [];
  if (segments.join("") !== location.slice(1)) return undefined;
  let node: JsonSchema | undefined = dereference(root, root);
  for (const segment of segments) {
    if (!node) return undefined;
    const key = segment.slice(1);
    const next: JsonSchema | undefined =
      segment === "[]"
        ? node.items
        : node.properties !== undefined && Object.hasOwn(node.properties, key)
          ? node.properties[key]
          : undefined;
    node = next === undefined ? undefined : dereference(root, next);
  }
  return node;
}

function dereference(root: JsonSchema, schema: JsonSchema): JsonSchema {
  let current = schema;
  for (const seen = new Set<string>(); current.$ref !== undefined && !seen.has(current.$ref); ) {
    seen.add(current.$ref);
    current = resolveReference(root, current.$ref);
  }
  return current;
}

function matchesSchema(value: unknown, schema: JsonSchema, root = schema): boolean {
  return firstSchemaMismatch(value, schema, "$", root) === undefined;
}

function mismatch(
  keyword: StagedQualitySchemaMismatchKeyword,
  location: string,
): StagedQualitySchemaMismatch {
  return { keyword, location };
}

function firstSchemaMismatch(
  value: unknown,
  schema: JsonSchema,
  location: string,
  root = schema,
): StagedQualitySchemaMismatch | undefined {
  if (schema.$ref) {
    const target = resolveReference(root, schema.$ref);
    const found = firstSchemaMismatch(value, target, location, root);
    if (found) return found;
  }
  for (const item of schema.allOf ?? []) {
    const found = firstSchemaMismatch(value, item, location, root);
    if (found) return found;
  }
  if (schema.if && schema.then && matchesSchema(value, schema.if, root)) {
    const found = firstSchemaMismatch(value, schema.then, location, root);
    if (found) return found;
  }
  if (schema.const !== undefined && !Object.is(value, schema.const))
    return mismatch("const", location);
  if (schema.enum && !schema.enum.some((item) => Object.is(item, value)))
    return mismatch("enum", location);
  if (schema.type !== undefined && !matchesType(value, schema.type))
    return mismatch("type", location);
  if (schema.properties || schema.required || schema.additionalProperties === false) {
    if (!isRecord(value)) return mismatch("type", location);
    const missing = schema.required?.find((key) => !Object.hasOwn(value, key));
    if (missing !== undefined) return mismatch("required", `${location}.${missing}`);
    if (
      schema.additionalProperties === false &&
      Object.keys(value).some((key) => !schema.properties?.[key])
    ) {
      return mismatch("additional-properties", location);
    }
    for (const [key, child] of Object.entries(schema.properties ?? {})) {
      if (!Object.hasOwn(value, key)) continue;
      const found = firstSchemaMismatch(value[key], child, `${location}.${key}`, root);
      if (found) return found;
    }
  }
  if (schema.items || schema.minItems !== undefined || schema.maxItems !== undefined) {
    if (!Array.isArray(value)) return mismatch("type", location);
    if (schema.minItems !== undefined && value.length < schema.minItems)
      return mismatch("min-items", location);
    if (schema.maxItems !== undefined && value.length > schema.maxItems)
      return mismatch("max-items", location);
    if (
      schema.uniqueItems &&
      new Set(value.map((item) => JSON.stringify(item))).size !== value.length
    ) {
      return mismatch("unique-items", location);
    }
    if (schema.items) {
      for (const item of value) {
        const found = firstSchemaMismatch(item, schema.items, `${location}[]`, root);
        if (found) return found;
      }
    }
  }
  if (typeof value === "string") {
    if (schema.minLength !== undefined && value.length < schema.minLength)
      return mismatch("min-length", location);
    if (schema.maxLength !== undefined && value.length > schema.maxLength)
      return mismatch("max-length", location);
    if (schema.pattern && !new RegExp(schema.pattern, "u").test(value))
      return mismatch("pattern", location);
    if (schema.format === "date-time" && !isRfc3339DateTime(value))
      return mismatch("format", location);
  }
  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum)
      return mismatch("minimum", location);
    if (schema.maximum !== undefined && value > schema.maximum)
      return mismatch("maximum", location);
    if (schema.exclusiveMinimum !== undefined) {
      if (typeof schema.exclusiveMinimum === "number" && value <= schema.exclusiveMinimum)
        return mismatch("exclusive-minimum", location);
      if (
        schema.exclusiveMinimum === true &&
        schema.minimum !== undefined &&
        value <= schema.minimum
      )
        return mismatch("exclusive-minimum", location);
    }
  }
  return undefined;
}

function resolveReference(root: JsonSchema, reference: string): JsonSchema {
  if (!reference.startsWith("#/")) {
    throw new Error("Unsupported JSON Schema reference format encountered in frozen contract.");
  }
  let current: unknown = root;
  for (const token of reference.slice(2).split("/")) {
    if (!isRecord(current)) {
      throw new Error(
        "Unresolved JSON Schema reference encountered while loading a frozen contract.",
      );
    }
    current = current[token.replaceAll("~1", "/").replaceAll("~0", "~")];
  }
  if (!isRecord(current)) {
    throw new Error("Invalid JSON Schema reference target encountered in frozen contract.");
  }
  return current as JsonSchema;
}

function matchesType(value: unknown, type: string | readonly string[]): boolean {
  return (Array.isArray(type) ? type : [type]).some((expected) => {
    switch (expected) {
      case "object":
        return isRecord(value);
      case "array":
        return Array.isArray(value);
      case "string":
        return typeof value === "string";
      case "number":
        return typeof value === "number" && Number.isFinite(value);
      case "integer":
        return typeof value === "number" && Number.isInteger(value);
      case "boolean":
        return typeof value === "boolean";
      case "null":
        return value === null;
      default:
        throw new Error(
          "Unsupported JSON Schema type encountered while validating a frozen contract.",
        );
    }
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isRfc3339DateTime(value: string): boolean {
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d+)?(Z|[+-]\d{2}:\d{2})$/iu.exec(
    value,
  );
  if (!match) return false;
  const year = Number(match[1]!.slice(0, 4));
  const month = Number(match[1]!.slice(5, 7));
  const day = Number(match[1]!.slice(8, 10));
  const daysInMonth =
    [
      31,
      year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28,
      31,
      30,
      31,
      30,
      31,
      31,
      30,
      31,
      30,
      31,
    ][month - 1] ?? 0;
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth) return false;
  const second = Number(match[4]);
  const offset = match[6]!;
  if (
    second > 60 ||
    Number(match[2]) > 23 ||
    Number(match[3]) > 59 ||
    (offset !== "Z" && (Number(offset.slice(1, 3)) > 23 || Number(offset.slice(4, 6)) > 59))
  )
    return false;
  const normalized = `${match[1]}T${match[2]}:${match[3]}:${second === 60 ? "59" : match[4]}${match[5] ?? ""}${match[6]!.toUpperCase() === "Z" ? "+00:00" : match[6]}`;
  const parsed = new Date(normalized);
  if (Number.isNaN(parsed.valueOf()) || second !== 60) return true;
  const lastDay = new Date(
    Date.UTC(parsed.getUTCFullYear(), parsed.getUTCMonth() + 1, 0),
  ).getUTCDate();
  return (
    (parsed.getUTCMonth() === 5 || parsed.getUTCMonth() === 11) &&
    parsed.getUTCHours() === 23 &&
    parsed.getUTCMinutes() === 59 &&
    parsed.getUTCSeconds() === 59 &&
    parsed.getUTCDate() === lastDay
  );
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}
