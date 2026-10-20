// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { types as utilTypes } from "node:util";

import { RoadmapContractError } from "../contracts/decode.js";
import {
  screenCredentialText,
  tokenPrefixRuleIds,
} from "../../security/credential-shape-findings.js";
import { dnsHostnamePattern } from "../../shared/dns-hostname.js";
import { compareText } from "../../shared/primitives.js";

export type JsonObject = Record<string, unknown>;
const SHA256 = /^[a-f0-9]{64}$/u;
const IDENTIFIER = /^[a-z0-9](?:[a-z0-9._:/-]{0,255})$/u;
const EXTERNAL_ID = /^(?:[1-9][0-9]{0,19}|[a-f0-9]{40}|[a-f0-9]{64})$/u;
export const REVISION = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
export const HOST = dnsHostnamePattern({ singleLabel: true });

export function closed(
  value: unknown,
  path: string,
  allowed: readonly string[],
  required: readonly string[] = allowed,
  allowUnknownKnownFields = false,
): JsonObject {
  requireValue(
    typeof value === "object" &&
      value !== null &&
      !utilTypes.isProxy(value) &&
      !Array.isArray(value),
    "invalid-type",
    path,
  );
  const proto = Object.getPrototypeOf(value);
  requireValue(proto === Object.prototype || proto === null, "invalid-type", path);
  const item = value as JsonObject;
  const keys = Reflect.ownKeys(item);
  requireValue(
    keys.every((key): key is string => typeof key === "string"),
    "unknown-field",
    path,
  );
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(item, key)!;
    requireValue(
      Object.hasOwn(descriptor, "value") && descriptor.enumerable,
      "invalid-type",
      `${path}.${key}`,
    );
    if (!allowUnknownKnownFields)
      requireValue(allowed.includes(key), "unknown-field", `${path}.${key}`);
  }
  for (const key of required)
    requireValue(Object.hasOwn(item, key), "missing-field", `${path}.${key}`);
  return item;
}

export function array(value: unknown, path: string): unknown[] {
  requireValue(!utilTypes.isProxy(value) && Array.isArray(value), "invalid-type", path);
  requireValue(Object.getPrototypeOf(value) === Array.prototype, "invalid-type", path);
  const keys = Reflect.ownKeys(value);
  requireValue(
    keys.every(
      (key) => key === "length" || (typeof key === "string" && /^(?:0|[1-9][0-9]*)$/u.test(key)),
    ),
    "invalid-type",
    path,
  );
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
  requireValue(
    lengthDescriptor !== undefined &&
      Object.hasOwn(lengthDescriptor, "value") &&
      typeof lengthDescriptor.value === "number" &&
      Number.isSafeInteger(lengthDescriptor.value) &&
      lengthDescriptor.value >= 0,
    "invalid-type",
    `${path}.length`,
  );
  const result: unknown[] = [];
  for (let index = 0; index < lengthDescriptor.value; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    requireValue(
      descriptor !== undefined && Object.hasOwn(descriptor, "value"),
      "invalid-type",
      `${path}[${index}]`,
    );
    result.push(descriptor.value);
  }
  requireValue(keys.length === result.length + 1, "invalid-type", path);
  return result;
}
export function identifier(value: unknown, path: string): string {
  requireValue(
    typeof value === "string" &&
      IDENTIFIER.test(value) &&
      !value.includes(":/") &&
      screenCredentialText(value, `roadmap-execution:${path}`, (text) =>
        tokenPrefixRuleIds(text, { anchored: true }),
      ) === null,
    "invalid-value",
    path,
  );
  return value;
}
export function externalId(value: unknown, path: string): string {
  requireValue(typeof value === "string" && EXTERNAL_ID.test(value), "invalid-value", path);
  return value;
}
export function digest(value: unknown, path: string): string {
  requireValue(typeof value === "string" && SHA256.test(value), "invalid-value", path);
  return value;
}
export function timestamp(value: unknown, path: string): string {
  requireValue(
    typeof value === "string" && new Date(value).toISOString() === value,
    "invalid-time",
    path,
  );
  return value;
}
export function positiveInteger(value: unknown, path: string): number {
  requireValue(
    typeof value === "number" && Number.isSafeInteger(value) && value > 0,
    "invalid-value",
    path,
  );
  return value;
}
export function enumeration<T extends string>(
  value: unknown,
  values: readonly T[],
  path: string,
): T {
  requireValue(typeof value === "string" && values.includes(value as T), "invalid-value", path);
  return value as T;
}
export function idArray(value: unknown, path: string): string[] {
  return array(value, path)
    .map((item, index) => identifier(item, `${path}[${index}]`))
    .sort(compareText);
}
export function unique(values: string[], path: string): void {
  requireValue(new Set(values).size === values.length, "duplicate-id", path);
}
export function sameArray(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((item, index) => item === right[index]);
}
export function requireValue(
  condition: unknown,
  code: ConstructorParameters<typeof RoadmapContractError>[0],
  path: string,
): asserts condition {
  if (!condition) throw new RoadmapContractError(code, path);
}
