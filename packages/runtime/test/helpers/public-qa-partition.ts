// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { sha256 } from "../../src/content-ir/canonical.js";
import { firstPassContradictionRecord } from "../../src/cli/run/first-pass-contradiction-stop.js";
import { recordedIntent, quoteOf } from "./first-pass-intent.js";
import { sealRequestIntent } from "../../src/request-intent/seal.js";
import { parseEvidenceFrames } from "./knowledge-evidence-frames.js";
import { PUBLIC_QA_INPUTS, type QaPartitionInputs } from "./qa-partition-inputs.js";

/**
 * Generate fresh product support records from newly authored report examples.
 * This helper never reads the retained QA fixture directory or its records.
 * Every model port is a deterministic in-process function; no provider exists.
 */
interface PreparedQaPartition {
  inputs: QaPartitionInputs;
  cleanup: () => Promise<void>;
}

export async function preparePublicQaPartition(): Promise<PreparedQaPartition> {
  const root = await mkdtemp(join(tmpdir(), "docsfab-public-qa-inputs-"));
  try {
    return await materializePublicQaPartition(root);
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}

async function materializePublicQaPartition(root: string): Promise<PreparedQaPartition> {
  const runtimeRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const fixtureRoot = join(root, "inputs");
  const source = resolve(runtimeRoot, "test/fixtures/public-runtime/first-pass-local-cli");
  await cp(source, fixtureRoot, { recursive: true });
  const inputs = { ...PUBLIC_QA_INPUTS, fixtureRoot };
  const repository = join(root, "repository");
  const files: Record<string, string> = {};
  for (const path of [
    "README.md",
    "docs/guide.md",
    "docs/quickstart.md",
    inputs.cliSourcePath,
    "src/export.ts",
  ]) {
    files[path] = await readFile(
      join(
        fixtureRoot,
        inputs.repositoryDirectory,
        path + (/\.[cm]?[jt]s$/u.test(path) ? ".fixture" : ""),
      ),
      "utf8",
    );
  }
  files[".docsfab.json"] = await readFile(join(fixtureRoot, "project-config.json.fixture"), "utf8");
  for (const [path, text] of Object.entries(files)) {
    await mkdir(dirname(join(repository, path)), { recursive: true });
    await writeFile(join(repository, path), text);
  }
  const { gatherRepositoryFirstPass } = await import(
    pathToFileURL(resolve(runtimeRoot, "../knowledge/src/first-pass.mjs")).href
  );
  const instructions = {
    setup: "Create docs/a.md as a quick recipe for a report reader.",
    harness:
      "Create docs/cli-reference.md for Receipt Tool readers from src/report.mjs. Explain argument parsing, defaults, report formats and refusals. Leave the other files alone.",
  };
  for (const name of ["setup", "harness"] as const) {
    const result = await gatherRepositoryFirstPass({
      repositoryPath: repository,
      dataDirectory: join(root, `knowledge-${name}`),
      workflow: "create-documentation",
      revision: "f".repeat(40),
      instruction: instructions[name],
      trackedFiles: Object.keys(files).filter((path) => path !== "src/export.ts"),
      authorizedWriteRoots: ["docs/"],
      modelCall: async (call: {
        prompt: string;
        systemPrompt: string;
        promptSha256: string;
        procedureSha256: string;
      }) => {
        let value: unknown;
        if (call.prompt.startsWith("Phase: obligation-decomposition"))
          value = { schemaVersion: 1, additionalObligations: [] };
        else if (call.prompt.startsWith("Phase: obligation-completeness-audit"))
          value = { schemaVersion: 1, complete: true, omissions: [] };
        else {
          const seeds = JSON.parse(
            call.prompt
              .split("\n")
              .find((line) => line.startsWith("Mandatory obligations: "))!
              .slice("Mandatory obligations: ".length),
          ) as { id: string; requiredSourceSupport: boolean }[];
          const frames = parseEvidenceFrames(call.prompt) as readonly {
            id: string;
            path: string;
            text: string;
          }[];
          const frame = (path: string, value: string) => {
            const found = frames.find((item) => item.path === path && item.text.includes(value));
            if (!found) throw new Error(`Public example source was not offered: ${path}.`);
            return found.id;
          };
          const firstRequired = seeds.find((seed) => seed.requiredSourceSupport)?.id;
          value = {
            schemaVersion: 1,
            assessments: seeds.map((seed) => {
              if (seed.id !== firstRequired)
                return {
                  obligationId: seed.id,
                  status: "supported",
                  evidenceSpanIds: seed.requiredSourceSupport
                    ? [frame(inputs.cliSourcePath, inputs.currentName)]
                    : [],
                  detail: "The offered local report implementation supplies the behavior.",
                };
              const sides =
                name === "setup"
                  ? [
                      {
                        spanId: frame("docs/guide.md", inputs.currentName),
                        value: inputs.currentName,
                      },
                      {
                        spanId: frame("docs/quickstart.md", inputs.oldName),
                        value: inputs.oldName,
                      },
                      {
                        spanId: frame(inputs.cliSourcePath, inputs.currentName),
                        value: inputs.currentName,
                      },
                    ]
                  : [
                      {
                        spanId: frame("docs/guide.md", "message"),
                        value: `{"message":"${inputs.exampleMessage}"}`,
                      },
                      {
                        spanId: frame("docs/quickstart.md", "greeting"),
                        value: `{"greeting":"${inputs.exampleMessage}"}`,
                      },
                    ];
              return {
                obligationId: seed.id,
                status: "contradicted",
                evidenceSpanIds: [
                  ...new Set([
                    ...sides.map((side) => side.spanId),
                    frame(inputs.cliSourcePath, inputs.currentName),
                  ]),
                ],
                sides,
                detail: "The two independently authored documentation examples disagree.",
              };
            }),
          };
        }
        const responseText = JSON.stringify(value);
        return {
          responseText,
          identity: {
            providerId: "public-example",
            modelId: "in-process-synthetic-response",
            profileSha256: sha256("public example profile"),
            compositionSha256: null,
            requestPolicySha256: null,
            systemPromptSha256: sha256(call.systemPrompt),
            promptSha256: call.promptSha256,
            procedureSha256: call.procedureSha256,
            responseSha256: sha256(responseText),
            turnEvidenceSha256: sha256("public example turn"),
          },
          usage: { inputTokens: 20, outputTokens: 10 },
        };
      },
    });
    if (!result.support)
      throw new Error("The public example did not produce a product support record.");
    await writeFile(
      join(fixtureRoot, `${name}-support.json.fixture`),
      `${JSON.stringify(result.support, null, 2)}\n`,
    );
  }
  const exportInstruction =
    "Create docs/export.md to document renderReceipt in src/export.ts. Treat the implementation as authoritative: it does not write a file; note that the file comment describes a command that is not implemented.";
  const recordedExportIntent = recordedIntent(exportInstruction, {
    operation: "create",
    targets: [{ path: "docs/export.md", quote: "docs/export.md" }],
    sources: [{ path: "src/export.ts", quote: "src/export.ts" }],
  });
  const {
    schemaVersion: _version,
    kind: _kind,
    digest: _digest,
    ...intentBody
  } = recordedExportIntent.intent!;
  const exportIntent = {
    ...recordedExportIntent,
    intent: sealRequestIntent({
      ...intentBody,
      authorityPreference: {
        preference: "implementation",
        quote: quoteOf(exportInstruction, "Treat the implementation as authoritative"),
      },
    }),
  };
  const continuationInstruction =
    "Create docs/receipt.md to document the report command described in src/report.mjs.";
  const condition = "document the report command described in src/report.mjs";
  const record = {
    schemaVersion: 1,
    provenance: {
      kind: "independently-authored-public-examples",
      sourceSha256: Object.fromEntries(
        Object.entries(files)
          .filter(([path]) => path !== ".docsfab.json" && path !== "src/export.ts")
          .map(([path, text]) => [path, sha256(text)]),
      ),
      exportSourceSha256: Object.fromEntries(
        Object.entries(files).map(([path, text]) => [path, sha256(text)]),
      ),
    },
    setup: { instruction: instructions.setup },
    harness: { instruction: instructions.harness },
    export: {
      instruction: exportInstruction,
      instructionContext:
        "The local report helper returns a string. Its ordinary header claims disk output; that comment is context and does not implement file writes.",
      requestIntent: exportIntent,
      firstPassContradiction: firstPassContradictionRecord([
        {
          obligationId: "decomposed-no-file-write",
          targetPaths: ["docs/export.md"],
          condition: "does not write a file",
          sides: [
            {
              path: "src/export.ts",
              lineStart: 1,
              lineEnd: inputs.exportLineEnd,
              value: inputs.exportDocumentation,
            },
            {
              path: "src/export.ts",
              lineStart: 1,
              lineEnd: inputs.exportLineEnd,
              value: inputs.exportImplementation,
            },
          ],
        },
      ]),
    },
    restart: {
      instruction: continuationInstruction,
      requestIntent: recordedIntent(continuationInstruction, {
        operation: "create",
        targets: [{ path: inputs.continuationPage, quote: inputs.continuationPage }],
        sources: [{ path: inputs.cliSourcePath, quote: inputs.cliSourcePath }],
      }),
      firstPassContradiction: firstPassContradictionRecord([
        {
          obligationId: "public-original-output-shape",
          targetPaths: [inputs.continuationPage],
          condition,
          sides: [
            {
              path: "docs/guide.md",
              lineStart: 1,
              lineEnd: files["docs/guide.md"]!.split("\n").length,
              value: `{"message":"${inputs.exampleMessage}"}`,
            },
            {
              path: "docs/quickstart.md",
              lineStart: 1,
              lineEnd: files["docs/quickstart.md"]!.split("\n").length,
              value: `{"greeting":"${inputs.exampleMessage}"}`,
            },
          ],
        },
      ]),
      freshObligation: { id: "decomposed-public-current-output-shape", condition },
    },
  };
  await writeFile(join(fixtureRoot, "cases.json"), `${JSON.stringify(record, null, 2)}\n`);
  return { inputs, cleanup: () => rm(root, { recursive: true, force: true }) };
}
