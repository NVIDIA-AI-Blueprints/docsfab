// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Recover the JSON object a model wrapped in an envelope.
 *
 * A provider can answer with the object inside a Markdown fence or after a
 * sentence even when the contract asks for one bare JSON object. This module
 * only picks which span of the reply is the candidate document; it is not a
 * lenient parser, and the strict `json-evidence` parser still reads that span.
 *
 * It is the shared extraction policy for model replies, so decoders agree on
 * whether a wrapped reply holds a document.
 * `test/model-reply-extraction-drift.test.ts` checks the decoders against it
 * and lists those still on their own behavior.
 *
 * Ambiguity is refused, never guessed: the caller re-parses the original reply.
 * An unambiguous envelope's span is handed over even when it does not parse, so
 * the refusal describes the document (for example `duplicate-key`) rather than
 * the envelope.
 */

import { isJsonEvidence } from "../json-evidence.js";

/**
 * Fenced block openers and closers, as CommonMark spells them: three or more
 * backticks or tildes, an optional info string, to the end of the line.
 */
const FENCE_LINE = /^[ \t]*(`{3,}|~{3,})([^\n`]*)$/u;

type FencedBlock = { body: string; info: string };

function isJsonFence(block: FencedBlock): boolean {
  const firstToken = block.info.trim().split(/\s+/u)[0]?.toLowerCase();
  return firstToken === "" || firstToken === "json";
}

/**
 * The span of `response` the strict parser should read.
 *
 * Returns the response unchanged when there is no single envelope to open, so
 * the caller's refusal describes the original reply.
 */
export function jsonEnvelopeBody(response: string): string {
  const trimmed = response.trim();
  if (trimmed.length === 0) return response;
  // Fast path only: strict JSON has no raw newline inside a string, so a
  // conforming reply cannot contain a fence line.
  if (isJsonEvidence(trimmed)) return trimmed;

  const fenced = fencedBlocks(trimmed);
  // One fenced block is one envelope: unambiguous, so its body is the
  // candidate even when the body is broken.
  if (fenced.length === 1) return fenced[0]!.body;
  if (fenced.length !== 0) {
    // Info strings identify candidate answers; parse success must not make an
    // illustration win over a broken answer.
    const eligible = fenced.filter(isJsonFence);
    return eligible.length === 1 ? eligible[0]!.body : response;
  }

  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start < 0 || end < start) return response;
  // First `{` to last `}`: two separate objects do not parse as one span, so
  // they are refused rather than reduced to the first.
  return trimmed.slice(start, end + 1);
}

/**
 * Whether this policy declined a reply because more than one fenced block
 * is eligible as JSON. A decoder uses this only to name that rule on a refusal it
 * already made; it admits nothing.
 */
export function isAmbiguousJsonEnvelope(response: string): boolean {
  const trimmed = response.trim();
  if (trimmed.length === 0 || isJsonEvidence(trimmed)) return false;
  const fenced = fencedBlocks(trimmed);
  return fenced.length > 1 && fenced.filter(isJsonFence).length > 1;
}

/** Every fenced block body and opener info string, in order. */
function fencedBlocks(text: string): FencedBlock[] {
  const lines = text.split("\n");
  const blocks: FencedBlock[] = [];
  let openMarker: string | undefined;
  let info = "";
  let body: string[] = [];
  for (const line of lines) {
    const fenceLine = FENCE_LINE.exec(line);
    const marker = fenceLine?.[1];
    if (openMarker === undefined) {
      if (marker !== undefined) {
        openMarker = marker[0];
        info = fenceLine?.[2] ?? "";
        body = [];
      }
      continue;
    }
    // A closing fence uses the same character as its opener; a shorter run, or
    // the other character, is content.
    if (marker !== undefined && marker[0] === openMarker) {
      blocks.push({ body: body.join("\n"), info });
      openMarker = undefined;
      continue;
    }
    body.push(line);
  }
  return blocks;
}
