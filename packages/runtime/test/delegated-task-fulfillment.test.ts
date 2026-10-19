// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  DelegatedTaskResultError,
  delegatedTaskContractKit,
  delegatedTaskRequirementIdentitySha256,
  delegatedTaskRequirementsIdentitySha256,
} from "../src/delegated-task/result-contract.js";
import {
  projectDelegatedTaskFulfillment,
  type DelegatedTaskFulfillmentInputV1,
} from "../src/delegated-task/fulfillment.js";

const SHA = (value: string) => delegatedTaskContractKit.canonicalDigest(value);
const REVISION = "a".repeat(40);
const OTHER_REVISION = "b".repeat(40);
const TASK_ID = "task:delegated-1";

function requirement(
  id: string,
  kind: "artifact" | "check" | "child-workflow",
  targetLocator: string,
) {
  return {
    id,
    kind,
    originalSha256: delegatedTaskRequirementIdentitySha256({ id, kind, targetLocator }),
    targetLocator,
  };
}

function r1r2() {
  return [requirement("R1", "artifact", "docs/a.md"), requirement("R2", "check", "docs-check")];
}

function identityFields(requirements = r1r2()) {
  return {
    taskId: TASK_ID,
    taskSha256: delegatedTaskRequirementsIdentitySha256(requirements),
    repositoryIdentitySha256: SHA("repo"),
    repositoryRevision: REVISION,
  };
}

function baseInput(
  overrides: Partial<DelegatedTaskFulfillmentInputV1> = {},
): DelegatedTaskFulfillmentInputV1 {
  const originalRequirements = overrides.originalRequirements ?? r1r2();
  const repository = {
    identitySha256: SHA("repo"),
    revision: REVISION,
  };
  const request = {
    kind: "bounded-instruction" as const,
    requestSha256: SHA("request"),
    taskKind: "instruction-only" as const,
    taskSha256: delegatedTaskRequirementsIdentitySha256(originalRequirements),
  };
  return {
    taskId: TASK_ID,
    stopReason: "finished",
    deliveryState: "not-requested",
    artifacts: [],
    checks: [],
    children: [],
    pendingQuestions: [],
    usage: { input: 10, output: 4, cacheRead: 0, cacheWrite: 0, total: 14, turns: 2 },
    ...overrides,
    originalRequirements,
    request,
    repository,
    planRequirementIds: overrides.planRequirementIds ?? originalRequirements.map((item) => item.id),
  };
}

function artifact(overrides: Record<string, unknown> = {}) {
  return {
    evidenceId: "artifact:a",
    ...identityFields(),
    locator: "docs/a.md",
    digestSha256: SHA("docs/a.md-bytes"),
    boundRequirementIds: ["R1"],
    persistence: "applied",
    supportClass: "supported",
    ...overrides,
  };
}

function check(overrides: Record<string, unknown> = {}) {
  return {
    evidenceId: "check:docs-check",
    ...identityFields(),
    checkId: "docs-check",
    state: "not-run",
    receiptSha256: null,
    boundRequirementIds: ["R2"],
    ...overrides,
  };
}

function expectCode(run: () => unknown, code: DelegatedTaskResultError["code"]): void {
  try {
    run();
    throw new Error(`expected DelegatedTaskResultError(${code})`);
  } catch (error) {
    expect(error).toBeInstanceOf(DelegatedTaskResultError);
    expect((error as DelegatedTaskResultError).code).toBe(code);
  }
}

describe("delegated-task fulfillment projection", () => {
  it("projects R1 artifact plus R2 not-run as partial even when prose or a semantic assessor claims done", () => {
    const input = baseInput({
      artifacts: [artifact()],
      checks: [check({ state: "not-run" })],
    });
    const result = projectDelegatedTaskFulfillment(input, {
      modelProseClaim: "done",
      semanticAssessment: "pass",
    });
    const withoutClaim = projectDelegatedTaskFulfillment(input);
    expect(result.fulfillment).toBe("partial");
    expect(result.fulfillment).not.toBe("complete");
    expect(result.unmetRequirementIds).toEqual(["R2"]);
    expect(result.checkState).toBe("not-run");
    expect(result.requirements.find((item) => item.id === "R1")?.status).toBe("met");
    expect(result.requirements.find((item) => item.id === "R2")?.status).toBe("unmet");
    expect(result).toEqual(withoutClaim);
    expect(JSON.stringify(result)).not.toContain("done");
  });

  it("becomes complete only with the original locator/digest and a matching check receipt", () => {
    const result = projectDelegatedTaskFulfillment(
      baseInput({
        artifacts: [artifact()],
        checks: [
          check({
            state: "passed",
            receiptSha256: SHA("docs-check-receipt"),
          }),
        ],
      }),
    );
    expect(result.fulfillment).toBe("complete");
    expect(result.stopReason).toBe("finished");
    expect(result.unmetRequirementIds).toEqual([]);
    expect(result.checkState).toBe("passed");
    expect(result.artifacts[0]?.locator).toBe("docs/a.md");
    expect(result.checks[0]?.receiptSha256).toBe(SHA("docs-check-receipt"));
  });

  it("rejects a narrowed plan that removes R2 as an identity mismatch", () => {
    expectCode(
      () =>
        projectDelegatedTaskFulfillment(
          baseInput({
            planRequirementIds: ["R1"],
            artifacts: [artifact()],
          }),
        ),
      "identity-mismatch",
    );
  });

  it("projects question-only pause with no supported artifact as none plus needs-input", () => {
    const result = projectDelegatedTaskFulfillment(
      baseInput({
        stopReason: "needs-input",
        pendingQuestions: [{ questionId: "question:target" }],
      }),
    );
    expect(result.fulfillment).toBe("none");
    expect(result.stopReason).toBe("needs-input");
    expect(result.pendingQuestionIds).toEqual(["question:target"]);
    expect(result.nextAction.code).toBe("resume-with-answers");
  });

  it("projects one useful artifact plus a required pending question as partial plus needs-input", () => {
    const result = projectDelegatedTaskFulfillment(
      baseInput({
        stopReason: "needs-input",
        pendingQuestions: [{ questionId: "question:target" }],
        artifacts: [artifact()],
        checks: [check({ state: "not-run" })],
      }),
    );
    expect(result.fulfillment).toBe("partial");
    expect(result.stopReason).toBe("needs-input");
    expect(result.requirements.find((item) => item.id === "R1")?.status).toBe("met");
    expect(result.unmetRequirementIds).toEqual(["R2"]);
  });

  it("preserves useful evidence on cancellation and budget exhaustion without claiming complete", () => {
    const cancelled = projectDelegatedTaskFulfillment(
      baseInput({
        stopReason: "cancelled",
        artifacts: [artifact()],
        checks: [check({ state: "not-run" })],
      }),
    );
    expect(cancelled.fulfillment).toBe("partial");
    expect(cancelled.stopReason).toBe("cancelled");
    expect(cancelled.artifacts).toHaveLength(1);
    expect(cancelled.checks[0]?.state).toBe("not-run");

    const exhausted = projectDelegatedTaskFulfillment(
      baseInput({
        stopReason: "budget-exhausted",
        artifacts: [artifact()],
        checks: [check({ state: "passed", receiptSha256: SHA("receipt") })],
      }),
    );
    expect(exhausted.fulfillment).toBe("partial");
    expect(exhausted.stopReason).toBe("budget-exhausted");
    expect(exhausted.checkState).toBe("passed");
  });

  it("distinguishes a persistence-failed local candidate from an applied checkout artifact", () => {
    const failed = projectDelegatedTaskFulfillment(
      baseInput({
        artifacts: [artifact({ persistence: "persistence-failed" })],
        checks: [check({ state: "not-run" })],
      }),
    );
    expect(failed.fulfillment).toBe("partial");
    expect(failed.persistenceState).toBe("persistence-failed");
    expect(failed.requirements.find((item) => item.id === "R1")?.status).toBe("unmet");
    expect(failed.nextAction.code).toBe("persist-candidate");

    const applied = projectDelegatedTaskFulfillment(
      baseInput({
        artifacts: [artifact({ persistence: "applied" })],
        checks: [check({ state: "not-run" })],
      }),
    );
    expect(applied.persistenceState).toBe("applied");
    expect(applied.requirements.find((item) => item.id === "R1")?.status).toBe("met");
    expect(applied.fulfillment).toBe("partial");
  });

  it("lists a failed child unchanged beside later direct recovery without claiming workflow or publication success", () => {
    const result = projectDelegatedTaskFulfillment(
      baseInput({
        deliveryState: "ineligible",
        artifacts: [artifact()],
        checks: [check({ state: "not-run" })],
        children: [
          {
            childId: "run:child-create",
            ...identityFields(),
            workflow: "create-documentation",
            status: "failed",
            failureCode: "workflow-failed",
            formalQuality: "failed",
            attemptedRequirementIds: ["R1"],
          },
        ],
      }),
    );
    expect(result.fulfillment).toBe("partial");
    expect(result.children).toEqual([
      {
        childId: "run:child-create",
        workflow: "create-documentation",
        status: "failed",
        failureCode: "workflow-failed",
        formalQuality: "failed",
        attemptedRequirementIds: ["R1"],
      },
    ]);
    expect(result.requirements.find((item) => item.id === "R1")?.status).toBe("met");
    expect(result.deliveryState).toBe("ineligible");
    expect(result.children[0]?.status).toBe("failed");
    expect(result.fulfillment).not.toBe("complete");
  });

  it("does not let missing, substituted, cross-task, cross-repository, stale, duplicate, or unknown evidence satisfy a requirement", () => {
    const missing = projectDelegatedTaskFulfillment(baseInput());
    expect(missing.fulfillment).toBe("none");
    expect(missing.unmetRequirementIds).toEqual(["R1", "R2"]);

    const substituted = projectDelegatedTaskFulfillment(
      baseInput({ artifacts: [artifact({ locator: "docs/b.md" })] }),
    );
    expect(substituted.requirements.find((item) => item.id === "R1")?.status).toBe("unmet");

    const crossTask = projectDelegatedTaskFulfillment(
      baseInput({ artifacts: [artifact({ taskId: "task:other" })] }),
    );
    expect(crossTask.artifacts).toEqual([]);
    expect(crossTask.requirements.find((item) => item.id === "R1")?.status).toBe("unmet");

    const crossRepo = projectDelegatedTaskFulfillment(
      baseInput({ artifacts: [artifact({ repositoryIdentitySha256: SHA("other-repo") })] }),
    );
    expect(crossRepo.artifacts).toEqual([]);

    const stale = projectDelegatedTaskFulfillment(
      baseInput({ artifacts: [artifact({ repositoryRevision: OTHER_REVISION })] }),
    );
    expect(stale.artifacts).toEqual([]);

    const unknownCheck = projectDelegatedTaskFulfillment(
      baseInput({
        artifacts: [artifact()],
        checks: [check({ state: "unknown" })],
      }),
    );
    expect(unknownCheck.requirements.find((item) => item.id === "R2")?.status).toBe("unknown");
    expect(unknownCheck.fulfillment).toBe("partial");
    expect(unknownCheck.checkState).toBe("unknown");

    expectCode(
      () =>
        projectDelegatedTaskFulfillment(
          baseInput({
            artifacts: [artifact(), artifact({ evidenceId: "artifact:a", locator: "docs/c.md" })],
          }),
        ),
      "invalid-value",
    );
  });

  it("projects an unsupported CREATE draft as partial without completing the original request", () => {
    const result = projectDelegatedTaskFulfillment(
      baseInput({
        artifacts: [artifact({ supportClass: "unsupported-draft", persistence: "candidate" })],
        checks: [check({ state: "not-run" })],
      }),
    );
    expect(result.fulfillment).toBe("partial");
    expect(result.requirements.find((item) => item.id === "R1")?.status).toBe("unmet");
    expect(result.artifacts[0]?.supportClass).toBe("unsupported-draft");
  });

  it("rejects malformed extra fields on retained evidence", () => {
    expectCode(
      () =>
        projectDelegatedTaskFulfillment(
          baseInput({
            artifacts: [{ ...artifact(), modelProse: "done" } as ReturnType<typeof artifact>],
          }),
        ),
      "invalid-shape",
    );
  });
});
