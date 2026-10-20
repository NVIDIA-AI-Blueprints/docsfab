// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { cp, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import { buildRuntimeQualityLock } from "../scripts/generate-quality-pack.mjs";
import { QUALITY_RUNTIME_POLICY_ROOT, QUALITY_SOURCE_ROOTS } from "../scripts/derived-products.mjs";
import { executeWorkflowRun } from "../src/cli/run/execution.js";
import { limit } from "../src/config/limits.js";
import { QualityResourceLimitError } from "../src/execution/task-context.js";
import { parseRuntimeQualityLock } from "../src/quality-pack/manifest.js";
import type { RepositoryWorkspace } from "../src/repository/workspace/contracts.js";
import { prepareRepositoryWorkspace } from "../src/repository/workspace/materialize.js";
import { getWorkflow } from "../src/workflow-registry/catalog.js";
import { validModelConfig } from "./helpers.js";
import { initFixtureRepo } from "./helpers/git.js";
import { temporaryRoots } from "./helpers/temp.js";

const runtimeRoot = fileURLToPath(new URL("..", import.meta.url));
const qualitySourceRoot = resolve(runtimeRoot, "../quality");
const roots = temporaryRoots();
const workspaces: RepositoryWorkspace[] = [];

const state = vi.hoisted(() => ({
  /** Replaces the verified pack's quality root and lock when set. */
  quality: undefined as { qualityRoot: string; qualityLock: unknown } | undefined,
  harnesses: 0,
  runs: 0,
  providerRequests: 0,
}));

vi.mock("../src/quality-pack/manifest.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/quality-pack/manifest.js")>();
  return {
    ...actual,
    verifyQualityPackContext: async (
      options: Parameters<typeof actual.verifyQualityPackContext>[0],
    ) => {
      const pack = await actual.verifyQualityPackContext(options);
      return state.quality ? { ...pack, ...state.quality } : pack;
    },
  };
});
vi.mock("../src/harness/pi.js", () => ({
  PiHarness: class {
    constructor() {
      state.harnesses += 1;
    }
  },
}));
vi.mock("../src/workflow-execution/runner.js", () => ({
  WorkflowRunner: class {
    async run(input: { workflow: { name: string } }) {
      state.runs += 1;
      return { workflow: input.workflow.name, status: "failed", steps: [] };
    }
  },
}));

afterEach(async () => {
  state.quality = undefined;
  state.harnesses = 0;
  state.runs = 0;
  state.providerRequests = 0;
  vi.unstubAllGlobals();
  await Promise.all(workspaces.splice(0).map((workspace) => workspace.dispose()));
  await roots.cleanup();
});

/** A quality tree whose product default binds a style guide of the given text. */
async function qualityWithStyleGuide(styleGuide: string) {
  const root = await roots.create("docsfab-style-admission-");
  for (const subtree of [...QUALITY_SOURCE_ROOTS, QUALITY_RUNTIME_POLICY_ROOT]) {
    await cp(resolve(qualitySourceRoot, subtree), join(root, subtree), { recursive: true });
  }
  await mkdir(join(root, "profiles/house-style"), { recursive: true });
  await writeFile(
    join(root, "profiles/house-style/profile.json"),
    '{"id":"house-style","version":"2026-10-05"}\n',
  );
  await writeFile(join(root, "profiles/house-style/style-guide.md"), styleGuide);
  await writeFile(join(root, "profiles/house-style/TERMINOLOGY.md"), "# Terms\n\nwidget\n");
  const declarationPath = join(root, "profiles/product-default.json");
  const declaration = JSON.parse(await readFile(declarationPath, "utf8"));
  declaration.style_profile.bar_id = "profile:house-style";
  await writeFile(declarationPath, `${JSON.stringify(declaration, null, 2)}\n`);
  return {
    qualityRoot: await realpath(root),
    qualityLock: parseRuntimeQualityLock(
      JSON.parse(JSON.stringify(await buildRuntimeQualityLock(root))),
    ),
  };
}

async function runWorkflow(workflowName: "update-documentation" | "review-documentation") {
  const repository = await roots.create("docsfab-style-admission-repo-");
  await initFixtureRepo(repository, {
    "docs/guide.md": "# Guide\n\nDeterministic documentation.\n",
  });
  const workspace = await prepareRepositoryWorkspace(repository, "HEAD");
  workspaces.push(workspace);
  const stateDirectory = join(repository, "runs");
  await mkdir(stateDirectory, { recursive: true });
  const workflow = getWorkflow(workflowName);
  return executeWorkflowRun(
    {
      request: {
        workflow: workflow.name,
        instruction: "Update the guide.",
        verbose: false,
        allowWrite: false,
      } as never,
      config: {
        skillCrateDirectory: join(runtimeRoot, "skill-crate"),
        qualityDirectory: join(runtimeRoot, "quality"),
        qualityPackDirectory: join(runtimeRoot, "quality-pack"),
        stateDirectory,
        model: validModelConfig,
      } as never,
      options: { silent: true },
      output: { log: vi.fn(), error: vi.fn() },
    },
    workspace,
    {} as never,
    { workflow } as never,
    {} as never,
  );
}

describe("style resource admission", () => {
  it.each(["update-documentation", "review-documentation"] as const)(
    "refuses an oversized style resource before %s builds a harness or sends a provider request",
    async (workflowName) => {
      vi.stubGlobal("fetch", async () => {
        state.providerRequests += 1;
        throw new Error("No provider request is expected.");
      });
      const bound = limit("execution.styleResourceMaxBytes");
      state.quality = await qualityWithStyleGuide(`# House style\n\n${"a".repeat(bound.value)}\n`);

      const refusal = await runWorkflow(workflowName).catch((error: unknown) => error);

      expect(refusal).toBeInstanceOf(QualityResourceLimitError);
      expect(refusal).toMatchObject({
        code: "style-resource-max-bytes-bound",
        resourceId: "profile:house-style",
      });
      expect(state).toMatchObject({ harnesses: 0, runs: 0, providerRequests: 0 });
    },
  );

  it.each(["update-documentation", "review-documentation"] as const)(
    "admits the installed style resource and lets %s reach the workflow runner",
    async (workflowName) => {
      await runWorkflow(workflowName);

      expect(state).toMatchObject({ harnesses: 1, runs: 1 });
    },
  );
});
