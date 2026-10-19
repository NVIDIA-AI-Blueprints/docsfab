// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";

import { collectCredentialFindings } from "../src/security/credential-shape-findings.js";
import {
  clearPlantedCredential,
  plantConfiguredCredential,
} from "./helpers/planted-configured-credential.js";

import type {
  RoadmapFinding,
  RoadmapFindingMaterial,
  RoadmapLedger,
  RoadmapLifecycleTransition,
  RoadmapMutationAuthorization,
  RoadmapMutationPlan,
  RoadmapMutationReceipt,
  RoadmapTrackerIdentity,
} from "../src/roadmap/index.js";
import {
  assertRoadmapOperationAuthorized,
  createRoadmapLedger,
  createRoadmapMutationAuthorization,
  createRoadmapMutationPlan,
  createRoadmapMutationReceipt,
  createRoadmapRunArtifactReferences,
  roadmapCanonicalJson,
  roadmapDigest,
  roadmapFindingFingerprint,
  RoadmapContractError,
  validateRoadmapLedger,
  validateRoadmapMutationAuthorization,
  validateRoadmapMutationPlan,
  validateRoadmapMutationReceipt,
  validateRoadmapRunArtifactReferences,
  validateRoadmapSchemaMigrationRule,
} from "../src/roadmap/index.js";

const REVISION = "a".repeat(40);
const CONTENT = "b".repeat(64);
const EVIDENCE = "c".repeat(64);
const TRACKER = "d".repeat(64);
const T0 = "2026-08-04T00:00:00.000Z";
const T1 = "2026-08-04T00:01:00.000Z";
const T2 = "2026-08-04T00:02:00.000Z";
const T3 = "2026-08-04T00:03:00.000Z";
const T4 = "2026-08-04T00:04:00.000Z";
const STATE_FIXTURE = JSON.parse(
  readFileSync(
    new URL("./fixtures/runtime-evaluation/roadmap/state-transition-cases.json", import.meta.url),
    "utf8",
  ),
) as {
  schemaVersion: number;
  lifecycle: Array<{ id: string; states: RoadmapFinding["lifecycle"][] }>;
  partialFailureCodes: string[];
  receiptScenarios: string[];
  closeoutScenarios: string[];
};

describe("roadmap contracts", () => {
  afterEach(() => {
    clearPlantedCredential();
  });

  it("round-trips a revision/project/tracker-bound ledger with a canonical digest", () => {
    const ledger = makeLedger();
    const decoded = validateRoadmapLedger(JSON.parse(roadmapCanonicalJson(ledger)));

    expect(decoded).toEqual(ledger);
    expect(decoded.digest).toBe(roadmapDigest(decoded));
    expect(Object.isFrozen(decoded)).toBe(true);
    expect(Object.isFrozen(decoded.findings[0])).toBe(true);
  });

  it("keeps finding identity stable across wording/id changes and changes on material evidence", () => {
    const material = findingMaterial("docs/architecture.md", EVIDENCE);
    const renamed = { ...material, category: `${material.category}` };

    expect(roadmapFindingFingerprint(material)).toBe(roadmapFindingFingerprint(renamed));
    expect(
      roadmapFindingFingerprint({
        ...material,
        materialEvidenceDigest: "f".repeat(64),
      }),
    ).not.toBe(roadmapFindingFingerprint(material));
    expect(
      roadmapFindingFingerprint({
        ...material,
        affectedPaths: ["docs/reference/contracts/roadmap-contracts.md"],
      }),
    ).not.toBe(roadmapFindingFingerprint(material));
  });

  it("canonicalizes set-like ledger collections independently of input order", () => {
    const ledger = makeLedger();
    const reordered = createRoadmapLedger({
      ...withoutDigest(ledger),
      evidence: [...ledger.evidence].reverse(),
      findings: [...ledger.findings].reverse(),
      workstreams: [...ledger.workstreams].reverse(),
      dedup: [...ledger.dedup].reverse(),
      transitions: [...ledger.transitions].reverse(),
    });

    expect(reordered.digest).toBe(ledger.digest);
    expect(roadmapCanonicalJson(reordered)).toBe(roadmapCanonicalJson(ledger));
  });

  it("accepts complete lifecycle chains including reopened, duplicate, and superseded work", () => {
    const first = makeFinding("finding:one", "docs/architecture.md", "proposed");
    const second = makeFinding(
      "finding:two",
      "docs/reference/contracts/run-records.md",
      "superseded",
      "f".repeat(64),
    );
    const transitions: RoadmapLifecycleTransition[] = [
      transition("transition:1", first.id, "observed", "proposed", T1),
      transition("transition:2", first.id, "proposed", "filed", T2),
      transition("transition:3", first.id, "filed", "selected", T3),
      transition("transition:4", first.id, "selected", "in-progress", "2026-08-04T00:04:00.000Z"),
      transition("transition:5", first.id, "in-progress", "fixed", "2026-08-04T00:05:00.000Z"),
      transition("transition:6", first.id, "fixed", "verified", "2026-08-04T00:06:00.000Z"),
      transition("transition:7", first.id, "verified", "closed", "2026-08-04T00:07:00.000Z"),
      transition("transition:8", first.id, "closed", "observed", "2026-08-04T00:08:00.000Z"),
      transition("transition:9", first.id, "observed", "proposed", "2026-08-04T00:09:00.000Z"),
      transition("transition:10", second.id, "observed", "duplicate", T1),
      transition("transition:11", second.id, "duplicate", "observed", T2),
      transition("transition:12", second.id, "observed", "superseded", T3),
    ];
    const ledger = createRoadmapLedger({
      ...withoutDigest(makeLedger()),
      findings: [first, second],
      transitions,
      workstreams: [
        {
          id: "workstream:one",
          findingIds: [first.id, second.id],
          dependsOnWorkstreamIds: [],
          collidesWithWorkstreamIds: [],
          executionOrder: 1,
          state: "planned",
        },
      ],
      dedup: [
        { findingId: first.id, decision: "create", rationaleCode: "new-finding" },
        { findingId: second.id, decision: "create", rationaleCode: "new-finding" },
      ],
      sweeps: [],
      closeouts: [],
      updatedAt: "2026-08-04T00:10:00.000Z",
    });

    expect(ledger.findings.map((item) => item.lifecycle)).toEqual(["proposed", "superseded"]);
  });

  it("validates every checked-in lifecycle transition fixture", () => {
    expect(STATE_FIXTURE.schemaVersion).toBe(1);
    expect(new Set(STATE_FIXTURE.receiptScenarios)).toEqual(
      new Set(["partial-filing", "bounded-retry", "issue-reuse"]),
    );
    expect(new Set(STATE_FIXTURE.closeoutScenarios)).toEqual(
      new Set(["clean-supplemental-sweep", "new-finding-keeps-open"]),
    );
    for (const scenario of STATE_FIXTURE.lifecycle) {
      const finding = makeFinding(
        "finding:fixture",
        "docs/architecture.md",
        scenario.states.at(-1)!,
      );
      const transitions = scenario.states
        .slice(1)
        .map((state, index) =>
          transition(
            `transition:${scenario.id}-${index + 1}`,
            finding.id,
            scenario.states[index]!,
            state,
            new Date(Date.parse(T0) + (index + 1) * 1_000).toISOString(),
          ),
        );
      const ledger = createRoadmapLedger({
        ...withoutDigest(makeLedger()),
        findings: [finding],
        transitions,
        workstreams: [
          {
            id: "workstream:fixture",
            findingIds: [finding.id],
            dependsOnWorkstreamIds: [],
            collidesWithWorkstreamIds: [],
            executionOrder: 1,
            state: "planned",
          },
        ],
        dedup: [{ findingId: finding.id, decision: "create", rationaleCode: "fixture" }],
        sweeps: [],
        closeouts: [],
      });
      expect(ledger.findings[0]!.lifecycle).toBe(scenario.states.at(-1));
    }
  });

  it("binds a mutation plan to the ledger, immutable repository, project, and tracker observations", () => {
    const { ledger, plan } = makePlan();
    const decoded = validateRoadmapMutationPlan(JSON.parse(roadmapCanonicalJson(plan)), {
      ledger,
      now: new Date(T2),
      currentTracker: ledger.tracker,
    });

    expect(decoded.digest).toBe(plan.digest);
    expect(new Set(decoded.operations.map((item) => item.key))).toEqual(
      new Set(["operation:create-issue", "operation:update-existing"]),
    );
  });

  it("provides content-free ledger and plan references for roadmap run records", () => {
    const { ledger, plan } = makePlan();
    const references = createRoadmapRunArtifactReferences(ledger, plan);

    expect(
      validateRoadmapRunArtifactReferences(
        JSON.parse(roadmapCanonicalJson(references)),
        ledger,
        plan,
      ),
    ).toEqual(references);
    expect(references).toEqual({
      schemaVersion: 1,
      ledger: {
        kind: "roadmap-ledger",
        schemaVersion: 1,
        digest: ledger.digest,
        repositoryRevision: REVISION,
        repositoryContentDigest: CONTENT,
      },
      plan: {
        kind: "roadmap-mutation-plan",
        schemaVersion: 1,
        digest: plan.digest,
        repositoryRevision: REVISION,
        repositoryContentDigest: CONTENT,
      },
    });
  });

  it("authorizes only an exact subset and rejects later operation expansion", () => {
    const { ledger, plan } = makePlan();
    const authorization = makeAuthorization(ledger, plan, ["operation:create-issue"]);

    expect(validateRoadmapMutationAuthorization(authorization, plan, ledger)).toEqual(
      authorization,
    );
    expectRoadmapError(
      () =>
        assertRoadmapOperationAuthorized(
          ledger,
          plan,
          authorization,
          "operation:create-issue",
          new Date(T2),
          ledger.tracker,
        ),
      "replan-required",
    );

    const expanded = redigest({
      ...structuredClone(authorization),
      authorizedOperationKeys: [...authorization.authorizedOperationKeys, "operation:unplanned"],
    });
    expectRoadmapError(
      () => validateRoadmapMutationAuthorization(expanded, plan, ledger),
      "operation-expansion",
    );
    expectRoadmapError(
      () => makeAuthorization(ledger, plan, ["operation:update-existing"]),
      "unresolved-dependency",
    );
    const staleTracker = structuredClone(ledger.tracker);
    staleTracker[0]!.updatedAt = T2;
    expectRoadmapError(
      () =>
        assertRoadmapOperationAuthorized(
          ledger,
          plan,
          authorization,
          "operation:create-issue",
          new Date(T2),
          staleTracker,
        ),
      "replan-required",
    );

    const mutated = structuredClone(plan);
    mutated.operations[0]!.payloadBytes += 1;
    expectRoadmapError(
      () =>
        assertRoadmapOperationAuthorized(
          ledger,
          mutated,
          authorization,
          "operation:create-issue",
          new Date(T2),
          ledger.tracker,
        ),
      "replan-required",
    );
    mutated.digest = roadmapDigest(mutated);
    expectRoadmapError(
      () =>
        assertRoadmapOperationAuthorized(
          ledger,
          mutated,
          authorization,
          "operation:create-issue",
          new Date(T2),
          ledger.tracker,
        ),
      "replan-required",
    );
  });

  it("round-trips typed proposals and enforces kind-specific targets", () => {
    const base = makeCloseableLedger("issue:45");
    const linkTargetDigest = "6".repeat(64);
    const ledger = createRoadmapLedger({
      ...withoutDigest(base),
      tracker: [
        ...base.tracker,
        { issueIid: 46, state: "opened", updatedAt: T1, identityDigest: linkTargetDigest },
      ],
      closeouts: [
        {
          ...base.closeouts[0]!,
          targetKey: "issue:45",
          decision: "close",
        },
      ],
    });
    const precondition = {
      targetKey: "issue:45",
      observedAt: T1,
      identityDigest: TRACKER,
    };
    const proposals = [
      {
        key: "operation:saga",
        targetKey: "project:422255",
        proposal: {
          kind: "saga" as const,
          projectId: 422_255,
          titleDigest: "1".repeat(64),
          descriptionDigest: "2".repeat(64),
          labelNames: ["status:planned"],
        },
      },
      {
        key: "operation:comment",
        targetKey: "issue:45",
        proposal: { kind: "comment" as const, issueIid: 45, commentDigest: "3".repeat(64) },
        precondition,
      },
      {
        key: "operation:link",
        targetKey: "issue:45",
        proposal: {
          kind: "link" as const,
          sourceIssueIid: 45,
          targetIssueIid: 46,
          relationship: "blocks" as const,
          targetPrecondition: {
            targetKey: "issue:46",
            observedAt: T1,
            identityDigest: linkTargetDigest,
          },
        },
        precondition,
      },
      {
        key: "operation:milestone",
        targetKey: "project:422255",
        proposal: {
          kind: "milestone" as const,
          projectId: 422_255,
          titleDigest: "4".repeat(64),
          dueDate: "2026-09-01",
        },
      },
      {
        key: "operation:label",
        targetKey: "issue:45",
        proposal: {
          kind: "label" as const,
          issueIid: 45,
          add: ["status:in-progress"],
          remove: ["status:planned"],
        },
        precondition,
      },
      {
        key: "operation:closure",
        targetKey: "issue:45",
        proposal: {
          kind: "closure" as const,
          issueIid: 45,
          action: "close" as const,
          closeoutDecisionId: "closeout:one",
          evidenceDigest: roadmapDigest({ evidenceIds: ["evidence:run-one"] }),
        },
        precondition,
      },
    ];
    const plan = createRoadmapMutationPlan(
      {
        id: "plan:typed-proposals",
        ledger: createRoadmapRunArtifactReferences(ledger).ledger,
        repository: ledger.repository,
        project: ledger.project,
        trackerObservedAt: ledger.trackerObservedAt,
        operations: proposals.map((item) => ({
          key: item.key,
          kind: item.proposal.kind,
          targetKey: item.targetKey,
          findingIds: [ledger.findings[0]!.id],
          dependsOnOperationKeys: [],
          payloadDigest: roadmapDigest(item.proposal),
          payloadBytes: 1,
          proposal: item.proposal,
          ...(item.precondition === undefined ? {} : { precondition: item.precondition }),
        })),
        generatedAt: T3,
        expiresAt: "2026-08-04T00:30:00.000Z",
      },
      ledger,
    );

    expect(new Set(plan.operations.map((item) => item.kind))).toEqual(
      new Set(["saga", "comment", "link", "milestone", "label", "closure"]),
    );
    expect(roadmapDigest({ kind: "label", issueIid: 45, add: ["z", "a"], remove: [] })).toBe(
      roadmapDigest({ kind: "label", issueIid: 45, add: ["a", "z"], remove: [] }),
    );
    const wrongTarget = structuredClone(plan);
    wrongTarget.operations.find((item) => item.kind === "closure")!.targetKey = "issue:46";
    wrongTarget.digest = roadmapDigest(wrongTarget);
    expectRoadmapError(() => validateRoadmapMutationPlan(wrongTarget, { ledger }), "tracker-drift");

    const unobservedLink = structuredClone(plan);
    const link = unobservedLink.operations.find((item) => item.proposal.kind === "link")!;
    if (link.proposal.kind !== "link") throw new Error("expected link proposal");
    link.proposal.targetIssueIid = 999;
    link.proposal.targetPrecondition.targetKey = "issue:999";
    link.payloadDigest = roadmapDigest(link.proposal);
    unobservedLink.digest = roadmapDigest(unobservedLink);
    expectRoadmapError(
      () => validateRoadmapMutationPlan(unobservedLink, { ledger }),
      "tracker-drift",
    );

    const unsupportedClosureEvidence = structuredClone(plan);
    const closure = unsupportedClosureEvidence.operations.find(
      (item) => item.proposal.kind === "closure",
    )!;
    if (closure.proposal.kind !== "closure") throw new Error("expected closure proposal");
    closure.proposal.evidenceDigest = "9".repeat(64);
    closure.payloadDigest = roadmapDigest(closure.proposal);
    unsupportedClosureEvidence.digest = roadmapDigest(unsupportedClosureEvidence);
    expectRoadmapError(
      () => validateRoadmapMutationPlan(unsupportedClosureEvidence, { ledger }),
      "digest-mismatch",
    );

    const closureAuthorization = createRoadmapMutationAuthorization(
      {
        id: "authorization:closure",
        authorizedOperationKeys: ["operation:closure"],
        authority: { kind: "local-user", id: "operator:maintainer" },
        issuedAt: T3,
        expiresAt: "2026-08-04T00:20:00.000Z",
      },
      plan,
      ledger,
    );
    expectRoadmapError(
      () =>
        createRoadmapMutationReceipt(
          {
            id: "receipt:closure-wrong-state",
            attempts: [
              {
                operationKey: "operation:closure",
                attempt: 1,
                disposition: "succeeded",
                startedAt: T3,
                completedAt: T4,
                before: trackerIdentity("issue:45", "45", "opened", T1, TRACKER),
                after: trackerIdentity("issue:45", "45", "opened", T4, "8".repeat(64)),
              },
            ],
            terminal: "complete",
            createdAt: T3,
            completedAt: T4,
          },
          ledger,
          plan,
          closureAuthorization,
        ),
      "tracker-drift",
    );
  });

  it("records partial failure, bounded retry, and complete resumption", () => {
    const { ledger, plan } = makePlan();
    const authorization = makeAuthorization(
      ledger,
      plan,
      plan.operations.map((item) => item.key),
    );
    const created = trackerIdentity("issue:46", "46", "opened", T2, "1".repeat(64));
    const existing = trackerIdentity("issue:45", "45", "opened", T1, TRACKER);
    const updated = trackerIdentity("issue:45", "45", "opened", T4, "2".repeat(64));
    const receipt = createRoadmapMutationReceipt(
      {
        id: "receipt:one",
        attempts: [
          {
            operationKey: "operation:create-issue",
            attempt: 1,
            disposition: "succeeded",
            startedAt: T1,
            completedAt: T2,
            after: created,
          },
          {
            operationKey: "operation:update-existing",
            attempt: 1,
            disposition: "failed",
            startedAt: T2,
            completedAt: T3,
            before: existing,
            failureCode: "tracker-timeout",
          },
          {
            operationKey: "operation:update-existing",
            attempt: 2,
            disposition: "succeeded",
            startedAt: T3,
            completedAt: T4,
            before: existing,
            after: updated,
          },
        ],
        terminal: "complete",
        createdAt: T1,
        completedAt: T4,
      },
      ledger,
      plan,
      authorization,
    );

    expect(validateRoadmapMutationReceipt(receipt, ledger, plan, authorization)).toEqual(receipt);
  });

  it("binds receipt attempts to authorization time, preconditions, reuse identity, and dependency order", () => {
    const { ledger, plan } = makePlan();
    const authorization = makeAuthorization(
      ledger,
      plan,
      plan.operations.map((item) => item.key),
    );
    const created = trackerIdentity("issue:46", "46", "opened", T2, "1".repeat(64));
    const existing = trackerIdentity("issue:45", "45", "opened", T1, TRACKER);
    const updated = trackerIdentity("issue:45", "45", "opened", T4, "2".repeat(64));
    const receiptInput = {
      id: "receipt:adversarial",
      attempts: [
        {
          operationKey: "operation:create-issue",
          attempt: 1,
          disposition: "succeeded" as const,
          startedAt: T1,
          completedAt: T2,
          after: created,
        },
        {
          operationKey: "operation:update-existing",
          attempt: 1,
          disposition: "succeeded" as const,
          startedAt: T2,
          completedAt: T4,
          before: existing,
          after: updated,
        },
      ],
      terminal: "complete" as const,
      createdAt: T1,
      completedAt: T4,
    };
    const { before: _before, ...withoutBefore } = receiptInput.attempts[1]!;

    expectRoadmapError(
      () =>
        createRoadmapMutationReceipt(
          {
            ...receiptInput,
            id: "receipt:late",
            attempts: [
              {
                ...receiptInput.attempts[0]!,
                startedAt: "2026-08-04T00:21:00.000Z",
                completedAt: "2026-08-04T00:22:00.000Z",
              },
            ],
            terminal: "complete",
            createdAt: "2026-08-04T00:21:00.000Z",
            completedAt: "2026-08-04T00:22:00.000Z",
          },
          ledger,
          plan,
          makeAuthorization(ledger, plan, ["operation:create-issue"]),
        ),
      "expired",
    );

    expectRoadmapError(
      () =>
        createRoadmapMutationReceipt(
          {
            ...receiptInput,
            id: "receipt:missing-before",
            attempts: [receiptInput.attempts[0]!, withoutBefore],
          },
          ledger,
          plan,
          authorization,
        ),
      "missing-field",
    );

    expectRoadmapError(
      () =>
        createRoadmapMutationReceipt(
          {
            ...receiptInput,
            id: "receipt:wrong-before",
            attempts: [
              receiptInput.attempts[0]!,
              {
                ...receiptInput.attempts[1]!,
                before: { ...existing, identityDigest: "9".repeat(64) },
              },
            ],
          },
          ledger,
          plan,
          authorization,
        ),
      "tracker-drift",
    );

    expectRoadmapError(
      () =>
        createRoadmapMutationReceipt(
          {
            ...receiptInput,
            id: "receipt:cross-operation-reuse",
            attempts: [
              receiptInput.attempts[0]!,
              {
                ...receiptInput.attempts[1]!,
                disposition: "reused",
                before: existing,
                after: existing,
                reusedOperationKey: "operation:create-issue",
              },
            ],
          },
          ledger,
          plan,
          authorization,
        ),
      "unresolved-dependency",
    );

    const unobserved = trackerIdentity("issue:999", "999", "opened", T1, "7".repeat(64));
    expectRoadmapError(
      () =>
        createRoadmapMutationReceipt(
          {
            id: "receipt:unobserved-reuse",
            attempts: [
              {
                operationKey: "operation:create-issue",
                attempt: 1,
                disposition: "reused",
                startedAt: T1,
                completedAt: T2,
                before: unobserved,
                after: unobserved,
                reusedOperationKey: "operation:create-issue",
              },
            ],
            terminal: "complete",
            createdAt: T1,
            completedAt: T2,
          },
          ledger,
          plan,
          makeAuthorization(ledger, plan, ["operation:create-issue"]),
        ),
      "unresolved-dependency",
    );

    expectRoadmapError(
      () =>
        createRoadmapMutationReceipt(
          {
            id: "receipt:wrong-created-target",
            attempts: [
              {
                operationKey: "operation:create-issue",
                attempt: 1,
                disposition: "succeeded",
                startedAt: T1,
                completedAt: T2,
                after: trackerIdentity("milestone:999", "999", "closed", T2, "8".repeat(64)),
              },
            ],
            terminal: "complete",
            createdAt: T1,
            completedAt: T2,
          },
          ledger,
          plan,
          makeAuthorization(ledger, plan, ["operation:create-issue"]),
        ),
      "tracker-drift",
    );

    expectRoadmapError(
      () =>
        createRoadmapMutationReceipt(
          {
            id: "receipt:future-created-identity",
            attempts: [
              {
                ...receiptInput.attempts[0]!,
                after: { ...created, updatedAt: T4 },
              },
            ],
            terminal: "complete",
            createdAt: T1,
            completedAt: T2,
          },
          ledger,
          plan,
          makeAuthorization(ledger, plan, ["operation:create-issue"]),
        ),
      "invalid-time",
    );

    expectRoadmapError(
      () =>
        createRoadmapMutationReceipt(
          {
            ...receiptInput,
            id: "receipt:early-dependent",
            attempts: [
              { ...receiptInput.attempts[0]!, completedAt: T3 },
              { ...receiptInput.attempts[1]!, startedAt: T2 },
            ],
          },
          ledger,
          plan,
          authorization,
        ),
      "unresolved-dependency",
    );
  });

  it.each(STATE_FIXTURE.partialFailureCodes)(
    "records partial filing after %s without hiding completed mutations",
    (failureCode) => {
      const { ledger, plan } = makePlan();
      const authorization = makeAuthorization(
        ledger,
        plan,
        plan.operations.map((item) => item.key),
      );
      const receipt = createRoadmapMutationReceipt(
        {
          id: `receipt:${failureCode}`,
          attempts: [
            {
              operationKey: "operation:create-issue",
              attempt: 1,
              disposition: "succeeded",
              startedAt: T1,
              completedAt: T2,
              after: trackerIdentity("issue:46", "46", "opened", T2, "1".repeat(64)),
            },
            {
              operationKey: "operation:update-existing",
              attempt: 1,
              disposition: "failed",
              startedAt: T2,
              completedAt: T3,
              before: trackerIdentity("issue:45", "45", "opened", T1, TRACKER),
              failureCode,
            },
          ],
          terminal: "partial",
          createdAt: T1,
          completedAt: T3,
        },
        ledger,
        plan,
        authorization,
      );

      expect(receipt.terminal).toBe("partial");
      expect(receipt.attempts[0]!.disposition).toBe("succeeded");
      expect(receipt.attempts[1]!.failureCode).toBe(failureCode);
    },
  );

  it("supports idempotent issue reuse without treating an MR or issue as implicit closure", () => {
    const base = makeLedger();
    const ledger = createRoadmapLedger({
      ...withoutDigest(base),
      dedup: base.dedup.map((item) =>
        item.findingId === "finding:two"
          ? {
              findingId: item.findingId,
              decision: "reuse" as const,
              issueIid: 45,
              observedUpdatedAt: T1,
              rationaleCode: "same-material-evidence",
            }
          : item,
      ),
    });
    const { plan } = makePlan(ledger);
    const authorization = makeAuthorization(ledger, plan, ["operation:create-issue"]);
    const existing = trackerIdentity("issue:45", "45", "opened", T1, TRACKER);
    const receipt = createRoadmapMutationReceipt(
      {
        id: "receipt:reuse",
        attempts: [
          {
            operationKey: "operation:create-issue",
            attempt: 1,
            disposition: "reused",
            startedAt: T1,
            completedAt: T2,
            before: existing,
            after: existing,
            reusedOperationKey: "operation:create-issue",
          },
        ],
        terminal: "complete",
        createdAt: T1,
        completedAt: T2,
      },
      ledger,
      plan,
      authorization,
    );

    expect(receipt.terminal).toBe("complete");
    expect(receipt.attempts[0]!.disposition).toBe("reused");
    expect(makeLedger().findings.every((item) => item.lifecycle !== "closed")).toBe(true);

    expectRoadmapError(
      () =>
        createRoadmapMutationReceipt(
          {
            id: "receipt:duplicate-create-after-reuse-decision",
            attempts: [
              {
                operationKey: "operation:create-issue",
                attempt: 1,
                disposition: "succeeded",
                startedAt: T1,
                completedAt: T2,
                after: trackerIdentity("issue:46", "46", "opened", T2, "1".repeat(64)),
              },
            ],
            terminal: "complete",
            createdAt: T1,
            completedAt: T2,
          },
          ledger,
          plan,
          authorization,
        ),
      "unresolved-dependency",
    );
  });

  it("allows closeout only after a clean supplemental sweep", () => {
    const clean = makeCloseableLedger("saga:43");
    const closing = createRoadmapLedger({
      ...withoutDigest(clean),
      closeouts: [{ ...clean.closeouts[0]!, decision: "close" }],
    });
    expect(closing.closeouts[0]!.decision).toBe("close");

    const findingId = clean.findings[0]!.id;
    const blocked = structuredClone(closing);
    blocked.sweeps[0]!.disposition = "new-findings";
    blocked.sweeps[0]!.newFindingIds = [findingId];
    blocked.digest = roadmapDigest(blocked);
    expectRoadmapError(() => validateRoadmapLedger(blocked), "unresolved-dependency");

    const incomplete = structuredClone(closing);
    incomplete.sweeps[0]!.findingFingerprints = [];
    incomplete.digest = roadmapDigest(incomplete);
    expectRoadmapError(() => validateRoadmapLedger(incomplete), "unresolved-reference");

    const premature = structuredClone(closing);
    premature.sweeps[0]!.trackerObservedAt = T3;
    premature.closeouts[0]!.decidedAt = T2;
    premature.updatedAt = T4;
    premature.digest = roadmapDigest(premature);
    expectRoadmapError(() => validateRoadmapLedger(premature), "invalid-time");
  });

  it.each([
    "PRIVATE-TOKEN: raw-secret",
    "glpat-1234567890abcdefghijk",
    "https://gitlab.example.com/group/project/-/issues/45",
    "/Users/operator/private/issue.json",
  ])("rejects content-bearing external identifiers: %s", (externalId) => {
    const ledger = structuredClone(makeLedger());
    ledger.evidence[0]!.externalId = externalId;
    ledger.digest = roadmapDigest(ledger);
    expectRoadmapError(() => validateRoadmapLedger(ledger), "invalid-value");
  });

  it("admits and records credential-shaped generic identifiers, and refuses a configured credential (#1807)", () => {
    const ledger = structuredClone(makeLedger());
    ledger.id = "glpat-1234567890abcdefghijk";
    ledger.digest = roadmapDigest(ledger);
    const { findings } = collectCredentialFindings(() => validateRoadmapLedger(ledger));
    expect(findings).toEqual([
      {
        code: "credential-like-content",
        location: "roadmap:$.id",
        rule: "credential.gitlab-token",
      },
    ]);
    const configured = structuredClone(makeLedger());
    configured.id = plantConfiguredCredential();
    configured.digest = roadmapDigest(configured);
    expectRoadmapError(() => validateRoadmapLedger(configured), "invalid-value");
  });

  it.each([
    [
      "unknown field",
      (ledger: RoadmapLedger) => Object.assign(ledger, { rawIssueBody: "secret" }),
      "unknown-field",
    ],
    [
      "absolute evidence path",
      (ledger: RoadmapLedger) => {
        ledger.evidence[0]!.path = "/tmp/private.json";
      },
      "unsafe-path",
    ],
    [
      "stale repository",
      (ledger: RoadmapLedger) => {
        ledger.repository.revision = "9".repeat(40);
      },
      "repository-mismatch",
    ],
    [
      "digest mismatch",
      (ledger: RoadmapLedger) => {
        ledger.digest = "9".repeat(64);
      },
      "digest-mismatch",
    ],
    [
      "unresolved finding dependency",
      (ledger: RoadmapLedger) => {
        ledger.findings[0]!.dependsOnFindingIds = ["finding:missing"];
      },
      "unresolved-reference",
    ],
    [
      "dependency cycle",
      (ledger: RoadmapLedger) => {
        ledger.findings[0]!.dependsOnFindingIds = [ledger.findings[1]!.id];
        ledger.findings[1]!.dependsOnFindingIds = [ledger.findings[0]!.id];
      },
      "dependency-cycle",
    ],
    [
      "invalid lifecycle transition",
      (ledger: RoadmapLedger) => {
        ledger.transitions[0]!.to = "closed";
      },
      "invalid-transition",
    ],
    [
      "tracker drift",
      (ledger: RoadmapLedger) => {
        ledger.dedup.find((item) => item.decision === "reuse")!.observedUpdatedAt = T2;
      },
      "tracker-drift",
    ],
  ] as const)("rejects %s", (_label, mutate, code) => {
    const ledger = structuredClone(makeLedger());
    mutate(ledger);
    if (code !== "digest-mismatch" && code !== "unknown-field")
      ledger.digest = roadmapDigest(ledger);
    expectRoadmapError(() => validateRoadmapLedger(ledger), code);
  });

  it("rejects duplicate operations, plan drift, expiration, and authorization digest drift", () => {
    const { ledger, plan } = makePlan();
    const duplicate = structuredClone(plan);
    duplicate.operations.push(structuredClone(duplicate.operations[0]!));
    duplicate.digest = roadmapDigest(duplicate);
    expectRoadmapError(() => validateRoadmapMutationPlan(duplicate, { ledger }), "duplicate-id");

    const staleTracker = structuredClone(ledger.tracker);
    staleTracker[0]!.updatedAt = T2;
    expectRoadmapError(
      () => validateRoadmapMutationPlan(plan, { ledger, currentTracker: staleTracker }),
      "tracker-drift",
    );
    expectRoadmapError(
      () =>
        validateRoadmapMutationPlan(plan, { ledger, now: new Date("2026-08-04T01:00:00.000Z") }),
      "expired",
    );
    const substitutedLedgerReference = structuredClone(plan);
    substitutedLedgerReference.ledger.repositoryRevision = "8".repeat(40);
    substitutedLedgerReference.digest = roadmapDigest(substitutedLedgerReference);
    expectRoadmapError(
      () => validateRoadmapMutationPlan(substitutedLedgerReference, { ledger }),
      "repository-mismatch",
    );

    const authorization = makeAuthorization(ledger, plan, ["operation:create-issue"]);
    const changed = structuredClone(authorization);
    changed.planDigest = "9".repeat(64);
    changed.digest = roadmapDigest(changed);
    expectRoadmapError(
      () => validateRoadmapMutationAuthorization(changed, plan, ledger),
      "digest-mismatch",
    );
  });

  it("distinguishes additive defaults from breaking migrators", () => {
    expect(
      validateRoadmapSchemaMigrationRule({
        kind: "roadmap-schema-migration",
        fromVersion: 1,
        toVersion: 2,
        compatibility: "additive",
        defaultsDigest: "1".repeat(64),
        rationaleDigest: "2".repeat(64),
      }).compatibility,
    ).toBe("additive");
    expect(
      validateRoadmapSchemaMigrationRule({
        kind: "roadmap-schema-migration",
        fromVersion: 2,
        toVersion: 3,
        compatibility: "breaking",
        migratorId: "migration:roadmap-v2-v3",
        rationaleDigest: "3".repeat(64),
      }).compatibility,
    ).toBe("breaking");
    expectRoadmapError(
      () =>
        validateRoadmapSchemaMigrationRule({
          kind: "roadmap-schema-migration",
          fromVersion: 1,
          toVersion: 2,
          compatibility: "breaking",
          rationaleDigest: "3".repeat(64),
        }),
      "invalid-migration",
    );
  });

  it("keeps ledger and receipt projections content-free and repository-relative", () => {
    const { ledger, plan } = makePlan();
    const authorization = makeAuthorization(ledger, plan, ["operation:create-issue"]);
    const serialized = roadmapCanonicalJson({ ledger, plan, authorization });

    expect(serialized).not.toContain("/Users/");
    expect(serialized).not.toContain("PRIVATE-TOKEN");
    expect(serialized).not.toContain("Authorization:");
    expect(serialized).not.toContain("issue body");
    expect(serialized).toContain("docs/architecture.md");
  });
});

function makeLedger(): RoadmapLedger {
  const first = makeFinding("finding:one", "docs/architecture.md", "filed");
  const second = makeFinding(
    "finding:two",
    "docs/reference/contracts/run-records.md",
    "observed",
    "f".repeat(64),
  );
  return createRoadmapLedger({
    id: "ledger:wave-4",
    repository: { revision: REVISION, contentDigest: CONTENT },
    project: {
      provider: "gitlab",
      host: "gitlab.example.com",
      fullPath: "group/docsfab",
      projectId: 422_255,
    },
    boundary: {
      id: "boundary:health-2026-08-04",
      mode: "documentation-health",
      observedAt: T0,
      queryDigest: "1".repeat(64),
    },
    trackerObservedAt: T1,
    tracker: [{ issueIid: 45, state: "opened", updatedAt: T1, identityDigest: TRACKER }],
    evidence: [
      {
        id: "evidence:run-one",
        kind: "docsfab-run",
        digest: EVIDENCE,
        repositoryRevision: REVISION,
        path: "records/run-one.json",
      },
    ],
    findings: [first, second],
    workstreams: [
      {
        id: "workstream:one",
        findingIds: [first.id],
        dependsOnWorkstreamIds: [],
        collidesWithWorkstreamIds: ["workstream:two"],
        executionOrder: 1,
        state: "ready",
      },
      {
        id: "workstream:two",
        findingIds: [second.id],
        dependsOnWorkstreamIds: [],
        collidesWithWorkstreamIds: ["workstream:one"],
        executionOrder: 1,
        state: "planned",
      },
    ],
    dedup: [
      {
        findingId: first.id,
        decision: "reuse",
        issueIid: 45,
        observedUpdatedAt: T1,
        rationaleCode: "same-material-evidence",
      },
      { findingId: second.id, decision: "create", rationaleCode: "new-material-evidence" },
    ],
    transitions: [
      transition("transition:one", first.id, "observed", "proposed", "2026-08-04T00:00:10.000Z"),
      transition("transition:two", first.id, "proposed", "filed", "2026-08-04T00:00:20.000Z"),
    ],
    sweeps: [
      {
        id: "sweep:one",
        observedAt: T1,
        repositoryRevision: REVISION,
        trackerObservedAt: T1,
        findingFingerprints: [first.fingerprint, second.fingerprint],
        newFindingIds: [],
        disposition: "clean",
      },
    ],
    closeouts: [
      {
        id: "closeout:one",
        targetKey: "saga:43",
        findingIds: [first.id, second.id],
        decision: "keep-open",
        decidedAt: T1,
        reasonCode: "children-remain",
        evidenceIds: ["evidence:run-one"],
        supplementalSweepId: "sweep:one",
      },
    ],
    createdAt: T0,
    updatedAt: T1,
  });
}

function makeCloseableLedger(targetKey: string): RoadmapLedger {
  const base = makeLedger();
  const first = {
    ...base.findings.find((item) => item.id === "finding:one")!,
    lifecycle: "verified" as const,
  };
  const second = {
    ...base.findings.find((item) => item.id === "finding:two")!,
    lifecycle: "duplicate" as const,
  };
  return createRoadmapLedger({
    ...withoutDigest(base),
    findings: [first, second],
    transitions: [
      ...base.transitions,
      transition("transition:three", first.id, "filed", "selected", "2026-08-04T00:01:10.000Z"),
      transition(
        "transition:four",
        first.id,
        "selected",
        "in-progress",
        "2026-08-04T00:01:20.000Z",
      ),
      transition("transition:five", first.id, "in-progress", "fixed", "2026-08-04T00:01:30.000Z"),
      transition("transition:six", first.id, "fixed", "verified", "2026-08-04T00:01:40.000Z"),
      transition(
        "transition:seven",
        second.id,
        "observed",
        "duplicate",
        "2026-08-04T00:01:10.000Z",
      ),
    ],
    sweeps: base.sweeps.map((item) => ({ ...item, observedAt: T2, trackerObservedAt: T2 })),
    closeouts: base.closeouts.map((item) => ({
      ...item,
      targetKey,
      decision: "close" as const,
      decidedAt: T3,
    })),
    updatedAt: T3,
  });
}

function makePlan(ledger = makeLedger()): { ledger: RoadmapLedger; plan: RoadmapMutationPlan } {
  const updateProposal = {
    kind: "update" as const,
    issueIid: 45,
    changedFields: ["description" as const],
    updateDigest: "e".repeat(64),
  };
  const issueProposal = {
    kind: "issue" as const,
    projectId: ledger.project.projectId,
    titleDigest: "2".repeat(64),
    descriptionDigest: "3".repeat(64),
    labelNames: ["status:planned"],
  };
  const plan = createRoadmapMutationPlan(
    {
      id: "plan:wave-4",
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
          key: "operation:update-existing",
          kind: "update",
          targetKey: "issue:45",
          findingIds: [ledger.findings[0]!.id],
          dependsOnOperationKeys: ["operation:create-issue"],
          payloadDigest: roadmapDigest(updateProposal),
          payloadBytes: 120,
          proposal: updateProposal,
          precondition: {
            targetKey: "issue:45",
            observedAt: T1,
            identityDigest: TRACKER,
          },
        },
        {
          key: "operation:create-issue",
          kind: "issue",
          targetKey: "project:422255",
          findingIds: [ledger.findings[1]!.id],
          dependsOnOperationKeys: [],
          payloadDigest: roadmapDigest(issueProposal),
          payloadBytes: 240,
          proposal: issueProposal,
        },
      ],
      generatedAt: T1,
      expiresAt: "2026-08-04T00:30:00.000Z",
    },
    ledger,
  );
  return { ledger, plan };
}

function makeAuthorization(
  ledger: RoadmapLedger,
  plan: RoadmapMutationPlan,
  keys: string[],
): RoadmapMutationAuthorization {
  return createRoadmapMutationAuthorization(
    {
      id: "authorization:one",
      authorizedOperationKeys: keys,
      authority: { kind: "local-user", id: "operator:maintainer" },
      issuedAt: T1,
      expiresAt: "2026-08-04T00:20:00.000Z",
    },
    plan,
    ledger,
  );
}

function makeFinding(
  id: string,
  path: string,
  lifecycle: RoadmapFinding["lifecycle"],
  evidenceDigest = EVIDENCE,
): RoadmapFinding {
  const material = findingMaterial(path, evidenceDigest);
  return {
    id,
    fingerprint: roadmapFindingFingerprint(material),
    ...material,
    source: "documentation-health",
    disposition: "repair",
    lifecycle,
    dependsOnFindingIds: [],
  };
}

function findingMaterial(path: string, evidenceDigest: string): RoadmapFindingMaterial {
  return {
    boundaryId: "boundary:health-2026-08-04",
    category: "missing-contract-documentation",
    severity: "p1",
    affectedPaths: [path],
    evidenceIds: ["evidence:run-one"],
    materialEvidenceDigest: evidenceDigest,
  };
}

function transition(
  id: string,
  findingId: string,
  from: RoadmapLifecycleTransition["from"],
  to: RoadmapLifecycleTransition["to"],
  at: string,
): RoadmapLifecycleTransition {
  return {
    id,
    findingId,
    from,
    to,
    at,
    reasonCode: "evidence-transition",
    evidenceIds: ["evidence:run-one"],
  };
}

function trackerIdentity(
  targetKey: string,
  externalId: string,
  state: string,
  updatedAt: string,
  identityDigest: string,
): RoadmapTrackerIdentity {
  return { targetKey, externalId, state, updatedAt, identityDigest };
}

function withoutDigest(
  ledger: RoadmapLedger,
): Omit<RoadmapLedger, "kind" | "schemaVersion" | "digest"> {
  const {
    kind: _kind,
    schemaVersion: _schemaVersion,
    digest: _digest,
    ...input
  } = structuredClone(ledger);
  return input;
}

function redigest<T extends { digest: string }>(value: T): T {
  value.digest = roadmapDigest(value);
  return value;
}

function expectRoadmapError(action: () => unknown, code: string): void {
  try {
    action();
    throw new Error("Expected RoadmapContractError");
  } catch (error) {
    expect(error).toBeInstanceOf(RoadmapContractError);
    expect((error as RoadmapContractError).code).toBe(code);
  }
}
