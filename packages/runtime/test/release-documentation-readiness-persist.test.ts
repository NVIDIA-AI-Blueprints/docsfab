// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { RunRecord } from "../src/records/contracts.js";
import type { WorkflowOutcomeCandidateV1 } from "../src/workflow-contracts/contracts.js";
import { serializeRunResultCliJson } from "../src/cli/run-request.js";
import {
  createWorkUnitMachineContract,
  decodeWorkUnitMachineContract,
  WORK_UNIT_MACHINE_CONTRACT_KIND,
} from "../src/maturity/work-unit-machine-contract.js";
import { buildRunResultV1, parseJsonEvidence } from "../src/operator/index.js";
import type { ReleaseDocumentationReadinessArtifactV1 } from "../src/release-documentation-readiness.js";
import * as releaseDocumentationReadiness from "../src/release-documentation-readiness.js";
import { applyWorkflowOutcome } from "../src/workflow-execution/runner-evidence.js";
import { workflowOutcomePersistenceError } from "../src/workflow-execution/runner-schedule.js";
import { workflowOutcomeStepEvidence } from "../src/workflow-contracts/outcome.js";

const SHA = (value: string) => createHash("sha256").update(value).digest("hex");

afterEach(() => {
  vi.restoreAllMocks();
});

describe("release-documentation-readiness persist (#308)", () => {
  it.each([
    { expectedRepository: undefined, trustedInventory: undefined },
    { expectedRepository: undefined, trustedInventory: dummyInventory() },
    { expectedRepository: dummyExpectedRepository(), trustedInventory: undefined },
  ])(
    "surfaces invalid-authority when expectedRepository or trustedInventory is missing",
    async (authority) => {
      const record = succeededReleaseDocRecord();
      record.workUnitMachineContracts = [
        createWorkUnitMachineContract({
          workUnitFingerprint: SHA("stale-unit"),
          repositoryIdentitySha256: SHA("stale-repo"),
          machineChecks: [
            {
              checkKind: "cli-smoke",
              commandId: "release-documentation-readiness",
              expectedOutcomeClass: "pass",
            },
          ],
          acceptanceAuthority: "host-deterministic",
          trackerMutation: "not-authorized",
        }),
      ];

      await applyWorkflowOutcome({
        record,
        ...(authority.expectedRepository
          ? { expectedRepository: authority.expectedRepository }
          : {}),
        ...(authority.trustedInventory ? { trustedInventory: authority.trustedInventory } : {}),
      });

      expect(record.status).toBe("failed");
      expect(record.workflowOutcome).toBeUndefined();
      expect(record.releaseDocumentationReadiness).toBeUndefined();
      expect(record.workUnitMachineContracts).toBeUndefined();
      expect(record.error).toContain("invalid-authority");
      expect(record.error).not.toBe(workflowOutcomePersistenceError);
      expect(JSON.stringify(record)).not.toContain(WORK_UNIT_MACHINE_CONTRACT_KIND);
    },
  );

  it("attaches WorkUnitMachineContractV1 envelopes on succeeded persist", async () => {
    const record = succeededReleaseDocRecord();
    const fingerprint = SHA("release-work-unit");
    const repositoryIdentitySha256 = SHA("release-repository");
    const contract = createWorkUnitMachineContract({
      workUnitFingerprint: fingerprint,
      repositoryIdentitySha256,
      machineChecks: [
        {
          checkKind: "cli-smoke",
          commandId: "release-documentation-readiness",
          expectedOutcomeClass: "pass",
        },
        {
          checkKind: "inventory-probe",
          inventoryProbeId: "release-launch-audiences",
          expectedOutcomeClass: "pass",
        },
      ],
      acceptanceAuthority: "host-deterministic",
      trackerMutation: "not-authorized",
    });
    vi.spyOn(
      releaseDocumentationReadiness,
      "createReleaseDocumentationReadinessResult",
    ).mockReturnValue({
      artifact: {
        kind: "docsfab-release-documentation-readiness",
      } as ReleaseDocumentationReadinessArtifactV1,
      outcome: notReadyCandidate(record),
      machineContracts: [contract],
    });

    await applyWorkflowOutcome({
      record,
      expectedRepository: dummyExpectedRepository(),
      trustedInventory: dummyInventory(),
    });

    expect(record.status).toBe("succeeded");
    expect(record.workflowOutcome).toBeDefined();
    expect(record.workUnitMachineContracts).toHaveLength(1);
    const persisted = decodeWorkUnitMachineContract(record.workUnitMachineContracts![0]);
    expect(persisted.kind).toBe(WORK_UNIT_MACHINE_CONTRACT_KIND);
    expect(persisted.workUnitFingerprint).toBe(fingerprint);
    expect(persisted.repositoryIdentitySha256).toBe(repositoryIdentitySha256);
    expect(persisted.trackerMutation).toBe("not-authorized");

    const runRecordJson = JSON.parse(JSON.stringify(record)) as RunRecord;
    expect(runRecordJson.workUnitMachineContracts?.[0]?.kind).toBe(WORK_UNIT_MACHINE_CONTRACT_KIND);
    expect(runRecordJson.workUnitMachineContracts?.[0]?.trackerMutation).toBe("not-authorized");

    const cliJson = parseJsonEvidence(
      serializeRunResultCliJson(
        buildRunResultV1({
          record,
          recordPath: "/private/state/run-persist.json",
          exitCode: 0,
          repositoryPath: "/private/source",
          nextSteps: [],
        }),
        record,
      ),
    ) as {
      workUnitMachineContracts?: Array<{
        kind: string;
        workUnitFingerprint: string;
        trackerMutation: string;
      }>;
    };
    expect(cliJson.workUnitMachineContracts).toHaveLength(1);
    expect(cliJson.workUnitMachineContracts?.[0]?.kind).toBe(WORK_UNIT_MACHINE_CONTRACT_KIND);
    expect(cliJson.workUnitMachineContracts?.[0]?.workUnitFingerprint).toBe(fingerprint);
    expect(cliJson.workUnitMachineContracts?.[0]?.trackerMutation).toBe("not-authorized");
  });

  it("does not emit contracts when outcome persist fails after projection", async () => {
    const record = succeededReleaseDocRecord();
    vi.spyOn(
      releaseDocumentationReadiness,
      "createReleaseDocumentationReadinessResult",
    ).mockReturnValue({
      artifact: {
        kind: "docsfab-release-documentation-readiness",
      } as ReleaseDocumentationReadinessArtifactV1,
      outcome: {
        disposition: "ready",
        findings: [
          {
            id: "finding:contradiction",
            kind: "product-gap",
            severity: "blocking",
            code: "contradiction",
            evidenceIds: ["step:assess-release-documentation-readiness"],
          },
        ],
        evidence: [workflowOutcomeStepEvidence(record, "assess-release-documentation-readiness")],
        limitations: [],
        openDecisions: [],
        producedArtifacts: [],
      },
      machineContracts: [
        createWorkUnitMachineContract({
          workUnitFingerprint: SHA("should-not-emit"),
          repositoryIdentitySha256: SHA("should-not-emit-repo"),
          machineChecks: [
            {
              checkKind: "cli-smoke",
              commandId: "release-documentation-readiness",
              expectedOutcomeClass: "pass",
            },
          ],
          acceptanceAuthority: "host-deterministic",
          trackerMutation: "not-authorized",
        }),
      ],
    });

    await applyWorkflowOutcome({
      record,
      expectedRepository: dummyExpectedRepository(),
      trustedInventory: dummyInventory(),
    });

    expect(record.status).toBe("failed");
    expect(record.workflowOutcome).toBeUndefined();
    expect(record.workUnitMachineContracts).toBeUndefined();
    expect(record.releaseDocumentationReadiness).toBeUndefined();
  });
});

function succeededReleaseDocRecord(): RunRecord {
  return {
    schemaVersion: 2,
    id: "run-persist-308",
    workflow: "release-documentation-readiness",
    repository: {
      sourcePath: "/private/source",
      requestedRevision: "HEAD",
      revision: "a".repeat(40),
    },
    workspace: { strategy: "tracked-export", disposable: true },
    status: "succeeded",
    createdAt: "2026-08-05T00:00:00.000Z",
    startedAt: "2026-08-05T00:00:00.000Z",
    completedAt: "2026-08-05T00:00:01.000Z",
    durationMs: 1_000,
    models: [],
    skills: [],
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 0,
      turns: 0,
    },
    tools: { totalCalls: 0, failedCalls: 0, byTool: [] },
    steps: [
      {
        id: "assess-release-documentation-readiness",
        title: "Assess public release-documentation readiness",
        kind: "inference",
        skill: "doc-context-analyzer",
        mode: "read-only",
        status: "succeeded",
        startedAt: "2026-08-05T00:00:00.000Z",
        completedAt: "2026-08-05T00:00:01.000Z",
        durationMs: 1_000,
        summary: "Typed persist fixture.",
      },
    ],
  };
}

function notReadyCandidate(record: RunRecord): WorkflowOutcomeCandidateV1 {
  const evidence = workflowOutcomeStepEvidence(record, "assess-release-documentation-readiness");
  return {
    disposition: "not-ready",
    findings: [
      {
        id: "finding:public-docs-gap",
        kind: "product-gap",
        severity: "blocking",
        code: "public-docs-gap",
        evidenceIds: [evidence.id],
      },
    ],
    evidence: [evidence],
    limitations: [],
    openDecisions: [],
    producedArtifacts: [],
  };
}

function dummyExpectedRepository() {
  return {
    sourcePath: "/private/source",
    requestedRevision: "HEAD",
    revision: "a".repeat(40),
    defaultBranch: "main",
  };
}

function dummyInventory() {
  return {
    schemaVersion: 1 as const,
    kind: "docsfab-repository-discovery-inventory" as const,
  } as never;
}
