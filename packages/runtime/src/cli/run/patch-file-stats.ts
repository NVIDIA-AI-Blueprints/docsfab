// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import type { RunRecord } from "../../records/contracts.js";
import { limit } from "../../config/limits.js";
import { parsePatchFileStats, type RunSummaryPatchFileStat } from "../../operator/run-summary.js";

// Patch readers share the capture bound, so every patch the run can capture is readable.
const PATCH_BYTES_LIMIT = "repository.evidenceGitOutputMaxBytes";

/**
 * Best-effort per-file +/- stats for the PATCH section, read and verified
 * against the durable patch artifact. Presentation only: any mismatch or
 * read failure degrades to `undefined`, and callers fall back to a plain
 * file list rather than showing wrong or stale counts.
 */
export async function readPatchFileStats(
  record: RunRecord,
): Promise<readonly RunSummaryPatchFileStat[] | undefined> {
  const patch = record.changes?.patch;
  const files = record.changes?.files;
  if (!patch || !files || patch.byteLength > limit(PATCH_BYTES_LIMIT).value) return undefined;
  try {
    const bytes = await readFile(patch.artifactPath);
    if (bytes.byteLength !== patch.byteLength) return undefined;
    if (createHash("sha256").update(bytes).digest("hex") !== patch.sha256) return undefined;
    return parsePatchFileStats(bytes.toString("utf8"), files);
  } catch {
    return undefined;
  }
}
