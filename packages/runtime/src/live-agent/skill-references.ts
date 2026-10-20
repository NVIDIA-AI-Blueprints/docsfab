// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** Reader-context projection policy for the locked documentation skills. */

import { ReaderTaskAdmissionObservationError } from "../execution/reader-task-admission-failure.js";
import { ReaderTaskContextError } from "../execution/task-context.js";

export const LIVE_SKILL_FAILURES = {
  missingContext:
    "DocsFab direct reader evidence requests require an explicit bounded reader context.",
  readOnly: "DocsFab reader-impact direct assessment requires a read-only live-agent session.",
  unavailable: "DocsFab reader-impact observation is unavailable in this live-agent session.",
  snapshotMismatch:
    "DocsFab refused the reader-evidence handoff because the comparison or workspace snapshot no longer matches. No patch was generated.",
} as const;

function isLiveReaderSnapshotMismatchCause(error: unknown): boolean {
  if (error instanceof ReaderTaskContextError) return error.code === "stale";
  if (error instanceof ReaderTaskAdmissionObservationError) {
    return error.code === "identity-mismatch" || error.failure?.reason === "changed-snapshot";
  }
  return false;
}

/** Report snapshot mismatch with the live-agent diagnostic; rethrow any other failure. */
export function rethrowLiveReaderSnapshotMismatch(error: unknown): never {
  if (isLiveReaderSnapshotMismatchCause(error)) {
    throw new Error(LIVE_SKILL_FAILURES.snapshotMismatch);
  }
  throw error;
}
