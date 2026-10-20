// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { CheckCommandResult } from "../../src/workflow-execution/check-sandbox.js";
import type {
  CheckCommandAuthority,
  RequiredCheckProgram,
} from "../../src/workflow-execution/workflow-checks.js";

/** Deterministic command authority that records exact dispatch; runs nothing. */
export function recordingAuthority(
  outcome: Pick<CheckCommandResult, "status" | "exitCode" | "output">,
  options: { onRun?: () => Promise<void> } = {},
): CheckCommandAuthority & {
  calls: Array<{ executable: string; argv: readonly string[]; cwd: string }>;
} {
  const calls: Array<{ executable: string; argv: readonly string[]; cwd: string }> = [];
  return {
    calls,
    resolve: async (program: RequiredCheckProgram) => `/fixture/bin/${program}`,
    run: async (executable, argv, runOptions) => {
      calls.push({ executable, argv: [...argv], cwd: runOptions.cwd });
      await options.onRun?.();
      return { ...outcome };
    },
    cleanup: async () => undefined,
  };
}
