// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// A contradicted assessment may name the disagreeing sides; the first pass
// checks their shape and carries them into the support record, and the
// partial fallback names the contradicted obligation, not an install command.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { gatherRepositoryFirstPass } from "../src/first-pass.mjs";
import {
  classifyDocumentationPartialFallback,
  FirstPassSupportError,
  parseEvidenceFrames,
} from "../src/first-pass-support.mjs";
import { FIRST_PASS_CORRECTIONS } from "../src/first-pass/assess.mjs";
import { FIRST_PASS_LIMIT_DEFAULTS } from "../src/first-pass-limits.generated.mjs";

const revision = "7".repeat(40);
const TARGET = "docs/deployment.md";
const INSTRUCTION = `Update ${TARGET} with the service's listening port.`;

const temporary = [];
test.after(async () => {
  await Promise.all(temporary.map((root) => rm(root, { recursive: true, force: true })));
});

async function portRepository() {
  const root = await mkdtemp(path.join(tmpdir(), "knowledge-first-pass-contradiction-"));
  temporary.push(root);
  const repository = path.join(root, "repo");
  await mkdir(path.join(repository, "docs"), { recursive: true });
  await mkdir(path.join(repository, "src"), { recursive: true });
  await writeFile(path.join(repository, TARGET), "# Deployment\n\nDeploy the service.\n");
  await writeFile(
    path.join(repository, "deploy.yaml"),
    "service:\n  name: api\n  replicas: 2\n  port: 9090\n",
  );
  await writeFile(
    path.join(repository, "src", "server.ts"),
    "// The listening port.\nexport const requiredListenPort = 8088;\n",
  );
  return { repository, data: path.join(root, "data") };
}

function sha(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function respond(request, value) {
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
}

/**
 * Marks every required obligation contradicted between the deploy.yaml and
 * src/server.ts spans; `sides(frames)` writes the sides each answer carries.
 */
function contradictionModel(sides, prompts = []) {
  return async (request) => {
    if (request.prompt.startsWith("Phase: obligation-decomposition")) {
      return respond(request, { schemaVersion: 1, additionalObligations: [] });
    }
    if (request.prompt.startsWith("Phase: obligation-completeness-audit")) {
      return respond(request, { schemaVersion: 1, complete: true, omissions: [] });
    }
    prompts.push(request.prompt);
    const line = request.prompt.split("\n").find((entry) => entry.startsWith("Mandatory obligations: "));
    const seeds = JSON.parse(line.slice("Mandatory obligations: ".length));
    const frames = parseEvidenceFrames(request.prompt);
    const deploy = frames.find((frame) => frame.path === "deploy.yaml");
    const server = frames.find((frame) => frame.path === "src/server.ts");
    assert.ok(deploy && server, "the port sources were offered");
    return respond(request, {
      schemaVersion: 1,
      assessments: seeds.map((seed) => {
        if (!seed.requiredSourceSupport) {
          return { obligationId: seed.id, status: "supported", evidenceSpanIds: [], detail: "Instruction bound." };
        }
        const written = sides({ deploy, server, call: prompts.length });
        return {
          obligationId: seed.id,
          status: "contradicted",
          evidenceSpanIds: [deploy.id, server.id],
          detail: "deploy.yaml and src/server.ts name different ports.",
          ...(written === undefined ? {} : { sides: written }),
        };
      }),
    });
  };
}

function gather(setup, modelCall, extra = {}) {
  return gatherRepositoryFirstPass({
    repositoryPath: setup.repository,
    dataDirectory: setup.data,
    revision,
    workflow: "update-documentation",
    instruction: INSTRUCTION,
    authorizedWriteRoots: ["docs/"],
    modelCall,
    ...extra,
  });
}

test("a contradicted assessment's sides reach the support record as written", async () => {
  const setup = await portRepository();
  const result = await gather(
    setup,
    contradictionModel(({ deploy, server }) => [
      { spanId: deploy.id, value: "9090" },
      { spanId: server.id, value: "8088" },
    ]),
  );
  assert.equal(result.support.terminationReason, "unresolved-obligations");
  const contradicted = result.support.obligations.filter((item) => item.status === "contradicted");
  assert.ok(contradicted.length > 0);
  for (const item of contradicted) {
    assert.deepEqual(
      item.sides.map((side) => side.value),
      ["9090", "8088"],
    );
    assert.deepEqual(
      item.sides.map((side) => side.spanId),
      item.evidenceSpanIds,
    );
  }
  // No side on any other status.
  assert.ok(
    result.support.obligations
      .filter((item) => item.status !== "contradicted")
      .every((item) => !Object.hasOwn(item, "sides")),
  );
});

test("a contradicted assessment without sides is still accepted", async () => {
  const setup = await portRepository();
  const result = await gather(setup, contradictionModel(() => undefined));
  const contradicted = result.support.obligations.filter((item) => item.status === "contradicted");
  assert.ok(contradicted.length > 0);
  assert.ok(contradicted.every((item) => !Object.hasOwn(item, "sides")));
});

test("the first pass refuses sides in a shape the prompt does not state", async () => {
  const over = "9".repeat(FIRST_PASS_LIMIT_DEFAULTS.maxContradictionValueChars + 1);
  const atBound = "9".repeat(FIRST_PASS_LIMIT_DEFAULTS.maxContradictionValueChars);
  const cases = [
    ["one side", ({ deploy }) => [{ spanId: deploy.id, value: "9090" }], "contradiction-sides"],
    [
      "two sides with one value",
      ({ deploy, server }) => [
        { spanId: deploy.id, value: "9090" },
        { spanId: server.id, value: "9090" },
      ],
      "contradiction-sides",
    ],
    [
      "two sides equal once normalized (NFC and NFD)",
      ({ deploy, server }) => [
        { spanId: deploy.id, value: "caf\u00e9" },
        { spanId: server.id, value: "cafe\u0301" },
      ],
      "contradiction-sides",
    ],
    [
      "two sides equal once line endings are normalized",
      ({ deploy, server }) => [
        { spanId: deploy.id, value: "port:\r\n9090" },
        { spanId: server.id, value: "port:\n9090" },
      ],
      "contradiction-sides",
    ],
    [
      "a span the assessment does not cite",
      ({ deploy }) => [
        { spanId: deploy.id, value: "9090" },
        { spanId: "SPAN-999", value: "8088" },
      ],
      "contradiction-sides",
    ],
    [
      "an empty value",
      ({ deploy, server }) => [
        { spanId: deploy.id, value: "9090" },
        { spanId: server.id, value: "  " },
      ],
      "contradiction-sides",
    ],
    [
      "a value over firstPass.maxContradictionValueChars",
      ({ deploy, server }) => [
        { spanId: deploy.id, value: "9090" },
        { spanId: server.id, value: over },
      ],
      "contradiction-sides",
    ],
    [
      "more sides than firstPass.maxContradictionSides",
      ({ deploy, server }) =>
        Array.from({ length: FIRST_PASS_LIMIT_DEFAULTS.maxContradictionSides + 1 }, (_, index) => ({
          spanId: index % 2 === 0 ? deploy.id : server.id,
          value: String(index),
        })),
      "contradiction-sides",
    ],
    [
      "an unknown key in a side",
      ({ deploy, server }) => [
        { spanId: deploy.id, value: "9090" },
        { spanId: server.id, value: "8088", pathClass: "source" },
      ],
      "closed-schema",
    ],
    ["sides that are not a list", () => ({ deploy: "9090" }), "contradiction-sides"],
  ];
  for (const [name, sides, rule] of cases) {
    const setup = await portRepository();
    await assert.rejects(
      gather(setup, contradictionModel(sides)),
      (error) =>
        error instanceof FirstPassSupportError &&
        error.code === "assessment-invalid" &&
        error.rule === rule &&
        error.location.startsWith("$response.assessments["),
      name,
    );
  }
  // Positive controls at the bounds: a value of exactly the bound, and exactly
  // the side bound with two distinct values.
  for (const sides of [
    ({ deploy, server }) => [
      { spanId: deploy.id, value: "9090" },
      { spanId: server.id, value: atBound },
    ],
    ({ deploy, server }) =>
      Array.from({ length: FIRST_PASS_LIMIT_DEFAULTS.maxContradictionSides }, (_, index) => ({
        spanId: index % 2 === 0 ? deploy.id : server.id,
        value: String(index),
      })),
  ]) {
    const setup = await portRepository();
    const result = await gather(setup, contradictionModel(sides));
    assert.equal(result.support.terminationReason, "unresolved-obligations");
  }
});

test("an assessment row with any other extra key is still refused", async () => {
  // Adjacent to the optional sides key: the row stays closed.
  const setup = await portRepository();
  const model = async (request) => {
    const answer = await contradictionModel(() => undefined)(request);
    if (request.prompt.startsWith("Phase:")) return answer;
    const value = JSON.parse(answer.responseText);
    value.assessments[0].confidence = "high";
    return respond(request, value);
  };
  await assert.rejects(
    gather(setup, model),
    (error) =>
      error instanceof FirstPassSupportError &&
      error.rule === "closed-schema" &&
      error.location === "$response.assessments[0]",
  );
});

test("a side on an assessment that is not contradicted is refused", async () => {
  const setup = await portRepository();
  const model = async (request) => {
    const answer = await contradictionModel(({ deploy, server }) => [
      { spanId: deploy.id, value: "9090" },
      { spanId: server.id, value: "8088" },
    ])(request);
    if (request.prompt.startsWith("Phase:")) return answer;
    const value = JSON.parse(answer.responseText);
    for (const row of value.assessments) if (row.sides) row.status = "supported";
    return respond(request, value);
  };
  await assert.rejects(
    gather(setup, model),
    (error) => error instanceof FirstPassSupportError && error.rule === "contradiction-sides",
  );
});

test("a correction round names the sides contract and repairs the answer", async () => {
  const setup = await portRepository();
  const prompts = [];
  const result = await gather(
    setup,
    contradictionModel(
      ({ deploy, server, call }) =>
        call === 1
          ? [{ spanId: deploy.id, value: "9090" }]
          : [
              { spanId: deploy.id, value: "9090" },
              { spanId: server.id, value: "8088" },
            ],
      prompts,
    ),
    {
      modelBudget: {
        maxCorrections: 1,
        evidenceExpansionModelTurns: FIRST_PASS_LIMIT_DEFAULTS.evidenceExpansionModelTurns,
        inputTokensPerTurn: FIRST_PASS_LIMIT_DEFAULTS.modelInputTokensPerTurn,
        outputTokensPerTurn: FIRST_PASS_LIMIT_DEFAULTS.modelOutputTokensPerTurn,
      },
    },
  );
  assert.equal(prompts.length, 2);
  assert.ok(prompts[1].includes(FIRST_PASS_CORRECTIONS["contradiction-sides"]));
  assert.ok(
    result.support.obligations.some((item) => item.status === "contradicted" && item.sides?.length === 2),
  );
});

test("the partial fallback names the contradicted obligation, not an install command", async () => {
  const setup = await portRepository();
  const result = await gather(
    setup,
    contradictionModel(({ deploy, server }) => [
      { spanId: deploy.id, value: "9090" },
      { spanId: server.id, value: "8088" },
    ]),
  );
  const classified = classifyDocumentationPartialFallback({
    support: result.support,
    instruction: INSTRUCTION,
    repositoryPath: setup.repository,
    authorizedWriteRoots: ["docs/"],
  });
  const contradicted = result.support.obligations.filter((item) => item.status === "contradicted");
  for (const item of contradicted) {
    const question = classified.envelope.unresolvedQuestions.find(
      (entry) => entry.obligationId === item.id,
    );
    assert.equal(
      question.neededSourceOrDecision,
      `Accountable product decision or source correction for the sources that disagree on ${item.id}: ${item.condition}`,
    );
    assert.ok(
      classified.envelope.claimsNotMade.includes(
        `Either disagreeing source for ${item.id} as product truth`,
      ),
    );
  }
  const text = JSON.stringify(classified.envelope);
  assert.doesNotMatch(text, /install command/u);
});
