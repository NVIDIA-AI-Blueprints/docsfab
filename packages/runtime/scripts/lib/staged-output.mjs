// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { rename as renamePath, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

/**
 * Build into a sibling staging directory and swap it in only after every step
 * succeeds. A failed build leaves the previous `target` untouched, so the
 * source-checkout launcher never sees a fresh `launcher.js` beside missing
 * modules. The sibling keeps the same depth, so emitted source-map paths hold.
 *
 * @param {string} target
 * @param {(staging: string) => Promise<void>} build
 * @param {{ rename?: (from: string, to: string) => Promise<void> }} [options]
 */
export async function replaceDirectoryAfterBuild(target, build, options = {}) {
  const rename = options.rename ?? renamePath;
  const parent = dirname(target);
  const name = basename(target);
  const staging = join(parent, `${name}.staging-${process.pid}`);
  const previous = join(parent, `${name}.previous-${process.pid}`);
  await rm(staging, { recursive: true, force: true });
  try {
    await build(staging);
    await rm(previous, { recursive: true, force: true });
    const movedAside = await renameIfPresent(rename, target, previous);
    try {
      await rename(staging, target);
    } catch (error) {
      if (movedAside) await rename(previous, target);
      throw error;
    }
  } finally {
    await rm(staging, { recursive: true, force: true });
    await rm(previous, { recursive: true, force: true });
  }
}

/**
 * @param {(from: string, to: string) => Promise<void>} rename
 * @param {string} from
 * @param {string} to
 * @returns {Promise<boolean>}
 */
async function renameIfPresent(rename, from, to) {
  try {
    await rename(from, to);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}
