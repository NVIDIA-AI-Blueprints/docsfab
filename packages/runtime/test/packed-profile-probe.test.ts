// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFile } from "node:child_process";
import { cp, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import { installPackedDocsFab } from "../scripts/lib/packed-cli.mjs";
import { limit } from "../src/config/limits.js";
import { temporaryRoots } from "./helpers/temp.js";
import { testTimeoutMs } from "./helpers/test-timeouts.js";
import { childEnvironment, startProxyFixture } from "./support/outbound-proxy-fixture.js";

const execute = promisify(execFile);
const runtimeRoot = join(import.meta.dirname, "..");
const roots = temporaryRoots();
const FIXTURE_TIMEOUT_MS = limit("test.packedProfileFixtureLocalTimeoutMs").value;

async function buildPackedFixture(packageRoot: string, packRoot: string, env: NodeJS.ProcessEnv) {
  const packageInputs = [
    "README.md",
    "SECURITY.md",
    "bin",
    "governed-assets",
    "model-compositions",
    "npm-shrinkwrap.json",
    "package.json",
    "quality",
    "quality-pack",
    "skill-crate",
    "workflows",
  ];
  await mkdir(packageRoot);
  await execute(
    process.execPath,
    ["scripts/build-package.mjs", "--output-dir", join(packageRoot, "dist")],
    { cwd: runtimeRoot, env, timeout: FIXTURE_TIMEOUT_MS },
  );
  // build-package.mjs materializes the canonical repository LICENSE and
  // NOTICE files beside its isolated dist output. Do not copy ignored local
  // package staging from runtimeRoot, which is absent in a clean checkout.
  const copies = await Promise.allSettled(
    packageInputs.map((path) =>
      cp(join(runtimeRoot, path), join(packageRoot, path), { recursive: true }),
    ),
  );
  const rejected = copies.filter(
    (result): result is PromiseRejectedResult => result.status === "rejected",
  );
  if (rejected.length > 0) {
    throw new AggregateError(
      rejected.map((result) => result.reason),
      "package fixture copy failed",
    );
  }
  const docsDirectory = join(packageRoot, "docs", "get-started");
  await mkdir(docsDirectory, { recursive: true });
  await cp(
    join(runtimeRoot, "docs", "get-started", "installation-reference.md"),
    join(docsDirectory, "installation-reference.md"),
  );
  const packed = await execute(
    "npm",
    ["pack", "--ignore-scripts", "--json", "--pack-destination", packRoot],
    { cwd: packageRoot, env, timeout: FIXTURE_TIMEOUT_MS },
  );
  const [record] = JSON.parse(packed.stdout) as Array<{ filename: string }>;
  if (!record?.filename) throw new Error("isolated npm pack returned no tarball filename");
  return join(packRoot, record.filename);
}

describe("packed installed profile probe", () => {
  it(
    "runs --live through the installed CLI and returns the localhost stub verdict",
    async () => {
      const root = await roots.create("docsfab-packed-profile-probe-");
      const closers: Array<() => Promise<void>> = [];
      try {
        const proxy = await startProxyFixture(
          roots,
          closers,
          "docsfab-packed-profile-probe-proxy-",
        );
        const packageRoot = join(root, "package");
        const packRoot = join(root, "pack");
        const installRoot = join(root, "install");
        const outsideRoot = join(root, "outside");
        await Promise.all([mkdir(packRoot), mkdir(installRoot), mkdir(outsideRoot)]);
        const env = {
          ...process.env,
          npm_config_cache: join(root, "npm-cache"),
          npm_config_audit: "false",
          npm_config_fund: "false",
          npm_config_update_notifier: "false",
        };
        const tarball = await buildPackedFixture(packageRoot, packRoot, env);
        const installed = await installPackedDocsFab({
          tarball,
          installRoot,
          cwd: outsideRoot,
          env,
        });

        const childEnv = childEnvironment(proxy, {
          HTTPS_PROXY: proxy.proxyUrl,
          NODE_USE_ENV_PROXY: "1",
          MODEL_API_KEY: "packed-install-stub-key",
        });
        let result: { stdout: string };
        try {
          result = await execute(
            process.execPath,
            [
              "--import",
              proxy.dnsGuardPath,
              installed.executable,
              "profile",
              "probe",
              "--route",
              "openai-api",
              "--model",
              "gpt-4.1-mini",
              "--live",
              "--json",
            ],
            { cwd: outsideRoot, env: childEnv, timeout: FIXTURE_TIMEOUT_MS },
          );
        } catch (error) {
          const stderr =
            error && typeof error === "object" && "stderr" in error
              ? String(error.stderr)
              : String(error);
          throw new Error(`Installed packed CLI failed: ${stderr}`, { cause: error });
        }

        const observation = JSON.parse(result.stdout) as {
          live: boolean;
          locator: string;
          verdict: string;
          compatibility: unknown;
        };
        expect(observation.live).toBe(true);
        expect(observation.locator).toBe("openai-api:gpt-4.1-mini");
        expect(observation.verdict, JSON.stringify(observation)).toBe("harness-compatible");
        expect(observation.compatibility).not.toBeNull();
        expect(proxy.targetRequests.length).toBeGreaterThan(0);
        expect(proxy.targetRequests.every((request) => request.host === "api.openai.com")).toBe(
          true,
        );
        expect(proxy.proxyLog.every((entry) => entry.proxyAuthorization === undefined)).toBe(true);
      } finally {
        const closeResults = await Promise.allSettled(
          closers
            .splice(0)
            .reverse()
            .map((close) => close()),
        );
        const closeErrors = closeResults.flatMap((result) =>
          result.status === "rejected" ? [result.reason] : [],
        );
        if (closeErrors.length > 0) {
          throw new AggregateError(closeErrors, "packed profile probe fixture cleanup failed");
        }
      }
    },
    testTimeoutMs(FIXTURE_TIMEOUT_MS),
  );
});
