// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Verify one candidate projection's `source` binding.
 *
 * A candidate source must live under this package's model-compositions/sources/
 * directory: the runtime ships and is exported without the repository's
 * internal trees, so a source anywhere else would make `check:pins` depend on
 * files a public checkout does not have.
 */
import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { resolve, sep } from "node:path";

export const CANDIDATE_SOURCES_DIRECTORY = "packages/runtime/model-compositions/sources";

export class CandidateSourceBindingError extends Error {
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.name = "CandidateSourceBindingError";
    this.code = code;
  }
}

function within(root, path) {
  return path.startsWith(`${root}${sep}`);
}

export async function verifyCandidateSource({ repositoryRoot, locator, sha256 }) {
  const sourcesRoot = resolve(repositoryRoot, CANDIDATE_SOURCES_DIRECTORY);
  const sourcePath = resolve(repositoryRoot, locator);
  if (!within(sourcesRoot, sourcePath)) {
    throw new CandidateSourceBindingError(
      "candidate-source-outside-runtime",
      `candidate source ${locator} is outside ${CANDIDATE_SOURCES_DIRECTORY}/; move the source there, re-point the locator, and reseal`,
    );
  }
  let realSourcePath;
  try {
    realSourcePath = await realpath(sourcePath);
  } catch (error) {
    // Only an absent file is a missing source; any other failure is not ours to name.
    if (error?.code !== "ENOENT") throw error;
    throw new CandidateSourceBindingError(
      "candidate-source-missing",
      `candidate source ${locator} does not exist; restore it or re-point the locator, then reseal`,
    );
  }
  // A symlink inside the directory must not reach a file outside it.
  if (!within(await realpath(sourcesRoot), realSourcePath)) {
    throw new CandidateSourceBindingError(
      "candidate-source-outside-runtime",
      `candidate source ${locator} resolves outside ${CANDIDATE_SOURCES_DIRECTORY}/; replace the link with the file`,
    );
  }
  const actual = createHash("sha256")
    .update(await readFile(realSourcePath))
    .digest("hex");
  if (actual !== sha256) {
    throw new CandidateSourceBindingError(
      "candidate-source-digest-stale",
      `candidate source digest is stale: ${locator}; run scripts/reseal-candidate-source-digests.mts`,
    );
  }
}
