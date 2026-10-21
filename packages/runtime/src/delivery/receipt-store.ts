// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash, randomUUID } from "node:crypto";
import { type ChildProcess, spawn } from "node:child_process";
import { constants, type Stats } from "node:fs";
import { lstat, mkdir, open, realpath } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";

import {
  formatLimitExceeded,
  formatLimitObservation,
  limit,
  type ResolvedLimit,
} from "../config/limits.js";
import { canonicalizeJsonEvidence, type JsonEvidenceValue } from "../json-evidence.js";
import { assertLocalUserPublicationPlan, type LocalUserPublicationPlan } from "./contracts.js";
import {
  classifyReceiptHelperExit,
  type ReceiptHelperExit,
  receiptHelperReportCollector,
} from "./receipt-helper-exit.js";
import {
  JOURNAL_WORKER,
  MAX_RECEIPT_BYTES,
  PLAN_WORKER,
} from "./receipt-store/worker-publication.js";
import {
  MERGE_REQUEST_LEASE_CLEANUP_WORKER,
  MERGE_REQUEST_LEASE_WORKER,
} from "./receipt-store/worker-lease.js";
import {
  assertScmDeliveryRecordShape,
  scmDeliveryIdempotencyKey,
  type ScmDeliveryRecord,
} from "./receipt.js";
import { isRecord, isNodeError } from "../shared/primitives.js";
import { withRunMaintenanceGate } from "../records/run-maintenance-gate.js";
import {
  assertReviewDeliveryRecordShape,
  assertReviewDeliveryTransition,
  type ReviewDeliveryRecordV1,
} from "../review-delivery/receipt.js";

const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const SHA256 = /^[a-f0-9]{64}$/u;

export type ScmDeliveryReceiptStoreErrorCode =
  | "invalid-root"
  | "unsupported-platform"
  | "unsafe-root"
  | "unsafe-entry"
  | "receipt-conflict"
  | "receipt-missing"
  | "receipt-invalid"
  | "write-failed"
  | "helper-failed";

/** Child process that performs one isolated receipt-store filesystem exchange. */
export type ScmDeliveryReceiptHelper = "plan" | "journal" | "lease" | "lease-cleanup";

/**
 * How a helper stopped outside its exit protocol. Only a helper's own exit
 * code reports `unsafe-root` (including a lease helper's unexpected filesystem
 * error, which it reports as a lock-integrity refusal). None of these outcomes
 * says anything about the receipt root, so each reports `helper-failed`.
 */
export type ScmDeliveryReceiptHelperFailure =
  /** The helper process could not be started. */
  | "spawn"
  /** `delivery.receiptHelperTimeoutMs` elapsed and the store killed the helper. */
  | "timeout"
  /** A signal the store did not send ended the helper. */
  | "signal"
  /** The helper exited with a code outside its protocol. */
  | "exit"
  /** The helper closed its input before the store finished the exchange. */
  | "pipe"
  /** The helper wrote output outside its protocol. */
  | "protocol";

/** Observed helper outcome attached to a receipt-store error. */
export interface ScmDeliveryReceiptHelperOutcome {
  readonly helper: ScmDeliveryReceiptHelper;
  /** Present when the code is `helper-failed`. */
  readonly failure?: ScmDeliveryReceiptHelperFailure;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  /**
   * Bound refusal text: the elapsed timeout when `failure` is `timeout`, the
   * oversized output when it is `protocol`, and the exhausted attempts when a
   * lease stayed held (`receipt-conflict`).
   */
  readonly limit?: string;
  /** Process the held lease's owner record named on the last attempt. */
  readonly holderPid?: number;
  /**
   * The helper's own report of an uncaught failure: one of its verdict
   * messages, a platform errno name such as `ELOOP`, `syntax`, or `unexpected`.
   */
  readonly reason?: string;
}

export class ScmDeliveryReceiptStoreError extends Error {
  public constructor(
    public readonly code: ScmDeliveryReceiptStoreErrorCode,
    public readonly helper?: ScmDeliveryReceiptHelperOutcome,
  ) {
    super(
      `SCM delivery receipt store failed (${code}${helper ? `: ${describeHelperOutcome(helper)}` : ""}).`,
    );
    this.name = "ScmDeliveryReceiptStoreError";
  }
}

function describeHelperOutcome(outcome: ScmDeliveryReceiptHelperOutcome): string {
  const described = describeHelperStop(outcome);
  return outcome.reason === undefined ? described : `${described}: ${outcome.reason}`;
}

function describeHelperStop(outcome: ScmDeliveryReceiptHelperOutcome): string {
  const name = `${outcome.helper} helper`;
  switch (outcome.failure) {
    case "spawn":
      return `${name} could not start`;
    case "timeout":
      return `${name} timed out: ${outcome.limit ?? RECEIPT_HELPER_TIMEOUT_LIMIT}`;
    case "pipe":
      return `${name} closed its input before the exchange finished`;
    case "protocol":
      return `${name} wrote output outside its protocol${outcome.limit ? `: ${outcome.limit}` : ""}`;
    default:
      if (outcome.limit !== undefined) {
        const holder =
          outcome.holderPid === undefined
            ? ""
            : ` (its owner record names publisher process ${outcome.holderPid})`;
        return `${name} found the lease held on every attempt${holder}: ${outcome.limit}`;
      }
      return outcome.signal
        ? `${name} was ended by ${outcome.signal}`
        : `${name} exited with code ${outcome.exitCode}`;
  }
}

export interface ScmDeliveryReceiptClaim {
  record: ScmDeliveryRecord;
  created: boolean;
}

export interface ScmDeliveryReceiptStore {
  load(idempotencyKey: string): Promise<ScmDeliveryRecord | undefined>;
  /** Load the immutable plan bound before the first durable receipt claim. */
  loadPlan?(planSha256: string): Promise<LocalUserPublicationPlan | undefined>;
  claim(
    record: ScmDeliveryRecord,
    plan?: LocalUserPublicationPlan,
    assertAuthorized?: () => void,
  ): Promise<ScmDeliveryReceiptClaim>;
  compareAndSwap(
    expectedSha256: string,
    record: ScmDeliveryRecord,
    assertAuthorized?: () => void,
  ): Promise<ScmDeliveryRecord>;
  /** Cross-process, crash-releasing serialization for the non-idempotent MR POST. */
  withMergeRequestLease?<T>(idempotencyKey: string, action: () => Promise<T>): Promise<T>;
  loadReview?(idempotencyKey: string): Promise<ReviewDeliveryRecordV1 | undefined>;
  claimReview?(
    record: ReviewDeliveryRecordV1,
    assertAuthorized: () => void | Promise<void>,
  ): Promise<ScmDeliveryReviewReceiptClaim>;
  /** Empty destination only; the caller must authenticate the configured source fence. */
  claimReviewImport?(
    record: ReviewDeliveryRecordV1,
    assertAuthorized: () => void | Promise<void>,
  ): Promise<ScmDeliveryReviewReceiptClaim>;
  compareAndSwapReview?(
    expectedSha256: string,
    record: ReviewDeliveryRecordV1,
    assertAuthorized: () => void | Promise<void>,
  ): Promise<ReviewDeliveryRecordV1>;
  withReviewDeliveryLease?<T>(
    idempotencyKey: string,
    assertAuthorized: () => void | Promise<void>,
    action: (assertHeldReviewIntent: (recordSha256: string) => Promise<void>) => Promise<T>,
  ): Promise<T>;
}

export interface ScmDeliveryReviewReceiptClaim {
  readonly record: ReviewDeliveryRecordV1;
  readonly created: boolean;
}

export interface FileScmDeliveryReceiptStoreOptions {
  /** Adversarial test seam after an import observes the live receipt-root gate owner. */
  afterReviewImportGateContention?: () => void | Promise<void>;
  /** Adversarial test seam after the helper holds the journal cwd. */
  beforeJournalOperation?: (
    operation: JournalWorkerRequest["operation"],
    idempotencyKey: string,
  ) => void | Promise<void>;
  /** Adversarial test seam after the plan helper holds the exact receipt root. */
  beforePlanOperation?: (
    operation: PlanWorkerRequest["operation"],
    planSha256: string,
  ) => void | Promise<void>;
  /** Adversarial test seam after the lease helper reports exact ownership. */
  afterMergeRequestLeaseReady?: (helperPid: number, idempotencyKey: string) => void | Promise<void>;
  /** Adversarial test seam called synchronously after each helper process starts. */
  afterHelperSpawn?: HelperSpawnObserver;
}

type HelperSpawnObserver = (helper: ScmDeliveryReceiptHelper, pid: number) => void;

const RECEIPT_HELPER_TIMEOUT_LIMIT = "delivery.receiptHelperTimeoutMs";
const RECEIPT_PUBLICATION_SETTLE_LIMIT = "delivery.receiptPublicationSettleMs";
const MERGE_REQUEST_LEASE_ATTEMPTS_LIMIT = "delivery.mergeRequestLeaseAttempts";
const MERGE_REQUEST_LEASE_RETRY_PAUSE_LIMIT = "delivery.mergeRequestLeaseRetryPauseMs";
const MERGE_REQUEST_LEASE_RECORD_BYTES_LIMIT = "delivery.mergeRequestLeaseRecordMaxBytes";

interface ReceiptEnvelope {
  schemaVersion: 1;
  kind: "docsfab-scm-delivery-receipt-slot";
  sequence: number;
  previousRecordSha256: string | null;
  record: ScmDeliveryRecord;
  sha256: string;
}

interface ReviewReceiptEnvelope {
  schemaVersion: 1;
  kind: "docsfab-review-delivery-receipt-slot";
  sequence: number;
  previousRecordSha256: string | null;
  record: ReviewDeliveryRecordV1;
  sha256: string;
}

interface PublicationPlanEnvelope {
  schemaVersion: 1;
  kind: "docsfab-scm-publication-plan-binding";
  idempotencyKey: string;
  plan: LocalUserPublicationPlan;
  sha256: string;
}

/** Crash-safe owner-private append-only CAS journal. */
export class FileScmDeliveryReceiptStore implements ScmDeliveryReceiptStore {
  private readonly root: string;

  public get reviewRootPath(): string {
    return this.root;
  }

  public constructor(
    root: string,
    private readonly options: FileScmDeliveryReceiptStoreOptions = {},
  ) {
    if (!isAbsolute(root) || root.includes("\0")) fail("invalid-root");
    this.root = resolve(root);
  }

  public async load(idempotencyKey: string): Promise<ScmDeliveryRecord | undefined> {
    key(idempotencyKey);
    const root = await privateDirectory(this.root, false, false);
    try {
      const result = await runJournalWorker(
        root,
        { operation: "load", idempotencyKey },
        this.options.beforeJournalOperation,
        undefined,
        this.options.afterHelperSpawn,
      );
      await assertDirectory(root);
      await assertJournalPath(root, idempotencyKey, result.journal);
      return result.envelope ? validateEnvelope(result.envelope).record : undefined;
    } finally {
      await root.handle.close().catch(() => undefined);
    }
  }

  /** Read an existing journal's pinned dialect; never reinterpret a failed chain. */
  public async loadEither(
    idempotencyKey: string,
  ): Promise<
    | { readonly kind: "scm"; readonly record: ScmDeliveryRecord }
    | { readonly kind: "review"; readonly record: ReviewDeliveryRecordV1 }
    | undefined
  > {
    key(idempotencyKey);
    const root = await privateDirectory(this.root, false, false);
    try {
      const result = await runJournalWorker(
        root,
        { operation: "load", idempotencyKey, dialect: "auto" },
        this.options.beforeJournalOperation,
        undefined,
        this.options.afterHelperSpawn,
      );
      await assertDirectory(root);
      await assertJournalPath(root, idempotencyKey, result.journal);
      if (result.envelope === null) return undefined;
      if (!isRecord(result.envelope)) fail("receipt-invalid");
      if (result.envelope.kind === "docsfab-scm-delivery-receipt-slot")
        return { kind: "scm", record: validateEnvelope(result.envelope).record };
      if (result.envelope.kind === "docsfab-review-delivery-receipt-slot")
        return { kind: "review", record: validateReviewEnvelope(result.envelope).record };
      return fail("receipt-invalid");
    } finally {
      await root.handle.close().catch(() => undefined);
    }
  }

  public async loadPlan(planSha256: string): Promise<LocalUserPublicationPlan | undefined> {
    key(planSha256);
    const root = await privateDirectory(this.root, false, false);
    try {
      const envelope = await runPlanWorker(
        root,
        { operation: "load", planSha256 },
        this.options.beforePlanOperation,
        this.options.afterHelperSpawn,
      );
      await assertDirectory(root);
      return envelope === null ? undefined : validatePlanEnvelope(envelope, planSha256).plan;
    } finally {
      await root.handle.close().catch(() => undefined);
    }
  }

  public async claim(
    recordValue: ScmDeliveryRecord,
    plan?: LocalUserPublicationPlan,
    assertAuthorized?: () => void,
  ): Promise<ScmDeliveryReceiptClaim> {
    const root = await privateDirectory(this.root, true, true, assertAuthorized);
    await root.handle.close();
    return withRunMaintenanceGate(this.root, () =>
      this.claimUnderGate(recordValue, plan, assertAuthorized),
    );
  }

  private async claimUnderGate(
    recordValue: ScmDeliveryRecord,
    plan?: LocalUserPublicationPlan,
    assertAuthorized?: () => void,
  ): Promise<ScmDeliveryReceiptClaim> {
    const record = validateRecord(recordValue);
    const root = await privateDirectory(this.root, true, true, assertAuthorized);
    try {
      if (plan !== undefined) {
        assertLocalUserPublicationPlan(plan);
        if (
          plan.sha256 !== record.planSha256 ||
          scmDeliveryIdempotencyKey(plan) !== record.idempotencyKey
        )
          fail("receipt-conflict");
        const envelope = makePlanEnvelope(plan, record.idempotencyKey);
        const bound = await runPlanWorker(
          root,
          {
            operation: "bind",
            planSha256: plan.sha256,
            envelope,
          },
          async (operation, planSha256) => {
            await this.options.beforePlanOperation?.(operation, planSha256);
            assertAuthorized?.();
          },
          this.options.afterHelperSpawn,
        );
        validatePlanEnvelope(bound, plan.sha256);
      }
      const result = await runJournalWorker(
        root,
        {
          operation: "claim",
          idempotencyKey: record.idempotencyKey,
          envelope: makeEnvelope(0, null, record),
        },
        this.options.beforeJournalOperation,
        assertAuthorized,
        this.options.afterHelperSpawn,
      );
      await assertDirectory(root);
      await assertJournalPath(root, record.idempotencyKey, result.journal);
      if (result.code === "receipt-conflict") fail("receipt-conflict");
      if (!result.envelope) fail("receipt-missing");
      const winner = validateEnvelope(result.envelope).record;
      if (winner.planSha256 !== record.planSha256) fail("receipt-conflict");
      return { record: winner, created: result.created === true };
    } finally {
      await root.handle.close().catch(() => undefined);
    }
  }

  public async compareAndSwap(
    expectedSha256: string,
    recordValue: ScmDeliveryRecord,
    assertAuthorized?: () => void,
  ): Promise<ScmDeliveryRecord> {
    return withRunMaintenanceGate(this.root, () =>
      this.compareAndSwapUnderGate(expectedSha256, recordValue, assertAuthorized),
    );
  }

  private async compareAndSwapUnderGate(
    expectedSha256: string,
    recordValue: ScmDeliveryRecord,
    assertAuthorized?: () => void,
  ): Promise<ScmDeliveryRecord> {
    key(expectedSha256);
    const record = validateRecord(recordValue);
    const root = await privateDirectory(this.root, false, false);
    try {
      const current = await runJournalWorker(
        root,
        {
          operation: "inspect",
          idempotencyKey: record.idempotencyKey,
        },
        this.options.beforeJournalOperation,
        undefined,
        this.options.afterHelperSpawn,
      );
      if (!current.envelope) fail("receipt-missing");
      const previous = validateEnvelope(current.envelope);
      if (previous.record.sha256 === expectedSha256 && record.sha256 === expectedSha256) {
        await assertDirectory(root);
        await assertJournalPath(root, record.idempotencyKey, current.journal);
        return previous.record;
      }
      const result = await runJournalWorker(
        root,
        {
          operation: "cas",
          idempotencyKey: record.idempotencyKey,
          expectedSha256,
          expectedJournal: current.journal,
          envelope: makeEnvelope(previous.sequence + 1, expectedSha256, record),
        },
        this.options.beforeJournalOperation,
        assertAuthorized,
        this.options.afterHelperSpawn,
      );
      await assertDirectory(root);
      await assertJournalPath(root, record.idempotencyKey, result.journal);
      if (result.code === "receipt-conflict") fail("receipt-conflict");
      if (!result.envelope) fail("receipt-missing");
      const winner = validateEnvelope(result.envelope).record;
      if (winner.sha256 !== record.sha256) fail("receipt-conflict");
      return winner;
    } finally {
      await root.handle.close().catch(() => undefined);
    }
  }

  public async withMergeRequestLease<T>(
    idempotencyKey: string,
    action: () => Promise<T>,
  ): Promise<T> {
    key(idempotencyKey);
    const root = await privateDirectory(this.root, false, false);
    try {
      const lease = await acquireMergeRequestLease(
        root,
        idempotencyKey,
        this.options.afterMergeRequestLeaseReady,
        this.options.afterHelperSpawn,
      );
      try {
        return await action();
      } finally {
        await lease.release();
        await assertDirectory(root);
      }
    } finally {
      await root.handle.close().catch(() => undefined);
    }
  }

  public async loadReview(idempotencyKey: string): Promise<ReviewDeliveryRecordV1 | undefined> {
    key(idempotencyKey);
    const root = await privateDirectory(this.root, false, false);
    try {
      const result = await runJournalWorker(
        root,
        { operation: "load", idempotencyKey, dialect: "review" },
        this.options.beforeJournalOperation,
        undefined,
        this.options.afterHelperSpawn,
      );
      await assertDirectory(root);
      await assertJournalPath(root, idempotencyKey, result.journal);
      return result.envelope ? validateReviewEnvelope(result.envelope).record : undefined;
    } finally {
      await root.handle.close().catch(() => undefined);
    }
  }

  public async claimReview(
    recordValue: ReviewDeliveryRecordV1,
    assertAuthorized: () => void | Promise<void>,
  ): Promise<ScmDeliveryReviewReceiptClaim> {
    const record = validateReviewRecord(recordValue);
    if (
      record.ownerStoreId !== record.originStoreId ||
      record.generation !== 0 ||
      record.custody.state !== "active" ||
      record.custody.transferId !== null ||
      record.custody.otherStoreId !== null ||
      record.effects.length !== 0 ||
      record.context.committedEffects.length !== 0 ||
      record.preparationStop !== null
    )
      fail("receipt-invalid");
    await assertAuthorized();
    const root = await privateDirectory(this.root, true, true);
    await root.handle.close();
    return withRunMaintenanceGate(this.root, async () => {
      await assertAuthorized();
      const held = await privateDirectory(this.root, true, true);
      try {
        const result = await runJournalWorker(
          held,
          {
            operation: "claim",
            idempotencyKey: record.idempotencyKey,
            dialect: "review",
            envelope: makeReviewEnvelope(0, null, record),
          },
          this.options.beforeJournalOperation,
          assertAuthorized,
          this.options.afterHelperSpawn,
        );
        await assertDirectory(held);
        await assertJournalPath(held, record.idempotencyKey, result.journal);
        if (result.code === "receipt-conflict") fail("receipt-conflict");
        if (!result.envelope) fail("receipt-missing");
        const winner = validateReviewEnvelope(result.envelope).record;
        if (
          winner.manifest.manifestSha256 !== record.manifest.manifestSha256 ||
          winner.originStoreId !== record.originStoreId
        )
          fail("receipt-conflict");
        return { record: winner, created: result.created === true };
      } finally {
        await held.handle.close().catch(() => undefined);
      }
    });
  }

  public async claimReviewImport(
    recordValue: ReviewDeliveryRecordV1,
    assertAuthorized: () => void | Promise<void>,
  ): Promise<ScmDeliveryReviewReceiptClaim> {
    const record = validateReviewRecord(recordValue);
    if (
      record.custody.state !== "import-pending" ||
      record.custody.transferId === null ||
      record.custody.otherStoreId === null ||
      record.ownerStoreId === record.originStoreId ||
      record.ownerStoreId === record.custody.otherStoreId ||
      record.generation < 1
    )
      fail("receipt-invalid");
    await assertAuthorized();
    const root = await privateDirectory(this.root, true, true);
    await root.handle.close();
    return withRunMaintenanceGate(
      this.root,
      async () => {
        await assertAuthorized();
        const held = await privateDirectory(this.root, true, true);
        try {
          const result = await runJournalWorker(
            held,
            {
              operation: "claim",
              idempotencyKey: record.idempotencyKey,
              dialect: "review",
              envelope: makeReviewEnvelope(0, null, record),
            },
            this.options.beforeJournalOperation,
            assertAuthorized,
            this.options.afterHelperSpawn,
          );
          await assertDirectory(held);
          await assertJournalPath(held, record.idempotencyKey, result.journal);
          if (result.code === "receipt-conflict") fail("receipt-conflict");
          if (!result.envelope) fail("receipt-missing");
          const winner = validateReviewEnvelope(result.envelope).record;
          if (winner.sha256 !== record.sha256) fail("receipt-conflict");
          return { record: winner, created: result.created === true };
        } finally {
          await held.handle.close().catch(() => undefined);
        }
      },
      this.options.afterReviewImportGateContention,
    );
  }

  public async compareAndSwapReview(
    expectedSha256: string,
    recordValue: ReviewDeliveryRecordV1,
    assertAuthorized: () => void | Promise<void>,
  ): Promise<ReviewDeliveryRecordV1> {
    key(expectedSha256);
    const record = validateReviewRecord(recordValue);
    return withRunMaintenanceGate(this.root, async () => {
      const root = await privateDirectory(this.root, false, false);
      try {
        const current = await runJournalWorker(
          root,
          { operation: "inspect", idempotencyKey: record.idempotencyKey, dialect: "review" },
          this.options.beforeJournalOperation,
          undefined,
          this.options.afterHelperSpawn,
        );
        if (!current.envelope) fail("receipt-missing");
        const previous = validateReviewEnvelope(current.envelope);
        if (previous.record.sha256 === expectedSha256 && record.sha256 === expectedSha256) {
          await assertDirectory(root);
          await assertJournalPath(root, record.idempotencyKey, current.journal);
          return previous.record;
        }
        assertReviewDeliveryTransition(previous.record, record);
        const result = await runJournalWorker(
          root,
          {
            operation: "cas",
            idempotencyKey: record.idempotencyKey,
            dialect: "review",
            expectedSha256,
            expectedJournal: current.journal,
            envelope: makeReviewEnvelope(previous.sequence + 1, expectedSha256, record),
          },
          this.options.beforeJournalOperation,
          assertAuthorized,
          this.options.afterHelperSpawn,
        );
        await assertDirectory(root);
        await assertJournalPath(root, record.idempotencyKey, result.journal);
        if (result.code === "receipt-conflict") fail("receipt-conflict");
        if (!result.envelope) fail("receipt-missing");
        const winner = validateReviewEnvelope(result.envelope).record;
        if (winner.sha256 !== record.sha256) fail("receipt-conflict");
        return winner;
      } finally {
        await root.handle.close().catch(() => undefined);
      }
    });
  }

  public async withReviewDeliveryLease<T>(
    idempotencyKey: string,
    assertAuthorized: () => void | Promise<void>,
    action: (assertHeldReviewIntent: (recordSha256: string) => Promise<void>) => Promise<T>,
  ): Promise<T> {
    key(idempotencyKey);
    await assertAuthorized();
    const root = await privateDirectory(this.root, true, true);
    try {
      const lease = await acquireMergeRequestLease(
        root,
        idempotencyKey,
        this.options.afterMergeRequestLeaseReady,
        this.options.afterHelperSpawn,
      );
      try {
        return await action(async (recordSha256) => {
          key(recordSha256);
          await lease.assertHeld();
          const inspected = await runJournalWorker(
            root,
            { operation: "inspect", idempotencyKey, dialect: "review" },
            this.options.beforeJournalOperation,
            undefined,
            this.options.afterHelperSpawn,
          );
          await lease.assertHeld();
          if (!inspected.envelope || !inspected.journal) fail("receipt-missing");
          await assertJournalPath(root, idempotencyKey, inspected.journal);
          if (validateReviewEnvelope(inspected.envelope).record.sha256 !== recordSha256)
            fail("receipt-conflict");
          await lease.assertHeld();
        });
      } finally {
        await lease.release();
        await assertDirectory(root);
      }
    } finally {
      await root.handle.close().catch(() => undefined);
    }
  }
}

interface JournalWorkerRequest {
  operation: "load" | "inspect" | "claim" | "cas";
  idempotencyKey: string;
  expectedSha256?: string;
  expectedJournal?: { dev: number; ino: number };
  envelope?: ReceiptEnvelope | ReviewReceiptEnvelope;
  dialect?: "review" | "auto";
}

interface JournalWorkerResult {
  envelope: unknown | null;
  journal?: { dev: number; ino: number };
  created?: boolean;
  code?: "receipt-conflict";
}

interface PlanWorkerRequest {
  operation: "load" | "bind";
  planSha256: string;
  envelope?: PublicationPlanEnvelope;
}

async function runPlanWorker(
  root: PrivateDirectory,
  request: PlanWorkerRequest,
  beforeOperation?: FileScmDeliveryReceiptStoreOptions["beforePlanOperation"],
  afterSpawn?: HelperSpawnObserver,
): Promise<unknown | null> {
  const input = Buffer.from(JSON.stringify(request), "utf8");
  if (input.byteLength > MAX_RECEIPT_BYTES * 2) fail("receipt-invalid");
  const timeout = helperTimeout();
  const settle = limit(RECEIPT_PUBLICATION_SETTLE_LIMIT);
  const started = performance.now();
  return new Promise((resolveResult, rejectResult) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", PLAN_WORKER], {
      cwd: root.path,
      env: {
        DOCSFAB_RECEIPT_ROOT_IDENTITY: JSON.stringify({
          dev: root.stat.dev,
          ino: root.stat.ino,
          uid: root.uid,
          mode: root.stat.mode & 0o7777,
        }),
        DOCSFAB_RECEIPT_PUBLICATION_SETTLE_MS: String(settle.value),
        LC_ALL: "C",
        LANG: "C",
      },
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    const report = collectHelperReport(child);
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    let ready = false;
    let pipeFailed = false;
    const finish = (error?: ScmDeliveryReceiptStoreError): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) rejectResult(error);
      else {
        try {
          const source = Buffer.concat(chunks).toString("utf8");
          const result = JSON.parse(source.startsWith("READY\n") ? source.slice(6) : source) as {
            envelope: unknown | null;
          };
          if (!isRecord(result) || !("envelope" in result)) throw new Error("invalid result");
          resolveResult(result.envelope);
        } catch {
          rejectResult(new ScmDeliveryReceiptStoreError("receipt-invalid"));
        }
      }
    };
    const terminate = (): void => terminateHelper(child);
    const timer = setTimeout(() => {
      terminate();
      finish(helperTimedOut("plan", timeout, started));
    }, timeout.value);
    observeSpawn(child, "plan", afterSpawn);
    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.byteLength;
      if (size > MAX_RECEIPT_BYTES * 2) {
        terminate();
        finish(new ScmDeliveryReceiptStoreError("receipt-invalid"));
      } else {
        chunks.push(Buffer.from(chunk));
        if (!ready && Buffer.concat(chunks).includes(Buffer.from("READY\n"))) {
          ready = true;
          Promise.resolve(beforeOperation?.(request.operation, request.planSha256))
            .then(() => child.stdin.end(Buffer.from("1")))
            .catch(() => {
              terminate();
              finish(new ScmDeliveryReceiptStoreError("unsafe-root"));
            });
        }
      }
    });
    child.once("error", () => finish(helperFailed("plan", "spawn")));
    child.once("close", (code, signal) => {
      const exit = classifyReceiptHelperExit({
        code,
        pipeFailed,
        unsafeRootCodes: [2],
        verdictCodes: [1],
      });
      finish(
        helperCloseError("plan", exit, code, signal, report.reason(), {
          verdict: request.operation === "load" ? "receipt-invalid" : "write-failed",
        }),
      );
    });
    // A broken input pipe ends the exchange; the helper's exit says why.
    child.stdin.once("error", () => {
      pipeFailed = true;
    });
    child.stdin.write(Buffer.concat([input, Buffer.from("\n")]));
  });
}

async function runJournalWorker(
  root: PrivateDirectory,
  request: JournalWorkerRequest,
  beforeOperation?: FileScmDeliveryReceiptStoreOptions["beforeJournalOperation"],
  assertAuthorized?: () => void | Promise<void>,
  afterSpawn?: HelperSpawnObserver,
): Promise<JournalWorkerResult> {
  const identity = JSON.stringify({
    dev: root.stat.dev,
    ino: root.stat.ino,
    uid: root.uid,
    mode: root.stat.mode & 0o7777,
  });
  const input = Buffer.from(JSON.stringify(request), "utf8");
  if (input.byteLength > MAX_RECEIPT_BYTES * 2) fail("receipt-invalid");
  const timeout = helperTimeout();
  const settle = limit(RECEIPT_PUBLICATION_SETTLE_LIMIT);
  const started = performance.now();
  return new Promise((resolveResult, rejectResult) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", JOURNAL_WORKER], {
      cwd: root.path,
      env: {
        DOCSFAB_RECEIPT_ROOT_IDENTITY: identity,
        DOCSFAB_RECEIPT_PUBLICATION_SETTLE_MS: String(settle.value),
        LC_ALL: "C",
        LANG: "C",
      },
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    const report = collectHelperReport(child);
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    let mutationReady = false;
    let ready = false;
    let pipeFailed = false;
    const finish = (error?: ScmDeliveryReceiptStoreError): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) rejectResult(error);
      else {
        try {
          let source = Buffer.concat(chunks).toString("utf8");
          if (source.startsWith("MUTATE\n")) source = source.slice(7);
          if (source.startsWith("READY\n")) source = source.slice(6);
          const value = JSON.parse(source) as JournalWorkerResult;
          if (!isRecord(value) || !("envelope" in value)) fail("receipt-invalid");
          resolveResult(value);
        } catch {
          rejectResult(new ScmDeliveryReceiptStoreError("receipt-invalid"));
        }
      }
    };
    const terminate = (): void => terminateHelper(child);
    const timer = setTimeout(() => {
      terminate();
      finish(helperTimedOut("journal", timeout, started));
    }, timeout.value);
    observeSpawn(child, "journal", afterSpawn);
    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.byteLength;
      if (size > MAX_RECEIPT_BYTES * 2) {
        terminate();
        finish(new ScmDeliveryReceiptStoreError("receipt-invalid"));
      } else {
        chunks.push(Buffer.from(chunk));
        const output = Buffer.concat(chunks);
        if (!mutationReady && output.includes(Buffer.from("MUTATE\n"))) {
          mutationReady = true;
          Promise.resolve()
            .then(() => assertAuthorized?.())
            .then(() => child.stdin.write(Buffer.from("1")))
            .catch(() => {
              terminate();
              finish(new ScmDeliveryReceiptStoreError("unsafe-root"));
            });
        }
        if (!ready && output.includes(Buffer.from("READY\n"))) {
          ready = true;
          Promise.resolve(beforeOperation?.(request.operation, request.idempotencyKey))
            .then(() => assertAuthorized?.())
            .then(() => child.stdin.end(Buffer.from("1")))
            .catch(() => {
              terminate();
              finish(new ScmDeliveryReceiptStoreError("unsafe-root"));
            });
        }
      }
    });
    child.once("error", () => finish(helperFailed("journal", "spawn")));
    child.once("close", (code, signal) => {
      const exit = classifyReceiptHelperExit({
        code,
        pipeFailed,
        unsafeRootCodes: [2, 3],
        verdictCodes: [1],
      });
      finish(
        helperCloseError("journal", exit, code, signal, report.reason(), {
          verdict:
            request.operation === "load" || request.operation === "inspect"
              ? "receipt-invalid"
              : "write-failed",
        }),
      );
    });
    // A broken input pipe ends the exchange; the helper's exit says why.
    child.stdin.once("error", () => {
      pipeFailed = true;
    });
    child.stdin.write(Buffer.concat([input, Buffer.from("\n")]));
  });
}

async function acquireMergeRequestLease(
  root: PrivateDirectory,
  idempotencyKey: string,
  afterReady?: FileScmDeliveryReceiptStoreOptions["afterMergeRequestLeaseReady"],
  afterSpawn?: HelperSpawnObserver,
): Promise<{ assertHeld(): Promise<void>; release(): Promise<void> }> {
  const attempts = limit(MERGE_REQUEST_LEASE_ATTEMPTS_LIMIT);
  const pause = limit(MERGE_REQUEST_LEASE_RETRY_PAUSE_LIMIT);
  let holderPid: number | undefined;
  for (let attempt = 0; attempt < attempts.value; attempt += 1) {
    const outcome = await startMergeRequestLeaseWorker(root, idempotencyKey, afterSpawn);
    if ("release" in outcome) {
      try {
        await afterReady?.(outcome.helperPid, idempotencyKey);
        return outcome;
      } catch {
        await outcome.release().catch(() => undefined);
        fail("unsafe-root");
      }
    }
    holderPid = "holderPid" in outcome ? outcome.holderPid : undefined;
    await new Promise<void>((resolveWait) => setTimeout(resolveWait, pause.value));
  }
  throw leaseStayedHeld(attempts, holderPid);
}

/** The lease stayed held for every catalog attempt; name the last recorded holder. */
function leaseStayedHeld(
  attempts: ResolvedLimit,
  holderPid: number | undefined,
): ScmDeliveryReceiptStoreError {
  return new ScmDeliveryReceiptStoreError("receipt-conflict", {
    helper: "lease",
    exitCode: 3,
    signal: null,
    limit: formatLimitExceeded(attempts),
    ...(holderPid === undefined ? {} : { holderPid }),
  });
}

/** A lease attempt that found the lock held; `holderPid` when the helper named one. */
interface MergeRequestLeaseHeld {
  readonly holderPid?: number;
}

/** Line a lease helper writes to stderr when a live publisher holds the lock. */
const LEASE_HELD_LINE = /^DOCSFAB_LEASE_HELD ([1-9][0-9]{0,15})$/mu;

function startMergeRequestLeaseWorker(
  root: PrivateDirectory,
  idempotencyKey: string,
  afterSpawn?: HelperSpawnObserver,
): Promise<
  | { helperPid: number; assertHeld(): Promise<void>; release(): Promise<void> }
  | MergeRequestLeaseHeld
> {
  const timeout = helperTimeout();
  const recordBytes = limit(MERGE_REQUEST_LEASE_RECORD_BYTES_LIMIT);
  const started = performance.now();
  return new Promise((resolveLease, rejectLease) => {
    const leaseId = createHash("sha256").update(randomUUID()).digest("hex");
    const rootIdentity = JSON.stringify({
      dev: root.stat.dev,
      ino: root.stat.ino,
      uid: root.uid,
      mode: root.stat.mode & 0o7777,
    });
    const child = spawn(
      process.execPath,
      ["--input-type=module", "-e", MERGE_REQUEST_LEASE_WORKER],
      {
        cwd: root.path,
        env: {
          DOCSFAB_RECEIPT_ROOT_IDENTITY: rootIdentity,
          DOCSFAB_RECEIPT_IDEMPOTENCY_KEY: idempotencyKey,
          DOCSFAB_RECEIPT_LEASE_ID: leaseId,
          DOCSFAB_RECEIPT_PUBLISHER_PID: String(process.pid),
          DOCSFAB_RECEIPT_LEASE_RECORD_MAX_BYTES: String(recordBytes.value),
          LC_ALL: "C",
          LANG: "C",
        },
        detached: process.platform !== "win32",
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      },
    );
    const report = collectHelperReport(child);
    // Keep at most one record's worth of stderr for the holder line; the
    // failure report above reads the same stream through its own vocabulary.
    let diagnostics = Buffer.alloc(0);
    child.stderr.on("data", (chunk: Buffer) => {
      if (diagnostics.byteLength < recordBytes.value)
        diagnostics = Buffer.concat([diagnostics, chunk]).subarray(0, recordBytes.value);
    });
    let output = Buffer.alloc(0);
    let ready = false;
    let settled = false;
    let timedOut = false;
    const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolveClose) => {
        child.once("close", (code, signal) => resolveClose({ code, signal }));
      },
    );
    const timer = setTimeout(() => {
      timedOut = true;
      terminateHelper(child);
    }, timeout.value);
    observeSpawn(child, "lease", afterSpawn);
    // The helper can die after READY; its exit code drives release cleanup, and
    // the late gate write's EPIPE must not crash the publisher.
    child.stdin.on("error", () => undefined);
    child.stdout.on("data", (chunk: Buffer) => {
      if (settled) return;
      output = Buffer.concat([output, chunk]);
      if (output.byteLength > recordBytes.value) {
        settled = true;
        clearTimeout(timer);
        child.kill("SIGKILL");
        rejectLease(
          helperFailed("lease", "protocol", formatLimitObservation(recordBytes, output.byteLength)),
        );
      } else if (output.at(-1) === 10 && output.subarray(0, 6).equals(Buffer.from("READY "))) {
        try {
          const lockIdentity = JSON.parse(output.subarray(6).toString("utf8"));
          if (
            !isRecord(lockIdentity) ||
            !Number.isSafeInteger(lockIdentity.dev) ||
            !Number.isSafeInteger(lockIdentity.ino) ||
            !child.pid
          ) {
            throw new Error("invalid lease identity");
          }
          ready = true;
          settled = true;
          clearTimeout(timer);
          resolveLease({
            helperPid: child.pid,
            assertHeld: async () => {
              if (child.exitCode !== null || child.signalCode !== null) fail("unsafe-root");
              await assertMergeRequestLeaseHeld(
                root,
                idempotencyKey,
                leaseId,
                lockIdentity as { dev: number; ino: number },
              );
            },
            release: async () => {
              if (child.exitCode === null && child.signalCode === null)
                child.stdin.end(Buffer.from("1"));
              const { code } = await closed;
              if (code !== 0) {
                await cleanupMergeRequestLease(
                  root,
                  {
                    idempotencyKey,
                    leaseId,
                    publisherPid: process.pid,
                    lockIdentity: lockIdentity as { dev: number; ino: number },
                    rootIdentity,
                  },
                  afterSpawn,
                );
              }
            },
          });
        } catch {
          settled = true;
          clearTimeout(timer);
          child.kill("SIGKILL");
          rejectLease(helperFailed("lease", "protocol"));
        }
      }
    });
    child.once("error", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      rejectLease(helperFailed("lease", "spawn"));
    });
    void closed.then(({ code, signal }) => {
      if (ready || settled) return;
      settled = true;
      clearTimeout(timer);
      // Exit 3 is the helper's own "held or released during inspection" verdict;
      // a held lock also names its recorded holder.
      if (code === 3) {
        const held = LEASE_HELD_LINE.exec(diagnostics.toString("utf8"));
        resolveLease(held ? { holderPid: Number(held[1]) } : {});
      } else if (timedOut) rejectLease(helperTimedOut("lease", timeout, started));
      else {
        const exit = classifyReceiptHelperExit({
          code,
          pipeFailed: false,
          unsafeRootCodes: [2],
          verdictCodes: [],
        });
        rejectLease(
          helperCloseError("lease", exit, code, signal, report.reason()) ??
            helperFailed("lease", "protocol"),
        );
      }
    });
  });
}

async function cleanupMergeRequestLease(
  root: PrivateDirectory,
  input: {
    idempotencyKey: string;
    leaseId: string;
    publisherPid: number;
    lockIdentity: { dev: number; ino: number };
    rootIdentity: string;
  },
  afterSpawn?: HelperSpawnObserver,
): Promise<void> {
  const timeout = helperTimeout();
  const recordBytes = limit(MERGE_REQUEST_LEASE_RECORD_BYTES_LIMIT);
  const started = performance.now();
  const child = spawn(
    process.execPath,
    ["--input-type=module", "-e", MERGE_REQUEST_LEASE_CLEANUP_WORKER],
    {
      cwd: root.path,
      env: {
        DOCSFAB_RECEIPT_ROOT_IDENTITY: input.rootIdentity,
        DOCSFAB_RECEIPT_LOCK_IDENTITY: JSON.stringify(input.lockIdentity),
        DOCSFAB_RECEIPT_IDEMPOTENCY_KEY: input.idempotencyKey,
        DOCSFAB_RECEIPT_LEASE_ID: input.leaseId,
        DOCSFAB_RECEIPT_PUBLISHER_PID: String(input.publisherPid),
        DOCSFAB_RECEIPT_LEASE_RECORD_MAX_BYTES: String(recordBytes.value),
        LC_ALL: "C",
        LANG: "C",
      },
      detached: process.platform !== "win32",
      stdio: ["ignore", "ignore", "pipe"],
      windowsHide: true,
    },
  );
  const report = collectHelperReport(child);
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    terminateHelper(child);
  }, timeout.value);
  const outcome = await new Promise<
    { spawned: false } | { spawned: true; code: number | null; signal: NodeJS.Signals | null }
  >((resolveClose) => {
    child.once("error", () => resolveClose({ spawned: false }));
    child.once("close", (code, signal) => resolveClose({ spawned: true, code, signal }));
    observeSpawn(child, "lease-cleanup", afterSpawn);
  });
  clearTimeout(timer);
  if (!outcome.spawned) throw helperFailed("lease-cleanup", "spawn");
  if (outcome.code === 0) return;
  if (timedOut) throw helperTimedOut("lease-cleanup", timeout, started);
  const exit = classifyReceiptHelperExit({
    code: outcome.code,
    pipeFailed: false,
    unsafeRootCodes: [2],
    verdictCodes: [],
  });
  const error = helperCloseError(
    "lease-cleanup",
    exit,
    outcome.code,
    outcome.signal,
    report.reason(),
  );
  if (error) throw error;
}

function collectHelperReport(child: ChildProcess): { reason(): string | undefined } {
  const collector = receiptHelperReportCollector();
  child.stderr?.on("data", (chunk: Buffer) => collector.receive(chunk));
  return collector;
}

/** Map a classified helper exit to the store error, or undefined on success. */
function helperCloseError(
  helper: ScmDeliveryReceiptHelper,
  exit: ReceiptHelperExit,
  exitCode: number | null,
  signal: NodeJS.Signals | null,
  reason: string | undefined,
  codes: { verdict?: ScmDeliveryReceiptStoreErrorCode } = {},
): ScmDeliveryReceiptStoreError | undefined {
  const observed = { helper, exitCode, signal, ...(reason === undefined ? {} : { reason }) };
  switch (exit.kind) {
    case "success":
      return undefined;
    case "unsafe-root":
      return new ScmDeliveryReceiptStoreError(
        "unsafe-root",
        reason === undefined ? undefined : observed,
      );
    case "verdict":
      return new ScmDeliveryReceiptStoreError(codes.verdict ?? "helper-failed", observed);
    case "stopped":
      return new ScmDeliveryReceiptStoreError("helper-failed", {
        ...observed,
        failure: exit.failure,
      });
  }
}

function helperTimeout(): ResolvedLimit {
  return limit(RECEIPT_HELPER_TIMEOUT_LIMIT);
}

function terminateHelper(child: ChildProcess): void {
  try {
    if (child.pid && process.platform !== "win32") process.kill(-child.pid, "SIGKILL");
    else child.kill("SIGKILL");
  } catch {
    child.kill("SIGKILL");
  }
}

function observeSpawn(
  child: ChildProcess,
  helper: ScmDeliveryReceiptHelper,
  afterSpawn: HelperSpawnObserver | undefined,
): void {
  if (afterSpawn && child.pid !== undefined) afterSpawn(helper, child.pid);
}

function helperFailed(
  helper: ScmDeliveryReceiptHelper,
  failure: ScmDeliveryReceiptHelperFailure,
  limitText?: string,
): ScmDeliveryReceiptStoreError {
  return new ScmDeliveryReceiptStoreError("helper-failed", {
    helper,
    failure,
    exitCode: null,
    signal: null,
    ...(limitText === undefined ? {} : { limit: limitText }),
  });
}

function helperTimedOut(
  helper: ScmDeliveryReceiptHelper,
  timeout: ResolvedLimit,
  started: number,
): ScmDeliveryReceiptStoreError {
  const observed = Math.max(timeout.value, Math.ceil(performance.now() - started));
  return new ScmDeliveryReceiptStoreError("helper-failed", {
    helper,
    failure: "timeout",
    exitCode: null,
    signal: "SIGKILL",
    limit: formatLimitObservation(timeout, observed),
  });
}

interface PrivateDirectory {
  path: string;
  uid: number;
  stat: Stats;
  handle: FileHandle;
}

/** Apply-only preparation for the default receipt-root gate; never chmod an existing root. */
export async function preparePrivateReceiptRootForDeletion(path: string): Promise<string> {
  const directory = await privateDirectory(path, true, false);
  try {
    return directory.path;
  } finally {
    await directory.handle.close();
  }
}

async function privateDirectory(
  path: string,
  create: boolean,
  allowTighten: boolean,
  authorizeMutation?: () => void,
): Promise<PrivateDirectory> {
  supported();
  try {
    await assertNoSymlinkAncestors(path);
    const before = await lstat(path).catch((error: unknown) =>
      isNodeError(error, "ENOENT") ? undefined : Promise.reject(error),
    );
    if (!before && create) {
      authorizeMutation?.();
      await mkdir(path, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
    } else if (!before) fail("unsafe-root");
    if (before?.isSymbolicLink() || (before && !before.isDirectory())) fail("unsafe-root");
    const canonicalBefore = await realpath(path);
    if (canonicalBefore !== canonicalSpelling(resolve(path))) fail("unsafe-root");
    const handle = await open(
      path,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    let stat = await handle.stat();
    const uid = process.getuid!();
    if (!stat.isDirectory() || stat.uid !== uid) {
      await handle.close();
      fail("unsafe-root");
    }
    if ((stat.mode & 0o7777) !== PRIVATE_DIRECTORY_MODE) {
      if (!allowTighten) {
        await handle.close();
        fail("unsafe-root");
      }
      authorizeMutation?.();
      await handle.chmod(PRIVATE_DIRECTORY_MODE);
      stat = await handle.stat();
    }
    const [leaf, canonicalAfter] = await Promise.all([lstat(path), realpath(path)]);
    if (
      !leaf.isDirectory() ||
      leaf.isSymbolicLink() ||
      leaf.uid !== uid ||
      leaf.dev !== stat.dev ||
      leaf.ino !== stat.ino ||
      canonicalAfter !== canonicalBefore ||
      (leaf.mode & 0o7777) !== PRIVATE_DIRECTORY_MODE
    ) {
      await handle.close();
      fail("unsafe-root");
    }
    return { path, uid, stat, handle };
  } catch (error) {
    if (error instanceof ScmDeliveryReceiptStoreError) throw error;
    fail("unsafe-root");
  }
}

function canonicalSpelling(path: string): string {
  if (process.platform !== "darwin") return path;
  if (path === "/var" || path.startsWith("/var/")) return `/private${path}`;
  if (path === "/tmp" || path.startsWith("/tmp/")) return `/private${path}`;
  return path;
}

async function assertNoSymlinkAncestors(path: string): Promise<void> {
  const ancestors: string[] = [];
  let cursor = resolve(path);
  while (true) {
    ancestors.push(cursor);
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  for (const ancestor of ancestors.reverse()) {
    const details = await lstat(ancestor).catch((error: unknown) =>
      isNodeError(error, "ENOENT") ? undefined : Promise.reject(error),
    );
    if (details?.isSymbolicLink()) {
      const canonical = await realpath(ancestor);
      const operatingSystemAlias =
        (ancestor === "/var" && canonical === "/private/var") ||
        (ancestor === "/tmp" && canonical === "/private/tmp");
      if (!operatingSystemAlias) fail("unsafe-root");
    }
  }
}

function makeEnvelope(
  sequence: number,
  previousRecordSha256: string | null,
  record: ScmDeliveryRecord,
): ReceiptEnvelope {
  const digestible = {
    schemaVersion: 1 as const,
    kind: "docsfab-scm-delivery-receipt-slot" as const,
    sequence,
    previousRecordSha256,
    record,
  };
  return { ...digestible, sha256: digest(digestible) };
}

function makeReviewEnvelope(
  sequence: number,
  previousRecordSha256: string | null,
  record: ReviewDeliveryRecordV1,
): ReviewReceiptEnvelope {
  const body = {
    schemaVersion: 1 as const,
    kind: "docsfab-review-delivery-receipt-slot" as const,
    sequence,
    previousRecordSha256,
    record,
  };
  return { ...body, sha256: digest(body) };
}

function makePlanEnvelope(
  plan: LocalUserPublicationPlan,
  idempotencyKey: string,
): PublicationPlanEnvelope {
  const body = {
    schemaVersion: 1 as const,
    kind: "docsfab-scm-publication-plan-binding" as const,
    idempotencyKey,
    plan,
  };
  return { ...body, sha256: digest(body) };
}

function validatePlanEnvelope(value: unknown, expectedPlanSha256: string): PublicationPlanEnvelope {
  try {
    if (
      !isRecord(value) ||
      Object.keys(value).sort().join("\0") !==
        ["idempotencyKey", "kind", "plan", "schemaVersion", "sha256"].join("\0") ||
      value.schemaVersion !== 1 ||
      value.kind !== "docsfab-scm-publication-plan-binding" ||
      typeof value.idempotencyKey !== "string" ||
      !SHA256.test(value.idempotencyKey) ||
      typeof value.sha256 !== "string" ||
      !SHA256.test(value.sha256)
    )
      fail("receipt-invalid");
    assertLocalUserPublicationPlan(value.plan);
    const plan = value.plan;
    if (
      plan.sha256 !== expectedPlanSha256 ||
      value.idempotencyKey !== scmDeliveryIdempotencyKey(plan)
    )
      fail("receipt-invalid");
    const envelope = value as unknown as PublicationPlanEnvelope;
    if (
      envelope.sha256 !==
      digest({
        schemaVersion: 1,
        kind: "docsfab-scm-publication-plan-binding",
        idempotencyKey: envelope.idempotencyKey,
        plan,
      })
    )
      fail("receipt-invalid");
    return { ...envelope, plan };
  } catch (error) {
    if (error instanceof ScmDeliveryReceiptStoreError) throw error;
    return fail("receipt-invalid");
  }
}

function validateEnvelope(value: unknown): ReceiptEnvelope {
  if (
    !isRecord(value) ||
    Object.keys(value).sort().join("\0") !==
      ["kind", "previousRecordSha256", "record", "schemaVersion", "sequence", "sha256"].join(
        "\0",
      ) ||
    value.schemaVersion !== 1 ||
    value.kind !== "docsfab-scm-delivery-receipt-slot" ||
    !Number.isSafeInteger(value.sequence) ||
    (value.sequence as number) < 0 ||
    (value.previousRecordSha256 !== null &&
      (typeof value.previousRecordSha256 !== "string" ||
        !SHA256.test(value.previousRecordSha256))) ||
    typeof value.sha256 !== "string" ||
    !SHA256.test(value.sha256)
  )
    fail("receipt-invalid");
  const record = validateRecord(value.record);
  const envelope = value as unknown as ReceiptEnvelope;
  if (
    envelope.sha256 !==
    digest({
      schemaVersion: 1,
      kind: "docsfab-scm-delivery-receipt-slot",
      sequence: envelope.sequence,
      previousRecordSha256: envelope.previousRecordSha256,
      record,
    })
  )
    fail("receipt-invalid");
  return { ...envelope, record };
}

function validateReviewEnvelope(value: unknown): ReviewReceiptEnvelope {
  if (
    !isRecord(value) ||
    Object.keys(value).sort().join("\0") !==
      ["kind", "previousRecordSha256", "record", "schemaVersion", "sequence", "sha256"].join(
        "\0",
      ) ||
    value.schemaVersion !== 1 ||
    value.kind !== "docsfab-review-delivery-receipt-slot" ||
    !Number.isSafeInteger(value.sequence) ||
    (value.sequence as number) < 0 ||
    (value.previousRecordSha256 !== null &&
      (typeof value.previousRecordSha256 !== "string" ||
        !SHA256.test(value.previousRecordSha256))) ||
    typeof value.sha256 !== "string" ||
    !SHA256.test(value.sha256)
  )
    fail("receipt-invalid");
  const record = validateReviewRecord(value.record);
  const envelope = value as unknown as ReviewReceiptEnvelope;
  if (
    envelope.sha256 !==
    digest({
      schemaVersion: 1,
      kind: "docsfab-review-delivery-receipt-slot",
      sequence: envelope.sequence,
      previousRecordSha256: envelope.previousRecordSha256,
      record,
    })
  )
    fail("receipt-invalid");
  return { ...envelope, record };
}

function validateReviewRecord(value: unknown): ReviewDeliveryRecordV1 {
  try {
    return assertReviewDeliveryRecordShape(value);
  } catch {
    return fail("receipt-invalid");
  }
}

function validateRecord(value: unknown): ScmDeliveryRecord {
  try {
    return assertScmDeliveryRecordShape(value);
  } catch {
    return fail("receipt-invalid");
  }
}

async function assertDirectory(directory: PrivateDirectory): Promise<void> {
  const handle = await directory.handle.stat();
  const leaf = await lstat(directory.path);
  if (
    !handle.isDirectory() ||
    !leaf.isDirectory() ||
    leaf.isSymbolicLink() ||
    handle.dev !== directory.stat.dev ||
    handle.ino !== directory.stat.ino ||
    leaf.dev !== directory.stat.dev ||
    leaf.ino !== directory.stat.ino ||
    leaf.uid !== directory.uid ||
    (leaf.mode & 0o7777) !== PRIVATE_DIRECTORY_MODE
  ) {
    fail("unsafe-root");
  }
}

async function assertMergeRequestLeaseHeld(
  root: PrivateDirectory,
  idempotencyKey: string,
  leaseId: string,
  expectedLock: { dev: number; ino: number },
): Promise<void> {
  const lockPath = join(root.path, `.${idempotencyKey}.merge-request.lock`);
  const assertLock = async (): Promise<void> => {
    await assertDirectory(root);
    const lock = await lstat(lockPath).catch(() => fail("unsafe-root"));
    if (
      !lock.isDirectory() ||
      lock.isSymbolicLink() ||
      lock.uid !== root.uid ||
      lock.dev !== expectedLock.dev ||
      lock.ino !== expectedLock.ino ||
      (lock.mode & 0o7777) !== PRIVATE_DIRECTORY_MODE
    )
      fail("unsafe-root");
  };
  await assertLock();
  const owner = await open(
    join(lockPath, "owner.json"),
    constants.O_RDONLY | constants.O_NOFOLLOW,
  ).catch(() => fail("unsafe-root"));
  try {
    const stat = await owner.stat();
    if (
      !stat.isFile() ||
      stat.uid !== root.uid ||
      stat.nlink !== 1 ||
      (stat.mode & 0o7777) !== 0o600 ||
      stat.size > limit(MERGE_REQUEST_LEASE_RECORD_BYTES_LIMIT).value
    )
      fail("unsafe-root");
    const bytes = await owner.readFile({ encoding: "utf8" });
    if (
      bytes !==
      `${JSON.stringify({ schemaVersion: 1, key: idempotencyKey, leaseId, pid: process.pid })}\n`
    )
      fail("unsafe-root");
  } finally {
    await owner.close();
  }
  await assertLock();
}

async function assertJournalPath(
  root: PrivateDirectory,
  idempotencyKey: string,
  expected: JournalWorkerResult["journal"],
): Promise<void> {
  if (!expected) return;
  const stat = await lstat(join(root.path, idempotencyKey)).catch(() => fail("unsafe-root"));
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    stat.uid !== root.uid ||
    stat.dev !== expected.dev ||
    stat.ino !== expected.ino ||
    (stat.mode & 0o7777) !== PRIVATE_DIRECTORY_MODE
  )
    fail("unsafe-root");
}

function digest(value: unknown): string {
  return createHash("sha256")
    .update(canonicalizeJsonEvidence(value as JsonEvidenceValue))
    .digest("hex");
}

function key(value: string): void {
  if (!SHA256.test(value)) fail("receipt-invalid");
}

function supported(): void {
  if (
    process.platform === "win32" ||
    typeof process.getuid !== "function" ||
    typeof constants.O_NOFOLLOW !== "number" ||
    typeof constants.O_DIRECTORY !== "number"
  ) {
    fail("unsupported-platform");
  }
}

function fail(code: ScmDeliveryReceiptStoreErrorCode): never {
  throw new ScmDeliveryReceiptStoreError(code);
}
