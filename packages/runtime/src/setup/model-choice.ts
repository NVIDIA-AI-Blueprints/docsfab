// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Setup picks no model on the operator's behalf. A composition becomes a setup
 * default only after it passes the live-journey acceptance on a public route,
 * and none has yet, so setup that cannot prompt and names no model refuses.
 */
export const SETUP_MODEL_CHOICE_REQUIRED = "setup-model-choice-required";

/** The choices an operator can make, shared by the refusal and the readiness result. */
export const SETUP_MODEL_CHOICES =
  "Run `docsfab setup` in a terminal to choose a provider, or pass `--provider <openai|openai-compatible|anthropic|anthropic-compatible> --model <id>` (compatible providers also need `--endpoint <url>`), or pass `--profile <compositionId>` with an installed composition from `docsfab composition list`.";

/** Non-interactive setup named no model and the host has no usable model selection. */
export class SetupModelChoiceRequiredError extends Error {
  readonly code = SETUP_MODEL_CHOICE_REQUIRED;
  readonly nextAction = SETUP_MODEL_CHOICES;

  constructor() {
    super(
      "DocsFab setup has no default model, and this host has no model selection. Setup without a terminal, or with --json, needs an explicit model choice.",
    );
    this.name = "SetupModelChoiceRequiredError";
  }
}
