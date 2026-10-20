// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { delimiter, dirname, join, resolve } from "node:path";

import { describe, expect, it, onTestFinished } from "vitest";
import { parseCredentialSafeGrepRequest } from "../src/harness/credential-safe-grep-worker.js";
import { temporaryRoots } from "./helpers/temp.js";

const roots = temporaryRoots();
const SDK_PROCESS_TEST_TIMEOUT_MS = 30_000;
const sentinelNames = [
  "MODEL_API_KEY",
  "OPENAI_API_KEY",
  "GITLAB_TOKEN",
  "GITHUB_TOKEN",
  "CI_JOB_TOKEN",
  "AWS_SECRET_ACCESS_KEY",
];

async function existingRg(): Promise<string> {
  // Filesystem lookup only: never execute an ambient PATH probe with host credentials.
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    const candidate = join(directory, "rg");
    try {
      await access(candidate, constants.X_OK);
      return await realpath(candidate);
    } catch {
      /* Try the next file. */
    }
  }
  throw new Error(
    "Resolver sentinel qualification requires an already installed ripgrep executable.",
  );
}

async function runHarness(mode: string, offline: boolean, missing = false) {
  const root = await roots.create("docsfab-resolver-sentinel-");
  const home = join(root, "home");
  const agent = join(root, "pi-agent");
  const bin = join(root, "bin");
  const scratch = join(root, "scratch");
  for (const path of [home, agent, bin, scratch]) await mkdir(path);
  const actualRg = await existingRg();
  if (!missing)
    await writeFile(
      join(bin, "rg"),
      `#!${process.execPath}
const fs = require("node:fs");
const { spawn } = require("node:child_process");
const names = ${JSON.stringify(sentinelNames)};
const version = process.argv.includes("--version");
fs.appendFileSync(${JSON.stringify(join(root, "probes.jsonl"))}, JSON.stringify({ phase: version ? "version" : "search", pid: process.pid, secretKeysPresent: Object.fromEntries(names.map(name => [name, Object.hasOwn(process.env, name)])) }) + "\\n");
if (version && ${JSON.stringify(mode)} === "abort-probe") { process.on("SIGTERM", () => {}); setInterval(() => {}, 1000); }
else if (version) console.log("ripgrep 14.1.0");
else { const child = spawn(${JSON.stringify(actualRg)}, process.argv.slice(2), {stdio:"inherit"}); for(const signal of ["SIGTERM","SIGINT"])process.on(signal,()=>child.kill(signal));child.on("error",()=>{process.exitCode=2});child.on("close",code=>{process.exitCode=code ?? 2}); }
`,
      { mode: 0o700 },
    );
  // The tested parent itself receives only this explicit environment. Real
  // model/SCM credentials are never inherited by any diagnostic command.
  const environment: NodeJS.ProcessEnv = {
    PATH: missing ? bin : `${bin}${delimiter}${dirname(process.execPath)}`,
    HOME: home,
    TMPDIR: scratch,
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    PI_CODING_AGENT_DIR: agent,
    PI_OFFLINE: offline ? "1" : "0",
    ...Object.fromEntries(
      sentinelNames.map((name) => [name, `synthetic-${name.toLowerCase()}-${randomUUID()}`]),
    ),
  };
  const controller = new AbortController();
  onTestFinished(() => controller.abort());
  const child = spawn(
    process.execPath,
    [
      "--import",
      import.meta.resolve("tsx"),
      resolve(import.meta.dirname, "helpers/grep-resolver-sentinel.ts"),
      root,
      mode,
    ],
    {
      env: environment,
      cwd: root,
      stdio: ["ignore", "pipe", "pipe"],
      signal: controller.signal,
    },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString();
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const code = await new Promise<number | null>((done, reject) => {
    child.on("error", reject);
    child.on("close", done);
  });
  expect(code, stderr).toBe(0);
  const receipt = JSON.parse(stdout.trim());
  expect(receipt.parentSentinelsIntact).toBe(true);
  expect(
    receipt.observations.every((row: { secretKeysPresent: Record<string, boolean> }) =>
      Object.values(row.secretKeysPresent).every((present) => !present),
    ),
  ).toBe(true);
  expect(await readdir(agent)).toEqual([]);
  expect(
    (await readdir(scratch)).filter((name) => name.startsWith("docsfab-quality-grep-")),
  ).toEqual([]);
  return receipt;
}

describe("SDK ripgrep resolution stays below the credential boundary", () => {
  it.each([true, false])(
    "keeps generated provider/SCM secrets away from real SDK PATH probes with offline=%s",
    async (offline) => {
      const receipt = await runHarness("guarded", offline);
      expect(receipt).toMatchObject({ status: "passed", useful: true, historicalAbsent: true });
      expect(receipt.observations.some((row: { phase: string }) => row.phase === "version")).toBe(
        true,
      );
    },
    SDK_PROCESS_TEST_TIMEOUT_MS,
  );

  it(
    "keeps ordinary SDK search useful under the same minimized execution",
    async () => {
      expect(await runHarness("plain", true)).toMatchObject({ status: "passed", useful: true });
    },
    SDK_PROCESS_TEST_TIMEOUT_MS,
  );

  it(
    "preserves offline missing-tool refusal without downloading or changing SDK state",
    async () => {
      expect(await runHarness("guarded", true, true)).toMatchObject({
        status: "refused",
        message: expect.stringContaining("ripgrep is unavailable"),
      });
    },
    SDK_PROCESS_TEST_TIMEOUT_MS,
  );

  it(
    "settles resolver/probe descendants on cancellation",
    async () => {
      const receipt = await runHarness("abort-probe", true);
      expect(receipt.status).toBe("refused");
      expect(receipt.processStates.every((row: { alive: boolean }) => !row.alive)).toBe(true);
    },
    SDK_PROCESS_TEST_TIMEOUT_MS,
  );

  it.each(["prefix-packages", "prefix-quality"])(
    "keeps read and grep useful when a historical marker prefix is an ordinary file: %s",
    async (mode) => {
      expect(await runHarness(mode, true)).toMatchObject({
        status: "passed",
        useful: true,
        readUseful: true,
      });
    },
    SDK_PROCESS_TEST_TIMEOUT_MS,
  );

  it("rejects parent-supplied executable authority rather than accepting a new probe path", () => {
    expect(() =>
      parseCredentialSafeGrepRequest({
        schemaVersion: 1,
        type: "request",
        id: "strict",
        cwd: "/workspace",
        grants: { workspaceRoot: "/workspace" },
        params: { pattern: "public" },
        rgExecutable: "/usr/bin/rg",
      }),
    ).toThrow();
  });
});
