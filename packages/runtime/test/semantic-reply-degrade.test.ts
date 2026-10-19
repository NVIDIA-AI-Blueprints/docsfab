// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  parseHostRuntimeSemanticComparisonProposal,
  sealHostRuntimeSemanticComparisonChunk,
  type HostRuntimeRequestV1,
  type HostRuntimeSemanticComparisonChunkV1,
} from "../src/host-invoker/contracts.js";
import { buildHostRuntimeFailureRecord } from "../src/host-invoker/main.js";
import {
  decodeSemanticComparisonProposal,
  SemanticComparisonReplyError,
  semanticComparisonReplyHarness,
  validateSemanticComparisonRun,
} from "../src/host-invoker/reconcile-product-behavior.js";
import { InferenceStepError, type HarnessStepInput } from "../src/execution/contracts.js";
import type { RunRecord } from "../src/records/contracts.js";
import { collectCredentialFindings } from "../src/security/credential-shape-findings.js";
import {
  clearPlantedCredential,
  plainConfiguredCredential,
  plantConfiguredCredential,
} from "./helpers/planted-configured-credential.js";

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const statement = "Ordinary messages require an explicit mention before a reply.";
const claimScope = '{"component":"ordinary messages","horizon":"current plan"}';
const before = "export const requiresMention = true;\n";
const after = "export const requiresMention = false;\n";

function chunk(): HostRuntimeSemanticComparisonChunkV1 {
  const fragment = (
    evidenceId: string,
    kind: "repository-before" | "repository-after",
    content: string,
  ) => ({
    evidenceId,
    kind,
    version: kind === "repository-before" ? "a".repeat(40) : "b".repeat(40),
    sourcePath: "source.ts",
    change: "modified" as const,
    content,
    contentSha256: sha(content),
    sourceContentSha256: sha(content),
    startByte: 0,
    endByte: Buffer.byteLength(content),
    totalBytes: Buffer.byteLength(content),
    sourceVersionSha256: null,
  });
  return sealHostRuntimeSemanticComparisonChunk({
    schemaVersion: 1,
    kind: "docsfab-semantic-comparison-chunk",
    projectId: "project-fixture",
    caseKind: "merge",
    caseSha256: sha("case"),
    comparisonSha256: sha("comparison"),
    baselineGeneration: 1,
    baselineSha256: sha("baseline"),
    approvalReceiptSha256: sha("approval"),
    modelSha256: sha("model"),
    canonSha256: sha("model"),
    sourceInventorySha256: sha("inventory"),
    ordinal: 1,
    chunkCount: 1,
    claims: [
      {
        claimId: "CLAIM-MENTION",
        statement,
        statementSha256: sha(statement),
        scope: claimScope,
        recordSha256: sha("record"),
      },
    ],
    evidence: [
      fragment("before", "repository-before", before),
      fragment("after", "repository-after", after),
    ],
  });
}

function assessment(evidenceId: string, content: string, overrides: Record<string, unknown> = {}) {
  return {
    evidenceId,
    claimId: "CLAIM-MENTION",
    relationship: "intent-conflict",
    assertion: "observed-implementation",
    explanation: "The after source removes the mention prerequisite the claim states.",
    scope: "This merge only.",
    confidence: "high",
    modelCitation: { evidenceId: "CLAIM-MENTION", quote: statement },
    sourceCitations: [{ evidenceId, quote: content }],
    ...overrides,
  };
}

const reply = (...assessments: unknown[]) => ({ assessments, missingEvidence: [] });

function semanticRequest(input: HostRuntimeSemanticComparisonChunkV1): HostRuntimeRequestV1 {
  return {
    workflow: "reconcile-product-behavior",
    runId: "run-semantic-reply",
    revision: "b".repeat(40),
    packet: { semanticComparison: input, reviewScope: null, canon: null },
  } as unknown as HostRuntimeRequestV1;
}

function succeededRecord(summary: string): RunRecord {
  return {
    status: "succeeded",
    steps: [{ id: "compare-product-behavior", summary }],
  } as unknown as RunRecord;
}

describe("semantic comparison reply degrade", () => {
  it("keeps strict JSON refusal codes for duplicate keys, trailing commas, and two objects", () => {
    const input = chunk();
    const body = '{"assessments":[],"missingEvidence":[]}';
    for (const refused of [
      '{"assessments":[],"assessments":[],"missingEvidence":[]}',
      '{"assessments":[],"missingEvidence":[],}',
      `${body} ${body}`,
    ]) {
      expect(() => decodeSemanticComparisonProposal(refused, input)).toThrow(
        /semantic-proposal-not-json/u,
      );
    }
    expect(decodeSemanticComparisonProposal(body, input).assessments).toEqual([]);
  });

  it("retains a bounded, redacted refusal shape and excerpt at the host attempt seam", async () => {
    const input = chunk();
    const marker = plantConfiguredCredential(plainConfiguredCredential("comparison-reply"));
    const refusedReply = `not JSON ${marker} {"assessments":[],}`;
    try {
      const harness = semanticComparisonReplyHarness(
        {
          async runStep() {
            return { summary: refusedReply };
          },
        },
        semanticRequest(input),
      );
      let thrown: unknown;
      try {
        await harness.runStep({ step: { id: "compare-product-behavior" } } as HarnessStepInput);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(InferenceStepError);
      const rejection = thrown as InferenceStepError;
      expect(rejection.retryable).toBe(false);
      expect(rejection.rejection).toEqual({
        code: "semantic-proposal-not-json",
        location: "$.compareProductBehavior",
      });
      expect(rejection.rejectedReplyShape).toBeDefined();
      expect(rejection.rejectedReplyExcerpt?.bound).toBeGreaterThan(0);
      expect(rejection.rejectedReplyExcerpt?.limit).toBe("inference.rejectedReplyExcerptChars");
      expect(JSON.stringify(rejection.rejectedReplyExcerpt)).not.toContain(marker);
      const failure = buildHostRuntimeFailureRecord(
        semanticRequest(input),
        new SemanticComparisonReplyError(
          rejection.rejection!.code,
          rejection.rejectedReplyShape,
          rejection.rejectedReplyExcerpt,
        ),
      );
      expect(failure.code).toBe("semantic-reply-proposal-not-json");
      expect(failure.rejectedReplyShape).toEqual(rejection.rejectedReplyShape);
      expect(failure.rejectedReplyExcerpt).toEqual(rejection.rejectedReplyExcerpt);
      expect(JSON.stringify(failure)).not.toContain(marker);
    } finally {
      clearPlantedCredential();
    }
  });

  it("normalizes empty optional reply lists through the host-side run projection", () => {
    const input = chunk();
    const base = reply(assessment("before", before), assessment("after", after));
    for (const absent of [[], null]) {
      const projected = validateSemanticComparisonRun(
        succeededRecord(
          JSON.stringify({
            ...base,
            ownerInformationRequests: absent,
            acceptedEffectAssessments: absent,
          }),
        ),
        semanticRequest(input),
      );
      const normalized = JSON.parse(projected.steps[0]!.summary!);
      expect(Object.hasOwn(normalized, "ownerInformationRequests")).toBe(false);
      expect(Object.hasOwn(normalized, "acceptedEffectAssessments")).toBe(false);
      expect(normalized.assessments.map((row: { evidenceId: string }) => row.evidenceId)).toEqual([
        "before",
        "after",
      ]);
    }
  });

  it("admits a proposed claim whose scope copies the claim's JSON-text scope", () => {
    const input = chunk();
    const proposal = parseHostRuntimeSemanticComparisonProposal(
      reply(
        assessment("before", before),
        assessment("after", after, {
          proposedClaim: { statement: "Replies need no mention.", scope: claimScope },
        }),
      ),
      input,
    );
    const admitted = proposal.assessments.find((row) => row.evidenceId === "after")!;
    expect(admitted.proposedClaim).toEqual({
      statement: "Replies need no mention.",
      scope: JSON.parse(claimScope),
    });
    expect(proposal.missingEvidence).toEqual([]);
  });

  it("admits an assessment scope written as the claim's structured scope object", () => {
    const input = chunk();
    const scope = JSON.parse(claimScope);
    const proposal = parseHostRuntimeSemanticComparisonProposal(
      reply(
        assessment("before", before, { relationship: "compatible", scope }),
        assessment("after", after, {
          relationship: "behavior-conflict",
          scope,
          proposedClaim: { statement: "Replies need no mention.", scope },
        }),
      ),
      input,
    );
    expect(proposal.assessments.map((row) => row.scope)).toEqual([claimScope, claimScope]);
    expect(proposal.assessments[1]!.proposedClaim?.scope).toEqual(scope);
    expect(proposal.missingEvidence).toEqual([]);
    expect(
      parseHostRuntimeSemanticComparisonProposal(JSON.parse(JSON.stringify(proposal)), input),
    ).toEqual(proposal);
  });

  it("keeps the approved scope, and names it, when a proposed scope is prose", () => {
    const input = chunk();
    const proposal = parseHostRuntimeSemanticComparisonProposal(
      reply(
        assessment("before", before),
        assessment("after", after, {
          proposedClaim: { statement: "Replies need no mention.", scope: "the pilot" },
        }),
      ),
      input,
    );
    expect(
      proposal.assessments.find((row) => row.evidenceId === "after")!.proposedClaim?.scope,
    ).toEqual(JSON.parse(claimScope));
    expect(proposal.missingEvidence).toEqual([
      "The comparison kept the approved scope of CLAIM-MENTION for its proposed claim.",
    ]);
  });

  it("folds the casing of enumerated values instead of refusing them", () => {
    const input = chunk();
    const proposal = parseHostRuntimeSemanticComparisonProposal(
      reply(
        assessment("before", before, { confidence: "Medium", relationship: " Behavior-Conflict" }),
        assessment("after", after, { assertion: "OBSERVED-IMPLEMENTATION" }),
      ),
      input,
    );
    expect(proposal.assessments).toHaveLength(2);
    expect(proposal.assessments[0]).toMatchObject({
      confidence: "medium",
      relationship: "behavior-conflict",
    });
    expect(proposal.assessments[1]!.assertion).toBe("observed-implementation");
    expect(proposal.missingEvidence).toEqual([]);
  });

  it("drops only the refused assessment, names it, and parses its own result again unchanged", () => {
    const input = chunk();
    const proposal = parseHostRuntimeSemanticComparisonProposal(
      reply(assessment("before", before), assessment("after", after, { claimId: "CLAIM-UNKNOWN" })),
      input,
    );
    expect(proposal.assessments.map((row) => row.evidenceId)).toEqual(["before"]);
    expect(proposal.missingEvidence).toEqual([
      "The comparison dropped an assessment of after (semantic-assessment-membership).",
      "The comparison did not assess 1 supplied evidence fragment(s).",
    ]);
    expect(
      parseHostRuntimeSemanticComparisonProposal(JSON.parse(JSON.stringify(proposal)), input),
    ).toEqual(proposal);
  });

  it("names an undeclared evidence ID generically", () => {
    const proposal = parseHostRuntimeSemanticComparisonProposal(
      reply(
        assessment("before", before),
        assessment("after", after),
        assessment("elsewhere", after),
      ),
      chunk(),
    );
    expect(proposal.assessments).toHaveLength(2);
    expect(proposal.missingEvidence).toEqual([
      "The comparison dropped an assessment of undeclared evidence (semantic-assessment-membership).",
    ]);
  });

  it("still refuses the whole reply when an assessment carries a configured credential", () => {
    // DocsFab's own configured credential, which looks like no credential, so
    // only the exact match can refuse the reply (#1807).
    const marker = plantConfiguredCredential();
    try {
      expect(() =>
        parseHostRuntimeSemanticComparisonProposal(
          reply(assessment("before", before), assessment("after", after, { explanation: marker })),
          chunk(),
        ),
      ).toThrow(/credential/u);
    } finally {
      clearPlantedCredential();
    }
  });

  it("keeps a reply whose assessment only looks like it carries a credential and records the shape, #1807", () => {
    const marker = "glpat-" + "h".repeat(40);
    const { result, findings } = collectCredentialFindings(() =>
      parseHostRuntimeSemanticComparisonProposal(
        reply(assessment("before", before), assessment("after", after, { explanation: marker })),
        chunk(),
      ),
    );
    expect(result.assessments.map((row) => row.explanation)).toContain(marker);
    expect(findings.map((finding) => finding.location)).toContain(
      "hosted-semantic:comparisonProposal",
    );
  });

  it("records a truncated reply as a coded model-content failure", () => {
    const input = chunk();
    const request = semanticRequest(input);
    const truncated = JSON.stringify(reply(assessment("before", before))).slice(0, 120);
    let thrown: unknown;
    try {
      validateSemanticComparisonRun(succeededRecord(truncated), request);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(SemanticComparisonReplyError);
    const record = buildHostRuntimeFailureRecord(request, thrown, "workflow-execution");
    expect(record).toMatchObject({
      failurePhase: "workflow-execution",
      code: "semantic-reply-proposal-not-json",
      failure: {
        class: "model-content",
        layer: "workflow",
        code: "semantic-reply-proposal-not-json",
      },
    });
  });

  it("records a reply with no assessment list under its binding code", () => {
    const input = chunk();
    const request = semanticRequest(input);
    let thrown: unknown;
    try {
      validateSemanticComparisonRun(
        succeededRecord(JSON.stringify({ missingEvidence: [] })),
        request,
      );
    } catch (error) {
      thrown = error;
    }
    expect(buildHostRuntimeFailureRecord(request, thrown).code).toBe(
      "semantic-reply-proposal-binding",
    );
  });

  it("keeps the uncoded fallback for any other error that claims a reply code", () => {
    const request = semanticRequest(chunk());
    const impostor = Object.assign(new Error("not a reply refusal"), {
      code: "semantic-reply-proposal-not-json",
    });
    expect(buildHostRuntimeFailureRecord(request, impostor)).toMatchObject({
      code: "execution-failed",
      failure: { class: "unknown", code: "execution-failed" },
    });
    expect(
      buildHostRuntimeFailureRecord(
        request,
        new SemanticComparisonReplyError("semantic-proposal-binding"),
        "terminal-sealing",
      ).code,
    ).toBe("terminal-sealing-failed");
    let getterCalls = 0;
    const hostile = new SemanticComparisonReplyError("semantic-proposal-binding");
    Object.defineProperty(hostile, "rejectedReplyShape", {
      get() {
        getterCalls += 1;
        throw new Error("diagnostic getter must not run");
      },
    });
    const safelyClassed = buildHostRuntimeFailureRecord(request, hostile);
    expect(safelyClassed.code).toBe("semantic-reply-proposal-binding");
    expect(safelyClassed.rejectedReplyShape).toBeUndefined();
    expect(getterCalls).toBe(0);
  });
});
