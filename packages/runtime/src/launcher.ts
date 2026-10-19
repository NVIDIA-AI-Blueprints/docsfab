#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { readFileSync, realpathSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { untrustedChildEnvironment } from "./security/child-process-environment.js";
import { fileURLToPath } from "node:url";

import { ensureBuiltInProxy } from "./model/outbound-http-policy.js";
import { DOCSFAB_BUILD_IDENTITY } from "./build-identity.js";

export const MINIMUM_NODE_VERSION = "24.21.0";
const SUPPORTED_PLATFORMS = new Set<NodeJS.Platform>(["darwin", "linux"]);

interface PackageMetadata {
  name: string;
  version: string;
}

export function displayVersion(
  version: string,
  identity: { commit: string | null; dirty: boolean | null; releaseTag?: string | null },
): string {
  if (version.includes("-")) return `${version}${identity.dirty ? ".dirty" : ""}`;
  const verifiedCommit =
    typeof identity.commit === "string" && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(identity.commit);
  if (
    verifiedCommit &&
    identity.dirty === false &&
    identity.releaseTag?.startsWith(`v${version}`)
  ) {
    const tagVersion = identity.releaseTag.slice(1);
    if (tagVersion === version || /^-rc\.(0|[1-9]\d*)$/u.test(tagVersion.slice(version.length))) {
      return tagVersion;
    }
  }
  if (verifiedCommit) {
    return `${version}-dev+${identity.commit}${identity.dirty ? ".dirty" : ""}`;
  }
  return `${version}+unknown`;
}

/** Older compiled installs have no release companion and remain development builds. */
function compiledReleaseTag(): string | null {
  let source: string;
  try {
    source = readFileSync(new URL("./release-identity.js", import.meta.url), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  const match = /DOCSFAB_RELEASE_IDENTITY = Object\.freeze\((\{[\s\S]*?\})\);/u.exec(source);
  if (!match) return null;
  try {
    const value = JSON.parse(match[1]!) as { releaseTag?: unknown };
    return typeof value.releaseTag === "string" ? value.releaseTag : null;
  } catch {
    return null;
  }
}

function numericVersion(value: string): [number, number, number] | undefined {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/u.exec(value);
  if (!match) return undefined;
  const parts = match.slice(1, 4).map(Number);
  if (parts.some((part) => !Number.isSafeInteger(part))) return undefined;
  return [parts[0]!, parts[1]!, parts[2]!];
}

function before(left: [number, number, number], right: [number, number, number]): boolean {
  for (let index = 0; index < left.length; index += 1) {
    if (left[index]! < right[index]!) return true;
    if (left[index]! > right[index]!) return false;
  }
  return false;
}

export function runtimeCompatibilityIssue(
  nodeVersion: string,
  platform: NodeJS.Platform,
): string | undefined {
  if (!SUPPORTED_PLATFORMS.has(platform)) {
    return `DocsFab supports macOS and Linux; this machine reports ${platform}. Use a supported machine and retry.`;
  }
  const actual = numericVersion(nodeVersion);
  const minimum = numericVersion(MINIMUM_NODE_VERSION)!;
  if (!actual || before(actual, minimum)) {
    return `DocsFab requires Node.js >=${MINIMUM_NODE_VERSION}; found ${nodeVersion}. Install a supported Node.js release and retry.`;
  }
  return undefined;
}

export function commandRequiresGit(args: readonly string[]): boolean {
  return (
    args[0] === "init" ||
    args[0] === "run" ||
    args[0] === "publish" ||
    args[0] === "roadmap-plan" ||
    args[0] === "auto" ||
    (args[0] === "profile" && (args[1] === "approve" || args[1] === "rollback"))
  );
}

export function missingGitPrerequisite(
  run: (command: string) => boolean = (command) => {
    const result = spawnSync(command, ["--version"], {
      stdio: "ignore",
      env: untrustedChildEnvironment(process.env),
    });
    return !result.error && result.status === 0;
  },
): string | undefined {
  if (!run("git")) {
    return "This DocsFab command requires git. Install git, ensure it is on PATH, and retry.";
  }
  return undefined;
}

function packageMetadata(): PackageMetadata {
  const value = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  ) as Partial<PackageMetadata>;
  if (typeof value.name !== "string" || typeof value.version !== "string") {
    throw new Error("DocsFab package metadata is invalid. Reinstall DocsFab and retry.");
  }
  return { name: value.name, version: value.version };
}

export async function launch(args = process.argv.slice(2)): Promise<void> {
  const compatibilityIssue = runtimeCompatibilityIssue(process.versions.node, process.platform);
  if (compatibilityIssue) throw new Error(compatibilityIssue);

  if (args.length === 1 && args[0] === "--version") {
    console.log(
      displayVersion(packageMetadata().version, {
        ...DOCSFAB_BUILD_IDENTITY,
        releaseTag: compiledReleaseTag(),
      }),
    );
    return;
  }
  if (args.length === 0) {
    const { renderStartupOnboarding } = await import("./onboarding/startup.js");
    console.log(renderStartupOnboarding());
    return;
  }
  ensureBuiltInProxy();
  if (commandRequiresGit(args)) {
    const prerequisiteIssue = missingGitPrerequisite();
    if (prerequisiteIssue) throw new Error(prerequisiteIssue);
  }

  const { main } = await import("./cli.js");
  await main();
}

function isDirectInvocation(): boolean {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isDirectInvocation()) {
  launch().catch(async (error: unknown) => {
    const { reportLocalCliFailure } = await import("./operator/local-cli-failure.js");
    reportLocalCliFailure(error);
    process.exitCode = 1;
  });
}
