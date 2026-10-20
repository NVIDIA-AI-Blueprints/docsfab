// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  documentationFileRootRule,
  documentationPageShapeRule,
} from "../src/cli/first-pass-support.js";
import { AGENT_INSTRUCTION_FILE_NAMES } from "../src/repository/agent-instruction-files.js";
import { buildRepositoryDiscoveryInventory } from "../src/repository/inventory.js";
import { prepareRepositoryWorkspace } from "../src/repository/workspace/materialize.js";
import { initFixtureRepo } from "./helpers/git.js";
import { testTimeoutMs } from "./helpers/test-timeouts.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it("first-pass classification and the observed inventory use every shared instruction name", {
  timeout: testTimeoutMs(30_000),
}, async () => {
  const root = await mkdtemp(join(tmpdir(), "docsfab-naming-classification-"));
  roots.push(root);
  const paths = AGENT_INSTRUCTION_FILE_NAMES.map((name) => `docs/${name}.md`);
  const normal = ["docs/CONVENTIONS.md", "docs/agents-guide.md", "docs/agents/index.md"];
  await initFixtureRepo(
    root,
    Object.fromEntries(
      [...paths, ...normal].map((path) => [path, "# Guidance\n\nUse the API guide.\n"]),
    ),
  );
  const workspace = await prepareRepositoryWorkspace(root, "HEAD");
  try {
    const inventory = await buildRepositoryDiscoveryInventory({ workspace });
    expect(inventory.instructionScopes.map((scope) => scope.path).sort()).toEqual(
      [...paths].sort(),
    );
    for (const path of paths) {
      expect(documentationPageShapeRule(path, "local-widen"), path).toBeUndefined();
      expect(documentationFileRootRule(path, "local-widen"), path).toBe("protected-path");
      expect(
        documentationPageShapeRule(path.replace("docs/", "guides/"), "local-widen"),
        path,
      ).toBe("protected-path");
    }
    for (const path of normal) {
      expect(documentationPageShapeRule(path, "local-widen"), path).toBeUndefined();
    }
  } finally {
    await workspace.dispose();
  }
});
