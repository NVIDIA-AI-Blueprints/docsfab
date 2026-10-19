// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** Canonical receipt-root gate order shared by deletion and Git cleanup. */
import { lstat } from "node:fs/promises";

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
