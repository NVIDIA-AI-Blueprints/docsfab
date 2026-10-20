// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** The installed bin over a private compiled package, never shared dist or a source-only catch. */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFile,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { validModelEnvironment } from "./helpers.js";
import { initFixtureRepo } from "./helpers/git.js";
import { temporaryRoots } from "./helpers/temp.js";
import { testTimeoutMs } from "./helpers/test-timeouts.js";

const execute = promisify(execFile);
const runtimeRoot = fileURLToPath(new URL("..", import.meta.url));
const roots = temporaryRoots();
// Same private-build and subprocess journey budgets as doctor-limits-built-cli.
const BUILD_LOCAL_MS = 120_000;
const CLI_LOCAL_MS = 30_000;
let buildRoot: string;
let packageRoot: string;

beforeAll(async () => {
  buildRoot = await mkdtemp(join(tmpdir(), "docsfab-scope-built-"));
  packageRoot = join(buildRoot, "package");
  await mkdir(join(packageRoot, "bin"), { recursive: true });
  await execute(
    process.execPath,
    [join(runtimeRoot, "scripts/build-package.mjs"), "--output-dir", join(packageRoot, "dist")],
    { cwd: runtimeRoot, env: { ...process.env, PI_OFFLINE: "1" } },
  );
  for (const file of ["docsfab.mjs", "source-checkout-refresh.mjs"])
    await copyFile(join(runtimeRoot, "bin", file), join(packageRoot, "bin", file));
  await copyFile(join(runtimeRoot, "package.json"), join(packageRoot, "package.json"));
  for (const directory of [
    "workflows",
    "skill-crate",
    "quality",
    "quality-pack",
    "governed-assets",
  ]) {
    await cp(join(runtimeRoot, directory), join(packageRoot, directory), {
      recursive: true,
      filter: (path) => {
        const parts = relative(runtimeRoot, path).split(sep);
        return !(
          parts.length === 2 &&
          parts[0] === "governed-assets" &&
          parts[1] === "model-comparison"
        );
      },
    });
  }
  await mkdir(join(packageRoot, "model-compositions"));
  for (const file of [
    "adapter-registry.json",
    "candidate-projections.json",
    "composition-registry.json",
    "installed-manifest.json",
    "workflow-catalog.json",
  ])
    await copyFile(
      join(runtimeRoot, "model-compositions", file),
      join(packageRoot, "model-compositions", file),
    );
  await symlink(join(runtimeRoot, "node_modules"), join(packageRoot, "node_modules"), "dir");
}, testTimeoutMs(BUILD_LOCAL_MS));

afterAll(async () => {
  if (buildRoot) await rm(buildRoot, { recursive: true, force: true });
});

/** Every fixture file and directory, including Git and outside-repository sentinels. */
async function snapshotTree(root: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  async function visit(directory: string): Promise<void> {
    for (const name of (await readdir(directory)).sort()) {
      const path = join(directory, name);
      const relative = path.slice(root.length + 1);
      const stat = await lstat(path);
      if (stat.isDirectory()) {
        result[relative] = "directory";
        await visit(path);
      } else if (stat.isSymbolicLink()) result[relative] = `symlink:${await readlink(path)}`;
      else
        result[relative] = createHash("sha256")
          .update(await readFile(path))
          .digest("hex");
    }
  }
  await visit(root);
  return result;
}

async function runBuilt(
  workflow: string,
  requestedTarget: string,
  json: boolean,
  proposedPath?: string,
  documentationRoots: readonly string[] = ["docs"],
  extraFiles: Readonly<Record<string, string>> = {},
) {
  const root = await roots.create("docsfab-scope-world-");
  const world = join(root, "world");
  const repository = join(world, "repository");
  const home = join(root, "home");
  const target =
    requestedTarget === "<absolute-sentinel>" ? join(world, "absolute.md") : requestedTarget;
  await mkdir(home);
  await initFixtureRepo(repository, {
    "README.md": "# Product\n",
    "docs/a.md": "# Alpha\n",
    "src/notes.md": "# Source sentinel\n",
    "src/x.md": "# Traversal sentinel\n",
    "site/content/AGENTS.md": "# Protected agent instructions\n",
    ...extraFiles,
    ".docsfab.json": JSON.stringify({
      schemaVersion: 1,
      gitlab: { remote: "origin", defaultBranch: "main" },
      provider: { configuration: "host" },
      storage: { scope: "user-private" },
      documentationRoots,
    }),
  });
  await writeFile(join(world, "outside.md"), "# External sentinel\n");
  await writeFile(join(world, "absolute.md"), "# Absolute external sentinel\n");
  const before = await snapshotTree(world);
  let providerCalls = 0;
  const content = JSON.stringify({
    operation: workflow === "create-documentation" ? "create" : "update",
    targets: proposedPath
      ? [{ path: proposedPath, role: "write", chosenFrom: "named", quote: target }]
      : [],
    authorityPreference: { preference: "unspecified", quote: null },
  });
  const server = createServer((request, response) => {
    providerCalls += 1;
    request.resume();
    response.writeHead(200, { "content-type": "text/event-stream" });
    for (const delta of [{ role: "assistant", content }, {}])
      response.write(
        `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 0, model: "example/model", choices: [{ index: 0, delta, finish_reason: "content" in delta ? null : "stop" }] })}\n\n`,
      );
    response.end("data: [DONE]\n\n");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Fixture listener missing");
  let output: { stdout: string; stderr: string; exitCode: number };
  try {
    try {
      const result = await execute(
        process.execPath,
        [
          join(packageRoot, "bin/docsfab.mjs"),
          "run",
          workflow,
          "--repo",
          repository,
          "--patch-only",
          "--allow-write",
          ...(json ? ["--json"] : []),
          "--instruction",
          `${workflow === "create-documentation" ? "Create" : "Update"} ${target} for developers.`,
        ],
        {
          cwd: home,
          env: {
            PATH: process.env.PATH,
            HOME: home,
            TMPDIR: tmpdir(),
            ...validModelEnvironment,
            MODEL_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
            DOCSFAB_SERVICE_ENV_FILE: join(home, "absent-service.env"),
            DOCSFAB_STATE_DIR: join(home, "runs"),
            DOCSFAB_CONFIG_ROOT: join(home, "config"),
          },
        },
      );
      output = { ...result, exitCode: 0 };
    } catch (error) {
      const failed = error as { code?: unknown; stdout?: string; stderr?: string };
      if (typeof failed.code !== "number") throw error;
      output = { stdout: failed.stdout ?? "", stderr: failed.stderr ?? "", exitCode: failed.code };
    }
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
  expect(await snapshotTree(world)).toEqual(before);
  const runState = await snapshotTree(join(home, "runs")).catch((error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return {};
    throw error;
  });
  return { ...output, providerCalls, target, runState };
}

describe("compiled CLI negative write scope", { timeout: testTimeoutMs(CLI_LOCAL_MS) }, () => {
  describe.each([false, true])("json=%s", (json) => {
    it.each([
      ["create-documentation", "README.md"],
      ["update-documentation", "README.md"],
      ["create-documentation", "src/notes.md"],
      ["update-documentation", "src/notes.md"],
      ["create-documentation", "../outside.md"],
      ["update-documentation", "../outside.md"],
      ["create-documentation", "docs/../src/x.md"],
      ["update-documentation", "docs/../src/x.md"],
      ["create-documentation", "<absolute-sentinel>"],
      ["update-documentation", "<absolute-sentinel>"],
    ])("refuses decisive %s %s before any provider or write", async (workflow, target) => {
      const result = await runBuilt(workflow, target, json);
      expect(result.exitCode).toBe(1);
      expect(result.providerCalls).toBe(0);
      if (target === "README.md") expect(result.runState).toEqual({});
      if (json)
        expect(JSON.parse(result.stderr)).toMatchObject({
          kind: "docsfab-operator-error",
          code: "request-intent-outside-write-scope",
          failure: { class: "planning-refusal", layer: "cli" },
          nextAction: expect.stringContaining("documentationRoots"),
        });
      else {
        expect(result.stderr).toContain("code: request-intent-outside-write-scope");
        expect(result.stderr).toContain("failure class: planning-refusal (layer cli)");
        expect(result.stderr).toContain("Next action:");
      }
      expect(result.stderr).toContain(
        target === "<absolute-sentinel>" ? "absolute.md" : result.target,
      );
      expect(result.stderr).toContain("docs/");
      expect(result.stderr).toContain("documentationRoots");
    });

    it("keeps the protected-page refusal under a documentation root", async () => {
      const result = await runBuilt(
        "update-documentation",
        "site/content/AGENTS.md",
        json,
        undefined,
        ["site/content"],
      );
      expect(result.exitCode).toBe(1);
      expect(result.providerCalls).toBe(0);
      if (json)
        expect(JSON.parse(result.stderr)).toMatchObject({
          code: "proposal-scope-unsafe-target",
          failure: { class: "planning-refusal", layer: "cli" },
        });
      else expect(result.stderr).toContain("code: proposal-scope-unsafe-target");
      expect(result.stderr).toContain("site/content/AGENTS.md");
    });

    it.each([
      ["./docs/AGENTS.md", ["docs"]],
      ["docs/x/../AGENTS.md", ["docs"]],
      ["docs/ＡGENTS.md", ["docs"]],
      ["guides/WARP.md", ["docs"]],
      ["docs/../src/x.md and site/content/AGENTS.md", ["site/content"]],
      ["site/content/AGENTS.md and docs/../src/x.md", ["site/content"]],
      ["./docs/../src/x.md and site/content/AGENTS.md", ["site/content"]],
      ["site/content/AGENTS.md and ./docs/../src/x.md", ["site/content"]],
    ] as const)("keeps the private refusal for %s", async (target, documentationRoots) => {
      const result = await runBuilt(
        "update-documentation",
        target,
        json,
        undefined,
        documentationRoots,
      );
      expect(result.exitCode).toBe(1);
      expect(result.providerCalls).toBe(0);
      expect(result.stdout).toBe("");
      if (json)
        expect(JSON.parse(result.stderr)).toMatchObject({
          code: "proposal-scope-unsafe-target",
          failure: { class: "planning-refusal", layer: "cli" },
        });
      else {
        expect(result.stderr).toContain("code: proposal-scope-unsafe-target");
        expect(result.stderr).toContain("failure class: planning-refusal (layer cli)");
      }
    });

    it("retains normal interpretation for duplicate-basename UPDATE README", async () => {
      const result = await runBuilt(
        "update-documentation",
        "README.md",
        json,
        "README.md",
        ["docs"],
        { "docs/README.md": "# Nested product\n" },
      );
      expect(result.exitCode).toBe(1);
      expect(result.providerCalls).toBe(1);
      expect(Object.keys(result.runState)).not.toHaveLength(0);
      if (json)
        expect(JSON.parse(result.stdout)).toMatchObject({
          kind: "docsfab-run-result",
          execution: { status: "failed", exitCode: 1 },
          failures: [{ code: "request-intent-outside-write-scope" }],
        });
      else expect(result.stdout + result.stderr).toContain("request-intent-outside-write-scope");
    });

    it.each([
      ["file", ["README.md"]],
      ["mixed", ["README.md", "docs"]],
    ] as const)(
      "names exact files in the %s root remediation",
      async (kind, documentationRoots) => {
        const result = await runBuilt(
          "update-documentation",
          "src/notes.md",
          json,
          undefined,
          documentationRoots,
        );
        expect(result.exitCode).toBe(1);
        expect(result.providerCalls).toBe(0);
        const action = json
          ? JSON.parse(result.stderr).nextAction
          : result.stderr.split("\n").find((line) => line.startsWith("Next action:"));
        expect(action).toContain("exact permitted file");
        expect(action).toContain('"README.md"');
        expect(action).not.toContain('inside "README.md"');
        expect(action).toContain("documentationRoots");
        if (kind === "mixed") expect(action).toContain('inside "docs/"');
        expect(result.stderr).toContain("request-intent-outside-write-scope");
      },
    );

    it.each([
      "./../outside.md",
      "./docs/../src/x.md",
      "/.context/.git/outside.md",
      "/AGENTS.md/.git/outside.md",
    ])("keeps an outside host spelling typed: %s", async (target) => {
      const result = await runBuilt("update-documentation", target, json);
      expect(result.exitCode).toBe(1);
      expect(result.providerCalls).toBe(0);
      expect(result.stdout).toBe("");
      if (json)
        expect(JSON.parse(result.stderr)).toMatchObject({
          code: "request-intent-outside-write-scope",
          failure: { class: "planning-refusal", layer: "cli" },
        });
      else expect(result.stderr).toContain("code: request-intent-outside-write-scope");
      expect(result.stderr).toContain(target);
    });

    it("keeps an empty root list as an invalid project configuration", async () => {
      const result = await runBuilt("update-documentation", "src/notes.md", json, undefined, []);
      expect(result.exitCode).toBe(1);
      expect(result.providerCalls).toBe(0);
      expect(result.stderr).toContain("project configuration is invalid");
      expect(result.stderr).not.toContain("inside none");
    });
  });

  it.each(["docs/x.md", "./docs/x.md"])(
    "lets %s reach the interpreter without seeding a target",
    async (target) => {
      const result = await runBuilt("create-documentation", target, true);
      expect(result.exitCode).toBe(2);
      expect(result.providerCalls).toBe(1);
      expect(JSON.parse(result.stdout)).toMatchObject({
        kind: "docsfab-run-result",
        execution: { status: "needs-input", exitCode: 2 },
      });
    },
  );
});
