// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { chmod, mkdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { sha256 } from "../src/content-ir/canonical.js";
import { limit } from "../src/config/limits.js";
import { createConfinedToolSet } from "../src/harness/confined-tools.js";
import { FileConfinement } from "../src/harness/confined-tools/file-confinement.js";
import { ReviewReadCapture } from "../src/harness/confined-tools/source-coordinates.js";
import { ReadEvidenceLedger, resolveReadLoopPolicy } from "../src/harness/read-evidence.js";
import { temporaryRoots } from "./helpers/temp.js";
import { DurableArtifactStore } from "../src/artifacts/store.js";
import { FileRunStore } from "../src/records/file-store.js";
import { loadReviewLocatorAuthority } from "../src/review/locator-provenance.js";

const roots = temporaryRoots();

async function capturedTools(maxObjectBytes = limit("artifacts.maxObjectBytes").value) {
  const root = await roots.create("docsfab-review-locator-");
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  const set = await createConfinedToolSet({
    workspacePath: workspace,
    allowWrite: false,
    readTextRendering: "source-coordinates",
    toolOutputCapBytes: 1_024,
    readEvidence: new ReadEvidenceLedger(resolveReadLoopPolicy()),
    reviewReadMaxObjectBytes: maxObjectBytes,
  });
  const read = set.definitions.find((tool) => tool.name === "read")!;
  let call = 0;
  return {
    workspace,
    set,
    read: (path: string) =>
      read.execute(`review-read-${++call}`, { path }, undefined, undefined, undefined as never),
  };
}

describe("registered confined review read provenance", () => {
  it("does not repair a permissive run directory on a direct cold locator reload", async () => {
    if (process.platform === "win32") return;
    const parent = await roots.create("docsfab-review-locator-passive-");
    const runDirectory = join(parent, "runs");
    await mkdir(runDirectory, { mode: 0o700 });
    await chmod(runDirectory, 0o755);
    const input = {
      runStore: new FileRunStore(runDirectory),
      artifacts: new DurableArtifactStore(join(parent, "artifacts")),
      runId: "passive-run",
      binding: {} as Parameters<typeof loadReviewLocatorAuthority>[0]["binding"],
      result: {} as Parameters<typeof loadReviewLocatorAuthority>[0]["result"],
      snapshotSha256: "0".repeat(64),
      readOnly: true as const,
    };

    await expect(loadReviewLocatorAuthority(input)).resolves.toEqual({
      kind: "unavailable",
      reason: "binding-mismatch",
    });
    expect((await stat(runDirectory)).mode & 0o7777).toBe(0o755);
    expect((await stat(parent)).mode & 0o7777).toBe(0o700);
  });

  it("retains exact raw bytes only for complete post-cap delivered coordinate lines", async () => {
    const { workspace, set, read } = await capturedTools();
    const raw = Buffer.from(`\ufefffirst\r\n${"middle".repeat(400)}\r\nlast\n`, "utf8");
    await writeFile(join(workspace, "guide.md"), raw);
    await read("guide.md");
    const file = set.getReviewReadObservation()?.files[0];
    expect(file?.rawBase64).toBe(raw.toString("base64"));
    expect(file?.rawSha256).toBe(sha256(raw));
    expect(file?.lines.map((line) => line.line)).toEqual([1]);
    await writeFile(join(workspace, "guide.md"), "changed after the read\n");
    expect(set.getReviewReadObservation()?.files[0]?.rawBase64).toBe(raw.toString("base64"));
  });

  it("isolates concurrent calls and invalidates only a path whose read bytes conflict", async () => {
    const { workspace, set, read } = await capturedTools();
    await writeFile(join(workspace, "left.md"), "left\n");
    await writeFile(join(workspace, "right.md"), "right\n");
    await Promise.all([read("left.md"), read("right.md")]);
    expect(set.getReviewReadObservation()?.files.map((file) => file.path)).toEqual([
      "left.md",
      "right.md",
    ]);
    await writeFile(join(workspace, "left.md"), "changed\n");
    await read("left.md");
    expect(set.getReviewReadObservation()?.files.map((file) => file.path)).toEqual(["right.md"]);
    expect(set.getReviewReadObservation()?.invalidPaths).toEqual(["left.md"]);
  });

  it("orders mixed-case captured paths by the cold decoder's string order", async () => {
    const { workspace, set, read } = await capturedTools();
    await mkdir(join(workspace, "docs"));
    await writeFile(join(workspace, "docs", "a.md"), "# Café\n");
    await writeFile(join(workspace, "docs", "B.md"), "# Über\n");
    await read("docs/a.md");
    await read("docs/B.md");
    const files = set.getReviewReadObservation()?.files;
    expect(files?.map((file) => file.path)).toEqual(["docs/B.md", "docs/a.md"]);
    expect(files?.map((file) => Buffer.from(file.rawBase64, "base64").toString("utf8"))).toEqual([
      "# Über\n",
      "# Café\n",
    ]);
  });

  it("closes overflow during read capture without clipping the tool result", async () => {
    const { workspace, set, read } = await capturedTools(1);
    await writeFile(join(workspace, "guide.md"), "visible\n");
    const result = await read("guide.md");
    expect(result.content).toContainEqual(
      expect.objectContaining({ text: "[source-line 1] visible\n" }),
    );
    expect(set.getReviewReadObservation()).toMatchObject({ unavailable: true, files: [] });
  });

  it("refuses a prefixed notice or clipped fragment that is not a delivered source row", async () => {
    const root = await roots.create("docsfab-review-locator-");
    const workspace = join(root, "workspace");
    await mkdir(workspace);
    const raw = Buffer.from("actual source line\n");
    const confinement = await FileConfinement.create({ workspacePath: workspace });
    const target = join(confinement.workspaceRoot, "guide.md");
    for (const presented of ["[source-line 1] notice-only\n", "[source-line 1] actual"]) {
      const capture = new ReviewReadCapture(confinement, limit("artifacts.maxObjectBytes").value);
      const read = capture.observe({
        name: "read",
        execute: async () => {
          capture.captureRaw(target, raw);
          return { content: [{ type: "text", text: presented }] };
        },
      } as unknown as Parameters<ReviewReadCapture["observe"]>[0]);
      await read.execute(
        "fixture-read",
        { path: "guide.md" },
        undefined,
        undefined,
        undefined as never,
      );
      expect(capture.snapshot().files).toEqual([]);
    }
  });
});
