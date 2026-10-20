// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** Verdict, patch, and saved delivery projections; section order stays with the facade. */
import { limit } from "../../config/limits.js";
import type { RunRecord } from "../../records/contracts.js";
import type { RunRetainedDeliveryV1 } from "../../records/retained-delivery.js";
import { overallRunStatus } from "../../records/checkout-persistence.js";
import type { ChangedFileEvidence } from "../../impact/contracts.js";
import {
  admittedCreateConversion,
  createConversionPatchNote,
} from "../../workflow-contracts/create-conversion.js";
import {
  admittedKeptUnchangedPages,
  keptUnchangedPatchLine,
} from "../../workflow-contracts/kept-pages.js";
import { type CliVerdictPlanes, type ExecutionStatus } from "../cli-format.js";
import { projectRunProduct, type RunResultPublicationV1 } from "../run-result.js";
import type { RunSummaryContext, RunSummaryPatchFileStat } from "./contracts.js";

function toExecutionStatus(status: RunRecord["status"]): ExecutionStatus {
  switch (status) {
    case "succeeded":
    case "failed":
    case "needs-input":
      return status;
    case "needs-human-decision":
      return "needs-input";
    default:
      return "running";
  }
}

export function formatDeliveryLookupLines(lookup: RunResultPublicationV1): string[] {
  if (lookup.status === "found") {
    return [
      "Status: draft merge request opened",
      `Merge request: ${lookup.mergeRequestUrl}`,
      `Source branch: ${lookup.sourceBranch}`,
      `Head: ${lookup.headRevision}`,
      ...(lookup.disposition === "succeeded" ? [] : [`Receipt disposition: ${lookup.disposition}`]),
    ];
  }
  if (lookup.status === "absent") {
    return [
      `Status: not recorded (${lookup.code})`,
      `No draft merge request is recorded for this run in the run delivery index under ${lookup.checkedRoot}.`,
    ];
  }
  return [`Status: lookup refused (${lookup.code})`, lookup.detail];
}

export function formatRetainedDeliveryLines(retained: RunRetainedDeliveryV1): string[] {
  return [
    retained.status === "retained"
      ? "Retained delivery state:"
      : "Retained delivery state requires inspection.",
    ...retained.worktrees.map((path) => `Preserved worktree: ${path}`),
    ...retained.branches.map((branch) => `Preserved branch: ${branch}`),
    ...retained.keptBranches,
    ...(retained.explanation ? [retained.explanation] : []),
    ...(retained.cleanupPreviewCommand
      ? [`Cleanup preview: ${retained.cleanupPreviewCommand}`]
      : []),
  ];
}

/** Shared footer fields the plain-text status-block projector may reuse. */
export type RunFooterProjectionContext = Pick<RunSummaryContext, "record"> &
  Partial<
    Pick<
      RunSummaryContext,
      | "publication"
      | "patchFileStats"
      | "repositoryPath"
      | "recordPath"
      | "reportServeCommand"
      | "htmlReportPath"
      | "reportUnavailableReason"
      | "markdownReportUnavailableReason"
      | "reviewFindingsProjection"
      | "reviewEvidenceProjection"
      | "editorialDecodeOptions"
      | "history"
    >
  >;

/** Nested VERDICT planes for the job-path footer. */
export function runVerdictPlanes(context: RunFooterProjectionContext): CliVerdictPlanes {
  const { record } = context;
  const planes: CliVerdictPlanes = {
    execution: toExecutionStatus(overallRunStatus(record)),
  };
  const product = projectRunProduct(record, context.editorialDecodeOptions);
  if (product.disposition !== null && product.disposition !== "legacy-no-product-disposition") {
    planes.product = product.disposition;
  }
  if (context.publication?.status === "succeeded" || context.publication?.status === "failed") {
    planes.publication = context.publication.status;
  }
  return planes;
}

/** `path  +N/-M` per file from the patch artifact, capped at `runs.summaryPatchFiles`. */
export function buildPatchSectionLines(context: RunFooterProjectionContext): string[] {
  const files = context.record.changes?.files;
  const statsByPath = new Map((context.patchFileStats ?? []).map((item) => [item.path, item]));
  // Shown on the page's own row, which `--quiet` keeps, so a conversion is never silent.
  const conversion = admittedCreateConversion(context.record);
  const rows =
    files && files.length > 0
      ? files.map((file) => {
          const stat = statsByPath.get(file.path);
          const row = stat ? `${file.path}  +${stat.insertions}/-${stat.deletions}` : file.path;
          return conversion?.path === file.path
            ? `${row}  ${createConversionPatchNote(conversion)}`
            : row;
        })
      : [];
  const shown = rows.slice(0, limit("runs.summaryPatchFiles").value);
  const omitted = rows.length - shown.length;
  const lines = omitted > 0 ? [...shown, `PATCH omitted: ${omitted}`] : shown;
  // Every page the plan kept unchanged, which `--quiet` keeps too, so a page
  // the request named and the plan kept is never silent.
  const kept = admittedKeptUnchangedPages(context.record);
  if (kept.length > 0) lines.push(keptUnchangedPatchLine(kept));
  if (
    context.publication?.status === "failed" &&
    context.publication.failureCode === "publication-not-attempted" &&
    !patchListsDocumentationFiles(files)
  ) {
    lines.push("No documentation files.");
  }
  return lines;
}

function isProjectConfigPath(path: string): boolean {
  return path === ".docsfab.json" || path.startsWith(".docsfab/");
}

function patchListsDocumentationFiles(
  files: readonly Pick<ChangedFileEvidence, "path">[] | undefined,
): boolean {
  return (files ?? []).some((file) => !isProjectConfigPath(file.path));
}

/**
 * Per-file +/- counts from a unified patch, paired positionally with `files`
 * (same collector, same path filters). `undefined` on a count mismatch so
 * callers show a plain file list rather than wrong counts.
 */
export function parsePatchFileStats(
  patchText: string,
  files: readonly Pick<ChangedFileEvidence, "path">[],
): readonly RunSummaryPatchFileStat[] | undefined {
  const blocks: string[][] = [];
  for (const line of patchText.split("\n")) {
    if (line.startsWith("diff --git ")) {
      blocks.push([line]);
      continue;
    }
    if (blocks.length === 0) continue;
    blocks.at(-1)!.push(line);
  }
  if (blocks.length !== files.length) return undefined;
  return blocks.map((block, index) => {
    let insertions = 0;
    let deletions = 0;
    for (const line of block.slice(1)) {
      if (line.startsWith("+++") || line.startsWith("---")) continue;
      if (line.startsWith("+")) insertions += 1;
      else if (line.startsWith("-")) deletions += 1;
    }
    return { path: files[index]!.path, insertions, deletions };
  });
}
