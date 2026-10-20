// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { SkillEvidence } from "../records/contracts.js";

export type SkillResolutionErrorCode = "required-skill-unavailable";
const REQUIRED_SKILL_RESOLUTION_ERROR: SkillResolutionErrorCode = "required-skill-unavailable";

/** Closed, content-free failure used when a required skill did not resolve. */
export class SkillResolutionError extends Error {
  public readonly code: SkillResolutionErrorCode = "required-skill-unavailable";

  public constructor(skillId: string) {
    super(`Required skill "${skillId}" was not resolved (${REQUIRED_SKILL_RESOLUTION_ERROR}).`);
    this.name = "SkillResolutionError";
  }
}

/**
 * Require structured skill evidence before a step claims success. Summary text
 * is not inspected: it is untrusted work output.
 */
export function assertRequiredSkillResolved(
  skillId: string,
  skill: SkillEvidence | undefined,
): asserts skill is SkillEvidence {
  if (!skill) {
    throw new SkillResolutionError(skillId);
  }
}
