// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  canonicalArtifactJson,
  createArtifact,
  createEditorialDecisionCandidateFromProposalV1,
  createEditorialDecisionPayloadV1,
  decodeEditorialDecisionPayloadV1,
  editorialDecisionReferenceV3,
  validateArtifact,
  validateEditorialDecisionProposalV1,
  type ArtifactReference,
  type ArtifactUse,
  type EditorialDecisionArtifactResolverV1,
  type EditorialDecisionProducerProvenanceV1,
  type ResolvedEditorialDecisionEvidenceV1,
  type ResolvedEditorialDecisionRationaleV1,
} from "../src/artifacts/index.js";
import {
  NO_CHANGE_ASSESSMENT_LOCATION,
  QUALITY_EVALUATION_NOT_APPLICABLE_LIMITATION,
} from "../src/artifacts/editorial-decision.js";
import type { ContentIndexV1 } from "../src/content-ir/contracts.js";
import {
  READER_CONTEXT_CHANGED_SOURCE_INAPPLICABLE_LIMITATION,
  readerContextProvenanceSha256,
  readerContextSha256,
  type ReaderContextProvenanceV1,
  type ReaderContextV1,
} from "../src/context/reader-context.js";
import type { AgentHarness } from "../src/execution/contracts.js";
import type { RepositorySecurityScanner } from "../src/security/contracts.js";
import type { RunRecord, RunStore } from "../src/records/contracts.js";
import { WorkflowRunner } from "../src/workflow-execution/runner.js";
import { readyContextPreflight } from "./helpers.js";

class MemoryStore implements RunStore {
  public records: RunRecord[] = [];

  public async save(record: RunRecord): Promise<void> {
    this.records.push(structuredClone(record));
  }
}

const scanner: RepositorySecurityScanner = {
  scan: async () => ({
    ruleSet: "test-v1",
    status: "passed",
    scannedFiles: 0,
    binaryFiles: 0,
    findings: [],
  }),
};

const repositoryRevision = "a".repeat(40);
const repositoryContentDigest = "b".repeat(64);

function artifact(
  kind: ArtifactUse["reference"]["kind"],
  digestCharacter: string,
  role: ArtifactUse["role"],
): ArtifactUse {
  return {
    role,
    stepId: "UNTRUSTED_STEP_ID",
    reference: {
      kind,
      schemaVersion: 1,
      digest: digestCharacter.repeat(64),
      repositoryRevision,
      repositoryContentDigest,
    },
  };
}

type MutableArtifactUse = {
  role?: unknown;
  stepId?: unknown;
  reference?: Record<string, unknown>;
};

async function runWithArtifacts(artifacts: ArtifactUse[]): Promise<RunRecord> {
  const harness: AgentHarness = {
    runStep: async () => ({
      summary: "artifact fixture completed",
      artifacts,
    }),
  };
  const store = new MemoryStore();
  const runner = new WorkflowRunner({
    harness,
    store,
    repositoryScanner: scanner,
    contextPreflight: readyContextPreflight,
    id: () => "artifact-run",
    now: () => new Date("2026-08-03T12:00:00.000Z"),
  });

  return runner.run({
    workflow: "readiness",
    workspacePath: "/tmp/disposable-repository",
    repository: {
      sourcePath: "/tmp/source-repository",
      requestedRevision: "HEAD",
      revision: repositoryRevision,
    },
    allowWrite: false,
  });
}

describe("run-record artifact references", () => {
  it("copies and deduplicates content-free references without losing production order", async () => {
    const context = artifact("context-packet", "c", "input");
    const ontology = artifact("ontology", "d", "input");
    const impact = artifact("impact-report", "e", "output");
    const roadmapLedger = artifact("roadmap-ledger", "f", "input");
    const roadmapPlan = artifact("roadmap-mutation-plan", "1", "output");
    const unsafeArtifacts = [
      {
        ...impact,
        payload: "PAYLOAD_SENTINEL",
        artifactPath: "/Users/example/private-artifact.json",
        reference: {
          ...impact.reference,
          payload: "REFERENCE_PAYLOAD_SENTINEL",
          artifactPath: "/Users/example/reference-artifact.json",
        },
      },
      ontology,
      context,
      roadmapLedger,
      roadmapPlan,
      {
        ...context,
        payload: "DUPLICATE_PAYLOAD_SENTINEL",
      },
    ] as unknown as ArtifactUse[];
    const harness: AgentHarness = {
      runStep: async () => ({
        summary: "artifact fixture completed",
        artifacts: unsafeArtifacts,
      }),
    };
    const store = new MemoryStore();
    const runner = new WorkflowRunner({
      harness,
      store,
      repositoryScanner: scanner,
      contextPreflight: readyContextPreflight,
      id: () => "artifact-run",
      now: () => new Date("2026-08-03T12:00:00.000Z"),
    });

    const record = await runner.run({
      workflow: "readiness",
      workspacePath: "/tmp/disposable-repository",
      repository: {
        sourcePath: "/tmp/source-repository",
        requestedRevision: "HEAD",
        revision: repositoryRevision,
      },
      allowWrite: false,
    });

    expect(record.schemaVersion).toBe(2);
    expect(record.status).toBe("succeeded");
    expect(record.artifacts).toHaveLength(5);
    expect(record.steps[0]?.artifacts).toEqual(record.artifacts);
    expect(record.artifacts?.map((use) => [use.role, use.reference.kind])).toEqual([
      ["output", "impact-report"],
      ["input", "ontology"],
      ["input", "context-packet"],
      ["input", "roadmap-ledger"],
      ["output", "roadmap-mutation-plan"],
    ]);
    expect(record.artifacts?.every((use) => use.stepId === "assess-readiness")).toBe(true);

    for (const use of record.artifacts ?? []) {
      expect(Object.keys(use).sort()).toEqual(["reference", "role", "stepId"]);
      expect(Object.keys(use.reference).sort()).toEqual([
        "digest",
        "kind",
        "repositoryContentDigest",
        "repositoryRevision",
        "schemaVersion",
      ]);
    }
    const serialized = JSON.stringify({
      run: record.artifacts,
      step: record.steps[0]?.artifacts,
    });
    expect(serialized).not.toContain("payload");
    expect(serialized).not.toContain("artifactPath");
    expect(serialized).not.toContain("PAYLOAD_SENTINEL");
    expect(serialized).not.toContain("/Users/");
  });

  it.each([
    {
      name: "invalid role",
      mutate: (use: MutableArtifactUse) => {
        use.role = "side-channel";
      },
    },
    {
      name: "missing role",
      mutate: (use: MutableArtifactUse) => {
        delete use.role;
      },
    },
    {
      name: "invalid kind",
      mutate: (use: MutableArtifactUse) => {
        use.reference!.kind = "prompt-payload";
      },
    },
    {
      name: "missing kind",
      mutate: (use: MutableArtifactUse) => {
        delete use.reference!.kind;
      },
    },
    {
      name: "invalid schema version",
      mutate: (use: MutableArtifactUse) => {
        use.reference!.schemaVersion = 2;
      },
    },
    {
      name: "missing schema version",
      mutate: (use: MutableArtifactUse) => {
        delete use.reference!.schemaVersion;
      },
    },
    {
      name: "invalid digest",
      mutate: (use: MutableArtifactUse) => {
        use.reference!.digest = "not-a-digest";
      },
    },
    {
      name: "missing digest",
      mutate: (use: MutableArtifactUse) => {
        delete use.reference!.digest;
      },
    },
    {
      name: "invalid repository revision",
      mutate: (use: MutableArtifactUse) => {
        use.reference!.repositoryRevision = "moving-ref";
      },
    },
    {
      name: "missing repository revision",
      mutate: (use: MutableArtifactUse) => {
        delete use.reference!.repositoryRevision;
      },
    },
    {
      name: "invalid repository content digest",
      mutate: (use: MutableArtifactUse) => {
        use.reference!.repositoryContentDigest = "unknown";
      },
    },
    {
      name: "missing repository content digest",
      mutate: (use: MutableArtifactUse) => {
        delete use.reference!.repositoryContentDigest;
      },
    },
    {
      name: "object-valued copied field",
      mutate: (use: MutableArtifactUse) => {
        use.reference!.digest = {
          payload: "PAYLOAD_SENTINEL",
          artifactPath: "/Users/example/private-artifact.json",
        };
      },
    },
    {
      name: "NUL collision value",
      mutate: (use: MutableArtifactUse) => {
        use.reference!.kind = "ontology\0impact-report";
      },
    },
    {
      name: "stale repository revision",
      mutate: (use: MutableArtifactUse) => {
        use.reference!.repositoryRevision = "c".repeat(40);
      },
    },
  ])("rejects $name without persisting artifact data", async ({ mutate }) => {
    const malformed = structuredClone(
      artifact("ontology", "d", "input"),
    ) as unknown as MutableArtifactUse;
    mutate(malformed);

    const record = await runWithArtifacts([malformed as unknown as ArtifactUse]);

    expect(record.status).toBe("failed");
    expect(record.artifacts).toBeUndefined();
    expect(record.steps[0]?.artifacts).toBeUndefined();
    const serialized = JSON.stringify(record);
    expect(serialized).not.toContain("PAYLOAD_SENTINEL");
    expect(serialized).not.toContain("artifactPath");
    expect(serialized).not.toContain("/Users/");
    expect(serialized).not.toContain("prompt-payload");
    expect(serialized).not.toContain("side-channel");
    expect(serialized).not.toContain("ontology\\u0000impact-report");
  });
});

describe("editorial decision artifact admission", () => {
  const contentDigest = "b".repeat(64);
  const workspaceSnapshot = "c".repeat(64);
  const index: ContentIndexV1 = {
    schemaVersion: 1,
    repository: { revision: repositoryRevision, contentDigest },
    indexDigest: "d".repeat(64),
    nodes: [
      {
        id: "document:cli",
        kind: "document",
        sourcePath: "docs/cli.md",
        format: "markdown",
        byteLength: 100,
        contentDigest: "e".repeat(64),
        title: "CLI",
        anchors: ["run"],
      },
    ],
    edges: [],
    evidence: {
      repositoryRevision,
      contentDigest,
      indexDigest: "d".repeat(64),
      documentCount: 1,
      sectionCount: 0,
      edgeCount: 0,
    },
  };

  function producer(
    stepId: EditorialDecisionProducerProvenanceV1["stepId"],
    assessment: EditorialDecisionProducerProvenanceV1["assessment"] = "accepted",
    recommendationCandidate: "update" | "insufficient-evidence" = "insufficient-evidence",
  ): EditorialDecisionProducerProvenanceV1 {
    const recommendation =
      assessment === "rejected"
        ? {
            candidate: recommendationCandidate,
            kind:
              recommendationCandidate === "update"
                ? ("product-gap" as const)
                : ("evidence-limitation" as const),
            code:
              recommendationCandidate === "update"
                ? "product-gap.documentation-update-required"
                : "evidence-limitation.independent-assessment-rejected",
            rationaleSha256: "9".repeat(64),
          }
        : null;
    return {
      stepId,
      skill: stepId,
      mode: "read-only",
      status: "succeeded",
      repositoryRevision,
      workspaceSnapshotSha256: workspaceSnapshot,
      assessment,
      recommendation,
    };
  }

  function genuineEvidence(label: string): {
    reference: ArtifactReference;
    bytes: Uint8Array;
  } {
    const artifact = createArtifact(
      "context-packet",
      {
        targetNodeId: "document:cli",
        pageRole: {
          contentType: "reference",
          readerJob: `reader:${label}`,
          organizingAxis: "reader-job",
        },
        ancestors: [],
        siblings: [],
        relatedCanonicalPages: [],
        placementRules: { belongsHere: [label], belongsElsewhere: [] },
        activeDecisionIds: [],
        structuralPressure: "healthy",
        evidence: [{ path: "docs/cli.md", nodeId: "document:cli" }],
      },
      { index },
    );
    return {
      reference: {
        kind: artifact.kind,
        schemaVersion: 1,
        digest: artifact.digest,
        repositoryRevision,
        repositoryContentDigest: contentDigest,
      },
      bytes: new TextEncoder().encode(canonicalArtifactJson(artifact)),
    };
  }

  function fixture(
    rejectedStep?: EditorialDecisionProducerProvenanceV1["stepId"],
    audienceAssessment: EditorialDecisionProducerProvenanceV1["assessment"] = "accepted",
    changedSourceInapplicable = false,
    recommendationCandidate: "update" | "insufficient-evidence" = "insufficient-evidence",
    notApplicableStep?: EditorialDecisionProducerProvenanceV1["stepId"],
  ) {
    const coreAssessment = (
      stepId: EditorialDecisionProducerProvenanceV1["stepId"],
    ): EditorialDecisionProducerProvenanceV1["assessment"] =>
      rejectedStep === stepId
        ? "rejected"
        : notApplicableStep === stepId
          ? "not-applicable"
          : "accepted";
    const plan = genuineEvidence("plan");
    const sharedAssessmentEvidence = genuineEvidence("shared-assessment-source");
    const evidence = new Map<string, ResolvedEditorialDecisionEvidenceV1>();
    const rationales = new Map<string, ResolvedEditorialDecisionRationaleV1>();
    const key = (reference: ArtifactReference) => canonicalArtifactJson(reference);
    evidence.set(key(plan.reference), { ...plan, producers: [producer("plan-documentation")] });
    evidence.set(key(sharedAssessmentEvidence.reference), {
      ...sharedAssessmentEvidence,
      producers: [
        producer(
          "verify-technical-accuracy",
          coreAssessment("verify-technical-accuracy"),
          recommendationCandidate,
        ),
        producer(
          "review-documentation",
          coreAssessment("review-documentation"),
          recommendationCandidate,
        ),
        producer(
          "test-audience-understanding",
          rejectedStep === "test-audience-understanding" ? "rejected" : audienceAssessment,
          recommendationCandidate,
        ),
        producer(
          "evaluate-document-quality",
          coreAssessment("evaluate-document-quality"),
          recommendationCandidate,
        ),
      ],
    });
    const resolver: EditorialDecisionArtifactResolverV1 = {
      resolve(reference) {
        const resolved = evidence.get(key(reference));
        if (!resolved) throw new Error("unavailable");
        return resolved;
      },
      resolveRationale(digest) {
        const resolved = rationales.get(digest);
        if (!resolved) throw new Error("unavailable");
        return resolved;
      },
    };
    const input = {
      schema_version: 1 as const,
      target_audience: "developers",
      reader_job: "run one inspection",
      change_scope: ["docs/cli.md"],
      source_priority: ["public CLI", "current docs"],
      required_content: ["command", "verification"],
      excluded_content: [],
      unresolved_questions: [],
    };
    const changedSource = {
      uri: "artifact:source-change",
      sha256: "f".repeat(64),
      role: "changed-source" as const,
    };
    const requiredSources = [
      {
        uri: "artifact:current-documentation",
        sha256: "6".repeat(64),
        role: "current-documentation" as const,
      },
      {
        uri: "artifact:public-contract",
        sha256: "7".repeat(64),
        role: "public-contract" as const,
      },
    ];
    const sourceEvidence = changedSourceInapplicable
      ? requiredSources
      : [changedSource, ...requiredSources];
    const impactEvidence = {
      uri: sourceEvidence[0]!.uri,
      sha256: sourceEvidence[0]!.sha256,
    };
    const candidateRationale =
      "The exact source comparison is internal-only and the public command remains documented.";
    const proposal = validateEditorialDecisionProposalV1(
      {
        schemaVersion: 1,
        kind: "docsfab-editorial-decision-proposal",
        candidate: "no-change",
        rationale: candidateRationale,
        evidenceRefs: [plan.reference],
        limitations: [],
        impactBasis: {
          kind: "none",
          rationale: "The admitted change is internal and does not alter the public command.",
          evidence_refs: [impactEvidence],
        },
      },
      {
        readerContextInput: input,
        admittedReaderEvidence: [impactEvidence],
        admittedEvidenceRefs: [plan.reference],
      },
    );
    const candidateRationaleBytes = new TextEncoder().encode(candidateRationale);
    const candidateRationaleSha = createHash("sha256")
      .update(candidateRationaleBytes)
      .digest("hex");
    rationales.set(candidateRationaleSha, {
      bytes: candidateRationaleBytes,
      boundReference: plan.reference,
      producer: producer("plan-documentation"),
    });
    const readerContext: ReaderContextV1 = {
      ...input,
      impact_basis: proposal.impactBasis,
    };
    const comparison = {
      kind: "base-head" as const,
      base_revision: changedSourceInapplicable ? repositoryRevision : "9".repeat(40),
      head_revision: repositoryRevision,
    };
    const readerProvenance: ReaderContextProvenanceV1 = {
      schema_version: 1,
      reader_context_sha256: readerContextSha256(readerContext),
      baseline_sha256: "8".repeat(64),
      admitted_revision: repositoryRevision,
      workspace_snapshot_sha256: workspaceSnapshot,
      repository_identity_sha256: "4".repeat(64),
      policy: { id: "docsfab-documentation-quality", version: "v0.1", sha256: "3".repeat(64) },
      comparison,
      sources: sourceEvidence,
      observed_at: "2026-09-12T12:00:00Z",
      limitations: changedSourceInapplicable
        ? [READER_CONTEXT_CHANGED_SOURCE_INAPPLICABLE_LIMITATION]
        : [],
    };
    const readerProvenanceValidation = {
      readerContextSha256: readerProvenance.reader_context_sha256,
      baselineSha256: readerProvenance.baseline_sha256,
      admittedRevision: repositoryRevision,
      workspaceSnapshotSha256: workspaceSnapshot,
      repositoryIdentitySha256: readerProvenance.repository_identity_sha256,
      policy: readerProvenance.policy,
      admittedSources: sourceEvidence,
    };
    const common = {
      repositoryRevision,
      repositoryContentDigest: contentDigest,
      workspaceSnapshotSha256: workspaceSnapshot,
      planBindingSha256: "2".repeat(64),
      policySha256: "3".repeat(64),
      comparison,
      readerContext,
      readerContextValidation: { admittedEvidence: [impactEvidence] },
      readerProvenance,
      readerProvenanceValidation,
      evidenceValidator: {
        validate(reference: ArtifactReference, bytes: Uint8Array) {
          const artifact = validateArtifact(JSON.parse(new TextDecoder().decode(bytes)), { index });
          if (
            artifact.digest !== reference.digest ||
            artifact.kind !== reference.kind ||
            artifact.repository.revision !== reference.repositoryRevision ||
            artifact.repository.contentDigest !== reference.repositoryContentDigest
          ) {
            throw new Error("artifact identity mismatch");
          }
        },
      },
      producerValidator: {
        validate(candidate: EditorialDecisionProducerProvenanceV1) {
          if (candidate.repositoryRevision !== repositoryRevision)
            throw new Error("stale producer");
        },
      },
      resolver,
    };
    const candidate = createEditorialDecisionCandidateFromProposalV1(proposal, {
      ...common,
      producer: producer("plan-documentation"),
    });
    const candidateReference = editorialDecisionReferenceV3(candidate, contentDigest);
    evidence.set(key(candidateReference), {
      reference: candidateReference,
      bytes: new TextEncoder().encode(canonicalArtifactJson(candidate)),
      producers: [producer("plan-documentation")],
    });
    const validatedRationale =
      "Independent verification, review, and evaluation confirmed the no-change assessment.";
    const validatedRationaleBytes = new TextEncoder().encode(validatedRationale);
    const validatedRationaleSha = createHash("sha256")
      .update(validatedRationaleBytes)
      .digest("hex");
    rationales.set(validatedRationaleSha, {
      bytes: validatedRationaleBytes,
      boundReference: sharedAssessmentEvidence.reference,
      producer: producer(
        "evaluate-document-quality",
        coreAssessment("evaluate-document-quality"),
        recommendationCandidate,
      ),
    });
    return {
      common,
      proposal,
      producer: producer(
        "evaluate-document-quality",
        coreAssessment("evaluate-document-quality"),
        recommendationCandidate,
      ),
      candidate,
      candidateReference,
      validatedValue: {
        phase: "validated" as const,
        candidateArtifact: candidateReference,
        branchCoverage: {
          schemaVersion: 1 as const,
          kind: "docsfab-workflow-branch-coverage-reference" as const,
          coverageSha256: "1".repeat(64),
        },
        candidate: "no-change" as const,
        repositoryRevision,
        workspaceSnapshotSha256: workspaceSnapshot,
        readerProvenanceSha256: readerContextProvenanceSha256(readerProvenance),
        planBindingSha256: common.planBindingSha256,
        policySha256: common.policySha256,
        comparison: common.comparison,
        rationaleSha256: validatedRationaleSha,
        evidenceRefs: [candidateReference, sharedAssessmentEvidence.reference],
        limitations: ["experimental-quality-profile"],
      },
    };
  }

  it("creates and replays candidate/validated decisions from genuine admitted artifact bytes", () => {
    const value = fixture();
    const validated = createEditorialDecisionPayloadV1(value.validatedValue, {
      ...value.common,
      producer: value.producer,
    });
    expect(
      decodeEditorialDecisionPayloadV1(JSON.parse(canonicalArtifactJson(validated)), {
        ...value.common,
        producer: value.producer,
      }),
    ).toEqual(validated);
    expect(value.candidateReference).toMatchObject({
      kind: "editorial-decision",
      schemaVersion: 3,
      digest: value.candidate.decisionSha256,
    });
    const tampered = JSON.parse(canonicalArtifactJson(validated));
    tampered.branchCoverage.coverageSha256 = "9".repeat(64);
    expect(() =>
      decodeEditorialDecisionPayloadV1(tampered, {
        ...value.common,
        producer: value.producer,
      }),
    ).toThrowError(expect.objectContaining({ code: "digest-mismatch" }));
  });

  it("requires every completed reader impact reference in provenance sources", () => {
    const value = fixture();
    const unprovenImpact = {
      uri: "artifact:reader-impact-without-provenance",
      sha256: "a".repeat(64),
    };
    const { impact_basis: _impactBasis, ...readerContextInput } = value.common.readerContext;
    const proposal = validateEditorialDecisionProposalV1(
      {
        ...value.proposal,
        impactBasis: {
          ...value.proposal.impactBasis,
          evidence_refs: [unprovenImpact],
        },
      },
      {
        readerContextInput,
        admittedReaderEvidence: [unprovenImpact],
        admittedEvidenceRefs: value.proposal.evidenceRefs,
      },
    );
    const readerContext = { ...readerContextInput, impact_basis: proposal.impactBasis };
    const readerProvenance = {
      ...value.common.readerProvenance,
      reader_context_sha256: readerContextSha256(readerContext),
    };

    expect(() =>
      createEditorialDecisionCandidateFromProposalV1(proposal, {
        ...value.common,
        producer: producer("plan-documentation"),
        readerContext,
        readerContextValidation: { admittedEvidence: [unprovenImpact] },
        readerProvenance,
        readerProvenanceValidation: {
          ...value.common.readerProvenanceValidation,
          readerContextSha256: readerProvenance.reader_context_sha256,
        },
      }),
    ).toThrowError(expect.objectContaining({ code: "identity-mismatch" }));
  });

  it("rejects independent rejection, unavailable candidate bytes and substituted identity", () => {
    const rejected = fixture("review-documentation");
    expect(() =>
      createEditorialDecisionPayloadV1(rejected.validatedValue, {
        ...rejected.common,
        producer: rejected.producer,
      }),
    ).toThrowError(expect.objectContaining({ code: "independent-rejection" }));

    const missing = fixture();
    const missingResolver = {
      ...missing.common.resolver,
      resolve: () => {
        throw new Error("missing");
      },
    };
    expect(() =>
      createEditorialDecisionPayloadV1(missing.validatedValue, {
        ...missing.common,
        resolver: missingResolver,
        producer: missing.producer,
      }),
    ).toThrowError(expect.objectContaining({ code: "evidence-unavailable" }));

    const drifted = fixture();
    expect(() =>
      createEditorialDecisionPayloadV1(
        { ...drifted.validatedValue, workspaceSnapshotSha256: "8".repeat(64) },
        { ...drifted.common, producer: drifted.producer },
      ),
    ).toThrowError(expect.objectContaining({ code: "identity-mismatch" }));

    const substituted = fixture();
    const replacement = genuineEvidence("substituted-valid-artifact");
    const substitutedResolver: EditorialDecisionArtifactResolverV1 = {
      ...substituted.common.resolver,
      resolve(reference) {
        const original = substituted.common.resolver.resolve(reference);
        return reference.kind === "editorial-decision"
          ? original
          : { ...original, bytes: replacement.bytes };
      },
    };
    expect(() =>
      createEditorialDecisionPayloadV1(substituted.validatedValue, {
        ...substituted.common,
        resolver: substitutedResolver,
        producer: substituted.producer,
      }),
    ).toThrowError(expect.objectContaining({ code: "evidence-unavailable" }));

    const unboundCoverage = fixture();
    expect(() =>
      createEditorialDecisionPayloadV1(
        { ...unboundCoverage.validatedValue, branchCoverage: null },
        { ...unboundCoverage.common, producer: unboundCoverage.producer },
      ),
    ).toThrowError(expect.objectContaining({ code: "invalid-value" }));

    const extraEditorialReference = fixture();
    expect(() =>
      createEditorialDecisionPayloadV1(
        {
          ...extraEditorialReference.validatedValue,
          evidenceRefs: [
            ...extraEditorialReference.validatedValue.evidenceRefs,
            {
              ...extraEditorialReference.candidateReference,
              digest: "9".repeat(64),
            },
          ],
        },
        {
          ...extraEditorialReference.common,
          producer: extraEditorialReference.producer,
        },
      ),
    ).toThrowError(expect.objectContaining({ code: "invalid-value" }));
  });

  it("retains a genuine independent reversal without changing candidate or branch identity", () => {
    for (const recommendation of ["update", "insufficient-evidence"] as const) {
      const rejected = fixture("review-documentation", "accepted", false, recommendation);
      const code =
        recommendation === "update"
          ? "product-gap.documentation-update-required"
          : "evidence-limitation.independent-assessment-rejected";
      const final = createEditorialDecisionPayloadV1(
        {
          ...rejected.validatedValue,
          candidate: recommendation,
          limitations: [...rejected.validatedValue.limitations, code],
        },
        { ...rejected.common, producer: rejected.producer },
      );
      expect(final).toMatchObject({
        phase: "validated",
        candidate: recommendation,
        candidateArtifact: rejected.candidateReference,
        branchCoverage: rejected.validatedValue.branchCoverage,
      });
    }
    const rejected = fixture("review-documentation");
    expect(() =>
      createEditorialDecisionPayloadV1(rejected.validatedValue, {
        ...rejected.common,
        producer: rejected.producer,
      }),
    ).toThrowError(expect.objectContaining({ code: "independent-rejection" }));
  });

  it("rejects a changed final when all independent assessments accepted the original", () => {
    const accepted = fixture();
    for (const candidate of ["update", "insufficient-evidence"] as const) {
      expect(() =>
        createEditorialDecisionPayloadV1(
          { ...accepted.validatedValue, candidate },
          { ...accepted.common, producer: accepted.producer },
        ),
      ).toThrowError(expect.objectContaining({ code: "independent-rejection" }));
    }
  });

  it("rejects every reserved final limitation without its exact rejected recommendation", () => {
    const accepted = fixture();
    for (const code of ["product-gap.fabricated", "evidence-limitation.fabricated"] as const) {
      expect(() =>
        createEditorialDecisionPayloadV1(
          {
            ...accepted.validatedValue,
            limitations: [...accepted.validatedValue.limitations, code],
          },
          { ...accepted.common, producer: accepted.producer },
        ),
      ).toThrowError(expect.objectContaining({ code: "independent-rejection" }));
    }

    const rejected = fixture("review-documentation", "accepted", false, "update");
    expect(() =>
      createEditorialDecisionPayloadV1(
        {
          ...rejected.validatedValue,
          candidate: "update",
          limitations: [
            ...rejected.validatedValue.limitations,
            "product-gap.documentation-update-required",
            "product-gap.fabricated",
          ],
        },
        { ...rejected.common, producer: rejected.producer },
      ),
    ).toThrowError(expect.objectContaining({ code: "independent-rejection" }));
  });

  it("requires audience evidence without treating an unavailable audience result as editorial rejection", () => {
    const unavailable = fixture(undefined, "not-applicable");
    expect(() =>
      createEditorialDecisionPayloadV1(unavailable.validatedValue, {
        ...unavailable.common,
        producer: unavailable.producer,
      }),
    ).not.toThrow();

    const rejected = fixture("test-audience-understanding");
    expect(() =>
      createEditorialDecisionPayloadV1(rejected.validatedValue, {
        ...rejected.common,
        producer: rejected.producer,
      }),
    ).toThrowError(expect.objectContaining({ code: "independent-rejection" }));
  });

  // A no-change changes no page, so the quality evaluator may judge no quality
  // and answer not-applicable. The decision admits that answer only when it
  // discloses it; technical verification and review must still accept.
  it("admits the evaluator's not-applicable to a no-change only when the decision discloses it", () => {
    const value = fixture(
      undefined,
      "not-applicable",
      false,
      "insufficient-evidence",
      "evaluate-document-quality",
    );
    const disclosed = createEditorialDecisionPayloadV1(
      {
        ...value.validatedValue,
        limitations: [
          ...value.validatedValue.limitations,
          QUALITY_EVALUATION_NOT_APPLICABLE_LIMITATION,
        ],
      },
      { ...value.common, producer: value.producer },
    );
    expect(disclosed).toMatchObject({ phase: "validated", candidate: "no-change" });
    expect(disclosed.limitations).toContain(QUALITY_EVALUATION_NOT_APPLICABLE_LIMITATION);
    expect(
      decodeEditorialDecisionPayloadV1(JSON.parse(canonicalArtifactJson(disclosed)), {
        ...value.common,
        producer: value.producer,
      }),
    ).toEqual(disclosed);

    let refusal: unknown;
    try {
      createEditorialDecisionPayloadV1(value.validatedValue, {
        ...value.common,
        producer: value.producer,
      });
    } catch (error) {
      refusal = error;
    }
    expect(refusal).toMatchObject({ code: "independent-rejection" });
    expect((refusal as { location?: unknown }).location).toBe(NO_CHANGE_ASSESSMENT_LOCATION);
  });

  it.each(["verify-technical-accuracy", "review-documentation"] as const)(
    "refuses a no-change whose %s answers not-applicable, whatever the decision discloses",
    (stepId) => {
      const value = fixture(undefined, "not-applicable", false, "insufficient-evidence", stepId);
      let refusal: unknown;
      try {
        createEditorialDecisionPayloadV1(
          {
            ...value.validatedValue,
            limitations: [
              ...value.validatedValue.limitations,
              QUALITY_EVALUATION_NOT_APPLICABLE_LIMITATION,
            ],
          },
          { ...value.common, producer: value.producer },
        );
      } catch (error) {
        refusal = error;
      }
      expect(refusal).toMatchObject({ code: "independent-rejection" });
      expect((refusal as { location?: unknown }).location).toBe(NO_CHANGE_ASSESSMENT_LOCATION);
    },
  );

  it("merges more than 32 distinct limitations into a validated decision", () => {
    const value = fixture();
    const many = Array.from({ length: 40 }, (_, index) => `fixture-limitation-${index}`);
    const final = createEditorialDecisionPayloadV1(
      { ...value.validatedValue, limitations: [...value.validatedValue.limitations, ...many] },
      { ...value.common, producer: value.producer },
    );
    expect(final.limitations).toHaveLength(41);
    expect(
      decodeEditorialDecisionPayloadV1(JSON.parse(canonicalArtifactJson(final)), {
        ...value.common,
        producer: value.producer,
      }).limitations,
    ).toHaveLength(41);
  });

  it("accepts changed-source inapplicability only for an identical host-bound comparison", () => {
    const value = fixture(undefined, "accepted", true);
    expect(() =>
      createEditorialDecisionPayloadV1(value.validatedValue, {
        ...value.common,
        producer: value.producer,
      }),
    ).not.toThrow();
  });
});
