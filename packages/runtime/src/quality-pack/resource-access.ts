// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import {
  HISTORICAL_QUALITY_PROGRAM,
  isHistoricalQualityProgramPath,
  qualityExecutionResource,
  QualityResourceRoleError,
} from "./resource-roles.js";

/** Resolve a closed host-owned role, never a lock bar or caller-supplied path. */
export function qualityExecutionPath(
  selection: unknown,
  kind: "script" | "module",
  roots: { qualityRoot: string; skillCrateRoot?: string },
): string {
  const resource = qualityExecutionResource(selection);
  if (resource.kind !== kind) {
    // hygiene: envelope — QualityResourceRoleError maps the closed code to an actionable message.
    throw new QualityResourceRoleError("unsupported-execution");
  }
  if (resource.scope === "quality") return resolve(roots.qualityRoot, resource.path);
  if (!roots.skillCrateRoot || !resource.skillId)
    // hygiene: envelope — QualityResourceRoleError maps the closed code to an actionable message.
    throw new QualityResourceRoleError("unsupported-execution");
  return resolve(roots.skillCrateRoot, resource.skillId, resource.path);
}

export function insideQualityRoot(root: string, path: string): boolean {
  const scoped = relative(root, path);
  return scoped !== ".." && !scoped.startsWith(`..${sep}`) && !isAbsolute(scoped);
}

/** Called on canonical paths; also refuse hardlinks and renamed byte aliases. */
export async function assertReadableQualityResource(root: string, path: string): Promise<void> {
  if (!insideQualityRoot(root, path)) return;
  if (isHistoricalQualityProgramPath(relative(root, path).split(sep).join("/"))) {
    // hygiene: envelope — QualityResourceRoleError maps the closed code to an actionable message.
    throw new QualityResourceRoleError("historical-program");
  }
  const metadata = await stat(path);
  if (metadata.isFile() && metadata.size === HISTORICAL_QUALITY_PROGRAM.byteLength) {
    assertReadableQualityBytes(await readFile(path));
  }
}

function assertReadableQualityBytes(bytes: Buffer): void {
  if (
    bytes.byteLength === HISTORICAL_QUALITY_PROGRAM.byteLength &&
    createHash("sha256").update(bytes).digest("hex") === HISTORICAL_QUALITY_PROGRAM.sha256
  ) {
    // hygiene: envelope — QualityResourceRoleError maps the closed code to an actionable message.
    throw new QualityResourceRoleError("historical-program");
  }
}

/** Source ownership requires an exact declared path and the authenticated bytes. */
export async function hasHistoricalQualityProgramSource(workspaceRoot: string): Promise<boolean> {
  const paths = [
    join(workspaceRoot, "packages/quality", HISTORICAL_QUALITY_PROGRAM.qualitySourcePath),
    join(workspaceRoot, "packages/runtime/quality", HISTORICAL_QUALITY_PROGRAM.qualityPath),
  ];
  for (const path of paths) {
    try {
      const metadata = await lstat(path);
      if (!metadata.isFile() || metadata.size !== HISTORICAL_QUALITY_PROGRAM.byteLength) continue;
      try {
        assertReadableQualityBytes(await readFile(path));
      } catch (error) {
        if (error instanceof QualityResourceRoleError) return true;
        throw error;
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
    }
  }
  return false;
}

export async function assertReadableSourceResource(
  root: string,
  path: string,
  historicalSource: boolean,
): Promise<void> {
  if (!historicalSource || !insideQualityRoot(root, path)) return;
  const metadata = await stat(path);
  if (metadata.isFile() && metadata.size === HISTORICAL_QUALITY_PROGRAM.byteLength) {
    assertReadableQualityBytes(await readFile(path));
  }
}

/**
 * Run only in the isolated, single-request grep worker. An owned temporary
 * tool adapter appends exclusions after caller globs. No searched file is
 * copied, linked or modified; the SDK keeps its original streaming controls.
 */
export async function withQualityGrepPolicy<T>(
  workspaceRoot: string,
  qualityRoot: string | undefined,
  searchPath: string,
  executable: string | undefined,
  signal: AbortSignal | undefined,
  search: () => Promise<T>,
  glob?: string,
): Promise<T> {
  const target = await realpath(searchPath);
  const root = qualityRoot ? await realpath(qualityRoot) : undefined;
  const historicalSource = await hasHistoricalQualityProgramSource(workspaceRoot);
  const intersectsQuality =
    root && (insideQualityRoot(root, target) || insideQualityRoot(target, root));
  if (!historicalSource && !intersectsQuality) return search();
  if (root) await assertReadableQualityResource(root, target);
  await assertReadableSourceResource(workspaceRoot, target, historicalSource);
  if (!(await stat(target)).isDirectory()) return search();
  if (!executable || !isAbsolute(executable)) {
    throw new Error("Quality grep requires the existing host-resolved ripgrep executable.");
  }
  const excluded: string[] = [];
  const args = ["--files", "--null", "--hidden", ...(glob ? ["--glob", glob] : []), "--", target];
  const child = spawn(executable, args, {
    cwd: workspaceRoot,
    stdio: ["ignore", "pipe", "pipe"],
    signal,
  });
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });
  let processError: Error | undefined;
  const closed = new Promise<number | null>((done) => {
    child.on("error", (error) => {
      processError = error;
    });
    child.on("close", (code) => done(code));
  });
  const decoder = new StringDecoder("utf8");
  let pending = "";
  async function inspect(path: string): Promise<void> {
    signal?.throwIfAborted();
    const canonical = await realpath(path);
    try {
      if (root) await assertReadableQualityResource(root, canonical);
      await assertReadableSourceResource(workspaceRoot, canonical, historicalSource);
    } catch (error) {
      if (!(error instanceof QualityResourceRoleError) || error.code !== "historical-program")
        throw error;
      excluded.push(path.split(sep).join("/"));
    }
  }
  try {
    for await (const chunk of child.stdout) {
      pending += decoder.write(chunk as Buffer);
      let end: number;
      while ((end = pending.indexOf("\0")) !== -1) {
        const path = pending.slice(0, end);
        pending = pending.slice(end + 1);
        if (path) await inspect(path);
      }
    }
    pending += decoder.end();
    const code = await closed;
    if (processError) throw processError;
    if (code !== 0 && code !== 1)
      throw new Error(stderr.trim() || "ripgrep file inventory failed.");
    if (pending) throw new Error("Ripgrep file inventory ended with an incomplete path.");
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await closed;
  }
  if (excluded.length === 0) return search();
  // A leading `/` glob is cwd-relative in rg. A literal slash class instead
  // matches the exact absolute candidate, including literal metacharacters.
  const literalGlob = (path: string) => {
    const insideWorkspace = insideQualityRoot(workspaceRoot, path);
    const scoped = insideWorkspace ? relative(workspaceRoot, path).split(sep).join("/") : path;
    const escaped = scoped.replace(/[?*\[\]{}\\]/gu, (part) => "\\" + part);
    if (insideWorkspace) return "!/" + escaped;
    return escaped.startsWith("/") ? "![/]" + escaped.slice(1) : "!" + escaped;
  };
  const flags = excluded.flatMap((path) => ["--glob", literalGlob(path)]);
  const owned = await mkdtemp(join(tmpdir(), "docsfab-quality-grep-"));
  const previousAgentDirectory = process.env.PI_CODING_AGENT_DIR;
  try {
    await mkdir(join(owned, "bin"), { mode: 0o700 });
    const adapter = `#!${process.execPath}
const { spawn } = require("node:child_process");
const args = process.argv.slice(2);
const separator = args.indexOf("--");
const flags = ${JSON.stringify(flags)};
const forwarded = separator < 0 ? args : [...args.slice(0, separator), ...flags, ...args.slice(separator)];
const child = spawn(${JSON.stringify(executable)}, forwarded, { stdio: "inherit" });
for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => child.kill(signal));
child.on("error", () => { process.stderr.write("Failed to run ripgrep: existing executable is unavailable\\n"); process.exitCode = 2; });
child.on("close", (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0); });
`;
    await writeFile(join(owned, "bin", "rg"), adapter, { mode: 0o700 });
    process.env.PI_CODING_AGENT_DIR = owned;
    signal?.throwIfAborted();
    return await search();
  } finally {
    if (previousAgentDirectory === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDirectory;
    await rm(owned, { recursive: true, force: true });
  }
}
