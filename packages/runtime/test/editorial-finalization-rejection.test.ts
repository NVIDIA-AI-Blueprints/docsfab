// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The inner reason terminal editorial finalization refused a run whose steps
 * all succeeded. Each refusal records its closed code and location, which
 * `failure.code` repeats; the FAILURE lines and NEXT name both. The catch
 * never discards the thrown error.
 */
import { describe, expect, it } from "vitest";

import type { EditorialDecisionArtifactReferenceV3 } from "../src/artifacts/contracts.js";
import {
  EditorialDecisionValidationError,
  NO_CHANGE_ASSESSMENT_LOCATION,
} from "../src/artifacts/editorial-decision.js";
import { INFERENCE_REJECTION_LOCATION_GRAMMAR } from "../src/config/inference-rejection-limits.js";
import { isFailureCode } from "../src/operator/failure-class.js";
import {
  attachRunFailureClassifications,
  editorialFinalizationRejectionFailure,
  readRunFailure,
  RUN_FAILURE_CODE_CLASSES,
} from "../src/operator/failure-classification.js";
import {
  buildRunHumanNextCommand,
  formatRunFailureDiagnosticLines,
} from "../src/operator/run-summary.js";
import { createWorkflowBranchCoverageV1 } from "../src/records/composition-execution.js";
import type { RunRecord } from "../src/records/contracts.js";
import { WorkflowBranchCoverageError } from "../src/workflow-contracts/branch-coverage.js";
import {
  workflowSelectedPath,
  type WorkflowBranchEvidenceHost,
  type WorkflowBranchSelectionEvidenceV1,
} from "../src/workflow-contracts/contracts.js";
import { getWorkflow } from "../src/workflow-registry/catalog.js";
import { EditorialEvidenceHostError } from "../src/workflow-execution/editorial-evidence-host.js";
import {
  EDITORIAL_FINALIZATION_CONTRACT_CODES,
  EDITORIAL_FINALIZATION_REJECTION_CODES,
  readEditorialFinalizationRejection,
  type EditorialFinalizationContract,
} from "../src/workflow-execution/editorial-finalization-rejection.js";
import {
  editorialFinalizationRejectionOf,
  finalizeEditorialEvidence,
} from "../src/workflow-execution/runner-terminal.js";

const REVISION = "a".repeat(40);
const SNAPSHOT = "9".repeat(64);
const INADMISSIBLE = "Final editorial evidence could not be admitted.";
const CANDIDATE: EditorialDecisionArtifactReferenceV3 = {
  kind: "editorial-decision",
  schemaVersion: 3,
  digest: "7".repeat(64),
  repositoryRevision: REVISION,
  repositoryContentDigest: "8".repeat(64),
};
const VALIDATED: EditorialDecisionArtifactReferenceV3 = { ...CANDIDATE, digest: "6".repeat(64) };
const INDEPENDENT_REJECTION = Object.freeze({
  code: "editorial-finalization-decision-independent-rejection",
  location: NO_CHANGE_ASSESSMENT_LOCATION,
});

/** A no-change run whose read-only steps all succeeded, just before finalization. */
function completedNoChangeRun(): {
  record: RunRecord;
  selection: WorkflowBranchSelectionEvidenceV1;
} {
  const workflow = getWorkflow("update-documentation");
  const searched = new Set([
    "plan-documentation",
    "verify-technical-accuracy",
    "evaluate-document-quality",
  ]);
  const steps = workflowSelectedPath(workflow, "assess-no-change").steps.map((step) => ({
    id: step.id,
    title: step.title,
    kind: step.kind ?? "inference",
    skill: step.skill,
    mode: step.mode,
    status: "succeeded",
    ...(searched.has(step.id) ? { searchEvidence: { workspaceSnapshotSha256: SNAPSHOT } } : {}),
  }));
  const record = {
    schemaVersion: 2,
    id: "run-2042-finalization",
    workflow: "update-documentation",
    repository: { sourcePath: "/repository", requestedRevision: REVISION, revision: REVISION },
    workspace: { strategy: "tracked-export", disposable: true },
    status: "succeeded",
    createdAt: "2026-10-07T12:00:00.000Z",
    models: [],
    skills: [],
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, turns: 0 },
    tools: { totalCalls: 0, failedCalls: 0, byTool: [] },
    steps,
    artifacts: [{ role: "output", stepId: "plan-documentation", reference: CANDIDATE }],
    workflowBranchCoverage: createWorkflowBranchCoverageV1({
      workflow,
      repositoryRevision: REVISION,
      workspaceSnapshotSha256: SNAPSHOT,
      selection: { branchId: "assess-no-change", candidateArtifact: CANDIDATE },
    }),
  } as unknown as RunRecord;
  const selection = {
    candidate: "no-change",
    branchId: "assess-no-change",
    workspaceSnapshotSha256: SNAPSHOT,
    candidateArtifact: CANDIDATE,
  } as unknown as WorkflowBranchSelectionEvidenceV1;
  return { record, selection };
}

function finalizingWith(
  finalize: WorkflowBranchEvidenceHost["finalize"],
): WorkflowBranchEvidenceHost {
  const unused = async (): Promise<never> => {
    throw new Error("Finalization does not select or observe.");
  };
  return {
    select: unused,
    observeAssessment: unused,
    finalize,
    decodeEditorialDecision: () => {
      throw new Error("Finalization does not decode.");
    },
  };
}

async function finalizeRefusedBy(error: unknown, record?: RunRecord): Promise<RunRecord> {
  const run = completedNoChangeRun();
  const target = record ?? run.record;
  await finalizeEditorialEvidence({
    workflow: getWorkflow("update-documentation"),
    record: target,
    selection: run.selection,
    editorialHost: finalizingWith(async () => {
      throw error;
    }),
  });
  return target;
}

function errorOf(contract: EditorialFinalizationContract, code: string): Error {
  switch (contract) {
    case "branch-coverage":
      return new WorkflowBranchCoverageError(code as never);
    case "host":
      return new EditorialEvidenceHostError(code as never);
    case "decision":
      return new EditorialDecisionValidationError(code as never);
  }
}

describe("editorial finalization refusal inner reason (#2042)", () => {
  it("seals and attaches the final decision when finalization admits the decision (control)", async () => {
    const { record, selection } = completedNoChangeRun();
    await finalizeEditorialEvidence({
      workflow: getWorkflow("update-documentation"),
      record,
      selection,
      editorialHost: finalizingWith(async () => VALIDATED),
    });

    expect(record.status).toBe("succeeded");
    expect(record.error).toBeUndefined();
    expect(record.failure).toBeUndefined();
    expect(record.editorialFinalizationRejection).toBeUndefined();
    expect(record.steps.at(-1)?.artifacts).toEqual([
      { role: "output", stepId: "evaluate-document-quality", reference: VALIDATED },
    ]);
  });

  it.each([
    [
      "assessments that do not confirm a no-change",
      new EditorialDecisionValidationError("independent-rejection", NO_CHANGE_ASSESSMENT_LOCATION),
      INDEPENDENT_REJECTION.code,
      NO_CHANGE_ASSESSMENT_LOCATION,
      "model-content",
    ],
    [
      "a decision identity the candidate does not share",
      new EditorialDecisionValidationError("identity-mismatch"),
      "editorial-finalization-decision-identity-mismatch",
      "$",
      "contract-shape",
    ],
    [
      "an evaluator rationale that repeats the planner's",
      new EditorialEvidenceHostError("conflicting-assessment"),
      "editorial-finalization-host-conflicting-assessment",
      "$",
      "model-content",
    ],
    [
      "a missing assessment",
      new EditorialEvidenceHostError("evidence-unavailable"),
      "editorial-finalization-host-evidence-unavailable",
      "$",
      "contract-shape",
    ],
    [
      "an error no contract coded",
      Object.assign(new Error("disk full at /private/state"), { code: "ENOSPC" }),
      "editorial-finalization-uncoded-error",
      "$",
      "unknown",
    ],
  ])(
    "records %s as its closed code and location",
    async (_name, error, code, location, failureClass) => {
      const record = await finalizeRefusedBy(error);

      expect(record.status).toBe("failed");
      expect(record.error).toBe(INADMISSIBLE);
      expect(record.editorialFinalizationRejection).toEqual({ code, location });
      expect(record.failure).toEqual({ class: failureClass, layer: "workflow", code });
      // Nothing the refused decision named is attached.
      expect(record.steps.at(-1)?.artifacts).toBeUndefined();
      // The saved record keeps both, and every reader sees the inner code.
      attachRunFailureClassifications(record);
      expect(readRunFailure(record)?.code).toBe(code);
      expect(readEditorialFinalizationRejection(record.editorialFinalizationRejection)).toEqual({
        code,
        location,
      });
      // Neither the message nor the host path of the thrown error is copied.
      expect(JSON.stringify(record)).not.toContain("disk full");
      expect(JSON.stringify(record)).not.toContain("/private/state");
    },
  );

  it("records a branch coverage refusal without asking the host", async () => {
    const { record, selection } = completedNoChangeRun();
    record.workflowBranchCoverage = {
      ...record.workflowBranchCoverage!,
      excludedStepIds: [],
    };
    let finalized = false;
    await finalizeEditorialEvidence({
      workflow: getWorkflow("update-documentation"),
      record,
      selection,
      editorialHost: finalizingWith(async () => {
        finalized = true;
        return VALIDATED;
      }),
    });

    expect(finalized).toBe(false);
    expect(record.status).toBe("failed");
    expect(record.editorialFinalizationRejection).toEqual({
      code: "editorial-finalization-branch-coverage-digest-mismatch",
      location: "$",
    });
    expect(record.failure?.code).toBe("editorial-finalization-branch-coverage-digest-mismatch");
  });

  it("keeps the first cause when the run already recorded one", async () => {
    const { record } = completedNoChangeRun();
    const earlier = {
      class: "infrastructure",
      layer: "workflow",
      code: "impact-postflight-failed",
    };
    record.failure = earlier as RunRecord["failure"];
    await finalizeRefusedBy(new EditorialEvidenceHostError("identity-mismatch"), record);

    expect(record.status).toBe("failed");
    expect(record.failure).toEqual(earlier);
    expect(record.editorialFinalizationRejection).toBeUndefined();
  });

  it("reduces every contract's closed codes, and nothing else", () => {
    for (const [contract, codes] of Object.entries(EDITORIAL_FINALIZATION_CONTRACT_CODES) as [
      EditorialFinalizationContract,
      readonly string[],
    ][]) {
      for (const code of codes) {
        const rejection = editorialFinalizationRejectionOf(errorOf(contract, code));
        expect(rejection, `${contract} ${code}`).toEqual({
          code: `editorial-finalization-${contract}-${code}`,
          location: "$",
        });
      }
    }
    expect(
      editorialFinalizationRejectionOf(
        new EditorialDecisionValidationError(
          "independent-rejection",
          NO_CHANGE_ASSESSMENT_LOCATION,
        ),
      ),
    ).toEqual(INDEPENDENT_REJECTION);

    const uncoded = { code: "editorial-finalization-uncoded-error", location: "$" };
    // A lookalike carries a contract code but is not the contract's error.
    expect(
      editorialFinalizationRejectionOf(
        Object.assign(new Error("x"), { code: "independent-rejection" }),
      ),
    ).toEqual(uncoded);
    expect(editorialFinalizationRejectionOf("independent-rejection")).toEqual(uncoded);
    // A code outside the contract's list, and a hostile getter, read as uncoded.
    const offCatalog = new EditorialEvidenceHostError("identity-mismatch");
    Object.defineProperty(offCatalog, "code", { value: "not-a-host-code" });
    expect(editorialFinalizationRejectionOf(offCatalog)).toEqual(uncoded);
    const hostile = new EditorialDecisionValidationError("invalid-value");
    Object.defineProperty(hostile, "code", {
      get: () => {
        throw new Error("hostile");
      },
    });
    expect(editorialFinalizationRejectionOf(hostile)).toEqual(uncoded);
    // A location outside the retained grammar reads as the root.
    for (const location of ["/private/state/run.json", "$.steps[3].assessment", "assessment"]) {
      expect(
        editorialFinalizationRejectionOf(
          new EditorialDecisionValidationError("independent-rejection", location),
        ),
      ).toEqual({ code: INDEPENDENT_REJECTION.code, location: "$" });
    }
  });

  it("gives every inner code one class and a failure-code shape", () => {
    expect(
      Object.keys(RUN_FAILURE_CODE_CLASSES)
        .filter((code) => code.startsWith("editorial-finalization-"))
        .sort(),
    ).toEqual([...EDITORIAL_FINALIZATION_REJECTION_CODES].sort());
    expect(new Set(EDITORIAL_FINALIZATION_REJECTION_CODES).size).toBe(
      EDITORIAL_FINALIZATION_REJECTION_CODES.length,
    );
    const modelContent = new Set([
      INDEPENDENT_REJECTION.code,
      "editorial-finalization-host-conflicting-assessment",
    ]);
    for (const code of EDITORIAL_FINALIZATION_REJECTION_CODES) {
      expect(isFailureCode(code), code).toBe(true);
      expect(editorialFinalizationRejectionFailure({ code }).class, code).toBe(
        modelContent.has(code)
          ? "model-content"
          : code === "editorial-finalization-uncoded-error"
            ? "unknown"
            : "contract-shape",
      );
    }
    expect(INFERENCE_REJECTION_LOCATION_GRAMMAR.test(NO_CHANGE_ASSESSMENT_LOCATION)).toBe(true);
  });

  it("reads back only a closed code with a retained location", () => {
    expect(readEditorialFinalizationRejection({ ...INDEPENDENT_REJECTION })).toEqual(
      INDEPENDENT_REJECTION,
    );
    for (const value of [
      undefined,
      null,
      [],
      { code: INDEPENDENT_REJECTION.code },
      { ...INDEPENDENT_REJECTION, detail: "extra" },
      { code: "independent-rejection", location: "$" },
      { code: "editorial-finalization-decision-not-a-code", location: "$" },
      { code: "editorial-evidence-inadmissible", location: "$" },
      { code: INDEPENDENT_REJECTION.code, location: "$.steps[0].assessment" },
      { code: INDEPENDENT_REJECTION.code, location: "/private/state" },
    ]) {
      expect(readEditorialFinalizationRejection(value)).toBeNull();
    }
  });

  it("drops the inner reason from a record that did not fail", () => {
    const { record } = completedNoChangeRun();
    record.editorialFinalizationRejection = INDEPENDENT_REJECTION as never;
    attachRunFailureClassifications(record);
    expect(record.editorialFinalizationRejection).toBeUndefined();
  });

  it("names the code and location in the FAILURE lines", async () => {
    const record = await finalizeRefusedBy(
      new EditorialDecisionValidationError("independent-rejection", NO_CHANGE_ASSESSMENT_LOCATION),
    );
    const lines = formatRunFailureDiagnosticLines(record);
    expect(lines).toContain(
      `Failure class: model-content (layer workflow, code ${INDEPENDENT_REJECTION.code}).`,
    );
    expect(lines).toContain(
      `Final editorial evidence refused by ${INDEPENDENT_REJECTION.code} at ${NO_CHANGE_ASSESSMENT_LOCATION}.`,
    );
    expect(lines).toContain(INADMISSIBLE);

    const forged = { ...record, editorialFinalizationRejection: { code: "x", location: "/tmp" } };
    expect(
      formatRunFailureDiagnosticLines(forged as RunRecord).some((line) =>
        line.startsWith("Final editorial evidence refused"),
      ),
    ).toBe(false);
  });

  it.each([
    [
      "assessments that do not confirm a no-change",
      new EditorialDecisionValidationError("independent-rejection", NO_CHANGE_ASSESSMENT_LOCATION),
      `Final editorial evidence was refused by ${INDEPENDENT_REJECTION.code} at ${NO_CHANGE_ASSESSMENT_LOCATION}: the independent assessments do not confirm the no-change. A no-change needs verify-technical-accuracy and review-documentation to answer accepted, and evaluate-document-quality to answer accepted or not-applicable. Inspect each assessment step in the saved run; do not retry unchanged inference.`,
    ],
    [
      "an evaluator rationale that repeats the planner's",
      new EditorialEvidenceHostError("conflicting-assessment"),
      "Final editorial evidence was refused by editorial-finalization-host-conflicting-assessment at $: the evaluator's rationale repeats the planner's, so it is not independent evidence. Inspect each assessment step in the saved run; do not retry unchanged inference.",
    ],
    [
      "a host binding check",
      new EditorialEvidenceHostError("identity-mismatch"),
      "Final editorial evidence was refused by editorial-finalization-host-identity-mismatch at $: a DocsFab check of evidence the host bound failed after every step succeeded. Report the saved run as a DocsFab defect; do not retry unchanged inference.",
    ],
    [
      "an error no contract coded",
      new Error("boom"),
      "Final editorial evidence was refused by editorial-finalization-uncoded-error at $: the refusal carried no closed code. Report the saved run as a DocsFab defect; do not retry unchanged inference.",
    ],
  ])("names the refusal in NEXT for %s", async (_name, error, reason) => {
    const record = await finalizeRefusedBy(error);
    expect(buildRunHumanNextCommand({ record })).toEqual({
      command: `docsfab runs show ${record.id} --json`,
      reason,
    });
  });

  it("keeps the generic inspect NEXT for a failed run without the inner reason (control)", async () => {
    const record = await finalizeRefusedBy(new EditorialEvidenceHostError("identity-mismatch"));
    delete record.editorialFinalizationRejection;
    expect(buildRunHumanNextCommand({ record })?.reason).toBe(
      "Inspect the saved run for the failing step and coded rejection. Do not retry unchanged inference from this output.",
    );
  });
});
