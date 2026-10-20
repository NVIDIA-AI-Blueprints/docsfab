// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  delegatedTaskContractKit,
  delegatedTaskRequirementIdentitySha256,
  delegatedTaskRequirementsIdentitySha256,
} from "../src/delegated-task/result-contract.js";
import {
  projectDelegatedTaskFulfillment,
  type DelegatedTaskFulfillmentInputV1,
} from "../src/delegated-task/fulfillment.js";
import { delegatedTaskPresentation } from "../src/delegated-task/presentation.js";
import { formatDelegatedTaskResultJson } from "../src/delegated-task/result-format.js";
import { renderPresentation, resolvePresentationCapabilities } from "../src/operator/index.js";

const digest = (value: string) => delegatedTaskContractKit.canonicalDigest(value);
const revision = "a".repeat(40);
const taskId = "task:delegated-presentation";
const requirements = [
  {
    id: "R1",
    kind: "artifact" as const,
    targetLocator: "docs/result.md",
    originalSha256: delegatedTaskRequirementIdentitySha256({
      id: "R1",
      kind: "artifact",
      targetLocator: "docs/result.md",
    }),
  },
  {
    id: "R2",
    kind: "check" as const,
    targetLocator: "docs-check",
    originalSha256: delegatedTaskRequirementIdentitySha256({
      id: "R2",
      kind: "check",
      targetLocator: "docs-check",
    }),
  },
];

function baseInput(
  overrides: Partial<DelegatedTaskFulfillmentInputV1> = {},
): DelegatedTaskFulfillmentInputV1 {
  const originalRequirements = overrides.originalRequirements ?? requirements;
  const taskSha256 = delegatedTaskRequirementsIdentitySha256(originalRequirements);
  return {
    taskId,
    request: {
      kind: "bounded-instruction",
      requestSha256: digest("request"),
      taskKind: "instruction-only",
      taskSha256,
    },
    repository: { identitySha256: digest("repository"), revision },
    originalRequirements,
    planRequirementIds: originalRequirements.map((requirement) => requirement.id),
    stopReason: "finished",
    deliveryState: "not-requested",
    artifacts: [],
    checks: [],
    children: [],
    pendingQuestions: [],
    usage: { input: 8, output: 5, cacheRead: 0, cacheWrite: 0, total: 13, turns: 2 },
    ...overrides,
  };
}

function evidenceIdentity() {
  return {
    taskId,
    taskSha256: delegatedTaskRequirementsIdentitySha256(requirements),
    repositoryIdentitySha256: digest("repository"),
    repositoryRevision: revision,
  };
}

function artifact(overrides: Partial<DelegatedTaskFulfillmentInputV1["artifacts"][number]> = {}) {
  return {
    evidenceId: "artifact:result",
    ...evidenceIdentity(),
    locator: "docs/result.md",
    digestSha256: digest("artifact-bytes"),
    boundRequirementIds: ["R1"],
    persistence: "applied" as const,
    supportClass: "supported" as const,
    ...overrides,
  };
}

function check(state: "not-run" | "unknown" | "passed" | "failed") {
  return {
    evidenceId: "check:docs-check",
    ...evidenceIdentity(),
    checkId: "docs-check",
    state,
    receiptSha256: state === "passed" ? digest("receipt") : null,
    boundRequirementIds: ["R2"],
  };
}

function output(
  result: ReturnType<typeof projectDelegatedTaskFulfillment>,
  options: Parameters<typeof delegatedTaskPresentation>[1] = {},
) {
  const capabilities = resolvePresentationCapabilities({
    stdout: { isTTY: false },
    stderr: { isTTY: false },
    environment: { noColorPresent: true, forceColor: false, ci: true, termDumb: true },
    unicode: false,
  });
  return renderPresentation(delegatedTaskPresentation(result, options), capabilities).stdout;
}

describe("delegated task shared presentation", () => {
  it("keeps each terminal reason, fulfillment, unmet requirement, and next action visible", () => {
    const cases = [
      { stopReason: "needs-input" as const, pendingQuestions: [{ questionId: "Q1" }] },
      { stopReason: "failed" as const },
      { stopReason: "cancelled" as const },
      { stopReason: "budget-exhausted" as const },
      { stopReason: "deadline-exceeded" as const },
    ];
    for (const terminal of cases) {
      const result = projectDelegatedTaskFulfillment(baseInput(terminal));
      const text = output(result);
      expect(text).toContain(`Stop reason: ${terminal.stopReason}`);
      expect(text).toContain(`Fulfillment: ${result.fulfillment}`);
      expect(text).toContain("Next action:");
      if (terminal.stopReason === "needs-input") expect(text).toContain("Pending questions: Q1");
    }

    const incomplete = projectDelegatedTaskFulfillment(
      baseInput({ artifacts: [artifact()], checks: [check("not-run")] }),
    );
    expect(incomplete.unmetRequirementIds).toContain("R2");
    expect(output(incomplete)).toContain("Unmet requirements: R2.");
  });

  it("shows unsupported drafts, unapplied candidates, failed persistence, incomplete checks, and child quality uncertainty", () => {
    const result = projectDelegatedTaskFulfillment(
      baseInput({
        artifacts: [artifact({ supportClass: "unsupported-draft", persistence: "candidate" })],
        checks: [check("not-run")],
        children: [
          {
            childId: "run:child",
            ...evidenceIdentity(),
            workflow: "create-documentation",
            status: "failed",
            failureCode: "workflow-failed",
            formalQuality: "not-established",
            attemptedRequirementIds: ["R1"],
          },
        ],
      }),
    );
    const text = output(result);
    expect(text).toContain("unsupported-draft");
    expect(text).toContain("candidate");
    expect(text).toContain("incomplete-requested-checks");
    expect(text).toContain("quality-not-established");
    expect(text).toContain("local-candidate-not-applied");

    const failedPersistence = projectDelegatedTaskFulfillment(
      baseInput({
        artifacts: [artifact({ persistence: "persistence-failed" })],
        checks: [check("not-run")],
      }),
    );
    expect(output(failedPersistence)).toContain("persistence-failed");
  });

  it("retains material limit guidance in quiet output while suppressing an optional answer", () => {
    const result = projectDelegatedTaskFulfillment(
      baseInput({
        stopReason: "needs-input",
        pendingQuestions: [{ questionId: "Q1" }],
      }),
    );
    const quiet = output(result, {
      answer: "Optional answer prose",
      limitNotice: "token ceiling reached; resume with a larger token limit",
      includeAnswer: false,
    });
    expect(quiet).toContain("token ceiling reached");
    expect(quiet).toContain("Delegated task");
    expect(quiet).not.toContain("Optional answer prose");
  });

  it("preserves answer line breaks while escaping unsafe controls", () => {
    const result = projectDelegatedTaskFulfillment(baseInput());
    const text = output(result, {
      answer: "First paragraph.\n\n- second line with hostile \u202E marker",
      includeAnswer: true,
    });
    expect(text).toContain("First paragraph.\n  \n  - second line with hostile ");
    expect(text).toContain("\\u{202e} marker");
    expect(text).not.toContain("\\u{a}");
  });

  it("leaves the versioned JSON result contract untouched", () => {
    const result = projectDelegatedTaskFulfillment(
      baseInput({ artifacts: [artifact()], checks: [check("passed")] }),
    );
    expect(JSON.parse(formatDelegatedTaskResultJson(result))).toEqual(result);
  });
});
