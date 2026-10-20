// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { isAbsolute } from "node:path";

import type { RunRecord } from "../records/contracts.js";
import { redactCredentialMaterial } from "../security/credential-material.js";
import {
  pushIndentedBody,
  pushSectionHeader,
  weakestCliVerdictColor,
  type CliFormatOptions,
} from "./cli-format.js";
import {
  buildPatchSectionLines,
  buildRunHumanNextCommand,
  buildRunVerdictLines,
  runVerdictPlanes,
  type RunSummaryPatchFileStat,
  type RunSummaryPublicationOutcome,
} from "./run-summary.js";

/** Forced pipe/CI shape: MR notes and Slack consume words, never ANSI. */
const PLAIN: CliFormatOptions = { tty: false, noColor: true, ci: true };

/**
 * Portable footer input. Omits CLI-only locators (`recordPath`,
 * `repositoryPath`) so Slack and MR notes cannot echo host paths.
 */
export interface StatusBlockInput {
  readonly record: RunRecord;
  readonly publication?: RunSummaryPublicationOutcome;
  readonly patchFileStats?: readonly RunSummaryPatchFileStat[];
}

/**
 * Plain-text status block: VERDICT, NEXT and PATCH when present, and RECORD as
 * the run id, not a filesystem path. No ANSI, credentials, or host paths.
 */
export function projectStatusBlock(input: StatusBlockInput): string {
  return projectStatusBlockLines(input).join("\n");
}

export function projectStatusBlockLines(input: StatusBlockInput): string[] {
  const record = withPortableChangeFiles(input.record);
  const patchFileStats = input.patchFileStats?.filter((item) => isPortableRepoPath(item.path));
  const lines: string[] = [];
  pushSectionHeader(lines, "VERDICT", PLAIN, {
    color: weakestCliVerdictColor(runVerdictPlanes({ record, publication: input.publication })),
  });
  pushIndentedBody(lines, buildRunVerdictLines({ record, publication: input.publication }, PLAIN));

  const next = buildRunHumanNextCommand({ record, publication: input.publication });
  if (next) {
    pushSectionHeader(lines, "NEXT", PLAIN);
    pushIndentedBody(lines, [next.command, `Reason: ${next.reason}`]);
  }

  const patchLines = buildPatchSectionLines({
    record,
    publication: input.publication,
    ...(patchFileStats && patchFileStats.length > 0 ? { patchFileStats } : {}),
  });
  if (patchLines.length > 0) {
    pushSectionHeader(lines, "PATCH", PLAIN);
    pushIndentedBody(lines, patchLines);
  }

  pushSectionHeader(lines, "RECORD", PLAIN);
  pushIndentedBody(lines, [`run ${record.id}`]);
  return lines.map((line) => redactCredentialMaterial(line));
}

function isPortableRepoPath(value: string): boolean {
  return value.length > 0 && !isAbsolute(value);
}

function withPortableChangeFiles(record: RunRecord): RunRecord {
  const files = record.changes?.files;
  if (!files || !record.changes) return record;
  const portable = files.filter((file) => isPortableRepoPath(file.path));
  if (portable.length === files.length) return record;
  return { ...record, changes: { ...record.changes, files: portable } };
}
