// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { lstat, readdir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import { canonicalDigest } from "../content-ir/index.js";

const TOPIC_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const WINDOWS_DRIVE = /^[A-Za-z]:[\\/]/u;
const PLATFORM_SPECIAL = /[<>:"|?*\u0000-\u001f]/u;
const PORTABLE_ASCII_PATH = /^[A-Za-z0-9._/-]+$/u;
const WINDOWS_RESERVED = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/iu;
const GENERIC_TEMPLATE_NAMES = new Set([
  "about-feature",
  "about-procedural-task",
  "concept",
  "conceptual",
  "conceptual-blended",
  "default",
  "doc",
  "document",
  "example",
  "feature",
  "general",
  "misc",
  "miscellaneous",
  "multiple-procedural",
  "multiple-procedural-tasks",
  "new-page",
  "new-site",
  "other",
  "page",
  "procedural",
  "procedural-task",
  "single-procedural",
  "single-procedural-task",
  "template",
  "test",
  "untitled",
]);

/** Bounds transaction-owned descriptors retained through the acceptance gate. */
export const MAX_TEMPLATE_OUTPUTS = 128;

export interface ProposedTemplatePath {
  /** Approved topic slug, not a display label or generic template placeholder. */
  templateName: string;
  /** Repository-relative output file path using forward slashes. */
  relativePath: string;
}

export interface CanonicalTemplatePath {
  templateName: string;
  relativePath: string;
  absolutePath: string;
  /** Missing directories, ordered shallowest-first, that a transaction may create. */
  missingParentDirectories: string[];
}

export interface TemplatePathPlan {
  schemaVersion: 1;
  workspacePath: string;
  workspaceIdentity: {
    device: number;
    inode: number;
  };
  outputs: CanonicalTemplatePath[];
  /** SHA-256 over the immutable workspace identity and canonical output identities. */
  digest: string;
}

export type TemplatePathErrorCode =
  | "invalid-workspace"
  | "invalid-template-name"
  | "unsafe-path"
  | "duplicate-path"
  | "portable-path-collision"
  | "path-exists"
  | "symlink-component"
  | "parent-file-collision"
  | "plan-changed";

export class TemplatePathError extends Error {
  public constructor(
    public readonly code: TemplatePathErrorCode,
    public readonly path: string,
  ) {
    super(`Template path preflight failed (${code}) at ${path}.`);
    this.name = "TemplatePathError";
  }
}

export interface TemplatePathPreflightInput {
  /** Existing disposable workspace directory. The preflight never writes to it. */
  workspacePath: string;
  outputs: readonly ProposedTemplatePath[];
}

/**
 * Resolve and inspect every proposed output before any scaffold write occurs.
 * The operation is read-only and returns outputs in canonical path order.
 */
export async function preflightTemplatePaths(
  input: TemplatePathPreflightInput,
): Promise<TemplatePathPlan> {
  const workspace = await canonicalWorkspace(input.workspacePath);
  if (
    !Array.isArray(input.outputs) ||
    input.outputs.length === 0 ||
    input.outputs.length > MAX_TEMPLATE_OUTPUTS
  ) {
    fail("unsafe-path", "$.outputs");
  }

  const normalized = input.outputs
    .map((output, index) => {
      const path = `$.outputs[${index}]`;
      if (
        !output ||
        typeof output !== "object" ||
        Array.isArray(output) ||
        Object.keys(output).some((key) => key !== "templateName" && key !== "relativePath") ||
        !Object.hasOwn(output, "templateName") ||
        !Object.hasOwn(output, "relativePath")
      ) {
        fail("unsafe-path", path);
      }
      return {
        templateName: validateTemplateName(output.templateName, `${path}.templateName`),
        relativePath: validateRelativePath(output.relativePath, `${path}.relativePath`),
      };
    })
    .sort((left, right) => compareStrings(left.relativePath, right.relativePath));
  assertNoOutputCollisions(normalized);

  const outputs: CanonicalTemplatePath[] = [];
  for (const output of normalized) {
    outputs.push({
      ...output,
      absolutePath: containedAbsolutePath(workspace.path, output.relativePath),
      missingParentDirectories: await inspectOutputPath(workspace.path, output.relativePath),
    });
  }

  return sealPlan({
    schemaVersion: 1,
    workspacePath: workspace.path,
    workspaceIdentity: workspace.identity,
    outputs,
  });
}

/**
 * Recheck the sealed plan immediately before a transaction creates anything.
 * Callers must still create files with exclusive semantics because no preflight
 * can eliminate a race after its final filesystem observation.
 */
export async function recheckTemplatePathPlan(plan: TemplatePathPlan): Promise<TemplatePathPlan> {
  if (plan.digest !== digestPlan(plan)) fail("plan-changed", "$.digest");
  const workspace = await canonicalWorkspace(plan.workspacePath);
  if (
    workspace.identity.device !== plan.workspaceIdentity.device ||
    workspace.identity.inode !== plan.workspaceIdentity.inode ||
    workspace.path !== plan.workspacePath
  ) {
    fail("plan-changed", "$.workspaceIdentity");
  }
  const refreshed = await preflightTemplatePaths({
    workspacePath: plan.workspacePath,
    outputs: plan.outputs.map(({ templateName, relativePath }) => ({ templateName, relativePath })),
  });
  if (refreshed.digest !== plan.digest) fail("plan-changed", "$.outputs");
  return refreshed;
}

function validateTemplateName(value: unknown, path: string): string {
  if (
    typeof value !== "string" ||
    value !== value.normalize("NFC") ||
    value.length > 80 ||
    !TOPIC_SLUG.test(value) ||
    GENERIC_TEMPLATE_NAMES.has(value)
  ) {
    fail("invalid-template-name", path);
  }
  return value;
}

function validateRelativePath(value: unknown, path: string): string {
  if (
    typeof value !== "string" ||
    !value ||
    value !== value.normalize("NFC") ||
    value.includes("\0") ||
    value.includes("\\") ||
    value.startsWith("~") ||
    !PORTABLE_ASCII_PATH.test(value) ||
    isAbsolute(value) ||
    WINDOWS_DRIVE.test(value) ||
    value.startsWith("//")
  ) {
    fail("unsafe-path", path);
  }
  if (value.length > 4_096) fail("unsafe-path", path);
  const segments = value.split("/");
  if (
    segments.some(
      (segment) =>
        !segment ||
        segment === "." ||
        segment === ".." ||
        segment.length > 255 ||
        segment.endsWith(".") ||
        segment.endsWith(" ") ||
        PLATFORM_SPECIAL.test(segment) ||
        WINDOWS_RESERVED.test(segment),
    )
  ) {
    fail("unsafe-path", path);
  }
  return segments.join("/");
}

function assertNoOutputCollisions(outputs: readonly ProposedTemplatePath[]): void {
  const byPortablePath = new Map<string, string>();
  for (const output of outputs) {
    const key = portablePathKey(output.relativePath);
    const previous = byPortablePath.get(key);
    if (previous) fail("duplicate-path", output.relativePath);
    byPortablePath.set(key, output.relativePath);
  }
  const paths = [...byPortablePath.keys()].sort(compareStrings);
  for (let index = 0; index < paths.length; index += 1) {
    const parent = paths[index]!;
    for (let nestedIndex = index + 1; nestedIndex < paths.length; nestedIndex += 1) {
      const child = paths[nestedIndex]!;
      if (child.startsWith(`${parent}/`))
        fail("parent-file-collision", byPortablePath.get(parent)!);
      if (!child.startsWith(parent)) break;
    }
  }
}

async function inspectOutputPath(workspacePath: string, relativePath: string): Promise<string[]> {
  const segments = relativePath.split("/");
  const missingParents: string[] = [];
  let current = workspacePath;
  let parentMissing = false;
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index]!;
    if (!parentMissing) {
      const collision = (await readdir(current)).find(
        (entry) => entry !== segment && portablePathKey(entry) === portablePathKey(segment),
      );
      if (collision) fail("portable-path-collision", relativePath);
    }
    current = join(current, segment);
    const output = index === segments.length - 1;
    let metadata;
    try {
      metadata = await lstat(current);
    } catch (error) {
      if (!isMissing(error)) throw error;
      if (!output) {
        missingParents.push(current);
        parentMissing = true;
      }
      continue;
    }
    if (metadata.isSymbolicLink()) fail("symlink-component", relativePath);
    if (output) fail("path-exists", relativePath);
    if (!metadata.isDirectory()) fail("parent-file-collision", relativePath);
  }

  // Existing ancestors were lstat-checked component by component from a real
  // workspace root. This final containment check also protects path API drift.
  containedAbsolutePath(workspacePath, relativePath);
  return missingParents;
}

async function canonicalWorkspace(workspacePath: unknown): Promise<{
  path: string;
  identity: { device: number; inode: number };
}> {
  if (typeof workspacePath !== "string" || !workspacePath || workspacePath.includes("\0")) {
    fail("invalid-workspace", "$.workspacePath");
  }
  const lexical = resolve(workspacePath);
  let lexicalMetadata;
  try {
    lexicalMetadata = await lstat(lexical);
  } catch {
    fail("invalid-workspace", "$.workspacePath");
  }
  if (lexicalMetadata.isSymbolicLink() || !lexicalMetadata.isDirectory()) {
    fail("invalid-workspace", "$.workspacePath");
  }
  const canonical = await realpath(lexical);
  const metadata = await lstat(canonical);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    fail("invalid-workspace", "$.workspacePath");
  }
  return {
    path: canonical,
    identity: { device: metadata.dev, inode: metadata.ino },
  };
}

function containedAbsolutePath(workspacePath: string, relativePath: string): string {
  const candidate = resolve(workspacePath, ...relativePath.split("/"));
  const difference = relative(workspacePath, candidate);
  if (difference === ".." || difference.startsWith(`..${sep}`) || isAbsolute(difference)) {
    fail("unsafe-path", relativePath);
  }
  return candidate;
}

function sealPlan(plan: Omit<TemplatePathPlan, "digest">): TemplatePathPlan {
  return { ...plan, digest: digestPlan(plan) };
}

function digestPlan(plan: Omit<TemplatePathPlan, "digest"> | TemplatePathPlan): string {
  return canonicalDigest({
    schemaVersion: plan.schemaVersion,
    workspacePath: plan.workspacePath,
    workspaceIdentity: plan.workspaceIdentity,
    outputs: plan.outputs.map((output) => ({
      templateName: output.templateName,
      relativePath: output.relativePath,
      absolutePath: output.absolutePath,
    })),
  });
}

function portablePathKey(path: string): string {
  return path.normalize("NFC").toLowerCase();
}

function isMissing(error: unknown): boolean {
  return (
    error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

function fail(code: TemplatePathErrorCode, path: string): never {
  throw new TemplatePathError(code, path);
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
