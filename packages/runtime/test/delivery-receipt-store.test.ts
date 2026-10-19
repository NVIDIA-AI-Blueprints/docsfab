// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import {
  chmod,
  link,
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  symlink,
  unlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";

import {
  FileScmDeliveryReceiptStore,
  authorizeLocalUserPublication,
  createScmDeliveryRecord,
  localUserGitIdentitySha256,
  localUserPublicationPlanSha256,
  recordScmDeliveryProgress,
  scmDeliveryRecordSha256,
  type LocalUserPublicationPlanV1,
  type LocalUserPublicationPlanV2,
} from "../src/delivery/index.js";
import { limit } from "../src/config/limits.js";
import { canonicalizeJsonEvidence, type JsonEvidenceValue } from "../src/json-evidence.js";
import {
  classifyReceiptHelperExit,
  RECEIPT_HELPER_REPORT_IMPORT,
  receiptHelperFailureReportSource,
} from "../src/delivery/receipt-helper-exit.js";
import { nestedDeadlineMs, testTimeoutMs, vitestDefaultTimeouts } from "./helpers/test-timeouts.js";
import { requireFreshDocumentationPlanForMutation } from "../src/delivery/contracts.js";
import {
  documentationValidationKit,
  selectDocumentationValidationProfile,
} from "../src/delivery/validation-profile.js";
import { temporaryRoots } from "./helpers/temp.js";

const temporary = temporaryRoots();
const NOW = "2026-08-04T12:00:00.000Z";
// Longer than a fixed 100 polls of 5 ms and well inside
// delivery.receiptPublicationSettleMs, so a slow writer is waited for.
const BEYOND_FORMER_SETTLE_MS = 750;
// Local budgets for the two-process lease case; CI scales both up together.
const LEASE_PROCESS_CASE_MS = 10_000;
const LEASE_PROCESS_MS = 8_000;
// Stalling cases run under the shared Vitest default budget. A stall waits for
// its resume file for at most this file's lease-process share of that budget
// (nestedDeadlineMs()), so an unresumed helper ends itself, with its own
// message, before the case times out.
const DEFAULT_CASE_LOCAL_MS = vitestDefaultTimeouts({}).testTimeout;
const STALL_LOCAL_MS = Math.floor(
  (DEFAULT_CASE_LOCAL_MS * LEASE_PROCESS_MS) / LEASE_PROCESS_CASE_MS,
);
const STALL_MS = nestedDeadlineMs(STALL_LOCAL_MS, DEFAULT_CASE_LOCAL_MS);
// A request larger than any pipe buffer, so a helper that never reads it breaks the pipe.
const LARGER_THAN_ANY_PIPE_BUFFER = 4 * 1024 * 1024;

afterEach(async () => {
  vi.unstubAllEnvs();
});

describe("SCM delivery receipt journal", () => {
  it("holds the receipt-root maintenance gate for the full claim mutation", async () => {
    const root = await directory();
    const { plan, authorization } = currentInputs();
    let entered!: () => void;
    let resume!: () => void;
    const reached = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const held = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const store = new FileScmDeliveryReceiptStore(root, {
      beforeJournalOperation: async (operation) => {
        if (operation === "claim") {
          entered();
          await held;
        }
      },
    });
    const record = createScmDeliveryRecord({ plan, authorization, createdAt: NOW });
    const claim = store.claim(record, plan);
    await reached;
    expect((await lstat(join(root, ".docsfab-run-maintenance.lock"))).isDirectory()).toBe(true);
    resume();
    expect((await claim).record.sha256).toBe(record.sha256);
    expect(await store.load(record.idempotencyKey)).toMatchObject({ sha256: record.sha256 });
  });

  it("holds the receipt-root maintenance gate through a paused CAS mutation", async () => {
    const root = await directory();
    const { plan, authorization } = currentInputs();
    let entered!: () => void;
    let resume!: () => void;
    const reached = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const held = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const store = new FileScmDeliveryReceiptStore(root, {
      beforeJournalOperation: async (operation) => {
        if (operation === "cas") {
          entered();
          await held;
        }
      },
    });
    const initial = createScmDeliveryRecord({ plan, authorization, createdAt: NOW });
    await store.claim(initial, plan);
    const prepared = recordScmDeliveryProgress(
      initial,
      {
        toState: "prepared",
        source: "executed",
        at: "2026-08-04T12:00:01.000Z",
        evidence: { workspaceKey: "e".repeat(64), baseRevision: plan.baseRevision },
      },
      plan,
      authorization,
    );
    const mutation = store.compareAndSwap(initial.sha256, prepared);
    await reached;
    expect((await lstat(join(root, ".docsfab-run-maintenance.lock"))).isDirectory()).toBe(true);
    resume();
    expect((await mutation).sha256).toBe(prepared.sha256);
    expect(await store.load(initial.idempotencyKey)).toMatchObject({ sha256: prepared.sha256 });
  });

  it("rejects a rehashed durable v2 result digest forgery", async () => {
    const root = await directory();
    const store = new FileScmDeliveryReceiptStore(root);
    const { plan, authorization } = currentInputs();
    let record = createScmDeliveryRecord({ plan, authorization, createdAt: NOW });
    record = recordScmDeliveryProgress(
      record,
      {
        toState: "prepared",
        source: "executed",
        at: "2026-08-04T12:01:00.000Z",
        evidence: { workspaceKey: "e".repeat(64), baseRevision: plan.baseRevision },
      },
      plan,
      authorization,
    );
    const results = plan.documentationValidation.checkIds.map((id) => ({
      id,
      status: "passed" as const,
    }));
    const candidateTreeSha256 = "c".repeat(64);
    record = recordScmDeliveryProgress(
      record,
      {
        toState: "validated",
        source: "executed",
        at: "2026-08-04T12:02:00.000Z",
        evidence: {
          commandSha256: digestText(plan.validationCommand),
          summarySha256: "f".repeat(64),
          checkCount: results.length,
          profileId: plan.documentationValidation.profileId,
          profileVersion: plan.documentationValidation.profileVersion,
          checkIds: [...plan.documentationValidation.checkIds],
          selectorInputSha256: plan.documentationValidation.selectorInputSha256,
          validatorIdentity: plan.documentationValidation.validatorIdentity,
          candidateTreeSha256,
          checkSetSha256: plan.documentationValidation.checkSetSha256,
          applicabilitySha256: plan.documentationValidation.applicabilitySha256,
          results,
          resultSha256: documentationValidationKit.canonicalDigest({
            results,
            stateSha256: "f".repeat(64),
            checkSetSha256: plan.documentationValidation.checkSetSha256,
            candidateTreeSha256,
            applicabilitySha256: plan.documentationValidation.applicabilitySha256,
          }),
        },
      },
      plan,
      authorization,
    );
    const forged = structuredClone(record);
    if (!forged.evidence.validation) throw new Error("missing validation fixture");
    forged.evidence.validation.resultSha256 = "9".repeat(64);
    const attempt = forged.attempts.at(-1);
    if (!attempt) throw new Error("missing validation attempt fixture");
    attempt.evidenceSha256 = digestJson(forged.evidence.validation as unknown as JsonEvidenceValue);
    forged.sha256 = scmDeliveryRecordSha256(forged);

    await expect(store.claim(forged, plan)).rejects.toMatchObject({ code: "receipt-invalid" });
  });

  it("requires fresh preflight before a stored historical v1 plan can mutate publication", () => {
    const { plan } = inputs();
    const selected = selectDocumentationValidationProfile({
      workflow: "update-documentation",
      changedPaths: ["docs/guide.md"],
      hostPolicySha256: "a".repeat(64),
    });
    const { sha256: _oldSha256, ...body } = plan;
    const historicalBody = {
      ...body,
      validationCommand: selected.entrypointCommand,
      documentationValidation: selected.binding,
    };
    const historical: LocalUserPublicationPlanV1 = {
      ...historicalBody,
      sha256: localUserPublicationPlanSha256(historicalBody),
    };
    expect(() => requireFreshDocumentationPlanForMutation(historical, true)).toThrow(
      "Run fresh preflight and confirm the new plan",
    );
    expect(() => requireFreshDocumentationPlanForMutation(historical, false)).not.toThrow();
    expect(() => requireFreshDocumentationPlanForMutation(historical, true, "failed")).toThrow(
      "Run fresh preflight and confirm the new plan",
    );
    expect(() =>
      requireFreshDocumentationPlanForMutation(historical, true, "succeeded"),
    ).not.toThrow();
    expect(() => requireFreshDocumentationPlanForMutation(plan, true, "active")).toThrow(
      "Run fresh preflight and confirm the new plan",
    );
  });

  it("rejects a receipt root reached through a symlinked ancestor", async () => {
    const parent = await directory();
    const actual = join(parent, "actual");
    const alias = join(parent, "alias");
    await mkdir(actual, { mode: 0o700 });
    await symlink(actual, alias);
    const { plan, authorization } = inputs();
    const initial = createScmDeliveryRecord({ plan, authorization, createdAt: NOW });
    await expect(
      new FileScmDeliveryReceiptStore(join(alias, "receipts")).claim(initial),
    ).rejects.toMatchObject({ code: "unsafe-root" });
    expect(await readdir(actual)).toEqual([]);
  });

  it("requires current authority at root, plan-bind, and initial-claim mutation boundaries", async () => {
    const parent = await directory();
    const missingRoot = join(parent, "missing-receipts");
    const { plan, authorization } = inputs();
    const initial = createScmDeliveryRecord({ plan, authorization, createdAt: NOW });
    await expect(
      new FileScmDeliveryReceiptStore(missingRoot).claim(initial, plan, () => {
        throw new Error("expired-before-root");
      }),
    ).rejects.toMatchObject({ code: "unsafe-root" });
    await expect(lstat(missingRoot)).rejects.toMatchObject({ code: "ENOENT" });

    const planRoot = join(parent, "plan-receipts");
    await mkdir(planRoot, { mode: 0o700 });
    let planAuthorized = true;
    const planStore = new FileScmDeliveryReceiptStore(planRoot, {
      beforePlanOperation: (operation) => {
        if (operation === "bind") planAuthorized = false;
      },
    });
    await expect(
      planStore.claim(initial, plan, () => {
        if (!planAuthorized) throw new Error("expired-before-plan-bind");
      }),
    ).rejects.toMatchObject({ code: "unsafe-root" });
    expect(await readdir(planRoot)).toEqual([]);

    const claimRoot = join(parent, "claim-receipts");
    await mkdir(claimRoot, { mode: 0o700 });
    let claimBoundaries = 0;
    const claimStore = new FileScmDeliveryReceiptStore(claimRoot);
    await expect(
      claimStore.claim(initial, plan, () => {
        claimBoundaries += 1;
        if (claimBoundaries === 2) throw new Error("expired-before-journal-create");
      }),
    ).rejects.toMatchObject({ code: "unsafe-root" });
    expect(await readdir(claimRoot)).toEqual([`plan-${plan.sha256}.json`]);

    const slotRoot = join(parent, "slot-receipts");
    await mkdir(slotRoot, { mode: 0o700 });
    let slotAuthorized = true;
    const slotStore = new FileScmDeliveryReceiptStore(slotRoot, {
      beforeJournalOperation: (operation) => {
        if (operation === "claim") slotAuthorized = false;
      },
    });
    await expect(
      slotStore.claim(initial, plan, () => {
        if (!slotAuthorized) throw new Error("expired-before-initial-slot");
      }),
    ).rejects.toMatchObject({ code: "unsafe-root" });
    const slotEntries = await readdir(slotRoot);
    expect(slotEntries).toContain(`plan-${plan.sha256}.json`);
    expect(slotEntries).toContain(initial.idempotencyKey);
    expect(await readdir(join(slotRoot, initial.idempotencyKey))).toEqual([]);
  });

  it("claims once, appends CAS slots, and preserves owner-only exact-link files", async () => {
    const root = await directory();
    const store = new FileScmDeliveryReceiptStore(root);
    const { plan, authorization } = inputs();
    const initial = createScmDeliveryRecord({ plan, authorization, createdAt: NOW });
    expect((await store.claim(initial, plan)).created).toBe(true);
    expect((await store.claim(initial)).created).toBe(false);
    expect(await store.loadPlan(plan.sha256)).toEqual(plan);
    const prepared = recordScmDeliveryProgress(
      initial,
      {
        toState: "prepared",
        source: "executed",
        at: "2026-08-04T12:00:01.000Z",
        evidence: { workspaceKey: "e".repeat(64), baseRevision: plan.baseRevision },
      },
      plan,
      authorization,
    );
    await store.compareAndSwap(initial.sha256, prepared);
    expect(await store.load(initial.idempotencyKey)).toEqual(prepared);
    const journal = join(root, initial.idempotencyKey);
    expect(await readdir(journal)).toEqual(["000000.json", "000001.json"]);
    expect((await lstat(root)).mode & 0o777).toBe(0o700);
    expect((await lstat(journal)).mode & 0o777).toBe(0o700);
    const planBinding = await lstat(join(root, `plan-${plan.sha256}.json`));
    expect(planBinding.mode & 0o777).toBe(0o600);
    expect(planBinding.nlink).toBe(1);
    for (const name of await readdir(journal)) {
      const stat = await lstat(join(journal, name));
      expect(stat.mode & 0o777).toBe(0o600);
      expect(stat.nlink).toBe(1);
    }
  });

  it("waits for exact plan and journal publication aliases to become single-link files", async () => {
    const root = await directory();
    const { plan, authorization } = inputs();
    const initial = createScmDeliveryRecord({ plan, authorization, createdAt: NOW });
    await new FileScmDeliveryReceiptStore(root).claim(initial, plan);

    const planName = `plan-${plan.sha256}.json`;
    const planAlias = join(
      root,
      publicationTemporary(planName, "11111111-1111-4111-8111-111111111111"),
    );
    const planLoser = join(
      root,
      publicationTemporary(planName, "22222222-2222-4222-8222-222222222222"),
    );
    await writeFile(planLoser, "loser\n", { mode: 0o600 });
    let releasePlan: Promise<void> | undefined;
    let planReleased = false;
    const planStore = new FileScmDeliveryReceiptStore(root, {
      beforePlanOperation: async (operation) => {
        if (operation !== "load") return;
        await link(join(root, planName), planAlias);
        releasePlan = delayedUnlink(planAlias, BEYOND_FORMER_SETTLE_MS).then(() => {
          planReleased = true;
        });
      },
    });
    try {
      await expect(planStore.loadPlan(plan.sha256)).resolves.toEqual(plan);
    } finally {
      await releasePlan;
    }
    expect(planReleased).toBe(true);
    await unlink(planLoser);

    const journal = join(root, initial.idempotencyKey);
    const slotName = "000000.json";
    const slotAlias = join(
      journal,
      publicationTemporary(slotName, "33333333-3333-4333-8333-333333333333"),
    );
    const slotLoser = join(
      journal,
      publicationTemporary(slotName, "44444444-4444-4444-8444-444444444444"),
    );
    await writeFile(slotLoser, "loser\n", { mode: 0o600 });
    let releaseSlot: Promise<void> | undefined;
    let slotReleased = false;
    const journalStore = new FileScmDeliveryReceiptStore(root, {
      beforeJournalOperation: async (operation) => {
        if (operation !== "load") return;
        await link(join(journal, slotName), slotAlias);
        releaseSlot = delayedUnlink(slotAlias, BEYOND_FORMER_SETTLE_MS).then(() => {
          slotReleased = true;
        });
      },
    });
    try {
      await expect(journalStore.load(initial.idempotencyKey)).resolves.toEqual(initial);
    } finally {
      await releaseSlot;
    }
    expect(slotReleased).toBe(true);
  });

  it("rejects persistent, mismatched, and other hardlinks for plans and journal slots", async () => {
    // A persistent alias is refused only after the settle budget; keep it short.
    vi.stubEnv("DOCSFAB_DELIVERY_RECEIPT_PUBLICATION_SETTLE_MS", "100");
    const root = await directory();
    const { plan, authorization } = inputs();
    const initial = createScmDeliveryRecord({ plan, authorization, createdAt: NOW });
    const store = new FileScmDeliveryReceiptStore(root);
    await store.claim(initial, plan);
    const planName = `plan-${plan.sha256}.json`;
    const planPath = join(root, planName);
    const journal = join(root, initial.idempotencyKey);
    const slotName = "000000.json";
    const slotPath = join(journal, slotName);

    const persistentPlan = join(
      root,
      publicationTemporary(planName, "55555555-5555-4555-8555-555555555555"),
    );
    await link(planPath, persistentPlan);
    await expect(store.loadPlan(plan.sha256)).rejects.toMatchObject({ code: "receipt-invalid" });
    await unlink(persistentPlan);
    const persistentSlot = join(
      journal,
      publicationTemporary(slotName, "66666666-6666-4666-8666-666666666666"),
    );
    await link(slotPath, persistentSlot);
    await expect(store.load(initial.idempotencyKey)).rejects.toMatchObject({
      code: "receipt-invalid",
    });
    await unlink(persistentSlot);

    const otherPlanLink = join(root, "plan-other-hardlink");
    const mismatchedPlanAlias = join(
      root,
      publicationTemporary(planName, "77777777-7777-4777-8777-777777777777"),
    );
    await link(planPath, otherPlanLink);
    await writeFile(mismatchedPlanAlias, "mismatch\n", { mode: 0o600 });
    await expect(store.loadPlan(plan.sha256)).rejects.toMatchObject({ code: "receipt-invalid" });
    await Promise.all([unlink(otherPlanLink), unlink(mismatchedPlanAlias)]);

    const otherSlotLink = join(root, "slot-other-hardlink");
    const mismatchedSlotAlias = join(
      journal,
      publicationTemporary(slotName, "88888888-8888-4888-8888-888888888888"),
    );
    await link(slotPath, otherSlotLink);
    await writeFile(mismatchedSlotAlias, "mismatch\n", { mode: 0o600 });
    await expect(store.load(initial.idempotencyKey)).rejects.toMatchObject({
      code: "receipt-invalid",
    });
    await Promise.all([unlink(otherSlotLink), unlink(mismatchedSlotAlias)]);
  });

  it("allows exactly one concurrent different CAS writer", async () => {
    const root = await directory();
    const first = new FileScmDeliveryReceiptStore(root);
    const second = new FileScmDeliveryReceiptStore(root);
    const { plan, authorization } = inputs();
    const initial = createScmDeliveryRecord({ plan, authorization, createdAt: NOW });
    await first.claim(initial);
    const a = recordScmDeliveryProgress(
      initial,
      {
        toState: "prepared",
        source: "executed",
        at: "2026-08-04T12:00:01.000Z",
        evidence: { workspaceKey: "a".repeat(64), baseRevision: plan.baseRevision },
      },
      plan,
      authorization,
    );
    const b = recordScmDeliveryProgress(
      initial,
      {
        toState: "prepared",
        source: "executed",
        at: "2026-08-04T12:00:02.000Z",
        evidence: { workspaceKey: "b".repeat(64), baseRevision: plan.baseRevision },
      },
      plan,
      authorization,
    );
    const results = await Promise.allSettled([
      first.compareAndSwap(initial.sha256, a),
      second.compareAndSwap(initial.sha256, b),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect([a.sha256, b.sha256]).toContain((await first.load(initial.idempotencyKey))?.sha256);
  });

  it("serializes MR creation across store instances and releases after an interrupted action", async () => {
    const root = await directory();
    const first = new FileScmDeliveryReceiptStore(root);
    const second = new FileScmDeliveryReceiptStore(root);
    const key = "f".repeat(64);
    const orphan = join(root, `.${key}.merge-request.lock`);
    await mkdir(orphan, { mode: 0o700 });
    const old = new Date(Date.now() - 10_000);
    await utimes(orphan, old, old);
    await expect(first.withMergeRequestLease(key, async () => "stale-recovered")).resolves.toBe(
      "stale-recovered",
    );
    let active = 0;
    let maximum = 0;
    const action = async () => {
      active += 1;
      maximum = Math.max(maximum, active);
      await new Promise<void>((resolveWait) => setTimeout(resolveWait, 75));
      active -= 1;
    };
    await Promise.all([
      first.withMergeRequestLease(key, action),
      second.withMergeRequestLease(key, action),
    ]);
    expect(maximum).toBe(1);
    await expect(
      first.withMergeRequestLease(key, async () => {
        throw new Error("crash-before-post");
      }),
    ).rejects.toThrow("crash-before-post");
    await expect(second.withMergeRequestLease(key, async () => "recovered")).resolves.toBe(
      "recovered",
    );
  });

  it("publishes complete owner bytes before a contender can observe the owner name", async () => {
    const root = await directory();
    const key = "c".repeat(64);
    const lock = `.${key}.merge-request.lock`;
    const worker = await mergeRequestLeaseWorkerSource();
    const workerPath = join(root, "lease-worker.mjs");
    const observation = join(root, "publication-observation.json");
    await writeFile(workerPath, worker, { mode: 0o600 });
    const shim = join(root, "schedule-contender.mjs");
    await writeFile(
      shim,
      `import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
const open = fs.openSync;
fs.openSync = function(name, flags, ...args) {
  const fd = open.call(fs, name, flags, ...args);
  if ((flags & fs.constants.O_CREAT) &&
      (name === ${JSON.stringify(`${lock}/owner.json`)} || name === ".owner." + process.env.DOCSFAB_RECEIPT_LEASE_ID + ".tmp")) {
    let ownerBytes = null;
    try { ownerBytes = fs.statSync(${JSON.stringify(join(root, lock, "owner.json"))}).size; }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    const contender = spawnSync(process.execPath, [${JSON.stringify(workerPath)}], {
      cwd: ${JSON.stringify(root)}, env: { ...process.env, DOCSFAB_RECEIPT_LEASE_ID: "b".repeat(64) },
      input: "", encoding: "utf8"
    });
    fs.writeFileSync(${JSON.stringify(observation)}, JSON.stringify({
      ownerBytes, status: contender.status, signal: contender.signal,
      stdout: contender.stdout, stderr: contender.stderr
    }), { mode: 0o600 });
  }
  return fd;
};
syncBuiltinESMExports();
`,
      { mode: 0o600 },
    );
    const result = await runMergeRequestLeaseWorker(root, key, worker, shim);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toMatch(/^READY /u);
    const observed = JSON.parse(await readFile(observation, "utf8"));
    expect(observed).toMatchObject({ ownerBytes: null, status: 0, signal: null, stderr: "" });
    expect(observed.stdout).toMatch(/^READY /u);
    await expect(lstat(join(root, lock))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("recovers interrupted owner publication and refuses unrelated staging or malformed owners", async () => {
    const worker = await mergeRequestLeaseWorkerSource();
    const departed = spawnSync(
      process.execPath,
      ["-e", "process.stdout.write(String(process.pid))"],
      {
        encoding: "utf8",
        env: { LC_ALL: "C", LANG: "C" },
      },
    );
    expect(departed.status).toBe(0);
    const deadPid = Number(departed.stdout);
    expect(() => process.kill(deadPid, 0)).toThrow();
    for (const state of [
      "pending-only",
      "linked-owner",
      "unrelated-pending",
      "symlink-pending",
      "external-hardlink",
      "malformed-owner",
    ] as const) {
      const root = await directory();
      const key = "c".repeat(64);
      const lock = join(root, `.${key}.merge-request.lock`);
      const pending = join(
        lock,
        state === "unrelated-pending" ? "unrelated.pending" : `.owner.${"a".repeat(64)}.tmp`,
      );
      const owner = join(lock, "owner.json");
      await mkdir(lock, { mode: 0o700 });
      const bytes = JSON.stringify({
        schemaVersion: 1,
        key,
        leaseId: "a".repeat(64),
        pid: deadPid,
      });
      if (state === "pending-only") await writeFile(pending, "", { mode: 0o600 });
      else if (state === "linked-owner") {
        await writeFile(pending, bytes, { mode: 0o600 });
        await link(pending, owner);
      } else if (state === "malformed-owner") await writeFile(owner, "{", { mode: 0o600 });
      else {
        const other = join(root, "unrelated");
        await writeFile(other, "unrelated", { mode: 0o600 });
        if (state === "symlink-pending") await symlink(other, pending);
        else if (state === "external-hardlink") await link(other, pending);
        else {
          await writeFile(owner, bytes, { mode: 0o600 });
          await writeFile(pending, bytes, { mode: 0o600 });
        }
      }
      const old = new Date(Date.now() - 10_000);
      await utimes(lock, old, old);
      const result = await runMergeRequestLeaseWorker(root, key, worker);
      const recoverable = state === "pending-only" || state === "linked-owner";
      if (recoverable) {
        expect(result.status, `${state}: ${result.stderr}`).toBe(0);
        expect(result.stdout).toMatch(/^READY /u);
        expect((await readdir(root)).filter((name) => name.includes("merge-request.lock"))).toEqual(
          [],
        );
      } else {
        expect(result.status, state).not.toBe(0);
        expect(result.status, state).not.toBe(3);
        expect(result.stdout, state).toBe("");
        if (state === "malformed-owner") expect(await readFile(owner, "utf8")).toBe("{");
        else expect(await readFile(join(root, "unrelated"), "utf8")).toBe("unrelated");
      }
    }
  });

  it("keeps a prepared private generation from replacing a live canonical owner", async () => {
    const root = await directory();
    const key = "c".repeat(64);
    const lock = join(root, `.${key}.merge-request.lock`);
    const worker = await mergeRequestLeaseWorkerSource();
    const shim = join(root, "pause-before-publication.mjs");
    await writeFile(
      shim,
      `import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
const open = fs.openSync, close = fs.closeSync;
let stagedFd;
fs.openSync = function(name, ...args) {
  const fd = open.call(fs, name, ...args);
  if (name === ".owner." + process.env.DOCSFAB_RECEIPT_LEASE_ID + ".tmp") stagedFd = fd;
  return fd;
};
fs.closeSync = function(fd) {
  close.call(fs, fd);
  if (fd === stagedFd) {
    stagedFd = undefined;
    fs.writeSync(3, Buffer.from("P"));
    const gate = Buffer.alloc(1);
    if (fs.readSync(4, gate, 0, 1, null) !== 1) throw new Error("publication fixture gate closed");
  }
};
syncBuiltinESMExports();
`,
      { mode: 0o600 },
    );
    const environment = await mergeRequestLeaseEnvironment(root, key);
    const publisher = spawn(
      process.execPath,
      ["--import", pathToFileURL(shim).href, "--input-type=module", "-e", worker],
      { cwd: root, env: environment, stdio: ["pipe", "pipe", "pipe", "pipe", "pipe"] },
    );
    const publisherClosed = once(publisher, "close");
    const publisherOutput: Buffer[] = [];
    publisher.stdout?.on("data", (bytes: Buffer) => publisherOutput.push(bytes));
    publisher.stderr?.resume();
    let contender: ReturnType<typeof spawn> | undefined;
    let contenderClosed: ReturnType<typeof once> | undefined;
    try {
      const paused = publisher.stdio[3];
      const release = publisher.stdio[4];
      if (!paused || !release || !("end" in release)) throw new Error("missing fixture pipes");
      await once(paused, "data");
      const [candidate] = (await readdir(root)).filter((name) => name.includes(".candidate-"));
      expect(candidate).toBeDefined();
      const held = await lstat(join(root, candidate!));
      await expect(lstat(lock)).rejects.toMatchObject({ code: "ENOENT" });
      contender = spawn(process.execPath, ["--input-type=module", "-e", worker], {
        cwd: root,
        env: { ...environment, DOCSFAB_RECEIPT_LEASE_ID: "a".repeat(64) },
        stdio: ["pipe", "pipe", "pipe"],
      });
      contenderClosed = once(contender, "close");
      contender.stderr?.resume();
      if (!contender.stdout) throw new Error("missing contender output");
      const [ready] = await once(contender.stdout, "data");
      expect(ready.toString()).toMatch(/^READY /u);
      const replacement = await lstat(lock);
      expect(replacement.ino).not.toBe(held.ino);
      const ownerBytes = await readFile(join(lock, "owner.json"));
      release.end("1");
      const [code] = await publisherClosed;
      expect(code).toBe(3);
      expect(Buffer.concat(publisherOutput).toString()).toBe("");
      expect(await readFile(join(lock, "owner.json"))).toEqual(ownerBytes);
      expect((await lstat(lock)).ino).toBe(replacement.ino);
      contender.stdin?.end("1");
      expect((await contenderClosed)[0]).toBe(0);
    } finally {
      for (const child of [publisher, contender]) {
        if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      }
      await Promise.allSettled([publisherClosed, ...(contenderClosed ? [contenderClosed] : [])]);
    }
  });

  it("keeps a complete successor canonical when a missing-owner reaper resumes", async () => {
    const worker = await mergeRequestLeaseWorkerSource();
    for (const schedule of ["after-missing-owner", "after-pending-inspection"] as const) {
      const root = await directory();
      const key = "c".repeat(64);
      const lock = join(root, `.${key}.merge-request.lock`);
      await mkdir(lock, { mode: 0o700 });
      if (schedule === "after-pending-inspection") {
        await writeFile(join(lock, `.owner.${"b".repeat(64)}.tmp`), "", { mode: 0o600 });
      }
      const old = new Date(Date.now() - 10_000);
      await utimes(lock, old, old);
      const resume = join(root, "resume-reaper");
      const shim = join(root, "pause-reaper.mjs");
      await writeFile(
        shim,
        `import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
const pause = () => {
  process.stderr.write("PAUSED\\n");
  ${stallUntilSource(resume)}
};
const open = fs.openSync, lstat = fs.lstatSync;
fs.openSync = function(name, ...args) {
  try { return open.call(fs, name, ...args); }
  catch (error) {
    if (${JSON.stringify(schedule)} === "after-missing-owner" && String(name).endsWith("/owner.json") && error.code === "ENOENT") pause();
    throw error;
  }
};
fs.lstatSync = function(name, ...args) {
  const stat = lstat.call(fs, name, ...args);
  if (${JSON.stringify(schedule)} === "after-pending-inspection" && String(name).endsWith("/.owner." + "b".repeat(64) + ".tmp")) pause();
  return stat;
};
syncBuiltinESMExports();
`,
        { mode: 0o600 },
      );
      const reaper = await leaseWorkerProcess(root, worker, key, "b".repeat(64), shim);
      let publisher: Awaited<ReturnType<typeof leaseWorkerProcess>> | undefined;
      try {
        await reaper.marker("stderr", "PAUSED\n");
        publisher = await leaseWorkerProcess(root, worker, key, "a".repeat(64));
        await publisher.marker("stdout", "\n");
        expect(publisher.stdout()).toMatch(/^READY /u);
        const held = await lstat(lock);
        const bytes = await readFile(join(lock, "owner.json"));
        await writeFile(resume, "");
        expect(await reaper.closed).toBe(3);
        expect((await lstat(lock)).ino).toBe(held.ino);
        expect(await readFile(join(lock, "owner.json"))).toEqual(bytes);
        expect((await runMergeRequestLeaseWorker(root, key, worker)).status).toBe(3);
        publisher.child.stdin.end("1");
        expect(await publisher.closed).toBe(0);
        await expect(lstat(lock)).rejects.toMatchObject({ code: "ENOENT" });
      } finally {
        reaper.child.kill("SIGKILL");
        publisher?.child.kill("SIGKILL");
        await Promise.allSettled([reaper.closed, ...(publisher ? [publisher.closed] : [])]);
      }
    }
  });

  it("retries only ENOENT when a missing-owner lock is released during inspection", async () => {
    const worker = await mergeRequestLeaseWorkerSource();
    for (const point of ["after-owner-miss", "before-readdir", "before-temporary-lstat"] as const) {
      const root = await directory();
      const key = "c".repeat(64);
      const lockName = `.${key}.merge-request.lock`;
      const lock = join(root, lockName);
      const temporaryName = `.owner.${"b".repeat(64)}.tmp`;
      await mkdir(lock, { mode: 0o700 });
      if (point === "before-temporary-lstat") {
        await writeFile(join(lock, temporaryName), "", { mode: 0o600 });
      }
      const resume = join(root, `resume-${point}`);
      const shim = join(root, `pause-${point}.mjs`);
      await writeFile(
        shim,
        `import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
const lockName = ${JSON.stringify(lockName)};
const ownerName = lockName + "/owner.json";
const temporaryName = ${JSON.stringify(temporaryName)};
let paused = false;
const pause = () => {
  if (paused) return;
  paused = true;
  process.stderr.write("PAUSED ${point}\\n");
  ${stallUntilSource(resume)}
};
const open = fs.openSync, lstat = fs.lstatSync, readdir = fs.readdirSync;
fs.openSync = function(name, ...args) {
  try { return open.call(fs, name, ...args); }
  catch (error) {
    if (${JSON.stringify(point)} === "after-owner-miss" && name === ownerName && error.code === "ENOENT") pause();
    throw error;
  }
};
fs.readdirSync = function(name, ...args) {
  if (${JSON.stringify(point)} === "before-readdir" && name === lockName) pause();
  return readdir.call(fs, name, ...args);
};
fs.lstatSync = function(name, ...args) {
  if (${JSON.stringify(point)} === "before-temporary-lstat" && name === lockName + "/" + temporaryName) pause();
  return lstat.call(fs, name, ...args);
};
syncBuiltinESMExports();
`,
        { mode: 0o600 },
      );
      const rootBefore = await lstat(root);
      const reaper = await leaseWorkerProcess(root, worker, key, "b".repeat(64), shim);
      let successor: Awaited<ReturnType<typeof leaseWorkerProcess>> | undefined;
      let progress: Awaited<ReturnType<typeof leaseWorkerProcess>> | undefined;
      try {
        await reaper.marker("stderr", `PAUSED ${point}\n`);
        successor = await leaseWorkerProcess(root, worker, key, "a".repeat(64));
        await successor.marker("stdout", "\n");
        expect(successor.stdout()).toMatch(/^READY /u);
        successor.child.stdin?.end("1");
        expect(await successor.closed).toBe(0);
        await expect(lstat(lock)).rejects.toMatchObject({ code: "ENOENT" });

        await writeFile(resume, "");
        expect(await reaper.closed, point).toBe(3);
        expect(reaper.stdout()).toBe("");
        expect(reaper.stderr()).toBe(`PAUSED ${point}\n`);
        await expect(lstat(lock)).rejects.toMatchObject({ code: "ENOENT" });
        expect(
          (await readdir(root)).some((name) => name.includes(".merge-request.lock.candidate-")),
        ).toBe(false);
        const rootAfter = await lstat(root);
        expect([rootAfter.dev, rootAfter.ino, rootAfter.uid, rootAfter.mode & 0o7777]).toEqual([
          rootBefore.dev,
          rootBefore.ino,
          rootBefore.uid,
          rootBefore.mode & 0o7777,
        ]);

        progress = await leaseWorkerProcess(root, worker, key, "d".repeat(64));
        await progress.marker("stdout", "\n");
        expect(progress.stdout()).toMatch(/^READY /u);
        progress.child.stdin?.end("1");
        expect(await progress.closed).toBe(0);
        await expect(lstat(lock)).rejects.toMatchObject({ code: "ENOENT" });
      } finally {
        for (const helper of [reaper, successor, progress]) {
          if (helper?.child.exitCode === null && helper.child.signalCode === null) {
            helper.child.kill("SIGKILL");
          }
        }
        await Promise.allSettled(
          [reaper, successor, progress]
            .filter((helper) => helper !== undefined)
            .map((helper) => helper.closed),
        );
      }
    }
  });

  it("keeps non-ENOENT inspection failures fail-closed at each missing-owner observation", async () => {
    const worker = await mergeRequestLeaseWorkerSource();
    for (const errorCode of ["EACCES", "EIO"] as const) {
      for (const point of ["lock-lstat", "readdir", "temporary-lstat"] as const) {
        const root = await directory();
        const key = "c".repeat(64);
        const lockName = `.${key}.merge-request.lock`;
        const temporaryName = `.owner.${"b".repeat(64)}.tmp`;
        await mkdir(join(root, lockName), { mode: 0o700 });
        if (point === "temporary-lstat") {
          await writeFile(join(root, lockName, temporaryName), "", { mode: 0o600 });
        }
        const shim = join(root, `deny-${errorCode}-${point}.mjs`);
        await writeFile(
          shim,
          `import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
const lockName = ${JSON.stringify(lockName)};
const ownerName = lockName + "/owner.json";
const temporaryName = ${JSON.stringify(temporaryName)};
let ownerMissing = false;
const deny = () => { const error = new Error("denied"); error.code = ${JSON.stringify(errorCode)}; throw error; };
const open = fs.openSync, lstat = fs.lstatSync, readdir = fs.readdirSync;
fs.openSync = function(name, ...args) {
  try { return open.call(fs, name, ...args); }
  catch (error) { if (name === ownerName && error.code === "ENOENT") ownerMissing = true; throw error; }
};
fs.lstatSync = function(name, ...args) {
  if (ownerMissing && ${JSON.stringify(point)} === "lock-lstat" && name === lockName) deny();
  if (ownerMissing && ${JSON.stringify(point)} === "temporary-lstat" && name === lockName + "/" + temporaryName) deny();
  return lstat.call(fs, name, ...args);
};
fs.readdirSync = function(name, ...args) {
  if (ownerMissing && ${JSON.stringify(point)} === "readdir" && name === lockName) deny();
  return readdir.call(fs, name, ...args);
};
syncBuiltinESMExports();
`,
          { mode: 0o600 },
        );
        const result = await runMergeRequestLeaseWorker(root, key, worker, shim);
        expect(result.error).toBeUndefined();
        expect(result.status).toBe(2);
        expect(result.stdout).toBe("");
        expect(result.stderr).toBe(`DOCSFAB_HELPER_FAILURE ${errorCode}\n`);
      }
    }
  });

  it("refuses substituted owner names inside a private candidate generation", async () => {
    for (const state of ["valid-owner", "malformed-owner"] as const) {
      const root = await directory();
      const key = "c".repeat(64);
      const bytes =
        state === "valid-owner"
          ? JSON.stringify({ schemaVersion: 1, key, leaseId: "a".repeat(64), pid: process.pid })
          : "malformed-substitute";
      const shim = join(root, "substitute-owner.mjs");
      await writeFile(
        shim,
        `import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
const link = fs.linkSync;
fs.linkSync = function(source, destination) {
  if (destination === "owner.json") fs.writeFileSync(destination, ${JSON.stringify(bytes)}, { flag: "wx", mode: 0o600 });
  return link.call(fs, source, destination);
};
syncBuiltinESMExports();
`,
        { mode: 0o600 },
      );
      const result = await runMergeRequestLeaseWorker(
        root,
        key,
        await mergeRequestLeaseWorkerSource(),
        shim,
      );
      expect(result.status).toBe(2);
      expect(result.stdout).toBe("");
      await expect(lstat(join(root, `.${key}.merge-request.lock`))).rejects.toMatchObject({
        code: "ENOENT",
      });
      const [candidate] = (await readdir(root)).filter((name) => name.includes(".candidate-"));
      expect(candidate).toBeDefined();
      expect(await readFile(join(root, candidate!, "owner.json"), "utf8")).toBe(bytes);
    }
  });

  it("keeps publisher ownership when the lease helper dies after READY", async () => {
    const root = await directory();
    const key = "d".repeat(64);
    let started!: () => void;
    const actionStarted = new Promise<void>((resolveStarted) => {
      started = resolveStarted;
    });
    let finish!: () => void;
    const actionFinished = new Promise<void>((resolveFinished) => {
      finish = resolveFinished;
    });
    const first = new FileScmDeliveryReceiptStore(root, {
      afterMergeRequestLeaseReady: (helperPid) => {
        process.kill(helperPid, "SIGKILL");
      },
    });
    const second = new FileScmDeliveryReceiptStore(root);
    const firstLease = first.withMergeRequestLease(key, async () => {
      started();
      await actionFinished;
    });
    await actionStarted;
    let secondEntered = false;
    const secondLease = second.withMergeRequestLease(key, async () => {
      secondEntered = true;
    });
    await new Promise<void>((resolveWait) => setTimeout(resolveWait, 150));
    expect(secondEntered).toBe(false);
    finish();
    await Promise.all([firstLease, secondLease]);
    expect(secondEntered).toBe(true);
  });

  it("never exposes an unwritten owner record to a contending lease helper", async () => {
    // Pause the real helper between creating its owner record's file and writing
    // it, then run a second helper on that lock. The contender acquires its own
    // generation; it never reads an empty owner or inherits the paused directory.
    const worker = await mergeRequestLeaseWorkerSource();
    const root = await directory();
    const key = "c".repeat(64);
    const resume = join(root, "resume-owner-write");
    const shim = join(root, "pause-owner-write.mjs");
    await writeFile(
      shim,
      `import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
const write = fs.writeFileSync;
fs.writeFileSync = function(target, ...args) {
  if (typeof target === "number") {
    process.stderr.write("PAUSED\\n");
    ${stallUntilSource(resume)}
  }
  return write.call(fs, target, ...args);
};
syncBuiltinESMExports();
`,
      { mode: 0o600 },
    );
    const holder = spawn(
      process.execPath,
      ["--import", pathToFileURL(shim).href, "--input-type=module", "-e", worker],
      {
        cwd: root,
        env: await leaseWorkerEnvironment(root, key, "a".repeat(64)),
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    try {
      let stdout = "";
      let stderr = "";
      const closed = new Promise<number | null>((resolveClosed) => {
        holder.once("close", (code) => resolveClosed(code));
      });
      const output = (stream: "stdout" | "stderr", marker: string) =>
        new Promise<void>((resolveMarker, rejectMarker) => {
          holder[stream].on("data", (chunk: Buffer) => {
            if (stream === "stdout") stdout += chunk.toString("utf8");
            else stderr += chunk.toString("utf8");
            if ((stream === "stdout" ? stdout : stderr).includes(marker)) resolveMarker();
          });
          void closed.then((code) =>
            rejectMarker(new Error(`holder exited (${code}) before ${marker.trim()}: ${stderr}`)),
          );
        });
      const paused = output("stderr", "PAUSED\n");
      const ready = output("stdout", "\n");
      await paused;

      const contender = spawnSync(process.execPath, ["--input-type=module", "-e", worker], {
        cwd: root,
        input: "",
        encoding: "utf8",
        env: await leaseWorkerEnvironment(root, key, "b".repeat(64)),
      });
      expect(contender.error).toBeUndefined();
      expect(contender.signal).toBeNull();
      expect(contender.stderr).toBe("");
      expect(contender.stdout).toMatch(/^READY /u);
      expect(contender.status).toBe(0);

      await writeFile(resume, "");
      await ready;
      expect(stdout).toMatch(/^READY \{"dev":\d+,"ino":\d+\}\n$/u);
      holder.stdin.end("1");
      expect(await closed).toBe(0);
      expect(await readdir(root)).not.toContain(`.${key}.merge-request.lock`);
    } finally {
      holder.kill("SIGKILL");
    }
  });

  it("leaves a killed private candidate inert while canonical acquisition succeeds", async () => {
    const root = await directory();
    const key = "f".repeat(64);
    const lock = join(root, `.${key}.merge-request.lock`);
    const worker = await mergeRequestLeaseWorkerSource();
    const shim = join(root, "pause-candidate-publication.mjs");
    await writeFile(
      shim,
      `import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
const rename = fs.renameSync;
fs.renameSync = function(source, destination, ...args) {
  if (String(destination).endsWith(".merge-request.lock")) {
    process.stderr.write("DURABLE\\n");
    ${stallUntilSource(join(root, "resume-never-written"))}
  }
  return rename.call(fs, source, destination, ...args);
};
syncBuiltinESMExports();
`,
      { mode: 0o600 },
    );
    const holder = await leaseWorkerProcess(root, worker, key, "a".repeat(64), shim);
    try {
      await holder.marker("stderr", "DURABLE\n");
      const [name] = (await readdir(root)).filter((entry) => entry.includes(".candidate-"));
      expect(name).toBeDefined();
      const candidate = join(root, name!);
      const identity = await lstat(candidate);
      const bytes = await readFile(join(candidate, "owner.json"));
      expect(identity.mode & 0o7777).toBe(0o700);
      expect((await lstat(join(candidate, "owner.json"))).mode & 0o7777).toBe(0o600);
      await expect(lstat(lock)).rejects.toMatchObject({ code: "ENOENT" });
      holder.child.kill("SIGKILL");
      await holder.closed;
      expect(holder.stdout()).toBe("");
      await expect(
        new FileScmDeliveryReceiptStore(root).withMergeRequestLease(key, async () => "acquired"),
      ).resolves.toBe("acquired");
      await expect(lstat(lock)).rejects.toMatchObject({ code: "ENOENT" });
      expect((await lstat(candidate)).ino).toBe(identity.ino);
      expect(await readFile(join(candidate, "owner.json"))).toEqual(bytes);
    } finally {
      holder.child.kill("SIGKILL");
      await holder.closed;
    }
  });

  it("recovers a lock whose holder died before publishing its owner record", async () => {
    const root = await directory();
    const key = "b".repeat(64);
    const lock = join(root, `.${key}.merge-request.lock`);
    const old = new Date(Date.now() - 10_000);
    await mkdir(lock, { mode: 0o700 });
    await writeFile(join(lock, `.owner.${"a".repeat(64)}.tmp`), "", { mode: 0o600 });
    await utimes(lock, old, old);
    await expect(
      new FileScmDeliveryReceiptStore(root).withMergeRequestLease(key, async () => "recovered"),
    ).resolves.toBe("recovered");
    expect((await readdir(root)).filter((name) => name.includes(".merge-request.lock"))).toEqual(
      [],
    );

    // Anything other than an abandoned owner temporary is not ours to delete.
    await mkdir(lock, { mode: 0o700 });
    await writeFile(join(lock, "unexpected"), "", { mode: 0o600 });
    await utimes(lock, old, old);
    await expect(
      new FileScmDeliveryReceiptStore(root).withMergeRequestLease(key, async () => "taken"),
    ).rejects.toMatchObject({ code: "unsafe-root" });
  });

  it("reports helper deaths and timeouts as helper-failed instead of unsafe-root", async () => {
    const root = await directory();
    const { plan, authorization } = inputs();
    const initial = createScmDeliveryRecord({ plan, authorization, createdAt: NOW });
    await new FileScmDeliveryReceiptStore(root).claim(initial, plan);
    const run = (store: FileScmDeliveryReceiptStore, helper: "lease" | "journal" | "plan") =>
      helper === "lease"
        ? store.withMergeRequestLease(initial.idempotencyKey, async () => "entered")
        : helper === "journal"
          ? store.load(initial.idempotencyKey)
          : store.loadPlan(plan.sha256);

    for (const helper of ["lease", "journal", "plan"] as const) {
      const store = new FileScmDeliveryReceiptStore(root, {
        afterHelperSpawn: (spawned, pid) => {
          if (spawned === helper) process.kill(pid, "SIGKILL");
        },
      });
      await expect(run(store, helper)).rejects.toMatchObject({
        code: "helper-failed",
        helper: { helper, failure: "signal", exitCode: null, signal: "SIGKILL" },
        message: `SCM delivery receipt store failed (helper-failed: ${helper} helper was ended by SIGKILL).`,
      });
    }

    vi.stubEnv("DOCSFAB_DELIVERY_RECEIPT_HELPER_TIMEOUT_MS", "1");
    for (const helper of ["lease", "journal"] as const) {
      const rejected = run(new FileScmDeliveryReceiptStore(root), helper);
      await expect(rejected).rejects.toMatchObject({
        code: "helper-failed",
        helper: { helper, failure: "timeout" },
      });
      await expect(rejected).rejects.toThrow(
        /delivery-receipt-helper-timeout-ms-bound: \d+ exceeds delivery\.receiptHelperTimeoutMs = 1 ms\./u,
      );
    }
    vi.unstubAllEnvs();

    // Neither a killed nor a timed-out helper leaves the lease held.
    await expect(run(new FileScmDeliveryReceiptStore(root), "lease")).resolves.toBe("entered");
  });

  it("never lets a delayed private generation replace the canonical holder's owner record", async () => {
    // H stalls opening its private generation while C publishes first; resumed,
    // H must retry without entering or modifying C's directory.
    const worker = await mergeRequestLeaseWorkerSource();
    const root = await directory();
    const key = "d".repeat(64);
    const lock = join(root, `.${key}.merge-request.lock`);
    const resume = join(root, "resume-lock-open");
    const shim = join(root, "pause-lock-open.mjs");
    await writeFile(
      shim,
      `import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
const open = fs.openSync;
fs.openSync = function(target, flags, ...args) {
  if (typeof target === "string" && target.includes(".merge-request.lock.candidate-") && (flags & fs.constants.O_DIRECTORY)) {
    process.stderr.write("PAUSED\\n");
    ${stallUntilSource(resume)}
  }
  return open.call(fs, target, flags, ...args);
};
syncBuiltinESMExports();
`,
      { mode: 0o600 },
    );
    const holder = await leaseWorkerProcess(root, worker, key, "a".repeat(64), shim);
    let contender: Awaited<ReturnType<typeof leaseWorkerProcess>> | undefined;
    try {
      await holder.marker("stderr", "PAUSED\n");
      await expect(lstat(lock)).rejects.toMatchObject({ code: "ENOENT" });
      contender = await leaseWorkerProcess(root, worker, key, "b".repeat(64));
      await contender.marker("stdout", "\n");
      expect(contender.stdout()).toMatch(/^READY /u);

      await writeFile(resume, "");
      const outcome = await Promise.race([
        holder.closed.then((code) => `exit ${code}`),
        holder.marker("stdout", "\n").then(() => `READY ${holder.stdout().trim()}`),
      ]);
      expect(outcome).toBe("exit 3");
      expect(holder.stderr()).toBe(`PAUSED\nDOCSFAB_LEASE_HELD ${process.pid}\n`);
      expect(await readdir(lock)).toEqual(["owner.json"]);
      expect(JSON.parse(await readFile(join(lock, "owner.json"), "utf8"))).toMatchObject({
        leaseId: "b".repeat(64),
      });
      expect((await lstat(join(lock, "owner.json"))).nlink).toBe(1);

      contender.child.stdin.end("1");
      expect(await contender.closed).toBe(0);
      expect(await readdir(root)).not.toContain(`.${key}.merge-request.lock`);
    } finally {
      holder.child.kill("SIGKILL");
      contender?.child.kill("SIGKILL");
    }
  });

  it("keeps a successor canonical when a recorded-dead-owner reaper resumes", async () => {
    const root = await directory();
    const key = "e".repeat(64);
    const lock = join(root, `.${key}.merge-request.lock`);
    const dead = spawnSync(process.execPath, ["-e", ""]);
    expect(dead.status).toBe(0);
    await mkdir(lock, { mode: 0o700 });
    await writeFile(
      join(lock, "owner.json"),
      JSON.stringify({
        schemaVersion: 1,
        key,
        leaseId: "a".repeat(64),
        pid: dead.pid,
      }),
      { mode: 0o600 },
    );
    const original = await lstat(lock);
    const resume = join(root, "resume-dead-owner-reaper");
    const shim = join(root, "pause-dead-owner-reaper.mjs");
    await writeFile(
      shim,
      `
const kill = process.kill;
const fs = await import("node:fs");
process.kill = function(pid, signal) {
  try { return kill.call(process, pid, signal); }
  catch (error) {
    if (pid === ${JSON.stringify(dead.pid)} && signal === 0 && error.code === "ESRCH") {
      process.stderr.write("PAUSED\\n");
      ${stallUntilSource(resume)}
    }
    throw error;
  }
};
`,
      { mode: 0o600 },
    );
    const worker = await mergeRequestLeaseWorkerSource();
    const reaper = await leaseWorkerProcess(root, worker, key, "b".repeat(64), shim);
    let successor: Awaited<ReturnType<typeof leaseWorkerProcess>> | undefined;
    try {
      await reaper.marker("stderr", "PAUSED\n");
      successor = await leaseWorkerProcess(root, worker, key, "c".repeat(64));
      await successor.marker("stdout", "\n");
      expect(successor.stdout()).toMatch(/^READY /u);
      const replacement = await lstat(lock);
      expect(replacement.ino).not.toBe(original.ino);
      const bytes = await readFile(join(lock, "owner.json"));
      await writeFile(resume, "");
      const code = await reaper.closed;
      const canonical = await lstat(lock).catch(() => undefined);
      expect({ code, canonical: canonical?.ino }).toEqual({ code: 3, canonical: replacement.ino });
      expect(reaper.stdout()).toBe("");
      expect(await readFile(join(lock, "owner.json"))).toEqual(bytes);
      expect((await runMergeRequestLeaseWorker(root, key, worker)).status).toBe(3);
      successor.child.stdin.end("1");
      expect(await successor.closed).toBe(0);
      await expect(lstat(lock)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      reaper.child.kill("SIGKILL");
      successor?.child.kill("SIGKILL");
      await Promise.allSettled([reaper.closed, ...(successor ? [successor.closed] : [])]);
    }
  });

  it("holds the observed owner descriptor through dead-owner recovery", async () => {
    const root = await directory();
    const key = "e".repeat(64);
    const lock = join(root, `.${key}.merge-request.lock`);
    const dead = spawnSync(process.execPath, ["-e", ""]);
    expect(dead.status).toBe(0);
    await mkdir(lock, { mode: 0o700 });
    await writeFile(
      join(lock, "owner.json"),
      JSON.stringify({ schemaVersion: 1, key, leaseId: "a".repeat(64), pid: dead.pid }),
      { mode: 0o600 },
    );
    const original = await lstat(join(lock, "owner.json"));
    const observation = join(root, "owner-fd-lifetime.json");
    const shim = join(root, "observe-owner-fd.mjs");
    await writeFile(
      shim,
      `import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
const open = fs.openSync, close = fs.closeSync, unlink = fs.unlinkSync, kill = process.kill;
const events = [];
const record = event => {
  events.push(event);
  fs.writeFileSync(${JSON.stringify(observation)}, JSON.stringify(events), { mode: 0o600 });
};
let observedFd, closed = false, unlinked = false;
fs.openSync = function(name, ...args) {
  const fd = open.call(fs, name, ...args);
  if (name === ${JSON.stringify(`.${key}.merge-request.lock/owner.json`)}) observedFd = fd;
  return fd;
};
const inspect = phase => {
  try {
    const stat = fs.fstatSync(observedFd);
    record({ phase, dev: stat.dev, ino: stat.ino, nlink: stat.nlink });
  } catch (error) { record({ phase, error: error.code }); throw error; }
};
process.kill = function(pid, signal) {
  try { return kill.call(process, pid, signal); }
  catch (error) {
    if (pid === ${JSON.stringify(dead.pid)} && signal === 0 && error.code === "ESRCH") inspect("probe");
    throw error;
  }
};
fs.unlinkSync = function(name, ...args) {
  if (name === "./owner.json" && !unlinked) {
    inspect("before-unlink");
    const result = unlink.call(fs, name, ...args);
    inspect("after-unlink");
    unlinked = true;
    return result;
  }
  return unlink.call(fs, name, ...args);
};
fs.closeSync = function(fd) {
  if (fd === observedFd && !closed) { record({ phase: "close" }); closed = true; }
  return close.call(fs, fd);
};
syncBuiltinESMExports();
`,
      { mode: 0o600 },
    );
    const result = await runMergeRequestLeaseWorker(
      root,
      key,
      await mergeRequestLeaseWorkerSource(),
      shim,
    );
    const events = JSON.parse(await readFile(observation, "utf8"));
    expect(result.status, JSON.stringify(events)).toBe(0);
    expect(result.stdout).toMatch(/^READY /u);
    expect(events).toEqual([
      { phase: "probe", dev: original.dev, ino: original.ino, nlink: 1 },
      { phase: "before-unlink", dev: original.dev, ino: original.ino, nlink: 1 },
      { phase: "after-unlink", dev: original.dev, ino: original.ino, nlink: 0 },
      { phase: "close" },
    ]);
    expect((await readdir(root)).filter((name) => name.includes(".merge-request.lock"))).toEqual(
      [],
    );
  });

  it("isolates a delayed private publisher from two recorded-owner reapers", async () => {
    const root = await directory();
    const key = "f".repeat(64);
    const lock = join(root, `.${key}.merge-request.lock`);
    const worker = await mergeRequestLeaseWorkerSource();
    const publisherPid = spawn(
      process.execPath,
      ["-e", "process.stdout.write('READY\\n'); setInterval(() => {}, 1000)"],
      { stdio: ["ignore", "pipe", "ignore"] },
    );
    const publisherExited = once(publisherPid, "close");
    await once(publisherPid.stdout!, "data");
    const gate = (marker: string, file: string) => `
process.stderr.write(${JSON.stringify(marker + "\n")});
${stallUntilSource(join(root, file))}
`;
    const shim = async (name: string, body: string) => {
      const file = join(root, name);
      await writeFile(
        file,
        `import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
${body}
syncBuiltinESMExports();
`,
        { mode: 0o600 },
      );
      return file;
    };
    const publisherShim = await shim(
      "pause-late-publisher.mjs",
      `
const open = fs.openSync;
fs.openSync = function(name, flags, ...args) {
  if ((flags & fs.constants.O_CREAT) && String(name).startsWith(".owner.")) {
    ${gate("P-STAGE", "resume-p-stage")}
  }
  return open.call(fs, name, flags, ...args);
};`,
    );
    const ownerShim = await shim(
      "pause-owner-b.mjs",
      `
process.env.DOCSFAB_RECEIPT_PUBLISHER_PID = ${JSON.stringify(String(publisherPid.pid))};
`,
    );
    const firstReaperShim = await shim(
      "pause-first-reaper.mjs",
      `
const unlink = fs.unlinkSync;
fs.unlinkSync = function(name, ...args) {
  if (String(name).endsWith("/owner.json")) { ${gate("R1-UNLINK", "resume-r1")} }
  return unlink.call(fs, name, ...args);
};`,
    );
    const secondReaperShim = await shim(
      "pause-second-reaper.mjs",
      `
const unlink = fs.unlinkSync;
fs.unlinkSync = function(name, ...args) {
  const result = unlink.call(fs, name, ...args);
  if (String(name).endsWith("/owner.json")) { ${gate("R2-DELETED", "resume-r2")} }
  return result;
};`,
    );
    const children: Awaited<ReturnType<typeof leaseWorkerProcess>>[] = [];
    const start = async (leaseId: string, path: string) => {
      const child = await leaseWorkerProcess(root, worker, key, leaseId.repeat(64), path);
      children.push(child);
      return child;
    };
    try {
      const publisher = await start("a", publisherShim);
      await publisher.marker("stderr", "P-STAGE\n");
      const [candidate] = (await readdir(root)).filter((name) => name.includes(".candidate-"));
      expect(candidate).toBeDefined();
      const privateGeneration = await lstat(join(root, candidate!));
      await expect(lstat(lock)).rejects.toMatchObject({ code: "ENOENT" });
      const owner = await start("b", ownerShim);
      await owner.marker("stdout", "\n");
      expect(owner.stdout()).toMatch(/^READY /u);
      const replacement = await lstat(lock);
      expect(replacement.ino).not.toBe(privateGeneration.ino);
      publisherPid.kill("SIGKILL");
      await publisherExited;
      const firstReaper = await start("c", firstReaperShim);
      await firstReaper.marker("stderr", "R1-UNLINK\n");
      const secondReaper = await start("d", secondReaperShim);
      await secondReaper.marker("stderr", "R2-DELETED\n");
      await expect(lstat(join(lock, "owner.json"))).rejects.toMatchObject({ code: "ENOENT" });
      // No lock is protected by its age: the delayed publisher finds the dead
      // owner's lock cleared, removes the empty directory, and publishes. Both
      // reapers then find a live successor and retry without touching it.
      await writeFile(join(root, "resume-p-stage"), "");
      expect(await leaseOutcome(publisher)).toBe("READY");
      const successor = await lstat(lock);
      expect(successor.ino).toBe(privateGeneration.ino);
      const bytes = await readFile(join(lock, "owner.json"));
      expect(JSON.parse(bytes.toString()).leaseId).toBe("a".repeat(64));
      await writeFile(join(root, "resume-r2"), "");
      expect(await leaseOutcome(secondReaper)).toBe("exit 3");
      await writeFile(join(root, "resume-r1"), "");
      expect(await leaseOutcome(firstReaper)).toBe("exit 3");
      expect((await lstat(lock)).ino).toBe(successor.ino);
      expect(await readFile(join(lock, "owner.json"))).toEqual(bytes);
      publisher.child.stdin.end("1");
      expect(await publisher.closed).toBe(0);
    } finally {
      publisherPid.kill("SIGKILL");
      for (const child of children) child.child.kill("SIGKILL");
      await Promise.allSettled([publisherExited, ...children.map((child) => child.closed)]);
    }
  });

  it("releases cleanly when a contender removes its emptied lock mid-release", async () => {
    // Without an age heuristic, a contender may remove the holder's lock as
    // soon as the holder's release has cleared the owner record, and publish
    // its own. The holder's release must then succeed, not refuse unsafe-root.
    const root = await directory();
    const key = "e".repeat(64);
    const lock = `.${key}.merge-request.lock`;
    const worker = await mergeRequestLeaseWorkerSource();
    const workerPath = join(root, "lease-worker.mjs");
    const observation = join(root, "contender.json");
    await writeFile(workerPath, worker, { mode: 0o600 });
    const shim = join(root, "contend-during-release.mjs");
    await writeFile(
      shim,
      `import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
const unlink = fs.unlinkSync;
fs.unlinkSync = function(name, ...args) {
  const result = unlink.call(fs, name, ...args);
  if (name === "./owner.json") {
    const contender = spawnSync(process.execPath, [${JSON.stringify(workerPath)}], {
      cwd: ${JSON.stringify(root)}, env: { ...process.env, DOCSFAB_RECEIPT_LEASE_ID: "c".repeat(64) },
      input: "", encoding: "utf8"
    });
    fs.writeFileSync(${JSON.stringify(observation)}, JSON.stringify({
      status: contender.status, stdout: contender.stdout, stderr: contender.stderr
    }), { mode: 0o600 });
  }
  return result;
};
syncBuiltinESMExports();
`,
      { mode: 0o600 },
    );
    const result = await runMergeRequestLeaseWorker(root, key, worker, shim);
    expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: "" });
    expect(result.stdout).toMatch(/^READY /u);
    const contender = JSON.parse(await readFile(observation, "utf8"));
    expect(contender).toMatchObject({ status: 0, stderr: "" });
    expect(contender.stdout).toMatch(/^READY /u);
    expect((await readdir(root)).filter((name) => name.includes(lock))).toEqual([]);
  });

  it("reports a lock that left its name right after publication as lost, not unsafe", async () => {
    // The lock is moved away (or replaced) right after the helper renames it into
    // place. The helper must retry (exit 3) without READY and not touch the
    // replacement.
    const worker = await mergeRequestLeaseWorkerSource();
    for (const after of ["moved", "replaced"] as const) {
      const root = await directory();
      const key = "d".repeat(64);
      const lock = `.${key}.merge-request.lock`;
      const shim = join(root, "move-after-publication.mjs");
      await writeFile(
        shim,
        `import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
const rename = fs.renameSync;
fs.renameSync = function(from, to) {
  rename.call(fs, from, to);
  if (to === ${JSON.stringify(lock)}) {
    rename.call(fs, to, "moved-away");
    if (${JSON.stringify(after)} === "replaced") fs.mkdirSync(to, { mode: 0o700 });
  }
};
syncBuiltinESMExports();
`,
        { mode: 0o600 },
      );
      const helper = await leaseWorkerProcess(root, worker, key, "a".repeat(64), shim);
      expect(await leaseOutcome(helper)).toBe("exit 3");
      expect(helper.stdout()).toBe("");
      expect(helper.stderr()).toBe("");
      const locks = (await readdir(root)).filter((name) => name.includes(".merge-request.lock"));
      expect(locks).toEqual(after === "replaced" ? [lock] : []);
      if (after === "replaced") expect(await readdir(join(root, lock))).toEqual([]);
      // The moved directory still holds the record, which no longer names the lock.
      expect(await readdir(join(root, "moved-away"))).toEqual(["owner.json"]);
    }
  });

  it("never grants the lease twice when a contender stalls before taking over an ownerless lock", async () => {
    // H makes the lock exist and stalls. C inspects the ownerless lock and
    // stalls before moving or removing it. H reports READY; resumed, C must not
    // free H's live lock, so a third helper D cannot acquire while H holds.
    const worker = await mergeRequestLeaseWorkerSource();
    const root = await directory();
    const key = "a".repeat(64);
    const lock = `.${key}.merge-request.lock`;
    const resumeHolder = join(root, "resume-holder");
    const resumeContender = join(root, "resume-contender");
    const holderShim = await leaseStallShim(root, lock, "after-create", resumeHolder);
    const contenderShim = await leaseStallShim(root, lock, "before-remove", resumeContender);
    const helpers: Array<Awaited<ReturnType<typeof leaseWorkerProcess>>> = [];
    try {
      const holder = await leaseWorkerProcess(root, worker, key, "1".repeat(64), holderShim);
      helpers.push(holder);
      await holder.marker("stderr", "PAUSED\n");
      const old = new Date(Date.now() - 10_000);
      await utimes(join(root, lock), old, old);

      const contender = await leaseWorkerProcess(root, worker, key, "2".repeat(64), contenderShim);
      helpers.push(contender);
      await Promise.race([contender.marker("stderr", "PAUSED\n"), contender.closed]);

      await writeFile(resumeHolder, "");
      expect(await leaseOutcome(holder)).toBe("READY");
      await writeFile(resumeContender, "");
      const contenderOutcome = await leaseOutcome(contender);

      const third = await leaseWorkerProcess(root, worker, key, "3".repeat(64));
      helpers.push(third);
      expect(await leaseOutcome(third)).toBe("exit 3");
      // A held lease names its recorded holder.
      expect(third.stdout()).toBe("");
      expect(third.stderr()).toBe(`DOCSFAB_LEASE_HELD ${process.pid}\n`);
      expect(contenderOutcome).toBe("exit 3");
      expect(JSON.parse(await readFile(join(root, lock, "owner.json"), "utf8"))).toMatchObject({
        leaseId: "1".repeat(64),
      });

      holder.child.stdin?.end("1");
      expect(await holder.closed).toBe(0);
      expect((await readdir(root)).filter((name) => name.includes(".merge-request.lock"))).toEqual(
        [],
      );
    } finally {
      for (const helper of helpers) helper.child.kill("SIGKILL");
    }
  });

  it.each(["after-owner-read", "before-remove"] as const)(
    "never grants the lease twice when two contenders reclaim the same dead owner's lock (stall %s)",
    async (point) => {
      // The recorded owner is dead. C2 reads that record and stalls, after the
      // read or before moving or removing the lock. C1 reclaims and reports READY;
      // resumed, C2 must not clear or free C1's live lock, so a third helper D
      // cannot acquire while C1 holds.
      const worker = await mergeRequestLeaseWorkerSource();
      const root = await directory();
      const key = "b".repeat(64);
      const lock = `.${key}.merge-request.lock`;
      const dead = spawnSync(process.execPath, ["-e", ""]);
      expect(dead.status).toBe(0);
      await mkdir(join(root, lock), { mode: 0o700 });
      await writeFile(
        join(root, lock, "owner.json"),
        `${JSON.stringify({ schemaVersion: 1, key, leaseId: "0".repeat(64), pid: dead.pid })}\n`,
        { mode: 0o600 },
      );
      const resume = join(root, "resume-late-contender");
      const shim = await leaseStallShim(root, lock, point, resume);
      const helpers: Array<Awaited<ReturnType<typeof leaseWorkerProcess>>> = [];
      try {
        const late = await leaseWorkerProcess(root, worker, key, "2".repeat(64), shim);
        helpers.push(late);
        await late.marker("stderr", "PAUSED\n");

        const early = await leaseWorkerProcess(root, worker, key, "1".repeat(64));
        helpers.push(early);
        expect(await leaseOutcome(early)).toBe("READY");
        await writeFile(resume, "");
        const lateOutcome = await leaseOutcome(late);

        const third = await leaseWorkerProcess(root, worker, key, "3".repeat(64));
        helpers.push(third);
        expect(await leaseOutcome(third)).toBe("exit 3");
        expect(lateOutcome).toBe("exit 3");
        expect(JSON.parse(await readFile(join(root, lock, "owner.json"), "utf8"))).toMatchObject({
          leaseId: "1".repeat(64),
        });

        early.child.stdin?.end("1");
        expect(await early.closed).toBe(0);
        expect(
          (await readdir(root)).filter((name) => name.includes(".merge-request.lock")),
        ).toEqual([]);
      } finally {
        for (const helper of helpers) helper.child.kill("SIGKILL");
      }
    },
  );

  it("bounds the wait for a held lease and the owner record it reads by the catalog", async () => {
    const root = await directory();
    const key = "9".repeat(64);
    const lock = join(root, `.${key}.merge-request.lock`);
    await mkdir(lock, { mode: 0o700 });
    const record = {
      schemaVersion: 1,
      key,
      leaseId: "a".repeat(64),
      pid: process.pid,
    };
    await writeFile(join(lock, "owner.json"), `${JSON.stringify(record)}\n`, {
      mode: 0o600,
    });
    vi.stubEnv("DOCSFAB_DELIVERY_MERGE_REQUEST_LEASE_ATTEMPTS", "2");
    const held = new FileScmDeliveryReceiptStore(root).withMergeRequestLease(key, async () => "x");
    await expect(held).rejects.toMatchObject({
      code: "receipt-conflict",
      helper: { helper: "lease", exitCode: 3 },
    });
    await expect(held).rejects.toMatchObject({ helper: { holderPid: process.pid } });
    await expect(held).rejects.toThrow(
      new RegExp(
        `lease helper found the lease held on every attempt \\(its owner record names publisher process ${process.pid}\\): delivery-merge-request-lease-attempts-bound: exceeded delivery\\.mergeRequestLeaseAttempts = 2 count\\.`,
        "u",
      ),
    );

    // A record larger than delivery.mergeRequestLeaseRecordMaxBytes is refused
    // before it is parsed, even when it is otherwise well formed.
    const padded = `${JSON.stringify(record)}${" ".repeat(
      limit("delivery.mergeRequestLeaseRecordMaxBytes").value,
    )}\n`;
    await writeFile(join(lock, "owner.json"), padded, { mode: 0o600 });
    await expect(
      new FileScmDeliveryReceiptStore(root).withMergeRequestLease(key, async () => "x"),
    ).rejects.toMatchObject({ code: "unsafe-root" });
    expect(await readdir(lock)).toEqual(["owner.json"]);
    vi.unstubAllEnvs();

    // Hosts may only lower the lease bounds. The smallest record bound admits
    // every owner record DocsFab writes; a smaller one is refused.
    const fresh = await directory();
    vi.stubEnv("DOCSFAB_DELIVERY_MERGE_REQUEST_LEASE_RECORD_MAX_BYTES", "193");
    vi.stubEnv("DOCSFAB_DELIVERY_MERGE_REQUEST_LEASE_RETRY_PAUSE_MS", "1");
    vi.stubEnv("DOCSFAB_DELIVERY_MERGE_REQUEST_LEASE_ATTEMPTS", "1");
    await expect(
      new FileScmDeliveryReceiptStore(fresh).withMergeRequestLease(key, async () => "lowered"),
    ).resolves.toBe("lowered");
    for (const [name, value] of [
      ["DOCSFAB_DELIVERY_MERGE_REQUEST_LEASE_RECORD_MAX_BYTES", "192"],
      ["DOCSFAB_DELIVERY_MERGE_REQUEST_LEASE_RECORD_MAX_BYTES", "257"],
      ["DOCSFAB_DELIVERY_MERGE_REQUEST_LEASE_RETRY_PAUSE_MS", "26"],
      ["DOCSFAB_DELIVERY_MERGE_REQUEST_LEASE_ATTEMPTS", "1201"],
    ] as const) {
      vi.unstubAllEnvs();
      vi.stubEnv(name, value);
      await expect(
        new FileScmDeliveryReceiptStore(fresh).withMergeRequestLease(key, async () => "x"),
      ).rejects.toThrow(name);
    }
    expect((await readdir(fresh)).filter((name) => name.includes(".merge-request.lock"))).toEqual(
      [],
    );
  });

  it("recovers a dead holder's owner record left with its temporary name", async () => {
    // A helper that dies between linking owner.json and removing its temporary
    // leaves one record under two names in the lock directory.
    const root = await directory();
    const key = "e".repeat(64);
    const lock = join(root, `.${key}.merge-request.lock`);
    const dead = spawnSync(process.execPath, ["-e", ""]);
    expect(dead.status).toBe(0);
    const writeDeadOwner = async () => {
      await mkdir(lock, { mode: 0o700 });
      await writeFile(
        join(lock, "owner.json"),
        `${JSON.stringify({ schemaVersion: 1, key, leaseId: "a".repeat(64), pid: dead.pid })}\n`,
        { mode: 0o600 },
      );
    };
    await writeDeadOwner();
    await link(join(lock, "owner.json"), join(lock, `.owner.${"a".repeat(64)}.tmp`));
    await expect(
      new FileScmDeliveryReceiptStore(root).withMergeRequestLease(key, async () => "recovered"),
    ).resolves.toBe("recovered");
    expect((await readdir(root)).filter((name) => name.includes(".merge-request.lock"))).toEqual(
      [],
    );

    // A second link outside the lock directory is not ours to delete.
    await writeDeadOwner();
    await link(join(lock, "owner.json"), join(root, "owner-elsewhere"));
    await expect(
      new FileScmDeliveryReceiptStore(root).withMergeRequestLease(key, async () => "taken"),
    ).rejects.toMatchObject({ code: "unsafe-root" });
    // Refused recovery preserves the canonical directory and owner record.
    expect(await readdir(lock)).toEqual(["owner.json"]);
    expect((await lstat(join(lock, "owner.json"))).nlink).toBe(2);
  });

  it("classifies a helper's own refusal ahead of the input pipe it broke", async () => {
    // A helper that refuses before reading a large request breaks the pipe
    // first; the refusal (exit 2) is the cause, not the pipe.
    const child = spawn(process.execPath, ["-e", "process.exit(2)"], {
      stdio: ["pipe", "ignore", "ignore"],
    });
    let pipeFailed = false;
    child.stdin.on("error", () => {
      pipeFailed = true;
    });
    child.stdin.write(Buffer.alloc(LARGER_THAN_ANY_PIPE_BUFFER));
    const code = await new Promise<number | null>((resolveClose) => {
      child.once("close", (closeCode) => resolveClose(closeCode));
    });
    expect({ code, pipeFailed }).toEqual({ code: 2, pipeFailed: true });
    const classify = (closeCode: number | null) =>
      classifyReceiptHelperExit({
        code: closeCode,
        pipeFailed,
        unsafeRootCodes: [2, 3],
        verdictCodes: [1],
      });
    expect(classify(code)).toEqual({ kind: "unsafe-root" });
    expect(classify(3)).toEqual({ kind: "unsafe-root" });
    expect(classify(1)).toEqual({ kind: "verdict" });
    expect(classify(7)).toEqual({ kind: "stopped", failure: "pipe" });
    expect(classify(null)).toEqual({ kind: "stopped", failure: "signal" });
  });

  it("names the helper's own failure reason without copying its output", async () => {
    const root = await directory();
    const { plan, authorization } = inputs();
    const initial = createScmDeliveryRecord({ plan, authorization, createdAt: NOW });
    const store = new FileScmDeliveryReceiptStore(root);
    await store.claim(initial, plan);
    const planPath = join(root, `plan-${plan.sha256}.json`);
    await rename(planPath, join(root, "plan-target.json"));
    await symlink("plan-target.json", planPath);
    await expect(store.loadPlan(plan.sha256)).rejects.toMatchObject({
      code: "receipt-invalid",
      helper: { helper: "plan", exitCode: 1, signal: null, reason: "ELOOP" },
      message:
        "SCM delivery receipt store failed (receipt-invalid: plan helper exited with code 1: ELOOP).",
    });

    // An unexpected filesystem error is a named lock integrity refusal (exit 2):
    // here the private candidate is swapped for a symlink between creation and open.
    const worker = await mergeRequestLeaseWorkerSource();
    const key = "f".repeat(64);
    const shim = join(root, "swap-lock.mjs");
    await writeFile(
      shim,
      `import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
const open = fs.openSync;
fs.openSync = function(target, flags, ...args) {
  if (typeof target === "string" && target.includes(".merge-request.lock.candidate-") && (flags & fs.constants.O_DIRECTORY)) {
    fs.rmdirSync(target);
    fs.mkdirSync("elsewhere", { mode: 0o700 });
    fs.symlinkSync("elsewhere", target);
  }
  return open.call(fs, target, flags, ...args);
};
syncBuiltinESMExports();
`,
      { mode: 0o600 },
    );
    const swapped = await leaseWorkerProcess(root, worker, key, "a".repeat(64), shim);
    try {
      const outcome = await Promise.race([
        swapped.closed,
        swapped.marker("stdout", "\n").then(() => "READY"),
      ]);
      expect(outcome).toBe(2);
      expect(swapped.stdout()).toBe("");
      // O_NOFOLLOW | O_DIRECTORY on a symlink reports ELOOP on Linux, ENOTDIR on macOS.
      expect(swapped.stderr()).toMatch(/^DOCSFAB_HELPER_FAILURE (?:ELOOP|ENOTDIR)\n$/u);
    } finally {
      swapped.child.kill("SIGKILL");
      await swapped.closed;
    }
  });

  it("retries a lock released during contention inspection and rejects a substituted lock", async () => {
    // Schedule the competing release between the worker's existence inspection
    // and lstat. The exact worker adds no test bypass to the lease protocol.
    const worker = await mergeRequestLeaseWorkerSource();
    for (const replacement of ["released", "symlink"] as const) {
      const root = await directory();
      const key = "d".repeat(64);
      const lock = `.${key}.merge-request.lock`;
      await mkdir(join(root, lock), { mode: 0o700 });
      await writeFile(
        join(root, lock, "owner.json"),
        JSON.stringify({ schemaVersion: 1, key, leaseId: "a".repeat(64), pid: process.pid }),
        { mode: 0o600 },
      );
      await mkdir(join(root, "alternate"), { mode: 0o700 });
      const shim = join(root, "schedule-release.mjs");
      await writeFile(
        shim,
        `import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
const lstat = fs.lstatSync;
let release = false;
fs.lstatSync = function(name, ...args) {
  if (!release && name === ${JSON.stringify(lock)}) {
    const observed = lstat.call(fs, name, ...args); release = true; return observed;
  }
  if (release && name === ${JSON.stringify(lock)}) {
    release = false; fs.unlinkSync(name + "/owner.json"); fs.rmdirSync(name);
    if (${JSON.stringify(replacement)} === "symlink") fs.symlinkSync("alternate", name);
  }
  return lstat.call(fs, name, ...args);
};
syncBuiltinESMExports();
`,
        { mode: 0o600 },
      );
      const result = spawnSync(
        process.execPath,
        ["--import", pathToFileURL(shim).href, "--input-type=module", "-e", worker],
        {
          cwd: root,
          input: "",
          encoding: "utf8",
          env: await leaseWorkerEnvironment(root, key, "b".repeat(64)),
        },
      );
      expect(result.error).toBeUndefined();
      expect(result.signal).toBeNull();
      expect(result.status).toBe(replacement === "released" ? 3 : 2);
      expect(result.stdout).toBe("");
      expect(result.stderr).toBe("");
    }
  });

  it(
    "serializes two OS processes and recovers when a claimant process is killed",
    async () => {
      const root = await directory();
      const marker = join(root, "process-order.log");
      const key = "e".repeat(64);
      const initialOutcomes = await Promise.allSettled([
        leaseProcess(root, marker, key, "normal"),
        leaseProcess(root, marker, key, "normal"),
      ]);
      expect(initialOutcomes.filter((outcome) => outcome.status === "rejected")).toEqual([]);
      const events = (await readFile(marker, "utf8")).trim().split("\n");
      expect(events.map((event) => event.split(" ")[0])).toEqual(["start", "end", "start", "end"]);

      await expect(leaseProcess(root, marker, key, "crash")).rejects.toThrow();
      await new Promise<void>((resolveWait) => setTimeout(resolveWait, 150));
      await expect(leaseProcess(root, marker, key, "normal")).resolves.toBeUndefined();
    },
    testTimeoutMs(LEASE_PROCESS_CASE_MS),
  );

  it("rejects journal tampering, permissive slots, and stale expected digests", async () => {
    const root = await directory();
    const store = new FileScmDeliveryReceiptStore(root);
    const { plan, authorization } = inputs();
    const initial = createScmDeliveryRecord({ plan, authorization, createdAt: NOW });
    await store.claim(initial);
    const slot = join(root, initial.idempotencyKey, "000000.json");
    const bytes = await readFile(slot);
    await chmod(slot, 0o644);
    await expect(store.load(initial.idempotencyKey)).rejects.toMatchObject({
      code: "receipt-invalid",
    });
    await chmod(slot, 0o600);
    await writeFile(slot, Buffer.concat([bytes, Buffer.from(" ")]), { mode: 0o600 });
    await expect(store.load(initial.idempotencyKey)).rejects.toMatchObject({
      code: "receipt-invalid",
    });
  });

  it("keeps CAS writes in the OS-held journal and rejects final pathname drift", async () => {
    const root = await directory();
    const initialStore = new FileScmDeliveryReceiptStore(root);
    const { plan, authorization } = inputs();
    const initial = createScmDeliveryRecord({ plan, authorization, createdAt: NOW });
    await initialStore.claim(initial);
    const journal = join(root, initial.idempotencyKey);
    const stolen = join(root, `${initial.idempotencyKey}-stolen`);
    let swapped = false;
    const store = new FileScmDeliveryReceiptStore(root, {
      beforeJournalOperation: async (operation) => {
        if (operation !== "cas" || swapped) return;
        swapped = true;
        await rename(journal, stolen);
        await mkdir(journal, { mode: 0o700 });
      },
    });
    const prepared = recordScmDeliveryProgress(
      initial,
      {
        toState: "prepared",
        source: "executed",
        at: "2026-08-04T12:00:01.000Z",
        evidence: { workspaceKey: "a".repeat(64), baseRevision: plan.baseRevision },
      },
      plan,
      authorization,
    );
    await expect(store.compareAndSwap(initial.sha256, prepared)).rejects.toMatchObject({
      code: "unsafe-root",
    });
    expect(await readdir(journal)).toEqual([]);
    expect(await readdir(stolen)).toEqual(["000000.json", "000001.json"]);
  });
});

describe("lease helper stall deadline (test harness, not product behavior)", () => {
  // Runs one real process whose only work is a stall on `resume`, and returns
  // once its streams have closed, so all of its output has arrived.
  async function runStall(
    resume: string,
    budgetMs: number,
  ): Promise<{ code: number | null; stdout: string; stderr: string }> {
    const source = `import fs from "node:fs";\n${stallUntilSource(resume, budgetMs)}\nprocess.stdout.write("RESUMED\\n");\n`;
    const child = spawn(process.execPath, ["--input-type=module", "-e", source], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    onTestFinished(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    const [code] = (await once(child, "close")) as [number | null];
    return { code, stdout, stderr };
  }

  it("keeps a stalled lease helper's deadline strictly inside the default case budget, locally and in CI", () => {
    expect(STALL_MS).toBeLessThan(vitestDefaultTimeouts().testTimeout);
    for (const environment of [{}, { CI: "true" }]) {
      const stall = nestedDeadlineMs(STALL_LOCAL_MS, DEFAULT_CASE_LOCAL_MS, environment);
      expect(stall).toBeLessThan(vitestDefaultTimeouts(environment).testTimeout);
    }
  });

  it("lets a stalled lease helper continue once its resume file exists", async () => {
    const root = await directory();
    const resume = join(root, "resume");
    await writeFile(resume, "");
    expect(await runStall(resume, STALL_MS)).toEqual({
      code: 0,
      stdout: "RESUMED\n",
      stderr: "",
    });
  });

  // Nothing writes the resume file: without the deadline check the helper polls
  // forever instead of ending with the message below.
  it("ends a stalled lease helper with its own message when nothing resumes it", async () => {
    const root = await directory();
    const resume = join(root, "never-written-resume");
    expect(await runStall(resume, 50)).toEqual({
      code: 1,
      stdout: "",
      stderr: `STALL DEADLINE: ${resume} did not appear within 50 ms\n`,
    });
  });
});

async function runMergeRequestLeaseWorker(
  root: string,
  key: string,
  worker: string,
  shim?: string,
) {
  return spawnSync(
    process.execPath,
    [...(shim ? ["--import", pathToFileURL(shim).href] : []), "--input-type=module", "-e", worker],
    {
      cwd: root,
      input: "",
      encoding: "utf8",
      env: await mergeRequestLeaseEnvironment(root, key),
    },
  );
}

async function mergeRequestLeaseEnvironment(root: string, key: string) {
  const stat = await lstat(root);
  return {
    DOCSFAB_RECEIPT_ROOT_IDENTITY: JSON.stringify({
      dev: stat.dev,
      ino: stat.ino,
      uid: stat.uid,
      mode: stat.mode & 0o7777,
    }),
    DOCSFAB_RECEIPT_IDEMPOTENCY_KEY: key,
    DOCSFAB_RECEIPT_LEASE_ID: "b".repeat(64),
    DOCSFAB_RECEIPT_PUBLISHER_PID: String(process.pid),
    DOCSFAB_RECEIPT_LEASE_RECORD_MAX_BYTES: String(
      limit("delivery.mergeRequestLeaseRecordMaxBytes").value,
    ),
    LC_ALL: "C",
    LANG: "C",
  };
}

function leaseProcess(
  root: string,
  marker: string,
  key: string,
  mode: "normal" | "crash",
): Promise<void> {
  const source = `
    import { appendFile } from "node:fs/promises";
    import { FileScmDeliveryReceiptStore } from "./src/delivery/receipt-store.ts";
    const [root, marker, key, mode] = process.argv.slice(1);
    try {
      const store = new FileScmDeliveryReceiptStore(root);
      await store.withMergeRequestLease(key, async () => {
        await appendFile(marker, "start " + process.pid + "\\n");
        if (mode === "crash") process.kill(process.pid, "SIGKILL");
        await new Promise(resolve => setTimeout(resolve, 125));
        await appendFile(marker, "end " + process.pid + "\\n");
      });
    } catch (error) {
      console.error(error);
      process.exitCode = 1;
    }
  `;
  return new Promise((resolveProcess, rejectProcess) => {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "-e", source, root, marker, key, mode],
      { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] },
    );
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let settled = false;
    let timedOut = false;
    const collected = (): string =>
      [Buffer.concat(stdout).toString("utf8"), Buffer.concat(stderr).toString("utf8")]
        .map((part) => part.trim())
        .filter((part) => part.length > 0)
        .join("\n");
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) rejectProcess(error);
      else resolveProcess();
    };
    child.stdout?.on("data", (chunk: Buffer) => stdout.push(Buffer.from(chunk)));
    child.stderr?.on("data", (chunk: Buffer) => stderr.push(Buffer.from(chunk)));
    const timer = setTimeout(
      () => {
        timedOut = true;
        child.kill("SIGKILL");
      },
      nestedDeadlineMs(LEASE_PROCESS_MS, LEASE_PROCESS_CASE_MS),
    );
    child.once("error", (error) => {
      finish(error instanceof Error ? error : new Error(String(error)));
    });
    child.once("close", (code, signal) => {
      if (timedOut) {
        finish(new Error(`lease process timed out${collected() ? `: ${collected()}` : ""}`));
        return;
      }
      if (code === 0) {
        finish();
        return;
      }
      const output = collected();
      finish(
        new Error(
          `lease process failed (${code ?? signal ?? "unknown"})${output ? `: ${output}` : ""}`,
        ),
      );
    });
  });
}

/** The exact production lease helper, so tests add no bypass to its protocol. */
async function mergeRequestLeaseWorkerSource(): Promise<string> {
  const source = await readFile(
    new URL("../src/delivery/receipt-store/worker-lease.ts", import.meta.url),
    "utf8",
  );
  const template = (name: string) => {
    const marker = `const ${name} = String.raw\``;
    const start = source.indexOf(marker);
    expect(start).toBeGreaterThanOrEqual(0);
    const end = source.indexOf("\n`;", start + marker.length);
    expect(end).toBeGreaterThan(start);
    return source.slice(start + marker.length, end);
  };
  // Evaluate the production template with its production interpolations.
  const evaluate = new Function(
    "RECEIPT_HELPER_REPORT_IMPORT",
    "receiptHelperFailureReportSource",
    "LEASE_DIRECTORY_WORKER_SOURCE",
    `return String.raw\`${template("MERGE_REQUEST_LEASE_WORKER")}\`;`,
  ) as (...parts: unknown[]) => string;
  return evaluate(
    RECEIPT_HELPER_REPORT_IMPORT,
    receiptHelperFailureReportSource,
    template("LEASE_DIRECTORY_WORKER_SOURCE"),
  );
}

/**
 * Source for a preload's synchronous stall until `resume` exists, polling every
 * 10 ms with Atomics.wait. After `budgetMs` it writes its own message to stderr
 * and exits 1, so an unresumed helper cannot poll forever. The preload must
 * bind `fs` to node:fs.
 */
function stallUntilSource(resume: string, budgetMs = STALL_MS): string {
  const message = `STALL DEADLINE: ${resume} did not appear within ${budgetMs} ms\n`;
  return `{
  const stallDeadline = Date.now() + ${budgetMs};
  const stallNap = new Int32Array(new SharedArrayBuffer(4));
  while (!fs.existsSync(${JSON.stringify(resume)})) {
    if (Date.now() > stallDeadline) {
      fs.writeSync(2, ${JSON.stringify(message)});
      process.exit(1);
    }
    Atomics.wait(stallNap, 0, 0, 10);
  }
}`;
}

/**
 * A preload that stalls one real lease helper at a lock transition, whatever
 * filesystem call implements it: `after-create` right after the helper makes
 * the lock name exist, `after-owner-read` right after it reads the lock's
 * owner record, `before-remove` right before it moves or removes the lock
 * name. It writes `PAUSED` to stderr and waits for `resume` to exist.
 */
async function leaseStallShim(
  root: string,
  lock: string,
  point: LeaseStallPoint,
  resume: string,
): Promise<string> {
  const shim = join(root, `stall-${point}-${Math.random().toString(16).slice(2)}.mjs`);
  await writeFile(
    shim,
    `import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
const lock = ${JSON.stringify(lock)};
let stalled = false;
const stall = () => {
  if (stalled) return;
  stalled = true;
  process.stderr.write("PAUSED\\n");
  ${stallUntilSource(resume)}
};
const mkdir = fs.mkdirSync, rename = fs.renameSync, rmdir = fs.rmdirSync, read = fs.readFileSync;
if (${JSON.stringify(point)} === "after-owner-read") {
  fs.readFileSync = function(...args) { const bytes = read.apply(fs, args); stall(); return bytes; };
} else if (${JSON.stringify(point)} === "after-create") {
  fs.mkdirSync = function(name, ...args) { const made = mkdir.call(fs, name, ...args); if (name === lock) stall(); return made; };
  fs.renameSync = function(from, to) { rename.call(fs, from, to); if (to === lock) stall(); };
} else {
  fs.renameSync = function(from, to) { if (from === lock) stall(); return rename.call(fs, from, to); };
  fs.rmdirSync = function(name, ...args) { if (name === lock) stall(); return rmdir.call(fs, name, ...args); };
}
syncBuiltinESMExports();
`,
    { mode: 0o600 },
  );
  return shim;
}

type LeaseStallPoint = "after-create" | "after-owner-read" | "before-remove";

/** How a lease helper ended its acquisition: `READY` or `exit <code>`. */
async function leaseOutcome(
  helper: Awaited<ReturnType<typeof leaseWorkerProcess>>,
): Promise<string> {
  const first = await Promise.race([
    helper.closed.then((code) => `exit ${code}`),
    helper
      .marker("stdout", "\n")
      .then(() => (helper.stdout().startsWith("READY ") ? "READY" : undefined)),
  ]);
  return first ?? `exit ${await helper.closed}`;
}

/** One exact production lease helper process with its output collected. */
async function leaseWorkerProcess(
  root: string,
  worker: string,
  key: string,
  leaseId: string,
  shim?: string,
): Promise<{
  child: ReturnType<typeof spawn>;
  closed: Promise<number | null>;
  stdout(): string;
  stderr(): string;
  marker(stream: "stdout" | "stderr", text: string): Promise<void>;
}> {
  const env = await leaseWorkerEnvironment(root, key, leaseId);
  const args = [
    ...(shim ? ["--import", pathToFileURL(shim).href] : []),
    "--input-type=module",
    "-e",
    worker,
  ];
  let output = { stdout: "", stderr: "" };
  let exited = false;
  const waiters: Array<() => void> = [];
  const child = spawn(process.execPath, args, { cwd: root, env, stdio: ["pipe", "pipe", "pipe"] });
  for (const stream of ["stdout", "stderr"] as const) {
    child[stream]?.on("data", (chunk: Buffer) => {
      output = { ...output, [stream]: output[stream] + chunk.toString("utf8") };
      for (const wake of waiters.splice(0)) wake();
    });
  }
  const closed = new Promise<number | null>((resolveClose) => {
    child.once("close", (code) => {
      exited = true;
      resolveClose(code);
      for (const wake of waiters.splice(0)) wake();
    });
  });
  return {
    child,
    closed,
    stdout: () => output.stdout,
    stderr: () => output.stderr,
    marker: (stream: "stdout" | "stderr", text: string) =>
      new Promise<void>((resolveMarker, rejectMarker) => {
        const check = () => {
          if (output[stream].includes(text)) resolveMarker();
          else if (exited)
            rejectMarker(
              new Error(`lease helper exited before ${JSON.stringify(text)}: ${output.stderr}`),
            );
          else waiters.push(check);
        };
        check();
      }),
  };
}

async function leaseWorkerEnvironment(
  root: string,
  key: string,
  leaseId: string,
): Promise<NodeJS.ProcessEnv> {
  const stat = await lstat(root);
  return {
    DOCSFAB_RECEIPT_ROOT_IDENTITY: JSON.stringify({
      dev: stat.dev,
      ino: stat.ino,
      uid: stat.uid,
      mode: stat.mode & 0o7777,
    }),
    DOCSFAB_RECEIPT_IDEMPOTENCY_KEY: key,
    DOCSFAB_RECEIPT_LEASE_ID: leaseId,
    DOCSFAB_RECEIPT_PUBLISHER_PID: String(process.pid),
    DOCSFAB_RECEIPT_LEASE_RECORD_MAX_BYTES: String(
      limit("delivery.mergeRequestLeaseRecordMaxBytes").value,
    ),
    LC_ALL: "C",
    LANG: "C",
  };
}

function directory(): Promise<string> {
  return temporary.create("docsfab-receipts-");
}

function publicationTemporary(destination: string, uuid: string): string {
  return `.${destination}.${uuid}.tmp`;
}

function delayedUnlink(path: string, delayMs: number): Promise<void> {
  return new Promise((resolveDelay, rejectDelay) => {
    setTimeout(() => {
      void unlink(path).then(resolveDelay, rejectDelay);
    }, delayMs);
  });
}

function inputs() {
  const candidate = {
    schemaVersion: 1,
    kind: "docsfab-local-user-gitlab-publication-plan",
    deliveryMode: "local-user",
    authorityBasis: "interactive-once",
    run: { id: "run-store", recordSha256: "d".repeat(64) },
    project: { id: 42, host: "gitlab.example.test", path: "group/docs" },
    remote: { name: "origin", transport: "ssh" },
    identity: {
      git: "configured",
      gitIdentitySha256: localUserGitIdentitySha256("Maintainer", "maintainer@example.test"),
      gitlabUsername: "maintainer",
    },
    baseRevision: "a".repeat(40),
    targetBranch: { name: "main", protected: true },
    proposedSourceBranch: "docsfab-run/run-store",
    patch: { format: "git-diff", sha256: "b".repeat(64), byteLength: 10, changedFileCount: 1 },
    validationCommand: "npm run check",
    mergeRequest: { draft: true },
    fallback: { mode: "patch-only", preserved: true },
    checks: {
      repository: "passed",
      remote: "passed",
      revision: "current",
      gitIdentity: "configured",
      gitlabAuthentication: "authenticated",
      pushAccess: "allowed",
      sourceBranch: "unprotected",
    },
  } as const;
  const plan: LocalUserPublicationPlanV1 = {
    ...candidate,
    sha256: localUserPublicationPlanSha256(candidate as never),
  };
  const authorization = authorizeLocalUserPublication({
    plan,
    confirmedPlanSha256: plan.sha256,
    command: "publish",
  });
  return { plan, authorization };
}

function currentInputs(): {
  plan: LocalUserPublicationPlanV2;
  authorization: ReturnType<typeof authorizeLocalUserPublication>;
} {
  const historical = inputs().plan;
  const selected = selectDocumentationValidationProfile({
    workflow: "update-documentation",
    changedPaths: ["docs/guide.md"],
    hostPolicySha256: "a".repeat(64),
    applicabilitySha256: "9".repeat(64),
  });
  const { schemaVersion: _schemaVersion, sha256: _sha256, ...common } = historical;
  const candidate = {
    ...common,
    schemaVersion: 2 as const,
    validationCommand: selected.entrypointCommand,
    documentationValidation: selected.binding,
  };
  const plan: LocalUserPublicationPlanV2 = {
    ...candidate,
    sha256: localUserPublicationPlanSha256(candidate),
  };
  return {
    plan,
    authorization: authorizeLocalUserPublication({
      plan,
      confirmedPlanSha256: plan.sha256,
      command: "publish",
    }),
  };
}

function digestText(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function digestJson(value: JsonEvidenceValue): string {
  return createHash("sha256").update(canonicalizeJsonEvidence(value)).digest("hex");
}
import { createHash } from "node:crypto";
