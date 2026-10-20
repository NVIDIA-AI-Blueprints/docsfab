// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { ReviewReplyIngressV2 } from "../contracts.js";

type Provider = Extract<ReviewReplyIngressV2, { readonly kind: "provider-reply" }>["provider"];
const PROVIDER: Provider = "gitlab";

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function positiveId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function nonempty(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

/**
 * Normalizes a supplied discussion shape only. Even a successful visit has no
 * authenticated actor, receipt membership, provider provenance or grant.
 */
type ParsedReply = readonly [number, number, string, number, number, number, string];

function parseUntrustedGitLabReply(input: unknown): ParsedReply | null {
  const envelope = object(input);
  const discussion = object(envelope?.discussion);
  const rootNoteId = envelope?.root_note_id;
  if (
    envelope?.provider !== PROVIDER ||
    !positiveId(envelope.project_id) ||
    !positiveId(envelope.merge_request_iid) ||
    !positiveId(rootNoteId) ||
    !positiveId(envelope.reply_id) ||
    !nonempty(discussion?.id) ||
    !Array.isArray(discussion.notes)
  ) {
    return null;
  }

  const notes = new Map<number, { readonly authorId: number; readonly body: string }>();
  for (const entry of discussion.notes) {
    const note = object(entry);
    const author = object(note?.author);
    if (
      !positiveId(note?.id) ||
      !positiveId(author?.id) ||
      typeof note.body !== "string" ||
      notes.has(note.id)
    ) {
      return null;
    }
    notes.set(note.id, { authorId: author.id, body: note.body });
  }
  const reply = notes.get(envelope.reply_id);
  // The supplied root remains untrusted until a retained publication receipt
  // and authenticated provider reader bind it to this discussion.
  if (rootNoteId === envelope.reply_id || !notes.has(rootNoteId) || reply === undefined) {
    return null;
  }

  return [
    envelope.project_id,
    envelope.merge_request_iid,
    discussion.id,
    rootNoteId,
    envelope.reply_id,
    reply.authorId,
    reply.body,
  ];
}

export function visitUntrustedGitLabReply(
  input: unknown,
  onReply: (
    projectId: number,
    mergeRequestIid: number,
    discussionId: string,
    rootNoteId: number,
    replyNoteId: number,
    authorId: number,
    body: string,
  ) => void,
): boolean {
  let parsed: ParsedReply | null;
  try {
    parsed = parseUntrustedGitLabReply(input);
  } catch {
    return false;
  }
  if (parsed === null) return false;
  onReply(...parsed);
  return true;
}
