// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { afterEach, describe, expect, it } from "vitest";

import { canonicalizeJsonEvidence, type JsonEvidenceValue } from "../src/json-evidence.js";
import {
  assertScmDeliveryRecord,
  assertScmDeliveryRecordShape,
  assertScmPublishedTerminalCapability,
  authorizeLocalUserPublication,
  canonicalMergeRequestUrl,
  confirmScmDeliveryObservation,
  createScmDeliveryRecord,
  failScmDeliveryRecord,
  localUserGitIdentitySha256,
  localUserPublicationPlanSha256,
  normalizeDeliveryValidationFailureEvidence,
  issueScmPublishedTerminalCapability,
  reconcileScmDelivery,
  recordScmDeliveryProgress,
  recoverScmDeliveryPatch,
  scmDeliveryAttemptId,
  scmDeliveryIdempotencyKey,
  scmDeliveryIdentityKey,
  scmDeliveryRecordSha256,
  ScmDeliveryContractError,
  selectDocumentationValidationProfile,
  type LocalUserPublicationPlanV1,
  type LocalUserPublicationPlanV2,
  type ScmDeliveryObservationV1,
  type ScmDeliveryRecordV1,
  type ScmDeliveryState,
} from "../src/delivery/index.js";
import { validationBackendPolicySha256 } from "../src/delivery/worktree/validation-backend.js";
import { documentationValidationKit } from "../src/delivery/validation-profile.js";
import { collectCredentialFindings } from "../src/security/credential-shape-findings.js";
import {
  clearPlantedCredential,
  plantConfiguredCredential,
} from "./helpers/planted-configured-credential.js";

const BASE = "a".repeat(40);
const COMMIT = "b".repeat(40);
const PATCH_BYTES = Buffer.from(
  [
    "diff --git a/docs/a.md b/docs/a.md",
    "--- a/docs/a.md",
    "+++ b/docs/a.md",
    "@@ -1 +1 @@",
    "-old",
    "+new",
    "",
  ]
    .join("\n")
    .padEnd(128, " "),
);
const PATCH = createHash("sha256").update(PATCH_BYTES).digest("hex");
const RECORD = "d".repeat(64);
const WORKTREE = "e".repeat(64);
const SUMMARY = "f".repeat(64);
const T0 = "2026-08-04T00:00:00.000Z";
const TIMES = Array.from({ length: 12 }, (_item, index) =>
  new Date(Date.parse(T0) + (index + 1) * 60_000).toISOString(),
);
const STRUCTURAL_FIXTURE = JSON.parse(
  readFileSync(
    new URL("./fixtures/runtime-evaluation/delivery/scm-delivery-record-v1.json", import.meta.url),
    "utf8",
  ),
) as {
  schemaVersion: number;
  requiredTopLevel: string[];
  evidenceByState: Record<Exclude<ScmDeliveryState, "planned">, string[]>;
  dispositions: string[];
  replayStates: Array<Exclude<ScmDeliveryState, "planned">>;
  reconciliationCases: Array<{
    id: string;
    recordState: "planned" | "opened";
    observation: Omit<
      ScmDeliveryObservationV1,
      "schemaVersion" | "kind" | "idempotencyKey" | "planSha256"
    >;
    expected: { decision: string; failureCode?: string; nextAction: string };
  }>;
};

describe("idempotent SCM delivery records", () => {
  afterEach(() => {
    clearPlantedCredential();
  });

  it("emits and decodes v2 records without changing historical v1 digests", () => {
    const historical = makePlan();
    const historicalDigest = historical.sha256;
    const selected = selectDocumentationValidationProfile({
      workflow: "update-documentation",
      changedPaths: ["docs/a.md"],
      hostPolicySha256: validationBackendPolicySha256(),
      applicabilitySha256: "9".repeat(64),
    });
    const plan = {
      ...historical,
      schemaVersion: 2 as const,
      validationCommand: selected.entrypointCommand,
      documentationValidation: selected.binding,
      sha256: "0".repeat(64),
    };
    plan.sha256 = localUserPublicationPlanSha256(plan);
    const authorization = authorizeLocalUserPublication({
      plan,
      confirmedPlanSha256: plan.sha256,
      command: "publish",
    });
    const record = createScmDeliveryRecord({ plan, authorization, createdAt: T0 });
    expect(record.schemaVersion).toBe(2);
    expect(assertScmDeliveryRecordShape(record)).toEqual(record);
    expect(() => assertScmDeliveryRecordShape({ ...record, schemaVersion: 3 })).toThrow(
      ScmDeliveryContractError,
    );
    expect(makePlan().sha256).toBe(historicalDigest);
  });

  it("rejects a v2 documentation validation transition without bound evidence", () => {
    const plan = makeCurrentDocumentationPlan();
    const authorization = authorizeLocalUserPublication({
      plan,
      confirmedPlanSha256: plan.sha256,
      command: "publish",
    });
    const prepared = recordScmDeliveryProgress(
      createScmDeliveryRecord({ plan, authorization, createdAt: T0 }),
      {
        toState: "prepared",
        source: "executed",
        at: TIMES[0]!,
        evidence: { workspaceKey: WORKTREE, baseRevision: BASE },
      },
      plan,
      authorization,
    );
    expectDeliveryError(
      () =>
        recordScmDeliveryProgress(
          prepared,
          {
            toState: "validated",
            source: "executed",
            at: TIMES[1]!,
            evidence: {
              commandSha256: shaText(plan.validationCommand),
              summarySha256: SUMMARY,
              checkCount: 1,
            },
          },
          plan,
          authorization,
        ),
      "invalid-record",
    );
  });

  it("recomputes the canonical v2 documentation validation result digest", () => {
    const plan = makeCurrentDocumentationPlan();
    const authorization = authorizeLocalUserPublication({
      plan,
      confirmedPlanSha256: plan.sha256,
      command: "publish",
    });
    const prepared = recordScmDeliveryProgress(
      createScmDeliveryRecord({ plan, authorization, createdAt: T0 }),
      {
        toState: "prepared",
        source: "executed",
        at: TIMES[0]!,
        evidence: { workspaceKey: WORKTREE, baseRevision: BASE },
      },
      plan,
      authorization,
    );
    const results = plan.documentationValidation.checkIds.map((id) => ({
      id,
      status: "passed" as const,
    }));
    const candidateTreeSha256 = "c".repeat(64);
    const evidence = {
      commandSha256: shaText(plan.validationCommand),
      summarySha256: SUMMARY,
      checkCount: plan.documentationValidation.checkIds.length,
      profileId: plan.documentationValidation.profileId,
      profileVersion: plan.documentationValidation.profileVersion,
      checkIds: [...plan.documentationValidation.checkIds],
      selectorInputSha256: plan.documentationValidation.selectorInputSha256,
      validatorIdentity: plan.documentationValidation.validatorIdentity,
      candidateTreeSha256,
      checkSetSha256: plan.documentationValidation.checkSetSha256,
      applicabilitySha256: plan.documentationValidation.applicabilitySha256,
      results,
      resultSha256: documentationValidationKit.canonicalDigest({
        results,
        stateSha256: SUMMARY,
        checkSetSha256: plan.documentationValidation.checkSetSha256,
        candidateTreeSha256,
        applicabilitySha256: plan.documentationValidation.applicabilitySha256,
      }),
    };
    const validated = recordScmDeliveryProgress(
      prepared,
      { toState: "validated", source: "executed", at: TIMES[1]!, evidence },
      plan,
      authorization,
    );
    expect(validated.state).toBe("validated");
    expect(assertScmDeliveryRecordShape(structuredClone(validated))).toEqual(validated);
    expectDeliveryError(
      () =>
        recordScmDeliveryProgress(
          prepared,
          {
            toState: "validated",
            source: "executed",
            at: TIMES[1]!,
            evidence: { ...evidence, resultSha256: "9".repeat(64) },
          },
          plan,
          authorization,
        ),
      "invalid-record",
    );
    const durableTamper = structuredClone(validated);
    if (!durableTamper.evidence.validation) throw new Error("missing validation fixture");
    durableTamper.evidence.validation.resultSha256 = "9".repeat(64);
    const lastAttempt = durableTamper.attempts.at(-1);
    if (!lastAttempt) throw new Error("missing validation attempt fixture");
    lastAttempt.evidenceSha256 = shaEvidence(
      durableTamper.evidence.validation as unknown as JsonEvidenceValue,
    );
    durableTamper.sha256 = scmDeliveryRecordSha256(durableTamper);
    expectDeliveryError(() => assertScmDeliveryRecordShape(durableTamper), "invalid-record");
    expectDeliveryError(() => assertScmDeliveryRecord(durableTamper, plan), "invalid-record");
  });

  it("keeps v1 receipt validation evidence closed to v2 applicability", () => {
    const { plan, authorization } = inputs();
    let record = createScmDeliveryRecord({ plan, authorization, createdAt: T0 });
    record = progress(record, "prepared", plan, 0);
    record = progress(record, "validated", plan, 1);
    const tampered = structuredClone(record);
    if (!tampered.evidence.validation) throw new Error("missing validation fixture");
    (tampered.evidence.validation as { applicabilitySha256?: string }).applicabilitySha256 =
      "9".repeat(64);
    tampered.sha256 = scmDeliveryRecordSha256(tampered);
    expectDeliveryError(() => assertScmDeliveryRecordShape(tampered), "invalid-record");
  });

  it("matches the checked-in structural evidence fixture at every state", () => {
    const { plan, authorization } = inputs();
    let record = createScmDeliveryRecord({
      plan,
      authorization,
      createdAt: T0,
    });

    expect(STRUCTURAL_FIXTURE.schemaVersion).toBe(1);
    expect(Object.keys(record).sort()).toEqual([...STRUCTURAL_FIXTURE.requiredTopLevel].sort());
    for (const [index, state] of (
      ["prepared", "validated", "committed", "pushed", "opened"] as const
    ).entries()) {
      record = progress(record, state, plan, index);
      expect(Object.keys(record.evidence).sort()).toEqual(
        [...STRUCTURAL_FIXTURE.evidenceByState[state]].sort(),
      );
    }
    expect(STRUCTURAL_FIXTURE.dispositions).toEqual(["active", "failed", "succeeded", "recovered"]);
    const actualDispositions = new Set<ScmDeliveryRecordV1["disposition"]>();
    const active = createScmDeliveryRecord({
      plan,
      authorization,
      createdAt: T0,
    });
    actualDispositions.add(active.disposition);
    actualDispositions.add(
      failScmDeliveryRecord(
        active,
        {
          code: "prepare-failed",
          at: TIMES[8]!,
        },
        plan,
      ).disposition,
    );
    actualDispositions.add(progressThrough(active, "opened", plan).disposition);
    actualDispositions.add(
      recoverScmDeliveryPatch(
        active,
        {
          reasonCode: "operator-requested",
          at: TIMES[9]!,
          patchBytes: PATCH_BYTES,
        },
        plan,
      ).disposition,
    );
    expect([...actualDispositions].sort()).toEqual([...STRUCTURAL_FIXTURE.dispositions].sort());

    const replayedStates = STRUCTURAL_FIXTURE.replayStates.map((state) => {
      const reached = progressThrough(
        createScmDeliveryRecord({ plan, authorization, createdAt: T0 }),
        state,
        plan,
      );
      expect(progress(reached, state, plan, 6, confirmedReplay(reached, plan)), state).toEqual(
        reached,
      );
      return state;
    });
    expect(replayedStates).toEqual(["prepared", "validated", "committed", "pushed", "opened"]);
    for (const fixture of STRUCTURAL_FIXTURE.reconciliationCases) {
      const candidate =
        fixture.recordState === "opened"
          ? progressThrough(
              createScmDeliveryRecord({ plan, authorization, createdAt: T0 }),
              "opened",
              plan,
            )
          : createScmDeliveryRecord({ plan, authorization, createdAt: T0 });
      const observed: ScmDeliveryObservationV1 = {
        schemaVersion: 1,
        kind: "docsfab-scm-delivery-observation",
        idempotencyKey: candidate.idempotencyKey,
        planSha256: candidate.planSha256,
        ...structuredClone(fixture.observation),
      };
      expect(reconcileScmDelivery(candidate, observed, plan), fixture.id).toMatchObject(
        fixture.expected,
      );
    }
  });

  it("creates one deterministic generic SCM identity from an exact #38 authorization", () => {
    const { plan, authorization } = inputs();
    const first = createScmDeliveryRecord({
      plan,
      authorization,
      createdAt: T0,
    });
    const second = createScmDeliveryRecord({
      plan,
      authorization,
      createdAt: T0,
    });

    expect(first).toEqual(second);
    expect(first.idempotencyKey).toBe(scmDeliveryIdempotencyKey(plan));
    expect(first.authorization).toEqual({
      kind: "docsfab-scm-publication-authorization",
      provider: "gitlab",
      planSha256: plan.sha256,
    });
    expect(first.repository).toEqual({
      provider: "gitlab",
      projectId: 42,
      host: "gitlab.example.test",
      path: "group/docs",
      remoteName: "origin",
      remoteTransport: "ssh",
    });
    expect(assertScmDeliveryRecord(structuredClone(first), plan)).toEqual(first);
    expect(Object.isFrozen(first)).toBe(true);
    expect(JSON.stringify(first)).not.toContain("/Users/");
    expect(JSON.stringify(first)).not.toContain("glpat-");
  });

  it("keeps one delivery identity when the same run retries with a branch override", () => {
    const first = makePlan();
    const second = makePlan();
    second.proposedSourceBranch = "docsfab-run/operator-selected-branch";
    second.sha256 = localUserPublicationPlanSha256(second);

    expect(scmDeliveryIdempotencyKey(first)).toBe(scmDeliveryIdempotencyKey(second));
    expect(first.sha256).not.toBe(second.sha256);
  });

  it("validates an opened provider-neutral GitHub receipt and its provider-specific relations", () => {
    const { plan, authorization } = inputs();
    const record = structuredClone(
      progressThrough(
        createScmDeliveryRecord({ plan, authorization, createdAt: T0 }),
        "opened",
        plan,
      ),
    );
    record.authorization.provider = "github";
    record.repository.provider = "github";
    record.repository.host = "github.example.test";
    record.idempotencyKey = scmDeliveryIdentityKey({
      provider: "github",
      run: record.run,
      repository: {
        projectId: record.repository.projectId,
        host: record.repository.host,
        path: record.repository.path,
      },
      baseRevision: record.baseRevision,
      targetBranch: record.targetBranch,
      patchSha256: record.patch.sha256,
    });
    record.attempts = record.attempts.map((attempt) => ({
      ...attempt,
      id: scmDeliveryAttemptId(record.idempotencyKey, attempt.sequence),
    }));
    record.evidence.mergeRequest!.url = canonicalMergeRequestUrl(record, 7);
    record.attempts.at(-1)!.evidenceSha256 = shaEvidence({ ...record.evidence.mergeRequest! });
    record.sha256 = scmDeliveryRecordSha256(record);

    const decoded = assertScmDeliveryRecordShape(record);
    expect(decoded.repository.provider).toBe("github");
    expect(decoded.state).toBe("opened");
    expect(decoded.disposition).toBe("succeeded");
    expect(canonicalMergeRequestUrl(decoded, 12)).toBe(
      "https://github.example.test/group/docs/pull/12",
    );
    expectDeliveryError(() => assertScmDeliveryRecord(record, plan), "identity-mismatch");

    const wrongProviderUrl = structuredClone(record);
    wrongProviderUrl.evidence.mergeRequest!.url =
      "https://github.example.test/group/docs/-/merge_requests/7";
    wrongProviderUrl.attempts.at(-1)!.evidenceSha256 = shaEvidence({
      ...wrongProviderUrl.evidence.mergeRequest!,
    });
    wrongProviderUrl.sha256 = scmDeliveryRecordSha256(wrongProviderUrl);
    expectDeliveryError(() => assertScmDeliveryRecordShape(wrongProviderUrl), "identity-mismatch");
  });

  it("advances every mutating boundary and records a terminal draft MR without duplicates", () => {
    const { plan, authorization } = inputs();
    let record = createScmDeliveryRecord({
      plan,
      authorization,
      createdAt: T0,
    });
    record = progress(record, "prepared", plan, 0);
    const replay = {
      toState: "prepared",
      source: "executed",
      at: TIMES[1]!,
      evidence: { workspaceKey: WORKTREE, baseRevision: BASE },
    } as const;
    expectDeliveryError(
      () => recordScmDeliveryProgress(record, replay, plan),
      "invalid-authorization",
    );
    expectDeliveryError(
      () =>
        recordScmDeliveryProgress(
          record,
          {
            ...replay,
            at: T0,
          },
          plan,
          authorization,
        ),
      "invalid-transition",
    );
    const replayed = recordScmDeliveryProgress(
      record,
      replay,
      plan,
      authorization,
      confirmedReplay(record, plan),
    );
    expect(replayed).toEqual(record);
    record = progress(record, "validated", plan, 1);
    record = progress(record, "committed", plan, 2);
    record = progress(record, "pushed", plan, 3);
    record = progress(record, "opened", plan, 4);

    expect(record.state).toBe("opened");
    expect(record.disposition).toBe("succeeded");
    expect(record.attempts).toHaveLength(5);
    expect(
      record.attempts.map(
        (item, index) => item.id === scmDeliveryAttemptId(record.idempotencyKey, index + 1),
      ),
    ).toEqual([true, true, true, true, true]);
    expect(record.evidence.mergeRequest).toEqual({
      iid: 7,
      url: "https://gitlab.example.test/group/docs/-/merge_requests/7",
      state: "opened",
      draft: true,
      sourceBranch: plan.proposedSourceBranch,
      targetBranch: "main",
      headRevision: COMMIT,
    });
    expect(record.sha256).toBe(scmDeliveryRecordSha256(record));

    expectDeliveryError(() => progress(record, "opened", plan, 5), "external-drift");
    const terminalReplay = progress(record, "opened", plan, 5, confirmedReplay(record, plan));
    expect(terminalReplay).toEqual(record);
    const oneTimeReplay = confirmedReplay(record, plan);
    expect(progress(record, "opened", plan, 6, oneTimeReplay)).toEqual(record);
    expectDeliveryError(() => progress(record, "opened", plan, 7, oneTimeReplay), "external-drift");
    const clonedReplay = structuredClone(confirmedReplay(record, plan));
    expectDeliveryError(() => progress(record, "opened", plan, 6, clonedReplay), "external-drift");
    const staleObservation = observation(record, {
      localCommit: { status: "matching", revision: COMMIT },
      remoteBranch: { status: "deleted" },
      mergeRequest: observedMr(record, "closed"),
    });
    expectDeliveryError(
      () => progress(record, "opened", plan, 6, confirmedReplay(record, plan, staleObservation)),
      "external-drift",
    );
  });

  it("issues opaque terminal evidence for published cleanup and rejects lookalikes", () => {
    const { plan, authorization } = inputs();
    const record = progressThrough(
      createScmDeliveryRecord({ plan, authorization, createdAt: T0 }),
      "opened",
      plan,
    );
    const capability = issueScmPublishedTerminalCapability({
      record,
      plan,
      authorization,
      replay: confirmedReplay(record, plan),
    });
    expect(assertScmPublishedTerminalCapability(capability, plan, authorization)).toMatchObject({
      idempotencyKey: record.idempotencyKey,
      recordSha256: record.sha256,
      planSha256: plan.sha256,
      run: plan.run,
      patch: { sha256: PATCH },
      baseRevision: BASE,
      sourceBranch: plan.proposedSourceBranch,
      targetBranch: plan.targetBranch.name,
      commitRevision: COMMIT,
      remoteRevision: COMMIT,
      mergeRequest: {
        iid: 7,
        state: "opened",
        draft: true,
        headRevision: COMMIT,
      },
    });
    expectDeliveryError(
      () => assertScmPublishedTerminalCapability(structuredClone(capability), plan, authorization),
      "invalid-authorization",
    );

    const stale = observation(record, {
      localCommit: { status: "matching", revision: COMMIT },
      remoteBranch: { status: "deleted" },
      mergeRequest: observedMr(record, "closed"),
    });
    expectDeliveryError(
      () =>
        issueScmPublishedTerminalCapability({
          record,
          plan,
          authorization,
          replay: confirmedReplay(record, plan, stale),
        }),
      "external-drift",
    );
  });

  it("keeps reconciliation advisory and rejects discovered state as confirmed progress", () => {
    const { plan, authorization } = inputs();
    const record = createScmDeliveryRecord({
      plan,
      authorization,
      createdAt: T0,
    });
    const observed = observation(record, { worktree: "matching" });
    const reconciliation = reconcileScmDelivery(record, observed, plan);
    expect(reconciliation).toMatchObject({
      decision: "resume-prepare",
      lastConfirmedState: "planned",
      nextAction: "prepare-worktree",
    });
    expectDeliveryError(
      () =>
        recordScmDeliveryProgress(
          record,
          {
            toState: "prepared",
            source: "reconciled",
            at: TIMES[0]!,
            evidence: { workspaceKey: WORKTREE, baseRevision: BASE },
          } as unknown as Parameters<typeof recordScmDeliveryProgress>[1],
          plan,
          authorization,
        ),
      "invalid-transition",
    );
    expect(record.state).toBe("planned");
    expect(record.attempts).toHaveLength(0);
    expect(progress(record, "prepared", plan, 0).state).toBe("prepared");
  });

  it.each([
    ["planned", "prepare-failed"],
    ["prepared", "validation-failed"],
    ["prepared", "validation-isolation-unavailable"],
    ["validated", "commit-failed"],
    ["committed", "push-failed"],
    ["pushed", "merge-request-open-failed"],
  ] as const)("preserves %s as the last confirmed state after interruption", (state, code) => {
    const { plan, authorization } = inputs();
    let record = createScmDeliveryRecord({
      plan,
      authorization,
      createdAt: T0,
    });
    record = progressThrough(record, state, plan);
    const failed = failScmDeliveryRecord(record, { code, at: TIMES[8]! }, plan);

    expect(failed.state).toBe(state);
    expect(failed.disposition).toBe("failed");
    expect(failed.failure).toMatchObject({ code, lastConfirmedState: state });
    expect(failed.patch).toMatchObject({ sha256: PATCH, preserved: true });
    expect(failScmDeliveryRecord(failed, { code, at: TIMES[9]! }, plan)).toEqual(failed);
  });

  it("rejects phase failure codes at impossible receipt states but allows cross-cutting failures", () => {
    const { plan, authorization } = inputs();
    const planned = createScmDeliveryRecord({
      plan,
      authorization,
      createdAt: T0,
    });
    expectDeliveryError(
      () =>
        failScmDeliveryRecord(
          planned,
          {
            code: "merge-request-open-failed",
            at: TIMES[0]!,
          },
          plan,
        ),
      "invalid-transition",
    );
    expect(
      failScmDeliveryRecord(
        planned,
        {
          code: "merge-request-changed",
          at: TIMES[0]!,
        },
        plan,
      ),
    ).toMatchObject({
      state: "planned",
      disposition: "failed",
      failure: { code: "merge-request-changed", lastConfirmedState: "planned" },
    });
    expectDeliveryError(
      () =>
        failScmDeliveryRecord(
          planned,
          {
            code: "remote-branch-deleted",
            at: TIMES[0]!,
          },
          plan,
        ),
      "invalid-transition",
    );
    const pushed = progressThrough(planned, "pushed", plan);
    expectDeliveryError(
      () =>
        failScmDeliveryRecord(
          pushed,
          {
            code: "prepare-failed",
            at: TIMES[8]!,
          },
          plan,
        ),
      "invalid-transition",
    );
    expect(
      failScmDeliveryRecord(
        pushed,
        {
          code: "remote-branch-deleted",
          at: TIMES[8]!,
        },
        plan,
      ),
    ).toMatchObject({
      state: "pushed",
      disposition: "failed",
      failure: {
        code: "remote-branch-deleted",
        nextAction: "restore-remote-branch",
      },
    });
  });

  it.each([
    ["merge-request-open-failed", "retry-open-draft-merge-request"],
    ["remote-branch-deleted", "restore-remote-branch"],
  ] as const)(
    "rejects a rehashed durable %s failure at an impossible state",
    (code, nextAction) => {
      const { plan, authorization } = inputs();
      const record = structuredClone(
        createScmDeliveryRecord({ plan, authorization, createdAt: T0 }),
      );
      record.disposition = "failed";
      record.failure = {
        code,
        lastConfirmedState: "planned",
        nextAction,
        at: TIMES[0]!,
      };
      record.attempts.push({
        sequence: 1,
        id: scmDeliveryAttemptId(record.idempotencyKey, 1),
        source: "host-policy",
        outcome: "failed",
        fromState: "planned",
        toState: "planned",
        at: TIMES[0]!,
        failureCode: code,
      });
      record.updatedAt = TIMES[0]!;
      record.sha256 = scmDeliveryRecordSha256(record);

      expectDeliveryError(() => assertScmDeliveryRecord(record, plan), "invalid-transition");
    },
  );

  it("rejects a rehashed durable receipt that continues after terminal recovery", () => {
    const { plan, authorization } = inputs();
    const active = createScmDeliveryRecord({
      plan,
      authorization,
      createdAt: T0,
    });
    const recovered = recoverScmDeliveryPatch(
      active,
      {
        reasonCode: "operator-requested",
        at: TIMES[0]!,
        patchBytes: PATCH_BYTES,
      },
      plan,
    );
    const record = structuredClone(recovered);
    record.disposition = "failed";
    delete record.recovery;
    record.failure = {
      code: "authentication-unavailable",
      lastConfirmedState: "planned",
      nextAction: "restore-authentication",
      at: TIMES[1]!,
    };
    record.attempts.push({
      sequence: 2,
      id: scmDeliveryAttemptId(record.idempotencyKey, 2),
      source: "host-policy",
      outcome: "failed",
      fromState: "planned",
      toState: "planned",
      at: TIMES[1]!,
      failureCode: "authentication-unavailable",
    });
    record.updatedAt = TIMES[1]!;
    record.sha256 = scmDeliveryRecordSha256(record);

    expectDeliveryError(() => assertScmDeliveryRecord(record, plan), "invalid-transition");
  });

  it.each(["failed", "recovered"] as const)(
    "rejects a rehashed durable %s history whose terminal overlay was erased",
    (outcome) => {
      const { plan, authorization } = inputs();
      const active = createScmDeliveryRecord({
        plan,
        authorization,
        createdAt: T0,
      });
      const terminal =
        outcome === "failed"
          ? failScmDeliveryRecord(
              active,
              {
                code: "authentication-unavailable",
                at: TIMES[0]!,
              },
              plan,
            )
          : recoverScmDeliveryPatch(
              active,
              {
                reasonCode: "operator-requested",
                at: TIMES[0]!,
                patchBytes: PATCH_BYTES,
              },
              plan,
            );
      const record = structuredClone(terminal);
      record.disposition = "active";
      delete record.failure;
      delete record.recovery;
      record.sha256 = scmDeliveryRecordSha256(record);

      expectDeliveryError(() => assertScmDeliveryRecord(record, plan), "invalid-record");
    },
  );

  it("resumes after failure and retains one monotonic attempt history", () => {
    const { plan, authorization } = inputs();
    let record = createScmDeliveryRecord({
      plan,
      authorization,
      createdAt: T0,
    });
    record = progress(record, "prepared", plan, 0);
    record = failScmDeliveryRecord(record, { code: "validation-failed", at: TIMES[1]! }, plan);
    record = progress(record, "validated", plan, 2);

    expect(record.disposition).toBe("active");
    expect(record.failure).toBeUndefined();
    expect(record.attempts.map((item) => item.outcome)).toEqual([
      "confirmed",
      "failed",
      "confirmed",
    ]);
  });

  it("does not clear a failed validation from an unknown observation", () => {
    const { plan, authorization } = inputs();
    let record = createScmDeliveryRecord({
      plan,
      authorization,
      createdAt: T0,
    });
    record = progress(record, "prepared", plan, 0);
    record = failScmDeliveryRecord(record, { code: "validation-failed", at: TIMES[1]! }, plan);

    expect(
      reconcileScmDelivery(
        record,
        observation(record, {
          worktree: "matching",
          validation: "failed",
        }),
        plan,
      ),
    ).toMatchObject({
      decision: "blocked",
      failureCode: "validation-failed",
      nextAction: "fix-validation",
    });
    expect(
      reconcileScmDelivery(
        record,
        observation(record, {
          worktree: "matching",
          validation: "passed",
        }),
        plan,
      ),
    ).toMatchObject({
      decision: "resume-validation",
      nextAction: "run-validation",
    });
  });

  it("preserves isolation unavailability and routes containment remediation", () => {
    const { plan, authorization } = inputs();
    let record = createScmDeliveryRecord({
      plan,
      authorization,
      createdAt: T0,
    });
    record = progress(record, "prepared", plan, 0);
    record = failScmDeliveryRecord(
      record,
      { code: "validation-isolation-unavailable", at: TIMES[1]! },
      plan,
    );

    expect(record.failure).toMatchObject({
      code: "validation-isolation-unavailable",
      lastConfirmedState: "prepared",
      nextAction: "configure-validation-isolation",
    });
    expect(record.attempts.at(-1)).toMatchObject({
      outcome: "failed",
      failureCode: "validation-isolation-unavailable",
    });
    for (const observed of [
      observation(record, {
        authentication: "revoked",
        worktree: "matching",
        validation: "failed",
      }),
      observation(record, {
        worktree: "conflict",
        validation: "unknown",
      }),
    ]) {
      expect(reconcileScmDelivery(record, observed, plan)).toMatchObject({
        decision: "blocked",
        failureCode: "validation-isolation-unavailable",
        nextAction: "configure-validation-isolation",
      });
    }
  });

  it("does not skip workspace recovery for premature or contradictory validation evidence", () => {
    const { plan, authorization } = inputs();
    const planned = createScmDeliveryRecord({
      plan,
      authorization,
      createdAt: T0,
    });
    expect(
      reconcileScmDelivery(
        planned,
        observation(planned, {
          worktree: "matching",
          validation: "failed",
        }),
        plan,
      ),
    ).toMatchObject({
      decision: "resume-prepare",
      lastConfirmedState: "planned",
      nextAction: "prepare-worktree",
    });

    const prepared = progressThrough(planned, "prepared", plan);
    expectDeliveryError(
      () =>
        reconcileScmDelivery(
          prepared,
          observation(prepared, {
            worktree: "absent",
            validation: "failed",
          }),
          plan,
        ),
      "invalid-record",
    );
    expect(
      reconcileScmDelivery(
        prepared,
        observation(prepared, {
          worktree: "matching",
          validation: "failed",
        }),
        plan,
      ),
    ).toMatchObject({
      decision: "blocked",
      failureCode: "validation-failed",
      nextAction: "fix-validation",
    });
  });

  it("recovers the original patch without authentication or external state", () => {
    const { plan, authorization } = inputs();
    let record = createScmDeliveryRecord({
      plan,
      authorization,
      createdAt: T0,
    });
    record = failScmDeliveryRecord(record, { code: "authentication-revoked", at: TIMES[0]! }, plan);
    const recovered = recoverScmDeliveryPatch(
      record,
      {
        reasonCode: "authentication-unavailable",
        at: TIMES[1]!,
        patchBytes: PATCH_BYTES,
      },
      plan,
    );

    expect(recovered.disposition).toBe("recovered");
    expect(recovered.recovery).toEqual({
      mode: "patch-only",
      reasonCode: "authentication-unavailable",
      patchSha256: PATCH,
      preserved: true,
      nextAction: "review-preserved-patch",
      at: TIMES[1],
    });
    expect(
      recoverScmDeliveryPatch(
        recovered,
        {
          reasonCode: "authentication-unavailable",
          at: TIMES[2]!,
          patchBytes: PATCH_BYTES,
        },
        plan,
      ),
    ).toEqual(recovered);
    expectDeliveryError(
      () =>
        recoverScmDeliveryPatch(
          recovered,
          {
            reasonCode: "authentication-unavailable",
            at: TIMES[2]!,
            patchBytes: Buffer.from("deleted or substituted patch"),
          },
          plan,
        ),
      "external-drift",
    );
    expectDeliveryError(
      () =>
        recoverScmDeliveryPatch(
          recovered,
          {
            reasonCode: "operator-requested",
            at: TIMES[2]!,
            patchBytes: PATCH_BYTES,
          },
          plan,
        ),
      "invalid-transition",
    );
    expect(reconcileScmDelivery(recovered, observation(recovered), plan)).toMatchObject({
      decision: "recover-patch-only",
      lastConfirmedState: "planned",
      nextAction: "review-preserved-patch",
    });
  });

  it("reconciles crashes after prepare, validation, commit, push, and MR creation", () => {
    const { plan, authorization } = inputs();
    const planned = createScmDeliveryRecord({
      plan,
      authorization,
      createdAt: T0,
    });
    expect(reconcileScmDelivery(planned, observation(planned), plan)).toMatchObject({
      decision: "resume-prepare",
      lastConfirmedState: "planned",
      nextAction: "prepare-worktree",
    });
    expect(
      reconcileScmDelivery(planned, observation(planned, { worktree: "matching" }), plan),
    ).toMatchObject({
      decision: "resume-prepare",
      lastConfirmedState: "planned",
      nextAction: "prepare-worktree",
    });
    expect(
      reconcileScmDelivery(
        planned,
        observation(planned, {
          worktree: "matching",
          validation: "passed",
          localCommit: { status: "matching", revision: COMMIT },
          remoteBranch: { status: "matching", revision: COMMIT },
          mergeRequest: observedMr(planned, "opened"),
        }),
        plan,
      ),
    ).toMatchObject({
      decision: "resume-prepare",
      lastConfirmedState: "planned",
      nextAction: "prepare-worktree",
    });
    const prepared = progressThrough(planned, "prepared", plan);
    expect(
      reconcileScmDelivery(
        prepared,
        observation(prepared, {
          worktree: "matching",
          validation: "passed",
        }),
        plan,
      ),
    ).toMatchObject({
      decision: "resume-validation",
      lastConfirmedState: "prepared",
      nextAction: "run-validation",
    });
    const validated = progressThrough(planned, "validated", plan);
    expect(
      reconcileScmDelivery(
        validated,
        observation(validated, {
          worktree: "matching",
          validation: "passed",
          localCommit: { status: "matching", revision: COMMIT },
        }),
        plan,
      ),
    ).toMatchObject({
      decision: "resume-commit",
      lastConfirmedState: "validated",
      nextAction: "create-commit",
    });
    const committed = progressThrough(planned, "committed", plan);
    expect(
      reconcileScmDelivery(
        committed,
        observation(committed, {
          worktree: "matching",
          validation: "passed",
          localCommit: { status: "matching", revision: COMMIT },
          remoteBranch: { status: "matching", revision: COMMIT },
        }),
        plan,
      ),
    ).toMatchObject({
      decision: "resume-push",
      lastConfirmedState: "committed",
      nextAction: "push-branch",
    });
    const pushed = progressThrough(planned, "pushed", plan);
    expect(
      reconcileScmDelivery(
        pushed,
        observation(pushed, {
          worktree: "matching",
          validation: "passed",
          localCommit: { status: "matching", revision: COMMIT },
          remoteBranch: { status: "matching", revision: COMMIT },
          mergeRequest: observedMr(pushed, "opened"),
        }),
        plan,
      ),
    ).toMatchObject({
      decision: "resume-open-merge-request",
      lastConfirmedState: "pushed",
      nextAction: "open-draft-merge-request",
    });
    const opened = progressThrough(planned, "opened", plan);
    expect(reconcileScmDelivery(opened, matchingObservation(opened), plan)).toMatchObject({
      decision: "reuse-opened",
      lastConfirmedState: "opened",
      nextAction: "none",
    });
  });

  it("does not skip validation for discovered commits or regress a durable commit", () => {
    const { plan, authorization } = inputs();
    const planned = createScmDeliveryRecord({
      plan,
      authorization,
      createdAt: T0,
    });
    expect(
      reconcileScmDelivery(
        planned,
        observation(planned, {
          localCommit: { status: "matching", revision: COMMIT },
        }),
        plan,
      ),
    ).toMatchObject({
      decision: "resume-prepare",
      lastConfirmedState: "planned",
      nextAction: "prepare-worktree",
    });

    const committed = progressThrough(planned, "committed", plan);
    expect(reconcileScmDelivery(committed, observation(committed), plan)).toMatchObject({
      decision: "blocked",
      lastConfirmedState: "committed",
      failureCode: "receipt-drift",
      nextAction: "review-preserved-patch",
    });
    expect(
      reconcileScmDelivery(
        committed,
        observation(committed, {
          remoteBranch: { status: "deleted" },
        }),
        plan,
      ),
    ).toMatchObject({
      decision: "blocked",
      failureCode: "receipt-drift",
      nextAction: "review-preserved-patch",
    });
  });

  it.each([
    ["planned", "resume-prepare", "prepare-worktree"],
    ["prepared", "resume-validation", "run-validation"],
    ["validated", "resume-commit", "create-commit"],
  ] as const)(
    "does not skip the immediate %s boundary for a discovered commit and deleted remote",
    (state, decision, nextAction) => {
      const { plan, authorization } = inputs();
      const record = progressThrough(
        createScmDeliveryRecord({ plan, authorization, createdAt: T0 }),
        state,
        plan,
      );
      expect(
        reconcileScmDelivery(
          record,
          observation(record, {
            worktree: "matching",
            validation: "passed",
            localCommit: { status: "matching", revision: COMMIT },
            remoteBranch: { status: "deleted" },
          }),
          plan,
        ),
      ).toMatchObject({
        decision,
        lastConfirmedState: state,
        nextAction,
      });
    },
  );

  it.each([
    ["committed", (record: ScmDeliveryRecordV1) => observation(record)],
    [
      "pushed",
      (record: ScmDeliveryRecordV1) =>
        observation(record, {
          localCommit: { status: "matching", revision: COMMIT },
        }),
    ],
    [
      "opened",
      (record: ScmDeliveryRecordV1) =>
        observation(record, {
          worktree: "matching",
          validation: "passed",
          localCommit: { status: "matching", revision: COMMIT },
          remoteBranch: { status: "matching", revision: COMMIT },
          mergeRequest: { status: "absent" },
        }),
    ],
  ] as const)(
    "fails closed when durable %s external state is missing",
    (state, makeObservation) => {
      const { plan, authorization } = inputs();
      const record = progressThrough(
        createScmDeliveryRecord({ plan, authorization, createdAt: T0 }),
        state,
        plan,
      );
      expect(reconcileScmDelivery(record, makeObservation(record), plan)).toMatchObject({
        decision: "blocked",
        lastConfirmedState: state,
        failureCode: "receipt-drift",
        nextAction: "review-preserved-patch",
      });
    },
  );

  it.each([
    [
      "revoked auth",
      (record: ScmDeliveryRecordV1) => observation(record, { authentication: "revoked" }),
      "recover-patch-only",
      "authentication-revoked",
    ],
    [
      "remote drift",
      (record: ScmDeliveryRecordV1) =>
        observation(record, {
          remoteBranch: { status: "conflict", revision: "9".repeat(40) },
        }),
      "blocked",
      "remote-drift",
    ],
    [
      "closed MR",
      (record: ScmDeliveryRecordV1) =>
        observation(record, {
          localCommit: { status: "matching", revision: COMMIT },
          mergeRequest: observedMr(record, "closed"),
        }),
      "blocked",
      "merge-request-closed",
    ],
    [
      "manually merged MR",
      (record: ScmDeliveryRecordV1) =>
        observation(record, {
          localCommit: { status: "matching", revision: COMMIT },
          mergeRequest: observedMr(record, "merged"),
        }),
      "blocked",
      "merge-request-changed",
    ],
    [
      "changed MR target",
      (record: ScmDeliveryRecordV1) =>
        observation(record, {
          localCommit: { status: "matching", revision: COMMIT },
          mergeRequest: {
            ...observedMr(record, "opened"),
            targetBranch: "release",
          },
        }),
      "blocked",
      "merge-request-changed",
    ],
  ] as const)("fails closed for %s", (_label, makeObservation, decision, failureCode) => {
    const { plan, authorization } = inputs();
    const record = createScmDeliveryRecord({
      plan,
      authorization,
      createdAt: T0,
    });
    expect(reconcileScmDelivery(record, makeObservation(record), plan)).toMatchObject({
      decision,
      failureCode,
    });
  });

  it("detects disagreement between terminal success and current external state", () => {
    const { plan, authorization } = inputs();
    let record = createScmDeliveryRecord({
      plan,
      authorization,
      createdAt: T0,
    });
    record = progressThrough(record, "opened", plan);
    const result = reconcileScmDelivery(
      record,
      observation(record, {
        localCommit: { status: "matching", revision: COMMIT },
        remoteBranch: { status: "matching", revision: COMMIT },
        mergeRequest: { status: "absent" },
      }),
      plan,
    );
    expect(result).toMatchObject({
      decision: "blocked",
      failureCode: "receipt-drift",
    });

    const contradictory = reconcileScmDelivery(
      record,
      observation(record, {
        worktree: "matching",
        validation: "failed",
        localCommit: { status: "matching", revision: COMMIT },
        remoteBranch: { status: "deleted" },
        mergeRequest: observedMr(record, "opened"),
      }),
      plan,
    );
    expect(contradictory).toMatchObject({
      decision: "blocked",
      failureCode: "validation-failed",
    });
  });

  it("rejects receipt tampering, unplanned transitions, and content-bearing fields", () => {
    const { plan, authorization } = inputs();
    const record = createScmDeliveryRecord({
      plan,
      authorization,
      createdAt: T0,
    });
    expectDeliveryError(
      () =>
        recordScmDeliveryProgress(
          record,
          {
            toState: "committed",
            source: "executed",
            at: TIMES[0]!,
            evidence: { sha: COMMIT },
          },
          plan,
          authorization,
        ),
      "invalid-transition",
    );

    const tampered = structuredClone(record) as ScmDeliveryRecordV1 & {
      rawOutput?: string;
    };
    tampered.rawOutput = "PRIVATE-TOKEN: glpat-secret /Users/operator/.config/glab";
    expectDeliveryError(() => assertScmDeliveryRecord(tampered, plan), "invalid-record");

    const substituted = structuredClone(record);
    substituted.patch.sha256 = "9".repeat(64);
    substituted.sha256 = scmDeliveryRecordSha256(substituted);
    expectDeliveryError(() => assertScmDeliveryRecord(substituted, plan), "identity-mismatch");
  });

  it("requires the exact affirmative publication authorization for executed progress", () => {
    const { plan, authorization } = inputs();
    const record = createScmDeliveryRecord({
      plan,
      authorization,
      createdAt: T0,
    });
    const input = {
      toState: "prepared" as const,
      source: "executed" as const,
      at: TIMES[0]!,
      evidence: { workspaceKey: WORKTREE, baseRevision: BASE },
    };

    expectDeliveryError(
      () => recordScmDeliveryProgress(record, input, plan),
      "invalid-authorization",
    );
    expectDeliveryError(
      () =>
        recordScmDeliveryProgress(record, input, plan, {
          ...authorization,
          planSha256: "9".repeat(64),
        }),
      "invalid-authorization",
    );

    const literal = structuredClone(authorization);
    expectDeliveryError(
      () =>
        createScmDeliveryRecord({
          plan,
          authorization: literal,
          createdAt: T0,
        }),
      "invalid-authorization",
    );
  });

  it.each([
    `glpat-${"A".repeat(20)}`,
    `gldt-${"A".repeat(20)}`,
    `glrt-${"A".repeat(20)}`,
    `glptt-${"A".repeat(20)}`,
    `github_pat_${"A".repeat(24)}`,
    `xoxb-${"1".repeat(12)}-${"A".repeat(20)}`,
    `AIza${"A".repeat(35)}`,
    `ya29.${"A".repeat(30)}`,
    "AKIAABCDEFGHIJKLMNOP",
    "eyJabcdefgh.abcdefgh.abcdefgh",
    "api_key=abcdefghijkl",
  ])("admits and records credential-like branch value %s (#1807)", (credential) => {
    const plan = makePlan();
    plan.proposedSourceBranch = `docsfab-run/${credential}`;
    plan.sha256 = localUserPublicationPlanSha256(plan);
    const { findings } = collectCredentialFindings(() =>
      authorizeLocalUserPublication({
        plan,
        confirmedPlanSha256: plan.sha256,
        command: "publish",
      }),
    );
    expect(findings.filter((finding) => finding.location === "publication-plan:branch")).toEqual([
      expect.objectContaining({ code: "credential-like-content" }),
    ]);
    expect(JSON.stringify(findings)).not.toContain(credential);
  });

  it("refuses DocsFab's own configured credential in a branch, which looks like no credential", () => {
    const planted = plantConfiguredCredential();
    const plan = makePlan();
    plan.proposedSourceBranch = `docsfab-run/${planted}`;
    plan.sha256 = localUserPublicationPlanSha256(plan);
    expect(() =>
      authorizeLocalUserPublication({
        plan,
        confirmedPlanSha256: plan.sha256,
        command: "publish",
      }),
    ).toThrow();
  });

  it.each([
    [
      "run id",
      (plan: LocalUserPublicationPlanV1) => {
        plan.run.id = "AKIAABCDEFGHIJKLMNOP";
      },
    ],
    [
      "GitLab identity",
      (plan: LocalUserPublicationPlanV1) => {
        plan.identity.gitlabUsername = `ghp_${"A".repeat(24)}`;
      },
    ],
    [
      "project path",
      (plan: LocalUserPublicationPlanV1) => {
        plan.project.path = `group/glpat-${"A".repeat(20)}`;
      },
    ],
    [
      "remote name",
      (plan: LocalUserPublicationPlanV1) => {
        plan.remote.name = `nvapi-${"A".repeat(20)}`;
      },
    ],
    [
      "validation command",
      (plan: LocalUserPublicationPlanV1) => {
        plan.validationCommand = "npm run check AKIAABCDEFGHIJKLMNOP";
      },
    ],
  ] as const)("admits and records a credential-like value in plan %s (#1807)", (_label, mutate) => {
    const plan = makePlan();
    mutate(plan);
    plan.sha256 = localUserPublicationPlanSha256(plan);
    const { findings } = collectCredentialFindings(() =>
      authorizeLocalUserPublication({
        plan,
        confirmedPlanSha256: plan.sha256,
        command: "publish",
      }),
    );
    expect(findings.map((finding) => finding.location)).toContain("publication-plan");
  });

  it.each([
    ["run id", (plan: LocalUserPublicationPlanV1, value: string) => (plan.run.id = value)],
    [
      "GitLab identity",
      (plan: LocalUserPublicationPlanV1, value: string) => (plan.identity.gitlabUsername = value),
    ],
    [
      "project path",
      (plan: LocalUserPublicationPlanV1, value: string) => (plan.project.path = `group/${value}`),
    ],
    [
      "remote name",
      (plan: LocalUserPublicationPlanV1, value: string) => (plan.remote.name = value),
    ],
    [
      "validation command",
      (plan: LocalUserPublicationPlanV1, value: string) =>
        (plan.validationCommand = `npm run check ${value}`),
    ],
  ] as const)("refuses DocsFab's own configured credential in plan %s", (_label, mutate) => {
    const plan = makePlan();
    mutate(plan, plantConfiguredCredential());
    plan.sha256 = localUserPublicationPlanSha256(plan);
    expect(() =>
      authorizeLocalUserPublication({
        plan,
        confirmedPlanSha256: plan.sha256,
        command: "publish",
      }),
    ).toThrow();
  });

  it("admits and records a fake credential in an otherwise valid generic receipt field", () => {
    const { plan, authorization } = inputs();
    const record = structuredClone(createScmDeliveryRecord({ plan, authorization, createdAt: T0 }));
    const fake = `xoxb-${"1".repeat(12)}-${"A".repeat(20)}`;
    record.repository.path = `group/${fake}`;
    record.idempotencyKey = scmDeliveryIdentityKey({
      provider: record.repository.provider,
      run: record.run,
      repository: {
        projectId: record.repository.projectId,
        host: record.repository.host,
        path: record.repository.path,
      },
      baseRevision: record.baseRevision,
      targetBranch: record.targetBranch,
      patchSha256: record.patch.sha256,
    });
    record.sha256 = scmDeliveryRecordSha256(record);
    const { findings } = collectCredentialFindings(() => assertScmDeliveryRecordShape(record));
    expect(findings).toEqual([
      {
        code: "credential-like-content",
        location: "delivery-receipt",
        rule: "credential.slack-token",
      },
    ]);
  });

  it("refuses DocsFab's own configured credential in a generic receipt field", () => {
    const { plan, authorization } = inputs();
    const record = structuredClone(createScmDeliveryRecord({ plan, authorization, createdAt: T0 }));
    record.repository.path = `group/${plantConfiguredCredential()}`;
    record.idempotencyKey = scmDeliveryIdentityKey({
      provider: record.repository.provider,
      run: record.run,
      repository: {
        projectId: record.repository.projectId,
        host: record.repository.host,
        path: record.repository.path,
      },
      baseRevision: record.baseRevision,
      targetBranch: record.targetBranch,
      patchSha256: record.patch.sha256,
    });
    record.sha256 = scmDeliveryRecordSha256(record);

    expectDeliveryError(() => assertScmDeliveryRecordShape(record), "invalid-record");
  });

  it("binds documentation validation profile identity on validated evidence", () => {
    const selected = selectDocumentationValidationProfile({
      workflow: "update-documentation",
      changedPaths: ["docs/a.md", "docs/b.md"],
      hostPolicySha256: validationBackendPolicySha256(),
    });
    const { sha256: _omit, ...rest } = makePlan();
    const candidate = {
      ...rest,
      validationCommand: selected.entrypointCommand,
      documentationValidation: selected.binding,
    };
    const plan = {
      ...candidate,
      sha256: localUserPublicationPlanSha256(candidate),
    };
    const authorization = authorizeLocalUserPublication({
      plan,
      confirmedPlanSha256: plan.sha256,
      command: "publish",
    });
    let record = createScmDeliveryRecord({
      plan,
      authorization,
      createdAt: T0,
    });
    record = recordScmDeliveryProgress(
      record,
      {
        toState: "prepared",
        source: "executed",
        at: TIMES[1]!,
        evidence: { workspaceKey: WORKTREE, baseRevision: BASE },
      },
      plan,
      authorization,
    );
    record = recordScmDeliveryProgress(
      record,
      {
        toState: "validated",
        source: "executed",
        at: TIMES[2]!,
        evidence: {
          commandSha256: shaText(plan.validationCommand),
          summarySha256: SUMMARY,
          checkCount: selected.binding.checkIds.length,
          profileId: selected.binding.profileId,
          profileVersion: selected.binding.profileVersion,
          checkIds: [...selected.binding.checkIds],
          selectorInputSha256: selected.binding.selectorInputSha256,
          validatorIdentity: selected.binding.validatorIdentity,
          candidateTreeSha256: "c".repeat(64),
          checkSetSha256: selected.binding.checkSetSha256,
          resultSha256: "d".repeat(64),
          results: selected.binding.checkIds.map((id) => ({ id, status: "passed" as const })),
        },
      },
      plan,
      authorization,
    );
    expect(record.evidence.validation?.profileId).toBe("docsfab-documentation-validation");
    expect(record.evidence.validation?.checkIds).toEqual([...selected.binding.checkIds]);
    expect(record.evidence.validation?.resultSha256).toBe("d".repeat(64));
    const prepared = recordScmDeliveryProgress(
      createScmDeliveryRecord({ plan, authorization, createdAt: T0 }),
      {
        toState: "prepared",
        source: "executed",
        at: TIMES[1]!,
        evidence: { workspaceKey: WORKTREE, baseRevision: BASE },
      },
      plan,
      authorization,
    );
    expect(() =>
      recordScmDeliveryProgress(
        prepared,
        {
          toState: "validated",
          source: "executed",
          at: TIMES[2]!,
          evidence: {
            commandSha256: shaText(plan.validationCommand),
            summarySha256: SUMMARY,
            checkCount: 1,
            profileId: "docsfab-publication-validation",
            profileVersion: selected.binding.profileVersion,
            checkIds: [...selected.binding.checkIds],
            selectorInputSha256: selected.binding.selectorInputSha256,
            validatorIdentity: selected.binding.validatorIdentity,
            checkSetSha256: selected.binding.checkSetSha256,
          },
        },
        plan,
        authorization,
      ),
    ).toThrow(ScmDeliveryContractError);
  });

  it("binds failed validation diagnostics to the prepared workspace, plan, run, and patch", () => {
    const selected = selectDocumentationValidationProfile({
      workflow: "update-documentation",
      changedPaths: ["docs/a.md"],
      hostPolicySha256: validationBackendPolicySha256(),
    });
    const { sha256: _omit, ...rest } = makePlan();
    const candidate = {
      ...rest,
      validationCommand: selected.entrypointCommand,
      documentationValidation: selected.binding,
    };
    const plan = { ...candidate, sha256: localUserPublicationPlanSha256(candidate) };
    const authorization = authorizeLocalUserPublication({
      plan,
      confirmedPlanSha256: plan.sha256,
      command: "publish",
    });
    const prepared = recordScmDeliveryProgress(
      createScmDeliveryRecord({ plan, authorization, createdAt: T0 }),
      {
        toState: "prepared",
        source: "executed",
        at: TIMES[1]!,
        evidence: { workspaceKey: WORKTREE, baseRevision: BASE },
      },
      plan,
      authorization,
    );
    const validation = {
      reasonCode: "validation-check-failed" as const,
      planSha256: plan.sha256,
      runId: plan.run.id,
      runRecordSha256: plan.run.recordSha256,
      patchSha256: plan.patch.sha256,
      workspaceKey: WORKTREE,
      commandSha256: shaText(plan.validationCommand),
      profileId: selected.binding.profileId,
      profileVersion: selected.binding.profileVersion,
      checkIds: [...selected.binding.checkIds],
      selectorInputSha256: selected.binding.selectorInputSha256,
      validatorIdentity: selected.binding.validatorIdentity,
      candidateTreeSha256: "c".repeat(64),
      checkSetSha256: selected.binding.checkSetSha256,
      backendIdentity: "linux-bubblewrap",
      results: [{ id: "documentation-relative-links", status: "failed" as const }],
    };
    const failed = failScmDeliveryRecord(
      prepared,
      {
        code: "validation-failed",
        at: TIMES[2]!,
        validation,
        validationWorkspaceKey: validation.workspaceKey,
      },
      plan,
    );
    expect(failed).toMatchObject({
      state: "prepared",
      disposition: "failed",
      run: plan.run,
      planSha256: plan.sha256,
      patch: { sha256: plan.patch.sha256, preserved: true },
      failure: { code: "validation-failed", validation },
    });
    expect(failed.attempts.at(-1)).toMatchObject({
      outcome: "failed",
      failureCode: "validation-failed",
      evidenceSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
    });
    expect(assertScmDeliveryRecord(structuredClone(failed), plan)).toEqual(failed);
    expect(prepared).toMatchObject({ disposition: "active", attempts: [{ outcome: "confirmed" }] });
    expect(
      failScmDeliveryRecord(
        failed,
        {
          code: "validation-failed",
          at: TIMES[3]!,
          validation,
          validationWorkspaceKey: validation.workspaceKey,
        },
        plan,
      ),
    ).toEqual(failed);

    const retryValidation = {
      ...validation,
      workspaceKey: "1".repeat(64),
      candidateTreeSha256: "d".repeat(64),
    };
    const retryFailed = failScmDeliveryRecord(
      failed,
      {
        code: "validation-failed",
        at: TIMES[3]!,
        validation: retryValidation,
        validationWorkspaceKey: retryValidation.workspaceKey,
      },
      plan,
    );
    expect(retryFailed.attempts.slice(0, failed.attempts.length)).toEqual(failed.attempts);
    expect(retryFailed.attempts).toHaveLength(failed.attempts.length + 1);
    expect(retryFailed.failure?.validation).toEqual(retryValidation);
    expect(retryFailed.attempts.at(-1)?.workspaceKey).toBe(retryValidation.workspaceKey);

    expectDeliveryError(
      () =>
        failScmDeliveryRecord(
          prepared,
          {
            code: "validation-failed",
            at: TIMES[2]!,
            validation,
            validationWorkspaceKey: "1".repeat(64),
          },
          plan,
        ),
      "identity-mismatch",
    );

    for (const mismatch of [
      { planSha256: "2".repeat(64) },
      { runId: "run-other" },
      { runRecordSha256: "3".repeat(64) },
      { patchSha256: "4".repeat(64) },
      { profileId: "docsfab-publication-validation" },
      { validatorIdentity: "docsfab-validator-other" },
      { selectorInputSha256: "5".repeat(64) },
      { checkSetSha256: "6".repeat(64) },
    ]) {
      expectDeliveryError(
        () =>
          failScmDeliveryRecord(
            prepared,
            {
              code: "validation-failed",
              at: TIMES[2]!,
              validation: { ...validation, ...mismatch },
              validationWorkspaceKey: validation.workspaceKey,
            },
            plan,
          ),
        "identity-mismatch",
      );
    }
  });

  it("rejects unsafe or unbounded validation diagnostics before persistence", () => {
    // A credential-like backend identity is kept and recorded (#1807); DocsFab's
    // own configured credential is not kept.
    const shaped = collectCredentialFindings(() =>
      normalizeDeliveryValidationFailureEvidence({
        reasonCode: "validation-backend-unavailable",
        backendIdentity: `glpat-${"A".repeat(20)}`,
      }),
    );
    expect(shaped.result).toMatchObject({ backendIdentity: `glpat-${"A".repeat(20)}` });
    expect(shaped.findings).toEqual([
      {
        code: "credential-like-content",
        location: "publication-plan:documentationValidation",
        rule: "credential.gitlab-token",
      },
    ]);
    expect(
      normalizeDeliveryValidationFailureEvidence({
        reasonCode: "validation-backend-unavailable",
        backendIdentity: plantConfiguredCredential(),
      }),
    ).toBeUndefined();
    expect(
      normalizeDeliveryValidationFailureEvidence({
        reasonCode: "validation-check-failed",
        checkIds: ["documentation-relative-links"],
        results: [{ id: "/private/source/secret.md", status: "failed" }],
      }),
    ).toBeUndefined();
    expect(
      normalizeDeliveryValidationFailureEvidence({
        reasonCode: "validation-check-failed",
        checkIds: Array.from({ length: 65 }, (_item, index) => `check-${index}`),
        results: [{ id: "check-0", status: "failed" }],
      }),
    ).toBeUndefined();
  });
});

function inputs() {
  const plan = makePlan();
  const authorization = authorizeLocalUserPublication({
    plan,
    confirmedPlanSha256: plan.sha256,
    command: "publish",
  });
  return { plan, authorization };
}

function makePlan(): LocalUserPublicationPlanV1 {
  const candidate: LocalUserPublicationPlanV1 = {
    schemaVersion: 1,
    kind: "docsfab-local-user-gitlab-publication-plan",
    deliveryMode: "local-user",
    authorityBasis: "interactive-once",
    run: { id: "run-1", recordSha256: RECORD },
    project: { id: 42, host: "gitlab.example.test", path: "group/docs" },
    remote: { name: "origin", transport: "ssh" },
    identity: {
      git: "configured",
      gitIdentitySha256: localUserGitIdentitySha256("Maintainer", "maintainer@example.test"),
      gitlabUsername: "maintainer",
    },
    baseRevision: BASE,
    targetBranch: { name: "main", protected: true },
    proposedSourceBranch: "docsfab-run/run-1-aaaaaaaaaaaa",
    patch: {
      format: "git-diff",
      sha256: PATCH,
      byteLength: PATCH_BYTES.byteLength,
      changedFileCount: 2,
    },
    validationCommand: "npm run check",
    mergeRequest: { draft: true },
    fallback: { mode: "patch-only", preserved: true },
    checks: {
      repository: "passed",
      remote: "passed",
      revision: "current",
      gitIdentity: "configured",
      gitlabAuthentication: "authenticated",
      pushAccess: "allowed",
      sourceBranch: "unprotected",
    },
    sha256: "0".repeat(64),
  };
  candidate.sha256 = localUserPublicationPlanSha256(candidate);
  return candidate;
}

function makeCurrentDocumentationPlan(): LocalUserPublicationPlanV2 {
  const historical = makePlan();
  const selected = selectDocumentationValidationProfile({
    workflow: "update-documentation",
    changedPaths: ["docs/a.md"],
    hostPolicySha256: validationBackendPolicySha256(),
    applicabilitySha256: "9".repeat(64),
  });
  const { schemaVersion: _schemaVersion, sha256: _sha256, ...common } = historical;
  const candidate = {
    ...common,
    schemaVersion: 2 as const,
    validationCommand: selected.entrypointCommand,
    documentationValidation: selected.binding,
  };
  return { ...candidate, sha256: localUserPublicationPlanSha256(candidate) };
}

function progress(
  record: ScmDeliveryRecordV1,
  state: Exclude<ScmDeliveryState, "planned">,
  plan: LocalUserPublicationPlanV1,
  timeIndex: number,
  replay?: Parameters<typeof recordScmDeliveryProgress>[4],
): ScmDeliveryRecordV1 {
  const authorization = authorizeLocalUserPublication({
    plan,
    confirmedPlanSha256: plan.sha256,
    command: "publish",
  });
  if (state === "prepared")
    return recordScmDeliveryProgress(
      record,
      {
        toState: state,
        source: "executed",
        at: TIMES[timeIndex]!,
        evidence: { workspaceKey: WORKTREE, baseRevision: BASE },
      },
      plan,
      authorization,
      replay,
    );
  if (state === "validated")
    return recordScmDeliveryProgress(
      record,
      {
        toState: state,
        source: "executed",
        at: TIMES[timeIndex]!,
        evidence: {
          commandSha256: shaText(plan.validationCommand),
          summarySha256: SUMMARY,
          checkCount: 3,
        },
      },
      plan,
      authorization,
      replay,
    );
  if (state === "committed")
    return recordScmDeliveryProgress(
      record,
      {
        toState: state,
        source: "executed",
        at: TIMES[timeIndex]!,
        evidence: { sha: COMMIT },
      },
      plan,
      authorization,
      replay,
    );
  if (state === "pushed")
    return recordScmDeliveryProgress(
      record,
      {
        toState: state,
        source: "executed",
        at: TIMES[timeIndex]!,
        evidence: { remoteRevision: COMMIT },
      },
      plan,
      authorization,
      replay,
    );
  return recordScmDeliveryProgress(
    record,
    {
      toState: state,
      source: "executed",
      at: TIMES[timeIndex]!,
      evidence: {
        iid: 7,
        url: canonicalMergeRequestUrl(record, 7),
        state: "opened",
        draft: true,
        sourceBranch: plan.proposedSourceBranch,
        targetBranch: plan.targetBranch.name,
        headRevision: COMMIT,
      },
    },
    plan,
    authorization,
    replay,
  );
}

function progressThrough(
  record: ScmDeliveryRecordV1,
  state: ScmDeliveryState,
  plan: LocalUserPublicationPlanV1,
): ScmDeliveryRecordV1 {
  const sequence: Array<Exclude<ScmDeliveryState, "planned">> = [
    "prepared",
    "validated",
    "committed",
    "pushed",
    "opened",
  ];
  for (const [index, candidate] of sequence.entries()) {
    if (rank(candidate) > rank(state)) break;
    record = progress(record, candidate, plan, index);
  }
  return record;
}

function rank(state: ScmDeliveryState): number {
  return ["planned", "prepared", "validated", "committed", "pushed", "opened"].indexOf(state);
}

function observation(
  record: ScmDeliveryRecordV1,
  overrides: Partial<ScmDeliveryObservationV1> = {},
): ScmDeliveryObservationV1 {
  return {
    schemaVersion: 1,
    kind: "docsfab-scm-delivery-observation",
    idempotencyKey: record.idempotencyKey,
    planSha256: record.planSha256,
    authentication: "available",
    worktree: "absent",
    validation: "unknown",
    localCommit: { status: "absent" },
    remoteBranch: { status: "absent" },
    mergeRequest: { status: "absent" },
    ...overrides,
  };
}

function matchingObservation(record: ScmDeliveryRecordV1): ScmDeliveryObservationV1 {
  const stateRank = rank(record.state);
  return observation(record, {
    ...(stateRank >= rank("prepared") ? { worktree: "matching" as const } : {}),
    ...(stateRank >= rank("validated") ? { validation: "passed" as const } : {}),
    ...(stateRank >= rank("committed")
      ? { localCommit: { status: "matching" as const, revision: COMMIT } }
      : {}),
    ...(stateRank >= rank("pushed")
      ? { remoteBranch: { status: "matching" as const, revision: COMMIT } }
      : {}),
    ...(stateRank >= rank("opened") ? { mergeRequest: observedMr(record, "opened") } : {}),
  });
}

function confirmedReplay(
  record: ScmDeliveryRecordV1,
  plan: LocalUserPublicationPlanV1,
  observed = matchingObservation(record),
): NonNullable<Parameters<typeof recordScmDeliveryProgress>[4]> {
  const authorization = authorizeLocalUserPublication({
    plan,
    confirmedPlanSha256: plan.sha256,
    command: "publish",
  });
  return {
    observation: observed,
    confirmation: confirmScmDeliveryObservation({
      record,
      observation: observed,
      plan,
      authorization,
    }),
  };
}

function observedMr(record: ScmDeliveryRecordV1, status: "opened" | "closed" | "merged") {
  return {
    status,
    iid: 7,
    url: canonicalMergeRequestUrl(record, 7),
    draft: true as const,
    sourceBranch: record.sourceBranch,
    targetBranch: record.targetBranch,
    headRevision: COMMIT,
  };
}

function shaText(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function shaEvidence(value: JsonEvidenceValue): string {
  return createHash("sha256").update(canonicalizeJsonEvidence(value)).digest("hex");
}

function expectDeliveryError(action: () => unknown, code: string): void {
  try {
    action();
    throw new Error("Expected ScmDeliveryContractError.");
  } catch (error) {
    expect(error).toBeInstanceOf(ScmDeliveryContractError);
    expect((error as ScmDeliveryContractError).code).toBe(code);
  }
}
