// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Readers accept the additive source-citation evidence and the refused-citation
 * tool-failure category.
 *
 * Six closed run-record key lists and four closed tool-failure enumerations
 * would otherwise reject a record from an upgraded writer, so each is
 * exercised against a record that carries the field and against a control
 * carrying an unknown key, so "accepted" means "this field", not "the gate
 * was loosened".
 */
import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { decodeSuccessfulPublicationRunRecord } from "../src/delivery/run-record.js";
import { DOC_IMPROVEMENT_RUN_KEYS } from "../src/doc-improvement.js";
import { CORPUS_LIVE_RUN_KEYS } from "../src/quality-evaluation/corpus-live.js";
import { toolFailureDispositions } from "../src/quality-evaluation/structural.js";
import { EXECUTED_TOOL_FAILURE_CATEGORIES } from "../src/workflow-contracts/outcome.js";
import { NATIVE_PILOT_RUN_KEYS } from "../src/native-compositions/pilot-runner.js";
import { RELEASE_READINESS_RUN_READER } from "../src/scorecard-record.js";
import {
  SourceRunCitationsError,
  decodeSourceRunCitations,
} from "../src/records/source-citations.js";
import type { ToolFailureCategory } from "../src/records/contracts.js";

const REVISION = "a".repeat(40);
const sha = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");

const BINDING = sha("binding-983-readers");
const CLAIM_ONE = sha("claim-one-983");
const CLAIM_TWO = sha("claim-two-983");

function spanCitation(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    kind: "docsfab-source-span-citation",
    bindingSha256: BINDING,
    observationId: "obs-readers-983",
    representationId: "rep-readers-983",
    representationSha256: sha("representation-983"),
    stepId: "plan-documentation",
    spanIds: ["span-readers-983"],
    spanAccessSha256s: [sha("access-983")],
    supportedClaimSha256: CLAIM_ONE,
    externalInputCitationSha256: sha("join-983"),
    spanCitationSha256: sha("citation-983"),
    ...overrides,
  };
}

function runCitations(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    kind: "docsfab-source-run-citations",
    bindingSha256: BINDING,
    steps: [
      {
        stepId: "write-documentation",
        // Sorted and unique, which the decoder requires so a reader can compare two
        // records without re-sorting them.
        materialClaimSha256s: [CLAIM_ONE, CLAIM_TWO].sort(),
        citations: [spanCitation()],
      },
    ],
    ...overrides,
  };
}

/** The shipped publication-gate record shape, with the field optional. */
function publicationRecord(sourceCitations?: unknown): Record<string, unknown> {
  const patch = Buffer.from("diff --git a/README.md b/README.md\n", "utf8");
  return {
    schemaVersion: 2,
    id: "run-983-readers",
    workflow: "site-bootstrap",
    repository: {
      sourcePath: "/fixtures/citation-readers",
      requestedRevision: "HEAD",
      revision: REVISION,
    },
    workspace: { strategy: "tracked-export", disposable: true },
    task: {
      kind: "site-bootstrap",
      plan: {
        kind: "ia-plan",
        schemaVersion: 1,
        digest: "a".repeat(64),
        repositoryRevision: REVISION,
        repositoryContentDigest: "b".repeat(64),
      },
    },
    status: "succeeded",
    createdAt: "2026-09-18T00:00:00.000Z",
    startedAt: "2026-09-18T00:00:01.000Z",
    completedAt: "2026-09-18T00:00:02.000Z",
    durationMs: 1000,
    models: [],
    skills: [],
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, turns: 0 },
    tools: { totalCalls: 0, failedCalls: 0, byTool: [] },
    securityScan: {
      ruleSet: "credential-rules-v1",
      status: "passed",
      scannedFiles: 1,
      binaryFiles: 0,
      findings: [],
    },
    securityScanEffectiveDisposition: { status: "passed" },
    artifacts: [
      {
        role: "input",
        stepId: "apply-site-bootstrap",
        reference: {
          kind: "ia-plan",
          schemaVersion: 1,
          digest: "a".repeat(64),
          repositoryRevision: REVISION,
          repositoryContentDigest: "b".repeat(64),
        },
      },
    ],
    ...(sourceCitations === undefined ? {} : { sourceCitations }),
    steps: [
      {
        id: "apply-site-bootstrap",
        title: "Apply approved site bootstrap",
        kind: "host-operation",
        operation: "site-bootstrap",
        skill: "template-scaffold-site",
        mode: "write",
        status: "succeeded",
        startedAt: "2026-09-18T00:00:01.000Z",
        completedAt: "2026-09-18T00:00:02.000Z",
        durationMs: 1000,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, turns: 0 },
        tools: { totalCalls: 0, failedCalls: 0, byTool: [] },
        contextPreflight: {
          status: "ready",
          packetDigest: "c".repeat(64),
          consultedNodeIds: ["node-a"],
          ontologyVersion: "ontology-v1",
          effectiveDecisionIds: [],
          measurements: {
            byteLength: 1,
            estimatedTokens: 1,
            latencyMs: 0,
            nodeCount: 1,
            edgeCount: 0,
            pathCount: 1,
          },
          cache: { disposition: "miss", keyDigest: "d".repeat(64), rebuildAttempted: true },
        },
        artifacts: [
          {
            role: "input",
            stepId: "apply-site-bootstrap",
            reference: {
              kind: "ia-plan",
              schemaVersion: 1,
              digest: "a".repeat(64),
              repositoryRevision: REVISION,
              repositoryContentDigest: "b".repeat(64),
            },
          },
        ],
        summary: "Applied approved site plan.",
      },
    ],
    changes: {
      files: [{ path: "README.md", status: "modified" }],
      patch: {
        sha256: createHash("sha256").update(patch).digest("hex"),
        byteLength: patch.byteLength,
        lineCount: 1,
        artifactPath: "/fixtures/citation-readers/run-983.patch",
        format: "git-diff",
      },
    },
  };
}

describe("the publication decoder accepts the additive citation evidence (#983)", () => {
  it("decodes a successful record with and without the field", () => {
    expect(decodeSuccessfulPublicationRunRecord(publicationRecord()).id).toBe("run-983-readers");
    const decoded = decodeSuccessfulPublicationRunRecord(publicationRecord(runCitations()));
    expect(decoded.id).toBe("run-983-readers");
    // Carried through rather than dropped: a reader that accepted the key but
    // discarded the value would pass the decode test and lose the evidence.
    expect(decoded.sourceCitations?.steps[0]?.stepId).toBe("write-documentation");
  });

  it("still refuses an unknown run-record key", () => {
    // The control for the test above: acceptance is this field, not a widened gate.
    expect(() =>
      decodeSuccessfulPublicationRunRecord({
        ...publicationRecord(),
        sourceCitationsDraft: {},
      }),
    ).toThrowError();
  });

  it("refuses citation evidence whose shape is wrong", () => {
    // Accepted does not mean unvalidated.
    expect(() =>
      decodeSuccessfulPublicationRunRecord(
        publicationRecord(runCitations({ kind: "docsfab-source-run-citations-v2" })),
      ),
    ).toThrowError();
    expect(() =>
      decodeSuccessfulPublicationRunRecord(publicationRecord({ ...runCitations(), extra: 1 })),
    ).toThrowError();
  });
});

describe("source-citation evidence decoding (#983)", () => {
  it("accepts the shipped shape and freezes it", () => {
    const decoded = decodeSourceRunCitations(runCitations());
    expect(decoded.kind).toBe("docsfab-source-run-citations");
    expect(decoded.bindingSha256).toBe(BINDING);
    expect(decoded.steps).toHaveLength(1);
    expect(decoded.steps[0]!.citations[0]!.supportedClaimSha256).toBe(CLAIM_ONE);
    expect(Object.isFrozen(decoded)).toBe(true);
  });

  it("refuses a repeated step id", () => {
    // A reader asks "what did this step cite"; two rows for one step have no
    // answer.
    const doubled = runCitations();
    (doubled.steps as unknown[]).push({
      stepId: "write-documentation",
      materialClaimSha256s: [CLAIM_ONE],
      citations: [spanCitation()],
    });
    expect(() => decodeSourceRunCitations(doubled)).toThrow(
      new SourceRunCitationsError("duplicate-step"),
    );
  });

  it("refuses unsorted or repeated claim digests", () => {
    const unsorted = [CLAIM_ONE, CLAIM_TWO].sort().reverse();
    expect(() =>
      decodeSourceRunCitations(
        runCitations({
          steps: [
            {
              stepId: "write-documentation",
              materialClaimSha256s: unsorted,
              citations: [spanCitation()],
            },
          ],
        }),
      ),
    ).toThrow(new SourceRunCitationsError("invalid-value"));
    expect(() =>
      decodeSourceRunCitations(
        runCitations({
          steps: [
            {
              stepId: "write-documentation",
              materialClaimSha256s: [CLAIM_ONE, CLAIM_ONE],
              citations: [spanCitation()],
            },
          ],
        }),
      ),
    ).toThrow(new SourceRunCitationsError("invalid-value"));
  });

  it("refuses a citation sealed to a different binding than the evidence names", () => {
    expect(() =>
      decodeSourceRunCitations(
        runCitations({
          steps: [
            {
              stepId: "write-documentation",
              materialClaimSha256s: [CLAIM_ONE],
              citations: [spanCitation({ bindingSha256: sha("another-binding") })],
            },
          ],
        }),
      ),
    ).toThrow(new SourceRunCitationsError("invalid-value"));
  });

  it("carries uncited claims by page, line, and digest through both readers (#1917)", () => {
    const uncitedClaims = [{ path: "docs/guide.md", line: 4, claimSha256: CLAIM_TWO }];
    const withGaps = runCitations({
      steps: [
        {
          stepId: "write-documentation",
          materialClaimSha256s: [CLAIM_ONE, CLAIM_TWO].sort(),
          citations: [spanCitation()],
          uncitedClaims,
        },
      ],
    });
    expect(decodeSourceRunCitations(withGaps).steps[0]!.uncitedClaims).toEqual(uncitedClaims);
    expect(
      decodeSuccessfulPublicationRunRecord(publicationRecord(withGaps)).sourceCitations?.steps[0]
        ?.uncitedClaims,
    ).toEqual(uncitedClaims);
    // Absent stays absent: a reader never invents an empty list.
    expect(decodeSourceRunCitations(runCitations()).steps[0]).not.toHaveProperty("uncitedClaims");
  });

  it("refuses an uncited claim whose location or digest is malformed (#1917)", () => {
    const withClaim = (claim: Record<string, unknown>) =>
      runCitations({
        steps: [
          {
            stepId: "write-documentation",
            materialClaimSha256s: [CLAIM_ONE],
            citations: [spanCitation()],
            uncitedClaims: [claim],
          },
        ],
      });
    const valid = { path: "docs/guide.md", line: 3, claimSha256: CLAIM_ONE };
    expect(() => decodeSourceRunCitations(withClaim(valid))).not.toThrow();
    for (const claim of [
      { ...valid, path: "/etc/guide.md" },
      { ...valid, path: "docs/../guide.md" },
      { ...valid, path: "docs\\guide.md" },
      { ...valid, path: "C:/guide.md" },
      { ...valid, line: 0 },
      { ...valid, line: 2.5 },
      { ...valid, claimSha256: "not-a-digest" },
    ]) {
      expect(() => decodeSourceRunCitations(withClaim(claim))).toThrow(
        new SourceRunCitationsError("invalid-value"),
      );
    }
    // The claim text never rides along: an extra key is a shape error.
    expect(() =>
      decodeSourceRunCitations(withClaim({ ...valid, claim: "the bound note says so." })),
    ).toThrow(new SourceRunCitationsError("invalid-shape"));
  });

  it("refuses a citation that names no span or no supporting receipt", () => {
    for (const override of [{ spanIds: [] }, { spanAccessSha256s: [] }]) {
      expect(() =>
        decodeSourceRunCitations(
          runCitations({
            steps: [
              {
                stepId: "write-documentation",
                materialClaimSha256s: [CLAIM_ONE],
                citations: [spanCitation(override)],
              },
            ],
          }),
        ),
      ).toThrow(new SourceRunCitationsError("invalid-value"));
    }
  });
});

describe("the refused-citation tool-failure category is admitted (#983)", () => {
  it("is a member of the category union", () => {
    // Compile-time membership made executable: this does not type-check unless
    // the union carries it, and it does not pass unless the value survives.
    const category: ToolFailureCategory = "citation-refused";
    expect(category).toBe("citation-refused");
  });

  it("decodes inside recorded tool activity", async () => {
    // The strict decoder is the one that would reject an unknown category on a
    // record written by an upgraded writer.
    const { decodeTools } = await import("../src/execution/inference-evidence.js");
    const decoded = decodeTools({
      totalCalls: 2,
      failedCalls: 1,
      byTool: [{ name: "docsfab_cite_source", calls: 2, failures: 1 }],
      failureCategories: [{ category: "citation-refused", count: 1 }],
    });
    expect(decoded.failureCategories).toEqual([{ category: "citation-refused", count: 1 }]);
    // Control: an invented category is still refused.
    expect(() =>
      decodeTools({
        totalCalls: 2,
        failedCalls: 1,
        byTool: [{ name: "docsfab_cite_source", calls: 2, failures: 1 }],
        failureCategories: [{ category: "citation-declined", count: 1 }],
      }),
    ).toThrowError();
  });

  it("carries a content-free operator message", async () => {
    const { safeFailureMessage } = await import("../src/harness/confined-tools.js");
    expect(safeFailureMessage("citation-refused")).toBe(
      "DocsFab refused the requested source citation.",
    );
  });
});

/**
 * Every widened list has its own named test, because removing a key from any
 * one of them must fail the suite.
 *
 * Where the decoder is exported, the test decodes a real record through it.
 * Where it is private (`doc-improvement`'s `validateAuthenticRunRecord` and
 * `corpus-live`'s `runRecord`, reachable only behind large fixtures) the closed
 * list is a module-scope export asserted directly. That is weaker than an
 * end-to-end decode, but it proves the list admits the key.
 *
 * The two `scorecard-record.ts` lists are decoded end to end in
 * `scorecard-record.test.ts`, beside the readiness fixture they need.
 */
describe("every closed run-record list admits the field (#983)", () => {
  it("names it in the pilot terminal run-key allowlist", () => {
    // An end-to-end differential test cannot isolate this list: the decoder
    // refuses a record for many reasons before reaching the key check, so both
    // a record with the field and one with an unknown key fail identically.
    expect(NATIVE_PILOT_RUN_KEYS.has("sourceCitations")).toBe(true);
    expect(NATIVE_PILOT_RUN_KEYS.has("sourceCitationsDraft")).toBe(false);
  });

  it("names it in the release-documentation readiness allowlist", () => {
    // A valid record for this decoder needs a trusted inventory and an expected
    // repository; the companion readiness list is decoded end to end in
    // `scorecard-record.test.ts`, where that fixture exists.
    expect(RELEASE_READINESS_RUN_READER.admittedKeys).toContain("sourceCitations");
    expect(RELEASE_READINESS_RUN_READER.admittedKeys).not.toContain("sourceCitationsDraft");
  });

  it("names it in the doc-improvement run-key allowlist", () => {
    expect(DOC_IMPROVEMENT_RUN_KEYS.has("sourceCitations")).toBe(true);
    // Control: the allowlist is still closed.
    expect(DOC_IMPROVEMENT_RUN_KEYS.has("sourceCitationsDraft")).toBe(false);
  });

  it("names it in the live corpus run-key allowlist", () => {
    expect(CORPUS_LIVE_RUN_KEYS).toContain("sourceCitations");
    expect(CORPUS_LIVE_RUN_KEYS).not.toContain("sourceCitationsDraft");
  });
});

describe("every closed tool-failure category set admits the category (#983)", () => {
  it("names it in the executed-category list the workflow outcome decodes against", () => {
    expect([...EXECUTED_TOOL_FAILURE_CATEGORIES]).toContain("citation-refused");
    expect([...EXECUTED_TOOL_FAILURE_CATEGORIES]).not.toContain("citation-declined");
  });

  it("names it in the structural quality dispositions", () => {
    expect(toolFailureDispositions.has("citation-refused")).toBe(true);
    expect(toolFailureDispositions.has("citation-declined")).toBe(false);
  });

  it("admits malformed-arguments from the one record-contract source in every reader", async () => {
    const records = await import("../src/records/contracts.js");
    expect(EXECUTED_TOOL_FAILURE_CATEGORIES).toBe(records.EXECUTED_TOOL_FAILURE_CATEGORIES);
    expect([...EXECUTED_TOOL_FAILURE_CATEGORIES]).toContain("malformed-arguments");
    expect([...toolFailureDispositions].sort()).toEqual(
      [...records.TOOL_FAILURE_DISPOSITIONS].sort(),
    );
    const { safeFailureMessage } = await import("../src/harness/confined-tools.js");
    expect(safeFailureMessage("malformed-arguments")).toBe(
      "DocsFab could not run the tool: its arguments do not match the tool's declared parameters.",
    );
  });

  it("keeps the recorded order the producer emits decodable", async () => {
    // `inference-evidence` requires plain lexicographic order; the producer
    // sorts with `localeCompare`. A new category between them would be a record
    // its own decoder refuses, so the two orderings are compared directly.
    const { decodeTools } = await import("../src/execution/inference-evidence.js");
    const categories = [...EXECUTED_TOOL_FAILURE_CATEGORIES, "governance-stop"];
    const lexicographic = [...categories].sort();
    const producerOrder = [...categories].sort((left, right) => left.localeCompare(right));
    expect(producerOrder).toEqual(lexicographic);
    const executed = lexicographic.filter((category) => category !== "governance-stop");
    expect(
      decodeTools({
        totalCalls: executed.length,
        // Executed categories partition `failedCalls`; the decoder checks it.
        failedCalls: executed.length,
        byTool: [
          { name: "docsfab_cite_source", calls: executed.length, failures: executed.length },
        ],
        failureCategories: executed.map((category) => ({ category, count: 1 })),
      }).failureCategories?.map((entry) => entry.category),
    ).toEqual(executed);
  });
});
