// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The inner reason a workflow product outcome is refused, and the product-code
 * grammar the editorial assessment admission shares with it.
 *
 * The fixture is one evaluator step whose final editorial limitations include
 * snake_case codes. The authoring projector copies limitations into finding
 * codes, which the outcome admission refuses outside its grammar even after
 * every step succeeded.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { INFERENCE_REJECTION_LOCATION_GRAMMAR } from "../src/config/inference-rejection-limits.js";
import {
  AUTHORING_QUALITY_LIMITATION_CODES,
  AUTHORING_QUALITY_NON_WALL_CODES,
  AuthoringQualityWorkflowOutcomeError,
  type AuthoringQualityWorkflowOutcomeErrorCode,
} from "../src/evaluation-report/authoring-outcome-projector.js";
import {
  AuditWorkflowOutcomeError,
  type AuditWorkflowOutcomeErrorCode,
} from "../src/maturity/audit-outcome-projector.js";
import {
  ReadinessWorkflowOutcomeError,
  type ReadinessWorkflowOutcomeErrorCode,
} from "../src/readiness/outcome-projector.js";
import { READER_CONTEXT_CHANGED_SOURCE_INAPPLICABLE_LIMITATION } from "../src/context/reader-context.js";
import {
  attachRunFailureClassifications,
  classifyInferenceAttempt,
  readRunFailure,
  WORKFLOW_OUTCOME_REJECTION_FAILURE_CLASSES,
} from "../src/operator/failure-classification.js";
import { isFailureCode } from "../src/operator/failure-class.js";
import type { RunRecord } from "../src/records/contracts.js";
import { ReleaseDocumentationReadinessError } from "../src/release-documentation-readiness.js";
import { responseCorrectionInstruction } from "../src/harness/response-correction.js";
import {
  EXPECTED_WITHHELD_TOOL_LIMITATION,
  isWorkflowOutcomeCode,
  TOOL_MISSES_RECORDED_LIMITATION,
  WORKFLOW_OUTCOME_CODE_GRAMMAR,
  WorkflowOutcomeError,
  workflowOutcomeStepEvidence,
} from "../src/workflow-contracts/outcome.js";
import type {
  WorkflowOutcomeCandidateV1,
  WorkflowOutcomeProjector,
} from "../src/workflow-contracts/contracts.js";
import { EDITORIAL_LIMITATION_CODE_RULE } from "../src/workflow-execution/editorial-assessment-rule-hints.js";
import {
  decodeEditorialAssessmentProposalV1,
  EDITORIAL_LIMITATION_CODE_REJECTIONS,
  EditorialEvidenceHostError,
} from "../src/workflow-execution/editorial-evidence-host.js";
import {
  readWorkflowOutcomeRejection,
  WORKFLOW_OUTCOME_PROJECTOR_ERROR_CODES,
  WORKFLOW_OUTCOME_REJECTION_CODES,
  workflowOutcomeRejection,
} from "../src/workflow-execution/outcome-rejection.js";
import { applyWorkflowOutcome } from "../src/workflow-execution/runner-evidence.js";
import { workflowOutcomePersistenceError } from "../src/workflow-execution/runner-schedule.js";

const REVISION = "a".repeat(40);
const EVALUATE_STEP_ID = "evaluate-document-quality";

/** A recorded run's final editorial limitations, in the order the projector emitted them. */
const R3_LIMITATIONS = [
  "experimental-quality-profile",
  "insufficient-evidence",
  "audience-prereqs-missing",
  "bounded-code",
  "comparison_unknown",
  "no_audience_evidence",
  "no_runtime_observation",
] as const;

function succeededUpdateRecord(): RunRecord {
  const usage = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    total: 0,
    turns: 0,
  };
  return {
    schemaVersion: 2,
    id: "run-1268-outcome-rejection",
    workflow: "update-documentation",
    repository: {
      sourcePath: "/private/source",
      requestedRevision: "HEAD",
      revision: REVISION,
    },
    workspace: { strategy: "tracked-export", disposable: true },
    status: "succeeded",
    createdAt: "2026-09-24T09:53:49.989Z",
    startedAt: "2026-09-24T09:53:50.009Z",
    completedAt: "2026-09-24T09:55:54.529Z",
    durationMs: 1_000,
    models: [],
    skills: [],
    usage,
    tools: { totalCalls: 0, failedCalls: 0, byTool: [] },
    steps: [
      {
        id: EVALUATE_STEP_ID,
        title: "Evaluate document quality",
        kind: "evaluate",
        skill: EVALUATE_STEP_ID,
        mode: "read-only",
        status: "succeeded",
        startedAt: "2026-09-24T09:55:00.000Z",
        completedAt: "2026-09-24T09:55:54.000Z",
        durationMs: 1_000,
        summary: "Fixture evaluator summary.",
      },
    ],
  };
}

/** The candidate `validatedEditorialOutcome` builds from a final decision's limitations. */
function editorialCandidate(
  record: RunRecord,
  limitations: readonly string[],
): WorkflowOutcomeCandidateV1 {
  const evidence = workflowOutcomeStepEvidence(record, EVALUATE_STEP_ID);
  return {
    disposition: "inconclusive",
    findings: limitations.map((code) => ({
      id: `finding:authoring-quality:${code}`,
      kind: "evidence-limitation" as const,
      severity: "warning" as const,
      code,
      evidenceIds: [evidence.id],
    })),
    evidence: [evidence],
    limitations: [...limitations],
    openDecisions: [],
    producedArtifacts: [],
  };
}

function projecting(
  project: (record: Readonly<RunRecord>) => WorkflowOutcomeCandidateV1,
): WorkflowOutcomeProjector {
  return { project: async (record) => project(record) };
}

function throwingProjector(error: unknown): WorkflowOutcomeProjector {
  return {
    project: async () => {
      throw error;
    },
  };
}

describe("workflow outcome refusal inner reason (#1268)", () => {
  it("records the r3 update-cli refusal as a finding code outside the outcome grammar", async () => {
    const record = succeededUpdateRecord();
    await applyWorkflowOutcome({
      outcomeProjector: projecting((snapshot) =>
        editorialCandidate(snapshot as RunRecord, R3_LIMITATIONS),
      ),
      record,
    });

    expect(record.status).toBe("failed");
    expect(record.error).toBe(workflowOutcomePersistenceError);
    expect(record.workflowOutcome).toBeUndefined();
    expect(record.workflowOutcomeRejection).toEqual({
      code: "workflow-outcome-admission-invalid-outcome",
      location: "$.findings[].code",
    });
    expect(record.failure).toEqual({
      class: "contract-shape",
      layer: "workflow",
      code: "workflow-outcome-admission-invalid-outcome",
    });
    // The saved record keeps both, and every reader sees the inner code.
    attachRunFailureClassifications(record);
    expect(readRunFailure(record)?.code).toBe("workflow-outcome-admission-invalid-outcome");
    expect(readWorkflowOutcomeRejection(record.workflowOutcomeRejection)).toEqual(
      record.workflowOutcomeRejection,
    );
  });

  it("seals the same candidate when every code is inside the grammar", async () => {
    const record = succeededUpdateRecord();
    const kebab = R3_LIMITATIONS.map((code) => code.replaceAll("_", "-"));
    await applyWorkflowOutcome({
      outcomeProjector: projecting((snapshot) => editorialCandidate(snapshot as RunRecord, kebab)),
      record,
    });

    expect(record.status).toBe("succeeded");
    expect(record.workflowOutcome?.disposition).toBe("inconclusive");
    expect(record.workflowOutcomeRejection).toBeUndefined();
    expect(record.failure).toBeUndefined();
  });

  it.each([
    [
      "a limitation that no finding carries",
      (candidate: WorkflowOutcomeCandidateV1) => ({
        ...candidate,
        limitations: [...candidate.limitations, "orphan-limitation"],
      }),
      "workflow-outcome-admission-invalid-outcome",
      "$.limitations[]",
    ],
    [
      "a finding citing evidence the candidate does not carry",
      (candidate: WorkflowOutcomeCandidateV1) => ({
        ...candidate,
        findings: candidate.findings.map((finding) => ({
          ...finding,
          evidenceIds: ["step:unknown-step"],
        })),
      }),
      "workflow-outcome-admission-invalid-evidence",
      "$.findings[].evidenceIds",
    ],
    [
      "a candidate that cites no evidence",
      (candidate: WorkflowOutcomeCandidateV1) => ({
        ...candidate,
        findings: [],
        limitations: [],
        evidence: [],
      }),
      "workflow-outcome-admission-invalid-evidence",
      "$.evidence",
    ],
    [
      "an unknown disposition",
      (candidate: WorkflowOutcomeCandidateV1) =>
        ({
          ...candidate,
          disposition: "done",
        }) as unknown as WorkflowOutcomeCandidateV1,
      "workflow-outcome-admission-invalid-outcome",
      "$.disposition",
    ],
  ])("names the admission rule for %s", async (_name, mutate, code, location) => {
    const record = succeededUpdateRecord();
    await applyWorkflowOutcome({
      outcomeProjector: projecting((snapshot) =>
        mutate(editorialCandidate(snapshot as RunRecord, ["bounded-code"])),
      ),
      record,
    });
    expect(record.workflowOutcomeRejection).toEqual({ code, location });
    expect(record.failure?.code).toBe(code);
  });

  it("names the projector phase and its closed code, at the run root", async () => {
    const coded = succeededUpdateRecord();
    await applyWorkflowOutcome({
      outcomeProjector: throwingProjector(
        new AuthoringQualityWorkflowOutcomeError("invalid-record"),
      ),
      record: coded,
    });
    expect(coded.workflowOutcomeRejection).toEqual({
      code: "workflow-outcome-projection-invalid-record",
      location: "$",
    });
    expect(coded.failure).toEqual({
      class: "contract-shape",
      layer: "workflow",
      code: "workflow-outcome-projection-invalid-record",
    });

    // A located outcome error thrown inside the projector still reads the run root.
    const located = succeededUpdateRecord();
    await applyWorkflowOutcome({
      outcomeProjector: throwingProjector(
        new WorkflowOutcomeError("invalid-evidence", "$.findings[].code"),
      ),
      record: located,
    });
    expect(located.workflowOutcomeRejection).toEqual({
      code: "workflow-outcome-projection-invalid-evidence",
      location: "$",
    });

    // An error with no closed code names no cause, visibly.
    const uncoded = succeededUpdateRecord();
    await applyWorkflowOutcome({
      outcomeProjector: throwingProjector(Object.assign(new Error("boom"), { code: "ENOENT" })),
      record: uncoded,
    });
    expect(uncoded.workflowOutcomeRejection).toEqual({
      code: "workflow-outcome-projection-uncoded-error",
      location: "$",
    });
    expect(uncoded.failure).toEqual({
      class: "unknown",
      layer: "workflow",
      code: "workflow-outcome-projection-uncoded-error",
    });
    expect(uncoded.error).toBe(workflowOutcomePersistenceError);
  });

  it("keeps the first cause when the run already recorded one", async () => {
    const record = succeededUpdateRecord();
    record.failure = {
      class: "infrastructure",
      layer: "workflow",
      code: "impact-postflight-failed",
    };
    await applyWorkflowOutcome({
      outcomeProjector: throwingProjector(
        new AuthoringQualityWorkflowOutcomeError("invalid-record"),
      ),
      record,
    });
    expect(record.status).toBe("failed");
    expect(record.failure.code).toBe("impact-postflight-failed");
    expect(record.workflowOutcomeRejection).toBeUndefined();
  });

  it("reads release-readiness codes only from the release-readiness phase", () => {
    expect(
      workflowOutcomeRejection(
        "release-readiness",
        new ReleaseDocumentationReadinessError("execution-incomplete"),
      ),
    ).toEqual({
      code: "workflow-outcome-release-readiness-execution-incomplete",
      location: "$",
    });
    expect(
      workflowOutcomeRejection("release-readiness", new WorkflowOutcomeError("invalid-outcome")),
    ).toEqual({
      code: "workflow-outcome-release-readiness-uncoded-error",
      location: "$",
    });
    expect(
      workflowOutcomeRejection(
        "admission",
        new ReleaseDocumentationReadinessError("invalid-artifact"),
      ),
    ).toEqual({
      code: "workflow-outcome-admission-uncoded-error",
      location: "$",
    });
  });

  it("never copies a location outside the retained grammar", () => {
    expect(
      workflowOutcomeRejection(
        "admission",
        new WorkflowOutcomeError("invalid-outcome", "$.findings[3].code"),
      ),
    ).toEqual({
      code: "workflow-outcome-admission-invalid-outcome",
      location: "$",
    });
    expect(
      readWorkflowOutcomeRejection({
        code: "workflow-outcome-admission-invalid-outcome",
        location: "/tmp/x",
      }),
    ).toBeNull();
    expect(
      readWorkflowOutcomeRejection({
        code: "workflow-outcome-invented",
        location: "$",
      }),
    ).toBeNull();
    expect(
      readWorkflowOutcomeRejection({
        code: "workflow-outcome-admission-invalid-outcome",
        location: "$",
        detail: "x",
      }),
    ).toBeNull();
  });
});

describe("workflow outcome refusal drift (#1268)", () => {
  it("gives every inner code one class and a failure-code shape", () => {
    expect(Object.keys(WORKFLOW_OUTCOME_REJECTION_FAILURE_CLASSES).sort()).toEqual(
      [...WORKFLOW_OUTCOME_REJECTION_CODES].sort(),
    );
    expect(new Set(WORKFLOW_OUTCOME_REJECTION_CODES).size).toBe(
      WORKFLOW_OUTCOME_REJECTION_CODES.length,
    );
    for (const code of WORKFLOW_OUTCOME_REJECTION_CODES) {
      expect(isFailureCode(code), code).toBe(true);
      expect(WORKFLOW_OUTCOME_REJECTION_FAILURE_CLASSES[code], code).toBe(
        code.endsWith("-uncoded-error") ? "unknown" : "contract-shape",
      );
    }
  });

  it("holds every shipped projector's codes to the closed projector list", () => {
    const listed: readonly string[] = WORKFLOW_OUTCOME_PROJECTOR_ERROR_CODES;
    // Each projector's code union and the list must be the same set.
    const authoring: readonly AuthoringQualityWorkflowOutcomeErrorCode[] =
      WORKFLOW_OUTCOME_PROJECTOR_ERROR_CODES;
    const readiness: readonly ReadinessWorkflowOutcomeErrorCode[] =
      WORKFLOW_OUTCOME_PROJECTOR_ERROR_CODES;
    const audit: readonly AuditWorkflowOutcomeErrorCode[] = WORKFLOW_OUTCOME_PROJECTOR_ERROR_CODES;
    type Missing = Exclude<
      | AuthoringQualityWorkflowOutcomeErrorCode
      | ReadinessWorkflowOutcomeErrorCode
      | AuditWorkflowOutcomeErrorCode,
      (typeof WORKFLOW_OUTCOME_PROJECTOR_ERROR_CODES)[number]
    >;
    const exhaustive: [Missing] extends [never] ? true : false = true;
    expect(exhaustive).toBe(true);
    expect([authoring, readiness, audit].every((codes) => codes === listed)).toBe(true);
    for (const code of WORKFLOW_OUTCOME_PROJECTOR_ERROR_CODES) {
      for (const error of [
        new AuthoringQualityWorkflowOutcomeError(code),
        new ReadinessWorkflowOutcomeError(code),
        new AuditWorkflowOutcomeError(code),
      ]) {
        expect(workflowOutcomeRejection("projection", error).code).toBe(
          `workflow-outcome-projection-${code}`,
        );
      }
    }
  });

  it("names only retained-grammar locations in the outcome admission source", () => {
    const source = readFileSync(
      resolve(import.meta.dirname, "../src/workflow-contracts/outcome.ts"),
      "utf8",
    );
    const locations = [...source.matchAll(/"(\$[^"]*)"/gu)].map((match) => match[1]!);
    expect(locations.length).toBeGreaterThan(20);
    for (const location of locations) {
      expect(INFERENCE_REJECTION_LOCATION_GRAMMAR.test(location), location).toBe(true);
    }
  });
});

describe("one product-code grammar (#1268)", () => {
  const evidenceRef = {
    kind: "context-packet" as const,
    schemaVersion: 1 as const,
    digest: "c".repeat(64),
    repositoryRevision: "d".repeat(40),
    repositoryContentDigest: "e".repeat(64),
  };

  function proposal(overrides: Record<string, unknown>): unknown {
    return {
      schemaVersion: 1,
      kind: "docsfab-editorial-assessment-proposal",
      assessment: "not-applicable",
      rationale: "The run had no authorized representative audience fixture.",
      evidenceRefs: [evidenceRef],
      limitations: [],
      recommendation: null,
      ...overrides,
    };
  }

  function refusal(value: unknown): EditorialEvidenceHostError | undefined {
    try {
      decodeEditorialAssessmentProposalV1(value, [evidenceRef]);
    } catch (error) {
      if (error instanceof EditorialEvidenceHostError) return error;
      throw error;
    }
    return undefined;
  }

  it.each(["comparison_unknown", "no_audience_evidence", "no_runtime_observation", "a/b"])(
    "refuses the assessment limitation %s with a coded, retryable rule",
    (code) => {
      expect(isWorkflowOutcomeCode(code)).toBe(false);
      const error = refusal(proposal({ limitations: ["bounded-code", code] }));
      expect(error?.code).toBe("invalid-value");
      expect(error?.rejection).toEqual({
        code: "editorial-limitation-code-off-grammar",
        location: "$.editorialAssessmentProposal.limitations[]",
      });
    },
  );

  it("refuses a recommendation code outside the grammar at its own location", () => {
    const error = refusal(
      proposal({
        assessment: "rejected",
        limitations: [],
        recommendation: {
          candidate: "insufficient-evidence",
          kind: "evidence-limitation",
          code: "evidence-limitation.no_runtime_observation",
        },
      }),
    );
    expect(error?.rejection).toEqual(EDITORIAL_LIMITATION_CODE_REJECTIONS.recommendation);
  });

  it("admits every code the outcome grammar admits", () => {
    for (const code of ["bounded-code", "audience-prereqs-missing", "comparison.unknown", "a1"]) {
      expect(isWorkflowOutcomeCode(code), code).toBe(true);
      expect(refusal(proposal({ limitations: [code] })), code).toBeUndefined();
    }
  });

  it("keeps every host-authored limitation code inside the grammar", () => {
    for (const code of [
      ...AUTHORING_QUALITY_LIMITATION_CODES,
      ...AUTHORING_QUALITY_NON_WALL_CODES.advisory,
      READER_CONTEXT_CHANGED_SOURCE_INAPPLICABLE_LIMITATION,
      EXPECTED_WITHHELD_TOOL_LIMITATION,
      TOOL_MISSES_RECORDED_LIMITATION,
      "structured-product-evidence-unavailable",
    ]) {
      expect(isWorkflowOutcomeCode(code), code).toBe(true);
    }
  });

  it("keeps every hard gate the shipped quality profile names inside the grammar once prefixed (#1437)", () => {
    const profile = JSON.parse(
      readFileSync(resolve("quality/profiles/docsfab-documentation-quality/profile.json"), "utf8"),
    ) as { hard_gates: string[] };
    expect(profile.hard_gates).toContain("material-omission");
    for (const gate of profile.hard_gates) {
      for (const prefix of AUTHORING_QUALITY_NON_WALL_CODES.advisoryPrefixes) {
        expect(isWorkflowOutcomeCode(`${prefix}${gate}`), gate).toBe(true);
      }
    }
  });

  it("classifies the refusal as model content and gives the retry its rule", () => {
    const rejection = EDITORIAL_LIMITATION_CODE_REJECTIONS.limitation;
    expect(
      classifyInferenceAttempt({
        attempt: 1,
        outcome: "malformed-response",
        retryable: true,
        retryScheduled: true,
        durationMs: 1,
        rejection,
      } as Parameters<typeof classifyInferenceAttempt>[0]),
    ).toEqual({
      class: "model-content",
      layer: "inference",
      code: "editorial-limitation-code-off-grammar",
    });
    const correction = responseCorrectionInstruction({ rejection });
    expect(correction).toContain(
      "failed host rule editorial-limitation-code-off-grammar at $.editorialAssessmentProposal.limitations[]",
    );
    expect(correction).toContain(EDITORIAL_LIMITATION_CODE_RULE);
  });

  it("states the outcome grammar in the editorial response contract source", () => {
    const source = readFileSync(
      resolve(import.meta.dirname, "../src/harness/editorial-response-contract.ts"),
      "utf8",
    );
    expect(source).toContain("${WORKFLOW_OUTCOME_CODE_GRAMMAR.source}");
    expect(source).not.toContain("a-z0-9._/-");
    expect(WORKFLOW_OUTCOME_CODE_GRAMMAR.source).toBe("^[a-z0-9][a-z0-9.-]{0,127}$");
  });
});
