// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { formatLimitRefusal, limit, limitDefinition, resolveLimits } from "../src/config/limits.js";
import type { RunRecord } from "../src/records/contracts.js";
import { getWorkflow } from "../src/workflow-registry/catalog.js";
import { recordRunTaskLineage } from "../src/lineage/index.js";
import {
  createAutoAssessment,
  createAutoCycleRequest,
  createAutoWorkflowTaskBinding,
  createWorkflowCandidate,
  createWorkflowDecision,
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
  type AutoCycleOnceConfirmationV1,
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
const WINDOW = limit("autonomy.authorizationWindowMs");
const WINDOW_DEFAULT = limit("autonomy.authorizationWindowDefaultMs");

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
    cycleId: "cycle:once-window",
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
  return {
    schemaVersion: 2,
    id: "run-once-window",
    workflow: "create-documentation",
    repository: { sourcePath: "/tmp/source", requestedRevision: "HEAD", revision: REVISION },
    status: "succeeded",
  } as unknown as RunRecord;
}

function hostFor(
  saved: AutoCycleOnceRecordV1[],
  logs: string[],
  confirmation: AutoCycleOnceConfirmationV1,
): AutoCycleOnceHost {
  const now = () => new Date(BASE);
  return {
    now,
    confirmation,
    mintCycle: createHostAuthorityCycleMint(now),
    mintLineage: createHostAuthorityLineageMint(now),
    execute: async (input) => {
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
    log: (message) => {
      logs.push(message);
    },
  };
}

const BASE_CONFIRMATION: AutoCycleOnceConfirmationV1 = {
  authorityId: "operator-local",
  operatorIdentitySha256: "c".repeat(64),
  affirmed: true,
};

describe("auto-cycle authorization window limits", () => {
  it("admits the default window and preserves requested/effective values", async () => {
    const chain = executeChain();
    const saved: AutoCycleOnceRecordV1[] = [];
    const logs: string[] = [];
    const outcome = await runAutoCycleOnce(
      { ...chain, repository: REPOSITORY },
      hostFor(saved, logs, BASE_CONFIRMATION),
    );

    expect(outcome.record.authorizationWindow).toEqual({
      requestedMs: WINDOW_DEFAULT.value,
      effectiveMs: WINDOW_DEFAULT.value,
      source: "default",
    });
    expect(logs.join("\n")).toContain(`requested ${WINDOW_DEFAULT.value} ms`);
    expect(logs.join("\n")).toContain(`effective ${WINDOW_DEFAULT.value} ms`);
  });

  it("admits an explicit window at the default plus one without clamping to the default", async () => {
    const chain = executeChain();
    const saved: AutoCycleOnceRecordV1[] = [];
    const requestedMs = WINDOW_DEFAULT.value + 1;
    const outcome = await runAutoCycleOnce(
      { ...chain, repository: REPOSITORY },
      hostFor(saved, [], { ...BASE_CONFIRMATION, windowMs: requestedMs }),
    );

    expect(outcome.record.authorizationWindow).toEqual({
      requestedMs,
      effectiveMs: requestedMs,
      source: "confirmation",
    });
  });

  it("admits a requested window at the catalog bound", async () => {
    const chain = executeChain();
    const saved: AutoCycleOnceRecordV1[] = [];
    const outcome = await runAutoCycleOnce(
      { ...chain, repository: REPOSITORY },
      hostFor(saved, [], { ...BASE_CONFIRMATION, windowMs: WINDOW.value }),
    );

    expect(outcome.record.authorizationWindow).toEqual({
      requestedMs: WINDOW.value,
      effectiveMs: WINDOW.value,
      source: "confirmation",
    });
  });

  it("refuses a requested window at the catalog bound plus one without rewriting it", async () => {
    const chain = executeChain();
    const saved: AutoCycleOnceRecordV1[] = [];
    const logs: string[] = [];
    const requestedMs = WINDOW.value + 1;
    const message = formatLimitRefusal(WINDOW, requestedMs);

    await expect(
      runAutoCycleOnce(
        { ...chain, repository: REPOSITORY },
        hostFor(saved, logs, { ...BASE_CONFIRMATION, windowMs: requestedMs }),
      ),
    ).rejects.toThrow(message);
    expect(saved).toHaveLength(0);
    expect(logs.join("\n")).toContain(`requested authorization window ${requestedMs} ms`);
    expect(logs.join("\n")).toContain(`effective ceiling ${WINDOW.value} ms`);
    expect(logs.join("\n")).toContain("Recover.");
  });

  it("refuses a non-positive requested window instead of substituting the default", async () => {
    const chain = executeChain();
    await expect(
      runAutoCycleOnce(
        { ...chain, repository: REPOSITORY },
        hostFor([], [], { ...BASE_CONFIRMATION, windowMs: 0 }),
      ),
    ).rejects.toBeInstanceOf(AutoCycleOnceError);
    await expect(
      runAutoCycleOnce(
        { ...chain, repository: REPOSITORY },
        hostFor([], [], { ...BASE_CONFIRMATION, windowMs: 0 }),
      ),
    ).rejects.toMatchObject({ code: "invalid-authorization-window" });
  });
});

function hostShrink(assignments: Record<string, number>) {
  const environment: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(assignments)) {
    const key = limitDefinition(name).override;
    if (!key) {
      throw new Error(`missing host override key for ${name}`);
    }
    environment[key] = String(value);
  }
  return { environment, hostFile: null as const };
}

describe("auto-cycle authorization window host overrides", () => {
  it("declares override keys and refuses a raised or malformed value at startup", () => {
    for (const name of [
      "autonomy.authorizationWindowMs",
      "autonomy.authorizationWindowDefaultMs",
    ] as const) {
      const definition = limitDefinition(name);
      expect(definition.override).toMatch(/^DOCSFAB_[A-Z0-9_]+$/u);
      const paired =
        name === "autonomy.authorizationWindowMs"
          ? {
              "autonomy.authorizationWindowMs": definition.min,
              "autonomy.authorizationWindowDefaultMs": definition.min,
            }
          : {
              "autonomy.authorizationWindowMs": 1000,
              "autonomy.authorizationWindowDefaultMs": definition.min,
            };
      const options = hostShrink(paired);
      expect(limit(name, options)).toMatchObject({
        value: definition.min,
        source: "host",
      });
      expect(() =>
        resolveLimits({
          environment: { [definition.override!]: String(definition.max + 1) },
          hostFile: null,
        }),
      ).toThrow(
        `${definition.override} must be an integer between ${definition.min} and ${definition.max}.`,
      );
      expect(() =>
        resolveLimits({
          environment: { [definition.override!]: "not-a-number" },
          hostFile: null,
        }),
      ).toThrow(
        `${definition.override} must be an integer between ${definition.min} and ${definition.max}.`,
      );
    }
  });

  it("refuses a default authorization window above the effective maximum at startup", () => {
    const maximum = limitDefinition("autonomy.authorizationWindowMs");
    const fallback = limitDefinition("autonomy.authorizationWindowDefaultMs");
    expect(() => resolveLimits(hostShrink({ "autonomy.authorizationWindowMs": 1000 }))).toThrow(
      `${fallback.override} ${fallback.value} must be <= ${maximum.override} 1000.`,
    );
  });

  it("admits a requested window at a host-shrunk bound and refuses one millisecond over", async () => {
    const options = hostShrink({
      "autonomy.authorizationWindowMs": 1000,
      "autonomy.authorizationWindowDefaultMs": 500,
    });
    const ceiling = limit("autonomy.authorizationWindowMs", options);
    const chain = executeChain();
    const admitted = await runAutoCycleOnce(
      { ...chain, repository: REPOSITORY },
      hostFor([], [], { ...BASE_CONFIRMATION, windowMs: ceiling.value }),
      options,
    );
    expect(admitted.record.authorizationWindow).toEqual({
      requestedMs: ceiling.value,
      effectiveMs: ceiling.value,
      source: "confirmation",
    });

    const requestedMs = ceiling.value + 1;
    const saved: AutoCycleOnceRecordV1[] = [];
    const logs: string[] = [];
    await expect(
      runAutoCycleOnce(
        { ...chain, repository: REPOSITORY },
        hostFor(saved, logs, { ...BASE_CONFIRMATION, windowMs: requestedMs }),
        options,
      ),
    ).rejects.toThrow(formatLimitRefusal(ceiling, requestedMs));
    expect(saved).toHaveLength(0);
    expect(logs.join("\n")).toContain(`requested authorization window ${requestedMs} ms`);
    expect(logs.join("\n")).toContain(`effective ceiling ${ceiling.value} ms`);
  });

  it("uses a host-shrunk default window when confirmation omits windowMs", async () => {
    const options = hostShrink({ "autonomy.authorizationWindowDefaultMs": 50 });
    const fallback = limit("autonomy.authorizationWindowDefaultMs", options);
    const chain = executeChain();
    const outcome = await runAutoCycleOnce(
      { ...chain, repository: REPOSITORY },
      hostFor([], [], BASE_CONFIRMATION),
      options,
    );
    expect(fallback.value).toBe(50);
    expect(outcome.record.authorizationWindow).toEqual({
      requestedMs: fallback.value,
      effectiveMs: fallback.value,
      source: "default",
    });
  });
});
