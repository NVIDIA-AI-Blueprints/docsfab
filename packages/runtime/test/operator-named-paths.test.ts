// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Whether the operator's own input names a path is decided from that input
 * alone, and exactly: the tracked path, letter case included, as a whole token
 * of the request text, or an explicit target input. A bare file name names a
 * path only when the revision tracks exactly one file with that name. No
 * `./`, `..`, case folding, or Unicode lookalike names a path.
 */
import { describe, expect, it } from "vitest";

import {
  AGENT_INSTRUCTION_FILE_NAMES,
  isAgentInstructionFile,
  isHiddenPath,
  requiresOperatorNaming,
} from "../src/repository/agent-instruction-files.js";
import {
  NO_OPERATOR_NAMED_PATHS,
  operatorNamedPaths,
} from "../src/repository/operator-named-paths.js";

const TRACKED = ["AGENTS.md", "README.md", "docs/AGENTS.md", "docs/SKILL.md", "fern/SKILL.md"];

function names(text: string, path: string, trackedPaths: readonly string[] = TRACKED): boolean {
  return operatorNamedPaths({ texts: [text], trackedPaths }).names(path);
}

describe("the request text names a path only as the exact tracked path", () => {
  it.each([
    ["Update docs/AGENTS.md for the new flag.", "docs/AGENTS.md"],
    ["Update `docs/AGENTS.md` for the new flag.", "docs/AGENTS.md"],
    ["Update (docs/AGENTS.md) and nothing else.", "docs/AGENTS.md"],
    ["Fix [the guide](docs/.hidden/a.md) now.", "docs/.hidden/a.md"],
    ['Edit "docs/.cursor/rules/x.md": add a rule.', "docs/.cursor/rules/x.md"],
    ["Update docs/AGENTS.md#setup.", "docs/AGENTS.md"],
    ["First docs/guide.md, then docs/AGENTS.md", "docs/AGENTS.md"],
    ["请更新docs/AGENTS.md的内容。", "docs/AGENTS.md"],
  ])("%s names %s", (text, path) => {
    expect(names(text, path)).toBe(true);
  });

  it.each([
    ["Update ./docs/AGENTS.md for the new flag.", "docs/AGENTS.md", "a ./ prefix"],
    ["Update docs/x/../AGENTS.md for the new flag.", "docs/AGENTS.md", "a .. segment"],
    ["Update docs/./AGENTS.md for the new flag.", "docs/AGENTS.md", "a . segment"],
    ["Update docs/agents.md for the new flag.", "docs/AGENTS.md", "another letter case"],
    ["Update DOCS/AGENTS.md for the new flag.", "docs/AGENTS.md", "another directory case"],
    ["Update docs/SKILL.md for the new flag.", "docs/SKILL.md", "a Kelvin sign for K"],
    ["Update docs/ＡGENTS.md for the new flag.", "docs/AGENTS.md", "a full-width A"],
    ["Update docs/AGENTS.md́ for the new flag.", "docs/AGENTS.md", "a combining mark after it"],
    ["Update mydocs/AGENTS.md for the new flag.", "docs/AGENTS.md", "a longer path"],
    ["Update docs/AGENTS.md.bak for the new flag.", "docs/AGENTS.md", "a longer file name"],
    ["Update docs/AGENTS.mdx for the new flag.", "docs/AGENTS.md", "another extension"],
    ["Update docs/AGENTS.md/ for the new flag.", "docs/AGENTS.md", "a directory form"],
    ["Update @docs/AGENTS.md for the new flag.", "docs/AGENTS.md", "an @ mention"],
    ["Update https://example.com/docs/AGENTS.md now.", "docs/AGENTS.md", "a URL"],
    ["Fix whatever is stale in the documentation.", "docs/AGENTS.md", "no mention at all"],
  ])("%s does not name %s (%s)", (text, path) => {
    expect(names(text, path)).toBe(false);
  });

  it("matches the text as typed, never NFC-normalized", () => {
    // NFC maps the Kelvin sign to K, so a normalized match would name it.
    expect("docs/SKILL.md".normalize("NFC")).toBe("docs/SKILL.md");
    expect(names("Update docs/SKILL.md.", "docs/SKILL.md")).toBe(false);
  });
});

describe("a bare file name names the one tracked file with that name", () => {
  it("names docs/SKILL.md when nothing else is tracked as SKILL.md", () => {
    expect(names("Update SKILL.md for the new flag.", "docs/SKILL.md", ["docs/SKILL.md"])).toBe(
      true,
    );
  });

  it("names nothing when two tracked files share the name", () => {
    expect(names("Update SKILL.md for the new flag.", "docs/SKILL.md")).toBe(false);
    expect(names("Update SKILL.md for the new flag.", "fern/SKILL.md")).toBe(false);
  });

  it("counts a file outside the roots, so AGENTS.md beside docs/AGENTS.md names neither", () => {
    expect(names("Update AGENTS.md for the new flag.", "docs/AGENTS.md")).toBe(false);
  });

  it("names nothing a create would add: the page is not tracked yet", () => {
    expect(names("Create WARP.md for the docs.", "docs/WARP.md", TRACKED)).toBe(false);
  });

  it("names nothing when the bare name only ends a longer path in the text", () => {
    expect(
      names("Update guides/SKILL.md for the new flag.", "docs/SKILL.md", ["docs/SKILL.md"]),
    ).toBe(false);
  });

  it("matches the bare name in its letter case only", () => {
    expect(names("Update skill.md for the new flag.", "docs/SKILL.md", ["docs/SKILL.md"])).toBe(
      false,
    );
  });

  it("names nothing without a tracked listing", () => {
    expect(names("Update SKILL.md for the new flag.", "docs/SKILL.md", [])).toBe(false);
  });
});

describe("explicit target inputs and the fail-closed answer", () => {
  it("names an explicit target exactly, never a case variant", () => {
    const named = operatorNamedPaths({ texts: [], explicitPaths: ["docs/AGENTS.md"] });
    expect(named.names("docs/AGENTS.md")).toBe(true);
    expect(named.names("docs/agents.md")).toBe(false);
    expect(named.names("docs/CLAUDE.md")).toBe(false);
  });

  it("names nothing when the request cannot be read", () => {
    expect(NO_OPERATOR_NAMED_PATHS.names("docs/AGENTS.md")).toBe(false);
    expect(operatorNamedPaths({ texts: [""] }).names("")).toBe(false);
  });
});

describe("agent instruction files and hidden paths", () => {
  it.each([
    "docs/AGENTS.md",
    "docs/agents.md",
    "docs/AGENT.md",
    "docs/AGENTS.override.md",
    "docs/CLAUDE.md",
    "docs/CLAUDE.local.md",
    "docs/sub/GEMINI.md",
    "docs/copilot-instructions.md",
    "fern/SKILL.md",
    "docs/WARP.md",
    "docs/warp.mdx",
    "docs/QWEN.md",
    "docs/Qwen.md",
    "docs/CRUSH.md",
    "fern/pages/crush.mdx",
  ])("%s is an agent instruction file", (path) => {
    expect(isAgentInstructionFile(path)).toBe(true);
    expect(requiresOperatorNaming(path)).toBe(true);
  });

  it.each([
    "docs/agents-guide.md",
    "docs/agents/index.md",
    "docs/warp-guide.md",
    "docs/CONVENTIONS.md",
    "docs/claude-local.md",
    "docs/AGENTS.md.txt",
  ])("%s is neither an agent instruction file nor hidden", (path) => {
    expect(isAgentInstructionFile(path)).toBe(false);
    expect(isHiddenPath(path)).toBe(false);
    expect(requiresOperatorNaming(path)).toBe(false);
  });

  it.each(["docs/.hidden/a.md", "docs/.cursor/rules/x.md", "fern/.hidden.md", ".docsfab/x.md"])(
    "%s is a hidden path",
    (path) => {
      expect(isHiddenPath(path)).toBe(true);
      expect(requiresOperatorNaming(path)).toBe(true);
    },
  );

  it("lists WARP, QWEN and CRUSH and leaves CONVENTIONS out", () => {
    expect(AGENT_INSTRUCTION_FILE_NAMES).toEqual(
      expect.arrayContaining(["WARP", "QWEN", "CRUSH", "AGENTS", "CLAUDE", "SKILL"]),
    );
    expect(AGENT_INSTRUCTION_FILE_NAMES).not.toContain("CONVENTIONS");
  });
});
