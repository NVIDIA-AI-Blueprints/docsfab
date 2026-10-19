#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Vitest launcher for CI tiers.
 *
 *   node scripts/vitest-ci.mjs fast [-- --shard=k/n] [-- …]
 *   node scripts/vitest-ci.mjs isolation [-- …]          # all heavy domains
 *   node scripts/vitest-ci.mjs isolation:delivery|profile|docs [-- …]
 *   node scripts/vitest-ci.mjs smoke [-- …]
 *
 * Heavy files live under scripts/ci-heavy/*.txt so domains can run in
 * parallel CI jobs without lowering coverage. `fast --shard=k/n` runs the files
 * of runtime:test lane k of n, split by recorded duration in coverage-shards.mjs,
 * instead of Vitest's own `--shard` split.
 */
import { spawnSync } from "node:child_process";
import { offlineTestEnvironment } from "./offline-test-environment.mjs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  allHeavyFiles,
  assertHeavyManifestMatchesDomains,
  isolationDomains,
  readList,
} from "./check-ci-heavy-manifest.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const heavyRoot = join(root, "scripts/ci-heavy");

/** L0 smoke: a frozen set of core-surface files. */
export const smokeFiles = [
  "test/semantic-evaluation.test.ts",
  "test/release-artifact.test.ts",
  "test/cli-arguments.test.ts",
  "test/provider.test.ts",
  "test/launcher.test.ts",
  "test/json-evidence.test.ts",
  "test/channels-slack-notify.test.ts",
  "test/observation-apparatus.test.ts",
  "test/operator-status-block.test.ts",
  "test/host-progress.test.ts",
  "test/product-test.test.ts",
  "test/ci-smoke-membership.test.ts",
];

function domainFiles(domain) {
  if (!isolationDomains.includes(domain)) {
    throw new Error(`unknown isolation domain: ${domain}`);
  }
  return readList(join(heavyRoot, `${domain}.txt`));
}

/** Remove `--shard=k/n` or `--shard k/n` from args and return {index, total}, or null. */
export function takeShard(args) {
  const at = args.findIndex((arg) => arg === "--shard" || arg.startsWith("--shard="));
  if (at === -1) return null;
  const separate = args[at] === "--shard";
  const value = separate ? args[at + 1] : args[at].slice("--shard=".length);
  const match = /^(\d+)\/(\d+)$/u.exec(value ?? "");
  const index = Number(match?.[1]);
  const total = Number(match?.[2]);
  if (!match || index < 1 || index > total) {
    throw new Error(`--shard ${value ?? ""} is not k/n with 1 <= k <= n`);
  }
  args.splice(at, separate ? 2 : 1);
  return { index, total };
}

async function runCli() {
  const mode = process.argv[2];
  const passthrough = process.argv.slice(3);

  if (!mode) {
    console.error(
      "usage: node scripts/vitest-ci.mjs <fast|isolation|isolation:domain|smoke> [-- vitest-args…]",
    );
    process.exit(2);
  }

  assertHeavyManifestMatchesDomains();

  const args = ["vitest", "run"];
  const heavy = allHeavyFiles();

  if (mode === "smoke") {
    args.push(...smokeFiles);
  } else if (mode === "isolation") {
    args.push(...heavy);
  } else if (mode.startsWith("isolation:")) {
    const domain = mode.slice("isolation:".length);
    args.push(...domainFiles(domain));
  } else if (mode === "fast") {
    for (const path of heavy) {
      args.push("--exclude", path);
    }
    const shard = takeShard(passthrough);
    if (shard) {
      const { fastShardFiles } = await import("./coverage-shards.mjs");
      const files = await fastShardFiles(shard);
      // Empty positional filters would make Vitest run the whole fast lane.
      if (files.length === 0) {
        console.log(`fast shard ${shard.index}/${shard.total}: 0 assigned files; no tests run`);
        return;
      }
      args.push(...files);
    }
  } else {
    console.error(
      "usage: node scripts/vitest-ci.mjs <fast|isolation|isolation:domain|smoke> [-- vitest-args…]",
    );
    process.exit(2);
  }

  args.push(...passthrough);

  const env = offlineTestEnvironment();
  if (process.env.CI && env.PI_OFFLINE == null) {
    env.PI_OFFLINE = "1";
  }

  const result = spawnSync("npx", args, {
    cwd: root,
    env,
    stdio: "inherit",
    shell: false,
  });

  process.exit(result.status === null ? 1 : result.status);
}

const invoked = process.argv[1] ? resolve(process.argv[1]) : "";
const isMain = invoked === fileURLToPath(import.meta.url);
if (isMain) {
  runCli().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(2);
  });
}
