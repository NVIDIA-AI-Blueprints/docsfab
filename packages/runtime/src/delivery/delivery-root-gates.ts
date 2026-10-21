// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** Canonical receipt-root gate order shared by deletion and Git cleanup. */
import { lstat, realpath } from "node:fs/promises";

import { withRunMaintenanceGate } from "../records/run-maintenance-gate.js";

export async function withDeliveryRootGates<T>(
  roots: readonly string[],
  action: () => Promise<T>,
): Promise<T> {
  const existing: string[] = [];
  for (const root of [...new Set(roots)].sort()) {
    try {
      await lstat(root);
      existing.push(root);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  const visit = (index: number): Promise<T> =>
    index === existing.length
      ? action()
      : withRunMaintenanceGate(existing[index]!, () => visit(index + 1));
  return visit(0);
}

/** Hold every required existing root for a final deletion phase, including physical aliases once. */
export async function withPinnedDeliveryRootGates<T>(
  roots: readonly string[],
  action: (heldRoots: readonly string[]) => Promise<T>,
): Promise<T> {
  const identities = new Map<string, { path: string; dev: number; ino: number }>();
  for (const root of roots) {
    const path = await realpath(root);
    const stat = await lstat(path);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new Error(`The receipt root at ${root} is unsafe; inspect it before deletion.`);
    const identity = `${stat.dev}:${stat.ino}`;
    const prior = identities.get(identity);
    if (!prior || path < prior.path)
      identities.set(identity, { path, dev: stat.dev, ino: stat.ino });
  }
  const held = [...identities.values()].sort((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
  );
  const visit = (index: number): Promise<T> => {
    const current = held[index];
    if (!current) return action(held.map((root) => root.path));
    return withRunMaintenanceGate(current.path, async () => {
      const stat = await lstat(current.path);
      if (
        !stat.isDirectory() ||
        stat.isSymbolicLink() ||
        stat.dev !== current.dev ||
        stat.ino !== current.ino
      )
        throw new Error(`The receipt root at ${current.path} changed; preview deletion again.`);
      return visit(index + 1);
    });
  };
  return visit(0);
}
