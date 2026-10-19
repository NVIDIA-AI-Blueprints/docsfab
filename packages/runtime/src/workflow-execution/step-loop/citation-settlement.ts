// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** Post-write source citations are settled only after a succeeded write. */
import { sourceClaimMinWords } from "../../config/source-citation-limits.js";
import type { SourceRunCapabilityV1 } from "../../inputs/source-resolver.js";
import {
  SourceCitationLedgerError,
  sourceDocumentationCitationCoverage,
  sourceDocumentationClaims,
  verifySourceSpanCitations,
  type SourceDocumentationPageV1,
} from "../../inputs/source-evidence-artifacts.js";
import type { RunRecord } from "../../records/contracts.js";
import { compareText } from "../runner-ports.js";
import { readPlannedPageTexts } from "./plan-admission.js";

export async function settleStepSourceCitations(input: {
  readonly pagePaths: readonly string[] | undefined;
  readonly capability: SourceRunCapabilityV1 | undefined;
  readonly outcome: "succeeded" | "needs-input" | "needs-human-decision";
  readonly workspacePath: string;
  readonly stepId: string;
  readonly pagesBeforeWrite: ReadonlyMap<string, string | null> | undefined;
  readonly record: RunRecord;
  /** Host-applied RST prose span; only this edit contributes material claims. */
  readonly rstProseEdit?: Readonly<{
    path: string;
    before: string;
    after: string;
    lineOffset: number;
  }>;
}): Promise<void> {
  const {
    pagePaths,
    capability,
    outcome,
    workspacePath,
    stepId,
    pagesBeforeWrite,
    record,
    rstProseEdit,
  } = input;
  // Citation coverage. It engages exactly when this write step held a live
  // citer, and it judges documentation only: each sentence of at least
  // `sources.claimMinWords` words the step added to a planned page, never the
  // step's own status reply. A claim with no accepted citation from this step
  // is recorded by location and the write is kept; the product outcome labels
  // it `source-citation-gaps`. Reads count run-wide; citations are per step, so
  // one write step cannot lean on another's.
  if (pagePaths && capability && outcome === "succeeded") {
    const pagesAfterWrite = await readPlannedPageTexts(workspacePath, pagePaths, stepId);
    const claims = sourceDocumentationClaims({
      pages: rstProseEdit
        ? [{ path: rstProseEdit.path, before: rstProseEdit.before, after: rstProseEdit.after }]
        : pagePaths.map(
            (path): SourceDocumentationPageV1 => ({
              path,
              before: pagesBeforeWrite?.get(path) ?? null,
              after: pagesAfterWrite.get(path) ?? null,
            }),
          ),
      minWords: sourceClaimMinWords(),
    }).map((claim) =>
      rstProseEdit ? { ...claim, line: claim.line + rstProseEdit.lineOffset } : claim,
    );
    const spanCitations = capability.spanCitationsFor(stepId);
    const { uncited } = sourceDocumentationCitationCoverage({ claims, spanCitations });
    // Defence in depth: the verifier re-checks every recorded citation against
    // the run's access ledger. It reads the same ledger as the screen that
    // minted them, so a diagnostic here is a host defect, not a model one. An
    // uncited claim is the label above, so no claim is passed to it.
    const residual = verifySourceSpanCitations({
      binding: capability.binding,
      observations: capability.observations,
      spanAccesses: capability.spanAccesses(),
      spanCitations,
      materialClaimSha256s: [],
    });
    if (residual.length > 0) {
      throw new SourceCitationLedgerError({
        stepId: stepId,
        codes: residual.map((entry) => entry.code),
      });
    }
    const priorSteps = record.sourceCitations?.steps ?? [];
    record.sourceCitations = {
      schemaVersion: 1,
      kind: "docsfab-source-run-citations",
      bindingSha256: capability.binding.bindingSha256,
      steps: [
        ...priorSteps.filter((entry) => entry.stepId !== stepId),
        {
          stepId: stepId,
          materialClaimSha256s: [...new Set(claims.map((claim) => claim.claimSha256))].sort(
            compareText,
          ),
          citations: [...spanCitations],
          ...(uncited.length > 0
            ? {
                uncitedClaims: uncited.map(({ path, line, claimSha256 }) => ({
                  path,
                  line,
                  claimSha256,
                })),
              }
            : {}),
        },
      ],
    };
  }
}
