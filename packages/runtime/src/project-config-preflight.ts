// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Shared project-config / dirty-tree preflight for auto, multi-unit-campaign,
 * and release-documentation-readiness. Codes are the doctor family; gates stay
 * fail-closed (ADR docsfab-json-commit-vs-ignore-decision).
 */

import { spawn } from "node:child_process";
import { lstat } from "node:fs/promises";
import { join, resolve } from "node:path";

import { parseJsonEvidence } from "./json-evidence.js";
import { DOCSFAB_PROJECT_CONFIG_FILE, type DocsFabProjectConfigV1 } from "./init/types.js";
import { assertDocsFabProjectConfig } from "./init/project-config.js";

export const PROJECT_CONFIG_UNTRACKED_CODE = "project-config-untracked" as const;
export const REPOSITORY_SOURCE_DIRTY_CODE = "repository-source-dirty" as const;

export type ProjectConfigPreflightCode =
  | typeof PROJECT_CONFIG_UNTRACKED_CODE
  | typeof REPOSITORY_SOURCE_DIRTY_CODE;

export type ProjectConfigPreflightSurface =
  | "auto"
  | "multi-unit-campaign"
  | "release-documentation-readiness"
  | "run"
  | "publish";

export type ProjectConfigAuthority =
  | { readonly status: "missing" }
  | { readonly status: "untracked"; readonly inspection: ProjectConfigCheckoutInspection }
  | { readonly status: "tracked"; readonly config: DocsFabProjectConfigV1 };

export interface ProjectConfigCheckoutInspection {
  readonly porcelainLines: readonly string[];
  readonly trackedInRevision: boolean;
  readonly projectConfigPresent: boolean;
  readonly codes: readonly ProjectConfigPreflightCode[];
}

export class ProjectConfigPreflightError extends Error {
  public constructor(
    public readonly code: ProjectConfigPreflightCode,
    message: string,
    public readonly nextAction: string,
  ) {
    super(message);
    this.name = "ProjectConfigPreflightError";
  }
}

const GIT_BINARY = process.platform === "win32" ? "git" : "/usr/bin/git";
const SAFE_GIT_CONFIG = [
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "core.fsmonitor=false",
  "-c",
  "core.attributesFile=/dev/null",
  "-c",
  "core.excludesFile=/dev/null",
  "-c",
  "pager.status=false",
] as const;

const RELEASE_DOC_FALLBACK =
  "Release documentation readiness requires a valid tracked .docsfab.json default branch.";

export function classifyProjectConfigCheckout(input: {
  readonly porcelain: string;
  readonly trackedInRevision: boolean;
  readonly projectConfigPresent: boolean;
}): ProjectConfigCheckoutInspection {
  const porcelainLines = input.porcelain.split(/\r?\n/u).filter((line) => line.length > 0);
  const docsfabPorcelain = porcelainLines.filter(isDocsFabProjectConfigPorcelain);
  const otherPorcelain = porcelainLines.filter((line) => !isDocsFabProjectConfigPorcelain(line));
  const codes: ProjectConfigPreflightCode[] = [];
  if (input.projectConfigPresent && !input.trackedInRevision) {
    codes.push(PROJECT_CONFIG_UNTRACKED_CODE);
  }
  if (otherPorcelain.length > 0 || (input.trackedInRevision && docsfabPorcelain.length > 0)) {
    codes.push(REPOSITORY_SOURCE_DIRTY_CODE);
  }
  return Object.freeze({
    porcelainLines,
    trackedInRevision: input.trackedInRevision,
    projectConfigPresent: input.projectConfigPresent,
    codes: Object.freeze(codes),
  });
}

/**
 * Classify whether a checkout may authorize a run from tracked project
 * configuration. Untracked files are reported and never treated as authority.
 * An uninspectable (non-Git) path cannot mint tracked authority.
 */
export async function resolveProjectConfigAuthority(
  repositoryPath: string,
): Promise<ProjectConfigAuthority> {
  let inspection: ProjectConfigCheckoutInspection;
  try {
    inspection = await inspectProjectConfigCheckout(repositoryPath);
  } catch {
    return { status: "missing" };
  }
  if (inspection.codes.includes(PROJECT_CONFIG_UNTRACKED_CODE)) {
    return { status: "untracked", inspection };
  }
  if (!inspection.trackedInRevision) {
    return { status: "missing" };
  }
  return {
    status: "tracked",
    config: await loadTrackedHeadProjectConfig(resolve(repositoryPath)),
  };
}

async function loadTrackedHeadProjectConfig(
  repositoryPath: string,
): Promise<DocsFabProjectConfigV1> {
  try {
    const shown = await runGit(repositoryPath, ["show", `HEAD:${DOCSFAB_PROJECT_CONFIG_FILE}`]);
    const parsed = parseJsonEvidence(shown);
    assertDocsFabProjectConfig(parsed);
    return parsed;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Existing DocsFab")) {
      throw error;
    }
    throw new Error(
      "Existing DocsFab project configuration is invalid; no project file was changed.",
    );
  }
}

/**
 * The paths among `paths` that HEAD tracks as regular files, by exact path and
 * letter case: a link, a submodule, a directory, or an untracked file is not
 * one. Pathspecs are literal, so a configured entry never acts as a pattern.
 */
export async function trackedHeadRegularFiles(
  repositoryPath: string,
  paths: readonly string[],
): Promise<readonly string[]> {
  if (paths.length === 0) return [];
  const listed = await runGit(resolve(repositoryPath), [
    "--literal-pathspecs",
    "ls-tree",
    "-z",
    "HEAD",
    "--",
    ...paths,
  ]);
  const files = new Set<string>();
  for (const entry of listed.split("\0")) {
    const tab = entry.indexOf("\t");
    if (tab === -1) continue;
    const [mode, type] = entry.slice(0, tab).split(" ");
    if ((mode === "100644" || mode === "100755") && type === "blob") {
      files.add(entry.slice(tab + 1));
    }
  }
  return paths.filter((path) => files.has(path));
}

/**
 * Every path HEAD tracks, for a bare file name an operator's message names.
 * A checkout whose HEAD cannot be listed yields none, so no bare name resolves.
 */
export async function trackedHeadPaths(repositoryPath: string): Promise<readonly string[]> {
  try {
    const listed = await runGit(resolve(repositoryPath), [
      "ls-tree",
      "-r",
      "-z",
      "--name-only",
      "HEAD",
    ]);
    return Object.freeze(listed.split("\0").filter((path) => path !== ""));
  } catch {
    return [];
  }
}

export async function inspectProjectConfigCheckout(
  repositoryPath: string,
): Promise<ProjectConfigCheckoutInspection> {
  const path = resolve(repositoryPath);
  const [porcelain, listed, present] = await Promise.all([
    runGit(path, ["status", "--porcelain=v1", "--untracked-files=all"]),
    runGit(path, ["ls-tree", "--name-only", "HEAD", "--", DOCSFAB_PROJECT_CONFIG_FILE]),
    projectConfigPresent(path),
  ]);
  return classifyProjectConfigCheckout({
    porcelain,
    trackedInRevision: listed.trim() === DOCSFAB_PROJECT_CONFIG_FILE,
    projectConfigPresent: present,
  });
}

export function primaryProjectConfigPreflightCode(
  inspection: ProjectConfigCheckoutInspection,
): ProjectConfigPreflightCode | undefined {
  if (
    inspection.codes.includes(REPOSITORY_SOURCE_DIRTY_CODE) &&
    !inspection.codes.includes(PROJECT_CONFIG_UNTRACKED_CODE)
  ) {
    return REPOSITORY_SOURCE_DIRTY_CODE;
  }
  if (
    inspection.codes.includes(PROJECT_CONFIG_UNTRACKED_CODE) &&
    !inspection.codes.includes(REPOSITORY_SOURCE_DIRTY_CODE)
  ) {
    return PROJECT_CONFIG_UNTRACKED_CODE;
  }
  if (inspection.codes.includes(REPOSITORY_SOURCE_DIRTY_CODE)) {
    return REPOSITORY_SOURCE_DIRTY_CODE;
  }
  if (inspection.codes.includes(PROJECT_CONFIG_UNTRACKED_CODE)) {
    return PROJECT_CONFIG_UNTRACKED_CODE;
  }
  return undefined;
}

export function projectConfigPreflightNextStep(
  code: ProjectConfigPreflightCode,
  surface: ProjectConfigPreflightSurface,
): string {
  if (code === PROJECT_CONFIG_UNTRACKED_CODE) {
    if (surface === "run") {
      return `Remove the untracked ${DOCSFAB_PROJECT_CONFIG_FILE}; then retry the DocsFab write workflow`;
    }
    if (surface === "publish") {
      return `Remove the untracked ${DOCSFAB_PROJECT_CONFIG_FILE}; then retry docsfab publish --execute`;
    }
    const commit = `git add ${DOCSFAB_PROJECT_CONFIG_FILE} && git commit`;
    if (surface === "auto") return `${commit}; then retry docsfab auto --dry-run`;
    if (surface === "multi-unit-campaign") {
      return `${commit}; then retry docsfab multi-unit-campaign`;
    }
    return `${commit}; then retry docsfab run release-documentation-readiness`;
  }
  if (surface === "auto") return "git status; then retry docsfab auto --dry-run";
  if (surface === "multi-unit-campaign") {
    return "git status; then retry docsfab multi-unit-campaign";
  }
  if (surface === "run") return "git status; then retry the DocsFab write workflow";
  if (surface === "publish") return "git status; then retry docsfab publish --execute";
  return "git status; then retry docsfab run release-documentation-readiness";
}

export function formatProjectConfigPreflightMessage(
  code: ProjectConfigPreflightCode,
  surface: ProjectConfigPreflightSurface,
  fallbackMessage?: string,
): string {
  const explanation =
    code === PROJECT_CONFIG_UNTRACKED_CODE
      ? "The DocsFab project configuration is not tracked in the current revision."
      : "The worktree has dirty porcelain that blocks clean-revision commands.";
  const prefix = fallbackMessage ? `${fallbackMessage}\n` : "";
  return [
    `${prefix}${explanation}`,
    `Code: ${code}`,
    `Next action: ${projectConfigPreflightNextStep(code, surface)}`,
  ].join("\n");
}

export async function loadTrackedDocsFabProjectConfig(input: {
  readonly sourcePath: string;
  readonly readTrackedBytes: () => Promise<Buffer>;
  readonly surface: ProjectConfigPreflightSurface;
}): Promise<DocsFabProjectConfigV1> {
  try {
    const parsed: unknown = JSON.parse((await input.readTrackedBytes()).toString("utf8"));
    assertDocsFabProjectConfig(parsed);
    return parsed;
  } catch {
    throw await createProjectConfigPreflightError({
      repositoryPath: input.sourcePath,
      surface: input.surface,
      fallbackMessage:
        input.surface === "release-documentation-readiness" ? RELEASE_DOC_FALLBACK : undefined,
    });
  }
}

export async function createProjectConfigPreflightError(input: {
  readonly repositoryPath: string;
  readonly surface: ProjectConfigPreflightSurface;
  readonly fallbackMessage?: string;
}): Promise<Error> {
  const inspection = await inspectProjectConfigCheckout(input.repositoryPath).catch(() => null);
  const code = inspection ? primaryProjectConfigPreflightCode(inspection) : undefined;
  if (!code) {
    return new Error(
      input.fallbackMessage ??
        "DocsFab requires a valid tracked .docsfab.json in the selected revision.",
    );
  }
  return new ProjectConfigPreflightError(
    code,
    formatProjectConfigPreflightMessage(code, input.surface, input.fallbackMessage),
    projectConfigPreflightNextStep(code, input.surface),
  );
}

function isDocsFabProjectConfigPorcelain(line: string): boolean {
  return /^(?:[ MADRCU?!]{2}) (?:.+ -> )?\.docsfab\.json$/u.test(line);
}

async function projectConfigPresent(repositoryPath: string): Promise<boolean> {
  try {
    const metadata = await lstat(join(repositoryPath, DOCSFAB_PROJECT_CONFIG_FILE));
    return metadata.isFile() && !metadata.isSymbolicLink();
  } catch {
    return false;
  }
}

async function runGit(repositoryPath: string, args: readonly string[]): Promise<string> {
  return await new Promise((resolvePromise, reject) => {
    const child = spawn(GIT_BINARY, [...SAFE_GIT_CONFIG, "-C", repositoryPath, ...args], {
      cwd: repositoryPath,
      env: {
        PATH: process.env.PATH,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_TERMINAL_PROMPT: "0",
        LANG: "C",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.on("error", () => reject(new Error("project-config-preflight-inspect-failed")));
    child.on("close", (exitCode) => {
      if (exitCode !== 0) {
        reject(new Error("project-config-preflight-inspect-failed"));
        return;
      }
      resolvePromise(Buffer.concat(stdout).toString("utf8").trimEnd());
    });
  });
}
