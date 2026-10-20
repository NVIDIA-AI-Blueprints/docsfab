// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  applyIssueLifecyclePlan,
  createIssueLifecycleMaterialBundle,
  createManagedIssueIdentity,
  createManagedIssueStateLookupV1,
  createRoadmapLedger,
  createRoadmapMutationAuthorizationV2,
  createRoadmapMutationPlanV2,
  issueEffectIdentity,
  issueIdentityDigest,
  mutationMaterialBytes,
  mutationMaterialDigest,
  preflightIssueLifecyclePlan,
  recordManagedIssueStateAdvanceV1,
  managedIssueStateBindingFromLookup,
  roadmapDigest,
  roadmapFindingFingerprint,
  IssueLifecycleAdapterError,
  FileIssueLifecycleApplyLock,
  type IssueLifecycleMutationContext,
  type IssueLifecycleMutationMaterial,
  type IssueLifecycleProviderAdapter,
  type IssueTrackerIssue,
  type RoadmapLedger,
  type RoadmapMutationOperationV2Input,
  type IssueLifecycleApplyLock,
  type RoadmapEffectIdentity,
  type RoadmapMutationReceiptV2,
} from "../src/roadmap/index.js";
import { runtimeEgressRootSet } from "../src/config/egress-roots.js";
import { egressText } from "../src/security/egress.js";

const T0 = "2026-08-05T00:00:00.000Z";
const T1 = "2026-08-05T00:01:00.000Z";
const T2 = "2026-08-05T00:02:00.000Z";
const T3 = "2026-08-05T00:03:00.000Z";
const T7 = "2026-08-05T00:07:00.000Z";
const T9 = "2026-08-05T00:09:00.000Z";
const EXCLUSIVE: IssueLifecycleApplyLock = { runExclusive: async (_key, action) => action() };

describe("roadmap issue lifecycle", () => {
  it("preflights, applies, records a sanitized receipt, and replays without duplication", async () => {
    const fixture = makeFixture([
      {
        operationKey: "operation:update-45",
        action: "update-title",
        title: "PRIVATE-TOKEN new title",
      },
    ]);
    const adapter = new FakeAdapter(fixture.issues);
    const preflight = await preflightIssueLifecyclePlan({ ...fixture, adapter });
    expect(preflight).toMatchObject({ status: "ready", provider: "gitlab" });
    expect(JSON.stringify(preflight)).not.toContain("PRIVATE-TOKEN");

    const first = await applyIssueLifecyclePlan({ ...fixture, adapter, now: () => new Date(T3) });
    expect(first.receipt.terminal).toBe("complete");
    expect(adapter.mutations).toEqual(["operation:update-45"]);
    expect(JSON.stringify(first)).not.toContain("PRIVATE-TOKEN");

    const replay = await applyIssueLifecyclePlan({
      ...fixture,
      adapter,
      receipt: first.receipt,
      now: () => new Date(T3),
    });
    expect(replay.receipt.digest).toBe(first.receipt.digest);
    expect(adapter.mutations).toEqual(["operation:update-45"]);
  });

  it("issues managed-state authority only from the exact lifecycle result receipt", async () => {
    const fixture = makeFixture([
      {
        operationKey: "operation:create-managed",
        action: "create-issue",
        title: "Managed work",
        description: "Managed work description",
        labels: ["documentation"],
      },
    ]);
    const applied = await applyIssueLifecyclePlan({
      ...fixture,
      adapter: new FakeAdapter(fixture.issues),
      now: () => new Date(T3),
    });
    const context = {
      ledger: fixture.ledger,
      plan: fixture.plan,
      authorization: fixture.authorization,
      receipt: applied.receipt,
      operationKey: "operation:create-managed",
      identity: createManagedIssueIdentity(fixture.ledger, "finding:one"),
    };
    const advance = recordManagedIssueStateAdvanceV1(context);
    expect(advance).toMatchObject({
      issueIid: 100,
      operatorAuthorityId: fixture.authorization.authority.id,
    });
    expect(
      managedIssueStateBindingFromLookup(createManagedIssueStateLookupV1([advance]), 100)
        ?.findingId,
    ).toBe("finding:one");
    expect(() =>
      recordManagedIssueStateAdvanceV1({
        ...context,
        receipt: structuredClone(applied.receipt),
      }),
    ).toThrow(/invalid-evidence/u);
  });

  it("stops on preflight drift before an affected mutation", async () => {
    const fixture = makeFixture([
      { operationKey: "operation:update-45", action: "update-title", title: "new title" },
    ]);
    const adapter = new FakeAdapter(fixture.issues);
    adapter.issues.set(45, changed(adapter.issues.get(45)!, "external drift", T3));
    await expect(
      applyIssueLifecyclePlan({ ...fixture, adapter, now: () => new Date(T3) }),
    ).rejects.toMatchObject({ code: "tracker-drift" });
    expect(adapter.mutations).toEqual([]);
  });

  it("persists a partial failure and resumes from the next safe operation", async () => {
    const fixture = makeFixture([
      { operationKey: "operation:update-45", action: "update-title", title: "first" },
      { operationKey: "operation:update-46", action: "update-title", title: "second" },
    ]);
    const adapter = new FakeAdapter(fixture.issues);
    adapter.failOnce.add("operation:update-46");
    const partial = await applyIssueLifecyclePlan({ ...fixture, adapter, now: () => new Date(T3) });
    expect(partial.receipt).toMatchObject({
      terminal: "ambiguous",
      remainingOperationKeys: ["operation:update-46"],
    });
    expect(partial.nextSafeAction).toBe("reconcile-ambiguous-effect");

    const resumed = await applyIssueLifecyclePlan({
      ...fixture,
      adapter,
      receipt: partial.receipt,
      now: () => new Date(T3),
    });
    expect(resumed.receipt.terminal).toBe("complete");
    expect(adapter.mutations).toEqual([
      "operation:update-45",
      "operation:update-46",
      "operation:update-46",
    ]);
  });

  it("reconciles an applied update after a lost response before testing original-state drift", async () => {
    const fixture = makeFixture([
      { operationKey: "operation:update-45", action: "update-title", title: "desired" },
    ]);
    const adapter = new FakeAdapter(fixture.issues);
    adapter.ambiguousApplyOnce.add("operation:update-45");
    const ambiguous = await applyIssueLifecyclePlan({
      ...fixture,
      adapter,
      now: () => new Date(T3),
    });
    expect(ambiguous.receipt.terminal).toBe("ambiguous");
    expect(adapter.issues.get(45)!.titleDigest).toBe(textDigest("desired"));

    const resumed = await applyIssueLifecyclePlan({
      ...fixture,
      adapter,
      receipt: ambiguous.receipt,
      now: () => new Date(T3),
    });
    expect(resumed.receipt.terminal).toBe("complete");
    expect(adapter.mutations).toEqual(["operation:update-45"]);
  });

  it("reconciles an ambiguous update whose published title had a host root replaced", async () => {
    const title = `Fix ${join(process.cwd(), "docs", "a.md")}`;
    const fixture = makeFixture([
      { operationKey: "operation:update-45", action: "update-title", title },
    ]);
    const adapter = new EgressFakeAdapter(fixture.issues);
    adapter.ambiguousApplyOnce.add("operation:update-45");
    const ambiguous = await applyIssueLifecyclePlan({
      ...fixture,
      adapter,
      now: () => new Date(T3),
    });
    expect(ambiguous.receipt.terminal).toBe("ambiguous");
    expect(adapter.issues.get(45)!.titleDigest).toBe(textDigest("Fix docs/a.md"));

    const resumed = await applyIssueLifecyclePlan({
      ...fixture,
      adapter,
      receipt: ambiguous.receipt,
      now: () => new Date(T3),
    });
    expect(resumed.receipt.terminal).toBe("complete");
    expect(adapter.mutations).toEqual(["operation:update-45"]);
  });

  it("rejects unrelated target drift while reconciling an ambiguous update", async () => {
    const fixture = makeFixture([
      { operationKey: "operation:update-45", action: "update-title", title: "desired" },
    ]);
    const adapter = new FakeAdapter(fixture.issues);
    adapter.ambiguousApplyOnce.add("operation:update-45");
    const ambiguous = await applyIssueLifecyclePlan({
      ...fixture,
      adapter,
      now: () => new Date(T3),
    });
    adapter.issues.set(45, redescribed(adapter.issues.get(45)!, "unrelated description", T3));
    await expect(
      applyIssueLifecyclePlan({
        ...fixture,
        adapter,
        receipt: ambiguous.receipt,
        now: () => new Date(T3),
      }),
    ).rejects.toMatchObject({ code: "tracker-drift" });
    expect(adapter.mutations).toEqual(["operation:update-45"]);
  });

  it("serializes reconcile, create/comment/link mutation, and durable receipt across concurrent applies", async () => {
    const cases: IssueLifecycleMutationMaterial[] = [
      {
        operationKey: "operation:create",
        action: "create-issue",
        title: "Created",
        description: "Body",
        labels: [],
      },
      { operationKey: "operation:comment", action: "comment", body: "Evidence" },
      { operationKey: "operation:link", action: "link-related" },
    ];
    for (const material of cases) {
      const fixture = makeFixture([material]);
      const adapter = new FakeAdapter(fixture.issues);
      const root = await mkdtemp(join(tmpdir(), "docsfab-concurrent-apply-"));
      const exclusive = new FileIssueLifecycleApplyLock({ root });
      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      let entered!: () => void;
      const entry = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const apply = () =>
        applyIssueLifecyclePlan({
          ...fixture,
          exclusive,
          adapter,
          now: () => new Date(T3),
          persistReceipt: async () => {
            entered();
            await held;
          },
        });
      const owner = apply();
      await entry;
      try {
        await expect(apply(), material.action).rejects.toMatchObject({ code: "lock-active" });
      } finally {
        release();
      }
      await expect(owner, material.action).resolves.toBeDefined();
      expect(adapter.mutations, material.action).toEqual([material.operationKey]);
    }
  });

  it("recovers from a crash after mutation using the durable write-ahead receipt", async () => {
    const fixture = makeFixture([
      {
        operationKey: "operation:create",
        action: "create-issue",
        title: "Created",
        description: "Body",
        labels: [],
      },
    ]);
    const adapter = new FakeAdapter(fixture.issues);
    let durable: RoadmapMutationReceiptV2 | undefined;
    await expect(
      applyIssueLifecyclePlan({
        ...fixture,
        adapter,
        now: () => new Date(T3),
        persistReceipt: async (receipt) => {
          if (receipt.terminal === "complete")
            throw new Error("simulated crash before final receipt");
          durable = receipt;
        },
      }),
    ).rejects.toThrow("simulated crash");
    expect(durable?.terminal).toBe("ambiguous");
    expect(adapter.mutations).toEqual(["operation:create"]);

    const recovered = await applyIssueLifecyclePlan({
      ...fixture,
      adapter,
      receipt: durable,
      now: () => new Date(T3),
    });
    expect(recovered.receipt.terminal).toBe("complete");
    expect(adapter.mutations).toEqual(["operation:create"]);
  });

  it("denies missing permission, expired authority, and missing labels without mutation", async () => {
    const labeled = makeFixture([
      { operationKey: "operation:label-45", action: "add-labels", labels: ["missing"] },
    ]);
    const labelsAdapter = new FakeAdapter(labeled.issues);
    await expect(
      preflightIssueLifecyclePlan({ ...labeled, adapter: labelsAdapter }),
    ).rejects.toMatchObject({ code: "missing-label" });

    const fixture = makeFixture([
      { operationKey: "operation:update-45", action: "update-title", title: "new" },
    ]);
    const denied = new FakeAdapter(fixture.issues);
    denied.permission = false;
    await expect(
      preflightIssueLifecyclePlan({ ...fixture, adapter: denied }),
    ).rejects.toMatchObject({ code: "permission-denied" });

    const expired = new FakeAdapter(fixture.issues);
    await expect(
      applyIssueLifecyclePlan({
        ...fixture,
        adapter: expired,
        now: () => new Date("2026-08-05T00:08:00.000Z"),
      }),
    ).rejects.toThrow();
    expect(expired.mutations).toEqual([]);

    const substitutedOperator = new FakeAdapter(fixture.issues);
    substitutedOperator.username = "different-operator";
    await expect(
      applyIssueLifecyclePlan({
        ...fixture,
        adapter: substitutedOperator,
        now: () => new Date(T3),
      }),
    ).rejects.toMatchObject({ code: "authorization-invalid" });
    expect(substitutedOperator.mutations).toEqual([]);
  });

  it("rejects foreign prototypes, extra-field, digest, operation expansion, and unsupported-action attacks", async () => {
    const fixture = makeFixture([
      { operationKey: "operation:update-45", action: "update-title", title: "new" },
    ]);
    const bundle = structuredClone(fixture.materials);
    Object.assign(bundle.operations[0]!, { delete: true });
    expect(() =>
      createIssueLifecycleMaterialBundle({
        planDigest: fixture.plan.digest,
        operations: bundle.operations,
      }),
    ).toThrow();
    const polluted = Object.assign(Object.create({ inherited: true }), fixture.materials);
    await expect(
      preflightIssueLifecyclePlan({
        ...fixture,
        materials: polluted,
        adapter: new FakeAdapter(fixture.issues),
      }),
    ).rejects.toThrow();
  });
});

class FakeAdapter implements IssueLifecycleProviderAdapter {
  public readonly provider = "gitlab";
  public readonly issues: Map<number, IssueTrackerIssue>;
  public readonly mutations: string[] = [];
  public readonly failOnce = new Set<string>();
  public readonly ambiguousApplyOnce = new Set<string>();
  public readonly effects = new Map<string, RoadmapEffectIdentity>();
  public permission = true;
  public username = "maintainer";
  public constructor(issues: Map<number, IssueTrackerIssue>) {
    this.issues = new Map(issues);
  }
  public async preflight(project: RoadmapLedger["project"]) {
    if (!this.permission) throw new IssueLifecycleAdapterError("permission-denied");
    return {
      identity: {
        provider: "gitlab",
        host: project.host,
        username: this.username,
        identityDigest: roadmapDigest({ username: this.username }),
      },
      project: { project, accessLevel: 40, defaultBranch: "main" },
    };
  }
  public async searchIssues() {
    return [...this.issues.values()];
  }
  public async searchMilestones() {
    return [];
  }
  public async getIssue(_project: RoadmapLedger["project"], iid: number) {
    return this.issues.get(iid);
  }
  public async getMilestone() {
    return undefined;
  }
  public async listLabels() {
    return ["documentation"];
  }
  public async listLinks() {
    return [];
  }
  public async reconcile(context: IssueLifecycleMutationContext) {
    const existing = this.effects.get(context.operation.key);
    if (existing) return { disposition: "found" as const, effect: existing };
    const issue = context.targetIssue!;
    if (
      context.material.action === "update-title" &&
      issue.titleDigest === textDigest(context.material.title)
    ) {
      return { disposition: "found" as const, effect: issueEffectIdentity(issue) };
    }
    if (
      context.material.action === "add-labels" &&
      context.material.labels.every((label) => issue.labels.includes(label))
    ) {
      return { disposition: "found" as const, effect: issueEffectIdentity(issue) };
    }
    return { disposition: "absent" as const };
  }
  public async mutate(context: IssueLifecycleMutationContext) {
    context.assertAuthorized();
    this.mutations.push(context.operation.key);
    if (this.failOnce.delete(context.operation.key))
      throw new IssueLifecycleAdapterError("external-failure", true);
    const material = context.material;
    if (material.action === "create-issue" || material.action === "create-saga") {
      const issue = changed(baseIssue(100), material.title, T3);
      this.issues.set(issue.iid, issue);
      const effect = issueEffectIdentity(issue, context.operationProofDigest);
      this.effects.set(context.operation.key, effect);
      return effect;
    }
    const issue = context.targetIssue!;
    if (material.action === "comment") {
      const effect: RoadmapEffectIdentity = {
        kind: "note",
        targetKey: `note:${issue.iid}:900`,
        externalId: "900",
        state: "present",
        updatedAt: T3,
        identityDigest: roadmapDigest({ operation: context.operation.key }),
        subjectTargetKey: `issue:${issue.iid}`,
      };
      this.effects.set(context.operation.key, effect);
      return effect;
    }
    if (material.action.startsWith("link-")) {
      const effect: RoadmapEffectIdentity = {
        kind: "link",
        targetKey: "link:901",
        externalId: "901",
        state: "present",
        updatedAt: T3,
        identityDigest: roadmapDigest({ operation: context.operation.key }),
        subjectTargetKey: `issue:${issue.iid}`,
        relatedTargetKey: `issue:${context.relatedIssue!.iid}`,
      };
      this.effects.set(context.operation.key, effect);
      return effect;
    }
    const updated =
      material.action === "update-title"
        ? changed(issue, material.title, T3)
        : material.action === "add-labels"
          ? relabeled(issue, material.labels, T3)
          : issue;
    this.issues.set(issue.iid, updated);
    if (this.ambiguousApplyOnce.delete(context.operation.key)) {
      throw new IssueLifecycleAdapterError("ambiguous-effect", true);
    }
    return issueEffectIdentity(updated);
  }
}

function makeFixture(materialsInput: IssueLifecycleMutationMaterial[]) {
  const issues = new Map([
    [45, baseIssue(45)],
    [46, baseIssue(46)],
  ]);
  const ledger = makeLedger(issues);
  const operations = materialsInput.map((material) => operationForMaterial(material, issues));
  const plan = createRoadmapMutationPlanV2(
    {
      id: "plan:issues",
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
      generatedAt: T2,
      expiresAt: T9,
    },
    ledger,
  );
  const materials = createIssueLifecycleMaterialBundle({
    planDigest: plan.digest,
    operations: materialsInput,
  });
  const authorization = createRoadmapMutationAuthorizationV2(
    {
      id: "authorization:issues",
      authorizedOperationKeys: operations.map((item) => item.key),
      authority: {
        kind: "local-user",
        id: `local-user:${roadmapDigest({ username: "maintainer" })}`,
      },
      issuedAt: T2,
      expiresAt: T7,
    },
    plan,
    ledger,
  );
  return {
    ledger,
    plan,
    materials,
    authorization,
    issues,
    exclusive: EXCLUSIVE,
    persistReceipt: async () => undefined,
  };
}

function operationForMaterial(
  material: IssueLifecycleMutationMaterial,
  issues: Map<number, IssueTrackerIssue>,
): RoadmapMutationOperationV2Input {
  const iid = material.operationKey.endsWith("46") ? 46 : 45;
  const ledgerTarget = { source: "ledger-observation" as const, targetKey: `issue:${iid}` };
  const ledgerCondition = {
    ...ledgerTarget,
    observedAt: T1,
    identityDigest: issues.get(iid)!.identityDigest,
  };
  const common = {
    key: material.operationKey,
    findingIds: [iid === 46 ? "finding:two" : "finding:one"],
    dependsOnOperationKeys: [],
    materialDigest: mutationMaterialDigest(material),
    materialBytes: mutationMaterialBytes(material),
  };
  if (material.action === "create-issue" || material.action === "create-saga")
    return {
      ...common,
      kind: material.action === "create-saga" ? "saga" : "issue",
      target: { source: "project", targetKey: "project:422255" },
      preconditions: [],
      proposal: {
        kind: material.action === "create-saga" ? "saga" : "issue",
        intent: "create",
        effectKind: "issue",
      },
      expectedEffectKind: "issue",
    };
  if (material.action === "comment")
    return {
      ...common,
      kind: "comment",
      target: ledgerTarget,
      preconditions: [ledgerCondition],
      proposal: { kind: "comment", intent: "comment", effectKind: "note" },
      expectedEffectKind: "note",
    };
  if (material.action.startsWith("link-"))
    return {
      ...common,
      kind: "link",
      target: ledgerTarget,
      relatedTarget: { source: "ledger-observation", targetKey: "issue:46" },
      preconditions: [
        ledgerCondition,
        {
          source: "ledger-observation",
          targetKey: "issue:46",
          observedAt: T1,
          identityDigest: issues.get(46)!.identityDigest,
        },
      ],
      proposal: { kind: "link", intent: "link", effectKind: "link" },
      expectedEffectKind: "link",
    };
  const label = material.action === "add-labels" || material.action === "remove-labels";
  return {
    ...common,
    kind: label ? "label" : "update",
    target: ledgerTarget,
    preconditions: [ledgerCondition],
    proposal: {
      kind: label ? "label" : "update",
      intent: label ? "assign-label" : "update",
      effectKind: "issue",
    },
    expectedEffectKind: "issue",
  };
}

function makeLedger(issues: Map<number, IssueTrackerIssue>): RoadmapLedger {
  const evidenceId = `evidence:${"9".repeat(64)}`;
  const findingMaterial = (path: string, digest: string) => ({
    boundaryId: "boundary:one",
    category: "docs",
    severity: "p1" as const,
    affectedPaths: [path],
    evidenceIds: [evidenceId],
    materialEvidenceDigest: digest,
  });
  const one = findingMaterial("docs/one.md", "e".repeat(64));
  const two = findingMaterial("docs/two.md", "f".repeat(64));
  return createRoadmapLedger({
    id: "ledger:issues",
    repository: { revision: "a".repeat(40), contentDigest: "b".repeat(64) },
    project: {
      provider: "gitlab",
      host: "tracker.example.com",
      fullPath: "group/docsfab",
      projectId: 422255,
    },
    boundary: {
      id: "boundary:one",
      mode: "documentation-health",
      observedAt: T0,
      queryDigest: "0".repeat(64),
    },
    trackerObservedAt: T1,
    tracker: [...issues.values()].map((issue) => ({
      issueIid: issue.iid,
      state: issue.state,
      updatedAt: issue.updatedAt,
      identityDigest: issue.identityDigest,
    })),
    evidence: [
      {
        id: evidenceId,
        kind: "validation",
        digest: "9".repeat(64),
        repositoryRevision: "a".repeat(40),
      },
    ],
    findings: [
      {
        id: "finding:one",
        fingerprint: roadmapFindingFingerprint(one),
        ...one,
        source: "documentation-health",
        disposition: "repair",
        lifecycle: "proposed",
        dependsOnFindingIds: [],
      },
      {
        id: "finding:two",
        fingerprint: roadmapFindingFingerprint(two),
        ...two,
        source: "documentation-health",
        disposition: "repair",
        lifecycle: "proposed",
        dependsOnFindingIds: [],
      },
    ],
    workstreams: [
      {
        id: "workstream:one",
        findingIds: ["finding:one", "finding:two"],
        dependsOnWorkstreamIds: [],
        collidesWithWorkstreamIds: [],
        executionOrder: 1,
        state: "ready",
      },
    ],
    dedup: [
      {
        findingId: "finding:one",
        decision: "reuse",
        issueIid: 45,
        observedUpdatedAt: T1,
        rationaleCode: "same",
      },
      {
        findingId: "finding:two",
        decision: "reuse",
        issueIid: 46,
        observedUpdatedAt: T1,
        rationaleCode: "same",
      },
    ],
    transitions: [
      {
        id: "transition:one",
        findingId: "finding:one",
        from: "observed",
        to: "proposed",
        at: T0,
        reasonCode: "observed",
        evidenceIds: [evidenceId],
      },
      {
        id: "transition:two",
        findingId: "finding:two",
        from: "observed",
        to: "proposed",
        at: T0,
        reasonCode: "observed",
        evidenceIds: [evidenceId],
      },
    ],
    sweeps: [],
    closeouts: [],
    createdAt: T0,
    updatedAt: T1,
  });
}

function baseIssue(iid: number): IssueTrackerIssue {
  const body = {
    iid,
    titleDigest: textDigest(`issue ${iid}`),
    descriptionDigest: textDigest("description"),
    state: "opened" as const,
    labels: ["documentation"],
    updatedAt: T1,
  };
  return { ...body, identityDigest: issueIdentityDigest(body) };
}

/** Publishes titles through egress, as the GitLab adapter does. */
class EgressFakeAdapter extends FakeAdapter {
  public override async reconcile(context: IssueLifecycleMutationContext) {
    return super.reconcile(publishedContext(context));
  }
  public override async mutate(context: IssueLifecycleMutationContext) {
    return super.mutate(publishedContext(context));
  }
}

function publishedContext(context: IssueLifecycleMutationContext): IssueLifecycleMutationContext {
  const { material } = context;
  if (material.action !== "update-title") return context;
  const projected = egressText(material.title, runtimeEgressRootSet());
  if (!projected.ok) throw new Error(`unexpected egress refusal ${projected.code}`);
  return { ...context, material: { ...material, title: projected.text } };
}

function changed(issue: IssueTrackerIssue, title: string, updatedAt: string): IssueTrackerIssue {
  const body = { ...issue, titleDigest: textDigest(title), updatedAt };
  const { identityDigest: _old, ...identity } = body;
  return { ...identity, identityDigest: issueIdentityDigest(identity) };
}

function relabeled(
  issue: IssueTrackerIssue,
  labels: string[],
  updatedAt: string,
): IssueTrackerIssue {
  const body = { ...issue, labels: [...new Set([...issue.labels, ...labels])].sort(), updatedAt };
  const { identityDigest: _old, ...identity } = body;
  return { ...identity, identityDigest: issueIdentityDigest(identity) };
}

function redescribed(
  issue: IssueTrackerIssue,
  description: string,
  updatedAt: string,
): IssueTrackerIssue {
  const body = { ...issue, descriptionDigest: textDigest(description), updatedAt };
  const { identityDigest: _old, ...identity } = body;
  return { ...identity, identityDigest: issueIdentityDigest(identity) };
}

function textDigest(value: string): string {
  return roadmapDigest({ contract: "issue-tracker-text-v1", value });
}
