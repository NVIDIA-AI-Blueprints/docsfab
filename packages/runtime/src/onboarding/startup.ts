// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { CliFormatOptions } from "../operator/cli-format.js";
import { presentResult } from "../operator/presentation/index.js";
import {
  renderCliPresentation,
  resolveCliPresentationCapabilities,
} from "../cli/discovery-presentation.js";

/** First-run NEXT. Spelling must remain an argv already in `usage.ts`. */
export const BARE_ARGV_NEXT_COMMAND = "docsfab setup";

/** NEXT map: no profile, key in the environment. */
export const BARE_ARGV_NEXT_REASON = "Bootstrap the host policy profile and configuration root";

/**
 * Bind form until host provisioning exists. Not a second NEXT argv and not a
 * URL clone chooser.
 */
export const BARE_ARGV_REPO_HINT =
  "Jobs use --repo <path> for a local checkout. Git URLs are not accepted.";

/**
 * Bare `docsfab` is a blocked first-run state, not a fake 5-step wizard.
 * Prints exactly one copy-pasteable NEXT argv (WF-10).
 */
export function renderStartupOnboarding(options: CliFormatOptions = {}): string {
  const capabilities = resolveCliPresentationCapabilities(options);
  const document = presentResult({
    title: "DocsFab first run",
    summary: "Choose a local repository, configure the host, then check whether work can proceed.",
    outcome: { label: "State", evidence: { state: "known", value: "blocked until setup" } },
    effects: [
      { label: "Reason", evidence: { state: "known", value: BARE_ARGV_NEXT_REASON } },
      { label: "Repository", evidence: { state: "known", value: BARE_ARGV_REPO_HINT } },
    ],
    primaryAction: {
      kind: "argv",
      label: "Configure DocsFab",
      executable: "docsfab",
      args: ["setup"],
    },
    attention: null,
  });
  return renderCliPresentation(document, capabilities);
}
