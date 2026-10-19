// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The production request-interpretation port: one tool-free completion per
 * call over the governed connection of the bound profile. The only interpret
 * module that imports provider code.
 */
import { limit } from "../config/limits.js";
import type { DocsFabConfig } from "../config/runtime-loader.js";
import type { CompositionRunRuntime } from "../cli/run/composition-runtime.js";
import { resolveOperatorExecutionBinding } from "../model/operator-execution-binding.js";
import { createProviderConnectionFactory, type ModelConnection } from "../model/provider.js";
import {
  RequestIntentModelUnavailableError,
  type RequestIntentInterpreterCall,
  type RequestIntentInterpreterPort,
  type RequestIntentInterpreterReply,
} from "./interpret.js";

export function createRequestIntentModelPort(input: {
  readonly config: DocsFabConfig;
  readonly workflow: string;
  readonly repositoryRevision: string;
  /** Provider turns the connection allows: every call of one interpretation. */
  readonly maxCalls: number;
  readonly compositionRuntime?: CompositionRunRuntime;
  /** Provider-bound test seam; production resolves the configured governed connection. */
  readonly connectionFactory?: () => Promise<ModelConnection>;
}): RequestIntentInterpreterPort {
  let opener: Promise<() => Promise<ModelConnection>> | undefined;
  let connection: Promise<ModelConnection> | undefined;
  return Object.freeze({
    call: async (request: RequestIntentInterpreterCall): Promise<RequestIntentInterpreterReply> => {
      // Read before the provider catches: a limit refusal is a host fault, not unavailable.
      const maxTransportRetries = limit("retry.maxTransportRetries").value;
      // Binding the configured model is the operator's configuration, resolved
      // before a step's harness too (cli/run/execution.ts), so its fault keeps
      // its own code rather than reading as an unavailable provider.
      opener ??= input.connectionFactory
        ? Promise.resolve(input.connectionFactory)
        : bindConnectionOpener(input);
      const open = await opener;
      let active: ModelConnection;
      try {
        // Only opening the connection is a provider fault here, as a step's
        // harness failure is (workflow-execution/retry.ts normalizeFailure).
        connection ??= open();
        active = await connection;
      } catch (error) {
        throw new RequestIntentModelUnavailableError({ cause: error });
      }
      // Transient transport failures retry within retry.maxTransportRetries; the
      // interpretation deadline bounds every attempt of every call together.
      let response: Awaited<ReturnType<ModelConnection["runtime"]["completeSimple"]>>;
      try {
        response = await active.runtime.completeSimple(
          active.model,
          {
            systemPrompt: request.systemPrompt,
            messages: [{ role: "user", content: request.prompt, timestamp: Date.now() }],
          },
          {
            maxTokens: request.maxOutputTokens,
            maxRetries: maxTransportRetries,
            signal: request.signal,
          },
        );
      } catch (error) {
        throw new RequestIntentModelUnavailableError({ cause: error });
      }
      if (response.stopReason === "error" || response.stopReason === "aborted") {
        throw new RequestIntentModelUnavailableError();
      }
      const text = response.content
        .filter((item) => item.type === "text")
        .map((item) => item.text)
        .join("");
      const usage = (response as { usage?: { input?: unknown; output?: unknown } }).usage;
      return {
        text,
        usage: { inputTokens: tokens(usage?.input), outputTokens: tokens(usage?.output) },
      };
    },
  });
}

function tokens(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

/**
 * Bind the configured model, then return the opener of its governed
 * connection. A binding fault rejects here; only the opener reaches the
 * provider.
 */
async function bindConnectionOpener(input: {
  readonly config: DocsFabConfig;
  readonly workflow: string;
  readonly repositoryRevision: string;
  readonly maxCalls: number;
  readonly compositionRuntime?: CompositionRunRuntime;
}): Promise<() => Promise<ModelConnection>> {
  const turnOptions = {
    evidenceIdentity: { repositoryRevision: input.repositoryRevision },
    limits: {
      maxProviderTurns: Math.min(
        input.maxCalls,
        input.compositionRuntime?.executionProfile.compositionPolicy?.maxProviderTurns ??
          input.maxCalls,
      ),
    },
  };
  const runtime = input.compositionRuntime;
  if (runtime) {
    return () =>
      runtime.providerConnectionFactory.create(
        { profile: runtime.executionProfile, credential: runtime.credential },
        turnOptions,
      );
  }
  const binding = await resolveOperatorExecutionBinding({
    model: input.config.model,
    workflowId: input.workflow,
  });
  return () =>
    createProviderConnectionFactory({
      routeId: binding.profile.routeId,
      transport: binding.profile.transport,
    }).create({ profile: binding.profile, credential: binding.credential }, turnOptions);
}
