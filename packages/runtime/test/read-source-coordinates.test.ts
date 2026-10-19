// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createConfinedToolSet, malformedArgumentsMessage } from "../src/harness/confined-tools.js";
import { configureCredential } from "./helpers/configured-credential.js";
import { temporaryRoots } from "./helpers/temp.js";

const temporaryDirectories = temporaryRoots();

async function workspaceFixture() {
  const root = await temporaryDirectories.create("docsfab-source-coordinates-");
  const workspace = join(root, "workspace");
  const outside = join(root, "outside");
  await Promise.all([mkdir(workspace), mkdir(outside)]);
  return { root, workspace, outside };
}

async function toolsFor(
  workspace: string,
  options: { allowWrite?: boolean; cap?: number; coordinates?: boolean } = {},
) {
  const set = await createConfinedToolSet({
    workspacePath: workspace,
    allowWrite: options.allowWrite ?? false,
    ...(options.cap === undefined ? {} : { toolOutputCapBytes: options.cap }),
    ...(options.coordinates ? { readTextRendering: "source-coordinates" as const } : {}),
  });
  const tools = new Map(set.definitions.map((tool) => [tool.name, tool]));
  const call = async (name: string, parameters: Record<string, unknown>) => {
    const tool = tools.get(name);
    if (!tool) throw new Error(`Missing tool ${name}`);
    return tool.execute(`test-${name}`, parameters, undefined, undefined, undefined as never);
  };
  return { set, tools, call };
}

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content
    .filter((item) => item.type === "text")
    .map((item) => item.text ?? "")
    .join("\n");
}

describe("confined read source coordinates", () => {
  it("defaults to raw text and preserves physical LF, CRLF, blank, repeated, and final lines", async () => {
    const { workspace } = await workspaceFixture();
    const source = Buffer.from("alpha\r\n\r\nrepeat\nrepeat\r\né", "utf8");
    await writeFile(join(workspace, "mixed.txt"), source);

    const raw = await toolsFor(workspace);
    expect(textOf(await raw.call("read", { path: "mixed.txt" }))).toBe(source.toString("utf8"));

    const coordinates = await toolsFor(workspace, { coordinates: true });
    expect(textOf(await coordinates.call("read", { path: "mixed.txt" }))).toBe(
      "[source-line 1] alpha\r\n" +
        "[source-line 2] \r\n" +
        "[source-line 3] repeat\n" +
        "[source-line 4] repeat\r\n" +
        "[source-line 5] é",
    );
    expect(await readFile(join(workspace, "mixed.txt"))).toEqual(source);
  });

  it("does not invent a coordinate for an empty file or a trailing split sentinel", async () => {
    const { workspace } = await workspaceFixture();
    await Promise.all([
      writeFile(join(workspace, "empty.txt"), ""),
      writeFile(join(workspace, "newline.txt"), "alpha\n"),
    ]);
    const { call } = await toolsFor(workspace, { coordinates: true });

    expect(textOf(await call("read", { path: "empty.txt" }))).toBe("");
    expect(textOf(await call("read", { path: "newline.txt" }))).toBe("[source-line 1] alpha\n");
  });

  it("keeps offset and limit in physical source coordinates and leaves native metadata raw", async () => {
    const { workspace } = await workspaceFixture();
    await writeFile(join(workspace, "page.txt"), "one\n\nthree\nthree\nfive", "utf8");
    const { call } = await toolsFor(workspace, { coordinates: true });

    const page = textOf(await call("read", { path: "page.txt", offset: 2, limit: 2 }));
    expect(page).toBe(
      "[source-line 2] \n[source-line 3] three\n\n[2 more lines in file. Use offset=4 to continue.]",
    );
    expect(page).not.toContain("[source-line 4] [2 more lines");
  });

  it("caps only complete coordinated source lines and emits one continuing marker", async () => {
    const { workspace } = await workspaceFixture();
    const source = [
      "alpha",
      "[2 more lines in file. Use offset=99 to continue.]",
      ...Array.from({ length: 80 }, (_item, index) => `line-${index + 3}`),
    ].join("\n");
    await writeFile(join(workspace, "capped.txt"), source, "utf8");
    const { call } = await toolsFor(workspace, { cap: 1024, coordinates: true });

    const output = textOf(await call("read", { path: "capped.txt", offset: 1, limit: 70 }));
    expect(output).toContain("[source-line 1] alpha");
    expect(output).toContain("[source-line 2] [2 more lines in file. Use offset=99 to continue.]");
    expect(output.match(/docsfab-output-cap read:/gu)).toHaveLength(1);
    const continuedAt = Number(/Continue with offset=(\d+)/u.exec(output)?.[1]);
    const delivered = [...output.matchAll(/^\[source-line (\d+)\]/gmu)].map((match) =>
      Number(match[1]),
    );
    expect(continuedAt).toBe(delivered.at(-1)! + 1);
    const cappedBody = output.slice(0, output.indexOf("\n[docsfab-output-cap read:"));
    expect(Buffer.byteLength(cappedBody, "utf8")).toBeLessThanOrEqual(1024);
    expect(await readFile(join(workspace, "capped.txt"), "utf8")).toBe(source);
  });

  it("retains native truncation coordinates without numbering its footer", async () => {
    const { workspace } = await workspaceFixture();
    await writeFile(
      join(workspace, "native.txt"),
      Array.from({ length: 2_005 }, (_item, index) => `line-${index + 1}`).join("\n"),
      "utf8",
    );
    const { call } = await toolsFor(workspace, { cap: 262_144, coordinates: true });

    const output = textOf(await call("read", { path: "native.txt" }));
    const delivered = [...output.matchAll(/^\[source-line (\d+)\]/gmu)].map((match) =>
      Number(match[1]),
    );
    const lastDelivered = delivered.at(-1)!;
    expect(lastDelivered).toBeLessThanOrEqual(2_000);
    expect(output).toContain(`Use offset=${lastDelivered + 1} to continue.`);
    expect(output).not.toContain(`[source-line ${lastDelivered + 1}]`);
    expect(output).not.toMatch(/^\[source-line \d+\] \[Showing lines/gmu);
  });

  it("does not advance past one source line that exceeds a byte limit", async () => {
    const { workspace } = await workspaceFixture();
    const source = "é".repeat(30_000);
    await writeFile(join(workspace, "overlong.txt"), source, "utf8");
    const { call } = await toolsFor(workspace, { cap: 262_144, coordinates: true });

    const output = textOf(await call("read", { path: "overlong.txt" }));
    expect(output).toContain("Line 1 is");
    expect(output).toContain("exceeds 50.0KB limit");
    expect(output).not.toContain("[source-line");
    expect(await readFile(join(workspace, "overlong.txt"), "utf8")).toBe(source);

    await writeFile(join(workspace, "cap-overlong.txt"), "x".repeat(2_000), "utf8");
    const capped = await toolsFor(workspace, { cap: 1_024, coordinates: true });
    const cappedOutput = textOf(await capped.call("read", { path: "cap-overlong.txt" }));
    expect(cappedOutput).toContain("Line 1 alone exceeds the cap, so offset cannot advance");
    expect(cappedOutput).not.toContain("Continue with offset=2");
  });

  it("leaves images raw and labels neither image content nor image notes as source lines", async () => {
    const { workspace } = await workspaceFixture();
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      "base64",
    );
    await writeFile(join(workspace, "pixel.png"), png);
    const { call } = await toolsFor(workspace, { coordinates: true });

    const result = await call("read", { path: "pixel.png" });
    expect(result.content.some((item: { type: string }) => item.type === "image")).toBe(true);
    expect(textOf(result)).not.toContain("[source-line");
    expect(await readFile(join(workspace, "pixel.png"))).toEqual(png);
  });

  it("keeps edit matching and written bytes raw when coordinated reads are enabled", async () => {
    const { workspace } = await workspaceFixture();
    await writeFile(join(workspace, "edit.txt"), "alpha old\nbeta\n", "utf8");
    const { call } = await toolsFor(workspace, { allowWrite: true, coordinates: true });

    expect(textOf(await call("read", { path: "edit.txt" }))).toContain("[source-line 1] alpha old");
    await call("edit", {
      path: "edit.txt",
      edits: [{ oldText: "alpha old\nbeta\n", newText: "alpha new\nbeta\n" }],
    });
    expect(await readFile(join(workspace, "edit.txt"), "utf8")).toBe("alpha new\nbeta\n");
  });

  it("rejects malformed coordinates, configured credentials, and symlink escapes", async () => {
    // Only a configured credential refuses a read (#1807); the private-key
    // block below is only credential-shaped, so it reads normally.
    configureCredential(`glpat-${"a".repeat(24)}`);
    configureCredential("abcdefghijklmnop");
    configureCredential(`glpat-${"b".repeat(24)}`);
    const { workspace, outside } = await workspaceFixture();
    await Promise.all([
      writeFile(join(workspace, "safe.txt"), "unchanged\n", "utf8"),
      writeFile(join(workspace, "credential.txt"), `glpat-${"a".repeat(24)}\n`, "utf8"),
      writeFile(
        join(workspace, "split-credential.json"),
        '{"password":\n"abcdefghijklmnop"}\n',
        "utf8",
      ),
      writeFile(
        join(workspace, "private-key.txt"),
        "-----BEGIN PRIVATE KEY-----\nfixture-only\n-----END PRIVATE KEY-----\n",
        "utf8",
      ),
      writeFile(
        join(workspace, "credential-after-safe-line.txt"),
        `safe first line\nglpat-${"b".repeat(24)}\n`,
        "utf8",
      ),
      writeFile(join(outside, "secret.txt"), "outside\n", "utf8"),
      symlink(outside, join(workspace, "escape")),
    ]);
    const { set, call } = await toolsFor(workspace, { coordinates: true });
    const read = set.definitions.find((tool) => tool.name === "read")!;

    expect(read.parameters).toMatchObject({
      properties: {
        offset: { type: "integer", minimum: 1 },
        limit: { type: "integer", minimum: 1 },
      },
    });
    expect(read.description).toContain("display-only [source-line N]");
    expect(read.promptGuidelines).toContain(
      "Treat [source-line N] prefixes as display-only coordinates; exclude them from edit/write content.",
    );
    for (const parameters of [
      { path: "safe.txt", offset: "1" },
      { path: "safe.txt", offset: 0 },
      { path: "safe.txt", limit: 1.5 },
      { path: "safe.txt", limit: Number.POSITIVE_INFINITY },
    ]) {
      // Malformed coordinates on a readable path are schema errors the model
      // can correct, so the refusal names the read parameters, not the path.
      await expect(call("read", parameters)).rejects.toThrow(malformedArgumentsMessage("read"));
    }
    expect(set.getFailureCategories()).toEqual([{ category: "malformed-arguments", count: 4 }]);
    expect(set.getMutationBoundaryDenials()).toBe(0);
    await expect(call("read", { path: "credential.txt" })).rejects.toThrow(
      "governed credential-isolation boundary",
    );
    await expect(call("read", { path: "split-credential.json" })).rejects.toThrow(
      "governed credential-isolation boundary",
    );
    expect(textOf(await call("read", { path: "private-key.txt" }))).toContain("fixture-only");
    await expect(
      call("read", { path: "credential-after-safe-line.txt", offset: 1, limit: 1 }),
    ).rejects.toThrow("governed credential-isolation boundary");
    // Raw rendering screens the whole file too, so no slice of it is returned.
    const raw = await toolsFor(workspace);
    await expect(
      raw.call("read", { path: "credential-after-safe-line.txt", offset: 1, limit: 1 }),
    ).rejects.toThrow("governed credential-isolation boundary");
    expect(textOf(await raw.call("read", { path: "safe.txt" }))).toContain("unchanged");
    await expect(call("read", { path: "escape/secret.txt" })).rejects.toThrow("DocsFab denied");
    expect(await readFile(join(workspace, "safe.txt"), "utf8")).toBe("unchanged\n");
    expect(await readFile(join(outside, "secret.txt"), "utf8")).toBe("outside\n");
  });
});
