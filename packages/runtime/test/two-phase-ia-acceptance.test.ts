// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFile } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import {
  DurableArtifactStore,
  type Artifact,
  type ArtifactReference,
  type IaEvaluationArtifact,
  type IaPlanArtifact,
} from "../src/artifacts/index.js";
import type { AgentHarness } from "../src/execution/contracts.js";
import type { RepositorySecurityScanner } from "../src/security/contracts.js";
import type { RunRecord, RunStore } from "../src/records/contracts.js";
import type { ContentIndexV1 } from "../src/content-ir/index.js";
import {
  assertIaPlanReviewApproved,
  evaluateIaCandidate,
  iaPlanReviewerPolicyDigest,
  IaPlanningHostOperation,
  prepareIaPlanReviewerAuthorization,
  reviewIaPlan,
  type IaPlanReviewArtifact,
  type IaPlanReviewerPolicy,
  type IaPlanReviewerPolicyValue,
  type IaPlanningInputProviderResult,
} from "../src/ia/index.js";
import { GitPatchEvidenceCollector } from "../src/repository/evidence.js";
import { prepareRepositoryWorkspace } from "../src/repository/workspace/materialize.js";
import {
  createSiteBootstrapApplicationBundle,
  prepareSiteBootstrapApprovalGrant,
  SiteBootstrapRunner,
  SiteBootstrapRunnerError,
  type SiteBootstrapApplicationBundle,
  type SiteBootstrapApprovalGrant,
  type SiteBootstrapRunRecord,
  type SiteBootstrapRunStore,
} from "../src/site-bootstrap/index.js";
import type { RepositoryCheckCapability } from "../src/templates/checks.js";
import type { TemplateSetCapability } from "../src/templates/load.js";
import type { TemplatePreviewTopic } from "../src/templates/contracts.js";
import type { TemplateScaffoldSummary } from "../src/templates/scaffold.js";
import { TEMPLATE_SELECTION_POLICY, templateSelectionDigest } from "../src/templates/selection.js";
import { WorkflowRunner } from "../src/workflow-execution/runner.js";
import { readyContextPreflight } from "./helpers.js";
import {
  CATALOG_POLICY,
  CHECK_POLICY,
  siteBootstrapAfterIndex,
  siteBootstrapBundle,
  siteBootstrapIndex,
} from "./site-bootstrap-fixtures.js";
import { fixtureRepository } from "./site-bootstrap-test-repository.js";

const execFileAsync = promisify(execFile);
const roots: string[] = [];
const NOW = new Date("2026-08-03T20:00:00.000Z");
const OUTPUT_PATH = "docs/get-started/quickstart.md";
const OUTPUT_CONTENT = "# DocsFab quickstart\n";

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("two-phase IA acceptance", () => {
  it("recovers, revises, approves, seals, and applies one governed plan", async () => {
    const fixture = await fixtureRepository(roots);
    const index = siteBootstrapIndex(fixture.revision);
    const artifactRoot = await temporaryRoot("docsfab-two-phase-artifacts-");
    const initialTopics = siteBootstrapBundle(index, NOW).topics;
    const initialPlanning = planningProvider(index, initialTopics, "plan:site:initial");

    const planningWorkspace = await prepareRepositoryWorkspace(fixture.path, fixture.revision);
    let initialRecord: RunRecord;
    try {
      initialRecord = await runPlanning({
        artifactRoot,
        workspacePath: planningWorkspace.path,
        sourcePath: fixture.path,
        revision: fixture.revision,
        id: "ia-planning-initial",
        provided: initialPlanning.provided,
      });
    } finally {
      await planningWorkspace.dispose();
    }
    assertContentFreePlanningRecord(initialRecord);

    const freshStore = new DurableArtifactStore(artifactRoot);
    const initialPlan = await recoverPlan(freshStore, initialRecord, index, "any");
    const evaluation = await recoverEvaluation(freshStore, initialRecord, index);
    expect(initialPlan.payload.approval.status).toBe("pending");
    expect(evaluation.digest).toBe(initialPlanning.evaluation.digest);

    const reviewer = reviewerFixture();
    expect(() =>
      reviewIaPlan({
        index: siteBootstrapIndex("f".repeat(40)),
        plan: initialPlan,
        authorization: reviewer.authorization,
        decision: "approved",
      }),
    ).toThrow("stale-plan");

    const requestedChanges = reviewIaPlan({
      index,
      plan: initialPlan,
      authorization: reviewer.authorization,
      decision: "changes-requested",
      reason: "Name the page for DocsFab and make the task explicit.",
    });
    await freshStore.put(requestedChanges.plan, {
      index,
      now: NOW,
      planAcceptance: "any",
    });
    const recoveredChanges = await new DurableArtifactStore(artifactRoot).get(
      requestedChanges.plan.digest,
      { index, now: NOW, planAcceptance: "any" },
    );
    if (recoveredChanges.kind !== "ia-plan") throw new Error("Expected changes plan.");

    const revisedTopics = structuredClone(initialTopics);
    revisedTopics[0]!.title = "DocsFab quickstart";
    const revisedPlanning = planningProvider(
      index,
      revisedTopics,
      "plan:site:revised",
      reference(recoveredChanges),
    );
    const replanWorkspace = await prepareRepositoryWorkspace(fixture.path, fixture.revision);
    let revisedRecord: RunRecord;
    try {
      revisedRecord = await runPlanning({
        artifactRoot,
        workspacePath: replanWorkspace.path,
        sourcePath: fixture.path,
        revision: fixture.revision,
        id: "ia-planning-revised",
        provided: revisedPlanning.provided,
      });
    } finally {
      await replanWorkspace.dispose();
    }
    assertContentFreePlanningRecord(revisedRecord);
    const revisedPlan = await recoverPlan(
      new DurableArtifactStore(artifactRoot),
      revisedRecord,
      index,
      "any",
    );
    expect(revisedPlan.payload.approval.status).toBe("pending");
    expect(revisedPlan.payload.supersedes).toEqual(reference(recoveredChanges));

    const approval = reviewIaPlan({
      index,
      plan: revisedPlan,
      authorization: reviewer.authorization,
      decision: "approved",
      predecessor: requestedChanges.review,
      reviewedPlan: recoveredChanges,
    });
    expect(
      assertIaPlanReviewApproved({
        index,
        plan: approval.plan,
        review: approval.review,
        policy: reviewer.policy,
        now: NOW,
      }),
    ).toEqual(approval.review);
    await freshStore.put(approval.plan, { index, now: NOW });
    const approvedPlan = await recoverByDigest(
      new DurableArtifactStore(artifactRoot),
      approval.plan.digest,
      index,
    );

    expect(() =>
      applicationBundle({
        index,
        plan: initialPlan,
        review: approval.review,
        reviewerPolicy: reviewer.policy,
        evaluation,
        evaluationInput: initialPlanning.evaluationInput,
        topics: initialTopics,
      }),
    ).toThrow("plan-unapproved");
    const bundle = applicationBundle({
      index,
      plan: approvedPlan,
      review: approval.review,
      reviewerPolicy: reviewer.policy,
      evaluation,
      evaluationInput: revisedPlanning.evaluationInput,
      topics: revisedTopics,
    });
    const grant = prepareSiteBootstrapApprovalGrant({
      bundle,
      reviewerPolicy: reviewer.policy,
      evaluationTime: NOW,
    });

    const bypass = await runWithoutApproval(fixture, index, bundle, reviewer.policy);
    expect(bypass).toMatchObject({
      status: "failed",
      error: "invalid-approval",
      mutationBoundaryEntered: false,
    });
    assertContentFreeApplicationRecord(bypass);

    const collision = await runApplicationScenario({
      fixture,
      index,
      bundle,
      grant,
      reviewerPolicy: reviewer.policy,
      mode: "collision",
    });
    expect(collision.record).toMatchObject({ status: "failed", error: "scaffold-failed" });
    expect(collision.output).toBe("# Existing page\n");
    assertContentFreeApplicationRecord(collision.record);

    const interrupted = await runApplicationScenario({
      fixture,
      index,
      bundle,
      grant,
      reviewerPolicy: reviewer.policy,
      mode: "interrupted",
    });
    expect(interrupted.record).toMatchObject({
      status: "failed",
      error: "interrupted",
      mutationBoundaryEntered: true,
    });
    expect(interrupted.record.changes?.patch).toBeDefined();
    assertContentFreeApplicationRecord(interrupted.record);

    const applied = await runApplicationScenario({
      fixture,
      index,
      bundle,
      grant,
      reviewerPolicy: reviewer.policy,
      mode: "success",
    });
    expect(applied.record).toMatchObject({
      status: "succeeded",
      mutationBoundaryEntered: true,
      plan: { digest: approvedPlan.digest },
      changes: { files: [{ path: OUTPUT_PATH, status: "added" }] },
    });
    assertContentFreeApplicationRecord(applied.record);
    const patchPath = applied.record.changes?.patch?.artifactPath;
    if (!patchPath) throw new Error("Expected durable application patch.");

    const verificationRoot = await temporaryRoot("docsfab-two-phase-verify-");
    const verificationRepository = join(verificationRoot, "repository");
    await execFileAsync("git", ["clone", "--quiet", fixture.path, verificationRepository]);
    await execFileAsync("git", ["-C", verificationRepository, "apply", "--check", patchPath]);
    await execFileAsync("git", ["-C", verificationRepository, "apply", patchPath]);
    expect(await readFile(join(verificationRepository, OUTPUT_PATH), "utf8")).toBe(OUTPUT_CONTENT);
    expect(await gitStatus(fixture.path)).toBe("");
    await expect(readFile(join(fixture.path, OUTPUT_PATH), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  }, 15_000);
});

function planningProvider(
  index: ContentIndexV1,
  topics: TemplatePreviewTopic[],
  planId: string,
  supersedes?: ArtifactReference<"ia-plan">,
): {
  provided: IaPlanningInputProviderResult;
  evaluation: IaEvaluationArtifact;
  evaluationInput: ReturnType<typeof siteBootstrapBundle>["evaluationInput"];
} {
  const base = siteBootstrapBundle(index, NOW);
  const evaluated = evaluateIaCandidate(base.evaluationInput);
  const selection = {
    ...TEMPLATE_SELECTION_POLICY,
    digest: templateSelectionDigest(topics),
  };
  return {
    evaluation: evaluated.artifact,
    evaluationInput: base.evaluationInput,
    provided: {
      index,
      planId,
      ontology: base.evaluationInput.ontology,
      candidates: base.evaluationInput.candidates,
      evaluation: evaluated.artifact,
      evaluationInput: base.evaluationInput,
      navigationEvaluation: evaluated.navigationArtifact,
      useCases: [],
      redirects: [],
      inboundLinkConsequences: [],
      policyBindings: [
        { id: "policy:stable-urls", version: "1", digest: "7".repeat(64) },
        selection,
        CATALOG_POLICY,
        CHECK_POLICY,
      ],
      requiredApproval: "maintainer",
      expiresAt: new Date(NOW.valueOf() + 60 * 60_000).toISOString(),
      ...(supersedes ? { supersedes } : {}),
      plannedPages: topics.map((topic) => ({
        topicId: topic.id,
        title: topic.title,
        slug: topic.slug,
        templateId: topic.templateId,
        format: "gfm" as const,
        outputPath: topic.outputPath,
        evidence: topic.evidenceNodeIds.map((nodeId) => {
          const node = index.nodes.find((candidate) => candidate.id === nodeId);
          if (!node) throw new Error(`Missing evidence node ${nodeId}.`);
          return { path: node.sourcePath, nodeId };
        }),
      })),
      migrationDispositions: [],
    },
  };
}

async function runPlanning(input: {
  artifactRoot: string;
  workspacePath: string;
  sourcePath: string;
  revision: string;
  id: string;
  provided: IaPlanningInputProviderResult;
}): Promise<RunRecord> {
  const operation = new IaPlanningHostOperation({
    artifactStore: new DurableArtifactStore(input.artifactRoot),
    inputProvider: { provide: async () => structuredClone(input.provided) },
  });
  const runner = new WorkflowRunner({
    harness: new RejectingHarness(),
    hostOperations: operation,
    store: new PlanningStore(),
    repositoryScanner: passedScanner,
    contextPreflight: readyContextPreflight,
    id: () => input.id,
    now: () => NOW,
  });
  return runner.run({
    workflow: "ia-plan",
    workspacePath: input.workspacePath,
    repository: {
      sourcePath: input.sourcePath,
      requestedRevision: input.revision,
      revision: input.revision,
    },
    task: { kind: "ia-plan", scope: "site", mode: "create" },
    allowWrite: false,
  });
}

async function recoverPlan(
  store: DurableArtifactStore,
  record: RunRecord,
  index: ContentIndexV1,
  acceptance: "active" | "any",
): Promise<IaPlanArtifact> {
  const use = record.artifacts?.find(
    (item) => item.role === "output" && item.reference.kind === "ia-plan",
  );
  if (!use) throw new Error("Expected planning output reference.");
  const artifact = await store.get(use.reference.digest, {
    index,
    now: NOW,
    planAcceptance: acceptance,
  });
  if (artifact.kind !== "ia-plan") throw new Error("Expected IA plan.");
  return artifact;
}

async function recoverEvaluation(
  store: DurableArtifactStore,
  record: RunRecord,
  index: ContentIndexV1,
): Promise<IaEvaluationArtifact> {
  const use = record.artifacts?.find((item) => item.reference.kind === "ia-evaluation");
  if (!use) throw new Error("Expected evaluation reference.");
  const artifact = await store.get(use.reference.digest, { index, now: NOW });
  if (artifact.kind !== "ia-evaluation") throw new Error("Expected IA evaluation.");
  return artifact;
}

async function recoverByDigest(
  store: DurableArtifactStore,
  digest: string,
  index: ContentIndexV1,
): Promise<IaPlanArtifact> {
  const artifact = await store.get(digest, { index, now: NOW });
  if (artifact.kind !== "ia-plan") throw new Error("Expected approved IA plan.");
  return artifact;
}

function reviewerFixture() {
  const keys = generateKeyPairSync("ed25519");
  const value: IaPlanReviewerPolicyValue = {
    id: "docsfab:ia-reviewers",
    version: "1",
    reviewers: [
      {
        id: "maintainer:docs",
        role: "maintainer",
        publicKey: keys.publicKey.export({ type: "spki", format: "pem" }).toString(),
      },
    ],
  };
  const policy: IaPlanReviewerPolicy = {
    ...value,
    digest: iaPlanReviewerPolicyDigest(value),
  };
  return {
    policy,
    authorization: prepareIaPlanReviewerAuthorization({
      policy,
      reviewerId: "maintainer:docs",
      privateKey: keys.privateKey,
      now: () => NOW,
    }),
  };
}

function applicationBundle(input: {
  index: ContentIndexV1;
  plan: IaPlanArtifact;
  review: IaPlanReviewArtifact;
  reviewerPolicy: IaPlanReviewerPolicy;
  evaluation: IaEvaluationArtifact;
  evaluationInput: ReturnType<typeof siteBootstrapBundle>["evaluationInput"];
  topics: TemplatePreviewTopic[];
}): SiteBootstrapApplicationBundle {
  return createSiteBootstrapApplicationBundle(
    {
      schemaVersion: 1,
      kind: "site-bootstrap-application",
      repository: {
        ...input.index.repository,
        indexDigest: input.index.indexDigest,
      },
      plan: input.plan,
      review: input.review,
      reviewerPolicy: {
        id: input.reviewerPolicy.id,
        version: input.reviewerPolicy.version,
        digest: input.reviewerPolicy.digest,
      },
      evaluation: input.evaluation,
      evaluationInput: input.evaluationInput,
      topics: input.topics,
      templateCatalogPolicy: CATALOG_POLICY,
      repositoryCheckPolicy: CHECK_POLICY,
    },
    { now: NOW, reviewerPolicy: input.reviewerPolicy },
  );
}

async function runWithoutApproval(
  fixture: { path: string; revision: string },
  index: ContentIndexV1,
  bundle: SiteBootstrapApplicationBundle,
  reviewerPolicy: IaPlanReviewerPolicy,
): Promise<SiteBootstrapRunRecord> {
  const workspace = await prepareRepositoryWorkspace(fixture.path, fixture.revision);
  let scaffoldCalls = 0;
  let evidenceCalls = 0;
  try {
    const runner = new SiteBootstrapRunner({
      store: new ApplicationStore(),
      reviewerPolicy,
      now: () => NOW,
      currentIndex: { build: async () => index },
      postflightIndex: { build: async () => index },
      repositoryEvidence: {
        capture: async () => {
          evidenceCalls += 1;
          return { files: [] };
        },
      },
      scaffold: async () => {
        scaffoldCalls += 1;
        return scaffoldSummary(bundle.plan.digest, index);
      },
    });
    const record = await runner.run(
      applicationInput(workspace, fixture.path, bundle, {} as SiteBootstrapApprovalGrant),
    );
    expect(scaffoldCalls).toBe(0);
    expect(evidenceCalls).toBe(0);
    return record;
  } finally {
    await workspace.dispose();
  }
}

async function runApplicationScenario(input: {
  fixture: { path: string; revision: string };
  index: ContentIndexV1;
  bundle: SiteBootstrapApplicationBundle;
  grant: SiteBootstrapApprovalGrant;
  reviewerPolicy: IaPlanReviewerPolicy;
  mode: "collision" | "interrupted" | "success";
}): Promise<{ record: SiteBootstrapRunRecord; output?: string }> {
  const workspace = await prepareRepositoryWorkspace(input.fixture.path, input.fixture.revision);
  const artifactRoot = await temporaryRoot(`docsfab-two-phase-${input.mode}-`);
  if (input.mode === "collision") {
    const output = join(workspace.path, OUTPUT_PATH);
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, "# Existing page\n", "utf8");
  }
  const collector = await GitPatchEvidenceCollector.create(workspace.path, artifactRoot);
  try {
    const runner = new SiteBootstrapRunner({
      store: new ApplicationStore(),
      reviewerPolicy: input.reviewerPolicy,
      repositoryEvidence: collector,
      now: () => NOW,
      id: () => `site-bootstrap-${input.mode}`,
      currentIndex: { build: async () => input.index },
      postflightIndex: {
        build: async () =>
          input.mode === "collision" ? input.index : siteBootstrapAfterIndex(input.index),
      },
      scaffold: async () => {
        const output = join(workspace.path, OUTPUT_PATH);
        if (input.mode === "collision") {
          await readFile(output, "utf8");
          throw new Error("output collision");
        }
        await mkdir(dirname(output), { recursive: true });
        await writeFile(output, OUTPUT_CONTENT, "utf8");
        return scaffoldSummary(input.bundle.plan.digest, input.index);
      },
      ...(input.mode === "interrupted"
        ? {
            afterScaffold: () => {
              throw new SiteBootstrapRunnerError("interrupted");
            },
          }
        : {}),
    });
    const record = await runner.run(
      applicationInput(workspace, input.fixture.path, input.bundle, input.grant),
    );
    const output =
      input.mode === "collision"
        ? await readFile(join(workspace.path, OUTPUT_PATH), "utf8")
        : undefined;
    return { record, ...(output ? { output } : {}) };
  } finally {
    await collector.dispose();
    await workspace.dispose();
  }
}

function applicationInput(
  workspace: Awaited<ReturnType<typeof prepareRepositoryWorkspace>>,
  sourcePath: string,
  bundle: SiteBootstrapApplicationBundle,
  approval: SiteBootstrapApprovalGrant,
) {
  return {
    allowWrite: true,
    workspace,
    repository: {
      sourcePath,
      requestedRevision: workspace.requestedRevision,
      revision: workspace.revision,
    },
    bundle,
    approval,
    templates: {
      catalogDigest: CATALOG_POLICY.digest,
      bundle: {},
    } as TemplateSetCapability,
    checks: {
      id: CHECK_POLICY.id,
      version: CHECK_POLICY.version,
      digest: CHECK_POLICY.digest,
    } as RepositoryCheckCapability,
  };
}

function scaffoldSummary(planDigest: string, index: ContentIndexV1): TemplateScaffoldSummary {
  return {
    schemaVersion: 1,
    operation: "site",
    repository: { ...index.repository },
    planDigest,
    previewDigest: "1".repeat(64),
    catalogDigest: CATALOG_POLICY.digest,
    outputs: [],
    validations: [],
    transaction: { schemaVersion: 1, planDigest, outputs: [], totalByteLength: 0 },
    repositoryChecks: {
      schemaVersion: 1,
      policy: CHECK_POLICY,
      status: "passed",
      results: [],
      digest: "3".repeat(64),
    },
    digest: "4".repeat(64),
  };
}

function reference(plan: IaPlanArtifact): ArtifactReference<"ia-plan"> {
  return {
    kind: "ia-plan",
    schemaVersion: 1,
    digest: plan.digest,
    repositoryRevision: plan.repository.revision,
    repositoryContentDigest: plan.repository.contentDigest,
  };
}

function assertContentFreePlanningRecord(record: RunRecord): void {
  expect(record.status).toBe("succeeded");
  expect(record.artifacts?.map((use) => use.reference.kind)).toEqual([
    "ontology",
    "ia-candidates",
    "ia-evaluation",
    "navigation-evaluation",
    "ia-plan",
  ]);
  for (const use of record.artifacts ?? []) {
    expect(Object.keys(use.reference).sort()).toEqual([
      "digest",
      "kind",
      "repositoryContentDigest",
      "repositoryRevision",
      "schemaVersion",
    ]);
  }
  const encoded = JSON.stringify(record);
  expect(encoded).not.toContain("Fixture documentation");
  expect(encoded).not.toContain(OUTPUT_CONTENT.trim());
  expect(encoded).not.toContain('"payload"');
}

function assertContentFreeApplicationRecord(record: SiteBootstrapRunRecord): void {
  const encoded = JSON.stringify(record);
  expect(encoded).not.toContain("Fixture documentation");
  expect(encoded).not.toContain(OUTPUT_CONTENT.trim());
  expect(encoded).not.toContain('"payload"');
  expect(record.plan).toEqual({
    kind: "ia-plan",
    schemaVersion: 1,
    digest: record.plan.digest,
    repositoryRevision: record.repository.revision,
    repositoryContentDigest: "b".repeat(64),
  });
}

class PlanningStore implements RunStore {
  public records: RunRecord[] = [];
  public async save(record: RunRecord): Promise<void> {
    this.records.push(structuredClone(record));
  }
}

class ApplicationStore implements SiteBootstrapRunStore {
  public records: SiteBootstrapRunRecord[] = [];
  public async save(record: SiteBootstrapRunRecord): Promise<void> {
    this.records.push(structuredClone(record));
  }
}

class RejectingHarness implements AgentHarness {
  public async runStep(): Promise<never> {
    throw new Error("Planning must use the host operation.");
  }
}

const passedScanner: RepositorySecurityScanner = {
  scan: async () => ({
    ruleSet: "test-v1",
    status: "passed",
    scannedFiles: 6,
    binaryFiles: 0,
    findings: [],
  }),
};

async function temporaryRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

async function gitStatus(path: string): Promise<string> {
  const result = await execFileAsync("git", ["-C", path, "status", "--porcelain"], {
    encoding: "utf8",
  });
  return result.stdout.trim();
}
