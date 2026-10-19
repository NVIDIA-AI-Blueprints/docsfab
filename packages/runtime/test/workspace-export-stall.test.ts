// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Workspace export hang detection is a no-progress window,
 * `repository.workspaceExportStallMs`, not a wall clock (issue 1921). These
 * probes slow or hold single export steps so that both progress and a stall
 * are measurable: the mkdir sweep over tracked directories, each exported
 * file's open, and the closing directory fsync.
 */
const exportProbe = vi.hoisted(() => ({
  mkdirDelayMs: 0,
  mkdirStartedAt: [] as number[],
  /** 1-based position of the export mkdir to hold; 0 holds none. */
  mkdirHoldAt: 0,
  mkdirHoldMs: 0,
  /** Pause for the nth export mkdir (index 0 is the first); overrides the two above. */
  mkdirPauses: [] as number[],
  /** Called with the 1-based position of each export mkdir as it starts. */
  onMkdir: null as null | ((position: number) => void),
  openDelayMs: 0,
  exportedOpens: 0,
  holdFsync: false,
  fsyncAutoReleaseMs: 0,
  fsyncStartedAt: [] as number[],
  fsyncReached: null as null | (() => void),
  releaseHeldFsyncs: [] as (() => void)[],
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
  const insideExport = (path: string): boolean =>
    path.includes("docsfab-workspace-") && path.includes("/repository/");
  const isWorkspaceRoot = (path: string): boolean =>
    path.includes("docsfab-workspace-") && path.endsWith("/repository");
  const pause = (ms: number): Promise<void> =>
    new Promise<void>((resolvePause) => {
      setTimeout(resolvePause, ms);
    });
  return {
    ...actual,
    mkdir: async (...args: unknown[]) => {
      const path = String(args[0]);
      if (insideExport(path)) {
        exportProbe.mkdirStartedAt.push(performance.now());
        const position = exportProbe.mkdirStartedAt.length;
        exportProbe.onMkdir?.(position);
        const pauseMs =
          exportProbe.mkdirPauses[position - 1] ??
          (position === exportProbe.mkdirHoldAt
            ? exportProbe.mkdirHoldMs
            : exportProbe.mkdirDelayMs);
        if (pauseMs > 0) await pause(pauseMs);
      }
      return Reflect.apply(actual.mkdir, actual, args);
    },
    open: async (...args: unknown[]) => {
      const path = String(args[0]);
      if (insideExport(path)) {
        exportProbe.exportedOpens += 1;
        if (exportProbe.openDelayMs > 0) await pause(exportProbe.openDelayMs);
      }
      const handle = await Reflect.apply(actual.open, actual, args);
      if (!exportProbe.holdFsync || !isWorkspaceRoot(path)) return handle;
      return new Proxy(handle, {
        get(target, property) {
          if (property === "sync") {
            return async () => {
              exportProbe.fsyncStartedAt.push(performance.now());
              exportProbe.fsyncReached?.();
              await new Promise<void>((resolveHold) => {
                const timer =
                  exportProbe.fsyncAutoReleaseMs > 0
                    ? setTimeout(resolveHold, exportProbe.fsyncAutoReleaseMs)
                    : undefined;
                exportProbe.releaseHeldFsyncs.push(() => {
                  if (timer !== undefined) clearTimeout(timer);
                  resolveHold();
                });
              });
              const sync = Reflect.get(target, "sync", target) as () => Promise<void>;
              return sync.call(target);
            };
          }
          const value = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    },
  };
});

import { matchBoundLiterals } from "../scripts/check-limits.mjs";
import { LIMIT_DEFINITION_BY_NAME } from "../src/config/limits.generated.js";
import { REPOSITORY_WORKSPACE_EXPORT_LIMITS } from "../src/config/repository-discovery-limits.js";
import { toOperatorErrorEnvelope } from "../src/operator/error-envelope.js";
import {
  RepositoryWorkspaceMaterializationError,
  type RepositoryWorkspaceMaterializationLimits,
} from "../src/repository/workspace/contracts.js";
import { prepareRepositoryWorkspace } from "../src/repository/workspace/materialize.js";
import { sealOriginalSourceAuthority } from "../src/workflow-execution/source-obligation-authority.js";
import { observeCheckedSnapshot } from "../src/workflow-execution/workflow-checks.js";
import { git, initFixtureRepo } from "./helpers/git.js";
import { testTimeoutMs } from "./helpers/test-timeouts.js";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const STALL_OVERRIDE = "DOCSFAB_REPOSITORY_WORKSPACE_EXPORT_STALL_MS";
const EXPORT_OVERRIDES = [
  STALL_OVERRIDE,
  "DOCSFAB_REPOSITORY_WORKSPACE_EXPORT_MAX_TREE_ENTRIES",
  "DOCSFAB_REPOSITORY_WORKSPACE_EXPORT_MAX_AGGREGATE_BYTES",
  "DOCSFAB_REPOSITORY_WORKSPACE_EXPORT_MAX_SCRATCH_BYTES",
  "DOCSFAB_REPOSITORY_WORKSPACE_EXPORT_MAX_TREE_METADATA_BYTES",
] as const;
const savedOverrides = new Map<string, string | undefined>();

beforeEach(async () => {
  workspaceTestTemp.directory = await mkdtemp(join(tmpdir(), "docsfab-export-stall-"));
  for (const name of EXPORT_OVERRIDES) {
    savedOverrides.set(name, process.env[name]);
    delete process.env[name];
  }
});

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const release of exportProbe.releaseHeldFsyncs) release();
  exportProbe.releaseHeldFsyncs = [];
  exportProbe.mkdirDelayMs = 0;
  exportProbe.mkdirStartedAt = [];
  exportProbe.mkdirHoldAt = 0;
  exportProbe.mkdirHoldMs = 0;
  exportProbe.mkdirPauses = [];
  exportProbe.onMkdir = null;
  exportProbe.openDelayMs = 0;
  exportProbe.exportedOpens = 0;
  exportProbe.holdFsync = false;
  exportProbe.fsyncAutoReleaseMs = 0;
  exportProbe.fsyncStartedAt = [];
  exportProbe.fsyncReached = null;
  for (const [name, value] of savedOverrides) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  savedOverrides.clear();
  const directory = workspaceTestTemp.directory;
  workspaceTestTemp.directory = null;
  if (directory !== null) await rm(directory, { recursive: true, force: true });
});

/** A repository whose tracked tree has `directoryCount` directories of one file each. */
async function wideTreeFixture(directoryCount: number): Promise<string> {
  const repositoryPath = await mkdtemp(join(tmpdir(), "docsfab-export-source-"));
  const files: Record<string, string> = {};
  for (let index = 0; index < directoryCount; index += 1) {
    files[`unit-${String(index).padStart(4, "0")}/page.md`] = `unit ${index}\n`;
  }
  await initFixtureRepo(repositoryPath, files, { message: "wide export fixture" });
  return repositoryPath;
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

/** Let promise chains that need no timer run to their next await. */
async function drainPendingWork(): Promise<void> {
  for (let turn = 0; turn < 10; turn += 1) {
    await new Promise<void>((resolveTurn) => setImmediate(resolveTurn));
  }
}

describe("repository workspace export stall window", () => {
  it(
    "keeps exporting a slow tree that makes progress, far past the stall window",
    async () => {
      const directoryCount = 120;
      const stepDelayMs = 25;
      const windowMs = 1_000;
      const sourcePath = await wideTreeFixture(directoryCount);
      try {
        exportProbe.mkdirDelayMs = stepDelayMs;
        exportProbe.openDelayMs = stepDelayMs;
        const startedAt = performance.now();
        const workspace = await prepareRepositoryWorkspace(sourcePath, "HEAD", {
          limits: { maxStallMs: windowMs },
        });
        const elapsedMs = performance.now() - startedAt;
        try {
          // Not vacuous: the export really ran for several windows, one
          // directory and one file at a time, and every step was slow.
          expect(elapsedMs).toBeGreaterThan(4 * windowMs);
          expect(exportProbe.mkdirStartedAt).toHaveLength(directoryCount);
          expect(exportProbe.exportedOpens).toBe(directoryCount);
          expect(await readFile(join(workspace.path, "unit-0119", "page.md"), "utf8")).toBe(
            "unit 119\n",
          );
        } finally {
          await workspace.dispose();
        }
      } finally {
        await rm(sourcePath, { recursive: true, force: true });
      }
    },
    testTimeoutMs(60_000),
  );

  it(
    "records a stall at the window when one mkdir outlasts it, and fails once that mkdir returns",
    async () => {
      const windowMs = 500;
      const holdMs = 2_500;
      const sourcePath = await wideTreeFixture(8);
      try {
        exportProbe.mkdirHoldAt = 3;
        exportProbe.mkdirHoldMs = holdMs;
        const failure = await captureMaterializationFailure(
          prepareRepositoryWorkspace(sourcePath, "HEAD", { limits: { maxStallMs: windowMs } }),
        );
        const settledAt = performance.now();
        expect(failure.evidence).toMatchObject({
          code: "aggregate-timeout",
          phase: "materialization",
          quantity: { unit: "milliseconds", limit: String(windowMs) },
        });
        // The stall is recorded when the window passes, so `observed` is about
        // one window. A filesystem mkdir cannot be cancelled, so the export
        // itself fails only after the held call returns.
        const observed = Number(failure.evidence.quantity?.observed);
        expect(observed).toBeGreaterThan(windowMs);
        expect(observed).toBeLessThan(holdMs);
        expect(settledAt - exportProbe.mkdirStartedAt[2]!).toBeGreaterThanOrEqual(holdMs - 50);
        // No directory after the stalled one was attempted.
        expect(exportProbe.mkdirStartedAt).toHaveLength(3);
        expect(failure.message).toContain(
          `repository-workspace-export-stall-ms-bound: ${observed} exceeds repository.workspaceExportStallMs = ${windowMs} milliseconds.`,
        );
        expect(failure.message).toContain("raise DOCSFAB_REPOSITORY_WORKSPACE_EXPORT_STALL_MS");
      } finally {
        await rm(sourcePath, { recursive: true, force: true });
      }
    },
    testTimeoutMs(30_000),
  );

  it(
    "stops a hung closing fsync one window after the export's last progress",
    async () => {
      const windowMs = 1_500;
      const sourcePath = await wideTreeFixture(2);
      try {
        exportProbe.holdFsync = true;
        exportProbe.fsyncAutoReleaseMs = 20_000;
        const failure = await captureMaterializationFailure(
          prepareRepositoryWorkspace(sourcePath, "HEAD", { limits: { maxStallMs: windowMs } }),
        );
        const settledAt = performance.now();
        // Guards against a vacuous pass: the run reached the fsync, not a cheaper stop.
        expect(exportProbe.fsyncStartedAt).toHaveLength(1);
        // The window runs from the last progress, a directory open before the
        // fsync, so it may close a little before fsync start plus the window.
        // The held fsync would release only after 20 s, so settling within a
        // few seconds of the window shows the race stopped it; the slack is for
        // a heavily loaded host.
        const heldMs = settledAt - exportProbe.fsyncStartedAt[0]!;
        expect(heldMs).toBeGreaterThan(windowMs - 250);
        expect(heldMs).toBeLessThan(windowMs + 3_000);
        expect(failure.evidence).toMatchObject({
          code: "aggregate-timeout",
          phase: "materialization",
          quantity: { unit: "milliseconds", limit: String(windowMs) },
        });
        const envelope = toOperatorErrorEnvelope(failure);
        expect(envelope.code).toBe("aggregate-timeout");
        expect(envelope.message).toContain("repository-workspace-export-stall-ms-bound:");
        expect(envelope.message).toContain("repository.workspaceExportStallMs");
        expect(envelope.nextAction).toMatch(/no progress for the whole no-progress window/u);
        expect(envelope.nextAction).toMatch(/DOCSFAB_REPOSITORY_WORKSPACE_EXPORT_STALL_MS/u);
        expect(envelope.docsAnchor).toBe("docs/troubleshooting.md");
      } finally {
        await rm(sourcePath, { recursive: true, force: true });
      }
    },
    testTimeoutMs(30_000),
  );

  it.each([
    { label: "the catalog default", override: undefined, windowMs: 120_000 },
    { label: "a host override that raises it", override: "600000", windowMs: 600_000 },
    { label: "a host override that lowers it", override: "50", windowMs: 50 },
  ] as const)(
    "holds a step at exactly $windowMs ms without progress under $label and stops it 1 ms later",
    async ({ override, windowMs }) => {
      const sourcePath = await wideTreeFixture(2);
      if (override !== undefined) process.env[STALL_OVERRIDE] = override;
      // Export time is driven by hand: the watchdog's timers and the clock it
      // reads (`performance.now` from node:perf_hooks) both follow the fake
      // clock, which stands still while real Git and filesystem work runs.
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"], now: 0 });
      const origin = 1_000_000;
      vi.spyOn(performance, "now").mockImplementation(() => origin + Date.now());
      const holdNextFsync = (): Promise<void> =>
        new Promise<void>((resolveReached) => {
          exportProbe.fsyncReached = resolveReached;
        });
      try {
        exportProbe.holdFsync = true;

        // At the limit: a step that ends after exactly the window without
        // progress is still progress, and the export completes.
        const admittedReached = holdNextFsync();
        const admitted = prepareRepositoryWorkspace(sourcePath, "HEAD");
        await admittedReached;
        vi.advanceTimersByTime(windowMs);
        exportProbe.releaseHeldFsyncs.shift()?.();
        const workspace = await admitted;
        await workspace.dispose();

        // One millisecond past it: a step still running stops the export.
        const reached = holdNextFsync();
        let settled = false;
        const outcome = captureMaterializationFailure(
          prepareRepositoryWorkspace(sourcePath, "HEAD"),
        ).finally(() => {
          settled = true;
        });
        await reached;

        vi.advanceTimersByTime(windowMs);
        await drainPendingWork();
        expect(settled).toBe(false);

        vi.advanceTimersByTime(1);
        const failure = await outcome;
        expect(failure.evidence).toMatchObject({
          code: "aggregate-timeout",
          phase: "materialization",
          quantity: {
            unit: "milliseconds",
            limit: String(windowMs),
            observed: String(windowMs + 1),
          },
        });
        expect(failure.message).toContain(
          `repository-workspace-export-stall-ms-bound: ${windowMs + 1} exceeds repository.workspaceExportStallMs = ${windowMs} milliseconds.`,
        );
      } finally {
        vi.useRealTimers();
        vi.restoreAllMocks();
        for (const release of exportProbe.releaseHeldFsyncs) release();
        exportProbe.releaseHeldFsyncs = [];
        await rm(sourcePath, { recursive: true, force: true });
      }
    },
    testTimeoutMs(30_000),
  );

  it(
    "re-arms for the rest of the window after progress, so a later stall stops one window after that progress",
    async () => {
      const windowMs = 1_000;
      const sourcePath = await wideTreeFixture(3);
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"], now: 0 });
      const origin = 1_000_000;
      vi.spyOn(performance, "now").mockImplementation(() => origin + Date.now());
      const mkdirStarted = (position: number): Promise<void> =>
        new Promise<void>((resolveStarted) => {
          const previous = exportProbe.onMkdir;
          exportProbe.onMkdir = (started) => {
            previous?.(started);
            if (started === position) resolveStarted();
          };
        });
      try {
        // The first export mkdir takes half a window; the second never returns
        // until the clock passes 100 windows.
        exportProbe.mkdirPauses = [windowMs / 2, 100 * windowMs];
        const firstStarted = mkdirStarted(1);
        const secondStarted = mkdirStarted(2);
        const outcome = captureMaterializationFailure(
          prepareRepositoryWorkspace(sourcePath, "HEAD", { limits: { maxStallMs: windowMs } }),
        );
        // The sweep starts at t = 0 with the watchdog due at t = W + 1.
        await firstStarted;
        // t = W/2: the first mkdir returns, which is progress.
        vi.advanceTimersByTime(windowMs / 2);
        await secondStarted;
        // t = W + 1: the watchdog wakes, finds progress W/2 + 1 ms old, and must
        // sleep only for the rest of the window, not a whole new one.
        vi.advanceTimersByTime(windowMs / 2 + 1);
        await drainPendingWork();
        // t = 1.5W + 1: one window and 1 ms after the last progress.
        vi.advanceTimersByTime(windowMs / 2);
        await drainPendingWork();
        // Let the held mkdir return so the export can settle.
        vi.advanceTimersByTime(100 * windowMs);
        const failure = await outcome;
        expect(failure.evidence).toMatchObject({
          code: "aggregate-timeout",
          phase: "materialization",
          quantity: {
            unit: "milliseconds",
            limit: String(windowMs),
            observed: String(windowMs + 1),
          },
        });
      } finally {
        vi.useRealTimers();
        vi.restoreAllMocks();
        await rm(sourcePath, { recursive: true, force: true });
      }
    },
    testTimeoutMs(30_000),
  );

  it(
    "admits a caller window above the catalog default only after a host override raises it",
    async () => {
      const sourcePath = await wideTreeFixture(1);
      try {
        await expect(
          prepareRepositoryWorkspace(sourcePath, "HEAD", { limits: { maxStallMs: 300_000 } }),
        ).rejects.toThrow("Repository workspace materialization limits are invalid.");
        process.env[STALL_OVERRIDE] = "600000";
        const workspace = await prepareRepositoryWorkspace(sourcePath, "HEAD", {
          limits: { maxStallMs: 300_000 },
        });
        await workspace.dispose();
        process.env[STALL_OVERRIDE] = "2147483647";
        await expect(prepareRepositoryWorkspace(sourcePath, "HEAD")).rejects.toThrow(
          "DOCSFAB_REPOSITORY_WORKSPACE_EXPORT_STALL_MS must be an integer between 1 and 2147483646.",
        );
      } finally {
        await rm(sourcePath, { recursive: true, force: true });
      }
    },
    testTimeoutMs(30_000),
  );

  it.each([
    {
      variable: "DOCSFAB_REPOSITORY_WORKSPACE_EXPORT_MAX_TREE_ENTRIES",
      axis: "maxTreeEntries",
      name: "repository.workspaceExportMaxTreeEntries",
      refusal: "repository-workspace-export-max-tree-entries-bound",
      unit: "files",
      code: "file-count-limit",
      // Three tracked files.
      exact: async () => 3,
      raised: "200000",
      callerAboveDefault: 150_000,
    },
    {
      variable: "DOCSFAB_REPOSITORY_WORKSPACE_EXPORT_MAX_AGGREGATE_BYTES",
      axis: "maxAggregateBytes",
      name: "repository.workspaceExportMaxAggregateBytes",
      refusal: "repository-workspace-export-max-aggregate-bytes-bound",
      unit: "bytes",
      code: "aggregate-byte-limit",
      // Three files of 7 bytes: "unit 0\n", "unit 1\n", "unit 2\n".
      exact: async () => 21,
      raised: "4294967296",
      callerAboveDefault: 3_000_000_000,
    },
    {
      variable: "DOCSFAB_REPOSITORY_WORKSPACE_EXPORT_MAX_SCRATCH_BYTES",
      axis: "maxScratchBytes",
      name: "repository.workspaceExportMaxScratchBytes",
      refusal: "repository-workspace-export-max-scratch-bytes-bound",
      unit: "bytes",
      code: "scratch-space-limit",
      // The preflight plan: file bytes plus 4,096 bytes per tracked entry.
      exact: async () => 21 + 3 * 4_096,
      raised: "8589934592",
      callerAboveDefault: 4_294_967_296,
    },
    {
      variable: "DOCSFAB_REPOSITORY_WORKSPACE_EXPORT_MAX_TREE_METADATA_BYTES",
      axis: "maxTreeMetadataBytes",
      name: "repository.workspaceExportMaxTreeMetadataBytes",
      refusal: "repository-workspace-export-max-tree-metadata-bytes-bound",
      unit: "bytes",
      code: "tree-metadata-limit",
      // The listing the export reads, measured with the same command.
      exact: async (sourcePath: string) =>
        Buffer.byteLength(
          await git(sourcePath, ["ls-tree", "-lrz", "--full-tree", "HEAD"], { trim: false }),
        ),
      raised: "67108864",
      callerAboveDefault: 50_000_000,
    },
  ] as const)(
    "admits exactly the $axis ceiling, refuses one under it, and lets a host override raise it",
    async ({ variable, axis, name, refusal, unit, code, exact, raised, callerAboveDefault }) => {
      const sourcePath = await wideTreeFixture(3);
      const caller = {
        limits: { [axis]: callerAboveDefault } as Partial<RepositoryWorkspaceMaterializationLimits>,
      };
      try {
        const bound = await exact(sourcePath);

        // At the bound: the export completes.
        process.env[variable] = String(bound);
        const atBound = await prepareRepositoryWorkspace(sourcePath, "HEAD");
        await atBound.dispose();

        // One under it: refused in preflight, naming the bound and the observed value.
        process.env[variable] = String(bound - 1);
        const failure = await captureMaterializationFailure(
          prepareRepositoryWorkspace(sourcePath, "HEAD"),
        );
        expect(failure.evidence).toMatchObject({
          code,
          phase: "preflight",
          quantity: { unit, limit: String(bound - 1), observed: String(bound) },
        });
        expect(failure.message).toContain(
          `${refusal}: ${bound} exceeds ${name} = ${bound - 1} ${unit}.`,
        );
        expect(failure.message).toContain(`Raise ${variable}`);
        const nextAction = toOperatorErrorEnvelope(failure).nextAction;
        expect(nextAction).toMatch(/raise that limit with the override the message names/u);
        expect(nextAction).not.toMatch(/only tighten/u);

        // Above the catalog default: a caller cannot raise it, a host override can.
        delete process.env[variable];
        await expect(prepareRepositoryWorkspace(sourcePath, "HEAD", caller)).rejects.toThrow(
          "Repository workspace materialization limits are invalid.",
        );
        process.env[variable] = raised;
        const workspace = await prepareRepositoryWorkspace(sourcePath, "HEAD", caller);
        await workspace.dispose();
      } finally {
        await rm(sourcePath, { recursive: true, force: true });
      }
    },
    testTimeoutMs(30_000),
  );

  it("bounds the checked-tree walk and the source authority by the same export limits", async () => {
    const checkedTree = await mkdtemp(join(tmpdir(), "docsfab-checked-tree-"));
    const paths = ["a.md", "b.md", "c.md"];
    try {
      for (const path of paths) await writeFile(join(checkedTree, path), "x\n");
      const entries = "DOCSFAB_REPOSITORY_WORKSPACE_EXPORT_MAX_TREE_ENTRIES";
      const bytes = "DOCSFAB_REPOSITORY_WORKSPACE_EXPORT_MAX_AGGREGATE_BYTES";
      const seal = () =>
        sealOriginalSourceAuthority({
          runId: "run-1921",
          scope: "review-tracked-workspace",
          repositoryRevision: "a".repeat(40),
          scopeSha256: "b".repeat(64),
          workspaceSnapshotSha256: "c".repeat(64),
          members: paths.map((path) => ({
            path,
            mode: 0o644,
            byteLength: 2,
            sourceSha256: "d".repeat(64),
          })),
        });

      process.env[entries] = "2";
      await expect(observeCheckedSnapshot(checkedTree)).rejects.toThrow(
        "The checked tree exceeds the repository workspace entry bound (maxTreeEntries 2).",
      );
      expect(seal).toThrow(
        "Original source authority evidence did not satisfy the host-owned contract: member-count.",
      );
      process.env[entries] = "3";
      await expect(observeCheckedSnapshot(checkedTree)).resolves.toMatchObject({
        sha256: expect.any(String),
      });
      expect(seal).not.toThrow();

      process.env[bytes] = "5";
      await expect(observeCheckedSnapshot(checkedTree)).rejects.toThrow(
        "The checked tree exceeds the repository workspace byte bound (maxAggregateBytes 5).",
      );
      expect(seal).toThrow(
        "Original source authority evidence did not satisfy the host-owned contract: member-bytes.",
      );
    } finally {
      await rm(checkedTree, { recursive: true, force: true });
    }
  });

  it("declares every export ceiling as a raisable catalog limit with no allowlisted literal", async () => {
    for (const name of Object.values(REPOSITORY_WORKSPACE_EXPORT_LIMITS)) {
      const definition = LIMIT_DEFINITION_BY_NAME[name];
      expect(definition, name).toBeDefined();
      expect(definition!.scope, name).not.toBe("sealed");
      expect(definition!.override, name).toMatch(/^DOCSFAB_REPOSITORY_WORKSPACE_EXPORT_/u);
      expect(definition!.max, name).toBeGreaterThan(definition!.value);
      expect(definition!.min, name).toBeLessThan(definition!.value);
    }
    const sources = [
      "packages/runtime/src/repository/workspace/contracts.ts",
      "packages/runtime/src/repository/workspace/materialize.ts",
    ];
    const allowlist = JSON.parse(
      await readFile(
        join(repositoryRoot, "config/limits-allowlist/runtime.repository.json"),
        "utf8",
      ),
    ) as { literals: { path: string; kind: string; lexeme: string }[] };
    // What stays allowlisted in the exporter: one tree record's parse bound,
    // the Git preflight output buffer, and the per-entry scratch estimate.
    expect(
      allowlist.literals
        .filter((entry) => sources.includes(entry.path))
        .map((entry) => `${entry.kind} ${entry.lexeme}`)
        .sort(),
    ).toEqual([
      "kib-product 10 * 1024",
      "kib-product 1024 * 1024",
      "max-assign MAX_TREE_RECORD_BYTES = 1",
      "max-assign SCRATCH_ENTRY_OVERHEAD_BYTES = 4",
      "max-assign maxBuffer: 1",
      "max-buffer maxBuffer: 1",
    ]);
    const contracts = await readFile(join(repositoryRoot, sources[0]!), "utf8");
    expect(matchBoundLiterals(contracts)).toEqual([]);
    // The two clocks the checker's patterns never saw are gone too. A quoted
    // "120000" is Git's symlink mode, not a duration.
    const materialize = await readFile(join(repositoryRoot, sources[1]!), "utf8");
    expect(materialize).not.toMatch(/(?<![\w"'])(?:30|120)_?000(?![\w"'])/u);
  });
});
