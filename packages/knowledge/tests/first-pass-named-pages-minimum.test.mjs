// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * The pages a request names are the least its plan addresses, not all it may
 * write. First pass seeds them that way, and tells the model that a request to
 * also correct other pages the change makes out of date is met by the plan
 * with pages under the documentation write roots, so it needs no first-pass
 * evidence. This pins the host-authored prompt text a scripted model reads; it
 * is not evidence of what a live model assesses.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { assessOrdinaryDocumentationSupport } from "../src/first-pass-support.mjs";

const revision = "7".repeat(40);
const DECOMPOSITION = "Phase: obligation-decomposition";
const COMPLETENESS = "Phase: obligation-completeness-audit";
const OTHER_PAGES = "correct any other page that the change makes out of date";
const INSTRUCTION = `Update docs/cli.md and docs/guide.md for the new --new option, and ${OTHER_PAGES}.`;
const temporary = [];

test.after(async () => {
  await Promise.all(temporary.map((directory) => rm(directory, { recursive: true, force: true })));
});

function sha(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

async function repository() {
  const root = await mkdtemp(path.join(tmpdir(), "knowledge-named-pages-minimum-"));
  temporary.push(root);
  const files = {
    "src/orbit.mjs": "export const option = '--new';\n",
    "docs/cli.md": "# Orbit CLI\n\nThe public option is --new.\n",
    "docs/guide.md": "# Guide\n\nRun Orbit with --new.\n",
  };
  for (const [relative, text] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
    await writeFile(path.join(root, relative), text);
  }
  return root;
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
 * A scripted model that adds `omissions` at the completeness audit and
 * supports every obligation, citing an offered span only where one is needed.
 */
function scriptedModel({ omissions = [], requests = [] }) {
  return async (request) => {
    requests.push(request);
    if (request.prompt.startsWith(DECOMPOSITION)) {
      return respond(request, { schemaVersion: 1, additionalObligations: [] });
    }
    if (request.prompt.startsWith(COMPLETENESS)) {
      return respond(request, { schemaVersion: 1, complete: omissions.length === 0, omissions });
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
        detail: "Supported.",
      })),
    });
  };
}

async function assess(modelCall) {
  return assessOrdinaryDocumentationSupport({
    repositoryPath: await repository(),
    instruction: INSTRUCTION,
    revision,
    workflow: "update-documentation",
    snapshotSha256: sha("snapshot"),
    modelCall,
    modelBudget: {
      maxCorrections: 0,
      evidenceExpansionModelTurns: 1,
      inputTokensPerTurn: 64 * 1024,
      outputTokensPerTurn: 4096,
    },
  });
}

/** The host-seeded obligations the decomposition prompt shows the model. */
function seededObligations(prompt) {
  const line = prompt
    .split("\n")
    .find((entry) => entry.startsWith("Host-seeded mandatory obligations: "));
  return JSON.parse(line.slice("Host-seeded mandatory obligations: ".length));
}

test("seeds the named pages as the least the plan addresses, never all it may write", async () => {
  const requests = [];
  const support = await assess(scriptedModel({ requests }));
  assert.equal(support.terminationReason, "supported");
  const decomposition = requests.find((request) => request.prompt.startsWith(DECOMPOSITION));
  const seed = seededObligations(decomposition.prompt).find(
    (item) => item.id === "workflow-target-set",
  );
  assert.deepEqual(seed.targetPaths, ["docs/cli.md", "docs/guide.md"]);
  assert.equal(seed.requiredSourceSupport, false);
  assert.equal(
    seed.condition,
    "The downstream documentation plan must address every bound target; it may add other pages under the documentation write roots that the instruction asks it to correct.",
  );
  for (const request of requests) {
    assert.ok(!request.prompt.includes("must write exactly the bound target set"));
  }
});

test("tells the model that correcting other pages needs no first-pass evidence", async () => {
  const requests = [];
  await assess(scriptedModel({ requests }));
  assert.ok(requests.length > 0);
  for (const request of requests) {
    assert.ok(
      request.systemPrompt.includes(
        "A request to also correct other pages the change makes out of date is such a constraint: the downstream plan meets it with pages it adds under the documentation write roots, so first pass needs no evidence for those pages.",
      ),
    );
  }
});

test("supports an audited other-pages obligation from the instruction alone (control)", async () => {
  const support = await assess(
    scriptedModel({
      omissions: [
        {
          id: "audit-correct-other-outdated-page",
          origin: "explicit",
          instructionQuote: OTHER_PAGES,
          targetPaths: ["docs/cli.md", "docs/guide.md"],
          condition: OTHER_PAGES,
          requiredSourceSupport: false,
        },
      ],
    }),
  );
  assert.equal(support.terminationReason, "supported");
  const audited = support.obligations.find(
    (item) => item.id === "audit-correct-other-outdated-page",
  );
  assert.equal(audited.status, "supported");
  assert.deepEqual(audited.evidenceSpanIds, []);
});
