#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Build and retain the one package candidate consumed by downstream installed
 * acceptance jobs. This records identity and integrity; acceptance and release
 * authority remain with the later package verification gate.
 */
import { mkdtemp, mkdir, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { preparePackedCandidate, retainPackedArtifact } from "./lib/packed-cli.mjs";

function resolveFinalVersion(packageJson, env) {
  const tag = env.CI_COMMIT_TAG;
  if (tag && /^v\d+\.\d+\.\d+$/u.test(tag)) {
    if (tag !== `v${packageJson.version}`) {
      throw new Error("release tag does not match the source package version");
    }
    return packageJson.version;
  }
  if (env.CI_COMMIT_BRANCH && env.CI_COMMIT_BRANCH === env.CI_DEFAULT_BRANCH) {
    if (!env.CI_COMMIT_SHORT_SHA || !/^[a-f0-9]{7,12}$/u.test(env.CI_COMMIT_SHORT_SHA)) {
      throw new Error("default-branch package preparation requires CI_COMMIT_SHORT_SHA");
    }
    if (packageJson.version.includes("-")) {
      throw new Error("source package version must not already carry a prerelease suffix");
    }
    return `${packageJson.version}-main.${env.CI_COMMIT_SHORT_SHA}`;
  }
  return packageJson.version;
}

function parseArguments(argv) {
  if (
    argv.length !== 2 ||
    argv[0] !== "--output-dir" ||
    isAbsolute(argv[1]) ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(argv[1])
  ) {
    throw new Error(
      "Packed candidate preparation requires --output-dir <safe package-relative leaf>.",
    );
  }
  return argv[1];
}

export async function preparePackedCli({ argv, env, projectRoot, log = console.log }) {
  const outputLeaf = parseArguments(argv);
  const sourceRevision = env.CI_COMMIT_SHA;
  if (!sourceRevision || !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(sourceRevision)) {
    throw new Error("Packed candidate preparation requires one full CI_COMMIT_SHA revision.");
  }

  const temporaryRoot = await realpath(await mkdtemp(join(tmpdir(), "docsfab-package-candidate-")));
  try {
    const packageJson = JSON.parse(await readFile(join(projectRoot, "package.json"), "utf8"));
    const sourceVersion = packageJson.version;
    const finalVersion = resolveFinalVersion(packageJson, env);
    const packageEnvironment = { ...env, DOCSFAB_PACKAGE_FINAL_VERSION: finalVersion };
    const packDestination = join(temporaryRoot, "pack");
    await mkdir(packDestination);
    const candidate = await preparePackedCandidate({
      projectRoot,
      packDestination,
      env: packageEnvironment,
    });
    const sourceClean = candidate.sourceClean;
    const retained = await retainPackedArtifact({
      projectRoot,
      artifactRoot: resolve(projectRoot, outputLeaf),
      tarball: candidate.tarball,
      record: candidate.record,
      sourceRevision,
      sourceVersion,
      sourceClean,
    });
    log(
      `Prepared packed candidate ${retained.name}@${retained.version} integrity ${retained.integrity}; source revision ${retained.sourceRevision}; source clean ${sourceClean}.`,
    );
    return retained;
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : undefined;
if (invokedPath === fileURLToPath(import.meta.url)) {
  const projectRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
  preparePackedCli({ argv: process.argv.slice(2), env: process.env, projectRoot }).catch(
    (error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    },
  );
}
