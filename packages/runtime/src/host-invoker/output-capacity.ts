// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Pure output-capacity contract and serializer accounting for the hosted worker.
 *
 * The complete terminal is one NDJSON line, so its ceiling is a representation
 * fact of the engine's string carrier, not a configured allowance that an
 * override could raise. No per-field capacity is reserved; admission tests the
 * actual combined serialized size.
 */
import { constants as bufferConstants } from "node:buffer";

/**
 * Supported ceiling for one complete hosted output line, in UTF-8 bytes,
 * excluding the framing newline.
 *
 * `MAX_STRING_LENGTH` counts UTF-16 code units; comparing UTF-8 bytes against it
 * is exact for ASCII and conservative for anything wider.
 */
export const HOSTED_OUTPUT_LINE_MAXIMUM_BYTES = bufferConstants.MAX_STRING_LENGTH;

/** Framing is emitted separately so `line + frame` is never constructed. */
export const HOSTED_OUTPUT_LINE_FRAME = "\n";

export class HostedOutputCapacityError extends Error {
  readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = "HostedOutputCapacityError";
    this.code = code;
  }
}

export interface HostedOutputLineAccountingV1 {
  /** Without framing. */
  readonly json: string;
  /** Exact UTF-8 bytes of `json`, quotes, escapes and metadata included. */
  readonly bytes: number;
  /** Exact UTF-8 bytes actually delivered, framing included. */
  readonly framedBytes: number;
}

/**
 * Serialize one hosted output value and account its exact delivered cost.
 *
 * Refuses rather than truncating, summarizing or substituting a digest. A value
 * too wide to serialize raises the same coded refusal as one that exceeds the
 * carrier: either way the complete output cannot be represented.
 */
export function serializeHostedOutputLine(value: unknown): HostedOutputLineAccountingV1 {
  let json: string | undefined;
  try {
    json = JSON.stringify(value);
  } catch (error) {
    if (error instanceof RangeError)
      throw new HostedOutputCapacityError(
        `The complete hosted output is too wide to serialize at all, above the supported ${HOSTED_OUTPUT_LINE_MAXIMUM_BYTES}-byte line carrier.`,
        "hosted-output-line-max-bytes-bound",
      );
    throw error;
  }
  if (typeof json !== "string")
    throw new HostedOutputCapacityError(
      "The complete hosted output has no JSON representation and cannot be delivered as one line.",
      "hosted-output-line-unserializable",
    );
  const bytes = Buffer.byteLength(json, "utf8");
  const framedBytes = bytes + Buffer.byteLength(HOSTED_OUTPUT_LINE_FRAME, "utf8");
  // Checked against the carrier before framing, and against the safe-integer
  // range because the sum, not either part, is what the host reads.
  if (bytes > HOSTED_OUTPUT_LINE_MAXIMUM_BYTES || !Number.isSafeInteger(framedBytes))
    throw new HostedOutputCapacityError(
      `The complete hosted output measured ${bytes} bytes, above the supported ${HOSTED_OUTPUT_LINE_MAXIMUM_BYTES}-byte line carrier.`,
      "hosted-output-line-max-bytes-bound",
    );
  return Object.freeze({ json, bytes, framedBytes });
}
