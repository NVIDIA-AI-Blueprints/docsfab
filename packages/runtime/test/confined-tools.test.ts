// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFile } from "node:child_process";
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";

import { createConfinedToolSet, RECOVERABLE_MISS_MESSAGES } from "../src/harness/confined-tools.js";
import { CANON_TOOL_NAMES } from "../src/harness/canon-tools.js";
import { grantedTools } from "../src/harness/pi-tool-confine.js";
import { OBSERVATION_TOOL_NAMES } from "../src/harness/observation-tools.js";
import { documentationAuditSearch } from "../src/maturity/audit-search-plan.js";
import { documentationObservationSearch } from "../src/search/observation-search-plan.js";
import { temporaryRoots } from "./helpers/temp.js";

const executeFile = promisify(execFile);
const temporaryDirectories = temporaryRoots();

async function fixture() {
  const root = await temporaryDirectories.create("docsfab-confined-tools-");
  const workspace = join(root, "workspace");
  const outside = join(root, "outside");
  const skill = join(root, "skill");
  const quality = join(root, "quality");
  await Promise.all([
    mkdir(join(workspace, "docs"), { recursive: true }),
    mkdir(join(workspace, "docs", "guides", "deep"), { recursive: true }),
    mkdir(outside, { recursive: true }),
    mkdir(join(skill, "references"), { recursive: true }),
    mkdir(join(quality, "profiles"), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(join(workspace, "docs", "guide.md"), "alpha old\n", "utf8"),
    writeFile(join(workspace, "docs", "guide.txt"), "text guide\n", "utf8"),
    writeFile(join(workspace, "docs", "guides", "guide1.md"), "one\n", "utf8"),
    writeFile(join(workspace, "docs", "guides", "guide10.md"), "ten\n", "utf8"),
    writeFile(join(workspace, "docs", "guides", "deep", "guide2.md"), "two\n", "utf8"),
    writeFile(join(outside, "secret.md"), "outside secret\n", "utf8"),
    writeFile(join(outside, "target.md"), "outside unchanged\n", "utf8"),
    writeFile(join(skill, "references", "rubric.md"), "governed rubric\n", "utf8"),
    writeFile(join(quality, "profiles", "default.json"), '{"id":"default"}\n', "utf8"),
  ]);
  await symlink(outside, join(workspace, "escape"));

  const toolSet = await createConfinedToolSet({
    workspacePath: workspace,
    allowWrite: true,
    governedSkill: { id: "write-documentation", directory: skill },
    governedQualityDirectory: quality,
  });
  const tools = new Map(toolSet.definitions.map((tool) => [tool.name, tool]));
  const call = async (name: string, parameters: Record<string, unknown>) => {
    const tool = tools.get(name);
    if (!tool) throw new Error(`Missing tool ${name}`);
    return tool.execute(`test-${name}`, parameters, undefined, undefined, undefined as never);
  };

  return { root, workspace, outside, skill, toolSet, call };
}

function resultText(result: { content: Array<{ type: string; text?: string }> }) {
  return result.content
    .filter((item) => item.type === "text")
    .map((item) => item.text ?? "")
    .join("\n");
}

function resultPaths(result: { content: Array<{ type: string; text?: string }> }) {
  return resultText(result).split("\n").filter(Boolean).sort();
}

function parametersFor(tool: string, path: string): Record<string, unknown> {
  switch (tool) {
    case "read":
      return { path };
    case "grep":
      return { path, pattern: "alpha", literal: true };
    case "find":
      return { path, pattern: "*.md" };
    case "ls":
      return { path };
    case "edit":
      return { path, edits: [{ oldText: "old", newText: "new" }] };
    case "write":
      return { path, content: "mutated\n" };
    default:
      throw new Error(`Unexpected tool ${tool}`);
  }
}

describe("Pi-native confined filesystem tools", () => {
  it("replaces all six built-in names while leaving bash unavailable", async () => {
    const { workspace, toolSet } = await fixture();
    expect(toolSet.definitions.map((tool) => tool.name).sort()).toEqual(
      ["edit", "find", "grep", "ls", "read", "write", ...CANON_TOOL_NAMES].sort(),
    );
    expect(toolSet.definitions.some((tool) => tool.name === "bash")).toBe(false);

    const readOnly = await createConfinedToolSet({
      workspacePath: workspace,
      allowWrite: false,
    });
    expect(readOnly.definitions.map((tool) => tool.name).sort()).toEqual(
      ["find", "grep", "ls", "read", ...CANON_TOOL_NAMES].sort(),
    );
  });

  it("schedules get_section only for the observation search pack", async () => {
    const { workspace } = await fixture();
    const observation = await createConfinedToolSet({
      workspacePath: workspace,
      allowWrite: false,
      search: documentationObservationSearch,
    });
    expect(observation.definitions.map((tool) => tool.name)).toEqual(
      expect.arrayContaining([...OBSERVATION_TOOL_NAMES]),
    );

    const audit = await createConfinedToolSet({
      workspacePath: workspace,
      allowWrite: false,
      search: documentationAuditSearch,
    });
    expect(audit.definitions.map((tool) => tool.name)).not.toContain("get_section");
    expect(grantedTools("read-only", "inference", documentationObservationSearch)).toEqual(
      expect.arrayContaining([...OBSERVATION_TOOL_NAMES]),
    );
    expect(grantedTools("read-only", "inference", documentationAuditSearch)).not.toContain(
      "get_section",
    );
  });

  it.each(["read", "grep", "find", "ls", "edit", "write"])(
    "rejects absolute, home-relative, traversal, NUL, and symlink escapes for %s",
    async (tool) => {
      const { outside, call } = await fixture();
      const fileTarget = join(outside, "target.md");
      const directoryTool = tool === "grep" || tool === "find" || tool === "ls";
      const attempts = [
        directoryTool ? outside : fileTarget,
        "~/.docsfab-sensitive",
        directoryTool ? "../outside" : "../outside/target.md",
        "bad\0path",
        directoryTool ? "escape" : "escape/target.md",
      ];

      for (const path of attempts) {
        try {
          await call(tool, parametersFor(tool, path));
          throw new Error("Expected DocsFab to reject the escape attempt.");
        } catch (error) {
          expect(String(error)).toContain("DocsFab denied");
          expect(String(error)).not.toContain("outside secret");
        }
      }

      expect(await readFile(fileTarget, "utf8")).toBe("outside unchanged\n");
    },
  );

  it("activates only the SDK-confined definitions in a Pi session", async () => {
    const { root, workspace, outside, toolSet } = await fixture();
    const agentDirectory = join(root, "agent");
    await mkdir(agentDirectory);
    const resourceLoader = new DefaultResourceLoader({
      cwd: workspace,
      agentDir: agentDirectory,
      noExtensions: true,
      noPromptTemplates: true,
      noThemes: true,
      noSkills: true,
    });
    await resourceLoader.reload();
    const { session } = await createAgentSession({
      cwd: workspace,
      resourceLoader,
      sessionManager: SessionManager.inMemory(workspace),
      tools: toolSet.definitions.map((tool) => tool.name),
      excludeTools: ["bash"],
      customTools: toolSet.definitions,
    });

    try {
      expect(session.getActiveToolNames().sort()).toEqual(
        ["edit", "find", "grep", "ls", "read", "write", ...CANON_TOOL_NAMES].sort(),
      );
      expect(session.getAllTools().some((tool) => tool.name === "bash")).toBe(false);
      expect(session.getAllTools().filter((tool) => tool.sourceInfo.source === "sdk")).toHaveLength(
        6 + CANON_TOOL_NAMES.length,
      );
      const read = session.getToolDefinition("read");
      expect(read).toBeDefined();
      await expect(
        read!.execute(
          "session-read",
          { path: join(outside, "secret.md") },
          undefined,
          undefined,
          undefined as never,
        ),
      ).rejects.toThrow("DocsFab denied");
    } finally {
      session.dispose();
    }
  });

  it("supports normal workspace reads, searches, listings, edits, and writes", async () => {
    const { workspace, call } = await fixture();

    expect(resultText(await call("read", { path: "docs/guide.md" }))).toContain("alpha old");
    expect(
      resultText(
        await call("grep", {
          path: "docs",
          pattern: "alpha",
          literal: true,
        }),
      ),
    ).toContain("guide.md:1: alpha old");
    expect(resultText(await call("find", { path: ".", pattern: "**/*.md" }))).toContain(
      "docs/guide.md",
    );
    expect(resultText(await call("ls", { path: "docs" }))).toContain("guide.md");

    await call("edit", {
      path: "docs/guide.md",
      edits: [{ oldText: "alpha old", newText: "alpha revised" }],
    });
    await call("write", { path: "docs/new.md", content: "new page\n" });

    expect(await readFile(join(workspace, "docs", "guide.md"), "utf8")).toBe("alpha revised\n");
    expect(await readFile(join(workspace, "docs", "new.md"), "utf8")).toBe("new page\n");
  });

  it("enforces signed write leaves at the filesystem tool boundary", async () => {
    const { workspace } = await fixture();
    const toolSet = await createConfinedToolSet({
      workspacePath: workspace,
      allowWrite: true,
      allowedWritePaths: ["docs/guide.md", "docs/approved/new.md"],
    });
    const tools = new Map(toolSet.definitions.map((tool) => [tool.name, tool]));
    const call = (name: string, parameters: Record<string, unknown>) =>
      tools.get(name)!.execute("test", parameters, undefined, undefined, undefined as never);

    await call("edit", {
      path: "docs/guide.md",
      edits: [{ oldText: "old", newText: "approved" }],
    });
    await call("write", { path: "docs/approved/new.md", content: "approved\n" });
    await expect(
      call("write", {
        path: "package.json",
        content: "unapproved\n",
      }),
    ).rejects.toThrow("DocsFab denied");

    expect(await readFile(join(workspace, "docs", "guide.md"), "utf8")).toBe("alpha approved\n");
    expect(await readFile(join(workspace, "docs", "approved", "new.md"), "utf8")).toBe(
      "approved\n",
    );
  });

  it("documents the confined find dialect at the model tool boundary", async () => {
    const { toolSet } = await fixture();
    const find = toolSet.definitions.find((tool) => tool.name === "find");

    expect(find?.description).toContain("* matches zero or more characters");
    expect(find?.description).toContain("? matches exactly one character");
    expect(find?.description).toContain("** matches across directory segments");
    expect(find?.description).toContain("Brace expansion");
    expect(find?.description).toContain("character classes");
  });

  it.each([
    ["literal paths", "docs/guide.md", ["docs/guide.md"]],
    [
      "basename * at any depth",
      "*.md",
      [
        "docs/guide.md",
        "docs/guides/deep/guide2.md",
        "docs/guides/guide1.md",
        "docs/guides/guide10.md",
      ],
    ],
    ["segment-local *", "docs/*.md", ["docs/guide.md"]],
    ["segment-local ?", "docs/guide.??", ["docs/guide.md"]],
    ["recursive ** including zero directories", "docs/**/guide.md", ["docs/guide.md"]],
    [
      "recursive ** across directories",
      "docs/**/guide?.md",
      ["docs/guides/deep/guide2.md", "docs/guides/guide1.md"],
    ],
    [
      "terminal recursive **",
      "docs/**",
      [
        "docs/guide.md",
        "docs/guide.txt",
        "docs/guides",
        "docs/guides/deep",
        "docs/guides/deep/guide2.md",
        "docs/guides/guide1.md",
        "docs/guides/guide10.md",
      ],
    ],
  ])("supports %s find patterns", async (_form, pattern, expected) => {
    const { call } = await fixture();

    expect(resultPaths(await call("find", { path: ".", pattern }))).toEqual(expected);
  });

  it.each([
    ["empty patterns", ""],
    ["leading negation", "!**/*.md"],
    ["brace expansion", "docs/{guide,other}.md"],
    ["character classes", "docs/guide[12].md"],
    ["absolute patterns", "/docs/*.md"],
    ["Windows absolute patterns", "C:\\docs\\*.md"],
    ["home-relative patterns", "~/*.md"],
    ["parent traversal", "../*.md"],
    ["NUL", "docs/guide\0.md"],
  ])("rejects unsupported %s explicitly", async (_form, pattern) => {
    const { toolSet, call } = await fixture();

    await expect(call("find", { path: ".", pattern })).rejects.toThrow(
      "DocsFab does not support the requested tool pattern.",
    );
    expect(toolSet.getFailureCategories()).toEqual([{ category: "unsupported-pattern", count: 1 }]);
  });

  it("resolves governed skill assets through read, list, find, and grep", async () => {
    const { toolSet, call } = await fixture();
    const virtualRoot = toolSet.governedSkillVirtualPath;
    expect(virtualRoot).toBe(".docsfab-governed-assets/skills/write-documentation");
    expect(
      resultText(await call("read", { path: `${virtualRoot}/references/rubric.md` })),
    ).toContain("governed rubric");
    expect(resultText(await call("ls", { path: virtualRoot }))).toContain("references/");
    expect(resultText(await call("find", { path: virtualRoot, pattern: "**/*.md" }))).toBe(
      "references/rubric.md",
    );
    expect(
      resultText(
        await call("grep", {
          path: virtualRoot,
          pattern: "governed rubric",
          literal: true,
        }),
      ),
    ).toContain("references/rubric.md:1: governed rubric");
    expect(toolSet.getFailureCategories()).toEqual([]);
  });

  it("mounts locked quality assets read-only beside the governed skill", async () => {
    const { toolSet, call } = await fixture();
    const virtualRoot = toolSet.governedQualityVirtualPath;
    expect(virtualRoot).toBe(".docsfab-governed-assets/quality");
    expect(
      resultText(await call("read", { path: `${virtualRoot}/profiles/default.json` })),
    ).toContain('"id":"default"');
    await expect(
      call("write", {
        path: `${virtualRoot}/profiles/default.json`,
        content: "tampered\n",
      }),
    ).rejects.toThrow("DocsFab denied");
  });

  it("keeps governed skill assets read-only behind an explicit virtual root", async () => {
    const { toolSet, call } = await fixture();
    const virtualRoot = toolSet.governedSkillVirtualPath!;
    await expect(
      call("write", {
        path: `${virtualRoot}/references/rubric.md`,
        content: "tampered\n",
      }),
    ).rejects.toThrow("DocsFab denied");
  });

  it("records only closed, redacted tool-failure categories", async () => {
    const { outside, toolSet, call } = await fixture();

    await expect(call("read", { path: "missing.md" })).rejects.toThrow("target is unavailable");
    await expect(call("read", { path: join(outside, "secret.md") })).rejects.toThrow(
      "DocsFab denied",
    );
    await expect(call("find", { path: ".", pattern: "docs/{guide,other}.md" })).rejects.toThrow(
      "does not support",
    );
    await expect(call("read", { path: "docs" })).rejects.toThrow(
      RECOVERABLE_MISS_MESSAGES["directory-not-file"],
    );

    expect(toolSet.getFailureCategories()).toEqual([
      { category: "denied-path", count: 1 },
      { category: "expected-missing-probe", count: 1 },
      { category: "recoverable-miss", count: 1 },
      { category: "unsupported-pattern", count: 1 },
    ]);
    expect(JSON.stringify(toolSet.getFailureCategories())).not.toContain(outside);
    expect(JSON.stringify(toolSet.getFailureCategories())).not.toContain("outside secret");
  });

  it("leaves write-tool changes capturable as a Git patch", async () => {
    const { workspace, call } = await fixture();
    await executeFile("git", ["init", "--quiet"], { cwd: workspace });
    await executeFile("git", ["add", "docs/guide.md"], { cwd: workspace });
    await call("edit", {
      path: "docs/guide.md",
      edits: [{ oldText: "old", newText: "captured" }],
    });
    await call("write", { path: "docs/created.md", content: "created\n" });
    await executeFile("git", ["add", "-N", "docs/created.md"], { cwd: workspace });

    const { stdout } = await executeFile("git", ["diff", "--", "docs"], {
      cwd: workspace,
    });
    expect(stdout).toContain("+alpha captured");
    expect(stdout).toContain("+created");
  });
});

// The model knows the governed skill only by its virtual root, so the host
// location of the bundle is an ordinary absolute path and is denied.
describe("governed skill location and mutation refusals", () => {
  it("serves the skill at its virtual root and denies its absolute host location", async () => {
    const { skill, toolSet, call } = await fixture();
    const virtualRoot = toolSet.governedSkillVirtualPath!;
    expect(
      resultText(await call("read", { path: `${virtualRoot}/references/rubric.md` })),
    ).toContain("governed rubric");

    const hostLocations: Array<[string, Record<string, unknown>]> = [
      ["read", { path: join(skill, "references", "rubric.md") }],
      ["ls", { path: skill }],
      ["find", { path: skill, pattern: "**/*.md" }],
      ["grep", { path: skill, pattern: "governed rubric", literal: true }],
    ];
    for (const [tool, parameters] of hostLocations) {
      await expect(call(tool, parameters), tool).rejects.toThrow("DocsFab denied");
    }
    expect(toolSet.getFailureCategories()).toEqual([
      { category: "denied-path", count: hostLocations.length },
    ]);
    expect(toolSet.getMutationBoundaryDenials()).toBe(0);
  });

  it("still denies absolute writes, traversal, workspace, and symlink escapes", async () => {
    const { workspace, outside, skill, toolSet, call } = await fixture();
    await symlink(join(outside, "secret.md"), join(skill, "references", "leak.md"));
    const deniedReads = [
      join(workspace, "docs", "guide.md"),
      `${skill}/../skill/references/rubric.md`,
      join(skill, "references", "leak.md"),
      `${toolSet.governedSkillVirtualPath}/references/leak.md`,
    ];
    for (const path of deniedReads) {
      await expect(call("read", { path })).rejects.toThrow("DocsFab denied");
    }
    for (const tool of ["write", "edit"]) {
      await expect(
        call(tool, parametersFor(tool, join(skill, "references", "rubric.md"))),
      ).rejects.toThrow("DocsFab denied");
    }

    expect(await readFile(join(skill, "references", "rubric.md"), "utf8")).toBe(
      "governed rubric\n",
    );
    expect(toolSet.getFailureCategories()).toEqual([
      { category: "denied-path", count: deniedReads.length + 2 },
    ]);
    // Only the two refused mutations are mutation-boundary refusals.
    expect(toolSet.getMutationBoundaryDenials()).toBe(2);
  });

  it("counts refused mutations apart from refused reads", async () => {
    const { workspace } = await fixture();
    const toolSet = await createConfinedToolSet({
      workspacePath: workspace,
      allowWrite: true,
      allowedWritePaths: ["docs/guide.md"],
    });
    const tools = new Map(toolSet.definitions.map((tool) => [tool.name, tool]));
    const call = (name: string, parameters: Record<string, unknown>) =>
      tools.get(name)!.execute("test", parameters, undefined, undefined, undefined as never);

    await expect(call("read", { path: "/etc/hosts" })).rejects.toThrow("DocsFab denied");
    await expect(call("read", { path: "../outside/secret.md" })).rejects.toThrow("DocsFab denied");
    expect(toolSet.getMutationBoundaryDenials()).toBe(0);

    await expect(call("write", { path: "src/module.py", content: "x\n" })).rejects.toThrow(
      "DocsFab denied",
    );
    await expect(
      call("edit", { path: "changelog.d/entry.md", edits: [{ oldText: "a", newText: "b" }] }),
    ).rejects.toThrow("DocsFab denied");
    expect(toolSet.getMutationBoundaryDenials()).toBe(2);
    expect(toolSet.getFailureCategories()).toEqual([{ category: "denied-path", count: 4 }]);
  });
});
