// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** Pin B resolver for the packaged, closed catalog skill crate. */
import type { GovernedSkillResolver, HarnessStepInput } from "../execution/contracts.js";
import type { SkillEvidence } from "../records/contracts.js";
import { verifyCatalogSkill } from "./catalog-crate.js";
import { catalogSkillToolsForStep } from "./catalog-crate-selection.js";
import {
  loadVerifiedInvocationMetadata,
  type SkillInvocationMetadata,
} from "./invocation-metadata.js";

export class CatalogSkillCrateResolver implements GovernedSkillResolver {
  public constructor(private readonly skillCrateDirectory: string) {}

  public async resolveSkill(input: HarnessStepInput): Promise<SkillEvidence> {
    return (await this.verifyStep(input)).evidence;
  }

  /** Load invocation metadata from the verified crate entry for this step. */
  public async resolveInvocationMetadata(
    input: HarnessStepInput,
  ): Promise<SkillInvocationMetadata> {
    return loadVerifiedInvocationMetadata(await this.verifyStep(input));
  }

  private verifyStep(input: HarnessStepInput) {
    return verifyCatalogSkill({
      skillCrateDirectory: this.skillCrateDirectory,
      skillId: input.step.skill,
      grantedTools: catalogSkillToolsForStep(input.step),
    });
  }
}
