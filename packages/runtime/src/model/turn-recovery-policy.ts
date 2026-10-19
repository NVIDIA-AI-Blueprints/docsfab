// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { limit, type ResolveLimitsOptions } from "../config/limits.js";

/** Recovery cannot spend more turns than the attempt was already admitted to use. */
export function resolveTurnRecoveryPolicy(
  maxProviderTurns: number,
  options?: ResolveLimitsOptions,
): {
  readonly maxCompactions: number;
  readonly maxConsecutiveLengthStoppedToolTurns: number;
  readonly minRecentToolTurns: number;
} {
  return {
    maxCompactions: Math.min(maxProviderTurns, limit("governance.maxCompactions", options).value),
    maxConsecutiveLengthStoppedToolTurns: Math.min(
      maxProviderTurns,
      limit("governance.maxConsecutiveLengthStoppedToolTurns", options).value,
    ),
    // A preservation minimum is separate from recovery capacity. Clamping an
    // explicitly larger minimum would silently weaken the selected policy.
    minRecentToolTurns: limit("governance.minRecentToolTurns", options).value,
  };
}
