// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { RepositoryWorkspace } from "../repository/workspace/contracts.js";
import { DockerCheckContainmentError } from "../validation/host-containment.js";
import {
  CheckIsolationUnavailableError,
  requiredCheckIsolationRemedy,
} from "./check-isolation-selection.js";
import {
  CheckSandboxLimitationError,
  hostSelectedCheckAuthority,
  observeCheckedSnapshot,
  requiredRepositoryChecks,
  type CheckCommandAuthority,
} from "./workflow-checks.js";

export const REQUIRED_CHECK_ISOLATION_DIAGNOSTIC = "required-check-isolation-unavailable";

export interface RequiredCheckReadinessLimitation {
  readonly code: typeof REQUIRED_CHECK_ISOLATION_DIAGNOSTIC;
  readonly explanation: string;
  readonly nextCommand: string;
}

export interface RequiredCheckReadinessDependencies {
  /** Host-owned authority; tests may substitute an unavailable backend. */
  readonly prepareAuthority?: (workspace: RepositoryWorkspace) => Promise<CheckCommandAuthority>;
}

/**
 * Probe the same isolated authority delivery uses, without executing a repository
 * command. Only source-backed, supported required checks cause preparation.
 */
export async function probeRequiredCheckReadiness(
  workspace: RepositoryWorkspace,
  dependencies: RequiredCheckReadinessDependencies = {},
): Promise<RequiredCheckReadinessLimitation | undefined> {
  const observed = await observeCheckedSnapshot(workspace.path, { digest: false });
  const checks = requiredRepositoryChecks(observed.instructions).filter((check) => check.argv);
  if (checks.length === 0) return undefined;
  let authority: CheckCommandAuthority;
  try {
    authority = await (dependencies.prepareAuthority ?? hostSelectedCheckAuthority)(workspace);
  } catch (error) {
    // Final validation also records ordinary preparation failures as unavailable,
    // but failed containment or teardown must still stop the run.
    if (error instanceof DockerCheckContainmentError) throw error;
    if (error instanceof CheckIsolationUnavailableError) {
      return {
        code: REQUIRED_CHECK_ISOLATION_DIAGNOSTIC,
        explanation: `A repository-required check cannot run in isolated command authority on this host: ${error.message}`,
        nextCommand: requiredCheckIsolationRemedy([error.refusal]),
      };
    }
    if (error instanceof CheckSandboxLimitationError) {
      return {
        code: REQUIRED_CHECK_ISOLATION_DIAGNOSTIC,
        explanation: `A repository-required check cannot run in isolated command authority on this host: ${error.message}`,
        nextCommand:
          "Resolve the named check sandbox limitation, then run doctor again before starting another write run.",
      };
    }
    return {
      code: REQUIRED_CHECK_ISOLATION_DIAGNOSTIC,
      explanation:
        "A repository-required check could not prepare isolated command authority on this host; no repository command ran.",
      nextCommand: requiredCheckIsolationRemedy([]),
    };
  }
  await authority.cleanup();
  return undefined;
}
