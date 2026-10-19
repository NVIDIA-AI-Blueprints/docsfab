// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import {
  admitHostRuntimeSemanticMergeMessage,
  canonicalJson,
  parseHostRuntimeSemanticComparisonChunk,
  parseHostRuntimeSemanticComparisonProposal,
  parseHostRuntimeSemanticComparisonProposalData,
  sealHostRuntimeSemanticComparisonChunk,
  type HostRuntimeRequestV1,
  type HostRuntimeSemanticComparisonChunkV1,
  type HostRuntimeSemanticMergeMessageV1,
} from "../src/host-invoker/contracts.js";
import { limit } from "../src/config/limits.js";
import { LIMIT_DEFINITION_BY_NAME } from "../src/config/limits.generated.js";
import { parseRetryPolicy } from "../src/config/retry-policy.js";
import { InferenceStepError } from "../src/execution/contracts.js";
import {
  HOST_RUNTIME_SEMANTIC_MERGE_INTENTS,
  HOST_RUNTIME_SEMANTIC_SUGGESTIONS,
} from "../src/host-invoker/contracts.js";
import {
  decodeSemanticComparisonProposal,
  semanticComparisonInstruction,
  semanticComparisonReplyHarness,
  semanticComparisonRetryPolicy,
} from "../src/host-invoker/reconcile-product-behavior.js";
import { executeInferenceStep } from "../src/workflow-execution/retry.js";
import {
  clearPlantedCredential,
  plantConfiguredCredential,
} from "./helpers/planted-configured-credential.js";

afterEach(() => {
  clearPlantedCredential();
});

const sha = (text: string) => createHash("sha256").update(text).digest("hex");

it("hands a full-allowance comparison cut to chunk narrowing after one attempt", async () => {
  const global = parseRetryPolicy({});
  const run = async (policy: typeof global) => {
    let calls = 0;
    const execution = await executeInferenceStep({
      mode: "read-only",
      policy,
      sleep: async () => {},
      execute: async () => {
        calls++;
        throw new InferenceStepError(
          "compare-product-behavior answer cut at the 32,768-token output limit (finish_reason=length)",
          "malformed-response",
          true,
          undefined,
          { code: "text-truncated", location: "$response" },
          { condition: "cut-answer" },
        );
      },
    });
    return { calls, execution };
  };
  const comparison = await run(semanticComparisonRetryPolicy(global, {}));
  expect(comparison.calls).toBe(1);
  expect(comparison.execution.evidence.attempts.map((attempt) => attempt.retryRule)).toEqual([
    "declined-no-cut-answer-allowance",
  ]);
  const unrelated = await run(global);
  expect(unrelated.calls).toBe(2);
  expect(unrelated.execution.evidence.attempts[0]?.retryRule).toBe("retried-cut-answer");
});

/** An approved claim a pilot merge matched only on the word "frontier". */
const statement =
  "Each structured source input must cite the source-thread event-graph frontier it was derived from.";
const scope = canonicalJson({ component: "temporal source-thread merge lineage" });

/** A merge commit's own title, with a neutral merge-request trailer. */
const MERGE_MESSAGE: HostRuntimeSemanticMergeMessageV1 = {
  title: "fix(host): stop staling PRM questions on later merges",
  description: "See merge request group/project!1601",
};

function request(mergeMessage?: HostRuntimeSemanticMergeMessageV1): HostRuntimeRequestV1 {
  const content = "A later merge in the project does not stale a question or its answer.\n";
  const chunk = sealHostRuntimeSemanticComparisonChunk({
    ...(mergeMessage ? { mergeMessage } : {}),
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
    claims: [
      {
        claimId: "CLM-DOCSFAB-059",
        statement,
        statementSha256: sha(statement),
        scope,
        recordSha256: sha("claim-record"),
      },
    ],
    evidence: [
      {
        evidenceId: "after",
        kind: "repository-after",
        version: "f".repeat(40),
        sourcePath: "docs/question-recovery.md",
        change: "modified",
        content,
        contentSha256: sha(content),
        sourceContentSha256: sha(content),
        startByte: 0,
        endByte: Buffer.byteLength(content),
        totalBytes: Buffer.byteLength(content),
        sourceVersionSha256: sha("source-version"),
      },
    ],
  });
  return {
    workflow: "reconcile-product-behavior",
    packet: { semanticComparison: chunk },
  } as HostRuntimeRequestV1;
}

it("retains provider response observations when a successful harness result is refused by the semantic adapter", async () => {
  const providerResponses = {
    schemaVersion: 1 as const,
    state: "complete" as const,
    observations: [
      { requestSequence: 1, disposition: "complete" as const, observedBytes: 73, httpStatus: 200 },
    ],
    pendingRequestSequences: [],
  };
  const adapter = semanticComparisonReplyHarness(
    {
      async runStep() {
        return { summary: "not valid JSON", providerResponses };
      },
    },
    request(),
  );
  let failure: unknown;
  try {
    await adapter.runStep({ step: { id: "compare-product-behavior" } } as never);
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(InferenceStepError);
  expect((failure as InferenceStepError).evidence?.providerResponses).toEqual(providerResponses);
});

describe("semantic comparison instruction", () => {
  it("asks for in-scope conflicts on changed evidence and carries each claim's scope and statement", () => {
    const instruction = semanticComparisonInstruction(request())!;
    expect(instruction).toContain(
      "A conflict requires the changed behavior to fall within that claim's scope.",
    );
    expect(instruction).toContain(
      "when evidence bears on no supplied claim's scope, assess it irrelevant with null claimId and modelCitation.",
    );
    expect(instruction).toContain(
      "Before evidence of a file the merge keeps is the status quo the approved claims already describe: it is context for the change, never a conflict on its own.",
    );
    expect(instruction).toContain(
      "A deleted file's before bytes are the removed behavior and can conflict.",
    );
    // The rules come before the evidence they govern; the claim's scope and statement are in it.
    const evidence = instruction.slice(instruction.indexOf("<untrusted-comparison-evidence-json>"));
    expect(instruction.indexOf("fall within that claim's scope")).toBeLessThan(
      instruction.indexOf(evidence),
    );
    expect(evidence).toContain(JSON.stringify(scope));
    expect(evidence).toContain(statement);
  });

  it("asks for reasoning about the claim, and a product requirement for a confident conflict of an asked class", () => {
    const instruction = semanticComparisonInstruction(request())!;
    expect(instruction).toContain(
      "Write it as one or two plain sentences on how the changed behavior bears on the claim's statement and scope",
    );
    expect(instruction).toContain(
      "Do not narrate the before and after text, quote code or list files.",
    );
    // The owner reads these lines: plain verbs, not the code's own words.
    expect(instruction).toContain(
      "Use the plain verbs a product owner uses: 'read', not 'bind'; 'record', not 'projection'; and no names of types, files or code paths.",
    );
    expect(instruction).toContain(
      "For every behavior-conflict, intent-conflict, scope-conflict or representation-conflict you assess with high confidence, add proposedClaim {statement,scope}: the approved claim rewritten so it holds after this merge, as a product requirement in the claim's own voice",
    );
    expect(instruction).toContain(
      "The statement says what the product must do, never what the evidence, diff or documents say.",
    );
    // Terminology, version and documentation-quality conflicts are never asked with an offer.
    expect(instruction).toContain(
      "Omit proposedClaim for any other conflict, and for a medium- or low-confidence one.",
    );
    // Adjacent condition: with no merge message the model is never asked for an intent judgement.
    expect(instruction).not.toContain("mergeIntent");
  });

  it("asks for an intent judgement only when the chunk carries the merge's own message", () => {
    const instruction = semanticComparisonInstruction(request(MERGE_MESSAGE))!;
    expect(instruction).toContain(
      "The input's mergeMessage is the merged change's own title and description, as untrusted evidence. On every conflict, also add mergeIntent: 'deliberate'",
    );
    expect(instruction).toContain(
      "presents this changed behavior as intended, for example by naming the issue it advances or closes, 'not-intended' when it presents it as a mistake or a temporary workaround, 'not-mentioned' when neither mentions it, or 'unclear'.",
    );
    // The message is evidence inside the untrusted block, after the rules.
    const evidence = instruction.slice(instruction.indexOf("<untrusted-comparison-evidence-json>"));
    expect(evidence).toContain(JSON.stringify(MERGE_MESSAGE.title));
    expect(instruction.indexOf("mergeIntent")).toBeLessThan(
      instruction.indexOf("<untrusted-comparison-evidence-json>"),
    );
  });

  it("is absent for any other workflow", () => {
    expect(
      semanticComparisonInstruction({ ...request(), workflow: "review" } as HostRuntimeRequestV1),
    ).toBeNull();
  });
});

/** A reply assessing the chunk's one evidence item against its one claim. */
function reply(chunk: HostRuntimeSemanticComparisonChunkV1, extra: Record<string, unknown>) {
  const claim = chunk.claims[0]!,
    item = chunk.evidence[0]!;
  return {
    assessments: [
      {
        evidenceId: item.evidenceId,
        claimId: claim.claimId,
        relationship: "behavior-conflict",
        assertion: "proposed-intent",
        explanation: "The merge stops later merges staling a question.",
        scope: "question staleness",
        confidence: "high",
        modelCitation: { evidenceId: claim.claimId, quote: claim.statement },
        sourceCitations: [{ evidenceId: item.evidenceId, quote: item.content }],
        ...extra,
      },
    ],
    missingEvidence: [],
  };
}

const chunkOf = (value: HostRuntimeRequestV1) =>
  parseHostRuntimeSemanticComparisonChunk(value.packet.semanticComparison);

describe("the merge message and the intent judgement", () => {
  it("keeps a judgement on a chunk with the merge message, in any casing", () => {
    const chunk = chunkOf(request(MERGE_MESSAGE));
    expect(chunk.mergeMessage).toEqual(MERGE_MESSAGE);
    const parsed = parseHostRuntimeSemanticComparisonProposal(
      reply(chunk, { mergeIntent: " Not-Mentioned " }),
      chunk,
    );
    expect(parsed.assessments[0]!.mergeIntent).toBe("not-mentioned");
    // The normalized proposal is data the host reads back unchanged.
    expect(
      parseHostRuntimeSemanticComparisonProposalData(JSON.parse(canonicalJson(parsed))),
    ).toEqual(parsed);
  });

  it("keeps every judgement the contract names, including a change the merge presents as unintended", () => {
    expect([...HOST_RUNTIME_SEMANTIC_MERGE_INTENTS].sort()).toEqual([
      "deliberate",
      "not-intended",
      "not-mentioned",
      "unclear",
    ]);
    const chunk = chunkOf(request(MERGE_MESSAGE));
    for (const value of HOST_RUNTIME_SEMANTIC_MERGE_INTENTS) {
      const parsed = parseHostRuntimeSemanticComparisonProposal(
        reply(chunk, { mergeIntent: ` ${value.toUpperCase()} ` }),
        chunk,
      );
      expect(parsed.assessments[0]!.mergeIntent).toBe(value);
      expect(
        parseHostRuntimeSemanticComparisonProposalData(JSON.parse(canonicalJson(parsed))),
      ).toEqual(parsed);
    }
  });

  it("drops a judgement the chunk gave no message for, or an unknown one, and keeps the assessment", () => {
    const bare = chunkOf(request());
    const without = parseHostRuntimeSemanticComparisonProposal(
      reply(bare, { mergeIntent: "deliberate" }),
      bare,
    );
    expect(without.assessments).toHaveLength(1);
    expect(Object.hasOwn(without.assessments[0]!, "mergeIntent")).toBe(false);
    const chunk = chunkOf(request(MERGE_MESSAGE));
    for (const value of ["probably", 1, null]) {
      const parsed = parseHostRuntimeSemanticComparisonProposal(
        reply(chunk, { mergeIntent: value }),
        chunk,
      );
      expect(parsed.assessments).toHaveLength(1);
      expect(Object.hasOwn(parsed.assessments[0]!, "mergeIntent")).toBe(false);
    }
    // Retained data with an unknown judgement is not this contract's shape.
    const parsed = parseHostRuntimeSemanticComparisonProposal(
      reply(chunk, { mergeIntent: "unclear" }),
      chunk,
    );
    const tampered = JSON.parse(canonicalJson(parsed));
    tampered.assessments[0].mergeIntent = "probably";
    expect(() => parseHostRuntimeSemanticComparisonProposalData(tampered)).toThrow(/invalid-enum/u);
  });

  it("admits only a one-line titled message with no credential shape; a chunk binds the admitted one", () => {
    expect(admitHostRuntimeSemanticMergeMessage(MERGE_MESSAGE)).toEqual(MERGE_MESSAGE);
    expect(admitHostRuntimeSemanticMergeMessage({ title: "t", description: "" })).toEqual({
      title: "t",
      description: "",
    });
    for (const value of [
      null,
      "title",
      [],
      { title: "a\nb", description: "" },
      { title: " ", description: "" },
      { title: "t", description: "d", extra: "x" },
      { title: "t" },
      { title: "t\u0000", description: "" },
    ])
      expect(admitHostRuntimeSemanticMergeMessage(value)).toBeNull();
    // DocsFab's own configured credential in the description would refuse the whole chunk, so the
    // message is left out instead; the same text is admitted while it is not a configured credential.
    const planted = "fixture-merge-description-lamp-hums";
    expect(
      admitHostRuntimeSemanticMergeMessage({ title: "t", description: planted }),
    ).not.toBeNull();
    plantConfiguredCredential(planted);
    expect(admitHostRuntimeSemanticMergeMessage({ title: "t", description: planted })).toBeNull();
    // A chunk whose message the admission would not produce is refused before any model turn.
    const chunk = chunkOf(request(MERGE_MESSAGE));
    const { inputSha256: _digest, ...body } = chunk;
    const tampered = { ...body, mergeMessage: { title: "two\nlines", description: "" } };
    expect(() =>
      parseHostRuntimeSemanticComparisonChunk({
        ...tampered,
        inputSha256: sha(canonicalJson(tampered)),
      }),
    ).toThrow(/semantic-merge-message/u);
  });
});

const RATIONALE_LIMIT = "semantic.suggestionRationaleMaxChars";
const SUGGESTION_RATIONALE = "the claim still holds; the new record is a separate capability";

describe("the suggested reply", () => {
  it("asks for a suggestion and a rationale on every conflict, with or without a merge message, as advice that decides nothing", () => {
    for (const message of [undefined, MERGE_MESSAGE]) {
      const instruction = semanticComparisonInstruction(request(message))!;
      expect(instruction).toContain(
        "On every conflict, also add suggestion and rationale, the reply you would give the product owner.",
      );
      expect(instruction).toContain(
        "suggestion is 'keep' when the approved claim still holds as written, 'update' when the merge is intended and the claim needs rewording to match it, or 'later' when the evidence cannot settle it.",
      );
      expect(instruction).toContain(
        `rationale is one plain sentence of at most ${limit(RATIONALE_LIMIT).value} characters that says why, in the same plain words`,
      );
      expect(instruction).toContain("neither records a decision or changes a claim.");
      expect(instruction).toContain("Omit both on an assessment that is not a conflict.");
      // The rules come before the untrusted evidence they govern.
      expect(instruction.indexOf("add suggestion and rationale")).toBeLessThan(
        instruction.indexOf("<untrusted-comparison-evidence-json>"),
      );
    }
    // The three words are exactly the contract's.
    expect([...HOST_RUNTIME_SEMANTIC_SUGGESTIONS]).toEqual(["keep", "update", "later"]);
  });

  it("keeps a valid pair in any casing or padding as one line of prose, and the retained proposal reads back unchanged", () => {
    const chunk = chunkOf(request());
    for (const word of HOST_RUNTIME_SEMANTIC_SUGGESTIONS) {
      const parsed = parseHostRuntimeSemanticComparisonProposal(
        reply(chunk, { suggestion: ` ${word.toUpperCase()} `, rationale: SUGGESTION_RATIONALE }),
        chunk,
      );
      expect(parsed.assessments[0]!.suggestion).toBe(word);
      expect(parsed.assessments[0]!.rationale).toBe(SUGGESTION_RATIONALE);
      expect(
        parseHostRuntimeSemanticComparisonProposalData(JSON.parse(canonicalJson(parsed))),
      ).toEqual(parsed);
    }
    // Line breaks and brackets in the model's sentence become one inert line.
    const loose = parseHostRuntimeSemanticComparisonProposal(
      reply(chunk, {
        suggestion: "keep",
        rationale: "  the claim still holds;\n the new record is [separate]  \n",
      }),
      chunk,
    );
    expect(loose.assessments[0]!.rationale).toBe(
      "the claim still holds; the new record is (separate)",
    );
    expect(
      parseHostRuntimeSemanticComparisonProposalData(JSON.parse(canonicalJson(loose))),
    ).toEqual(loose);
    // The reply decoder the invoker runs keeps the same pair, under the effective allowance.
    const decoded = decodeSemanticComparisonProposal(
      JSON.stringify(reply(chunk, { suggestion: "update", rationale: SUGGESTION_RATIONALE })),
      chunk,
    );
    expect([decoded.assessments[0]!.suggestion, decoded.assessments[0]!.rationale]).toEqual([
      "update",
      SUGGESTION_RATIONALE,
    ]);
  });

  it("drops a pair that is not exactly one of the three words with a rationale, names nothing, and keeps the assessment", () => {
    const chunk = chunkOf(request());
    const malformed: Record<string, unknown>[] = [
      { suggestion: "approve", rationale: SUGGESTION_RATIONALE },
      { suggestion: "keep it", rationale: SUGGESTION_RATIONALE },
      { suggestion: 1, rationale: SUGGESTION_RATIONALE },
      { suggestion: null, rationale: SUGGESTION_RATIONALE },
      { suggestion: "keep" },
      { rationale: SUGGESTION_RATIONALE },
      { suggestion: "keep", rationale: "" },
      { suggestion: "keep", rationale: "  \n " },
      { suggestion: "keep", rationale: 7 },
      { suggestion: "keep", rationale: null },
    ];
    for (const extra of malformed) {
      const parsed = parseHostRuntimeSemanticComparisonProposal(reply(chunk, extra), chunk);
      expect(parsed.assessments, JSON.stringify(extra)).toHaveLength(1);
      expect(Object.hasOwn(parsed.assessments[0]!, "suggestion"), JSON.stringify(extra)).toBe(
        false,
      );
      expect(Object.hasOwn(parsed.assessments[0]!, "rationale"), JSON.stringify(extra)).toBe(false);
      expect(parsed.missingEvidence, JSON.stringify(extra)).toEqual([]);
    }
    // Positive control: the same assessment with a well-formed pair keeps both fields.
    const kept = parseHostRuntimeSemanticComparisonProposal(
      reply(chunk, { suggestion: "keep", rationale: SUGGESTION_RATIONALE }),
      chunk,
    );
    expect([kept.assessments[0]!.suggestion, kept.assessments[0]!.rationale]).toEqual([
      "keep",
      SUGGESTION_RATIONALE,
    ]);
  });

  it("drops a pair on an assessment that is not a conflict, and keeps it on every conflict relationship", () => {
    const chunk = chunkOf(request());
    const pair = { suggestion: "update", rationale: SUGGESTION_RATIONALE };
    for (const relationship of ["compatible", "unknown"]) {
      const parsed = parseHostRuntimeSemanticComparisonProposal(
        reply(chunk, { relationship, ...pair }),
        chunk,
      );
      expect(parsed.assessments[0]!.relationship).toBe(relationship);
      expect(Object.hasOwn(parsed.assessments[0]!, "suggestion"), relationship).toBe(false);
      expect(Object.hasOwn(parsed.assessments[0]!, "rationale"), relationship).toBe(false);
    }
    for (const relationship of [
      "behavior-conflict",
      "intent-conflict",
      "scope-conflict",
      "version-conflict",
      "terminology-conflict",
      "representation-conflict",
      "documentation-quality-conflict",
    ]) {
      const parsed = parseHostRuntimeSemanticComparisonProposal(
        reply(chunk, { relationship, ...pair }),
        chunk,
      );
      expect(parsed.assessments[0]!.suggestion, relationship).toBe("update");
    }
  });

  it("measures the rationale in characters against the declared allowance: at it is kept, past it is dropped and named, never cut", () => {
    const chunk = chunkOf(request());
    const definition = LIMIT_DEFINITION_BY_NAME[RATIONALE_LIMIT]!;
    const max = limit(RATIONALE_LIMIT).value;
    expect(max).toBe(definition.value);
    // The declared domain: raisable above the default, never below one character.
    expect([definition.min, definition.max > definition.value]).toEqual([1, true]);
    const parse = (rationale: string, options?: { suggestionRationaleMaxChars: number }) =>
      parseHostRuntimeSemanticComparisonProposal(
        reply(chunk, { suggestion: "update", rationale }),
        chunk,
        options,
      );
    expect(parse("r".repeat(max)).assessments[0]!.rationale).toBe("r".repeat(max));
    // A character outside the BMP is one character, never two.
    expect(parse("\u{1F642}".repeat(max)).assessments[0]!.suggestion).toBe("update");
    for (const over of ["r".repeat(max + 1), "\u{1F642}".repeat(max + 1)]) {
      const parsed = parse(over);
      expect(parsed.assessments).toHaveLength(1);
      expect(Object.hasOwn(parsed.assessments[0]!, "suggestion")).toBe(false);
      expect(Object.hasOwn(parsed.assessments[0]!, "rationale")).toBe(false);
      expect(parsed.missingEvidence).toEqual([
        `The comparison's suggested reply for CLM-DOCSFAB-059 was not used: ${definition.refusal}: ${max + 1} exceeds ${definition.name} = ${max} ${definition.unit}. ${definition.remediation} Follow the named remediation.`,
      ]);
      // Parsing the normalized proposal again yields the same proposal.
      expect(
        parseHostRuntimeSemanticComparisonProposalData(JSON.parse(canonicalJson(parsed))),
      ).toEqual(parsed);
    }
    // The effective allowance a caller passes governs the fresh reply.
    expect(
      parse("r".repeat(10), { suggestionRationaleMaxChars: 10 }).assessments[0]!.suggestion,
    ).toBe("update");
    const lowered = parse("r".repeat(11), { suggestionRationaleMaxChars: 10 });
    expect(Object.hasOwn(lowered.assessments[0]!, "suggestion")).toBe(false);
    expect(lowered.missingEvidence[0]).toContain(`11 exceeds ${definition.name} = 10 characters`);
  });

  it("reads a retained proposal under the catalog maximum, so lowering the allowance invalidates none, and refuses what the reply parser would not keep", () => {
    const chunk = chunkOf(request());
    const definition = LIMIT_DEFINITION_BY_NAME[RATIONALE_LIMIT]!;
    const retained = JSON.parse(
      canonicalJson(
        parseHostRuntimeSemanticComparisonProposal(
          reply(chunk, { suggestion: "keep", rationale: "r".repeat(100) }),
          chunk,
        ),
      ),
    );
    // Positive control: a retained rationale beyond a lowered allowance still reads back.
    expect(() => parseHostRuntimeSemanticComparisonProposalData(retained)).not.toThrow();
    const tamper = (edit: (row: Record<string, unknown>) => void) => {
      const copy = structuredClone(retained);
      edit(copy.assessments[0]);
      return () => parseHostRuntimeSemanticComparisonProposalData(copy);
    };
    expect(tamper((row) => delete row.rationale)).toThrow(/semantic-suggestion/u);
    expect(tamper((row) => delete row.suggestion)).toThrow(/semantic-suggestion/u);
    expect(tamper((row) => (row.suggestion = "approve"))).toThrow(/invalid-enum/u);
    expect(tamper((row) => (row.rationale = " padded"))).toThrow(/semantic-suggestion-rationale/u);
    expect(tamper((row) => (row.rationale = "two\nlines"))).toThrow(
      /semantic-suggestion-rationale/u,
    );
    expect(tamper((row) => (row.rationale = ""))).toThrow(/semantic-suggestion-rationale/u);
    expect(tamper((row) => (row.rationale = 7))).toThrow(/semantic-suggestion-rationale/u);
    expect(tamper((row) => (row.rationale = "r".repeat(definition.max + 1)))).toThrow(
      /semantic-suggestion-rationale/u,
    );
    expect(tamper((row) => (row.rationale = "r".repeat(definition.max)))).not.toThrow();
    expect(tamper((row) => (row.relationship = "compatible"))).toThrow(/semantic-suggestion/u);
  });

  it("is no way around DocsFab's own credential screen: a configured credential in the rationale refuses the reply", () => {
    const chunk = chunkOf(request());
    const planted = "fixture-suggestion-rationale-lamp-hums";
    const wording = { suggestion: "keep", rationale: `the claim holds, ${planted}` };
    expect(
      parseHostRuntimeSemanticComparisonProposal(reply(chunk, wording), chunk).assessments,
    ).toHaveLength(1);
    plantConfiguredCredential(planted);
    expect(() => parseHostRuntimeSemanticComparisonProposal(reply(chunk, wording), chunk)).toThrow(
      /semantic-proposal-size-or-credential/u,
    );
  });
});
