// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  createManagedIssueIdentity,
  createRoadmapLedger,
  createRoadmapMutationAuthorizationV2,
  createRoadmapMutationPlanV2,
  createRoadmapMutationReceiptV2,
  recordManagedIssueStateAdvanceV1,
  restoreManagedIssueStateAdvanceV1,
  roadmapFindingFingerprint,
  roadmapProjectEffectProofDigestV2,
  type RoadmapLedger,
} from "../src/roadmap/index.js";

const T0 = "2026-08-05T00:00:00.000Z";
const T1 = "2026-08-05T00:01:00.000Z";
const T2 = "2026-08-05T00:02:00.000Z";
const T3 = "2026-08-05T00:03:00.000Z";

describe("managed issue state advances", () => {
  it("rejects a structurally valid receipt that was not issued by lifecycle execution", () => {
    const context = stateContext();
    expect(() => recordManagedIssueStateAdvanceV1(context)).toThrow(/invalid-evidence/u);
    expect(() => restoreManagedIssueStateAdvanceV1({}, context)).toThrow(/invalid-evidence/u);
  });

  it("rejects another finding identity and an unconfirmed operation", () => {
    const context = stateContext();
    const otherIdentity = createManagedIssueIdentity(context.ledger, "finding:two");
    expect(() => recordManagedIssueStateAdvanceV1({ ...context, identity: otherIdentity })).toThrow(
      /invalid-evidence/u,
    );

    const receipt = createRoadmapMutationReceiptV2(
      {
        id: "receipt:failed",
        attempts: [
          {
            operationKey: "operation:create",
            attempt: 1,
            idempotencyKey: context.plan.operations[0]!.idempotencyKey,
            phase: "mutation",
            disposition: "failed",
            startedAt: T1,
            completedAt: T2,
            failureCode: "provider-failure",
          },
        ],
        createdAt: T1,
        updatedAt: T2,
      },
      context.ledger,
      context.plan,
      context.authorization,
    );
    expect(() => recordManagedIssueStateAdvanceV1({ ...context, receipt })).toThrow(
      /invalid-evidence/u,
    );
  });
});

function stateContext() {
  const ledger = makeLedger();
  const plan = createRoadmapMutationPlanV2(
    {
      id: "plan:managed-state",
      ledger: {
        kind: "roadmap-ledger",
        schemaVersion: 1,
        digest: ledger.digest,
        repositoryRevision: ledger.repository.revision,
        repositoryContentDigest: ledger.repository.contentDigest,
      },
      repository: ledger.repository,
      project: ledger.project,
      trackerObservedAt: ledger.trackerObservedAt,
      operations: [
        {
          key: "operation:create",
          kind: "issue",
          findingIds: ["finding:one"],
          dependsOnOperationKeys: [],
          target: { source: "project", targetKey: "project:42" },
          preconditions: [],
          proposal: { kind: "issue", intent: "create", effectKind: "issue" },
          materialDigest: "1".repeat(64),
          materialBytes: 32,
          expectedEffectKind: "issue",
        },
      ],
      generatedAt: T0,
      expiresAt: T3,
    },
    ledger,
  );
  const authorization = createRoadmapMutationAuthorizationV2(
    {
      id: "authorization:managed-state",
      authorizedOperationKeys: ["operation:create"],
      authority: { kind: "local-user", id: "local-user:test" },
      issuedAt: T0,
      expiresAt: T3,
    },
    plan,
    ledger,
  );
  const operation = plan.operations[0]!;
  const receipt = createRoadmapMutationReceiptV2(
    {
      id: "receipt:managed-state",
      attempts: [
        {
          operationKey: operation.key,
          attempt: 1,
          idempotencyKey: operation.idempotencyKey,
          phase: "mutation",
          disposition: "succeeded",
          startedAt: T1,
          completedAt: T2,
          effect: {
            kind: "issue",
            targetKey: "issue:7",
            externalId: "7",
            state: "opened",
            updatedAt: T2,
            identityDigest: "7".repeat(64),
            operationProofDigest: roadmapProjectEffectProofDigestV2(operation),
          },
        },
      ],
      createdAt: T1,
      updatedAt: T2,
    },
    ledger,
    plan,
    authorization,
  );
  return {
    ledger,
    plan,
    authorization,
    receipt,
    operationKey: operation.key,
    identity: createManagedIssueIdentity(ledger, "finding:one"),
  };
}

function makeLedger(): RoadmapLedger {
  const findings = [finding("one", "1"), finding("two", "2")];
  return createRoadmapLedger({
    id: "ledger:managed-state",
    repository: { revision: "a".repeat(40), contentDigest: "b".repeat(64) },
    project: {
      provider: "gitlab",
      host: "gitlab.example.com",
      fullPath: "group/project",
      projectId: 42,
    },
    boundary: {
      id: "boundary:managed-state",
      mode: "documentation-health",
      observedAt: T0,
      queryDigest: "c".repeat(64),
    },
    trackerObservedAt: T0,
    tracker: [],
    evidence: findings.map((item) => ({
      id: item.evidenceIds[0]!,
      kind: "validation" as const,
      digest: item.materialEvidenceDigest,
      repositoryRevision: "a".repeat(40),
      path: item.affectedPaths[0],
    })),
    findings,
    workstreams: findings.map((item, index) => ({
      id: `workstream:${index + 1}`,
      findingIds: [item.id],
      dependsOnWorkstreamIds: [],
      collidesWithWorkstreamIds: [],
      executionOrder: index + 1,
      state: "ready" as const,
    })),
    dedup: findings.map((item) => ({
      findingId: item.id,
      decision: "create" as const,
      rationaleCode: "new",
    })),
    transitions: [],
    sweeps: [],
    closeouts: [],
    createdAt: T0,
    updatedAt: T0,
  });
}

function finding(name: string, digit: string) {
  const material = {
    boundaryId: "boundary:managed-state",
    category: `maturity-${name}`,
    severity: "p1" as const,
    affectedPaths: [`docs/${name}.md`],
    evidenceIds: [`evidence:${digit.repeat(64)}`],
    materialEvidenceDigest: digit.repeat(64),
  };
  return {
    id: `finding:${name}`,
    ...material,
    fingerprint: roadmapFindingFingerprint(material),
    source: "documentation-health" as const,
    disposition: "repair" as const,
    lifecycle: "observed" as const,
    dependsOnFindingIds: [],
  };
}
