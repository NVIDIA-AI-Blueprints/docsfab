// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * A tool call whose arguments do not match the schema is not a
 * mutation-boundary refusal, and a path under the advertised virtual cwd
 * (`/workspace`) names the workspace. Neither opens a path outside the grant:
 * the confinement judges exactly the path Pi's file tools open.
 */
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createConfinedToolSet,
  malformedArgumentsMessage,
  safeFailureMessage,
} from "../src/harness/confined-tools.js";
import { VIRTUAL_WORKSPACE_CWD } from "../src/harness/pi-session.js";
import { isRepositoryBootstrapGuidancePath } from "../src/onboarding/bootstrap-result.js";
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
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  await resetSharedTestState();
});

async function workspace(): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "docsfab-malformed-tools-")));
  roots.push(root);
  await mkdir(join(root, "docs"), { recursive: true });
  await writeFile(join(root, "docs", "guide.md"), "# Guide\n\nOld text.\n");
  await writeFile(join(root, "docs", "index.md"), "# Index\n");
  await writeFile(join(root, "package.json"), "{}\n");
  return root;
}

async function planToolSet(root: string) {
  return toolSetFor(
    await createConfinedToolSet({
      workspacePath: root,
      allowWrite: true,
      allowedWritePaths: ["docs/guide.md"],
    }),
  );
}

type ToolCall = (name: string, raw: Record<string, unknown>) => Promise<unknown>;

function toolSetFor(toolSet: Awaited<ReturnType<typeof createConfinedToolSet>>) {
  const tools = new Map(toolSet.definitions.map((tool) => [tool.name, tool]));
  /** Pi's own order: prepare, clone (validateToolArguments), then execute. */
  const prepare = (name: string, raw: Record<string, unknown>) => {
    const tool = tools.get(name)!;
    return structuredClone(tool.prepareArguments ? tool.prepareArguments(raw) : raw);
  };
  const execute = (name: string, prepared: unknown) =>
    tools.get(name)!.execute("call", prepared as never, undefined, undefined, undefined as never);
  const call = (name: string, raw: Record<string, unknown>) => execute(name, prepare(name, raw));
  return { toolSet, prepare, execute, call };
}

describe("malformed tool arguments are not mutation-boundary refusals", () => {
  it("classifies Pi's legacy flat edit on a granted path as malformed-arguments, naming the schema", async () => {
    const root = await workspace();
    const { toolSet, call } = await planToolSet(root);

    const refusal = await call("edit", {
      path: "docs/guide.md",
      oldText: "Old text.",
      newText: "New text.",
    }).catch((error: Error) => error);

    expect(refusal).toBeInstanceOf(Error);
    expect((refusal as Error).message).toBe(malformedArgumentsMessage("edit"));
    expect((refusal as Error).message).toBe(
      'DocsFab could not run edit: its arguments do not match the edit parameters. Send exactly {"path": string, "edits": [{"oldText": string, "newText": string}, ...]} (required: path, edits), with no other keys, then call it again.',
    );
    expect(toolSet.getFailureCategories()).toEqual([{ category: "malformed-arguments", count: 1 }]);
    expect(toolSet.getMutationBoundaryDenials()).toBe(0);
    expect(await readFile(join(root, "docs", "guide.md"), "utf8")).toBe("# Guide\n\nOld text.\n");

    // The model can self-correct from that message: the schema shape succeeds.
    await call("edit", {
      path: "docs/guide.md",
      edits: [{ oldText: "Old text.", newText: "New text." }],
    });
    expect(await readFile(join(root, "docs", "guide.md"), "utf8")).toBe("# Guide\n\nNew text.\n");
    expect(toolSet.getMutationBoundaryDenials()).toBe(0);
    // The later successful edit corrects it, so it is no longer material.
    expect(toolSet.getFailureCategories()).toEqual([
      { category: "malformed-arguments-corrected", count: 1 },
    ]);
  });

  it("keeps a malformed edit uncorrected when the later well-formed edit fails inside Pi", async () => {
    const root = await workspace();
    const { toolSet, call } = await planToolSet(root);
    await expect(
      call("edit", { path: "docs/guide.md", oldText: "Old text.", newText: "New text." }),
    ).rejects.toThrow(malformedArgumentsMessage("edit"));
    // Well-formed and inside the grant, but its oldText is not in the file.
    await expect(
      call("edit", { path: "docs/guide.md", edits: [{ oldText: "Absent text.", newText: "x" }] }),
    ).rejects.toThrow();
    expect(toolSet.getFailureCategories()).toEqual([
      { category: "malformed-arguments", count: 1 },
      { category: "recoverable-miss", count: 1 },
    ]);
    expect(await readFile(join(root, "docs", "guide.md"), "utf8")).toBe("# Guide\n\nOld text.\n");
  });

  it.each([
    {
      name: "no later call succeeds",
      follow: async (_call: ToolCall) => undefined,
      expected: [{ category: "malformed-arguments", count: 2 }],
    },
    {
      name: "only a different tool succeeds later",
      follow: async (call: ToolCall) => {
        await call("write", { path: "docs/guide.md", content: "# New\n" });
      },
      expected: [{ category: "malformed-arguments", count: 2 }],
    },
    {
      name: "a later edit succeeds",
      follow: async (call: ToolCall) => {
        await call("edit", {
          path: "docs/guide.md",
          edits: [{ oldText: "Old text.", newText: "New text." }],
        });
      },
      expected: [{ category: "malformed-arguments-corrected", count: 2 }],
    },
  ])("classifies two malformed edits by correction when $name", async ({ follow, expected }) => {
    const root = await workspace();
    const { toolSet, call } = await planToolSet(root);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await expect(
        call("edit", { path: "docs/guide.md", oldText: "Old text.", newText: "New text." }),
      ).rejects.toThrow(malformedArgumentsMessage("edit"));
    }
    await follow(call);
    expect(toolSet.getFailureCategories()).toEqual(expected);
    expect(toolSet.getMutationBoundaryDenials()).toBe(0);
  });

  it("names the write schema for a write with an extra key on a granted path", async () => {
    const root = await workspace();
    const { toolSet, call } = await planToolSet(root);
    await expect(
      call("write", { path: "docs/guide.md", content: "x\n", mode: "overwrite" }),
    ).rejects.toThrow(
      'Send exactly {"path": string, "content": string} (required: path, content), with no other keys',
    );
    expect(toolSet.getFailureCategories()).toEqual([{ category: "malformed-arguments", count: 1 }]);
    expect(toolSet.getMutationBoundaryDenials()).toBe(0);
  });

  // Fail closed: a malformed call counts as a refused mutation unless the path
  // it names was shown to be inside the grant.
  it.each([
    {
      name: "a flat edit on a path outside the plan",
      tool: "edit",
      raw: { path: "docs/index.md", oldText: "# Index", newText: "# Home" },
    },
    {
      name: "a write whose path key is misspelled",
      tool: "write",
      raw: { file_path: "README.md", content: "x" },
    },
    { name: "a write whose path is not a string", tool: "write", raw: { path: 7, content: "x" } },
    {
      name: "an absolute host path",
      tool: "write",
      raw: { path: "/etc/hosts", content: "x", extra: 1 },
    },
    {
      // Pi drops one leading "@", so this names /tmp/x for Pi and the confinement.
      name: "an @-prefixed absolute path",
      tool: "write",
      raw: { path: "@/tmp/docsfab-malformed-at.md", content: "x", extra: 1 },
    },
    {
      name: "a file URL",
      tool: "write",
      raw: { path: "file:///tmp/docsfab-malformed-url.md", content: "x", extra: 1 },
    },
    {
      name: "a virtual-cwd traversal",
      tool: "write",
      raw: { path: `${VIRTUAL_WORKSPACE_CWD}/../etc/hosts`, content: "x", extra: 1 },
    },
  ])("keeps $name a denied-path mutation refusal", async ({ tool, raw }) => {
    const root = await workspace();
    const { toolSet, call } = await planToolSet(root);
    await expect(call(tool, raw)).rejects.toThrow(safeFailureMessage("denied-path"));
    expect(toolSet.getFailureCategories()).toEqual([{ category: "denied-path", count: 1 }]);
    expect(toolSet.getMutationBoundaryDenials()).toBe(1);
    expect(await readFile(join(root, "docs", "index.md"), "utf8")).toBe("# Index\n");
  });

  // Without a narrow grant, only the path form Pi opens can catch these.
  it.each(["file:///tmp/docsfab-unrestricted-url.md", "@/tmp/docsfab-unrestricted-at.md"])(
    "keeps a malformed write to %s a refusal on an unrestricted write tool set",
    async (path) => {
      const root = await workspace();
      const { toolSet, call } = toolSetFor(
        await createConfinedToolSet({ workspacePath: root, allowWrite: true }),
      );
      await expect(call("write", { path, content: "x", extra: 1 })).rejects.toThrow(
        safeFailureMessage("denied-path"),
      );
      expect(toolSet.getMutationBoundaryDenials()).toBe(1);
    },
  );

  it("settles a parallel batch of malformed calls by each call's own path", async () => {
    const root = await workspace();
    const { toolSet, prepare, execute } = await planToolSet(root);
    // Pi prepares the whole batch before executing any call.
    const inGrant = prepare("edit", { path: "docs/guide.md", oldText: "a", newText: "b" });
    const outOfGrant = prepare("edit", { path: "docs/index.md", oldText: "a", newText: "b" });
    await expect(execute("edit", outOfGrant)).rejects.toThrow(safeFailureMessage("denied-path"));
    await expect(execute("edit", inGrant)).rejects.toThrow(malformedArgumentsMessage("edit"));
    expect(toolSet.getFailureCategories()).toEqual([
      { category: "denied-path", count: 1 },
      { category: "malformed-arguments", count: 1 },
    ]);
    expect(toolSet.getMutationBoundaryDenials()).toBe(1);
  });

  it("refuses a replayed or forged sentinel as a denied path", async () => {
    const root = await workspace();
    const { toolSet, prepare, execute } = await planToolSet(root);
    const prepared = prepare("edit", { path: "docs/guide.md", oldText: "a", newText: "b" });
    await expect(execute("edit", prepared)).rejects.toThrow(malformedArgumentsMessage("edit"));
    // The token is single use.
    await expect(execute("edit", prepared)).rejects.toThrow(safeFailureMessage("denied-path"));
    // A model that sends a sentinel-shaped path gets no special treatment.
    await expect(
      execute("write", {
        path: "\u0000docsfab-malformed-arguments:00000000-0000-0000-0000-000000000000",
        content: "x",
      }),
    ).rejects.toThrow(safeFailureMessage("denied-path"));
    expect(toolSet.getFailureCategories()).toEqual([
      { category: "denied-path", count: 2 },
      { category: "malformed-arguments", count: 1 },
    ]);
    expect(toolSet.getMutationBoundaryDenials()).toBe(2);
  });

  it("classifies a malformed read on a readable path without any mutation count", async () => {
    const root = await workspace();
    const { toolSet, call } = await planToolSet(root);
    await expect(call("read", { path: "docs/guide.md", offset: "1" })).rejects.toThrow(
      malformedArgumentsMessage("read"),
    );
    await expect(call("read", { path: "../outside.md", offset: "1" })).rejects.toThrow(
      safeFailureMessage("denied-path"),
    );
    expect(toolSet.getFailureCategories()).toEqual([
      { category: "denied-path", count: 1 },
      { category: "malformed-arguments", count: 1 },
    ]);
    expect(toolSet.getMutationBoundaryDenials()).toBe(0);
  });
});

describe("paths under the advertised virtual cwd name the workspace", () => {
  it("admits /workspace paths inside the grant through the same confinement", async () => {
    const root = await workspace();
    const { toolSet, call } = await planToolSet(root);
    await call("write", { path: `${VIRTUAL_WORKSPACE_CWD}/docs/guide.md`, content: "# New\n" });
    expect(await readFile(join(root, "docs", "guide.md"), "utf8")).toBe("# New\n");
    await call("edit", {
      path: `${VIRTUAL_WORKSPACE_CWD}/docs/guide.md`,
      edits: [{ oldText: "# New", newText: "# Newer" }],
    });
    expect(await readFile(join(root, "docs", "guide.md"), "utf8")).toBe("# Newer\n");
    const read = await call("read", { path: `${VIRTUAL_WORKSPACE_CWD}/docs/index.md` });
    expect(JSON.stringify(read)).toContain("# Index");
    expect(toolSet.getFailureCategories()).toEqual([]);
    expect(toolSet.getMutationBoundaryDenials()).toBe(0);
  });

  it.each([
    "@/tmp/docsfab-well-formed-at.md",
    "file:///tmp/docsfab-well-formed-url.md",
    `${VIRTUAL_WORKSPACE_CWD}/docs/index.md`,
    `${VIRTUAL_WORKSPACE_CWD}/../etc/hosts`,
    `${VIRTUAL_WORKSPACE_CWD}//etc/hosts`,
    `${VIRTUAL_WORKSPACE_CWD}x/docs/guide.md`,
    "/etc/hosts",
  ])("still denies a write to %s", async (path) => {
    const root = await workspace();
    const { toolSet, call } = await planToolSet(root);
    await expect(call("write", { path, content: "x\n" })).rejects.toThrow(
      safeFailureMessage("denied-path"),
    );
    expect(toolSet.getMutationBoundaryDenials()).toBe(1);
    expect(await readFile(join(root, "docs", "index.md"), "utf8")).toBe("# Index\n");
  });

  it("judges an @-prefixed path as the path Pi opens", async () => {
    const root = await workspace();
    const { toolSet, call } = await planToolSet(root);
    await call("write", { path: "@docs/guide.md", content: "# At\n" });
    expect(await readFile(join(root, "docs", "guide.md"), "utf8")).toBe("# At\n");
    await call("write", { path: `@${VIRTUAL_WORKSPACE_CWD}/docs/guide.md`, content: "# At2\n" });
    expect(await readFile(join(root, "docs", "guide.md"), "utf8")).toBe("# At2\n");
    // Malformed, but naming a granted path: a schema error, not a refusal.
    await expect(
      call("edit", { path: "@docs/guide.md", oldText: "a", newText: "b" }),
    ).rejects.toThrow(malformedArgumentsMessage("edit"));
    expect(toolSet.getMutationBoundaryDenials()).toBe(0);
  });

  // Pi drops one leading "@" again from whatever it is handed, so the judged
  // form is handed on as "./<form>", which Pi opens unchanged.
  it.each(["write", "edit"])(
    "denies %s to a second-@ or /workspace/@ form of a granted path as a refusal",
    async (tool) => {
      const root = await workspace();
      const { toolSet, call } = await planToolSet(root);
      for (const path of ["@@docs/guide.md", `${VIRTUAL_WORKSPACE_CWD}/@docs/guide.md`]) {
        await expect(
          call(
            tool,
            tool === "write"
              ? { path, content: "x\n" }
              : { path, edits: [{ oldText: "Old text.", newText: "x" }] },
          ),
        ).rejects.toThrow(safeFailureMessage("denied-path"));
      }
      expect(toolSet.getFailureCategories()).toEqual([{ category: "denied-path", count: 2 }]);
      expect(toolSet.getMutationBoundaryDenials()).toBe(2);
      expect(await readFile(join(root, "docs", "guide.md"), "utf8")).toBe("# Guide\n\nOld text.\n");
    },
  );

  it.each(["@@docs/new.md", `${VIRTUAL_WORKSPACE_CWD}/@docs/new.md`])(
    "opens the judged path for %s without a grant list",
    async (path) => {
      const root = await workspace();
      const { toolSet, call } = toolSetFor(
        await createConfinedToolSet({ workspacePath: root, allowWrite: true }),
      );
      await call("write", { path, content: "# At\n" });
      // Judged and opened as the workspace's "@docs/new.md", never "docs/new.md".
      expect(await readFile(join(root, "@docs", "new.md"), "utf8")).toBe("# At\n");
      await expect(readFile(join(root, "docs", "new.md"), "utf8")).rejects.toThrow();
      await call("edit", { path, edits: [{ oldText: "# At", newText: "# At2" }] });
      expect(await readFile(join(root, "@docs", "new.md"), "utf8")).toBe("# At2\n");
      expect(toolSet.getFailureCategories()).toEqual([]);
    },
  );

  it("judges a Unicode space as the space Pi opens", async () => {
    const root = await workspace();
    const { toolSet, call } = toolSetFor(
      await createConfinedToolSet({
        workspacePath: root,
        allowWrite: true,
        allowedWritePaths: ["docs/a b.md"],
      }),
    );
    await call("write", { path: "docs/a\u00A0b.md", content: "# Space\n" });
    expect(await readFile(join(root, "docs", "a b.md"), "utf8")).toBe("# Space\n");
    expect(toolSet.getMutationBoundaryDenials()).toBe(0);
  });

  it("admits bootstrap guidance under /workspace and still denies other files", async () => {
    const root = await workspace();
    const { toolSet, call } = toolSetFor(
      await createConfinedToolSet({
        workspacePath: root,
        allowWrite: true,
        isWritePathAllowed: isRepositoryBootstrapGuidancePath,
      }),
    );
    await call("write", { path: `${VIRTUAL_WORKSPACE_CWD}/README.md`, content: "# Repo\n" });
    expect(await readFile(join(root, "README.md"), "utf8")).toBe("# Repo\n");
    await expect(
      call("write", { path: `${VIRTUAL_WORKSPACE_CWD}/package.json`, content: "{}" }),
    ).rejects.toThrow(safeFailureMessage("denied-path"));
    expect(await readFile(join(root, "package.json"), "utf8")).toBe("{}\n");
    expect(toolSet.getMutationBoundaryDenials()).toBe(1);
  });
});

describe("through the real Pi session", () => {
  // The live shape: a refused edit, then the in-grant write. Pi prepares,
  // clones, and executes the calls; the step must report no refused mutation.
  it("reports a malformed edit as malformed-arguments and no mutation-boundary refusal", async () => {
    const repositoryPath = await createRepository();
    const base = stepInput(repositoryPath);
    const workflow = getWorkflow("restructure-documentation");
    const step = workflow.steps.find((candidate) => candidate.id === "write-documentation")!;
    const requests: string[] = [];
    vi.stubGlobal("fetch", async (_request: RequestInfo | URL, init?: RequestInit) => {
      requests.push(String(init?.body));
      if (requests.length === 1) {
        return toolTurn([
          {
            id: "call-1",
            name: "edit",
            arguments: { path: "README.md", oldText: "# Fixture", newText: "# Guide" },
          },
        ]);
      }
      if (requests.length === 2) {
        return toolTurn([
          {
            id: "call-2",
            name: "write",
            arguments: { path: `${VIRTUAL_WORKSPACE_CWD}/README.md`, content: "# Guide\n" },
          },
        ]);
      }
      return textTurn("The requested documentation was updated.");
    });

    const result = await (await createAuditHarness()).runStep({ ...base, workflow, step });

    expect(requests).toHaveLength(3);
    // The model saw the schema it must use, not a path refusal.
    expect(requests[1]).toContain("Send exactly");
    expect(requests[1]).not.toContain(safeFailureMessage("denied-path"));
    expect(result.mutationBoundaryDenials ?? 0).toBe(0);
    expect(result.tools?.failureCategories).toEqual([
      { category: "malformed-arguments", count: 1 },
    ]);
    expect(await readFile(join(repositoryPath, "README.md"), "utf8")).toBe("# Guide\n");
  });
});
