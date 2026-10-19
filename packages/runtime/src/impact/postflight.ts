// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  buildContentIndex,
  canonicalDigest,
  contentIndexLimitations,
  describeContentIndexLimitation,
  type ContentIndexLimitation,
  type ContentIndexV1,
} from "../content-ir/index.js";
import {
  WRITTEN_PAGE_ANCHOR_WARNING_CODE,
  type ImpactPostflightContext,
  type ImpactPostflightResult,
  type ImpactPostflightService,
} from "./contracts.js";
import { analyzeDocumentationImpact } from "./analyze.js";
import { DEFAULT_HEALING_POLICY } from "./policy.js";

/**
 * Production postflight for a single disposable workspace. The baseline is
 * copied at construction so callers cannot replace the exact pre-mutation
 * state while a write is running.
 */
export class LocalImpactPostflightService implements ImpactPostflightService {
  private readonly before: ContentIndexV1;
  /** The baseline's anchor problems; the clone below drops the index's limitations. */
  private readonly beforeAnchorProblems: ReadonlyMap<string, number>;
  private readonly includePaths: readonly string[] | undefined;
  private readonly trackedAliasPaths: readonly string[] | undefined;

  /** `options` must match the ones the baseline was built with. */
  public constructor(
    before: ContentIndexV1,
    options: {
      readonly includePaths?: readonly string[];
      readonly trackedAliasPaths?: readonly string[];
    } = {},
  ) {
    this.beforeAnchorProblems = countAnchorProblems(contentIndexLimitations(before));
    this.before = structuredClone(before);
    this.includePaths = options.includePaths;
    this.trackedAliasPaths = options.trackedAliasPaths;
  }

  public async postflight(input: ImpactPostflightContext): Promise<ImpactPostflightResult> {
    if (input.repository.revision !== this.before.repository.revision) {
      throw new Error("Impact postflight baseline revision does not match the run.");
    }
    const after = await buildContentIndex({
      repositoryPath: input.workspacePath,
      repositoryRevision: input.repository.revision,
      ...(this.includePaths ? { includePaths: this.includePaths } : {}),
      ...(this.trackedAliasPaths ? { trackedAliasPaths: this.trackedAliasPaths } : {}),
    });
    this.reportWrittenAnchorProblems(after, input);
    if (input.changedFiles.length === 0 && after.indexDigest === this.before.indexDigest) {
      return { schemaVersion: 1, status: "no-change" };
    }
    const changedPaths = new Set<string>();
    for (const file of input.changedFiles) {
      changedPaths.add(file.path);
      if (file.previousPath !== undefined) changedPaths.add(file.previousPath);
    }
    if (after.indexDigest === this.before.indexDigest) {
      return {
        schemaVersion: 1,
        status: "completed",
        analysisDigest: canonicalDigest({
          beforeIndexDigest: this.before.indexDigest,
          afterIndexDigest: after.indexDigest,
          changedFiles: input.changedFiles,
          policyDigest: DEFAULT_HEALING_POLICY.digest,
        }),
        changedPaths: [...changedPaths].sort(),
      };
    }
    const analysis = analyzeDocumentationImpact({
      mode: "incremental",
      before: this.before,
      after,
      policy: {
        id: DEFAULT_HEALING_POLICY.id,
        version: DEFAULT_HEALING_POLICY.version,
        digest: DEFAULT_HEALING_POLICY.digest,
      },
    });
    for (const path of analysis.changedPaths) changedPaths.add(path);
    // The content index intentionally ignores repository navigation/configuration
    // files (for example fern/versions/nightly.yml). Include every source-bound
    // mutation so the publication contract sees the complete patch. Rename and
    // copy evidence contributes both sides of the move.
    for (const file of input.changedFiles) {
      changedPaths.add(file.path);
      if (file.previousPath !== undefined) changedPaths.add(file.previousPath);
    }
    return {
      schemaVersion: 1,
      status: "completed",
      analysisDigest: analysis.digest,
      changedPaths: [...changedPaths].sort(),
    };
  }

  /**
   * Names each anchor problem the run wrote into a changed page: one the
   * baseline did not have, by page and code, since edits move line numbers.
   * It is reported, never a stop, because the model has already run.
   */
  private reportWrittenAnchorProblems(after: ContentIndexV1, input: ImpactPostflightContext): void {
    if (!input.recordWarning) return;
    const changed = new Set<string>();
    for (const file of input.changedFiles) changed.add(file.path);
    const written = contentIndexLimitations(after).filter(
      (limitation) => isAnchorProblem(limitation) && changed.has(limitation.path),
    );
    const afterCounts = countAnchorProblems(written);
    for (const limitation of written) {
      const key = anchorProblemKey(limitation);
      if ((afterCounts.get(key) ?? 0) <= (this.beforeAnchorProblems.get(key) ?? 0)) continue;
      input.recordWarning(writtenAnchorWarning(limitation));
    }
  }
}

function isAnchorProblem(limitation: ContentIndexLimitation): boolean {
  return limitation.reason === "empty-page-anchor" || limitation.reason === "duplicate-page-anchor";
}

function anchorProblemKey(limitation: ContentIndexLimitation): string {
  return `${limitation.path}\0${limitation.reason}`;
}

function countAnchorProblems(
  limitations: readonly ContentIndexLimitation[],
): ReadonlyMap<string, number> {
  const counts = new Map<string, number>();
  for (const limitation of limitations) {
    if (!isAnchorProblem(limitation)) continue;
    const key = anchorProblemKey(limitation);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

/** One run-record warning, within the record's 1,024-character warning bound. */
function writtenAnchorWarning(limitation: ContentIndexLimitation): string {
  const full = `${WRITTEN_PAGE_ANCHOR_WARNING_CODE}: ${describeContentIndexLimitation(limitation)} The run wrote this page; fix the line before the change merges.`;
  if (full.length <= 1_024) return full;
  return `${WRITTEN_PAGE_ANCHOR_WARNING_CODE}: the run wrote ${limitation.reason} at line ${limitation.line ?? 0} of a page whose path is too long to show here; fix that line before the change merges.`;
}
