// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The run record's `instructionContext` contract: non-authoritative live-agent
 * context beside the verbatim instruction, trimmed and cut at
 * `liveAgent.workflowContextMaxChars` with a coded marker. The writer and
 * every strict reader share this module so they agree on the shape.
 *
 * The text is never parsed for targets, sources, or restrictions, so readers
 * check shape and bound only.
 */
import { limitDefinition } from "../config/limits.js";

export const INSTRUCTION_CONTEXT_MAX_CHARS_LIMIT = "liveAgent.workflowContextMaxChars";

export function instructionContextClipMarker(omittedChars: number, maxChars: number): string {
  const refusal = limitDefinition(INSTRUCTION_CONTEXT_MAX_CHARS_LIMIT).refusal;
  return `\n[${refusal}: ${omittedChars} more characters of live-agent context were cut at ${maxChars}]`;
}

export class RunRecordInstructionContextError extends Error {
  constructor() {
    super("Run record instructionContext does not match the live-agent context contract.");
    this.name = "RunRecordInstructionContextError";
  }
}

/**
 * Admit only what the writer can produce: trimmed, non-empty text within the
 * limit's declared ceiling, or text cut at an admissible bound plus the clip
 * marker.
 */
export function decodeRunRecordInstructionContext(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value) {
    throw new RunRecordInstructionContextError();
  }
  const bound = limitDefinition(INSTRUCTION_CONTEXT_MAX_CHARS_LIMIT);
  if (value.length <= bound.max) return value;
  // Longer than any admissible bound: only a cut context with its marker fits.
  const counts = /(\d+)\D+(\d+)\]$/u.exec(value);
  const omittedChars = Number(counts?.[1]);
  const maxChars = Number(counts?.[2]);
  if (
    !Number.isSafeInteger(omittedChars) ||
    !Number.isSafeInteger(maxChars) ||
    omittedChars <= 0 ||
    maxChars < bound.min ||
    maxChars > bound.max
  ) {
    throw new RunRecordInstructionContextError();
  }
  const marker = instructionContextClipMarker(omittedChars, maxChars);
  if (!value.endsWith(marker) || value.length - marker.length !== maxChars) {
    throw new RunRecordInstructionContextError();
  }
  return value;
}
