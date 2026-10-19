// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * A readable empty tree. `observeCheckedSnapshot` succeeds, and the
 * baseline/final command union is empty, so required checks are
 * `not-required` without treating observation failure as success.
 */
export async function createObservableWorkspaceWithoutRequiredChecks(): Promise<{
  path: string;
  dispose: () => Promise<void>;
}> {
  const path = await mkdtemp(join(tmpdir(), "docsfab-observable-ws-"));
  return {
    path,
    dispose: async () => {
      await rm(path, { recursive: true, force: true });
    },
  };
}
