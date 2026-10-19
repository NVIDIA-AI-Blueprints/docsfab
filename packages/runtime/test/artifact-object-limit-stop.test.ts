// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * An object over `artifacts.maxObjectBytes` stops `docsfab run` while the run
 * admits its editorial evidence, before any model call and before a run record
 * exists (#1932). Splitting the content index into parts cannot help an object
 * that one index entry fills, so the store refuses it by the bound. The printed
 * stop names the code, the observed size, the limit, and the setting to raise;
 * the situation catalog adds the same remediation as the next action and points
 * at the troubleshooting entry, because `docsfab why` has no record to read.
 */
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import { ArtifactStoreError } from "../src/artifacts/store.js";
import { executeRunRequest } from "../src/cli/run-request.js";
import { LIMIT_DEFINITION_BY_NAME } from "../src/config/limits.generated.js";
import type { DocsFabConfig } from "../src/config/runtime-loader.js";
import type {
  AgentHarness,
  HarnessStepInput,
  HarnessStepResult,
} from "../src/execution/contracts.js";
import { DEFAULT_DOCS_ANCHORS, reportOperatorFailure } from "../src/operator/error-envelope.js";
import { SITUATION_CATALOG } from "../src/operator/situation-catalog.js";
import { validModelConfig } from "./helpers.js";
import { git, initFixtureRepo } from "./helpers/git.js";
import { temporaryRoots } from "./helpers/temp.js";

const roots = temporaryRoots();
const runtimeRoot = fileURLToPath(new URL("..", import.meta.url));
const CODE = "artifacts-max-object-bytes-bound";
const LIMIT = LIMIT_DEFINITION_BY_NAME["artifacts.maxObjectBytes"]!;
/** The catalog minimum, so the lowered bound is one a host can set. */
const LOWERED = LIMIT.min;

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  process.exitCode = undefined;
});

/** Records every workflow step; a run that reaches one has passed editorial admission. */
class RecordingHarness implements AgentHarness {
  public readonly steps: string[] = [];

  public async runStep(input: HarnessStepInput): Promise<HarnessStepResult> {
    this.steps.push(input.step.id);
    throw new Error("The test harness stops at the first workflow step.");
  }
}

/**
 * A page whose one index entry is larger than the lowered bound: its document
 * node lists every anchor on the page.
 */
function longReferencePage(): string {
  const sections = Array.from(
    { length: 160 },
    (_, index) => `## Reference entry ${index + 1} for the install options\n\nText.\n`,
  );
  return ["# Install Options", "", ...sections].join("\n");
}

async function runFixture() {
  const repository = await roots.create("docsfab-artifact-object-limit-run-");
  const state = await roots.create("docsfab-artifact-object-limit-state-");
  const head = await initFixtureRepo(
    repository,
    {
      "docs/guide.md": "# Guide\n\n## Install\n\nSteps.\n",
      "docs/options.md": longReferencePage(),
      ".docsfab.json": `${JSON.stringify({
        schemaVersion: 1,
        gitlab: { remote: "origin", defaultBranch: "main" },
        provider: { configuration: "host" },
        storage: { scope: "user-private" },
      })}\n`,
    },
    { branch: "main", message: "reference pages" },
  );
  await git(repository, ["remote", "add", "origin", "ssh://git@gitlab.example.invalid/docs/x.git"]);
  await git(repository, ["update-ref", "refs/remotes/origin/main", head]);
  const config: DocsFabConfig = {
    projectRoot: runtimeRoot,
    skillCrateDirectory: join(runtimeRoot, "skill-crate"),
    qualityDirectory: join(runtimeRoot, "quality"),
    qualityPackDirectory: join(runtimeRoot, "quality-pack"),
    stateDirectory: join(state, "runs"),
    retryPolicy: { maxRetries: 0, baseDelayMs: 0, maxDelayMs: 0, retryableCategories: [] },
    model: validModelConfig,
  };
  const modelRequests: string[] = [];
  vi.stubGlobal("fetch", async (input: string | URL | Request) => {
    modelRequests.push(input instanceof Request ? input.url : String(input));
    throw new Error("The test provider stops at the first model call.");
  });
  const harness = new RecordingHarness();
  let outcome: unknown;
  try {
    outcome = await executeRunRequest(
      {
        workflow: "update-documentation",
        repositoryPath: repository,
        revision: head,
        instruction: "Document the install options on the guide page.",
        allowWrite: true,
        draftMr: false,
        releaseGate: false,
        verbose: false,
        json: false,
        showScan: false,
      },
      config,
      { silent: true, harness },
    );
  } catch (error) {
    outcome = error;
  }
  let records: string[] = [];
  try {
    records = (await readdir(config.stateDirectory)).filter((name) => name.endsWith(".json"));
  } catch {
    records = [];
  }
  return { outcome, modelCalls: modelRequests.length + harness.steps.length, records };
}

describe("docsfab run at artifacts.maxObjectBytes", () => {
  it("stops before any model call and prints the code, the sizes, the setting, and the next action", async () => {
    vi.stubEnv(LIMIT.override!, String(LOWERED));
    const { outcome, modelCalls, records } = await runFixture();
    expect(outcome).toBeInstanceOf(ArtifactStoreError);
    const error = outcome as ArtifactStoreError;
    expect(error.code).toBe(CODE);
    expect(error.limitName).toBe("artifacts.maxObjectBytes");
    expect(error.configured).toBe(LOWERED);
    expect(error.observed).toBeGreaterThan(LOWERED);
    expect(modelCalls).toBe(0);
    expect(records).toEqual([]);

    const printed: string[] = [];
    const envelope = reportOperatorFailure(error, { write: (line) => printed.push(line) });
    const lines = printed.join("\n").split("\n");
    expect(lines[0]).toContain(
      `${CODE}: ${error.observed} exceeds artifacts.maxObjectBytes = ${LOWERED} bytes.`,
    );
    expect(lines[0]).toContain(`Raise ${LIMIT.override}`);
    expect(lines).toContain(`code: ${CODE}`);
    expect(lines).toContain("failure class: bound (layer cli)");
    expect(lines).toContain(`Next action: ${LIMIT.remediation}`);
    expect(lines).toContain("Docs: docs/troubleshooting.md");
    expect(envelope.failure).toMatchObject({ class: "bound", code: CODE });
  }, 180_000);

  it("reaches its first step at the default bound", async () => {
    const { outcome, modelCalls } = await runFixture();
    expect(outcome).not.toBeInstanceOf(ArtifactStoreError);
    expect(modelCalls).toBeGreaterThan(0);
  }, 180_000);

  it("keeps the catalog row's next action equal to the limit's remediation", () => {
    const row = SITUATION_CATALOG.find((candidate) => candidate.id === CODE);
    expect(row).toMatchObject({ failureClass: "bound", inEnvelope: true });
    expect(row?.nextAction).toBe(LIMIT.remediation);
    expect(DEFAULT_DOCS_ANCHORS[CODE]).toBe("docs/troubleshooting.md");
  });
});
