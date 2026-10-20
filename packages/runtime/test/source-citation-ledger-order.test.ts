// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

// Pi runs one assistant message's tool calls in parallel, so a read can land
// between an edit's steps. These hooks run a step at an exact point inside the
// confined tools' filesystem calls.
const hooks: {
  afterWrite?: (path: string) => Promise<void>;
  failStat?: string;
} = {};

vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs/promises")>();
  const mocked = {
    ...original,
    writeFile: async (...arguments_: Parameters<typeof original.writeFile>) => {
      const result = await original.writeFile(...arguments_);
      const after = hooks.afterWrite;
      if (after && String(arguments_[0]).endsWith("docs/a.md")) {
        hooks.afterWrite = undefined;
        await after(String(arguments_[0]));
      }
      return result;
    },
    stat: async (...arguments_: Parameters<typeof original.stat>) => {
      if (hooks.failStat && String(arguments_[0]).endsWith(hooks.failStat)) {
        hooks.failStat = undefined;
        throw Object.assign(new Error("injected stat fault"), { code: "EIO" });
      }
      return original.stat(...arguments_);
    },
  };
  return { ...mocked, default: mocked };
});

const { createConfinedToolSet } = await import("../src/harness/confined-tools.js");
const { temporaryRoots } = await import("./helpers/temp.js");

const temporaryDirectories = temporaryRoots();
const ORIGINAL = "keep\nold\n";

async function coordinateTools() {
  const root = await temporaryDirectories.create("docsfab-source-lines-order-");
  const workspace = join(root, "workspace");
  await mkdir(join(workspace, "docs"), { recursive: true });
  await writeFile(join(workspace, "docs/a.md"), ORIGINAL);
  const toolSet = await createConfinedToolSet({
    workspacePath: workspace,
    allowWrite: true,
    readTextRendering: "source-coordinates",
  });
  const tools = new Map(toolSet.definitions.map((tool) => [tool.name, tool]));
  const call = (name: string, parameters: Record<string, unknown>) =>
    tools.get(name)!.execute(`test-${name}`, parameters, undefined, undefined, undefined as never);
  return { workspace, toolSet, call };
}

describe("source-line ledger ordering against parallel tool calls (#1741)", () => {
  it("never counts a read that lands right after an edit or write changed the bytes", async () => {
    for (const mutation of [
      { name: "edit", parameters: { edits: [{ oldText: "old", newText: "NEW" }] } },
      { name: "write", parameters: { content: "keep\nNEW\n" } },
    ]) {
      const { toolSet, call } = await coordinateTools();
      let shown = "";
      hooks.afterWrite = async () => {
        shown = JSON.stringify(await call("read", { path: "docs/a.md" }));
      };
      await call(mutation.name, { path: "docs/a.md", ...mutation.parameters });
      // The read saw the new text; the host would mint the original "old".
      expect(shown, mutation.name).toContain("[source-line 2] NEW");
      expect(toolSet.getObservedSourceLines(), mutation.name).toEqual({});
    }
  });

  it("fails the write, leaving the file unchanged, when the mark cannot resolve the file", async () => {
    const { workspace, toolSet, call } = await coordinateTools();
    hooks.failStat = "docs/a.md";
    await expect(
      call("edit", { path: "docs/a.md", edits: [{ oldText: "old", newText: "NEW" }] }),
    ).rejects.toThrow();
    expect(hooks.failStat).toBeUndefined();
    expect(await readFile(join(workspace, "docs/a.md"), "utf8")).toBe(ORIGINAL);
    // The file is unchanged, so a later read shows original text and counts.
    await call("read", { path: "docs/a.md" });
    expect(toolSet.getObservedSourceLines()).toEqual({ "docs/a.md": [[1, 3]] });
  });
});
