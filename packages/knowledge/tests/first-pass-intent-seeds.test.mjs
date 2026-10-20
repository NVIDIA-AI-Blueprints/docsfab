// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * First-pass obligations and read sources under an admitted request intent,
 * at the provider: intent sources bind beside `--source` selections, intent
 * constraints seed by kind at their raw-instruction spans, and request words
 * seed only the narrowing guards. Without an intent the seeds are unchanged.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { gatherRepositoryFirstPass } from "../src/first-pass.mjs";
import { decodeFirstPassRequestIntent, MAX_OBLIGATION_CONDITION_CHARS } from "../src/first-pass/assess.mjs";
import { FIRST_PASS_LIMIT_DEFAULTS } from "../src/first-pass-limits.generated.mjs";
import {
  assessOrdinaryDocumentationSupport,
  FirstPassSupportError,
  normalizeBoundSourcePaths,
  parseEvidenceFrames,
} from "../src/first-pass-support.mjs";

const temporary = [];
const revision = "7".repeat(40);
const TARGETS = ["docs/a.md", "docs/b.md"];
const PROJECTION_FAULT = /^Error: requestIntent is not the host's first-pass request-intent projection$/u;

test.after(async () => {
  await Promise.all(temporary.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

const sha = (value) => createHash("sha256").update(value, "utf8").digest("hex");

async function repository(extra = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "knowledge-intent-seeds-"));
  temporary.push(root);
  const repositoryPath = path.join(root, "repo");
  const files = {
    "README.md": "# Widget\n\nWidget reads its configuration from widget.yaml.\n",
    "src/a.ts": "export const alpha = 'alpha source evidence';\n",
    "src/b.ts": "export const beta = 'beta source evidence';\n",
    // Formats the scan never ranks: read only when bound.
    "notes/alpha.textile": "h1. Alpha\n\nAlpha notes.\n",
    "notes/beta.textile": "h1. Beta\n\nBeta notes.\n",
    ...extra,
  };
  for (const [name, text] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(repositoryPath, name)), { recursive: true });
    await writeFile(path.join(repositoryPath, name), text);
  }
  return { repositoryPath, dataDirectory: path.join(root, "data") };
}

/** A quote of `text` in the NFC instruction, as the host projects it. */
function quoteOf(instruction, text, from = 0) {
  const normalized = instruction.normalize("NFC");
  const start = normalized.indexOf(text, from);
  assert.ok(start >= 0, `fixture quote is not in the instruction: ${text}`);
  return { text, start, end: start + text.length };
}

function projection(instruction, { writeTargets = TARGETS, operation = "create", sources = [], constraints = [] } = {}) {
  return {
    schemaVersion: 1,
    kind: "docsfab-first-pass-request-intent",
    instructionSha256: sha(instruction.normalize("NFC")),
    operation,
    writeTargets,
    sources: sources.map((source) => ({ path: source.path, quote: quoteOf(instruction, source.quote) })),
    preserve: [],
    exclusions: [],
    constraints: constraints.map((constraint) => ({
      kind: constraint.kind,
      quote: typeof constraint.quote === "string" ? quoteOf(instruction, constraint.quote) : constraint.quote,
    })),
  };
}

/** Supports every obligation from the first offered span, and counts its calls. */
function scriptedModel() {
  const calls = [];
  const modelCall = async (request) => {
    calls.push(request.prompt.split("\n", 1)[0]);
    let value;
    if (request.prompt.startsWith("Phase: obligation-decomposition")) {
      value = { schemaVersion: 1, additionalObligations: [] };
    } else if (request.prompt.startsWith("Phase: obligation-completeness-audit")) {
      value = { schemaVersion: 1, complete: true, omissions: [] };
    } else {
      const line = request.prompt.split("\n").find((entry) => entry.startsWith("Mandatory obligations: "));
      const obligations = JSON.parse(line.slice("Mandatory obligations: ".length));
      const first = parseEvidenceFrames(request.prompt)[0].id;
      value = {
        schemaVersion: 1,
        assessments: obligations.map((obligation) => ({
          obligationId: obligation.id,
          status: "supported",
          evidenceSpanIds: obligation.requiredSourceSupport ? [first] : [],
          detail: "Supported by the offered span.",
        })),
      };
    }
    const responseText = JSON.stringify(value);
    return {
      responseText,
      identity: {
        providerId: "scripted-provider",
        modelId: "scripted-model-v1",
        profileSha256: sha("profile"),
        compositionSha256: null,
        requestPolicySha256: null,
        systemPromptSha256: sha(request.systemPrompt),
        promptSha256: request.promptSha256,
        procedureSha256: request.procedureSha256,
        responseSha256: sha(responseText),
        turnEvidenceSha256: sha("turn-evidence"),
      },
      usage: { inputTokens: 100, outputTokens: 50 },
    };
  };
  return { modelCall, calls };
}

async function assess(instruction, options = {}) {
  const repo = options.repo ?? (await repository());
  const model = scriptedModel();
  const support = await assessOrdinaryDocumentationSupport({
    repositoryPath: repo.repositoryPath,
    instruction,
    revision,
    workflow: options.workflow ?? "create-documentation",
    snapshotSha256: sha("snapshot"),
    authorizedWriteRoots: ["docs/"],
    ...(options.intent === null ? {} : { requestIntent: options.intent ?? projection(instruction) }),
    ...(options.boundSourcePaths ? { boundSourcePaths: options.boundSourcePaths } : {}),
    modelCall: model.modelCall,
  });
  return { support, calls: model.calls };
}

async function refusal(instruction, options = {}) {
  const repo = options.repo ?? (await repository());
  const model = scriptedModel();
  const error = await assessOrdinaryDocumentationSupport({
    repositoryPath: repo.repositoryPath,
    instruction,
    revision,
    workflow: "create-documentation",
    snapshotSha256: sha("snapshot"),
    authorizedWriteRoots: ["docs/"],
    requestIntent: options.intent,
    ...(options.boundSourcePaths ? { boundSourcePaths: options.boundSourcePaths } : {}),
    modelCall: model.modelCall,
  }).then(
    () => assert.fail("assessment did not refuse"),
    (caught) => caught,
  );
  return { error, calls: model.calls };
}

/** The seeded fields of every non-target obligation, in record order. */
function explicitSeeds(support) {
  return support.obligations
    .filter((item) => item.origin === "explicit")
    .map(({ id, origin, instructionSpan, condition, requiredSourceSupport, targetPaths }) => ({
      id,
      origin,
      instructionSpan,
      condition,
      requiredSourceSupport,
      targetPaths,
    }));
}

function rawSpan(instruction, text) {
  const start = instruction.indexOf(text);
  assert.ok(start >= 0, `not in the raw instruction: ${text}`);
  return { start, end: start + text.length };
}

function assertSpansAreInstructionSlices(instruction, support) {
  for (const item of support.obligations.filter((obligation) => obligation.origin === "explicit")) {
    assert.equal(
      instruction.slice(item.instructionSpan.start, item.instructionSpan.end),
      item.condition,
      `${item.id} span is not its condition`,
    );
  }
}

const readPaths = (support) => [...new Set(support.sourceSpans.map((span) => span.path))].sort();
const readNotes = (support) => readPaths(support).filter((item) => item.startsWith("notes/"));

test("intent sources bind beside distinct --source selections, and neither replaces the other (row 7b)", async () => {
  const instruction = "Create docs/a.md and docs/b.md from the beta notes.";
  const intent = projection(instruction, { sources: [{ path: "notes/beta.textile", quote: "the beta notes" }] });
  // Positive control: an unranked format is read only when something binds it.
  const unbound = await assess(instruction, { intent: projection(instruction) });
  assert.deepEqual(readNotes(unbound.support), []);
  // Distinct lists: the operator's selection and the reading's source are both read.
  const both = await assess(instruction, { intent, boundSourcePaths: ["notes/alpha.textile"] });
  assert.deepEqual(readNotes(both.support), ["notes/alpha.textile", "notes/beta.textile"]);
  // The provider does not rely on the host having merged them: intent only.
  const intentOnly = await assess(instruction, { intent });
  assert.deepEqual(readNotes(intentOnly.support), ["notes/beta.textile"]);
  // The same path from both is read once.
  const same = await assess(instruction, { intent, boundSourcePaths: ["notes/beta.textile"] });
  assert.deepEqual(readNotes(same.support), ["notes/beta.textile"]);
});

test("an intent source the revision lacks refuses before any model call, beside a present selection (row 7b)", async () => {
  const instruction = "Create docs/a.md and docs/b.md from the gamma module.";
  const intent = projection(instruction, { sources: [{ path: "src/gamma.ts", quote: "the gamma module" }] });
  for (const boundSourcePaths of [undefined, ["src/a.ts"]]) {
    const { error, calls } = await refusal(instruction, { intent, boundSourcePaths });
    assert.ok(error instanceof FirstPassSupportError);
    assert.equal(error.code, "bound-source-unavailable");
    assert.equal(
      error.message,
      "No such source: the request's reading names src/gamma.ts as a source, but it is not a readable regular file in the selected revision. Name a tracked file in the request, or pass it with --source, then run again.",
    );
    assert.deepEqual(calls, []);
  }
  // A missing --source keeps its own wording, even when the reading names it too.
  const named = projection(instruction, { sources: [{ path: "src/gamma.ts", quote: "the gamma module" }] });
  const { error } = await refusal(instruction, { intent: named, boundSourcePaths: ["src/gamma.ts"] });
  assert.equal(
    error.message,
    "No such source: src/gamma.ts is not a readable regular file in the selected revision. Check the path, or commit the file, then run again.",
  );
});

test("benign intent sources: a write target binds nothing, host state refuses, other tracked files bind (row 7k)", async () => {
  const instruction = "Create docs/a.md and docs/b.md from docs/open-api/indexes.yaml and vendor/lib/util.js.";
  const repo = await repository({
    "docs/open-api/indexes.yaml": "openapi: 3.0.0\npaths: {}\n",
    "vendor/lib/util.js": "export const vendored = 'vendored evidence';\n",
    ".docsfab/notes.md": "# Host state\n",
  });
  // The create's new page is a write target, not a read source: no presence refusal.
  const target = await assess(instruction, {
    repo,
    intent: projection(instruction, { sources: [{ path: "docs/a.md", quote: "docs/a.md" }] }),
  });
  assert.deepEqual(target.support.targetPaths, TARGETS);
  assert.equal(readPaths(target.support).includes("docs/a.md"), false);
  // A tracked YAML spec and a vendored file bind and are read.
  const tracked = await assess(instruction, {
    repo,
    intent: projection(instruction, {
      sources: [
        { path: "docs/open-api/indexes.yaml", quote: "docs/open-api/indexes.yaml" },
        { path: "vendor/lib/util.js", quote: "vendor/lib/util.js" },
      ],
    }),
  });
  assert.ok(readPaths(tracked.support).includes("docs/open-api/indexes.yaml"));
  assert.ok(readPaths(tracked.support).includes("vendor/lib/util.js"));
  // A directory is not a regular file.
  const directory = await refusal(instruction, {
    repo,
    intent: projection(instruction, { sources: [{ path: "docs/open-api", quote: "docs/open-api" }] }),
  });
  assert.equal(directory.error.code, "bound-source-unavailable");
  assert.deepEqual(directory.calls, []);
  // Host state is never evidence, and the refusal says the reading named it.
  const hostState = await refusal(`${instruction} Use .docsfab/notes.md.`, {
    repo,
    intent: projection(`${instruction} Use .docsfab/notes.md.`, {
      sources: [{ path: ".docsfab/notes.md", quote: ".docsfab/notes.md" }],
    }),
  });
  assert.equal(hostState.error.code, "bound-source-unavailable");
  assert.match(hostState.error.message, /^The request's reading names \.docsfab\/notes\.md as a source/u);
  assert.deepEqual(hostState.calls, []);
});

test("one source budget covers selections and intent sources together, naming both counts (row 7c)", () => {
  const bound = FIRST_PASS_LIMIT_DEFAULTS.maxSourceFiles;
  const selected = Array.from({ length: Math.ceil(bound / 2) }, (_, index) => `src/selected-${String(index)}.ts`);
  const reading = Array.from({ length: bound - selected.length }, (_, index) => `src/read-${String(index)}.ts`);
  // At the bound, with an overlap that counts once, every path is admitted.
  assert.equal(normalizeBoundSourcePaths(selected, bound, [...reading, selected[0]]).length, bound);
  // One over refuses, naming both counts.
  assert.throws(
    () => normalizeBoundSourcePaths(selected, bound, [...reading, "src/one-more.ts"]),
    (error) => {
      assert.ok(error instanceof FirstPassSupportError);
      assert.equal(error.code, "budget-exhausted");
      // The source budget is not the condition bound a host reports as its own refusal.
      assert.equal(error.limit, undefined);
      assert.equal(error.constraint, undefined);
      assert.equal(
        error.message,
        `The request selects ${String(bound + 1)} sources (${String(selected.length)} with --source and ${String(reading.length + 1)} more the request's reading names), over the first-pass source budget of ${String(bound)} (firstPass.maxSourceFiles). Select fewer sources with --source, or raise DOCSFAB_FIRST_PASS_MAX_SOURCE_FILES.`,
      );
      return true;
    },
  );
  // Selections alone keep their message.
  assert.throws(
    () => normalizeBoundSourcePaths([...selected, ...reading, "src/one-more.ts"], bound),
    /^FirstPassSupportError: The request selects \d+ sources, over the first-pass source budget/u,
  );
});

test("each intent constraint kind seeds its obligation at its own span, for every target (row 7e)", async () => {
  const instruction =
    "Create docs/a.md and docs/b.md. Ground every detail in the repository code. Halt and ask before any write if a third page is needed. List the follow-up actions for operators. Never share this outside the team.";
  const evidence = "Ground every detail in the repository code";
  const stop = "Halt and ask before any write if a third page is needed";
  const operations = "List the follow-up actions for operators";
  const nonpublication = "Never share this outside the team";
  const { support } = await assess(instruction, {
    intent: projection(instruction, {
      constraints: [
        { kind: "evidence-only", quote: evidence },
        { kind: "stop-before-mutation", quote: stop },
        { kind: "operational-next-steps", quote: operations },
        { kind: "non-publication", quote: nonpublication },
      ],
    }),
  });
  const seed = (id, text, requiredSourceSupport) => ({
    id,
    origin: "explicit",
    instructionSpan: rawSpan(instruction, text),
    condition: text,
    requiredSourceSupport,
    targetPaths: TARGETS,
  });
  assert.deepEqual(explicitSeeds(support), [
    seed("explicit-evidence", evidence, true),
    seed("explicit-typed-stop", stop, false),
    seed("explicit-operations", operations, true),
    seed("explicit-nonpublication", nonpublication, false),
  ]);
  assert.deepEqual(
    support.obligations.filter((item) => item.origin === "workflow").map((item) => item.id),
    ["target-01", "target-02", "workflow-target-set"],
  );
  assertSpansAreInstructionSlices(instruction, support);
  assert.equal(support.terminationReason, "supported");
});

test("two constraints of one kind seed two obligations with distinct ids (row 7e)", async () => {
  const instruction = "Create docs/a.md and docs/b.md. Cite the code for every flag. Cite the code for every default.";
  const { support } = await assess(instruction, {
    intent: projection(instruction, {
      constraints: [
        { kind: "evidence-only", quote: "Cite the code for every flag" },
        { kind: "evidence-only", quote: "Cite the code for every default" },
      ],
    }),
  });
  assert.deepEqual(
    explicitSeeds(support).map((item) => [item.id, item.condition, item.requiredSourceSupport]),
    [
      ["explicit-evidence", "Cite the code for every flag", true],
      ["explicit-evidence-2", "Cite the code for every default", true],
    ],
  );
});

test("the keyword non-publication guard stays under an intent and an intent prohibition adds its own (row 7f)", async () => {
  const keyword = "Keep the result local; do not publish";
  // No intent constraint: the keyword guard still seeds.
  const guarded = `Create docs/a.md and docs/b.md. ${keyword}.`;
  const onlyKeyword = await assess(guarded, { intent: projection(guarded) });
  assert.deepEqual(
    explicitSeeds(onlyKeyword.support).map((item) => [item.id, item.instructionSpan, item.condition]),
    [["explicit-nonpublication", rawSpan(guarded, keyword), keyword]],
  );
  // No keyword: the intent's prohibition adds the obligation.
  const plain = "Create docs/a.md and docs/b.md. Never publish this anywhere.";
  const onlyIntent = await assess(plain, {
    intent: projection(plain, { constraints: [{ kind: "non-publication", quote: "Never publish this anywhere" }] }),
  });
  assert.deepEqual(
    explicitSeeds(onlyIntent.support).map((item) => [item.id, item.condition, item.requiredSourceSupport]),
    [["explicit-nonpublication", "Never publish this anywhere", false]],
  );
  // Both: both are kept, with distinct ids.
  const both = `Create docs/a.md and docs/b.md. ${keyword}. Never publish this anywhere.`;
  const kept = await assess(both, {
    intent: projection(both, { constraints: [{ kind: "non-publication", quote: "Never publish this anywhere" }] }),
  });
  assert.deepEqual(
    explicitSeeds(kept.support).map((item) => [item.id, item.condition]),
    [
      ["explicit-nonpublication", keyword],
      ["explicit-nonpublication-2", "Never publish this anywhere"],
    ],
  );
  assertSpansAreInstructionSlices(both, kept.support);
});

test("constraint spans map from the NFC quote to the instruction as written (row 7g, provider-level)", async () => {
  // Decomposed characters before and inside each quote, a quote at offset 0,
  // and one that ends the instruction.
  const head = "Résumé the code first";
  const middle = "Cite the code for every détail";
  const tail = "Never publish the café";
  const instruction = `${head}. Create docs/a.md and docs/b.md. ${middle}. ${tail}`;
  assert.notEqual(instruction, instruction.normalize("NFC"));
  const nfc = (text) => text.normalize("NFC");
  const { support } = await assess(instruction, {
    intent: projection(instruction, {
      constraints: [
        { kind: "evidence-only", quote: nfc(head) },
        { kind: "operational-next-steps", quote: nfc(middle) },
        { kind: "non-publication", quote: nfc(tail) },
      ],
    }),
  });
  const seeds = explicitSeeds(support);
  assert.deepEqual(
    seeds.map((item) => [item.id, item.instructionSpan, item.condition]),
    [
      ["explicit-evidence", { start: 0, end: head.length }, head],
      ["explicit-operations", rawSpan(instruction, middle), middle],
      ["explicit-nonpublication", { start: instruction.length - tail.length, end: instruction.length }, tail],
    ],
  );
  for (const item of seeds) assert.notEqual(item.condition, item.condition.normalize("NFC"));
  assertSpansAreInstructionSlices(instruction, support);
});

test("a quote edge next to a combining mark maps when the boundary exists and is a projection fault when it does not (row 7g)", async () => {
  // x + acute has no precomposed form, so the boundary before the mark exists.
  const adjacent = "Create docs/a.md and docs/b.md. Cite the x́ axis.";
  const mapped = await assess(adjacent, {
    intent: projection(adjacent, { constraints: [{ kind: "evidence-only", quote: "Cite the x" }] }),
  });
  assert.deepEqual(explicitSeeds(mapped.support)[0].instructionSpan, rawSpan(adjacent, "Cite the x"));
  // a + acute + ogonek reorders under NFC to a-ogonek + acute: the NFC
  // boundary between them has no raw counterpart.
  const reordered = "Create docs/a.md and docs/b.md. Cite the ą́ mark.";
  const normalized = reordered.normalize("NFC");
  const start = normalized.indexOf("Cite");
  const end = normalized.indexOf("ą") + 1;
  const quote = { text: normalized.slice(start, end), start, end };
  const { error, calls } = await refusal(reordered, {
    intent: projection(reordered, { constraints: [{ kind: "evidence-only", quote }] }),
  });
  assert.match(String(error), PROJECTION_FAULT);
  assert.deepEqual(calls, []);
});

test("under an admitted intent request words seed only the narrowing guards (row 7h)", async () => {
  // Zero constraints and zero sources: the intent's presence, not its contents, selects the arm.
  const instruction =
    "Create docs/a.md and docs/b.md using only current repository evidence, with operational next steps for the source tree. Preserve current facts and links.";
  const { support } = await assess(instruction, { intent: projection(instruction) });
  assert.deepEqual(explicitSeeds(support), [
    {
      id: "explicit-preservation",
      origin: "explicit",
      instructionSpan: rawSpan(instruction, "Preserve current facts and links"),
      condition: "Preserve current facts and links",
      requiredSourceSupport: true,
      targetPaths: TARGETS,
    },
  ]);
  // Positive control: the same words seed every pattern without an intent.
  const parsed = "Create docs/a.md using only current repository evidence, with operational next steps for the source tree. Preserve current facts and links.";
  const { support: noIntent } = await assess(parsed, { intent: null });
  assert.deepEqual(
    explicitSeeds(noIntent).map((item) => item.id),
    ["explicit-evidence", "explicit-preservation", "explicit-operations", "explicit-concept-source"],
  );
});

test("without an intent the seeds are today's, less the scope duplicate of workflow-target-set (row 7i)", async () => {
  const repo = await repository({ "docs/a.md": "# A\n\nCurrent page.\n", "docs/b.md": "# B\n\nCurrent page.\n" });
  const phrases = {
    evidence: "using only current repository evidence",
    preservation: "Preserve current links and unrelated content",
    typedStop: "stop with a typed scope outcome before mutation if another page is required",
    operations: "operational next steps",
    nonpublication: "Keep the result local; do not publish",
  };
  const instruction = `Update docs/a.md and docs/b.md to clarify the Source and Estate vocabulary and ${phrases.operations} ${phrases.evidence}. ${phrases.preservation}. Change no other path, and ${phrases.typedStop}. ${phrases.nonpublication}.`;
  const { support } = await assess(instruction, { repo, intent: null, workflow: "update-documentation" });
  const seed = (id, text, requiredSourceSupport) => ({
    id,
    origin: "explicit",
    instructionSpan: rawSpan(instruction, text),
    condition: text,
    requiredSourceSupport,
    targetPaths: TARGETS,
  });
  assert.deepEqual(explicitSeeds(support), [
    seed("explicit-evidence", phrases.evidence, true),
    seed("explicit-preservation", phrases.preservation, true),
    seed("explicit-typed-stop", phrases.typedStop, false),
    seed("explicit-operations", phrases.operations, true),
    seed("explicit-nonpublication", phrases.nonpublication, false),
    seed("explicit-concept-source", "Source", true),
    seed("explicit-concept-estate", "Estate", true),
  ]);
  assert.deepEqual(
    support.obligations.filter((item) => item.origin === "workflow").map((item) => [item.id, item.requiredSourceSupport]),
    [["target-01", true], ["target-02", true], ["workflow-target-set", false]],
  );
  // "Change no other path" is held by workflow-target-set, not a seed of its own.
  assert.equal(support.obligations.some((item) => item.id === "explicit-scope"), false);
  assertSpansAreInstructionSlices(instruction, support);
});

test("a constraint longer than an obligation condition stops before any model call, never cut (row 7l)", async () => {
  // The catalog bound, read through the generated mirror.
  assert.equal(MAX_OBLIGATION_CONDITION_CHARS, FIRST_PASS_LIMIT_DEFAULTS.maxObligationConditionChars);
  const filler = (length) => `Cite the code ${"x".repeat(length - "Cite the code ".length - 1)}.`;
  const atBound = filler(MAX_OBLIGATION_CONDITION_CHARS);
  assert.equal(atBound.length, MAX_OBLIGATION_CONDITION_CHARS);
  const fits = `Create docs/a.md and docs/b.md. ${atBound}`;
  const admitted = await assess(fits, {
    intent: projection(fits, { constraints: [{ kind: "evidence-only", quote: atBound }] }),
  });
  assert.equal(explicitSeeds(admitted.support)[0].condition, atBound);
  for (const [label, instruction, quoteText] of [
    ["one over", `Create docs/a.md and docs/b.md. ${filler(MAX_OBLIGATION_CONDITION_CHARS + 1)}`, filler(MAX_OBLIGATION_CONDITION_CHARS + 1)],
    // The NFC quote fits; the decomposed form the operator wrote does not.
    ["decomposed", `Create docs/a.md and docs/b.md. ${atBound.slice(0, -2)}é.`, `${atBound.slice(0, -2)}é.`],
  ]) {
    assert.ok(quoteText.length <= MAX_OBLIGATION_CONDITION_CHARS + 1, label);
    const { error, calls } = await refusal(instruction, {
      intent: projection(instruction, { constraints: [{ kind: "evidence-only", quote: quoteText }] }),
    });
    assert.ok(error instanceof FirstPassSupportError, label);
    assert.equal(error.code, "budget-exhausted", label);
    assert.deepEqual([error.phase, error.rule, error.location], ["request", "budget-exhausted", "$instruction"], label);
    assert.match(error.message, new RegExp(`is ${String(MAX_OBLIGATION_CONDITION_CHARS + 1)} characters as written, over the ${String(MAX_OBLIGATION_CONDITION_CHARS)}-character bound on one first-pass obligation condition \\(firstPass\\.maxObligationConditionChars\\)\\. The interpretation admits quotes up to requestIntent\\.maxQuoteChars`, "u"), label);
    // The host reports the stop under the bound's own refusal from these fields.
    const start = instruction.indexOf(quoteText.slice(0, 4));
    assert.deepEqual(
      { limit: { ...error.limit }, constraint: { ...error.constraint } },
      {
        limit: { name: "firstPass.maxObligationConditionChars", observed: MAX_OBLIGATION_CONDITION_CHARS + 1 },
        constraint: { kind: "evidence-only", start, end: start + MAX_OBLIGATION_CONDITION_CHARS + 1 },
      },
      label,
    );
    assert.deepEqual(calls, [], label);
  }
});

test("gather forwards the intent and operator sources to the same union (row 7a, provider-level)", async () => {
  const repo = await repository();
  const instruction = "Create docs/a.md and docs/b.md from the beta notes.";
  const model = scriptedModel();
  const result = await gatherRepositoryFirstPass({
    repositoryPath: repo.repositoryPath,
    dataDirectory: repo.dataDirectory,
    revision,
    workflow: "create-documentation",
    instruction,
    authorizedWriteRoots: ["docs/"],
    boundSourcePaths: ["notes/alpha.textile"],
    requestIntent: projection(instruction, { sources: [{ path: "notes/beta.textile", quote: "the beta notes" }] }),
    modelCall: model.modelCall,
  });
  assert.deepEqual(readNotes(result.support), ["notes/alpha.textile", "notes/beta.textile"]);
});


test("the provider retains a grounded admitted authority preference", () => {
  const instruction = "Create docs/a.md and docs/b.md; match current implementation.";
  const authorityPreference = { preference: "implementation", quote: quoteOf(instruction, "match current implementation") };
  assert.deepEqual(decodeFirstPassRequestIntent({ ...projection(instruction), authorityPreference }, instruction).authorityPreference, authorityPreference);
  assert.deepEqual(decodeFirstPassRequestIntent(projection(instruction), instruction).authorityPreference, { preference: "unspecified", quote: null });
  for (const invalid of [
    { preference: "source-order", quote: authorityPreference.quote },
    { preference: "implementation", quote: null },
    { preference: "unspecified", quote: authorityPreference.quote },
    { preference: "documentation", quote: { ...authorityPreference.quote, text: "fabricated quote" } },
  ]) assert.throws(() => decodeFirstPassRequestIntent({ ...projection(instruction), authorityPreference: invalid }, instruction), /request-intent projection/u);
});

test("the assessment prompt receives the admitted preference without erasing contradictions", async () => {
  const instruction = "Create docs/a.md and docs/b.md; match current implementation.";
  const setup = await repository();
  const model = scriptedModel();
  const prompts = [];
  await assessOrdinaryDocumentationSupport({ ...setup, workflow: "create-documentation", revision, instruction, snapshotSha256: sha("snapshot"), authorizedWriteRoots: ["docs/"], requestIntent: { ...projection(instruction), authorityPreference: { preference: "implementation", quote: quoteOf(instruction, "match current implementation") } }, modelCall: async (call) => { prompts.push(call.prompt); return model.modelCall(call); } });
  const assessment = prompts.find((prompt) => prompt.includes("Mandatory obligations:"));
  assert.match(assessment, /Admitted authority preference:.*implementation/u);
  assert.match(assessment, /still.*contradicted/u);
});
