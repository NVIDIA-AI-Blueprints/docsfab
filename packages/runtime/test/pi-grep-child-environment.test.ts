// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { delimiter, join } from "node:path";

import { describe, expect, it } from "vitest";

import { temporaryRoots } from "./helpers/temp.js";

const roots = temporaryRoots();

describe("Pi grep child credential environment", () => {
  it("filters the pinned Pi grep probe and search children while find remains in-process", async () => {
    const root = await roots.create("docsfab-pi-grep-env-");
    const workspace = join(root, "workspace");
    const bin = join(root, "bin");
    const home = join(root, "home");
    const piAgent = join(root, "pi-agent");
    await Promise.all([
      mkdir(join(workspace, "docs"), { recursive: true }),
      mkdir(bin, { recursive: true }),
      mkdir(home, { recursive: true }),
      mkdir(piAgent, { recursive: true }),
    ]);
    await writeFile(join(workspace, "docs", "guide.md"), "alpha needle\n", "utf8");
    const reportPath = join(workspace, "docs", "rg-env-report.jsonl");
    const fakeRgPath = join(bin, "rg");
    await writeFile(
      fakeRgPath,
      `#!${process.execPath}\nconst fs = require("node:fs");\nconst path = require("node:path");\nconst args = process.argv.slice(2);\nconst reportPath = ${JSON.stringify(reportPath)};\nfs.appendFileSync(reportPath, JSON.stringify({ model: Boolean(process.env.MODEL_API_KEY), other: Boolean(process.env.DOCSFAB_FIXTURE_TOKEN), path: Boolean(process.env.PATH), home: Boolean(process.env.HOME), proxy: process.env.HTTPS_PROXY === "http://proxy.example.test:8080" }) + "\\n");\nif (args.includes("--version")) { process.stdout.write("ripgrep 14.1.0\\n"); } else { const target = args.at(-1); process.stdout.write(JSON.stringify({ type: "match", data: { path: { text: path.join(target, "guide.md") }, line_number: 1, lines: { text: "alpha needle\\n" } } }) + "\\n"); }\n`,
      "utf8",
    );
    await chmod(fakeRgPath, 0o700);

    const sourcePath = join(process.cwd(), "src", "harness", "confined-tools.ts");
    const script = [
      `import { readFile } from "node:fs/promises";`,
      `import { createConfinedToolSet } from ${JSON.stringify(new URL(`file://${sourcePath}`).href)};`,
      `const workspace = process.argv[1];`,
      `const set = await createConfinedToolSet({ workspacePath: workspace, allowWrite: false });`,
      `const tools = new Map(set.definitions.map((tool) => [tool.name, tool]));`,
      `const call = async (name, input) => tools.get(name).execute("fixture", input, undefined, undefined, undefined);`,
      `let grep; try { grep = await call("grep", { path: "docs", pattern: "alpha", literal: true }); } catch (error) { process.stderr.write(String(error)); throw error; }`,
      `const find = await call("find", { path: "docs", pattern: "*.md" });`,
      `process.stdout.write(JSON.stringify({ grep: grep.content[0]?.text, find: find.content[0]?.text }));`,
    ].join("\n");
    const fullEnvironment = {
      ...process.env,
      PATH: `${bin}${delimiter}${process.env.PATH ?? "/usr/bin:/bin"}`,
      HOME: home,
      PI_CODING_AGENT_DIR: piAgent,
      PI_OFFLINE: "1",
      MODEL_API_KEY: "operator-model-secret-3f69a2b1",
      DOCSFAB_FIXTURE_TOKEN: "file-loaded-other-secret-8b3c70d2",
      HTTPS_PROXY: "http://proxy.example.test:8080",
    };
    const executed = spawnSync(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "-e", script, workspace],
      { cwd: process.cwd(), env: fullEnvironment, encoding: "utf8" },
    );
    expect(executed.error).toBeUndefined();
    expect(
      executed.status,
      JSON.stringify({
        stderr: executed.stderr,
        report: await readFile(reportPath, "utf8").catch(() => "missing"),
      }),
    ).toBe(0);
    const output = JSON.parse(executed.stdout) as { grep: string; find: string };
    expect(output.grep).toContain("guide.md:1: alpha needle");
    expect(output.find).toContain("guide.md");

    const reports = (await readFile(reportPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, boolean>);
    expect(reports.length).toBeGreaterThan(0);
    expect(reports).toEqual(
      reports.map(() => ({ model: false, other: false, path: true, home: true, proxy: true })),
    );
  }, 15_000);
});
