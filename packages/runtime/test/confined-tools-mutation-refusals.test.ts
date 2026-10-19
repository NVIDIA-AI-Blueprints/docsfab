// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Every edit/write the confinement refuses is counted under the closed rule
 * that refused it, so an operator can see what to change without the path or
 * any model text. The counts by reason are the mutation-boundary refusal
 * count; refused reads and malformed calls on a granted path are not in it.
 */
import { link, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createConfinedToolSet, safeFailureMessage } from "../src/harness/confined-tools.js";
import { VIRTUAL_WORKSPACE_CWD } from "../src/harness/pi-session.js";
import { isRepositoryBootstrapGuidancePath } from "../src/onboarding/bootstrap-result.js";
import { PATH_REFUSAL_REASONS, type PathRefusalReason } from "../src/records/contracts.js";
import {
  createAuditHarness,
  createRepository,
  getWorkflow,
  resetSharedTestState,
  stepInput,
  textTurn,
  toolTurn,
} from "./support/pi-harness-session-fixtures.js";

const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  await resetSharedTestState();
});

async function tempDirectory(prefix: string): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  roots.push(root);
  return root;
}

async function workspace(): Promise<{ root: string; outside: string }> {
  const root = await tempDirectory("docsfab-mutation-refusals-");
  const outside = await tempDirectory("docsfab-mutation-refusals-outside-");
  await mkdir(join(root, "docs"), { recursive: true });
  await writeFile(join(root, "docs", "guide.md"), "# Guide\n\nOld text.\n");
  await writeFile(join(root, "docs", "index.md"), "# Index\n");
  await writeFile(join(root, "package.json"), "{}\n");
  await writeFile(join(outside, "secret.md"), "# Secret\n");
  await symlink(join(outside, "secret.md"), join(root, "docs", "linked.md"));
  await symlink(outside, join(root, "escape"));
  return { root, outside };
}

type ToolSet = Awaited<ReturnType<typeof createConfinedToolSet>>;

/** Pi's own order: prepare, clone (validateToolArguments), then execute. */
function caller(toolSet: ToolSet) {
  const tools = new Map(toolSet.definitions.map((tool) => [tool.name, tool]));
  return (name: string, raw: Record<string, unknown>) => {
    const tool = tools.get(name)!;
    const prepared = structuredClone(tool.prepareArguments ? tool.prepareArguments(raw) : raw);
    return tool.execute("call", prepared as never, undefined, undefined, undefined as never);
  };
}

function writeArguments(tool: "edit" | "write", path: unknown): Record<string, unknown> {
  return tool === "write"
    ? { path, content: "x\n" }
    : { path, edits: [{ oldText: "Old text.", newText: "x" }] };
}

const PLAN_REFUSALS: readonly { path: unknown; reason: PathRefusalReason }[] = [
  { path: "docs/index.md", reason: "outside-grant" },
  { path: "docs/new.md", reason: "outside-grant" },
  { path: "/tmp/docsfab-refusal-absolute.md", reason: "absolute-path" },
  { path: "~/docsfab-refusal-home.md", reason: "absolute-path" },
  { path: "file:///tmp/docsfab-refusal-url.md", reason: "absolute-path" },
  { path: "\\\\server\\share\\docsfab-refusal.md", reason: "absolute-path" },
  { path: "C:\\docsfab-refusal.md", reason: "absolute-path" },
  { path: "docs/../../docsfab-refusal.md", reason: "traversal" },
  { path: `${VIRTUAL_WORKSPACE_CWD}/../docsfab-refusal.md`, reason: "traversal" },
  { path: ".docsfab-governed-assets/skills/x/SKILL.md", reason: "governed-asset" },
  { path: "docs/gu\0ide.md", reason: "nul-byte" },
  { path: 7, reason: "missing-path" },
  { path: undefined, reason: "missing-path" },
];

describe("each refused edit/write names the rule that refused it", () => {
  it.each(["edit", "write"] as const)(
    "counts %s refusals by reason under an approved plan",
    async (tool) => {
      const { root } = await workspace();
      const toolSet = await createConfinedToolSet({
        workspacePath: root,
        allowWrite: true,
        allowedWritePaths: ["docs/guide.md"],
      });
      const call = caller(toolSet);
      for (const { path } of PLAN_REFUSALS) {
        await expect(call(tool, writeArguments(tool, path))).rejects.toThrow(
          safeFailureMessage("denied-path"),
        );
      }
      const expected = new Map<PathRefusalReason, number>();
      for (const { reason } of PLAN_REFUSALS) expected.set(reason, (expected.get(reason) ?? 0) + 1);
      expect(toolSet.getMutationRefusals()).toEqual(
        [...expected.entries()]
          .map(([reason, count]) => ({ reason, count }))
          .sort((left, right) => left.reason.localeCompare(right.reason)),
      );
      expect(toolSet.getMutationBoundaryDenials()).toBe(PLAN_REFUSALS.length);
      expect(toolSet.getFailureCategories()).toEqual([
        { category: "denied-path", count: PLAN_REFUSALS.length },
      ]);
      expect(await readFile(join(root, "docs", "guide.md"), "utf8")).toBe("# Guide\n\nOld text.\n");
    },
  );

  it.each(["edit", "write"] as const)(
    "names a symbolic link on the %s path, whether the link is a file or an ancestor",
    async (tool) => {
      const { root, outside } = await workspace();
      const toolSet = await createConfinedToolSet({ workspacePath: root, allowWrite: true });
      const call = caller(toolSet);
      for (const path of ["docs/linked.md", "escape/secret.md"]) {
        await expect(call(tool, writeArguments(tool, path))).rejects.toThrow(
          safeFailureMessage("denied-path"),
        );
      }
      expect(toolSet.getMutationRefusals()).toEqual([{ reason: "link", count: 2 }]);
      expect(await readFile(join(outside, "secret.md"), "utf8")).toBe("# Secret\n");
    },
  );

  it("names a hard-linked guidance file and a non-guidance path under the bootstrap grant", async () => {
    const { root, outside } = await workspace();
    await link(join(outside, "secret.md"), join(root, "AGENTS.md"));
    const toolSet = await createConfinedToolSet({
      workspacePath: root,
      allowWrite: true,
      isWritePathAllowed: isRepositoryBootstrapGuidancePath,
    });
    const call = caller(toolSet);
    await expect(call("write", { path: "AGENTS.md", content: "# Agents\n" })).rejects.toThrow(
      safeFailureMessage("denied-path"),
    );
    await expect(
      call("write", { path: `${VIRTUAL_WORKSPACE_CWD}/package.json`, content: "{}" }),
    ).rejects.toThrow(safeFailureMessage("denied-path"));
    await call("write", { path: `${VIRTUAL_WORKSPACE_CWD}/README.md`, content: "# Repo\n" });
    expect(toolSet.getMutationRefusals()).toEqual([
      { reason: "link", count: 1 },
      { reason: "outside-grant", count: 1 },
    ]);
    expect(toolSet.getMutationBoundaryDenials()).toBe(2);
    expect(await readFile(join(outside, "secret.md"), "utf8")).toBe("# Secret\n");
    expect(await readFile(join(root, "README.md"), "utf8")).toBe("# Repo\n");
  });

  it("counts no reason for a refused read or a corrected malformed edit on a granted path", async () => {
    const { root } = await workspace();
    const toolSet = await createConfinedToolSet({
      workspacePath: root,
      allowWrite: true,
      allowedWritePaths: ["docs/guide.md"],
    });
    const call = caller(toolSet);
    for (const path of ["../outside.md", "/etc/hosts", "docs/linked.md"]) {
      await expect(call("read", { path })).rejects.toThrow(safeFailureMessage("denied-path"));
    }
    await expect(
      call("edit", { path: "docs/guide.md", oldText: "Old text.", newText: "x" }),
    ).rejects.toThrow();
    await call("edit", {
      path: "docs/guide.md",
      edits: [{ oldText: "Old text.", newText: "New text." }],
    });
    expect(toolSet.getMutationRefusals()).toEqual([]);
    expect(toolSet.getMutationBoundaryDenials()).toBe(0);
    expect(toolSet.getFailureCategories()).toEqual([
      { category: "denied-path", count: 3 },
      { category: "malformed-arguments-corrected", count: 1 },
    ]);
  });

  // A write naming the root needs no ".." to fail; Pi would first create the
  // root's parent directory. The reason is the root itself, in every grant.
  it.each([
    { grant: "no grant or gate", options: {} },
    { grant: "an approved plan", options: { allowedWritePaths: ["docs/guide.md"] } },
    {
      grant: "the bootstrap gate",
      options: { isWritePathAllowed: isRepositoryBootstrapGuidancePath },
    },
  ])("names the workspace root for an edit or write to it under $grant", async ({ options }) => {
    const { root } = await workspace();
    const toolSet = await createConfinedToolSet({
      workspacePath: root,
      allowWrite: true,
      ...options,
    });
    const call = caller(toolSet);
    const roots = [".", "", "./", VIRTUAL_WORKSPACE_CWD, `${VIRTUAL_WORKSPACE_CWD}/`];
    for (const tool of ["edit", "write"] as const) {
      for (const path of roots) {
        await expect(
          call(tool, writeArguments(tool, path)),
          `${tool} ${JSON.stringify(path)}`,
        ).rejects.toThrow(safeFailureMessage("denied-path"));
      }
    }
    expect(toolSet.getMutationRefusals()).toEqual([
      { reason: "workspace-root", count: roots.length * 2 },
    ]);
    expect(toolSet.getFailureCategories()).toEqual([
      { category: "denied-path", count: roots.length * 2 },
    ]);
    expect(await readFile(join(root, "docs", "guide.md"), "utf8")).toBe("# Guide\n\nOld text.\n");
  });

  it("keeps the reason vocabulary closed, sorted, and unique", () => {
    expect([...PATH_REFUSAL_REASONS]).toEqual([...new Set(PATH_REFUSAL_REASONS)].sort());
  });
});

describe("Pi's argument preparation and path resolution stay inside the judged form", () => {
  // Pi's validateToolArguments converts a number to the string its schema
  // declares. The confinement must judge the call as the model sent it.
  it("refuses a numeric write path through the real Pi session instead of opening its string form", async () => {
    const repositoryPath = await createRepository();
    const base = stepInput(repositoryPath);
    const workflow = getWorkflow("restructure-documentation");
    const step = workflow.steps.find((candidate) => candidate.id === "write-documentation")!;
    const requests: string[] = [];
    vi.stubGlobal("fetch", async (_request: RequestInfo | URL, init?: RequestInit) => {
      requests.push(String(init?.body));
      if (requests.length === 1) {
        return toolTurn([{ id: "call-1", name: "write", arguments: { path: 7, content: "x\n" } }]);
      }
      if (requests.length === 2) {
        return toolTurn([
          { id: "call-2", name: "write", arguments: { path: "@README.md", content: "# At\n" } },
        ]);
      }
      return textTurn("The requested documentation was updated.");
    });

    const result = await (await createAuditHarness()).runStep({ ...base, workflow, step });

    expect(requests).toHaveLength(3);
    expect(result.mutationBoundaryDenials).toBe(1);
    expect(result.tools?.failureCategories).toEqual([{ category: "denied-path", count: 1 }]);
    await expect(readFile(join(repositoryPath, "7"), "utf8")).rejects.toThrow();
    // Pi drops one leading "@", and so does the judged form.
    expect(await readFile(join(repositoryPath, "README.md"), "utf8")).toBe("# At\n");
  });
});
