// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFile, spawnSync } from "node:child_process";
import type { BigIntStats } from "node:fs";
import {
  access,
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  stat,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const delayedReadOnlyFs = vi.hoisted(() => ({
  statfs: false,
  /** `Date.now()` when the held statfs or tracked-file lstat began. */
  heldSince: 0,
  captureLstat: false,
  trackedFileLstatCalls: 0,
  trackedFileSnapshot: null as null | { path: string; metadata: BigIntStats },
  workspaceMkdir: null as null | {
    observe: (temporaryRoot: string) => void;
    release: Promise<void>;
    releaseNow: () => void;
  },
  descriptorChmodFailure: null as null | {
    pathSuffix: string;
    error: Error;
  },
  injectedFsFailure: null as null | {
    operation: "lstat" | "mkdir" | "open";
    pathSuffix: string;
    error: Error;
  },
}));

const workspaceTestTemp = vi.hoisted(() => ({ directory: null as string | null }));

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return {
    ...actual,
    tmpdir: () => workspaceTestTemp.directory ?? actual.tmpdir(),
  };
});

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    statfs: (...args: unknown[]) => {
      if (!delayedReadOnlyFs.statfs) return Reflect.apply(actual.statfs, actual, args);
      delayedReadOnlyFs.heldSince = Date.now();
      return new Promise<never>(() => {});
    },
    mkdir: async (...args: unknown[]) => {
      const path = String(args[0]);
      const injected = delayedReadOnlyFs.injectedFsFailure;
      if (
        injected?.operation === "mkdir" &&
        path.includes("docsfab-workspace-") &&
        path.endsWith(injected.pathSuffix)
      )
        throw injected.error;
      const result = await Reflect.apply(actual.mkdir, actual, args);
      const control = delayedReadOnlyFs.workspaceMkdir;
      if (control !== null && path.endsWith("/repository") && path.includes("docsfab-workspace-")) {
        control.observe(path.slice(0, -"/repository".length));
        await control.release;
      }
      return result;
    },
    lstat: (...args: unknown[]) => {
      const path = String(args[0]);
      const injected = delayedReadOnlyFs.injectedFsFailure;
      if (
        injected?.operation === "lstat" &&
        path.includes("docsfab-workspace-") &&
        path.endsWith(injected.pathSuffix)
      )
        throw injected.error;
      const snapshot = delayedReadOnlyFs.trackedFileSnapshot;
      if (snapshot !== null && path === snapshot.path) return snapshot.metadata;
      if (
        delayedReadOnlyFs.captureLstat &&
        path.includes("docsfab-workspace-") &&
        path.endsWith("/blob-0.txt")
      ) {
        delayedReadOnlyFs.trackedFileLstatCalls += 1;
        if (delayedReadOnlyFs.trackedFileLstatCalls === 2) {
          delayedReadOnlyFs.captureLstat = false;
          delayedReadOnlyFs.heldSince = Date.now();
          return new Promise<never>(() => {});
        }
      }
      return Reflect.apply(actual.lstat, actual, args);
    },
    open: async (...args: unknown[]) => {
      const path = String(args[0]);
      const injected = delayedReadOnlyFs.injectedFsFailure;
      if (
        injected?.operation === "open" &&
        path.includes("docsfab-workspace-") &&
        path.endsWith(injected.pathSuffix)
      )
        throw injected.error;
      const handle = await Reflect.apply(actual.open, actual, args);
      const snapshot = delayedReadOnlyFs.trackedFileSnapshot;
      const chmodFailure = delayedReadOnlyFs.descriptorChmodFailure;
      if (
        (snapshot === null || path !== snapshot.path) &&
        (chmodFailure === null || !path.endsWith(chmodFailure.pathSuffix))
      ) {
        return handle;
      }
      return new Proxy(handle, {
        get(target, property) {
          if (
            property === "chmod" &&
            chmodFailure !== null &&
            path.endsWith(chmodFailure.pathSuffix)
          ) {
            return async () => {
              throw chmodFailure.error;
            };
          }
          if (property === "stat" && snapshot !== null && path === snapshot.path) {
            return async () => snapshot.metadata;
          }
          const value = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    },
  };
});

import {
  formatOperatorErrorEnvelope,
  serializeOperatorErrorEnvelope,
  toOperatorErrorEnvelope,
} from "../src/operator/error-envelope.js";
import { OperationalLimitError, limit } from "../src/config/limits.js";
import { GitPatchEvidenceCollector } from "../src/repository/evidence.js";
import { buildRepositoryDiscoveryInventory } from "../src/repository/inventory.js";
import {
  RepositoryWorkspaceMaterializationError,
  type RepositoryWorkspace,
  type RepositoryWorkspacePreparationOptions,
} from "../src/repository/workspace/contracts.js";
import {
  classifyRepositoryConfigurationKey,
  repositoryConfigurationRefusalMessage,
  RepositoryConfigurationRefusalError,
  REPOSITORY_CONFIGURATION_REFUSAL_CODES,
  REPOSITORY_CONFIGURATION_SCOPES,
  worktreeConfigurationEnabled,
  type RepositoryConfigurationRefusalCodeV1,
  type RepositoryConfigurationScopeV1,
} from "../src/repository/workspace/configuration-refusal.js";
import { acquireRepositoryWorkspaceLease } from "../src/repository/workspace/lease.js";
import {
  prepareRepositoryWorkspace,
  withRepositoryWorkspace,
} from "../src/repository/workspace/materialize.js";
import {
  admitAuthorizedTrackedWrites,
  assertActiveRepositoryWorkspace,
  readTrackedRepositoryFile,
  listTrackedRepositoryEntries,
  trackedRepositoryBlobObjectId,
  verifyActiveRepositoryWorkspace,
} from "../src/repository/workspace/tracked-read.js";
import { git, hermeticGitEnv, initFixtureRepo } from "./helpers/git.js";
import { testTimeoutMs } from "./helpers/test-timeouts.js";

const execFileAsync = promisify(execFile);

beforeEach(async () => {
  const directory = await mkdtemp(join(tmpdir(), "docsfab-workspace-test-"));
  workspaceTestTemp.directory = directory;
});

afterEach(async () => {
  vi.unstubAllEnvs();
  delayedReadOnlyFs.workspaceMkdir?.releaseNow();
  delayedReadOnlyFs.workspaceMkdir = null;
  delayedReadOnlyFs.statfs = false;
  delayedReadOnlyFs.heldSince = 0;
  delayedReadOnlyFs.captureLstat = false;
  delayedReadOnlyFs.trackedFileLstatCalls = 0;
  delayedReadOnlyFs.trackedFileSnapshot = null;
  delayedReadOnlyFs.descriptorChmodFailure = null;
  delayedReadOnlyFs.injectedFsFailure = null;
  const directory = workspaceTestTemp.directory;
  workspaceTestTemp.directory = null;
  if (directory !== null) await rm(directory, { recursive: true, force: true });
});

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function scratchRoots(): Promise<Set<string>> {
  return new Set(
    (await readdir(tmpdir()))
      .filter((name) => name.startsWith("docsfab-workspace-"))
      .map((name) => join(tmpdir(), name)),
  );
}

function holdNextWorkspaceMkdir(): {
  temporaryRoot: Promise<string>;
  release: () => void;
} {
  let observe!: (temporaryRoot: string) => void;
  let releaseNow!: () => void;
  const temporaryRoot = new Promise<string>((resolveRoot) => {
    observe = resolveRoot;
  });
  const release = new Promise<void>((resolveRelease) => {
    releaseNow = resolveRelease;
  });
  delayedReadOnlyFs.workspaceMkdir = { observe, release, releaseNow };
  return {
    temporaryRoot,
    release: () => {
      releaseNow();
      delayedReadOnlyFs.workspaceMkdir = null;
    },
  };
}

async function fixtureRepository(): Promise<string> {
  const repositoryPath = await mkdtemp(join(tmpdir(), "docsfab-source-"));
  await initFixtureRepo(repositoryPath);
  await mkdir(join(repositoryPath, "docs"));
  await mkdir(join(repositoryPath, "node_modules", "package"), {
    recursive: true,
  });
  await mkdir(join(repositoryPath, "dist"));
  await writeFile(join(repositoryPath, ".gitignore"), ".env\nignored.txt\n");
  await writeFile(join(repositoryPath, "README.md"), "first revision\n");
  await writeFile(join(repositoryPath, "docs", "guide.md"), "safe\n");
  await writeFile(join(repositoryPath, ".env"), "TOKEN=tracked-secret\n");
  await writeFile(join(repositoryPath, ".env.example"), "TOKEN=\n");
  await writeFile(join(repositoryPath, ".env.production"), "TOKEN=tracked-secret\n");
  await writeFile(join(repositoryPath, "ignored.txt"), "untracked\n");
  await writeFile(join(repositoryPath, "node_modules", "package", "index.js"), "generated\n");
  await writeFile(join(repositoryPath, "dist", "bundle.js"), "generated\n");
  await symlink("/etc/passwd", join(repositoryPath, "outside-link"));
  await git(repositoryPath, ["add", ".gitignore", "README.md", "docs/guide.md"]);
  await git(repositoryPath, [
    "add",
    "--force",
    ".env",
    ".env.example",
    ".env.production",
    "node_modules/package/index.js",
    "dist/bundle.js",
    "outside-link",
  ]);
  await git(repositoryPath, ["commit", "-m", "fixture"]);
  await writeFile(join(repositoryPath, "README.md"), "second revision\n");
  await git(repositoryPath, ["add", "README.md"]);
  await git(repositoryPath, ["commit", "-m", "second"]);
  return repositoryPath;
}

type NativePath = string | Buffer;
type NativeMode = "100644" | "120000" | "160000";
interface NativeTreeItem {
  path: NativePath;
  mode: NativeMode;
  content: Buffer;
}

/** Stage exact Git index bytes, bypassing a worktree filesystem that composes names. */
async function nativeTreeFixture(items: readonly NativeTreeItem[]): Promise<string> {
  const root = workspaceTestTemp.directory!;
  const repository = join(root, "native-source");
  await initFixtureRepo(repository);
  await git(repository, ["config", "core.precomposeunicode", "false"]);
  await git(repository, ["commit", "-qm", "base", "--allow-empty"]);
  const baseCommit = await git(repository, ["rev-parse", "HEAD"]);
  for (const [index, item] of items.entries()) {
    const source = join(root, `native-blob-${index}`);
    await writeFile(source, item.content);
    const objectId =
      item.mode === "160000" ? baseCommit : await git(repository, ["hash-object", "-w", source]);
    const name = typeof item.path === "string" ? Buffer.from(item.path, "utf8") : item.path;
    const input = Buffer.concat([
      Buffer.from(`${item.mode} ${objectId}\t`, "ascii"),
      name,
      Buffer.from([0]),
    ]);
    const result = spawnSync("git", ["-C", repository, "update-index", "-z", "--index-info"], {
      env: hermeticGitEnv(),
      input,
      encoding: "buffer",
    });
    if (result.status !== 0) throw new Error("Native Git fixture index staging failed.");
  }
  await git(repository, ["commit", "-qm", "exact native tree"]);
  return repository;
}

async function volumeKeepsDistinctNames(
  left: string,
  right: string,
  directory: boolean,
): Promise<boolean> {
  const root = join(workspaceTestTemp.directory!, directory ? "directory-probe" : "leaf-probe");
  await mkdir(root);
  if (directory) await mkdir(join(root, left));
  else await writeFile(join(root, left), "left", { flag: "wx" });
  try {
    if (directory) await mkdir(join(root, right));
    else await writeFile(join(root, right), "right", { flag: "wx" });
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EEXIST") return false;
    throw error;
  }
}

function noHostLimitOverrides(): void {
  vi.stubEnv("DOCSFAB_CONFIG_ROOT", join(workspaceTestTemp.directory!, "absent-host-config"));
  vi.stubEnv("DOCSFAB_REPOSITORY_TRACKED_WRITE_ADMISSION_MAX_PATH_CHARS", undefined);
}

function longAdmissionPath(length: number): string {
  const prefix = `docs/${Array(5).fill("a".repeat(180)).join("/")}/`;
  if (length <= prefix.length || length - prefix.length > 200) {
    throw new Error("Fixture length must fit its final Git path segment.");
  }
  return prefix + "z".repeat(length - prefix.length);
}

async function expectCleanPathCollision(
  repository: string,
  canaries: readonly string[],
): Promise<void> {
  const before = await scratchRoots();
  const failure = await captureMaterializationFailure(
    prepareRepositoryWorkspace(repository, "HEAD"),
  );
  expect(failure.code).toBe("filesystem-path-collision");
  expect(failure.evidence.quantity).toBeNull();
  expect(failure.evidence.children.reaped).toBe(failure.evidence.children.started);
  expectContentFreeFailure(failure, canaries);
  expect(toOperatorErrorEnvelope(failure).nextAction).toMatch(/filesystem.*distinct.*names/u);
  expect(await scratchRoots()).toEqual(before);
}

async function blobProcessFixture(count: number): Promise<{
  repository: string;
  objectIds: string[];
  objectPaths: string[];
}> {
  const repository = await mkdtemp(join(tmpdir(), "docsfab-blob-process-"));
  await initFixtureRepo(repository);
  const paths: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const path = `blob-${index}.txt`;
    paths.push(path);
    await writeFile(join(repository, path), `unique blob ${index}\n`);
  }
  await git(repository, ["add", "--", ...paths]);
  await git(repository, ["commit", "-m", "blob process fixture"]);
  const objectIds = await Promise.all(
    paths.map((path) => git(repository, ["rev-parse", `HEAD:${path}`])),
  );
  const gitDirectory = resolve(repository, await git(repository, ["rev-parse", "--git-dir"]));
  const objectPaths = objectIds.map((objectId) =>
    join(gitDirectory, "objects", objectId.slice(0, 2), objectId.slice(2)),
  );
  return { repository, objectIds, objectPaths };
}

async function stageObjectFifos(objectPaths: readonly string[]): Promise<string[]> {
  return Promise.all(
    objectPaths.map(async (path, index) => {
      if (!(await stat(path)).isFile()) throw new Error("Expected one loose fixture object.");
      const fifo = `${path}.docsfab-fifo-${index}`;
      await execFileAsync("mkfifo", [fifo]);
      return fifo;
    }),
  );
}

async function replaceObjectsWithFifos(
  objectPaths: readonly string[],
  stagedFifos: readonly string[],
): Promise<void> {
  await Promise.all(objectPaths.map((path, index) => rename(stagedFifos[index]!, path)));
}

async function captureMaterializationFailure(
  operation: Promise<unknown>,
): Promise<RepositoryWorkspaceMaterializationError> {
  try {
    await operation;
  } catch (error) {
    if (error instanceof RepositoryWorkspaceMaterializationError) return error;
    throw error;
  }
  throw new Error("Expected repository workspace materialization to fail.");
}

function expectContentFreeFailure(
  failure: RepositoryWorkspaceMaterializationError,
  canaries: readonly string[],
): void {
  expect(Object.isFrozen(failure.evidence)).toBe(true);
  expect(Object.isFrozen(failure.evidence.children)).toBe(true);
  if (failure.evidence.quantity !== null) {
    expect(Object.isFrozen(failure.evidence.quantity)).toBe(true);
  }
  const serialized = JSON.stringify({ message: failure.message, evidence: failure.evidence });
  for (const canary of canaries) expect(serialized).not.toContain(canary);
}

function expectAggregateTimeoutOperatorSurface(
  failure: RepositoryWorkspaceMaterializationError,
  phase: "preflight" | "materialization" | "verification",
): void {
  expect(failure.code).toBe("aggregate-timeout");
  expect(failure.message).toContain(phase);
  expect(failure.message).toMatch(/limit /u);
  const envelope = toOperatorErrorEnvelope(failure);
  expect(envelope.kind).toBe("docsfab-operator-error");
  expect(envelope.code).toBe("aggregate-timeout");
  expect(envelope.message).toContain(phase);
  expect(envelope.message).toMatch(/milliseconds/u);
  expect(envelope.nextAction).toEqual(expect.any(String));
  expect(envelope.nextAction).not.toBe("Correct the reported condition, then retry the command.");
  // A no-progress window, not a wall clock (issue 1921): the NEXT names the
  // stall, the override that raises it, and why tree size alone is not a cause.
  expect(envelope.nextAction).toMatch(/no progress for the whole no-progress window/u);
  expect(envelope.nextAction).toMatch(/tree size alone does not cause this stop/u);
  expect(envelope.nextAction).toMatch(/raise DOCSFAB_REPOSITORY_WORKSPACE_EXPORT_STALL_MS/u);
  expect(envelope.nextAction).not.toMatch(/fewer tracked files|cannot raise|only tighten/u);
  expect(envelope.docsAnchor).toBe("docs/troubleshooting.md");
  expect(envelope.details).toMatchObject({
    kind: "docsfab-repository-workspace-materialization-failure",
    code: "aggregate-timeout",
    phase,
    quantity: { unit: "milliseconds" },
  });
  const human = formatOperatorErrorEnvelope(envelope);
  expect(human).toContain(phase);
  expect(human).toContain("Next action:");
  expect(human).not.toContain("Correct the reported condition, then retry the command.");
  const json = JSON.parse(serializeOperatorErrorEnvelope(envelope)) as {
    kind: string;
    code: string;
    details?: { phase?: string; quantity?: { unit: string; limit: string; observed: string } };
  };
  expect(json.kind).toBe("docsfab-operator-error");
  expect(json.code).toBe("aggregate-timeout");
  expect(json.details?.phase).toBe(phase);
  expect(json.details?.quantity?.unit).toBe("milliseconds");
  expect(json.details?.quantity?.limit).toEqual(expect.any(String));
  expect(json.details?.quantity?.observed).toEqual(expect.any(String));
}

describe("aggregate-timeout operator envelope", () => {
  it.each(["preflight", "materialization", "verification"] as const)(
    "formats %s aggregate-timeout with phase, limit, and a specific NEXT",
    (phase) => {
      const failure = new RepositoryWorkspaceMaterializationError({
        schemaVersion: 1,
        kind: "docsfab-repository-workspace-materialization-failure",
        code: "aggregate-timeout",
        phase,
        quantity: { unit: "milliseconds", limit: "120000", observed: "120001" },
        children: { started: 0, cancellationRequested: 0, reaped: 0 },
      });
      expectAggregateTimeoutOperatorSurface(failure, phase);
      const envelope = toOperatorErrorEnvelope(failure);
      if (phase === "preflight") {
        expect(envelope.nextAction).toMatch(/before any file export/u);
      } else if (phase === "materialization") {
        expect(envelope.nextAction).toMatch(/while exporting tracked files/u);
        expect(envelope.nextAction).toMatch(/no directory, file write, or closing fsync finished/u);
      } else {
        expect(envelope.nextAction).toMatch(/while verifying the exported workspace/u);
      }
      expect(envelope.message).toContain("observed 120001 milliseconds");
      expect(envelope.message).toContain("limit 120000 milliseconds");
    },
  );

  it("formats per-blob-timeout as the same no-progress bound with its own NEXT", () => {
    const failure = new RepositoryWorkspaceMaterializationError({
      schemaVersion: 1,
      kind: "docsfab-repository-workspace-materialization-failure",
      code: "per-blob-timeout",
      phase: "materialization",
      quantity: { unit: "milliseconds", limit: "120000", observed: "120001" },
      children: { started: 1, cancellationRequested: 1, reaped: 1 },
    });
    const envelope = toOperatorErrorEnvelope(failure);
    expect(envelope.code).toBe("per-blob-timeout");
    expect(envelope.nextAction).toMatch(
      /no bytes arrived from git or were written to the workspace/u,
    );
    expect(envelope.nextAction).toMatch(/raise DOCSFAB_REPOSITORY_WORKSPACE_EXPORT_STALL_MS/u);
    expect(envelope.nextAction).not.toMatch(/only tighten/u);
    expect(envelope.docsAnchor).toBe("docs/troubleshooting.md");
    expect(formatOperatorErrorEnvelope(envelope)).toContain("failure class: bound");
  });
});

describe("repository workspace", () => {
  it("materializes an exact decomposed native Git path and reads its original bytes", async () => {
    const repositoryPath = join(workspaceTestTemp.directory!, "nfd-source");
    const sourceBlob = join(workspaceTestTemp.directory!, "nfd-blob");
    const path = "docs/cafe\u0301 guide.md";
    const original = Buffer.from("\ufeff# Cafe\u0301\r\n\r\nExact bytes.\r\n", "utf8");
    await initFixtureRepo(repositoryPath);
    await git(repositoryPath, ["config", "core.precomposeunicode", "false"]);
    await writeFile(sourceBlob, original);
    const objectId = await git(repositoryPath, ["hash-object", "-w", sourceBlob]);
    await git(repositoryPath, [
      "update-index",
      "--add",
      "--cacheinfo",
      `100644,${objectId},${path}`,
    ]);
    await git(repositoryPath, ["commit", "-qm", "native NFD fixture"]);
    expect(
      await git(repositoryPath, ["ls-tree", "-rz", "--name-only", "HEAD"], { trim: false }),
    ).toBe(`${path}\0`);

    const workspace = await prepareRepositoryWorkspace(repositoryPath, "HEAD");
    try {
      expect(await listTrackedRepositoryEntries(workspace)).toEqual([
        { path, kind: "regular", byteLength: original.byteLength },
      ]);
      expect(await readTrackedRepositoryFile(workspace, path, original.byteLength)).toEqual(
        original,
      );
      expect(await trackedRepositoryBlobObjectId(workspace, path)).toBe(objectId);
    } finally {
      await workspace.dispose();
    }
  });
  it("accepts a literal U+FFFD Git name while refusing malformed native UTF-8 bytes", async () => {
    const validPath = "docs/replacement-\ufffd.md";
    const validBytes = Buffer.from("# Literal replacement character\n", "utf8");
    const valid = await nativeTreeFixture([
      { path: validPath, mode: "100644", content: validBytes },
    ]);
    const workspace = await prepareRepositoryWorkspace(valid, "HEAD");
    try {
      expect(await readTrackedRepositoryFile(workspace, validPath, validBytes.length)).toEqual(
        validBytes,
      );
    } finally {
      await workspace.dispose();
    }
    await rm(valid, { recursive: true, force: true });

    const invalidPath = Buffer.concat([
      Buffer.from("docs/invalid-"),
      Buffer.from([0xff]),
      Buffer.from(".md"),
    ]);
    const invalid = await nativeTreeFixture([
      { path: invalidPath, mode: "100644", content: Buffer.from("# Invalid native name\n") },
    ]);
    const raw = spawnSync("git", ["-C", invalid, "ls-tree", "-rz", "--name-only", "HEAD"], {
      env: hermeticGitEnv(),
      encoding: "buffer",
    });
    expect(raw.status).toBe(0);
    expect(raw.stdout).toEqual(Buffer.concat([invalidPath, Buffer.from([0])]));
    const before = await scratchRoots();
    const failure = await captureMaterializationFailure(
      prepareRepositoryWorkspace(invalid, "HEAD"),
    );
    expect(failure.code).toBe("materialization-failed");
    expect(failure.evidence.phase).toBe("preflight");
    expect(await scratchRoots()).toEqual(before);
  });

  it("preserves two distinct regular Git names or refuses their actual leaf alias without publication", async () => {
    const nfd = "docs/cafe\u0301 guide.md";
    const nfc = "docs/caf\u00e9 guide.md";
    const nfdBytes = Buffer.from("NFD original\n");
    const nfcBytes = Buffer.from("NFC original\n");
    const repository = await nativeTreeFixture([
      { path: nfd, mode: "100644", content: nfdBytes },
      { path: nfc, mode: "100644", content: nfcBytes },
    ]);
    const distinct = await volumeKeepsDistinctNames(nfd.slice(5), nfc.slice(5), false);
    if (process.platform === "linux") expect(distinct).toBe(true);
    if (!distinct) {
      await expectCleanPathCollision(repository, [nfd, nfc, "NFD original", "NFC original"]);
      return;
    }
    const workspace = await prepareRepositoryWorkspace(repository, "HEAD");
    try {
      expect(await readTrackedRepositoryFile(workspace, nfd, nfdBytes.length)).toEqual(nfdBytes);
      expect(await readTrackedRepositoryFile(workspace, nfc, nfcBytes.length)).toEqual(nfcBytes);
      expect(await trackedRepositoryBlobObjectId(workspace, nfd)).toBe(
        await git(repository, ["rev-parse", `HEAD:${nfd}`]),
      );
      expect(await trackedRepositoryBlobObjectId(workspace, nfc)).toBe(
        await git(repository, ["rev-parse", `HEAD:${nfc}`]),
      );
    } finally {
      await workspace.dispose();
    }
  });

  it("preserves two distinct parent directories or refuses an actual directory alias", async () => {
    const nfd = "docs/cafe\u0301/first.md";
    const nfc = "docs/caf\u00e9/second.md";
    const repository = await nativeTreeFixture([
      { path: nfd, mode: "100644", content: Buffer.from("first parent\n") },
      { path: nfc, mode: "100644", content: Buffer.from("second parent\n") },
    ]);
    const distinct = await volumeKeepsDistinctNames("cafe\u0301", "caf\u00e9", true);
    if (process.platform === "linux") expect(distinct).toBe(true);
    if (!distinct) {
      await expectCleanPathCollision(repository, [nfd, nfc, "first parent", "second parent"]);
      return;
    }
    const workspace = await prepareRepositoryWorkspace(repository, "HEAD");
    try {
      expect(await readTrackedRepositoryFile(workspace, nfd, 13)).toEqual(
        Buffer.from("first parent\n"),
      );
      expect(await readTrackedRepositoryFile(workspace, nfc, 14)).toEqual(
        Buffer.from("second parent\n"),
      );
    } finally {
      await workspace.dispose();
    }
  });

  it.each([
    ["symlink", "docs/cafe\u0301.md", "docs/caf\u00e9.md", "120000"],
    ["submodule", "docs/cafe\u0301.md", "docs/caf\u00e9.md", "160000"],
    ["excluded", "docs/.env.example", "docs/.env.Example", "100644"],
  ] as const)(
    "does not register an omitted %s endpoint that aliases an exported file",
    async (_kind, regular, omitted, mode) => {
      const repository = await nativeTreeFixture([
        { path: regular, mode: "100644", content: Buffer.from("ordinary fixture\n") },
        { path: omitted, mode, content: Buffer.from("OMITTED_CONTENT_SENTINEL") },
      ]);
      const distinct = await volumeKeepsDistinctNames(regular.slice(5), omitted.slice(5), false);
      if (!distinct) {
        await expectCleanPathCollision(repository, [regular, omitted, "OMITTED_CONTENT_SENTINEL"]);
        return;
      }
      const workspace = await prepareRepositoryWorkspace(repository, "HEAD");
      try {
        expect(await readTrackedRepositoryFile(workspace, regular, 17)).toEqual(
          Buffer.from("ordinary fixture\n"),
        );
        await expect(readTrackedRepositoryFile(workspace, omitted, 100)).rejects.toMatchObject({
          code: "unsafe-kind",
        });
      } finally {
        await workspace.dispose();
      }
    },
  );

  it("checks an omitted endpoint against an implicit directory and an obstructing regular parent", async () => {
    const omittedDirectory = "docs/caf\u00e9";
    const directoryRepository = await nativeTreeFixture([
      { path: "docs/cafe\u0301/child.md", mode: "100644", content: Buffer.from("child\n") },
      { path: omittedDirectory, mode: "120000", content: Buffer.from("../outside") },
    ]);
    const distinctDirectory = await volumeKeepsDistinctNames("cafe\u0301", "caf\u00e9", true);
    if (!distinctDirectory) {
      await expectCleanPathCollision(directoryRepository, [omittedDirectory, "../outside"]);
    } else {
      const workspace = await prepareRepositoryWorkspace(directoryRepository, "HEAD");
      try {
        expect(await readTrackedRepositoryFile(workspace, "docs/cafe\u0301/child.md", 6)).toEqual(
          Buffer.from("child\n"),
        );
      } finally {
        await workspace.dispose();
      }
    }
    await rm(directoryRepository, { recursive: true, force: true });
    const parentRepository = await nativeTreeFixture([
      { path: "docs/cafe\u0301", mode: "100644", content: Buffer.from("file parent\n") },
      { path: "docs/caf\u00e9/omitted", mode: "120000", content: Buffer.from("../outside") },
    ]);
    const distinctLeaf = await volumeKeepsDistinctNames("cafe\u0301", "caf\u00e9", false);
    if (!distinctLeaf) {
      await expectCleanPathCollision(parentRepository, ["docs/caf\u00e9/omitted", "../outside"]);
    } else {
      const workspace = await prepareRepositoryWorkspace(parentRepository, "HEAD");
      await workspace.dispose();
    }
  });

  it.each([
    { operation: "mkdir" as const, pathSuffix: "/docs", code: "EIO" },
    { operation: "open" as const, pathSuffix: "/README.md", code: "EACCES" },
    { operation: "lstat" as const, pathSuffix: "/omitted-link", code: "EIO" },
  ])(
    "does not misclassify $operation $code as a filesystem collision",
    async ({ operation, pathSuffix, code }) => {
      const repository = await nativeTreeFixture([
        { path: "README.md", mode: "100644", content: Buffer.from("regular\n") },
        { path: "docs/guide.md", mode: "100644", content: Buffer.from("guide\n") },
        { path: "omitted-link", mode: "120000", content: Buffer.from("target") },
      ]);
      delayedReadOnlyFs.injectedFsFailure = {
        operation,
        pathSuffix,
        error: Object.assign(new Error("injected filesystem failure"), { code }),
      };
      const before = await scratchRoots();
      const failure = await captureMaterializationFailure(
        prepareRepositoryWorkspace(repository, "HEAD"),
      );
      expect(failure.code).toBe("materialization-failed");
      expect(failure.evidence.children.reaped).toBe(failure.evidence.children.started);
      expect(await scratchRoots()).toEqual(before);
      delayedReadOnlyFs.injectedFsFailure = null;
    },
  );

  it("keeps an NFC alias caller untracked and refuses malformed authorized recapture paths", async () => {
    noHostLimitOverrides();
    const nfd = "docs/cafe\u0301 guide.md";
    const nfc = "docs/caf\u00e9 guide.md";
    const repository = await nativeTreeFixture([
      { path: nfd, mode: "100644", content: Buffer.from("same host alias\n") },
    ]);
    const workspace = await prepareRepositoryWorkspace(repository, "HEAD");
    try {
      await expect(readTrackedRepositoryFile(workspace, nfc, 100)).rejects.toMatchObject({
        code: "not-tracked",
      });
      expect(await admitAuthorizedTrackedWrites(workspace, ["docs/\ud800.md"])).toEqual([]);
      expect(
        await admitAuthorizedTrackedWrites(workspace, [
          "../outside.md",
          "docs\\outside.md",
          "/outside.md",
        ]),
      ).toEqual([]);
      expect(await listTrackedRepositoryEntries(workspace)).toEqual([
        { path: nfd, kind: "regular", byteLength: Buffer.byteLength("same host alias\n") },
      ]);
    } finally {
      await workspace.dispose();
    }
  });

  it("enforces the catalogued recapture path default at its UTF-16 boundary and reports the exact crossing", async () => {
    noHostLimitOverrides();
    const bound = limit("repository.trackedWriteAdmissionMaxPathChars");
    expect(bound.value).toBe(1024);
    expect(bound.unit).toBe("UTF-16 code units");
    const repository = await fixtureRepository();
    const workspace = await prepareRepositoryWorkspace(repository, "HEAD");
    try {
      const over = longAdmissionPath(bound.value + 1);
      await expect(admitAuthorizedTrackedWrites(workspace, [over])).rejects.toMatchObject({
        code: bound.refusal,
        limitName: bound.name,
        configured: bound.value,
        observed: bound.value + 1,
        unit: bound.unit,
      });
      const at = longAdmissionPath(bound.value);
      let usableOnThisVolume = true;
      try {
        await mkdir(dirname(join(workspace.path, at)), { recursive: true });
        await writeFile(join(workspace.path, at), "at catalogued boundary\n");
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENAMETOOLONG")) {
          throw error;
        }
        usableOnThisVolume = false;
      }
      // The Linux CI volume is the native oracle for the published 1024-unit default.
      if (process.platform === "linux") expect(usableOnThisVolume).toBe(true);
      if (usableOnThisVolume) {
        expect(await admitAuthorizedTrackedWrites(workspace, [at])).toEqual([at]);
        expect(await readTrackedRepositoryFile(workspace, at, 100)).toEqual(
          Buffer.from("at catalogued boundary\n"),
        );
      } else {
        // Darwin volumes may refuse a 1024-unit absolute path independently.
        vi.stubEnv("DOCSFAB_REPOSITORY_TRACKED_WRITE_ADMISSION_MAX_PATH_CHARS", "20");
        const supported = `docs/${"a".repeat(15)}`;
        await writeFile(join(workspace.path, supported), "at override boundary\n");
        expect(await admitAuthorizedTrackedWrites(workspace, [supported])).toEqual([supported]);
        expect(await readTrackedRepositoryFile(workspace, supported, 100)).toEqual(
          Buffer.from("at override boundary\n"),
        );
      }
    } finally {
      await workspace.dispose();
    }
  });

  it("prechecks every eligible candidate before recapture and propagates the named refusal through inventory", async () => {
    noHostLimitOverrides();
    vi.stubEnv("DOCSFAB_REPOSITORY_TRACKED_WRITE_ADMISSION_MAX_PATH_CHARS", "20");
    const repository = await fixtureRepository();
    const workspace = await prepareRepositoryWorkspace(repository, "HEAD");
    try {
      const changed = Buffer.from("new revision!!!\n");
      await writeFile(join(workspace.path, "README.md"), changed);
      const over = "z".repeat(21);
      await expect(readTrackedRepositoryFile(workspace, "README.md", 100)).rejects.toMatchObject({
        code: "changed",
      });
      let refusal: unknown;
      try {
        await admitAuthorizedTrackedWrites(workspace, ["README.md", over]);
      } catch (error) {
        refusal = error;
      }
      expect(refusal).toBeInstanceOf(OperationalLimitError);
      expect(refusal).toMatchObject({
        code: "repository-tracked-write-admission-max-path-chars-bound",
        limitName: "repository.trackedWriteAdmissionMaxPathChars",
        configured: 20,
        observed: 21,
        unit: "UTF-16 code units",
      });
      await expect(readTrackedRepositoryFile(workspace, "README.md", 100)).rejects.toMatchObject({
        code: "changed",
      });
      await expect(
        buildRepositoryDiscoveryInventory({ workspace, authorizedWritePaths: ["README.md", over] }),
      ).rejects.toMatchObject({ configured: 20, observed: 21 });
      const envelope = toOperatorErrorEnvelope(refusal);
      expect(envelope.code).toBe("repository-tracked-write-admission-max-path-chars-bound");
      expect(envelope.message).toMatch(/21 exceeds.*20 UTF-16 code units/u);
      expect(envelope.message).toMatch(
        /DOCSFAB_REPOSITORY_TRACKED_WRITE_ADMISSION_MAX_PATH_CHARS/u,
      );
      expect(await admitAuthorizedTrackedWrites(workspace, ["README.md"])).toEqual(["README.md"]);
      expect(await readTrackedRepositoryFile(workspace, "README.md", 100)).toEqual(changed);
    } finally {
      await workspace.dispose();
    }
  });

  it("counts astral paths as UTF-16 units, honors valid overrides, and validates invalid overrides", async () => {
    noHostLimitOverrides();
    const repository = await fixtureRepository();
    const workspace = await prepareRepositoryWorkspace(repository, "HEAD");
    try {
      const path = "docs/😀.md";
      const length = path.length;
      expect(length).toBeGreaterThan([...path].length);
      vi.stubEnv("DOCSFAB_REPOSITORY_TRACKED_WRITE_ADMISSION_MAX_PATH_CHARS", String(length - 1));
      await expect(admitAuthorizedTrackedWrites(workspace, [path])).rejects.toMatchObject({
        configured: length - 1,
        observed: length,
      });
      vi.stubEnv("DOCSFAB_REPOSITORY_TRACKED_WRITE_ADMISSION_MAX_PATH_CHARS", String(length));
      await writeFile(join(workspace.path, path), "astral path\n");
      expect(await admitAuthorizedTrackedWrites(workspace, [path])).toEqual([path]);
      expect(await readTrackedRepositoryFile(workspace, path, 100)).toEqual(
        Buffer.from("astral path\n"),
      );
      // Existing non-regular or excluded entries cannot mutate and do not consume
      // this recapture-only path budget.
      vi.stubEnv("DOCSFAB_REPOSITORY_TRACKED_WRITE_ADMISSION_MAX_PATH_CHARS", "1");
      expect(
        await admitAuthorizedTrackedWrites(workspace, [
          "outside-link",
          ".env",
          "node_modules/package/index.js",
        ]),
      ).toEqual([]);
      for (const invalid of ["0", "-1", "1.5", "9007199254740992", "not-a-number"]) {
        vi.stubEnv("DOCSFAB_REPOSITORY_TRACKED_WRITE_ADMISSION_MAX_PATH_CHARS", invalid);
        expect(() => limit("repository.trackedWriteAdmissionMaxPathChars")).toThrow();
      }
    } finally {
      await workspace.dispose();
    }
  });

  it.each(["uploadpack", "receivepack"])(
    "rejects executable remote.%s configuration without running it",
    async (setting) => {
      const repositoryPath = await fixtureRepository();
      const marker = join(repositoryPath, `remote-${setting}-executed`);
      const command = join(repositoryPath, `remote-${setting}`);
      await writeFile(command, `#!/bin/sh\nprintf executed > ${JSON.stringify(marker)}\n`);
      await chmod(command, 0o700);
      await git(repositoryPath, ["config", `remote.origin.${setting}`, command]);
      try {
        await expect(prepareRepositoryWorkspace(repositoryPath, "HEAD")).rejects.toThrow(
          RepositoryConfigurationRefusalError,
        );
        // The sentence an operator reads, written out here rather than read
        // from the table it is pinning.
        await expect(prepareRepositoryWorkspace(repositoryPath, "HEAD")).rejects.toThrow(
          "sets a remote uploadpack or receivepack program",
        );
        expect(await exists(marker)).toBe(false);
      } finally {
        await rm(repositoryPath, { recursive: true, force: true });
      }
    },
  );

  /**
   * The coded refusal for a checkout that configures its own programs.
   *
   * Every case drives `prepareRepositoryWorkspace` against a real temporary
   * checkout configured with `git config`, so what is proved is the key
   * `git config --list` actually emits. Expected substrings are written out
   * here, never read from the shipped tables, so an empty shipped sentence
   * cannot pass.
   */
  describe("executable or included repository configuration", () => {
    const configurationCases: readonly [
      label: string,
      settings: readonly (readonly [key: string, value: string])[],
      code: RepositoryConfigurationRefusalCodeV1,
      named: string,
      clearCommand: string,
    ][] = [
      [
        "core.hooksPath",
        [["core.hooksPath", "zq41-operator-chosen"]],
        "hooks-path",
        "sets core.hooksPath",
        "git config --local --unset core.hooksPath",
      ],
      [
        "core.fsmonitor",
        [["core.fsmonitor", "zq42-operator-chosen"]],
        "filesystem-monitor",
        "sets core.fsmonitor",
        "git config --local --unset core.fsmonitor",
      ],
      [
        "core.attributesFile",
        [["core.attributesFile", "zq43-operator-chosen"]],
        "attributes-file",
        "sets core.attributesFile",
        "git config --local --unset core.attributesFile",
      ],
      [
        "core.excludesFile",
        [["core.excludesFile", "zq44-operator-chosen"]],
        "excludes-file",
        "sets core.excludesFile",
        "git config --local --unset core.excludesFile",
      ],
      [
        "the filter driver git-lfs installs",
        [
          ["filter.lfs.clean", "git-lfs clean -- %f"],
          ["filter.lfs.smudge", "git-lfs smudge -- %f"],
          ["filter.lfs.process", "git-lfs filter-process"],
          ["filter.lfs.required", "true"],
        ],
        "content-filter",
        "sets a content filter driver",
        "git config --local --remove-section filter.<name>",
      ],
      [
        "a filter subsection whose name git keeps cased",
        [["filter.LFS.process", "git-lfs filter-process"]],
        "content-filter",
        "sets a content filter driver",
        "git config --local --remove-section filter.<name>",
      ],
      [
        "diff.external",
        [["diff.external", "zq45-operator-chosen"]],
        "diff-external-driver",
        "sets diff.external",
        "git config --local --unset diff.external",
      ],
      [
        "a textconv diff driver",
        [["diff.docs.textconv", "zq46-operator-chosen"]],
        "diff-named-driver",
        "sets a named diff driver",
        "git config --local --remove-section diff.<name>",
      ],
      [
        "tar.<format>.command",
        [["tar.tgz.command", "zq47-operator-chosen"]],
        "archive-command",
        "sets a tar archive command",
        "git config --local --unset tar.<format>.command",
      ],
      [
        "include.path",
        [["include.path", "extra.config"]],
        "included-configuration",
        "includes another configuration file",
        "git config --local --remove-section include",
      ],
      [
        "includeIf.<condition>.path",
        [["includeIf.gitdir:/tmp/.path", "extra.config"]],
        "included-configuration",
        "includes another configuration file",
        "git config --local --remove-section include",
      ],
    ];

    it.each(configurationCases)(
      "refuses %s with a coded sentence naming the key and one scoped command",
      async (_label, settings, code, named, clearCommand) => {
        const repositoryPath = await fixtureRepository();
        for (const [key, value] of settings) {
          await git(repositoryPath, ["config", key, value]);
        }
        try {
          const caught = await prepareRepositoryWorkspace(repositoryPath, "HEAD").then(
            () => null,
            (error: unknown) => error,
          );
          expect(caught).toBeInstanceOf(RepositoryConfigurationRefusalError);
          const refusal = caught as RepositoryConfigurationRefusalError;
          expect(refusal.code).toBe(code);
          expect(refusal.scope).toBe("local");
          expect(refusal.name).toBe("RepositoryConfigurationRefusalError");
          expect(refusal.message).toContain(named);
          expect(refusal.message).toContain(clearCommand);
          // The operator's own paths and configured values stay out of it.
          expect(refusal.message).not.toContain(repositoryPath);
          for (const [, value] of settings) {
            if (value === "true") continue;
            expect(refusal.message).not.toContain(value);
          }
        } finally {
          await rm(repositoryPath, { recursive: true, force: true });
        }
      },
    );

    /**
     * The command the operator is handed clears the key in the scope it was
     * read from: `git config --unset` with no scope flag writes `--local` and
     * exits 5 against a worktree-scoped key. The command is taken from the
     * rendered sentence, run against the fixture, and materialization is
     * retried to prove the checkout is readable afterwards.
     */
    it.each([
      ["local", "core.hooksPath", "hooks-path"],
      ["worktree", "core.hooksPath", "hooks-path"],
      ["local", "core.fsmonitor", "filesystem-monitor"],
      ["worktree", "core.fsmonitor", "filesystem-monitor"],
      ["local", "diff.external", "diff-external-driver"],
      ["worktree", "diff.external", "diff-external-driver"],
    ] as const)(
      "clears a %s-scope %s with the exact command its refusal printed",
      async (scope, key, code) => {
        const repositoryPath = await fixtureRepository();
        try {
          if (scope === "worktree") {
            await git(repositoryPath, ["config", "extensions.worktreeConfig", "true"]);
            await git(repositoryPath, ["config", "--worktree", key, "zq60-operator-chosen"]);
          } else {
            await git(repositoryPath, ["config", "--local", key, "zq60-operator-chosen"]);
          }

          const refusal = (await prepareRepositoryWorkspace(repositoryPath, "HEAD").then(
            () => null,
            (error: unknown) => error,
          )) as RepositoryConfigurationRefusalError;
          expect(refusal).toBeInstanceOf(RepositoryConfigurationRefusalError);
          expect(refusal.code).toBe(code);
          expect(refusal.scope).toBe(scope);

          const printed = /clear it where it is with (git config --[a-z]+ --unset [^,]+),/u.exec(
            refusal.message,
          );
          expect(printed, refusal.message).not.toBeNull();
          const command = printed![1]!.split(" ");
          expect(command[2]).toBe(scope === "worktree" ? "--worktree" : "--local");

          // Run exactly what the operator was told to run.
          await git(repositoryPath, command.slice(1));
          expect(await git(repositoryPath, ["config", "--get", key]).catch(() => "")).toBe("");

          const workspace = await prepareRepositoryWorkspace(repositoryPath, "HEAD");
          expect(workspace.requestedRevision).toBe("HEAD");
          await workspace.dispose();
        } finally {
          await rm(repositoryPath, { recursive: true, force: true });
        }
      },
    );

    /**
     * The second fatal mode.
     *
     * With `extensions.worktreeConfig` enabled but no `config.worktree` written
     * yet, `git config --worktree --list` exits 128 with "unable to read config
     * file ... No such file or directory", at any worktree count.
     * `git rev-parse --git-path config.worktree` answers with a path whether or
     * not the file is there, so the gate stats it: a missing file is nothing to
     * screen, never a refusal and never a failed read.
     */
    it.each(["single", "multi"] as const)(
      "materializes a %s-worktree repository that enables the extension with no config.worktree",
      async (shape) => {
        const repositoryPath = await fixtureRepository();
        const linkedPath = `${repositoryPath}-no-file`;
        try {
          await git(repositoryPath, ["config", "extensions.worktreeConfig", "true"]);
          if (shape === "multi") {
            await git(repositoryPath, ["worktree", "add", "--quiet", linkedPath, "-b", "nofile"]);
          }
          // Preconditions, asserted rather than assumed.
          expect(await git(repositoryPath, ["rev-parse", "--git-path", "config.worktree"])).toBe(
            ".git/config.worktree",
          );
          expect(await exists(join(repositoryPath, ".git", "config.worktree"))).toBe(false);
          await expect(
            git(repositoryPath, ["config", "--worktree", "--list"]),
          ).rejects.toBeDefined();

          const workspace = await prepareRepositoryWorkspace(repositoryPath, "HEAD");
          expect(workspace.requestedRevision).toBe("HEAD");
          await workspace.dispose();
        } finally {
          if (shape === "multi") await rm(linkedPath, { recursive: true, force: true });
          await rm(repositoryPath, { recursive: true, force: true });
        }
      },
    );

    /**
     * `git config --worktree` exits 128 on any repository with more than one
     * registered working tree while `extensions.worktreeConfig` is unset, from
     * the main checkout as well as from the linked one. The worktree read is
     * guarded so that does not become "Git workspace preparation failed".
     */
    it.each(["main", "linked"] as const)(
      "materializes from the %s checkout of a multi-worktree repository with no worktree extension",
      async (from) => {
        const repositoryPath = await fixtureRepository();
        const linkedPath = `${repositoryPath}-linked`;
        try {
          // `--detach` on purpose: this is the exact command the hosted
          // dispatcher runs for every workflow
          // (`packages/host/src/service/dispatcher/source.ts`, pinned by
          // "checks out every hosted run into a second working tree with no
          // worktree config scope" in packages/host/test/service-dispatcher.test.ts),
          // so this case is that composition and not a lookalike.
          await git(repositoryPath, ["worktree", "add", "--quiet", "--detach", linkedPath, "HEAD"]);
          // The precondition, asserted rather than assumed: this is the shape
          // whose worktree-scope read fails.
          await expect(
            git(repositoryPath, ["config", "--worktree", "--list"]),
          ).rejects.toBeDefined();
          expect(
            await git(repositoryPath, ["config", "--local", "--get", "extensions.worktreeConfig"])
              .then(() => "set")
              .catch(() => "absent"),
          ).toBe("absent");

          const workspace = await prepareRepositoryWorkspace(
            from === "main" ? repositoryPath : linkedPath,
            "HEAD",
          );
          expect(workspace.requestedRevision).toBe("HEAD");
          await workspace.dispose();
        } finally {
          await rm(linkedPath, { recursive: true, force: true });
          await rm(repositoryPath, { recursive: true, force: true });
        }
      },
    );

    it("materializes a multi-worktree repository whose only registered second worktree is stale", async () => {
      const repositoryPath = await fixtureRepository();
      const linkedPath = `${repositoryPath}-stale`;
      try {
        await git(repositoryPath, ["worktree", "add", "--quiet", linkedPath, "-b", "stale"]);
        await rm(linkedPath, { recursive: true, force: true });
        expect(await git(repositoryPath, ["worktree", "list", "--porcelain"])).toContain(
          "prunable",
        );
        await expect(git(repositoryPath, ["config", "--worktree", "--list"])).rejects.toBeDefined();

        const workspace = await prepareRepositoryWorkspace(repositoryPath, "HEAD");
        expect(workspace.requestedRevision).toBe("HEAD");
        await workspace.dispose();
      } finally {
        await rm(repositoryPath, { recursive: true, force: true });
      }
    });

    /**
     * A linked worktree of a repository that enables `extensions.worktreeConfig`,
     * whose `config.worktree` carries only benign keys, as a Conductor workspace does.
     */
    it("materializes a linked worktree that enables the extension and carries no refusable key", async () => {
      const repositoryPath = await fixtureRepository();
      const linkedPath = `${repositoryPath}-owner-shape`;
      try {
        await git(repositoryPath, ["config", "extensions.worktreeConfig", "true"]);
        await git(repositoryPath, ["worktree", "add", "--quiet", linkedPath, "-b", "owner"]);
        await git(linkedPath, ["config", "--worktree", "push.autoSetupRemote", "true"]);
        expect(await git(linkedPath, ["config", "--worktree", "--list", "--name-only"])).toContain(
          "push.autosetupremote",
        );

        const workspace = await prepareRepositoryWorkspace(linkedPath, "HEAD");
        expect(workspace.requestedRevision).toBe("HEAD");
        await workspace.dispose();
      } finally {
        await rm(linkedPath, { recursive: true, force: true });
        await rm(repositoryPath, { recursive: true, force: true });
      }
    });

    it("refuses a key that only worktree scope carries in a linked worktree", async () => {
      const repositoryPath = await fixtureRepository();
      const linkedPath = `${repositoryPath}-worktree-key`;
      try {
        await git(repositoryPath, ["config", "extensions.worktreeConfig", "true"]);
        await git(repositoryPath, ["worktree", "add", "--quiet", linkedPath, "-b", "scoped"]);
        await git(linkedPath, ["config", "--worktree", "core.hooksPath", "zq48-worktree-scope"]);
        // In effect for the checkout, and absent from the local scope.
        expect(
          (await git(linkedPath, ["config", "--local", "--no-includes", "--list", "--name-only"]))
            .split("\n")
            .includes("core.hookspath"),
        ).toBe(false);
        expect(await git(linkedPath, ["config", "--get", "core.hooksPath"])).toBe(
          "zq48-worktree-scope",
        );

        const caught = await prepareRepositoryWorkspace(linkedPath, "HEAD").then(
          () => null,
          (error: unknown) => error,
        );
        expect(caught).toBeInstanceOf(RepositoryConfigurationRefusalError);
        expect((caught as RepositoryConfigurationRefusalError).code).toBe("hooks-path");
        expect((caught as RepositoryConfigurationRefusalError).scope).toBe("worktree");
        expect((caught as RepositoryConfigurationRefusalError).message).toContain(
          "git config --worktree --unset core.hooksPath",
        );

        // The main checkout does not share that file and is still readable.
        const workspace = await prepareRepositoryWorkspace(repositoryPath, "HEAD");
        await workspace.dispose();
      } finally {
        await rm(linkedPath, { recursive: true, force: true });
        await rm(repositoryPath, { recursive: true, force: true });
      }
    });

    /**
     * The one shape that reaches the guarded read. A dangling symlink at
     * `config.worktree` is visible to `lstat`, so the extension gate and the
     * existence probe both pass and the `--local` read still answers; only the
     * second, `--worktree` read fatals. Every other failure of that read is the
     * extension being off or the file being absent, and both return early, so
     * nothing else in this file reaches `worktree-configuration-unreadable`.
     *
     * The coded refusal keeps the sentence through the relays to a terminal. A
     * bare `Error` here is withheld by every surface that reports a source
     * command, leaving the operator nothing about the checkout to act on.
     */
    it("raises a coded refusal, not a bare Error, when the worktree scope cannot be read", async () => {
      const repositoryPath = await fixtureRepository();
      const configWorktreePath = join(repositoryPath, ".git", "config.worktree");
      try {
        await git(repositoryPath, ["config", "extensions.worktreeConfig", "true"]);
        await symlink("/nonexistent/docsfab-absent-config-worktree", configWorktreePath);

        // Preconditions, so this cannot pass through some earlier failure: the
        // path git names is the one that dangles, something is there for the
        // `lstat` the existence probe uses, the target is not, the first read
        // still succeeds, and only the guarded second read fatals.
        expect(await git(repositoryPath, ["rev-parse", "--git-path", "config.worktree"])).toBe(
          ".git/config.worktree",
        );
        expect((await lstat(configWorktreePath)).isSymbolicLink()).toBe(true);
        expect(await exists(configWorktreePath)).toBe(false);
        expect(
          await git(repositoryPath, ["config", "--local", "--no-includes", "--list"]),
        ).toContain("extensions.worktreeconfig=true");
        await expect(
          git(repositoryPath, ["config", "--worktree", "--no-includes", "--list"]),
        ).rejects.toBeDefined();

        const caught = await prepareRepositoryWorkspace(repositoryPath, "HEAD").then(
          () => null,
          (error: unknown) => error,
        );
        expect(caught).toBeInstanceOf(RepositoryConfigurationRefusalError);
        expect((caught as RepositoryConfigurationRefusalError).code).toBe(
          "worktree-configuration-unreadable",
        );
        expect((caught as RepositoryConfigurationRefusalError).scope).toBe("worktree");
        expect((caught as RepositoryConfigurationRefusalError).message).toContain(
          "keeps per-worktree git configuration",
        );
        // Neither the bare `Error` sentence nor what every source surface
        // prints for a message it cannot recognize.
        expect((caught as RepositoryConfigurationRefusalError).message).not.toContain(
          "Git workspace preparation failed",
        );
        expect((caught as RepositoryConfigurationRefusalError).message).not.toContain(
          "withheld the underlying diagnostic",
        );

        // Positive control: the unreadable scope is the cause, not the enabled
        // extension. Remove only the symlink and the same checkout materializes.
        await rm(configWorktreePath);
        const workspace = await prepareRepositoryWorkspace(repositoryPath, "HEAD");
        expect(workspace.requestedRevision).toBe("HEAD");
        await workspace.dispose();
      } finally {
        await rm(repositoryPath, { recursive: true, force: true });
      }
    });

    it("reads git's own boolean vocabulary for the worktree extension", () => {
      for (const value of ["true", "yes", "on", "1", "TRUE", "exotic", undefined]) {
        expect(
          worktreeConfigurationEnabled([{ key: "extensions.worktreeconfig", value }]),
          String(value),
        ).toBe(true);
      }
      for (const value of ["false", "no", "off", "0", "", " FALSE "]) {
        expect(
          worktreeConfigurationEnabled([{ key: "extensions.worktreeconfig", value }]),
          String(value),
        ).toBe(false);
      }
      expect(worktreeConfigurationEnabled([{ key: "core.bare", value: "false" }])).toBe(false);
      expect(worktreeConfigurationEnabled([])).toBe(false);
    });

    it("offers a reversible Git LFS remediation and never a bare deletion", () => {
      const sentence = repositoryConfigurationRefusalMessage("content-filter", "local");
      // Only the --local form writes a filter into a checkout, and a filter
      // installed for the whole account is invisible to a read that runs with
      // GIT_CONFIG_GLOBAL and GIT_CONFIG_NOSYSTEM set. Both facts are stated.
      expect(sentence).toContain("git lfs install --local");
      expect(sentence).toContain("global and system git configuration switched off");
      // The safe action comes first and the destructive one is ordered and
      // paired with its restore, so nothing here can strand an operator with
      // pointer files in place of content.
      const safe = sentence.indexOf("Select a checkout that does not carry it");
      const destructive = sentence.indexOf("--remove-section filter.<name>");
      expect(safe).toBeGreaterThan(-1);
      expect(destructive).toBeGreaterThan(safe);
      expect(sentence).toContain("install the filter for your account with git lfs install first");
      expect(sentence).toContain("removing the section alone leaves Git LFS pointer files");
    });

    it("admits every key a plain fixture checkout actually carries", async () => {
      const repositoryPath = await fixtureRepository();
      try {
        const listed = await git(repositoryPath, [
          "config",
          "--local",
          "--no-includes",
          "--list",
          "--name-only",
        ]);
        const keys = listed.split("\n").filter(Boolean);
        // A positive control. If this list were empty the cases above would
        // prove nothing, so the count is asserted too.
        expect(keys.length).toBeGreaterThan(3);
        const refused = keys.filter(
          (key) => classifyRepositoryConfigurationKey(key.toLowerCase()) !== undefined,
        );
        expect(refused).toEqual([]);
        const workspace = await prepareRepositoryWorkspace(repositoryPath, "HEAD");
        expect(workspace.requestedRevision).toBe("HEAD");
        await workspace.dispose();
      } finally {
        await rm(repositoryPath, { recursive: true, force: true });
      }
    });

    it("admits near neighbours of every refused family instead of refusing by prefix alone", () => {
      for (const key of [
        "core.bare",
        "core.hookspathological",
        "core.fsmonitorhookversion",
        "user.email",
        "filter.lfs.foo",
        "diff.tool",
        "diff.external.notakey",
        "remote.origin.url",
        "tar.tgz.remote",
        "includes.path",
        "includeifnot.path",
        "extensions.worktreeconfig",
        "push.autosetupremote",
      ]) {
        expect(classifyRepositoryConfigurationKey(key)).toBeUndefined();
      }
    });

    it("gives every shipped refusal code a reachable key and a sentence in both scopes", () => {
      const reachable = new Set(
        [
          "core.hookspath",
          "core.fsmonitor",
          "core.attributesfile",
          "core.excludesfile",
          "filter.lfs.process",
          "diff.external",
          "diff.docs.textconv",
          "remote.origin.uploadpack",
          "tar.tgz.command",
          "include.path",
        ].map((key) => classifyRepositoryConfigurationKey(key)),
      );
      // Every code except the one no configuration key produces.
      expect([...reachable].sort()).toEqual(
        REPOSITORY_CONFIGURATION_REFUSAL_CODES.filter(
          (code) => code !== "worktree-configuration-unreadable",
        )
          .slice()
          .sort(),
      );

      for (const code of REPOSITORY_CONFIGURATION_REFUSAL_CODES) {
        for (const scope of REPOSITORY_CONFIGURATION_SCOPES) {
          const sentence = repositoryConfigurationRefusalMessage(code, scope);
          expect(sentence.length).toBeGreaterThan(80);
          expect(sentence).not.toContain("${");
          expect(sentence).toContain("then retry.");
          // Remediation is never a bare deletion offered first.
          expect(sentence).not.toMatch(/exported\.\s+(?:Remove|Unset|Delete)\b/u);
          if (code === "worktree-configuration-unreadable") continue;
          // The command names the scope the entry was read from, never the
          // scopeless form that would exit 5 against a worktree-scoped key.
          expect(sentence).toContain(`git config ${scope === "local" ? "--local" : "--worktree"} `);
          expect(sentence).not.toContain(
            `git config ${scope === "local" ? "--worktree" : "--local"} `,
          );
          expect(sentence).toContain(
            scope === "local" ? "the repository's own .git/config" : "this checkout's own config",
          );
        }
      }
    });

    it("refuses loudly rather than rendering an empty sentence for a code or scope it does not ship", () => {
      expect(() =>
        repositoryConfigurationRefusalMessage(
          "core.hooksPath" as RepositoryConfigurationRefusalCodeV1,
          "local",
        ),
      ).toThrow("requires one shipped refusal code");
      expect(() =>
        repositoryConfigurationRefusalMessage(
          "hooks-path",
          "global" as RepositoryConfigurationScopeV1,
        ),
      ).toThrow("requires one shipped configuration scope");
    });
  });

  it("exports only the requested tracked, safe repository view", async () => {
    const sourcePath = await fixtureRepository();
    const expectedRevision = await git(sourcePath, ["rev-parse", "HEAD~1"]);
    const workspace = await prepareRepositoryWorkspace(sourcePath, "HEAD~1");

    try {
      expect(workspace.sourcePath).toBe(await realpath(sourcePath));
      expect(workspace.requestedRevision).toBe("HEAD~1");
      expect(workspace.revision).toBe(expectedRevision);
      expect(await readFile(join(workspace.path, "README.md"), "utf8")).toBe("first revision\n");
      expect(await exists(join(workspace.path, ".git"))).toBe(false);
      expect(await exists(join(workspace.path, ".env"))).toBe(false);
      expect(await readFile(join(workspace.path, ".env.example"), "utf8")).toBe("TOKEN=\n");
      expect(await exists(join(workspace.path, ".env.production"))).toBe(false);
      expect(await exists(join(workspace.path, "ignored.txt"))).toBe(false);
      expect(await exists(join(workspace.path, "node_modules"))).toBe(false);
      expect(await exists(join(workspace.path, "dist"))).toBe(false);
      expect(await exists(join(workspace.path, "outside-link"))).toBe(false);
      expect(workspace.path).not.toContain(sourcePath);
    } finally {
      await workspace.dispose();
    }
    expect(await exists(workspace.path)).toBe(false);
    await workspace.dispose();
  });

  it("restores exact tracked file modes under a restrictive process umask", async () => {
    const sourcePath = await fixtureRepository();
    const executablePath = join(sourcePath, "verify-fixture");
    await writeFile(executablePath, "#!/bin/sh\nexit 0\n");
    await chmod(executablePath, 0o755);
    await git(sourcePath, ["add", "verify-fixture"]);
    await git(sourcePath, ["commit", "-m", "add executable fixture"]);

    const previousUmask = process.umask(0o077);
    let workspace: RepositoryWorkspace | undefined;
    try {
      workspace = await prepareRepositoryWorkspace(sourcePath, "HEAD");
    } finally {
      process.umask(previousUmask);
    }
    if (workspace === undefined) throw new Error("Expected restrictive-umask workspace export.");

    try {
      const regular = await stat(join(workspace.path, "README.md"));
      const executable = await stat(join(workspace.path, "verify-fixture"));
      expect(regular.mode & 0o777).toBe(0o644);
      expect(executable.mode & 0o777).toBe(0o755);
      expect(await readFile(join(workspace.path, "README.md"), "utf8")).toBe("second revision\n");
      expect(await readFile(join(workspace.path, "verify-fixture"), "utf8")).toBe(
        "#!/bin/sh\nexit 0\n",
      );
    } finally {
      await workspace.dispose();
    }
  });

  it("keeps descriptor mode failures typed and content-free", async () => {
    const sourcePath = await fixtureRepository();
    const canary = "descriptor-mode-canary";
    delayedReadOnlyFs.descriptorChmodFailure = {
      pathSuffix: "README.md",
      error: new Error(`${canary}: ${sourcePath}/README.md`),
    };
    try {
      const failure = await captureMaterializationFailure(
        prepareRepositoryWorkspace(sourcePath, "HEAD"),
      );
      expect(failure.evidence).toMatchObject({
        code: "materialization-failed",
        phase: "verification",
      });
      expectContentFreeFailure(failure, [canary, sourcePath, "README.md"]);
    } finally {
      delayedReadOnlyFs.descriptorChmodFailure = null;
    }
  });

  it("preserves precise typed evidence from the pre-stream mode boundary", async () => {
    const sourcePath = await fixtureRepository();
    delayedReadOnlyFs.descriptorChmodFailure = {
      pathSuffix: "README.md",
      error: new RepositoryWorkspaceMaterializationError({
        schemaVersion: 1,
        kind: "docsfab-repository-workspace-materialization-failure",
        code: "scratch-space-limit",
        phase: "verification",
        quantity: { unit: "bytes", limit: "4096", observed: "8192" },
        children: { started: 0, cancellationRequested: 0, reaped: 0 },
      }),
    };
    try {
      const failure = await captureMaterializationFailure(
        prepareRepositoryWorkspace(sourcePath, "HEAD"),
      );
      expect(failure.evidence).toMatchObject({
        code: "scratch-space-limit",
        phase: "verification",
        quantity: { unit: "bytes", limit: "4096", observed: "8192" },
      });
      expectContentFreeFailure(failure, [sourcePath, "README.md"]);
    } finally {
      delayedReadOnlyFs.descriptorChmodFailure = null;
    }
  });

  it("rejects equal-length replacements when timestamp metadata coalesces", async () => {
    const sourcePath = await fixtureRepository();
    const workspace = await prepareRepositoryWorkspace(sourcePath, "HEAD");
    const path = join(workspace.path, "README.md");
    try {
      const original = await readFile(path);
      const replacement = Buffer.from("mutate revision\n");
      expect(replacement.byteLength).toBe(original.byteLength);
      const snapshot = await stat(path, { bigint: true });
      await writeFile(path, replacement);

      // Model a filesystem whose resolution coalesces the rapid in-place rewrite.
      // The descriptor and path metadata remain the original snapshot, so the
      // retained Git-blob digest is the proof that must reject the new bytes.
      delayedReadOnlyFs.trackedFileSnapshot = { path, metadata: snapshot };
      await expect(
        readTrackedRepositoryFile(workspace, "README.md", replacement.byteLength),
      ).rejects.toMatchObject({ code: "changed" });
    } finally {
      delayedReadOnlyFs.trackedFileSnapshot = null;
      await workspace.dispose();
      await rm(sourcePath, { recursive: true, force: true });
    }
  });

  it("cleans up after successful and failed actions", async () => {
    const sourcePath = await fixtureRepository();
    let successfulPath = "";
    await withRepositoryWorkspace(sourcePath, "HEAD", async (workspace) => {
      successfulPath = workspace.path;
      expect(await exists(successfulPath)).toBe(true);
    });
    expect(await exists(successfulPath)).toBe(false);

    let failedPath = "";
    await expect(
      withRepositoryWorkspace(sourcePath, "HEAD", async (workspace) => {
        failedPath = workspace.path;
        throw new Error("workflow failed");
      }),
    ).rejects.toThrow("workflow failed");
    expect(await exists(failedPath)).toBe(false);
  });

  it("exposes only frozen, active workspace capabilities", async () => {
    const sourcePath = await fixtureRepository();
    const workspace = await prepareRepositoryWorkspace(sourcePath, "HEAD");

    expect(Object.isFrozen(workspace)).toBe(true);
    expect(() => assertActiveRepositoryWorkspace(workspace)).not.toThrow();
    expect(() =>
      assertActiveRepositoryWorkspace({
        ...workspace,
        dispose: workspace.dispose,
      } as RepositoryWorkspace),
    ).toThrow("Repository workspace capability is not active");

    await workspace.dispose();
    expect(() => assertActiveRepositoryWorkspace(workspace)).toThrow(
      "Repository workspace capability is not active",
    );
    await workspace.dispose();
  });

  it("rejects an active capability whose exported root was replaced", async () => {
    const sourcePath = await fixtureRepository();
    const workspace = await prepareRepositoryWorkspace(sourcePath, "HEAD");
    const moved = `${workspace.path}-replaced`;

    await expect(verifyActiveRepositoryWorkspace(workspace)).resolves.toBe(workspace);
    await rename(workspace.path, moved);
    await mkdir(workspace.path);
    await expect(verifyActiveRepositoryWorkspace(workspace)).rejects.toThrow(
      "no longer matches its export",
    );
    await workspace.dispose();
  });

  it("leases an export to one cooperative writer at a time", async () => {
    const sourcePath = await fixtureRepository();
    const workspace = await prepareRepositoryWorkspace(sourcePath, "HEAD");
    const release = await acquireRepositoryWorkspaceLease(workspace);

    await expect(acquireRepositoryWorkspaceLease(workspace)).rejects.toThrow("already leased");
    await expect(workspace.dispose()).rejects.toThrow("is leased");
    release();
    release();
    await workspace.dispose();
  });

  it("rejects a missing revision without leaving a workspace", async () => {
    const sourcePath = await fixtureRepository();
    await expect(prepareRepositoryWorkspace(sourcePath, "missing-revision")).rejects.toThrow(
      "Git workspace preparation failed",
    );
  });

  it("fails closed on whole-tree count, aggregate-byte, and scratch bounds before export", async () => {
    const sourcePath = await fixtureRepository();
    const sourceRevision = await git(sourcePath, ["rev-parse", "HEAD"]);
    const sourceStatus = await git(sourcePath, ["status", "--porcelain=v1"]);
    try {
      for (const scenario of [
        { code: "file-count-limit", limits: { maxTreeEntries: 1 } },
        { code: "aggregate-byte-limit", limits: { maxAggregateBytes: 1 } },
        { code: "scratch-space-limit", limits: { maxScratchBytes: 1 } },
      ] as const) {
        const beforeScratch = await scratchRoots();
        const failure = await captureMaterializationFailure(
          prepareRepositoryWorkspace(sourcePath, "HEAD", { limits: scenario.limits }),
        );
        expect(failure.evidence).toMatchObject({
          schemaVersion: 1,
          kind: "docsfab-repository-workspace-materialization-failure",
          code: scenario.code,
          phase: "preflight",
          children: { started: 1, reaped: 1 },
        });
        expect(await scratchRoots()).toEqual(beforeScratch);
        expectContentFreeFailure(failure, [
          sourcePath,
          sourceRevision,
          "README.md",
          "tracked-secret",
        ]);
      }
      expect(await git(sourcePath, ["rev-parse", "HEAD"])).toBe(sourceRevision);
      expect(await git(sourcePath, ["status", "--porcelain=v1"])).toBe(sourceStatus);
    } finally {
      await rm(sourcePath, { recursive: true, force: true });
    }
  });

  it(
    "bounds blocked blobs, reaps every Git child, and removes partial scratch",
    async () => {
      const fixture = await blobProcessFixture(32);
      const stagedFifos = await stageObjectFifos(fixture.objectPaths);
      const boundary = holdNextWorkspaceMkdir();
      let scratchRoot = "";
      try {
        const failurePromise = captureMaterializationFailure(
          prepareRepositoryWorkspace(fixture.repository, "HEAD", {
            limits: { maxStallMs: 1_000 },
          }),
        );
        scratchRoot = await boundary.temporaryRoot;
        await replaceObjectsWithFifos(fixture.objectPaths, stagedFifos);
        boundary.release();
        const failure = await failurePromise;
        expect(failure.evidence).toMatchObject({
          code: "per-blob-timeout",
          phase: "materialization",
          quantity: { unit: "milliseconds", limit: "1000" },
        });
        // The stalled blob names the catalog limit, the time without progress,
        // and the override that raises it.
        const observed = failure.evidence.quantity?.observed;
        expect(Number(observed)).toBeGreaterThan(1_000);
        expect(failure.message).toContain(
          `repository-workspace-export-stall-ms-bound: ${observed} exceeds repository.workspaceExportStallMs = 1000 milliseconds.`,
        );
        expect(toOperatorErrorEnvelope(failure).nextAction).toMatch(
          /raise DOCSFAB_REPOSITORY_WORKSPACE_EXPORT_STALL_MS/u,
        );
        expect(failure.evidence.children.started).toBeGreaterThan(0);
        expect(failure.evidence.children.cancellationRequested).toBeGreaterThan(0);
        expect(failure.evidence.children.reaped).toBe(failure.evidence.children.started);
        expect(scratchRoot).not.toBe("");
        expect(await exists(scratchRoot)).toBe(false);
        expectContentFreeFailure(failure, [fixture.repository, ...fixture.objectIds, "blob-0.txt"]);
      } finally {
        boundary.release();
        await rm(fixture.repository, { recursive: true, force: true });
      }
    },
    testTimeoutMs(15_000),
  );

  it("does not expose or invoke caller-controlled scratch mutation hooks", async () => {
    const fixture = await blobProcessFixture(1);
    let invoked = false;
    try {
      const legacyOptions = {
        limits: { maxStallMs: 2_000 },
        hooks: {
          scratchCreated: async () => {
            invoked = true;
            await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
          },
          afterPlan: () => {
            invoked = true;
          },
          childStarted: () => {
            invoked = true;
          },
        },
      } as unknown as RepositoryWorkspacePreparationOptions;
      const workspace = await prepareRepositoryWorkspace(fixture.repository, "HEAD", legacyOptions);
      await workspace.dispose();
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 75));
      expect(invoked).toBe(false);
    } finally {
      await rm(fixture.repository, { recursive: true, force: true });
    }
  }, 5_000);

  it(
    "stops a preflight step or the workspace mkdir that outlasts the stall window",
    async () => {
      const fixture = await blobProcessFixture(1);
      let scratchRoot = "";
      try {
        const initialScratch = await scratchRoots();
        // The scratch-space statfs never answers, so a preflight step outlasts
        // the window however fast the steps before it run. A 1 ms window alone
        // is not enough: on a fast CI runner every preflight step finished
        // inside it, and the stall landed in materialization instead.
        delayedReadOnlyFs.statfs = true;
        const preflightFailure = await captureMaterializationFailure(
          prepareRepositoryWorkspace(fixture.repository, "HEAD", { limits: { maxStallMs: 50 } }),
        );
        delayedReadOnlyFs.statfs = false;
        expect(preflightFailure.evidence).toMatchObject({
          code: "aggregate-timeout",
          phase: "preflight",
          quantity: { unit: "milliseconds", limit: "50" },
        });
        expect(Number(preflightFailure.evidence.quantity?.observed)).toBeGreaterThan(50);
        expectAggregateTimeoutOperatorSurface(preflightFailure, "preflight");
        expect(await scratchRoots()).toEqual(initialScratch);

        // A filesystem mkdir cannot be cancelled, so the held workspace root is
        // judged when it settles: it took longer than the window, and nothing
        // else made progress meanwhile.
        const windowMs = 300;
        const boundary = holdNextWorkspaceMkdir();
        const failurePromise = captureMaterializationFailure(
          prepareRepositoryWorkspace(fixture.repository, "HEAD", {
            limits: { maxStallMs: windowMs },
          }),
        );
        try {
          scratchRoot = await boundary.temporaryRoot;
          await new Promise((resolveHold) => setTimeout(resolveHold, 3 * windowMs));
          boundary.release();
          const failure = await failurePromise;
          expect(failure.evidence).toMatchObject({
            code: "aggregate-timeout",
            phase: "materialization",
            children: { started: 0, cancellationRequested: 0, reaped: 0 },
          });
          expect(Number(failure.evidence.quantity?.observed)).toBeGreaterThan(windowMs);
          expectAggregateTimeoutOperatorSurface(failure, "materialization");
          expect(await exists(scratchRoot)).toBe(false);
        } finally {
          boundary.release();
        }
      } finally {
        await rm(fixture.repository, { recursive: true, force: true });
      }
    },
    testTimeoutMs(15_000),
  );

  it(
    "returns a bounded typed timeout when scratch-space inspection does not settle",
    async () => {
      const fixture = await blobProcessFixture(1);
      const beforeScratch = await scratchRoots();
      delayedReadOnlyFs.statfs = true;
      try {
        const failure = await captureMaterializationFailure(
          prepareRepositoryWorkspace(fixture.repository, "HEAD", { limits: { maxStallMs: 500 } }),
        );
        // One window after the export's last progress, which preceded the held statfs.
        expect(delayedReadOnlyFs.heldSince).toBeGreaterThan(0);
        expect(Date.now() - delayedReadOnlyFs.heldSince).toBeLessThan(1_500);
        expect(failure.evidence).toMatchObject({
          code: "aggregate-timeout",
          phase: "preflight",
          children: { started: 0, cancellationRequested: 0, reaped: 0 },
        });
        expect(await scratchRoots()).toEqual(beforeScratch);
      } finally {
        delayedReadOnlyFs.statfs = false;
        await rm(fixture.repository, { recursive: true, force: true });
      }
    },
    testTimeoutMs(15_000),
  );

  it(
    "returns a bounded typed timeout when tracked-entry verification does not settle",
    async () => {
      const fixture = await blobProcessFixture(1);
      const boundary = holdNextWorkspaceMkdir();
      let scratchRoot = "";
      delayedReadOnlyFs.captureLstat = true;
      delayedReadOnlyFs.trackedFileLstatCalls = 0;
      try {
        const failurePromise = captureMaterializationFailure(
          prepareRepositoryWorkspace(fixture.repository, "HEAD", { limits: { maxStallMs: 2_000 } }),
        );
        scratchRoot = await boundary.temporaryRoot;
        boundary.release();
        const failure = await failurePromise;
        // One window after the last verified file, not after the whole export.
        expect(delayedReadOnlyFs.heldSince).toBeGreaterThan(0);
        expect(Date.now() - delayedReadOnlyFs.heldSince).toBeLessThan(4_000);
        expect(failure.evidence).toMatchObject({
          code: "aggregate-timeout",
          phase: "verification",
          children: { started: 0, cancellationRequested: 0, reaped: 0 },
        });
        expect(await exists(scratchRoot)).toBe(false);
      } finally {
        boundary.release();
        delayedReadOnlyFs.captureLstat = false;
        delayedReadOnlyFs.trackedFileLstatCalls = 0;
        await rm(fixture.repository, { recursive: true, force: true });
      }
    },
    testTimeoutMs(15_000),
  );

  it(
    "cancels and reaps the batch Git child before cleaning a failed export",
    async () => {
      const fixture = await blobProcessFixture(64);
      const stagedFifos = await stageObjectFifos(fixture.objectPaths);
      const boundary = holdNextWorkspaceMkdir();
      let scratchRoot = "";
      try {
        const failurePromise = captureMaterializationFailure(
          prepareRepositoryWorkspace(fixture.repository, "HEAD", {
            limits: { maxStallMs: 1_000 },
          }),
        );
        scratchRoot = await boundary.temporaryRoot;
        await replaceObjectsWithFifos(fixture.objectPaths, stagedFifos);
        boundary.release();
        const failure = await failurePromise;
        expect(failure.evidence).toMatchObject({
          code: "per-blob-timeout",
          phase: "materialization",
        });
        expect(failure.evidence.children.started).toBe(1);
        expect(failure.evidence.children.cancellationRequested).toBeGreaterThan(0);
        expect(failure.evidence.children.reaped).toBe(failure.evidence.children.started);
        expect(await exists(scratchRoot)).toBe(false);
        expectContentFreeFailure(failure, [
          fixture.repository,
          ...fixture.objectIds,
          "corrupt-object",
          "blob-0.txt",
        ]);
      } finally {
        boundary.release();
        await rm(fixture.repository, { recursive: true, force: true });
      }
    },
    testTimeoutMs(30_000),
  );

  it("preserves a patch after cleanup without changing the source repository", async () => {
    const sourcePath = await fixtureRepository();
    const artifactRoot = await mkdtemp(join(tmpdir(), "docsfab-artifacts-"));
    let patchPath = "";
    try {
      await withRepositoryWorkspace(sourcePath, "HEAD", async (workspace) => {
        const collector = await GitPatchEvidenceCollector.create(workspace.path, artifactRoot);
        try {
          await writeFile(join(workspace.path, "README.md"), "agent revision\n");
          const evidence = await collector.capture({
            runId: "write-run",
            repository: {
              sourcePath: workspace.sourcePath,
              requestedRevision: workspace.requestedRevision,
              revision: workspace.revision,
            },
            workspacePath: workspace.path,
            persistPatch: true,
          });
          patchPath = evidence.patch?.artifactPath ?? "";
        } finally {
          await collector.dispose();
        }
      });

      expect(await readFile(join(sourcePath, "README.md"), "utf8")).toBe("second revision\n");
      expect(await readFile(patchPath, "utf8")).toContain("+agent revision");
      await expect(git(sourcePath, ["apply", "--check", patchPath])).resolves.toBe("");
    } finally {
      await rm(sourcePath, { recursive: true, force: true });
      await rm(artifactRoot, { recursive: true, force: true });
    }
  });
});
