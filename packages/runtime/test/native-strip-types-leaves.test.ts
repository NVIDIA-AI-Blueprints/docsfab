// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

const SOURCE_ROOT = fileURLToPath(new URL("../src/", import.meta.url));
const LEAF_MARKER =
  "NodeNext `.js` leaf so plain `node --experimental-strip-types` can evaluate this graph";

function markedLeaves(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return markedLeaves(path);
    return entry.name.endsWith(".js") && readFileSync(path, "utf8").includes(LEAF_MARKER)
      ? [path]
      : [];
  });
}

const leaves = markedLeaves(SOURCE_ROOT).sort();

describe("native strip-types source leaves", () => {
  it("discovers the declared leaves", () => {
    expect(leaves.map((path) => relative(SOURCE_ROOT, path))).toContain(
      join("host-invoker", "wire-decode.js"),
    );
  });

  // A shared-helper import from a module without its own `.js` leaf breaks
  // every host plain-Node import graph that reaches the importer.
  it.each(leaves.map((path) => [relative(SOURCE_ROOT, path), path]))(
    "loads %s through fresh native Node",
    (_name, path) => {
      const program = `await import(${JSON.stringify(pathToFileURL(path).href)});`;
      expect(() =>
        execFileSync(
          process.execPath,
          ["--experimental-strip-types", "--input-type=module", "-e", program],
          { stdio: "pipe", env: { PATH: "/usr/bin:/bin", PI_OFFLINE: "1" } },
        ),
      ).not.toThrow();
    },
  );
});
