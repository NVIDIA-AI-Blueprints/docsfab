// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assessRequiredRepositoryChecks,
  observeCheckedSnapshot,
  requiredRepositoryChecks,
} from "../src/workflow-execution/workflow-checks.js";
import { materializePilotHead } from "./helpers/documentation-supervision-pilot.js";
import { prepareRepositoryWorkspace } from "../src/repository/workspace/materialize.js";

const observationProbe = vi.hoisted(() => ({
  missingDescendant: null as string | null,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    lstat: (async (...args: Parameters<typeof actual.lstat>) => {
      const path = String(args[0]);
      if (observationProbe.missingDescendant && path === observationProbe.missingDescendant) {
        throw Object.assign(new Error(`ENOENT: no such file or directory, lstat '${path}'`), {
          code: "ENOENT",
          path,
        });
      }
      return actual.lstat(...args);
    }) as typeof actual.lstat,
  };
});

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  observationProbe.missingDescendant = null;
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe("required-check snapshot observation failures", () => {
  async function pilotWorkspace() {
    const { root, repository } = await materializePilotHead();
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const workspace = await prepareRepositoryWorkspace(repository, "HEAD");
    cleanups.push(() => workspace.dispose());
    return workspace;
  }

  it("refuses when observing a descendant fails with ENOENT", async () => {
    const workspace = await pilotWorkspace();
    const baseline = (await observeCheckedSnapshot(workspace.path, { digest: false })).instructions;
    expect(requiredRepositoryChecks(baseline).length).toBeGreaterThan(0);
    const descendant = join(workspace.path, "docs", "cli.md");
    observationProbe.missingDescendant = descendant;
    await expect(observeCheckedSnapshot(workspace.path)).rejects.toMatchObject({
      code: "ENOENT",
      path: descendant,
    });
    const gate = await assessRequiredRepositoryChecks({
      runId: "run-848",
      workspacePath: workspace.path,
      baselineInstructions: baseline,
      steps: [],
    });
    expect(gate).toMatchObject({
      status: "refused",
      code: "required-check-snapshot-unavailable",
    });
    expect(gate.status === "refused" ? gate.message : "").toContain("was not proposed");
  });
});
