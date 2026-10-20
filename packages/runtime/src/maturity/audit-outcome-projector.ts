// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Product outcome projector for catalog `audit`.
 *
 * Maps admitted step/search evidence to findings. Never parses the model
 * summary and never infers `ready` from a successful model call.
 */

import type { ArtifactReference } from "../artifacts/index.js";
import { validateArtifactReference } from "../artifacts/validate.js";
import { canonicalJson } from "../content-ir/canonical.js";
import type { RunRecord, ToolFailureDisposition } from "../records/contracts.js";
import { NON_MATERIAL_TOOL_FAILURE_CATEGORIES } from "../records/contracts.js";
import type {
  WorkflowOutcomeCandidateV1,
  WorkflowOutcomeEvidenceV1,
  WorkflowOutcomeProjector,
} from "../workflow-contracts/contracts.js";
import {
  defaultInconclusiveWorkflowOutcome,
  EXPECTED_WITHHELD_TOOL_LIMITATION,
  workflowOutcomeSearchEvidence,
  workflowOutcomeStepEvidence,
} from "../workflow-contracts/outcome.js";

export type AuditWorkflowOutcomeErrorCode = "invalid-workflow" | "invalid-record";

/** Contract-style reject when the projector is applied outside audit. */
export class AuditWorkflowOutcomeError extends Error {
  public constructor(public readonly code: AuditWorkflowOutcomeErrorCode) {
    super(messageFor(code));
    this.name = "AuditWorkflowOutcomeError";
  }
}

function messageFor(code: AuditWorkflowOutcomeErrorCode): string {
  switch (code) {
    case "invalid-workflow":
      return "Audit outcome projector rejects records that are not the audit workflow.";
    case "invalid-record":
      return "Audit outcome projector rejects records that cannot be sealed from admitted evidence.";
  }
}

const INCOMPLETE_DISPOSITIONS = new Set(["search-incomplete", "stopped-no-progress"]);
const BLOCKED_DISPOSITIONS = new Set(["search-blocked", "stopped-hard-ceiling"]);
const PRODUCT_DISPOSITIONS = new Set(["found", "not-found-after-bounded-search"]);
export const AUDIT_RUBRIC_EVIDENCE_LIMITATION = "audit-rubric-evidence-limited";

/** Material tool evidence prevented the audit from supporting a product disposition. */
export const AUDIT_TOOL_EVIDENCE_LIMITATION = "audit-tool-evidence-limited";

interface AdmittedSearch {
  targetId: string;
  disposition: string;
  rubricEvidenceLimited: boolean;
  evidence: Extract<WorkflowOutcomeEvidenceV1, { kind: "search" }>;
}

export class AuditWorkflowOutcomeProjector implements WorkflowOutcomeProjector {
  public async project(record: Readonly<RunRecord>): Promise<WorkflowOutcomeCandidateV1> {
    if (record.workflow !== "review-documentation") {
      throw new AuditWorkflowOutcomeError("invalid-workflow"); // hygiene: ok
    }
    if (record.status !== "succeeded") {
      throw new AuditWorkflowOutcomeError("invalid-record"); // hygiene: ok
    }

    const terminal = [...record.steps].reverse().find((step) => step.status === "succeeded");
    if (!terminal) return defaultInconclusiveWorkflowOutcome(record as RunRecord);

    const admitted = admittedSearches(record as RunRecord, terminal.id);
    const blocked = admitted.filter(
      (item) => !item.rubricEvidenceLimited && BLOCKED_DISPOSITIONS.has(item.disposition),
    );
    const incomplete = admitted.filter(
      (item) => item.rubricEvidenceLimited || INCOMPLETE_DISPOSITIONS.has(item.disposition),
    );
    const product = admitted.filter(
      (item) => !item.rubricEvidenceLimited && PRODUCT_DISPOSITIONS.has(item.disposition),
    );
    const artifacts = recordOutputArtifacts(record as RunRecord);
    const toolLimitation = materialToolLimitation(record as RunRecord);

    if (blocked.length > 0) {
      const evidence = appendToolLimitationEvidence(
        blocked.map((item) => item.evidence),
        toolLimitation,
      );
      return {
        disposition: "blocked",
        findings: [
          ...blocked.map((item) => ({
            id: `finding:audit:${item.targetId}`,
            kind: "blocked-dependency" as const,
            severity: "blocking" as const,
            code: "audit-search-blocked",
            evidenceIds: [item.evidence.id],
          })),
          ...toolLimitationFindings(toolLimitation),
        ],
        evidence,
        limitations: toolLimitation ? [AUDIT_TOOL_EVIDENCE_LIMITATION] : [],
        openDecisions: blocked.map((item) => ({
          id: `decision:audit:${item.targetId}`,
          kind: "dependency",
          evidenceIds: [item.evidence.id],
        })),
        producedArtifacts: artifacts,
      };
    }

    if (incomplete.length > 0) {
      const evidence = appendToolLimitationEvidence(
        incomplete.map((item) =>
          item.rubricEvidenceLimited
            ? workflowOutcomeStepEvidence(record as RunRecord, terminal.id)
            : item.evidence,
        ),
        toolLimitation,
      );
      return {
        disposition: "inconclusive",
        findings: [
          ...incomplete.map((item) => ({
            id: `finding:audit:${item.targetId}`,
            kind: "evidence-limitation" as const,
            severity: "warning" as const,
            code: item.rubricEvidenceLimited
              ? AUDIT_RUBRIC_EVIDENCE_LIMITATION
              : "audit-search-incomplete",
            evidenceIds: [item.rubricEvidenceLimited ? `step:${terminal.id}` : item.evidence.id],
          })),
          ...toolLimitationFindings(toolLimitation),
        ],
        evidence,
        limitations: [
          ...new Set(
            incomplete.map((item) =>
              item.rubricEvidenceLimited
                ? AUDIT_RUBRIC_EVIDENCE_LIMITATION
                : "audit-search-incomplete",
            ),
          ),
          ...(toolLimitation ? [AUDIT_TOOL_EVIDENCE_LIMITATION] : []),
        ],
        openDecisions: [],
        producedArtifacts: artifacts,
      };
    }

    if (toolLimitation) {
      return {
        disposition: "inconclusive",
        findings: toolLimitationFindings(toolLimitation),
        evidence: toolLimitation.evidence,
        limitations: [AUDIT_TOOL_EVIDENCE_LIMITATION],
        openDecisions: [],
        producedArtifacts: artifacts,
      };
    }

    if (product.length === 0) {
      return defaultInconclusiveWorkflowOutcome(record as RunRecord);
    }

    const evidence: WorkflowOutcomeEvidenceV1[] = product.map((item) => item.evidence);
    const withheld = expectedWithheldToolLimitation(record as RunRecord);
    if (withheld) {
      evidence.push(...withheld.evidence);
    }
    return {
      disposition: "not-ready",
      findings: [
        ...product.map((item) => ({
          id: `finding:audit:${item.targetId}`,
          kind: "product-gap" as const,
          severity: "blocking" as const,
          code: "audit-documentation-gap",
          evidenceIds: [item.evidence.id],
        })),
        ...(withheld
          ? [
              {
                id: `finding:audit:${EXPECTED_WITHHELD_TOOL_LIMITATION}`,
                kind: "evidence-limitation" as const,
                severity: "warning" as const,
                code: EXPECTED_WITHHELD_TOOL_LIMITATION,
                evidenceIds: withheld.evidence.map((item) => item.id),
              },
            ]
          : []),
      ],
      evidence,
      limitations: withheld ? [EXPECTED_WITHHELD_TOOL_LIMITATION] : [],
      openDecisions: [],
      producedArtifacts: artifacts,
    };
  }
}

interface MaterialToolLimitation {
  evidence: Extract<WorkflowOutcomeEvidenceV1, { kind: "step" }>[];
}

function materialToolLimitation(record: RunRecord): MaterialToolLimitation | undefined {
  const affectedSteps = record.steps.filter((step) =>
    (step.tools?.failureCategories ?? []).some((entry) =>
      isMaterialToolFailure(entry.category, record, step),
    ),
  );
  if (affectedSteps.length === 0) return undefined;
  return {
    evidence: affectedSteps.map((step) => workflowOutcomeStepEvidence(record, step.id)),
  };
}

function isMaterialToolFailure(
  category: ToolFailureDisposition,
  record: RunRecord,
  step: RunRecord["steps"][number],
): boolean {
  if (NON_MATERIAL_TOOL_FAILURE_CATEGORIES.includes(category) || category === "governance-stop") {
    return false;
  }
  if (
    (category === "denied-path" || category === "unknown-tool") &&
    licensesWithheldBash(record, step)
  ) {
    return false;
  }
  return true;
}

function licensesWithheldBash(record: RunRecord, step: RunRecord["steps"][number]): boolean {
  if (record.steps.some((item) => item.mode !== "read-only") || step.mode !== "read-only") {
    return false;
  }
  const withheld = step.skillEvidence?.toolPolicy?.withheld ?? [];
  if (!withheld.some((tool) => /^bash(?:\(|$)/iu.test(tool))) return false;
  const failedTools = (step.tools?.byTool ?? []).filter((entry) => entry.failures > 0);
  return failedTools.length > 0 && failedTools.every((entry) => /^bash$/iu.test(entry.name));
}

function toolLimitationFindings(toolLimitation: MaterialToolLimitation | undefined) {
  return toolLimitation
    ? [
        {
          id: `finding:audit:${AUDIT_TOOL_EVIDENCE_LIMITATION}`,
          kind: "evidence-limitation" as const,
          severity: "warning" as const,
          code: AUDIT_TOOL_EVIDENCE_LIMITATION,
          evidenceIds: toolLimitation.evidence.map((item) => item.id),
        },
      ]
    : [];
}

function appendToolLimitationEvidence(
  evidence: WorkflowOutcomeEvidenceV1[],
  toolLimitation: MaterialToolLimitation | undefined,
): WorkflowOutcomeEvidenceV1[] {
  if (!toolLimitation) return evidence;
  const seen = new Set(evidence.map((item) => item.id));
  return [
    ...evidence,
    ...toolLimitation.evidence.filter((item) => {
      if (seen.has(item.id)) return false;
      seen.add(item.id);
      return true;
    }),
  ];
}

function admittedSearches(record: RunRecord, stepId: string): AdmittedSearch[] {
  const step = record.steps.find((candidate) => candidate.id === stepId);
  const searches = step?.searchEvidence?.searches ?? [];
  const admitted: AdmittedSearch[] = [];
  for (const search of searches) {
    const disposition = search.bounded.confidence.disposition;
    const rubricEvidenceLimited =
      search.bounded.target.targetType === "rubric-coverage" &&
      search.bounded.coverage.sufficient === false;
    try {
      admitted.push({
        targetId: search.targetId,
        disposition,
        rubricEvidenceLimited,
        evidence: workflowOutcomeSearchEvidence(record, stepId, search.targetId),
      });
    } catch {
      // Unbindable search rows are ignored; leftover limitation uses step evidence.
    }
  }
  return admitted;
}

function expectedWithheldToolLimitation(
  record: RunRecord,
): { evidence: Extract<WorkflowOutcomeEvidenceV1, { kind: "step" }>[] } | undefined {
  if (record.steps.some((step) => step.mode !== "read-only")) return undefined;
  const aggregateCategories = new Set(
    (record.tools.failureCategories ?? []).map((entry) => entry.category),
  );
  if (
    [...aggregateCategories].some(
      (category) =>
        !NON_MATERIAL_TOOL_FAILURE_CATEGORIES.includes(category) &&
        category !== "governance-stop" &&
        category !== "denied-path" &&
        category !== "unknown-tool",
    )
  ) {
    return undefined;
  }
  const affectedSteps = record.steps.filter((step) => {
    const categories = (step.tools?.failureCategories ?? []).map((entry) => entry.category);
    return categories.some((category) => {
      if (category === "governance-stop") return true;
      if (category === "denied-path" || category === "unknown-tool") {
        return licensesWithheldBash(record, step);
      }
      return false;
    });
  });
  if (affectedSteps.length === 0) return undefined;
  if (
    record.steps.some((step) =>
      (step.tools?.failureCategories ?? []).some((entry) =>
        isMaterialToolFailure(entry.category, record, step),
      ),
    )
  ) {
    return undefined;
  }
  return {
    evidence: affectedSteps.map((step) => workflowOutcomeStepEvidence(record, step.id)),
  };
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
      throw new AuditWorkflowOutcomeError("invalid-record"); // hygiene: ok
    }
  }
  return output.sort((left, right) => canonicalJson(left).localeCompare(canonicalJson(right)));
}
