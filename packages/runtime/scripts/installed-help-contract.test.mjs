// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { expect, test } from "vitest";

import { hasInstalledGeneralHelpContract } from "./lib/installed-help-contract.mjs";

const help = `DocsFab — governed documentation workflows on Pi
Usage
  docsfab <command> [options]
Start here
Configure a model profile: 'docsfab' 'setup'
List workflows: 'docsfab' 'list'
Run a read-only review: 'docsfab' 'run' 'review-documentation'
Delivery choices
Commands
  help: Display command help.
  list: List workflows.
  plan: Print a workflow plan.
  run: Run a workflow.
  setup: Configure the model profile.
Command help
  General: docsfab help
`;

test("accepts useful installed discovery help", () => {
  expect(hasInstalledGeneralHelpContract(help)).toBe(true);
});

test("rejects empty, missing, or unusable installed discovery help", () => {
  for (const broken of [
    "",
    help.replace("  docsfab <command> [options]", ""),
    help.replace("List workflows: 'docsfab' 'list'", "List workflows: list"),
    help.replace("  run: Run a workflow.", "  run: "),
    help.replace("  run: Run a workflow.", "  run:    "),
    help.replace("Command help\n", ""),
    help.replace("Start here\n", ""),
  ]) {
    expect(hasInstalledGeneralHelpContract(broken), broken).toBe(false);
  }
});
