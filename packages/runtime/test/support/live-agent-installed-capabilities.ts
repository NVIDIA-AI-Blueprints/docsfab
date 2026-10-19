// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { DocsFabConfig } from "../../src/config/runtime-loader.js";
import {
  loadLiveAgentCapabilities,
  type LiveAgentCapabilities,
} from "../../src/live-agent/capabilities.js";
import type { RunnableWorkflowName } from "../../src/workflow-registry/catalog.js";

const runtimeRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

// Host fixtures use the same verified installation as the shipped live-agent
// entry point. The catalog and quality assets are immutable during these tests.
let installed: Promise<LiveAgentCapabilities> | undefined;

export async function installedLiveAgentCapabilities(
  workflows: readonly RunnableWorkflowName[],
): Promise<LiveAgentCapabilities> {
  installed ??= loadLiveAgentCapabilities({
    projectRoot: runtimeRoot,
    skillCrateDirectory: join(runtimeRoot, "skill-crate"),
    qualityDirectory: join(runtimeRoot, "quality"),
    qualityPackDirectory: join(runtimeRoot, "quality-pack"),
  } as DocsFabConfig);
  const capabilities = await installed;
  return {
    ...capabilities,
    workflows: workflows.map((name) => {
      const workflow = capabilities.workflows.find((candidate) => candidate.name === name);
      if (!workflow) throw new Error(`Missing installed workflow ${name}.`);
      return workflow;
    }),
  };
}
