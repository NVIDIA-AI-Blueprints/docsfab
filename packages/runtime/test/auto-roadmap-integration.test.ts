// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";

vi.mock("../src/content-ir/indexer.js", () => ({
  buildContentIndexV2: vi.fn(async () => ({
    repository: { revision: "a".repeat(40), contentDigest: "b".repeat(64) },
    schemaVersion: 2,
    indexDigest: "0".repeat(64),
    nodes: [],
    edges: [],
    evidence: {},
  })),
}));

vi.mock("../src/maturity/cascade.js", async () => {
  const actual = await vi.importActual<typeof import("../src/maturity/cascade.js")>(
    "../src/maturity/cascade.js",
  );
  return {
    ...actual,
    validateDocumentationMaturityCascadeSelection: vi.fn(async (value: unknown) => value),
  };
});

import {
  AUTO_ROADMAP_MAX_OPERATION_CAP,
  AutoRoadmapError,
  applyAutoRoadmapExecutionPlanV1,
  createAutoAssessment,
  createAutoCycleRequest,
  createWorkflowDecision,
  createAutoRoadmapExecutionPlanV1,
  planAutoRoadmapCycleV1,
  runAutoRoadmapDryRunV1,
  restoreAutoRoadmapExecutionPlanV1,
} from "./support/autonomy-contracts.js";
import {
  applyIssueLifecyclePlan,
  createIssueLifecycleMaterialBundle,
  createManagedIssueIdentity,
  createManagedIssueStateLookupV1,
  createRoadmapMutationAuthorizationV2,
  extractManagedIssueMarker,
  createRoadmapLedger,
  createRoadmapMutationPlanV2,
  mutationMaterialBytes,
  mutationMaterialDigest,
  observeManagedIssueTrackerV1,
  roadmapDigest,
  roadmapFindingFingerprint,
  recordManagedIssueStateAdvanceV1,
  IssueLifecycleAdapterError,
  type IssueLifecycleMutationContext,
  type IssueLifecycleMutationMaterial,
  type IssueLifecycleProviderAdapter,
  type IssueTrackerIssue,
  type ManagedIssueStateLookupV1,
  type ManagedIssueHostProjectionV1,
  type RoadmapFinding,
  type RoadmapEffectIdentity,
  type RoadmapLedger,
  type RoadmapMutationOperationV2Input,
} from "../src/roadmap/index.js";
import { internalIssueManagedIssueObservationCapability } from "../src/roadmap/managed-issue-observer-authority-internal.js";

const T0 = "2026-08-05T00:00:00.000Z";
const T1 = "2026-08-05T00:05:00.000Z";
const PROJECT = {
  provider: "gitlab",
  host: "gitlab.example.com",
  fullPath: "group/project",
  projectId: 42,
};
const AUTO_FIXTURE = JSON.parse(
  readFileSync(new URL("./fixtures/auto-cycle-v1.json", import.meta.url), "utf8"),
) as {
  request: Parameters<typeof createAutoCycleRequest>[0];
  finding: {
    fingerprint: string;
    findingSha256: string;
    confidence: "confirmed";
    disposition: "observed-absence";
  };
  candidate: Parameters<typeof createAutoAssessment>[0]["candidates"][number];
};

describe("auto roadmap execution preview", () => {
  it("projects maturity through #46 and keeps exact create keys stable", async () => {
    const first = await planAutoRoadmapCycleV1(planningFixture([]));
    const second = await planAutoRoadmapCycleV1(planningFixture([]));

    expect(first).toMatchObject({
      readOnly: true,
      authorization: null,
      planning: { readOnly: true, authorization: null },
      mutationPlan: { operations: [{ kind: "issue", proposal: { intent: "create" } }] },
      execution: { operationCap: 2 },
    });
    expect(second.mutationPlan?.operations.map((operation) => operation.key)).toEqual(
      first.mutationPlan?.operations.map((operation) => operation.key),
    );
    expect(first.materials?.operations[0]).toMatchObject({
      action: "create-issue",
      labels: expect.arrayContaining(["docsfab-roadmap::managed", "gate::g3", "priority::p1"]),
    });
  });

  it("exposes a closed, stable public dry-run seam", async () => {
    const planningInput = planningFixture([]);
    const first = await runAutoRoadmapDryRunV1({ mode: "dry-run", planningInput });
    const second = await runAutoRoadmapDryRunV1({ mode: "dry-run", planningInput });
    expect(first).toMatchObject({ readOnly: true, authorization: null });
    expect(second.digest).toBe(first.digest);
    await expect(
      runAutoRoadmapDryRunV1({
        mode: "dry-run",
        planningInput,
        authorization: {},
      } as never),
    ).rejects.toMatchObject({ code: "invalid-plan" });
  });

  it("returns zero operations for a genuine non-selected maturity outcome", async () => {
    const input = planningFixture([]);
    const selection = input.maturitySelection as unknown as Record<string, unknown>;
    input.maturitySelection = {
      ...selection,
      outcome: { state: "no-action", gateId: null, workUnit: null, missingInputIds: [] },
    } as never;
    const result = await planAutoRoadmapCycleV1(input);
    expect(result).toMatchObject({ mutationPlan: null, materials: null, execution: null });
    expect(result.source.decisionSha256).toBe(input.decision.decisionSha256);
  });

  it("rejects workflow-step and selected-scope cross-binding drift", async () => {
    const input = planningFixture([]);
    const selection = input.maturitySelection as unknown as Record<string, unknown>;
    const outcome = selection.outcome as { workUnit: ReturnType<typeof maturityWorkUnit> };
    const selected = outcome.workUnit;
    input.maturitySelection = {
      ...selection,
      outcome: {
        ...outcome,
        workUnit: { ...selected, workflow: { ...selected.workflow, stepId: "unselected-step" } },
      },
    } as never;
    await expect(planAutoRoadmapCycleV1(input)).rejects.toMatchObject({ code: "binding-mismatch" });
  });

  it("never mutates an unmarked human issue from material overlap alone", async () => {
    const issue = managedHostIssue({
      marker: null,
      materialEvidenceDigests: ["7".repeat(64)],
    });
    const result = await planAutoRoadmapCycleV1(planningFixture([issue]));

    expect(result.mutationPlan).toBeNull();
    expect(result.materials).toBeNull();
    expect(result.execution).toBeNull();
    expect(result.reconciliations).toEqual([
      expect.objectContaining({
        disposition: "non-actionable",
        issueIid: 7,
        operationKeys: [],
        reasonCode: "human-issue-not-explicitly-linked",
      }),
    ]);
  });

  it("follows an observed typed link to a terminal managed issue without creating", async () => {
    const seeded = await seededManagedIssue();
    const human = managedHostIssue({
      iid: 7,
      links: [{ targetIid: 8, relationship: "relates-to", identityDigest: "8".repeat(64) }],
    });
    const terminal = managedHostIssue({
      iid: 8,
      identityDigest: "8".repeat(64),
      marker: seeded.marker,
      labels: [
        "docsfab-roadmap::managed",
        "gate::g3",
        "workflow::content-repair",
        "priority::p1",
        "lifecycle::superseded",
      ],
    });
    const input = planningFixture([]);
    input.managedTrackerObservation = managedObservation(
      [human, terminal],
      createManagedIssueStateLookupV1([seeded.advance]),
    );
    const result = await planAutoRoadmapCycleV1(input);
    expect(result.mutationPlan).toBeNull();
    expect(result.reconciliations).toEqual([
      expect.objectContaining({
        disposition: "superseded",
        issueIid: 8,
        linkedIssueIids: [7],
        operationKeys: [],
      }),
    ]);
    const withoutLink = planningFixture([]);
    withoutLink.managedTrackerObservation = managedObservation(
      [terminal],
      createManagedIssueStateLookupV1([seeded.advance]),
    );
    const directOnly = await planAutoRoadmapCycleV1(withoutLink);
    expect(directOnly.reconciliations[0]).toMatchObject({
      disposition: "superseded",
      issueIid: 8,
      linkedIssueIids: [],
    });
  });

  it("plans an authorization-gated migration comment for prior unmanaged state", async () => {
    const seeded = await seededManagedIssue();
    const input = planningFixture([]);
    input.managedTrackerObservation = managedObservation(
      [
        managedHostIssue({
          iid: 8,
          marker: seeded.marker,
          labels: [
            "docsfab-roadmap::managed",
            "gate::g3",
            "workflow::content-repair",
            "priority::p1",
            "lifecycle::ready",
          ],
        }),
      ],
      createManagedIssueStateLookupV1([seeded.advance]),
    );
    const result = await planAutoRoadmapCycleV1(input);
    expect(result.mutationPlan?.operations).toEqual([
      expect.objectContaining({
        kind: "comment",
        proposal: { kind: "comment", intent: "comment", effectKind: "note" },
      }),
    ]);
    expect(result.reconciliations).toEqual([expect.objectContaining({ disposition: "migration" })]);
  });

  it("defers a whole two-operation label repair when the cycle cap is one", async () => {
    const { marker, advance, operatorDigest, findingId } = await seededManagedIssue();
    const currentLabels = [
      "docsfab-roadmap::managed",
      "gate::g2",
      "workflow::investigation",
      "priority::p2",
      "lifecycle::ready",
      "human::owned",
    ];
    const issue: IssueTrackerIssue = {
      iid: 8,
      titleDigest: "1".repeat(64),
      descriptionDigest: "2".repeat(64),
      state: "opened",
      labels: currentLabels,
      updatedAt: T0,
      identityDigest: "8".repeat(64),
    };
    const migrationInput = planningFixture([]);
    migrationInput.managedTrackerObservation = managedObservation(
      [
        managedHostIssue({
          iid: 8,
          identityDigest: "8".repeat(64),
          marker,
          labels: currentLabels,
        }),
      ],
      createManagedIssueStateLookupV1([advance]),
    );
    const migration = await planAutoRoadmapCycleV1(migrationInput);
    if (!migration.mutationPlan || !migration.materials) throw new Error("missing migration");
    const migrationAuthorization = createRoadmapMutationAuthorizationV2(
      {
        id: "authorization:auto-migration",
        authorizedOperationKeys: migration.mutationPlan.operations.map(
          (operation) => operation.key,
        ),
        authority: { kind: "local-user", id: `local-user:${operatorDigest}` },
        issuedAt: T0,
        expiresAt: T1,
      },
      migration.mutationPlan,
      migration.planning.ledger,
    );
    const migrated = await applyIssueLifecyclePlan({
      ledger: migration.planning.ledger,
      plan: migration.mutationPlan,
      authorization: migrationAuthorization,
      materials: migration.materials,
      adapter: new CreateOnlyAdapter(operatorDigest, [], issue),
      exclusive: { runExclusive: async (_key, action) => action() },
      now: () => new Date(T0),
      persistReceipt: async () => undefined,
    });
    const migrationAdvance = recordManagedIssueStateAdvanceV1({
      ledger: migration.planning.ledger,
      plan: migration.mutationPlan,
      authorization: migrationAuthorization,
      receipt: migrated.receipt,
      operationKey: migration.mutationPlan.operations[0]!.key,
      identity: createManagedIssueIdentity(migration.planning.ledger, findingId),
    });
    const input = planningFixture([]);
    input.managedTrackerObservation = managedObservation(
      [
        managedHostIssue({
          iid: 8,
          identityDigest: "8".repeat(64),
          marker,
          labels: currentLabels,
        }),
      ],
      createManagedIssueStateLookupV1([migrationAdvance]),
    );
    input.operationCap = 1;
    const result = await planAutoRoadmapCycleV1(input);
    expect(result.mutationPlan).toBeNull();
    expect(result.deferredWorkUnitFingerprints).toEqual(["6".repeat(64)]);
    expect(result.reconciliations).toEqual([
      expect.objectContaining({
        disposition: "deferred-by-cap",
        operationKeys: [],
      }),
    ]);
  });

  it("is authorization-free and preserves operation keys for unchanged input", () => {
    const input = fixture(2);
    const first = createAutoRoadmapExecutionPlanV1(input);
    const second = createAutoRoadmapExecutionPlanV1(input);

    expect(first).toMatchObject({ readOnly: true, authorization: null, operationCap: 2 });
    expect(second.operationKeys).toEqual(first.operationKeys);
    expect(second.digest).toBe(first.digest);
  });

  it("caps the complete exact plan and records deferred work", () => {
    const tooSmall = fixture(1);
    expect(() => createAutoRoadmapExecutionPlanV1(tooSmall)).toThrowError(
      expect.objectContaining<Partial<AutoRoadmapError>>({
        code: "operation-cap-exceeded",
      }),
    );

    const capped = createAutoRoadmapExecutionPlanV1({
      ...fixture(2),
      deferredWorkUnitFingerprints: ["f".repeat(64)],
    });
    expect(capped.operationKeys).toHaveLength(2);
    expect(capped.deferredWorkUnitFingerprints).toEqual(["f".repeat(64)]);
    expect(AUTO_ROADMAP_MAX_OPERATION_CAP).toBe(25);
  });

  it("keeps serialized copies inert until exact-input restoration", () => {
    const input = fixture(2);
    const original = createAutoRoadmapExecutionPlanV1(input);
    const restored = restoreAutoRoadmapExecutionPlanV1(JSON.parse(JSON.stringify(original)), input);
    expect(restored).toEqual(original);

    const changed = fixture(2);
    changed.source = { ...changed.source, decisionSha256: "9".repeat(64) };
    expect(() => restoreAutoRoadmapExecutionPlanV1(original, changed)).toThrow(/invalid-plan/u);
  });

  it("applies the exact auto preview and replays its confirmed receipt without duplicate writes", async () => {
    const execution = autoApplyFixture();
    const adapter = new CreateOnlyAdapter(execution.operatorDigest, ["docsfab-roadmap::managed"]);
    const persisted: unknown[] = [];
    const first = await applyAutoRoadmapExecutionPlanV1({
      ...execution,
      adapter,
      exclusive: { runExclusive: async (_key, action) => action() },
      now: () => new Date(T0),
      persistReceipt: async (receipt) => {
        persisted.push(receipt);
      },
    });
    expect(first.receipt.terminal).toBe("complete");
    expect(adapter.mutations).toEqual(execution.plan.operations.map((operation) => operation.key));
    const replay = await applyAutoRoadmapExecutionPlanV1({
      ...execution,
      adapter,
      receipt: first.receipt,
      exclusive: { runExclusive: async (_key, action) => action() },
      now: () => new Date(T0),
      persistReceipt: async (receipt) => {
        persisted.push(receipt);
      },
    });
    expect(replay.receipt.digest).toBe(first.receipt.digest);
    expect(adapter.mutations).toEqual(execution.plan.operations.map((operation) => operation.key));
    expect(persisted.length).toBeGreaterThan(0);
  });

  it("rejects expanded authority and receipt records outside the exact preview", async () => {
    const execution = autoApplyFixture();
    const expandedAuthorization = rehash({
      ...structuredClone(execution.authorization),
      authorizedOperationKeys: [
        ...execution.authorization.authorizedOperationKeys,
        "operation:outside-preview",
      ],
    });
    await expect(
      applyAutoRoadmapExecutionPlanV1({
        ...execution,
        authorization: expandedAuthorization as never,
        adapter: new CreateOnlyAdapter(execution.operatorDigest, ["docsfab-roadmap::managed"]),
        exclusive: { runExclusive: async (_key, action) => action() },
        now: () => new Date(T0),
        persistReceipt: async () => undefined,
      }),
    ).rejects.toBeDefined();

    const adapter = new CreateOnlyAdapter(execution.operatorDigest, ["docsfab-roadmap::managed"]);
    const applied = await applyAutoRoadmapExecutionPlanV1({
      ...execution,
      adapter,
      exclusive: { runExclusive: async (_key, action) => action() },
      now: () => new Date(T0),
      persistReceipt: async () => undefined,
    });
    const firstAttempt = applied.receipt.attempts[0]!;
    const expandedReceipt = rehash({
      ...structuredClone(applied.receipt),
      attempts: [
        ...applied.receipt.attempts,
        {
          ...firstAttempt,
          operationKey: "operation:outside-preview",
          idempotencyKey: "f".repeat(64),
          attempt: 1,
        },
      ],
    });
    await expect(
      applyAutoRoadmapExecutionPlanV1({
        ...execution,
        adapter,
        receipt: expandedReceipt as never,
        exclusive: { runExclusive: async (_key, action) => action() },
        now: () => new Date(T0),
        persistReceipt: async () => undefined,
      }),
    ).rejects.toBeDefined();
  });

  it("resumes an ambiguous auto receipt without duplicating the confirmed effect", async () => {
    const execution = autoApplyFixture();
    const adapter = new CreateOnlyAdapter(execution.operatorDigest, ["docsfab-roadmap::managed"]);
    const firstKey = execution.plan.operations[0]!.key;
    adapter.ambiguousOnce.add(firstKey);
    const partial = await applyAutoRoadmapExecutionPlanV1({
      ...execution,
      adapter,
      exclusive: { runExclusive: async (_key, action) => action() },
      now: () => new Date(T0),
      persistReceipt: async () => undefined,
    });
    expect(partial.receipt.terminal).toBe("ambiguous");
    expect(adapter.mutations).toEqual([firstKey]);
    const resumed = await applyAutoRoadmapExecutionPlanV1({
      ...execution,
      adapter,
      receipt: partial.receipt,
      exclusive: { runExclusive: async (_key, action) => action() },
      now: () => new Date(T0),
      persistReceipt: async () => undefined,
    });
    expect(resumed.receipt.terminal).toBe("complete");
    expect(adapter.mutations).toEqual(execution.plan.operations.map((operation) => operation.key));
  });
});

function planningFixture(issues: ReturnType<typeof managedHostIssue>[]) {
  const projectIdentitySha256 = canonicalProjectDigest();
  const request = createAutoCycleRequest({
    ...structuredClone(AUTO_FIXTURE.request),
    tracker: {
      projectIdentitySha256,
      observationSha256: "8".repeat(64),
      observedAt: T0,
      authority: "observe-only",
    },
    maturityFindingSha256s: ["4".repeat(64)],
  });
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
      candidates: [structuredClone(AUTO_FIXTURE.candidate)],
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
  const repository = {
    identitySha256: request.repository.identitySha256,
    revision: request.repository.revision,
  };
  const finding = maturityFinding(repository);
  const workUnit = maturityWorkUnit(finding);
  const maturityAssessment = {
    repository,
    assessmentSha256: "2".repeat(64),
    gates: [{ findings: [finding], workUnits: [workUnit] }],
  };
  const maturityTrackerObservation = {
    observationSha256: request.tracker.observationSha256,
    projectSha256: projectIdentitySha256,
    observedAt: request.tracker.observedAt,
    expiresAt: T1,
  };
  const managedTrackerObservation = managedObservation(issues);
  return {
    request,
    assessment,
    decision,
    maturityAssessment: maturityAssessment as never,
    maturityTrackerObservation: maturityTrackerObservation as never,
    maturitySelection: {
      repository,
      selectionSha256: "3".repeat(64),
      assessmentSha256: maturityAssessment.assessmentSha256,
      trackerObservationSha256: maturityTrackerObservation.observationSha256,
      outcome: { state: "selected", gateId: "G3", workUnit, missingInputIds: [] },
    } as never,
    policyWorkspace: {} as never,
    repository: { revision: "a".repeat(40), contentDigest: "b".repeat(64) },
    project: PROJECT,
    managedTrackerObservation,
    operationCap: 2,
  };
}

async function seededManagedIssue() {
  const seed = await planAutoRoadmapCycleV1(planningFixture([]));
  const createMaterial = seed.materials?.operations[0];
  if (
    !seed.mutationPlan ||
    !seed.materials ||
    !createMaterial ||
    createMaterial.action !== "create-issue"
  )
    throw new Error("missing seed");
  const operatorDigest = "9".repeat(64);
  const authorization = createRoadmapMutationAuthorizationV2(
    {
      id: "authorization:auto-seed",
      authorizedOperationKeys: seed.mutationPlan.operations.map((operation) => operation.key),
      authority: { kind: "local-user", id: `local-user:${operatorDigest}` },
      issuedAt: T0,
      expiresAt: T1,
    },
    seed.mutationPlan,
    seed.planning.ledger,
  );
  const applied = await applyIssueLifecyclePlan({
    ledger: seed.planning.ledger,
    plan: seed.mutationPlan,
    authorization,
    materials: seed.materials,
    adapter: new CreateOnlyAdapter(operatorDigest, createMaterial.labels),
    exclusive: { runExclusive: async (_key, action) => action() },
    now: () => new Date(T0),
    persistReceipt: async () => undefined,
  });
  const findingId = seed.reconciliations[0]!.findingId;
  const advance = recordManagedIssueStateAdvanceV1({
    ledger: seed.planning.ledger,
    plan: seed.mutationPlan,
    authorization,
    receipt: applied.receipt,
    operationKey: seed.mutationPlan.operations[0]!.key,
    identity: createManagedIssueIdentity(seed.planning.ledger, findingId),
  });
  return {
    marker: extractManagedIssueMarker(createMaterial.description)!,
    advance,
    operatorDigest,
    findingId,
  };
}

function maturityFinding(repository: { identitySha256: string; revision: string }) {
  return {
    schemaVersion: 1,
    kind: "docsfab-documentation-maturity-finding",
    repository,
    id: "finding:maturity-g3",
    findingKey: "article-accuracy",
    gateId: "G3",
    requirement: { id: "article-accuracy", subjectSha256: "6".repeat(64) },
    scopeSha256: "7".repeat(64),
    disposition: "observed-absence",
    issuePriority: "P1",
    severity: "major",
    confidence: "confirmed",
    audienceImpact: [{ audience: "reader", impact: "degraded" }],
    affectedPaths: ["docs/guide.md"],
    dependencyFingerprints: [],
    requiredHumanInput: [],
    requiredWorkflowInputs: [],
    workflow: { name: "update-documentation", stepId: "write-documentation" },
    acceptanceCriteria: [{ id: "accuracy-fixed", evidenceKinds: ["repository-observation"] }],
    verification: [
      {
        id: "verify-accuracy",
        method: "repository-observation",
        acceptanceCriterionIds: ["accuracy-fixed"],
      },
    ],
    evidence: [{ id: "evidence:accuracy", kind: "repository-observation", sha256: "4".repeat(64) }],
    fingerprint: "5".repeat(64),
    findingSha256: "4".repeat(64),
  };
}

function maturityWorkUnit(finding: ReturnType<typeof maturityFinding>) {
  return {
    schemaVersion: 1,
    kind: "docsfab-documentation-maturity-work-unit",
    repository: finding.repository,
    id: "work-unit:maturity-g3",
    dependsOnWorkUnitIds: [],
    execution: { state: "ready", governedInputs: [], missingInputIds: [] },
    findingFingerprint: finding.fingerprint,
    gateId: finding.gateId,
    requirement: finding.requirement,
    scopeSha256: finding.scopeSha256,
    disposition: finding.disposition,
    issuePriority: finding.issuePriority,
    severity: finding.severity,
    confidence: finding.confidence,
    audienceImpact: finding.audienceImpact,
    affectedPaths: finding.affectedPaths,
    dependencyFingerprints: finding.dependencyFingerprints,
    requiredHumanInput: finding.requiredHumanInput,
    requiredWorkflowInputs: finding.requiredWorkflowInputs,
    workflow: finding.workflow,
    acceptanceCriteria: finding.acceptanceCriteria,
    verification: finding.verification,
    trackerMutation: "not-authorized",
    workUnitFingerprint: "6".repeat(64),
    workUnitSha256: "7".repeat(64),
  };
}

function managedObservation(
  issues: ReturnType<typeof managedHostIssue>[],
  stateLookup: ManagedIssueStateLookupV1 = createManagedIssueStateLookupV1([]),
) {
  const normalizedIssues = issues
    .map((issue) => ({
      ...issue,
      labels: [...issue.labels].sort(),
      materialEvidenceDigests: [...issue.materialEvidenceDigests].sort(),
      links: [...issue.links].sort(
        (left, right) =>
          left.targetIid - right.targetIid || left.relationship.localeCompare(right.relationship),
      ),
    }))
    .sort((left, right) => left.iid - right.iid);
  const sourceDigest = roadmapDigest({
    project: PROJECT,
    observedAt: T0,
    issues: normalizedIssues,
  });
  return observeManagedIssueTrackerV1({
    project: PROJECT,
    observedAt: T0,
    issues: normalizedIssues,
    sourceCapability: internalIssueManagedIssueObservationCapability(sourceDigest),
    stateLookup,
  });
}

class CreateOnlyAdapter implements IssueLifecycleProviderAdapter {
  public readonly provider = "gitlab";
  public readonly mutations: string[] = [];
  public readonly ambiguousOnce = new Set<string>();
  private readonly effects = new Map<string, RoadmapEffectIdentity>();
  public constructor(
    private readonly operatorIdentityDigest: string,
    private readonly labels: string[],
    private readonly issue?: IssueTrackerIssue,
  ) {}
  public async preflight(project: RoadmapLedger["project"]) {
    return {
      identity: {
        provider: "gitlab",
        host: project.host,
        username: "maintainer",
        identityDigest: this.operatorIdentityDigest,
      },
      project: { project, accessLevel: 40, defaultBranch: "main" },
    };
  }
  public async searchIssues() {
    return this.issue ? [this.issue] : [];
  }
  public async searchMilestones() {
    return [];
  }
  public async getIssue(_project: RoadmapLedger["project"], iid: number) {
    return this.issue?.iid === iid ? this.issue : undefined;
  }
  public async getMilestone() {
    return undefined;
  }
  public async listLabels() {
    return this.labels;
  }
  public async listLinks() {
    return [];
  }
  public async reconcile(context: IssueLifecycleMutationContext) {
    const effect = this.effects.get(context.operation.key);
    return effect ? { disposition: "found" as const, effect } : { disposition: "absent" as const };
  }
  public async mutate(context: IssueLifecycleMutationContext) {
    context.assertAuthorized();
    this.mutations.push(context.operation.key);
    if (context.material.action === "comment") {
      const effect: RoadmapEffectIdentity = {
        kind: "note" as const,
        targetKey: "note:8:1",
        externalId: "1",
        state: "present" as const,
        updatedAt: T0,
        identityDigest: "7".repeat(64),
        subjectTargetKey: "issue:8",
      };
      this.effects.set(context.operation.key, effect);
      return effect;
    }
    const effect: RoadmapEffectIdentity = {
      kind: "issue" as const,
      targetKey: "issue:8",
      externalId: "8",
      state: "opened" as const,
      updatedAt: T0,
      identityDigest: "8".repeat(64),
      ...(context.operationProofDigest === undefined
        ? {}
        : { operationProofDigest: context.operationProofDigest }),
    };
    this.effects.set(context.operation.key, effect);
    if (this.ambiguousOnce.delete(context.operation.key)) {
      throw new IssueLifecycleAdapterError("ambiguous-effect", true);
    }
    return effect;
  }
}

function managedHostIssue(
  overrides: Partial<ManagedIssueHostProjectionV1> = {},
): ManagedIssueHostProjectionV1 {
  return {
    iid: 7,
    state: "opened" as const,
    updatedAt: T0,
    identityDigest: "7".repeat(64),
    marker: null,
    labels: [],
    materialEvidenceDigests: [],
    links: [],
    ...overrides,
  };
}

function canonicalProjectDigest(): string {
  return roadmapDigest(PROJECT);
}

function fixture(operationCap: number) {
  const ledger = makeLedger();
  const materials: IssueLifecycleMutationMaterial[] = [
    createMaterial("operation:create:one", "One"),
    createMaterial("operation:create:two", "Two"),
  ];
  const operations = materials.map(
    (material, index): RoadmapMutationOperationV2Input => ({
      key: material.operationKey,
      kind: "issue",
      findingIds: [`finding:${index + 1}`],
      dependsOnOperationKeys: [],
      target: { source: "project", targetKey: `project:${PROJECT.projectId}` },
      preconditions: [],
      proposal: { kind: "issue", intent: "create", effectKind: "issue" },
      materialDigest: mutationMaterialDigest(material),
      materialBytes: mutationMaterialBytes(material),
      expectedEffectKind: "issue",
    }),
  );
  const plan = createRoadmapMutationPlanV2(
    {
      id: "plan:auto-roadmap-test",
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
      operations,
      generatedAt: T0,
      expiresAt: T1,
    },
    ledger,
  );
  return {
    source: {
      requestSha256: "1".repeat(64),
      assessmentSha256: "2".repeat(64),
      decisionSha256: "3".repeat(64),
      maturityAssessmentSha256: "6".repeat(64),
      maturitySelectionSha256: "7".repeat(64),
      trackerObservationSha256: "4".repeat(64),
      managedTrackerObservationSha256: "8".repeat(64),
      planningArtifactSha256: "5".repeat(64),
    },
    ledger,
    plan,
    materials: createIssueLifecycleMaterialBundle({
      planDigest: plan.digest,
      operations: materials,
    }),
    operationCap,
    deferredWorkUnitFingerprints: [],
  };
}

function autoApplyFixture() {
  const input = fixture(2);
  const autoPlan = createAutoRoadmapExecutionPlanV1(input);
  const operatorDigest = "a".repeat(64);
  const authorization = createRoadmapMutationAuthorizationV2(
    {
      id: "authorization:auto-apply",
      authorizedOperationKeys: input.plan.operations.map((operation) => operation.key),
      authority: { kind: "local-user", id: `local-user:${operatorDigest}` },
      issuedAt: T0,
      expiresAt: T1,
    },
    input.plan,
    input.ledger,
  );
  return {
    autoPlan,
    ledger: input.ledger,
    plan: input.plan,
    materials: input.materials,
    authorization,
    operatorDigest,
  };
}

function rehash(value: Record<string, unknown>): Record<string, unknown> {
  const body = Object.fromEntries(Object.entries(value).filter(([key]) => key !== "digest"));
  return { ...body, digest: roadmapDigest(body) };
}

function createMaterial(operationKey: string, title: string): IssueLifecycleMutationMaterial {
  return {
    operationKey,
    action: "create-issue",
    title,
    description: `Description ${title}`,
    labels: ["docsfab-roadmap::managed"],
  };
}

function makeLedger(): RoadmapLedger {
  const findings = [finding(1), finding(2)];
  return createRoadmapLedger({
    id: "ledger:auto-roadmap-test",
    repository: { revision: "a".repeat(40), contentDigest: "b".repeat(64) },
    project: PROJECT,
    boundary: {
      id: "boundary:auto-roadmap-test",
      mode: "documentation-health",
      observedAt: T0,
      queryDigest: "c".repeat(64),
    },
    trackerObservedAt: T0,
    tracker: [],
    evidence: findings.map((item, index) => ({
      id: item.evidenceIds[0]!,
      kind: "validation" as const,
      digest: String(index + 1).repeat(64),
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

function finding(index: number): RoadmapFinding {
  const material = {
    boundaryId: "boundary:auto-roadmap-test",
    category: `maturity-g${index}`,
    severity: "p1" as const,
    affectedPaths: [`docs/${index}.md`],
    evidenceIds: [`evidence:${String(index).repeat(64)}`],
    materialEvidenceDigest: String(index).repeat(64),
  };
  return {
    id: `finding:${index}`,
    ...material,
    fingerprint: roadmapFindingFingerprint(material),
    source: "documentation-health",
    disposition: "repair",
    lifecycle: "observed",
    dependsOnFindingIds: [],
  };
}
