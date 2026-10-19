// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { ModelProfile } from "../model/configuration.js";

export type LegacyPolicyProfileReadiness = {
  ready: boolean;
  code: "ready" | "provider-profile-unapproved";
  explanation: string;
  nextCommand: string;
};

/**
 * Unknown metadata is not an invented 8K host ceiling. A passed review date is
 * advisory: it never makes the profile unready, so a local run is not refused
 * on the date alone.
 */
export function inspectLegacyPolicyProfileReadiness(
  profile: ModelProfile,
): LegacyPolicyProfileReadiness {
  if (profile.effectiveLimitReason === "metadata-unknown") {
    return {
      ready: true,
      code: "ready",
      explanation:
        "The host policy profile has unknown metadata. DocsFab does not invent a host context ceiling: unique installed-composition matches use that composition's window, and unmatched selections leave the provider as the ceiling.",
      nextCommand: "docsfab doctor",
    };
  }
  return {
    ready: true,
    code: "ready",
    explanation: "The host policy profile can use its configured context limits.",
    nextCommand: "docsfab doctor",
  };
}

export function assertLegacyPolicyProfileReady(profile: ModelProfile): void {
  const readiness = inspectLegacyPolicyProfileReadiness(profile);
  if (readiness.ready) return;
  // The composed message is a full explanation plus the shared
  // `Next action: <command>` line; only the static projection looks short.
  throw new Error(`${readiness.explanation} Next action: ${readiness.nextCommand}`); // hygiene: ok
}
