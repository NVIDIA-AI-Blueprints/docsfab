// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Maps in-process ProgressEvent values onto the host observe append DTO and
 * composes an injected append port.
 *
 * Runtime-owned: no host-package import. The sealed object matches the host's
 * `parseHostJobProgressRequest`. `text` and artifact bodies are never copied.
 * Do not wire `workflow-execution/runner.ts` here.
 */

import type { ProgressEvent } from "./contracts.js";

export const HOST_PROGRESS_APPEND_STATUSES = [
  "running",
  "needs-input",
  "needs-human-decision",
] as const;
export type HostProgressAppendStatus = (typeof HOST_PROGRESS_APPEND_STATUSES)[number];

export type HostProgressAppendType = "run-status" | "step-status";

export type HostProgressAppendV1 = {
  requestKey: string;
  type: HostProgressAppendType;
  status: HostProgressAppendStatus;
  runId: string;
  stepId?: string;
};

export type HostProgressMapErrorCode =
  | "invalid-value"
  | "credential-material"
  | "write-grant-rejected";

export class HostProgressMapError extends Error {
  readonly code: HostProgressMapErrorCode;

  constructor(code: HostProgressMapErrorCode) {
    super(`Host progress map rejected: ${code}.`);
    this.name = "HostProgressMapError";
    this.code = code;
  }
}

const IDENTIFIER_MAX = 127;
const SAFE_IDENTIFIER = new RegExp(`^[A-Za-z0-9][A-Za-z0-9._:/-]{0,${IDENTIFIER_MAX}}$`, "u");
const GRANT_SHAPE =
  /(?:^|[^A-Za-z0-9_-])(?:--allow-write|--allow-publish|allowWrite|allowPublish|writeGrant|publishGrant)(?:$|[^A-Za-z0-9_-])/u;
const CREDENTIAL_SHAPES = [
  /\b(?:glpat|gldt|glrt|glptt)-[A-Za-z0-9_-]{20,}\b/u,
  /\b(?:gh[pousr]_|github_pat_)[A-Za-z0-9_]{20,}\b/u,
  /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/u,
  /\bnvapi-[A-Za-z0-9_-]{20,}\b/u,
  /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/u,
];
const URL_SHAPE = /https?:\/\//iu;
const HOST_PATH_SHAPE = /(?:^|[\\/])(?:Users|home|root)[\\/]/u;
const PATCH_SHAPES = [/^diff --git /mu, /^\+\+\+ [ab]\//mu];

/** The host binds this to `spine.progress`. */
export type HostProgressAppendPort = (dto: HostProgressAppendV1) => Promise<void> | void;

/** Calls the injected append only for events that map to a host progress status. */
export function createHostedRunProgressAppend(
  requestKey: string,
  append: HostProgressAppendPort,
): (event: ProgressEvent) => Promise<HostProgressAppendV1 | null> {
  return async (event) => appendHostedRunProgress(requestKey, event, append);
}

export async function appendHostedRunProgress(
  requestKey: string,
  event: ProgressEvent,
  append: HostProgressAppendPort,
): Promise<HostProgressAppendV1 | null> {
  const dto = mapProgressEventToHostAppend(requestKey, event);
  if (dto === null) return null;
  await append(dto);
  return dto;
}

export async function appendHostedRunProgressEvents(
  requestKey: string,
  events: readonly ProgressEvent[],
  append: HostProgressAppendPort,
): Promise<readonly HostProgressAppendV1[]> {
  const appended: HostProgressAppendV1[] = [];
  for (const event of events) {
    const dto = await appendHostedRunProgress(requestKey, event, append);
    if (dto !== null) appended.push(dto);
  }
  return Object.freeze(appended);
}

export function mapProgressEventToHostAppend(
  requestKey: string,
  event: ProgressEvent,
): HostProgressAppendV1 | null {
  const key = requireSafeIdentifier(requestKey);
  if (!event || typeof event !== "object") fail("invalid-value");
  const runId = requireSafeIdentifier(event.runId);
  if (event.type === "text" || event.type === "artifact-reference") {
    if (event.stepId !== undefined) requireSafeIdentifier(event.stepId);
    return null;
  }
  if (event.type !== "run-status" && event.type !== "step-status") fail("invalid-value");
  if (!isHostProgressStatus(event.status)) return null;
  if (event.type === "run-status") {
    return freezeAppend({ requestKey: key, type: "run-status", status: event.status, runId });
  }
  return freezeAppend({
    requestKey: key,
    type: "step-status",
    status: event.status,
    runId,
    stepId: requireSafeIdentifier(event.stepId),
  });
}

function isHostProgressStatus(status: string): status is HostProgressAppendStatus {
  return (HOST_PROGRESS_APPEND_STATUSES as readonly string[]).includes(status);
}

function freezeAppend(value: HostProgressAppendV1): HostProgressAppendV1 {
  return Object.freeze(value);
}

function requireSafeIdentifier(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) fail("invalid-value");
  rejectUnsafeString(value);
  if (!SAFE_IDENTIFIER.test(value)) fail("invalid-value");
  return value;
}

function rejectUnsafeString(value: string): void {
  if (CREDENTIAL_SHAPES.some((pattern) => pattern.test(value))) fail("credential-material");
  if (GRANT_SHAPE.test(value)) fail("write-grant-rejected");
  if (
    URL_SHAPE.test(value) ||
    HOST_PATH_SHAPE.test(value) ||
    PATCH_SHAPES.some((p) => p.test(value))
  ) {
    fail("invalid-value");
  }
}

function fail(code: HostProgressMapErrorCode): never {
  throw new HostProgressMapError(code);
}
