// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { realpathSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { executionProfileIdentity } from "../src/config/execution-profile.js";
import { runSetupBootstrap } from "../src/setup/bootstrap.js";

/**
 * Installed composition the live-model CI jobs bind: `runtime:live-model`,
 * `runtime:live-journey`, `runtime:mr-assessment`, and
 * `runtime:workflow-canary` all prepare their configuration root here, and
 * `live-journey-gate.mts` seals this same id into its hosted requests.
 *
 * `nvidia-inference-claude-sonnet-5-pi` stays installed as a
 * secondary record on the same route and credential family, so one
 * `MODEL_API_KEY` source serves both.
 */
export const LIVE_MODEL_CI_COMPOSITION_ID = "nvidia-inference-gpt-6-sol-pi";

export function liveModelApproveUrl(): string {
  return executionProfileIdentity(LIVE_MODEL_CI_COMPOSITION_ID).baseUrl;
}

/**
 * Canonical path, tolerating a target that does not exist yet.
 *
 * `resolve` collapses `..` lexically but does not follow symlinks, so a root
 * reached through one would compare as outside the checkout while writing
 * inside it. Resolve the nearest existing ancestor and re-append the missing
 * tail, because the configuration root is usually created by this script.
 */
function canonicalPath(target: string): string {
  const absolute = resolve(target);
  const trailing: string[] = [];
  let current = absolute;
  for (;;) {
    try {
      return join(realpathSync(current), ...trailing);
    } catch {
      const parent = dirname(current);
      // Reached the filesystem root with nothing resolvable.
      if (parent === current) return absolute;
      trailing.unshift(basename(current));
      current = parent;
    }
  }
}

/**
 * Refuse a configuration root inside the checkout.
 *
 * This writes `secrets.env` containing MODEL_API_KEY. The checkout is what
 * CI collects as artifacts, so a root pointed anywhere inside it would
 * publish the credential to anyone who can download them. DOCSFAB_CONFIG_ROOT
 * is supplied by the job definition, but a manual job's player can override a
 * CI/CD variable at play time, so the value is not trusted -- it is checked.
 *
 * Both sides are canonicalised: raw paths let a symlink walk back into the
 * checkout (`/proc/self/cwd/...`), and one-sided canonicalisation mismatches
 * when the checkout itself sits under a symlink (macOS `/tmp`).
 */
export function refuseConfigurationRootInCheckout(
  configurationRoot: string,
  projectDirectory: string | undefined,
): void {
  const project = projectDirectory?.trim();
  if (!project) return;
  const root = canonicalPath(configurationRoot);
  const checkout = canonicalPath(project);
  if (root === checkout || root.startsWith(`${checkout}${sep}`)) {
    throw new Error(
      "DOCSFAB_CONFIG_ROOT must be outside CI_PROJECT_DIR. It resolves to " +
        `${root}, which is inside the collected checkout ${checkout}. ` +
        "This script writes secrets.env there, so that would publish " +
        "MODEL_API_KEY in the job artifacts.",
    );
  }
}

export async function prepareLiveModelCiConfig(input: {
  readonly configurationRoot: string;
  readonly modelApiKey: string;
  readonly projectDirectory?: string | undefined;
}): Promise<void> {
  const key = input.modelApiKey.trim();
  if (!key) {
    throw new Error("prepare-live-model-ci-config requires a non-empty MODEL_API_KEY.");
  }
  refuseConfigurationRootInCheckout(input.configurationRoot, input.projectDirectory);
  const result = await runSetupBootstrap({
    profile: LIVE_MODEL_CI_COMPOSITION_ID,
    purpose: "setup",
    environment: {
      ...process.env,
      DOCSFAB_CONFIG_ROOT: input.configurationRoot,
      MODEL_API_KEY: key,
    },
  });
  if (result.status !== "ready") {
    throw new Error(`supported setup ${result.status}; run docsfab setup.`);
  }
}

async function main(argv: string[]): Promise<void> {
  if (argv.includes("--print-approve-url")) {
    process.stdout.write(`${liveModelApproveUrl()}\n`);
    return;
  }
  const configurationRoot = process.env.DOCSFAB_CONFIG_ROOT?.trim();
  const modelApiKey = process.env.MODEL_API_KEY ?? "";
  if (!configurationRoot) {
    throw new Error("DOCSFAB_CONFIG_ROOT must be set to the live-model configuration root.");
  }
  await prepareLiveModelCiConfig({
    configurationRoot,
    modelApiKey,
    projectDirectory: process.env.CI_PROJECT_DIR,
  });
}

const invokedPath = process.argv[1] ? realpathSync(resolve(process.argv[1])) : undefined;
if (invokedPath === realpathSync(fileURLToPath(import.meta.url))) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`prepare-live-model-ci-config: ${message}`);
    process.exitCode = 1;
  });
}
