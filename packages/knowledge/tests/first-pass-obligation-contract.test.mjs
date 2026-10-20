// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * Offline reproductions of observed first-pass obligation rejections, plus the
 * bounded correction round. Fixture shapes are sanitized reconstructions; see
 * fixtures/first-pass-obligation-rejections.json.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import {
  assessOrdinaryDocumentationSupport,
  FirstPassSupportError,
} from "../src/first-pass-support.mjs";
import { mainAuthorityExpansion } from "./fixtures/main-authority-expansion.mjs";

const fixture = JSON.parse(
  await readFile(new URL("./fixtures/first-pass-obligation-rejections.json", import.meta.url), "utf8"),
);
const revision = "7".repeat(40);
const DECOMPOSITION = "Phase: obligation-decomposition";
const COMPLETENESS = "Phase: obligation-completeness-audit";
const temporary = [];

test.after(async () => {
  await Promise.all(temporary.map((directory) => rm(directory, { recursive: true, force: true })));
});

function sha(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

async function repository() {
  const root = await mkdtemp(path.join(tmpdir(), "knowledge-obligation-contract-"));
  temporary.push(root);
  for (const [relative, text] of Object.entries(fixture.repository)) {
    await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
    await writeFile(path.join(root, relative), text);
  }
  return root;
}

function respond(request, value) {
  const responseText = typeof value === "string" ? value : JSON.stringify(value);
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
}

/**
 * Scripted provider. Each phase replays its listed responses in order and
 * repeats the last one, so a model that keeps a violation keeps failing.
 */
function scriptedModel({ decompositions, omissions = [[]], prompts = [] }) {
  let decompositionCalls = 0;
  let completenessCalls = 0;
  return async (request) => {
    prompts.push(request.prompt);
    if (request.prompt.startsWith(DECOMPOSITION)) {
      const next = decompositions[Math.min(decompositionCalls, decompositions.length - 1)];
      decompositionCalls += 1;
      return respond(
        request,
        typeof next === "string" ? next : { schemaVersion: 1, additionalObligations: next },
      );
    }
    if (request.prompt.startsWith(COMPLETENESS)) {
      const next = omissions[Math.min(completenessCalls, omissions.length - 1)];
      completenessCalls += 1;
      return respond(request, { schemaVersion: 1, complete: next.length === 0, omissions: next });
    }
    const line = request.prompt
      .split("\n")
      .find((entry) => entry.startsWith("Mandatory obligations: "));
    const obligations = JSON.parse(line.slice("Mandatory obligations: ".length));
    const span = /BEGIN UNTRUSTED EVIDENCE (SPAN-\d+)/u.exec(request.prompt)[1];
    return respond(request, {
      schemaVersion: 1,
      assessments: obligations.map((obligation) => ({
        obligationId: obligation.id,
        status: "supported",
        evidenceSpanIds: obligation.requiredSourceSupport ? [span] : [],
        detail: "Supported by the offered source.",
      })),
    });
  };
}

/**
 * The runtime host's first-pass budget with one correction round: the mandatory
 * phases, one evidence-expansion turn, and one round.
 */
const ONE_ROUND_BUDGET = Object.freeze({
  maxCorrections: 1,
  evidenceExpansionModelTurns: 1,
  inputTokensPerTurn: 64 * 1024,
  outputTokensPerTurn: 4096,
});

async function assess({ workflow, instruction, modelCall, modelBudget = ONE_ROUND_BUDGET }) {
  return assessOrdinaryDocumentationSupport({
    repositoryPath: await repository(),
    instruction,
    revision,
    workflow,
    snapshotSha256: sha("snapshot"),
    modelCall,
    modelBudget,
  });
}

function phaseCount(prompts, prefix) {
  return prompts.filter((prompt) => prompt.startsWith(prefix)).length;
}

for (const observed of fixture.observed) {
  const base = fixture.decompositionBase[observed.base];

  test(`${observed.name}: a correct obligation is admitted without correction`, async () => {
    for (const variant of observed.accepted) {
      const instruction = fixture.instructions[variant.instruction];
      const prompts = [];
      const items = [...base, variant.item];
      assert.equal(
        `$response.additionalObligations[${items.length - 1}]`,
        observed.location.replace(/\.(?:condition|instructionQuote)$/u, ""),
        variant.label,
      );
      const support = await assess({
        workflow: observed.workflow,
        instruction,
        modelCall: scriptedModel({ decompositions: [items], prompts }),
      }).catch((error) => {
        throw new Error(`${variant.label}: ${error.rule} at ${error.location}`, { cause: error });
      });
      const admitted = support.obligations.find((item) => item.id === variant.item.id);
      assert.ok(admitted, variant.label);
      assert.equal(phaseCount(prompts, DECOMPOSITION), 1, variant.label);
      assert.equal(support.terminationReason, "supported", variant.label);
      if (variant.item.origin === "explicit") {
        assert.equal(admitted.condition, variant.canonical ?? variant.item.condition, variant.label);
        assert.equal(
          instruction.slice(admitted.instructionSpan.start, admitted.instructionSpan.end),
          admitted.condition,
          variant.label,
        );
      } else {
        assert.equal(admitted.condition, variant.item.condition, variant.label);
        assert.equal(admitted.instructionSpan, undefined, variant.label);
      }
    }
  });

  test(`${observed.name}: a true violation still fails with its rule after one correction`, async () => {
    for (const variant of observed.rejected) {
      const prompts = [];
      const location = variant.location ?? observed.location;
      const error = await assess({
        workflow: observed.workflow,
        instruction: fixture.instructions[variant.instruction],
        modelCall: scriptedModel({ decompositions: [[...base, variant.item]], prompts }),
      }).catch((caught) => caught);
      assert.ok(error instanceof FirstPassSupportError, variant.label);
      assert.equal(error.code, "assessment-invalid", variant.label);
      assert.equal(error.phase, "decomposition", variant.label);
      assert.equal(error.rule, observed.rule, variant.label);
      assert.equal(error.location, location, variant.label);
      const decompositionPrompts = prompts.filter((prompt) => prompt.startsWith(DECOMPOSITION));
      assert.equal(decompositionPrompts.length, 2, variant.label);
      assert.ok(
        decompositionPrompts[1].includes(`at ${location} under rule ${observed.rule}.`),
        variant.label,
      );
      // The correction names the rule and location, never the model's own text.
      assert.ok(!decompositionPrompts[1].includes(JSON.stringify(variant.item)), variant.label);
      assert.ok(!decompositionPrompts[1].includes("Previous response"), variant.label);
      assert.equal(phaseCount(prompts, COMPLETENESS), 0, variant.label);
    }
  });
}

test("a rejected decomposition item is corrected once with its rule and location fed back", async () => {
  const base = fixture.decompositionBase.update;
  const prompts = [];
  const rejected = fixture.observed[1].rejected[0].item;
  const corrected = {
    ...rejected,
    origin: "inferred",
    instructionQuote: null,
    condition: "Keep every other quickstart section unchanged.",
  };
  const support = await assess({
    workflow: "update-documentation",
    instruction: fixture.instructions.update,
    modelCall: scriptedModel({ decompositions: [[...base, rejected], [...base, corrected]], prompts }),
  });
  assert.equal(support.terminationReason, "supported");
  // The correction round's turn comes on top of the mandatory and expansion turns.
  assert.equal(support.cost.modelTurns, 4);
  assert.equal(support.limits.maxModelTurns, 5);
  assert.deepEqual(
    prompts.map((prompt) => prompt.split("\n")[0]),
    [DECOMPOSITION, DECOMPOSITION, COMPLETENESS, "Workflow: update-documentation"],
  );
  assert.match(
    prompts[1],
    /Correction: the host rejected your previous response at \$response\.additionalObligations\[2\]\.instructionQuote under rule explicit-quote-binding\./u,
  );
  assert.equal(
    support.obligations.find((item) => item.id === rejected.id).condition,
    corrected.condition,
  );
});

test("completeness gets a correction only while the pass's correction budget has a round left", async () => {
  const base = fixture.decompositionBase.update;
  const unsafeOmission = {
    id: "audit-extra-page",
    origin: "inferred",
    instructionQuote: null,
    targetPaths: ["docs/guide.md"],
    condition: "The guide also explains JSON output.",
    requiredSourceSupport: true,
  };
  const validOmission = { ...unsafeOmission, targetPaths: ["docs/quickstart.md"] };

  const corrected = [];
  const support = await assess({
    workflow: "update-documentation",
    instruction: fixture.instructions.update,
    modelCall: scriptedModel({
      decompositions: [base],
      omissions: [[unsafeOmission], [validOmission]],
      prompts: corrected,
    }),
  });
  assert.equal(support.terminationReason, "supported");
  assert.equal(phaseCount(corrected, COMPLETENESS), 2);
  assert.ok(support.obligations.some((item) => item.id === "audit-extra-page"));

  const exhausted = [];
  const error = await assess({
    workflow: "update-documentation",
    instruction: fixture.instructions.update,
    modelCall: scriptedModel({
      decompositions: [[...base, fixture.observed[1].rejected[0].item], base],
      omissions: [[unsafeOmission], [validOmission]],
      prompts: exhausted,
    }),
  }).catch((caught) => caught);
  assert.ok(error instanceof FirstPassSupportError);
  assert.equal(error.phase, "completeness");
  assert.equal(error.rule, "target-binding");
  assert.equal(error.location, "$response.omissions[0].targetPaths");
  assert.equal(phaseCount(exhausted, DECOMPOSITION), 2);
  assert.equal(phaseCount(exhausted, COMPLETENESS), 1);
});

test("malformed JSON gets one hinted correction, then passes (#1284)", async () => {
  const prompts = [];
  const support = await assess({
    workflow: "update-documentation",
    instruction: fixture.instructions.update,
    modelCall: scriptedModel({ decompositions: ["{", []], prompts }),
  });
  assert.equal(support.terminationReason, "supported");
  assert.equal(phaseCount(prompts, DECOMPOSITION), 2);
  assert.match(
    prompts[1],
    /under rule strict-json\. Return one strict JSON object only, with no Markdown fences/u,
  );
});

test("with no host budget the first pass runs no correction round", async () => {
  const prompts = [];
  const error = await assessOrdinaryDocumentationSupport({
    repositoryPath: await repository(),
    instruction: fixture.instructions.update,
    revision,
    workflow: "update-documentation",
    snapshotSha256: sha("snapshot"),
    modelCall: scriptedModel({ decompositions: ["{", []], prompts }),
  }).catch((caught) => caught);
  assert.equal(error.rule, "strict-json");
  assert.equal(error.corrections, 0);
  assert.equal(prompts.length, 1);
});

test("host identity failures are not model corrections", async () => {
  const prompts = [];
  const delegate = scriptedModel({ decompositions: [[]], prompts });
  const error = await assess({
    workflow: "update-documentation",
    instruction: fixture.instructions.update,
    modelCall: async (request) => {
      const response = await delegate(request);
      return { ...response, identity: { ...response.identity, responseSha256: sha("other") } };
    },
  }).catch((caught) => caught);
  assert.equal(error.rule, "identity-binding");
  assert.equal(prompts.length, 1);
});

test("the decomposition prompt states the rules the host enforces", async () => {
  const prompts = [];
  await assess({
    workflow: "update-documentation",
    instruction: fixture.instructions.update,
    modelCall: scriptedModel({ decompositions: [[]], prompts }),
  });
  const [decomposition, completeness] = prompts;
  for (const prompt of [decomposition, completeness]) {
    assert.match(prompt, /lowercase ASCII letters, digits, and hyphens/u);
    assert.match(prompt, /at most 500 characters/u);
    assert.match(prompt, /non-empty list of distinct paths copied from Exact write targets/u);
    assert.match(prompt, /use origin inferred with instructionQuote null/u);
    assert.match(prompt, /Do not add inferred prohibitions/u);
    assert.match(prompt, /this check is hygiene, not the authority boundary/u);
    assert.doesNotMatch(prompt, /in other words/u);
    assert.match(prompt, /host-enforced limits/u);
  }
  assert.match(completeness, /complete is true exactly when omissions is empty/u);
});

// An inferred item's authority decision equals the vendored
// main-authority-expansion decision, with no allowances; NFKC and
// format-character normalization can only reject more. The property runs the
// admission path over every review corpus and fixture condition, and the
// mutation test shows an injected acceptance fails it.
const TARGET = ["docs/cli-reference.md"];

function inferredItem(condition) {
  return { id: "decomposed-authority", origin: "inferred", instructionQuote: null, targetPaths: TARGET, condition, requiredSourceSupport: false };
}

async function rejectsInferred(assessSupport, repositoryPath, condition) {
  const outcome = await assessSupport({
    repositoryPath,
    instruction: fixture.instructions.create,
    revision,
    workflow: "create-documentation",
    snapshotSha256: sha("snapshot"),
    modelCall: scriptedModel({ decompositions: [[inferredItem(condition)]] }),
  }).catch((error) => error);
  if (!(outcome instanceof Error)) return false;
  assert.equal(outcome.rule, "authority-expansion", JSON.stringify(condition));
  assert.equal(outcome.location, "$response.additionalObligations[0].condition", JSON.stringify(condition));
  return true;
}

function authorityCorpus() {
  return [...new Set([
    ...Object.values(fixture.reviewCorpus).flat(),
    ...fixture.earlierFixtureConditions,
    ...fixture.observed[0].prohibitionConditions,
    ...fixture.observed[0].topicConditions,
    ...fixture.observed.flatMap((observed) =>
      [...observed.accepted, ...observed.rejected]
        .filter((variant) => variant.item.origin === "inferred")
        .map((variant) => variant.item.condition),
    ),
  ])];
}

const mainRejects = (condition) => mainAuthorityExpansion({ origin: "inferred", condition });

/** Inputs where the admission path and main's function disagree. */
async function authorityDisagreements(assessSupport) {
  const repositoryPath = await repository();
  const acceptedButMainRejects = [];
  const rejectedButMainAccepts = [];
  for (const condition of authorityCorpus()) {
    const head = await rejectsInferred(assessSupport, repositoryPath, condition);
    const main = mainRejects(condition);
    if (main && !head) acceptedButMainRejects.push(condition);
    if (!main && head) rejectedButMainAccepts.push(condition);
  }
  return { acceptedButMainRejects, rejectedButMainAccepts };
}

/** Load first-pass/assess.mjs with one source edit, for a mutation check. */
async function mutatedAssess(edit) {
  const sourceUrl = new URL("../src/first-pass/assess.mjs", import.meta.url);
  const source = await readFile(sourceUrl, "utf8");
  const mutated = edit(source);
  assert.notEqual(mutated, source, "the mutation must change the source");
  const rebased = mutated.replace(/from "(\.\.?\/[^"]+)"/gu, (_, file) =>
    "from " + JSON.stringify(new URL(`../src/first-pass/${file}`, import.meta.url).href),
  );
  const root = await mkdtemp(path.join(tmpdir(), "knowledge-authority-mutant-"));
  temporary.push(root);
  const file = path.join(root, "first-pass-assess-mutant.mjs");
  await writeFile(file, rebased);
  return import(pathToFileURL(file).href);
}

test("inferred authority decisions equal main's decision", async () => {
  const { acceptedButMainRejects, rejectedButMainAccepts } = await authorityDisagreements(
    assessOrdinaryDocumentationSupport,
  );
  // No allowances: nothing main rejects is admitted.
  assert.deepEqual(acceptedButMainRejects, []);
  // Normalization only rejects more: a main word hidden by NFKC or format characters.
  assert.deepEqual(rejectedButMainAccepts, fixture.normalizationRejected);
  for (const condition of rejectedButMainAccepts) {
    const visible = condition.normalize("NFKC").replace(/\p{Cf}/gu, "");
    assert.notEqual(visible, condition, JSON.stringify(condition));
    assert.ok(mainRejects(visible), JSON.stringify(condition));
  }
});

test("any injected acceptance of a main-rejected input fails the property", async () => {
  const injected = "Explain how to publish a package to npm";
  assert.ok(mainRejects(injected));
  const mutant = await mutatedAssess((source) =>
    source.replace(
      "function authorityExpansion(condition) {",
      `function authorityExpansion(condition) {\n  if (condition === ${JSON.stringify(injected)}) return false;`,
    ),
  );
  const { acceptedButMainRejects } = await authorityDisagreements(mutant.assessOrdinaryDocumentationSupport);
  assert.deepEqual(acceptedButMainRejects, [injected]);
});

test("explicit quotes bind the user's own words without an authority check", async () => {
  const repositoryPath = await repository();
  // Includes user-quoted prohibitions: they stay admitted although inferred ones do not.
  const quotes = [
    ...fixture.observed[0].topicConditions,
    ...fixture.observed[0].prohibitionConditions,
    ...fixture.reviewCorpus["70867824"],
  ];
  for (const condition of quotes) {
    const instruction = `${fixture.instructions.create} ${condition}`;
    const item = { ...inferredItem(condition), origin: "explicit", instructionQuote: condition };
    const support = await assessOrdinaryDocumentationSupport({
      repositoryPath,
      instruction,
      revision,
      workflow: "create-documentation",
      snapshotSha256: sha("snapshot"),
      modelCall: scriptedModel({ decompositions: [[item]] }),
    });
    const bound = support.obligations.find((obligation) => obligation.id === item.id);
    assert.equal(instruction.slice(bound.instructionSpan.start, bound.instructionSpan.end), bound.condition);
  }
});

test("a correction cannot launder a grant into an admitted condition", async () => {
  const base = fixture.decompositionBase.create;
  const target = ["docs/cli-reference.md"];
  const grant = (id, condition) => ({ id, origin: "inferred", instructionQuote: null, targetPaths: target, condition, requiredSourceSupport: false });
  const error = await assess({
    workflow: "create-documentation",
    instruction: fixture.instructions.create,
    modelCall: scriptedModel({
      decompositions: [
        [...base, grant("decomposed-publish", "You may publish the result once the page is written.")],
        [
          ...base,
          grant("decomposed-merge", "Do not merge, approve the MR"),
          grant("decomposed-publish", "Never publish the page, unless approved"),
        ],
      ],
    }),
  }).catch((caught) => caught);
  assert.ok(error instanceof FirstPassSupportError);
  assert.equal(error.rule, "authority-expansion");
  assert.equal(error.location, "$response.additionalObligations[12].condition");
});
