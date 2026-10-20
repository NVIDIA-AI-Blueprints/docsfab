// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFile } from "node:child_process";
import { copyFile, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import {
  CREATE_DOCUMENTATION_INSTRUCTION,
  CRATE_STEPS,
  LAUNCHER_MAX_BUFFER_LIMIT,
  RUNTIME_ENV_REMEDIATION,
  assertCrateSteps,
  captureBounded,
  crateStepStatuses,
  assertNotFactoryPath,
  copyNoDocFixture,
  createDocumentationArgv,
  extractInitPlanSha256,
  extractRunResult,
  factoryRootFromRuntime,
  initApplyArgv,
  initPreviewArgv,
  initializeThrowawayGit,
  noDocFixturePath,
  parseCliArgs,
  provisionRuntimeEnv,
  readCatalogLimit,
  REMOTE_REQUIRED_CODE,
  REMOTE_REQUIRED_REMEDIATION,
  requireUncredentialedRemoteUrl,
  resolveThrowawayRemote,
  runtimeRootFromHere,
  sanitizeOriginUrl,
} from "../scripts/dogfood/create-documentation-no-doc/plan.mjs";
import { temporaryRoots } from "./helpers/temp.js";
import { NO_DOC_FIXTURE_PACKAGE_NAME } from "./helpers/no-doc-dogfood-inputs.js";

const execute = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const runtimeRoot = resolve(here, "..");
const cliPath = join(runtimeRoot, "scripts/dogfood/create-documentation-no-doc/cli.mjs");
const temporaryDirectories = temporaryRoots();
const EXAMPLE_REMOTE = "https://gitlab.example.test/group/docs.git";
const CREDENTIALED_REMOTE = "https://dogfood:example@gitlab.example.test/group/docs.git";
const CATALOG = "config/limits.catalog.json";
const LAUNCHER_BOUND_REFUSAL = "dogfood-no-doc-launcher-max-buffer-bytes-bound";
const GIT_IDENTITY = ["-c", "user.email=test@example.test", "-c", "user.name=Test"];

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execute("git", args, { cwd });
  return stdout.trim();
}

/**
 * This checkout's shape as the public export builds it: the helper and its
 * fixture in a one-commit repository with no remote at all.
 */
async function exportedFactory(): Promise<{
  factory: string;
  cli: string;
  tmp: string;
}> {
  const root = await temporaryDirectories.create("docsfab-no-doc-factory-", { realpath: true });
  const factory = join(root, "factory");
  const factoryRuntime = join(factory, "packages/runtime");
  const helper = "scripts/dogfood/create-documentation-no-doc";
  await mkdir(join(factoryRuntime, helper), { recursive: true });
  for (const name of ["cli.mjs", "plan.mjs", "fixture-source.mjs"]) {
    await copyFile(join(runtimeRoot, helper, name), join(factoryRuntime, helper, name));
  }
  await copyNoDocFixture(runtimeRoot, noDocFixturePath(factoryRuntime));
  await mkdir(join(factory, "config"));
  await copyFile(join(factoryRootFromRuntime(runtimeRoot), CATALOG), join(factory, CATALOG));
  await git(factory, ["init", "-q", "-b", "main"]);
  await git(factory, ["add", "."]);
  await git(factory, [...GIT_IDENTITY, "-c", "commit.gpgsign=false", "commit", "-q", "-m", "x"]);
  const tmp = join(root, "tmp");
  await mkdir(tmp);
  return { factory, cli: join(factoryRuntime, helper, "cli.mjs"), tmp };
}

/** Runs the copied CLI with only what git needs, and its scratch under `tmp`. */
async function runCli(
  cli: string,
  tmp: string,
  args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  const env = { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? tmp, TMPDIR: tmp };
  const result = await execute(process.execPath, [cli, ...args], { cwd: tmp, env }).then(
    (done) => ({ ...done, code: 0 }),
    (error: { code?: number; stdout?: string; stderr?: string }) => ({
      code: typeof error.code === "number" ? error.code : -1,
      stdout: String(error.stdout ?? ""),
      stderr: String(error.stderr ?? ""),
    }),
  );
  return { code: result.code, stdout: String(result.stdout), stderr: String(result.stderr) };
}

/**
 * Makes the copied factory ready for --live without a model: a runtime env
 * file, a launcher stand-in whose `list` prints `listBytes` bytes and whose
 * other commands exit 7, and a launcher output bound of `bound` bytes.
 */
async function stubLiveFactory(bound: number, listBytes: number) {
  const { factory, cli, tmp } = await exportedFactory();
  const runtime = join(factory, "packages/runtime");
  await writeFile(join(runtime, ".env"), "MODEL_ID=example/model\n");
  await mkdir(join(runtime, "dist"));
  const listing = "create-documentation".padEnd(listBytes, "x");
  await writeFile(
    join(runtime, "dist/launcher.js"),
    `if (process.argv[2] === "list") process.stdout.write(${JSON.stringify(listing)});\n` +
      `else { process.stderr.write("stand-in has no " + process.argv[2]); process.exitCode = 7; }\n`,
  );
  const catalog = JSON.parse(await readFile(join(factory, CATALOG), "utf8")) as {
    limits: Record<string, { value: number }>;
  };
  catalog.limits[LAUNCHER_MAX_BUFFER_LIMIT]!.value = bound;
  await writeFile(join(factory, CATALOG), JSON.stringify(catalog));
  return { cli, tmp };
}

function keptScratch(stderr: string): string {
  const match = /kept scratch: (\S+)/u.exec(stderr);
  if (!match) throw new Error(`no kept scratch in: ${stderr}`);
  return temporaryDirectories.track(match[1]!);
}

describe("create-documentation no-doc dogfood helper", () => {
  it("copies the fixture into a throwaway git repo and builds live argv", async () => {
    const root = await temporaryDirectories.create("docsfab-no-doc-plan-");
    const destination = join(root, "fixture");
    await copyNoDocFixture(runtimeRoot, destination);
    await initializeThrowawayGit(destination, "https://gitlab.example.test/group/docs.git");
    const packageJson = JSON.parse(await readFile(join(destination, "package.json"), "utf8")) as {
      name: string;
    };
    expect(packageJson.name).toBe(NO_DOC_FIXTURE_PACKAGE_NAME);
    expect(initPreviewArgv(destination)).toEqual([
      "init",
      "--repo",
      destination,
      "--non-interactive",
      "--json",
    ]);
    expect(createDocumentationArgv(destination)).toEqual([
      "run",
      "create-documentation",
      "--repo",
      destination,
      "--allow-write",
      "--instruction",
      CREATE_DOCUMENTATION_INSTRUCTION,
      "--json",
    ]);
    expect(createDocumentationArgv(destination).includes("--canon-snapshot")).toBe(false);
    expect(initApplyArgv(destination, "a".repeat(64)).includes("--apply")).toBe(true);
  });

  it("refuses the factory checkout as the write target", () => {
    const factory = factoryRootFromRuntime(runtimeRootFromHere());
    expect(() => assertNotFactoryPath(factory, factory)).toThrow(/throwaway copy/u);
    expect(() => assertNotFactoryPath(join(factory, "docs"), factory)).toThrow(/throwaway copy/u);
  });

  it("parses crate steps from a run record and rejects --canon-snapshot", () => {
    const record = {
      steps: CRATE_STEPS.map((id) => ({ id, status: "succeeded" })),
    };
    expect(assertCrateSteps(record)).toEqual([...CRATE_STEPS]);
    expect(crateStepStatuses(record)).toEqual(
      CRATE_STEPS.map((id) => ({ id, status: "succeeded" })),
    );
    expect(() =>
      assertCrateSteps({ steps: CRATE_STEPS.filter((id) => id !== "review-documentation") }),
    ).toThrow(/review-documentation/u);
    expect(
      extractInitPlanSha256(JSON.stringify({ kind: "docsfab-init-plan", sha256: "b".repeat(64) })),
    ).toBe("b".repeat(64));
    expect(
      extractRunResult(
        JSON.stringify({
          kind: "docsfab-run-result",
          execution: { runId: "run-1", recordPath: "/tmp/run-1.json", exitCode: 0 },
        }),
      ),
    ).toEqual({ runId: "run-1", recordPath: "/tmp/run-1.json", exitCode: 0 });
    expect(() => parseCliArgs(["--canon-snapshot"])).toThrow(/canon-snapshot/u);
    expect(parseCliArgs(["--live"]).live).toBe(true);
    expect(
      sanitizeOriginUrl("https://gitlab-ci-token:glcbt-example@gitlab.example.test/group/docs.git"),
    ).toBe("https://gitlab.example.test/group/docs.git");
    expect(sanitizeOriginUrl("https://gitlab.example.test/group/docs.git")).toBe(
      "https://gitlab.example.test/group/docs.git",
    );
  });

  it("names the model selection fields only when the runtime env file is absent", async () => {
    const root = await temporaryDirectories.create("docsfab-no-doc-env-");
    const runtime = join(root, "runtime");
    const config = join(root, "config");
    await mkdir(runtime);
    await mkdir(config);
    await expect(provisionRuntimeEnv(runtime, config)).rejects.toThrow(RUNTIME_ENV_REMEDIATION);
    expect(RUNTIME_ENV_REMEDIATION).toContain("MODEL_PROVIDER, MODEL_BASE_URL, MODEL_ID");

    // Adjacent condition: the env file exists but the copy target does not.
    await writeFile(join(runtime, ".env"), "MODEL_ID=example/model\n");
    const failure = await provisionRuntimeEnv(runtime, join(root, "absent")).catch(
      (error: unknown) => error,
    );
    expect(String(failure)).toMatch(/ENOENT/u);
    expect(String(failure)).not.toContain(RUNTIME_ENV_REMEDIATION);

    const target = await provisionRuntimeEnv(runtime, config);
    expect(await readFile(target, "utf8")).toBe("MODEL_ID=example/model\n");
    expect((await stat(target)).mode & 0o777).toBe(0o600);
  });

  it("dry-runs without spawning init apply or a model", async () => {
    const { stdout, stderr } = await execute(process.execPath, [cliPath], {
      cwd: runtimeRoot,
      env: { ...process.env },
    });
    expect(stderr).toBe("");
    const parsed = JSON.parse(stdout) as {
      mode: string;
      instruction: string;
      argv: { run: string[]; initApply: string[] };
    };
    expect(parsed.mode).toBe("dry-run");
    expect(parsed.instruction).toBe(CREATE_DOCUMENTATION_INSTRUCTION);
    expect(parsed.argv.run).toContain("create-documentation");
    expect(parsed.argv.run).toContain("--allow-write");
    expect(parsed.argv.initApply).toContain("--apply");
    expect(parsed.argv.run.includes("--canon-snapshot")).toBe(false);
    expect(stdout).not.toMatch(/nvapi-|ihub_api_|glpat-|MODEL_API_KEY=/u);
  });

  it("dry-runs in a checkout with no remote, as the public export is", async () => {
    const { cli, tmp } = await exportedFactory();
    const { code, stdout, stderr } = await runCli(cli, tmp, []);
    expect(stderr).toBe("");
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout) as {
      mode: string;
      remote: unknown;
      argv: { run: string[] };
    };
    expect(parsed.mode).toBe("dry-run");
    expect(parsed.remote).toEqual({
      source: "none",
      liveRefusal: REMOTE_REQUIRED_CODE,
      remediation: REMOTE_REQUIRED_REMEDIATION,
    });
    expect(parsed.argv.run).toContain("create-documentation");
    expect(await readdir(tmp)).toEqual([]);
  });

  it("refuses --live with no remote before it provisions anything", async () => {
    const { cli, tmp } = await exportedFactory();
    const { code, stdout, stderr } = await runCli(cli, tmp, ["--live"]);
    expect(code).toBe(1);
    expect(stdout).toBe("");
    expect(stderr).toContain(`${REMOTE_REQUIRED_CODE}: ${REMOTE_REQUIRED_REMEDIATION}`);
    expect(stderr).not.toContain(RUNTIME_ENV_REMEDIATION);
    expect(await readdir(tmp)).toEqual([]);
  });

  it("gives the throwaway repository the --remote-url remote", async () => {
    const { cli, tmp } = await exportedFactory();
    const { code, stdout, stderr } = await runCli(cli, tmp, [
      "--remote-url",
      EXAMPLE_REMOTE,
      "--keep",
    ]);
    expect(code).toBe(0);
    expect((JSON.parse(stdout) as { remote: unknown }).remote).toEqual({ source: "argument" });
    expect(stdout).not.toContain(EXAMPLE_REMOTE);
    const fixture = join(keptScratch(stderr), "fixture");
    expect(await git(fixture, ["remote", "get-url", "origin"])).toBe(EXAMPLE_REMOTE);
  });

  it("gives the throwaway repository this checkout's origin when it has one", async () => {
    const { factory, cli, tmp } = await exportedFactory();
    await git(factory, ["remote", "add", "origin", EXAMPLE_REMOTE]);
    const { code, stdout, stderr } = await runCli(cli, tmp, ["--keep"]);
    expect(code).toBe(0);
    expect((JSON.parse(stdout) as { remote: unknown }).remote).toEqual({
      source: "factory-origin",
    });
    const fixture = join(keptScratch(stderr), "fixture");
    expect(await git(fixture, ["remote", "get-url", "origin"])).toBe(EXAMPLE_REMOTE);
  });

  it("leaves the throwaway repository without a remote when given none", async () => {
    const root = await temporaryDirectories.create("docsfab-no-doc-bare-");
    const destination = join(root, "fixture");
    await copyNoDocFixture(runtimeRoot, destination);
    await initializeThrowawayGit(destination, null);
    expect(await git(destination, ["remote"])).toBe("");
  });

  it("treats only an absent origin as no remote", async () => {
    const { factory } = await exportedFactory();
    await git(factory, ["remote", "add", "upstream", EXAMPLE_REMOTE]);
    await expect(resolveThrowawayRemote(factory, undefined)).resolves.toEqual({
      source: "none",
      url: null,
    });

    // Adjacent conditions: git cannot read the checkout, or origin is unusable.
    const broken = await temporaryDirectories.create("docsfab-no-doc-broken-");
    await writeFile(join(broken, ".git"), `gitdir: ${join(broken, "missing")}\n`);
    await expect(resolveThrowawayRemote(broken, undefined)).rejects.toThrow(
      /not a git repository/u,
    );
    await git(factory, ["remote", "add", "origin", "ssh://dogfood:example@gitlab.example.test/x"]);
    await expect(resolveThrowawayRemote(factory, undefined)).rejects.toThrow(
      "Factory origin must be one uncredentialed Git remote URL.",
    );
    await expect(resolveThrowawayRemote(factory, EXAMPLE_REMOTE)).resolves.toEqual({
      source: "argument",
      url: EXAMPLE_REMOTE,
    });
  });

  it("refuses a credentialed --remote-url at the CLI instead of stripping it", async () => {
    const { factory, cli, tmp } = await exportedFactory();
    const { code, stdout, stderr } = await runCli(cli, tmp, ["--remote-url", CREDENTIALED_REMOTE]);
    expect(code).toBe(1);
    expect(stdout).toBe("");
    expect(stderr).toContain("--remote-url must be one uncredentialed Git remote URL.");
    expect(stderr).not.toContain("dogfood:example");
    expect(stderr).not.toContain("gitlab.example.test");
    expect(await readdir(tmp)).toEqual([]);
    await expect(resolveThrowawayRemote(factory, CREDENTIALED_REMOTE)).rejects.toThrow(
      "--remote-url must be one uncredentialed Git remote URL.",
    );
    // Adjacent condition: this checkout's own origin with credentials is stripped, not refused.
    await git(factory, ["remote", "add", "origin", CREDENTIALED_REMOTE]);
    await expect(resolveThrowawayRemote(factory, undefined)).resolves.toEqual({
      source: "factory-origin",
      url: EXAMPLE_REMOTE,
    });
  });

  it("captures launcher output up to its catalogued bound and refuses past it", async () => {
    const bound = 64;
    const live = ["--live", "--remote-url", EXAMPLE_REMOTE];
    const atLimit = await stubLiveFactory(bound, bound);
    const passed = await runCli(atLimit.cli, atLimit.tmp, live);
    expect(passed.code).toBe(1);
    expect(passed.stderr).toContain("docsfab init exited 7: stand-in has no init");
    expect(passed.stderr).not.toContain(LAUNCHER_BOUND_REFUSAL);
    expect(await readdir(atLimit.tmp)).toEqual([]);

    const over = await stubLiveFactory(bound, bound + 1);
    const refused = await runCli(over.cli, over.tmp, live);
    expect(refused.code).toBe(1);
    expect(refused.stdout).toBe("");
    expect(refused.stderr).toContain(`${LAUNCHER_BOUND_REFUSAL}: stdout maxBuffer length exceeded`);
    expect(refused.stderr).toContain(`${LAUNCHER_MAX_BUFFER_LIMIT} = ${bound} bytes`);
    expect(refused.stderr).not.toContain("exited");
    expect(await readdir(over.tmp)).toEqual([]);
  });

  it("reads the launcher bound from the catalog mirror and refuses without it", async () => {
    await expect(
      readCatalogLimit(factoryRootFromRuntime(runtimeRoot), LAUNCHER_MAX_BUFFER_LIMIT),
    ).resolves.toMatchObject({ unit: "bytes", refusal: LAUNCHER_BOUND_REFUSAL });

    const { factory, cli, tmp } = await exportedFactory();
    await rm(join(factory, CATALOG));
    const { code, stderr } = await runCli(cli, tmp, []);
    expect(code).toBe(1);
    expect(stderr).toContain(
      `${CATALOG} is missing or unreadable; run \`npm run generate:limits\``,
    );
    expect(await readdir(tmp)).toEqual([]);

    await writeFile(join(factory, CATALOG), JSON.stringify({ limits: {} }));
    await expect(readCatalogLimit(factory, LAUNCHER_MAX_BUFFER_LIMIT)).rejects.toThrow(
      `${LAUNCHER_MAX_BUFFER_LIMIT} is not a registered byte bound`,
    );
    // Adjacent condition: a mirror that exists but cannot be read keeps its own cause.
    await rm(join(factory, CATALOG));
    await mkdir(join(factory, CATALOG));
    await expect(readCatalogLimit(factory, LAUNCHER_MAX_BUFFER_LIMIT)).rejects.toThrow(/EISDIR/u);
  });

  it("reports a launcher's exit status, and never one for a signal or spawn failure", async () => {
    const bound = { name: "n", value: 16, unit: "bytes", refusal: "r", remediation: "m" };
    const node = (source: string) => captureBounded(process.execPath, ["-e", source], {}, bound);
    const exited = node('process.stderr.write("e".repeat(16)); process.exitCode = 3');
    await expect(exited).resolves.toEqual({ stdout: "", stderr: "e".repeat(16), code: 3 });
    await expect(node('process.stderr.write("e".repeat(17))')).rejects.toThrow(
      "r: stderr maxBuffer length exceeded; exceeded n = 16 bytes. m",
    );
    const signalled = await node('process.kill(process.pid, "SIGKILL")').catch(
      (error: unknown) => error,
    );
    expect(signalled).toMatchObject({ signal: "SIGKILL" });
    const missing = captureBounded(join(runtimeRoot, "no-such-command"), [], {}, bound);
    await expect(missing).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses a credentialed or missing --remote-url instead of stripping it", () => {
    expect(() =>
      requireUncredentialedRemoteUrl("https://dogfood:example@gitlab.example.test/group/docs.git"),
    ).toThrow("--remote-url must be one uncredentialed Git remote URL.");
    expect(() => requireUncredentialedRemoteUrl("ssh://dogfood@gitlab.example.test/x")).toThrow(
      "--remote-url must be one uncredentialed Git remote URL.",
    );
    expect(requireUncredentialedRemoteUrl("git@gitlab.example.test:group/docs.git")).toBe(
      "git@gitlab.example.test:group/docs.git",
    );
    expect(parseCliArgs(["--remote-url", EXAMPLE_REMOTE, "--live"])).toEqual({
      live: true,
      keep: false,
      remoteUrl: EXAMPLE_REMOTE,
    });
    expect(() => parseCliArgs(["--remote-url"])).toThrow("--remote-url needs one Git remote URL.");
    expect(() => parseCliArgs(["--remote-url", "--live"])).toThrow(
      "--remote-url needs one Git remote URL.",
    );
    expect(() => parseCliArgs(["--remote-url", " --upload-pack=x"])).toThrow(
      "--remote-url needs one Git remote URL.",
    );
    expect(() =>
      parseCliArgs(["--remote-url", EXAMPLE_REMOTE, "--remote-url", EXAMPLE_REMOTE]),
    ).toThrow("Duplicated option: --remote-url");
  });
});
