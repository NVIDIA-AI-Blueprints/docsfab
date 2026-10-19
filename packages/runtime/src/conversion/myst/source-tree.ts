// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

import { ConversionContractError } from "../contracts.js";

/**
 * Read access to one documentation root. Paths are POSIX, relative to the
 * root, and already normalized by the reader; an implementation refuses any
 * path that reaches outside the root, including through a symbolic link.
 */
export interface MystSourceTree {
  /** Size of the regular file at `path`, or undefined when there is none. */
  fileSize(path: string): number | undefined;
  read(path: string): Uint8Array;
}

function outsideRoot(path: string): ConversionContractError {
  return new ConversionContractError(
    "conversion-include-outside-root",
    `Path ${JSON.stringify(path)} resolves outside the documentation root.`,
  );
}

function within(root: string, candidate: string): boolean {
  const offset = relative(root, candidate);
  return (
    offset === "" || (offset !== ".." && !offset.startsWith(`..${sep}`) && !isAbsolute(offset))
  );
}

/** A source tree over a directory on disk; symbolic links that leave the root are refused. */
export function createMystFileTree(rootDirectory: string): MystSourceTree {
  const root = realpathSync(rootDirectory);
  const locate = (path: string): string | undefined => {
    const lexical = resolve(root, ...path.split("/"));
    if (!within(root, lexical)) throw outsideRoot(path);
    let real: string;
    try {
      real = realpathSync(lexical);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    if (!within(root, real)) throw outsideRoot(path);
    return real;
  };
  return {
    fileSize(path) {
      const real = locate(path);
      if (real === undefined) return undefined;
      const stats = statSync(real);
      return stats.isFile() ? stats.size : undefined;
    },
    read(path) {
      const real = locate(path);
      if (real === undefined) {
        throw new ConversionContractError(
          "conversion-source-missing",
          `No file at ${JSON.stringify(path)} under the documentation root.`,
        );
      }
      return readFileSync(real);
    },
  };
}

/** A source tree over in-memory files keyed by root-relative POSIX path. */
export function createMystMemoryTree(
  files: Readonly<Record<string, string | Uint8Array>>,
): MystSourceTree {
  const encoder = new TextEncoder();
  const entries = new Map<string, Uint8Array>();
  for (const [path, contents] of Object.entries(files)) {
    entries.set(path, typeof contents === "string" ? encoder.encode(contents) : contents);
  }
  const guard = (path: string): void => {
    if (path.startsWith("/") || path.split("/").includes("..")) throw outsideRoot(path);
  };
  return {
    fileSize(path) {
      guard(path);
      return entries.get(path)?.byteLength;
    },
    read(path) {
      guard(path);
      const bytes = entries.get(path);
      if (bytes === undefined) {
        throw new ConversionContractError(
          "conversion-source-missing",
          `No file at ${JSON.stringify(path)} under the documentation root.`,
        );
      }
      return bytes;
    },
  };
}
