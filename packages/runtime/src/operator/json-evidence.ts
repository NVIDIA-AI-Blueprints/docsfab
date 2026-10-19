// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";

import {
  readAcceptanceJsonLeaf,
  type AcceptanceEvidenceDirectory,
  type AcceptanceJsonLeaf,
} from "../acceptance-evidence.js";
import {
  canonicalizeJsonEvidence,
  isJsonEvidence,
  JsonEvidenceError,
  parseJsonEvidence,
  type JsonEvidenceParseOptions,
  type JsonEvidenceValue,
} from "../json-evidence.js";

export {
  canonicalizeJsonEvidence,
  isJsonEvidence,
  JsonEvidenceError,
  parseJsonEvidence,
  type JsonEvidenceParseOptions,
  type JsonEvidenceValue,
};

export interface PrivateJsonEvidenceLeaf {
  readonly file: string;
  readonly bytes: Buffer;
  readonly value: JsonEvidenceValue;
  readonly leaf: AcceptanceJsonLeaf;
}

/**
 * Read a private evidence leaf and re-parse its bytes with strict
 * JSON-evidence rules (no duplicate keys, no non-finite numbers, UTF-8 only).
 * Credential material must never be passed through this helper.
 */
export async function readPrivateJsonEvidenceLeaf(
  directory: AcceptanceEvidenceDirectory,
  file: string,
): Promise<PrivateJsonEvidenceLeaf> {
  const leaf = await readAcceptanceJsonLeaf(directory, file);
  const value = parseJsonEvidence(leaf.bytes);
  return {
    file: leaf.file,
    bytes: leaf.bytes,
    value,
    leaf,
  };
}

/** Parse already-loaded private evidence bytes with strict JSON-evidence rules. */
export function parsePrivateJsonEvidence(
  input: string | Uint8Array,
  options: JsonEvidenceParseOptions = {},
): JsonEvidenceValue {
  return parseJsonEvidence(input, options);
}

/** Serialize a value to canonical JSON-evidence bytes (trailing newline). */
export function serializePrivateJsonEvidence(value: JsonEvidenceValue): Buffer {
  return Buffer.from(canonicalizeJsonEvidence(value), "utf8");
}

/** SHA-256 of canonical JSON-evidence bytes. */
export function sha256PrivateJsonEvidence(value: JsonEvidenceValue): string {
  return createHash("sha256").update(serializePrivateJsonEvidence(value)).digest("hex");
}
