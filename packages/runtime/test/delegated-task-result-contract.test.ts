// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  createDelegatedTaskResult,
  decodeDelegatedTaskResult,
  DelegatedTaskResultError,
  delegatedTaskContractKit,
  delegatedTaskRequirementIdentitySha256,
  delegatedTaskRequirementsIdentitySha256,
  type DelegatedTaskResultV1,
} from "../src/delegated-task/result-contract.js";
import { projectDelegatedTaskFulfillment } from "../src/delegated-task/fulfillment.js";
import type { DelegatedTaskFulfillmentInputV1 } from "../src/delegated-task/fulfillment.js";
import { configureCredential } from "./helpers/configured-credential.js";

const { canonicalJson } = delegatedTaskContractKit;
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

function baseInput(
  overrides: Partial<DelegatedTaskFulfillmentInputV1> = {},
): DelegatedTaskFulfillmentInputV1 {
  const originalRequirements = overrides.originalRequirements ?? r1r2();
  const repository = overrides.repository ?? {
    identitySha256: SHA("repo"),
    revision: REVISION,
  };
  const request = overrides.request ?? {
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

function matchingArtifact(persistence: "candidate" | "applied" | "persistence-failed" = "applied") {
  const originalRequirements = r1r2();
  return {
    evidenceId: "artifact:a",
    taskId: TASK_ID,
    taskSha256: delegatedTaskRequirementsIdentitySha256(originalRequirements),
    repositoryIdentitySha256: SHA("repo"),
    repositoryRevision: REVISION,
    locator: "docs/a.md",
    digestSha256: SHA("docs/a.md-bytes"),
    boundRequirementIds: ["R1"],
    persistence,
    supportClass: "supported" as const,
  };
}

function matchingCheck(state: "not-run" | "unknown" | "passed" | "failed") {
  const originalRequirements = r1r2();
  return {
    evidenceId: "check:docs-check",
    taskId: TASK_ID,
    taskSha256: delegatedTaskRequirementsIdentitySha256(originalRequirements),
    repositoryIdentitySha256: SHA("repo"),
    repositoryRevision: REVISION,
    checkId: "docs-check",
    state,
    receiptSha256: state === "passed" || state === "failed" ? SHA(`receipt:${state}`) : null,
    boundRequirementIds: ["R2"],
  };
}

function completeResult(): DelegatedTaskResultV1 {
  return projectDelegatedTaskFulfillment(
    baseInput({
      artifacts: [matchingArtifact("applied")],
      checks: [matchingCheck("passed")],
    }),
  );
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

describe("delegated-task result contract", () => {
  it("seals, freezes, and round-trips canonical JSON", () => {
    const result = completeResult();
    expect(result.kind).toBe("docsfab-delegated-task-result");
    expect(result.schemaVersion).toBe(1);
    expect(Object.isFrozen(result)).toBe(true);
    expect(result.fulfillment).toBe("complete");
    expect(result.stopReason).toBe("finished");
    const json = canonicalJson(result);
    const decoded = decodeDelegatedTaskResult(JSON.parse(json));
    expect(decoded).toEqual(result);
    expect(canonicalJson(decoded)).toBe(json);
    expect(canonicalJson(completeResult())).toBe(json);
  });

  it("rejects extra fields on the sealed envelope", () => {
    const result = completeResult();
    expectCode(
      () => decodeDelegatedTaskResult({ ...result, modelSaidDone: true }),
      "invalid-shape",
    );
    expectCode(
      () =>
        decodeDelegatedTaskResult({
          ...result,
          nextAction: { ...result.nextAction, extra: "field" },
        }),
      "invalid-shape",
    );
  });

  it("rejects invalid enums and contradictory complete combinations", () => {
    const result = completeResult();
    expectCode(
      () => decodeDelegatedTaskResult({ ...result, fulfillment: "done" }),
      "invalid-value",
    );
    expectCode(
      () => decodeDelegatedTaskResult({ ...result, stopReason: "needs-input" }),
      "contradictory-state",
    );
    expectCode(
      () =>
        decodeDelegatedTaskResult({
          ...result,
          fulfillment: "complete",
          unmetRequirementIds: ["R2"],
        }),
      "contradictory-state",
    );
  });

  it("rejects credential material before digest comparison", () => {
    configureCredential("sk-abcdefghijklmnopqrstuvwxyz1234567890");
    const result = completeResult();
    expectCode(
      () =>
        decodeDelegatedTaskResult({
          ...result,
          nextAction: {
            ...result.nextAction,
            command: "sk-abcdefghijklmnopqrstuvwxyz1234567890",
          },
        }),
      "credential-material",
    );
  });

  it("createDelegatedTaskResult rejects extra body fields", () => {
    const result = completeResult();
    expectCode(
      () =>
        createDelegatedTaskResult({
          ...result,
          proseClaim: "done",
        } as Parameters<typeof createDelegatedTaskResult>[0]),
      "invalid-shape",
    );
  });
});
