// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Workspace-evidence git commands run under two catalog limits (issue 1932):
 * `repository.evidenceGitTimeoutMs` and `repository.evidenceGitOutputMaxBytes`.
 * To hold one command at an exact elapsed time, the probe below swaps the
 * chosen evidence git subcommand for a real child that waits on stdin, so the
 * collector's own timer, kill, and refusal path runs against a live process.
 * `holdWith` picks that child:
 * - `cat` only waits;
 * - `lock` first takes the private repository's `index.lock` exclusively and
 *   fails as git does when the lock is already there;
 * - `lock-overflow` also writes 500 bytes to stderr;
 * - `grandchild` leaves a background `sleep` holding its pipes;
 * - `exit-on-input` exits 3 once stdin ends, and its `kill()` reports success
 *   without signalling, as for a child that has already exited when the timer
 *   fires.
 * The probe can also swap one subcommand for a shell that writes to stderr.
 * Every other command, and every non-evidence caller, runs real git unchanged.
 */
const gitProbe = vi.hoisted(() => ({
  holdSubcommand: null as null | string,
  holdWith: "cat" as "cat" | "lock" | "lock-overflow" | "grandchild" | "exit-on-input",
  /** Where the `grandchild` stand-in writes its background sleep's pid. */
  grandchildPidFile: null as null | string,
  held: null as null | ChildProcess,
  onHeld: null as null | (() => void),
  /** Swap this subcommand for a shell that writes `stderrBytes` spaces to stderr. */
  stderrSubcommand: null as null | string,
  stderrBytes: 0,
  calls: [] as { readonly args: readonly string[]; readonly options: Record<string, unknown> }[],
}));

/** Real timers, captured before any test fakes them, for waiting on real I/O. */
const realTimers = { setTimeout: globalThis.setTimeout };

const evidenceTemp = vi.hoisted(() => ({ directory: null as string | null }));

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, tmpdir: () => evidenceTemp.directory ?? actual.tmpdir() };
});

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  const { promisify } = await import("node:util");
  type Promised = Promise<unknown> & { child: ChildProcess };
  const realPromised = (actual.execFile as unknown as Record<symbol, unknown>)[
    promisify.custom
  ] as (file: string, args: readonly string[], options: Record<string, unknown>) => Promised;
  const isEvidenceGit = (args: readonly string[]): boolean =>
    args.some((arg) => arg.startsWith("--git-dir=") && arg.includes("docsfab-evidence-"));
  function execFile(...args: unknown[]): unknown {
    return Reflect.apply(actual.execFile, actual, args);
  }
  Object.defineProperty(execFile, promisify.custom, {
    value: (file: string, args: readonly string[], options: Record<string, unknown>) => {
      if (!isEvidenceGit(args)) return realPromised(file, args, options);
      gitProbe.calls.push({ args, options });
      if (gitProbe.stderrSubcommand !== null && args.includes(gitProbe.stderrSubcommand)) {
        gitProbe.stderrSubcommand = null;
        // One write of fewer than 512 bytes reaches the pipe whole.
        return realPromised(
          "/bin/sh",
          ["-c", `printf '%${gitProbe.stderrBytes}s' '' >&2`],
          options,
        );
      }
      const hold = gitProbe.holdSubcommand !== null && args.includes(gitProbe.holdSubcommand);
      if (!hold) return realPromised(file, args, options);
      gitProbe.holdSubcommand = null;
      const gitDirectory = args.find((arg) => arg.startsWith("--git-dir="))!.slice(10);
      const takeLock =
        'set -C; : > "$1/index.lock" || { echo "fatal: index.lock: File exists." >&2; exit 128; }';
      const stub: Record<typeof gitProbe.holdWith, readonly string[]> = {
        cat: ["/bin/cat"],
        lock: ["/bin/sh", "-c", `${takeLock}; exec /bin/cat`, "sh", gitDirectory],
        "lock-overflow": [
          "/bin/sh",
          "-c",
          `${takeLock}; printf '%500s' '' >&2; exec /bin/cat`,
          "sh",
          gitDirectory,
        ],
        grandchild: [
          "/bin/sh",
          "-c",
          '/bin/sleep 60 & echo $! > "$1"; exec /bin/cat',
          "sh",
          gitProbe.grandchildPidFile ?? "/dev/null",
        ],
        "exit-on-input": ["/bin/sh", "-c", "read line; exit 3"],
      };
      const [command, ...commandArgs] = stub[gitProbe.holdWith];
      const promise = realPromised(command!, commandArgs, options);
      if (gitProbe.holdWith === "exit-on-input") {
        Object.defineProperty(promise.child, "kill", { value: () => true });
      }
      gitProbe.held = promise.child;
      gitProbe.onHeld?.();
      return promise;
    },
  });
  return { ...actual, execFile };
});

import { matchBoundLiterals } from "../scripts/check-limits.mjs";
import { LIMIT_DEFINITION_BY_NAME } from "../src/config/limits.generated.js";
import { limitDefinition, type ResolvedLimit } from "../src/config/limits.js";
import {
  REPOSITORY_EVIDENCE_GIT_LIMITS,
  repositoryEvidenceGitLimits,
} from "../src/config/repository-evidence-limits.js";
import {
  formatOperatorErrorEnvelope,
  toOperatorErrorEnvelope,
} from "../src/operator/error-envelope.js";
import type { RunRecord } from "../src/records/contracts.js";
import {
  GitPatchEvidenceCollector,
  RepositoryEvidenceLimitError,
} from "../src/repository/evidence.js";
import { captureChanges } from "../src/workflow-execution/runner-evidence.js";
import { temporaryRoots } from "./helpers/temp.js";
import { testTimeoutMs } from "./helpers/test-timeouts.js";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const TIMEOUT_OVERRIDE = "DOCSFAB_REPOSITORY_EVIDENCE_GIT_TIMEOUT_MS";
const OUTPUT_OVERRIDE = "DOCSFAB_REPOSITORY_EVIDENCE_GIT_OUTPUT_MAX_BYTES";
const roots = temporaryRoots();
const savedOverrides = new Map<string, string | undefined>();

beforeEach(async () => {
  evidenceTemp.directory = await roots.create("docsfab-evidence-git-limits-");
  for (const name of [TIMEOUT_OVERRIDE, OUTPUT_OVERRIDE]) {
    savedOverrides.set(name, process.env[name]);
    delete process.env[name];
  }
});

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  gitProbe.held?.stdin?.end();
  gitProbe.held = null;
  gitProbe.holdSubcommand = null;
  gitProbe.holdWith = "cat";
  gitProbe.onHeld = null;
  // The grandchild stand-in's background sleep outlives its parent by design.
  const pidFile = gitProbe.grandchildPidFile;
  gitProbe.grandchildPidFile = null;
  if (pidFile !== null) {
    const pid = Number((await readFile(pidFile, "utf8").catch(() => "")).trim());
    if (Number.isInteger(pid) && pid > 0) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Already gone.
      }
    }
  }
  gitProbe.stderrSubcommand = null;
  gitProbe.stderrBytes = 0;
  gitProbe.calls = [];
  evidenceTemp.directory = null;
  for (const [name, value] of savedOverrides) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  savedOverrides.clear();
});

/** A workspace with one tracked page; a separate root holds patch artifacts. */
async function evidenceWorkspace(): Promise<{ workspace: string; artifacts: string }> {
  const root = await roots.create("docsfab-git-limits-workspace-");
  const workspace = join(root, "workspace");
  await mkdir(join(workspace, "docs"), { recursive: true });
  await writeFile(join(workspace, "docs", "guide.md"), "before\n");
  return { workspace, artifacts: join(root, "artifacts") };
}

function captureContext(workspacePath: string, persistPatch: boolean) {
  return {
    runId: "run-1932",
    workspacePath,
    persistPatch,
    repository: { sourcePath: "/source", requestedRevision: "HEAD", revision: "abc123" },
  };
}

async function evidenceScratchRoots(): Promise<string[]> {
  return (await readdir(evidenceTemp.directory!)).filter((name) =>
    name.startsWith("docsfab-evidence-"),
  );
}

/** Let promise chains that need no timer run to their next await. */
async function drainPendingWork(): Promise<void> {
  for (let turn = 0; turn < 10; turn += 1) {
    await new Promise<void>((resolveTurn) => setImmediate(resolveTurn));
  }
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

/** Fake the collector's clock: its timer and `performance.now` advance only on demand. */
function useEvidenceClock(): void {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"], now: 0 });
  const origin = 1_000_000;
  vi.spyOn(performance, "now").mockImplementation(() => origin + Date.now());
}

/** True when the args carry `-c <setting>` as one pair. */
function hasConfigPair(args: readonly string[], setting: string): boolean {
  return args.some((arg, index) => arg === "-c" && args[index + 1] === setting);
}

/** Resolves once the next evidence `git add` is swapped for the chosen stand-in. */
function holdNextAdd(holdWith: typeof gitProbe.holdWith = "cat"): Promise<void> {
  return new Promise<void>((resolveHeld) => {
    gitProbe.holdSubcommand = "add";
    gitProbe.holdWith = holdWith;
    gitProbe.onHeld = resolveHeld;
  });
}

/** The private evidence repository, read from the collector's first git call. */
function privateIndexLock(): string {
  const gitDirectory = gitProbe.calls[0]!.args.find((arg) => arg.startsWith("--git-dir="))!;
  return join(gitDirectory.slice("--git-dir=".length), "index.lock");
}

function runRecord(): RunRecord {
  return {
    id: "run-1932",
    repository: { sourcePath: "/source", requestedRevision: "HEAD", revision: "abc123" },
  } as unknown as RunRecord;
}

async function captureRefusal(operation: Promise<unknown>): Promise<RepositoryEvidenceLimitError> {
  try {
    await operation;
  } catch (error) {
    if (error instanceof RepositoryEvidenceLimitError) return error;
    throw error;
  }
  throw new Error("Expected an evidence git limit refusal.");
}

describe("workspace-evidence git limits", () => {
  it.each([
    { label: "the catalog default", override: undefined, limitMs: 600_000 },
    { label: "a host override that raises it", override: "3600000", limitMs: 3_600_000 },
    { label: "a host override that lowers it", override: "50", limitMs: 50 },
  ] as const)(
    "holds an evidence git add at exactly $limitMs ms under $label and stops it 1 ms later",
    async ({ override, limitMs }) => {
      if (override !== undefined) process.env[TIMEOUT_OVERRIDE] = override;
      const { workspace, artifacts } = await evidenceWorkspace();
      // The collector's timer and the clock it reads (`performance.now` from
      // node:perf_hooks) follow the fake clock, which stands still while the
      // real git commands around the held one run.
      useEvidenceClock();
      const holdNextAdd = (): Promise<void> =>
        new Promise<void>((resolveHeld) => {
          gitProbe.holdSubcommand = "add";
          gitProbe.onHeld = resolveHeld;
        });

      // At the limit: a command that finishes after exactly the limit holds.
      const admittedHeld = holdNextAdd();
      const admitted = GitPatchEvidenceCollector.create(workspace, artifacts);
      await admittedHeld;
      vi.advanceTimersByTime(limitMs);
      await drainPendingWork();
      gitProbe.held?.stdin?.end();
      const collector = await admitted;
      // Every finished command cleared its timer; a leaked one would keep the
      // CLI process alive for up to the whole limit after its work is done.
      expect(vi.getTimerCount()).toBe(0);
      await collector.dispose();

      // One millisecond past it: a command still running stops, coded and named.
      const stoppedHeld = holdNextAdd();
      let settled = false;
      const stopped = captureRefusal(
        GitPatchEvidenceCollector.create(workspace, artifacts),
      ).finally(() => {
        settled = true;
      });
      await stoppedHeld;
      vi.advanceTimersByTime(limitMs);
      await drainPendingWork();
      expect(settled).toBe(false);
      vi.advanceTimersByTime(1);
      await waitFor(() => settled, "the stopped evidence git to be refused");
      const refusal = await stopped;
      // The refusal comes only after the held child was killed and has exited.
      expect(gitProbe.held?.signalCode).toBe("SIGKILL");
      expect(vi.getTimerCount()).toBe(0);

      expect(refusal.code).toBe("repository-evidence-git-timeout-ms-bound");
      expect(refusal.limitName).toBe("repository.evidenceGitTimeoutMs");
      expect(refusal.configured).toBe(limitMs);
      expect(refusal.observed).toBe(limitMs + 1);
      expect(refusal.operation).toBe("add");
      expect(refusal.message).toBe(
        `repository-evidence-git-timeout-ms-bound: ${limitMs + 1} exceeds repository.evidenceGitTimeoutMs = ${limitMs} milliseconds. ${limitDefinition("repository.evidenceGitTimeoutMs").remediation} Follow the named remediation. Scope: git add while recording the run's workspace evidence.`,
      );
      // The failed baseline left no private evidence repository behind.
      expect(await evidenceScratchRoots()).toEqual([]);
    },
    testTimeoutMs(30_000),
  );

  it.each([
    { label: "the time measured when the stop fires late", clockShiftMs: 250, observed: 301 },
    { label: "the limit plus one when the clock reads early", clockShiftMs: -10, observed: 51 },
  ] as const)(
    "reports $label as the observed time of a stopped evidence git",
    async ({ clockShiftMs, observed }) => {
      process.env[TIMEOUT_OVERRIDE] = "50";
      const { workspace, artifacts } = await evidenceWorkspace();
      useEvidenceClock();
      const held = new Promise<void>((resolveHeld) => {
        gitProbe.holdSubcommand = "add";
        gitProbe.onHeld = resolveHeld;
      });
      let settled = false;
      const stopped = captureRefusal(
        GitPatchEvidenceCollector.create(workspace, artifacts),
      ).finally(() => {
        settled = true;
      });
      await held;
      // Move the clock the collector reads without moving its timer: a busy
      // event loop runs the timer late, and a coarse timer can run it while
      // the finer clock still reads the limit or less.
      vi.setSystemTime(Date.now() + clockShiftMs);
      vi.advanceTimersByTime(51);
      await waitFor(() => settled, "the stopped evidence git to be refused");
      const refusal = await stopped;
      expect(refusal.configured).toBe(50);
      expect(refusal.observed).toBe(observed);
      expect(refusal.message).toContain(
        `repository-evidence-git-timeout-ms-bound: ${observed} exceeds repository.evidenceGitTimeoutMs = 50 milliseconds.`,
      );
    },
    testTimeoutMs(30_000),
  );

  it(
    "admits patch output of exactly the output bound and stops one byte more, naming the bound",
    async () => {
      // Multibyte text, so a count of characters instead of bytes shows.
      const edited = "après l'été, ✓ déjà vu: ünïcödé ✓✓✓\n";
      expect(Buffer.byteLength(edited, "utf8") - edited.length).toBeGreaterThanOrEqual(15);
      const editedPatch = async (): Promise<number> => {
        const { workspace, artifacts } = await evidenceWorkspace();
        const collector = await GitPatchEvidenceCollector.create(workspace, artifacts);
        try {
          await writeFile(join(workspace, "docs", "guide.md"), edited);
          const evidence = await collector.capture(captureContext(workspace, true));
          return evidence.patch?.byteLength ?? 0;
        } finally {
          await collector.dispose();
        }
      };

      // The patch diff is the largest output of this run; its size is the bound to test.
      const patchBytes = await editedPatch();
      expect(patchBytes).toBeGreaterThan(64);

      process.env[OUTPUT_OVERRIDE] = String(patchBytes);
      await expect(editedPatch()).resolves.toBe(patchBytes);

      process.env[OUTPUT_OVERRIDE] = String(patchBytes - 1);
      const refusal = await captureRefusal(editedPatch());
      expect(refusal.code).toBe("repository-evidence-git-output-max-bytes-bound");
      expect(refusal.observed).toBe(patchBytes);
      expect(refusal.operation).toBe("diff");
      expect(refusal.message).toBe(
        `repository-evidence-git-output-max-bytes-bound: ${patchBytes} exceeds repository.evidenceGitOutputMaxBytes = ${patchBytes - 1} bytes. ${limitDefinition("repository.evidenceGitOutputMaxBytes").remediation} Follow the named remediation. Scope: git diff while recording the run's workspace evidence.`,
      );

      // Well under the output, the refusal still reports the bytes git actually
      // wrote (one small buffered write), not an invented limit plus one.
      process.env[OUTPUT_OVERRIDE] = "64";
      const farUnder = await captureRefusal(editedPatch());
      expect(farUnder.configured).toBe(64);
      expect(farUnder.observed).toBe(patchBytes);
    },
    testTimeoutMs(30_000),
  );

  it(
    "stops an evidence git that writes past the output bound on stderr and reports the stderr bytes",
    async () => {
      process.env[OUTPUT_OVERRIDE] = "64";
      const { workspace, artifacts } = await evidenceWorkspace();
      useEvidenceClock();
      gitProbe.stderrSubcommand = "add";
      gitProbe.stderrBytes = 500;
      const refusal = await captureRefusal(GitPatchEvidenceCollector.create(workspace, artifacts));
      // The overflow cleared its command's timer too.
      expect(vi.getTimerCount()).toBe(0);
      expect(refusal.code).toBe("repository-evidence-git-output-max-bytes-bound");
      expect(refusal.configured).toBe(64);
      expect(refusal.observed).toBe(500);
      expect(refusal.operation).toBe("add");
      expect(refusal.message).toContain(
        "repository-evidence-git-output-max-bytes-bound: 500 exceeds repository.evidenceGitOutputMaxBytes = 64 bytes.",
      );
      expect(await evidenceScratchRoots()).toEqual([]);
    },
    testTimeoutMs(30_000),
  );

  it.each([
    {
      stop: "the timer",
      holdWith: "lock",
      override: [TIMEOUT_OVERRIDE, "50"],
      code: "repository-evidence-git-timeout-ms-bound",
    },
    {
      stop: "an output overflow",
      holdWith: "lock-overflow",
      override: [OUTPUT_OVERRIDE, "400"],
      code: "repository-evidence-git-output-max-bytes-bound",
    },
  ] as const)(
    "refuses a git add stopped by $stop only once it is dead, releases its index.lock, and lets the next capture succeed",
    async ({ holdWith, override, code }) => {
      process.env[override[0]] = override[1];
      const { workspace, artifacts } = await evidenceWorkspace();
      useEvidenceClock();
      const collector = await GitPatchEvidenceCollector.create(workspace, artifacts);
      try {
        const lockPath = privateIndexLock();
        await writeFile(join(workspace, "docs", "guide.md"), "after\n");
        const held = holdNextAdd(holdWith);
        let atRefusal: undefined | { error: unknown; signal: string | null; lockLeft: boolean };
        void collector.capture(captureContext(workspace, true)).then(
          () => {
            atRefusal = {
              error: new Error("The capture was not stopped."),
              signal: null,
              lockLeft: false,
            };
          },
          (error: unknown) => {
            // Read in the same turn as the refusal: the child is already dead
            // and its lock already gone.
            atRefusal = {
              error,
              signal: gitProbe.held?.signalCode ?? null,
              lockLeft: existsSync(lockPath),
            };
          },
        );
        await held;
        if (holdWith === "lock") {
          await waitFor(() => existsSync(lockPath), "the stand-in to take index.lock");
          vi.advanceTimersByTime(51);
        }
        await waitFor(() => atRefusal !== undefined, "the stopped capture to be refused");
        expect(atRefusal!.error).toBeInstanceOf(RepositoryEvidenceLimitError);
        expect((atRefusal!.error as RepositoryEvidenceLimitError).code).toBe(code);
        expect(atRefusal!.signal).toBe("SIGKILL");
        expect(atRefusal!.lockLeft).toBe(false);
        expect(vi.getTimerCount()).toBe(0);
        // The stall cleared: the next capture runs real git and succeeds.
        const evidence = await collector.capture(captureContext(workspace, true));
        expect(evidence.files).toEqual([{ path: "docs/guide.md", status: "modified" }]);
      } finally {
        await collector.dispose();
      }
    },
    testTimeoutMs(30_000),
  );

  it.each([
    { label: "clears", stallsAgain: false },
    { label: "persists", stallsAgain: true },
  ] as const)(
    "keeps a run's final capture working after an earlier capture was stopped when the stall $label",
    async ({ stallsAgain }) => {
      process.env[TIMEOUT_OVERRIDE] = "50";
      const { workspace, artifacts } = await evidenceWorkspace();
      useEvidenceClock();
      const collector = await GitPatchEvidenceCollector.create(workspace, artifacts);
      try {
        const lockPath = privateIndexLock();
        await writeFile(join(workspace, "docs", "guide.md"), "after\n");
        const stopHeldAdd = async (held: Promise<void>): Promise<void> => {
          await held;
          await waitFor(() => existsSync(lockPath), "the stand-in to take index.lock");
          vi.advanceTimersByTime(51);
        };

        // An earlier capture, such as the runner's changed-files capture, is
        // stopped while it holds the lock, and the runner swallows the failure.
        let earlier: unknown;
        const firstHeld = holdNextAdd("lock");
        void collector.capture(captureContext(workspace, false)).catch((error: unknown) => {
          earlier = error;
        });
        await stopHeldAdd(firstHeld);
        await waitFor(() => earlier !== undefined, "the earlier capture to be refused");
        expect(earlier).toBeInstanceOf(RepositoryEvidenceLimitError);

        // The run's final capture.
        const record = runRecord();
        const secondHeld = stallsAgain ? holdNextAdd("lock") : undefined;
        let settled = false;
        const final = captureChanges({
          repositoryEvidence: collector,
          record,
          workspacePath: workspace,
          persistPatch: true,
        }).finally(() => {
          settled = true;
        });
        if (secondHeld !== undefined) await stopHeldAdd(secondHeld);
        await waitFor(() => settled, "the run's final capture to finish");
        const result = await final;
        if (stallsAgain) {
          expect(result).toEqual({ captured: false, provenanceRejected: false });
          expect(record.evidenceWarnings).toEqual([
            `Repository changes could not be preserved as a patch artifact. repository-evidence-git-timeout-ms-bound: 51 exceeds repository.evidenceGitTimeoutMs = 50 milliseconds. ${limitDefinition("repository.evidenceGitTimeoutMs").remediation} Follow the named remediation. Scope: git add while recording the run's workspace evidence.`,
          ]);
        } else {
          expect(result).toEqual({ captured: true, provenanceRejected: false });
          expect(record.changes?.files).toEqual([{ path: "docs/guide.md", status: "modified" }]);
          expect(record.evidenceWarnings).toBeUndefined();
        }
      } finally {
        await collector.dispose();
      }
    },
    testTimeoutMs(30_000),
  );

  it(
    "keeps an ordinary git failure that lands as the timer fires instead of reporting a timeout",
    async () => {
      process.env[TIMEOUT_OVERRIDE] = "50";
      const { workspace, artifacts } = await evidenceWorkspace();
      useEvidenceClock();
      const collector = await GitPatchEvidenceCollector.create(workspace, artifacts);
      try {
        await writeFile(join(workspace, "docs", "guide.md"), "after\n");
        const held = holdNextAdd("exit-on-input");
        let outcome: unknown;
        let settled = false;
        void collector
          .capture(captureContext(workspace, true))
          .then(
            () => {
              outcome = "resolved";
            },
            (error: unknown) => {
              outcome = error;
            },
          )
          .finally(() => {
            settled = true;
          });
        await held;
        // The timer fires and its kill() reports success, but the stand-in was
        // already on its way out and exits 3 on its own.
        vi.advanceTimersByTime(51);
        await drainPendingWork();
        expect(settled).toBe(false);
        gitProbe.held?.stdin?.end();
        await waitFor(() => settled, "the failed git add to settle");
        expect(outcome).not.toBeInstanceOf(RepositoryEvidenceLimitError);
        expect(outcome).toMatchObject({ code: 3 });
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        await collector.dispose();
      }
    },
    testTimeoutMs(30_000),
  );

  it(
    "refuses a stopped git add promptly while a grandchild still holds its pipes",
    async () => {
      process.env[TIMEOUT_OVERRIDE] = "50";
      const { workspace, artifacts } = await evidenceWorkspace();
      useEvidenceClock();
      const collector = await GitPatchEvidenceCollector.create(workspace, artifacts);
      try {
        await writeFile(join(workspace, "docs", "guide.md"), "after\n");
        const pidFile = join(evidenceTemp.directory!, "grandchild.pid");
        gitProbe.grandchildPidFile = pidFile;
        const held = holdNextAdd("grandchild");
        let refusal: unknown;
        void collector.capture(captureContext(workspace, true)).catch((error: unknown) => {
          refusal = error;
        });
        await held;
        await waitFor(() => existsSync(pidFile), "the grandchild to start");
        vi.advanceTimersByTime(51);
        // The grandchild sleeps 60 s with the pipes open; the refusal must not wait for it.
        await waitFor(() => refusal !== undefined, "the stopped git add to be refused");
        expect(refusal).toBeInstanceOf(RepositoryEvidenceLimitError);
      } finally {
        await collector.dispose();
      }
    },
    testTimeoutMs(30_000),
  );

  it(
    "turns off automatic gc and maintenance in every evidence git command",
    async () => {
      const { workspace, artifacts } = await evidenceWorkspace();
      const collector = await GitPatchEvidenceCollector.create(workspace, artifacts);
      try {
        await writeFile(join(workspace, "docs", "guide.md"), "after\n");
        await collector.capture(captureContext(workspace, true));
      } finally {
        await collector.dispose();
      }
      // init, three config writes, add, commit, rev-parse, then add and two diffs.
      expect(gitProbe.calls.length).toBeGreaterThanOrEqual(10);
      for (const { args } of gitProbe.calls) {
        expect(hasConfigPair(args, "gc.auto=0"), args.join(" ")).toBe(true);
        expect(hasConfigPair(args, "maintenance.auto=false"), args.join(" ")).toBe(true);
      }
    },
    testTimeoutMs(30_000),
  );

  it(
    "passes raised host overrides to every evidence git command",
    async () => {
      process.env[TIMEOUT_OVERRIDE] = "3600000";
      process.env[OUTPUT_OVERRIDE] = "104857600";
      const { workspace, artifacts } = await evidenceWorkspace();
      const collector = await GitPatchEvidenceCollector.create(workspace, artifacts);
      try {
        await writeFile(join(workspace, "docs", "guide.md"), "after\n");
        await collector.capture(captureContext(workspace, true));
      } finally {
        await collector.dispose();
      }
      const subcommands = gitProbe.calls.map(
        ({ args }) =>
          args.find(
            (arg, index) => index > 0 && !arg.startsWith("-") && args[index - 1] !== "-c",
          ) ?? "",
      );
      expect(subcommands).toEqual(expect.arrayContaining(["add", "commit", "diff"]));
      for (const { options } of gitProbe.calls) {
        expect(options.maxBuffer).toBe(104_857_600);
        expect(options.killSignal).toBe("SIGKILL");
        // The collector's own timer enforces the limit, not execFile's.
        expect(options.timeout).toBeUndefined();
      }
      expect(repositoryEvidenceGitLimits().timeoutMs).toMatchObject({
        value: 3_600_000,
        source: "host",
      });
      process.env[TIMEOUT_OVERRIDE] = "2147483647";
      await expect(GitPatchEvidenceCollector.create(workspace, artifacts)).rejects.toThrow(
        "DOCSFAB_REPOSITORY_EVIDENCE_GIT_TIMEOUT_MS must be an integer between 1 and 2147483646.",
      );
    },
    testTimeoutMs(30_000),
  );

  it("classifies a stop as bound and names the limit, observed value, and override", () => {
    const limit: ResolvedLimit = {
      ...limitDefinition("repository.evidenceGitTimeoutMs"),
      source: "config/limits.yaml",
    };
    const envelope = toOperatorErrorEnvelope(
      new RepositoryEvidenceLimitError(limit, 600_001, "add"),
    );
    expect(envelope.code).toBe("repository-evidence-git-timeout-ms-bound");
    expect(envelope.failure).toMatchObject({ class: "bound" });
    expect(envelope.message).toContain("600001 exceeds repository.evidenceGitTimeoutMs = 600000");
    expect(envelope.message).toContain("raise DOCSFAB_REPOSITORY_EVIDENCE_GIT_TIMEOUT_MS");
    expect(formatOperatorErrorEnvelope(envelope)).toContain("failure class: bound (layer cli)");
  });

  it("names the crossed limit in a run's evidence warning, and keeps other failures generic", async () => {
    const limit: ResolvedLimit = {
      ...limitDefinition("repository.evidenceGitOutputMaxBytes"),
      source: "config/limits.yaml",
    };
    const capture = async (error: Error) => {
      const record = {
        id: "run-1932",
        repository: { sourcePath: "/source", requestedRevision: "HEAD", revision: "abc123" },
      } as unknown as RunRecord;
      const result = await captureChanges({
        repositoryEvidence: {
          capture: async () => {
            throw error;
          },
        },
        record,
        workspacePath: "/workspace",
        persistPatch: true,
      });
      return { result, warnings: record.evidenceWarnings };
    };

    const limited = await capture(new RepositoryEvidenceLimitError(limit, 52_428_801, "diff"));
    expect(limited.result).toEqual({ captured: false, provenanceRejected: false });
    expect(limited.warnings).toEqual([
      `Repository changes could not be preserved as a patch artifact. repository-evidence-git-output-max-bytes-bound: 52428801 exceeds repository.evidenceGitOutputMaxBytes = ${limit.value} bytes. ${limit.remediation} Follow the named remediation. Scope: git diff while recording the run's workspace evidence.`,
    ]);
    // The run record admits warnings of at most 1,024 characters.
    expect(limited.warnings?.[0]?.length).toBeLessThanOrEqual(1_024);

    const generic = await capture(new Error("git exited 128"));
    expect(generic.warnings).toEqual([
      "Repository changes could not be preserved as a patch artifact.",
    ]);
  });

  it("declares both evidence git limits as raisable catalog limits with no allowlisted literal", async () => {
    for (const name of Object.values(REPOSITORY_EVIDENCE_GIT_LIMITS)) {
      const definition = LIMIT_DEFINITION_BY_NAME[name];
      expect(definition, name).toBeDefined();
      expect(definition!.scope, name).not.toBe("sealed");
      expect(definition!.override, name).toMatch(/^DOCSFAB_REPOSITORY_EVIDENCE_GIT_/u);
      expect(definition!.max, name).toBeGreaterThan(definition!.value);
      expect(definition!.min, name).toBeLessThan(definition!.value);
    }
    const source = "packages/runtime/src/repository/evidence.ts";
    const allowlist = JSON.parse(
      await readFile(
        join(repositoryRoot, "config/limits-allowlist/runtime.repository.json"),
        "utf8",
      ),
    ) as { literals: { path: string }[] };
    expect(allowlist.literals.filter((entry) => entry.path === source)).toEqual([]);
    expect(matchBoundLiterals(await readFile(join(repositoryRoot, source), "utf8"))).toEqual([]);
  });
});
