// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * `docsfab profile seed` picks no model on the operator's behalf, for the
 * same reason setup does not (`setup/model-choice.ts`): no composition on a
 * public route has earned a default yet. Seed without `--preset` refuses.
 */
export const PROFILE_SEED_CHOICE_REQUIRED = "profile-seed-choice-required";

/** The choices an operator can make, shared by the refusal and its catalogue row. */
export const PROFILE_SEED_CHOICES =
  "Choose a model with `docsfab setup`, then enter MODEL_API_KEY through the hidden setup prompt.";

/** `docsfab profile seed` named no preset, so it has no model profile to write. */
export class ProfileSeedChoiceRequiredError extends Error {
  readonly code = PROFILE_SEED_CHOICE_REQUIRED;
  readonly nextAction = PROFILE_SEED_CHOICES;

  constructor() {
    super(
      "DocsFab profile seed has no default model. Name the model profile to write with --preset.",
    );
    this.name = "ProfileSeedChoiceRequiredError";
  }
}
