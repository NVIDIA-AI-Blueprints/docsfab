// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createConfinedToolSet } from "../src/harness/confined-tools.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function repository(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "docsfab-text-representation-"));
  roots.push(root);
  return root;
}

function digest(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function toolCaller(toolSet: Awaited<ReturnType<typeof createConfinedToolSet>>) {
  const tools = new Map(toolSet.definitions.map((tool) => [tool.name, tool]));
  return (name: "edit" | "write", input: Record<string, unknown>) => {
    const tool = tools.get(name)!;
    const prepared = structuredClone(tool.prepareArguments ? tool.prepareArguments(input) : input);
    return tool.execute("call", prepared as never, undefined, undefined, undefined as never);
  };
}

describe("confined text mutation representation", () => {
  it("edits supported UTF-8 text with an unfamiliar suffix without labeling it Markdown", async () => {
    const root = await repository();
    await writeFile(join(root, "manual"), '<topic id="x">Old</topic>\n', "utf8");
    const tools = await createConfinedToolSet({
      workspacePath: root,
      allowWrite: true,
      allowedWritePaths: ["manual"],
    });
    const call = toolCaller(tools);
    await call("edit", {
      path: "manual",
      edits: [{ oldText: "Old", newText: "New" }],
    });
    expect(await readFile(join(root, "manual"), "utf8")).toBe('<topic id="x">New</topic>\n');
    expect(tools.definitions.find((tool) => tool.name === "edit")?.description).not.toMatch(
      /Markdown/i,
    );
  });

  it.each(["edit", "write"] as const)(
    "refuses %s of invalid UTF-8 before changing original bytes",
    async (operation) => {
      const root = await repository();
      const original = Buffer.from([0x61, 0xff, 0x62, 0x0a]);
      await writeFile(join(root, "manual.dat"), original);
      const tools = await createConfinedToolSet({
        workspacePath: root,
        allowWrite: true,
        allowedWritePaths: ["manual.dat"],
      });
      const call = toolCaller(tools);
      await expect(
        operation === "edit"
          ? call("edit", {
              path: "manual.dat",
              edits: [{ oldText: "a", newText: "replacement" }],
            })
          : call("write", { path: "manual.dat", content: "replacement\n" }),
      ).rejects.toThrow(
        "DocsFab cannot edit this file as text because it is binary or not valid UTF-8.",
      );
      const after = await readFile(join(root, "manual.dat"));
      expect(digest(after)).toBe(digest(original));
    },
  );
});
