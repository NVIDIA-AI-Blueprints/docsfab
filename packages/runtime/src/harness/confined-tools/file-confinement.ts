// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { lstat, readdir, realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { PathRefusalReason, ToolFailureCategory } from "../../records/contracts.js";
import { VIRTUAL_WORKSPACE_CWD } from "../pi-session.js";
import type { CredentialSafeGrepGrants } from "../credential-safe-grep.js";
import {
  assertReadableQualityResource,
  assertReadableSourceResource,
  hasHistoricalQualityProgramSource,
} from "../../quality-pack/resource-access.js";
import { QualityResourceRoleError } from "../../quality-pack/resource-roles.js";

const VIRTUAL_GOVERNED_DIRECTORY = ".docsfab-governed-assets";
export type PathMode = "read" | "write";

export interface FileConfinementOptions {
  readonly workspacePath: string;
  readonly governedSkill?: { readonly id: string; readonly directory: string };
  readonly governedQualityDirectory?: string;
  readonly allowedWritePaths?: readonly string[];
  readonly isWritePathAllowed?: (path: string) => boolean;
  readonly beforeMutation?: () => Promise<void>;
  readonly writeScopeRefusal?: (path: string) => string;
}

export class ConfinedToolError extends Error {
  /** Set only for `malformed-arguments`, to name the tool's own parameters. */
  public readonly toolName: string | undefined;
  /** Set for every `denied-path` refusal, and only then: the rule that refused the path. */
  public readonly refusal: PathRefusalReason | undefined;
  /** A host-authored sentence that replaces the category's generic one. */
  public readonly hostMessage: string | undefined;

  public constructor(category: "denied-path", refusal: PathRefusalReason, hostMessage?: string);
  public constructor(category: "malformed-arguments", toolName: string);
  public constructor(category: Exclude<ToolFailureCategory, "denied-path" | "malformed-arguments">);
  public constructor(
    public readonly category: ToolFailureCategory,
    detail?: string,
    hostMessage?: string,
  ) {
    super(category);
    this.toolName = category === "malformed-arguments" ? detail : undefined;
    this.refusal = category === "denied-path" ? (detail as PathRefusalReason) : undefined;
    this.hostMessage = hostMessage;
  }
}

export function governedSkillVirtualRoot(skillId: string): string {
  return `${VIRTUAL_GOVERNED_DIRECTORY}/skills/${validateVirtualSegment(skillId)}`;
}

export class FileConfinement {
  private constructor(
    public readonly workspaceRoot: string,
    /** `root` is canonical. */
    private readonly governedSkill?: { id: string; root: string },
    private readonly governedQualityRoot?: string,
    private readonly allowedWriteTargets?: ReadonlySet<string>,
    private readonly isWritePathAllowed?: (path: string) => boolean,
    readonly prepareMutation?: () => Promise<void>,
    private readonly writeScopeRefusal?: (path: string) => string,
    private readonly historicalSource = false,
  ) {}

  public static async create(options: FileConfinementOptions): Promise<FileConfinement> {
    const workspaceRoot = await canonicalDirectory(options.workspacePath, "workspace");
    const governedSkill = options.governedSkill
      ? {
          id: validateVirtualSegment(options.governedSkill.id),
          root: await canonicalDirectory(options.governedSkill.directory, "governed skill bundle"),
        }
      : undefined;
    const governedQualityRoot = options.governedQualityDirectory
      ? await canonicalDirectory(options.governedQualityDirectory, "governed quality payload")
      : undefined;
    const allowedWriteTargets = options.allowedWritePaths
      ? new Set(
          options.allowedWritePaths.map((path) => {
            validateRawPath(path);
            const target = resolve(workspaceRoot, path);
            assertInside(workspaceRoot, target, "traversal");
            return target;
          }),
        )
      : undefined;
    return new FileConfinement(
      workspaceRoot,
      governedSkill,
      governedQualityRoot,
      allowedWriteTargets,
      options.isWritePathAllowed,
      options.beforeMutation,
      options.writeScopeRefusal,
      await hasHistoricalQualityProgramSource(workspaceRoot),
    );
  }

  public get governedSkillVirtualPath(): string | undefined {
    return this.governedSkill ? governedSkillVirtualRoot(this.governedSkill.id) : undefined;
  }

  /** Exact canonical read roots admitted by this parent confinement instance. */
  public get grepReadGrants(): CredentialSafeGrepGrants {
    return {
      workspaceRoot: this.workspaceRoot,
      ...(this.governedSkill
        ? { governedSkill: { id: this.governedSkill.id, root: this.governedSkill.root } }
        : {}),
      ...(this.governedQualityRoot ? { governedQualityRoot: this.governedQualityRoot } : {}),
    };
  }

  public get governedQualityVirtualPath(): string | undefined {
    return this.governedQualityRoot ? `${VIRTUAL_GOVERNED_DIRECTORY}/quality` : undefined;
  }

  public async resolveInput(rawPath: string, mode: PathMode): Promise<string> {
    // The session advertises `VIRTUAL_WORKSPACE_CWD` as its working directory,
    // so an absolute path under it names the workspace. The remainder takes
    // every check a relative path takes; any other absolute path is denied.
    const path = confinedPathForm(rawPath);
    validateRawPath(path);
    if (mode === "write") {
      if (isVirtualGovernedPath(path)) {
        throw new ConfinedToolError("denied-path", "governed-asset");
      }
      const target = resolve(this.workspaceRoot, path);
      // The root is the directory every write lands in, never a file an
      // edit or write can replace. Refused here, in every grant, before Pi
      // touches the filesystem.
      if (target === this.workspaceRoot) {
        throw new ConfinedToolError("denied-path", "workspace-root"); // hygiene: ok -- internal category rendered at the tool boundary
      }
      return this.writeTarget(target);
    }
    return this.readTarget(resolve(this.workspaceRoot, path));
  }

  public async readTarget(operationPath: string): Promise<string> {
    const lexicalPath = resolve(operationPath);
    if (this.governedSkill && isInside(this.governedSkill.root, lexicalPath)) {
      return this.admitReadTarget(
        await canonicalExistingInside(lexicalPath, this.governedSkill.root),
      );
    }
    if (this.governedQualityRoot && isInside(this.governedQualityRoot, lexicalPath)) {
      return this.admitReadTarget(
        await canonicalExistingInside(lexicalPath, this.governedQualityRoot),
      );
    }
    this.assertWorkspaceLexicalPath(lexicalPath);

    const virtualRelative = relative(this.workspaceRoot, lexicalPath);
    const skillTarget = this.mapGovernedSkillPath(virtualRelative);
    if (skillTarget)
      return this.admitReadTarget(
        await canonicalExistingInside(skillTarget, this.governedSkill!.root),
      );
    const qualityTarget = this.mapGovernedQualityPath(virtualRelative);
    if (qualityTarget)
      return this.admitReadTarget(
        await canonicalExistingInside(qualityTarget, this.governedQualityRoot!),
      );

    return this.admitReadTarget(await canonicalExistingInside(lexicalPath, this.workspaceRoot));
  }

  private async admitReadTarget(path: string): Promise<string> {
    try {
      if (this.governedQualityRoot) {
        await assertReadableQualityResource(this.governedQualityRoot, path);
      }
      await assertReadableSourceResource(this.workspaceRoot, path, this.historicalSource);
    } catch (error) {
      if (error instanceof QualityResourceRoleError) {
        // hygiene: envelope — the tool boundary renders this code with the fixed role refusal message.
        throw new ConfinedToolError("denied-path", "governed-asset", error.message);
      }
      throw error;
    }
    return path;
  }

  public async isVisibleReadEntry(path: string): Promise<boolean> {
    try {
      await this.readTarget(path);
      return true;
    } catch (error) {
      if (error instanceof ConfinedToolError && error.category === "denied-path") return false;
      if (isMissingPath(error)) return false;
      throw error;
    }
  }

  public async readDirectory(path: string): Promise<string[]> {
    const directory = await this.readTarget(path);
    const entries = await readdir(directory);
    if (
      !this.historicalSource &&
      (!this.governedQualityRoot || !isInside(this.governedQualityRoot, directory))
    )
      return entries;
    const visible = await Promise.all(
      entries.map(async (name) =>
        (await this.isVisibleReadEntry(join(directory, name))) ? name : undefined,
      ),
    );
    return visible.filter((name): name is string => name !== undefined);
  }

  public async writeTarget(
    operationPath: string,
    allowAuthorizedAncestor = false,
  ): Promise<string> {
    const lexicalPath = resolve(operationPath);
    this.assertWorkspaceLexicalPath(lexicalPath);
    if (
      this.allowedWriteTargets &&
      !this.allowedWriteTargets.has(lexicalPath) &&
      !(
        allowAuthorizedAncestor &&
        [...this.allowedWriteTargets].some((target) => isInside(lexicalPath, target))
      )
    ) {
      throw new ConfinedToolError("denied-path", "outside-grant");
    }
    const workspaceRelative = relative(this.workspaceRoot, lexicalPath);
    if (
      this.isWritePathAllowed &&
      !allowAuthorizedAncestor &&
      !this.isWritePathAllowed(workspaceRelative.split(sep).join("/"))
    ) {
      throw new ConfinedToolError(
        "denied-path",
        "outside-grant",
        this.writeScopeRefusal?.(workspaceRelative.split(sep).join("/")),
      ); // hygiene: ok -- internal category rendered at the tool boundary
    }
    if (isVirtualGovernedPath(workspaceRelative)) {
      throw new ConfinedToolError("denied-path", "governed-asset");
    }

    let current = this.workspaceRoot;
    for (const segment of workspaceRelative.split(sep).filter(Boolean)) {
      current = join(current, segment);
      try {
        const metadata = await lstat(current);
        if (metadata.isSymbolicLink()) {
          throw new ConfinedToolError("denied-path", "link"); // hygiene: ok -- internal category rendered at the tool boundary
        }
        // A file with another hard link shares its bytes with a name the
        // workspace checks never see, which can sit outside the workspace.
        // Writing through it would change that file, so no grant admits it.
        if (metadata.isFile() && metadata.nlink > 1)
          throw new ConfinedToolError("denied-path", "link"); // hygiene: ok -- internal category rendered at the tool boundary
      } catch (error) {
        if (isMissingPath(error)) break;
        throw error;
      }
    }

    const ancestor = await nearestExistingAncestor(lexicalPath);
    const canonicalAncestor = await realpath(ancestor);
    assertInside(this.workspaceRoot, canonicalAncestor, "link");
    try {
      const canonicalTarget = await realpath(lexicalPath);
      assertInside(this.workspaceRoot, canonicalTarget, "link");
    } catch (error) {
      if (!isMissingPath(error)) throw error;
    }
    return lexicalPath;
  }

  /**
   * Defensive: tool input never reaches this refusal. `validateRawPath` denies
   * `..` and absolute forms first, a write naming the root is refused in
   * `resolveInput`, and Pi resolves the handed-on form under the root.
   */
  private assertWorkspaceLexicalPath(path: string): void {
    assertInside(this.workspaceRoot, path, "traversal");
  }

  private mapGovernedSkillPath(workspaceRelative: string): string | undefined {
    if (!this.governedSkill) return undefined;
    const prefix = join(VIRTUAL_GOVERNED_DIRECTORY, "skills", this.governedSkill.id);
    if (workspaceRelative === prefix) return this.governedSkill.root;
    if (!workspaceRelative.startsWith(`${prefix}${sep}`)) return undefined;
    return resolve(this.governedSkill.root, workspaceRelative.slice(prefix.length + 1));
  }

  private mapGovernedQualityPath(workspaceRelative: string): string | undefined {
    if (!this.governedQualityRoot) return undefined;
    const prefix = join(VIRTUAL_GOVERNED_DIRECTORY, "quality");
    if (workspaceRelative === prefix) return this.governedQualityRoot;
    if (!workspaceRelative.startsWith(`${prefix}${sep}`)) return undefined;
    return resolve(this.governedQualityRoot, workspaceRelative.slice(prefix.length + 1));
  }
}

async function canonicalDirectory(path: string, label: string): Promise<string> {
  const canonical = await realpath(resolve(path));
  if (!(await stat(canonical)).isDirectory()) {
    throw new Error(`DocsFab ${label} is not a directory.`);
  }
  return canonical;
}

async function canonicalExistingInside(path: string, root: string): Promise<string> {
  const canonical = await realpath(path);
  assertInside(root, canonical, "link");
  return canonical;
}

function assertInside(root: string, candidate: string, refusal: PathRefusalReason): void {
  if (!isInside(root, candidate)) throw new ConfinedToolError("denied-path", refusal);
}

function isInside(root: string, candidate: string): boolean {
  const difference = relative(root, candidate);
  return !(difference === ".." || difference.startsWith(`..${sep}`) || isAbsolute(difference));
}

/** Pi's Unicode-space class (`utils/paths.js` `UNICODE_SPACES`). */
const PI_UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/gu;

/**
 * The path the confinement judges: the form Pi's own file tools resolve
 * (`resolveToCwd`, through `normalizePath`: Unicode spaces become spaces and
 * one leading `@` is dropped; a `~` or `file://` form is denied by
 * `validateRawPath`), mapped from the advertised virtual cwd to
 * workspace-relative. The argument rewrite in `wrapPathInput` hands Pi a form
 * its normalization keeps as is, so the judged path is the opened path.
 */
export function confinedPathForm(rawPath: string): string {
  const piForm = rawPath.replace(PI_UNICODE_SPACES, " ").replace(/^@/u, "");
  return virtualWorkspaceRelativePath(piForm) ?? piForm;
}

/**
 * The workspace-relative form of a path under the advertised virtual cwd
 * (`/workspace` itself is `.`), or `undefined` for any other path. Lexical
 * only: the remainder is validated and confined like any relative path.
 */
function virtualWorkspaceRelativePath(rawPath: string): string | undefined {
  if (rawPath === VIRTUAL_WORKSPACE_CWD) return ".";
  const prefix = `${VIRTUAL_WORKSPACE_CWD}/`;
  return rawPath.startsWith(prefix) ? rawPath.slice(prefix.length) || "." : undefined;
}

function validateRawPath(rawPath: string): void {
  if (rawPath.includes("\0")) {
    throw new ConfinedToolError("denied-path", "nul-byte");
  }
  if (rawPath.startsWith("~")) {
    throw new ConfinedToolError("denied-path", "absolute-path");
  }
  // Pi turns a file URL into its absolute path.
  if (/^file:\/\//iu.test(rawPath)) {
    throw new ConfinedToolError("denied-path", "absolute-path"); // hygiene: ok -- internal category rendered at the tool boundary
  }
  if (isAbsolute(rawPath) || rawPath.startsWith("\\\\") || /^[A-Za-z]:[\\/]/u.test(rawPath)) {
    throw new ConfinedToolError("denied-path", "absolute-path");
  }
  if (rawPath.split(/[\\/]+/u).includes("..")) {
    throw new ConfinedToolError("denied-path", "traversal");
  }
}

export function isVirtualGovernedPath(path: string): boolean {
  const firstSegment = path.split(/[\\/]+/u)[0];
  return firstSegment === VIRTUAL_GOVERNED_DIRECTORY;
}

function validateVirtualSegment(value: string): string {
  if (!/^[A-Za-z0-9._-]+$/u.test(value)) {
    throw new Error("Governed skill id cannot be represented as a safe virtual path.");
  }
  return value;
}

export async function nearestExistingAncestor(path: string): Promise<string> {
  let candidate = path;
  while (true) {
    try {
      await lstat(candidate);
      return candidate;
    } catch (error) {
      if (!isMissingPath(error)) throw error;
      const parent = dirname(candidate);
      if (parent === candidate) throw error;
      candidate = parent;
    }
  }
}

/** One file's identity across every name it has. */
export function fileIdentity(metadata: { dev: number; ino: number }): string {
  return `${metadata.dev}:${metadata.ino}`;
}

export function isMissingPath(error: unknown): boolean {
  return (
    error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

export async function confinedGlob(
  confinement: FileConfinement,
  pattern: string,
  cwd: string,
  limit: number,
): Promise<string[]> {
  const root = await confinement.readTarget(cwd);
  const matcher = globMatcher(pattern);
  const results: string[] = [];

  async function visit(directory: string): Promise<void> {
    if (results.length >= limit) return;
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (results.length >= limit) return;
      if (entry.name === ".git" || entry.name === "node_modules") continue;
      const candidate = join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (!(await confinement.isVisibleReadEntry(candidate))) continue;
      const candidateRelative = relative(root, candidate).split(sep).join("/");
      if (matcher(candidateRelative)) results.push(candidate);
      if (entry.isDirectory()) await visit(candidate);
    }
  }

  await visit(root);
  return results;
}

function globMatcher(pattern: string): (path: string) => boolean {
  const normalized = pattern.replaceAll("\\", "/");
  if (
    !normalized ||
    normalized.startsWith("!") ||
    normalized.startsWith("~") ||
    normalized.includes("\0") ||
    normalized.startsWith("/") ||
    /^[A-Za-z]:\//u.test(normalized) ||
    normalized.split("/").includes("..") ||
    /[\[\]{}]/u.test(normalized)
  ) {
    throw new ConfinedToolError("unsupported-pattern");
  }
  const matchesBasename = !normalized.includes("/");
  let expression = "";
  for (let index = 0; index < normalized.length; index += 1) {
    const character = normalized[index]!;
    const next = normalized[index + 1];
    if (character === "*" && next === "*") {
      if (normalized[index + 2] === "/") {
        expression += "(?:.*/)?";
        index += 2;
      } else {
        expression += ".*";
        index += 1;
      }
    } else if (character === "*") {
      expression += "[^/]*";
    } else if (character === "?") {
      expression += "[^/]";
    } else {
      expression += character.replace(/[|\\{}()[\]^$+?.]/gu, "\\$&");
    }
  }
  const regex = new RegExp(`^${expression}$`, "u");
  return (path) => regex.test(matchesBasename ? basename(path) : path);
}
