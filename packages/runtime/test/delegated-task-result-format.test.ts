// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  decodeDelegatedTaskResult,
  delegatedTaskContractKit,
  delegatedTaskRequirementIdentitySha256,
  delegatedTaskRequirementsIdentitySha256,
} from "../src/delegated-task/result-contract.js";
import {
  projectDelegatedTaskFulfillment,
  type DelegatedTaskFulfillmentInputV1,
} from "../src/delegated-task/fulfillment.js";
import {
  delegatedTaskExitIntent,
  delegatedTaskResultProjectionIdentity,
  formatDelegatedTaskResultHuman,
  formatDelegatedTaskResultJson,
} from "../src/delegated-task/result-format.js";

const SHA = (value: string) => delegatedTaskContractKit.canonicalDigest(value);
const REVISION = "a".repeat(40);
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

function identityFields() {
  return {
    taskId: TASK_ID,
    taskSha256: delegatedTaskRequirementsIdentitySha256(r1r2()),
    repositoryIdentitySha256: SHA("repo"),
    repositoryRevision: REVISION,
  };
}

function baseInput(
  overrides: Partial<DelegatedTaskFulfillmentInputV1> = {},
): DelegatedTaskFulfillmentInputV1 {
  const originalRequirements = overrides.originalRequirements ?? r1r2();
  const repository = { identitySha256: SHA("repo"), revision: REVISION };
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

describe("delegated-task result format", () => {
  it("keeps human and JSON projections on the same task identity fields", () => {
    const result = projectDelegatedTaskFulfillment(
      baseInput({
        artifacts: [artifact()],
        checks: [check({ state: "not-run" })],
      }),
    );
    const human = formatDelegatedTaskResultHuman(result);
    const json = formatDelegatedTaskResultJson(result);
    const decoded = decodeDelegatedTaskResult(JSON.parse(json));
    expect(human.taskId).toBe(result.taskId);
    expect(human.fulfillment).toBe(result.fulfillment);
    expect(human.stopReason).toBe(result.stopReason);
    expect(human.unmetRequirementIds).toEqual(result.unmetRequirementIds);
    expect(human.checkState).toBe(result.checkState);
    expect(human.childIds).toEqual(result.children.map((child) => child.childId));
    expect(human.locators).toEqual(result.artifacts.map((item) => item.locator));
    expect(human.usage).toEqual(result.usage);
    expect(human.nextAction).toEqual(result.nextAction);
    expect(decoded).toEqual(result);
    expect(delegatedTaskResultProjectionIdentity(decoded)).toBe(
      delegatedTaskResultProjectionIdentity(result),
    );
    expect(human.text).toContain(`Delegated task: ${TASK_ID}`);
    expect(human.text).toContain("incomplete-requested-checks");
    expect(human.text).toContain("successful-local-artifact");
  });

  it("distinguishes unsupported draft, failed persistence, quality failure, and delivery states", () => {
    const draft = formatDelegatedTaskResultHuman(
      projectDelegatedTaskFulfillment(
        baseInput({
          artifacts: [artifact({ supportClass: "unsupported-draft", persistence: "candidate" })],
          checks: [check({ state: "not-run" })],
        }),
      ),
    );
    expect(draft.text).toContain("unsupported-draft");

    const persistence = formatDelegatedTaskResultHuman(
      projectDelegatedTaskFulfillment(
        baseInput({
          artifacts: [artifact({ persistence: "persistence-failed" })],
          checks: [check({ state: "not-run" })],
        }),
      ),
    );
    expect(persistence.text).toContain("persistence-failed");
    expect(persistence.text).toContain("local-candidate-not-applied");

    const quality = formatDelegatedTaskResultHuman(
      projectDelegatedTaskFulfillment(
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
      ),
    );
    expect(quality.text).toContain("formal-quality-failure");
    expect(quality.text).toContain("run:child-create");
    expect(quality.text).toContain("Delivery: ineligible");

    for (const deliveryState of ["not-requested", "ineligible", "eligible", "attempted"] as const) {
      const projected = projectDelegatedTaskFulfillment(
        baseInput({
          deliveryState,
          artifacts: [artifact()],
          checks: [check({ state: "not-run" })],
        }),
      );
      expect(formatDelegatedTaskResultHuman(projected).text).toContain(
        `Delivery: ${deliveryState}`,
      );
      expect(projected.fulfillment).toBe("partial");
    }
  });

  it("maps exit intent 0 only for complete+finished and 2 for needs-input", () => {
    const complete = projectDelegatedTaskFulfillment(
      baseInput({
        artifacts: [artifact()],
        checks: [check({ state: "passed", receiptSha256: SHA("receipt") })],
      }),
    );
    expect(delegatedTaskExitIntent(complete)).toEqual({ exitCode: 0, reason: "complete" });

    const needsInput = projectDelegatedTaskFulfillment(
      baseInput({
        stopReason: "needs-input",
        pendingQuestions: [{ questionId: "question:target" }],
      }),
    );
    expect(delegatedTaskExitIntent(needsInput)).toEqual({ exitCode: 2, reason: "needs-input" });

    const cancelled = projectDelegatedTaskFulfillment(
      baseInput({
        stopReason: "cancelled",
        artifacts: [artifact()],
        checks: [check({ state: "not-run" })],
      }),
    );
    expect(delegatedTaskExitIntent(cancelled)).toEqual({ exitCode: 1, reason: "cancelled" });

    const exhausted = projectDelegatedTaskFulfillment(
      baseInput({
        stopReason: "budget-exhausted",
        artifacts: [artifact()],
      }),
    );
    expect(delegatedTaskExitIntent(exhausted)).toEqual({
      exitCode: 1,
      reason: "budget-exhausted",
    });

    const failed = projectDelegatedTaskFulfillment(
      baseInput({
        stopReason: "failed",
        artifacts: [artifact()],
      }),
    );
    expect(delegatedTaskExitIntent(failed)).toEqual({ exitCode: 1, reason: "failed" });

    const incomplete = projectDelegatedTaskFulfillment(
      baseInput({
        artifacts: [artifact()],
        checks: [check({ state: "not-run" })],
      }),
    );
    expect(delegatedTaskExitIntent(incomplete)).toEqual({ exitCode: 1, reason: "incomplete" });
  });

  it("does not let publication eligibility change fulfillment or exit intent", () => {
    const ineligible = projectDelegatedTaskFulfillment(
      baseInput({
        deliveryState: "ineligible",
        artifacts: [artifact()],
        checks: [check({ state: "passed", receiptSha256: SHA("receipt") })],
      }),
    );
    const eligible = projectDelegatedTaskFulfillment(
      baseInput({
        deliveryState: "eligible",
        artifacts: [artifact()],
        checks: [check({ state: "passed", receiptSha256: SHA("receipt") })],
      }),
    );
    expect(ineligible.fulfillment).toBe("complete");
    expect(eligible.fulfillment).toBe("complete");
    expect(delegatedTaskExitIntent(ineligible)).toEqual(delegatedTaskExitIntent(eligible));
    expect(delegatedTaskExitIntent(ineligible)).toEqual({ exitCode: 0, reason: "complete" });
    expect(ineligible.deliveryState).toBe("ineligible");
    expect(eligible.deliveryState).toBe("eligible");
  });
});
