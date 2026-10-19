// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Run index location and loss signals, kept free of store imports so
 * `FileRunStore` can name them without an import cycle.
 *
 * A lost index write cannot fail the record, but must never be silent.
 * `reportRunIndexLoss` writes straight to stderr because `NODE_NO_WARNINGS=1`
 * suppresses process warnings; stderr also stays out of `--json` stdout.
 */
import { dirname, resolve } from "node:path";

export const RUN_INDEX_DIRECTORY_NAME = "run-index";

/** The state directory's sibling `run-index/`. */
export function defaultRunIndexDirectory(stateDirectory: string): string {
  return resolve(dirname(resolve(stateDirectory)), RUN_INDEX_DIRECTORY_NAME);
}

export type RunIndexLossCode = "runs-index-io-failed" | "run-store-after-save-failed";

export function reportRunIndexLoss(
  code: RunIndexLossCode,
  message: string,
  write: (text: string) => void = (text) => void process.stderr.write(text),
): void {
  write(`WARNING ${code}: ${message}\n`);
}

/** The one rebuild remediation every index-loss surface and the docs name. */
export function runIndexRebuildRemediation(
  stateDirectory: string,
  indexDirectory = defaultRunIndexDirectory(stateDirectory),
): string {
  return `Move ${indexDirectory} aside, then rebuild it with docsfab runs import ${stateDirectory} --index-dir ${indexDirectory}.`;
}
