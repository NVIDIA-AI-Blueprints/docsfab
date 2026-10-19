// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** Skip conditions for tests that pin repository paths the public export leaves out. */
import { statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../../../../", import.meta.url));

// The export drops the GitLab pipeline definition, so only a tree without it
// may skip. In the internal repository every declared path is read as before,
// and a missing one fails its test instead of hiding behind a skip.
const EXPORTED_TREE_MARKER = ".gitlab-ci.yml";

export interface InternalOnly {
  /** True only in an exported tree that lacks one of the declared paths. */
  readonly skip: boolean;
  /** The skip reason, or `undefined` when the test runs. */
  readonly reason: string | undefined;
  /** The title unchanged when the test runs; the title and the reason when it skips. */
  title(base: string): string;
}

export function internalOnly(
  paths: string | readonly string[],
  reason: string,
  root: string = repositoryRoot,
): InternalOnly {
  const declared = typeof paths === "string" ? [paths] : [...paths];
  if (declared.length === 0 || reason.trim() === "") {
    throw new Error("internalOnly needs at least one repository path and a reason.");
  }
  for (const path of declared) {
    if (path === "" || isAbsolute(path) || path.split("/").includes("..")) {
      throw new Error(`internalOnly path must be repository-relative: ${JSON.stringify(path)}.`);
    }
  }
  const missing = isAbsent(root, EXPORTED_TREE_MARKER)
    ? declared.filter((path) => isAbsent(root, path))
    : [];
  const note =
    missing.length === 0
      ? undefined
      : `internal-only, skipped: ${missing.join(", ")} absent from the exported tree; ${reason}`;
  return {
    skip: note !== undefined,
    reason: note,
    title: (base) => (note === undefined ? base : `${base} [${note}]`),
  };
}

function isAbsent(root: string, path: string): boolean {
  try {
    statSync(resolve(root, path));
    return false;
  } catch (error) {
    // Only a missing entry means the export left the path out. Anything else,
    // such as a file where a directory belongs or a denied read, is a broken
    // tree and must fail loudly.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw error;
  }
}
