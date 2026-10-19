// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { existsSync } from "node:fs";

import {
  createAgentSession,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type CreateAgentSessionOptions,
  type DefaultResourceLoader,
  type ResourceLoader,
} from "@earendil-works/pi-coding-agent";
import type { LiveAgentHostAssembly } from "./host.js";
import {
  createDocsFabResourceLoader,
  repositoryVirtualCwd,
  VIRTUAL_WORKSPACE_CWD,
} from "../harness/pi-session.js";

/**
 * Open the persisted conversation for one repository under its virtual cwd.
 *
 * A transcript recorded under the real repository path before virtual cwds
 * still resumes when the repository has no newer virtual-cwd transcript.
 */
export function openLiveAgentSessionManager(input: {
  readonly repositoryPath: string;
  readonly sessionDirectory: string;
  readonly newSession: boolean;
}): SessionManager {
  const cwd = repositoryVirtualCwd(input.repositoryPath);
  if (input.newSession) return SessionManager.create(cwd, input.sessionDirectory);
  const resumed = SessionManager.continueRecent(cwd, input.sessionDirectory);
  if (isSavedSession(resumed)) return resumed;
  const legacy = SessionManager.continueRecent(input.repositoryPath, input.sessionDirectory);
  return isSavedSession(legacy)
    ? SessionManager.open(legacy.getSessionFile()!, input.sessionDirectory, cwd)
    : resumed;
}

function isSavedSession(manager: SessionManager): boolean {
  const file = manager.getSessionFile();
  return file !== undefined && existsSync(file);
}

/**
 * The live agent's Pi resources. Pi loads no skills: it would list them by
 * absolute path, and `docsfab_use_skill` already serves every installed skill.
 */
export async function createLiveAgentResourceLoader(input: {
  readonly repositoryPath: string;
  readonly host: Pick<LiveAgentHostAssembly, "systemPrompt">;
  readonly agentDir?: string;
  readonly noninteractiveTask?: boolean;
}): Promise<DefaultResourceLoader> {
  if (input.noninteractiveTask) {
    if (!input.agentDir) throw new Error("A task session requires a private agent directory.");
    const loader = new (await import("@earendil-works/pi-coding-agent")).DefaultResourceLoader({
      cwd: input.repositoryPath,
      agentDir: input.agentDir,
      settingsManager: SettingsManager.inMemory(),
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      agentsFilesOverride: () => ({ agentsFiles: [] }),
      systemPrompt: input.host.systemPrompt,
    });
    await loader.reload();
    return loader;
  }
  const resourceLoader = createDocsFabResourceLoader({
    repositoryPath: input.repositoryPath,
    mode: "live-agent",
    ...(input.agentDir ? { agentDir: input.agentDir } : {}),
    systemPrompt: input.host.systemPrompt,
    additionalSystemPrompt: [
      "The terminal conversation is persistent. Keep useful conversational context across turns, but never treat conversation memory as canonical repository evidence.",
    ],
  });
  await resourceLoader.reload();
  return resourceLoader;
}

export interface LiveAgentPiSessionInput {
  /** The real checkout; Pi receives only the virtual workspace cwd. */
  readonly repositoryPath: string;
  readonly modelRuntime?: CreateAgentSessionOptions["modelRuntime"];
  readonly model?: CreateAgentSessionOptions["model"];
  readonly resourceLoader: ResourceLoader;
  /** A new or resumed conversation; its history never widens the tool set. */
  readonly sessionManager: SessionManager;
  readonly host: Pick<LiveAgentHostAssembly, "tools" | "excludeTools" | "customTools">;
}

/**
 * Open the Pi session for one live-agent process.
 *
 * The tool allowlist, denylist, and definitions come only from this
 * invocation's {@link assembleLiveAgentHost} result. A resumed session JSONL
 * contributes conversation history, never a grant: an earlier write-enabled
 * conversation reopened under `--read-only` gets no edit, write, or bash.
 */
export async function createLiveAgentPiSession(
  input: LiveAgentPiSessionInput,
): Promise<AgentSession> {
  const { session } = await createAgentSession({
    cwd: VIRTUAL_WORKSPACE_CWD,
    modelRuntime: input.modelRuntime,
    model: input.model,
    resourceLoader: input.resourceLoader,
    sessionManager: input.sessionManager,
    settingsManager: SettingsManager.inMemory({
      compaction: { enabled: false },
      cacheWarming: "off",
      retry: { enabled: false, provider: { maxRetries: 0 } },
    }),
    tools: [...input.host.tools],
    excludeTools: [...input.host.excludeTools],
    customTools: [...input.host.customTools],
  });
  return session;
}
