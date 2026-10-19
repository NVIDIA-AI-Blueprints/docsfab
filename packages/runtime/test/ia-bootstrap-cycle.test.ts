// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import type { RunRecord } from "../src/records/contracts.js";
import { IaSiteBootstrapCycleCoordinator, IaSiteBootstrapCycleError } from "../src/ia/index.js";

const IDENTITY = "1".repeat(64);
const REVISION = "a".repeat(40);
const ANALYSIS_DIGEST = "2".repeat(64);
const PLANNING_DIGEST = "3".repeat(64);
const PLAN_DIGEST = "4".repeat(64);
const EXPIRES = "2099-08-10T12:00:00.000Z";

describe("IA site bootstrap cycle coordinator", () => {
  it("runs only the fixed read-only cycle and returns a frozen human-approval handoff", async () => {
    const calls: string[] = [];
    const coordinator = new IaSiteBootstrapCycleCoordinator({
      provisionAnalysis: async (input) => {
        calls.push(`provision-analysis:${input.task.scope}/${input.task.mode}`);
        return packageReceipt(ANALYSIS_DIGEST);
      },
      runAnalysis: async (input) => {
        calls.push(`run-analysis:${input.inputDigest}`);
        return record("analysis-1", "ia-analysis");
      },
      provisionPlanning: async (input) => {
        calls.push(`provision-planning:${input.analysisRunId}:${input.analysisInputDigest}`);
        return packageReceipt(PLANNING_DIGEST);
      },
      runPlanning: async (input) => {
        calls.push(`run-planning:${input.inputDigest}`);
        return record("planning-1", "ia-plan", true);
      },
    });

    const receipt = await coordinator.run({
      repositoryIdentity: IDENTITY,
      repositoryRevision: REVISION,
      expiresAt: EXPIRES,
      commandRepositoryPath: "/selected/router repo",
      reviewer: {
        reviewerPolicyPath: "/host-only/reviewers.json",
        reviewerId: "maintainer:docs",
        privateKeyPath: "/host-only/reviewer.pem",
      },
    });

    expect(calls).toEqual([
      "provision-analysis:site/create",
      `run-analysis:${ANALYSIS_DIGEST}`,
      `provision-planning:analysis-1:${ANALYSIS_DIGEST}`,
      `run-planning:${PLANNING_DIGEST}`,
    ]);
    expect(receipt).toEqual({
      schemaVersion: 1,
      kind: "docsfab-ia-site-bootstrap-cycle",
      disposition: "needs-human-decision",
      repositoryIdentity: IDENTITY,
      repositoryRevision: REVISION,
      analysis: { runId: "analysis-1", inputDigest: ANALYSIS_DIGEST },
      planning: { runId: "planning-1", inputDigest: PLANNING_DIGEST, iaPlanDigest: PLAN_DIGEST },
      expiresAt: EXPIRES,
      writesAuthorized: false,
      nextCommand:
        "docsfab ia approve --repo '/selected/router repo' --revision " +
        REVISION +
        " --scope site --mode create --run-id 'planning-1' --reviewer-policy '/host-only/reviewers.json' --reviewer-id 'maintainer:docs' --private-key '/host-only/reviewer.pem'",
    });
    expect(Object.isFrozen(receipt)).toBe(true);
    expect(Object.isFrozen(receipt.planning)).toBe(true);
  });

  it.each([
    ["needs-input analysis", () => record("analysis-1", "ia-analysis", false, "needs-input")],
    ["failed analysis", () => record("analysis-1", "ia-analysis", false, "failed")],
    [
      "substituted planning revision",
      () => record("planning-1", "ia-plan", true, "succeeded", "b".repeat(40)),
    ],
    ["planning without an output ia-plan", () => record("planning-1", "ia-plan")],
  ])("fails closed for %s", async (_name, badRecord) => {
    const coordinator = new IaSiteBootstrapCycleCoordinator({
      provisionAnalysis: async () => packageReceipt(ANALYSIS_DIGEST),
      runAnalysis: async () => record("analysis-1", "ia-analysis"),
      provisionPlanning: async () => packageReceipt(PLANNING_DIGEST),
      runPlanning: async () => badRecord(),
    });

    await expect(coordinator.run(request())).rejects.toThrow(IaSiteBootstrapCycleError);
  });
});

function packageReceipt(inputDigest: string) {
  return {
    repositoryIdentity: IDENTITY,
    repositoryRevision: REVISION,
    inputDigest,
    expiresAt: EXPIRES,
  };
}

function request() {
  return {
    repositoryIdentity: IDENTITY,
    repositoryRevision: REVISION,
    expiresAt: EXPIRES,
    commandRepositoryPath: "/selected/repository",
    reviewer: {
      reviewerPolicyPath: "/host-only/reviewers.json",
      reviewerId: "maintainer:docs",
      privateKeyPath: "/host-only/reviewer.pem",
    },
  };
}

function record(
  id: string,
  workflow: "ia-analysis" | "ia-plan",
  plan = false,
  status: "succeeded" | "needs-input" | "failed" = "succeeded",
  revision = REVISION,
): RunRecord {
  return {
    id,
    workflow,
    status,
    repository: { revision },
    task: { kind: "ia-plan", scope: "site", mode: "create" },
    artifacts: plan
      ? [
          {
            role: "output",
            reference: {
              kind: "ia-plan",
              schemaVersion: 1,
              digest: PLAN_DIGEST,
              repositoryRevision: revision,
              repositoryContentDigest: "5".repeat(64),
            },
          },
        ]
      : [],
  } as RunRecord;
}
