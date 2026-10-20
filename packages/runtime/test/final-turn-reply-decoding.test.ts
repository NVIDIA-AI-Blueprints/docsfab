// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * A structured model reply is decoded from the final settled assistant message
 * of the attempt, never from text joined across every turn.
 *
 * Readiness, repository bootstrap and the semantic comparison proposal are
 * decoded outside the Pi harness. Each transcript runs through the shipped
 * composition:
 *
 * - T1 (false refusal): a tool turn opens with preamble prose, then the final
 *   turn is the valid document. Joined, `preamble{document}` is refused.
 * - T2 (false admission): a tool turn carries the document, then the final turn
 *   has reasoning and no text. Joined, the earlier document is admitted;
 *   final-turn only, the reply is blank.
 * - T3: a tool turn carries the document, then the final turn is prose only.
 *   Joined, the brace span is the earlier document; final-turn only, it is
 *   refused.
 */
import { HostRuntimeContractError } from "../src/host-invoker/contract-error.js";
import { createHash } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { canonicalDigest } from "../src/contract-kit/index.js";
import {
  InferenceStepError,
  type HarnessStepInput,
  type HarnessStepResult,
} from "../src/execution/contracts.js";
import {
  canonicalJson,
  parseHostRuntimeSemanticComparisonProposal,
  sealHostRuntimeSemanticComparisonChunk,
  type HostRuntimeRequestV1,
} from "../src/host-invoker/contracts.js";
import {
  decodeSemanticComparisonProposal,
  validateSemanticComparisonRun,
} from "../src/host-invoker/reconcile-product-behavior.js";
import { createRepositoryBootstrapAdapter } from "../src/onboarding/bootstrap-adapter.js";
import {
  REPOSITORY_BOOTSTRAP_RESULT_KIND,
  decodeRepositoryBootstrapResponse,
} from "../src/onboarding/bootstrap-result.js";
import {
  sourceReadinessBinding,
  unassessedSourceReadinessFixture,
  wrapSourceReadinessHarness,
} from "../src/readiness/assessment.js";
import { sourceReadinessSearch } from "../src/readiness/workflow.js";
import type { RunRecord } from "../src/records/contracts.js";
import type { RepositoryWorkspace } from "../src/repository/workspace/contracts.js";
import { prepareRepositoryWorkspace } from "../src/repository/workspace/materialize.js";
import {
  instantiateWorkflowSearchTargets,
  normalizeWorkflowSearchEvidence,
} from "../src/workflow-contracts/search.js";
import { getWorkflow } from "../src/workflow-registry/catalog.js";
import { initFixtureRepo } from "./helpers/git.js";
import { searchEvidenceFixture } from "./helpers/search-evidence-fixture.js";
import {
  createAuditHarness,
  narratedToolTurn,
  scriptedProvider,
  textTurn,
  thinkingTurn,
  toolTurnWithPreamble,
} from "./support/pi-harness-session-fixtures.js";

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const GUIDE = "Run `make docs` before every release.";
const PREAMBLE = "I will read the tracked guide before answering.";
const CLOSING_PROSE = "The assessment above is my final answer.";
const REASONING = "The document is complete.";
const fence = (body: string) => `\`\`\`json\n${body}\n\`\`\``;

let root: string, repository: string, revision: string;
const workspaces: RepositoryWorkspace[] = [];
beforeAll(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "docsfab-final-turn-")));
  repository = join(root, "repository");
  revision = await initFixtureRepo(
    repository,
    { "README.md": `# Fixture\n\n${GUIDE}\n`, "AGENTS.md": `# Agents\n\n${GUIDE}\n` },
    { message: "Final-turn decoding fixture" },
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
});
afterAll(async () => {
  for (const item of workspaces) await item.dispose();
  if (root) await rm(root, { recursive: true, force: true });
});

async function workspace(): Promise<RepositoryWorkspace> {
  const item = await prepareRepositoryWorkspace(repository, revision);
  workspaces.push(item);
  return item;
}

const readCall = (id: string) => [{ id, name: "read", arguments: { path: "README.md" } }];
const readTurn = (id: string) => toolTurnWithPreamble(PREAMBLE, readCall(id));
function citingDocument(input: HarnessStepInput): string {
  const document = JSON.parse(unassessedSourceReadinessFixture(input));
  document.criteria[0] = {
    ...document.criteria[0],
    status: "met",
    reason: "The tracked guide states the release command.",
    citations: [{ path: "README.md", startLine: 3, endLine: 3 }],
  };
  return JSON.stringify(document);
}
function mintedDocument(text: string) {
  const document = JSON.parse(text);
  document.criteria[0].citations[0].quote = GUIDE;
  return document;
}

async function outcome<T>(run: () => Promise<T>): Promise<T | Error> {
  return run().catch((error: unknown) => error as Error);
}

/**
 * Which turn answered, read from the attempt's `turns[]` evidence: the last
 * request, issued after every tool call. A summary equal to that turn's text
 * alone is the reply the decoder read.
 */
function expectAnsweredByLastTurn(
  result: Pick<HarnessStepResult, "turns" | "tools">,
  turns: number,
): void {
  expect(result.turns).toHaveLength(turns);
  const last = result.turns!.at(-1)!;
  expect(last.turn).toBe(turns);
  expect(last.toolCalls).toBeGreaterThan(0);
  expect(last.toolCalls).toBe(result.tools!.totalCalls);
}

// ------------------------------------------------------------ source readiness

function readinessInput(actual: RepositoryWorkspace): HarnessStepInput {
  const workflow = getWorkflow("readiness"),
    identitySha256 = sha("final-turn-readiness");
  const searchEvidence = normalizeWorkflowSearchEvidence({
    plan: sourceReadinessSearch,
    repository: { sourcePath: repository, requestedRevision: revision, revision },
    repositoryIdentitySha256: identitySha256,
    searches: instantiateWorkflowSearchTargets(sourceReadinessSearch, {
      identitySha256,
      revision,
    }).map((target) =>
      searchEvidenceFixture(
        target,
        Object.fromEntries(target.requiredProbes.map((probe) => [probe.id, "match"])),
      ),
    ),
  });
  return {
    runId: "run:final-turn-readiness",
    repositoryPath: actual.path,
    workflow,
    step: workflow.steps[0]!,
    evidenceIdentity: {
      repositoryRevision: revision,
      contextPacketDigest: sha("context"),
      searchEvidenceSha256: searchEvidence.evidenceSha256,
    },
    searchEvidence,
  };
}

describe("source readiness decodes the final turn only (#1427)", () => {
  it("admits the final-turn assessment after a preamble tool turn (T1)", async () => {
    const actual = await workspace();
    const input = readinessInput(actual);
    const document = citingDocument(input);
    vi.stubGlobal(
      "fetch",
      scriptedProvider([
        toolTurnWithPreamble(PREAMBLE, readCall("readiness-read-1")),
        textTurn(document),
      ]),
    );
    const harness = wrapSourceReadinessHarness(await createAuditHarness(), actual);
    const result = await harness.runStep(input);
    expect(JSON.parse(result.summary)).toEqual(mintedDocument(document));
    expectAnsweredByLastTurn(result, 2);
  });

  it("does not admit an earlier turn's assessment behind a reasoning-only final turn (T2)", async () => {
    const actual = await workspace();
    const input = readinessInput(actual);
    const document = unassessedSourceReadinessFixture(input);
    vi.stubGlobal(
      "fetch",
      scriptedProvider([
        narratedToolTurn(document, readCall("readiness-read-2")),
        thinkingTurn(REASONING),
      ]),
    );
    const harness = wrapSourceReadinessHarness(await createAuditHarness(), actual);
    const error = await outcome(() => harness.runStep(input));
    expect(error).toBeInstanceOf(InferenceStepError);
    expect(error).toMatchObject({
      category: "blank-response",
      retryable: true,
      message: "Model returned a blank response.",
    });
  });

  it("refuses an earlier turn's assessment behind a prose-only final turn (T3)", async () => {
    const actual = await workspace();
    const input = readinessInput(actual);
    const document = unassessedSourceReadinessFixture(input);
    vi.stubGlobal(
      "fetch",
      scriptedProvider([
        narratedToolTurn(document, readCall("readiness-read-3")),
        textTurn(CLOSING_PROSE),
      ]),
    );
    const harness = wrapSourceReadinessHarness(await createAuditHarness(), actual);
    const error = await outcome(() => harness.runStep(input));
    expect(error).toBeInstanceOf(InferenceStepError);
    expect(error).toMatchObject({
      category: "malformed-response",
      retryable: true,
      message: "Source readiness assessment rejected: invalid-assessment.",
    });
  });

  it("admits a fenced final-turn assessment through the shared envelope policy", async () => {
    const actual = await workspace();
    const input = readinessInput(actual);
    const document = citingDocument(input);
    vi.stubGlobal(
      "fetch",
      scriptedProvider([
        readTurn("readiness-fenced-read"),
        textTurn(`Here is the assessment:\n\n${fence(document)}`),
      ]),
    );
    const result = await wrapSourceReadinessHarness(await createAuditHarness(), actual).runStep(
      input,
    );
    expect(JSON.parse(result.summary)).toEqual(mintedDocument(document));
  });
});

describe("source readiness mints cited quotes from the lines a read showed (#1741)", () => {
  it("admits a locator after a real read and mints the exact line", async () => {
    const actual = await workspace();
    const input = readinessInput(actual);
    const document = citingDocument(input);
    vi.stubGlobal("fetch", scriptedProvider([readTurn("readiness-cite-1"), textTurn(document)]));
    const result = await wrapSourceReadinessHarness(await createAuditHarness(), actual).runStep(
      input,
    );
    const admitted = JSON.parse(document);
    admitted.criteria[0].citations[0].quote = GUIDE;
    expect(JSON.parse(result.summary)).toEqual(admitted);
    expect(result.observedSourceLines).toBeUndefined();
  });

  it("refuses the same locator when no read showed the line, as a correctable catalog rule", async () => {
    const actual = await workspace();
    const input = readinessInput(actual);
    vi.stubGlobal("fetch", scriptedProvider([textTurn(citingDocument(input))]));
    const harness = wrapSourceReadinessHarness(await createAuditHarness(), actual);
    const error = await outcome(() => harness.runStep(input));
    expect(error).toBeInstanceOf(InferenceStepError);
    expect(error).toMatchObject({
      category: "malformed-response",
      retryable: true,
      rejection: { code: "source-citation-unobserved", location: "$.criteria[].citations[]" },
    });
  });
});

// -------------------------------------------------------- repository bootstrap

function bootstrapInput(actual: RepositoryWorkspace, stepId?: string): HarnessStepInput {
  const workflow = getWorkflow("bootstrap");
  const step = workflow.steps[0]!;
  return {
    runId: "run-final-turn-bootstrap",
    repositoryPath: actual.path,
    workflow,
    step: stepId ? { ...step, id: stepId } : step,
    evidenceIdentity: { repositoryRevision: actual.revision },
  };
}

function bootstrapDocument(input: HarnessStepInput): string {
  return JSON.stringify({
    schemaVersion: 1,
    kind: REPOSITORY_BOOTSTRAP_RESULT_KIND,
    binding: {
      runId: input.runId,
      repositoryRevision: input.evidenceIdentity!.repositoryRevision,
      contextSha256: canonicalDigest({ contextPacket: null, instruction: null }),
    },
    decision: "needs-input",
    summary: "The release owner is not named in tracked guidance.",
    changedPaths: [],
    evidence: [{ path: "README.md", startLine: 3, endLine: 3 }],
    assumptions: [],
    missingEvidence: [],
    questions: ["Who owns the release step?"],
  });
}

describe("repository bootstrap decodes the final turn only (#1427)", () => {
  it("admits the final-turn result after a preamble tool turn (T1)", async () => {
    const actual = await workspace();
    const input = bootstrapInput(actual);
    const document = bootstrapDocument(input);
    vi.stubGlobal(
      "fetch",
      scriptedProvider([
        toolTurnWithPreamble(PREAMBLE, readCall("bootstrap-read-1")),
        textTurn(document),
      ]),
    );
    const adapter = createRepositoryBootstrapAdapter({
      harness: await createAuditHarness(),
      workspace: actual,
    });
    const result = await adapter.harness.runStep(input);
    // The read turn showed README.md line 3, so the host mints its exact text.
    const admitted = JSON.parse(document);
    admitted.evidence[0].quote = GUIDE;
    expect(JSON.parse(result.summary)).toEqual(admitted);
    expect(result.outcome).toBe("succeeded");
    expectAnsweredByLastTurn(result, 2);
  });

  it("does not admit an earlier turn's result behind a reasoning-only final turn (T2)", async () => {
    const actual = await workspace();
    const input = bootstrapInput(actual);
    vi.stubGlobal(
      "fetch",
      scriptedProvider([
        narratedToolTurn(bootstrapDocument(input), readCall("bootstrap-read-2")),
        thinkingTurn(REASONING),
      ]),
    );
    const adapter = createRepositoryBootstrapAdapter({
      harness: await createAuditHarness(),
      workspace: actual,
    });
    const error = await outcome(() => adapter.harness.runStep(input));
    expect(error).toBeInstanceOf(InferenceStepError);
    expect(error).toMatchObject({
      category: "blank-response",
      retryable: true,
      message: "Model returned a blank response.",
    });
  });

  it("refuses an earlier turn's result behind a prose-only final turn (T3)", async () => {
    const actual = await workspace();
    const input = bootstrapInput(actual);
    vi.stubGlobal(
      "fetch",
      scriptedProvider([
        narratedToolTurn(bootstrapDocument(input), readCall("bootstrap-read-3")),
        textTurn(CLOSING_PROSE),
      ]),
    );
    const adapter = createRepositoryBootstrapAdapter({
      harness: await createAuditHarness(),
      workspace: actual,
    });
    const error = await outcome(() => adapter.harness.runStep(input));
    // Recorded on the attempt as the refused result, with its bootstrap code.
    expect(error).toBeInstanceOf(InferenceStepError);
    expect(error).toMatchObject({
      category: "malformed-response",
      retryable: false,
      message: "Repository bootstrap result refused: response-json.",
      rejection: { code: "repository-bootstrap-response-json", location: "$" },
    });
  });

  it("admits a fenced final-turn result through the shared envelope policy", async () => {
    const actual = await workspace();
    const input = bootstrapInput(actual);
    const document = bootstrapDocument(input);
    vi.stubGlobal(
      "fetch",
      scriptedProvider([readTurn("bootstrap-read-fenced"), textTurn(fence(document))]),
    );
    const adapter = createRepositoryBootstrapAdapter({
      harness: await createAuditHarness(),
      workspace: actual,
    });
    const result = await adapter.harness.runStep(input);
    const admitted = JSON.parse(document);
    admitted.evidence[0].quote = GUIDE;
    expect(JSON.parse(result.summary)).toEqual(admitted);
  });

  it("refuses a citation of lines no read in the attempt showed (#1741)", async () => {
    // Adjacent condition of the fenced positive control above: the same reply
    // with no read turn. The citation is well formed and in range, but the
    // model was never shown README.md, so no quote is minted.
    const actual = await workspace();
    const input = bootstrapInput(actual);
    vi.stubGlobal("fetch", scriptedProvider([textTurn(fence(bootstrapDocument(input)))]));
    const adapter = createRepositoryBootstrapAdapter({
      harness: await createAuditHarness(),
      workspace: actual,
    });
    const error = await outcome(() => adapter.harness.runStep(input));
    expect(error).toBeInstanceOf(InferenceStepError);
    expect(error).toMatchObject({
      category: "malformed-response",
      message:
        "Repository bootstrap result refused: Source citation rejected: source-citation-unobserved.",
      rejection: { code: "source-citation-unobserved", location: "$.evidence[]" },
    });
  });

  it("keeps joined text for a bootstrap-workflow step the adapter does not decode", async () => {
    // The same workflow and skill, a different step: the final-turn rule does not
    // select it, so the harness keeps the joined narration.
    const actual = await workspace();
    const input = bootstrapInput(actual, "bootstrap-guidance-notes");
    vi.stubGlobal(
      "fetch",
      scriptedProvider([
        toolTurnWithPreamble(PREAMBLE, readCall("bootstrap-read-4")),
        textTurn(CLOSING_PROSE),
      ]),
    );
    const adapter = createRepositoryBootstrapAdapter({
      harness: await createAuditHarness(),
      workspace: actual,
    });
    const result = await adapter.harness.runStep(input);
    expect(result.summary).toBe(`${PREAMBLE}${CLOSING_PROSE}`);
  });
});

// --------------------------------------------------------- semantic comparison

function semanticFixture() {
  const statement = "Ordinary messages require a mention before a reply.";
  const content = "export const requiresMention = true;\n";
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
        relationship: "compatible",
        assertion: "observed-implementation",
        explanation: "The after source keeps the mention requirement.",
        scope: "ordinary messages",
        confidence: "high",
        modelCitation: { evidenceId: "CLAIM-MENTION", quote: statement },
        sourceCitations: [{ evidenceId: "source-after", quote: content }],
      },
    ],
    missingEvidence: [],
  };
  const request = {
    workflow: "reconcile-product-behavior",
    packet: { semanticComparison: chunk },
  } as unknown as HostRuntimeRequestV1;
  return { chunk, proposal, request };
}

function semanticInput(repositoryPath: string): HarnessStepInput {
  const workflow = getWorkflow("reconcile-product-behavior");
  return {
    runId: "run-final-turn-semantic",
    repositoryPath,
    workflow,
    step: workflow.steps[0]!,
    evidenceIdentity: { repositoryRevision: revision },
  };
}

/** The succeeded record the runner would retain for this one step's result. */
function semanticRecord(summary: string): RunRecord {
  return {
    status: "succeeded",
    steps: [{ id: "compare-product-behavior", status: "succeeded", summary }],
  } as unknown as RunRecord;
}

describe("semantic comparison decodes the final turn only (#1427)", () => {
  it("admits the final-turn proposal after a preamble tool turn (T1)", async () => {
    const actual = await workspace();
    const { chunk, proposal, request } = semanticFixture();
    const document = JSON.stringify(proposal);
    vi.stubGlobal(
      "fetch",
      scriptedProvider([
        toolTurnWithPreamble(PREAMBLE, readCall("semantic-read-1")),
        textTurn(document),
      ]),
    );
    const result = await (await createAuditHarness()).runStep(semanticInput(actual.path));
    expectAnsweredByLastTurn(result, 2);
    const validated = validateSemanticComparisonRun(semanticRecord(result.summary), request);
    expect(validated.steps[0]!.summary).toBe(
      canonicalJson(parseHostRuntimeSemanticComparisonProposal(proposal, chunk)),
    );
  });

  it("does not admit an earlier turn's proposal behind a reasoning-only final turn (T2)", async () => {
    const actual = await workspace();
    const { proposal } = semanticFixture();
    vi.stubGlobal(
      "fetch",
      scriptedProvider([
        narratedToolTurn(JSON.stringify(proposal), readCall("semantic-read-2")),
        thinkingTurn(REASONING),
      ]),
    );
    const error = await outcome(async () =>
      (await createAuditHarness()).runStep(semanticInput(actual.path)),
    );
    expect(error).toBeInstanceOf(InferenceStepError);
    expect(error).toMatchObject({
      category: "blank-response",
      retryable: true,
      message: "Model returned a blank response.",
    });
  });

  it("refuses an earlier turn's proposal behind a prose-only final turn (T3)", async () => {
    const actual = await workspace();
    const { proposal, request } = semanticFixture();
    vi.stubGlobal(
      "fetch",
      scriptedProvider([
        narratedToolTurn(JSON.stringify(proposal), readCall("semantic-read-3")),
        textTurn(CLOSING_PROSE),
      ]),
    );
    const result = await (await createAuditHarness()).runStep(semanticInput(actual.path));
    expect(() => validateSemanticComparisonRun(semanticRecord(result.summary), request)).toThrow(
      "The semantic comparison reply was refused: semantic-reply-proposal-not-json.",
    );
  });

  it("admits a fenced final-turn proposal through the shared envelope policy", async () => {
    const actual = await workspace();
    const { chunk, proposal, request } = semanticFixture();
    vi.stubGlobal("fetch", scriptedProvider([textTurn(fence(JSON.stringify(proposal)))]));
    const result = await (await createAuditHarness()).runStep(semanticInput(actual.path));
    const validated = validateSemanticComparisonRun(semanticRecord(result.summary), request);
    expect(validated.steps[0]!.summary).toBe(
      canonicalJson(parseHostRuntimeSemanticComparisonProposal(proposal, chunk)),
    );
  });
});

// ------------------------------------------------ the strict evidence parser

/**
 * The envelope policy picks the candidate span; the strict JSON evidence parser
 * reads it. `JSON.parse` would keep the last duplicate key and round an unsafe
 * integer, so the value parser alone cannot tell these forms from valid ones.
 */
const UNSAFE_INTEGER = (BigInt(Number.MAX_SAFE_INTEGER) + 1n).toString();
function strictParserRefusals(document: string): string[] {
  const duplicated = document.replace('"schemaVersion":1', '"schemaVersion":1,"schemaVersion":1');
  const unsafe = document.replace('"schemaVersion":1', `"schemaVersion":${UNSAFE_INTEGER}`);
  expect(duplicated).not.toBe(document);
  expect(unsafe).not.toBe(document);
  return [duplicated, fence(duplicated), unsafe, fence(unsafe)];
}

describe("model replies are read by the strict evidence parser (#1427)", () => {
  it("refuses a duplicate key or an unsafe integer in a bootstrap reply, bare or fenced", () => {
    const input = {
      runId: "run-final-turn-bootstrap",
      evidenceIdentity: { repositoryRevision: sha("strict-parser-revision") },
    } as HarnessStepInput;
    const document = bootstrapDocument(input);
    // Positive control: the same document, bare and fenced, is admitted.
    for (const text of [document, fence(document)])
      expect(decodeRepositoryBootstrapResponse(text)).toEqual(JSON.parse(document));
    for (const text of strictParserRefusals(document))
      expect(() => decodeRepositoryBootstrapResponse(text)).toThrowError(
        expect.objectContaining({
          name: "RepositoryBootstrapResultError",
          code: "repository-bootstrap-response-json",
        }),
      );
  });

  it("refuses a duplicate key or an unsafe integer in a semantic comparison reply, bare or fenced", () => {
    const { chunk, proposal } = semanticFixture();
    const document = JSON.stringify(proposal);
    // Positive control: the same proposal, bare and fenced, is admitted.
    for (const text of [document, fence(document)])
      expect(decodeSemanticComparisonProposal(text, chunk)).toEqual(
        parseHostRuntimeSemanticComparisonProposal(proposal, chunk),
      );
    for (const text of strictParserRefusals(document))
      expect(() => decodeSemanticComparisonProposal(text, chunk)).toThrowError(
        new HostRuntimeContractError("semantic-proposal-not-json"),
      );
  });

  // The parse-failure catch handles only a span the strict parser refuses; a
  // strict-parseable wrong value keeps the value parser's refusal.
  it("hands a strict-parseable wrong-version reply to the value parser", () => {
    const wrongVersion = (document: string) =>
      document.replace('"schemaVersion":1', '"schemaVersion":2');
    const bootstrap = wrongVersion(
      bootstrapDocument({
        runId: "run-final-turn-bootstrap",
        evidenceIdentity: { repositoryRevision: sha("strict-parser-revision") },
      } as HarnessStepInput),
    );
    for (const text of [bootstrap, fence(bootstrap)])
      expect(() => decodeRepositoryBootstrapResponse(text)).toThrowError(
        expect.objectContaining({ code: "repository-bootstrap-schema" }),
      );
    // The host injects the semantic binding fields, so its wrong value is a
    // non-list assessments field instead.
    const { chunk, proposal } = semanticFixture();
    const semantic = JSON.stringify({ ...proposal, assessments: "none" });
    for (const text of [semantic, fence(semantic)])
      expect(() => decodeSemanticComparisonProposal(text, chunk)).toThrowError(
        expect.objectContaining({
          name: "HostRuntimeContractError",
          code: "semantic-proposal-binding",
        }),
      );
  });
});

// ----------------------------------------------------- the adjacent condition

describe("an ordinary narrated step keeps its joined reply (#1427)", () => {
  it("returns every turn's narration for a review step outside the final-turn set", async () => {
    // A review audit is published as it streams, so it keeps the joined narration.
    const actual = await workspace();
    const workflow = getWorkflow("review-documentation");
    vi.stubGlobal(
      "fetch",
      scriptedProvider([
        toolTurnWithPreamble(PREAMBLE, readCall("review-read-1")),
        textTurn(CLOSING_PROSE),
      ]),
    );
    const result = await (await createAuditHarness()).runStep({
      runId: "run-final-turn-review",
      repositoryPath: actual.path,
      workflow,
      step: workflow.steps[0]!,
      evidenceIdentity: { repositoryRevision: revision },
    });
    expect(result.summary).toBe(`${PREAMBLE}${CLOSING_PROSE}`);
  });

  it("returns the joined narration for the release readiness step that shares the readiness skill", async () => {
    // The same `assess-documentation-readiness` skill under the release readiness
    // workflow, whose reply no JSON decoder reads.
    const actual = await workspace();
    const workflow = getWorkflow("release-documentation-readiness");
    vi.stubGlobal(
      "fetch",
      scriptedProvider([
        toolTurnWithPreamble(PREAMBLE, readCall("release-read-1")),
        textTurn(CLOSING_PROSE),
      ]),
    );
    const result = await (await createAuditHarness()).runStep({
      runId: "run-final-turn-release",
      repositoryPath: actual.path,
      workflow,
      step: workflow.steps[0]!,
      evidenceIdentity: { repositoryRevision: revision },
    });
    expect(result.summary).toBe(`${PREAMBLE}${CLOSING_PROSE}`);
  });

  it("returns the joined narration for a semantic comparison workflow step that is not the comparison", async () => {
    // The same workflow and skill, a step id the host invoker never decodes.
    const actual = await workspace();
    const input = semanticInput(actual.path);
    vi.stubGlobal(
      "fetch",
      scriptedProvider([
        toolTurnWithPreamble(PREAMBLE, readCall("semantic-read-4")),
        textTurn(CLOSING_PROSE),
      ]),
    );
    const result = await (await createAuditHarness()).runStep({
      ...input,
      step: { ...input.step, id: "compare-product-behavior-notes" },
    });
    expect(result.summary).toBe(`${PREAMBLE}${CLOSING_PROSE}`);
  });
});
