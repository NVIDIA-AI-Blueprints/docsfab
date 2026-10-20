// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** Entry point for a minimized parent-under-test; all secret values are synthetic. */
import { watch } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const installedRoot = process.argv[4];
const { createConfinedToolSet } = (await import(
  installedRoot
    ? pathToFileURL(join(installedRoot, "dist/harness/confined-tools.js")).href
    : new URL("../../src/harness/confined-tools.js", import.meta.url).href
)) as typeof import("../../src/harness/confined-tools.js");
const { HISTORICAL_QUALITY_PROGRAM } = (await import(
  installedRoot
    ? pathToFileURL(join(installedRoot, "dist/quality-pack/resource-roles.js")).href
    : new URL("../../src/quality-pack/resource-roles.js", import.meta.url).href
)) as typeof import("../../src/quality-pack/resource-roles.js");

const root = process.argv[2]!;
const mode = process.argv[3]!;
const workspace = join(root, "workspace");
const quality = join(root, "quality");
const sentinelNames = [
  "MODEL_API_KEY",
  "OPENAI_API_KEY",
  "GITLAB_TOKEN",
  "GITHUB_TOKEN",
  "CI_JOB_TOKEN",
  "AWS_SECRET_ACCESS_KEY",
];
const probes = join(root, "probes.jsonl");
const guarded = mode !== "plain" && !mode.startsWith("prefix-");
await mkdir(workspace, { recursive: true });
await writeFile(join(workspace, "guide.md"), "A useful public marker.\n");
if (guarded) {
  await mkdir(join(quality, "checks"), { recursive: true });
  await writeFile(join(quality, "checks/active.py"), "# useful public marker\n");
  await writeFile(
    join(quality, HISTORICAL_QUALITY_PROGRAM.qualityPath),
    await readFile(
      installedRoot
        ? join(installedRoot, "quality", HISTORICAL_QUALITY_PROGRAM.qualityPath)
        : resolve(import.meta.dirname, "../../quality", HISTORICAL_QUALITY_PROGRAM.qualityPath),
    ),
  );
}
if (mode === "prefix-packages")
  await writeFile(join(workspace, "packages"), "Ordinary repository source.\n");
if (mode === "prefix-quality") {
  await mkdir(join(workspace, "packages"));
  await writeFile(join(workspace, "packages/quality"), "Ordinary repository source.\n");
}

const set = await createConfinedToolSet({
  workspacePath: workspace,
  allowWrite: false,
  ...(guarded ? { governedQualityDirectory: quality } : {}),
});
const grep = set.definitions.find((tool) => tool.name === "grep")!;
const controller = new AbortController();
let watcher: ReturnType<typeof watch> | undefined;
let probeReady: Promise<void> | undefined;
if (mode === "abort-probe") {
  probeReady = new Promise<void>((done) => {
    watcher = watch(root, (_event, file) => {
      if (String(file) === "probes.jsonl") done();
    });
  });
}
let outcome: Record<string, unknown>;
try {
  const pending = grep.execute(
    "sentinel",
    {
      path: guarded ? ".docsfab-governed-assets/quality" : ".",
      pattern: "public marker|REQUIRED_FILES",
      glob: "**/*",
    },
    controller.signal,
    undefined,
    undefined as never,
  );
  if (probeReady) {
    await probeReady;
    controller.abort();
  }
  const result = await pending;
  const text = result.content
    .filter((item) => item.type === "text")
    .map((item) => (item as { text: string }).text)
    .join("\n");
  outcome = {
    status: "passed",
    useful: text.includes("public marker"),
    historicalAbsent: !text.includes("REQUIRED_FILES"),
  };
  if (mode.startsWith("prefix-")) {
    const read = set.definitions.find((tool) => tool.name === "read")!;
    const visible = await read.execute(
      "ordinary-read",
      { path: "guide.md" },
      undefined,
      undefined,
      undefined as never,
    );
    outcome.readUseful = visible.content.some(
      (item) => item.type === "text" && (item as { text: string }).text.includes("public marker"),
    );
  }
} catch (error) {
  outcome = { status: "refused", message: (error as Error).message };
} finally {
  watcher?.close();
}
const observations = (
  await readFile(probes, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return "";
    throw error;
  })
)
  .split("\n")
  .filter(Boolean)
  .map((line) => JSON.parse(line));
const processStates = observations
  .filter((row) => row.phase === "version")
  .map((row) => {
    try {
      process.kill(row.pid, 0);
      return { pid: row.pid, alive: true };
    } catch {
      return { pid: row.pid, alive: false };
    }
  });
process.stdout.write(
  JSON.stringify({
    ...outcome,
    mode,
    observations,
    parentSentinelsIntact: sentinelNames.every((name) =>
      process.env[name]?.startsWith("synthetic-"),
    ),
    processStates,
  }) + "\n",
);
