// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import type { RunRecord } from "../src/records/contracts.js";
import { getWorkflow } from "../src/workflow-registry/catalog.js";
import { recordRunTaskLineage } from "../src/lineage/index.js";
import {
  AutoCycleContractError,
  createAutoAssessment,
  createAutoCycleRequest,
  createAutoWorkflowTaskBinding,
  createWorkflowCandidate,
  createWorkflowDecision,
  validateAutoCycleCheckpointChain,
  type AutoAssessmentV1,
  type AutoCycleRequestV1,
  type WorkflowCandidateV1,
  type WorkflowDecisionV1,
} from "./support/autonomy-contracts.js";
import {
  AutoCycleOnceError,
  createHostAuthorityCycleMint,
  createHostAuthorityLineageMint,
  runAutoCycleOnce,
  type AutoCycleOnceExecuteInputV1,
  type AutoCycleOnceHost,
  type AutoCycleOnceRecordV1,
} from "../src/autonomy/once.js";

const IDENTITY = "1".repeat(64);
const REVISION = "a".repeat(40);
const FINDING_SHA = "4".repeat(64);
const FINGERPRINT = "5".repeat(64);
const EVIDENCE = "b".repeat(64);
const BASE = Date.parse("2026-08-07T12:00:00.000Z");

const REPOSITORY = { identitySha256: IDENTITY, revision: REVISION };

const CONFIRMATION = {
  authorityId: "operator-local",
  operatorIdentitySha256: "c".repeat(64),
  affirmed: true as const,
};

interface Chain {
  request: AutoCycleRequestV1;
  assessment: AutoAssessmentV1;
  decision: WorkflowDecisionV1;
  candidate: WorkflowCandidateV1;
}

function executeChain(): Chain {
  const binding = createAutoWorkflowTaskBinding("create-documentation", null, REPOSITORY);
  const stepIds = getWorkflow("create-documentation").steps.map((step) => step.id);
  const request = createAutoCycleRequest({
    cycleId: "cycle:once-fixture",
    repository: REPOSITORY,
    tracker: {
      projectIdentitySha256: "2".repeat(64),
      observationSha256: "3".repeat(64),
      observedAt: "2026-08-07T11:59:00.000Z",
      authority: "observe-only",
    },
    maturityFindingSha256s: [FINDING_SHA],
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
      stepIds,
      prerequisites: [{ id: "scaffold-ready", state: "satisfied", evidenceSha256s: [EVIDENCE] }],
      maturityFindingFingerprints: [FINGERPRINT],
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
          fingerprint: FINGERPRINT,
          findingSha256: FINDING_SHA,
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
  return { request, assessment, decision, candidate: assessment.candidates[0]! };
}

function succeededRun(): RunRecord {
  const partial = {
    schemaVersion: 2,
    id: "run-once-fixture",
    workflow: "create-documentation",
    repository: { sourcePath: "/tmp/source", requestedRevision: "HEAD", revision: REVISION },
    status: "succeeded",
  };
  return partial as unknown as RunRecord;
}

function fixedNow(): () => Date {
  return () => new Date(BASE);
}

function incrementingNow(stepMs: number): () => Date {
  let count = 0;
  return () => new Date(BASE + count++ * stepMs);
}

interface HostOptions {
  now?: () => Date;
  affirmed?: boolean;
  onExecute?: (input: AutoCycleOnceExecuteInputV1) => void;
}

function buildHost(
  saved: AutoCycleOnceRecordV1[],
  options: HostOptions = {},
): {
  host: AutoCycleOnceHost;
  executed: AutoCycleOnceExecuteInputV1[];
} {
  const now = options.now ?? fixedNow();
  const executed: AutoCycleOnceExecuteInputV1[] = [];
  const host: AutoCycleOnceHost = {
    now,
    confirmation: { ...CONFIRMATION, affirmed: (options.affirmed ?? true) as true },
    mintCycle: createHostAuthorityCycleMint(now),
    mintLineage: createHostAuthorityLineageMint(now),
    execute: async (input) => {
      options.onExecute?.(input);
      executed.push(input);
      const record = succeededRun();
      recordRunTaskLineage(record, input.taskLineage);
      return record;
    },
    validate: async (_record, ids) =>
      ids.map((id) => ({
        id,
        status: "passed" as const,
        evidenceSha256: "9".repeat(64),
      })),
    save: async (record) => {
      saved.push(record);
    },
  };
  return { host, executed };
}

describe("one bounded workflow under one cycle authorization (#99)", () => {
  it("executes exactly one write under a single affirmative confirmation", async () => {
    const chain = executeChain();
    const saved: AutoCycleOnceRecordV1[] = [];
    const { host, executed } = buildHost(saved);
    const outcome = await runAutoCycleOnce({ ...chain, repository: REPOSITORY }, host);

    expect(executed).toHaveLength(1);
    expect(executed[0]!.workflow).toBe("create-documentation");
    expect(executed[0]!.allowWrite).toBe(true);
    expect(executed[0]!.task).toBeNull();
    expect(outcome.record.disposition).toBe("executed-succeeded");
    expect(outcome.record.runRecordId).toBe("run-once-fixture");
    expect(outcome.record.publicationEligibility?.eligible).toBe(true);
    expect(outcome.record.authorizationProjection?.workflow).toBe("create-documentation");
    expect(saved).toHaveLength(1);

    const checkpoints = validateAutoCycleCheckpointChain(
      outcome.record.checkpoints.map((value) => JSON.parse(JSON.stringify(value))),
    );
    expect(checkpoints.map((item) => item.phase)).toEqual([
      "assessing",
      "decided",
      "authorized",
      "executing",
    ]);
    expect(outcome.record.terminalResult.workflowExecutionStatus).toBe("succeeded");
    expect(outcome.record.terminalResult.validation.every((v) => v.status === "passed")).toBe(true);
  });

  it("mints authentic operator-directed lineage that gates publication", async () => {
    const chain = executeChain();
    const saved: AutoCycleOnceRecordV1[] = [];
    let captured: AutoCycleOnceExecuteInputV1 | undefined;
    const { host } = buildHost(saved, { onExecute: (input) => (captured = input) });
    await runAutoCycleOnce({ ...chain, repository: REPOSITORY }, host);
    expect(captured).toBeDefined();
    const serialized = JSON.stringify(captured!.taskLineage);
    expect(serialized).toContain("operator-directed");
    expect(serialized).toContain("host-authenticated");
  });
});

function noActionChain(): Chain {
  const base = executeChain();
  const assessment = createAutoAssessment(
    {
      requestSha256: base.request.requestSha256,
      repository: base.request.repository,
      trackerObservationSha256: base.request.tracker.observationSha256,
      evidenceState: "sufficient",
      maturityFindings: [
        {
          fingerprint: FINGERPRINT,
          findingSha256: FINDING_SHA,
          confidence: "confirmed",
          disposition: "satisfied",
        },
      ],
      candidates: [],
      openInputIds: [],
    },
    base.request,
  );
  const decision = createWorkflowDecision(
    {
      disposition: "no-action",
      reasonCode: "maturity-satisfied",
    },
    base.request,
    assessment,
  );
  return { request: base.request, assessment, decision, candidate: base.candidate };
}

describe("one cycle authorization negative and no-action paths (#99)", () => {
  it("performs no write for an assessment-only no-action decision", async () => {
    const chain = noActionChain();
    const saved: AutoCycleOnceRecordV1[] = [];
    const { host, executed } = buildHost(saved);
    const outcome = await runAutoCycleOnce({ ...chain, repository: REPOSITORY }, host);
    expect(executed).toHaveLength(0);
    expect(outcome.runRecord).toBeNull();
    expect(outcome.record.disposition).toBe("no-action");
    expect(outcome.record.runRecordId).toBeNull();
    expect(outcome.record.authorizationProjection).toBeNull();
    expect(outcome.record.terminalResult.workflowExecutionStatus).toBe("not-run");
    expect(outcome.record.checkpoints).toHaveLength(2);
  });

  it("refuses to write when the confirmation is not affirmed", async () => {
    const chain = executeChain();
    const saved: AutoCycleOnceRecordV1[] = [];
    const { host, executed } = buildHost(saved, { affirmed: false });
    await expect(
      runAutoCycleOnce({ ...chain, repository: REPOSITORY }, host),
    ).rejects.toBeInstanceOf(AutoCycleOnceError);
    expect(executed).toHaveLength(0);
    expect(saved).toHaveLength(0);
  });

  it("rejects stale evidence at the reused write gate and performs no write", async () => {
    const chain = executeChain();
    const saved: AutoCycleOnceRecordV1[] = [];
    const { host, executed } = buildHost(saved, { now: incrementingNow(20 * 60_000) });
    await expect(
      runAutoCycleOnce({ ...chain, repository: REPOSITORY }, host),
    ).rejects.toBeInstanceOf(AutoCycleContractError);
    expect(executed).toHaveLength(0);
    expect(saved).toHaveLength(0);
  });
});

describe("one cycle authorization rejects scope growth (#99)", () => {
  it("rejects path expansion beyond the documentation-only ceiling", () => {
    const chain = executeChain();
    expect(() =>
      createWorkflowCandidate(
        {
          id: "candidate:expanded",
          taskSha256: chain.candidate.taskSha256,
          workflow: "create-documentation",
          stepIds: getWorkflow("create-documentation").steps.map((step) => step.id),
          prerequisites: [
            { id: "scaffold-ready", state: "satisfied", evidenceSha256s: [EVIDENCE] },
          ],
          maturityFindingFingerprints: [FINGERPRINT],
          pathClass: "documentation-write",
          pathPrefixes: ["docs", "src"],
          deliveryMode: "local-patch",
          validationIds: ["docs-build"],
        },
        chain.request,
      ),
    ).toThrow(AutoCycleContractError);
  });

  it("rejects substituting a workflow the cycle never bound", () => {
    const chain = executeChain();
    expect(() =>
      createWorkflowCandidate(
        {
          id: "candidate:substitute",
          taskSha256: chain.candidate.taskSha256,
          workflow: "review-documentation",
          stepIds: getWorkflow("review-documentation").steps.map((step) => step.id),
          prerequisites: [
            { id: "scaffold-ready", state: "satisfied", evidenceSha256s: [EVIDENCE] },
          ],
          maturityFindingFingerprints: [FINGERPRINT],
          pathClass: "documentation-write",
          pathPrefixes: ["docs"],
          deliveryMode: "local-patch",
          validationIds: ["docs-build"],
        },
        chain.request,
      ),
    ).toThrow(AutoCycleContractError);
  });
});
