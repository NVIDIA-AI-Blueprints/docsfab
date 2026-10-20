// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Fresh in-memory Pi session for one headless delegated task, built with the
 * shared `createPiAgentSession`. Only `fresh` lifetime is admitted; this module
 * never calls `SessionManager.continueRecent` or keeps a second Pi factory.
 */
import type { DefaultResourceLoader } from "@earendil-works/pi-coding-agent";

import type { ConfinedToolSet } from "../harness/confined-tools.js";
import { createPiAgentSession, type PiAgentSession } from "../harness/pi-session.js";
import type { ModelConnection } from "../model/provider.js";

export const DELEGATED_TASK_FRESH_SESSION_KIND = "fresh" as const;

export interface DelegatedTaskSessionLifetime {
  readonly kind: typeof DELEGATED_TASK_FRESH_SESSION_KIND;
}

export interface CreateDelegatedTaskSessionInput {
  readonly repositoryPath: string;
  readonly connection: ModelConnection;
  readonly resourceLoader: DefaultResourceLoader;
  readonly confinedToolDefinitions: ConfinedToolSet["definitions"];
  readonly lifetime: DelegatedTaskSessionLifetime;
}

export function assertDelegatedTaskSessionLifetime(
  lifetime: DelegatedTaskSessionLifetime | undefined,
): asserts lifetime is DelegatedTaskSessionLifetime {
  if (lifetime?.kind !== DELEGATED_TASK_FRESH_SESSION_KIND) {
    throw new Error(
      "Delegated tasks require a fresh session lifetime and never continue the most recent live-agent session.",
    );
  }
}

/** Open one ephemeral Pi session. Callers dispose it. */
export async function createDelegatedTaskSession(
  input: CreateDelegatedTaskSessionInput,
): Promise<PiAgentSession> {
  assertDelegatedTaskSessionLifetime(input.lifetime);
  return createPiAgentSession({
    repositoryPath: input.repositoryPath,
    connection: input.connection,
    resourceLoader: input.resourceLoader,
    confinedToolDefinitions: input.confinedToolDefinitions,
  });
}
