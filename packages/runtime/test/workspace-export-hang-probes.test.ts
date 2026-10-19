// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import type { PassThrough } from "node:stream";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Executing probes for the export's hang detectors and progress points (issue
 * 1921, critic-1572 MAJOR-1). Each probe swaps one export git call for a real
 * stand-in: a child that never answers, or the real git command whose output
 * the test releases piece by piece. The `delay` mode instead holds the answer
 * of every buffered export git read for part of the window. A fake clock
 * drives the export's watchdog timers and the `performance.now` they read, and
 * it advances only while the export waits on the stand-in, so host load cannot
 * open a false gap and every observed value is exact. Every other git call
 * runs real git unchanged.
 */
interface Relay {
  /** Real git output not yet released to the export. */
  readonly buffered: Buffer[];
  sourceEnded: boolean;
  /** What the export reads instead of the child's stdout. */
  readonly out: PassThrough;
  outEnded: boolean;
}

interface GitSubstitution {
  /** Which export git call to replace; matched on its argument list. */
  readonly match: (args: readonly string[]) => boolean;
  /** `hang` never answers; `relay` runs the real command and holds its output. */
  readonly mode: "hang" | "relay";
}

const gitProbe = vi.hoisted(() => ({
  substitution: null as null | GitSubstitution,
  substituted: [] as ChildProcess[],
  relay: null as null | Relay,
  onSubstituted: null as null | (() => void),
}));

/**
 * The `delay` mode: every buffered export git read runs real git at once, and
 * the export gets the answer this long later on the (fake) clock; 0 disables.
 */
const gitReadDelay = vi.hoisted(() => ({ delayMs: 0, pending: 0, answered: 0 }));

/** Exported-file lstats wait this long on the (fake) clock; 0 disables. */
const fsProbe = vi.hoisted(() => ({ lstatDelayMs: 0, pendingLstats: 0, delayedLstats: 0 }));

const probeTemp = vi.hoisted(() => ({ directory: null as string | null }));

/** Real timers, captured before any test fakes them, for waiting on real I/O. */
const realTimers = { setTimeout: globalThis.setTimeout };

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, tmpdir: () => probeTemp.directory ?? actual.tmpdir() };
});

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const exportedFile = (path: string): boolean =>
    path.includes("docsfab-workspace-") && path.includes("/repository/");
  return {
    ...actual,
    lstat: async (...args: unknown[]) => {
      if (fsProbe.lstatDelayMs > 0 && exportedFile(String(args[0]))) {
        fsProbe.pendingLstats += 1;
        await new Promise<void>((resolveDelay) => {
          setTimeout(resolveDelay, fsProbe.lstatDelayMs);
        });
        fsProbe.pendingLstats -= 1;
        fsProbe.delayedLstats += 1;
      }
      return Reflect.apply(actual.lstat, actual, args);
    },
  };
});

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  const { promisify } = await import("node:util");
  const { PassThrough: Relayed } = await import("node:stream");
  type Promised = Promise<unknown> & { child: ChildProcess };
  const realPromised = (actual.execFile as unknown as Record<symbol, unknown>)[
    promisify.custom
  ] as (file: string, args: readonly string[], options: unknown) => Promised;
  const HANG = ["-c", "exec /bin/sleep 100000"];
  /** The export runs `/usr/bin/git`; test helpers run plain `git`. */
  const substitutionFor = (file: string, args: readonly string[]) => {
    const substitution = gitProbe.substitution;
    if (file !== "/usr/bin/git" || substitution === null || !substitution.match(args)) return null;
    gitProbe.substitution = null;
    return substitution.mode;
  };
  const substituted = (child: ChildProcess): void => {
    gitProbe.substituted.push(child);
    gitProbe.onSubstituted?.();
  };
  /** Holds a finished read's answer for `gitReadDelay.delayMs` of (fake) time. */
  const answerLate = (real: Promised): Promised => {
    const delayMs = gitReadDelay.delayMs;
    const answer = real.then(async (value) => {
      gitReadDelay.pending += 1;
      await new Promise<void>((resolveDelay) => {
        setTimeout(resolveDelay, delayMs);
      });
      gitReadDelay.pending -= 1;
      gitReadDelay.answered += 1;
      return value;
    });
    return Object.assign(answer, { child: real.child });
  };
  function execFile(...args: unknown[]): unknown {
    return Reflect.apply(actual.execFile, actual, args);
  }
  Object.defineProperty(execFile, promisify.custom, {
    value: (file: string, args: readonly string[], options: unknown) => {
      const mode = substitutionFor(file, args);
      if (mode === null) {
        const real = realPromised(file, args, options);
        return file === "/usr/bin/git" && gitReadDelay.delayMs > 0 ? answerLate(real) : real;
      }
      if (mode !== "hang") throw new Error("Only a hang substitutes a buffered git read.");
      const promise = realPromised("/bin/sh", HANG, options);
      substituted(promise.child);
      return promise;
    },
  });
  function spawn(file: string, args: readonly string[], options: unknown): ChildProcess {
    const mode = substitutionFor(file, args);
    if (mode === null) return Reflect.apply(actual.spawn, actual, [file, args, options]);
    if (mode === "hang") {
      const child = Reflect.apply(actual.spawn, actual, ["/bin/sh", HANG, options]) as ChildProcess;
      substituted(child);
      return child;
    }
    const child = Reflect.apply(actual.spawn, actual, [file, args, options]) as ChildProcess;
    const relay: Relay = { buffered: [], sourceEnded: false, out: new Relayed(), outEnded: false };
    child.stdout!.on("data", (chunk: Buffer) => relay.buffered.push(chunk));
    child.stdout!.on("end", () => {
      relay.sourceEnded = true;
    });
    // A killed child ends what the export reads, as its real stdout would.
    child.once("exit", (_code, signal) => {
      if (signal !== null && !relay.outEnded) {
        relay.outEnded = true;
        relay.out.end();
      }
    });
    Object.defineProperty(child, "stdout", {
      value: relay.out,
      writable: true,
      configurable: true,
    });
    gitProbe.relay = relay;
    substituted(child);
    return child;
  }
  return { ...actual, execFile, spawn };
});

import { RepositoryWorkspaceMaterializationError } from "../src/repository/workspace/contracts.js";
import { prepareRepositoryWorkspace } from "../src/repository/workspace/materialize.js";
import { initFixtureRepo } from "./helpers/git.js";
import { testTimeoutMs } from "./helpers/test-timeouts.js";

beforeEach(async () => {
  probeTemp.directory = await mkdtemp(join(tmpdir(), "docsfab-export-hang-"));
});

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const child of gitProbe.substituted) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
  gitProbe.substituted = [];
  gitProbe.substitution = null;
  gitProbe.relay = null;
  gitProbe.onSubstituted = null;
  gitReadDelay.delayMs = 0;
  gitReadDelay.pending = 0;
  gitReadDelay.answered = 0;
  fsProbe.lstatDelayMs = 0;
  fsProbe.pendingLstats = 0;
  fsProbe.delayedLstats = 0;
  const directory = probeTemp.directory;
  probeTemp.directory = null;
  if (directory !== null) await rm(directory, { recursive: true, force: true });
});

/** Fake the export's clock: timers and `performance.now` advance only on demand. */
function useExportClock(): void {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"], now: 0 });
  const origin = 1_000_000;
  vi.spyOn(performance, "now").mockImplementation(() => origin + Date.now());
}

/** Waits in real time, while the fake clock stands still, until `condition` holds. */
async function waitFor(condition: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 3_000; attempt += 1) {
    if (condition()) return;
    await new Promise<void>((resolveWait) => {
      realTimers.setTimeout(resolveWait, 5);
    });
  }
  throw new Error(`Timed out waiting for ${label}.`);
}

/** Lets promise chains and I/O callbacks that need no fake timer run. */
async function drainPendingWork(): Promise<void> {
  for (let turn = 0; turn < 20; turn += 1) {
    await new Promise<void>((resolveTurn) => {
      realTimers.setTimeout(resolveTurn, 1);
    });
  }
}

/** Releases up to `pieceBytes` of held git output, ending the stream once all of it is out. */
function releasePiece(relay: Relay, pieceBytes: number): void {
  let released = 0;
  while (released < pieceBytes && relay.buffered.length > 0) {
    const head = relay.buffered[0]!;
    const take = Math.min(head.length, pieceBytes - released);
    relay.out.write(head.subarray(0, take));
    if (take === head.length) relay.buffered.shift();
    else relay.buffered[0] = head.subarray(take);
    released += take;
  }
  if (relay.buffered.length === 0 && relay.sourceEnded && !relay.outEnded) {
    relay.outEnded = true;
    relay.out.end();
  }
}

/**
 * Feeds held git output to the export one piece per `stepMs` of fake time,
 * advancing the clock only once the export has read the previous piece and
 * more output is ready. Returns the fake time spent.
 */
async function relayUntilSettled(
  relay: Relay,
  pieceBytes: number,
  stepMs: number,
  settled: () => boolean,
): Promise<number> {
  let spentMs = 0;
  while (!settled()) {
    await waitFor(
      () =>
        settled() ||
        relay.outEnded ||
        (relay.out.readableLength === 0 && (relay.buffered.length > 0 || relay.sourceEnded)),
      "the export to read the last piece",
    );
    if (settled()) break;
    if (relay.outEnded) {
      await waitFor(settled, "the export to finish");
      break;
    }
    vi.advanceTimersByTime(stepMs);
    spentMs += stepMs;
    releasePiece(relay, pieceBytes);
  }
  return spentMs;
}

async function fixture(files: Record<string, string | Buffer>): Promise<string> {
  const repositoryPath = await mkdtemp(join(tmpdir(), "docsfab-export-hang-source-"));
  const text: Record<string, string> = {};
  for (const [path, content] of Object.entries(files)) {
    if (typeof content === "string") text[path] = content;
    else await writeFile(join(repositoryPath, path), content);
  }
  await initFixtureRepo(repositoryPath, { ...text, "README.md": "fixture\n" });
  return repositoryPath;
}

function pages(count: number): Record<string, string> {
  const files: Record<string, string> = {};
  for (let index = 0; index < count; index += 1) {
    files[`page-${String(index).padStart(3, "0")}.md`] = `page ${index}\n`;
  }
  return files;
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

/** Resolves once the child has exited and been reaped. */
function exited(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise<void>((resolveExit) => {
    child.once("exit", () => resolveExit());
  });
}

/** True once the operating system no longer knows the process. */
function processGone(child: ChildProcess): boolean {
  try {
    process.kill(child.pid!, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  }
}

async function scratchRoots(): Promise<string[]> {
  return (await readdir(probeTemp.directory!)).filter((name) =>
    name.startsWith("docsfab-workspace-"),
  );
}

describe("repository workspace export hang probes", () => {
  it.each([
    {
      call: "a preflight git read",
      match: (args: readonly string[]) => args.includes("--show-toplevel"),
      children: { started: 0, cancellationRequested: 0, reaped: 0 },
      signal: "SIGTERM",
    },
    {
      call: "the tree listing",
      match: (args: readonly string[]) => args.includes("ls-tree"),
      children: { started: 1, cancellationRequested: 1, reaped: 1 },
      signal: "SIGKILL",
    },
  ] as const)(
    "holds $call that never answers for exactly the window and stops it 1 ms later",
    async ({ match, children, signal }) => {
      const windowMs = 1_000;
      const sourcePath = await fixture(pages(2));
      useExportClock();
      try {
        const spawnedStandIn = new Promise<void>((resolveSpawned) => {
          gitProbe.onSubstituted = resolveSpawned;
        });
        gitProbe.substitution = { match, mode: "hang" };
        let settled = false;
        const outcome = captureMaterializationFailure(
          prepareRepositoryWorkspace(sourcePath, "HEAD", { limits: { maxStallMs: windowMs } }),
        ).finally(() => {
          settled = true;
        });
        await spawnedStandIn;
        vi.advanceTimersByTime(windowMs);
        await drainPendingWork();
        expect(settled).toBe(false);
        vi.advanceTimersByTime(1);
        await waitFor(() => settled, "the hung call to be stopped");
        const failure = await outcome;
        expect(failure.evidence).toMatchObject({
          code: "aggregate-timeout",
          phase: "preflight",
          quantity: {
            unit: "milliseconds",
            limit: String(windowMs),
            observed: String(windowMs + 1),
          },
          children,
        });
        // A buffered git read's abort sends SIGTERM and does not wait for the
        // child, so an unkillable child cannot hold the export; the listing's
        // stop sends SIGKILL and reaps it before the export fails.
        const child = gitProbe.substituted[0]!;
        await exited(child);
        expect(child.signalCode).toBe(signal);
        expect(processGone(child)).toBe(true);
        expect(await scratchRoots()).toEqual([]);
      } finally {
        await rm(sourcePath, { recursive: true, force: true });
      }
    },
    testTimeoutMs(30_000),
  );

  it(
    "finishes a preflight whose three git reads take 0.6 window each, 1.8 windows in all",
    async () => {
      const windowMs = 1_000;
      const readMs = (windowMs * 3) / 5;
      const sourcePath = await fixture(pages(2));
      useExportClock();
      try {
        // The top-level, configuration and revision reads each answer 0.6
        // window late. Together they outlast the window, so the export
        // finishes only if each finished read counts as progress.
        gitReadDelay.delayMs = readMs;
        let settled = false;
        const outcome = prepareRepositoryWorkspace(sourcePath, "HEAD", {
          limits: { maxStallMs: windowMs },
        }).finally(() => {
          settled = true;
        });
        let spentMs = 0;
        while (!settled) {
          await waitFor(() => settled || gitReadDelay.pending > 0, "the next slow git read");
          if (settled) break;
          const answered = gitReadDelay.answered;
          vi.advanceTimersByTime(readMs);
          spentMs += readMs;
          await waitFor(
            () => settled || gitReadDelay.answered > answered,
            "the slow git read to answer",
          );
        }
        const workspace = await outcome;
        try {
          expect(gitReadDelay.answered).toBe(3);
          expect(spentMs).toBe(3 * readMs);
          expect(await readFile(join(workspace.path, "page-001.md"), "utf8")).toBe("page 1\n");
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
    "keeps reading a tree listing that arrives one piece per quarter window, far past the window",
    async () => {
      const windowMs = 1_000;
      const sourcePath = await fixture(pages(40));
      useExportClock();
      try {
        const spawnedRelay = new Promise<void>((resolveSpawned) => {
          gitProbe.onSubstituted = resolveSpawned;
        });
        gitProbe.substitution = { match: (args) => args.includes("ls-tree"), mode: "relay" };
        let settled = false;
        const outcome = prepareRepositoryWorkspace(sourcePath, "HEAD", {
          limits: { maxStallMs: windowMs },
        }).finally(() => {
          settled = true;
        });
        await spawnedRelay;
        // About 3 KiB of listing at 64 bytes a piece: dozens of quarter-window
        // steps, every one of them progress.
        const spentMs = await relayUntilSettled(gitProbe.relay!, 64, windowMs / 4, () => settled);
        const workspace = await outcome;
        try {
          expect(spentMs).toBeGreaterThan(4 * windowMs);
          expect(await readFile(join(workspace.path, "page-039.md"), "utf8")).toBe("page 39\n");
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
    "keeps exporting one blob that streams one piece per quarter window, far past the window, with identical bytes",
    async () => {
      const windowMs = 1_000;
      const blob = randomBytes(4 * 1024 * 1024);
      const sourcePath = await fixture({ "large.bin": blob });
      useExportClock();
      try {
        const spawnedRelay = new Promise<void>((resolveSpawned) => {
          gitProbe.onSubstituted = resolveSpawned;
        });
        gitProbe.substitution = { match: (args) => args.includes("cat-file"), mode: "relay" };
        let settled = false;
        const outcome = prepareRepositoryWorkspace(sourcePath, "HEAD", {
          limits: { maxStallMs: windowMs },
        }).finally(() => {
          settled = true;
        });
        await spawnedRelay;
        // 4 MiB at 256 KiB a piece: one file streaming for about four windows,
        // which is progress only if each written piece counts.
        const spentMs = await relayUntilSettled(
          gitProbe.relay!,
          256 * 1024,
          windowMs / 4,
          () => settled,
        );
        const workspace = await outcome;
        try {
          expect(spentMs).toBeGreaterThan(3 * windowMs);
          const exported = await readFile(join(workspace.path, "large.bin"));
          expect(createHash("sha256").update(exported).digest("hex")).toBe(
            createHash("sha256").update(blob).digest("hex"),
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
    "keeps verifying a sweep whose every lstat takes a quarter window, far past the window",
    async () => {
      const windowMs = 1_000;
      const sourcePath = await fixture(pages(20));
      useExportClock();
      try {
        // Each exported-file lstat waits a quarter window on the fake clock. The
        // closing verification sweep is made only of finished lstat and
        // realpath steps, so each one must count as progress.
        fsProbe.lstatDelayMs = windowMs / 4;
        let settled = false;
        const outcome = prepareRepositoryWorkspace(sourcePath, "HEAD", {
          limits: { maxStallMs: windowMs },
        }).finally(() => {
          settled = true;
        });
        let spentMs = 0;
        while (!settled) {
          await waitFor(() => settled || fsProbe.pendingLstats > 0, "the next slow lstat");
          if (settled) break;
          vi.advanceTimersByTime(windowMs / 4);
          spentMs += windowMs / 4;
        }
        const workspace = await outcome;
        try {
          // Two slow lstats per file: one after its bytes are written, one in the sweep.
          expect(fsProbe.delayedLstats).toBeGreaterThanOrEqual(2 * 21);
          expect(spentMs).toBeGreaterThan(8 * windowMs);
        } finally {
          await workspace.dispose();
        }
      } finally {
        await rm(sourcePath, { recursive: true, force: true });
      }
    },
    testTimeoutMs(60_000),
  );
});
