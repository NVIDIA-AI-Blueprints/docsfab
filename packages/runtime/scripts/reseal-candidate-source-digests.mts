#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** Rebind generated candidate projections after governed source bytes change. */

import { createHash } from "node:crypto";
import { readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { canonicalDigest } from "../src/content-ir/canonical.js";

const defaultRuntimeRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const defaultRepositoryRoot = resolve(defaultRuntimeRoot, "..", "..");
const repositoryRoot = await realpath(repositoryRootArgument() ?? defaultRepositoryRoot);
const runtimeRoot = resolve(repositoryRoot, "packages", "runtime");
const assetsRoot = resolve(runtimeRoot, "model-compositions");
const projectionsPath = resolve(assetsRoot, "candidate-projections.json");
const manifestPath = resolve(assetsRoot, "installed-manifest.json");
const installedPath = resolve(runtimeRoot, "src/model-composition/installed-manifest-pin.js");

const sha256 = (value: Buffer | string): string =>
  createHash("sha256").update(value).digest("hex");

function repositoryRootArgument(): string | null {
  const args = process.argv.slice(2);
  if (args.length === 0) return null;
  if (args.length !== 2 || args[0] !== "--repository-root" || !args[1]) {
    throw new Error("usage: reseal-candidate-source-digests.mts [--repository-root PATH]");
  }
  return resolve(args[1]);
}

function withoutKey(
  value: Record<string, unknown>,
  key: string,
): Record<string, unknown> {
  const { [key]: _omitted, ...rest } = value;
  return rest;
}

function pretty(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

const projections = JSON.parse(await readFile(projectionsPath, "utf8")) as {
  registrySha256: string;
  candidates: Array<{
    candidateSha256: string;
    source: { locator: string; sha256: string };
  } & Record<string, unknown>>;
} & Record<string, unknown>;
if (!Array.isArray(projections.candidates)) throw new Error("candidate registry is malformed");

const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
  installedManifestSha256: string;
  assets: Array<{
    kind: string;
    path: string;
    fileSha256: string;
    contractSha256: string;
  }>;
} & Record<string, unknown>;
if (!Array.isArray(manifest.assets)) throw new Error("installed manifest is malformed");

const installedSource = await readFile(installedPath, "utf8");
const pinPattern = /(const EXPECTED_INSTALLED_MANIFEST_FILE_SHA256 =\s*\n?\s*")([a-f0-9]{64})(";)/u;
if (!pinPattern.test(installedSource)) {
  throw new Error("installed manifest source pin is missing");
}

let sourceChanges = 0;
for (const candidate of projections.candidates) {
  if (
    !candidate.source ||
    typeof candidate.source.locator !== "string" ||
    typeof candidate.source.sha256 !== "string" ||
    typeof candidate.candidateSha256 !== "string"
  ) {
    throw new Error("candidate source binding is malformed");
  }
  const sourcePath = await realpath(resolve(repositoryRoot, candidate.source.locator));
  if (sourcePath !== repositoryRoot && !sourcePath.startsWith(`${repositoryRoot}${sep}`)) {
    throw new Error(`candidate source escaped repository: ${candidate.source.locator}`);
  }
  const sourceSha256 = sha256(await readFile(sourcePath));
  if (candidate.source.sha256 !== sourceSha256) {
    candidate.source.sha256 = sourceSha256;
    sourceChanges += 1;
  }
  candidate.candidateSha256 = canonicalDigest(withoutKey(candidate, "candidateSha256"));
}
projections.registrySha256 = canonicalDigest(withoutKey(projections, "registrySha256"));
const projectionBytes = pretty(projections);

const projectionAsset = manifest.assets.find(
  (asset) => asset.kind === "candidate-projections" && asset.path === "candidate-projections.json",
);
if (!projectionAsset) throw new Error("candidate-projections manifest asset is missing");
projectionAsset.fileSha256 = sha256(projectionBytes);
projectionAsset.contractSha256 = projections.registrySha256;
manifest.installedManifestSha256 = canonicalDigest(
  withoutKey(manifest, "installedManifestSha256"),
);
const manifestBytes = pretty(manifest);
const nextInstalledSource = installedSource.replace(
  pinPattern,
  `$1${sha256(manifestBytes)}$3`,
);

await replaceOutputsAtomically([
  { path: projectionsPath, contents: projectionBytes },
  { path: manifestPath, contents: manifestBytes },
  { path: installedPath, contents: nextInstalledSource },
]);

console.log(
  `Resealed ${projections.candidates.length} candidates; ${sourceChanges} source digest(s) changed.`,
);

async function replaceOutputsAtomically(
  outputs: readonly { path: string; contents: string }[],
): Promise<void> {
  const staged: Array<{ path: string; temporaryPath: string }> = [];
  try {
    for (const [index, output] of outputs.entries()) {
      const temporaryPath = `${output.path}.docsfab-reseal-${process.pid}-${index}`;
      const mode = (await stat(output.path)).mode & 0o777;
      await writeFile(temporaryPath, output.contents, { flag: "wx", mode });
      staged.push({ path: output.path, temporaryPath });
    }
    for (const output of staged) await rename(output.temporaryPath, output.path);
  } finally {
    await Promise.all(staged.map((output) => rm(output.temporaryPath, { force: true })));
  }
}
