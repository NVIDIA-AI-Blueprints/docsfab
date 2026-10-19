// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { ReviewReplyIngressV2 } from "../contracts.js";

type Provider = Extract<ReviewReplyIngressV2, { readonly kind: "provider-reply" }>["provider"];
const PROVIDER: Provider = "github";

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

interface UntrustedComment {
  readonly id: number;
  readonly parent: number | null;
  readonly authorId: number;
  readonly body: string;
}

/**
 * Follows the supplied incoming reply chain to its supplied top-level root.
 * The shape and chain remain untrusted until a configured provider reader and
 * retained publication receipt independently prove them.
 */
type ParsedReply = readonly [
  number,
  string,
  string,
  number,
  number,
  number,
  number,
  number,
  string,
];

function parseUntrustedGitHubReply(input: unknown): ParsedReply | null {
  const envelope = object(input);
  const repository = object(envelope?.repository);
  const owner = object(repository?.owner);
  if (
    envelope?.provider !== PROVIDER ||
    !positiveId(repository?.id) ||
    !nonempty(owner?.login) ||
    !nonempty(repository.name) ||
    !positiveId(envelope.pull_number) ||
    !positiveId(envelope.root_comment_id) ||
    !positiveId(envelope.reply_id) ||
    !Array.isArray(envelope.comments)
  ) {
    return null;
  }

  const comments = new Map<number, UntrustedComment>();
  for (const entry of envelope.comments) {
    const comment = object(entry);
    const user = object(comment?.user);
    const parent = comment?.in_reply_to_id === undefined ? null : comment.in_reply_to_id;
    if (
      !positiveId(comment?.id) ||
      !(parent === null || positiveId(parent)) ||
      !positiveId(user?.id) ||
      typeof comment.body !== "string" ||
      comments.has(comment.id)
    ) {
      return null;
    }
    comments.set(comment.id, {
      id: comment.id,
      parent,
      authorId: user.id,
      body: comment.body,
    });
  }

  const root = comments.get(envelope.root_comment_id);
  const reply = comments.get(envelope.reply_id);
  if (root?.parent !== null || reply === undefined || !positiveId(reply.parent)) return null;

  const visited = new Set<number>();
  let current: UntrustedComment = reply;
  while (current.id !== root.id) {
    if (current.parent === null || visited.has(current.id)) return null;
    visited.add(current.id);
    const parent = comments.get(current.parent);
    if (parent === undefined) return null;
    current = parent;
  }

  return [
    repository.id,
    owner.login,
    repository.name,
    envelope.pull_number,
    root.id,
    reply.parent,
    reply.id,
    reply.authorId,
    reply.body,
  ];
}

export function visitUntrustedGitHubReply(
  input: unknown,
  onReply: (
    repositoryId: number,
    owner: string,
    repositoryName: string,
    pullNumber: number,
    rootCommentId: number,
    parentCommentId: number,
    replyCommentId: number,
    authorId: number,
    body: string,
  ) => void,
): boolean {
  let parsed: ParsedReply | null;
  try {
    parsed = parseUntrustedGitHubReply(input);
  } catch {
    return false;
  }
  if (parsed === null) return false;
  onReply(...parsed);
  return true;
}
