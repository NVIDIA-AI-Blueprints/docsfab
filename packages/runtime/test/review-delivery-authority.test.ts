// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import { createHash, randomBytes } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { canonicalJson, sha256 } from "../src/content-ir/canonical.js";
import { DurableArtifactStore } from "../src/artifacts/store.js";
import { FileRunStore } from "../src/records/file-store.js";
import type { RunRecord } from "../src/records/contracts.js";
import {
  createChangeSource,
  type ChangeSourceSourceV1,
  type ChangeSourceV1,
} from "../src/inputs/change-source.js";
import { gitlabProjectIdentity } from "../src/inputs/change-source/revision.js";
import { digestGitlabMrReviewLocator } from "../src/inputs/gitlab-mr-locator.js";
import {
  createReviewResult,
  createReviewResultV2,
  createReviewTarget,
  createReviewTargetV2,
  migrateReviewTargetToV2,
  type ReviewResultInputV1,
} from "../src/review/index.js";
import {
  createReviewDeliveryGrant,
  createReviewDeliveryPlan,
  type ReviewDeliveryPlanInput,
} from "../src/review-delivery/index.js";
import { createReviewDeliveryManifest } from "../src/review-delivery/receipt.js";
import {
  FileScmDeliveryReceiptStore,
  authorizeLocalUserPublication,
  createScmDeliveryRecord,
  localUserGitIdentitySha256,
  localUserPublicationPlanSha256,
  type LocalUserPublicationPlanV1,
} from "../src/delivery/index.js";
import { canonicalizeJsonEvidence } from "../src/json-evidence.js";
import {
  executeReviewDelivery,
  reviewDeliveryEffectNonce,
  reviewDeliveryOutboundBytesSha256,
  type ReviewDeliveryPreparation,
} from "../src/review-delivery/execute.js";
import {
  admitReviewDeliveryOrigin,
  createReviewDeliveryOriginAdmission,
  createLocalReviewDeliveryOriginAdmission,
} from "../src/review-delivery/custody.js";
import { createReviewDeliveryRecord } from "../src/review-delivery/receipt.js";

const BASE = "a".repeat(40);
const START = "c".repeat(40);
const HEAD = "b".repeat(40);
const HASH = "d".repeat(64);
const AFTER = new TextEncoder().encode("after\n");
const roots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "review-delivery-authority-"));
  roots.push(root);
  return root;
}

async function fileSnapshot(root: string): Promise<Map<string, Buffer>> {
  const entries = new Map<string, Buffer>();
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) entries.set(relative(root, path), await readFile(path));
    }
  };
  await visit(root);
  return entries;
}

function legacyPlan(): LocalUserPublicationPlanV1 {
  const candidate = {
    schemaVersion: 1,
    kind: "docsfab-local-user-gitlab-publication-plan",
    deliveryMode: "local-user",
    authorityBasis: "interactive-once",
    run: { id: "run-store", recordSha256: "d".repeat(64) },
    project: { id: 42, host: "gitlab.example.test", path: "group/docs" },
    remote: { name: "origin", transport: "ssh" },
    identity: {
      git: "configured",
      gitIdentitySha256: localUserGitIdentitySha256("Maintainer", "maintainer@example.test"),
      gitlabUsername: "maintainer",
    },
    baseRevision: "a".repeat(40),
    targetBranch: { name: "main", protected: true },
    proposedSourceBranch: "docsfab-run/run-store",
    patch: { format: "git-diff", sha256: "b".repeat(64), byteLength: 10, changedFileCount: 1 },
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
  } as const;
  return { ...candidate, sha256: localUserPublicationPlanSha256(candidate as never) };
}

function planFixture(
  options: {
    legacy?: boolean;
    canonicalIssues?: boolean;
    presentation?: "summary" | "retained";
  } = {},
) {
  const source = createChangeSource({
    source: {
      kind: "gitlab-merge-request",
      provenance: "forge-reported",
      host: "gitlab.example.com",
      projectPath: "team/docs",
      projectId: 42,
      iid: 7,
      state: "opened",
      mergeMode: null,
      diffRefs: { base: BASE, start: START, head: HEAD },
      mergeCommit: null,
      squashCommit: null,
      fork: true,
    } as ChangeSourceSourceV1,
    revision: {
      schemaVersion: 1,
      kind: "docsfab-pinned-repository-revision",
      repository: gitlabProjectIdentity({ host: "gitlab.example.com", projectId: 42 }),
      base: BASE,
      head: HEAD,
    },
    objectFormat: "sha1",
    rangeSemantics: "two-dot",
    mergeBase: null,
    diffFrom: BASE,
    baseTree: null,
    headTree: null,
    commits: [{ id: HEAD, parents: [BASE], subject: "Change docs" }],
    files: [
      {
        status: "A",
        similarity: null,
        oldPath: null,
        newPath: "docs/guide.md",
        oldMode: null,
        newMode: null,
        oldBlob: null,
        newBlob: null,
        binary: false,
        added: 1,
        removed: 0,
      },
    ],
    labels: [],
    protocol: { provider: "gitlab" },
  });
  const target = createReviewTargetV2(
    {
      sourceBranch: "topic",
      targetBranch: "main",
      baseSha: BASE,
      headSha: HEAD,
      trigger: "api",
      requestIdentitySha256: HASH,
      workflow: "review-documentation",
      deliveryIntent: "comment-existing-mr",
      logicalRequestId: "request:7",
      changeSourceSha256: source.changeSourceSha256,
      scmProvider: "gitlab",
      host: "gitlab.example.com",
      projectId: 42,
      mergeRequestIid: 7,
      sourceFork: true,
    },
    source,
  );
  const resultInput: ReviewResultInputV1 = {
    taskId: "task:7",
    runIdSha256: HASH,
    findings: [
      {
        id: "finding:1",
        severity: "warning",
        code: "docs-gap",
        summary: "Explain the new value.",
        path: "docs/guide.md",
        line: 1,
      },
    ],
    checks: [],
    unresolvedQuestions: [],
    affectedPaths: ["docs/guide.md"],
    patchLocator: { kind: "artifact-digest", digestSha256: HASH },
    locatorSha256: digestGitlabMrReviewLocator({
      host: "gitlab.example.com",
      projectId: 42,
      mergeRequestIid: 7,
    }),
  };
  const projectedInput =
    options.canonicalIssues === true
      ? {
          ...resultInput,
          issues: [
            {
              id: "issue:1",
              producerStepId: "review",
              producerSkill: "technical-review",
              originalId: "TECH-1",
              severity: "warning" as const,
              originalSeverity: "major" as const,
              category: "technical_accuracy",
              finding: "The new value needs an explanation.",
              location: "docs/guide.md:1",
              path: "docs/guide.md",
              line: 1,
              locationFidelity: "exact" as const,
              evidence: { sourceId: "source:1", locator: "docs/guide.md:1" },
              requiredChange: "Explain the new value.",
              limitations: ["retained issue limitation"],
              sourceContextId: null,
              factRefs: [],
            },
          ],
          sourceContexts: [],
        }
      : resultInput;
  if (target.scmProvider !== "gitlab") throw new Error("Expected GitLab fixture.");
  const legacyTarget =
    options.legacy === true
      ? createReviewTarget({
          scmProvider: "gitlab",
          host: target.host,
          projectId: target.projectId,
          mergeRequestIid: target.mergeRequestIid,
          sourceBranch: target.sourceBranch,
          targetBranch: target.targetBranch,
          headSha: target.headSha,
          trigger: target.trigger,
          requestIdentitySha256: target.requestIdentitySha256,
          workflow: target.workflow,
          deliveryIntent: target.deliveryIntent,
          logicalRequestId: target.logicalRequestId,
        })
      : null;
  const result =
    legacyTarget === null
      ? createReviewResultV2(target, source, projectedInput)
      : createReviewResult(legacyTarget, projectedInput);
  const targetValue =
    legacyTarget === null ? target : migrateReviewTargetToV2(legacyTarget, source);
  const input: ReviewDeliveryPlanInput<ChangeSourceV1> = {
    target: targetValue,
    source,
    result,
    snapshot: {
      changeSourceSha256: source.changeSourceSha256,
      files: [
        {
          oldPath: null,
          newPath: "docs/guide.md",
          beforeBytes: null,
          afterBytes: AFTER,
          beforeSha256: null,
          afterSha256: sha256(AFTER),
          state: "complete",
          hunks: [{ lines: [{ kind: "added", text: "after", beforeLine: null, afterLine: 1 }] }],
        },
      ],
    },
    artifact: {
      kind: "retained-review-result",
      id: "artifact:7",
      resultSha256: result.resultSha256,
    },
    actor: { host: target.host, id: "user:42" },
    capabilities: { scmProvider: "gitlab", host: target.host, summary: true, inline: true },
    ...(options.presentation === undefined
      ? {}
      : {
          extensions: {
            presentation: { select: () => options.presentation! },
          },
        }),
  };
  return createReviewDeliveryPlan(input);
}

function grantsFor(plan: ReturnType<typeof planFixture>, admitted: () => boolean) {
  return new Map(
    plan.actions.map((action) => [
      action.id,
      createReviewDeliveryGrant({
        verifyCurrent: (current) => {
          if (!admitted() || current.id !== action.id) throw new Error("fixture grant revoked");
          return { status: "admitted" as const, actionId: action.id, kind: action.kind };
        },
      }),
    ]),
  );
}

async function retainedOrigin(
  root: string,
  plan: ReturnType<typeof planFixture>,
  store = new FileScmDeliveryReceiptStore(root),
) {
  const state = await temporaryRoot();
  const runId = "review-run-1";
  const artifactDigest = plan.result.originalResultSha256;
  const artifactStore = new DurableArtifactStore(join(state, "artifacts"));
  await artifactStore.initialize();
  await artifactStore.putRecord(
    artifactDigest,
    JSON.parse(plan.result.originalResultCanonicalJson),
  );
  const runStore = new FileRunStore(join(state, "runs"));
  await runStore.save({
    schemaVersion: 2,
    id: runId,
    workflow: "review-documentation",
    repository: { sourcePath: "/fixture/repository", requestedRevision: "HEAD", revision: HEAD },
    workspace: { strategy: "tracked-export", disposable: true },
    status: "succeeded",
    createdAt: "2026-10-15T12:00:00.000Z",
    models: [],
    skills: [],
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, turns: 0 },
    tools: { totalCalls: 0, failedCalls: 0, byTool: [] },
    artifacts: [
      {
        role: "output",
        reference: {
          kind: "ia-plan",
          schemaVersion: 1,
          digest: artifactDigest,
          repositoryRevision: HEAD,
          repositoryContentDigest: HASH,
        },
      },
    ],
  } as unknown as RunRecord);
  const admission = createLocalReviewDeliveryOriginAdmission({
    store,
    configuredReceiptRoot: root,
    runStore,
    artifactStore,
    runId,
    artifactDigest,
    artifactId: plan.artifact.id,
    originalResultSha256: plan.result.originalResultSha256,
    loadSnapshot: async () => ({
      changeSourceSha256: plan.source.changeSourceSha256,
      files: [
        {
          oldPath: null,
          newPath: "docs/guide.md",
          beforeBytes: null,
          afterBytes: Uint8Array.from(AFTER),
          beforeSha256: null,
          afterSha256: sha256(AFTER),
          state: "complete",
          hunks: [{ lines: [{ kind: "added", text: "after", beforeLine: null, afterLine: 1 }] }],
        },
      ],
    }),
  });
  return { store, admission, runStore, artifactStore, runId, artifactDigest };
}

function executionPorts(plan: ReturnType<typeof planFixture>, state: { drift: boolean }) {
  const action = plan.actions[0]!;
  const digest = (value: unknown) =>
    createHash("sha256")
      .update(canonicalizeJsonEvidence(value as never))
      .digest("hex");
  const recovery = {
    observeCurrent: vi.fn(async (binding: typeof action.binding) =>
      state.drift
        ? { kind: "drift" as const, reason: "target changed during delayed CAS" }
        : {
            kind: "current" as const,
            target: binding.target,
            sourceSha256: binding.sourceSha256,
            snapshotSha256: binding.snapshotSha256,
            actor: binding.actor,
            headSha: binding.reviewedHeadSha,
            startSha: binding.startSha,
          },
    ),
    observeEffect: vi.fn(async () => ({
      kind: "unavailable" as const,
      effectId: "unused",
      reason: "unexpected read",
    })),
  };
  const effects = {
    prepareNextEffect: vi.fn(
      async ({
        context,
      }: {
        context: Parameters<typeof reviewDeliveryEffectNonce>[0];
      }): Promise<ReviewDeliveryPreparation> => {
        const coveredActionIds = [action.id];
        const stage = "gitlab-discussion" as const;
        const effectId = digest({
          domain: "docsfab-review-effect-v1",
          logicalDeliveryId: context.logicalDeliveryId,
          stage,
          coveredActionIds,
        });
        const body = "review body";
        const request = {
          method: "POST" as const,
          path: "/projects/42/merge_requests/7/discussions",
          bodyBytes: new TextEncoder().encode(JSON.stringify({ body })),
        };
        return {
          kind: "effect" as const,
          effectId,
          coveredActionIds,
          actionPayloads: [
            {
              actionId: action.id,
              bodySha256: digest(body),
              anchorSha256: action.kind === "publish-inline" ? digest(action.anchor) : null,
            },
          ],
          stage,
          request,
          outboundBytesSha256: reviewDeliveryOutboundBytesSha256(request),
          expectedBodySha256: digest(body),
          expectedGitLabPosition: {
            baseSha: BASE,
            startSha: START,
            headSha: HEAD,
            positionType: "text" as const,
            oldPath: "docs/guide.md",
            newPath: "docs/guide.md",
            oldLine: null,
            newLine: 1,
            lineRange: null,
          },
          marker: reviewDeliveryEffectNonce(context, effectId),
          revisionProvenance: {
            kind: "gitlab-diff-position" as const,
            baseSha: BASE,
            startSha: START,
            headSha: HEAD,
          },
        };
      },
    ),
    publishEffect: vi.fn(async () => ({
      kind: "not-dispatched" as const,
      providerReference: null,
      stop: { code: "provider-unavailable" as const, retryAfterAt: null },
    })),
  };
  return { recovery, effects };
}

describe("review-delivery origin authority", () => {
  it("binds inline path, line, side, and snapshot to the retained native source", async () => {
    const plan = planFixture({ canonicalIssues: true });
    const root = await temporaryRoot();
    const origin = await retainedOrigin(root, plan);
    expect(
      await admitReviewDeliveryOrigin(origin.admission, {
        plan,
        manifest: createReviewDeliveryManifest(plan),
        requestedStore: origin.store,
      }),
    ).toMatchObject({ admitted: true });
    for (const field of ["path", "startLine", "side", "snapshotSha256"] as const) {
      const edited = structuredClone(plan);
      if (field === "snapshotSha256") {
        Reflect.set(edited, "snapshotSha256", "e".repeat(64));
        for (const action of edited.actions)
          Reflect.set(action.binding, "snapshotSha256", "e".repeat(64));
      } else {
        const finding = edited.findings[0]!;
        if (finding.disposition.kind !== "inline-candidate") throw new Error("fixture anchor");
        Reflect.set(
          finding.disposition.anchor,
          field,
          field === "path" ? "docs/other.md" : field === "side" ? "before" : 2,
        );
        if (field === "startLine") Reflect.set(finding.disposition.anchor, "endLine", 2);
        if (field === "path") Reflect.set(finding.disposition.anchor, "newPath", "docs/other.md");
        const action = edited.actions.find(
          (candidate) =>
            candidate.kind === "publish-inline" && candidate.findingId === finding.inventoryId,
        );
        if (action?.kind !== "publish-inline") throw new Error("fixture inline action");
        Reflect.set(action.anchor, field, Reflect.get(finding.disposition.anchor, field));
        if (field === "startLine") Reflect.set(action.anchor, "endLine", 2);
        if (field === "path") Reflect.set(action.anchor, "newPath", "docs/other.md");
      }
      for (const action of edited.actions) {
        const { id: _id, ...content } = action;
        Reflect.set(action, "id", sha256(canonicalJson(content)));
      }
      expect(
        await admitReviewDeliveryOrigin(origin.admission, {
          plan: edited,
          manifest: createReviewDeliveryManifest(edited),
          requestedStore: origin.store,
        }),
        field,
      ).toEqual({ admitted: false });
    }
    const unavailable = createLocalReviewDeliveryOriginAdmission({
      store: origin.store,
      configuredReceiptRoot: root,
      runStore: origin.runStore,
      artifactStore: origin.artifactStore,
      runId: origin.runId,
      artifactDigest: origin.artifactDigest,
      artifactId: plan.artifact.id,
      originalResultSha256: plan.result.originalResultSha256,
      loadSnapshot: async () => {
        throw new Error("retained source bytes unavailable");
      },
    });
    expect(
      await admitReviewDeliveryOrigin(unavailable, {
        plan,
        manifest: createReviewDeliveryManifest(plan),
        requestedStore: origin.store,
      }),
    ).toEqual({ admitted: false });
  });

  it("binds the complete provider result projection and duplicate plan content to the retained artifact", async () => {
    const plan = planFixture({ canonicalIssues: true });
    const root = await temporaryRoot();
    const origin = await retainedOrigin(root, plan);
    const manifest = createReviewDeliveryManifest(plan);
    expect(
      await admitReviewDeliveryOrigin(origin.admission, {
        plan,
        manifest,
        requestedStore: origin.store,
      }),
    ).toMatchObject({ admitted: true });
    const variants = [
      (edited: typeof plan) =>
        Reflect.set(edited.result.findings[0]!, "recommendation", "Unretained recommendation"),
      (edited: typeof plan) => Reflect.set(edited.result, "originalResultCanonicalJson", "{}"),
      (edited: typeof plan) => Reflect.set(edited.findings[0]!, "text", "Unretained finding"),
      (edited: typeof plan) =>
        Reflect.set(edited, "unresolvedQuestions", [
          { id: "question:tampered", summary: "Unretained question" },
        ]),
      (edited: typeof plan) => Reflect.set(edited, "affectedPaths", ["unreviewed/path.md"]),
      (edited: typeof plan) => Reflect.set(edited.findings[0]!, "evidence", null),
      (edited: typeof plan) => Reflect.set(edited, "checks", [{ id: "check:tampered" }]),
    ];
    for (const mutate of variants) {
      const edited = structuredClone(plan);
      mutate(edited);
      expect(createReviewDeliveryManifest(edited).manifestSha256).toBe(manifest.manifestSha256);
      expect(
        await admitReviewDeliveryOrigin(origin.admission, {
          plan: edited,
          manifest,
          requestedStore: origin.store,
        }),
      ).toEqual({ admitted: false });
    }
  });

  it("admits legitimate presentation downgrades and a canonical legacy migration, but refuses same-head target substitutions", async () => {
    for (const presentation of ["summary", "retained"] as const) {
      const plan = planFixture({ presentation });
      const root = await temporaryRoot();
      const origin = await retainedOrigin(root, plan);
      expect(
        await admitReviewDeliveryOrigin(origin.admission, {
          plan,
          manifest: createReviewDeliveryManifest(plan),
          requestedStore: origin.store,
        }),
      ).toMatchObject({ admitted: true });
    }
    const plan = planFixture({ legacy: true });
    const root = await temporaryRoot();
    const origin = await retainedOrigin(root, plan);
    const manifest = createReviewDeliveryManifest(plan);
    expect(
      await admitReviewDeliveryOrigin(origin.admission, {
        plan,
        manifest,
        requestedStore: origin.store,
      }),
    ).toMatchObject({ admitted: true });
    for (const replacement of [
      { sourceBranch: "different-branch" },
      { requestIdentitySha256: "e".repeat(64) },
      { logicalRequestId: "different-request" },
    ]) {
      if (plan.target.scmProvider !== "gitlab") throw new Error("Expected GitLab fixture.");
      const substitutedTarget = createReviewTargetV2(
        {
          scmProvider: "gitlab",
          host: plan.target.host,
          projectId: plan.target.projectId,
          mergeRequestIid: plan.target.mergeRequestIid,
          sourceFork: plan.target.sourceFork,
          sourceBranch: plan.target.sourceBranch,
          targetBranch: plan.target.targetBranch,
          baseSha: plan.target.baseSha,
          headSha: plan.target.headSha,
          trigger: plan.target.trigger,
          requestIdentitySha256: plan.target.requestIdentitySha256,
          workflow: plan.target.workflow,
          deliveryIntent: plan.target.deliveryIntent,
          logicalRequestId: plan.target.logicalRequestId,
          changeSourceSha256: plan.target.changeSourceSha256,
          ...replacement,
        },
        plan.source,
      );
      const edited = structuredClone(plan);
      Reflect.set(edited, "target", substitutedTarget);
      expect(
        await admitReviewDeliveryOrigin(origin.admission, {
          plan: edited,
          manifest,
          requestedStore: origin.store,
        }),
      ).toEqual({ admitted: false });
    }
  });

  it("admits only the closed planner locator fallback shape without an inline action", async () => {
    for (const summarySupported of [true, false]) {
      const base = planFixture({
        canonicalIssues: true,
        presentation: summarySupported ? "summary" : undefined,
      });
      const plan = structuredClone(base);
      const finding = plan.findings[0]!;
      Reflect.set(finding, "limitations", [
        ...finding.limitations,
        "review-locator:binding-mismatch",
      ]);
      Reflect.set(
        finding,
        "disposition",
        summarySupported
          ? { kind: "summary-candidate", reason: "inline-unavailable" }
          : { kind: "unsupported", reason: "provider-unsupported" },
      );
      if (!summarySupported) {
        Reflect.set(plan, "capabilities", { ...plan.capabilities, summary: false });
        Reflect.set(
          plan,
          "actions",
          plan.actions.filter(
            (action) =>
              action.kind !== "publish-inline" || action.findingId !== finding.inventoryId,
          ),
        );
      }
      const root = await temporaryRoot();
      const origin = await retainedOrigin(root, plan);
      const manifest = createReviewDeliveryManifest(plan);
      expect(
        await admitReviewDeliveryOrigin(origin.admission, {
          plan,
          manifest,
          requestedStore: origin.store,
        }),
      ).toMatchObject({ admitted: true });
      const variants = [
        (edited: typeof plan) =>
          Reflect.set(edited.findings[0]!, "limitations", [
            ...finding.limitations.slice(0, -1),
            "review-locator:unrecognized",
          ]),
        (edited: typeof plan) =>
          Reflect.set(edited.findings[0]!, "limitations", [
            ...finding.limitations,
            "review-locator:binding-mismatch",
          ]),
        (edited: typeof plan) =>
          Reflect.set(edited.findings[0]!, "limitations", [
            "review-locator:binding-mismatch",
            ...finding.limitations.slice(0, -1),
          ]),
        (edited: typeof plan) =>
          Reflect.set(edited.findings[0]!, "disposition", {
            kind: "inline-candidate",
            anchor:
              base.findings[0]!.disposition.kind === "inline-candidate"
                ? base.findings[0]!.disposition.anchor
                : { kind: "unsupported-anchor" },
          }),
      ];
      for (const mutate of variants) {
        const edited = structuredClone(plan);
        mutate(edited);
        expect(
          await admitReviewDeliveryOrigin(origin.admission, {
            plan: edited,
            manifest,
            requestedStore: origin.store,
          }),
        ).toEqual({ admitted: false });
      }
    }
  });

  it("refuses an action binding or action ID rewritten under a freshly calculated manifest", async () => {
    const plan = planFixture({ canonicalIssues: true, presentation: "summary" });
    const root = await temporaryRoot();
    const origin = await retainedOrigin(root, plan);
    for (const mutate of [
      (edited: typeof plan) => Reflect.set(edited.actions[0]!.binding, "startSha", HEAD),
      (edited: typeof plan) => Reflect.set(edited.actions[0]!, "id", "e".repeat(64)),
    ]) {
      const edited = structuredClone(plan);
      mutate(edited);
      expect(
        await admitReviewDeliveryOrigin(origin.admission, {
          plan: edited,
          manifest: createReviewDeliveryManifest(edited),
          requestedStore: origin.store,
        }),
      ).toEqual({ admitted: false });
    }
  });

  it("revalidates the configured origin on each execute, including an empty claim and resume", async () => {
    const plan = planFixture();
    const root = await temporaryRoot();
    const origin = await retainedOrigin(root, plan);
    const runRead = vi.spyOn(origin.runStore, "getWithDigest");
    const artifactRead = vi.spyOn(origin.artifactStore, "getRecord");
    const ports = executionPorts(plan, { drift: false });
    ports.effects.prepareNextEffect.mockResolvedValue({ kind: "complete" });
    const invoke = () =>
      executeReviewDelivery({
        plan,
        store: origin.store,
        originAdmission: origin.admission,
        grantsByActionId: grantsFor(plan, () => true),
        effects: ports.effects,
        recovery: ports.recovery,
      });
    const first = await invoke();
    const runReadsAfterFirst = runRead.mock.calls.length;
    const artifactReadsAfterFirst = artifactRead.mock.calls.length;
    const second = await invoke();
    expect(first.kind).toBe("stopped");
    expect(second.kind).toBe("stopped");
    expect(runRead.mock.calls.length).toBeGreaterThan(runReadsAfterFirst);
    expect(artifactRead.mock.calls.length).toBeGreaterThan(artifactReadsAfterFirst);
    expect(ports.effects.publishEffect).not.toHaveBeenCalled();
  });

  it("refuses an empty competing root for the same retained plan", async () => {
    const plan = planFixture();
    const originRoot = await temporaryRoot();
    const competingRoot = await temporaryRoot();
    const origin = await retainedOrigin(originRoot, plan);
    const competing = new FileScmDeliveryReceiptStore(competingRoot);
    const ports = executionPorts(plan, { drift: false });
    const result = await executeReviewDelivery({
      plan,
      store: competing,
      originAdmission: origin.admission,
      grantsByActionId: grantsFor(plan, () => true),
      effects: ports.effects,
      recovery: ports.recovery,
    });
    expect(result).toEqual({ kind: "stopped", reason: "custody", record: null });
    expect(
      await competing.loadReview?.(createReviewDeliveryManifest(plan).idempotencyKey),
    ).toBeUndefined();
    expect(ports.effects.prepareNextEffect).not.toHaveBeenCalled();
  });

  it("keeps legacy patch receipt and plan bytes unchanged when the review dialect claims the same root", async () => {
    const root = await temporaryRoot();
    const store = new FileScmDeliveryReceiptStore(root);
    const plan = legacyPlan();
    const authorization = authorizeLocalUserPublication({
      plan,
      confirmedPlanSha256: plan.sha256,
      command: "publish",
    });
    const patchRecord = createScmDeliveryRecord({
      plan,
      authorization,
      createdAt: "2026-10-15T12:00:00.000Z",
    });
    await store.claim(patchRecord, plan);
    const before = await fileSnapshot(root);

    const reviewPlan = planFixture();
    const manifest = createReviewDeliveryManifest(reviewPlan);
    const reviewRecord = createReviewDeliveryRecord(
      manifest,
      sha256("test-origin-store"),
      randomBytes(32).toString("base64url"),
    );
    expect(reviewRecord.idempotencyKey).not.toBe(patchRecord.idempotencyKey);
    expect((await store.claimReview(reviewRecord, () => undefined)).created).toBe(true);

    const after = await fileSnapshot(root);
    for (const [path, bytes] of before) expect(after.get(path)).toEqual(bytes);
    expect(after.size).toBeGreaterThan(before.size);
    expect(await store.load(patchRecord.idempotencyKey)).toEqual(patchRecord);
    expect(await store.loadPlan(plan.sha256)).toEqual(plan);
  });

  it("refuses an idempotent review CAS when its inspected root changes before return", async () => {
    const plan = planFixture();
    const root = await temporaryRoot();
    const displaced = `${root}-displaced`;
    roots.push(displaced);
    let swapOnInspect = false;
    const store = new FileScmDeliveryReceiptStore(root, {
      async beforeJournalOperation(operation) {
        if (operation !== "inspect" || !swapOnInspect) return;
        swapOnInspect = false;
        await rename(root, displaced);
        await mkdir(root, { mode: 0o700 });
      },
    });
    const manifest = createReviewDeliveryManifest(plan);
    const initial = createReviewDeliveryRecord(
      manifest,
      sha256("test-origin-store"),
      randomBytes(32).toString("base64url"),
    );
    expect((await store.claimReview(initial, () => undefined)).created).toBe(true);
    expect(await store.compareAndSwapReview(initial.sha256, initial, () => undefined)).toEqual(
      initial,
    );
    swapOnInspect = true;
    await expect(
      store.compareAndSwapReview(initial.sha256, initial, () => undefined),
    ).rejects.toMatchObject({ code: "unsafe-root" });
  });

  it.each([false, true])(
    "keeps review publication behind the held receipt root (replace root: %s)",
    async (replaceRoot) => {
      const plan = planFixture();
      const root = await temporaryRoot();
      const displaced = `${root}-displaced`;
      roots.push(displaced);
      const store = new FileScmDeliveryReceiptStore(root);
      const origin = await retainedOrigin(root, plan, store);
      const ports = executionPorts(plan, { drift: false });
      const publishEffect = vi.fn(async () => ({
        kind: "confirmed" as const,
        providerReference: "native-review-1",
      }));
      const cas = store.compareAndSwapReview.bind(store);
      let swapped = false;
      vi.spyOn(store, "compareAndSwapReview").mockImplementation(
        async (expected, next, authorize) => {
          const committed = await cas(expected, next, authorize);
          if (replaceRoot && !swapped && next.effects.some((item) => item.state === "intent")) {
            swapped = true;
            await rename(root, displaced);
            await mkdir(root, { mode: 0o700 });
          }
          return committed;
        },
      );
      const manifest = createReviewDeliveryManifest(plan);
      const input = {
        plan,
        store,
        originAdmission: origin.admission,
        grantsByActionId: grantsFor(plan, () => true),
        effects: { ...ports.effects, publishEffect },
        recovery: ports.recovery,
      };
      const first = await executeReviewDelivery(input);
      expect(first).toMatchObject({
        kind: "stopped",
        reason: replaceRoot ? "store-uncertain" : "remote-uncertain",
      });
      expect(publishEffect).toHaveBeenCalledTimes(replaceRoot ? 0 : 1);
      const canonical = await store.loadReview(manifest.idempotencyKey);
      expect(canonical?.effects[0]?.state ?? null).toBe(replaceRoot ? null : "uncertain");

      const second = await executeReviewDelivery(input);
      expect(second).toMatchObject({ kind: "stopped", reason: "remote-uncertain" });
      expect(publishEffect).toHaveBeenCalledTimes(1);
    },
  );

  it.each(["lease lock", "review journal"] as const)(
    "refuses review publication after a post-intent %s replacement",
    async (replacement) => {
      const plan = planFixture();
      const root = await temporaryRoot();
      const store = new FileScmDeliveryReceiptStore(root);
      const origin = await retainedOrigin(root, plan, store);
      const ports = executionPorts(plan, { drift: false });
      const publishEffect = vi.fn(async () => ({
        kind: "confirmed" as const,
        providerReference: "native-review-1",
      }));
      const key = createReviewDeliveryManifest(plan).idempotencyKey;
      const path = join(root, replacement === "lease lock" ? `.${key}.merge-request.lock` : key);
      const cas = store.compareAndSwapReview.bind(store);
      let swapped = false;
      vi.spyOn(store, "compareAndSwapReview").mockImplementation(
        async (expected, next, authorize) => {
          const committed = await cas(expected, next, authorize);
          if (!swapped && next.effects.some((item) => item.state === "intent")) {
            swapped = true;
            await rename(path, `${path}-displaced`);
            await mkdir(path, { mode: 0o700 });
          }
          return committed;
        },
      );
      const result = await executeReviewDelivery({
        plan,
        store,
        originAdmission: origin.admission,
        grantsByActionId: grantsFor(plan, () => true),
        effects: { ...ports.effects, publishEffect },
        recovery: ports.recovery,
      });
      expect(result).toMatchObject({ kind: "stopped", reason: "store-uncertain" });
      expect(publishEffect).not.toHaveBeenCalled();
    },
  );

  it.each(["grant revocation", "cancellation", "stable"] as const)(
    "rechecks %s after the awaited held-intent inspection and before transport",
    async (race) => {
      const plan = planFixture();
      const root = await temporaryRoot();
      let grantAllowed = true;
      let cancelled = false;
      let intentCommitted = false;
      let guardInspections = 0;
      const store = new FileScmDeliveryReceiptStore(root, {
        beforeJournalOperation: async (operation) => {
          if (operation !== "inspect" || !intentCommitted || guardInspections > 0) return;
          guardInspections += 1;
          if (race === "grant revocation") grantAllowed = false;
          if (race === "cancellation") cancelled = true;
        },
      });
      const origin = await retainedOrigin(root, plan, store);
      const ports = executionPorts(plan, { drift: false });
      const publishEffect = vi.fn(async () => ({
        kind: "confirmed" as const,
        providerReference: "native-review-1",
      }));
      const cas = store.compareAndSwapReview.bind(store);
      vi.spyOn(store, "compareAndSwapReview").mockImplementation(
        async (expected, next, authorize) => {
          const committed = await cas(expected, next, authorize);
          if (next.effects.some((item) => item.state === "intent")) intentCommitted = true;
          return committed;
        },
      );
      const input = {
        plan,
        store,
        originAdmission: origin.admission,
        grantsByActionId: grantsFor(plan, () => grantAllowed),
        effects: { ...ports.effects, publishEffect },
        recovery: ports.recovery,
        cancelled: () => cancelled,
      };
      const first = await executeReviewDelivery(input);
      expect(guardInspections).toBe(1);
      expect(first).toMatchObject({
        kind: "stopped",
        reason: race === "stable" ? "remote-uncertain" : "authority",
      });
      expect(publishEffect).toHaveBeenCalledTimes(race === "stable" ? 1 : 0);
      const manifest = createReviewDeliveryManifest(plan);
      const stored = await store.loadReview(manifest.idempotencyKey);
      expect(stored?.effects[0]?.state).toBe(race === "stable" ? "uncertain" : "not-dispatched");
      if (race !== "stable") {
        grantAllowed = true;
        cancelled = false;
      }
      const second = await executeReviewDelivery(input);
      expect(second).toMatchObject({ kind: "stopped", reason: "remote-uncertain" });
      expect(publishEffect).toHaveBeenCalledTimes(1);
    },
  );

  it.each(["grant revocation", "target drift", "cancellation", "origin lost"] as const)(
    "records not-dispatched when %s occurs after durable intent CAS and before the dispatch guard",
    async (race) => {
      const plan = planFixture();
      const root = await temporaryRoot();
      let admitted = true;
      let originHealthy = true;
      let cancelled = false;
      const state = { drift: false };
      let release!: () => void;
      let reached!: () => void;
      const paused = new Promise<void>((resolve) => {
        release = resolve;
      });
      const entered = new Promise<void>((resolve) => {
        reached = resolve;
      });
      let pausedOnce = false;
      const store = new FileScmDeliveryReceiptStore(root);
      const origin = await retainedOrigin(root, plan, store);
      const originAdmission = createReviewDeliveryOriginAdmission({
        async verifyCurrent(input) {
          if (!originHealthy) return { status: "blocked" };
          const result = await admitReviewDeliveryOrigin(origin.admission, input);
          return result.admitted
            ? { status: "admitted", storeId: result.storeId }
            : { status: "blocked" };
        },
      });
      const ports = executionPorts(plan, state);
      const compareAndSwap = store.compareAndSwapReview.bind(store);
      vi.spyOn(store, "compareAndSwapReview").mockImplementation(
        async (expectedSha256, next, authorize) => {
          const committed = await compareAndSwap(expectedSha256, next, authorize);
          if (!pausedOnce && next.effects.some((effect) => effect.state === "intent")) {
            pausedOnce = true;
            reached();
            await paused;
          }
          return committed;
        },
      );
      const invocation = executeReviewDelivery({
        plan,
        store,
        originAdmission,
        grantsByActionId: grantsFor(plan, () => admitted),
        effects: ports.effects,
        recovery: ports.recovery,
        cancelled: () => cancelled,
      });
      await entered;
      if (race === "grant revocation") admitted = false;
      if (race === "target drift") state.drift = true;
      if (race === "cancellation") cancelled = true;
      const observationsBeforeRelease = ports.recovery.observeCurrent.mock.calls.length;
      if (race === "origin lost") {
        originHealthy = false;
        ports.recovery.observeCurrent.mockRejectedValueOnce(
          new Error("remote observation is unavailable after origin loss"),
        );
      }
      release();
      const result = await invocation;
      expect(result).toMatchObject({ kind: "stopped", reason: "authority" });
      if (race === "origin lost")
        expect(ports.recovery.observeCurrent).toHaveBeenCalledTimes(observationsBeforeRelease);
      expect(ports.effects.publishEffect).not.toHaveBeenCalled();
      expect(ports.recovery.observeEffect).not.toHaveBeenCalled();
      const stored = await store.loadReview(createReviewDeliveryManifest(plan).idempotencyKey);
      expect(stored?.effects.at(-1)?.state).toBe("not-dispatched");
    },
  );
});
