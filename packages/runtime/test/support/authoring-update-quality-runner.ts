// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { executeRunRequest } from "../../src/cli/run-request.js";
import { verifyQualityPackContext } from "../../src/quality-pack/manifest.js";
import { createReaderTaskContextSupplier } from "../../src/execution/task-context.js";
import { observeReaderTaskContextAdmissionV1 } from "../../src/execution/reader-task-admission.js";
import { validModelConfig } from "../helpers.js";
import { initFixtureRepo, commitFixture, git } from "../helpers/git.js";
import { orbitReaderContextInput } from "../helpers/orbit-option-change-fixture.js";
import { EditorialProtocolHarness } from "../helpers/editorial-protocol-harness.js";
import { authoringFixtureCandidate } from "./authoring-quality-fixture.js";
import type { HarnessStepInput, HarnessStepResult } from "../../src/execution/contracts.js";
import type { InferenceRetryPolicy } from "../../src/execution/contracts.js";

const runtimeRoot = fileURLToPath(new URL("../..", import.meta.url));
/** Real CLI application, admitted reader evidence, writer, patch collector and validators; scripted model replies. */
export async function runAuthoringUpdateQualityProducerFixture(
  root: string,
  candidate: "update" | "no-change" = "update",
  options: {
    declineQuality?: boolean;
    retryPolicy?: InferenceRetryPolicy;
    patchOnly?: boolean;
    json?: boolean;
    silent?: boolean;
    signal?: AbortSignal;
    runStep?: (input: HarnessStepInput, result: HarnessStepResult) => Promise<HarnessStepResult>;
  } = {},
) {
  const sourcePath = join(root, "source"),
    stateDirectory = join(root, "runs");
  const base = await initFixtureRepo(
    sourcePath,
    {
      "docs/cli.md": `# Orbit CLI\n\nThe public option is --${candidate === "update" ? "old" : "new"}.\n`,
      "src/orbit.ts": "export const option = '--old';\n",
    },
    { branch: "main" },
  );
  await writeFile(join(sourcePath, "src/orbit.ts"), "export const option = '--new';\n");
  const head = await commitFixture(sourcePath, "change public option");
  await git(sourcePath, [
    "remote",
    "add",
    "origin",
    "ssh://git@gitlab.example.invalid/docs/orbit.git",
  ]);
  await git(sourcePath, ["update-ref", "refs/remotes/origin/main", head]);
  const config = {
    projectRoot: runtimeRoot,
    stateDirectory,
    skillCrateDirectory: join(runtimeRoot, "skill-crate"),
    qualityDirectory: join(runtimeRoot, "quality"),
    qualityPackDirectory: join(runtimeRoot, "quality-pack"),
    retryPolicy: options.retryPolicy ?? {
      maxRetries: 0,
      baseDelayMs: 0,
      maxDelayMs: 0,
      retryableCategories: [],
    },
    model: validModelConfig,
  };
  const pack = await verifyQualityPackContext(config);
  const supplier = await createReaderTaskContextSupplier(pack);
  const readerContextInput = orbitReaderContextInput();
  const observation = await observeReaderTaskContextAdmissionV1({
    repositoryPath: sourcePath,
    revision: head,
    observationMode: "workflow-export",
    readerContextInput,
    comparisonRequest: { kind: "base-head", baseRevision: base, headRevision: head },
    sourceHints: [{ role: "public-contract", path: "src/orbit.ts" }],
  });
  const publicContract = observation.admission.sources.find(
    (source) => source.role === "public-contract",
  )!;
  const delegate = new EditorialProtocolHarness({
    candidate,
    impactSource: { uri: publicContract.uri, sha256: publicContract.sha256 },
  });
  const profile = JSON.parse(
    await readFile(
      join(pack.qualityRoot, pack.qualityLock.productDefaults.evaluation.assetPath),
      "utf8",
    ),
  );
  const record = await executeRunRequest(
    {
      workflow: "update-documentation",
      repositoryPath: sourcePath,
      revision: head,
      instruction:
        candidate === "update"
          ? "Update docs/cli.md for the changed public option. Keep the result local."
          : "Assess whether docs/cli.md needs an update for the changed public option.",
      readerTaskContext: supplier.createHandoff({
        readerContextInput,
        admission: observation.admission,
        inputOrigin: "explicit",
        sourceBinding: observation.sourceBinding,
      }),
      allowWrite: candidate === "update",
      ...(options.patchOnly ? { patchOnly: true } : {}),
      releaseGate: false,
      verbose: false,
      json: options.json ?? false,
      showScan: false,
    },
    config,
    {
      silent: options.silent ?? true,
      quiet: true,
      ...(options.signal ? { signal: options.signal } : {}),
      harness: {
        runStep: async (input) => {
          const result = await delegate.runStep(input);
          if (input.step.id !== "evaluate-document-quality" || candidate === "no-change")
            return options.runStep ? options.runStep(input, result) : result;
          const answer = authoringFixtureCandidate(profile, head);
          answer.selectionSha256 = input.qualityProfileSelection!.selectionSha256;
          if (options.declineQuality)
            answer.reportMarkdown +=
              "\n\n## Evidence gaps and limitations\n\n- Limitation: Second unavailable evidence.";
          const quality = {
            ...result,
            summary: answer.reportMarkdown,
            qualityArtifactCandidate: answer,
          };
          return options.runStep ? options.runStep(input, quality) : quality;
        },
      },
    },
  );
  if (!record) throw new Error("The real UPDATE fixture returned no run record.");
  return { record, stateDirectory, sourcePath, inputs: delegate.inputs };
}
