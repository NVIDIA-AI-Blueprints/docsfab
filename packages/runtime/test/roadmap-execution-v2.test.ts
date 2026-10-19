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
  RoadmapEffectIdentity,
  RoadmapFinding,
  RoadmapFindingMaterial,
  RoadmapLedger,
  RoadmapMutationAuthorizationV2,
  RoadmapMutationOperationV2Input,
  RoadmapMutationPlanV2,
  RoadmapMutationReceiptV2,
  RoadmapOperationKind,
} from "../src/roadmap/index.js";
import {
  assertRoadmapOperationAuthorized,
  assertRoadmapOperationStartableV2,
  createRoadmapLedger,
  createRoadmapMutationAuthorization,
  createRoadmapMutationAuthorizationV2,
  createRoadmapMutationPlan,
  createRoadmapMutationPlanV2,
  createRoadmapMutationReceiptV2,
  requireRoadmapExecutionV2,
  roadmapCanonicalJson,
  roadmapDigest,
  roadmapFindingFingerprint,
  roadmapProjectEffectProofDigestV2,
  RoadmapContractError,
  validateRoadmapLedger,
  validateRoadmapMutationAuthorizationV2,
  validateRoadmapMutationPlan,
  validateRoadmapMutationPlanV2,
  validateRoadmapMutationReceiptV2,
} from "../src/roadmap/index.js";

const REVISION = "a".repeat(40);
const CONTENT = "b".repeat(64);
const TRACKER_45 = "c".repeat(64);
const TRACKER_46 = "d".repeat(64);
const T0 = "2026-08-05T00:00:00.000Z";
const T1 = "2026-08-05T00:01:00.000Z";
const T2 = "2026-08-05T00:02:00.000Z";
const T3 = "2026-08-05T00:03:00.000Z";
const T4 = "2026-08-05T00:04:00.000Z";
const T5 = "2026-08-05T00:05:00.000Z";
const T6 = "2026-08-05T00:06:00.000Z";
const T7 = "2026-08-05T00:07:00.000Z";
const T8 = "2026-08-05T00:08:00.000Z";
const T9 = "2026-08-05T00:09:00.000Z";
const MIGRATION_FIXTURE = JSON.parse(
  readFileSync(
    new URL("./fixtures/runtime-evaluation/roadmap/execution-v1-migration.json", import.meta.url),
    "utf8",
  ),
) as {
  schemaVersion: number;
  cases: Array<{ kind: string; schemaVersion: number; expectedExecutionDisposition: string }>;
};

describe("roadmap execution v2", () => {
  afterEach(() => {
    clearPlantedCredential();
  });

  it("carries a single-label tracker host through the ledger and the v2 plan", () => {
    const ledger = makeLedger({ host: "tracker" });
    const plan = makePlan(ledger, [createIssueOperation()]);
    expect(plan.project.host).toBe("tracker");
    expect(validateRoadmapMutationPlanV2(JSON.parse(roadmapCanonicalJson(plan)), ledger)).toEqual(
      plan,
    );
    const malformed = JSON.parse(roadmapCanonicalJson(plan)) as { project: { host: string } };
    for (const host of ["tracker..example", "Tracker"]) {
      malformed.project.host = host;
      expectRoadmapError(() => validateRoadmapMutationPlanV2(malformed, ledger), "invalid-value");
    }
    expectRoadmapError(() => makeLedger({ host: "tracker..example" }), "invalid-value");
  });

  it("round-trips a project-, repository-, and ledger-scoped deterministic plan", () => {
    const ledger = makeLedger();
    const first = makePlan(ledger, [createIssueOperation()]);
    const second = makePlan(ledger, [createIssueOperation()]);

    expect(validateRoadmapMutationPlanV2(JSON.parse(roadmapCanonicalJson(first)), ledger)).toEqual(
      first,
    );
    expect(second.digest).toBe(first.digest);
    expect(second.operations[0]!.idempotencyKey).toBe(first.operations[0]!.idempotencyKey);

    const otherLedger = makeLedger({ projectId: 422_256 });
    const other = makePlan(otherLedger, [
      {
        ...createIssueOperation(),
        target: { source: "project", targetKey: "project:422256" },
      },
    ]);
    expect(other.operations[0]!.idempotencyKey).not.toBe(first.operations[0]!.idempotencyKey);

    const providerNeutralLedger = makeLedger({ provider: "forgejo" });
    const providerNeutralPlan = makePlan(providerNeutralLedger, [createIssueOperation()]);
    expect(providerNeutralPlan.project.provider).toBe("forgejo");
    expect(validateRoadmapMutationPlanV2(providerNeutralPlan, providerNeutralLedger)).toEqual(
      providerNeutralPlan,
    );
    expectRoadmapError(() => makeLedger({ provider: "forgejo/escaped" }), "invalid-value");
    // A provider that only starts like an issuer token is recorded (#1807);
    // DocsFab's own configured credential refuses.
    expect(
      collectCredentialFindings(() => makeLedger({ provider: "glpat-secret" })).findings,
    ).toEqual([
      {
        code: "credential-like-content",
        location: "roadmap:$.project.provider",
        rule: "credential.gitlab-token",
      },
    ]);
    expectRoadmapError(
      () => makeLedger({ provider: plantConfiguredCredential() }),
      "invalid-value",
    );
  });

  it("keeps v1 readable while every execution entry point requires a v2 replan", () => {
    const ledger = makeLedger();
    const proposal = {
      kind: "issue" as const,
      projectId: ledger.project.projectId,
      titleDigest: "1".repeat(64),
      descriptionDigest: "2".repeat(64),
      labelNames: ["documentation"],
    };
    const plan = createRoadmapMutationPlan(
      {
        id: "plan:legacy",
        ledger: ledgerReference(ledger),
        repository: ledger.repository,
        project: ledger.project,
        trackerObservedAt: ledger.trackerObservedAt,
        operations: [
          {
            key: "operation:legacy",
            kind: "issue",
            targetKey: `project:${ledger.project.projectId}`,
            findingIds: [ledger.findings[0]!.id],
            dependsOnOperationKeys: [],
            payloadDigest: roadmapDigest(proposal),
            payloadBytes: 12,
            proposal,
          },
        ],
        generatedAt: T2,
        expiresAt: T9,
      },
      ledger,
    );
    const authorization = createRoadmapMutationAuthorization(
      {
        id: "authorization:legacy",
        authorizedOperationKeys: ["operation:legacy"],
        authority: { kind: "local-user", id: "operator:maintainer" },
        issuedAt: T2,
        expiresAt: T7,
      },
      plan,
      ledger,
    );

    expect(validateRoadmapMutationPlan(plan, { ledger })).toEqual(plan);
    expectRoadmapError(() => requireRoadmapExecutionV2(plan), "replan-required");
    expectRoadmapError(() => requireRoadmapExecutionV2(authorization), "replan-required");
    expectRoadmapError(
      () =>
        assertRoadmapOperationAuthorized(
          ledger,
          plan,
          authorization,
          "operation:legacy",
          new Date(T3),
          ledger.tracker,
        ),
      "replan-required",
    );
    expect(MIGRATION_FIXTURE.schemaVersion).toBe(1);
    for (const migrationCase of MIGRATION_FIXTURE.cases) {
      expect(migrationCase.expectedExecutionDisposition).toBe("replan-required");
      expectRoadmapError(() => requireRoadmapExecutionV2(migrationCase), "replan-required");
    }
  });

  it("authorizes an exact dependency-closed subset without gaining authority by rehashing", () => {
    const ledger = makeLedger();
    const plan = makePlan(ledger, [createIssueOperation(), updateDependencyOperation()]);
    expectRoadmapError(
      () => authorize(ledger, plan, ["operation:update"]),
      "unresolved-dependency",
    );
    const authorization = authorize(ledger, plan, ["operation:create", "operation:update"]);
    expect(validateRoadmapMutationAuthorizationV2(authorization, plan, ledger)).toEqual(
      authorization,
    );

    const expanded = redigest({
      ...structuredClone(authorization),
      authorizedOperationKeys: [...authorization.authorizedOperationKeys, "operation:unknown"],
    });
    expectRoadmapError(
      () => validateRoadmapMutationAuthorizationV2(expanded, plan, ledger),
      "operation-expansion",
    );

    const substituted = redigest({ ...structuredClone(authorization), planDigest: "f".repeat(64) });
    expectRoadmapError(
      () => validateRoadmapMutationAuthorizationV2(substituted, plan, ledger),
      "digest-mismatch",
    );
    expectRoadmapError(
      () =>
        assertRoadmapOperationStartableV2(
          startOptions(ledger, plan, authorization, "operation:update", T3),
        ),
      "unresolved-dependency",
    );
  });

  it("chains dependency after-identities and resumes exactly after every boundary", () => {
    const ledger = makeLedger();
    const plan = makePlan(ledger, [
      createIssueOperation(),
      updateDependencyOperation(),
      commentDependencyOperation(),
    ]);
    const authorization = authorize(ledger, plan, [
      "operation:create",
      "operation:update",
      "operation:comment",
    ]);

    expect(
      assertRoadmapOperationStartableV2(
        startOptions(ledger, plan, authorization, "operation:create", T3),
      ).key,
    ).toBe("operation:create");

    const created = withProjectProof(plan, "operation:create", issueEffect(47, "opened", T4, "1"));
    const first = receipt(
      ledger,
      plan,
      authorization,
      [
        {
          operationKey: "operation:create",
          attempt: 1,
          idempotencyKey: key(plan, "operation:create"),
          phase: "mutation",
          disposition: "succeeded",
          startedAt: T3,
          completedAt: T4,
          effect: created,
        },
      ],
      T4,
    );
    expect(first.lastConfirmedOperationKey).toBe("operation:create");
    expect(first.remainingOperationKeys).toEqual(["operation:comment", "operation:update"]);

    expect(
      assertRoadmapOperationStartableV2(
        startOptions(ledger, plan, authorization, "operation:update", T4, first, [], [created]),
      ).key,
    ).toBe("operation:update");
    expectRoadmapError(
      () =>
        assertRoadmapOperationStartableV2(
          startOptions(ledger, plan, authorization, "operation:update", T4, first, [], []),
        ),
      "tracker-drift",
    );

    const updated = issueEffect(47, "opened", T5, "2");
    const second = receipt(
      ledger,
      plan,
      authorization,
      [
        ...first.attempts,
        {
          operationKey: "operation:update",
          attempt: 1,
          idempotencyKey: key(plan, "operation:update"),
          phase: "mutation",
          disposition: "succeeded",
          startedAt: T4,
          completedAt: T5,
          before: created,
          effect: updated,
        },
      ],
      T5,
    );
    expect(second.lastConfirmedOperationKey).toBe("operation:update");

    expect(
      assertRoadmapOperationStartableV2(
        startOptions(ledger, plan, authorization, "operation:comment", T5, second, [], [updated]),
      ).key,
    ).toBe("operation:comment");
    const complete = receipt(
      ledger,
      plan,
      authorization,
      [
        ...second.attempts,
        {
          operationKey: "operation:comment",
          attempt: 1,
          idempotencyKey: key(plan, "operation:comment"),
          phase: "mutation",
          disposition: "succeeded",
          startedAt: T5,
          completedAt: T6,
          before: updated,
          effect: noteEffect(47, 900, T6, "3"),
        },
      ],
      T6,
    );
    expect(complete).toMatchObject({
      lastConfirmedOperationKey: "operation:comment",
      remainingOperationKeys: [],
      terminal: "complete",
    });
    expect(
      validateRoadmapMutationReceiptV2(
        JSON.parse(roadmapCanonicalJson(complete)),
        ledger,
        plan,
        authorization,
      ),
    ).toEqual(complete);
  });

  it("accepts verified reuse for every operation kind with typed effect identities", () => {
    const ledger = makeLedger();
    const operations = everyKindOperations();
    const plan = makePlan(ledger, operations);
    const before45 = issueEffect(45, "opened", T1, "c");
    const cases: Array<{
      key: string;
      before?: RoadmapEffectIdentity;
      effect: RoadmapEffectIdentity;
    }> = [
      {
        key: "operation:saga",
        effect: withProjectProof(plan, "operation:saga", issueEffect(100, "opened", T1, "1")),
      },
      {
        key: "operation:issue",
        effect: withProjectProof(plan, "operation:issue", issueEffect(101, "opened", T1, "2")),
      },
      {
        key: "operation:update-existing",
        before: before45,
        effect: issueEffect(45, "opened", T1, "c"),
      },
      { key: "operation:comment-existing", before: before45, effect: noteEffect(45, 901, T1, "3") },
      {
        key: "operation:link-existing",
        before: before45,
        effect: linkEffect(45, 46, 902, T1, "4"),
      },
      {
        key: "operation:milestone",
        effect: withProjectProof(plan, "operation:milestone", milestoneEffect(20, T1, "5")),
      },
      {
        key: "operation:label-existing",
        before: before45,
        effect: issueEffect(45, "opened", T1, "c"),
      },
      {
        key: "operation:closure-existing",
        before: before45,
        effect: issueEffect(45, "closed", T3, "6"),
      },
    ];

    for (const item of cases) {
      const authorization = authorize(ledger, plan, [item.key]);
      const decoded = receipt(
        ledger,
        plan,
        authorization,
        [
          {
            operationKey: item.key,
            attempt: 1,
            idempotencyKey: key(plan, item.key),
            phase: "mutation",
            disposition: "reused",
            startedAt: T3,
            completedAt: T4,
            ...(item.before === undefined ? {} : { before: item.before }),
            effect: item.effect,
          },
        ],
        T4,
      );
      expect(decoded.terminal, item.key).toBe("complete");
      expect(decoded.attempts[0]!.effect?.kind, item.key).toBe(
        plan.operations.find((operationItem) => operationItem.key === item.key)!.expectedEffectKind,
      );
    }

    const closedLedger = makeLedger({ issue45State: "closed" });
    const reopen = operation({
      key: "operation:reopen-existing",
      kind: "closure",
      findingIds: ["finding:one"],
      target: { source: "ledger-observation", targetKey: "issue:45" },
      preconditions: [ledgerPrecondition(45, TRACKER_45)],
      proposal: { kind: "closure", intent: "reopen", effectKind: "issue" },
      expectedEffectKind: "issue",
      material: "9",
    });
    const reopenPlan = makePlan(closedLedger, [reopen]);
    const reopenAuthorization = authorize(closedLedger, reopenPlan, [reopen.key]);
    const reopened = receipt(
      closedLedger,
      reopenPlan,
      reopenAuthorization,
      [
        {
          operationKey: reopen.key,
          attempt: 1,
          idempotencyKey: key(reopenPlan, reopen.key),
          phase: "mutation",
          disposition: "reused",
          startedAt: T3,
          completedAt: T4,
          before: issueEffect(45, "closed", T1, "c"),
          effect: issueEffect(45, "opened", T3, "a"),
        },
      ],
      T4,
    );
    expect(reopened.terminal).toBe("complete");
  });

  it("binds milestone assignment and link relations to both material target identities", () => {
    const ledger = makeLedger();
    const milestone = operation({
      key: "operation:create-milestone",
      kind: "milestone",
      findingIds: ["finding:one"],
      target: { source: "project", targetKey: "project:422255" },
      proposal: { kind: "milestone", intent: "create", effectKind: "milestone" },
      expectedEffectKind: "milestone",
      material: "7",
    });
    const assignment = operation({
      key: "operation:assign-milestone",
      kind: "update",
      findingIds: ["finding:one"],
      dependencies: ["operation:create-milestone"],
      target: { source: "ledger-observation", targetKey: "issue:45" },
      relatedTarget: {
        source: "dependency-result",
        operationKey: "operation:create-milestone",
        effectKind: "milestone",
      },
      preconditions: [
        ledgerPrecondition(45, TRACKER_45),
        {
          source: "dependency-result",
          operationKey: "operation:create-milestone",
          effectKind: "milestone",
        },
      ],
      proposal: { kind: "update", intent: "assign-milestone", effectKind: "issue" },
      expectedEffectKind: "issue",
      material: "8",
    });
    const plan = makePlan(ledger, [milestone, assignment]);
    const authorization = authorize(ledger, plan, [
      "operation:create-milestone",
      "operation:assign-milestone",
    ]);
    const createdMilestone = withProjectProof(
      plan,
      "operation:create-milestone",
      milestoneEffect(22, T4, "7"),
    );
    const first = receipt(
      ledger,
      plan,
      authorization,
      [
        {
          operationKey: "operation:create-milestone",
          attempt: 1,
          idempotencyKey: key(plan, "operation:create-milestone"),
          phase: "mutation",
          disposition: "succeeded",
          startedAt: T3,
          completedAt: T4,
          effect: createdMilestone,
        },
      ],
      T4,
    );

    expect(
      assertRoadmapOperationStartableV2(
        startOptions(
          ledger,
          plan,
          authorization,
          "operation:assign-milestone",
          T4,
          first,
          [ledger.tracker[0]!],
          [createdMilestone],
        ),
      ).proposal.intent,
    ).toBe("assign-milestone");
    expectRoadmapError(
      () =>
        assertRoadmapOperationStartableV2(
          startOptions(
            ledger,
            plan,
            authorization,
            "operation:assign-milestone",
            T4,
            first,
            [ledger.tracker[0]!],
            [{ ...createdMilestone, identityDigest: "8".repeat(64) }],
          ),
        ),
      "tracker-drift",
    );

    const complete = receipt(
      ledger,
      plan,
      authorization,
      [
        ...first.attempts,
        {
          operationKey: "operation:assign-milestone",
          attempt: 1,
          idempotencyKey: key(plan, "operation:assign-milestone"),
          phase: "mutation",
          disposition: "reused",
          startedAt: T4,
          completedAt: T5,
          before: issueEffect(45, "opened", T1, "c"),
          effect: issueEffect(45, "opened", T4, "a"),
        },
      ],
      T5,
    );
    expect(complete).toMatchObject({
      lastConfirmedOperationKey: "operation:assign-milestone",
      remainingOperationKeys: [],
      terminal: "complete",
    });
  });

  it("records in-flight completion and post-expiry reconciliation but forbids blind or new starts", () => {
    const ledger = makeLedger();
    const plan = makePlan(ledger, [createIssueOperation()]);
    const authorization = authorize(ledger, plan, ["operation:create"]);
    const ambiguous = receipt(
      ledger,
      plan,
      authorization,
      [
        {
          operationKey: "operation:create",
          attempt: 1,
          idempotencyKey: key(plan, "operation:create"),
          phase: "mutation",
          disposition: "ambiguous",
          startedAt: T3,
          completedAt: T4,
          failureCode: "response-ambiguous",
        },
      ],
      T4,
    );
    expect(ambiguous.terminal).toBe("ambiguous");
    expectRoadmapError(
      () =>
        assertRoadmapOperationStartableV2(
          startOptions(ledger, plan, authorization, "operation:create", T5, ambiguous),
        ),
      "ambiguous-effect",
    );

    expectRoadmapError(
      () =>
        receipt(
          ledger,
          plan,
          authorization,
          [
            ...ambiguous.attempts,
            {
              operationKey: "operation:create",
              attempt: 2,
              idempotencyKey: key(plan, "operation:create"),
              phase: "mutation",
              disposition: "reused",
              startedAt: T4,
              completedAt: T4,
              effect: withProjectProof(
                plan,
                "operation:create",
                issueEffect(48, "opened", T4, "8"),
              ),
            },
          ],
          T4,
        ),
      "ambiguous-effect",
    );

    expectRoadmapError(
      () =>
        receipt(
          ledger,
          plan,
          authorization,
          [
            ...ambiguous.attempts,
            {
              operationKey: "operation:create",
              attempt: 2,
              idempotencyKey: key(plan, "operation:create"),
              phase: "reconciliation",
              disposition: "reused",
              startedAt: T4,
              completedAt: T4,
              effect: withProjectProof(
                plan,
                "operation:create",
                issueEffect(48, "opened", T4, "8"),
              ),
              reconcilesAttempt: 2,
            },
          ],
          T4,
        ),
      "ambiguous-effect",
    );

    const reconciled = receipt(
      ledger,
      plan,
      authorization,
      [
        ...ambiguous.attempts,
        {
          operationKey: "operation:create",
          attempt: 2,
          idempotencyKey: key(plan, "operation:create"),
          phase: "reconciliation",
          disposition: "reused",
          startedAt: T8,
          completedAt: T8,
          effect: withProjectProof(plan, "operation:create", issueEffect(48, "opened", T4, "8")),
          reconcilesAttempt: 1,
        },
      ],
      T8,
    );
    expect(reconciled.terminal).toBe("complete");

    const inFlight = receipt(
      ledger,
      plan,
      authorization,
      [
        {
          operationKey: "operation:create",
          attempt: 1,
          idempotencyKey: key(plan, "operation:create"),
          phase: "mutation",
          disposition: "succeeded",
          startedAt: T6,
          completedAt: T8,
          effect: withProjectProof(plan, "operation:create", issueEffect(49, "opened", T8, "9")),
        },
      ],
      T8,
    );
    expect(inFlight.terminal).toBe("complete");

    const absent = receipt(
      ledger,
      plan,
      authorization,
      [
        ...ambiguous.attempts,
        {
          operationKey: "operation:create",
          attempt: 2,
          idempotencyKey: key(plan, "operation:create"),
          phase: "reconciliation",
          disposition: "failed",
          startedAt: T8,
          completedAt: T8,
          failureCode: "effect-confirmed-absent",
          reconcilesAttempt: 1,
        },
      ],
      T8,
    );
    expectRoadmapError(
      () =>
        assertRoadmapOperationStartableV2(
          startOptions(ledger, plan, authorization, "operation:create", T8, absent),
        ),
      "expired",
    );
  });

  it("fails closed on expansion, substitution, duplicate observations, and non-inert shapes", () => {
    const ledger = makeLedger();
    const plan = makePlan(ledger, [createIssueOperation(), updateLedgerOperation()]);
    const authorization = authorize(ledger, plan, ["operation:update-existing"]);

    const material = startOptions(ledger, plan, authorization, "operation:update-existing", T3);
    expectRoadmapError(
      () =>
        assertRoadmapOperationStartableV2({
          ...material,
          material: { ...material.material, materialDigest: "f".repeat(64) },
        }),
      "digest-mismatch",
    );
    expectRoadmapError(
      () =>
        assertRoadmapOperationStartableV2({
          ...material,
          currentTracker: ledger.tracker.map((item) =>
            item.issueIid === 45 ? { ...item, identityDigest: "f".repeat(64) } : item,
          ),
        }),
      "tracker-drift",
    );
    expectRoadmapError(
      () =>
        assertRoadmapOperationStartableV2({
          ...material,
          currentTracker: [...ledger.tracker, ledger.tracker[0]!],
        }),
      "duplicate-id",
    );

    const changedKey = redigest({
      ...structuredClone(plan),
      operations: structuredClone(plan.operations).map((item) =>
        item.key === "operation:update-existing"
          ? { ...item, idempotencyKey: "f".repeat(64) }
          : item,
      ),
    });
    expectRoadmapError(() => validateRoadmapMutationPlanV2(changedKey, ledger), "digest-mismatch");

    const unknown = { ...structuredClone(plan), rawIssueBody: "do-not-persist" };
    expectRoadmapError(() => validateRoadmapMutationPlanV2(unknown, ledger), "unknown-field");
    expectRoadmapError(
      () => validateRoadmapMutationPlanV2(new Proxy(plan, {}), ledger),
      "invalid-type",
    );
    const sparse = structuredClone(plan);
    sparse.operations.length += 1;
    expectRoadmapError(() => validateRoadmapMutationPlanV2(sparse, ledger), "invalid-type");

    let accessorHits = 0;
    const accessorOperations = [...plan.operations];
    Object.defineProperty(accessorOperations, "0", {
      configurable: true,
      enumerable: true,
      get: () => {
        accessorHits += 1;
        return plan.operations[0];
      },
    });
    expectRoadmapError(
      () =>
        validateRoadmapMutationPlanV2(
          {
            ...structuredClone(plan),
            operations: accessorOperations,
          },
          ledger,
        ),
      "invalid-type",
    );
    expect(accessorHits).toBe(0);

    let compositionHits = 0;
    const customProtoOperations = [...plan.operations];
    Object.setPrototypeOf(
      customProtoOperations,
      Object.defineProperty({}, "poison", {
        get: () => {
          compositionHits += 1;
          return "executed";
        },
      }),
    );
    expectRoadmapError(
      () =>
        validateRoadmapMutationPlanV2(
          {
            ...structuredClone(plan),
            operations: customProtoOperations,
          },
          ledger,
        ),
      "invalid-type",
    );
    expect(compositionHits).toBe(0);

    let proxyTrapHits = 0;
    const proxiedOperations = new Proxy([...plan.operations], {
      get: (targetValue, property, receiver) => {
        proxyTrapHits += 1;
        return Reflect.get(targetValue, property, receiver);
      },
      getOwnPropertyDescriptor: (targetValue, property) => {
        proxyTrapHits += 1;
        return Reflect.getOwnPropertyDescriptor(targetValue, property);
      },
      getPrototypeOf: (targetValue) => {
        proxyTrapHits += 1;
        return Reflect.getPrototypeOf(targetValue);
      },
      ownKeys: (targetValue) => {
        proxyTrapHits += 1;
        return Reflect.ownKeys(targetValue);
      },
    });
    expectRoadmapError(
      () =>
        validateRoadmapMutationPlanV2(
          {
            ...structuredClone(plan),
            operations: proxiedOperations,
          },
          ledger,
        ),
      "invalid-type",
    );
    expect(proxyTrapHits).toBe(0);

    let nestedAccessorHits = 0;
    const hostileOperation = createIssueOperation();
    Object.defineProperty(hostileOperation.findingIds, "0", {
      configurable: true,
      enumerable: true,
      get: () => {
        nestedAccessorHits += 1;
        return "finding:two";
      },
    });
    expectRoadmapError(() => makePlan(ledger, [hostileOperation]), "invalid-type");
    expect(nestedAccessorHits).toBe(0);

    const duplicatePrecondition = updateLedgerOperation();
    duplicatePrecondition.preconditions.push(
      structuredClone(duplicatePrecondition.preconditions[0]!),
    );
    expectRoadmapError(() => makePlan(ledger, [duplicatePrecondition]), "duplicate-id");
  });

  it("treats skipped as confirmed terminal and never permits an unrecordable post-skip mutation", () => {
    const ledger = makeLedger();
    const plan = makePlan(ledger, [createIssueOperation()]);
    const authorization = authorize(ledger, plan, ["operation:create"]);
    const skipped = receipt(
      ledger,
      plan,
      authorization,
      [
        {
          operationKey: "operation:create",
          attempt: 1,
          idempotencyKey: key(plan, "operation:create"),
          phase: "mutation",
          disposition: "skipped",
          startedAt: T3,
          completedAt: T4,
          failureCode: "operator-skipped",
        },
      ],
      T4,
    );
    expect(skipped).toMatchObject({
      lastConfirmedOperationKey: "operation:create",
      remainingOperationKeys: [],
      terminal: "complete",
    });
    expectRoadmapError(
      () =>
        assertRoadmapOperationStartableV2(
          startOptions(ledger, plan, authorization, "operation:create", T4, skipped),
        ),
      "invalid-value",
    );
  });

  it("reconciles ambiguous issue, note, link, and milestone effects with exact typed identities", () => {
    const ledger = makeLedger();

    const issuePlan = makePlan(ledger, [createIssueOperation()]);
    const issueAuthorization = authorize(ledger, issuePlan, ["operation:create"]);
    const issueAmbiguous = ambiguousAttempt(issuePlan, "operation:create");
    const issueEffectValue = withProjectProof(
      issuePlan,
      "operation:create",
      issueEffect(48, "opened", T4, "8"),
    );
    expect(
      receipt(
        ledger,
        issuePlan,
        issueAuthorization,
        [
          issueAmbiguous,
          {
            ...reconciliationAttempt(issuePlan, "operation:create", issueEffectValue),
          },
        ],
        T4,
      ).terminal,
    ).toBe("complete");
    expectRoadmapError(
      () =>
        receipt(
          ledger,
          issuePlan,
          issueAuthorization,
          [
            issueAmbiguous,
            {
              ...reconciliationAttempt(issuePlan, "operation:create", {
                ...issueEffectValue,
                externalId: "49",
              }),
            },
          ],
          T4,
        ),
      "tracker-drift",
    );
    expectRoadmapError(
      () =>
        receipt(
          ledger,
          issuePlan,
          issueAuthorization,
          [
            issueAmbiguous,
            {
              ...reconciliationAttempt(
                issuePlan,
                "operation:create",
                issueEffect(999, "opened", T4, "8"),
              ),
            },
          ],
          T4,
        ),
      "tracker-drift",
    );
    const otherMaterialPlan = makePlan(ledger, [
      operation({
        key: "operation:create",
        kind: "issue",
        findingIds: ["finding:two"],
        target: { source: "project", targetKey: "project:422255" },
        proposal: { kind: "issue", intent: "create", effectKind: "issue" },
        expectedEffectKind: "issue",
        material: "f",
      }),
    ]);
    expectRoadmapError(
      () =>
        receipt(
          ledger,
          issuePlan,
          issueAuthorization,
          [
            issueAmbiguous,
            {
              ...reconciliationAttempt(
                issuePlan,
                "operation:create",
                withProjectProof(
                  otherMaterialPlan,
                  "operation:create",
                  issueEffect(48, "opened", T4, "8"),
                ),
              ),
            },
          ],
          T4,
        ),
      "tracker-drift",
    );

    const noteOperation = operation({
      key: "operation:comment-existing",
      kind: "comment",
      findingIds: ["finding:one"],
      target: { source: "ledger-observation", targetKey: "issue:45" },
      preconditions: [ledgerPrecondition(45, TRACKER_45)],
      proposal: { kind: "comment", intent: "comment", effectKind: "note" },
      expectedEffectKind: "note",
      material: "3",
    });
    const notePlan = makePlan(ledger, [noteOperation]);
    const noteAuthorization = authorize(ledger, notePlan, [noteOperation.key]);
    const noteBefore = issueEffect(45, "opened", T1, "c");
    const noteAmbiguous = ambiguousAttempt(notePlan, noteOperation.key, noteBefore);
    const noteEffectValue = noteEffect(45, 901, T4, "3");
    expect(
      receipt(
        ledger,
        notePlan,
        noteAuthorization,
        [
          noteAmbiguous,
          {
            ...reconciliationAttempt(notePlan, noteOperation.key, noteEffectValue, noteBefore),
          },
        ],
        T4,
      ).terminal,
    ).toBe("complete");
    for (const badNote of [
      { ...noteEffectValue, externalId: "902" },
      { ...noteEffectValue, subjectTargetKey: "issue:46" },
      { ...noteEffectValue, targetKey: "note:46:901" },
    ]) {
      expectRoadmapError(
        () =>
          receipt(
            ledger,
            notePlan,
            noteAuthorization,
            [
              noteAmbiguous,
              {
                ...reconciliationAttempt(notePlan, noteOperation.key, badNote, noteBefore),
              },
            ],
            T4,
          ),
        "tracker-drift",
      );
    }

    const linkOperation = linkLedgerOperation();
    const linkPlan = makePlan(ledger, [linkOperation]);
    const linkAuthorization = authorize(ledger, linkPlan, [linkOperation.key]);
    const linkAmbiguous = ambiguousAttempt(linkPlan, linkOperation.key, noteBefore);
    const linkEffectValue = linkEffect(45, 46, 902, T4, "4");
    expect(
      receipt(
        ledger,
        linkPlan,
        linkAuthorization,
        [
          linkAmbiguous,
          {
            ...reconciliationAttempt(linkPlan, linkOperation.key, linkEffectValue, noteBefore),
          },
        ],
        T4,
      ).terminal,
    ).toBe("complete");
    for (const badLink of [
      { ...linkEffectValue, externalId: "903" },
      { ...linkEffectValue, subjectTargetKey: "issue:46" },
      { ...linkEffectValue, relatedTargetKey: "issue:45" },
      { ...linkEffectValue, targetKey: "link:903" },
    ]) {
      expectRoadmapError(
        () =>
          receipt(
            ledger,
            linkPlan,
            linkAuthorization,
            [
              linkAmbiguous,
              {
                ...reconciliationAttempt(linkPlan, linkOperation.key, badLink, noteBefore),
              },
            ],
            T4,
          ),
        "tracker-drift",
      );
    }

    const milestoneOperation = everyKindOperations().find(
      (item) => item.key === "operation:milestone",
    )!;
    const milestonePlan = makePlan(ledger, [milestoneOperation]);
    const milestoneAuthorization = authorize(ledger, milestonePlan, [milestoneOperation.key]);
    const milestoneAmbiguous = ambiguousAttempt(milestonePlan, milestoneOperation.key);
    const milestoneEffectValue = withProjectProof(
      milestonePlan,
      milestoneOperation.key,
      milestoneEffect(20, T4, "5"),
    );
    expect(
      receipt(
        ledger,
        milestonePlan,
        milestoneAuthorization,
        [
          milestoneAmbiguous,
          {
            ...reconciliationAttempt(milestonePlan, milestoneOperation.key, milestoneEffectValue),
          },
        ],
        T4,
      ).terminal,
    ).toBe("complete");
    expectRoadmapError(
      () =>
        receipt(
          ledger,
          milestonePlan,
          milestoneAuthorization,
          [
            milestoneAmbiguous,
            {
              ...reconciliationAttempt(milestonePlan, milestoneOperation.key, {
                ...milestoneEffectValue,
                externalId: "21",
              }),
            },
          ],
          T4,
        ),
      "tracker-drift",
    );
    expectRoadmapError(
      () =>
        receipt(
          ledger,
          milestonePlan,
          milestoneAuthorization,
          [
            milestoneAmbiguous,
            {
              ...reconciliationAttempt(
                milestonePlan,
                milestoneOperation.key,
                milestoneEffect(999, T4, "5"),
              ),
            },
          ],
          T4,
        ),
      "tracker-drift",
    );
  });

  it("does not treat authority-proof removal as a material tracker mutation", () => {
    const ledger = makeLedger();
    const ledgerPlan = createRoadmapMutationPlanV2(
      {
        id: "plan:ledger-noop",
        ledger: ledgerReference(ledger),
        repository: ledger.repository,
        project: ledger.project,
        trackerObservedAt: ledger.trackerObservedAt,
        operations: [updateLedgerOperation()],
        generatedAt: T1,
        expiresAt: T9,
      },
      ledger,
    );
    const ledgerAuthorization = createRoadmapMutationAuthorizationV2(
      {
        id: "authorization:ledger-noop",
        authorizedOperationKeys: ["operation:update-existing"],
        authority: { kind: "local-user", id: "operator:maintainer" },
        issuedAt: T1,
        expiresAt: T7,
      },
      ledgerPlan,
      ledger,
    );
    const ledgerBefore = issueEffect(45, "opened", T1, "c");
    const ledgerReceipt = (before: RoadmapEffectIdentity, effect: RoadmapEffectIdentity) =>
      createRoadmapMutationReceiptV2(
        {
          id: "receipt:ledger-noop",
          attempts: [
            {
              operationKey: "operation:update-existing",
              attempt: 1,
              idempotencyKey: key(ledgerPlan, "operation:update-existing"),
              phase: "mutation",
              disposition: "succeeded",
              startedAt: T1,
              completedAt: T2,
              before,
              effect,
            },
          ],
          createdAt: T1,
          updatedAt: T2,
        },
        ledger,
        ledgerPlan,
        ledgerAuthorization,
      );

    expectRoadmapError(
      () => ledgerReceipt(ledgerBefore, issueEffect(45, "opened", T1, "c")),
      "tracker-drift",
    );

    expectRoadmapError(
      () =>
        ledgerReceipt(
          { ...ledgerBefore, operationProofDigest: "f".repeat(64) },
          issueEffect(45, "opened", T1, "a"),
        ),
      "tracker-drift",
    );

    const dependencyPlan = makePlan(ledger, [createIssueOperation(), updateDependencyOperation()]);
    const dependencyAuthorization = authorize(ledger, dependencyPlan, [
      "operation:create",
      "operation:update",
    ]);
    const created = withProjectProof(
      dependencyPlan,
      "operation:create",
      issueEffect(47, "opened", T4, "1"),
    );
    const { operationProofDigest: _proof, ...sameTrackerIdentity } = created;
    const createdAttempt: RoadmapMutationReceiptV2["attempts"][number] = {
      operationKey: "operation:create",
      attempt: 1,
      idempotencyKey: key(dependencyPlan, "operation:create"),
      phase: "mutation",
      disposition: "succeeded",
      startedAt: T3,
      completedAt: T4,
      effect: created,
    };

    expectRoadmapError(
      () =>
        receipt(
          ledger,
          dependencyPlan,
          dependencyAuthorization,
          [
            createdAttempt,
            {
              operationKey: "operation:update",
              attempt: 1,
              idempotencyKey: key(dependencyPlan, "operation:update"),
              phase: "mutation",
              disposition: "succeeded",
              startedAt: T4,
              completedAt: T5,
              before: created,
              effect: sameTrackerIdentity,
            },
          ],
          T5,
        ),
      "tracker-drift",
    );

    const changed = receipt(
      ledger,
      dependencyPlan,
      dependencyAuthorization,
      [
        createdAttempt,
        {
          operationKey: "operation:update",
          attempt: 1,
          idempotencyKey: key(dependencyPlan, "operation:update"),
          phase: "mutation",
          disposition: "succeeded",
          startedAt: T4,
          completedAt: T5,
          before: created,
          effect: issueEffect(47, "opened", T5, "2"),
        },
      ],
      T5,
    );
    expect(changed.terminal).toBe("complete");
  });

  it("rejects receipt before/effect drift and keeps resumable evidence content-free", () => {
    const ledger = makeLedger();
    const plan = makePlan(ledger, [updateLedgerOperation(), linkLedgerOperation()]);
    const updateAuthorization = authorize(ledger, plan, ["operation:update-existing"]);
    const update = receipt(
      ledger,
      plan,
      updateAuthorization,
      [
        {
          operationKey: "operation:update-existing",
          attempt: 1,
          idempotencyKey: key(plan, "operation:update-existing"),
          phase: "mutation",
          disposition: "succeeded",
          startedAt: T3,
          completedAt: T4,
          before: issueEffect(45, "opened", T1, "c"),
          effect: issueEffect(45, "opened", T4, "a"),
        },
      ],
      T4,
    );
    const wrongBefore = redigest({
      ...structuredClone(update),
      attempts: [
        { ...structuredClone(update.attempts[0]!), before: issueEffect(45, "opened", T1, "f") },
      ],
    });
    expectRoadmapError(
      () => validateRoadmapMutationReceiptV2(wrongBefore, ledger, plan, updateAuthorization),
      "tracker-drift",
    );

    const wrongLastConfirmed = redigest({
      ...structuredClone(update),
      lastConfirmedOperationKey: "operation:link-existing",
    });
    expectRoadmapError(
      () => validateRoadmapMutationReceiptV2(wrongLastConfirmed, ledger, plan, updateAuthorization),
      "unresolved-dependency",
    );

    const wrongRemaining = redigest({
      ...structuredClone(update),
      remainingOperationKeys: ["operation:update-existing"],
    });
    expectRoadmapError(
      () => validateRoadmapMutationReceiptV2(wrongRemaining, ledger, plan, updateAuthorization),
      "unresolved-dependency",
    );

    const linkAuthorization = authorize(ledger, plan, ["operation:link-existing"]);
    expectRoadmapError(
      () =>
        receipt(
          ledger,
          plan,
          linkAuthorization,
          [
            {
              operationKey: "operation:link-existing",
              attempt: 1,
              idempotencyKey: key(plan, "operation:link-existing"),
              phase: "mutation",
              disposition: "reused",
              startedAt: T3,
              completedAt: T4,
              before: issueEffect(45, "opened", T1, "c"),
              effect: linkEffect(45, 999, 903, T1, "b"),
            },
          ],
          T4,
        ),
      "tracker-drift",
    );

    const serialized = roadmapCanonicalJson({ plan, receipt: update });
    expect(serialized).not.toContain("issue body");
    expect(serialized).not.toContain("/Users/");
    expect(serialized).not.toContain("PRIVATE-TOKEN");
    expect(serialized).toContain("materialBytes");
    expect(serialized).toContain("remainingOperationKeys");
  });
});

function makeLedger(
  options: {
    projectId?: number;
    issue45State?: "opened" | "closed";
    provider?: string;
    host?: string;
  } = {},
): RoadmapLedger {
  const first = finding("finding:one", "docs/one.md", "e".repeat(64));
  const second = finding("finding:two", "docs/two.md", "f".repeat(64));
  const projectId = options.projectId ?? 422_255;
  return createRoadmapLedger({
    id: "ledger:roadmap-v2",
    repository: { revision: REVISION, contentDigest: CONTENT },
    project: {
      provider: options.provider ?? "gitlab",
      host: options.host ?? "tracker.example.com",
      fullPath: "group/docsfab",
      projectId,
    },
    boundary: {
      id: "boundary:one",
      mode: "documentation-health",
      observedAt: T0,
      queryDigest: "0".repeat(64),
    },
    trackerObservedAt: T1,
    tracker: [
      {
        issueIid: 45,
        state: options.issue45State ?? "opened",
        updatedAt: T1,
        identityDigest: TRACKER_45,
      },
      { issueIid: 46, state: "opened", updatedAt: T1, identityDigest: TRACKER_46 },
    ],
    evidence: [
      {
        id: "evidence:one",
        kind: "validation",
        digest: "9".repeat(64),
        repositoryRevision: REVISION,
      },
    ],
    findings: [first, second],
    workstreams: [
      {
        id: "workstream:one",
        findingIds: [first.id, second.id],
        dependsOnWorkstreamIds: [],
        collidesWithWorkstreamIds: [],
        executionOrder: 1,
        state: "ready",
      },
    ],
    dedup: [
      {
        findingId: first.id,
        decision: "reuse",
        issueIid: 45,
        observedUpdatedAt: T1,
        rationaleCode: "same-evidence",
      },
      { findingId: second.id, decision: "create", rationaleCode: "new-evidence" },
    ],
    transitions: [
      {
        id: "transition:one",
        findingId: first.id,
        from: "observed",
        to: "proposed",
        at: T0,
        reasonCode: "observed",
        evidenceIds: ["evidence:one"],
      },
      {
        id: "transition:two",
        findingId: second.id,
        from: "observed",
        to: "proposed",
        at: T0,
        reasonCode: "observed",
        evidenceIds: ["evidence:one"],
      },
    ],
    sweeps: [],
    closeouts: [],
    createdAt: T0,
    updatedAt: T1,
  });
}

function finding(id: string, path: string, evidenceDigest: string): RoadmapFinding {
  const material: RoadmapFindingMaterial = {
    boundaryId: "boundary:one",
    category: "documentation-gap",
    severity: "p1",
    affectedPaths: [path],
    evidenceIds: ["evidence:one"],
    materialEvidenceDigest: evidenceDigest,
  };
  return {
    id,
    fingerprint: roadmapFindingFingerprint(material),
    ...material,
    source: "documentation-health",
    disposition: "repair",
    lifecycle: "proposed",
    dependsOnFindingIds: [],
  };
}

function ledgerReference(ledger: RoadmapLedger) {
  return {
    kind: "roadmap-ledger" as const,
    schemaVersion: 1 as const,
    digest: ledger.digest,
    repositoryRevision: ledger.repository.revision,
    repositoryContentDigest: ledger.repository.contentDigest,
  };
}

function makePlan(
  ledger: RoadmapLedger,
  operations: RoadmapMutationOperationV2Input[],
): RoadmapMutationPlanV2 {
  return createRoadmapMutationPlanV2(
    {
      id: "plan:roadmap-v2",
      ledger: ledgerReference(ledger),
      repository: ledger.repository,
      project: ledger.project,
      trackerObservedAt: ledger.trackerObservedAt,
      operations,
      generatedAt: T2,
      expiresAt: T9,
    },
    ledger,
  );
}

function createIssueOperation(): RoadmapMutationOperationV2Input {
  return operation({
    key: "operation:create",
    kind: "issue",
    findingIds: ["finding:two"],
    target: { source: "project", targetKey: "project:422255" },
    proposal: { kind: "issue", intent: "create", effectKind: "issue" },
    expectedEffectKind: "issue",
    material: "1",
  });
}

function updateDependencyOperation(): RoadmapMutationOperationV2Input {
  return operation({
    key: "operation:update",
    kind: "update",
    findingIds: ["finding:two"],
    dependencies: ["operation:create"],
    target: { source: "dependency-result", operationKey: "operation:create", effectKind: "issue" },
    preconditions: [
      { source: "dependency-result", operationKey: "operation:create", effectKind: "issue" },
    ],
    proposal: { kind: "update", intent: "update", effectKind: "issue" },
    expectedEffectKind: "issue",
    material: "2",
  });
}

function commentDependencyOperation(): RoadmapMutationOperationV2Input {
  return operation({
    key: "operation:comment",
    kind: "comment",
    findingIds: ["finding:two"],
    dependencies: ["operation:update"],
    target: { source: "dependency-result", operationKey: "operation:update", effectKind: "issue" },
    preconditions: [
      { source: "dependency-result", operationKey: "operation:update", effectKind: "issue" },
    ],
    proposal: { kind: "comment", intent: "comment", effectKind: "note" },
    expectedEffectKind: "note",
    material: "3",
  });
}

function updateLedgerOperation(): RoadmapMutationOperationV2Input {
  return operation({
    key: "operation:update-existing",
    kind: "update",
    findingIds: ["finding:one"],
    target: { source: "ledger-observation", targetKey: "issue:45" },
    preconditions: [ledgerPrecondition(45, TRACKER_45)],
    proposal: { kind: "update", intent: "update", effectKind: "issue" },
    expectedEffectKind: "issue",
    material: "4",
  });
}

function linkLedgerOperation(): RoadmapMutationOperationV2Input {
  return operation({
    key: "operation:link-existing",
    kind: "link",
    findingIds: ["finding:one"],
    target: { source: "ledger-observation", targetKey: "issue:45" },
    relatedTarget: { source: "ledger-observation", targetKey: "issue:46" },
    preconditions: [ledgerPrecondition(45, TRACKER_45), ledgerPrecondition(46, TRACKER_46)],
    proposal: { kind: "link", intent: "link", effectKind: "link" },
    expectedEffectKind: "link",
    material: "5",
  });
}

function everyKindOperations(): RoadmapMutationOperationV2Input[] {
  return [
    operation({
      key: "operation:saga",
      kind: "saga",
      findingIds: ["finding:two"],
      target: { source: "project", targetKey: "project:422255" },
      proposal: { kind: "saga", intent: "create", effectKind: "issue" },
      expectedEffectKind: "issue",
      material: "1",
    }),
    operation({
      ...createIssueOperation(),
      key: "operation:issue",
      kind: "issue",
      findingIds: ["finding:two"],
      target: { source: "project", targetKey: "project:422255" },
      proposal: { kind: "issue", intent: "create", effectKind: "issue" },
      expectedEffectKind: "issue",
      material: "2",
    }),
    updateLedgerOperation(),
    operation({
      key: "operation:comment-existing",
      kind: "comment",
      findingIds: ["finding:one"],
      target: { source: "ledger-observation", targetKey: "issue:45" },
      preconditions: [ledgerPrecondition(45, TRACKER_45)],
      proposal: { kind: "comment", intent: "comment", effectKind: "note" },
      expectedEffectKind: "note",
      material: "3",
    }),
    linkLedgerOperation(),
    operation({
      key: "operation:milestone",
      kind: "milestone",
      findingIds: ["finding:one"],
      target: { source: "project", targetKey: "project:422255" },
      proposal: { kind: "milestone", intent: "create", effectKind: "milestone" },
      expectedEffectKind: "milestone",
      material: "6",
    }),
    operation({
      key: "operation:label-existing",
      kind: "label",
      findingIds: ["finding:one"],
      target: { source: "ledger-observation", targetKey: "issue:45" },
      preconditions: [ledgerPrecondition(45, TRACKER_45)],
      proposal: { kind: "label", intent: "assign-label", effectKind: "issue" },
      expectedEffectKind: "issue",
      material: "7",
    }),
    operation({
      key: "operation:closure-existing",
      kind: "closure",
      findingIds: ["finding:one"],
      target: { source: "ledger-observation", targetKey: "issue:45" },
      preconditions: [ledgerPrecondition(45, TRACKER_45)],
      proposal: { kind: "closure", intent: "close", effectKind: "issue" },
      expectedEffectKind: "issue",
      material: "8",
    }),
  ];
}

function ledgerPrecondition(issueIid: number, identityDigest: string) {
  return {
    source: "ledger-observation" as const,
    targetKey: `issue:${issueIid}`,
    observedAt: T1,
    identityDigest,
  };
}

function operation(input: {
  key: string;
  kind: RoadmapOperationKind;
  findingIds: string[];
  dependencies?: string[];
  target: RoadmapMutationOperationV2Input["target"];
  relatedTarget?: RoadmapMutationOperationV2Input["relatedTarget"];
  preconditions?: RoadmapMutationOperationV2Input["preconditions"];
  proposal: RoadmapMutationOperationV2Input["proposal"];
  expectedEffectKind: RoadmapMutationOperationV2Input["expectedEffectKind"];
  material: string;
}): RoadmapMutationOperationV2Input {
  return {
    key: input.key,
    kind: input.kind,
    findingIds: input.findingIds,
    dependsOnOperationKeys: input.dependencies ?? [],
    target: input.target,
    ...(input.relatedTarget === undefined ? {} : { relatedTarget: input.relatedTarget }),
    preconditions: input.preconditions ?? [],
    proposal: input.proposal,
    materialDigest: input.material.repeat(64),
    materialBytes: 32,
    expectedEffectKind: input.expectedEffectKind,
  };
}

function authorize(
  ledger: RoadmapLedger,
  plan: RoadmapMutationPlanV2,
  keys: string[],
): RoadmapMutationAuthorizationV2 {
  return createRoadmapMutationAuthorizationV2(
    {
      id: "authorization:roadmap-v2",
      authorizedOperationKeys: keys,
      authority: { kind: "local-user", id: "operator:maintainer" },
      issuedAt: T2,
      expiresAt: T7,
    },
    plan,
    ledger,
  );
}

function receipt(
  ledger: RoadmapLedger,
  plan: RoadmapMutationPlanV2,
  authorization: RoadmapMutationAuthorizationV2,
  attempts: RoadmapMutationReceiptV2["attempts"],
  updatedAt: string,
): RoadmapMutationReceiptV2 {
  return createRoadmapMutationReceiptV2(
    {
      id: "receipt:roadmap-v2",
      attempts,
      createdAt: T2,
      updatedAt,
    },
    ledger,
    plan,
    authorization,
  );
}

function ambiguousAttempt(
  plan: RoadmapMutationPlanV2,
  operationKey: string,
  before?: RoadmapEffectIdentity,
): RoadmapMutationReceiptV2["attempts"][number] {
  return {
    operationKey,
    attempt: 1,
    idempotencyKey: key(plan, operationKey),
    phase: "mutation",
    disposition: "ambiguous",
    startedAt: T3,
    completedAt: T4,
    ...(before === undefined ? {} : { before }),
    failureCode: "response-ambiguous",
  };
}

function reconciliationAttempt(
  plan: RoadmapMutationPlanV2,
  operationKey: string,
  effect: RoadmapEffectIdentity,
  before?: RoadmapEffectIdentity,
): RoadmapMutationReceiptV2["attempts"][number] {
  return {
    operationKey,
    attempt: 2,
    idempotencyKey: key(plan, operationKey),
    phase: "reconciliation",
    disposition: "reused",
    startedAt: T4,
    completedAt: T4,
    ...(before === undefined ? {} : { before }),
    effect,
    reconcilesAttempt: 1,
  };
}

function startOptions(
  ledger: RoadmapLedger,
  plan: RoadmapMutationPlanV2,
  authorization: RoadmapMutationAuthorizationV2,
  operationKey: string,
  now: string,
  existingReceipt?: RoadmapMutationReceiptV2,
  currentTracker = ledger.tracker,
  currentDependencyEffects: RoadmapEffectIdentity[] = [],
) {
  const planned = plan.operations.find((item) => item.key === operationKey)!;
  return {
    ledger,
    plan,
    authorization,
    operationKey,
    now: new Date(now),
    currentTracker,
    currentDependencyEffects,
    material: {
      operationKey,
      proposalDigest: planned.proposalDigest,
      materialDigest: planned.materialDigest,
      materialBytes: planned.materialBytes,
    },
    ...(existingReceipt === undefined ? {} : { receipt: existingReceipt }),
  };
}

function key(plan: RoadmapMutationPlanV2, operationKey: string): string {
  return plan.operations.find((item) => item.key === operationKey)!.idempotencyKey;
}

function issueEffect(
  iid: number,
  state: "opened" | "closed",
  updatedAt: string,
  digestCharacter: string,
): RoadmapEffectIdentity {
  return {
    kind: "issue",
    targetKey: `issue:${iid}`,
    externalId: String(iid),
    state,
    updatedAt,
    identityDigest: digestCharacter.repeat(64),
  };
}

function noteEffect(
  issueIid: number,
  noteId: number,
  updatedAt: string,
  digestCharacter: string,
): RoadmapEffectIdentity {
  return {
    kind: "note",
    targetKey: `note:${issueIid}:${noteId}`,
    externalId: String(noteId),
    state: "present",
    updatedAt,
    identityDigest: digestCharacter.repeat(64),
    subjectTargetKey: `issue:${issueIid}`,
  };
}

function linkEffect(
  subjectIid: number,
  relatedIid: number,
  linkId: number,
  updatedAt: string,
  digestCharacter: string,
): RoadmapEffectIdentity {
  return {
    kind: "link",
    targetKey: `link:${linkId}`,
    externalId: String(linkId),
    state: "present",
    updatedAt,
    identityDigest: digestCharacter.repeat(64),
    subjectTargetKey: `issue:${subjectIid}`,
    relatedTargetKey: `issue:${relatedIid}`,
  };
}

function milestoneEffect(
  iid: number,
  updatedAt: string,
  digestCharacter: string,
): RoadmapEffectIdentity {
  return {
    kind: "milestone",
    targetKey: `milestone:${iid}`,
    externalId: String(iid),
    state: "active",
    updatedAt,
    identityDigest: digestCharacter.repeat(64),
  };
}

function withProjectProof(
  plan: RoadmapMutationPlanV2,
  operationKey: string,
  effect: RoadmapEffectIdentity,
): RoadmapEffectIdentity {
  const operation = plan.operations.find((item) => item.key === operationKey)!;
  return { ...effect, operationProofDigest: roadmapProjectEffectProofDigestV2(operation) };
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
