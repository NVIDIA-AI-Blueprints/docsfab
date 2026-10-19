// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import type { RunRecord } from "../src/records/contracts.js";
import { getWorkflow } from "../src/workflow-registry/catalog.js";
import {
  createAutoAssessment,
  createAutoCycleRequest,
  createAutoWorkflowTaskBinding,
  createWorkflowCandidate,
  createWorkflowDecision,
} from "./support/autonomy-contracts.js";
import type { AutoDryRunHostAssessmentV1 } from "../src/autonomy/dry-run-cli.js";
import { parseAutoOnceCliArguments, runAutoOnceCli } from "../src/autonomy/once-cli.js";
import type { AutoCycleOnceRecordV1 } from "../src/autonomy/once.js";

const IDENTITY = "1".repeat(64);
const REVISION = "a".repeat(40);

function readySource() {
  const repository = { identitySha256: IDENTITY, revision: REVISION };
  const binding = createAutoWorkflowTaskBinding("create-documentation", null, repository);
  const request = createAutoCycleRequest({
    cycleId: "cycle:cli-fixture",
    repository,
    tracker: {
      projectIdentitySha256: "2".repeat(64),
      observationSha256: "3".repeat(64),
      observedAt: "2026-08-07T11:59:00.000Z",
      authority: "observe-only",
    },
    maturityFindingSha256s: ["4".repeat(64)],
    bounds: {
      workflowNames: ["create-documentation"],
      pathClass: "documentation-write",
      pathPrefixes: ["docs"],
      targetBranch: "main",
      deliveryMode: "local-patch",
      requiredValidationIds: ["docs-build"],
      workflowPrerequisites: [
        { workflow: "create-documentation", prerequisiteIds: ["scaffold-ready"] },
      ],
      workflowTasks: [binding],
    },
  });
  const candidate = createWorkflowCandidate(
    {
      id: "candidate:create-documentation",
      taskSha256: binding.taskSha256,
      workflow: "create-documentation",
      stepIds: getWorkflow("create-documentation").steps.map((step) => step.id),
      prerequisites: [
        { id: "scaffold-ready", state: "satisfied", evidenceSha256s: ["b".repeat(64)] },
      ],
      maturityFindingFingerprints: ["5".repeat(64)],
      pathClass: "documentation-write",
      pathPrefixes: ["docs"],
      deliveryMode: "local-patch",
      validationIds: ["docs-build"],
    },
    request,
  );
  const { schemaVersion: _s, kind: _k, candidateSha256: _c, ...candidateInput } = candidate;
  const assessment = createAutoAssessment(
    {
      requestSha256: request.requestSha256,
      repository: request.repository,
      trackerObservationSha256: request.tracker.observationSha256,
      evidenceState: "sufficient",
      maturityFindings: [
        {
          fingerprint: "5".repeat(64),
          findingSha256: "4".repeat(64),
          confidence: "confirmed",
          disposition: "observed-absence",
        },
      ],
      candidates: [candidateInput],
      openInputIds: [],
    },
    request,
  );
  const decision = createWorkflowDecision(
    {
      disposition: "execute",
      candidateSha256: assessment.candidates[0]!.candidateSha256,
      reasonCode: "eligible-candidate-selected",
    },
    request,
    assessment,
  );
  return { request, assessment, decision };
}

function succeededRun(): RunRecord {
  return {
    schemaVersion: 2,
    id: "run-cli-fixture",
    workflow: "create-documentation",
    repository: { sourcePath: "/tmp/source", requestedRevision: "HEAD", revision: REVISION },
    status: "succeeded",
  } as unknown as RunRecord;
}

function fakeAssess(): () => Promise<AutoDryRunHostAssessmentV1> {
  const source = readySource();
  return async () =>
    ({
      status: "ready",
      source,
      dispose: async () => undefined,
    }) as unknown as AutoDryRunHostAssessmentV1;
}

describe("docsfab auto --once command wiring (#99)", () => {
  it("parses one affirmative confirmation and defaults", () => {
    const parsed = parseAutoOnceCliArguments(
      ["--once", "--confirm-cycle", "--revision", REVISION],
      "/tmp/repo",
    );
    expect(parsed.confirmCycle).toBe(true);
    expect(parsed.revision).toBe(REVISION);
    expect(parsed.authorityId).toBe("local-operator");
    expect(() => parseAutoOnceCliArguments(["--once", "--nope"], "/tmp/repo")).toThrow();
  });

  it("proposes without writing when the cycle is not confirmed", async () => {
    const logs: string[] = [];
    let ran = 0;
    await runAutoOnceCli(["--once", "--repo", "/tmp/repo"], {
      cwd: "/tmp/repo",
      log: (message) => logs.push(message),
      assess: fakeAssess(),
      runWorkflow: async () => {
        ran += 1;
        return succeededRun();
      },
      save: async () => undefined,
    });
    expect(ran).toBe(0);
    expect(logs.join("\\n")).toContain("Authorization: confirmation required");
    expect(logs.join("\\n")).toContain("--confirm-cycle");
  });

  it("executes exactly one write once the cycle is confirmed", async () => {
    const logs: string[] = [];
    const saved: AutoCycleOnceRecordV1[] = [];
    let ran = 0;
    await runAutoOnceCli(["--once", "--confirm-cycle", "--repo", "/tmp/repo"], {
      cwd: "/tmp/repo",
      now: () => new Date("2026-08-07T12:00:00.000Z"),
      log: (message) => logs.push(message),
      assess: fakeAssess(),
      runWorkflow: async () => {
        ran += 1;
        return succeededRun();
      },
      save: async (record) => {
        saved.push(record);
      },
    });
    expect(ran).toBe(1);
    expect(saved).toHaveLength(1);
    expect(saved[0]!.disposition).toBe("executed-succeeded");
    expect(logs.join("\\n")).toContain("executed-succeeded");
  });
});
