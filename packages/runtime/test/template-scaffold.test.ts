// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFile } from "node:child_process";
import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  createArtifact,
  type ArtifactEnvelope,
  type ArtifactEvidence,
  type ArtifactPayloadByKind,
  type ArtifactReference,
  type IaCandidate,
  type IaEvaluationArtifact,
  type IaPlanArtifact,
  type OntologyEntity,
} from "../src/artifacts/index.js";
import type { ContentIndexV1, DocumentNode } from "../src/content-ir/index.js";
import { canonicalDigest } from "../src/content-ir/canonical.js";
import {
  DEFAULT_IA_DIAGNOSTIC_POLICY,
  evaluateIaCandidate,
  type EvaluateIaCandidateInput,
  type IaStructuralProjection,
  type NavigationRankCandidate,
  type NavigationRankings,
  type VersionedNavigationSuite,
} from "../src/ia/index.js";
import { GitPatchEvidenceCollector } from "../src/repository/evidence.js";
import {
  prepareRepositoryWorkspace,
  withRepositoryWorkspace,
} from "../src/repository/workspace/materialize.js";
import type { RepositoryWorkspace } from "../src/repository/workspace/contracts.js";
import {
  repositoryCheckPolicyDigest,
  prepareRepositoryCheckCapability,
  type RepositoryCheckCapability,
  type RepositoryCheckPolicy,
} from "../src/templates/checks.js";
import type { TemplatePreviewTopic } from "../src/templates/contracts.js";
import { template as templateOperations } from "../src/templates/operations.js";
import { TemplatePathError } from "../src/templates/paths.js";
import {
  scaffoldPage,
  scaffoldSite,
  TemplateScaffoldError,
  type TemplateScaffoldInput,
} from "../src/templates/scaffold.js";
import { TEMPLATE_SELECTION_POLICY, templateSelectionDigest } from "../src/templates/selection.js";
import {
  prepareTemplateSet,
  TEMPLATE_CATALOG_POLICY,
  type TemplateSetCapability,
} from "../src/templates/load.js";

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const execFileAsync = promisify(execFile);
const TEST_TIME = Date.now();
const NOW = new Date(TEST_TIME - 90 * 60_000);
const APPROVED_AT = new Date(TEST_TIME - 2 * 60 * 60_000).toISOString();
const DEFAULT_EXPIRES_AT = new Date(TEST_TIME + 2 * 60 * 60_000).toISOString();
const EXPIRED_AT = new Date(TEST_TIME - 60 * 60_000).toISOString();
const REVISION = "a".repeat(40);
const CONTENT_DIGEST = "b".repeat(64);
const INDEX_DIGEST = "c".repeat(64);
const A1 = "document:operate/run.md";
const A2 = "document:operate/debug.md";
const B1 = "document:concepts/model.md";
const B2 = "document:concepts/policy.md";
const OA = "document:operate/index.md";
const OB = "document:concepts/index.md";
const createdWorkspaces: string[] = [];
const activeWorkspaces: RepositoryWorkspace[] = [];
let templateCapability: TemplateSetCapability;
let passingCheckCapability: RepositoryCheckCapability;
let failingCheckCapability: RepositoryCheckCapability;
let mutatingCheckCapability: RepositoryCheckCapability;
let chmodCheckCapability: RepositoryCheckCapability;
let ownerExecuteRemovalCheckCapability: RepositoryCheckCapability;

beforeAll(async () => {
  templateCapability = await prepareTemplateSet(PROJECT_ROOT);
  [
    passingCheckCapability,
    failingCheckCapability,
    mutatingCheckCapability,
    chmodCheckCapability,
    ownerExecuteRemovalCheckCapability,
  ] = await Promise.all([
    prepareRepositoryCheckCapability({
      policy: policy("process.exit(0)"),
      allowedExecutables: [process.execPath],
    }),
    prepareRepositoryCheckCapability({
      policy: policy("process.stderr.write('fixture failure'); process.exit(7)"),
      allowedExecutables: [process.execPath],
    }),
    prepareRepositoryCheckCapability({
      policy: policy("require('node:fs').writeFileSync('README.md', 'mutated\\n')"),
      allowedExecutables: [process.execPath],
    }),
    prepareRepositoryCheckCapability({
      policy: policy("require('node:fs').chmodSync('README.md', 0o755)"),
      allowedExecutables: [process.execPath],
    }),
    prepareRepositoryCheckCapability({
      policy: policy("require('node:fs').chmodSync('README.md', 0o655)"),
      allowedExecutables: [process.execPath],
    }),
  ]);
});

afterEach(async () => {
  await Promise.all(activeWorkspaces.splice(0).map((workspace) => workspace.dispose()));
  await Promise.all(
    createdWorkspaces.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("approved template scaffolding", () => {
  it("creates an authentic GFM/MyST site in a disposable workspace with a content-free summary", async () => {
    const workspace = await preparedWorkspace();
    const workspacePath = workspace.path;
    const input = scaffoldFixture(workspace, siteTopics(), passingPolicy());

    const summary = await scaffoldSite(input);

    expect(summary.operation).toBe("site");
    expect(summary.outputs.map((output) => [output.path, output.format])).toEqual([
      ["docs/get-started/quickstart-myst.md", "myst"],
      ["docs/get-started/quickstart.md", "gfm"],
    ]);
    expect(summary.validations.every((report) => report.status === "passed")).toBe(true);
    expect(summary.repositoryChecks.status).toBe("passed");
    expect(summary.transaction.outputs).toHaveLength(2);

    const gfm = await readFile(join(workspacePath, "docs/get-started/quickstart.md"), "utf8");
    const myst = await readFile(join(workspacePath, "docs/get-started/quickstart-myst.md"), "utf8");
    expect(gfm).toContain("Quickstart for DocsFab");
    expect(myst).toContain("Quickstart for DocsFab");

    const serialized = JSON.stringify(summary);
    expect(serialized).not.toContain("Quickstart for DocsFab");
    expect(serialized).not.toContain(gfm);
    expect(serialized).not.toContain(myst);
    expect(serialized).not.toContain(workspacePath);
  });

  it("creates one authentic approved page", async () => {
    const workspace = await preparedWorkspace();
    const workspacePath = workspace.path;
    const topic = siteTopics()[0]!;
    const summary = await scaffoldPage(scaffoldFixture(workspace, [topic], passingPolicy()));

    expect(summary.operation).toBe("page");
    expect(summary.outputs).toHaveLength(1);
    expect(summary.outputs[0]).toMatchObject({
      path: "docs/get-started/quickstart.md",
      format: "gfm",
    });
    expect(summary.outputs[0]!.evidenceGapCount).toBeGreaterThan(0);
    await expect(access(join(workspacePath, topic.outputPath))).resolves.toBeUndefined();
  });

  it("rolls back every scaffold output when a repository check fails", async () => {
    const workspace = await preparedWorkspace();
    const workspacePath = workspace.path;
    const input = scaffoldFixture(workspace, siteTopics(), failingPolicy());

    await expect(scaffoldSite(input)).rejects.toMatchObject({
      name: "TemplateScaffoldError",
      code: "repository-check-failed",
      report: { status: "failed" },
    });

    await expectMissing(join(workspacePath, "docs/get-started/quickstart.md"));
    await expectMissing(join(workspacePath, "docs/get-started/quickstart-myst.md"));
    await expectMissing(join(workspacePath, "docs"));
  });

  it("detects an existing target during read-only preflight before creating any sibling output", async () => {
    const workspace = await preparedWorkspace();
    const workspacePath = workspace.path;
    const existingPath = join(workspacePath, "docs/get-started/quickstart-myst.md");
    await mkdir(dirname(existingPath), { recursive: true });
    await writeFile(existingPath, "maintainer-authored\n", "utf8");

    await expect(
      scaffoldSite(scaffoldFixture(workspace, siteTopics(), passingPolicy())),
    ).rejects.toEqual(new TemplatePathError("path-exists", "docs/get-started/quickstart-myst.md"));

    expect(await readFile(existingPath, "utf8")).toBe("maintainer-authored\n");
    await expectMissing(join(workspacePath, "docs/get-started/quickstart.md"));
  });

  it("rejects a workspace revision mismatch before writing", async () => {
    const workspace = await preparedWorkspace();
    const workspacePath = workspace.path;
    const input = scaffoldFixture(workspace, siteTopics(), passingPolicy(), "f".repeat(40));

    await expect(scaffoldSite(input)).rejects.toEqual(
      new TemplateScaffoldError("workspace-mismatch"),
    );
    await expectMissing(join(workspacePath, "docs"));
  });

  it("rejects a template id for an unsupported format without writing", async () => {
    const workspace = await preparedWorkspace();
    const workspacePath = workspace.path;
    const topics = siteTopics().slice(0, 1);
    topics[0] = { ...topics[0]!, templateId: "quickstart-mdx" };

    await expect(scaffoldPage(scaffoldFixture(workspace, topics, passingPolicy()))).rejects.toThrow(
      "Unknown template id: quickstart-mdx",
    );
    await expectMissing(join(workspacePath, "docs"));
  });

  it("rejects partial or changed page selections not digest-bound by the approved plan", async () => {
    const workspace = await preparedWorkspace();
    const input = scaffoldFixture(workspace, siteTopics(), passingPolicy());
    input.topics = input.topics.slice(0, 1);

    await expect(scaffoldSite(input)).rejects.toMatchObject({ code: "selection-mismatch" });
    await expectMissing(join(workspace.path, "docs"));
  });

  it("rejects fabricated evidence node IDs before preview or writing", async () => {
    const workspace = await preparedWorkspace();
    const input = scaffoldFixture(workspace, siteTopics(), passingPolicy());
    input.topics[0]!.evidenceNodeIds = ["document:made-up.md"];

    await expect(scaffoldSite(input)).rejects.toEqual(
      new TemplateScaffoldError("invalid-evidence"),
    );
    await expectMissing(join(workspace.path, "docs"));
  });

  it("rejects a check capability not bound into the approved plan", async () => {
    const workspace = await preparedWorkspace();
    const input = scaffoldFixture(workspace, siteTopics(), passingPolicy());
    input.checks = failingCheckCapability;

    await expect(scaffoldSite(input)).rejects.toMatchObject({ code: "selection-mismatch" });
    await expectMissing(join(workspace.path, "docs"));
  });

  it("rejects a passing check that changes anything outside the approved outputs", async () => {
    const workspace = await preparedWorkspace();
    const input = scaffoldFixture(workspace, siteTopics(), mutatingCheckCapability);

    await expect(scaffoldSite(input)).rejects.toEqual(
      new TemplateScaffoldError("workspace-check-drift"),
    );
    await expectMissing(workspace.path);
    expect(await readFile(join(workspace.sourcePath, "README.md"), "utf8")).toBe(
      "fixture source\n",
    );
    await expect(scaffoldSite(input)).rejects.toEqual(
      new TemplateScaffoldError("workspace-mismatch"),
    );
  });

  it("detects executable-mode drift and invalidates the contaminated workspace", async () => {
    const workspace = await preparedWorkspace();
    const input = scaffoldFixture(workspace, siteTopics(), chmodCheckCapability);

    await expect(scaffoldSite(input)).rejects.toEqual(
      new TemplateScaffoldError("workspace-check-drift"),
    );
    await expectMissing(workspace.path);
    expect(await readFile(join(workspace.sourcePath, "README.md"), "utf8")).toBe(
      "fixture source\n",
    );
  });

  it("uses Git's owner-execute semantics when detecting mode drift", async () => {
    const workspace = await preparedWorkspace();
    await chmod(join(workspace.path, "README.md"), 0o755);
    const input = scaffoldFixture(workspace, siteTopics(), ownerExecuteRemovalCheckCapability);

    await expect(scaffoldSite(input)).rejects.toEqual(
      new TemplateScaffoldError("workspace-check-drift"),
    );
    await expectMissing(workspace.path);
    expect(await readFile(join(workspace.sourcePath, "README.md"), "utf8")).toBe(
      "fixture source\n",
    );
  });

  it("rejects forged workspace objects and plans expired at the trusted current time", async () => {
    const workspace = await preparedWorkspace();
    const forged = scaffoldFixture(workspace, siteTopics(), passingPolicy());
    forged.workspace = { ...workspace };
    await expect(scaffoldSite(forged)).rejects.toEqual(
      new TemplateScaffoldError("workspace-mismatch"),
    );

    const expired = scaffoldFixture(
      workspace,
      siteTopics(),
      passingPolicy(),
      workspace.revision,
      EXPIRED_AT,
    );
    await expect(scaffoldSite(expired)).rejects.toMatchObject({ code: "invalid-plan" });
    await expectMissing(join(workspace.path, "docs"));
  });

  it("exposes the complete stable template operation namespace", () => {
    expect(Object.keys(templateOperations)).toEqual([
      "list",
      "previewSite",
      "scaffoldSite",
      "scaffoldPage",
      "validatePage",
    ]);
    expect(templateOperations.scaffoldSite).toBe(scaffoldSite);
    expect(templateOperations.scaffoldPage).toBe(scaffoldPage);
  });

  it("captures a cleanly applicable patch while leaving the source checkout unchanged", async () => {
    const sourcePath = await fixtureRepository();
    const artifactRoot = await workspace();
    const sourceRevision = await git(sourcePath, ["rev-parse", "HEAD"]);
    const sourceStatus = await git(sourcePath, ["status", "--porcelain=v1"]);
    let patchPath = "";

    await withRepositoryWorkspace(sourcePath, "HEAD", async (repositoryWorkspace) => {
      const collector = await GitPatchEvidenceCollector.create(
        repositoryWorkspace.path,
        artifactRoot,
      );
      try {
        const topic = siteTopics()[0]!;
        const summary = await scaffoldPage(
          scaffoldFixture(repositoryWorkspace, [topic], passingPolicy()),
        );
        expect(summary.repository.revision).toBe(sourceRevision);
        const evidence = await collector.capture({
          runId: "template-scaffold-acceptance",
          repository: {
            sourcePath: repositoryWorkspace.sourcePath,
            requestedRevision: repositoryWorkspace.requestedRevision,
            revision: repositoryWorkspace.revision,
          },
          workspacePath: repositoryWorkspace.path,
          persistPatch: true,
        });
        patchPath = evidence.patch?.artifactPath ?? "";
        expect(evidence.files).toEqual([
          {
            path: "docs/get-started/quickstart.md",
            status: "added",
          },
        ]);
      } finally {
        await collector.dispose();
      }
    });

    expect(await git(sourcePath, ["status", "--porcelain=v1"])).toBe(sourceStatus);
    await expectMissing(join(sourcePath, "docs"));
    expect(await readFile(patchPath, "utf8")).toContain("+++ b/docs/get-started/quickstart.md");

    const freshRoot = await workspace();
    const freshCheckout = join(freshRoot, "checkout");
    await execFileAsync("git", ["clone", "--quiet", sourcePath, freshCheckout]);
    await git(freshCheckout, ["apply", "--check", patchPath]);
    await git(freshCheckout, ["apply", patchPath]);
    expect(await readFile(join(freshCheckout, "docs/get-started/quickstart.md"), "utf8")).toContain(
      "Quickstart for DocsFab",
    );
  });
});

async function workspace(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "docsfab-template-scaffold-"));
  createdWorkspaces.push(path);
  return path;
}

async function preparedWorkspace(): Promise<RepositoryWorkspace> {
  const sourcePath = await fixtureRepository();
  const prepared = await prepareRepositoryWorkspace(sourcePath, "HEAD");
  activeWorkspaces.push(prepared);
  return prepared;
}

async function expectMissing(path: string): Promise<void> {
  await expect(access(path)).rejects.toMatchObject({ code: "ENOENT" });
}

function siteTopics(): TemplatePreviewTopic[] {
  return [
    {
      id: "topic:quickstart",
      slug: "get-started/quickstart",
      title: "Quickstart",
      templateId: "quickstart-gfm",
      outputPath: "docs/get-started/quickstart.md",
      productName: "DocsFab",
      evidenceNodeIds: [A1],
    },
    {
      id: "topic:quickstart-myst",
      slug: "get-started/quickstart-myst",
      title: "Quickstart MyST",
      templateId: "quickstart-myst",
      outputPath: "docs/get-started/quickstart-myst.md",
      productName: "DocsFab",
      evidenceNodeIds: [A1],
    },
  ];
}

function scaffoldFixture(
  workspace: RepositoryWorkspace,
  topics: TemplatePreviewTopic[],
  checks: RepositoryCheckCapability,
  repositoryRevision = workspace.revision,
  expiresAt = DEFAULT_EXPIRES_AT,
): TemplateScaffoldInput {
  const evaluationInput = evaluationFixture(repositoryRevision);
  const evaluation = evaluateIaCandidate(evaluationInput).artifact;
  return {
    templates: templateCapability,
    workspace,
    index: evaluationInput.index,
    plan: planFixture(evaluationInput, evaluation, topics, expiresAt, checks),
    evaluation,
    evaluationInput,
    topics,
    checks,
  };
}

function passingPolicy(): RepositoryCheckCapability {
  return passingCheckCapability;
}

function failingPolicy(): RepositoryCheckCapability {
  return failingCheckCapability;
}

function policy(script: string): RepositoryCheckPolicy {
  const value = {
    id: "policy:template-scaffold",
    version: "1",
    checks: [
      { id: "check:docs", executable: process.execPath, args: ["-e", script], timeoutMs: 5_000 },
    ],
  };
  return { ...value, digest: repositoryCheckPolicyDigest(value) };
}

function planFixture(
  input: EvaluateIaCandidateInput,
  evaluation: IaEvaluationArtifact,
  topics: TemplatePreviewTopic[],
  expiresAt: string,
  checks?: RepositoryCheckCapability,
): IaPlanArtifact {
  const candidate = input.candidates.payload.candidates[0]!;
  const outputScope: ArtifactPayloadByKind["ia-plan"]["outputScope"] = topics.map((topic) => ({
    path: topic.outputPath,
    operation: "create",
  }));
  return createArtifact(
    "ia-plan",
    {
      planId: "plan:reader-job",
      candidateId: candidate.id,
      candidateArtifact: reference(input.candidates),
      scope: "site",
      primaryAxis: candidate.primaryAxis,
      secondaryAxes: candidate.secondaryAxes,
      groups: candidate.groups,
      useCases: [],
      rejectedCandidates: [],
      openDecisions: [],
      redirects: [],
      inboundLinkConsequences: [],
      navigationEvaluation: evaluation.payload.navigationEvaluation,
      policyBindings: [
        { id: "policy:stable-urls", version: "1", digest: "7".repeat(64) },
        { ...TEMPLATE_SELECTION_POLICY, digest: templateSelectionDigest(topics) },
        { ...TEMPLATE_CATALOG_POLICY, digest: templateCapability.catalogDigest },
        {
          id: (checks ?? passingCheckCapability).id,
          version: (checks ?? passingCheckCapability).version,
          digest: (checks ?? passingCheckCapability).digest,
        },
      ],
      approval: {
        requirement: "maintainer",
        status: "approved",
        approvedBy: "maintainer:example",
        approvedAt: APPROVED_AT,
      },
      expiresAt,
      outputScope,
    },
    { index: input.index, now: NOW },
  );
}

function reference<K extends "ia-candidates">(artifact: ArtifactEnvelope<K>): ArtifactReference<K> {
  return {
    kind: artifact.kind,
    schemaVersion: artifact.schemaVersion,
    digest: artifact.digest,
    repositoryRevision: artifact.repository.revision,
    repositoryContentDigest: artifact.repository.contentDigest,
  };
}

function evaluationFixture(repositoryRevision = REVISION): EvaluateIaCandidateInput {
  const nodes = [OA, OB, A1, A2, B1, B2].map(document);
  const index = contentIndex(nodes, repositoryRevision);
  const candidate = candidateFixture();
  const ontology = createArtifact(
    "ontology",
    {
      entities: ontologyEntities(),
      relationships: [],
    },
    { index },
  );
  const candidates = createArtifact(
    "ia-candidates",
    {
      scope: "site",
      candidates: [candidate],
      recommendedCandidateId: candidate.id,
      rejectedCandidates: [],
      openDecisions: [],
    },
    { index },
  );
  const structure = structureFixture();
  const semantics = structure.topicNodeIds.map((nodeId) => contextPacket(index, nodeId));
  const rankings = passingRankings();
  return {
    index,
    ontology,
    candidates,
    semantics,
    candidateId: candidate.id,
    structure,
    diagnosticPolicy: DEFAULT_IA_DIAGNOSTIC_POLICY,
    placements: structure.topicNodeIds.map((nodeId) => ({
      nodeId,
      proposedPath: sourcePathFor(nodeId),
      evidence: [evidence(nodeId)],
    })),
    navigationSuite: navigationSuite(),
    navigationRetrieval: {
      id: "docsfab:test-navigation-retrieval",
      version: "1",
      digest: "6".repeat(64),
    },
    currentRankings: structuredClone(rankings),
    proposedRankings: structuredClone(rankings),
  };
}

function candidateFixture(): IaCandidate {
  return {
    id: "candidate:reader-job",
    primaryAxis: "reader-job",
    secondaryAxes: [],
    score: 90,
    groups: [
      {
        id: "group:operate",
        label: "Operate",
        axis: "reader-job",
        members: [A1, A2],
        canonicalPath: "operate",
        evidence: [evidence(A1)],
      },
      {
        id: "group:understand",
        label: "Understand",
        axis: "reader-job",
        members: [B1, B2],
        canonicalPath: "concepts",
        evidence: [evidence(B1)],
      },
    ],
    evidence: [evidence(A1)],
  };
}

function ontologyEntities(): OntologyEntity[] {
  return [
    { id: "entity:operate", label: "Operate", kind: "user-job", evidence: [evidence(A1)] },
    { id: "entity:understand", label: "Understand", kind: "concept", evidence: [evidence(B1)] },
  ];
}

function structureFixture(): IaStructuralProjection {
  return {
    topicNodeIds: [A1, A2, B1, B2],
    siblingSets: [
      {
        id: "siblings:top",
        parentId: "candidate:reader-job",
        groupIds: ["group:operate", "group:understand"],
        declaredAxis: "reader-job",
        evidence: [evidence(A1)],
      },
    ],
    overviews: [
      { groupId: "group:operate", nodeId: OA, evidence: [evidence(OA)] },
      { groupId: "group:understand", nodeId: OB, evidence: [evidence(OB)] },
    ],
    throughlines: [
      { groupId: "group:operate", entityId: "entity:operate", evidence: [evidence(A1)] },
      { groupId: "group:understand", entityId: "entity:understand", evidence: [evidence(B1)] },
    ],
    pageClassifications: [A1, A2, B1, B2].map((nodeId) => ({
      nodeId,
      purpose: "single-purpose" as const,
      siblingKind: "task" as const,
      evidence: [evidence(nodeId)],
    })),
    exceptions: [],
  };
}

function navigationSuite(): VersionedNavigationSuite {
  return {
    schemaVersion: 1,
    id: "suite:mvp",
    version: "1",
    cases: [
      navigationCase("routine", "routine-task", [destination(A1)]),
      navigationCase("reference", "reference-lookup", [destination(B1)]),
      navigationCase("troubleshoot", "troubleshooting", [destination(A2)]),
      navigationCase("ambiguous", "ambiguous-placement", [destination(A1), destination(B1)]),
      navigationCase("none", "expected-no-result", []),
    ],
  };
}

function navigationCase(
  id: string,
  kind: VersionedNavigationSuite["cases"][number]["kind"],
  expected: VersionedNavigationSuite["cases"][number]["expected"],
): VersionedNavigationSuite["cases"][number] {
  return { id, kind, query: `query:${id}`, expected, acceptableAlternatives: [] };
}

function passingRankings(): NavigationRankings {
  return {
    routine: [hit(A1, 10)],
    reference: [hit(B1, 10)],
    troubleshoot: [hit(A2, 10)],
    ambiguous: [hit(A1, 10), hit(B1, 9)],
    none: [],
  };
}

function destination(nodeId: string): NavigationRankCandidate {
  const path = sourcePathFor(nodeId)
    .replace(/\.md$/u, "")
    .replace(/\/index$/u, "");
  return { nodeId, url: `/${path}`, anchor: null, score: 0 };
}

function hit(nodeId: string, score: number): NavigationRankCandidate {
  return { ...destination(nodeId), score };
}

function contextPacket(index: ContentIndexV1, nodeId: string): ArtifactEnvelope<"context-packet"> {
  return createArtifact(
    "context-packet",
    {
      targetNodeId: nodeId,
      pageRole: {
        contentType: "how-to",
        readerJob: nodeId.startsWith("document:concepts/") ? "entity:understand" : "entity:operate",
        organizingAxis: "reader-job",
      },
      ancestors: [],
      siblings: [],
      relatedCanonicalPages: [],
      placementRules: { belongsHere: [], belongsElsewhere: [] },
      activeDecisionIds: [],
      structuralPressure: "healthy",
      evidence: [evidence(nodeId)],
    },
    { index },
  );
}

function contentIndex(nodes: DocumentNode[], repositoryRevision: string): ContentIndexV1 {
  const value: ContentIndexV1 = {
    schemaVersion: 1,
    repository: { revision: repositoryRevision, contentDigest: CONTENT_DIGEST },
    indexDigest: INDEX_DIGEST,
    nodes,
    edges: [],
    evidence: {
      repositoryRevision,
      contentDigest: CONTENT_DIGEST,
      indexDigest: INDEX_DIGEST,
      documentCount: nodes.length,
      sectionCount: 0,
      edgeCount: 0,
    },
  };
  const indexDigest = canonicalDigest({
    schemaVersion: 1,
    repository: value.repository,
    nodes,
    edges: value.edges,
  });
  return { ...value, indexDigest, evidence: { ...value.evidence, indexDigest } };
}

async function fixtureRepository(): Promise<string> {
  const repositoryPath = await workspace();
  await git(repositoryPath, ["init", "--quiet"]);
  await git(repositoryPath, ["config", "user.email", "docsfab@example.test"]);
  await git(repositoryPath, ["config", "user.name", "DocsFab Test"]);
  await git(repositoryPath, ["config", "commit.gpgsign", "false"]);
  await writeFile(join(repositoryPath, "README.md"), "fixture source\n", "utf8");
  await git(repositoryPath, ["add", "README.md"]);
  await git(repositoryPath, ["commit", "--quiet", "-m", "fixture"]);
  return repositoryPath;
}

async function git(repositoryPath: string, args: string[]): Promise<string> {
  const result = await execFileAsync("git", ["-C", repositoryPath, ...args], { encoding: "utf8" });
  return result.stdout.trim();
}

function document(id: string): DocumentNode {
  return {
    id,
    kind: "document",
    sourcePath: sourcePathFor(id),
    format: "gfm",
    byteLength: 64,
    anchors: [],
    frontmatter: [],
    directives: [],
    codeBlocks: [],
    regions: {
      body: "1".repeat(64),
      headings: "2".repeat(64),
      metadata: "3".repeat(64),
      navigation: "4".repeat(64),
      graph: "5".repeat(64),
    },
  };
}

function evidence(nodeId: string): ArtifactEvidence {
  return { path: sourcePathFor(nodeId), nodeId };
}

function sourcePathFor(nodeId: string): string {
  return nodeId.replace(/^document:/u, "");
}
