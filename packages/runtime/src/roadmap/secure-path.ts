// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { lstat, mkdir, realpath } from "node:fs/promises";
import { dirname, parse, relative, resolve, sep } from "node:path";

export class SecurePathError extends Error {
  public readonly code = "insecure-path" as const;

  public constructor(message = "Path does not have a stable private parent authority.") {
    super(message);
    this.name = "SecurePathError";
  }
}

interface DirectoryIdentity {
  path: string;
  dev: bigint;
  ino: bigint;
  ctimeNs: bigint;
}

/**
 * Pins the lexical parent chain used by a security-sensitive file operation.
 *
 * Node does not expose portable openat/renameat operations. Callers therefore
 * verify this authority immediately around every absolute-path operation. The
 * immediate parent identity may be refreshed only after an operation that is
 * expected to change its directory metadata (create, unlink, or rename).
 */
export class SecurePathAuthority {
  public readonly path: string;
  public readonly parent: string;
  private chain: DirectoryIdentity[];

  private constructor(path: string, chain: DirectoryIdentity[]) {
    this.path = path;
    this.parent = dirname(path);
    this.chain = chain;
  }

  public static async bind(
    pathValue: string,
    options: { createParents?: boolean } = {},
  ): Promise<SecurePathAuthority> {
    const path = resolve(pathValue);
    if (options.createParents) await createMissingParents(dirname(path));
    const chain = await inspectChain(dirname(path));
    const authority = new SecurePathAuthority(path, chain);
    await authority.assertStable();
    return authority;
  }

  public async assertStable(): Promise<void> {
    let observed: DirectoryIdentity[];
    try {
      observed = await inspectChain(this.parent);
    } catch {
      throw new SecurePathError("Parent path changed during secure file access.");
    }
    if (observed.length !== this.chain.length) throw new SecurePathError();
    for (let index = 0; index < observed.length; index += 1) {
      const expected = this.chain[index]!;
      const current = observed[index]!;
      if (
        current.path !== expected.path ||
        current.dev !== expected.dev ||
        current.ino !== expected.ino ||
        (index === observed.length - 1 && current.ctimeNs !== expected.ctimeNs)
      ) {
        throw new SecurePathError("Parent path changed during secure file access.");
      }
    }
  }

  /** Refreshes only the immediate parent's ctime after our own directory mutation. */
  public async refreshAfterParentMutation(): Promise<void> {
    let observed: DirectoryIdentity[];
    try {
      observed = await inspectChain(this.parent);
    } catch {
      throw new SecurePathError("Parent path changed during secure file access.");
    }
    if (observed.length !== this.chain.length) throw new SecurePathError();
    for (let index = 0; index < observed.length; index += 1) {
      const expected = this.chain[index]!;
      const current = observed[index]!;
      if (
        current.path !== expected.path ||
        current.dev !== expected.dev ||
        current.ino !== expected.ino
      ) {
        throw new SecurePathError("Parent path changed during secure file access.");
      }
    }
    this.chain = observed;
  }
}

async function createMissingParents(parent: string): Promise<void> {
  const components = pathComponents(parent);
  for (let index = 0; index < components.length; index += 1) {
    const component = components[index]!;
    try {
      await validateDirectory(component);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      if (index === 0) throw new SecurePathError();
      const existingParent = components[index - 1]!;
      const before = await inspectChain(existingParent);
      await assertSameChain(before, false);
      try {
        await mkdir(component, { mode: 0o700 });
      } catch (mkdirError) {
        if ((mkdirError as NodeJS.ErrnoException).code !== "EEXIST") throw mkdirError;
      }
      await assertSameChain(before, true);
      await validateDirectory(component);
    }
  }
}

async function assertSameChain(
  expected: DirectoryIdentity[],
  allowLastCtimeChange: boolean,
): Promise<void> {
  const observed = await inspectChain(expected.at(-1)!.path);
  if (observed.length !== expected.length) throw new SecurePathError();
  for (let index = 0; index < observed.length; index += 1) {
    const current = observed[index]!;
    const prior = expected[index]!;
    if (
      current.path !== prior.path ||
      current.dev !== prior.dev ||
      current.ino !== prior.ino ||
      (index === observed.length - 1 && !allowLastCtimeChange && current.ctimeNs !== prior.ctimeNs)
    ) {
      throw new SecurePathError("Parent path changed during secure file access.");
    }
  }
}

async function inspectChain(parent: string): Promise<DirectoryIdentity[]> {
  const identities: DirectoryIdentity[] = [];
  for (const component of pathComponents(parent))
    identities.push(await validateDirectory(component));
  return identities;
}

async function validateDirectory(path: string): Promise<DirectoryIdentity> {
  const state = await lstat(path, { bigint: true });
  if (state.isSymbolicLink())
    throw new SecurePathError("Symbolic-link parent paths are not allowed.");
  if (!state.isDirectory()) throw new SecurePathError();
  const uid = typeof process.getuid === "function" ? BigInt(process.getuid()) : 0n;
  if ((state.uid !== 0n && state.uid !== uid) || (state.mode & 0o022n) !== 0n)
    throw new SecurePathError();
  let canonical: string;
  try {
    canonical = await realpath(path);
  } catch {
    throw new SecurePathError();
  }
  if (canonical !== path) throw new SecurePathError("Symbolic-link parent paths are not allowed.");
  return { path, dev: state.dev, ino: state.ino, ctimeNs: state.ctimeNs };
}

function pathComponents(pathValue: string): string[] {
  const path = resolve(pathValue);
  const root = parse(path).root;
  const rest = relative(root, path).split(sep).filter(Boolean);
  const components = [root];
  for (const name of rest) components.push(resolve(components.at(-1)!, name));
  return components;
}
