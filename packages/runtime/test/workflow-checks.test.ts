// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { constants as fsConstants } from "node:fs";
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as checkSandboxModule from "../src/workflow-execution/check-sandbox.js";
import {
  prepareCheckSandbox,
  CHECK_COMMAND_TIMEOUT_LIMIT,
  CHECK_ISOLATION_UNAVAILABLE,
  CHECK_OUTPUT_RETAINED_LIMIT,
  CheckSandboxPreparationError,
  checkSandboxEnvironment,
  runBoundedCheckCommand,
  type CheckCommandResult,
} from "../src/workflow-execution/check-sandbox.js";
import { limit, limitDefinition } from "../src/config/limits.js";
import { testTimeoutMs } from "./helpers/test-timeouts.js";
import { checkIsolationRefusalMessage } from "../src/workflow-execution/check-isolation-selection.js";
import { DARWIN_DOCKER_DESKTOP_IMAGE } from "../src/delivery/worktree/docker-desktop-backend.js";
import {
  DockerCheckPreparationError,
  prepareDarwinCheckAuthority,
} from "../src/validation/host-containment.js";
import {
  assessRequiredRepositoryChecks,
  checkNotRunCause,
  classifyRepositoryCheckGuidance,
  hostSelectedCheckAuthority,
  makeDryRunSoleCommand,
  makefileDryRunBlocker,
  networkCommand,
  observeCheckedSnapshot,
  requiredRepositoryChecks,
  scriptFirstCommand,
  shellSimpleCommands,
  soleSimpleCommand,
  WorkflowChecksHostOperation,
  type CheckCommandAuthority,
} from "../src/workflow-execution/workflow-checks.js";
import { formatRequiredCheckLimitation } from "../src/workflow-execution/required-check-limitation.js";
import type { StepRunRecord } from "../src/records/contracts.js";
import {
  materializePilotHead,
  PILOT_REQUIRED_CHECK,
  PILOT_CLI,
  requiredCheckInstructions,
  recordingAuthority,
} from "./helpers/documentation-supervision-pilot.js";
import { prepareRepositoryWorkspace } from "../src/repository/workspace/materialize.js";
import { readTrackedRepositoryFile } from "../src/repository/workspace/tracked-read.js";
import type { HarnessStepInput } from "../src/execution/contracts.js";
import { commitFixture, initFixtureRepo } from "./helpers/git.js";
import { decodeTemplateAuditReport } from "../src/templates/audit.js";
import { prepareTemplateSet } from "../src/templates/load.js";
import { createDocumentationPlanBinding } from "../src/workflow-execution/plan-binding.js";

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "docsfab-check-test-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function sandboxOrSkip(root: string, skip: () => void) {
  try {
    const sandbox = await prepareCheckSandbox(root);
    cleanups.push(sandbox.cleanup);
    return sandbox;
  } catch (error) {
    expect(String(error)).toContain(CHECK_ISOLATION_UNAVAILABLE);
    if (process.env.DOCSFAB_REQUIRE_CHECK_ISOLATION === "1") throw error;
    skip();
    return undefined;
  }
}

describe("read-only workflow checks", () => {
  it("executes a real fixture while denying repository writes, credential reads, and network", async (context) => {
    const root = await fixture();
    await writeFile(join(root, "page.md"), "original");
    await writeFile(join(root, ".env"), "fixture-secret");
    const outside = await fixture();
    await writeFile(join(outside, "credential"), "outside-secret");
    const sandbox = await sandboxOrSkip(root, () => context.skip());
    if (!sandbox) return;
    const listener = createServer();
    await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
    cleanups.push(() => new Promise<void>((resolve) => listener.close(() => resolve())));
    const address = listener.address();
    if (!address || typeof address === "string") throw new Error("Fixture listener unavailable.");
    const script = `
      const fs = require('node:fs');
      const net = require('node:net');
      let denied = 0;
      for (const action of [() => fs.writeFileSync('page.md', 'changed'),
        () => fs.readFileSync('.env'), () => fs.readFileSync(${JSON.stringify(join(outside, "credential"))})]) {
        try { action(); } catch { denied++; }
      }
      if (denied !== 3) process.exit(9);
      if (process.env.GITHUB_TOKEN || process.env.NODE_OPTIONS) process.exit(10);
      const socket = net.connect(${address.port}, '127.0.0.1');
      socket.on('error', () => console.log('isolation-proven'));
      socket.on('connect', () => { socket.destroy(); process.exit(11); });
    `;
    const result = await sandbox.run(sandbox.node, ["-e", script]);
    expect(result).toMatchObject({ status: "passed", exitCode: 0 });
    expect(result.output).toContain("isolation-proven");
    expect(await readFile(join(root, "page.md"), "utf8")).toBe("original");
  });

  it("bounds execution time, never stops a check for its output, and preserves a failing exit code", async (context) => {
    const sandbox = await sandboxOrSkip(await fixture(), () => context.skip());
    if (!sandbox) return;
    expect(await sandbox.run(sandbox.node, ["-e", "process.exit(7)"])).toMatchObject({
      status: "failed",
      exitCode: 7,
    });
    expect(
      await sandbox.run(sandbox.node, ["-e", "setInterval(() => {}, 1000)"], { timeoutMs: 200 }),
    ).toMatchObject({ status: "failed", reason: "timeout", timeoutMs: 200 });
    // Output volume keeps the head and tail and never stops the check (#1932).
    const noisy = await sandbox.run(
      sandbox.node,
      ["-e", "process.stdout.write('x'.repeat(10000))"],
      { retainedOutputBytes: 100 },
    );
    expect(noisy).toMatchObject({
      status: "passed",
      exitCode: 0,
      outputBytes: 10_000,
      outputOmittedBytes: 9_900,
    });
    expect(noisy.output).toBe(
      `${"x".repeat(50)}\n[9900 bytes of output omitted]\n${"x".repeat(50)}`,
    );
  });

  it.each(["win32", "darwin"] as const)(
    "fails closed on %s without a bounded process lifetime backend",
    async (platform) => {
      vi.spyOn(process, "platform", "get").mockReturnValue(platform);
      await expect(prepareCheckSandbox(await fixture())).rejects.toThrow(
        CHECK_ISOLATION_UNAVAILABLE,
      );
    },
  );

  it("cannot escape the deadline by detaching a descendant with inherited pipes", async (context) => {
    const root = await fixture();
    const sandbox = await sandboxOrSkip(root, () => context.skip());
    if (!sandbox) return;
    const start = Date.now();
    const result = await sandbox.run(
      sandbox.node,
      [
        "-e",
        `
      const child = require('node:child_process').spawn(process.execPath,
        ['-e', 'setTimeout(() => {}, 1500)'],
        { detached: true, stdio: ['ignore', 1, 2] });
      child.on('error', () => {});
      setInterval(() => {}, 1000);
    `,
      ],
      { timeoutMs: 200 },
    );
    expect(result).toMatchObject({ status: "failed", reason: "timeout" });
    expect(Date.now() - start).toBeLessThan(1500);
  });

  it("runs only repository-owned documentation checks and returns real command evidence without model usage", async (context) => {
    const root = await fixture();
    const sandbox = await sandboxOrSkip(root, () => context.skip());
    if (!sandbox) return;
    await mkdir(join(root, "docs"));
    await writeFile(join(root, "docs", "page.md"), "# Fixture\n");
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({
        scripts: {
          "lint:docs": "node -e \"console.log('native-check-ran')\"",
          lint: 'node -e "process.exit(99)"',
        },
      }),
    );
    await writeFile(join(root, "Makefile"), "fern-check:\n\t@printf 'make-check-ran\\n'\n");
    await initFixtureRepo(root);
    await commitFixture(root);
    const workspace = await prepareRepositoryWorkspace(root, "HEAD");
    cleanups.push(() => workspace.dispose());
    const input = {
      repositoryPath: workspace.path,
      step: {
        id: "lint-documentation",
        title: "Lint",
        skill: "lint-documentation",
        mode: "read-only",
        prompt: "",
      },
      workflow: {
        name: "review-documentation",
        title: "Review",
        outcome: "Review fixture",
        contextPolicy: { schemaVersion: 1, steps: [] },
        steps: [],
      },
    } satisfies HarnessStepInput;
    const result = await new WorkflowChecksHostOperation(workspace).runStep(input);
    expect(result.usage).toMatchObject({ total: 0, turns: 0 });
    const evidence = JSON.parse(result.summary);
    expect(evidence.status, result.summary).toBe("passed");
    expect(evidence.checks).toHaveLength(2);
    expect(result.summary).toContain("native-check-ran");
    expect(result.summary).toContain("make-check-ran");
    expect(evidence.checks.every((check: { status: string }) => check.status === "passed")).toBe(
      true,
    );
  });

  it("binds a checks executor to the revised lint identity", async () => {
    const root = await fixture();
    await writeFile(join(root, "README.md"), "# Fixture\n");
    await initFixtureRepo(root);
    await commitFixture(root);
    const workspace = await prepareRepositoryWorkspace(root, "HEAD");
    cleanups.push(() => workspace.dispose());
    const input = {
      repositoryPath: workspace.path,
      step: {
        id: "lint-revised-documentation",
        title: "Lint revised documentation",
        skill: "lint-documentation",
        mode: "read-only",
        prompt: "",
      },
      workflow: {
        name: "create-documentation",
        title: "Create",
        outcome: "Create fixture",
        contextPolicy: { schemaVersion: 1, steps: [] },
        steps: [],
      },
    } satisfies HarnessStepInput;

    const revised = new WorkflowChecksHostOperation(workspace, "lint-revised-documentation");
    const result = await revised.runStep(input);
    expect(JSON.parse(result.summary)).toMatchObject({ status: "unavailable" });
    await expect(new WorkflowChecksHostOperation(workspace).runStep(input)).rejects.toThrow(
      "bound repository and lint step",
    );
    const ordinaryInput = {
      ...input,
      step: { ...input.step, id: "lint-documentation" },
    } satisfies HarnessStepInput;
    await expect(revised.runStep(ordinaryInput)).rejects.toThrow("bound repository and lint step");
    await expect(
      revised.runStep({ ...input, repositoryPath: join(root, "other") }),
    ).rejects.toThrow("bound repository and lint step");
  });

  it("adds an advisory template report for the plan's candidate pages without changing status", async () => {
    const root = await fixture();
    await mkdir(join(root, "docs"), { recursive: true });
    await writeFile(join(root, "docs", "troubleshooting.md"), "# Troubleshooting Orbit\n");
    await writeFile(join(root, "docs", "orbit.md"), "# Orbit\n");
    await initFixtureRepo(root);
    await commitFixture(root);
    const workspace = await prepareRepositoryWorkspace(root, "HEAD");
    cleanups.push(() => workspace.dispose());
    // Candidate bytes: the troubleshooting page still has no issue section.
    await writeFile(
      join(workspace.path, "docs", "troubleshooting.md"),
      "# Troubleshooting Orbit\n\nThe following issues can occur.\n",
    );
    const planBinding = createDocumentationPlanBinding({
      mode: "update",
      pages: [
        { path: "docs/troubleshooting.md", disposition: "update" },
        { path: "docs/orbit.md", disposition: "update" },
        { path: "docs/retained.md", disposition: "retain" },
      ],
      sourceBindings: [
        { pagePath: "docs/troubleshooting.md", sources: ["src/orbit.ts"] },
        { pagePath: "docs/orbit.md", sources: ["src/orbit.ts"] },
      ],
    });
    const input = {
      repositoryPath: workspace.path,
      step: {
        id: "lint-documentation",
        title: "Lint documentation",
        skill: "lint-documentation",
        mode: "read-only",
        prompt: "",
      },
      workflow: {
        name: "update-documentation",
        title: "Update",
        outcome: "Update fixture",
        contextPolicy: { schemaVersion: 1, steps: [] },
        steps: [],
      },
      planBinding,
    } satisfies HarnessStepInput;

    const plain = JSON.parse(
      (await new WorkflowChecksHostOperation(workspace).runStep(input)).summary,
    );
    expect(plain).not.toHaveProperty("templateConformance");
    const templates = await prepareTemplateSet(resolve(import.meta.dirname, ".."));
    const advised = JSON.parse(
      (
        await new WorkflowChecksHostOperation(workspace, "lint-documentation", {
          templates,
        }).runStep(input)
      ).summary,
    );
    const { templateConformance, ...rest } = advised;
    expect(rest, "the advisory report never changes status or check evidence").toEqual(plain);
    expect(advised.status).toBe("unavailable");
    const report = decodeTemplateAuditReport(templateConformance);
    expect(report.scope.kind).toBe("focused-set");
    expect(report.pages).toEqual([
      { path: "docs/orbit.md", status: "unmapped", reason: "no-template-signal", candidates: [] },
      expect.objectContaining({
        path: "docs/troubleshooting.md",
        status: "failed",
        templateId: "troubleshooting-gfm",
        findings: [
          expect.objectContaining({ rule: "missing-required-heading", expected: "h2:.+" }),
        ],
      }),
    ]);

    // Without a plan, or for a plan whose pages are all absent, no report.
    const { planBinding: _omitted, ...unplanned } = input;
    const checks = new WorkflowChecksHostOperation(workspace, "lint-documentation", { templates });
    expect(JSON.parse((await checks.runStep(unplanned)).summary)).not.toHaveProperty(
      "templateConformance",
    );
    const absent = createDocumentationPlanBinding({
      mode: "update",
      pages: [{ path: "docs/absent.md", disposition: "update" }],
      sourceBindings: [{ pagePath: "docs/absent.md", sources: ["src/orbit.ts"] }],
    });
    expect(
      JSON.parse((await checks.runStep({ ...input, planBinding: absent })).summary),
    ).not.toHaveProperty("templateConformance");
  });
});

describe("repository-required checks before a proposal (#848)", () => {
  async function pilotWorkspace() {
    const { root, repository } = await materializePilotHead();
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const workspace = await prepareRepositoryWorkspace(repository, "HEAD");
    cleanups.push(() => workspace.dispose());
    return workspace;
  }

  function lintInput(repositoryPath: string): HarnessStepInput {
    return {
      repositoryPath,
      step: {
        id: "lint-documentation",
        title: "Check the documentation",
        skill: "lint-documentation",
        mode: "read-only",
        prompt: "",
      },
      workflow: {
        name: "update-documentation",
        title: "Update",
        outcome: "Update fixture",
        contextPolicy: { schemaVersion: 1, steps: [] },
        steps: [],
      },
    };
  }

  /**
   * The pilot head with its instruction replaced, committed before the export.
   * Files under `scripts/`, `tools/`, and `bin/` are executable.
   */
  async function instructionWorkspace(agents: string, files: Record<string, string> = {}) {
    const { root, repository } = await materializePilotHead();
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    await writeFile(join(repository, "AGENTS.md"), agents);
    for (const [path, text] of Object.entries(files)) {
      await mkdir(dirname(join(repository, path)), { recursive: true });
      await writeFile(join(repository, path), text);
      if (/^(?:scripts|tools|bin)\//u.test(path)) await chmod(join(repository, path), 0o755);
    }
    await commitFixture(repository, "instruction under test");
    const workspace = await prepareRepositoryWorkspace(repository, "HEAD");
    cleanups.push(() => workspace.dispose());
    return workspace;
  }

  /** Runs the lint operation, then the gate on its evidence, for one workspace. */
  async function lintAndGate(
    workspace: Awaited<ReturnType<typeof instructionWorkspace>>,
    authority: CheckCommandAuthority,
  ) {
    return lintAndGateWith(workspace, async () => authority);
  }

  /** Runs the lint operation with a prepared authority, then the gate on its evidence. */
  async function lintAndGateWith(
    workspace: Awaited<ReturnType<typeof instructionWorkspace>>,
    prepareAuthority: (repository: string) => Promise<CheckCommandAuthority>,
  ) {
    const baseline = (await observeCheckedSnapshot(workspace.path, { digest: false })).instructions;
    const result = await new WorkflowChecksHostOperation(workspace, "lint-documentation", {
      prepareAuthority,
    }).runStep(lintInput(workspace.path));
    const evidence = JSON.parse(result.summary) as { checks: Array<Record<string, unknown>> };
    const gate = await assessRequiredRepositoryChecks({
      runId: "run-1918",
      workspacePath: workspace.path,
      baselineInstructions: baseline,
      steps: [lintStep(result.summary)],
    });
    return { evidence, gate };
  }

  function lintStep(
    summary: string,
    kind: StepRunRecord["kind"] = "host-operation",
  ): StepRunRecord {
    return {
      id: "lint-documentation",
      title: "Check the documentation",
      kind,
      skill: "lint-documentation",
      mode: "read-only",
      status: "succeeded",
      summary,
    };
  }

  it("derives the declared repository instruction as one required check and ignores unrelated commands", async () => {
    const instructions = await requiredCheckInstructions();
    expect(requiredRepositoryChecks([{ path: "AGENTS.md", text: instructions }])).toEqual([
      {
        command: PILOT_REQUIRED_CHECK,
        directory: ".",
        instruction: "AGENTS.md",
        argv: ["python3", "-m", "unittest", "discover", "-s", "tests"],
      },
    ]);
    expect(
      requiredRepositoryChecks([
        {
          path: "AGENTS.md",
          text: `Run \`python3 -m ${PILOT_CLI.module} ${PILOT_CLI.currentOption} .\` to inspect. Do not run \`make deploy\` before merging. Never execute \`npm run release\` before you open a merge request.\n`,
        },
      ]),
    ).toEqual([]);
    const unsupported = requiredRepositoryChecks([
      {
        path: "AGENTS.md",
        text: "Run `npm test; echo done` before committing. Run `make --file=../outside.mk check` before pushing. Run `bash scripts/check.sh` before proposing a change.\n",
      },
    ]);
    expect(
      unsupported.map((check) => [check.command, check.argv, Boolean(check.unsupported)]),
    ).toEqual([
      ["bash scripts/check.sh", undefined, true],
      ["make --file=../outside.mk check", undefined, true],
      ["npm test; echo done", undefined, true],
    ]);
    const nested = [
      { path: "AGENTS.md", text: "Before proposing a change, run `make docs-check`.\n" },
      {
        path: "packages/api/AGENTS.md",
        text: "Run `npm run test:api` before submitting a change.\n",
      },
    ];
    expect(requiredRepositoryChecks(nested, ["docs/cli.md"]).map((check) => check.command)).toEqual(
      ["make docs-check"],
    );
    expect(
      requiredRepositoryChecks(nested, ["packages/api/docs/usage.md"]).map((check) => [
        check.directory,
        check.command,
      ]),
    ).toEqual([
      [".", "make docs-check"],
      ["packages/api", "npm run test:api"],
    ]);
  });

  it("separates Gym contribution commands from isolated validation candidates", async () => {
    const text =
      "Run `git commit -s`, `pre-commit run --all-files`, and `make docs-check` before proposing a change.\n";
    expect(classifyRepositoryCheckGuidance([{ path: "AGENTS.md", text }])).toMatchObject([
      { command: "git commit -s", classification: "contribution-mutation" },
      { command: "make docs-check", classification: "validation-check" },
      {
        command: "pre-commit run --all-files",
        classification: "validation-check",
        sideEffects: "may-write",
      },
    ]);
    expect(
      requiredRepositoryChecks([{ path: "AGENTS.md", text }]).map((check) => check.command),
    ).toEqual(["make docs-check", "pre-commit run --all-files"]);
    const workspace = await instructionWorkspace(text);
    const authority = recordingAuthority({ status: "passed", exitCode: 0, output: "ok\n" });
    const { evidence, gate } = await lintAndGate(workspace, authority);
    expect(authority.calls.map((call) => call.argv)).toEqual([
      ["docs-check"],
      ["run", "--all-files"],
    ]);
    expect(evidence.checks).toContainEqual(
      expect.objectContaining({
        command: "git commit -s",
        classification: "contribution-mutation",
        status: "not-run",
        instruction: "AGENTS.md",
        reason: expect.stringContaining("Contribution mutation"),
      }),
    );
    expect(evidence.checks).toContainEqual(
      expect.objectContaining({
        command: "pre-commit run --all-files",
        classification: "validation-check",
        sideEffects: "may-write",
        status: "passed",
      }),
    );
    expect(gate).toMatchObject({
      status: "satisfied",
      commands: ["make docs-check", "pre-commit run --all-files"],
    });
  });

  it("reports unavailable pre-commit and unsupported forms without dispatch", async () => {
    const text =
      "Run `pre-commit run --all-files`, `pre-commit run --files docs/a.md`, `pre-commit install`, and `git commit -s` before proposing a change.\n";
    const workspace = await instructionWorkspace(text);
    const authority = recordingAuthority({ status: "passed", exitCode: 0, output: "ok\n" });
    authority.resolve = async (program) =>
      program === "pre-commit" ? undefined : `/fixture/bin/${program}`;
    const { evidence, gate } = await lintAndGate(workspace, authority);
    expect(authority.calls).toEqual([]);
    expect(evidence.checks).toContainEqual(
      expect.objectContaining({
        command: "pre-commit run --all-files",
        classification: "validation-check",
        sideEffects: "may-write",
        status: "unavailable",
        cause: "dependency-unavailable",
        reason: expect.stringContaining("pre-commit executable"),
      }),
    );
    expect(evidence.checks).toContainEqual(
      expect.objectContaining({
        command: "pre-commit run --files docs/a.md",
        classification: "validation-check",
        status: "unavailable",
        cause: "unsupported-check-form",
      }),
    );
    expect(evidence.checks).toContainEqual(
      expect.objectContaining({
        command: "pre-commit install",
        classification: "contribution-mutation",
        status: "not-run",
      }),
    );
    expect(gate).toMatchObject({ status: "limited" });
  });

  it("reports a source-backed missing fern checker before running make", async () => {
    const workspace = await instructionWorkspace("Repository guidance.\n", {
      Makefile: "docs-check:\n\tcd fern && npm run check\n",
      "fern/package.json": JSON.stringify({ scripts: { check: "npx -y fern-api@latest check" } }),
    });
    expect((await readTrackedRepositoryFile(workspace, "Makefile", 1024)).toString()).toContain(
      "&& npm run",
    );
    const calls: string[][] = [];
    const authority: CheckCommandAuthority = {
      resolve: async (program) => `/usr/bin/${program}`,
      resolveExecutable: async () => undefined,
      run: async (_executable, argv) => {
        calls.push([...argv]);
        if (argv[0] === "--dry-run")
          return {
            status: "passed",
            exitCode: 0,
            output: "Makefile:1: target 'docs-check' does not exist\ncd fern && npm run check\n",
          };
        if (argv[0] === "cache") return { status: "passed", exitCode: 0, output: "" };
        throw new Error(`The unavailable checker must not run: ${JSON.stringify(calls)}`);
      },
      cleanup: async () => undefined,
    };
    const result = await new WorkflowChecksHostOperation(workspace, "lint-documentation", {
      prepareAuthority: async () => authority,
    }).runStep(lintInput(workspace.path));
    expect(calls).toEqual([
      ["--dry-run", "--trace", "docs-check"],
      ["cache", "ls", "fern-api@latest"],
    ]);
    expect(JSON.parse(result.summary).checks).toContainEqual(
      expect.objectContaining({
        command: "make docs-check",
        source: "Makefile",
        classification: "validation-check",
        status: "unavailable",
        cause: "dependency-unavailable",
        reason: expect.stringContaining("documentation content was not assessed"),
      }),
    );
  });

  it("does not apply the docs-check offline package probe to another make target", async () => {
    const workspace = await instructionWorkspace("Before proposing a change, run `make lint`.\n", {
      Makefile: "lint:\n\tcd fern && npm run check\n",
      "fern/package.json": JSON.stringify({ scripts: { check: "npx -y fern-api@latest check" } }),
    });
    const calls: string[][] = [];
    const authority: CheckCommandAuthority = {
      resolve: async (program) => `/usr/bin/${program}`,
      resolveExecutable: async () => undefined,
      run: async (_executable, argv) => {
        calls.push([...argv]);
        if (argv[0] === "--dry-run")
          return {
            status: "passed",
            exitCode: 0,
            output: "Makefile:1: target 'lint' does not exist\ncd fern && npm run check\n",
          };
        if (argv[0] === "cache") return { status: "passed", exitCode: 0, output: "" };
        return { status: "passed", exitCode: 0, output: "lint passed\n" };
      },
      cleanup: async () => undefined,
    };
    const result = await new WorkflowChecksHostOperation(workspace, "lint-documentation", {
      prepareAuthority: async () => authority,
    }).runStep(lintInput(workspace.path));
    expect(calls).toHaveLength(2);
    expect(calls[0]).toEqual(["--dry-run", "--trace", "lint"]);
    expect(calls[1]).toContain("lint");
    expect(calls[1]?.[0]).not.toBe("cache");
    expect(JSON.parse(result.summary).checks).toContainEqual(
      expect.objectContaining({ command: "make lint", status: "passed" }),
    );
  });

  it("does not infer a missing npx dependency from a differently named local executable", async () => {
    const workspace = await instructionWorkspace("Repository guidance.\n", {
      Makefile: "docs-check:\n\tcd fern && npm run check\n",
      "fern/package.json": JSON.stringify({ scripts: { check: "npx -y fern-api@latest check" } }),
    });
    await mkdir(join(workspace.path, "fern/node_modules/fern-api"), { recursive: true });
    await writeFile(
      join(workspace.path, "fern/node_modules/fern-api/package.json"),
      JSON.stringify({ name: "fern-api", bin: { fern: "cli.js" } }),
    );
    const calls: string[][] = [];
    const authority: CheckCommandAuthority = {
      resolve: async (program) => `/usr/bin/${program}`,
      resolveExecutable: async () => undefined,
      run: async (_executable, argv) => {
        calls.push([...argv]);
        return argv[0] === "--dry-run"
          ? {
              status: "passed",
              exitCode: 0,
              output: "Makefile:1: target 'docs-check' does not exist\ncd fern && npm run check\n",
            }
          : { status: "passed", exitCode: 0, output: "ok\n" };
      },
      cleanup: async () => undefined,
    };
    const result = await new WorkflowChecksHostOperation(workspace, "lint-documentation", {
      prepareAuthority: async () => authority,
    }).runStep(lintInput(workspace.path));
    expect(calls).toEqual([
      ["--dry-run", "--trace", "docs-check"],
      ["--no-print-directory", "docs-check"],
    ]);
    expect(JSON.parse(result.summary).checks).toContainEqual(
      expect.objectContaining({ command: "make docs-check", status: "passed" }),
    );
  });

  it("dispatches the exact required argv against the tested snapshot and binds the evidence to it", async () => {
    const workspace = await pilotWorkspace();
    const authority = recordingAuthority({ status: "passed", exitCode: 0, output: "OK\n" });
    const result = await new WorkflowChecksHostOperation(workspace, "lint-documentation", {
      prepareAuthority: async () => authority,
    }).runStep(lintInput(workspace.path));
    expect(result.usage).toMatchObject({ total: 0, turns: 0 });
    expect(authority.calls).toEqual([
      {
        executable: "/fixture/bin/python3",
        argv: ["-m", "unittest", "discover", "-s", "tests"],
        cwd: resolve(workspace.path, "."),
      },
    ]);
    const snapshot = await observeCheckedSnapshot(workspace.path);
    const evidence = JSON.parse(result.summary);
    expect(evidence).toMatchObject({
      status: "passed",
      snapshotSha256: snapshot.sha256,
      requiredChecks: [{ command: PILOT_REQUIRED_CHECK, directory: ".", instruction: "AGENTS.md" }],
    });
    expect(evidence.checks).toEqual([
      expect.objectContaining({
        command: PILOT_REQUIRED_CHECK,
        required: true,
        status: "passed",
        exitCode: 0,
      }),
    ]);
    await expect(
      assessRequiredRepositoryChecks({
        runId: "run-848",
        workspacePath: workspace.path,
        baselineInstructions: snapshot.instructions,
        steps: [lintStep(result.summary)],
      }),
    ).resolves.toMatchObject({ status: "satisfied", commands: [PILOT_REQUIRED_CHECK] });
  });

  it(
    "runs a proposed Python documentation change in Docker on macOS and binds both digests",
    async (context) => {
      if (process.platform !== "darwin") {
        context.skip();
        return;
      }
      const workspace = await pilotWorkspace();
      const page = join(workspace.path, "docs", "cli.md");
      await writeFile(page, `${await readFile(page, "utf8")}\nProposed fixture note.\n`);
      await writeFile(join(workspace.path, ".env"), "fixture-hidden-credential");
      const baseline = (await observeCheckedSnapshot(workspace.path, { digest: false }))
        .instructions;
      const result = await new WorkflowChecksHostOperation(workspace).runStep(
        lintInput(workspace.path),
      );
      const evidence = JSON.parse(result.summary);
      if (
        evidence.checks[0]?.isolationRefusal === "darwin-docker-desktop-unavailable" &&
        process.env.DOCSFAB_REQUIRE_CHECK_ISOLATION !== "1"
      ) {
        context.skip();
        return;
      }
      expect(evidence.checks[0], result.summary).toMatchObject({
        command: PILOT_REQUIRED_CHECK,
        required: true,
        status: "passed",
        backendIdentity: "darwin-docker-desktop",
        exitCode: 0,
      });
      expect(evidence.checks[0].presentedViewSha256).toMatch(/^[0-9a-f]{64}$/u);
      expect(evidence.checks[0]).toMatchObject({
        credentialExclusionPolicy: "credential-name-v1",
        credentialExclusionCount: 1,
      });
      expect(evidence.snapshotSha256).toBe((await observeCheckedSnapshot(workspace.path)).sha256);
      await expect(
        assessRequiredRepositoryChecks({
          runId: "run-1446-darwin",
          workspacePath: workspace.path,
          baselineInstructions: baseline,
          steps: [lintStep(result.summary)],
        }),
      ).resolves.toMatchObject({ status: "satisfied", commands: [PILOT_REQUIRED_CHECK] });
    },
    testTimeoutMs(20_000),
  );

  it(
    "holds the issued private workspace through Docker preparation and rejects a fabricated one",
    async (context) => {
      if (process.platform !== "darwin") {
        context.skip();
        return;
      }
      const workspace = await pilotWorkspace();
      await expect(
        prepareDarwinCheckAuthority({ ...workspace }, observeCheckedSnapshot),
      ).rejects.toMatchObject({ stage: "view" });
      let enter!: () => void;
      let resume!: () => void;
      const entered = new Promise<void>((resolve) => (enter = resolve));
      const hold = new Promise<void>((resolve) => (resume = resolve));
      const preparing = prepareDarwinCheckAuthority(workspace, async (path) => {
        enter();
        await hold;
        return observeCheckedSnapshot(path);
      });
      await entered;
      await expect(workspace.dispose()).rejects.toThrow("leased");
      resume();
      let authority: CheckCommandAuthority;
      try {
        authority = await preparing;
      } catch (error) {
        if (
          error instanceof DockerCheckPreparationError &&
          error.stage === "unavailable" &&
          process.env.DOCSFAB_REQUIRE_CHECK_ISOLATION !== "1"
        ) {
          context.skip();
          return;
        }
        throw error;
      }
      await authority.cleanup();
      await workspace.dispose();
    },
    testTimeoutMs(20_000),
  );

  it(
    "refuses a source change after Docker admission before launching a check",
    async (context) => {
      if (process.platform !== "darwin") {
        context.skip();
        return;
      }
      const repository = await fixture();
      await writeFile(join(repository, "page.md"), "before\n");
      await initFixtureRepo(repository);
      await commitFixture(repository);
      const workspace = await prepareRepositoryWorkspace(repository);
      cleanups.push(() => workspace.dispose());
      const root = workspace.path;
      const page = join(root, "page.md");
      let authority: CheckCommandAuthority;
      try {
        authority = await prepareDarwinCheckAuthority(workspace, observeCheckedSnapshot);
      } catch (error) {
        if (
          error instanceof DockerCheckPreparationError &&
          error.stage === "unavailable" &&
          process.env.DOCSFAB_REQUIRE_CHECK_ISOLATION !== "1"
        ) {
          context.skip();
          return;
        }
        throw error;
      }
      try {
        await writeFile(page, "after\n");
        await expect(
          authority.run("/usr/local/bin/node", ["-e", "process.exit(0)"], { cwd: root }),
        ).rejects.toThrow();
      } finally {
        await authority.cleanup();
      }
    },
    testTimeoutMs(limitDefinition("test.ciTimeoutMs").value),
  );

  it(
    "refuses an outward nested symlink during real Docker preparation",
    async (context) => {
      if (process.platform !== "darwin") {
        context.skip();
        return;
      }
      const repository = await fixture();
      const outside = await fixture();
      await writeFile(join(repository, "page.md"), "before\n");
      await writeFile(join(outside, "sentinel"), "outside-secret");
      await initFixtureRepo(repository);
      await commitFixture(repository);
      const workspace = await prepareRepositoryWorkspace(repository);
      cleanups.push(() => workspace.dispose());
      await mkdir(join(workspace.path, "docs"));
      await symlink(join(outside, "sentinel"), join(workspace.path, "docs", "escape"));
      try {
        await prepareDarwinCheckAuthority(workspace, observeCheckedSnapshot);
        throw new Error("The outward symlink must be refused.");
      } catch (error) {
        if (
          error instanceof DockerCheckPreparationError &&
          error.stage === "unavailable" &&
          process.env.DOCSFAB_REQUIRE_CHECK_ISOLATION !== "1"
        ) {
          context.skip();
          return;
        }
        expect(error).toMatchObject({ stage: "view" });
      }
    },
    testTimeoutMs(20_000),
  );

  it(
    "keeps every host Docker call outside preparation and check mounts",
    async (context) => {
      if (process.platform !== "darwin") {
        context.skip();
        return;
      }
      const repository = await fixture();
      await writeFile(join(repository, "page.md"), "fixture\n");
      await initFixtureRepo(repository);
      await commitFixture(repository);
      const workspace = await prepareRepositoryWorkspace(repository);
      cleanups.push(() => workspace.dispose());
      const runner = vi.spyOn(checkSandboxModule, "runBoundedCheckCommand");
      let authority: CheckCommandAuthority;
      try {
        authority = await prepareDarwinCheckAuthority(workspace, observeCheckedSnapshot);
      } catch (error) {
        if (
          error instanceof DockerCheckPreparationError &&
          error.stage === "unavailable" &&
          process.env.DOCSFAB_REQUIRE_CHECK_ISOLATION !== "1"
        ) {
          context.skip();
          return;
        }
        throw error;
      }
      try {
        expect(
          await authority.run("/usr/local/bin/node", ["-e", "console.log('checked')"], {
            cwd: workspace.path,
          }),
        ).toMatchObject({ status: "passed", output: "checked\n" });
        expect(
          await authority.run("/usr/bin/python3", ["-m", "unittest", "-v"], {
            cwd: workspace.path,
          }),
        ).toMatchObject({ status: "passed" });
        const calls = runner.mock.calls.filter(([program]) => program === "docker");
        expect(calls.some(([, argv]) => argv[0] === "run")).toBe(true);
        expect(calls.some(([, argv]) => argv[0] === "rm")).toBe(true);
        expect(calls.some(([, argv]) => argv[0] === "ps")).toBe(true);
        const configRoot = calls[0]?.[2].env?.DOCKER_CONFIG;
        expect(configRoot).toBeTruthy();
        expect((await stat(configRoot!)).mode & 0o077).toBe(0);
        const mounts = calls.flatMap(([, argv]) =>
          argv.flatMap((arg, index) =>
            arg === "--mount" ? [argv[index + 1]!.match(/(?:^|,)source=([^,]+)/u)![1]!] : [],
          ),
        );
        expect(mounts.length).toBeGreaterThan(0);
        for (const [, , options] of calls) {
          expect(options.env?.DOCKER_CONFIG).toBe(configRoot);
          expect(options.env?.HOME).toBe(configRoot);
          expect(options.cwd).toBe(configRoot);
        }
        for (const mount of mounts) {
          expect(configRoot).not.toBe(mount);
          expect(configRoot!.startsWith(`${mount}/`)).toBe(false);
        }
      } finally {
        await authority.cleanup();
      }
    },
    testTimeoutMs(limitDefinition("test.ciTimeoutMs").value),
  );

  it(
    "keeps credentials, host paths, the socket, and network unavailable inside Docker",
    async (context) => {
      if (process.platform !== "darwin") {
        context.skip();
        return;
      }
      const repository = await fixture();
      const outside = await fixture();
      await writeFile(join(repository, "page.md"), "before\n");
      await initFixtureRepo(repository);
      await commitFixture(repository);
      const workspace = await prepareRepositoryWorkspace(repository);
      cleanups.push(() => workspace.dispose());
      const root = workspace.path;
      await writeFile(join(root, ".env"), "fixture-secret");
      await mkdir(join(root, "docs"));
      await writeFile(join(root, "docs", ".npmrc"), "fixture-token");
      await writeFile(join(outside, "credential"), "outside-secret");
      let authority: CheckCommandAuthority;
      try {
        authority = await prepareDarwinCheckAuthority(workspace, observeCheckedSnapshot);
      } catch (error) {
        if (
          error instanceof DockerCheckPreparationError &&
          error.stage === "unavailable" &&
          process.env.DOCSFAB_REQUIRE_CHECK_ISOLATION !== "1"
        ) {
          context.skip();
          return;
        }
        throw error;
      }
      try {
        const script = `const fs=require('node:fs'),net=require('node:net');
      for(const p of ['.env','docs/.npmrc',${JSON.stringify(join(outside, "credential"))}]){
        try{fs.readFileSync(p);process.exit(2)}catch{}
      }
      try{fs.writeFileSync('page.md','changed');process.exit(3)}catch{}
      if(fs.existsSync('/var/run/'+'docker'+'.sock'))process.exit(4);
      const c=net.connect({host:'1.1.1.1',port:443});c.setTimeout(1000);
      c.on('connect',()=>process.exit(5));c.on('timeout',()=>process.exit(6));
      c.on('error',()=>{console.log('contained');process.exit(0)});`;
        const result = await authority.run("/usr/local/bin/node", ["-e", script], { cwd: root });
        expect(result).toMatchObject({ status: "passed", output: "contained\n" });
        expect(await readFile(join(root, "page.md"), "utf8")).toBe("before\n");
      } finally {
        await authority.cleanup();
      }
    },
    testTimeoutMs(limitDefinition("test.ciTimeoutMs").value),
  );

  it(
    "removes a Docker check container and its detached child after cancellation",
    async (context) => {
      if (process.platform !== "darwin") {
        context.skip();
        return;
      }
      const repository = await fixture();
      await writeFile(join(repository, "page.md"), "fixture\n");
      await initFixtureRepo(repository);
      await commitFixture(repository);
      const workspace = await prepareRepositoryWorkspace(repository);
      cleanups.push(() => workspace.dispose());
      const root = workspace.path;
      let authority: CheckCommandAuthority;
      try {
        authority = await prepareDarwinCheckAuthority(workspace, observeCheckedSnapshot);
      } catch (error) {
        if (
          error instanceof DockerCheckPreparationError &&
          error.stage === "unavailable" &&
          process.env.DOCSFAB_REQUIRE_CHECK_ISOLATION !== "1"
        ) {
          context.skip();
          return;
        }
        throw error;
      }
      const signal = new AbortController();
      const markerSignal = new AbortController();
      let running: Promise<CheckCommandResult> | undefined;
      let startup: Promise<void> | undefined;
      let activeObservation: Promise<boolean> | undefined;
      let stopStartup: (() => void) | undefined;
      let observationError: unknown;
      let observationFailed = false;
      let closing = false;
      let cleanup: Promise<void> | undefined;
      const dispose = () => {
        if (!cleanup) {
          closing = true;
          signal.abort();
          markerSignal.abort();
          stopStartup?.();
          cleanup = (async () => {
            await running?.catch(() => undefined);
            await startup?.catch(() => undefined);
            await activeObservation?.catch(() => undefined);
            await authority.cleanup();
          })();
        }
        return cleanup;
      };
      cleanups.push(dispose);
      try {
        let childStarted = false;
        const script = `const {spawn}=require('node:child_process');
        spawn(process.execPath,['-e',"const fs=require('node:fs');fs.writeFileSync('/scratch/child-started-marker','started');setTimeout(()=>fs.writeFileSync('/scratch/detached-marker','leak'),4000)"],{detached:true,stdio:'ignore'}).unref();
        console.log('child-started');setInterval(()=>{},1000);`;
        const originalRunner = checkSandboxModule.runBoundedCheckCommand;
        vi.spyOn(checkSandboxModule, "runBoundedCheckCommand").mockImplementation(
          (program, argv, options) => {
            if (program === "docker" && argv.includes(script)) {
              const mount = argv.find((arg) => arg.includes("target=/scratch"));
              const scratch = mount?.match(/(?:^|,)source=([^,]+)/u)?.[1];
              expect(scratch).toBeTruthy();
              // Docker Desktop bind mounts may not deliver fs.watch notifications.
              let pollingStopped = false;
              stopStartup = () => {
                pollingStopped = true;
              };
              startup = vi
                .waitUntil(
                  async () => {
                    if (pollingStopped) return true;
                    const observation = (async () => {
                      try {
                        const value = await readFile(
                          join(scratch!, "child-started-marker"),
                          "utf8",
                        );
                        if (pollingStopped) return true;
                        if (value !== "started") return false;
                        childStarted = true;
                        pollingStopped = true;
                        signal.abort();
                        return true;
                      } catch (error) {
                        if (pollingStopped) return true;
                        const codeDescriptor =
                          typeof error === "object" && error !== null
                            ? Object.getOwnPropertyDescriptor(error, "code")
                            : undefined;
                        if (
                          codeDescriptor &&
                          "value" in codeDescriptor &&
                          codeDescriptor.value === "ENOENT"
                        ) {
                          return false;
                        }
                        observationError = error;
                        observationFailed = true;
                        pollingStopped = true;
                        signal.abort();
                        return true;
                      }
                    })();
                    activeObservation = observation;
                    try {
                      return await observation;
                    } finally {
                      if (activeObservation === observation) activeObservation = undefined;
                    }
                  },
                  { timeout: testTimeoutMs(limitDefinition("test.ciTimeoutMs").value) },
                )
                .catch(async (error: unknown) => {
                  observationError = error;
                  observationFailed = true;
                  pollingStopped = true;
                  signal.abort();
                  await activeObservation?.catch(() => undefined);
                })
                .then(() => undefined);
            }
            return originalRunner(program, argv, options);
          },
        );
        running = authority.run("/usr/local/bin/node", ["-e", script], {
          cwd: root,
          signal: signal.signal,
        });
        let stopped: CheckCommandResult;
        try {
          stopped = await running;
        } catch (error) {
          stopStartup?.();
          await startup;
          await activeObservation?.catch(() => undefined);
          if (observationFailed) throw observationError;
          throw error;
        }
        stopStartup?.();
        await startup;
        await activeObservation?.catch(() => undefined);
        if (observationFailed) throw observationError;
        expect(stopped).toMatchObject({ status: "unavailable", reason: "cancelled" });
        expect(childStarted).toBe(true);
        await new Promise((resolve) => setTimeout(resolve, 4300));
        if (closing) return;
        running = authority.run(
          "/usr/local/bin/node",
          ["-e", "process.exit(require('node:fs').existsSync('/scratch/detached-marker')?1:0)"],
          { cwd: root, signal: markerSignal.signal },
        );
        const marker = await running;
        expect(marker.status).toBe("passed");
      } finally {
        await dispose();
      }
    },
    testTimeoutMs(limitDefinition("test.ciTimeoutMs").value),
  );

  it("runs the frozen pilot unittest check under the real isolated executor", async (context) => {
    const workspace = await pilotWorkspace();
    const sandbox = await sandboxOrSkip(workspace.path, () => context.skip());
    if (!sandbox) return;
    const python = await Promise.any(
      ["/usr/bin/python3", "/usr/local/bin/python3"].map(async (path) => {
        await access(path);
        return path;
      }),
    ).catch(() => undefined);
    if (!python) {
      context.skip();
      return;
    }
    const result = await new WorkflowChecksHostOperation(workspace).runStep(
      lintInput(workspace.path),
    );
    const evidence = JSON.parse(result.summary);
    expect(evidence.checks[0], result.summary).toMatchObject({
      command: PILOT_REQUIRED_CHECK,
      required: true,
      status: "passed",
      exitCode: 0,
    });
    expect(evidence.checks[0].output).toContain("Ran 2 tests");
  });

  it("records a limitation with the platform remedy when isolated command authority is unavailable", async () => {
    const workspace = await pilotWorkspace();
    const baseline = (await observeCheckedSnapshot(workspace.path, { digest: false })).instructions;
    vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    const cases = [
      {
        // The host selected Docker, but its image or daemon was unavailable.
        operation: new WorkflowChecksHostOperation(workspace, "lint-documentation", {
          prepareAuthority: (repository) =>
            hostSelectedCheckAuthority(repository, {
              platform: "darwin",
              prepareDocker: async () => {
                throw new DockerCheckPreparationError(
                  "The pinned Docker image is unavailable.",
                  "unavailable",
                );
              },
            }),
        }),
        reason: checkIsolationRefusalMessage("darwin-docker-desktop-unavailable", "darwin"),
        isolationRefusal: "darwin-docker-desktop-unavailable",
        remedy: `start Docker Desktop and load the pinned image with 'docker pull ${DARWIN_DOCKER_DESKTOP_IMAGE}', then start a new run on this Mac.`,
      },
      {
        // An injected authority that fails with an untyped error keeps the generic reason.
        operation: new WorkflowChecksHostOperation(workspace, "lint-documentation", {
          prepareAuthority: async () => {
            throw new Error(CHECK_ISOLATION_UNAVAILABLE);
          },
        }),
        reason: CHECK_ISOLATION_UNAVAILABLE,
        isolationRefusal: undefined,
        remedy:
          "to have DocsFab run the check, rerun on a host where the isolated check executor can run the command, for example Linux with working bubblewrap user namespaces and the named tool installed.",
      },
    ];
    for (const { operation, reason, isolationRefusal, remedy } of cases) {
      const result = await operation.runStep(lintInput(workspace.path));
      const evidence = JSON.parse(result.summary);
      expect(evidence.status).toBe("unavailable");
      expect(evidence.checks).toEqual([
        {
          command: PILOT_REQUIRED_CHECK,
          directory: ".",
          instruction: "AGENTS.md",
          classification: "validation-check",
          required: true,
          status: "unavailable",
          reason,
          cause: "isolation-unavailable",
          ...(isolationRefusal ? { isolationRefusal } : {}),
        },
      ]);
      const gate = await assessRequiredRepositoryChecks({
        runId: "run-848",
        workspacePath: workspace.path,
        baselineInstructions: baseline,
        steps: [lintStep(result.summary)],
      });
      expect(gate).toEqual({
        status: "limited",
        snapshotSha256: (await observeCheckedSnapshot(workspace.path)).sha256,
        commands: [PILOT_REQUIRED_CHECK],
        limitations: [
          {
            command: PILOT_REQUIRED_CHECK,
            directory: ".",
            instruction: "AGENTS.md",
            cause: "isolation-unavailable",
            remedy,
          },
        ],
      });
      const line =
        gate.status === "limited" ? formatRequiredCheckLimitation(gate.limitations[0]!) : "";
      expect(line).toBe(
        `required check could not run: \`${PILOT_REQUIRED_CHECK}\` (no check isolation on this host). Next action: run this command from the repository root, as \`AGENTS.md\` requires, before you merge this change. Platform remedy: ${remedy}`,
      );
      if (isolationRefusal) expect(line).toContain("Docker Desktop");
      else expect(line).not.toMatch(/docker/iu);
    }
  });

  it("launches nothing when Docker is unavailable, and prepares Linux bubblewrap", async () => {
    const workspace = await pilotWorkspace();
    const baseline = (await observeCheckedSnapshot(workspace.path, { digest: false })).instructions;
    const before = (await observeCheckedSnapshot(workspace.path)).sha256;
    const launched: string[] = [];
    const cleaned: string[] = [];
    const resolvedInSandbox: string[][] = [];
    const prepareSandbox = vi.fn(async (repository: string) => ({
      run: async (command: string): Promise<CheckCommandResult> => {
        launched.push(command);
        return { status: "passed", exitCode: 0, output: "OK\n" };
      },
      // The in-sandbox pre-flight resolution (#1918) answers before any check runs.
      resolveExecutable: async (candidates: readonly string[]) => {
        resolvedInSandbox.push([...candidates]);
        return candidates[0];
      },
      searchPath: ["/usr/bin"],
      gitMetadata: true,
      cleanup: async () => {
        cleaned.push(repository);
      },
      node: process.execPath,
      runtime: "/fixture-runtime",
    }));
    const prepareDocker = vi.fn(async () => {
      throw new DockerCheckPreparationError(
        "The pinned Docker image is unavailable.",
        "unavailable",
      );
    });
    const operation = (platform: NodeJS.Platform) =>
      new WorkflowChecksHostOperation(workspace, "lint-documentation", {
        prepareAuthority: (repository) =>
          hostSelectedCheckAuthority(repository, { platform, prepareSandbox, prepareDocker }),
      });

    const refusedRun = await operation("darwin").runStep(lintInput(workspace.path));
    expect(prepareSandbox).toHaveBeenCalledTimes(0);
    expect(launched).toEqual([]);
    const gate = await assessRequiredRepositoryChecks({
      runId: "run-1446",
      workspacePath: workspace.path,
      baselineInstructions: baseline,
      steps: [lintStep(refusedRun.summary)],
    });
    // The check did not run, so the write stands with a limitation (#1918).
    expect(gate).toMatchObject({
      status: "limited",
      limitations: [{ command: PILOT_REQUIRED_CHECK, cause: "isolation-unavailable" }],
    });
    // The candidate tree is retained for inspection, not reverted.
    expect((await observeCheckedSnapshot(workspace.path)).sha256).toBe(before);

    // Positive control through the same call: Linux selects bubblewrap and prepares it once.
    await operation("linux").runStep(lintInput(workspace.path));
    expect(prepareSandbox).toHaveBeenCalledTimes(1);
    // The program resolved inside the sandbox before it ran.
    expect(resolvedInSandbox).toEqual([["/usr/bin/python3", "/usr/local/bin/python3"]]);
    expect(launched).toEqual(["/usr/bin/python3"]);
    expect(prepareSandbox).toHaveBeenCalledWith(workspace.path);
    expect(cleaned).toEqual([workspace.path]);
  });

  it("names neither macOS nor Docker Desktop when a platform has no host backend", async () => {
    const workspace = await pilotWorkspace();
    const baseline = (await observeCheckedSnapshot(workspace.path, { digest: false })).instructions;
    const prepareSandbox = vi.fn(prepareCheckSandbox);
    const result = await new WorkflowChecksHostOperation(workspace, "lint-documentation", {
      prepareAuthority: (repository) =>
        hostSelectedCheckAuthority(repository, { platform: "win32", prepareSandbox }),
    }).runStep(lintInput(workspace.path));
    expect(prepareSandbox).toHaveBeenCalledTimes(0);
    const [entry] = JSON.parse(result.summary).checks;
    expect(entry).toMatchObject({
      status: "unavailable",
      isolationRefusal: "platform-unsupported",
    });
    expect(entry.reason).toContain("(win32)");
    const gate = await assessRequiredRepositoryChecks({
      runId: "run-1446",
      workspacePath: workspace.path,
      baselineInstructions: baseline,
      steps: [lintStep(result.summary)],
    });
    expect(gate.status).toBe("limited");
    const message =
      gate.status === "limited"
        ? gate.limitations.map(formatRequiredCheckLimitation).join(" ")
        : "";
    expect(message).toContain("this platform has no required-check isolation backend");
    expect(message).not.toMatch(/docker|macos/iu);
  });

  it("records only typed isolation refusals, never an unrelated preparation error", async () => {
    const workspace = await pilotWorkspace();
    const result = await new WorkflowChecksHostOperation(workspace, "lint-documentation", {
      prepareAuthority: async () => {
        throw new TypeError("Cannot read /private/host-only/credential-path of undefined.");
      },
    }).runStep(lintInput(workspace.path));
    const [entry] = JSON.parse(result.summary).checks;
    expect(entry).toMatchObject({ status: "unavailable", reason: CHECK_ISOLATION_UNAVAILABLE });
    expect(entry).not.toHaveProperty("isolationRefusal");
    expect(result.summary).not.toContain("credential-path");
  });

  it("maps only sandbox establishment failures to a Linux isolation refusal", async () => {
    const root = await fixture();
    const failing = (error: Error) =>
      hostSelectedCheckAuthority(root, {
        platform: "linux",
        prepareSandbox: async () => {
          throw error;
        },
      });
    await expect(
      failing(new CheckSandboxPreparationError("bubblewrap-unavailable")),
    ).rejects.toMatchObject({
      name: "CheckIsolationUnavailableError",
      refusal: "linux-bubblewrap-unavailable",
      message: CHECK_ISOLATION_UNAVAILABLE,
    });
    // Adjacent condition: bubblewrap was present but host preparation failed.
    await expect(
      failing(new CheckSandboxPreparationError("host-preparation")),
    ).rejects.toMatchObject({
      name: "CheckIsolationUnavailableError",
      refusal: "linux-check-preparation-failed",
      message: checkIsolationRefusalMessage("linux-check-preparation-failed", "linux"),
    });
    // Adjacent condition: an untyped error names no bubblewrap cause and leaks no text.
    const untyped = await failing(new Error("bwrap: setting up uid map: Permission denied")).catch(
      (error: unknown) => error,
    );
    expect(untyped).toBeInstanceOf(Error);
    expect(untyped).not.toHaveProperty("refusal");
    expect(untyped).toMatchObject({ message: CHECK_ISOLATION_UNAVAILABLE });
    // Adjacent condition: a check that fails after the sandbox exists is not an isolation refusal.
    const authority = await hostSelectedCheckAuthority(root, {
      platform: "linux",
      prepareSandbox: async () => ({
        run: async () => {
          throw new RangeError("Check runner defect after establishment.");
        },
        resolveExecutable: async () => undefined,
        searchPath: [],
        gitMetadata: true,
        cleanup: async () => undefined,
        node: process.execPath,
        runtime: "/fixture-runtime",
      }),
    });
    await expect(authority.run("/usr/bin/true", [], { cwd: root })).rejects.toThrow(
      "Check runner defect after establishment.",
    );
  });

  it("keeps the instruction-level refusal free of an isolation remedy", async () => {
    const workspace = await pilotWorkspace();
    const snapshot = await observeCheckedSnapshot(workspace.path);
    const gate = await assessRequiredRepositoryChecks({
      runId: "run-1446",
      workspacePath: workspace.path,
      baselineInstructions: snapshot.instructions,
      steps: [
        lintStep(
          JSON.stringify({
            snapshotSha256: snapshot.sha256,
            checks: [
              {
                status: "unavailable",
                required: true,
                reason: "Repository instructions differ from the admitted revision (AGENTS.md).",
                isolationRefusal: "darwin-docker-desktop-unavailable",
              },
            ],
          }),
        ),
      ],
    });
    // A candidate-edited instruction still refuses: its commands may be model
    // text, so none is offered to the operator as a limitation.
    expect(gate).toMatchObject({ status: "refused", code: "required-check-instructions-altered" });
    const message = gate.status === "refused" ? gate.message : "";
    expect(message).toContain(
      "Next action: keep repository instruction files out of this change, or edit them in a separate change, then start a new run.",
    );
    expect(message).not.toMatch(/bubblewrap|macos/iu);
  });

  it("refuses failed, stale, substituted, and model-stated check evidence", async () => {
    const workspace = await pilotWorkspace();
    const baseline = (await observeCheckedSnapshot(workspace.path, { digest: false })).instructions;
    const gate = (
      steps: StepRunRecord[],
      baselineInstructions: typeof baseline | null = baseline,
    ) =>
      assessRequiredRepositoryChecks({
        runId: "run-848",
        workspacePath: workspace.path,
        baselineInstructions: baselineInstructions ?? undefined,
        steps,
      });
    const run = (outcome: { status: "passed" | "failed"; exitCode: number; output: string }) =>
      new WorkflowChecksHostOperation(workspace, "lint-documentation", {
        prepareAuthority: async () => recordingAuthority(outcome),
      }).runStep(lintInput(workspace.path));

    const failed = await run({ status: "failed", exitCode: 1, output: "FAILED (failures=1)\n" });
    await expect(gate([lintStep(failed.summary)])).resolves.toMatchObject({
      status: "refused",
      code: "required-check-failed",
    });
    const passed = await run({ status: "passed", exitCode: 0, output: "OK\n" });
    const snapshotSha256 = (await observeCheckedSnapshot(workspace.path)).sha256!;
    await expect(gate([lintStep(passed.summary)])).resolves.toMatchObject({ status: "satisfied" });
    await expect(gate([lintStep(passed.summary)], null)).resolves.toMatchObject({
      code: "required-check-snapshot-unavailable",
    });
    // A model statement, or a plain-text host summary, is never execution evidence.
    await expect(
      gate([lintStep(`${PILOT_REQUIRED_CHECK} passed`, "inference")]),
    ).resolves.toMatchObject({ code: "required-check-evidence-missing" });
    await expect(gate([lintStep("Fixture native checks passed")])).resolves.toMatchObject({
      code: "required-check-evidence-missing",
    });
    // Substituted evidence that omits the required check, or binds another tree.
    await expect(
      gate([
        lintStep(
          JSON.stringify({
            status: "passed",
            snapshotSha256,
            checks: [{ command: "npm run lint:docs", directory: ".", status: "passed" }],
          }),
        ),
      ]),
    ).resolves.toMatchObject({ code: "required-check-evidence-missing" });
    await expect(
      gate([
        lintStep(JSON.stringify({ ...JSON.parse(passed.summary), snapshotSha256: "0".repeat(64) })),
      ]),
    ).resolves.toMatchObject({ code: "required-check-evidence-stale" });
    // Genuine evidence goes stale when the proposed tree changes after the checks ran.
    await writeFile(
      join(workspace.path, "docs", "cli.md"),
      `# ${PILOT_CLI.title}\n\nChanged after checks.\n`,
    );
    await expect(gate([lintStep(passed.summary)])).resolves.toMatchObject({
      status: "refused",
      code: "required-check-evidence-stale",
    });
  });

  it("keeps a candidate from removing the instruction that governs its own proposal", async () => {
    const workspace = await pilotWorkspace();
    const baseline = (await observeCheckedSnapshot(workspace.path, { digest: false })).instructions;
    await writeFile(
      join(workspace.path, "AGENTS.md"),
      `This fixture describes the ${PILOT_CLI.title}.\n`,
    );
    const authority = recordingAuthority({ status: "passed", exitCode: 0, output: "" });
    const result = await new WorkflowChecksHostOperation(workspace, "lint-documentation", {
      prepareAuthority: async () => authority,
    }).runStep(lintInput(workspace.path));
    expect(authority.calls).toEqual([]);
    expect(JSON.parse(result.summary).checks).toEqual([
      expect.objectContaining({
        required: true,
        status: "unavailable",
        reason: expect.stringContaining("AGENTS.md"),
      }),
    ]);
    await expect(
      assessRequiredRepositoryChecks({
        runId: "run-848",
        workspacePath: workspace.path,
        baselineInstructions: baseline,
        steps: [lintStep(result.summary)],
      }),
    ).resolves.toMatchObject({ status: "refused", code: "required-check-instructions-altered" });
  });

  it("records an unsupported check form as a limitation, runs nothing for it, and names no other host (#1918)", async () => {
    const forms = ["mise run pre-commit", "uv run pre-commit run --all-files", "ruff format ."];
    expect(
      requiredRepositoryChecks([
        {
          path: "AGENTS.md",
          text: forms.map((form) => `Run \`${form}\` before you commit.`).join("\n\n"),
        },
      ]).map((check) => [check.command, check.argv, check.unsupported?.split(".")[0]]),
    ).toEqual([
      ["mise run pre-commit", undefined, "Unsupported check form"],
      ["ruff format .", undefined, "Unsupported check form"],
      ["uv run pre-commit run --all-files", undefined, "Unsupported check form"],
    ]);
    const workspace = await instructionWorkspace(
      `Run \`${PILOT_REQUIRED_CHECK}\` and \`ruff format .\` before proposing a documentation change.\n`,
    );
    const authority = recordingAuthority({ status: "passed", exitCode: 0, output: "OK\n" });
    const { evidence, gate } = await lintAndGate(workspace, authority);
    // Only the supported form ran; the unsupported one never reached the executor.
    expect(authority.calls.map((call) => call.argv)).toEqual([
      ["-m", "unittest", "discover", "-s", "tests"],
    ]);
    expect(evidence.checks).toContainEqual(
      expect.objectContaining({
        command: "ruff format .",
        status: "unavailable",
        cause: "unsupported-check-form",
        reason: expect.stringMatching(/^Unsupported check form\. /u),
      }),
    );
    expect(gate).toMatchObject({
      status: "limited",
      commands: [PILOT_REQUIRED_CHECK, "ruff format ."],
      limitations: [
        {
          command: "ruff format .",
          directory: ".",
          instruction: "AGENTS.md",
          cause: "unsupported-check-form",
        },
      ],
    });
    const line =
      gate.status === "limited" ? formatRequiredCheckLimitation(gate.limitations[0]!) : "";
    expect(line).toBe(
      "required check could not run: `ruff format .` (unsupported check form). Next action: run this command from the repository root, as `AGENTS.md` requires, before you merge this change.",
    );
    expect(line).not.toMatch(/linux|bubblewrap|rerun|remedy/iu);
  });

  it.each([
    {
      name: "a program the executor cannot resolve",
      authority: (): CheckCommandAuthority => ({
        ...recordingAuthority({ status: "passed", exitCode: 0, output: "" }),
        resolve: async () => undefined,
      }),
      cause: "dependency-unavailable",
      phrase: "dependency unavailable",
    },
    {
      name: "a command the executor could not launch",
      authority: () => ({
        ...recordingAuthority({ status: "passed", exitCode: 0, output: "" }),
        run: async () => ({
          status: "unavailable" as const,
          exitCode: null,
          output: "",
          reason: "launch-failed" as const,
        }),
      }),
      cause: "launch-failed",
      phrase: "the check executor could not start the command",
    },
  ])(
    "records $name as a could-not-run limitation, not a failure (#1918)",
    async ({ authority, cause, phrase }) => {
      const workspace = await instructionWorkspace(
        "Before proposing a change, run `make docs-check`.\n",
        { Makefile: "docs-check:\n\tgit ls-files >/dev/null\n" },
      );
      const { evidence, gate } = await lintAndGate(workspace, authority());
      expect(evidence.checks).toContainEqual(
        expect.objectContaining({
          command: "make docs-check",
          required: true,
          status: "unavailable",
          cause,
        }),
      );
      expect(gate).toMatchObject({
        status: "limited",
        limitations: [
          { command: "make docs-check", directory: ".", instruction: "AGENTS.md", cause },
        ],
      });
      const line =
        gate.status === "limited" ? formatRequiredCheckLimitation(gate.limitations[0]!) : "";
      expect(line).toBe(
        `required check could not run: \`make docs-check\` (${phrase}). Next action: run this command from the repository root, as \`AGENTS.md\` requires, before you merge this change.`,
      );
    },
  );

  it.each([
    {
      name: "a nonzero exit",
      outcome: { status: "failed" as const, exitCode: 1, output: "FAILED (failures=1)\n" },
    },
    {
      name: "a documentation lint error",
      outcome: {
        status: "failed" as const,
        exitCode: 2,
        output:
          "docs/cli.md:1 MD041/first-line-heading First line in a file should be a top-level heading\nmake: *** [Makefile:2: docs-check] Error 1\n",
      },
    },
  ])(
    "keeps a check that ran and failed with $name a refusal, beside one that could not run (#1918)",
    async ({ outcome }) => {
      const workspace = await instructionWorkspace(
        `Run \`${PILOT_REQUIRED_CHECK}\` and \`ruff format .\` before proposing a documentation change.\n`,
      );
      const authority: CheckCommandAuthority = {
        ...recordingAuthority(outcome),
        run: async () => ({ ...outcome }),
      };
      const { gate } = await lintAndGate(workspace, authority);
      expect(gate).toMatchObject({ status: "refused", code: "required-check-failed" });
      const message = gate.status === "refused" ? gate.message : "";
      expect(message).toContain(
        `\`${PILOT_REQUIRED_CHECK}\` (AGENTS.md, run from .) failed on the proposed change`,
      );
      expect(message).not.toContain("ruff format .");
    },
  );

  /** Every phrase the earlier output classifier matched; none may make a failure a limitation. */
  const TRIGGER_OUTPUTS = [
    [
      "command not found",
      'docs/troubleshooting.md:12 MD026 [Context: "bash: docsfab: command not found"]\n',
      1,
    ],
    [
      "a line ending in not found",
      'ERROR [en] REF_NOT_FOUND: Ref "missing.md": "docs/a.md:5:12": page not found\n',
      1,
    ],
    [
      "No module named",
      "FAILED docs/test_examples.py::test_quickstart\nSKIPPED [1] docs/test_gpu.py:3: No module named 'cupy'\n",
      1,
    ],
    ["MODULE_NOT_FOUND", "Error: Cannot find module './plugin'\n  code: 'MODULE_NOT_FOUND'\n", 1],
    ["ERR_MODULE_NOT_FOUND", "code: 'ERR_MODULE_NOT_FOUND'\n", 1],
    ["Cannot find package", "Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'remark'\n", 1],
    [
      "make Error 127",
      "/bin/sh: ./scripts/build-docs.sh: No such file or directory\nmake: *** [Makefile:2: docs-check] Error 127\n",
      2,
    ],
    ["exit 127", "", 127],
    [
      "not a git repository",
      "fatal: not a git repository (or any of the parent directories): .git\n",
      128,
    ],
    [
      "Temporary failure in name resolution",
      "dns error: Temporary failure in name resolution\n",
      2,
    ],
    ["Could not resolve host", "curl: (6) Could not resolve host: example.com\n", 6],
    ["Name or service not known", "socket.gaierror: [Errno -2] Name or service not known\n", 1],
    [
      "nodename nor servname provided",
      "getaddrinfo: nodename nor servname provided, or not known\n",
      1,
    ],
    ["getaddrinfo", "./missing.md: file does not exist\ngetaddrinfo ENOTFOUND example.com\n", 1],
    ["Network is unreachable", "OSError: [Errno 101] Network is unreachable\n", 1],
    ["ENETUNREACH", "connect ENETUNREACH 93.184.216.34:443\n", 1],
    ["EAI_AGAIN", "getaddrinfo EAI_AGAIN registry.npmjs.org\n", 1],
    ["ENOTCACHED", "npm error code ENOTCACHED\n", 1],
  ] as const;

  it.each(TRIGGER_OUTPUTS)(
    "refuses a check that ran and failed even when its output reads %s (#1918)",
    async (_name, output, exitCode) => {
      const workspace = await pilotWorkspace();
      const { evidence, gate } = await lintAndGate(
        workspace,
        recordingAuthority({ status: "failed", exitCode, output }),
      );
      expect(evidence.checks).toContainEqual(
        expect.objectContaining({ command: PILOT_REQUIRED_CHECK, status: "failed" }),
      );
      expect(evidence.checks.some((check) => "cause" in check)).toBe(false);
      expect(gate).toMatchObject({ status: "refused", code: "required-check-failed" });
    },
  );

  it.each([
    [
      "an echoed candidate line that reads command not found",
      "process.stdout.write('docs/troubleshooting.md:12 MD026 [Context: \"bash: docsfab: command not found\"]\\n'); process.exit(1)",
    ],
    [
      "a broken reference that ends in not found",
      "process.stdout.write('ERROR [en] REF_NOT_FOUND: Ref \"missing.md\": page not found\\n'); process.exit(1)",
    ],
    [
      "a real failure beside an unrelated No module named line",
      "process.stdout.write('FAILED docs/test_examples.py::test_quickstart\\nSKIPPED [1] docs/test_gpu.py:3: No module named cupy\\n'); process.exit(1)",
    ],
  ])("refuses a real process that ran and failed with %s (#1918)", async (_name, script) => {
    const workspace = await pilotWorkspace();
    const scratch = await fixture();
    // A real process through the real bounded executor; only the program differs.
    const real: CheckCommandAuthority = {
      resolve: async () => process.execPath,
      run: (executable, _argv, options) =>
        runBoundedCheckCommand(executable, ["-e", script], {
          cwd: options.cwd,
          env: checkSandboxEnvironment(process.execPath, scratch),
          timeoutMs: limit(CHECK_COMMAND_TIMEOUT_LIMIT).value,
          retainedOutputBytes: limit(CHECK_OUTPUT_RETAINED_LIMIT).value,
        }),
      cleanup: async () => undefined,
    };
    const { gate } = await lintAndGate(workspace, real);
    expect(gate).toMatchObject({ status: "refused", code: "required-check-failed" });
  });

  it("decides could-not-run from the executor's structural result, never from output (#1918)", () => {
    for (const [, output, exitCode] of TRIGGER_OUTPUTS) {
      expect(checkNotRunCause({ status: "failed", exitCode, output }), output).toBeUndefined();
    }
    expect(
      checkNotRunCause({ status: "passed", exitCode: 0, output: "not a git repository" }),
    ).toBeUndefined();
    // A check stopped at its time limit did not complete, whatever it printed (#1932).
    expect(
      checkNotRunCause({ status: "failed", exitCode: null, output: "", reason: "timeout" }),
    ).toBe("timeout");
    expect(
      checkNotRunCause({
        status: "failed",
        exitCode: null,
        output: "fatal: not a git repository\n",
        reason: "timeout",
      }),
    ).toBe("timeout");
    expect(
      checkNotRunCause({ status: "unavailable", exitCode: null, output: "", reason: "cancelled" }),
    ).toBe("cancelled");
    expect(
      checkNotRunCause({
        status: "unavailable",
        exitCode: null,
        output: "",
        reason: "launch-failed",
      }),
    ).toBe("launch-failed");
  });

  /** A recording authority whose pre-flight resolves against the real file system. */
  function preflightAuthority(
    outcome: Pick<CheckCommandResult, "status" | "exitCode" | "output">,
    searchPath: readonly string[] = [],
  ) {
    const resolved: string[][] = [];
    return {
      ...recordingAuthority(outcome),
      searchPath,
      resolved,
      resolveExecutable: async (candidates: readonly string[]) => {
        resolved.push([...candidates]);
        for (const candidate of candidates) {
          try {
            if ((await stat(candidate)).isFile()) {
              await access(candidate, fsConstants.X_OK);
              return candidate;
            }
          } catch {
            /* The next candidate. */
          }
        }
        return undefined;
      },
    };
  }

  const NPM_DOCS_LINT = `This fixture describes only the fictional ${PILOT_CLI.title}. Run \`npm run docs:lint\` before proposing a documentation change.\n`;

  it("records dependency-unavailable when the program an npm script starts is not installed (#1918)", async () => {
    const workspace = await instructionWorkspace(NPM_DOCS_LINT, {
      "package.json": JSON.stringify({ scripts: { "docs:lint": "markdownlint docs" } }),
    });
    const authority = preflightAuthority({ status: "passed", exitCode: 0, output: "" });
    const { evidence, gate } = await lintAndGate(workspace, authority);
    // Nothing ran: the pre-flight found no markdownlint before running npm.
    expect(authority.calls).toEqual([]);
    expect(authority.resolved).toEqual([
      [join(workspace.path, "node_modules", ".bin", "markdownlint")],
    ]);
    expect(evidence.checks).toContainEqual(
      expect.objectContaining({
        command: "npm run docs:lint",
        status: "unavailable",
        cause: "dependency-unavailable",
        reason: expect.stringContaining(
          "The `markdownlint` program that `npm run docs:lint` starts",
        ),
      }),
    );
    expect(gate).toMatchObject({
      status: "limited",
      limitations: [{ command: "npm run docs:lint", cause: "dependency-unavailable" }],
    });
    // Positive control: once the program is installed, the check runs.
    await mkdir(join(workspace.path, "node_modules", ".bin"), { recursive: true });
    await writeFile(join(workspace.path, "node_modules", ".bin", "markdownlint"), "#!/bin/sh\n", {
      mode: 0o755,
    });
    const installed = preflightAuthority({ status: "passed", exitCode: 0, output: "OK\n" });
    const ran = await lintAndGate(workspace, installed);
    expect(installed.calls.map((call) => call.argv)).toEqual([["run", "docs:lint"]]);
    expect(ran.gate).toMatchObject({ status: "satisfied" });
  });

  it.each([
    ["a shell builtin first", "cd docs && markdownlint ."],
    ["a quoted program", '"markdownlint" docs'],
    ["a repository script", "./scripts/lint-docs.sh"],
    ["an option after npx", "npx --yes markdownlint docs"],
  ])(
    "runs an npm script whose program it cannot read without a shell: %s (#1918)",
    async (_name, body) => {
      const workspace = await instructionWorkspace(NPM_DOCS_LINT, {
        "package.json": JSON.stringify({ scripts: { "docs:lint": body } }),
      });
      const authority = preflightAuthority({ status: "failed", exitCode: 1, output: "1 error\n" });
      const { gate } = await lintAndGate(workspace, authority);
      // It ran, and its failure stands.
      expect(authority.calls.map((call) => call.argv)).toEqual([["run", "docs:lint"]]);
      expect(gate).toMatchObject({ status: "refused", code: "required-check-failed" });
    },
  );

  it.each([
    ["a fallback after it", "markdownlint docs || true"],
    ["an if around it", "if markdownlint docs; then :; fi"],
    ["a negation", "! markdownlint docs"],
    ["a command after it", "markdownlint docs; echo done"],
    ["a pipe after it", "markdownlint docs | tee lint.log"],
    ["a background job", "markdownlint docs &"],
    ["a fallback after its and-list", "markdownlint docs && prettier --check docs || true"],
    ["a command after its and-list", "zz-missing && x; ./scripts/lint.sh"],
    ["a PATH it sets", "PATH=./bin:$PATH markdownlint docs"],
  ])(
    "runs an npm script whose first program's failure is not the script's: %s (#1918)",
    async (_name, body) => {
      const workspace = await instructionWorkspace(NPM_DOCS_LINT, {
        "package.json": JSON.stringify({ scripts: { "docs:lint": body } }),
      });
      // markdownlint is not installed, and the script fails as it would.
      const authority = preflightAuthority({ status: "failed", exitCode: 1, output: "1 error\n" });
      const { gate } = await lintAndGate(workspace, authority);
      // No pre-flight verdict: the check runs, and its true outcome stands.
      expect(authority.calls.map((call) => call.argv)).toEqual([["run", "docs:lint"]]);
      expect(gate).toMatchObject({ status: "refused", code: "required-check-failed" });
    },
  );

  it("records dependency-unavailable for an npm script whose first program's failure ends the script (#1918)", async () => {
    const workspace = await instructionWorkspace(NPM_DOCS_LINT, {
      "package.json": JSON.stringify({
        scripts: { "docs:lint": "markdownlint docs && prettier --check docs | tee lint.log" },
      }),
    });
    const authority = preflightAuthority({ status: "passed", exitCode: 0, output: "" });
    const { gate } = await lintAndGate(workspace, authority);
    expect(authority.calls).toEqual([]);
    expect(gate).toMatchObject({
      status: "limited",
      limitations: [{ command: "npm run docs:lint", cause: "dependency-unavailable" }],
    });
  });

  it("runs a Yarn Plug'n'Play script, whose programs have no node_modules/.bin, without that pre-flight (#1918)", async () => {
    const yarnDocsLint = `This fixture describes only the fictional ${PILOT_CLI.title}. Run \`yarn run docs:lint\` before proposing a documentation change.\n`;
    const manifest = JSON.stringify({ scripts: { "docs:lint": "markdownlint docs" } });
    const pnp = await instructionWorkspace(yarnDocsLint, {
      "package.json": manifest,
      ".pnp.cjs": "module.exports = {};\n",
    });
    const authority = preflightAuthority({ status: "passed", exitCode: 0, output: "OK\n" });
    const { gate } = await lintAndGate(pnp, authority);
    // Yarn's loader finds markdownlint, so the check runs as usual.
    expect(authority.resolved).toEqual([]);
    expect(
      authority.calls
        .filter((call) => call.executable === "/fixture/bin/yarn")
        .map((call) => call.argv),
    ).toEqual([["run", "docs:lint"]]);
    expect(gate).toMatchObject({ status: "satisfied" });
    // Control: the same script without the loader is pre-flighted, and stops there.
    const plain = await instructionWorkspace(yarnDocsLint, { "package.json": manifest });
    const unresolved = preflightAuthority({ status: "passed", exitCode: 0, output: "OK\n" });
    const limited = await lintAndGate(plain, unresolved);
    expect(unresolved.calls.filter((call) => call.executable === "/fixture/bin/yarn")).toEqual([]);
    expect(limited.gate).toMatchObject({
      status: "limited",
      limitations: [{ command: "yarn run docs:lint", cause: "dependency-unavailable" }],
    });
  });

  it("resolves an npm script's program on the sandbox PATH and in parent node_modules (#1918)", async () => {
    const workspace = await instructionWorkspace(NPM_DOCS_LINT, {
      "package.json": JSON.stringify({
        scripts: { "docs:lint": "LANG=C env NO_COLOR=1 markdownlint docs" },
      }),
    });
    const searchPath = await fixture();
    await writeFile(join(searchPath, "markdownlint"), "#!/bin/sh\n", { mode: 0o755 });
    const authority = preflightAuthority({ status: "passed", exitCode: 0, output: "OK\n" }, [
      searchPath,
    ]);
    const { gate } = await lintAndGate(workspace, authority);
    expect(authority.resolved).toEqual([
      [
        join(workspace.path, "node_modules", ".bin", "markdownlint"),
        join(searchPath, "markdownlint"),
      ],
    ]);
    expect(gate).toMatchObject({ status: "satisfied" });
  });

  it.each([
    ["markdown-link-check", "markdown-link-check README.md", "markdown-link-check"],
    ["npx lychee", "npx lychee docs", "lychee"],
    ["npm ci", "npm ci && markdownlint docs", "npm ci"],
  ])(
    "records network-unavailable for an npm script that starts %s (#1918)",
    async (_name, body, tool) => {
      const workspace = await instructionWorkspace(NPM_DOCS_LINT, {
        "package.json": JSON.stringify({ scripts: { "docs:lint": body } }),
      });
      const authority = preflightAuthority({ status: "passed", exitCode: 0, output: "" });
      const { evidence, gate } = await lintAndGate(workspace, authority);
      expect(authority.calls).toEqual([]);
      expect(evidence.checks).toContainEqual(
        expect.objectContaining({
          command: "npm run docs:lint",
          cause: "network-unavailable",
          reason: `The check runs \`${tool}\`, which needs the network, and the check sandbox is offline.`,
        }),
      );
      expect(gate).toMatchObject({
        status: "limited",
        limitations: [{ command: "npm run docs:lint", cause: "network-unavailable" }],
      });
    },
  );

  it("parses a required command that needs the network as network-unavailable, not as an unsupported form (#1918)", () => {
    const checks = requiredRepositoryChecks([
      {
        path: "AGENTS.md",
        text: [
          "Run `lychee docs/` before you commit.",
          "Run `lychee --offline docs/` before you commit.",
          "Run `mkdocs gh-deploy --force` before you commit.",
          "Run `pip install -r docs/requirements.txt` before you commit.",
          "Run `uv sync` before you commit.",
          "Run `npm ci` before you commit.",
          "Run `ruff format .` before you commit.",
        ].join("\n\n"),
      },
    ]);
    expect(checks.map((check) => [check.command, check.unsupportedCause])).toEqual([
      ["lychee --offline docs/", "unsupported-check-form"],
      ["lychee docs/", "network-unavailable"],
      ["mkdocs gh-deploy --force", "network-unavailable"],
      ["npm ci", "network-unavailable"],
      ["pip install -r docs/requirements.txt", "network-unavailable"],
      ["ruff format .", "unsupported-check-form"],
      ["uv sync", "network-unavailable"],
    ]);
    expect(checks.find((check) => check.command === "lychee docs/")?.unsupported).toBe(
      "The check runs `lychee`, which needs the network, and the check sandbox is offline.",
    );
    // Supported forms never parse as network commands.
    expect(networkCommand(["npm", "run", "docs:lint"])).toBeUndefined();
    expect(networkCommand(["make", "docs-check"])).toBeUndefined();
    expect(scriptFirstCommand("cross-env CI=1 npx lychee docs")).toEqual(["lychee", "docs"]);
  });

  it("records a lychee required check as network-unavailable at the gate (#1918)", async () => {
    const workspace = await instructionWorkspace(
      `This fixture describes only the fictional ${PILOT_CLI.title}. Run \`lychee docs/\` before proposing a documentation change.\n`,
    );
    const authority = recordingAuthority({ status: "passed", exitCode: 0, output: "" });
    const { gate } = await lintAndGate(workspace, authority);
    expect(authority.calls).toEqual([]);
    const line =
      gate.status === "limited" ? formatRequiredCheckLimitation(gate.limitations[0]!) : "";
    expect(line).toBe(
      "required check could not run: `lychee docs/` (network unavailable in the check sandbox). Next action: run this command from the repository root, as `AGENTS.md` requires, before you merge this change.",
    );
  });

  it("records dependency-unavailable when the module python -m runs is not installed (#1918)", async () => {
    const workspace = await instructionWorkspace(
      `This fixture describes only the fictional ${PILOT_CLI.title}. Run \`python3 -m pytest tests\` before proposing a documentation change.\n`,
    );
    const probes: Array<readonly string[]> = [];
    const missing: CheckCommandAuthority = {
      ...recordingAuthority({ status: "passed", exitCode: 0, output: "OK\n" }),
      run: async (_executable, argv) => {
        probes.push([...argv]);
        return { status: "passed", exitCode: 0, output: argv[0] === "-c" ? "missing" : "OK\n" };
      },
    };
    const { gate } = await lintAndGate(workspace, missing);
    // Only the module probe ran, never pytest itself.
    expect(probes).toEqual([["-c", expect.stringContaining("find_spec"), "pytest"]]);
    expect(gate).toMatchObject({
      status: "limited",
      limitations: [{ command: "python3 -m pytest tests", cause: "dependency-unavailable" }],
    });
    // Positive control: an importable module runs the check.
    const found: CheckCommandAuthority = {
      ...recordingAuthority({ status: "passed", exitCode: 0, output: "OK\n" }),
      run: async (_executable, argv) => ({
        status: "passed",
        exitCode: 0,
        output: argv[0] === "-c" ? "found" : "OK\n",
      }),
    };
    expect((await lintAndGate(workspace, found)).gate).toMatchObject({ status: "satisfied" });
  });

  it.each([
    [
      "the module after a warning line",
      { status: "passed", exitCode: 0, output: "Warning: x\nfound" },
    ],
    ["no answer", { status: "passed", exitCode: 0, output: "" }],
    [
      "the module beside a warning that mentions missing",
      { status: "passed", exitCode: 0, output: "Warning: an optional plugin is missing\nfound" },
    ],
    ["a probe that failed", { status: "failed", exitCode: 1, output: "missing" }],
    [
      "a probe that could not start",
      { status: "unavailable", exitCode: null, output: "", reason: "launch-failed" },
    ],
  ] as const)(
    "runs a python -m check as usual when its module probe returns %s (#1918)",
    async (_name, probe) => {
      const workspace = await instructionWorkspace(
        `This fixture describes only the fictional ${PILOT_CLI.title}. Run \`python3 -m pytest tests\` before proposing a documentation change.\n`,
      );
      const runs: string[][] = [];
      const authority: CheckCommandAuthority = {
        ...recordingAuthority({ status: "passed", exitCode: 0, output: "OK\n" }),
        run: async (_executable, argv) => {
          runs.push([...argv]);
          return argv[0] === "-c"
            ? { ...probe }
            : { status: "passed", exitCode: 0, output: "OK\n" };
        },
      };
      const { gate } = await lintAndGate(workspace, authority);
      // Only an exact "missing" from a probe that ran stops the check; here it runs.
      expect(runs.map((argv) => argv[0])).toEqual(["-c", "-m"]);
      expect(gate).toMatchObject({ status: "satisfied" });
    },
  );

  it.each([
    ["mkdocs build --strict", ["mkdocs", "build", "--strict"]],
    ["mkdocs serve", ["mkdocs", "serve"]],
    ["pip check", ["pip", "check"]],
    ["python3 -m pip list", ["python3", "-m", "pip", "list"]],
    ["npm run docs:lint", ["npm", "run", "docs:lint"]],
    ["npm test", ["npm", "test"]],
    ["pnpm run lint", ["pnpm", "run", "lint"]],
    ["yarn run lint", ["yarn", "run", "lint"]],
    ["uv run pytest", ["uv", "run", "pytest"]],
    ["lychee --offline docs/", ["lychee", "--offline", "docs/"]],
    ["linkchecker docs/_build/html", ["linkchecker", "docs/_build/html"]],
    ["sphinx-build -M html docs _build", ["sphinx-build", "-M", "html", "docs", "_build"]],
  ])("does not read `%s` as a command that needs the network (#1918)", (_name, words) => {
    expect(networkCommand(words)).toBeUndefined();
  });

  it.each([
    ["linkchecker --check-extern docs/_build/html", "linkchecker"],
    ["linkchecker https://docs.example.invalid/", "linkchecker"],
    ["sphinx-build -b linkcheck docs _build", "sphinx-build linkcheck"],
    ["sphinx-build -M linkcheck docs _build", "sphinx-build linkcheck"],
    ["mkdocs gh-deploy --force", "mkdocs gh-deploy"],
  ])("reads `%s` as a command that needs the network (#1918)", (command, name) => {
    expect(networkCommand(command.split(" "))).toBe(name);
  });

  it("refuses a check that a signal ended without an executor reason (#1918)", async () => {
    // No reason means the executor did not stop it: it ran and failed.
    expect(
      checkNotRunCause({ status: "failed", exitCode: null, output: "Killed\n" }),
    ).toBeUndefined();
    const workspace = await pilotWorkspace();
    const scratch = await fixture();
    const killed: CheckCommandAuthority = {
      resolve: async () => process.execPath,
      run: (executable, _argv, options) =>
        runBoundedCheckCommand(executable, ["-e", "process.kill(process.pid, 'SIGKILL')"], {
          cwd: options.cwd,
          env: checkSandboxEnvironment(process.execPath, scratch),
          timeoutMs: limit(CHECK_COMMAND_TIMEOUT_LIMIT).value,
          retainedOutputBytes: limit(CHECK_OUTPUT_RETAINED_LIMIT).value,
        }),
      cleanup: async () => undefined,
    };
    const { evidence, gate } = await lintAndGate(workspace, killed);
    expect(evidence.checks).toEqual([
      expect.objectContaining({ command: PILOT_REQUIRED_CHECK, status: "failed", exitCode: null }),
    ]);
    expect(evidence.checks[0]).not.toHaveProperty("reason");
    expect(evidence.checks[0]).not.toHaveProperty("cause");
    expect(gate).toMatchObject({ status: "refused", code: "required-check-failed" });
  });

  it("relabels every required check when the tested tree changes while checks run (#1918)", async () => {
    const workspace = await pilotWorkspace();
    const authority = recordingAuthority(
      { status: "passed", exitCode: 0, output: "OK\n" },
      {
        onRun: async () => {
          await writeFile(join(workspace.path, "docs", "cli.md"), "Changed while checks ran.\n");
        },
      },
    );
    const { evidence, gate } = await lintAndGate(workspace, authority);
    expect(evidence.checks).toEqual([
      expect.objectContaining({
        command: PILOT_REQUIRED_CHECK,
        required: true,
        status: "unavailable",
        reason: "The tested tree changed while checks ran.",
        cause: "tree-changed",
      }),
    ]);
    // The evidence no longer covers the tree to propose, so the gate refuses it.
    expect(gate).toMatchObject({ status: "refused", code: "required-check-evidence-stale" });
  });

  it("prepares no sandbox when no required or native check can run (#1918)", async () => {
    const workspace = await instructionWorkspace(
      `This fixture describes only the fictional ${PILOT_CLI.title}. Run \`ruff format .\` before proposing a documentation change.\n`,
    );
    const prepare = vi.fn(async () =>
      recordingAuthority({ status: "passed", exitCode: 0, output: "OK\n" }),
    );
    const { evidence, gate } = await lintAndGateWith(workspace, prepare);
    // No sandbox, so no Git metadata over the copy either.
    expect(prepare).not.toHaveBeenCalled();
    expect(evidence.checks).toEqual([
      expect.objectContaining({ command: "ruff format .", cause: "unsupported-check-form" }),
    ]);
    expect(gate).toMatchObject({ status: "limited" });
  });

  it("records a sandbox cleanup failure by its code and keeps the check evidence (#1918)", async () => {
    const workspace = await pilotWorkspace();
    const authority: CheckCommandAuthority = {
      ...recordingAuthority({ status: "passed", exitCode: 0, output: "OK\n" }),
      cleanup: async () => {
        throw Object.assign(
          new Error(`ENOTEMPTY: directory not empty, rmdir '${join(workspace.path, ".git")}'`),
          { code: "ENOTEMPTY" },
        );
      },
    };
    const { evidence, gate } = await lintAndGate(workspace, authority);
    expect(evidence).toMatchObject({ sandboxCleanup: { status: "failed", code: "ENOTEMPTY" } });
    // The code only: the error's message names a host path.
    expect(JSON.stringify(evidence)).not.toContain(workspace.path);
    expect(evidence.checks).toEqual([
      expect.objectContaining({ command: PILOT_REQUIRED_CHECK, status: "passed" }),
    ]);
    expect(gate).toMatchObject({ status: "satisfied" });
  });

  const MAKE_DOCS_CHECK = `This fixture describes only the fictional ${PILOT_CLI.title}. Run \`make docs-check\` before proposing a documentation change.\n`;
  const LINT_FAILS = "#!/bin/sh\necho 'lint: 1 problem in docs/cli.md' >&2\nexit 1\n";
  const LINT_PASSES = "#!/bin/sh\necho 'lint: ok'\n";
  const DOCLINT_FAILS = "#!/bin/sh\necho 'doclint: 1 problem' >&2\nexit 1\n";

  /**
   * Makefile shapes (#1918): S0-S11 and H1-H3 are critic-1575 round 3's, where
   * a pre-flight that read every listed command laundered a real failure into
   * a delivered limitation. `scripts/lint.sh` fails, so each check's true
   * outcome is a refusal, except S11, whose script passes, and S10 and the
   * Sphinx makefile, whose only program is not installed. `listing` is GNU Make
   * 4.3's `--dry-run --trace docs-check` output, as captured on Linux; `dryRun`
   * is whether DocsFab asks for one, which it does only for a makefile
   * `makefileDryRunBlocker` reads.
   */
  const MAKE_SHAPES: ReadonlyArray<{
    readonly name: string;
    readonly files: Record<string, string>;
    readonly listing: readonly string[];
    readonly dryRun: boolean;
    readonly outcome: "refused" | "satisfied" | "limited";
  }> = [
    {
      name: "S0 a failing script",
      files: { Makefile: "docs-check:\n\t./scripts/lint.sh\n" },
      listing: ["Makefile:2: target 'docs-check' does not exist", "./scripts/lint.sh"],
      dryRun: true,
      outcome: "refused",
    },
    {
      name: "S1 a subshell cd before the script",
      files: { Makefile: "docs-check:\n\t(cd docs && true) && ./scripts/lint.sh\n" },
      listing: [
        "Makefile:2: target 'docs-check' does not exist",
        "(cd docs && true) && ./scripts/lint.sh",
      ],
      dryRun: true,
      outcome: "refused",
    },
    {
      name: "S2 recipe-time $(info) in a prerequisite",
      files: {
        Makefile:
          "docs-check: links\n\t./scripts/lint.sh\nlinks:\n\t$(info Checking links\u2026)\n",
      },
      listing: [
        "Checking links\u2026",
        "Makefile:4: target 'links' does not exist",
        "Makefile:2: update target 'docs-check' due to: links",
        "./scripts/lint.sh",
      ],
      dryRun: false,
      outcome: "refused",
    },
    {
      name: "S3 $(MAKE) and echo before the script",
      files: {
        Makefile:
          'docs-check:\n\t$(MAKE) -C docs html && echo "Built docs; vale next"\n\t./scripts/lint.sh\n',
        "docs/Makefile": "html:\n\t@true\n",
      },
      listing: [
        "Makefile:2: target 'docs-check' does not exist",
        'make -C docs html && echo "Built docs; vale next"',
        "make[1]: Entering directory '/w/docs'",
        "Makefile:2: target 'html' does not exist",
        "true",
        "make[1]: Leaving directory '/w/docs'",
        "Built docs; vale next",
        "./scripts/lint.sh",
      ],
      dryRun: false,
      outcome: "refused",
    },
    {
      name: "S4 a file name with ; in a wildcard",
      files: {
        Makefile: "docs-check:\n\t./scripts/lint.sh $(wildcard docs/*.md)\n",
        "docs/new;lychee y.md": "# New\n",
      },
      listing: [
        "Makefile:2: target 'docs-check' does not exist",
        "./scripts/lint.sh docs/cli.md docs/new;lychee y.md",
      ],
      dryRun: true,
      outcome: "refused",
    },
    {
      name: "S5 a quiet sub-make with parse-time text",
      files: {
        Makefile:
          "MAKEFLAGS += --no-print-directory\ndocs-check:\n\tsh -c '$(MAKE) -C sub all'\n\t./scripts/lint.sh\n",
        "sub/Makefile": "$(info zz-missing-tool --check)\nall:\n\t@true\n",
      },
      listing: [
        "Makefile:3: target 'docs-check' does not exist",
        "sh -c 'make -C sub all'",
        "zz-missing-tool --check",
        "Makefile:3: target 'all' does not exist",
        "true",
        "./scripts/lint.sh",
      ],
      dryRun: false,
      outcome: "refused",
    },
    {
      name: "S6 a - prefix on a link check",
      files: { Makefile: "docs-check:\n\t-lychee docs\n\t./scripts/lint.sh\n" },
      listing: [
        "Makefile:2: target 'docs-check' does not exist",
        "lychee docs",
        "./scripts/lint.sh",
      ],
      dryRun: false,
      outcome: "refused",
    },
    {
      name: "S7 a command -v guard",
      files: {
        Makefile:
          "docs-check:\n\tcommand -v vale >/dev/null 2>&1 && vale docs || echo skipped\n\t./scripts/lint.sh\n",
      },
      listing: [
        "Makefile:2: target 'docs-check' does not exist",
        "command -v vale >/dev/null 2>&1 && vale docs || echo skipped",
        "./scripts/lint.sh",
      ],
      dryRun: true,
      outcome: "refused",
    },
    {
      name: "S8 a target-specific PATH",
      files: {
        Makefile:
          "docs-check: export PATH := $(CURDIR)/tools:$(PATH)\ndocs-check:\n\tdoclint docs\n",
        "tools/doclint": DOCLINT_FAILS,
      },
      listing: ["Makefile:3: target 'docs-check' does not exist", "doclint docs"],
      dryRun: false,
      outcome: "refused",
    },
    {
      name: "S9 .ONESHELL with export PATH",
      files: {
        Makefile:
          '.ONESHELL:\ndocs-check:\n\texport PATH="$(CURDIR)/tools:$$PATH"\n\tdoclint docs\n',
        "tools/doclint": DOCLINT_FAILS,
      },
      listing: [
        "Makefile:3: target 'docs-check' does not exist",
        'export PATH="/w/tools:$PATH"',
        "doclint docs",
      ],
      dryRun: false,
      outcome: "refused",
    },
    {
      name: "S10 a missing tool on a one-line recipe",
      files: { Makefile: "docs-check:\n\tzz-missing-tool --check docs\n" },
      listing: ["Makefile:2: target 'docs-check' does not exist", "zz-missing-tool --check docs"],
      dryRun: true,
      outcome: "limited",
    },
    {
      name: "S11 a subshell cd before a passing script",
      files: {
        Makefile: "docs-check:\n\t(cd docs && true) && ./scripts/lint.sh\n",
        "scripts/lint.sh": LINT_PASSES,
      },
      listing: [
        "Makefile:2: target 'docs-check' does not exist",
        "(cd docs && true) && ./scripts/lint.sh",
      ],
      dryRun: true,
      outcome: "satisfied",
    },
    {
      name: "H1 a + line that exits 127",
      files: { Makefile: "docs-check:\n\t+exit 127\n" },
      listing: [
        "Makefile:2: target 'docs-check' does not exist",
        "exit 127",
        "make: *** [Makefile:2: docs-check] Error 127",
      ],
      dryRun: false,
      outcome: "refused",
    },
    {
      name: "H2 a forged recipe PATH target",
      files: {
        Makefile:
          ".DOCSFAB-RECIPE-PATH:\n\t@printf 'DOCSFAB-RECIPE-PATH=/nonexistent\\n'\ndocs-check:\n\tls docs/missing-page.md\n",
      },
      listing: ["Makefile:4: target 'docs-check' does not exist", "ls docs/missing-page.md"],
      dryRun: true,
      outcome: "refused",
    },
    {
      name: "H3 a forged trace line and tool",
      files: {
        Makefile:
          "$(info Makefile:1: target 'forged' does not exist)\n$(info zz-forged-tool)\ndocs-check:\n\t./scripts/lint.sh\n",
      },
      listing: [
        "Makefile:1: target 'forged' does not exist",
        "zz-forged-tool",
        "Makefile:4: target 'docs-check' does not exist",
        "./scripts/lint.sh",
      ],
      dryRun: false,
      outcome: "refused",
    },
    {
      name: "R13 a TAB-led export PATH inside a conditional",
      files: {
        Makefile:
          "ifneq ($(wildcard tools),)\n\texport PATH := $(CURDIR)/tools:$(PATH)\nendif\ndocs-check:\n\tdoclint docs\n",
        "tools/doclint": DOCLINT_FAILS,
      },
      listing: ["Makefile:5: target 'docs-check' does not exist", "doclint docs"],
      dryRun: false,
      outcome: "refused",
    },
    {
      name: "R14 a TAB-led include inside a conditional",
      files: {
        Makefile:
          "ifneq ($(wildcard tools.mk),)\n\tinclude tools.mk\nendif\ndocs-check:\n\tdoclint docs\n",
        "tools.mk": "export PATH := $(CURDIR)/tools:$(PATH)\n",
        "tools/doclint": DOCLINT_FAILS,
      },
      listing: ["Makefile:5: target 'docs-check' does not exist", "doclint docs"],
      dryRun: false,
      outcome: "refused",
    },
    {
      name: "R15 a TAB-led PATH under ifdef CI",
      files: {
        Makefile: "ifdef CI\n\tPATH := $(CURDIR)/bin:$(PATH)\nendif\ndocs-check:\n\tdoclint docs\n",
        "bin/doclint": DOCLINT_FAILS,
      },
      listing: ["Makefile:5: target 'docs-check' does not exist", "doclint docs"],
      dryRun: false,
      outcome: "refused",
    },
    {
      name: "R16 the R13 export indented with spaces",
      files: {
        Makefile:
          "ifneq ($(wildcard tools),)\n    export PATH := $(CURDIR)/tools:$(PATH)\nendif\ndocs-check:\n\tdoclint docs\n",
        "tools/doclint": DOCLINT_FAILS,
      },
      listing: ["Makefile:5: target 'docs-check' does not exist", "doclint docs"],
      dryRun: false,
      outcome: "refused",
    },
    {
      name: "B15 a GNUmakefile beside a simple Makefile",
      files: {
        GNUmakefile:
          "docs-check: export PATH := $(CURDIR)/tools:$(PATH)\ndocs-check:\n\tdoclint docs\n",
        Makefile: "docs-check:\n\tdoclint docs\n",
        "tools/doclint": DOCLINT_FAILS,
      },
      listing: ["GNUmakefile:3: target 'docs-check' does not exist", "doclint docs"],
      dryRun: false,
      outcome: "refused",
    },
    {
      name: "C1 a rule in the untaken branch before a TAB-led export",
      files: {
        Makefile:
          "ifeq ($(OS),Windows_NT)\nsetup:\n\techo setup\nelse\n\texport PATH := $(CURDIR)/tools:$(PATH)\nendif\ndocs-check:\n\tdoclint docs\n",
        "tools/doclint": DOCLINT_FAILS,
      },
      listing: ["Makefile:8: target 'docs-check' does not exist", "doclint docs"],
      dryRun: false,
      outcome: "refused",
    },
    {
      name: "C2 a rule under an undefined variable before a TAB-led PATH",
      files: {
        Makefile:
          "ifdef SPHINX_DEBUG\ndebug:\n\t@echo debug\nendif\nifdef CI\n\tPATH := $(CURDIR)/bin:$(PATH)\nendif\ndocs-check:\n\tdoclint docs\n",
        "bin/doclint": DOCLINT_FAILS,
      },
      listing: ["Makefile:9: target 'docs-check' does not exist", "doclint docs"],
      dryRun: false,
      outcome: "refused",
    },
    {
      name: "V1 a colon-separated vpath before a TAB-led PATH",
      files: {
        Makefile:
          "vpath %.md docs:guides\nifdef CI\n\tPATH := $(CURDIR)/bin:$(PATH)\nendif\ndocs-check:\n\tdoclint docs\n",
        "bin/doclint": DOCLINT_FAILS,
      },
      listing: ["Makefile:6: target 'docs-check' does not exist", "doclint docs"],
      dryRun: false,
      outcome: "refused",
    },
    {
      name: "V2 a space-separated vpath before a TAB-led PATH",
      files: {
        Makefile:
          "vpath %.md docs guides\nifdef CI\n\tPATH := $(CURDIR)/bin:$(PATH)\nendif\ndocs-check:\n\tdoclint docs\n",
        "bin/doclint": DOCLINT_FAILS,
      },
      listing: ["Makefile:6: target 'docs-check' does not exist", "doclint docs"],
      dryRun: false,
      outcome: "refused",
    },
    {
      name: "a vale recipe with an option whose vale is missing",
      files: { Makefile: "docs-check:\n\tvale --minAlertLevel=error docs\n" },
      listing: [
        "Makefile:2: target 'docs-check' does not exist",
        "vale --minAlertLevel=error docs",
      ],
      dryRun: true,
      outcome: "limited",
    },
    {
      name: "a Sphinx makefile whose sphinx-build is missing",
      files: {
        Makefile:
          'SPHINXOPTS    ?=\nSPHINXBUILD   ?= sphinx-build\nSOURCEDIR     = docs\nBUILDDIR      = _build\n\nhelp:\n\t@$(SPHINXBUILD) -M help "$(SOURCEDIR)" "$(BUILDDIR)" $(SPHINXOPTS) $(O)\n\n.PHONY: help Makefile\n\n%: Makefile\n\t@$(SPHINXBUILD) -M $@ "$(SOURCEDIR)" "$(BUILDDIR)" $(SPHINXOPTS) $(O)\n',
      },
      listing: [
        "Makefile:12: update target 'docs-check' due to: Makefile",
        'sphinx-build -M docs-check "docs" "_build"  ',
      ],
      dryRun: true,
      outcome: "limited",
    },
  ];

  it.each(MAKE_SHAPES)(
    "decides $name from the makefile and its one-command listing only (#1918)",
    async ({ files, listing, dryRun, outcome }) => {
      const workspace = await instructionWorkspace(MAKE_DOCS_CHECK, {
        "scripts/lint.sh": LINT_FAILS,
        ...files,
      });
      const runs: string[][] = [];
      const installed = new Set(["/usr/bin/make", "/usr/bin/ls", "/bin/ls", "/bin/sh"]);
      const authority: CheckCommandAuthority = {
        resolve: async (program) => `/usr/bin/${program}`,
        searchPath: ["/usr/local/bin", "/usr/bin", "/bin"],
        resolveExecutable: async (candidates) =>
          candidates.find((candidate) => installed.has(candidate)),
        run: async (_executable, argv) => {
          runs.push([...argv]);
          if (argv[0] === "--dry-run") {
            return { status: "passed", exitCode: 0, output: `${listing.join("\n")}\n` };
          }
          // The check's own run: its script's true outcome.
          return outcome === "satisfied"
            ? { status: "passed", exitCode: 0, output: "lint: ok\n" }
            : {
                status: "failed",
                exitCode: 2,
                output: "make: *** [Makefile:2: docs-check] Error 1\n",
              };
        },
        cleanup: async () => undefined,
      };
      const { evidence, gate } = await lintAndGate(workspace, authority);
      // A dry run only for a makefile DocsFab reads, and only inside the sandbox port.
      expect(runs.filter((argv) => argv[0] === "--dry-run")).toEqual(
        dryRun ? [["--dry-run", "--trace", "docs-check"]] : [],
      );
      if (outcome === "limited") {
        expect(runs.some((argv) => argv[0] === "docs-check")).toBe(false);
        expect(gate).toMatchObject({
          status: "limited",
          limitations: [{ command: "make docs-check", cause: "dependency-unavailable" }],
        });
        return;
      }
      // The check ran, and its true outcome stands.
      expect(runs.at(-1)).toEqual(["docs-check"]);
      expect(evidence.checks[0]).not.toHaveProperty("cause");
      expect(gate).toMatchObject(
        outcome === "satisfied"
          ? { status: "satisfied" }
          : { status: "refused", code: "required-check-failed" },
      );
    },
  );

  it.for(MAKE_SHAPES)(
    "runs $name in the real sandbox, and its true outcome holds (#1918)",
    { timeout: testTimeoutMs(60_000) },
    async ({ files, outcome }, context) => {
      // Skip where this host has no admitted check sandbox: CI's bubblewrap lane runs it.
      const capability = await sandboxOrSkip(await fixture(), () => context.skip());
      if (!capability) return;
      await capability.cleanup();
      const workspace = await instructionWorkspace(MAKE_DOCS_CHECK, {
        "scripts/lint.sh": LINT_FAILS,
        ...files,
      });
      const { evidence, gate } = await lintAndGateWith(workspace, (repository) =>
        hostSelectedCheckAuthority(repository),
      );
      if (outcome === "limited") {
        expect(evidence.checks).toEqual([
          expect.objectContaining({
            command: "make docs-check",
            status: "unavailable",
            cause: "dependency-unavailable",
          }),
        ]);
        expect(gate).toMatchObject({ status: "limited" });
        return;
      }
      expect(evidence.checks[0]).not.toHaveProperty("cause");
      expect(gate).toMatchObject(
        outcome === "satisfied"
          ? { status: "satisfied" }
          : { status: "refused", code: "required-check-failed" },
      );
    },
  );

  it.for([
    ["Git on the presented metadata", "docs-check:\n\tgit ls-files --error-unmatch docs/cli.md\n"],
  ] as const)(
    "runs a one-line make target in the real sandbox: %s (#1918)",
    { timeout: testTimeoutMs(60_000) },
    async ([, makefile], context) => {
      const capability = await sandboxOrSkip(await fixture(), () => context.skip());
      if (!capability) return;
      await capability.cleanup();
      const workspace = await instructionWorkspace(MAKE_DOCS_CHECK, { Makefile: makefile });
      const { evidence, gate } = await lintAndGateWith(workspace, (repository) =>
        hostSelectedCheckAuthority(repository),
      );
      expect(evidence.checks).toEqual([
        expect.objectContaining({ command: "make docs-check", status: "passed", exitCode: 0 }),
      ]);
      expect(gate).toMatchObject({ status: "satisfied" });
    },
  );

  it.each([
    ["a function a dry run executes or prints", "FILES := $(shell ls docs)\n"],
    ["a function a dry run executes or prints", "${warning check}\n"],
    ["a function a dry run executes or prints", "x:\n\t$(eval Y := 1)\n"],
    ["a function a dry run executes or prints", "x:\n\t$(file >out,text)\n"],
    [
      "a variable that reveals the dry run or its goals",
      "ifneq (,$(findstring n,$(MAKEFLAGS)))\nendif\n",
    ],
    [
      "a variable that reveals the dry run or its goals",
      "ifeq ($(MAKECMDGOALS),docs-check)\nendif\n",
    ],
    ["a recipe line with a `-` or `+` prefix", "x:\n\t@-lychee docs\n"],
    ["a makefile DocsFab does not read", "include common.mk\n"],
    ["a makefile DocsFab does not read", "-include local.mk\n"],
    ["a multi-line variable", "define RUN\ndoclint\nendef\n"],
    ["a multi-line variable", "override define RUN\ndoclint\nendef\n"],
    ["a special target that changes recipes", ".IGNORE:\n"],
    ["a rule that remakes the makefile", "Makefile: Makefile.in\n\tcp Makefile.in Makefile\n"],
    ["a target-specific variable", "%: OPTS = -W\n"],
    ["a recipe on its rule line", "docs-check: ; doclint docs\n"],
    ["a variable a shell command sets", "FILES != ls docs\n"],
    ["a variable that changes what a recipe runs", "export PATH := $(CURDIR)/bin:$(PATH)\n"],
    ["a variable that changes what a recipe runs", "PATH += /opt/tools\n"],
    ["a variable that changes what a recipe runs", "export FOO PATH\n"],
    ["a variable that changes what a recipe runs", "SHELL := ./tools/fallback-shell\n"],
    ["a variable that changes what a recipe runs", "$(NAME) := x\n"],
    // A TAB-led line shaped like a directive is not read in any context, since
    // which branch of a conditional make takes decides how make reads it.
    [
      "a TAB-led line make may read as a directive",
      "ifneq ($(wildcard tools),)\n\texport PATH := $(CURDIR)/tools:$(PATH)\nendif\n",
    ],
    [
      "a TAB-led line make may read as a directive",
      "ifneq ($(wildcard tools.mk),)\n\tinclude tools.mk\nendif\n",
    ],
    [
      "a TAB-led line make may read as a directive",
      "ifdef CI\n\tPATH := $(CURDIR)/bin:$(PATH)\nendif\n",
    ],
    ["a TAB-led line make may read as a directive", "ifdef CI\n\toverride PATH := /opt/x\nendif\n"],
    ["a TAB-led line make may read as a directive", "\tSHELL := ./tools/fallback-shell\n"],
    ["a TAB-led line make may read as a directive", "\tunexport PATH\n"],
    ["a TAB-led line make may read as a directive", "\tFILES != ls docs\n"],
    ["a TAB-led line make may read as a directive", "ifdef CI\n\t$(NAME) := /opt/x\nendif\n"],
    [
      "a TAB-led line make may read as a directive",
      "lint:\n\tvale docs\nOPTS = -W\n\texport PATH := /opt/x\n",
    ],
    // C1: a rule in the untaken branch, then a TAB-led export in the taken one.
    [
      "a TAB-led line make may read as a directive",
      "ifeq ($(OS),Windows_NT)\nsetup:\n\techo setup\nelse\n\texport PATH := $(CURDIR)/tools:$(PATH)\nendif\n",
    ],
    // C2: a rule under an undefined variable, then a TAB-led PATH under ifdef CI.
    [
      "a TAB-led line make may read as a directive",
      "ifdef SPHINX_DEBUG\ndebug:\n\t@echo debug\nendif\nifdef CI\n\tPATH := $(CURDIR)/bin:$(PATH)\nendif\n",
    ],
    // V1 and V2: vpath, with colon- or space-separated directories, opens no rule.
    [
      "a TAB-led line make may read as a directive",
      "vpath %.md docs:guides\nifdef CI\n\tPATH := $(CURDIR)/bin:$(PATH)\nendif\n",
    ],
    [
      "a TAB-led line make may read as a directive",
      "vpath %.md docs guides\nifdef CI\n\tPATH := $(CURDIR)/bin:$(PATH)\nendif\n",
    ],
    ["a special target that changes recipes", "vpath %.md docs:guides\n\t.ONESHELL:\n"],
    // Directive shapes inside a rule, and a target-specific PATH after an untaken rule.
    ["a TAB-led line make may read as a directive", "debug:\n\t@include tools.mk\n"],
    [
      "a TAB-led line make may read as a directive",
      "ifdef SPHINX_DEBUG\ndebug:\n\t@echo debug\nendif\n\tdocs-check: export PATH := $(CURDIR)/tools:$(PATH)\n",
    ],
    // A prefix is read in any context: here the untaken branch ends no rule for make.
    [
      "a recipe line with a `-` or `+` prefix",
      "docs-check:\nifeq ($(OS),Windows_NT)\nX = 1\nendif\n\t-lychee docs\n",
    ],
    ["a special target that changes recipes", "\t.ONESHELL:\n"],
    ["a target-specific variable", "\tdocs-check: OPTS = -W\n"],
    ["a variable that changes what a recipe runs", "override undefine PATH\n"],
  ])("reads no dry run for a makefile with %s (#1918)", (reason, makefile) => {
    expect(makefileDryRunBlocker(`${makefile}docs-check:\n\tdoclint docs\n`)).toBe(reason);
  });

  it.each([
    ["conditionals on the environment", "ifeq ($(CI),1)\nOPTS = -W\nelse\nOPTS =\nendif\n"],
    ["a standard shell and options", "SHELL := /bin/bash\n.SHELLFLAGS := -eu -o pipefail -c\n"],
    ["substitution references", "OBJS = $(SRCS:.md=.html)\nall: $(OBJS:.html=.md)\n"],
    ["a recipe line continued with an option", "lint:\n\tdoclint \\\n\t  --strict docs\n"],
    ["exported variables other than PATH", "export SPHINXOPTS = -W\n"],
    ["phony targets", ".PHONY: help Makefile docs-check\n"],
    // A recipe line keeps its own syntax: the `=` in an option names no variable.
    ["a recipe option with an equals sign", "lint:\n\tvale --minAlertLevel=error docs\n"],
    ["a shell test with != in a recipe", 'lint:\n\ttest "$$CI" != 1 || vale docs\n'],
    ["vpath with colon-separated directories", "vpath %.md docs:guides\n"],
    [
      "a recipe line after a blank line, a comment, and a conditional",
      "lint:\n\tvale docs\n\n# More checks.\nifdef CI\n\tvale --minAlertLevel=error docs\nendif\n",
    ],
  ])("reads the dry run of a makefile with %s (#1918)", (_name, makefile) => {
    expect(makefileDryRunBlocker(`${makefile}docs-check:\n\tdoclint docs\n`)).toBeUndefined();
  });

  it("reads only a make listing of the goal's trace line and one simple command (#1918)", () => {
    const trace = "Makefile:2: target 'docs-check' does not exist";
    expect(
      makeDryRunSoleCommand(`${trace}\nsphinx-build -W docs _build 2>&1\n`, "docs-check"),
    ).toEqual({ words: ["sphinx-build", "-W", "docs", "_build", "2>&1"], npx: false });
    // GNU Make 4.4 names a new target's cause in its update line.
    expect(
      makeDryRunSoleCommand(
        "Makefile:2: update target 'docs-check' due to: target does not exist\nvale docs\n",
        "docs-check",
      ),
    ).toEqual({ words: ["vale", "docs"], npx: false });
    for (const listing of [
      // Another target's trace line, a second line, parse-time text, a make message.
      "Makefile:2: target 'other' does not exist\nvale docs\n",
      `${trace}\nvale docs\n./scripts/lint.sh\n`,
      `Building the docs\n${trace}\nvale docs\n`,
      "make: 'docs-check' is up to date.\n",
      // A command whose status is not its own, or that is not a program.
      `${trace}\nvale docs || true\n`,
      `${trace}\n! vale docs\n`,
      `${trace}\nvale docs | tee log\n`,
      `${trace}\nvale docs &\n`,
      `${trace}\nif vale docs; then :; fi\n`,
      `${trace}\ncommand -v vale\n`,
      `${trace}\nPATH=/opt/x:$PATH vale docs\n`,
      `${trace}\nvale $(cat files)\n`,
      `${trace}\n"vale" docs\n`,
    ]) {
      expect(makeDryRunSoleCommand(listing, "docs-check"), listing).toBeUndefined();
    }
    expect(soleSimpleCommand("tool docs >| out 2>&1")).toEqual([
      "tool",
      "docs",
      ">|",
      "out",
      "2>&1",
    ]);
    expect(soleSimpleCommand("tool '$(literal)' &> log")).toEqual([
      "tool",
      "'$(literal)'",
      "&>",
      "log",
    ]);
    // A trailing pipe or `&` leaves one command, but not its own status.
    for (const text of [
      "tool; x",
      "tool && x",
      "(tool)",
      "tool `x`",
      'tool "$(x)"',
      "tool <<EOF",
      "tool |",
      "tool &",
    ]) {
      expect(soleSimpleCommand(text), text).toBeUndefined();
    }
    // A substitution stays inside its word.
    expect(shellSimpleCommands("tool $(cat list) && $(VENV)/bin/x")).toEqual([
      ["tool", "$(cat list)"],
      ["$(VENV)/bin/x"],
    ]);
    expect(shellSimpleCommands("tool $(cat list")).toBeUndefined();
  });

  it("runs a make check with options or variable overrides without a dry run (#1918)", async () => {
    const workspace = await instructionWorkspace(
      `This fixture describes only the fictional ${PILOT_CLI.title}. Run \`make docs-check SPHINXOPTS=-W\` before proposing a documentation change.\n`,
      { Makefile: "docs-check:\n\tzz-missing-tool --check docs\n" },
    );
    const runs: string[][] = [];
    const authority: CheckCommandAuthority = {
      ...recordingAuthority({ status: "passed", exitCode: 0, output: "OK\n" }),
      searchPath: ["/usr/bin"],
      resolveExecutable: async (candidates) =>
        candidates.find((candidate) => candidate === "/usr/bin/make"),
      run: async (_executable, argv) => {
        runs.push([...argv]);
        return { status: "passed", exitCode: 0, output: "OK\n" };
      },
    };
    const { gate } = await lintAndGate(workspace, authority);
    // The required check ran as written, with no dry run first; the
    // discovered native `make docs-check` runs after that.
    expect(runs[0]).toEqual(["docs-check", "SPHINXOPTS=-W"]);
    expect(runs.some((argv) => argv[0] === "--dry-run")).toBe(false);
    expect(gate).toMatchObject({ status: "satisfied" });
  });

  it("reads no dry run for a makefile the change edits (#1918)", async () => {
    const workspace = await instructionWorkspace(MAKE_DOCS_CHECK, {
      Makefile: "docs-check:\n\t./scripts/lint.sh\n",
      "scripts/lint.sh": LINT_FAILS,
    });
    // The candidate rewrites the makefile to name a missing tool.
    await writeFile(join(workspace.path, "Makefile"), "docs-check:\n\tzz-missing-tool docs\n");
    const runs: string[][] = [];
    const authority: CheckCommandAuthority = {
      ...recordingAuthority({ status: "failed", exitCode: 2, output: "Error 127\n" }),
      searchPath: ["/usr/bin"],
      resolveExecutable: async () => undefined,
      run: async (_executable, argv) => {
        runs.push([...argv]);
        return { status: "failed", exitCode: 2, output: "make: *** Error 127\n" };
      },
    };
    const { gate } = await lintAndGate(workspace, authority);
    // Only the repository's own makefile is read: the check runs, and its failure stands.
    expect(runs).toEqual([["docs-check"]]);
    expect(gate).toMatchObject({ status: "refused", code: "required-check-failed" });
  });

  it.each([
    [
      "a credential scan past its declared bound",
      new CheckSandboxPreparationError("credential-scan-bound", 1_000_001),
      "credential-scan-bound",
      "required check could not run: `python3 -m unittest discover -s tests` (the checkout exceeds the check credential scan limit). Next action: run this command from the repository root, as `AGENTS.md` requires, before you merge this change. Limit: checks-credential-scan-max-entries-bound: 1000001 exceeds checks.credentialScanMaxEntries = 1000000 count.",
    ],
    [
      "Git metadata the sandbox could not present",
      new CheckSandboxPreparationError("git-metadata"),
      "git-metadata-unavailable",
      "required check could not run: `python3 -m unittest discover -s tests` (git metadata unavailable in the check sandbox). Next action: run this command from the repository root, as `AGENTS.md` requires, before you merge this change.",
    ],
  ])(
    "runs nothing and records a coded limitation for %s (#1918, #1932)",
    async (_name, failure, cause, linePrefix) => {
      const workspace = await pilotWorkspace();
      const { evidence, gate } = await lintAndGateWith(workspace, (repository) =>
        hostSelectedCheckAuthority(repository, {
          platform: "linux",
          prepareSandbox: async () => {
            throw failure;
          },
        }),
      );
      expect(evidence.checks).toEqual([
        expect.objectContaining({ command: PILOT_REQUIRED_CHECK, status: "unavailable", cause }),
      ]);
      expect(evidence.checks[0]).not.toHaveProperty("isolationRefusal");
      const line =
        gate.status === "limited" ? formatRequiredCheckLimitation(gate.limitations[0]!) : "";
      expect(line.startsWith(linePrefix), line).toBe(true);
    },
  );

  it(
    "stops a hanging check at the declared time limit and records a coded limitation (#1932)",
    async () => {
      vi.stubEnv("DOCSFAB_CHECKS_COMMAND_TIMEOUT_MS", "1000");
      const workspace = await pilotWorkspace();
      const scratch = await fixture();
      // The repository's check hangs; the real bounded executor runs it under
      // the declared limits, as the Linux sandbox does around bubblewrap.
      const hanging: CheckCommandAuthority = {
        resolve: async () => process.execPath,
        run: (executable, _argv, options) =>
          runBoundedCheckCommand(executable, ["-e", "setInterval(() => {}, 1000)"], {
            cwd: options.cwd,
            env: checkSandboxEnvironment(process.execPath, scratch),
            timeoutMs: limit(CHECK_COMMAND_TIMEOUT_LIMIT).value,
            retainedOutputBytes: limit(CHECK_OUTPUT_RETAINED_LIMIT).value,
            ...(options.signal ? { signal: options.signal } : {}),
          }),
        cleanup: async () => undefined,
      };
      const { evidence, gate } = await lintAndGate(workspace, hanging);
      const entry = evidence.checks.find((check) => check.required === true);
      expect(entry).toMatchObject({
        command: PILOT_REQUIRED_CHECK,
        status: "unavailable",
        cause: "timeout",
        timeoutMs: 1000,
        reason: expect.stringMatching(
          /^checks-command-timeout-ms-bound: \d+ exceeds checks\.commandTimeoutMs = 1000 ms\. /u,
        ),
      });
      expect(Number(entry?.elapsedMs)).toBeGreaterThanOrEqual(1000);
      expect(gate).toMatchObject({
        status: "limited",
        limitations: [{ command: PILOT_REQUIRED_CHECK, cause: "timeout" }],
      });
      const line =
        gate.status === "limited" ? formatRequiredCheckLimitation(gate.limitations[0]!) : "";
      expect(
        line.startsWith(
          `required check could not run: \`${PILOT_REQUIRED_CHECK}\` (it did not finish within the check time limit). Next action: run this command from the repository root, as \`AGENTS.md\` requires, before you merge this change. Limit: checks-command-timeout-ms-bound: `,
        ),
      ).toBe(true);
      expect(line).toContain("DOCSFAB_CHECKS_COMMAND_TIMEOUT_MS");
    },
    testTimeoutMs(30_000),
  );

  it("runs every required check, a tenth included (#1932)", async () => {
    const commands = Array.from({ length: 10 }, (_, index) => `make check-${index + 1}`);
    const workspace = await instructionWorkspace(
      `Before proposing a change, run ${commands.map((command) => `\`${command}\``).join(", ")}.\n`,
    );
    const authority = recordingAuthority({ status: "passed", exitCode: 0, output: "OK\n" });
    const { evidence, gate } = await lintAndGate(workspace, authority);
    const sorted = [...commands].sort();
    expect(authority.calls.map((call) => `make ${call.argv.join(" ")}`).sort()).toEqual(sorted);
    expect(
      evidence.checks.filter((check) => check.required === true && check.status === "passed"),
    ).toHaveLength(10);
    expect(gate).toMatchObject({ status: "satisfied" });
    expect(gate.status === "satisfied" ? [...gate.commands].sort() : []).toEqual(sorted);
  });

  it("caps discovered native checks at the declared limit, which a host can raise (#1932)", async () => {
    const targets = [
      "fern-check",
      "doc-check",
      "docs-check",
      "doc-lint",
      "docs-lint",
      "doc-validate",
      "docs-validate",
      "check-doc",
      "check-docs",
      "lint-docs",
    ];
    const workspace = await instructionWorkspace(
      `This fixture describes only the fictional ${PILOT_CLI.title}.\n`,
      { Makefile: targets.map((target) => `${target}:\n\t@true\n`).join("") },
    );
    const lint = async () => {
      const authority = recordingAuthority({ status: "passed", exitCode: 0, output: "OK\n" });
      const result = await new WorkflowChecksHostOperation(workspace, "lint-documentation", {
        prepareAuthority: async () => authority,
      }).runStep(lintInput(workspace.path));
      const evidence = JSON.parse(result.summary) as { checks: Array<Record<string, unknown>> };
      return { ran: authority.calls.length, checks: evidence.checks };
    };
    const capped = await lint();
    expect(capped.ran).toBe(8);
    expect(capped.checks).toContainEqual({
      status: "unavailable",
      reason: expect.stringMatching(
        /^checks-native-command-max-bound: 10 exceeds checks\.nativeCommandMax = 8 count\. /u,
      ),
    });
    vi.stubEnv("DOCSFAB_CHECKS_NATIVE_COMMAND_MAX", "10");
    const raised = await lint();
    expect(raised.ran).toBe(10);
    expect(JSON.stringify(raised.checks)).not.toContain("checks-native-command-max-bound");
  });

  it.each([
    ["DOCSFAB_CHECKS_COMMAND_TIMEOUT_MS", "checks.commandTimeoutMs", 86_400_000],
    ["DOCSFAB_CHECKS_OUTPUT_RETAINED_BYTES", "checks.outputRetainedBytes", 262_144],
    ["DOCSFAB_CHECKS_NATIVE_COMMAND_MAX", "checks.nativeCommandMax", 256],
    ["DOCSFAB_CHECKS_CREDENTIAL_SCAN_MAX_ENTRIES", "checks.credentialScanMaxEntries", 100_000_000],
  ] as const)(
    "lets a host raise %s to its maximum and no further (#1932)",
    (variable, name, maximum) => {
      const declared = limitDefinition(name);
      expect(declared.override).toBe(variable);
      expect(declared.max).toBe(maximum);
      expect(declared.max).toBeGreaterThan(declared.value);
      vi.stubEnv(variable, String(maximum));
      expect(limit(name)).toMatchObject({ value: maximum, source: "host" });
      vi.stubEnv(variable, String(maximum + 1));
      expect(() => limit(name)).toThrow(`${variable} must be an integer`);
    },
  );

  it("stays inert when no repository instruction requires a check", async () => {
    const root = await fixture();
    await writeFile(join(root, "AGENTS.md"), "Run `make docs-check` to preview changes.\n");
    await expect(
      assessRequiredRepositoryChecks({
        runId: "run-848",
        workspacePath: root,
        baselineInstructions: [],
        steps: [],
      }),
    ).resolves.toEqual({ status: "not-required" });
  });

  it("refuses a known baseline when the final workspace is missing", async () => {
    const workspace = await pilotWorkspace();
    const baseline = (await observeCheckedSnapshot(workspace.path, { digest: false })).instructions;
    expect(requiredRepositoryChecks(baseline).length).toBeGreaterThan(0);
    await rm(workspace.path, { recursive: true, force: true });
    const gate = await assessRequiredRepositoryChecks({
      runId: "run-848",
      workspacePath: workspace.path,
      baselineInstructions: baseline,
      steps: [],
    });
    expect(gate).toMatchObject({
      status: "refused",
      code: "required-check-snapshot-unavailable",
    });
    expect(gate.status === "refused" ? gate.message : "").toContain("was not proposed");
  });

  it("refuses an unobservable tree even when the baseline union has no commands", async () => {
    const root = await fixture();
    await writeFile(join(root, "AGENTS.md"), "Run `make docs-check` to preview changes.\n");
    await rm(root, { recursive: true, force: true });
    await expect(
      assessRequiredRepositoryChecks({
        runId: "run-848",
        workspacePath: root,
        baselineInstructions: [],
        steps: [],
      }),
    ).resolves.toMatchObject({
      status: "refused",
      code: "required-check-snapshot-unavailable",
    });
  });
});
