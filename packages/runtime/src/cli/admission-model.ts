// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Constrained admission-model fallback for `docsfab do`.
 *
 * The fixed outcome table still classifies first. When it cannot pick exactly
 * one catalog workflow, a tool-free model may name one workflow from the
 * offer: every runnable workflow, or, under `--patch-only` or `--draft-mr`, only
 * the workflows that deliver them. It cannot mint writes, invent workflows, or
 * act as a skill router. `--route-only` never takes this path; it names the
 * offer instead.
 */

import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";

import { loadConfig } from "../config/runtime-loader.js";
import { VIRTUAL_WORKSPACE_CWD } from "../harness/pi-session.js";
import { resolveOperatorExecutionBinding } from "../model/operator-execution-binding.js";
import { createProviderConnectionFactory } from "../model/provider.js";
import {
  ADMISSION_MODEL_SYSTEM_PROMPT,
  buildAdmissionModelPrompt,
  FULL_ADMISSION_OFFER,
  parseAdmissionModelResponse,
  type AdmissionOffer,
} from "./admission-parse.js";

export {
  ADMISSION_MODEL_SYSTEM_PROMPT,
  ADMISSION_MODEL_USER_PROMPT_PREFIX,
  buildAdmissionModelPrompt,
  FULL_ADMISSION_OFFER,
  parseAdmissionModelResponse,
  type AdmissionOffer,
} from "./admission-parse.js";

/**
 * Production admission-model call. Failures and offline hosts return
 * `undefined` so `docsfab do` keeps the table `needs-input` result.
 */
export async function liveAdmitCatalogWorkflow(
  request: string,
  offer: AdmissionOffer = FULL_ADMISSION_OFFER,
): Promise<string | undefined> {
  if (process.env.PI_OFFLINE === "1") return undefined;
  try {
    const config = loadConfig();
    const binding = await resolveOperatorExecutionBinding({ model: config.model });
    const resourceLoader = new DefaultResourceLoader({
      cwd: config.projectRoot,
      agentDir: getAgentDir(),
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      systemPrompt: ADMISSION_MODEL_SYSTEM_PROMPT,
    });
    await resourceLoader.reload();
    const connection = await createProviderConnectionFactory({
      routeId: binding.profile.routeId,
      transport: binding.profile.transport,
    }).create({ profile: binding.profile, credential: binding.credential });
    // Pi states the session cwd in the system prompt, so the install root stays host-side.
    const { session } = await createAgentSession({
      cwd: VIRTUAL_WORKSPACE_CWD,
      modelRuntime: connection.runtime,
      model: connection.model,
      resourceLoader,
      sessionManager: SessionManager.inMemory(VIRTUAL_WORKSPACE_CWD),
      settingsManager: SettingsManager.inMemory({
        compaction: { enabled: false },
        cacheWarming: "off",
        retry: { enabled: false, provider: { maxRetries: 0 } },
      }),
      noTools: "all",
    });
    let response = "";
    session.subscribe((event) => {
      if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
        response += event.assistantMessageEvent.delta;
      }
    });
    try {
      await session.prompt(buildAdmissionModelPrompt(request, offer));
      const modelError = session.agent.state.errorMessage;
      if (modelError) return undefined;
      return parseAdmissionModelResponse(response, offer);
    } finally {
      session.dispose();
    }
  } catch {
    return undefined;
  }
}
