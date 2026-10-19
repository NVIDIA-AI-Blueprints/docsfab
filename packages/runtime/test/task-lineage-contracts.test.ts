// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { canonicalDigest } from "../src/content-ir/canonical.js";
import * as publicApi from "../src/lineage/index.js";
import { createWorkflowLineageCandidate as createWorkflowLineageCandidateWithWorkflowAccess } from "../src/lineage/contracts.js";
import {
  decodeDecisionLineage as decodeDecisionLineageWithWorkflowAccess,
  decodePersistedDecisionLineage as decodePersistedDecisionLineageWithWorkflowAccess,
  decodeTaskLineageRecoveryAuthorization,
  mintTaskLineageHostCapability as mintTaskLineageHostCapabilityWithWorkflowAccess,
  projectTaskLineage as projectTaskLineageWithWorkflowAccess,
  recoverTaskLineageArtifacts,
  restoreTaskLineageArtifacts as restoreTaskLineageArtifactsWithWorkflowAccess,
  serializeDecisionLineage as serializeDecisionLineageWithWorkflowAccess,
} from "../src/lineage/contracts.js";
import * as workflowCatalog from "../src/workflow-registry/catalog.js";
import {
  TaskLineageContractError,
  assertTaskLineageAuthentic,
  createHistoricalUnknownTaskLineage,
  createTaskLineageArtifacts,
  createWorkflowLineageCandidate,
  decodeDecisionLineage,
  decodePersistedDecisionLineage,
  decodePersistedTaskOrigin,
  decodeTaskOrigin,
  migrateDecisionLineage,
  migrateTaskOrigin,
  mintTaskLineageHostCapability,
  projectTaskLineage,
  restoreTaskLineageArtifacts,
  serializeDecisionLineage,
  serializeTaskOrigin,
  TASK_LINEAGE_MIGRATION_POLICY,
  type AutonomousTaskSelectionV1,
  type DecisionAttributionInputV1,
  type DocsFabTaskRecommendationV1,
  type OperatorTaskApprovalV1,
  type TaskLineageAuthorityChallengeV1,
  type TaskLineageRepositoryBindingV1,
  type TaskOriginInputV1,
  type WorkflowLineageCandidateInputV1,
} from "../src/lineage/index.js";
import { internalCreateTaskLineageHostAuthority } from "../src/lineage/authority-internal.js";
import { taskLineageFixtureDigestMismatches } from "./helpers/current-task-lineage.js";
import { configureCredential } from "./helpers/configured-credential.js";

const fixture = JSON.parse(
  readFileSync(new URL("./fixtures/task-lineage-v1.json", import.meta.url), "utf8"),
) as {
  repository: TaskLineageRepositoryBindingV1;
  request: TaskOriginInputV1["request"];
  approval: OperatorTaskApprovalV1;
  recommendation: DocsFabTaskRecommendationV1;
  autonomousSelection: AutonomousTaskSelectionV1;
  candidates: WorkflowLineageCandidateInputV1[];
  selectedCandidateSha256: string;
  rejectedAlternatives: Array<{
    candidateSha256: string;
    reasonCode: string;
    evidenceSha256s: string[];
  }>;
  sharedDecisions: DecisionAttributionInputV1[];
};
const SHA = (character: string) => character.repeat(64);

describe("task-origin and decision-lineage contracts", () => {
  it("keeps authored fixture candidate digests consistent with current workflows", () => {
    expect(
      taskLineageFixtureDigestMismatches(fixture),
      "task-lineage-v1.json candidate digests changed with workflow topology; review the selected/rejected identities and contract expectations deliberately before updating the frozen fixture",
    ).toEqual([]);
  });

  it("uses caller-supplied workflow definitions to validate candidate steps", () => {
    const requestedNames: string[] = [];
    const candidate = createWorkflowLineageCandidateWithWorkflowAccess(fixture.candidates[0]!, {
      isRunnableWorkflowName: workflowCatalog.isRunnableWorkflowName,
      getWorkflow(name) {
        requestedNames.push(name);
        return workflowCatalog.getWorkflow(name);
      },
    });

    expect(candidate.workflow).toBe("update-documentation");
    expect(requestedNames.length).toBeGreaterThan(0);
    expect(new Set(requestedNames)).toEqual(new Set(["update-documentation"]));
  });

  it("serializes, restores, and projects against fake definitions while rejecting incompatible access", async () => {
    const workflows = fakeWorkflowAccess();
    const candidate = createWorkflowLineageCandidateWithWorkflowAccess(
      fixture.candidates[0]!,
      workflows,
    );
    expect(candidate.stepIds.every((stepId) => stepId.startsWith("fake-"))).toBe(true);

    const fakeCandidates = fixture.candidates.map((input) =>
      createWorkflowLineageCandidateWithWorkflowAccess(input, workflows),
    );
    const fakeLineage = lineageInput("operator-directed");
    fakeLineage.candidates = fakeCandidates.map(({ stepIds, candidateSha256, ...input }) => ({
      ...input,
      stepIds,
      candidateSha256,
    }));
    fakeLineage.selectedCandidateSha256 = fakeCandidates[0]!.candidateSha256;
    fakeLineage.rejectedAlternatives[0]!.candidateSha256 = fakeCandidates[1]!.candidateSha256;
    fakeLineage.decisions.find((decision) => decision.id === "decision:workflow")!.outcomeSha256 =
      fakeCandidates[0]!.candidateSha256;

    const capability = await mintTaskLineageHostCapabilityWithWorkflowAccess(
      {
        origin: currentOrigin("operator-directed"),
        lineage: fakeLineage,
      },
      authority(canonicalDigest("fake-lineage-receipt")),
      workflows,
    );
    const artifacts = createTaskLineageArtifacts(capability);
    const originText = serializeTaskOrigin(artifacts.origin);
    const lineageText = serializeDecisionLineageWithWorkflowAccess(
      artifacts.lineage,
      artifacts.origin,
      workflows,
    );
    const decodedOrigin = decodePersistedTaskOrigin(originText);
    const decodedLineage = decodePersistedDecisionLineageWithWorkflowAccess(
      lineageText,
      decodedOrigin,
      workflows,
    );
    expect(decodedLineage).toEqual(artifacts.lineage);
    expect(
      decodeDecisionLineageWithWorkflowAccess(JSON.parse(lineageText), decodedOrigin, workflows),
    ).toEqual(artifacts.lineage);
    expect(
      restoreTaskLineageArtifactsWithWorkflowAccess(
        { origin: decodedOrigin, lineage: decodedLineage },
        capability,
        workflows,
      ),
    ).toEqual(artifacts);
    expectError(
      () =>
        decodeDecisionLineageWithWorkflowAccess(
          JSON.parse(lineageText),
          decodedOrigin,
          workflowCatalog,
        ),
      "digest-mismatch",
    );

    const realArtifacts = createTaskLineageArtifacts(await mint("operator-directed", SHA("f")));
    expect(
      projectTaskLineageWithWorkflowAccess(
        realArtifacts.origin,
        realArtifacts.lineage,
        workflowCatalog,
      ),
    ).toEqual(projectTaskLineage(realArtifacts.origin, realArtifacts.lineage));
  });

  it.each(["operator-directed", "docsfab-recommended-approved", "docsfab-autonomous"] as const)(
    "round-trips authentic %s lineage and leaves decoded copies inert",
    async (originClass) => {
      const capability = await mint(
        originClass,
        SHA(
          originClass === "operator-directed"
            ? "a"
            : originClass === "docsfab-recommended-approved"
              ? "b"
              : "c",
        ),
      );
      const artifacts = createTaskLineageArtifacts(capability);
      assertTaskLineageAuthentic(artifacts);
      expect(Object.isFrozen(artifacts.origin)).toBe(true);
      expect(Object.isFrozen(artifacts.lineage)).toBe(true);
      expect(artifacts.origin.origin).toBe(originClass);
      expect(artifacts.lineage.selectedWorkflow).toBe("update-documentation");
      expect(artifacts.lineage.candidates).toHaveLength(2);
      expect(artifacts.lineage.rejectedAlternatives).toHaveLength(1);

      const originText = serializeTaskOrigin(artifacts.origin);
      const lineageText = serializeDecisionLineage(artifacts.lineage, artifacts.origin);
      const decodedOrigin = decodePersistedTaskOrigin(originText);
      const decodedLineage = decodePersistedDecisionLineage(lineageText, decodedOrigin);
      expect(decodedOrigin).toEqual(artifacts.origin);
      expect(decodedLineage).toEqual(artifacts.lineage);
      expectError(
        () =>
          assertTaskLineageAuthentic({
            origin: decodedOrigin,
            lineage: decodedLineage,
          }),
        "authority-required",
      );
      expect(
        restoreTaskLineageArtifacts(
          {
            origin: decodedOrigin,
            lineage: decodedLineage,
          },
          capability,
        ),
      ).toEqual(artifacts);
    },
  );

  it("makes all four origin states mutually exclusive and historical state non-authorizing", async () => {
    const historical = createHistoricalUnknownTaskLineage({
      lineageId: "lineage:historical",
      repository: fixture.repository,
    });
    expect(historical.origin.origin).toBe("historical-unknown");
    expect(historical.origin.authorityStatus).toBe("historical-inert");
    expect(historical.origin.request.taskSha256).toBeNull();
    expect(historical.lineage.decisions).toEqual([]);
    expectError(() => assertTaskLineageAuthentic(historical), "authority-required");

    const malformed = structuredClone(historical.origin);
    malformed.selectedBy = "operator";
    expectError(() => decodeTaskOrigin(rehash(malformed, "originSha256")), "ambiguous-origin");

    const directed = currentOrigin("operator-directed");
    await expectErrorAsync(
      () =>
        mintTaskLineageHostCapability(
          {
            origin: { ...directed, recommendation: fixture.recommendation } as never,
            lineage: lineageInput("operator-directed"),
          },
          authority(SHA("d")),
        ),
      "ambiguous-origin",
    );
  });

  it("keeps model explanation advisory and refuses responsibility expansion", async () => {
    const expanded = lineageInput("operator-directed");
    const path = expanded.decisions.find((decision) => decision.id === "decision:path-suggestion")!;
    path.effect = "authoritative";
    path.authoritySource = "host-policy";
    path.authoritySha256 = SHA("f");
    await expectErrorAsync(
      () =>
        mintTaskLineageHostCapability(
          {
            origin: currentOrigin("operator-directed"),
            lineage: expanded,
          },
          authority(SHA("e")),
        ),
      "responsibility-expansion",
    );

    const missingCeiling = lineageInput("operator-directed");
    missingCeiling.decisions.find(
      (decision) => decision.id === "decision:path-suggestion",
    )!.boundedByDecisionIds = [];
    await expectErrorAsync(
      () =>
        mintTaskLineageHostCapability(
          {
            origin: currentOrigin("operator-directed"),
            lineage: missingCeiling,
          },
          authority(SHA("f")),
        ),
      "responsibility-expansion",
    );

    const unrelatedTaskAuthority = lineageInput("operator-directed");
    unrelatedTaskAuthority.decisions.find(
      (decision) => decision.id === "decision:task",
    )!.authoritySha256 = SHA("f");
    await expectErrorAsync(
      () =>
        mintTaskLineageHostCapability(
          {
            origin: currentOrigin("operator-directed"),
            lineage: unrelatedTaskAuthority,
          },
          authority(SHA("7")),
        ),
      "responsibility-expansion",
    );

    const unrelatedRepository = lineageInput("operator-directed");
    unrelatedRepository.decisions.find(
      (decision) => decision.id === "decision:repository",
    )!.outcomeSha256 = SHA("f");
    await expectErrorAsync(
      () =>
        mintTaskLineageHostCapability(
          {
            origin: currentOrigin("operator-directed"),
            lineage: unrelatedRepository,
          },
          authority(SHA("8")),
        ),
      "responsibility-expansion",
    );

    const maskingAdvisory = lineageInput("operator-directed");
    const repositoryAuthority = maskingAdvisory.decisions.find(
      (decision) => decision.id === "decision:repository",
    )!;
    repositoryAuthority.outcomeSha256 = SHA("f");
    maskingAdvisory.decisions.push({
      id: "decision:0-repository-advisory",
      domain: "repository",
      actor: "model",
      effect: "advisory",
      outcomeSha256: fixture.repository.identitySha256,
      authoritySource: "none",
      authoritySha256: null,
      evidenceSha256s: [fixture.repository.identitySha256],
      boundedByDecisionIds: [repositoryAuthority.id],
      reasonCode: "model-repository-explanation",
    });
    await expectErrorAsync(
      () =>
        mintTaskLineageHostCapability(
          {
            origin: currentOrigin("operator-directed"),
            lineage: maskingAdvisory,
          },
          authority(SHA("9")),
        ),
      "responsibility-expansion",
    );

    const acceptedAdvisories = lineageInput("operator-directed");
    acceptedAdvisories.decisions.push(
      {
        id: "decision:0-task-advisory",
        domain: "task",
        actor: "model",
        effect: "advisory",
        outcomeSha256: SHA("7"),
        authoritySource: "none",
        authoritySha256: null,
        evidenceSha256s: [fixture.request.requestSha256!],
        boundedByDecisionIds: ["decision:task"],
        reasonCode: "model-task-explanation",
      },
      {
        id: "decision:0-workflow-advisory",
        domain: "workflow",
        actor: "model",
        effect: "advisory",
        outcomeSha256: SHA("8"),
        authoritySource: "none",
        authoritySha256: null,
        evidenceSha256s: [fixture.candidates[0]!.prerequisiteEvidenceSha256s[0]!],
        boundedByDecisionIds: ["decision:workflow"],
        reasonCode: "model-workflow-explanation",
      },
    );
    await expect(
      mintTaskLineageHostCapability(
        {
          origin: currentOrigin("operator-directed"),
          lineage: acceptedAdvisories,
        },
        authority(SHA("0")),
      ),
    ).resolves.toMatchObject({
      kind: "docsfab-task-lineage-host-capability",
    });
  });

  it("rejects candidate, selection, approval, origin, and revision substitution", async () => {
    const wrongSelection = lineageInput("operator-directed");
    wrongSelection.selectedCandidateSha256 = fixture.rejectedAlternatives[0]!.candidateSha256;
    await expectErrorAsync(
      () =>
        mintTaskLineageHostCapability(
          {
            origin: currentOrigin("operator-directed"),
            lineage: wrongSelection,
          },
          authority(SHA("1")),
        ),
      "selection-conflict",
    );

    const wrongApproval = currentOrigin("operator-directed");
    if (!wrongApproval.approval) throw new Error("fixture approval missing");
    wrongApproval.approval.approvedTaskSha256 = SHA("f");
    await expectErrorAsync(
      () =>
        mintTaskLineageHostCapability(
          {
            origin: wrongApproval,
            lineage: lineageInput("operator-directed"),
          },
          authority(SHA("2")),
        ),
      "ambiguous-origin",
    );

    const wrongRecommendationApproval = currentOrigin("docsfab-recommended-approved");
    if (!wrongRecommendationApproval.approval) throw new Error("fixture approval missing");
    wrongRecommendationApproval.approval.approvedRecommendationSha256 = SHA("f");
    await expectErrorAsync(
      () =>
        mintTaskLineageHostCapability(
          {
            origin: wrongRecommendationApproval,
            lineage: lineageInput("docsfab-recommended-approved"),
          },
          authority(SHA("7")),
        ),
      "ambiguous-origin",
    );

    const wrongAutoCandidate = currentOrigin("docsfab-autonomous");
    if (!wrongAutoCandidate.autonomousSelection) throw new Error("fixture selection missing");
    wrongAutoCandidate.autonomousSelection.candidateSha256 =
      fixture.rejectedAlternatives[0]!.candidateSha256;
    await expectErrorAsync(
      () =>
        mintTaskLineageHostCapability(
          {
            origin: wrongAutoCandidate,
            lineage: lineageInput("docsfab-autonomous"),
          },
          authority(SHA("9")),
        ),
      "selection-conflict",
    );

    const capability = await mint("operator-directed", SHA("3"));
    const artifacts = createTaskLineageArtifacts(capability);
    const drifted = structuredClone(artifacts.origin);
    drifted.repository.revision = SHA("f").slice(0, 40);
    const rewritten = rehash(drifted, "originSha256");
    expect(decodeTaskOrigin(rewritten).repository.revision).toBe(SHA("f").slice(0, 40));
    expectError(
      () =>
        restoreTaskLineageArtifacts(
          {
            origin: rewritten,
            lineage: artifacts.lineage,
          },
          capability,
        ),
      "selection-conflict",
    );
  });

  it("rejects replayed host receipts, copied capabilities, tampering, and unknown versions", async () => {
    const host = authority(SHA("4"));
    await mintTaskLineageHostCapability(
      {
        origin: currentOrigin("operator-directed"),
        lineage: lineageInput("operator-directed"),
      },
      host,
    );
    await expectErrorAsync(
      () =>
        mintTaskLineageHostCapability(
          {
            origin: { ...currentOrigin("operator-directed"), lineageId: "lineage:second" },
            lineage: { ...lineageInput("operator-directed"), lineageId: "lineage:second" },
          },
          host,
        ),
      "authority-replayed",
    );

    const capability = await mint("operator-directed", SHA("5"));
    const artifacts = createTaskLineageArtifacts(capability);
    const copiedCapability = { kind: "docsfab-task-lineage-host-capability" } as const;
    expectError(() => createTaskLineageArtifacts(copiedCapability), "authority-required");
    const tampered = structuredClone(artifacts.lineage);
    tampered.decisions[0]!.reasonCode = "substituted";
    expectError(() => decodeDecisionLineage(tampered, artifacts.origin), "digest-mismatch");
    expectError(
      () => migrateTaskOrigin({ ...artifacts.origin, schemaVersion: 2 }),
      "migration-required",
    );
    expectError(
      () => migrateDecisionLineage({ ...artifacts.lineage, schemaVersion: 2 }, artifacts.origin),
      "migration-required",
    );
    expect(TASK_LINEAGE_MIGRATION_POLICY.historicalAuthority).toBe("none");
  });

  it("snapshots normalized semantics before awaiting host verification", async () => {
    const origin = currentOrigin("operator-directed");
    const lineage = lineageInput("operator-directed");
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let challengeSeen = false;
    const host = internalCreateTaskLineageHostAuthority({
      async verifyCurrent(challenge) {
        challengeSeen = true;
        await gate;
        return {
          status: "current" as const,
          challengeSha256: challenge.challengeSha256,
          observedAt: "2026-08-05T18:00:00.000Z",
          authorityReceiptSha256: SHA("6"),
        };
      },
    });
    const pending = mintTaskLineageHostCapability({ origin, lineage }, host);
    expect(challengeSeen).toBe(true);

    origin.request.taskSha256 = SHA("f");
    if (!origin.approval) throw new Error("fixture approval missing");
    origin.approval.approvedTaskSha256 = SHA("f");
    lineage.selectedCandidateSha256 = fixture.rejectedAlternatives[0]!.candidateSha256;
    lineage.decisions.find((decision) => decision.id === "decision:task")!.outcomeSha256 = SHA("f");
    release();

    const artifacts = createTaskLineageArtifacts(await pending);
    expect(artifacts.origin.request.taskSha256).toBe(fixture.request.taskSha256);
    expect(artifacts.lineage.selectedCandidateSha256).toBe(fixture.selectedCandidateSha256);
    expect(
      artifacts.lineage.decisions.find((decision) => decision.id === "decision:task")!
        .outcomeSha256,
    ).toBe(fixture.request.taskSha256);
  });

  it("enforces canonical persistence, duplicate-key rejection, and minimized projections", async () => {
    configureCredential(["glpat", "abcdefghijklmnopqrst"].join("-"));
    const artifacts = createTaskLineageArtifacts(await mint("docsfab-autonomous", SHA("6")));
    const canonical = serializeTaskOrigin(artifacts.origin);
    expectError(() => decodePersistedTaskOrigin(` ${canonical}`), "invalid-shape");
    const duplicate = canonical.replace("{", '{"kind":"docsfab-task-origin",');
    expectError(() => decodePersistedTaskOrigin(duplicate), "invalid-shape");
    const projection = projectTaskLineage(artifacts.origin, artifacts.lineage);
    expect(projection.origin).toBe("docsfab-autonomous");
    expect(projection.selectedWorkflow).toBe("update-documentation");
    expect(projection).not.toHaveProperty("approval");
    expect(projection).not.toHaveProperty("recommendation");
    expect(projection).not.toHaveProperty("autonomousSelection");
    expect(JSON.stringify(projection)).not.toContain("operator:fixture");
    expect(Object.keys(publicApi).some((key) => key.startsWith("internal"))).toBe(false);

    const credentialOrigin = structuredClone(artifacts.origin);
    if (!credentialOrigin.approval) {
      const directed = createTaskLineageArtifacts(await mint("operator-directed", SHA("a")));
      const credentialDirected = structuredClone(directed.origin);
      if (!credentialDirected.approval) throw new Error("fixture approval missing");
      credentialDirected.approval.authorityId = "glpat-abcdefghijklmnopqrst";
      expectError(
        () => decodeTaskOrigin(rehash(credentialDirected, "originSha256")),
        "credential-material",
      );
    }
    expectError(
      () =>
        createHistoricalUnknownTaskLineage({
          lineageId: "glpat-abcdefghijklmnopqrst",
          repository: fixture.repository,
        }),
      "credential-material",
    );
  });

  it("recovers exact historical issuance through a fresh opaque host authority", async () => {
    const original = createTaskLineageArtifacts(await mint("operator-directed", SHA("a")));
    const originalOriginText = serializeTaskOrigin(original.origin);
    const originalLineageText = serializeDecisionLineage(original.lineage, original.origin);
    const persistedOrigin = decodePersistedTaskOrigin(originalOriginText);
    const persistedLineage = decodePersistedDecisionLineage(originalLineageText, persistedOrigin);
    let seenChallenge: TaskLineageAuthorityChallengeV1 | undefined;
    const recoveryAuthority = internalCreateTaskLineageHostAuthority({
      async verifyCurrent(challenge) {
        seenChallenge = challenge;
        return {
          status: "current" as const,
          challengeSha256: challenge.challengeSha256,
          observedAt: "2026-09-14T14:00:00.000Z",
          authorityReceiptSha256: SHA("b"),
        };
      },
    });

    const recovered = await recoverTaskLineageArtifacts(
      { origin: persistedOrigin, lineage: persistedLineage },
      recoveryAuthority,
      workflowCatalog,
    );

    expect(serializeTaskOrigin(recovered.artifacts.origin)).toBe(originalOriginText);
    expect(serializeDecisionLineage(recovered.artifacts.lineage, recovered.artifacts.origin)).toBe(
      originalLineageText,
    );
    expect(recovered.artifacts.origin.observedAt).toBe("2026-08-05T18:00:00.000Z");
    expect(recovered.artifacts.lineage.observedAt).toBe("2026-08-05T18:00:00.000Z");
    expect(recovered.artifacts.origin.authorityReceiptSha256).toBe(SHA("a"));
    expect(recovered.artifacts.lineage.authorityReceiptSha256).toBe(SHA("a"));
    expect(seenChallenge).toBeDefined();
    expect(seenChallenge).toMatchObject({
      lineageId: original.origin.lineageId,
      repository: original.origin.repository,
      originClass: original.origin.origin,
      requestSha256: original.origin.request.requestSha256,
      taskSha256: original.origin.request.taskSha256,
      proposedOriginSha256: original.origin.originSha256,
      proposedLineageSha256: original.lineage.lineageSha256,
    });
    if (!seenChallenge) throw new Error("Recovery verifier did not receive a challenge.");
    const { challengeSha256: _challengeSha256, ...challengeBody } = seenChallenge;
    expect(seenChallenge.challengeSha256).toBe(canonicalDigest(challengeBody));

    expect(recovered.authorization).toMatchObject({
      originalOriginSha256: original.origin.originSha256,
      originalLineageSha256: original.lineage.lineageSha256,
      challengeSha256: seenChallenge.challengeSha256,
      authorizedAt: "2026-09-14T14:00:00.000Z",
      authorityReceiptSha256: SHA("b"),
    });
    expect(decodeTaskLineageRecoveryAuthorization(recovered.authorization)).toEqual(
      recovered.authorization,
    );
    expect(Object.isFrozen(recovered.artifacts.origin)).toBe(true);
    expect(Object.isFrozen(recovered.artifacts.lineage)).toBe(true);
    expect(Object.isFrozen(recovered.authorization)).toBe(true);

    const clonedAuthority = structuredClone(recoveryAuthority);
    await expectErrorAsync(
      () =>
        recoverTaskLineageArtifacts(
          { origin: original.origin, lineage: original.lineage },
          clonedAuthority as never,
          workflowCatalog,
        ),
      "authority-required",
    );
  });

  it.each(["wrong challenge", "non-current response"] as const)(
    "rejects recovery with a %s from the trusted verifier",
    async (failure) => {
      const original = createTaskLineageArtifacts(await mint("operator-directed", SHA("c")));
      const authorityWithBadResponse = internalCreateTaskLineageHostAuthority({
        async verifyCurrent(challenge) {
          if (failure === "wrong challenge") {
            return {
              status: "current" as const,
              challengeSha256: SHA("f"),
              observedAt: "2026-09-14T14:01:00.000Z",
              authorityReceiptSha256: SHA("d"),
            };
          }
          return { status: "stale" } as never;
        },
      });

      await expectErrorAsync(
        () =>
          recoverTaskLineageArtifacts(
            { origin: original.origin, lineage: original.lineage },
            authorityWithBadResponse,
            workflowCatalog,
          ),
        failure === "wrong challenge" ? "authority-required" : "invalid-shape",
      );
    },
  );

  it("refuses substituted persisted lineage digests before recovery authorization", async () => {
    const original = createTaskLineageArtifacts(await mint("operator-directed", SHA("e")));
    const substituted = structuredClone(original);
    substituted.lineage.lineageSha256 = SHA("f");
    await expectErrorAsync(
      () =>
        recoverTaskLineageArtifacts(
          substituted,
          internalCreateTaskLineageHostAuthority({
            async verifyCurrent(challenge) {
              return {
                status: "current" as const,
                challengeSha256: challenge.challengeSha256,
                observedAt: "2026-09-14T14:02:00.000Z",
                authorityReceiptSha256: SHA("0"),
              };
            },
          }),
          workflowCatalog,
        ),
      "digest-mismatch",
    );
  });

  it("canonicalizes registered workflow steps and rejects caller-authored candidate hashes", () => {
    const candidate = createWorkflowLineageCandidate(fixture.candidates[0]!);
    expect(candidate.candidateSha256).toBe(fixture.selectedCandidateSha256);
    expect(candidate.stepIds).toEqual([
      "plan-documentation",
      "derive-source-obligations",
      "write-documentation",
      "lint-documentation",
      "verify-technical-accuracy",
      "review-documentation",
      "test-audience-understanding",
      "evaluate-document-quality",
    ]);
    expectError(
      () =>
        createWorkflowLineageCandidate({
          ...fixture.candidates[0],
          candidateSha256: SHA("f"),
        } as never),
      "digest-mismatch",
    );
  });
});

function currentOrigin(
  origin: Exclude<TaskOriginInputV1["origin"], "historical-unknown">,
): Exclude<TaskOriginInputV1, { origin: "historical-unknown" }> {
  const common = {
    lineageId: `lineage:${origin}`,
    repository: structuredClone(fixture.repository),
    request: structuredClone(fixture.request),
  };
  if (origin === "operator-directed")
    return {
      ...common,
      origin,
      selectedBy: "operator",
      approval: structuredClone(fixture.approval),
      recommendation: null,
      autonomousSelection: null,
    };
  if (origin === "docsfab-recommended-approved")
    return {
      ...common,
      origin,
      selectedBy: "operator",
      approval: {
        ...structuredClone(fixture.approval),
        approvedRecommendationSha256: fixture.recommendation.recommendationSha256,
      },
      recommendation: structuredClone(fixture.recommendation),
      autonomousSelection: null,
    };
  return {
    ...common,
    origin,
    selectedBy: "deterministic-workflow",
    approval: null,
    recommendation: null,
    autonomousSelection: structuredClone(fixture.autonomousSelection),
  };
}

function lineageInput(origin: Exclude<TaskOriginInputV1["origin"], "historical-unknown">) {
  const taskActor = origin === "docsfab-autonomous" ? "deterministic-workflow" : "operator";
  const taskDecision: DecisionAttributionInputV1 = {
    id: "decision:task",
    domain: "task",
    actor: taskActor,
    effect: "authoritative",
    outcomeSha256: fixture.request.taskSha256!,
    authoritySource: taskActor === "operator" ? "operator-approval" : "workflow-contract",
    authoritySha256:
      taskActor === "operator"
        ? fixture.approval.approvalSha256
        : fixture.autonomousSelection.decisionSha256,
    evidenceSha256s: [fixture.request.requestSha256!],
    boundedByDecisionIds: [],
    reasonCode: origin,
  };
  return {
    lineageId: `lineage:${origin}`,
    candidates: structuredClone(fixture.candidates),
    selectedCandidateSha256: fixture.selectedCandidateSha256,
    selectedSourceAutoCandidateSha256:
      origin === "docsfab-autonomous" ? fixture.autonomousSelection.candidateSha256 : null,
    rejectedAlternatives: structuredClone(fixture.rejectedAlternatives),
    decisions: [taskDecision, ...structuredClone(fixture.sharedDecisions)],
  };
}

async function mint(
  origin: Exclude<TaskOriginInputV1["origin"], "historical-unknown">,
  receipt: string,
) {
  return mintTaskLineageHostCapability(
    {
      origin: currentOrigin(origin),
      lineage: lineageInput(origin),
    },
    authority(receipt),
  );
}

function authority(receipt: string) {
  return internalCreateTaskLineageHostAuthority({
    async verifyCurrent(challenge) {
      return {
        status: "current" as const,
        challengeSha256: challenge.challengeSha256,
        observedAt: "2026-08-05T18:00:00.000Z",
        authorityReceiptSha256: receipt,
      };
    },
  });
}

function fakeWorkflowAccess() {
  const definitions = new Map(
    (["update-documentation", "review-documentation"] as const).map((name) => {
      const definition = structuredClone(workflowCatalog.getWorkflow(name));
      definition.steps = definition.steps.map((step, index) => ({
        ...step,
        id: `fake-${name}-${index}`,
      }));
      return [name, definition] as const;
    }),
  );
  return {
    isRunnableWorkflowName(
      value: string,
    ): value is "update-documentation" | "review-documentation" {
      return definitions.has(value as "update-documentation" | "review-documentation");
    },
    getWorkflow(name: "update-documentation" | "review-documentation") {
      const definition = definitions.get(name);
      if (!definition) throw new Error("workflow excluded");
      return definition;
    },
  };
}

function rehash<T extends object, D extends keyof T>(value: T, digestKey: D): T {
  const { [digestKey]: _digest, ...body } = value;
  return { ...body, [digestKey]: canonicalDigest(body) } as T;
}

function expectError(run: () => unknown, code: TaskLineageContractError["code"]): void {
  try {
    run();
    throw new Error("Expected task-lineage failure.");
  } catch (error) {
    expect(error).toBeInstanceOf(TaskLineageContractError);
    expect((error as TaskLineageContractError).code).toBe(code);
  }
}

async function expectErrorAsync(
  run: () => Promise<unknown>,
  code: TaskLineageContractError["code"],
): Promise<void> {
  try {
    await run();
    throw new Error("Expected task-lineage failure.");
  } catch (error) {
    expect(error).toBeInstanceOf(TaskLineageContractError);
    expect((error as TaskLineageContractError).code).toBe(code);
  }
}
