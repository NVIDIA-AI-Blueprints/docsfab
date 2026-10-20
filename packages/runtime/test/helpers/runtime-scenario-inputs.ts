// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** Independently authored request data for portable runtime tests. */
export interface FirstPassScenarioInputs {
  readonly originalCreate: string;
  readonly createConfiguration: string;
  readonly createQuote: string;
  readonly createShortQuote: string;
  readonly updateConfiguration: string;
  readonly updateReference: string;
  readonly conflictingServicePort: string;
  readonly libraryName: string;
  readonly exportedFunction: string;
  readonly cliName: string;
}

export const PUBLIC_FIRST_PASS_REQUESTS: FirstPassScenarioInputs = {
  originalCreate:
    "Create docs/usage.md as an application developer guide to @example/record-kit. Show installation, imports and a small readRecord example using facts found in source. State supported defaults and limitations. Write only docs/usage.md. Preserve source, package settings and the other documentation. Keep this local; do not publish.",
  createConfiguration:
    "Add an operator configuration guide for samplectl. Describe the configure command using its source definitions, including connection and display options, defaults and saved settings. Add a link from the CLI page. Use repository evidence for every claim.",
  createQuote: "Add an operator configuration guide for samplectl",
  createShortQuote: "Add an operator configuration guide",
  updateConfiguration:
    "Refresh the configuration page against the implementation. Explain the current timer setting and endpoint variable; keep the existing troubleshooting advice and its stable anchor. Leave unrelated pages as they are.",
  updateReference:
    "Revise the CLI reference using parser definitions. Explain the current configure flags, defaults and exit statuses. Keep examples in place and leave the release notes alone.",
  conflictingServicePort:
    "Revise the deployment guide to state the listening port and show a health check. Resolve conflicting source evidence before changing that value. Ask one focused question if no authoritative answer is available, and retain the deployment procedure meanwhile.",
  libraryName: "@example/record-kit",
  exportedFunction: "readRecord",
  cliName: "samplectl",
};

export interface LiveScenarioInputs {
  readonly update: string;
  readonly create: string;
  readonly review: string;
  readonly context: string;
  readonly sourcePath: string;
  readonly originalDocument: string;
  readonly oldValue: string;
  readonly newValue: string;
}

export const PUBLIC_LIVE_REQUESTS: LiveScenarioInputs = {
  update:
    "Run the update-documentation workflow on docs/quickstart.md. Use src/sample-cli.mjs to correct the documented setting and structured output. Leave the other files alone. Keep the work local; do not commit, push, or open an MR.",
  create:
    "Run the create-documentation workflow for docs/cli-reference.md. Explain Sample CLI for application developers from src/sample-cli.mjs, with supported switches, defaults and failure examples. Preserve the other pages. Keep the work local; do not commit, push, or open an MR.",
  review:
    "Run the review-documentation workflow on docs/quickstart.md using src/sample-cli.mjs as evidence. Report incorrect claims without editing files.",
  context:
    "Context: docs/quickstart.md describes an old setting and output field. The current sample source defines the replacement setting and field, so the page needs a focused correction.",
  sourcePath: "src/sample-cli.mjs",
  originalDocument: "# Starting a report\n\nThe selected mode is basic.\n",
  oldValue: "basic",
  newValue: "advanced",
};

export interface PublicationScenarioInputs {
  readonly base: string;
  readonly sourcePath: string;
  readonly review: string;
  readonly create: string;
  readonly update: string;
  readonly restructure: string;
}

export const PUBLIC_PUBLICATION_REQUESTS: PublicationScenarioInputs = {
  base: "Create docs/cli-reference.md for Sample CLI from src/sample-cli.mjs.",
  sourcePath: "src/sample-cli.mjs",
  review: PUBLIC_LIVE_REQUESTS.review,
  create: PUBLIC_LIVE_REQUESTS.create,
  update: PUBLIC_LIVE_REQUESTS.update,
  restructure:
    "Run the restructure-documentation workflow on docs/guide.md for a first-time reader. Put prerequisites before installation, then usage and recovery. Retain supported facts, anchors and links, and leave other files alone. Keep the work local; do not commit, push, or open an MR.",
};
