// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { mkdtemp, mkdir, readdir, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { inventoryRunDelivery } from "../src/delivery/run-deletion-adapter.js";

describe("run delivery deletion inventory", () => {
  it("inventories ordinary empty publication roots without creating or deleting bytes", async () => {
    const parent = await realpath(await mkdtemp(join(tmpdir(), "docsfab-delivery-delete-")));
    const stateDirectory = join(parent, "state");
    await mkdir(stateDirectory, { mode: 0o700 });
    const before = await readdir(parent);
    const inventory = await inventoryRunDelivery({
      stateDirectory,
      runId: "run-empty",
      recordSha256: "a".repeat(64),
    });
    expect(inventory).toMatchObject({
      runId: "run-empty",
      receipts: [],
      plans: [],
      attempts: [],
      sharedRetained: 0,
      unresolved: [],
    });
    expect(await readdir(parent)).toEqual(before);
  });
});
