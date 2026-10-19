// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Product outcome projector for catalog `readiness`.
 *
 * Maps exact filesystem observations and verified typed model judgments to
 * findings. A successful model call or free-form summary never proves readiness.
 */

import type { ArtifactReference } from "../artifacts/index.js";
import { validateArtifactReference } from "../artifacts/validate.js";
import { canonicalJson } from "../content-ir/canonical.js";
import { decodeWorkflowSearchEvidence } from "../workflow-contracts/search.js";
import type { RepositoryWorkspace } from "../repository/workspace/contracts.js";
import {
  decodeSourceReadinessAssessment,
  verifySourceReadinessCitations,
  type SourceReadinessAssessment,
} from "./assessment.js";
import { sourceReadinessSearch } from "./workflow.js";
import type { RunRecord } from "../records/contracts.js";
import type {
  WorkflowOutcomeCandidateV1,
  WorkflowOutcomeEvidenceV1,
  WorkflowOutcomeProjector,
} from "../workflow-contracts/contracts.js";
import {
  defaultInconclusiveWorkflowOutcome,
  workflowOutcomeSearchEvidence,
  workflowOutcomeStepEvidence,
} from "../workflow-contracts/outcome.js";

export type ReadinessWorkflowOutcomeErrorCode = "invalid-workflow" | "invalid-record";

/** Contract-style reject when the projector is applied outside readiness. */
export class ReadinessWorkflowOutcomeError extends Error {
  public constructor(public readonly code: ReadinessWorkflowOutcomeErrorCode) {
    super(messageFor(code));
    this.name = "ReadinessWorkflowOutcomeError";
  }
}

function messageFor(code: ReadinessWorkflowOutcomeErrorCode): string {
  switch (code) {
    case "invalid-workflow":
      return "Readiness outcome projector rejects records that are not the readiness workflow.";
    case "invalid-record":
      return "Readiness outcome projector rejects records that cannot be sealed from admitted evidence.";
  }
}

export interface ReadinessCriterionAssessment {
  readonly id: string;
  readonly status: "met" | "unmet" | "unassessed" | "blocked";
  readonly reason: string;
  readonly evidence: Extract<WorkflowOutcomeEvidenceV1, { kind: "search" | "step" }>;
}

/** Evaluate the declared criteria, not the legacy aggregate ANY-probe label. */
export function assessReadinessCriteria(
  record: Readonly<RunRecord>,
  assessment?: SourceReadinessAssessment,
): readonly ReadinessCriterionAssessment[] {
  if (record.workflow !== "readiness") {
    throw new ReadinessWorkflowOutcomeError("invalid-workflow"); // hygiene: ok
  }
  if (record.status !== "succeeded") {
    throw new ReadinessWorkflowOutcomeError("invalid-record"); // hygiene: ok
  }
  const step = record.steps.find(
    (candidate) => candidate.id === "assess-readiness" && candidate.status === "succeeded",
  );
  if (!step?.searchEvidence) return [];
  let admitted;
  try {
    admitted = decodeWorkflowSearchEvidence(
      step.searchEvidence,
      sourceReadinessSearch,
      record.repository,
    );
  } catch {
    throw new ReadinessWorkflowOutcomeError("invalid-record"); // hygiene: ok
  }
  return admitted.searches.flatMap((search): ReadinessCriterionAssessment[] => {
    const target = search.bounded.target;
    // Rubric criteria combine their required probes and, when present, the
    // verified model judgment. Their evidence is the exact step (including
    // summary and search digests), never the legacy ANY-probe aggregate.
    const evidence =
      target.targetType === "artifact-existence"
        ? workflowOutcomeSearchEvidence(record as RunRecord, step.id, target.id)
        : workflowOutcomeStepEvidence(record as RunRecord, step.id);
    const probes = new Map(search.bounded.probes.map((probe) => [probe.id, probe]));
    const unproved = (id: string, required: readonly string[]): ReadinessCriterionAssessment => {
      const relevant = search.bounded.limitations.filter(
        (limitation) =>
          limitation.impact === "blocking" &&
          (limitation.probeIds.length === 0 ||
            limitation.probeIds.some((probe) => required.includes(probe))),
      );
      const blocker = relevant.find(
        (limitation) =>
          limitation.category === "access-denied" ||
          limitation.category === "hard-ceiling" ||
          limitation.category === "tool-failure",
      );
      return {
        id,
        evidence,
        status: blocker ? "blocked" : "unassessed",
        reason: blocker?.category ?? relevant[0]?.category ?? "incomplete-search",
      };
    };
    if (target.targetType === "artifact-existence") {
      if (search.bounded.confidence.disposition === "found")
        return [{ id: target.id, status: "met", reason: "artifact-present", evidence }];
      if (search.bounded.confidence.disposition === "not-found-after-bounded-search")
        return [{ id: target.id, status: "unmet", reason: "artifact-not-found", evidence }];
      return [
        unproved(
          target.id,
          target.requiredProbes.map((probe) => probe.id),
        ),
      ];
    }
    return target.rubric.criteria.map((criterion): ReadinessCriterionAssessment => {
      const model = assessment?.criteria.find((item) => item.criterionId === criterion.id);
      // The model supplies semantic judgment; it cannot erase a real access,
      // tool, or resource failure already observed for that criterion.
      const impediment = unproved(criterion.id, criterion.requiredProbeIds);
      if (model && impediment.status === "blocked") return impediment;
      const required = model
        ? criterion.requiredProbeIds.filter(
            (id) =>
              target.requiredProbes.find((probe) => probe.id === id)?.strategy !==
              "rubric-assessment",
          )
        : criterion.requiredProbeIds;
      const outcomes = required.map((id) => probes.get(id)?.outcome);
      if (model && outcomes.every((outcome) => outcome === "match"))
        return {
          id: criterion.id,
          status: model.status,
          reason: `model-assessed-${model.status}`,
          evidence,
        };
      if (outcomes.every((outcome) => outcome === "match"))
        return { id: criterion.id, status: "met", reason: "required-probes-matched", evidence };
      if (outcomes.every((outcome) => outcome === "match" || outcome === "no-match"))
        return { id: criterion.id, status: "unmet", reason: "required-probe-no-match", evidence };
      return unproved(criterion.id, required);
    });
  });
}

/** Source readiness grants no release, publication or mutation authority. */
export class ReadinessWorkflowOutcomeProjector implements WorkflowOutcomeProjector {
  public constructor(private readonly workspace?: RepositoryWorkspace) {}

  public async project(record: Readonly<RunRecord>): Promise<WorkflowOutcomeCandidateV1> {
    // Decode host observations before accepting any model claim. The same
    // opaque workspace used for search independently verifies quoted bytes.
    let criteria = assessReadinessCriteria(record);
    if (this.workspace && criteria.length) {
      const step = record.steps.find(
        (item) => item.id === "assess-readiness" && item.status === "succeeded",
      )!;
      try {
        if (
          record.repository.sourcePath !== this.workspace.sourcePath ||
          record.repository.revision !== this.workspace.revision
        )
          throw new ReadinessWorkflowOutcomeError("invalid-record"); // hygiene: ok
        const assessment = decodeSourceReadinessAssessment(step.summary ?? "", {
          runId: record.id,
          repositoryRevision: record.repository.revision,
          searchEvidenceSha256: step.searchEvidence!.evidenceSha256,
          contextPacketSha256: step.contextPreflight?.packetDigest ?? null,
        });
        await verifySourceReadinessCitations(assessment, this.workspace);
        criteria = assessReadinessCriteria(record, assessment);
      } catch {
        throw new ReadinessWorkflowOutcomeError("invalid-record"); // hygiene: ok
      }
    }
    if (criteria.length === 0) return defaultInconclusiveWorkflowOutcome(record as RunRecord);
    const blocked = criteria.filter((item) => item.status === "blocked");
    const unmet = criteria.filter((item) => item.status === "unmet");
    const unknown = criteria.filter((item) => item.status === "unassessed");
    // Met criteria remain in exact retained search evidence. Findings describe
    // only exceptions, so finding an artifact is never itself a product gap.
    const reported = criteria.filter((item) => item.status !== "met");
    const evidence = [
      ...new Map(
        (reported.length ? reported : criteria).map((item) => [item.evidence.id, item.evidence]),
      ).values(),
    ];
    return {
      disposition: blocked.length
        ? "blocked"
        : unmet.length
          ? "not-ready"
          : unknown.length
            ? "inconclusive"
            : "ready",
      findings: reported.map((item) => ({
        id: `finding:readiness:${item.id}`,
        kind:
          item.status === "blocked"
            ? "blocked-dependency"
            : item.status === "unmet"
              ? "product-gap"
              : "evidence-limitation",
        severity: item.status === "unassessed" ? "warning" : "blocking",
        code: `readiness-${item.id}-${item.reason}`,
        evidenceIds: [item.evidence.id],
      })),
      evidence,
      limitations: unknown.map((item) => `readiness-${item.id}-${item.reason}`),
      openDecisions: blocked.map((item) => ({
        id: `decision:readiness:${item.id}`,
        kind: "dependency",
        evidenceIds: [item.evidence.id],
      })),
      producedArtifacts: recordOutputArtifacts(record as RunRecord),
    };
  }
}

function recordOutputArtifacts(record: RunRecord): ArtifactReference[] {
  const output: ArtifactReference[] = [];
  for (const use of record.artifacts ?? []) {
    if (
      use.role !== "output" ||
      output.some((item) => canonicalJson(item) === canonicalJson(use.reference))
    ) {
      continue;
    }
    try {
      output.push(validateArtifactReference(use.reference));
    } catch {
      throw new ReadinessWorkflowOutcomeError("invalid-record"); // hygiene: ok
    }
  }
  return output.sort((left, right) => canonicalJson(left).localeCompare(canonicalJson(right)));
}
