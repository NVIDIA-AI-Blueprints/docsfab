// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** The installed CLI must expose useful discovery and a copyable first action. */
export function hasInstalledGeneralHelpContract(stdout) {
  if (!stdout.startsWith("DocsFab — governed documentation workflows on Pi\n")) return false;

  const sections = ["Usage", "Start here", "Delivery choices", "Commands", "Command help"];
  const lines = stdout.trimEnd().split("\n");
  const boundaries = sections.map((section) => lines.indexOf(section));
  if (boundaries.some((index) => index < 0)) return false;
  if (boundaries.some((index, position) => position > 0 && index <= boundaries[position - 1])) {
    return false;
  }

  const [usage, start, delivery, commands, commandHelp] = boundaries;
  if (lines[usage + 1] !== "  docsfab <command> [options]") return false;

  const firstActions = lines.slice(start + 1, delivery);
  for (const action of [
    "Configure a model profile: 'docsfab' 'setup'",
    "List workflows: 'docsfab' 'list'",
    "Run a read-only review: 'docsfab' 'run' 'review-documentation'",
  ]) {
    if (!firstActions.includes(action)) return false;
  }

  const commandLines = lines.slice(commands + 1, commandHelp);
  for (const command of ["help", "list", "plan", "run", "setup"]) {
    const prefix = `  ${command}: `;
    if (!commandLines.some((line) => line.startsWith(prefix) && line.slice(prefix.length).trim())) {
      return false;
    }
  }

  return lines.slice(commandHelp + 1).includes("  General: docsfab help");
}
