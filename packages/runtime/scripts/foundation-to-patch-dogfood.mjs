#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Offline foundation-to-patch dogfood helper.
 *
 * Default mode runs the offline Vitest dogfood suite (no credentials / network
 * required for the product grade). Optional `--pack` exercises the packed
 * installed-package surface via scripts/lib/packed-cli.mjs. Optional
 * `--self-dogfood` is gated by DOCSFAB_FOUNDATION_TO_PATCH_SELF_DOGFOOD and is
 * non-blocking for merge when the offline grade is green.
 *
 * Never prints credentials, host home paths, or raw model transcripts.
 */

import { execFile } from "node:child_process";
import { mkdtemp, readFile, realpath, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { installPackedDocsFab, packDocsFab } from "./lib/packed-cli.mjs";
import { internalContentPath } from "../src/config/internal-content.js";

const execute = promisify(execFile);
const MAX_BUFFER = 16 * 1024 * 1024;
const projectRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));

const args = new Set(process.argv.slice(2));
const wantPack = args.has("--pack");
const wantSelf = args.has("--self-dogfood");
const selfGate = process.env.DOCSFAB_FOUNDATION_TO_PATCH_SELF_DOGFOOD === "1";

function fail(message) {
  throw new Error(`Foundation-to-patch dogfood failed: ${message}`);
}

function scrubEnv(base) {
  const env = { ...base };
  for (const key of Object.keys(env)) {
    if (/(?:TOKEN|SECRET|PASSWORD|API[_-]?KEY|CREDENTIAL)/iu.test(key)) {
      delete env[key];
    }
  }
  env.PI_OFFLINE = "1";
  env.CI = env.CI ?? "1";
  delete env.DOCSFAB_ROADMAP_GITLAB_HOST;
  return env;
}

async function runOfflineSuite() {
  const env = scrubEnv(process.env);
  await execute("npx", ["vitest", "run", internalContentPath("foundationDogfoodTest")], {
    cwd: projectRoot,
    env,
    maxBuffer: MAX_BUFFER,
  });
  console.log("offline dogfood suite: pass");
}

async function runPackedSmoke() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "docsfab-ftp-dogfood-")));
  try {
    const packDestination = join(root, "pack");
    const installRoot = join(root, "install");
    await mkdir(packDestination, { recursive: true });
    await mkdir(installRoot, { recursive: true });

    const env = scrubEnv(process.env);
    const { tarball } = await packDocsFab({
      projectRoot,
      packDestination,
      env,
    });
    const { executable } = await installPackedDocsFab({
      tarball,
      installRoot,
      cwd: root,
      env,
      offline: false,
    });

    const fixture = join(root, "fixture");
    await mkdir(fixture, { recursive: true });
    await writeFile(join(fixture, "README.md"), "# Dogfood fixture\n");
    await writeFile(join(fixture, "AGENTS.md"), "# Agents\n");
    await mkdir(join(fixture, "docs"), { recursive: true });
    await writeFile(join(fixture, "docs", "guide.md"), "# Guide\n");
    await execute("git", ["init", "-q"], { cwd: fixture });
    await execute("git", ["config", "user.email", "dogfood@example.test"], { cwd: fixture });
    await execute("git", ["config", "user.name", "Dogfood"], { cwd: fixture });
    await execute("git", ["add", "."], { cwd: fixture });
    await execute("git", ["commit", "-q", "-m", "dogfood fixture"], { cwd: fixture });

    const result = await execute(
      executable,
      [
        "do",
        "Turn a ready documentation foundation into a governed patch",
        "--repo",
        fixture,
        "--json",
      ],
      {
        cwd: root,
        env: scrubEnv({
          ...process.env,
          PATH: `${join(installRoot, "bin")}:${process.env.PATH ?? ""}`,
        }),
        maxBuffer: MAX_BUFFER,
      },
    ).catch((error) => error);

    const stdout = String(result.stdout ?? "");
    const stderr = String(result.stderr ?? "");
    const combined = `${stdout}\n${stderr}`;
    if (/(?:\/Users\/|\/home\/|glpat-|sk-)/u.test(combined)) {
      fail("packed smoke leaked host path or credential material");
    }
    if (!/foundation-to-patch|docsfab-outcome-route|docsfab-run-result/u.test(combined)) {
      fail("packed smoke did not exercise outcome router / foundation-to-patch surface");
    }
    console.log("packed installed-package smoke: pass");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function runSelfDogfoodGate() {
  if (!selfGate) {
    console.log(
      "gated self-dogfood: skipped (set DOCSFAB_FOUNDATION_TO_PATCH_SELF_DOGFOOD=1 to enable; non-blocking)",
    );
    return;
  }
  fail(
    "self-dogfood gate is set, but this helper does not mint live credentials or publish transcripts; run an operator-owned live session and keep evidence private",
  );
}

async function assertScorecardPresent() {
  const scorecardPath = join(projectRoot, internalContentPath("foundationDogfoodScorecard"));
  const raw = await readFile(scorecardPath, "utf8");
  const scorecard = JSON.parse(raw);
  if (
    scorecard.decision !== "proceed" &&
    scorecard.decision !== "iterate" &&
    scorecard.decision !== "stop"
  ) {
    fail("scorecard decision must be proceed, iterate, or stop");
  }
  if (/(?:\/Users\/|\/home\/|glpat-|sk-)/u.test(raw)) {
    fail("committed scorecard contains host path or credential material");
  }
  console.log(`scorecard decision: ${scorecard.decision}`);
}

async function main() {
  await assertScorecardPresent();
  await runOfflineSuite();
  if (wantPack) {
    await runPackedSmoke();
  } else {
    console.log("packed smoke: skipped (pass --pack to exercise installed package)");
  }
  if (wantSelf) {
    await runSelfDogfoodGate();
  } else {
    console.log("gated self-dogfood: skipped (non-blocking; pass --self-dogfood to request)");
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
