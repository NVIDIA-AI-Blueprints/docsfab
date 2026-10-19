// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

async function readOperatorSource(name: string): Promise<string> {
  return readFile(fileURLToPath(new URL(`../src/operator/${name}`, import.meta.url)), "utf8");
}

describe("operator run-summary scheduler isolation", () => {
  it("does not import runner-schedule or authoring-revision", async () => {
    // The isolation holds for the summary module and its NEXT-action sibling.
    const summary = await readOperatorSource("run-summary.ts");
    const nextAction = await readOperatorSource("run-next-action.ts");
    for (const source of [summary, nextAction]) {
      expect(source).not.toMatch(/workflow-execution\/runner-schedule/u);
      expect(source).not.toMatch(/workflow-execution\/authoring-revision/u);
    }
    expect(nextAction).toContain("../workflow-contracts/run-recovery-presentation.js");
  });
});
