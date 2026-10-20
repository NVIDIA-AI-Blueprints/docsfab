// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { resolve } from "node:path";
import { registerIaAnalysisHarnessScenarios } from "./ia-analysis-harness.scenarios.js";
import { publicIaAnalysisFixture } from "./helpers/public-runtime-inputs.js";

const fixtureRoot = resolve(import.meta.dirname, "fixtures/public-runtime/ia");
const fixture = await publicIaAnalysisFixture(fixtureRoot);
registerIaAnalysisHarnessScenarios({
  fixtureRoot,
  loadFixture: async () => structuredClone(fixture),
  consultedNodeId: fixture.index.nodes.find(
    (node) => node.kind === "document" && node.sourcePath === "README.md",
  )!.id,
  projectedDocumentNodeId: fixture.index.nodes.find(
    (node) => node.kind === "document" && node.sourcePath === "connect.md",
  )!.id,
});
