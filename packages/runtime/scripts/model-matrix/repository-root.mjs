// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The repository that holds these harness scripts.
 *
 * `${REPO}` in a matrix config means this checkout, wherever the config file
 * itself lives. Resolved from this module's real path, so a symlinked script
 * directory or a config kept in another repository cannot redirect it.
 */
import { existsSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function harnessRepositoryRoot() {
  const here = dirname(realpathSync(fileURLToPath(import.meta.url)));
  const root = resolve(here, "..", "..", "..", "..");
  if (!existsSync(join(root, "packages", "runtime", "package.json"))) {
    throw new Error(
      `The model-matrix scripts at ${here} are not inside a DocsFab checkout (no packages/runtime/package.json under ${root}).`,
    );
  }
  return root;
}
