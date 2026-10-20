// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import path from "node:path";

export const PUBLIC_ROOTS_VARIABLE = "DOCSFAB_PUBLIC_ROOTS";

/** A `DOCSFAB_PUBLIC_ROOTS` entry is unusable; the message names its index, never its value. */
export class PublicRootsOperatorError extends Error {
  readonly code = "public-roots-invalid";
  readonly index: number;

  constructor(index: number) {
    super(
      `public-roots-invalid: ${PUBLIC_ROOTS_VARIABLE} entry ${index} must be a normalized absolute path, without surrounding whitespace, other than the filesystem root.`,
    );
    this.name = "PublicRootsOperatorError";
    this.index = index;
  }
}

/**
 * Parse the deployment's declared public roots: paths that reveal nothing
 * about this host, such as an image's `/workspace` or `HOME=/home/node`.
 * Call at startup so an invalid entry stops the process before any egress.
 */
export function declaredPublicRoots(
  environment: NodeJS.ProcessEnv = process.env,
): ReadonlySet<string> {
  const value = environment[PUBLIC_ROOTS_VARIABLE];
  if (!value) return new Set();
  const roots = new Set<string>();
  value.split(path.delimiter).forEach((entry, index) => {
    if (!isDeclarableRoot(entry)) throw new PublicRootsOperatorError(index);
    roots.add(entry);
  });
  return roots;
}

/** The `isPublic` option for `hostRootSet`: exact match on a root's logical path or realpath. */
export function publicRootPredicate(roots: ReadonlySet<string>): (path: string) => boolean {
  return (candidate) => roots.has(candidate);
}

/**
 * The trailing-separator rule also refuses the filesystem root; `isAbsolute("")`
 * is false. A padded entry would never match a root, so it is refused too.
 */
function isDeclarableRoot(entry: string): boolean {
  return (
    path.isAbsolute(entry) &&
    path.normalize(entry) === entry &&
    !entry.endsWith(path.sep) &&
    entry.trim() === entry
  );
}
