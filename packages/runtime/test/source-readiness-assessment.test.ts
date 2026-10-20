// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  InferenceStepError,
  type AgentHarness,
  type HarnessStepInput,
  type HarnessStepResult,
} from "../src/execution/contracts.js";
import { prepareRepositoryWorkspace } from "../src/repository/workspace/materialize.js";
import type { RepositoryWorkspace } from "../src/repository/workspace/contracts.js";
import { getWorkflow } from "../src/workflow-registry/catalog.js";
import {
  instantiateWorkflowSearchTargets,
  normalizeWorkflowSearchEvidence,
} from "../src/workflow-contracts/search.js";
import {
  admitSourceReadinessReply,
  decodeSourceReadinessAssessment,
  decodeSourceReadinessReply,
  readSourceReadinessCitations,
  sourceReadinessBinding,
  sourceReadinessCitedPaths,
  sourceReadinessResponseContract,
  sourceReadinessStepError,
  SourceReadinessAssessmentError,
  verifySourceReadinessCitations,
  wrapSourceReadinessHarness,
  unassessedSourceReadinessFixture,
  type SourceReadinessBinding,
} from "../src/readiness/assessment.js";
import { canonicalJson } from "../src/contract-kit/index.js";
import { limit } from "../src/config/limits.js";
import { responseCorrectionInstruction } from "../src/harness/response-correction.js";
import {
  SourceCitationRefusal,
  sourceCitationContractText,
  type ObservedSourceLinesV1,
} from "../src/repository/source-citation.js";
import { sourceReadinessSearch } from "../src/readiness/workflow.js";
import { buildDocsFabStepPrompt } from "../src/harness/pi-session.js";
import { searchEvidenceFixture } from "./helpers/search-evidence-fixture.js";
import {
  ReadinessWorkflowOutcomeError,
  ReadinessWorkflowOutcomeProjector,
} from "../src/readiness/outcome-projector.js";
import type { RunRecord } from "../src/records/contracts.js";
import { initFixtureRepo } from "./helpers/git.js";
import { configureCredentialsForEachTest } from "./helpers/configured-credential.js";

// Configured for every test: only a configured credential is refused (#1807).
configureCredentialsForEachTest("syntheticxxxxxxxxxxxxxxxxxxxxxxxx");

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const QUOTE = "Connect to cafe\u0301, then publish. 区域 🚀";
const CREDENTIAL = "api_key=syntheticxxxxxxxxxxxxxxxxxxxxxxxx";
/** The lines a confined read of the whole guide shows. */
const READ_GUIDE: ObservedSourceLinesV1 = { "docs/guide.md": [[1, 5]] };
let root: string, repository: string, revision: string;
const workspaces: RepositoryWorkspace[] = [];
beforeAll(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "docsfab-readiness-assessment-")));
  repository = join(root, "repository");
  revision = await initFixtureRepo(
    repository,
    {
      "docs/guide.md": `# Setup\n\n${QUOTE}\n\nEvery endpoint has a public contract.\n`,
      "docs/credentials.md": `# Access\n\n${CREDENTIAL}\n`,
    },
    { message: "Readiness source fixture" },
  );
});
afterAll(async () => {
  for (const item of workspaces) await item.dispose();
  if (root) await rm(root, { recursive: true, force: true });
});
async function workspace() {
  const item = await prepareRepositoryWorkspace(repository, revision);
  workspaces.push(item);
  return item;
}
function binding(): SourceReadinessBinding {
  return {
    runId: "run:source-readiness",
    repositoryRevision: revision,
    searchEvidenceSha256: sha("synthetic-search-binding"),
    contextPacketSha256: sha("synthetic-context-binding"),
  };
}
function response(expected = binding()) {
  return {
    schemaVersion: 1,
    kind: "docsfab-source-readiness-assessment",
    ...expected,
    summary: "Assessment preserves cafe\u0301 and 区域 without converting it into approval.",
    criteria: ["source-completeness", "source-usability"].map((criterionId) => ({
      criterionId,
      status: "met",
      reason: "The tracked setup source states the exact operation.",
      citations: [{ path: "docs/guide.md", startLine: 3, endLine: 3 }],
    })),
  };
}
/** The admitted artifact `response()` mints: each citation gains its exact quote. */
function artifact(expected = binding()) {
  const reply = response(expected);
  return {
    ...reply,
    criteria: reply.criteria.map((row) => ({
      ...row,
      citations: row.citations.map((citation) => ({ ...citation, quote: QUOTE })),
    })),
  };
}
async function admit(text: string, actual: RepositoryWorkspace, observed = READ_GUIDE) {
  const reply = decodeSourceReadinessReply(text, binding());
  const sources = await readSourceReadinessCitations(actual, sourceReadinessCitedPaths(reply));
  return admitSourceReadinessReply(reply, sources, observed);
}
async function refusalOf(run: () => unknown): Promise<unknown> {
  try {
    await run();
  } catch (error) {
    return error;
  }
  return undefined;
}
function stepInput(actual: RepositoryWorkspace): HarnessStepInput {
  const workflow = getWorkflow("readiness"),
    identity = sha("synthetic-readiness-test-repository");
  const searches = instantiateWorkflowSearchTargets(sourceReadinessSearch, {
    identitySha256: identity,
    revision,
  }).map((target) =>
    searchEvidenceFixture(
      target,
      Object.fromEntries(target.requiredProbes.map((probe) => [probe.id, "match"])),
    ),
  );
  const searchEvidence = normalizeWorkflowSearchEvidence({
    plan: sourceReadinessSearch,
    repository: { sourcePath: repository, requestedRevision: revision, revision },
    repositoryIdentitySha256: identity,
    searches,
  });
  return {
    runId: "run:source-readiness",
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

describe("source readiness assessment contract", () => {
  it("mints the exact cited lines, preserving Unicode, from an actual tracked Git export", async () => {
    const actual = await workspace(),
      admitted = await admit(JSON.stringify(response()), actual);
    expect(admitted.criteria[0]!.citations[0]).toEqual({
      path: "docs/guide.md",
      startLine: 3,
      endLine: 3,
      quote: QUOTE,
    });
    expect(admitted.summary).toContain("cafe\u0301");
    expect(Object.isFrozen(admitted.criteria[0]!.citations)).toBe(true);
    // The admitted artifact round-trips through its own decoder and re-mints.
    const decoded = decodeSourceReadinessAssessment(canonicalJson(admitted), binding());
    expect(decoded).toEqual(artifact());
    await verifySourceReadinessCitations(decoded, actual);
    const normalized = artifact();
    normalized.criteria[0]!.citations[0]!.quote = QUOTE.normalize("NFC");
    await expect(
      verifySourceReadinessCitations(
        decodeSourceReadinessAssessment(JSON.stringify(normalized), binding()),
        actual,
      ),
    ).rejects.toMatchObject({ code: "citation-mismatch" });
  });
  it("refuses a quoted or paraphrased citation as the correctable locator rule (#1741)", async () => {
    // A path with paraphrased text and no lines.
    const changed = response();
    changed.criteria[0]!.citations = [
      { path: "docs/guide.md", quote: "Connect to the cafe, then publish." } as never,
    ];
    const error = await refusalOf(() =>
      decodeSourceReadinessReply(JSON.stringify(changed), binding()),
    );
    expect(error).toBeInstanceOf(SourceCitationRefusal);
    expect(error).toMatchObject({
      rejection: { code: "source-citation-locator-shape", location: "$.criteria[].citations[]" },
    });
    // Locator plus a quote is refused too: the model never supplies text.
    changed.criteria[0]!.citations = [
      { path: "docs/guide.md", startLine: 3, endLine: 3, quote: QUOTE } as never,
    ];
    expect(() => decodeSourceReadinessReply(JSON.stringify(changed), binding())).toThrowError(
      expect.objectContaining({
        rejection: expect.objectContaining({ code: "source-citation-locator-shape" }),
      }),
    );
    for (const citation of [
      { path: "docs/guide.md", startLine: 0, endLine: 1 },
      { path: "docs/guide.md", startLine: 3, endLine: 2 },
      { path: "docs/guide.md", startLine: 1.5, endLine: 2 },
      { path: "docs/guide.md", startLine: "3", endLine: 3 },
      ...["/etc/passwd", "../guide.md", "docs/../guide.md", "docs\\guide.md", "docs//guide.md"].map(
        (path) => ({ path, startLine: 1, endLine: 1 }),
      ),
    ]) {
      changed.criteria[0]!.citations = [citation as never];
      expect(
        () => decodeSourceReadinessReply(JSON.stringify(changed), binding()),
        JSON.stringify(citation),
      ).toThrowError(
        expect.objectContaining({
          rejection: expect.objectContaining({ code: "source-citation-locator-shape" }),
        }),
      );
    }
  });
  it("refuses independent run, revision, search and context substitution", () => {
    for (const [key, value] of Object.entries({
      runId: "run:another",
      repositoryRevision: "a".repeat(40),
      searchEvidenceSha256: sha("another-search"),
      contextPacketSha256: sha("another-context"),
    }))
      expect(
        () =>
          decodeSourceReadinessReply(JSON.stringify({ ...response(), [key]: value }), binding()),
        key,
      ).toThrowError(new SourceReadinessAssessmentError("binding-mismatch"));
    const noContext = { ...binding(), contextPacketSha256: null };
    expect(
      decodeSourceReadinessReply(JSON.stringify(response(noContext)), noContext)
        .contextPacketSha256,
    ).toBeNull();
    expect(() => decodeSourceReadinessReply(JSON.stringify(response()), noContext)).toThrow(
      SourceReadinessAssessmentError,
    );
  });
  it("requires exactly the declared criteria and closed fields instead of interpreting ready prose", () => {
    const original = response();
    for (const value of [
      { ...original, criteria: original.criteria.slice(1) },
      { ...original, criteria: [...original.criteria, original.criteria[0]] },
      {
        ...original,
        criteria: [
          original.criteria[0],
          { ...original.criteria[1], criterionId: "foreign-rubric" },
        ],
      },
      { ...original, ready: true },
      { ...original, criteria: [{ ...original.criteria[0], ready: true }, original.criteria[1]] },
      {
        ...original,
        criteria: [{ ...original.criteria[0], status: "ready" }, original.criteria[1]],
      },
    ])
      expect(() => decodeSourceReadinessReply(JSON.stringify(value), binding())).toThrowError(
        new SourceReadinessAssessmentError("invalid-assessment"),
      );
    for (const text of [
      "Everything is ready.",
      JSON.stringify(original).replace('"schemaVersion":1', '"schemaVersion":1,"schemaVersion":1'),
      // A fenced duplicate key: the shared envelope policy opens the fence,
      // and the strict parser still refuses the document inside it.
      `\`\`\`json\n${JSON.stringify(original).replace('"schemaVersion":1', '"schemaVersion":1,"schemaVersion":1')}\n\`\`\``,
    ])
      expect(() => decodeSourceReadinessReply(text, binding())).toThrowError(
        new SourceReadinessAssessmentError("invalid-assessment"),
      );
    // A fenced assessment is read through the shared model-reply envelope policy.
    expect(
      decodeSourceReadinessReply(`\`\`\`json\n${JSON.stringify(original)}\n\`\`\``, binding()),
    ).toEqual(decodeSourceReadinessReply(JSON.stringify(original), binding()));
  });
  it("requires citations for met and unmet while preserving explicit unassessed judgments", () => {
    for (const status of ["met", "unmet"]) {
      const changed = response();
      changed.criteria[0] = { ...changed.criteria[0]!, status, citations: [] };
      expect(() => decodeSourceReadinessReply(JSON.stringify(changed), binding())).toThrowError(
        new SourceReadinessAssessmentError("invalid-assessment"),
      );
    }
    const changed = response();
    changed.criteria = changed.criteria.map((row) => ({
      ...row,
      status: "unassessed",
      citations: [],
    }));
    expect(
      decodeSourceReadinessReply(JSON.stringify(changed), binding()).criteria.every(
        (row) => row.status === "unassessed",
      ),
    ).toBe(true);
  });
  it("refuses untracked, unread, out-of-range and blank citations with their catalog rules", async () => {
    const actual = await workspace();
    await writeFile(join(actual.path, "untracked.md"), `${QUOTE}\n`);
    const cases: [object, ObservedSourceLinesV1, string][] = [
      [
        { path: "untracked.md", startLine: 1, endLine: 1 },
        { "untracked.md": [[1, 1]] },
        "source-citation-untracked-path",
      ],
      [
        { path: "missing.md", startLine: 1, endLine: 1 },
        READ_GUIDE,
        "source-citation-untracked-path",
      ],
      [
        { path: "docs/guide.md", startLine: 5, endLine: 7 },
        READ_GUIDE,
        "source-citation-line-range",
      ],
      [
        { path: "docs/guide.md", startLine: 3, endLine: 3 },
        {
          "docs/guide.md": [
            [1, 2],
            [4, 5],
          ],
        },
        "source-citation-unobserved",
      ],
      [
        { path: "docs/guide.md", startLine: 2, endLine: 2 },
        READ_GUIDE,
        "source-citation-blank-span",
      ],
    ];
    for (const [citation, observed, code] of cases) {
      const changed = response();
      changed.criteria[0]!.citations = [citation as never];
      const error = await refusalOf(() => admit(JSON.stringify(changed), actual, observed));
      expect(error, code).toMatchObject({
        rejection: { code, location: "$.criteria[].citations[]" },
      });
    }
    // Positive control for the same cases: the last line, read, is admitted.
    const last = response();
    last.criteria[0]!.citations = [{ path: "docs/guide.md", startLine: 5, endLine: 5 }];
    const admitted = await admit(JSON.stringify(last), actual);
    expect(admitted.criteria[0]!.citations[0]!.quote).toBe("Every endpoint has a public contract.");
  });
  it("screens minted text for credential material as terminal, like the model's own text", async () => {
    const actual = await workspace();
    const changed = response();
    changed.criteria[0]!.citations = [{ path: "docs/credentials.md", startLine: 3, endLine: 3 }];
    const error = await refusalOf(() =>
      admit(JSON.stringify(changed), actual, { ...READ_GUIDE, "docs/credentials.md": [[1, 3]] }),
    );
    expect(error).toEqual(new SourceReadinessAssessmentError("credential-material"));
  });
  it("codes only the all-unassessed host refusal for a bounded source-reading correction", () => {
    const refusal = sourceReadinessStepError(
      new SourceReadinessAssessmentError("unassessed-available-sources"),
    );
    expect(refusal).toMatchObject({
      category: "malformed-response",
      retryable: true,
      rejection: {
        code: "source-readiness-unassessed-available-sources",
        location: "$.criteria",
      },
    });
    expect(
      sourceReadinessStepError(new SourceReadinessAssessmentError("invalid-assessment")).rejection,
    ).toBeUndefined();
    expect(
      sourceReadinessStepError(new SourceReadinessAssessmentError("credential-material")),
    ).toMatchObject({ category: "malformed-response", retryable: false });
  });
  it("detects changed bytes and a foreign revision on re-verification", async () => {
    const actual = await workspace();
    const decoded = decodeSourceReadinessAssessment(JSON.stringify(artifact()), binding());
    await expect(
      verifySourceReadinessCitations({ ...decoded, repositoryRevision: "b".repeat(40) }, actual),
    ).rejects.toMatchObject({ code: "binding-mismatch" });
    const path = join(actual.path, "docs/guide.md");
    await writeFile(path, `${await readFile(path, "utf8")}\nChanged bytes after export.\n`);
    await expect(verifySourceReadinessCitations(decoded, actual)).rejects.toMatchObject({
      code: "citation-mismatch",
    });
  });
  it("states the citation rules from the catalog in the response contract, not quoting instructions", async () => {
    const input = stepInput(await workspace()),
      expected = sourceReadinessBinding(input),
      contract = sourceReadinessResponseContract(input);
    expect(buildDocsFabStepPrompt(input)).toContain(contract);
    for (const value of Object.values(expected))
      if (value !== null) expect(contract).toContain(value);
    expect(contract).toContain(sourceCitationContractText());
    expect(contract).toContain(String(limit("sourceCitation.mintedMaxChars").value));
    expect(contract).toContain('"startLine"');
    // The model is told to cite locations, never to reproduce source text.
    expect(contract).not.toMatch(/quot|verbatim|copy the passage/iu);
    expect(
      decodeSourceReadinessReply(unassessedSourceReadinessFixture(input), expected).criteria.every(
        (row) => row.status === "unassessed" && row.citations.length === 0,
      ),
    ).toBe(true);
    for (const changed of [
      { ...input, runId: undefined },
      { ...input, searchEvidence: undefined },
      { ...input, evidenceIdentity: undefined },
    ])
      expect(() => sourceReadinessBinding(changed)).toThrow(SourceReadinessAssessmentError);
    expect(
      sourceReadinessResponseContract({
        ...input,
        workflow: { ...input.workflow, name: "review-documentation" },
        runId: undefined,
        searchEvidence: undefined,
      }),
    ).toBe("");
  });
  it("requires a live opaque workspace even when every criterion is unassessed without citations", async () => {
    const actual = await workspace();
    const input = stepInput(actual);
    const assessment = decodeSourceReadinessAssessment(
      unassessedSourceReadinessFixture(input),
      sourceReadinessBinding(input),
    );
    await verifySourceReadinessCitations(assessment, actual);
    await expect(verifySourceReadinessCitations(assessment, { ...actual })).rejects.toMatchObject({
      code: "citation-mismatch",
    });
    await actual.dispose();
    await expect(verifySourceReadinessCitations(assessment, actual)).rejects.toMatchObject({
      code: "citation-mismatch",
    });
  });
  it("limits the internal offline mode to the all-unassessed re-ask predicate", async () => {
    const actual = await workspace();
    const input = stepInput(actual);
    const fixture = JSON.parse(unassessedSourceReadinessFixture(input));
    const answer = async (summary: string, observedSourceLines?: ObservedSourceLinesV1) =>
      wrapSourceReadinessHarness(
        {
          async runStep() {
            return { summary, outcome: "succeeded" as const, observedSourceLines };
          },
        },
        actual,
        "internal-offline-fixture",
      ).runStep(input);
    const admitted = await answer(JSON.stringify(fixture));
    expect(
      JSON.parse(admitted.summary).criteria.every(
        (row: { status: string }) => row.status === "unassessed",
      ),
    ).toBe(true);
    expect(admitted).not.toHaveProperty("observedSourceLines");
    await expect(
      wrapSourceReadinessHarness(
        {
          async runStep() {
            return { summary: JSON.stringify(fixture), outcome: "succeeded" as const };
          },
        },
        actual,
      ).runStep(input),
    ).rejects.toMatchObject({ message: expect.stringContaining("All readiness criteria") });
    const badBinding = { ...fixture, repositoryRevision: "b".repeat(40) };
    const badCitation = response(sourceReadinessBinding(input));
    badCitation.criteria[0]!.citations = [{ path: "docs/guide.md", startLine: 3, endLine: 3 }];
    for (const malformed of ["not JSON", JSON.stringify(badBinding)]) {
      await expect(answer(malformed)).rejects.toMatchObject({ category: "malformed-response" });
    }
    await expect(answer(JSON.stringify(badCitation))).rejects.toMatchObject({
      rejection: { code: "source-citation-unobserved" },
    });
    const fabricatedCitation = response(sourceReadinessBinding(input));
    fabricatedCitation.criteria[0]!.citations = [
      { path: "docs/guide.md", startLine: 99, endLine: 99 },
    ];
    await expect(answer(JSON.stringify(fabricatedCitation), READ_GUIDE)).rejects.toMatchObject({
      rejection: { code: "source-citation-line-range" },
    });
    await expect(answer(JSON.stringify(badCitation), READ_GUIDE)).resolves.toHaveProperty(
      "summary",
    );
  });
  it("retains retry evidence without copying malformed or credential-bearing response text into errors", async () => {
    const actual = await workspace(),
      input = stepInput(actual);
    const retained = {
      model: { provider: "fixture", model: "fixture" },
      usage: { input: 2, output: 3, cacheRead: 0, cacheWrite: 0, total: 5, turns: 1 },
      tools: { totalCalls: 1, failedCalls: 0, byTool: [{ name: "read", calls: 1, failures: 0 }] },
      turns: [],
    };
    const credential = CREDENTIAL;
    for (const [summary, retryable] of [
      ["not JSON; rejected private prose", true],
      [JSON.stringify({ ...response(sourceReadinessBinding(input)), summary: credential }), false],
    ] as const) {
      let calls = 0;
      const base: AgentHarness = {
        async runStep() {
          expect(this).toBe(base);
          calls += 1;
          return { summary, outcome: "succeeded", ...retained };
        },
      };
      const error = await wrapSourceReadinessHarness(base, actual)
        .runStep(input)
        .then(
          () => undefined,
          (error) => error,
        );
      expect(error).toBeInstanceOf(InferenceStepError);
      expect(error).toMatchObject({
        category: "malformed-response",
        retryable,
        evidence: retained,
      });
      expect(Object.keys(error.evidence).sort()).toEqual(Object.keys(retained).sort());
      expect(error.evidence).not.toHaveProperty("summary");
      expect(error.evidence).not.toHaveProperty("outcome");
      expect(JSON.stringify(error.evidence)).not.toContain(credential);
      expect(error.message).not.toContain(credential);
      expect(calls).toBe(1);
    }
  });
  it("re-asks a refused citation with its catalog rule and location through the wrapper (#1741)", async () => {
    const actual = await workspace(),
      input = stepInput(actual);
    const quoted = response(sourceReadinessBinding(input));
    quoted.criteria[0]!.citations = [{ path: "docs/guide.md", quote: QUOTE } as never];
    for (const [summary, observedSourceLines, code] of [
      [JSON.stringify(quoted), READ_GUIDE, "source-citation-locator-shape"],
      // Zero reads: a correctable refusal.
      [
        JSON.stringify(response(sourceReadinessBinding(input))),
        undefined,
        "source-citation-unobserved",
      ],
    ] as const) {
      const error = await wrapSourceReadinessHarness(
        {
          async runStep() {
            return {
              summary,
              outcome: "succeeded",
              tools: { totalCalls: 0, failedCalls: 0, byTool: [] },
              ...(observedSourceLines ? { observedSourceLines } : {}),
            };
          },
        },
        actual,
      )
        .runStep(input)
        .then(
          () => undefined,
          (caught: unknown) => caught,
        );
      expect(error).toBeInstanceOf(InferenceStepError);
      expect(error).toMatchObject({
        category: "malformed-response",
        retryable: true,
        message: `Source readiness assessment rejected: Source citation rejected: ${code}.`,
        rejection: { code, location: "$.criteria[].citations[]" },
        evidence: { tools: { totalCalls: 0 } },
      });
      const correction = responseCorrectionInstruction({
        rejection: (error as InferenceStepError).rejection,
      });
      expect(correction).toContain(`host rule ${code} at $.criteria[].citations[]`);
      expect(correction).not.toContain("The host has no specific repair hint");
    }
  });
  it("preserves valid results and passes unrelated workflow results and transport errors through", async () => {
    const actual = await workspace(),
      input = stepInput(actual);
    const valid: HarnessStepResult = {
      summary: JSON.stringify(response(sourceReadinessBinding(input))),
      outcome: "succeeded",
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2, turns: 1 },
      observedSourceLines: READ_GUIDE,
    };
    const result = await wrapSourceReadinessHarness(
      {
        async runStep() {
          return valid;
        },
      },
      actual,
    ).runStep(input);
    expect(result.usage).toBe(valid.usage);
    expect(JSON.parse(result.summary)).toEqual(artifact(sourceReadinessBinding(input)));
    // The read ledger is admission evidence only; the step result drops it.
    expect(result).not.toHaveProperty("observedSourceLines");
    const plain = { summary: "Ordinary review prose", outcome: "succeeded" as const };
    expect(
      await wrapSourceReadinessHarness(
        {
          async runStep() {
            return plain;
          },
        },
        actual,
      ).runStep({ ...input, workflow: { ...input.workflow, name: "review-documentation" } }),
    ).toBe(plain);
    const transport = new InferenceStepError(
      "Fixture provider unavailable.",
      "provider-transient",
      true,
    );
    await expect(
      wrapSourceReadinessHarness(
        {
          async runStep() {
            throw transport;
          },
        },
        actual,
      ).runStep(input),
    ).rejects.toBe(transport);
  });
  it("re-mints every admitted quote at projection and refuses a record whose quote drifted", async () => {
    const actual = await workspace(),
      input = stepInput(actual);
    const record = {
      schemaVersion: 2,
      id: input.runId!,
      workflow: "readiness",
      repository: { sourcePath: actual.sourcePath, requestedRevision: revision, revision },
      workspace: { strategy: "tracked-export", disposable: true },
      status: "succeeded",
      createdAt: "2026-10-01T00:00:00.000Z",
      startedAt: "2026-10-01T00:00:00.000Z",
      completedAt: "2026-10-01T00:00:01.000Z",
      durationMs: 1_000,
      models: [],
      skills: [],
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, turns: 0 },
      tools: { totalCalls: 0, failedCalls: 0, byTool: [] },
      steps: [
        {
          id: "assess-readiness",
          title: "Assess repository readiness",
          kind: "inference",
          skill: "assess-documentation-readiness",
          mode: "read-only",
          status: "succeeded",
          startedAt: "2026-10-01T00:00:00.000Z",
          completedAt: "2026-10-01T00:00:01.000Z",
          durationMs: 1_000,
          searchEvidence: input.searchEvidence,
          summary: "",
        },
      ],
    } as unknown as RunRecord;
    const recordBinding = {
      runId: record.id,
      repositoryRevision: revision,
      searchEvidenceSha256: input.searchEvidence!.evidenceSha256,
      contextPacketSha256: null,
    };
    const projector = new ReadinessWorkflowOutcomeProjector(actual);
    // Positive control: the intact admitted artifact projects.
    record.steps[0]!.summary = canonicalJson(artifact(recordBinding));
    await expect(projector.project(record)).resolves.toMatchObject({ evidence: expect.any(Array) });
    // Adjacent: the same artifact with one quote no longer its cited lines.
    const drifted = artifact(recordBinding);
    drifted.criteria[1]!.citations[0]!.quote = `${QUOTE} (edited)`;
    record.steps[0]!.summary = canonicalJson(drifted);
    await expect(projector.project(record)).rejects.toEqual(
      new ReadinessWorkflowOutcomeError("invalid-record"),
    );
  });
});
