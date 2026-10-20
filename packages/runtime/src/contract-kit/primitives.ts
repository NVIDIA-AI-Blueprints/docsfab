// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { types as nodeUtilTypes } from "node:util";

import { LIMIT_DEFINITION_BY_NAME } from "../config/limits.generated.js";
import { canonicalDigest, canonicalJson } from "../content-ir/canonical.js";
import { findConfiguredCredentialInValue } from "../security/configured-credentials.js";
import {
  annotateContractBoundExceeded,
  CONTRACT_DECODE_BOUND_AXES,
  contractDecodeLimits,
  type ContractBoundExceeded,
} from "./decode-bounds.js";
import { deepFreeze } from "./freeze.js";

export type ContractFail<Code extends string> = (
  code: Code,
  boundExceeded?: ContractBoundExceeded,
) => never;

export interface ContractKitCodes<Code extends string> {
  /** Shape, foreign prototypes, proxy, or key-set failures. */
  invalidShape: Code;
  /** Scalar / format / enum failures. */
  invalidValue: Code;
  /** Sealed digest round-trip mismatch. */
  digestMismatch: Code;
  /** Credential scanner hit. */
  credentialMaterial: Code;
  /** Wrong schemaVersion or kind during decodeSealed. */
  schemaMismatch: Code;
  /**
   * Named decode-bound refusal. When omitted, the kit still annotates the
   * thrown error with axis, limit, and observed value, and falls back to
   * invalidShape or invalidValue so existing caller codes stay unchanged.
   */
  boundExceeded?: Code;
}

/**
 * `standard` — lineage/inputs dialect (reject null prototypes; shallow inert).
 * `strict` — autonomy/lease dialect (bounded depth, safe numbers,
 * null prototypes allowed, enumerable own data properties required).
 */
export type ContractInertMode = "standard" | "strict";

export interface ContractKitOptions<Code extends string> {
  fail: ContractFail<Code>;
  codes: ContractKitCodes<Code>;
  /**
   * Autonomy and lease contracts need stricter inert checks than lineage.
   * Prefer this option over forking another dialect stack.
   */
  inertMode?: ContractInertMode;
  /**
   * The declared limit that already governs this contract's size where the
   * record is built, such as `repository.inventoryMaxEntries` for a
   * repository inventory, which grows with the tracked tree. The strict walk
   * and the array helper then skip the generic `runtime.contract.maxNodes`
   * and `runtime.contract.maxArrayLength` ceilings: they are sized for
   * identifier lists, and they refused every inventory of a 10k-file tree
   * that the owning limit admits (#1927). The inertness, depth, and string
   * checks still apply. The name must be declared in `config/limits/`.
   */
  sizeGovernedBy?: string;
}

export type SealedEnvelope<K extends string, D extends string, T, V extends number = 1> = T & {
  schemaVersion: V;
  kind: K;
} & Record<D, string>;

/**
 * Shared closed-schema dialect used by lineage, inputs, autonomy, and leases.
 * Domain modules supply fail() + error codes; the kit stays harness-neutral.
 */
export function createContractKit<Code extends string>(options: ContractKitOptions<Code>) {
  const { fail, codes } = options;
  const inertMode: ContractInertMode = options.inertMode ?? "standard";
  if (
    options.sizeGovernedBy !== undefined &&
    !Object.hasOwn(LIMIT_DEFINITION_BY_NAME, options.sizeGovernedBy)
  ) {
    throw new Error(
      `Contract kit size governor ${options.sizeGovernedBy} is not declared in config/limits.yaml.`,
    );
  }
  // A contract whose size a declared limit governs at build time skips the
  // generic size ceilings; every other contract keeps them.
  const genericSizeCeilings = options.sizeGovernedBy === undefined;

  function refuseBound(fallback: Code, details: ContractBoundExceeded): never {
    const code = codes.boundExceeded ?? fallback;
    let thrown: unknown;
    try {
      fail(code, details);
    } catch (error) {
      thrown = error;
    }
    throw annotateContractBoundExceeded(thrown, details);
  }

  /**
   * Refuse a value that holds one of DocsFab's own configured credentials,
   * matched exactly (#1807). A credential shape alone is repository or request
   * content, reported as a finding, and never refuses a record.
   */
  function rejectCredentials(value: unknown): void {
    if (findConfiguredCredentialInValue(value)) {
      fail(codes.credentialMaterial);
    }
  }

  function assertInertStandard(value: unknown, seen = new Set<object>()): void {
    if (
      value === null ||
      value === undefined ||
      ["string", "number", "boolean"].includes(typeof value)
    ) {
      return;
    }
    if (typeof value !== "object" || seen.has(value) || nodeUtilTypes.isProxy(value)) {
      fail(codes.invalidShape);
    }
    seen.add(value);
    const proto = Object.getPrototypeOf(value);
    if (
      (Array.isArray(value) && proto !== Array.prototype) ||
      (!Array.isArray(value) && proto !== Object.prototype)
    ) {
      fail(codes.invalidShape);
    }
    for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
      if (!("value" in descriptor)) fail(codes.invalidShape);
      assertInertStandard(descriptor.value, seen);
    }
    seen.delete(value);
  }

  function assertInertStrict(value: unknown): void {
    const bounds = contractDecodeLimits();
    let nodes = 0;
    const active = new Set<object>();
    const visit = (candidate: unknown, depth: number): void => {
      nodes += 1;
      if (genericSizeCeilings && nodes > bounds.maxNodes) {
        refuseBound(codes.invalidShape, {
          axis: CONTRACT_DECODE_BOUND_AXES.maxNodes,
          limit: bounds.maxNodes,
          observed: nodes,
        });
      }
      if (depth > bounds.maxDepth) {
        refuseBound(codes.invalidShape, {
          axis: CONTRACT_DECODE_BOUND_AXES.maxDepth,
          limit: bounds.maxDepth,
          observed: depth,
        });
      }
      if (candidate === null || typeof candidate === "boolean") return;
      if (typeof candidate === "string") {
        if (candidate.length > bounds.maxStringChars) {
          refuseBound(codes.invalidValue, {
            axis: CONTRACT_DECODE_BOUND_AXES.maxStringChars,
            limit: bounds.maxStringChars,
            observed: candidate.length,
          });
        }
        return;
      }
      if (typeof candidate === "number") {
        if (
          !Number.isFinite(candidate) ||
          Object.is(candidate, -0) ||
          (Number.isInteger(candidate) && !Number.isSafeInteger(candidate))
        ) {
          fail(codes.invalidValue);
        }
        return;
      }
      if (
        candidate === undefined ||
        candidate === null ||
        typeof candidate !== "object" ||
        nodeUtilTypes.isProxy(candidate) ||
        active.has(candidate as object)
      ) {
        fail(codes.invalidShape);
      }
      const node = candidate as object;
      const arrayValue = Array.isArray(node);
      const proto = Object.getPrototypeOf(node);
      if (
        (arrayValue && proto !== Array.prototype) ||
        (!arrayValue && proto !== Object.prototype && proto !== null)
      ) {
        fail(codes.invalidShape);
      }
      active.add(node);
      const keys = Reflect.ownKeys(node);
      if (keys.some((key) => typeof key !== "string")) fail(codes.invalidShape);
      if (arrayValue) {
        const lengthDescriptor = Object.getOwnPropertyDescriptor(node, "length");
        const lengthValue =
          lengthDescriptor && "value" in lengthDescriptor ? lengthDescriptor.value : undefined;
        if (
          !Number.isSafeInteger(lengthValue) ||
          lengthValue < 0 ||
          keys.length !== lengthValue + 1
        ) {
          fail(codes.invalidShape);
        }
        if (genericSizeCeilings && lengthValue > bounds.maxArrayLength) {
          refuseBound(codes.invalidShape, {
            axis: CONTRACT_DECODE_BOUND_AXES.maxArrayLength,
            limit: bounds.maxArrayLength,
            observed: lengthValue,
          });
        }
        for (let index = 0; index < lengthValue; index += 1) {
          const descriptor = Object.getOwnPropertyDescriptor(node, String(index));
          if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
            fail(codes.invalidShape);
          }
          visit((descriptor as PropertyDescriptor).value, depth + 1);
        }
      } else {
        for (const key of keys as string[]) {
          const descriptor = Object.getOwnPropertyDescriptor(node, key);
          if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
            fail(codes.invalidShape);
          }
          visit((descriptor as PropertyDescriptor).value, depth + 1);
        }
      }
      active.delete(node);
    };
    visit(value, 0);
  }

  function assertInert(value: unknown): void {
    if (inertMode === "strict") assertInertStrict(value);
    else assertInertStandard(value);
  }

  function object(value: unknown): Record<string, unknown> {
    if (
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      nodeUtilTypes.isProxy(value)
    ) {
      fail(codes.invalidShape);
    }
    const proto = Object.getPrototypeOf(value);
    if (inertMode === "strict") {
      if (proto !== Object.prototype && proto !== null) fail(codes.invalidShape);
      const descriptors = Object.getOwnPropertyDescriptors(value);
      if (
        Reflect.ownKeys(descriptors).some((key) => {
          if (typeof key !== "string") return true;
          const descriptor = descriptors[key]!;
          return (
            !descriptor.enumerable ||
            descriptor.get !== undefined ||
            descriptor.set !== undefined ||
            !("value" in descriptor)
          );
        })
      ) {
        fail(codes.invalidShape);
      }
    } else if (proto !== Object.prototype) {
      fail(codes.invalidShape);
    }
    return value as Record<string, unknown>;
  }

  function exact(
    root: Record<string, unknown>,
    keys: readonly string[],
    optional: readonly string[] = [],
  ): void {
    const required = keys.filter((key) => !optional.includes(key));
    if (
      required.some((key) => !Object.hasOwn(root, key)) ||
      Object.keys(root).some((key) => !keys.includes(key))
    ) {
      fail(codes.invalidShape);
    }
    if (optional.length === 0 && Object.keys(root).length !== keys.length) {
      fail(codes.invalidShape);
    }
  }

  function noUnknown(root: Record<string, unknown>, keys: string[]): void {
    if (Object.keys(root).some((key) => !keys.includes(key))) {
      fail(codes.invalidShape);
    }
  }

  function pick(root: Record<string, unknown>, keys: string[]): Record<string, unknown> {
    return Object.fromEntries(keys.map((key) => [key, root[key]]));
  }

  function array(value: unknown): unknown[] {
    if (!Array.isArray(value) || nodeUtilTypes.isProxy(value)) return fail(codes.invalidShape);
    if (inertMode === "strict") {
      if (Object.getPrototypeOf(value) !== Array.prototype) fail(codes.invalidShape);
      const keys = Reflect.ownKeys(value);
      if (
        keys.length !== value.length + 1 ||
        !keys.includes("length") ||
        keys.some(
          (key) =>
            typeof key !== "string" ||
            (key !== "length" &&
              (!/^(?:0|[1-9][0-9]*)$/u.test(key) || Number(key) >= value.length)),
        )
      ) {
        fail(codes.invalidShape);
      }
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (
          !descriptor ||
          !descriptor.enumerable ||
          descriptor.get !== undefined ||
          descriptor.set !== undefined ||
          !("value" in descriptor)
        ) {
          fail(codes.invalidShape);
        }
      }
      return value;
    }
    if (Object.keys(value).length !== value.length) {
      return fail(codes.invalidShape);
    }
    const maxArrayLength = contractDecodeLimits().maxArrayLength;
    if (genericSizeCeilings && value.length > maxArrayLength) {
      return refuseBound(codes.invalidShape, {
        axis: CONTRACT_DECODE_BOUND_AXES.maxArrayLength,
        limit: maxArrayLength,
        observed: value.length,
      });
    }
    return value;
  }

  function string(value: unknown): string {
    if (typeof value !== "string" || value !== value.normalize("NFC") || value.includes("\0")) {
      return fail(codes.invalidValue);
    }
    return value;
  }

  function identifier(value: unknown): string {
    const result = string(value);
    if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/u.test(result)) fail(codes.invalidValue);
    return result;
  }

  function hash(value: unknown): string {
    const result = string(value);
    if (!/^[a-f0-9]{64}$/u.test(result)) fail(codes.invalidValue);
    return result;
  }

  function nullableHash(value: unknown): string | null {
    return value === null ? null : hash(value);
  }

  function revision(value: unknown): string {
    const result = string(value);
    if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(result)) fail(codes.invalidValue);
    return result;
  }

  function timestamp(value: unknown): string {
    const result = string(value);
    if (
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(result) ||
      new Date(result).toISOString() !== result
    ) {
      fail(codes.invalidValue);
    }
    return result;
  }

  function nullableTimestamp(value: unknown): string | null {
    return value === null ? null : timestamp(value);
  }

  function enumeration<const T extends readonly string[]>(value: unknown, values: T): T[number] {
    const result = string(value);
    if (!values.includes(result)) fail(codes.invalidValue);
    return result as T[number];
  }

  function compare(left: string, right: string): number {
    return left < right ? -1 : left > right ? 1 : 0;
  }

  function unique(values: string[]): void {
    if (new Set(values).size !== values.length) fail(codes.invalidValue);
  }

  function normalizedHashes(value: unknown, requireNonEmpty = false): string[] {
    const result = array(value).map(hash).sort(compare);
    unique(result);
    if (requireNonEmpty && result.length === 0) fail(codes.invalidValue);
    return result;
  }

  function normalizedIds(value: unknown, requireNonEmpty = false): string[] {
    const result = array(value).map(identifier).sort(compare);
    unique(result);
    if (requireNonEmpty && result.length === 0) fail(codes.invalidValue);
    return result;
  }

  function seal<K extends string, D extends string, T>(
    kind: K,
    digestKey: D,
    body: T,
  ): SealedEnvelope<K, D, T, 1>;
  function seal<K extends string, D extends string, T, const V extends number>(
    kind: K,
    digestKey: D,
    body: T,
    schemaVersion: V,
  ): SealedEnvelope<K, D, T, V>;
  function seal<K extends string, D extends string, T>(
    kind: K,
    digestKey: D,
    body: T,
    schemaVersion = 1,
  ): SealedEnvelope<K, D, T, number> {
    const envelope = { schemaVersion, kind, ...body };
    return deepFreeze({ ...envelope, [digestKey]: canonicalDigest(envelope) }) as SealedEnvelope<
      K,
      D,
      T,
      number
    >;
  }

  function decodeSealed<K extends string, D extends string, T>(
    value: unknown,
    kind: K,
    digestKey: D,
    bodyKeys: string[],
    normalize: (root: Record<string, unknown>) => T,
  ): SealedEnvelope<K, D, T, 1>;
  function decodeSealed<K extends string, D extends string, T, const V extends number>(
    value: unknown,
    kind: K,
    digestKey: D,
    bodyKeys: string[],
    normalize: (root: Record<string, unknown>) => T,
    schemaVersion: V,
  ): SealedEnvelope<K, D, T, V>;
  function decodeSealed<K extends string, D extends string, T>(
    value: unknown,
    kind: K,
    digestKey: D,
    bodyKeys: string[],
    normalize: (root: Record<string, unknown>) => T,
    schemaVersion = 1,
  ): SealedEnvelope<K, D, T, number> {
    assertInert(value);
    rejectCredentials(value);
    const root = object(value);
    exact(root, ["schemaVersion", "kind", ...bodyKeys, digestKey]);
    if (root.schemaVersion !== schemaVersion || root.kind !== kind) fail(codes.schemaMismatch);
    const body = Object.fromEntries(bodyKeys.map((key) => [key, root[key]]));
    const normalized = seal(kind, digestKey, normalize(body), schemaVersion);
    if (canonicalJson(root) !== canonicalJson(normalized)) fail(codes.digestMismatch);
    return normalized;
  }

  function sourceVersion(value: unknown): number | undefined {
    assertInert(value);
    return object(value).schemaVersion as number | undefined;
  }

  return {
    fail,
    deepFreeze,
    canonicalDigest,
    canonicalJson,
    rejectCredentials,
    assertInert,
    object,
    exact,
    noUnknown,
    pick,
    array,
    string,
    identifier,
    hash,
    nullableHash,
    revision,
    timestamp,
    nullableTimestamp,
    enumeration,
    compare,
    unique,
    normalizedHashes,
    normalizedIds,
    seal,
    decodeSealed,
    sourceVersion,
  };
}

export type ContractKit<Code extends string> = ReturnType<typeof createContractKit<Code>>;

/**
 * Single-use authority receipt tracking keyed by opaque verifier identity.
 */
export function createReceiptReplayGuard<Code extends string>(
  fail: ContractFail<Code>,
  replayCode: Code,
): { consume(verifier: object, receipt: string): void } {
  const used = new WeakMap<object, Set<string>>();
  return {
    consume(verifier: object, receipt: string): void {
      let receipts = used.get(verifier);
      if (!receipts) {
        receipts = new Set<string>();
        used.set(verifier, receipts);
      }
      if (receipts.has(receipt)) fail(replayCode);
      receipts.add(receipt);
    },
  };
}
