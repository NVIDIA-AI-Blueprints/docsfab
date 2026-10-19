// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import {
  canonicalJson,
  parseHostRuntimeSemanticComparisonProposal,
  parseHostRuntimeSemanticComparisonProposalData,
  sealHostRuntimeSemanticComparisonChunk,
} from "../src/host-invoker/contracts.js";

const sha = (value: string) => createHash("sha256").update(value).digest("hex");

/** Synthetic model/source data; tests real parsers, not host read admission. */
function fixture() {
  const statement = "Ordinary Slack messages require a mention before a reply.";
  const content = 'import { requiresMention } from "./secondary.js";';
  const chunk = sealHostRuntimeSemanticComparisonChunk({
    schemaVersion: 1,
    kind: "docsfab-semantic-comparison-chunk",
    projectId: "project-fixture",
    caseKind: "merge",
    caseSha256: sha("merge"),
    comparisonSha256: sha("comparison"),
    baselineGeneration: 1,
    baselineSha256: sha("baseline"),
    approvalReceiptSha256: sha("approval"),
    modelSha256: sha("model"),
    canonSha256: sha("canon"),
    sourceInventorySha256: sha("inventory"),
    ordinal: 1,
    chunkCount: 1,
    claims: [
      {
        claimId: "CLAIM-MENTION",
        statement,
        statementSha256: sha(statement),
        scope: "ordinary messages",
        recordSha256: sha("record"),
      },
    ],
    evidence: [
      {
        evidenceId: "source-after",
        kind: "repository-after",
        version: "a".repeat(40),
        sourcePath: "src/router.ts",
        change: "modified",
        content,
        contentSha256: sha(content),
        sourceContentSha256: sha(content),
        startByte: 0,
        endByte: Buffer.byteLength(content),
        totalBytes: Buffer.byteLength(content),
        sourceVersionSha256: null,
      },
    ],
  });
  const proposal = {
    schemaVersion: 1,
    kind: "docsfab-semantic-comparison-proposal",
    inputSha256: chunk.inputSha256,
    assessments: [
      {
        evidenceId: "source-after",
        claimId: "CLAIM-MENTION",
        relationship: "unknown",
        assertion: "unknown",
        explanation: "The imported adapter's mention predicate is absent from this input.",
        scope: "ordinary messages",
        confidence: "low",
        modelCitation: { evidenceId: "CLAIM-MENTION", quote: statement },
        sourceCitations: [{ evidenceId: "source-after", quote: content }],
      },
    ],
    missingEvidence: ["Read the imported secondary adapter to establish its mention predicate."],
    gatherRequests: [
      {
        inputSha256: chunk.inputSha256,
        evidenceId: "source-after",
        claimId: "CLAIM-MENTION",
        question: { kind: "exact-path", path: "src/secondary.ts" },
      },
    ],
  };
  return { chunk, proposal };
}

/**
 * A chunk shaped like a real multi-chunk merge comparison: this is chunk 2 of 3 (a large
 * merge split by `mergeComparisonMaximumChunkBytes`), carrying two independent unknown
 * findings, each with its own gather request. Regression shape for the production failure
 * `semantic-reply-gather-assessment-binding`: once merges routinely split into several
 * per-chunk model turns, one turn's single malformed gather request used to abort that
 * whole turn (`SemanticComparisonReplyError`), which aborted the entire multi-chunk
 * comparison (`executeSemanticComparison` breaks the chunk loop on any executor failure).
 * Degrading in place, chunk-local, means one bad request no longer costs the other
 * chunks their turn.
 */
function multiChunkFixture() {
  const statementA = "Ordinary Slack messages require a mention before a reply.";
  const statementB = "Thread follow-ups reuse the parent message's channel binding.";
  const contentA = 'import { requiresMention } from "./secondary.js";';
  const contentB = 'import { channelBinding } from "./thread-context.js";';
  const chunk = sealHostRuntimeSemanticComparisonChunk({
    schemaVersion: 1,
    kind: "docsfab-semantic-comparison-chunk",
    projectId: "project-fixture",
    caseKind: "merge",
    caseSha256: sha("merge"),
    comparisonSha256: sha("comparison"),
    baselineGeneration: 1,
    baselineSha256: sha("baseline"),
    approvalReceiptSha256: sha("approval"),
    modelSha256: sha("model"),
    canonSha256: sha("canon"),
    sourceInventorySha256: sha("inventory"),
    ordinal: 2,
    chunkCount: 3,
    claims: [
      {
        claimId: "CLAIM-MENTION",
        statement: statementA,
        statementSha256: sha(statementA),
        scope: "ordinary messages",
        recordSha256: sha("record-a"),
      },
      {
        claimId: "CLAIM-THREAD-BINDING",
        statement: statementB,
        statementSha256: sha(statementB),
        scope: "thread follow-ups",
        recordSha256: sha("record-b"),
      },
    ],
    evidence: [
      {
        evidenceId: "source-mention",
        kind: "repository-after",
        version: "a".repeat(40),
        sourcePath: "src/router.ts",
        change: "modified",
        content: contentA,
        contentSha256: sha(contentA),
        sourceContentSha256: sha(contentA),
        startByte: 0,
        endByte: Buffer.byteLength(contentA),
        totalBytes: Buffer.byteLength(contentA),
        sourceVersionSha256: null,
      },
      {
        evidenceId: "source-thread",
        kind: "repository-after",
        version: "a".repeat(40),
        sourcePath: "src/thread.ts",
        change: "modified",
        content: contentB,
        contentSha256: sha(contentB),
        sourceContentSha256: sha(contentB),
        startByte: 0,
        endByte: Buffer.byteLength(contentB),
        totalBytes: Buffer.byteLength(contentB),
        sourceVersionSha256: null,
      },
    ],
  });
  const proposal = {
    schemaVersion: 1,
    kind: "docsfab-semantic-comparison-proposal",
    inputSha256: chunk.inputSha256,
    assessments: [
      {
        evidenceId: "source-mention",
        claimId: "CLAIM-MENTION",
        relationship: "unknown",
        assertion: "unknown",
        explanation: "The imported adapter's mention predicate is absent from this input.",
        scope: "ordinary messages",
        confidence: "low",
        modelCitation: { evidenceId: "CLAIM-MENTION", quote: statementA },
        sourceCitations: [{ evidenceId: "source-mention", quote: contentA }],
      },
      {
        evidenceId: "source-thread",
        claimId: "CLAIM-THREAD-BINDING",
        relationship: "unknown",
        assertion: "unknown",
        explanation: "The imported thread context module is absent from this input.",
        scope: "thread follow-ups",
        confidence: "low",
        modelCitation: { evidenceId: "CLAIM-THREAD-BINDING", quote: statementB },
        sourceCitations: [{ evidenceId: "source-thread", quote: contentB }],
      },
    ],
    missingEvidence: [
      "Read the imported secondary adapter to establish its mention predicate.",
      "Read the imported thread context module to establish its channel binding.",
    ],
    gatherRequests: [
      {
        inputSha256: chunk.inputSha256,
        evidenceId: "source-mention",
        claimId: "CLAIM-MENTION",
        question: { kind: "exact-path", path: "src/secondary.ts" },
      },
      {
        inputSha256: chunk.inputSha256,
        // A model slip this fix targets: this evidenceId/claimId pair does not name any
        // assessment in this same reply (it transposes the two findings' identities).
        evidenceId: "source-thread",
        claimId: "CLAIM-MENTION",
        question: { kind: "exact-path", path: "src/thread-context.ts" },
      },
    ],
  };
  return { chunk, proposal };
}

describe("semantic gather request nominations", () => {
  it("retains exact path and literal probes bound to real cited unknown assessments", () => {
    const { chunk, proposal } = fixture();
    for (const question of [
      { kind: "exact-path", path: "src/secondary.ts" },
      { kind: "literal-text", value: "requiresMention" },
    ]) {
      const parsed = parseHostRuntimeSemanticComparisonProposal(
        { ...proposal, gatherRequests: [{ ...proposal.gatherRequests[0], question }] },
        chunk,
      );
      expect(parsed.gatherRequests?.[0]?.question).toEqual(question);
      expect(parsed.assessments[0]?.sourceCitations[0]?.sha256).toBe(
        chunk.evidence[0]?.contentSha256,
      );
      expect(parsed.missingEvidence).toEqual(proposal.missingEvidence);
      expect(Object.isFrozen(parsed.gatherRequests?.[0]?.question)).toBe(true);
      expect(parseHostRuntimeSemanticComparisonProposalData(parsed)).toEqual(parsed);
    }
  });

  it("preserves old normalized proposal bytes and omits the optional field when absent", () => {
    const { chunk, proposal } = fixture();
    const { gatherRequests: _requests, ...legacy } = proposal;
    const parsed = parseHostRuntimeSemanticComparisonProposal(legacy, chunk);
    expect(Object.hasOwn(parsed, "gatherRequests")).toBe(false);
    expect(canonicalJson(parseHostRuntimeSemanticComparisonProposalData(parsed))).toBe(
      canonicalJson(parsed),
    );
  });

  it.each(["evidenceId", "claimId"])(
    "drops, rather than refuses the whole reply for, a foreign request %s",
    (field) => {
      const { chunk, proposal } = fixture();
      const parsed = parseHostRuntimeSemanticComparisonProposal(
        {
          ...proposal,
          gatherRequests: [{ ...proposal.gatherRequests[0], [field]: "foreign" }],
        },
        chunk,
      );
      // gather-request-hard-fail mutant: an unbound request must be dropped and named,
      // not thrown, and the assessment it could not bind to must still stand.
      // The note only names an evidenceId that is itself a real assessment's evidenceId
      // in this same reply: mutating claimId leaves evidenceId "source-after" (known,
      // named); mutating evidenceId to "foreign" is not any assessment's id (unnamed).
      const namedEvidenceId = field === "evidenceId" ? "undeclared evidence" : "source-after";
      expect(parsed.gatherRequests).toBeUndefined();
      expect(parsed.assessments).toHaveLength(1);
      expect(parsed.assessments[0]?.evidenceId).toBe("source-after");
      expect(parsed.missingEvidence).toEqual([
        ...proposal.missingEvidence,
        `The comparison dropped a gather request for ${namedEvidenceId} (semantic-gather-assessment-binding).`,
      ]);
    },
  );

  it("never echoes a dropped request's raw evidenceId, even one an appended code would make credential-shaped", () => {
    const { chunk, proposal } = fixture();
    // credential-echo mutant: a dropped request's raw evidenceId must never reach the note.
    // "token:" alone is not credential-shaped (nothing follows the colon), so it is not
    // refused up front; echoed raw, the note's own " (<code>)." suffix supplies the 8+
    // non-space characters after the colon the credential pattern needs, making the NOTE
    // itself credential-shaped and refusing the WHOLE reply -- exactly the whole-reply
    // abort this fix exists to avoid. Never naming an unverified raw id closes that.
    const parsed = parseHostRuntimeSemanticComparisonProposal(
      {
        ...proposal,
        gatherRequests: [{ ...proposal.gatherRequests[0], evidenceId: "token:" }],
      },
      chunk,
    );
    expect(parsed.gatherRequests).toBeUndefined();
    expect(parsed.assessments).toHaveLength(1);
    expect(parsed.missingEvidence).toContain(
      "The comparison dropped a gather request for undeclared evidence (semantic-gather-assessment-binding).",
    );
  });

  it("binds a request echoing a foreign inputSha256 to its own chunk", () => {
    const { chunk, proposal } = fixture();
    const parsed = parseHostRuntimeSemanticComparisonProposal(
      {
        ...proposal,
        gatherRequests: [{ ...proposal.gatherRequests[0], inputSha256: sha("foreign") }],
      },
      chunk,
    );
    expect(parsed.gatherRequests?.[0]?.inputSha256).toBe(chunk.inputSha256);
    expect(parsed).toEqual(parseHostRuntimeSemanticComparisonProposal(proposal, chunk));
  });

  it("drops both an invented assessment and its agreeing gather request, not the whole reply", () => {
    const { chunk, proposal } = fixture();
    const parsed = parseHostRuntimeSemanticComparisonProposal(
      {
        ...proposal,
        assessments: [{ ...proposal.assessments[0], claimId: "foreign" }],
        gatherRequests: [{ ...proposal.gatherRequests[0], claimId: "foreign" }],
      },
      chunk,
    );
    // Both drops are independent and additive: an invented claim identity never
    // revives itself by also appearing, self-consistently, in a gather request. The
    // assessment drops first, so by the time the gather request's evidenceId is
    // checked against known assessment evidenceIds, none remain to name it against.
    expect(parsed.assessments).toHaveLength(0);
    expect(parsed.gatherRequests).toBeUndefined();
    expect(parsed.missingEvidence).toContain(
      "The comparison dropped an assessment of source-after (semantic-assessment-membership).",
    );
    expect(parsed.missingEvidence).toContain(
      "The comparison dropped a gather request for undeclared evidence (semantic-gather-assessment-binding).",
    );
  });

  it("still refuses the whole reply for a proposal-wide pending-evidence mismatch", () => {
    const { chunk, proposal } = fixture();
    // These two stay a hard, whole-reply refusal: an empty missingEvidence or an empty
    // gatherRequests array is the reply's own declared shape being self-contradictory,
    // not one request among several failing to bind; there is nothing to drop-and-keep.
    const alternatives = [
      { ...proposal, missingEvidence: [] },
      { ...proposal, gatherRequests: [] },
    ];
    for (const value of alternatives)
      expect(() => parseHostRuntimeSemanticComparisonProposal(value, chunk)).toThrow(
        /semantic-gather-pending-evidence/u,
      );
  });

  it("drops a gather request whose own assessment resolved clean or offered an alternative", () => {
    const { chunk, proposal } = fixture();
    const clean = parseHostRuntimeSemanticComparisonProposal(
      { ...proposal, assessments: [{ ...proposal.assessments[0], relationship: "compatible" }] },
      chunk,
    );
    expect(clean.gatherRequests).toBeUndefined();
    expect(clean.assessments[0]?.relationship).toBe("compatible");
    expect(clean.missingEvidence).toContain(
      "The comparison dropped a gather request for source-after (semantic-gather-assessment-binding).",
    );
    const offered = parseHostRuntimeSemanticComparisonProposal(
      {
        ...proposal,
        assessments: [
          {
            ...proposal.assessments[0],
            proposedClaim: { statement: "Guess a changed predicate.", scope: {} },
          },
        ],
      },
      chunk,
    );
    expect(offered.gatherRequests).toBeUndefined();
    expect(offered.assessments[0]?.proposedClaim?.statement).toBe("Guess a changed predicate.");
  });

  it.each([
    "../private",
    "/etc/passwd",
    "src/../private",
    "src//adapter",
    "src\\adapter",
    "src/adapter\0.ts",
  ])("drops, not refuses the whole reply for, an unsafe repository path %j", (path) => {
    const { chunk, proposal } = fixture();
    const parsed = parseHostRuntimeSemanticComparisonProposal(
      {
        ...proposal,
        gatherRequests: [{ ...proposal.gatherRequests[0], question: { kind: "exact-path", path } }],
      },
      chunk,
    );
    expect(parsed.gatherRequests).toBeUndefined();
    expect(parsed.missingEvidence).toContain(
      "The comparison dropped a gather request for source-after (semantic-gather-path).",
    );
  });

  it.each([
    "sourceKind",
    "role",
    "endpoint",
    "credential",
    "provider",
    "projectId",
    "revision",
    "command",
  ])("drops, not refuses the whole reply for, a request authority or command field %s", (field) => {
    const { chunk, proposal } = fixture();
    const parsed = parseHostRuntimeSemanticComparisonProposal(
      { ...proposal, gatherRequests: [{ ...proposal.gatherRequests[0], [field]: "untrusted" }] },
      chunk,
    );
    // authority-field-passthrough mutant: an extra authority/command field on a gather
    // request must never survive into the kept request or the model reply's out-of-contract
    // field would silently gain meaning; the whole request is dropped instead.
    expect(parsed.gatherRequests).toBeUndefined();
    expect(parsed.missingEvidence).toContain(
      "The comparison dropped a gather request for source-after (invalid-shape).",
    );
  });

  it("drops ambiguous selectors and unsupported command probes instead of refusing the reply", () => {
    const { chunk, proposal } = fixture();
    for (const question of [
      { kind: "exact-path", path: "src/secondary.ts", value: "requiresMention" },
      { kind: "literal-text", value: "requiresMention", path: "src/secondary.ts" },
      { kind: "command", value: "cat src/secondary.ts" },
      { kind: "literal-text", value: "x" },
      { kind: "literal-text", value: "x".repeat(129) },
    ]) {
      const parsed = parseHostRuntimeSemanticComparisonProposal(
        { ...proposal, gatherRequests: [{ ...proposal.gatherRequests[0], question }] },
        chunk,
      );
      expect(parsed.gatherRequests).toBeUndefined();
    }
  });

  it("keeps the first occurrence of a duplicate gather request and drops only the repeat", () => {
    const { chunk, proposal } = fixture();
    const parsed = parseHostRuntimeSemanticComparisonProposal(
      { ...proposal, gatherRequests: [...proposal.gatherRequests, ...proposal.gatherRequests] },
      chunk,
    );
    // drop-both-duplicates mutant: exactly one survivor, not zero and not two.
    expect(parsed.gatherRequests).toHaveLength(1);
    expect(parsed.gatherRequests?.[0]?.evidenceId).toBe("source-after");
    expect(parsed.missingEvidence).toContain(
      "The comparison dropped a gather request for source-after (semantic-gather-assessment-binding).",
    );
  });

  it("applies the existing probe limit to each batch without truncating it", () => {
    const { chunk, proposal } = fixture();
    const gatherRequests = Array.from({ length: 32 }, (_, index) => ({
      ...proposal.gatherRequests[0],
      question: { kind: "exact-path", path: `src/adapter-${index}.ts` },
    }));
    expect(
      parseHostRuntimeSemanticComparisonProposal({ ...proposal, gatherRequests }, chunk)
        .gatherRequests,
    ).toHaveLength(32);
    expect(() =>
      parseHostRuntimeSemanticComparisonProposal(
        {
          ...proposal,
          gatherRequests: [
            ...gatherRequests,
            { ...gatherRequests[0], question: { kind: "exact-path", path: "src/adapter-32.ts" } },
          ],
        },
        chunk,
      ),
    ).toThrow(/requests-per-proposal limit=32 observed=33/u);
  });

  it.each([
    ["exact-path", "path", 1024],
    ["literal-text", "value", 128],
  ] as const)(
    "preserves the full %s selector at its bound and drops bound plus one",
    (kind, field, limit) => {
      const { chunk, proposal } = fixture();
      const nominate = (value: string) => ({
        ...proposal,
        gatherRequests: [{ ...proposal.gatherRequests[0], question: { kind, [field]: value } }],
      });
      const parsed = parseHostRuntimeSemanticComparisonProposal(nominate("x".repeat(limit)), chunk);
      expect(parsed.gatherRequests?.[0]?.question).toEqual({ kind, [field]: "x".repeat(limit) });
      // at-the-bound-also-dropped mutant: the exact limit must still be kept (checked above);
      // only one character past it is dropped.
      const overLimit = parseHostRuntimeSemanticComparisonProposal(
        nominate("x".repeat(limit + 1)),
        chunk,
      );
      expect(overLimit.gatherRequests).toBeUndefined();
    },
  );

  it("rejects proxy and accessor requests without observing their executable behavior", () => {
    const { chunk, proposal } = fixture();
    let traps = 0;
    const proxy = new Proxy(proposal.gatherRequests[0]!, {
      ownKeys() {
        traps += 1;
        throw new Error("proxy executed");
      },
    });
    const accessor = {
      ...proposal.gatherRequests[0],
      get question() {
        traps += 1;
        throw new Error("getter executed");
      },
    };
    // A proxy or accessor anywhere in the reply fails the whole-input transport scan
    // (`assertHostRuntimeSemanticData`) before any per-request parsing, gather or
    // otherwise, ever runs -- this stays a hard, whole-reply refusal, not a drop.
    for (const request of [proxy, accessor])
      expect(() =>
        parseHostRuntimeSemanticComparisonProposal(
          { ...proposal, gatherRequests: [request] },
          chunk,
        ),
      ).toThrow(/invalid-shape/u);
    expect(traps).toBe(0);
  });

  it("keeps a chunk's other finding and gather request when only one gather request is malformed (regression: semantic-reply-gather-assessment-binding)", () => {
    const { chunk, proposal } = multiChunkFixture();
    const parsed = parseHostRuntimeSemanticComparisonProposal(proposal, chunk);
    // whole-turn-abort mutant: before this fix, one transposed identity in the second
    // gather request threw for the entire chunk turn (SemanticComparisonReplyError:
    // semantic-reply-gather-assessment-binding), which in `executeSemanticComparison`
    // aborted the whole multi-chunk comparison, discarding every other chunk's work too.
    // Both findings here must survive, and exactly the one well-formed request must too.
    expect(parsed.assessments).toHaveLength(2);
    expect(parsed.assessments.map((row) => row.evidenceId).sort()).toEqual([
      "source-mention",
      "source-thread",
    ]);
    expect(parsed.gatherRequests).toHaveLength(1);
    expect(parsed.gatherRequests?.[0]).toMatchObject({
      evidenceId: "source-mention",
      claimId: "CLAIM-MENTION",
    });
    expect(parsed.missingEvidence).toEqual([
      ...proposal.missingEvidence,
      "The comparison dropped a gather request for source-thread (semantic-gather-assessment-binding).",
    ]);
    // Re-parsing the normalized proposal again (the host's own "already normalized"
    // path, e.g. checkpoint replay) must be idempotent, not compound the drop notes.
    expect(parseHostRuntimeSemanticComparisonProposalData(parsed)).toEqual(parsed);
  });

  it("loads and validates the codec leaf through fresh native Node", () => {
    const value = fixture();
    const moduleUrl = pathToFileURL(resolve("src/host-invoker/semantic-comparison.js")).href;
    const output = execFileSync(
      process.execPath,
      [
        "--experimental-strip-types",
        "--input-type=module",
        "-e",
        `
      import { readFileSync } from 'node:fs';
      import { parseHostRuntimeSemanticComparisonProposal } from ${JSON.stringify(moduleUrl)};
      const {chunk, proposal} = JSON.parse(readFileSync(0, 'utf8'));
      const parsed = parseHostRuntimeSemanticComparisonProposal(proposal, chunk);
      process.stdout.write(JSON.stringify(parsed.gatherRequests));
    `,
      ],
      {
        input: JSON.stringify(value),
        encoding: "utf8",
        env: { PATH: "/usr/bin:/bin", PI_OFFLINE: "1" },
      },
    );
    expect(JSON.parse(output)).toEqual(value.proposal.gatherRequests);
  });
});
