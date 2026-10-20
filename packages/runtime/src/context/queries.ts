// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { isAbsolute } from "node:path";

import { canonicalDigest, canonicalJson } from "../content-ir/canonical.js";
import { CONTEXT_QUERY_KINDS, type ContextQuery, type ContextQueryKind } from "./contracts.js";

export class ContextQueryError extends Error {
  public constructor(
    public readonly code: "invalid-query" | "unknown-field" | "unsafe-path" | "duplicate-node-id",
    public readonly path: string,
  ) {
    super(`${code} at ${path}`);
    this.name = "ContextQueryError";
  }
}

type JsonObject = Record<string, unknown>;

function record(value: unknown, path: string): JsonObject {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new ContextQueryError("invalid-query", path);
  }
  return value as JsonObject;
}

function fields(value: JsonObject, allowed: readonly string[], required: readonly string[]): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      throw new ContextQueryError("unknown-field", `$.${key}`);
    }
  }
  for (const key of required) {
    if (!Object.hasOwn(value, key)) {
      throw new ContextQueryError("invalid-query", `$.${key}`);
    }
  }
}

function text(value: unknown, path: string): string {
  if (typeof value !== "string" || !value.trim() || value !== value.normalize("NFC")) {
    throw new ContextQueryError("invalid-query", path);
  }
  return value;
}

function nodeId(value: unknown, path: string): string {
  const result = text(value, path);
  if (/\s|\0/u.test(result)) throw new ContextQueryError("invalid-query", path);
  return result;
}

function sourcePath(value: unknown, path: string): string {
  const result = text(value, path);
  if (
    result.includes("\0") ||
    result.includes("\\") ||
    isAbsolute(result) ||
    /^[A-Za-z]:/u.test(result) ||
    result.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    throw new ContextQueryError("unsafe-path", path);
  }
  return result;
}

function depth(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new ContextQueryError("invalid-query", path);
  }
  return value;
}

function kind(value: unknown): ContextQueryKind {
  if (typeof value !== "string" || !CONTEXT_QUERY_KINDS.includes(value as ContextQueryKind)) {
    throw new ContextQueryError("invalid-query", "$.kind");
  }
  return value as ContextQueryKind;
}

/** Strictly validates and canonicalizes the closed context query language. */
export function validateContextQuery(value: unknown): ContextQuery {
  const query = record(value, "$");
  switch (kind(query.kind)) {
    case "locate": {
      fields(query, ["kind", "sourcePath", "anchor"], ["kind", "sourcePath"]);
      return {
        kind: "locate",
        sourcePath: sourcePath(query.sourcePath, "$.sourcePath"),
        ...(query.anchor === undefined ? {} : { anchor: text(query.anchor, "$.anchor") }),
      };
    }
    case "get-neighborhood": {
      fields(query, ["kind", "targetNodeId", "depth"], ["kind", "targetNodeId"]);
      return {
        kind: "get-neighborhood",
        targetNodeId: nodeId(query.targetNodeId, "$.targetNodeId"),
        ...(query.depth === undefined ? {} : { depth: depth(query.depth, "$.depth") }),
      };
    }
    case "find-home": {
      fields(query, ["kind", "targetNodeId"], ["kind", "targetNodeId"]);
      return { kind: "find-home", targetNodeId: nodeId(query.targetNodeId, "$.targetNodeId") };
    }
    case "test-placement": {
      fields(
        query,
        ["kind", "targetNodeId", "candidateParentId"],
        ["kind", "targetNodeId", "candidateParentId"],
      );
      return {
        kind: "test-placement",
        targetNodeId: nodeId(query.targetNodeId, "$.targetNodeId"),
        candidateParentId: nodeId(query.candidateParentId, "$.candidateParentId"),
      };
    }
    case "expand": {
      fields(query, ["kind", "targetNodeIds", "depth"], ["kind", "targetNodeIds"]);
      if (!Array.isArray(query.targetNodeIds) || query.targetNodeIds.length === 0) {
        throw new ContextQueryError("invalid-query", "$.targetNodeIds");
      }
      const targetNodeIds = query.targetNodeIds
        .map((value, index) => nodeId(value, `$.targetNodeIds[${index}]`))
        .sort();
      if (new Set(targetNodeIds).size !== targetNodeIds.length) {
        throw new ContextQueryError("duplicate-node-id", "$.targetNodeIds");
      }
      return {
        kind: "expand",
        targetNodeIds,
        ...(query.depth === undefined ? {} : { depth: depth(query.depth, "$.depth") }),
      };
    }
  }
}

export function canonicalContextQueryJson(value: ContextQuery): string {
  return canonicalJson(validateContextQuery(value));
}

export function canonicalContextQueryDigest(value: ContextQuery): string {
  return canonicalDigest(validateContextQuery(value));
}
