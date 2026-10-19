// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { describe, it, expect } from "vitest";
import {
  canonicalJson,
  sealHostRuntimeSemanticComparisonChunk,
  parseHostRuntimeSemanticComparisonProposal,
  type HostRuntimeRequestV1,
} from "../src/host-invoker/contracts.js";
import { semanticComparisonInstruction } from "../src/host-invoker/reconcile-product-behavior.js";
import {
  PRODUCT_REFERENCE_MODEL_TARGET_ID,
  parseSemanticDocumentTargets,
  parseSemanticDocumentProjection,
  semanticDocumentPolicySha256,
  semanticDocumentByteRanges,
} from "../src/host-invoker/semantic-document-projection.js";
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const policy = parseSemanticDocumentTargets({
  schemaVersion: 2,
  kind: "docsfab-product-feedback-document-targets",
  targets: [
    {
      targetId: "requirements",
      path: "planning/requirements.md",
      delivery: "repository-planning",
      sourceKind: "prd",
    },
  ],
});
const content =
  "# Requirements\n\nOrdinary messages require a mention. An unrelated caveat remains.\n";
function fixture(withPolicy = true) {
  const claim = {
    claimId: "CLAIM-MENTION",
    statement: "Ordinary messages require a mention.",
    statementSha256: sha("Ordinary messages require a mention."),
    scope: '{"surface":"ordinary-channel"}',
    recordSha256: sha("synthetic-claim-record"),
  };
  const source = {
    evidenceId: "document",
    kind: "repository-after" as const,
    version: "a".repeat(40),
    sourcePath: "planning/requirements.md",
    change: "modified" as const,
    content,
    contentSha256: sha(content),
    sourceContentSha256: sha(content),
    startByte: 0,
    endByte: Buffer.byteLength(content),
    totalBytes: Buffer.byteLength(content),
    sourceVersionSha256: sha("source-version"),
    repositoryRole: {
      sourceKind: "prd" as const,
      classification: "context" as const,
      coveragePlanSha256: sha("coverage"),
    },
  };
  const chunk = sealHostRuntimeSemanticComparisonChunk({
    schemaVersion: 1,
    kind: "docsfab-semantic-comparison-chunk",
    projectId: "fixture",
    caseKind: "merge",
    caseSha256: sha("case"),
    comparisonSha256: sha("comparison"),
    baselineGeneration: 0,
    baselineSha256: sha("baseline"),
    approvalReceiptSha256: sha("approval"),
    modelSha256: sha("model"),
    canonSha256: sha("model"),
    sourceInventorySha256: sha("inventory"),
    ordinal: 1,
    chunkCount: 1,
    repositoryObservationVersion: 3,
    claims: [claim],
    evidence: [source],
    ...(withPolicy ? { documentTargets: policy } : {}),
  });
  const cite = {
    evidenceId: source.evidenceId,
    startByte: 0,
    endByte: Buffer.byteLength(content),
    sha256: source.contentSha256,
  };
  const documentProjection = {
    schemaVersion: 1,
    kind: "docsfab-claim-document-projection",
    policySha256: semanticDocumentPolicySha256(policy),
    documents: [
      {
        targetId: "requirements",
        path: source.sourcePath,
        sourceRevision: source.version,
        sourceSha256: source.sourceContentSha256,
        impact: "update",
        explanation: "Explicit synthetic paragraph placement, not semantic approval.",
        citations: [cite],
        placement: {
          heading: null,
          beforeText: "Ordinary messages require a mention. An unrelated caveat remains.",
          selection: {
            kind: "claim-span",
            startByte: 0,
            endByte: Buffer.byteLength("Ordinary messages require a mention. "),
            beforeText: "Ordinary messages require a mention. ",
          },
        },
      },
    ],
  };
  const proposal = {
    schemaVersion: 1,
    kind: "docsfab-semantic-comparison-proposal",
    inputSha256: chunk.inputSha256,
    assessments: [
      {
        evidenceId: source.evidenceId,
        claimId: claim.claimId,
        relationship: "intent-conflict",
        assertion: "proposed-intent",
        explanation: "Synthetic exact proposed intent.",
        scope: "configured pilot",
        confidence: "high",
        modelCitation: {
          evidenceId: claim.claimId,
          startByte: 0,
          endByte: Buffer.byteLength(claim.statement),
          sha256: claim.statementSha256,
        },
        sourceCitations: [cite],
        proposedClaim: {
          statement: "Only the configured pilot allows replies without mentions.",
          scope: { surface: "pilot" },
        },
        ...(withPolicy ? { documentProjection } : {}),
      },
    ],
    missingEvidence: [],
  };
  return { chunk, proposal, documentProjection };
}
describe("source-bound document projections", () => {
  it.each(["root", "nested containers"])(
    "freezes targets and placements below pre-frozen %s",
    (mode) => {
      const targets = structuredClone(policy);
      const projection = structuredClone(fixture().documentProjection);
      if (mode === "root") {
        Object.freeze(targets);
        Object.freeze(projection);
      } else {
        Object.freeze(targets.targets);
        Object.freeze(projection.documents);
        Object.freeze(projection.documents[0]!.placement);
      }
      expect(parseSemanticDocumentTargets(targets)).toBe(targets);
      expect(parseSemanticDocumentProjection(projection)).toBe(projection);
      expect(Reflect.set(targets.targets[0]!, "path", "docs/changed.md")).toBe(false);
      const document = projection.documents[0]!;
      expect(Reflect.set(document, "path", "planning/changed.md")).toBe(false);
      expect(Reflect.set(document.citations[0]!, "endByte", 0)).toBe(false);
      expect(Reflect.set(document.placement!.selection, "kind", "changed")).toBe(false);
    },
  );
  it("binds configured targets, complete current bytes and exact proposed placement as data", () => {
    const { chunk, proposal } = fixture();
    expect(
      parseHostRuntimeSemanticComparisonProposal(proposal, chunk).assessments[0]!
        .documentProjection,
    ).toEqual(proposal.assessments[0]!.documentProjection);
    expect(
      semanticComparisonInstruction({
        workflow: "reconcile-product-behavior",
        packet: { semanticComparison: chunk },
      } as HostRuntimeRequestV1),
    ).toContain(semanticDocumentPolicySha256(policy));
  });
  it("refuses policy/path/ref/hash/citation changes before an owner-ready result", () => {
    const { chunk, proposal } = fixture();
    const edits: Array<(row: any) => void> = [
      (row) => (row.assessments[0].documentProjection.policySha256 = sha("foreign")),
      (row) => (row.assessments[0].documentProjection.documents[0].path = "planning/foreign.md"),
      (row) => (row.assessments[0].documentProjection.documents[0].sourceRevision = "b".repeat(40)),
      (row) => (row.assessments[0].documentProjection.documents[0].sourceSha256 = sha("foreign")),
      (row) => row.assessments[0].documentProjection.documents[0].citations[0].endByte--,
      (row) => (row.assessments[0].documentProjection.documents = []),
      (row) => (row.assessments[0].documentProjection.documents[0].newWriteGrant = true),
    ];
    for (const edit of edits) {
      const bad = structuredClone(proposal);
      edit(bad);
      expect(() => parseHostRuntimeSemanticComparisonProposal(bad, chunk)).toThrow();
    }
    // Adjacent condition: a proposal with no document plan is dropped and named; the
    // assessment stands as a conflict with no exact alternative, and the reply is kept.
    const planless = structuredClone(proposal);
    delete planless.assessments[0].documentProjection;
    const parsed = parseHostRuntimeSemanticComparisonProposal(planless, chunk);
    expect(parsed.assessments).toHaveLength(proposal.assessments.length);
    expect(Object.hasOwn(parsed.assessments[0]!, "proposedClaim")).toBe(false);
    expect(parsed.assessments[0]!.relationship).toBe(proposal.assessments[0]!.relationship);
    expect(parsed.missingEvidence).toContain(
      `The comparison proposed a claim for ${proposal.assessments[0]!.claimId} without its document plan; the proposal was dropped.`,
    );
    const legacy = fixture(false);
    expect(() =>
      parseHostRuntimeSemanticComparisonProposal(
        { ...proposal, inputSha256: legacy.chunk.inputSha256 },
        legacy.chunk,
      ),
    ).toThrow();
  });
  it("no-impact needs the same full current source coverage and cannot stand in for unavailable fragments", () => {
    const { chunk, proposal } = fixture();
    const value = structuredClone(proposal);
    Object.assign(value.assessments[0]!.documentProjection!.documents[0]!, {
      impact: "none",
      placement: null,
    });
    expect(
      parseHostRuntimeSemanticComparisonProposal(value, chunk).assessments[0]!.documentProjection!
        .documents[0]!.impact,
    ).toBe("none");
    const { inputSha256: _, ...body } = chunk;
    const fragmented = sealHostRuntimeSemanticComparisonChunk({
      ...body,
      evidence: [
        {
          ...body.evidence[0]!,
          content: content.slice(0, 15),
          contentSha256: sha(content.slice(0, 15)),
          endByte: 15,
        },
      ],
    });
    const edited = structuredClone(value);
    edited.inputSha256 = fragmented.inputSha256;
    edited.assessments[0]!.sourceCitations[0] = {
      evidenceId: "document",
      startByte: 0,
      endByte: 15,
      sha256: sha(content.slice(0, 15)),
    };
    edited.assessments[0]!.documentProjection!.documents[0]!.citations = [
      edited.assessments[0]!.sourceCitations[0]!,
    ];
    expect(() => parseHostRuntimeSemanticComparisonProposal(edited, fragmented)).toThrow();
  });
  it("refuses the product reference model package id as a configured document target", () => {
    const named = (targetId: string, second = false) => ({
      ...policy,
      targets: second
        ? [
            { ...policy.targets[0]!, targetId: "a-first-document" },
            { ...policy.targets[0]!, targetId, path: "planning/second.md" },
          ]
        : [{ ...policy.targets[0]!, targetId }],
    });
    // Positive controls: any other identifier, first or second, still parses.
    expect(parseSemanticDocumentTargets(named("product-requirements")).targets[0]!.targetId).toBe(
      "product-requirements",
    );
    expect(parseSemanticDocumentTargets(named("zz-document", true)).targets[1]!.targetId).toBe(
      "zz-document",
    );
    for (const second of [false, true])
      expect(() => parseSemanticDocumentTargets(named("product-reference-model", second))).toThrow(
        "Hosted runtime rejected: semantic-document-projection.",
      );
    expect(PRODUCT_REFERENCE_MODEL_TARGET_ID).toBe("product-reference-model");
  });
  it("refuses Fern and navigation paths as candidate document authority", () => {
    for (const path of ["fern/docs.yml", "fern/guide.md", "README.md", "docs/../fern/guide.md"])
      expect(() =>
        parseSemanticDocumentTargets({ ...policy, targets: [{ ...policy.targets[0]!, path }] }),
      ).toThrow();
  });
  it("preserves identical source aliases as distinct citations while reconstructing bytes once", () => {
    const { chunk, proposal } = fixture();
    const { inputSha256: _, ...body } = chunk;
    const alias = { ...body.evidence[0]!, evidenceId: "document-alias" };
    const repeated = sealHostRuntimeSemanticComparisonChunk({
      ...body,
      evidence: [body.evidence[0]!, alias],
    });
    const next = structuredClone(proposal);
    next.inputSha256 = repeated.inputSha256;
    next.assessments[0]!.documentProjection!.documents[0]!.citations.push({
      evidenceId: alias.evidenceId,
      startByte: 0,
      endByte: Buffer.byteLength(alias.content),
      sha256: alias.contentSha256,
    });
    next.assessments.push({
      ...structuredClone(next.assessments[0]!),
      evidenceId: alias.evidenceId,
      sourceCitations: [
        {
          evidenceId: alias.evidenceId,
          startByte: 0,
          endByte: Buffer.byteLength(alias.content),
          sha256: alias.contentSha256,
        },
      ],
    });
    const parsed = parseHostRuntimeSemanticComparisonProposal(next, repeated);
    expect(parsed.assessments).toHaveLength(2);
    expect(parsed.assessments[0]!.documentProjection!.documents[0]!.citations).toHaveLength(2);
    expect(semanticDocumentByteRanges(repeated.evidence)).toHaveLength(1);
    expect(() =>
      semanticDocumentByteRanges([
        body.evidence[0]!,
        { ...alias, contentSha256: sha("different") },
      ]),
    ).toThrow();
    expect(() => semanticDocumentByteRanges([{ ...alias, startByte: 1 }])).toThrow();
    expect(() =>
      semanticDocumentByteRanges([body.evidence[0]!, { ...alias, startByte: 1 }]),
    ).toThrow();
  });
  it("rejects active fields without invoking getters", () => {
    let reads = 0;
    const input = {
      schemaVersion: 2,
      kind: "docsfab-product-feedback-document-targets",
      get targets() {
        reads++;
        return policy.targets;
      },
    };
    expect(() => parseSemanticDocumentTargets(input)).toThrow();
    expect(reads).toBe(0);
  });
  it("keeps the historical absent-policy instruction bytes pinned", () => {
    const { chunk } = fixture(false);
    const instruction = semanticComparisonInstruction({
      workflow: "reconcile-product-behavior",
      packet: { semanticComparison: chunk },
    } as HostRuntimeRequestV1)!;
    expect(sha(instruction)).toBe(
      "bb38b3d07b47462620d09a0276a5df8b1b8fb837818878ff0f06ec60355debb5",
    );
  });
});
