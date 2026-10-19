// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Agent instruction files and hidden paths: Markdown that steers coding agents
 * rather than documenting the product. One list serves the documentation write
 * rule, the live agent's scope, the hosted write grant, and the repository
 * inventory's instruction scopes.
 *
 * Agent configuration directories, such as `.cursor/rules/`, `.claude/`, and
 * `.github/`, all start with a dot, so the hidden-path rule covers every file
 * under them.
 */

/**
 * Base names, without `.md` or `.mdx`, of the files coding agents load from a
 * directory, and of skill definitions (`SKILL.md`). They match in any letter
 * case. This policy keeps `CONVENTIONS.md` as an ordinary human conventions
 * page; the accepted list does not classify it as an agent instruction file.
 */
export const AGENT_INSTRUCTION_FILE_NAMES: readonly string[] = Object.freeze([
  "AGENT",
  "AGENTS",
  "AGENTS.override",
  "CLAUDE",
  "CLAUDE.local",
  "COPILOT-INSTRUCTIONS",
  "CRUSH",
  "GEMINI",
  "QWEN",
  "SKILL",
  "WARP",
]);

const AGENT_INSTRUCTION_FILE = new RegExp(
  `(?:^|/)(?:${AGENT_INSTRUCTION_FILE_NAMES.map((name) => name.replaceAll(".", "\\.")).join("|")})\\.mdx?$`,
  "iu",
);

/** Whether `path`'s file name is an agent instruction or skill file, in any directory. */
export function isAgentInstructionFile(path: string): boolean {
  return AGENT_INSTRUCTION_FILE.test(path);
}

/** Whether a segment of `path`, a directory or the file itself, starts with `.`. */
export function isHiddenPath(path: string): boolean {
  return path.split("/").some((segment) => segment.startsWith("."));
}

/**
 * Whether DocsFab writes `path` inside the documentation roots only when the
 * operator's request names it: an agent instruction file or a hidden path.
 */
export function requiresOperatorNaming(path: string): boolean {
  return isAgentInstructionFile(path) || isHiddenPath(path);
}
