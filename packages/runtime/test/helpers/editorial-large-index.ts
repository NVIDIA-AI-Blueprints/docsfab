// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Editorial evidence admitted against a content index of a chosen size, for
 * tests of the artifact store's object bound (#1932). It imports no test
 * runner, so host tests can load it through tsx and replay what the runtime
 * wrote after hosted retention.
 */
import { createHash } from "node:crypto";

import {
  createArtifact,
  DurableArtifactStore,
  type ArtifactReference,
  type EditorialDecisionArtifactReferenceV3,
} from "../../src/artifacts/index.js";
import type { ContentIndexV1 } from "../../src/content-ir/contracts.js";
import { canonicalDigest } from "../../src/content-ir/index.js";
import type { ReaderContextProvenanceSourceV1 } from "../../src/context/reader-context.js";
import type { RunRecord, StepRunRecord } from "../../src/records/contracts.js";
import { getWorkflow } from "../../src/workflow-registry/catalog.js";
import {
  bindDocumentationPlanProposal,
  type DocumentationPlanBindingV1,
} from "../../src/workflow-execution/plan-binding.js";
import {
  createEditorialEvidenceHostV1,
  loadEditorialEvidenceDecodeOptionsV1,
  type EditorialAssessmentProposalV1,
  type EditorialEvidenceHostV1,
} from "../../src/workflow-execution/editorial-evidence-host.js";

const revision = "a".repeat(40);
const contentDigest = "b".repeat(64);
const workspaceSnapshot = "c".repeat(64);
const baselineSha256 = "3".repeat(64);
const repositoryIdentitySha256 = "6".repeat(64);
const policy = Object.freeze({
  id: "docsfab-documentation-quality",
  version: "v0.1",
  sha256: "4".repeat(64),
});
const comparison = Object.freeze({
  kind: "base-head" as const,
  base_revision: "5".repeat(40),
  head_revision: revision,
});

/** Anchors per generated page; about 1.9 KB of index JSON per page, as in the field. */
const GENERATED_ANCHORS = 48;

/**
 * A valid content index whose JSON is at least `minimumBytes` long: the
 * requested page plus generated pages, each with a navigation edge. About
 * 1.9 KB per page, close to the 1.7 KB per tracked file measured on vLLM
 * Semantic Router.
 */
export function contentIndexOfAtLeast(minimumBytes: number): ContentIndexV1 {
  const nodes: ContentIndexV1["nodes"] = [documentNode("document:cli", "docs/cli.md", 0)];
  const edges: ContentIndexV1["edges"] = [];
  let bytes = Buffer.byteLength(JSON.stringify(nodes[0]));
  for (let page = 1; bytes < minimumBytes; page += 1) {
    const node = documentNode(`document:page-${page}`, `docs/generated/page-${page}.md`, page);
    const edge = { kind: "navigation" as const, from: "document:cli", to: node.id };
    nodes.push(node);
    edges.push(edge);
    bytes += Buffer.byteLength(JSON.stringify(node)) + Buffer.byteLength(JSON.stringify(edge)) + 2;
  }
  const repository = { revision, contentDigest };
  const indexDigest = canonicalDigest({ schemaVersion: 1, repository, nodes, edges });
  return {
    schemaVersion: 1,
    repository,
    indexDigest,
    nodes,
    edges,
    evidence: {
      repositoryRevision: revision,
      contentDigest,
      indexDigest,
      documentCount: nodes.length,
      sectionCount: 0,
      edgeCount: edges.length,
    },
  };
}

function documentNode(
  id: string,
  sourcePath: string,
  page: number,
): ContentIndexV1["nodes"][number] {
  const digest = (seed: string) => createHash("sha256").update(`${seed}:${page}`).digest("hex");
  return {
    id,
    kind: "document",
    sourcePath,
    format: "markdown",
    byteLength: 4096,
    anchors:
      page === 0
        ? []
        : Array.from(
            { length: GENERATED_ANCHORS },
            (_, anchor) => `section-${anchor}-of-generated-reference-page-${page}`,
          ),
    frontmatter: page === 0 ? [] : [{ name: "title", type: "string" }],
    directives: [],
    codeBlocks: page === 0 ? [] : [{ language: "bash", startLine: 3, endLine: 9 }],
    regions: {
      body: digest("body"),
      headings: digest("headings"),
      metadata: digest("metadata"),
      navigation: digest("navigation"),
      graph: digest("graph"),
    },
  };
}

export interface LargeIndexEditorialFixture {
  readonly host: EditorialEvidenceHostV1;
  readonly storeRoot: string;
  readonly index: ContentIndexV1;
  readonly reference: ArtifactReference;
  readonly sources: readonly ReaderContextProvenanceSourceV1[];
  readonly plan: DocumentationPlanBindingV1;
}

/** Admit editorial evidence for `index` into the store at `storeRoot`. */
export async function admitEditorialEvidence(
  storeRoot: string,
  index: ContentIndexV1,
): Promise<LargeIndexEditorialFixture> {
  const artifact = createArtifact(
    "context-packet",
    {
      targetNodeId: "document:cli",
      pageRole: {
        contentType: "reference",
        readerJob: "reader:run-inspection",
        organizingAxis: "reader-job",
      },
      ancestors: [],
      siblings: [],
      relatedCanonicalPages: [],
      placementRules: { belongsHere: ["contract:public-command"], belongsElsewhere: [] },
      activeDecisionIds: [],
      structuralPressure: "healthy",
      evidence: [{ path: "docs/cli.md", nodeId: "document:cli" }],
    },
    { index },
  );
  const reference: ArtifactReference = {
    kind: artifact.kind,
    schemaVersion: 1,
    digest: artifact.digest,
    repositoryRevision: revision,
    repositoryContentDigest: contentDigest,
  };
  const sourceInputs = [
    source("src/orbit.py", "changed-source", "changed implementation bytes"),
    source("src/orbit.py", "public-contract", "changed implementation bytes"),
    source("docs/cli.md", "current-documentation", "current documentation bytes"),
  ];
  const host = await createEditorialEvidenceHostV1({
    store: new DurableArtifactStore(storeRoot),
    index,
    readerContextInput: readerContextInput(),
    baselineSha256,
    policy,
    comparison,
    repositoryIdentitySha256,
    workspaceSnapshotSha256: workspaceSnapshot,
    observedAt: "2026-10-05T12:00:00.000Z",
    provenanceLimitations: [],
    sources: sourceInputs,
    admittedArtifacts: [artifact],
    audienceProtocol: "not-supplied",
    projectCompletedReaderTaskContext: ({ readerContext, provenance }) => {
      const { impact_basis: _impactBasis, ...input } = readerContext;
      return {
        schemaVersion: 1,
        kind: "docsfab-reader-task-context-completed",
        inputOrigin: "explicit",
        noChangeAssessment: "requires-evidence",
        readerContextInput: input,
        baseline: {
          path: "profiles/docsfab-documentation-quality/reader-impact-baseline.md",
          sha256: baselineSha256,
          content: "Use actual reader and source evidence.",
        },
        policy,
        readerContext,
        provenance,
        prompt: "Completed host-validated reader context.",
      };
    },
  });
  return {
    host,
    storeRoot,
    index,
    reference,
    sources: sourceInputs.map(({ source: admitted }) => admitted),
    plan: bindDocumentationPlanProposal(
      {
        mode: "update",
        pages: [{ path: "docs/cli.md", disposition: "retain" }],
        sourceBindings: [],
      },
      { expectedMode: "update" },
    ),
  };
}

/** Run the planner and the four assessments to a validated no-change decision. */
export async function completeNoChangeDecision(
  fixture: LargeIndexEditorialFixture,
  runId: string,
): Promise<{
  readonly record: RunRecord;
  readonly finalReference: EditorialDecisionArtifactReferenceV3;
}> {
  const workflow = getWorkflow("update-documentation");
  const record = runRecord(fixture.plan, [step("plan-documentation", fixture.reference)], runId);
  const selection = await fixture.host.select({
    workflow,
    record,
    proposal: candidateProposal(fixture.reference, fixture.sources[0]!),
  });
  record.steps[0]!.artifacts!.push({
    role: "output",
    stepId: "plan-documentation",
    reference: selection.candidateArtifact!,
  });
  for (const [stepId, assessment] of [
    ["verify-technical-accuracy", "accepted"],
    ["review-documentation", "accepted"],
    ["test-audience-understanding", "not-applicable"],
    ["evaluate-document-quality", "accepted"],
  ] as const) {
    record.steps.push(step(stepId, fixture.reference));
    await fixture.host.observeAssessment({
      workflow,
      record,
      stepId,
      proposal: assessmentProposal(fixture.reference, assessment),
    });
  }
  const finalReference = await fixture.host.finalize({
    workflow,
    record,
    selection,
    coverageSha256: "d".repeat(64),
  });
  record.artifacts = [
    { role: "output", stepId: "plan-documentation", reference: selection.candidateArtifact! },
    { role: "output", stepId: "evaluate-document-quality", reference: finalReference },
  ];
  return { record, finalReference };
}

/**
 * Rebuild the decision from the store at `storeRoot` alone, as replay after a
 * restore does, and return what it decoded.
 */
export async function replayNoChangeDecision(input: {
  readonly storeRoot: string;
  readonly record: RunRecord;
  readonly finalReference: EditorialDecisionArtifactReferenceV3;
  readonly sources: readonly ReaderContextProvenanceSourceV1[];
}): Promise<{ readonly phase: string; readonly candidate: string }> {
  const replay = await loadEditorialEvidenceDecodeOptionsV1({
    store: new DurableArtifactStore(input.storeRoot),
    record: input.record,
    baselineSha256,
    policy,
    admission: {
      admittedRevision: revision,
      workspaceSnapshotSha256: workspaceSnapshot,
      repositoryIdentitySha256,
      comparison,
      sources: [...input.sources],
      provenanceLimitations: [],
    },
  });
  const decision = replay.decodeEditorialDecision(
    input.finalReference,
    "evaluate-document-quality",
  );
  return { phase: decision.phase, candidate: decision.candidate };
}

function readerContextInput() {
  return {
    schema_version: 1 as const,
    target_audience: "developers using Orbit",
    reader_job: "run one inspection",
    change_scope: ["docs/cli.md"],
    source_priority: ["public contract", "current documentation", "changed source"],
    required_content: ["command and verification"],
    excluded_content: [],
    unresolved_questions: [],
  };
}

function source(uri: string, role: ReaderContextProvenanceSourceV1["role"], text: string) {
  const bytes = new TextEncoder().encode(text);
  return {
    source: { uri, role, sha256: createHash("sha256").update(bytes).digest("hex") },
    bytes,
  };
}

function candidateProposal(
  reference: ArtifactReference,
  impactEvidence: ReaderContextProvenanceSourceV1,
) {
  return {
    schemaVersion: 1,
    kind: "docsfab-editorial-decision-proposal",
    candidate: "no-change",
    rationale: "The public command remains unchanged in the admitted comparison.",
    evidenceRefs: [reference],
    limitations: [],
    impactBasis: {
      kind: "none",
      rationale: "The implementation change does not alter the public command.",
      evidence_refs: [{ uri: impactEvidence.uri, sha256: impactEvidence.sha256 }],
    },
  };
}

function assessmentProposal(
  reference: ArtifactReference,
  assessment: EditorialAssessmentProposalV1["assessment"],
): EditorialAssessmentProposalV1 {
  return {
    schemaVersion: 1,
    kind: "docsfab-editorial-assessment-proposal",
    assessment,
    rationale: "The independent assessment inspected the retained large-index evidence.",
    evidenceRefs: [reference],
    limitations: assessment === "not-applicable" ? ["audience-check-unavailable"] : [],
    recommendation: null,
  };
}

function runRecord(
  plan: DocumentationPlanBindingV1,
  steps: StepRunRecord[],
  id: string,
): RunRecord {
  return {
    schemaVersion: 2,
    id,
    workflow: "update-documentation",
    repository: { sourcePath: "/tmp/repository", requestedRevision: revision, revision },
    workspace: { strategy: "tracked-export", disposable: true },
    status: "running",
    createdAt: "2026-10-05T12:00:00.000Z",
    startedAt: "2026-10-05T12:00:00.000Z",
    models: [],
    skills: [],
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, turns: 0 },
    tools: { totalCalls: 0, failedCalls: 0, byTool: [] },
    steps: steps.map((value) =>
      value.id === "plan-documentation" ? { ...value, planBinding: plan } : value,
    ),
  };
}

function step(id: string, reference: ArtifactReference): StepRunRecord {
  return {
    id,
    title: id,
    kind: "evaluate",
    skill: id,
    mode: "read-only",
    status: "succeeded",
    artifacts: [{ role: "input", stepId: id, reference }],
    summary: `${id} completed.`,
  };
}
