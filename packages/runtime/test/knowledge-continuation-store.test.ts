// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { once } from "node:events";
import { spawn, type ChildProcessByStdio } from "node:child_process";
import { createHash } from "node:crypto";
import { access, chmod, mkdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { createInterface, type Interface } from "node:readline";
import type { Readable } from "node:stream";

import { afterEach, describe, expect, it } from "vitest";

import { inspectProcessBirth, requireProcessBirthIdentity } from "../src/init/storage.js";
import {
  KnowledgeContinuationAttemptStore,
  type KnowledgeContinuationClaimResult,
} from "../src/records/knowledge-continuation-store.js";
import { temporaryRoots } from "./helpers/temp.js";
import { nestedDeadlineMs, testTimeoutMs } from "./helpers/test-timeouts.js";

const fixture = resolve(
  dirname(new URL(import.meta.url).pathname),
  "fixtures/knowledge-continuation/journal-child.ts",
);
const roots = temporaryRoots();
// Local budgets of the cases that spawn journal children (the two-round race
// case gets twice the others); testTimeoutMs() scales them up in CI. Every
// wait nested inside such a case, in this file and in the child, takes a
// smaller share through nestedDeadlineMs(), so the wait's own message lands
// before the case times out, locally and in CI.
const JOURNAL_CASE_LOCAL_MS = 30_000;
const JOURNAL_RACE_CASE_LOCAL_MS = 60_000;
const JOURNAL_WAIT_LOCAL_MS = 25_000;
const JOURNAL_WAIT_MS = nestedDeadlineMs(JOURNAL_WAIT_LOCAL_MS, JOURNAL_CASE_LOCAL_MS);
type JournalChildProcess = ChildProcessByStdio<null, Readable, Readable>;
const children: JournalChildProcess[] = [];
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);

afterEach(async () => {
  const active = children.splice(0);
  for (const child of active) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
  }
  await Promise.all(
    active.map(async (child) => {
      if (child.exitCode === null && child.signalCode === null) await once(child, "exit");
    }),
  );
});

describe("knowledge continuation attempt journal", () => {
  it(
    "elects one active writer across real processes for same and different snapshots",
    async () => {
      for (const [leftSnapshot, rightSnapshot] of [
        [HASH_A, HASH_A],
        [HASH_A, HASH_B],
      ] as const) {
        const root = await roots.create("docsfab-journal-race-");
        const gate = join(root, "go");
        const left = await child(root, "race-left", leftSnapshot, gate, "claim", true);
        const right = await child(root, "race-right", rightSnapshot, gate, "claim", true);
        await writeFile(gate, "go\n", { mode: 0o600 });
        const [leftResult, rightResult] = await Promise.all([
          left.nextResult(),
          right.nextResult(),
        ]);
        const results = [leftResult.claim.disposition, rightResult.claim.disposition].sort();
        expect(results).toEqual(["busy", "claimed"]);
        expect(leftResult.claim.attempt.owner.processBirthIdentity).toMatch(/^[a-f0-9]{64}$/u);
        expect(rightResult.claim.attempt.owner.processBirthIdentity).toMatch(/^[a-f0-9]{64}$/u);
        await writeFile(left.release, "release\n", { mode: 0o600 });
        await writeFile(right.release, "release\n", { mode: 0o600 });
        await Promise.all([left.done(), right.done()]);

        const history = await new KnowledgeContinuationAttemptStore(root, {
          inspect: inspectJournalProcess,
        }).read("stopped-run");
        expect(history).toHaveLength(1);
        expect(history[0]!.sequence).toBe(1);
        expect(history[0]!.predecessorSha256).toBeNull();
        expect(history[0]!.journalSha256).toMatch(/^[a-f0-9]{64}$/u);
        expect(history[0]!.childRunId).toMatch(/^race-(left|right)$/u);
      }
    },
    testTimeoutMs(JOURNAL_RACE_CASE_LOCAL_MS),
  );

  it(
    "uses the exact classified predecessor for a concurrent CAS claim",
    async () => {
      const root = await roots.create("docsfab-journal-cas-");
      const gate = join(root, "go");
      const first = await child(root, "cas-first", HASH_A, gate, "claim", true);
      const second = await child(root, "cas-second", HASH_B, gate, "claim", true);
      await writeFile(gate, "go\n", { mode: 0o600 });
      const [firstResult, secondResult] = await Promise.all([
        first.nextResult(),
        second.nextResult(),
      ]);
      expect(
        [firstResult.claim.disposition, secondResult.claim.disposition].filter(
          (v) => v === "claimed",
        ),
      ).toHaveLength(1);
      await writeFile(first.release, "release\n", { mode: 0o600 });
      await writeFile(second.release, "release\n", { mode: 0o600 });
      await Promise.all([first.done(), second.done()]);
      const history = await new KnowledgeContinuationAttemptStore(root, {
        inspect: inspectJournalProcess,
      }).read("stopped-run");
      expect(history).toHaveLength(1);
      expect(history[0]!.predecessorSha256).toBeNull();
      expect(history[0]!.sequence).toBe(1);
    },
    testTimeoutMs(JOURNAL_CASE_LOCAL_MS),
  );

  it(
    "returns a journal child result emitted before the caller requests it",
    async () => {
      const root = await roots.create("docsfab-journal-result-buffer-");
      const gate = join(root, "go");
      const started = await child(root, "result-buffer", HASH_A, gate, "claim", true);
      const output = once(started.process.stdout, "data").then(() => "output" as const);
      const closed = once(started.process, "close");
      let goPublished = false;
      let observed:
        | { kind: "result"; value: ChildResult }
        | { kind: "error"; error: unknown }
        | { kind: "pending" };
      try {
        await writeFile(gate, "go\n", { mode: 0o600 });
        goPublished = true;
        expect(await Promise.race([output, closed.then(() => "closed" as const)])).toBe("output");
        const result = started.nextResult().then(
          (value) => ({ kind: "result" as const, value }),
          (error: unknown) => ({ kind: "error" as const, error }),
        );
        observed = await Promise.race([
          result,
          new Promise<{ kind: "pending" }>((resolve) =>
            setImmediate(() => resolve({ kind: "pending" })),
          ),
        ]);
      } finally {
        if (started.process.exitCode === null && started.process.signalCode === null) {
          if (goPublished) await writeFile(started.release, "release\n", { mode: 0o600 });
          else started.process.kill("SIGTERM");
        }
        await closed;
      }

      expect(observed).toMatchObject({
        kind: "result",
        value: { claim: { disposition: "claimed" } },
      });
    },
    testTimeoutMs(JOURNAL_CASE_LOCAL_MS),
  );

  it(
    "ignores private temporary bytes left by a real crash before atomic publication",
    async () => {
      const root = await roots.create("docsfab-journal-prepublish-crash-");
      const gate = join(root, "go");
      const crashed = await child(
        root,
        "prepublish-crash",
        HASH_A,
        gate,
        "crash-before-publication",
      );
      await writeFile(gate, "go\n", { mode: 0o600 });
      await once(crashed.process, "exit");
      expect(crashed.process.signalCode).toBe("SIGKILL");

      const store = new KnowledgeContinuationAttemptStore(root, {
        inspect: inspectJournalProcess,
      });
      const claimed = await store.claim({
        originalRunId: "stopped-run",
        snapshotSha256: HASH_B,
        deliveryIntentSha256: HASH_C,
        childRunId: "after-prepublish-crash",
        owner: currentOwner(),
      });
      expect(claimed.disposition).toBe("claimed");
      expect(await store.read("stopped-run")).toHaveLength(1);
    },
    testTimeoutMs(JOURNAL_CASE_LOCAL_MS),
  );

  it(
    "normalizes journal modes under a restrictive child-process umask",
    async () => {
      const root = await roots.create("docsfab-journal-umask-");
      const gate = join(root, "go");
      const writer = await child(root, "restrictive-umask", HASH_A, gate, "restrictive-umask");
      await writeFile(gate, "go\n", { mode: 0o600 });
      const result = await writer.nextResult();
      expect(result.claim.disposition).toBe("claimed");
      expect(result.transitions).toEqual(["failed-before-execution"]);
      await writer.done();
      const entries = await new KnowledgeContinuationAttemptStore(root, {
        inspect: inspectJournalProcess,
      }).read("stopped-run");
      expect(entries.map((entry) => entry.phase)).toEqual(["prepared", "failed-before-execution"]);
    },
    testTimeoutMs(JOURNAL_CASE_LOCAL_MS),
  );

  it(
    "reclassifies a deterministic stale empty read after another process publishes the claim",
    async () => {
      const root = await roots.create("docsfab-journal-stale-empty-");
      const firstGo = join(root, "first-go");
      const staleGo = join(root, "stale-go");
      const staleObserved = join(root, "stale-read-complete");
      const staleRelease = join(root, "stale-release");
      const first = await child(root, "stale-first", HASH_A, firstGo, "claim", true);
      const stale = await child(root, "stale-second", HASH_B, staleGo, "claim", true, {
        staleObserved,
        staleRelease,
      });

      await writeFile(staleGo, "go\n", { mode: 0o600 });
      await waitForPath(staleObserved, stale.process, []);
      await writeFile(firstGo, "go\n", { mode: 0o600 });
      const firstResult = await first.nextResult();
      expect(firstResult.claim.disposition).toBe("claimed");

      await writeFile(staleRelease, "release\n", { mode: 0o600 });
      const staleResult = await stale.nextResult();
      expect(staleResult.claim.disposition).toBe("busy");
      await first.done();
      await stale.done();

      const history = await new KnowledgeContinuationAttemptStore(root, {
        inspect: inspectJournalProcess,
      }).read("stopped-run");
      expect(history).toHaveLength(1);
      expect(history[0]!.childRunId).toBe("stale-first");
      expect(history[0]!.predecessorSha256).toBeNull();
    },
    testTimeoutMs(JOURNAL_CASE_LOCAL_MS),
  );

  it(
    "keeps a stale retryable predecessor from producing a second prepared claim",
    async () => {
      const root = await roots.create("docsfab-journal-stale-retryable-");
      const seedStore = new KnowledgeContinuationAttemptStore(root, {
        inspect: inspectJournalProcess,
      });
      const seed = await seedStore.claim({
        originalRunId: "stopped-run",
        snapshotSha256: HASH_A,
        deliveryIntentSha256: HASH_C,
        childRunId: "retry-seed",
        owner: currentOwner(),
        attemptId: "retry-seed-attempt",
      });
      expect(seed.disposition).toBe("claimed");
      await seedStore.transition({
        originalRunId: "stopped-run",
        attemptId: seed.attempt.attemptId,
        owner: currentOwner(),
        phase: "failed-before-execution",
      });

      const firstGo = join(root, "first-go");
      const secondGo = join(root, "second-go");
      const firstObserved = join(root, "first-read-complete");
      const secondObserved = join(root, "second-read-complete");
      const firstRelease = join(root, "first-release");
      const secondRelease = join(root, "second-release");
      const first = await child(root, "retry-first", HASH_B, firstGo, "claim", true, {
        staleObserved: firstObserved,
        staleRelease: firstRelease,
      });
      const second = await child(root, "retry-second", HASH_C, secondGo, "claim", true, {
        staleObserved: secondObserved,
        staleRelease: secondRelease,
      });
      await writeFile(firstGo, "go\n", { mode: 0o600 });
      await waitForPath(firstObserved, first.process, []);
      await writeFile(secondGo, "go\n", { mode: 0o600 });
      await waitForPath(secondObserved, second.process, []);
      await writeFile(firstRelease, "release\n", { mode: 0o600 });
      await writeFile(secondRelease, "release\n", { mode: 0o600 });
      const [firstResult, secondResult] = await Promise.all([
        first.nextResult(),
        second.nextResult(),
      ]);
      expect([firstResult.claim.disposition, secondResult.claim.disposition].sort()).toEqual([
        "busy",
        "claimed",
      ]);
      await first.done();
      await second.done();

      const history = await seedStore.read("stopped-run");
      expect(history.map((record) => record.phase)).toEqual([
        "prepared",
        "failed-before-execution",
        "prepared",
      ]);
      expect(history[2]!.predecessorSha256).toBe(history[1]!.journalSha256);
      expect(history[2]!.childRunId).toMatch(/^retry-(first|second)$/u);
    },
    testTimeoutMs(JOURNAL_CASE_LOCAL_MS),
  );

  it(
    "abandons a genuinely dead prepared owner and retries through the next CAS sequence",
    async () => {
      const root = await roots.create("docsfab-journal-dead-prepared-");
      const gate = join(root, "go");
      const dead = await child(root, "dead-prepared", HASH_A, gate, "claim");
      await writeFile(gate, "go\n", { mode: 0o600 });
      const deadResult = await dead.nextResult();
      expect(deadResult.claim.disposition).toBe("claimed");
      await dead.done();
      expect(inspectJournalProcess(deadResult.claim.attempt.owner.pid)).toEqual({ alive: false });

      const retry = new KnowledgeContinuationAttemptStore(root, { inspect: inspectJournalProcess });
      const result = await retry.claim({
        originalRunId: "stopped-run",
        snapshotSha256: HASH_B,
        deliveryIntentSha256: HASH_C,
        childRunId: "retry-child",
        owner: currentOwner(),
        attemptId: "retry-attempt",
      });
      expect(result.disposition).toBe("claimed");
      const history = await retry.read("stopped-run");
      expect(history.map((record) => record.phase)).toEqual([
        "prepared",
        "abandoned-before-execution",
        "prepared",
      ]);
      expect(history[1]!.predecessorSha256).toBe(history[0]!.journalSha256);
      expect(history[2]!.predecessorSha256).toBe(history[1]!.journalSha256);
      expect(history[0]!.childRunId).toBe("dead-prepared");
      expect(history[2]!.childRunId).toBe("retry-child");
    },
    testTimeoutMs(JOURNAL_CASE_LOCAL_MS),
  );

  it(
    "returns recovery-required for a dead executing owner and retains the old row",
    async () => {
      const root = await roots.create("docsfab-journal-dead-executing-");
      const gate = join(root, "go");
      const dead = await child(root, "dead-executing", HASH_A, gate, "executing");
      await writeFile(gate, "go\n", { mode: 0o600 });
      const result = await dead.nextResult();
      expect(result.claim.disposition).toBe("claimed");
      expect(result.transitions).toEqual(["executing"]);
      await dead.done();

      const store = new KnowledgeContinuationAttemptStore(root, { inspect: inspectJournalProcess });
      const recovery = await store.claim({
        originalRunId: "stopped-run",
        snapshotSha256: HASH_B,
        deliveryIntentSha256: HASH_C,
        childRunId: "recovery-child",
        owner: currentOwner(),
      });
      expect(recovery.disposition).toBe("recovery-required");
      expect((await store.read("stopped-run")).map((record) => record.phase)).toEqual([
        "prepared",
        "executing",
        "recovery-required",
      ]);
    },
    testTimeoutMs(JOURNAL_CASE_LOCAL_MS),
  );

  it(
    "requires recovery when an active owner identity is unknown",
    async () => {
      const root = await roots.create("docsfab-journal-unknown-owner-");
      const gate = join(root, "go");
      const active = await child(root, "unknown-owner", HASH_A, gate, "claim", true);
      await writeFile(gate, "go\n", { mode: 0o600 });
      const result = await active.nextResult();
      expect(result.claim.disposition).toBe("claimed");
      const store = new KnowledgeContinuationAttemptStore(root, {
        inspect: () => ({ alive: true }),
      });
      const recovery = await store.claim({
        originalRunId: "stopped-run",
        snapshotSha256: HASH_B,
        deliveryIntentSha256: HASH_C,
        childRunId: "unknown-recovery",
        owner: currentOwner(),
      });
      expect(recovery.disposition).toBe("recovery-required");
      await writeFile(active.release, "release\n", { mode: 0o600 });
      await active.done();
    },
    testTimeoutMs(JOURNAL_CASE_LOCAL_MS),
  );

  it(
    "detects definite PID reuse for a prepared owner and preserves its immutable row",
    async () => {
      const root = await roots.create("docsfab-journal-pid-reuse-");
      const gate = join(root, "go");
      const dead = await child(root, "pid-reused", HASH_A, gate, "claim");
      await writeFile(gate, "go\n", { mode: 0o600 });
      const first = await dead.nextResult();
      expect(first.claim.disposition).toBe("claimed");
      await dead.done();
      const store = new KnowledgeContinuationAttemptStore(root, {
        inspect: (pid) => ({ alive: pid === first.claim.attempt.owner.pid, identity: HASH_C }),
      });
      const retry = await store.claim({
        originalRunId: "stopped-run",
        snapshotSha256: HASH_B,
        deliveryIntentSha256: HASH_C,
        childRunId: "pid-retry",
        owner: currentOwner(),
      });
      expect(retry.disposition).toBe("claimed");
      expect((await store.read("stopped-run")).map((record) => record.phase)).toEqual([
        "prepared",
        "abandoned-before-execution",
        "prepared",
      ]);
    },
    testTimeoutMs(JOURNAL_CASE_LOCAL_MS),
  );

  it(
    "requires recovery when an owner disappears with an unknown live descendant",
    async () => {
      const root = await roots.create("docsfab-journal-descendant-");
      const gate = join(root, "go");
      const owner = await child(root, "descendant-owner", HASH_A, gate, "descendant");
      await writeFile(gate, "go\n", { mode: 0o600 });
      const result = await owner.nextResult();
      expect(result.claim.disposition).toBe("claimed");
      expect(result.transitions).toEqual(["executing"]);
      expect(result.descendantPid).toBeTypeOf("number");
      await owner.done();
      expect(inspectJournalProcess(result.claim.attempt.owner.pid)).toEqual({ alive: false });
      expect(inspectJournalProcess(result.descendantPid!)).toMatchObject({ alive: true });
      const store = new KnowledgeContinuationAttemptStore(root, { inspect: inspectJournalProcess });
      const recovery = await store.claim({
        originalRunId: "stopped-run",
        snapshotSha256: HASH_B,
        deliveryIntentSha256: HASH_C,
        childRunId: "descendant-recovery",
        owner: currentOwner(),
      });
      expect(recovery.disposition).toBe("recovery-required");
      process.kill(result.descendantPid!, "SIGTERM");
    },
    testTimeoutMs(JOURNAL_CASE_LOCAL_MS),
  );

  it(
    "reuses a completed writer result for a different snapshot without a second writer",
    async () => {
      const root = await roots.create("docsfab-journal-completed-");
      const gate = join(root, "go");
      const completed = await child(root, "completed-writer", HASH_A, gate, "settled");
      await writeFile(gate, "go\n", { mode: 0o600 });
      const result = await completed.nextResult();
      expect(result.claim.disposition).toBe("claimed");
      expect(result.transitions).toEqual(["executing", "writer-completed", "delivery-settled"]);
      await completed.done();
      const store = new KnowledgeContinuationAttemptStore(root, { inspect: inspectJournalProcess });
      const replay = await store.claim({
        originalRunId: "stopped-run",
        snapshotSha256: HASH_B,
        deliveryIntentSha256: HASH_C,
        childRunId: "must-not-write",
        owner: currentOwner(),
      });
      expect(replay.disposition).toBe("already-completed");
      expect(replay.attempt.childRunId).toBe("completed-writer");
      expect((await store.read("stopped-run")).map((record) => record.phase)).toEqual([
        "prepared",
        "executing",
        "writer-completed",
        "delivery-settled",
      ]);
    },
    testTimeoutMs(JOURNAL_CASE_LOCAL_MS),
  );

  it(
    "reuses a writer-completed child after the owner dies before delivery settlement",
    async () => {
      const root = await roots.create("docsfab-journal-writer-crash-");
      const gate = join(root, "go");
      const writer = await child(root, "writer-crash", HASH_A, gate, "writer-completed");
      await writeFile(gate, "go\n", { mode: 0o600 });
      const result = await writer.nextResult();
      expect(result.claim.disposition).toBe("claimed");
      expect(result.transitions).toEqual(["executing", "writer-completed"]);
      await writer.done();
      expect(inspectJournalProcess(result.claim.attempt.owner.pid)).toEqual({ alive: false });

      const store = new KnowledgeContinuationAttemptStore(root, { inspect: inspectJournalProcess });
      const replay = await store.claim({
        originalRunId: "stopped-run",
        snapshotSha256: HASH_B,
        deliveryIntentSha256: HASH_C,
        childRunId: "writer-replay",
        owner: currentOwner(),
      });
      expect(replay.disposition).toBe("already-completed");
      expect(replay.attempt.childRecordSha256).toBe(HASH_B);
      expect((await store.read("stopped-run")).map((record) => record.phase)).toEqual([
        "prepared",
        "executing",
        "writer-completed",
      ]);
    },
    testTimeoutMs(JOURNAL_CASE_LOCAL_MS),
  );

  it("rejects unsafe selectors, symlinked roots, and malformed journal entries", async () => {
    const root = await roots.create("docsfab-journal-safety-");
    const store = new KnowledgeContinuationAttemptStore(root, { inspect: inspectJournalProcess });
    await expect(store.read("../escape")).rejects.toMatchObject({ code: "unsafe-selector" });

    const linkedRoot = join(root, "linked");
    await symlink(join(root, "real"), linkedRoot);
    await expect(
      new KnowledgeContinuationAttemptStore(linkedRoot, { inspect: inspectJournalProcess }).read(
        "safe-run",
      ),
    ).rejects.toMatchObject({ code: "unsafe-root" });

    const safeRoot = join(root, "real");
    const safeStore = new KnowledgeContinuationAttemptStore(safeRoot, {
      inspect: inspectJournalProcess,
    });
    await safeStore.claim({
      originalRunId: "safe-run",
      snapshotSha256: HASH_A,
      deliveryIntentSha256: HASH_C,
      childRunId: "safe-child",
      owner: currentOwner(),
    });
    const entry = join(safeRoot, "safe-run.000000000001.json");
    const external = join(root, "external.json");
    await writeFile(external, "external\n", { mode: 0o600 });
    await rm(entry);
    await symlink(external, entry);
    await expect(safeStore.read("safe-run")).rejects.toMatchObject({ code: "unsafe-entry" });
    await rm(entry);
    await writeFile(entry, "{}\n", { mode: 0o600 });
    await expect(safeStore.read("safe-run")).rejects.toMatchObject({ code: "malformed-journal" });
  });

  it("keeps dotted original-run IDs isolated during journal discovery", async () => {
    const root = await roots.create("docsfab-journal-dotted-ids-");
    const store = new KnowledgeContinuationAttemptStore(root, { inspect: inspectJournalProcess });
    await store.claim({
      originalRunId: "run-a",
      snapshotSha256: HASH_A,
      deliveryIntentSha256: HASH_C,
      childRunId: "child-a",
      owner: currentOwner(),
    });
    await store.claim({
      originalRunId: "run-a.b",
      snapshotSha256: HASH_B,
      deliveryIntentSha256: HASH_C,
      childRunId: "child-a-b",
      owner: currentOwner(),
    });
    await expect(store.read("run-a")).resolves.toHaveLength(1);
    await expect(store.read("run-a.b")).resolves.toHaveLength(1);
  });

  it("rejects group-writable journal entries before decoding their contents", async () => {
    const root = await roots.create("docsfab-journal-private-mode-");
    const store = new KnowledgeContinuationAttemptStore(root, { inspect: inspectJournalProcess });
    await store.claim({
      originalRunId: "private-run",
      snapshotSha256: HASH_A,
      deliveryIntentSha256: HASH_C,
      childRunId: "private-child",
      owner: currentOwner(),
    });
    await chmod(join(root, "private-run.000000000001.json"), 0o660);
    await expect(store.read("private-run")).rejects.toMatchObject({ code: "unsafe-entry" });
  });

  it("rejects a user-controlled symlink ancestor before creating journal state", async () => {
    const parent = await roots.create("docsfab-journal-ancestor-");
    const real = join(parent, "real");
    const alias = join(parent, "alias");
    await mkdir(real, { mode: 0o700 });
    await symlink(real, alias);
    const store = new KnowledgeContinuationAttemptStore(join(alias, "journal"), {
      inspect: inspectJournalProcess,
    });
    await expect(
      store.claim({
        originalRunId: "ancestor-run",
        snapshotSha256: HASH_A,
        deliveryIntentSha256: HASH_C,
        childRunId: "ancestor-child",
        owner: currentOwner(),
      }),
    ).rejects.toMatchObject({ code: "unsafe-root" });
    await expect(access(join(real, "journal"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses a root identity swap before the atomic claim link", async () => {
    const parent = await roots.create("docsfab-journal-root-swap-");
    const root = join(parent, "journal");
    const moved = join(parent, "journal-moved");
    const store = new KnowledgeContinuationAttemptStore(
      root,
      { inspect: inspectJournalProcess },
      () => new Date("2026-09-14T00:00:00.000Z"),
      {
        beforeLink: async () => {
          await rename(root, moved);
          await mkdir(root, { mode: 0o700 });
        },
      },
    );
    await expect(
      store.claim({
        originalRunId: "swap-run",
        snapshotSha256: HASH_A,
        deliveryIntentSha256: HASH_C,
        childRunId: "swap-child",
        owner: currentOwner(),
      }),
    ).rejects.toMatchObject({ code: "unsafe-root" });
    await expect(access(join(root, "swap-run.000000000001.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});

interface ChildHandle {
  readonly release: string;
  readonly process: JournalChildProcess;
  nextResult(): Promise<ChildResult>;
  done(): Promise<void>;
}

interface ChildResult {
  claim: KnowledgeContinuationClaimResult;
  transitions?: string[];
  descendantPid?: number;
}

async function child(
  root: string,
  childRunId: string,
  snapshotSha256: string,
  go: string,
  action: string,
  hold = false,
  options: { staleObserved?: string; staleRelease?: string } = {},
): Promise<ChildHandle> {
  const ready = join(root, `${childRunId}.ready`);
  const release = join(root, `${childRunId}.release`);
  const childProcess = spawn(process.execPath, ["--import", "tsx", fixture], {
    cwd: resolve(dirname(fixture), "../../.."),
    env: {
      ...process.env,
      DOCSFAB_JOURNAL_ROOT: root,
      DOCSFAB_JOURNAL_ORIGINAL: "stopped-run",
      DOCSFAB_JOURNAL_SNAPSHOT: snapshotSha256,
      DOCSFAB_JOURNAL_DELIVERY: HASH_C,
      DOCSFAB_JOURNAL_CHILD: childRunId,
      DOCSFAB_JOURNAL_READY: ready,
      DOCSFAB_JOURNAL_GO: go,
      DOCSFAB_JOURNAL_RELEASE: hold ? release : "",
      DOCSFAB_JOURNAL_STALE_OBSERVED: options.staleObserved ?? "",
      DOCSFAB_JOURNAL_STALE_RELEASE: options.staleRelease ?? "",
      DOCSFAB_JOURNAL_ACTION: action,
      DOCSFAB_JOURNAL_WAIT_TIMEOUT_MS: String(JOURNAL_WAIT_MS),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(childProcess);
  const lines = createInterface({ input: childProcess.stdout });
  const errors: string[] = [];
  childProcess.stderr.setEncoding("utf8");
  childProcess.stderr.on("data", (chunk: string) => errors.push(chunk));
  const nextJsonResult = bufferJsonResults(lines, childProcess, errors);
  await waitForPath(ready, childProcess, errors);
  return {
    release,
    process: childProcess,
    nextResult: async () => nextJsonResult() as Promise<ChildResult>,
    done: async () => {
      if (childProcess.exitCode === null && childProcess.signalCode === null) {
        const exited = once(childProcess, "exit");
        if (hold) await writeFile(release, "release\n", { mode: 0o600 });
        await exited;
      }
      expect(childProcess.exitCode, errors.join("")).toBe(0);
      lines.close();
    },
  };
}

function bufferJsonResults(
  lines: Interface,
  childProcess: JournalChildProcess,
  errors: string[],
): () => Promise<unknown> {
  const bufferedLines: string[] = [];
  const waitingReaders: Array<(line: string | null) => void> = [];
  let closed = false;
  lines.on("line", (line: string) => {
    const waitingReader = waitingReaders.shift();
    if (waitingReader) waitingReader(line);
    else bufferedLines.push(line);
  });
  lines.on("close", () => {
    closed = true;
    while (waitingReaders.length > 0) waitingReaders.shift()!(null);
  });

  const nextLine = (): Promise<string | null> => {
    const line = bufferedLines.shift();
    if (line !== undefined) return Promise.resolve(line);
    if (closed) return Promise.resolve(null);
    return new Promise((resolve) => waitingReaders.push(resolve));
  };

  return async () => {
    for (;;) {
      const line = await nextLine();
      if (line === null)
        throw new Error(
          `child ${childProcess.pid ?? "unknown"} exited before result: ${errors.join("")}`,
        );
      if (!line.trim()) continue;
      try {
        return JSON.parse(line) as unknown;
      } catch {
        throw new Error(
          `child ${childProcess.pid ?? "unknown"} emitted invalid JSON: ${line}\n${errors.join("")}`,
        );
      }
    }
  };
}

/**
 * Polls every 5 ms until the child creates `path`, the child exits, or the
 * deadline passes, so a live child that never creates `path` cannot keep it
 * polling forever.
 */
async function waitForPath(
  path: string,
  childProcess: JournalChildProcess,
  errors: string[],
  timeoutMilliseconds = JOURNAL_WAIT_MS,
): Promise<void> {
  const deadline = Date.now() + timeoutMilliseconds;
  for (;;) {
    try {
      await access(path);
      return;
    } catch {
      if (childProcess.exitCode !== null)
        throw new Error(
          `child ${childProcess.pid ?? "unknown"} exited before ready: ${errors.join("")}`,
        );
      if (Date.now() > deadline)
        throw new Error(
          `child ${childProcess.pid ?? "unknown"} did not create ${path} within ${timeoutMilliseconds}ms (still running): ${errors.join("")}`,
        );
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
}

function currentOwner(): { pid: number; processBirthIdentity: string } {
  return { pid: process.pid, processBirthIdentity: processIdentity(process.pid) };
}

function processIdentity(pid: number): string {
  try {
    return requireProcessBirthIdentity(pid);
  } catch {
    return createHash("sha256").update(`docsfab-journal-child:${pid}`).digest("hex");
  }
}

function inspectJournalProcess(pid: number): { alive: boolean; identity?: string } {
  const observed = inspectProcessBirth(pid);
  return observed.alive && !observed.identity
    ? { alive: true, identity: processIdentity(pid) }
    : observed;
}

describe("journal wait deadlines (test harness, not product behavior)", () => {
  // Only `.exitCode` and `.pid` are read by `waitForPath`, so a stand-in
  // for a live child is enough to drive its polling on its own.
  function aliveChild(pid: number): JournalChildProcess {
    return { exitCode: null, signalCode: null, pid } as unknown as JournalChildProcess;
  }

  it("keeps each nested journal wait strictly inside its enclosing case budget, locally and in CI", () => {
    // The value the cases above use, in this run's environment.
    expect(JOURNAL_WAIT_MS).toBeLessThan(testTimeoutMs(JOURNAL_CASE_LOCAL_MS));
    for (const environment of [{}, { CI: "true" }]) {
      const wait = nestedDeadlineMs(JOURNAL_WAIT_LOCAL_MS, JOURNAL_CASE_LOCAL_MS, environment);
      expect(wait).toBeLessThan(testTimeoutMs(JOURNAL_CASE_LOCAL_MS, environment));
      expect(wait).toBeLessThan(testTimeoutMs(JOURNAL_RACE_CASE_LOCAL_MS, environment));
    }
  });

  it("returns once the child creates the path", async () => {
    const root = await roots.create("docsfab-wait-for-path-ok-");
    const marker = join(root, "marker");
    const pending = waitForPath(marker, aliveChild(1), []);
    setTimeout(() => {
      void writeFile(marker, "ready\n", { mode: 0o600 });
    }, 10);
    await pending;
  });

  // The child stays alive and the path never appears, so only the deadline
  // ends the wait.
  it("fails with its own message when a live child never creates the path", async () => {
    const root = await roots.create("docsfab-wait-for-path-timeout-");
    const marker = join(root, "never-created");
    await expect(waitForPath(marker, aliveChild(4242), [], 50)).rejects.toThrow(
      `child 4242 did not create ${marker} within 50ms (still running): `,
    );
  });

  // Runs the real fixture with only the environment it requires and the given
  // wait budget, and returns once its streams have closed, so all of its
  // stderr has arrived.
  async function runJournalChild(
    root: string,
    waitTimeout: string,
  ): Promise<{ code: number | null; stderr: string }> {
    const childProcess = spawn(process.execPath, ["--import", "tsx", fixture], {
      cwd: resolve(dirname(fixture), "../../.."),
      env: {
        ...process.env,
        DOCSFAB_JOURNAL_ROOT: root,
        DOCSFAB_JOURNAL_ORIGINAL: "stopped-run",
        DOCSFAB_JOURNAL_SNAPSHOT: HASH_A,
        DOCSFAB_JOURNAL_CHILD: "wait-deadline-child",
        DOCSFAB_JOURNAL_READY: join(root, "ready"),
        DOCSFAB_JOURNAL_GO: join(root, "never-written-go"),
        DOCSFAB_JOURNAL_WAIT_TIMEOUT_MS: waitTimeout,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    children.push(childProcess);
    let stderr = "";
    childProcess.stderr.setEncoding("utf8");
    childProcess.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    const [code] = (await once(childProcess, "close")) as [number | null];
    return { code, stderr };
  }

  // The parent never writes `go`, so the fixture's waitFor gives up after its
  // budget.
  it(
    "ends a journal child with its own message when the parent never writes go",
    async () => {
      const root = await roots.create("docsfab-journal-wait-timeout-");
      const result = await runJournalChild(root, "100");
      expect(result.code).toBe(1);
      expect(result.stderr).toContain(
        `journal-child timed out after 100ms waiting for ${join(root, "never-written-go")}`,
      );
    },
    testTimeoutMs(JOURNAL_CASE_LOCAL_MS),
  );

  // A budget that is not a positive integer would make the deadline never
  // fire, so the fixture refuses it by name before it writes its ready marker.
  it(
    "refuses a journal child wait budget that is not a positive integer",
    async () => {
      const root = await roots.create("docsfab-journal-wait-budget-");
      const result = await runJournalChild(root, "soon");
      expect(result.code).toBe(1);
      expect(result.stderr).toContain(
        "DOCSFAB_JOURNAL_WAIT_TIMEOUT_MS must be a positive integer millisecond budget, received soon",
      );
      await expect(access(join(root, "ready"))).rejects.toMatchObject({ code: "ENOENT" });
    },
    testTimeoutMs(JOURNAL_CASE_LOCAL_MS),
  );
});
