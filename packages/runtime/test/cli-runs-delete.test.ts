// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { handleRunsCommand } from "../src/cli/commands/runs.js";
import { DurableArtifactStore, opaqueRecordDigest } from "../src/artifacts/store.js";
import { limit, limitDefinition } from "../src/config/limits.js";
import { canonicalDigest, canonicalJson, sha256 } from "../src/content-ir/canonical.js";
import { recordRunDeliveryAttemptLocation } from "../src/delivery/run-deletion-adapter.js";
import { FileContextCache } from "../src/context/cache.js";
import { persistHostedQualityReport } from "../src/evaluation-report/hosted-report.js";
import { sealQualityValidationBinding } from "../src/evaluation-report/quality-artifact-staging.js";
import {
  collectRunLimitOverflowEvidence,
  persistRunLimitOverflowSidecar,
  runLimitOverflowSidecarPath,
} from "../src/operator/run-limit-overflow.js";
import { buildRepositoryDiscoveryInventory } from "../src/repository/inventory.js";
import { prepareRepositoryWorkspace } from "../src/repository/workspace/materialize.js";
import { FileRunStore } from "../src/records/file-store.js";
import { retainSourceSnapshotParts } from "../src/review-delivery/source-snapshot-store.js";
import { applyRunDeletion, previewRunDeletion } from "../src/records/run-deletion.js";
import { withRunMaintenanceGate } from "../src/records/run-maintenance-gate.js";
import { createIndexedFileRunStore } from "../src/records/run-index-store.js";
import { StudySession, studyDirectory } from "../src/records/study-store.js";
import { authoringReviewFindingsRecord } from "./helpers/authoring-review-record.js";
import { initFixtureRepo } from "./helpers/git.js";
import { attachSealedInventory } from "./helpers/limit-overflow-cli.js";
import { testTimeoutMs } from "./helpers/test-timeouts.js";

const roots: string[] = [];
const savedHostLimits = process.env.DOCSFAB_SERVICE_ENV_FILE;

afterEach(async () => {
  if (savedHostLimits === undefined) delete process.env.DOCSFAB_SERVICE_ENV_FILE;
  else process.env.DOCSFAB_SERVICE_ENV_FILE = savedHostLimits;
  process.exitCode = undefined;
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("docsfab runs delete", () => {
  it(
    "traverses a typed review source root to every part and refuses a readdressed malformed root",
    async () => {
      const parent = await realpath(await mkdtemp(join(tmpdir(), "docsfab-snapshot-delete-")));
      roots.push(parent);
      const stateDirectory = join(parent, "state");
      const artifacts = new DurableArtifactStore(join(parent, "artifacts"));
      const runId = "run-snapshot-deletion";
      const sourceSha256 = "a".repeat(64);
      const repositoryIdentitySha256 = "b".repeat(64);
      const reviewedHeadSha = "c".repeat(40);
      const snapshotSha256 = "d".repeat(64);
      const source = {
        runId,
        sourceSha256,
        repositoryIdentitySha256,
        reviewedHeadSha,
        snapshotSha256,
        manifest: { observationId: "manifest-1", bytes: new TextEncoder().encode("{}") },
        diff: { observationId: "diff-1", bytes: new Uint8Array() },
        rows: [
          {
            state: "absent" as const,
            sections: 0,
            before: { reason: "not-in-source" as const, statedSha256: null },
            after: { reason: "not-in-source" as const, statedSha256: null },
          },
        ],
      };
      const { rootObjectSha256 } = await retainSourceSnapshotParts(artifacts, source);
      const root = (await artifacts.getRecord(rootObjectSha256)) as { partDigests: string[] };
      const citation = {
        schemaVersion: 1 as const,
        kind: "docsfab-run-change-source" as const,
        sourceKind: "local-range",
        provenance: "local-verified" as const,
        repository: { kind: "local-checkout" as const, identitySha256: repositoryIdentitySha256 },
        objectFormat: "sha1" as const,
        rangeSemantics: "two-dot" as const,
        base: "e".repeat(40),
        head: reviewedHeadSha,
        mergeBase: null,
        diffFrom: "e".repeat(40),
        labels: [],
        fileCount: 1,
        commitCount: 1,
        changeSourceSha256: sourceSha256,
        observations: [
          { role: "manifest" as const, observationId: "manifest-1" },
          { role: "diff" as const, observationId: "diff-1" },
        ],
      };
      const reference = {
        kind: "docsfab-review-delivery-snapshot-reference" as const,
        schemaVersion: 1 as const,
        runId,
        rootObjectSha256,
        snapshotSha256,
        changeSourceSha256: sourceSha256,
        reviewedHeadSha,
        repositoryIdentitySha256,
      };
      const base = authoringReviewFindingsRecord();
      await new FileRunStore(stateDirectory).save({
        ...base,
        id: runId,
        workflow: "review-documentation",
        changeSources: [citation],
        reviewDeliverySnapshot: reference,
      });
      const retainedId = "run-snapshot-shared-reader";
      // A separate saved artifact reference pins the root and its typed descendants.
      await new FileRunStore(stateDirectory).save({
        ...base,
        id: retainedId,
        artifacts: [
          {
            role: "output",
            reference: {
              kind: "ia-plan",
              schemaVersion: 1,
              digest: rootObjectSha256,
              repositoryRevision: base.repository.revision,
              repositoryContentDigest: "f".repeat(64),
            },
          },
        ],
      });
      const preview = await previewRunDeletion(stateDirectory, runId);
      expect(preview.unresolved).toBe(0);
      expect(preview.sharedRetained).toBeGreaterThan(0);
      const deletion = await applyRunDeletion(stateDirectory, runId, preview.confirmation);
      expect(deletion.complete).toBe(true);
      expect(await artifacts.has(rootObjectSha256)).toBe(true);
      for (const digest of root.partDigests) expect(await artifacts.has(digest)).toBe(true);
      const retainedPreview = await previewRunDeletion(stateDirectory, retainedId);
      const retainedDeletion = await applyRunDeletion(
        stateDirectory,
        retainedId,
        retainedPreview.confirmation,
      );
      expect(retainedDeletion.complete).toBe(true);
      expect(await artifacts.has(rootObjectSha256)).toBe(false);
      for (const digest of root.partDigests) expect(await artifacts.has(digest)).toBe(false);

      const thirdId = "run-snapshot-part-tamper";
      const third = await retainSourceSnapshotParts(artifacts, { ...source, runId: thirdId });
      const thirdRoot = (await artifacts.getRecord(third.rootObjectSha256)) as {
        partDigests: string[];
      };
      const partPath = join(
        parent,
        "artifacts",
        "objects",
        "sha256",
        `${thirdRoot.partDigests[0]}.json`,
      );
      const part = JSON.parse(await readFile(partPath, "utf8")) as Record<string, unknown>;
      await writeFile(partPath, JSON.stringify({ ...part, rawBase64: "AA==" }));
      await new FileRunStore(stateDirectory).save({
        ...base,
        id: thirdId,
        workflow: "review-documentation",
        changeSources: [citation],
        reviewDeliverySnapshot: {
          ...reference,
          runId: thirdId,
          rootObjectSha256: third.rootObjectSha256,
        },
      });
      await expect(previewRunDeletion(stateDirectory, thirdId)).rejects.toMatchObject({
        code: "artifact-owner-invalid",
      });

      const secondId = "run-snapshot-malformed";
      const second = await retainSourceSnapshotParts(artifacts, { ...source, runId: secondId });
      const stored = (await artifacts.getRecord(second.rootObjectSha256)) as Record<
        string,
        unknown
      >;
      const malformed = { ...stored, unexpected: true };
      const malformedDigest = opaqueRecordDigest(malformed);
      await artifacts.putRecord(malformedDigest, malformed);
      await new FileRunStore(stateDirectory).save({
        ...base,
        id: secondId,
        workflow: "review-documentation",
        changeSources: [citation],
        reviewDeliverySnapshot: {
          ...reference,
          runId: secondId,
          rootObjectSha256: malformedDigest,
        },
      });
      await expect(previewRunDeletion(stateDirectory, secondId)).rejects.toMatchObject({
        code: "artifact-owner-invalid",
      });
    },
    limit("test.applicationExecutionTimeoutMs").value,
  );

  it.each([true, false])(
    "deletes staged review source parts when root publication fails=%s",
    async (failRoot) => {
      const parent = await realpath(await mkdtemp(join(tmpdir(), "docsfab-snapshot-orphan-")));
      roots.push(parent);
      const stateDirectory = join(parent, "state");
      const artifacts = new DurableArtifactStore(join(parent, "artifacts"));
      const runId = "run-staged-source";
      await new FileRunStore(stateDirectory).save({
        ...authoringReviewFindingsRecord(),
        id: runId,
      });
      const put = artifacts.putRecord.bind(artifacts);
      const stagedParts: string[] = [];
      const spy = vi.spyOn(artifacts, "putRecord").mockImplementation(async (digest, value) => {
        const kind = (value as { kind?: string }).kind;
        if (kind === "docsfab-review-delivery-snapshot" && failRoot)
          throw new Error("injected root write failure");
        await put(digest, value);
        if (kind === "docsfab-review-delivery-snapshot-part") stagedParts.push(digest);
      });
      const retention = retainSourceSnapshotParts(artifacts, {
        runId,
        sourceSha256: "a".repeat(64),
        repositoryIdentitySha256: "b".repeat(64),
        reviewedHeadSha: "c".repeat(40),
        snapshotSha256: "d".repeat(64),
        manifest: {
          observationId: "manifest-1",
          bytes: new TextEncoder().encode('{"private":"original source"}'),
        },
        diff: { observationId: "diff-1", bytes: new Uint8Array() },
        rows: [
          {
            state: "absent",
            sections: 0,
            before: { reason: "not-in-source", statedSha256: null },
            after: { reason: "not-in-source", statedSha256: null },
          },
        ],
      } as Parameters<typeof retainSourceSnapshotParts>[1]);
      if (failRoot) await expect(retention).rejects.toThrow("injected root write failure");
      else await expect(retention).resolves.toHaveProperty("rootObjectSha256");
      spy.mockRestore();
      expect(stagedParts.length).toBeGreaterThan(0);
      const preview = await previewRunDeletion(stateDirectory, runId);
      const outcome = await applyRunDeletion(stateDirectory, runId, preview.confirmation);
      expect(outcome.complete).toBe(true);
      for (const digest of stagedParts) expect(await artifacts.has(digest)).toBe(false);
    },
    testTimeoutMs(limit("test.applicationExecutionTimeoutMs").value),
  );

  it.each(["address", "shape"] as const)(
    "refuses a malformed staged orphan part (%s) before deleting its run",
    async (fault) => {
      const parent = await realpath(await mkdtemp(join(tmpdir(), "docsfab-snapshot-orphan-bad-")));
      roots.push(parent);
      const stateDirectory = join(parent, "state");
      const artifacts = new DurableArtifactStore(join(parent, "artifacts"));
      const runId = "run-staged-source-bad";
      await new FileRunStore(stateDirectory).save({
        ...authoringReviewFindingsRecord(),
        id: runId,
      });
      const put = artifacts.putRecord.bind(artifacts);
      const stagedParts: string[] = [];
      const spy = vi.spyOn(artifacts, "putRecord").mockImplementation(async (digest, value) => {
        if ((value as { kind?: string }).kind === "docsfab-review-delivery-snapshot")
          throw new Error("injected root write failure");
        await put(digest, value);
        if ((value as { kind?: string }).kind === "docsfab-review-delivery-snapshot-part")
          stagedParts.push(digest);
      });
      await expect(
        retainSourceSnapshotParts(artifacts, {
          runId,
          sourceSha256: "a".repeat(64),
          repositoryIdentitySha256: "b".repeat(64),
          reviewedHeadSha: "c".repeat(40),
          snapshotSha256: "d".repeat(64),
          manifest: {
            observationId: "manifest-1",
            bytes: new TextEncoder().encode("private original source"),
          },
          diff: { observationId: "diff-1", bytes: new Uint8Array() },
          rows: [
            {
              state: "absent",
              sections: 0,
              before: { reason: "not-in-source", statedSha256: null },
              after: { reason: "not-in-source", statedSha256: null },
            },
          ],
        } as Parameters<typeof retainSourceSnapshotParts>[1]),
      ).rejects.toThrow("injected root write failure");
      spy.mockRestore();
      const partPath = join(parent, "artifacts", "objects", "sha256", `${stagedParts[0]}.json`);
      const part = JSON.parse(await readFile(partPath, "utf8")) as Record<string, unknown>;
      if (fault === "address") {
        await writeFile(partPath, JSON.stringify({ ...part, rawBase64: "AA==" }));
      } else {
        const malformed = { ...part, unexpected: true };
        await artifacts.putRecord(opaqueRecordDigest(malformed), malformed);
      }
      await expect(previewRunDeletion(stateDirectory, runId)).rejects.toMatchObject({
        code: "artifact-owner-invalid",
      });
      expect(await artifacts.has(stagedParts[0]!)).toBe(true);
    },
    testTimeoutMs(limit("test.applicationExecutionTimeoutMs").value),
  );

  it(
    "retains a shared staged source part and never selects a foreign run's part",
    async () => {
      const parent = await realpath(
        await mkdtemp(join(tmpdir(), "docsfab-snapshot-shared-orphan-")),
      );
      roots.push(parent);
      const stateDirectory = join(parent, "state");
      const artifacts = new DurableArtifactStore(join(parent, "artifacts"));
      const base = authoringReviewFindingsRecord();
      const runId = "run-staged-shared-source";
      const survivorId = "run-staged-source-reader";
      await new FileRunStore(stateDirectory).save({ ...base, id: runId });
      const input: Parameters<typeof retainSourceSnapshotParts>[1] = {
        runId,
        sourceSha256: "a".repeat(64),
        repositoryIdentitySha256: "b".repeat(64),
        reviewedHeadSha: "c".repeat(40),
        snapshotSha256: "d".repeat(64),
        manifest: {
          observationId: "manifest-1",
          bytes: new TextEncoder().encode("private original source"),
        },
        diff: { observationId: "diff-1", bytes: new Uint8Array() },
        rows: [
          {
            state: "absent",
            sections: 0,
            before: { reason: "not-in-source", statedSha256: null },
            after: { reason: "not-in-source", statedSha256: null },
          },
        ],
      };
      const put = artifacts.putRecord.bind(artifacts);
      const stagedParts: string[] = [];
      const spy = vi.spyOn(artifacts, "putRecord").mockImplementation(async (digest, value) => {
        if ((value as { kind?: string }).kind === "docsfab-review-delivery-snapshot")
          throw new Error("injected root write failure");
        await put(digest, value);
        if ((value as { kind?: string }).kind === "docsfab-review-delivery-snapshot-part")
          stagedParts.push(digest);
      });
      await expect(retainSourceSnapshotParts(artifacts, input)).rejects.toThrow(
        "injected root write failure",
      );
      spy.mockRestore();
      const foreign = await retainSourceSnapshotParts(artifacts, {
        ...input,
        runId: "foreign-staged-source",
      });
      const foreignRoot = (await artifacts.getRecord(foreign.rootObjectSha256)) as {
        partDigests: string[];
      };
      const sharedPart = stagedParts[0]!;
      await new FileRunStore(stateDirectory).save({
        ...base,
        id: survivorId,
        artifacts: [
          {
            role: "output",
            reference: {
              kind: "ia-plan",
              schemaVersion: 1,
              digest: sharedPart,
              repositoryRevision: base.repository.revision,
              repositoryContentDigest: "f".repeat(64),
            },
          },
        ],
      });
      const preview = await previewRunDeletion(stateDirectory, runId);
      expect(preview.sharedRetained).toBeGreaterThan(0);
      const result = await applyRunDeletion(stateDirectory, runId, preview.confirmation);
      expect(result.complete).toBe(true);
      expect(await artifacts.has(sharedPart)).toBe(true);
      for (const digest of foreignRoot.partDigests) expect(await artifacts.has(digest)).toBe(true);
      const survivorPreview = await previewRunDeletion(stateDirectory, survivorId);
      const survivorResult = await applyRunDeletion(
        stateDirectory,
        survivorId,
        survivorPreview.confirmation,
      );
      expect(survivorResult.complete).toBe(true);
      expect(await artifacts.has(sharedPart)).toBe(false);
      for (const digest of foreignRoot.partDigests) expect(await artifacts.has(digest)).toBe(true);
    },
    testTimeoutMs(limit("test.applicationExecutionTimeoutMs").value),
  );

  it("accepts each deletion gate and inventory host ceiling and rejects the next value", async () => {
    const parent = await realpath(await mkdtemp(join(tmpdir(), "docsfab-run-delete-")));
    roots.push(parent);
    const hostFile = join(parent, "limits.env");
    process.env.DOCSFAB_SERVICE_ENV_FILE = hostFile;
    for (const name of [
      "runs.deletionGateAttempts",
      "runs.deletionGateRetryPauseMs",
      "runs.deletionInventoryMaxEntries",
    ]) {
      const maximum = limitDefinition(name).max;
      await writeFile(hostFile, `${name}=${maximum}\n`);
      expect(limit(name).value).toBe(maximum);
      await writeFile(hostFile, `${name}=${maximum + 1}\n`);
      expect(() => limit(name)).toThrow(new RegExp(`^${name.replaceAll(".", "\\.")} must be`));
    }
  });

  it("uses the configured attempt and pause budgets to refuse or resume a held local gate", async () => {
    const parent = await realpath(await mkdtemp(join(tmpdir(), "docsfab-run-delete-")));
    roots.push(parent);
    const stateDirectory = join(parent, "state");
    await mkdir(stateDirectory, { mode: 0o700 });
    await withRunMaintenanceGate(stateDirectory, async () => undefined);
    const gate = join(stateDirectory, ".docsfab-run-maintenance.lock");
    let entered!: () => void;
    let release!: () => void;
    const inside = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const untilRelease = new Promise<void>((resolve) => {
      release = resolve;
    });
    const holder = withRunMaintenanceGate(stateDirectory, async () => {
      entered();
      await untilRelease;
    });
    await inside;
    const hostFile = join(parent, "limits.env");
    process.env.DOCSFAB_SERVICE_ENV_FILE = hostFile;
    const oneAttempt = limitDefinition("runs.deletionGateAttempts").min;
    const pauseMs = limitDefinition("runs.deletionGateRetryPauseMs").value;
    await writeFile(
      hostFile,
      `runs.deletionGateAttempts=${oneAttempt}\nruns.deletionGateRetryPauseMs=${pauseMs}\n`,
    );
    await expect(
      withRunMaintenanceGate(stateDirectory, async () => undefined),
    ).rejects.toMatchObject({ code: "held" });
    const retryAttempts = oneAttempt + 7;
    await writeFile(
      hostFile,
      `runs.deletionGateAttempts=${retryAttempts}\nruns.deletionGateRetryPauseMs=${pauseMs}\n`,
    );
    const scheduledRelease = new Promise<void>((resolve) => {
      setTimeout(() => {
        release();
        resolve();
      }, pauseMs * 3);
    });
    await withRunMaintenanceGate(stateDirectory, async () => undefined);
    await scheduledRelease;
    await holder;
    await expect(stat(gate)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("previews at the structural inventory bound and refuses the next container", async () => {
    const parent = await realpath(await mkdtemp(join(tmpdir(), "docsfab-run-delete-")));
    roots.push(parent);
    const stateDirectory = join(parent, "state");
    const record = authoringReviewFindingsRecord();
    await new FileRunStore(stateDirectory).save(record);
    const countContainers = (value: unknown): number => {
      if (!value || typeof value !== "object") return 0;
      return (
        1 + Object.values(value).reduce<number>((sum, child) => sum + countContainers(child), 0)
      );
    };
    const stored = JSON.parse(
      await readFile(join(stateDirectory, `${record.id}.json`), "utf8"),
    ) as unknown;
    const at = countContainers(stored);
    const hostFile = join(parent, "limits.env");
    await writeFile(hostFile, `runs.deletionInventoryMaxEntries=${at}\n`);
    process.env.DOCSFAB_SERVICE_ENV_FILE = hostFile;
    expect((await previewRunDeletion(stateDirectory, record.id)).unresolved).toBe(0);

    await writeFile(hostFile, `runs.deletionInventoryMaxEntries=${at - 1}\n`);
    await expect(previewRunDeletion(stateDirectory, record.id)).rejects.toMatchObject({
      code: "runs-deletion-inventory-max-entries-bound",
      configured: at - 1,
      observed: at,
    });

    const reportDirectory = join(stateDirectory, "reports", record.id);
    await mkdir(reportDirectory, { recursive: true, mode: 0o700 });
    await writeFile(join(reportDirectory, "report.md"), "# Disposable report\n", { mode: 0o600 });
    await writeFile(hostFile, `runs.deletionInventoryMaxEntries=${at + 2}\n`);
    expect((await previewRunDeletion(stateDirectory, record.id)).files).toBeGreaterThan(1);
    await writeFile(hostFile, `runs.deletionInventoryMaxEntries=${at + 1}\n`);
    await expect(previewRunDeletion(stateDirectory, record.id)).rejects.toMatchObject({
      code: "runs-deletion-inventory-max-entries-bound",
      configured: at + 1,
      observed: at + 2,
    });
  });

  it("bounds a large scalar record before the structural scan", async () => {
    const parent = await realpath(await mkdtemp(join(tmpdir(), "docsfab-run-delete-")));
    roots.push(parent);
    const stateDirectory = join(parent, "state");
    await mkdir(stateDirectory, { mode: 0o700 });
    const record = authoringReviewFindingsRecord();
    const bound = limitDefinition("runs.recordMaxBytes").min;
    const oversized = JSON.stringify({ ...record, evidenceWarnings: ["x".repeat(bound)] });
    await writeFile(join(stateDirectory, `${record.id}.json`), oversized, { mode: 0o600 });
    const hostFile = join(parent, "limits.env");
    await writeFile(hostFile, `runs.recordMaxBytes=${bound}\n`);
    process.env.DOCSFAB_SERVICE_ENV_FILE = hostFile;
    await expect(previewRunDeletion(stateDirectory, record.id)).rejects.toMatchObject({
      code: "runs-record-max-bytes-bound",
      configured: bound,
      observed: Buffer.byteLength(oversized),
    });
  });

  it("refuses an unattributed artifact-store entry instead of silently skipping it", async () => {
    const parent = await realpath(await mkdtemp(join(tmpdir(), "docsfab-run-delete-")));
    roots.push(parent);
    const stateDirectory = join(parent, "state");
    const record = authoringReviewFindingsRecord();
    await new FileRunStore(stateDirectory).save(record);
    const artifacts = new DurableArtifactStore(join(parent, "artifacts"));
    await artifacts.initialize();
    await writeFile(
      join(parent, "artifacts", "objects", "sha256", ".unattributed.tmp"),
      "unknown\n",
      {
        mode: 0o600,
      },
    );
    await expect(previewRunDeletion(stateDirectory, record.id)).rejects.toMatchObject({
      code: "artifact-store-invalid",
    });
  });

  it("removes a sealed review quality binding while retaining another run's shared object", async () => {
    const parent = await realpath(await mkdtemp(join(tmpdir(), "docsfab-run-delete-")));
    roots.push(parent);
    const stateDirectory = join(parent, "state");
    const artifacts = new DurableArtifactStore(join(parent, "artifacts"));
    const base = authoringReviewFindingsRecord();
    const sharedDigest = "b".repeat(64);
    await artifacts.putRecord(sharedDigest, {
      kind: "fixture-shared-quality-record",
      runId: base.id,
    });
    const bindingBody = {
      runId: base.id,
      repositoryRevision: base.repository.revision,
      selectionSha256: "c".repeat(64),
      qualityPackBindingSha256: "d".repeat(64),
      evaluatorIdentitySha256: "e".repeat(64),
      status: "incomplete" as const,
      failureCode: "artifact-integrity-invalid" as const,
      artifacts: {
        evaluation: { recordSha256: sharedDigest, payloadSha256: "f".repeat(64) },
        qualityScore: null,
        candidateReport: null,
        finalReport: null,
      },
      validatorAssets: {
        evaluationScriptSha256: "1".repeat(64),
        evaluationSchemaSha256: "2".repeat(64),
        qualityScoreScriptSha256: "3".repeat(64),
        reportScriptSha256: "4".repeat(64),
      },
      validators: { evaluation: null, qualityScore: null, reportBinding: null },
    };
    const binding = sealQualityValidationBinding(bindingBody);
    const olderBinding = sealQualityValidationBinding({
      ...bindingBody,
      selectionSha256: "6".repeat(64),
    });
    await artifacts.putRecord(binding.bindingSha256, binding);
    await artifacts.putRecord(olderBinding.bindingSha256, olderBinding);
    const target = { ...base, qualityArtifactValidation: binding };
    const retained = {
      ...base,
      id: `${base.id}-retained`,
      artifacts: [
        {
          role: "output" as const,
          reference: {
            kind: "ia-plan" as const,
            schemaVersion: 1 as const,
            digest: sharedDigest,
            repositoryRevision: base.repository.revision,
            repositoryContentDigest: "5".repeat(64),
          },
        },
      ],
    };
    await new FileRunStore(stateDirectory).save(target);
    await new FileRunStore(stateDirectory).save(retained);

    const preview = await previewRunDeletion(stateDirectory, target.id);
    expect(preview.sharedRetained).toBeGreaterThan(0);
    const result = await applyRunDeletion(stateDirectory, target.id, preview.confirmation);
    expect(result.complete).toBe(true);
    expect(await artifacts.has(sharedDigest)).toBe(true);
    expect(await artifacts.has(binding.bindingSha256)).toBe(false);
    expect(await artifacts.has(olderBinding.bindingSha256)).toBe(false);
  });

  it("retains a shared locator object and refuses a late save after its last owner is deleted", async () => {
    const parent = await realpath(await mkdtemp(join(tmpdir(), "docsfab-run-delete-")));
    roots.push(parent);
    const stateDirectory = join(parent, "state");
    const artifacts = new DurableArtifactStore(join(parent, "artifacts"));
    const store = new FileRunStore(stateDirectory);
    const first = authoringReviewFindingsRecord();
    const raw = Buffer.from("head-side review line\n");
    const files = [
      {
        path: "docs/guide.md",
        rawSha256: sha256(raw),
        rawBase64: raw.toString("base64"),
        lines: [{ line: 1, textSha256: sha256("head-side review line") }],
      },
    ];
    const body = {
      schemaVersion: 1 as const,
      kind: "docsfab-review-locator-observation" as const,
      runId: first.id,
      repositoryRevision: first.repository.revision,
      repositoryIdentitySha256: sha256(first.repository.sourcePath),
      stepId: "verify-technical-accuracy" as const,
      attempt: 1,
      summarySha256: sha256("Review complete."),
      targetPaths: ["docs/guide.md"],
      repositoryContentDigest: sha256(
        canonicalJson(files.map((file) => ({ path: file.path, rawSha256: file.rawSha256 }))),
      ),
      workspaceSnapshotSha256: null,
      files,
    };
    const manifest = { ...body, domainSha256: sha256(canonicalJson(body)) };
    const objectSha256 = opaqueRecordDigest(manifest);
    await artifacts.putRecord(objectSha256, manifest);
    const reference = {
      kind: "docsfab-review-locator-observation-reference" as const,
      objectSha256,
      domainSha256: manifest.domainSha256,
      runId: first.id,
      stepId: "verify-technical-accuracy" as const,
      attempt: 1,
      summarySha256: body.summarySha256,
    };
    const owned = {
      ...first,
      steps: [{ ...first.steps[0]!, reviewLocatorObservation: reference }],
    };
    const shared = {
      ...first,
      id: `${first.id}-shared`,
      steps: [{ ...first.steps[0]!, reviewLocatorObservation: reference }],
    };
    await store.save(owned);
    await store.save(shared);
    const preview = await previewRunDeletion(stateDirectory, first.id);
    expect(preview.sharedRetained).toBeGreaterThan(0);
    expect((await applyRunDeletion(stateDirectory, first.id, preview.confirmation)).complete).toBe(
      true,
    );
    expect(await artifacts.has(objectSha256)).toBe(true);

    const last = await previewRunDeletion(stateDirectory, shared.id);
    expect((await applyRunDeletion(stateDirectory, shared.id, last.confirmation)).complete).toBe(
      true,
    );
    expect(await artifacts.has(objectSha256)).toBe(false);
    await expect(store.save({ ...shared, id: `${first.id}-late` })).rejects.toMatchObject({
      code: "object-deleted",
    });
  });

  it("deletes overflow sidecar evidence and prevents its writer from recreating the run", async () => {
    const parent = await realpath(await mkdtemp(join(tmpdir(), "docsfab-run-delete-")));
    roots.push(parent);
    const stateDirectory = join(parent, "state");
    const record = authoringReviewFindingsRecord();
    await new FileRunStore(stateDirectory).save(record);
    const recordPath = join(stateDirectory, `${record.id}.json`);
    const input = {
      recordPath,
      runId: record.id,
      evidence: { sourceRepresentations: [{ limitations: ["byte-budget-truncated"] }] },
    };
    await persistRunLimitOverflowSidecar(input);
    const sidecar = runLimitOverflowSidecarPath(recordPath);
    expect(await readFile(sidecar, "utf8")).toContain("byte-budget-truncated");

    const preview = await previewRunDeletion(stateDirectory, record.id);
    expect(preview.files).toBeGreaterThanOrEqual(2);
    const result = await applyRunDeletion(stateDirectory, record.id, preview.confirmation);
    expect(result.complete).toBe(true);
    await expect(stat(sidecar)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(persistRunLimitOverflowSidecar(input)).rejects.toMatchObject({
      code: "tombstoned",
    });
    await expect(stat(sidecar)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("deletes a quality closure with its validated overflow sidecar while retaining other owners", async () => {
    const parent = await realpath(await mkdtemp(join(tmpdir(), "docsfab-run-delete-")));
    roots.push(parent);
    const stateDirectory = join(parent, "state");
    const artifacts = new DurableArtifactStore(join(parent, "artifacts"));
    const base = authoringReviewFindingsRecord();
    const target = { ...base, id: `${base.id}.target` };
    const sharedDigest = "b".repeat(64);
    await artifacts.putRecord(sharedDigest, {
      kind: "fixture-shared-quality-record",
      runId: target.id,
    });
    const binding = sealQualityValidationBinding({
      runId: target.id,
      repositoryRevision: target.repository.revision,
      selectionSha256: "c".repeat(64),
      qualityPackBindingSha256: "d".repeat(64),
      evaluatorIdentitySha256: "e".repeat(64),
      status: "incomplete",
      failureCode: "artifact-integrity-invalid",
      artifacts: {
        evaluation: { recordSha256: sharedDigest, payloadSha256: "f".repeat(64) },
        qualityScore: null,
        candidateReport: null,
        finalReport: null,
      },
      validatorAssets: {
        evaluationScriptSha256: "1".repeat(64),
        evaluationSchemaSha256: "2".repeat(64),
        qualityScoreScriptSha256: "3".repeat(64),
        reportScriptSha256: "4".repeat(64),
      },
      validators: { evaluation: null, qualityScore: null, reportBinding: null },
    });
    await artifacts.putRecord(binding.bindingSha256, binding);
    const targetRecord = { ...target, qualityArtifactValidation: binding };
    const retained = {
      ...base,
      id: `${base.id}-retained`,
      artifacts: [
        {
          role: "output" as const,
          reference: {
            kind: "ia-plan" as const,
            schemaVersion: 1 as const,
            digest: sharedDigest,
            repositoryRevision: base.repository.revision,
            repositoryContentDigest: "5".repeat(64),
          },
        },
      ],
    };
    await new FileRunStore(stateDirectory).save(targetRecord);
    await new FileRunStore(stateDirectory).save(retained);
    const recordPath = join(stateDirectory, `${target.id}.json`);
    await persistRunLimitOverflowSidecar({
      recordPath,
      runId: target.id,
      evidence: { sourceRepresentations: [{ limitations: ["byte-budget-truncated"] }] },
    });
    const preview = await previewRunDeletion(stateDirectory, target.id);
    expect(preview.sharedRetained).toBeGreaterThan(0);
    const result = await applyRunDeletion(stateDirectory, target.id, preview.confirmation);
    expect(result.complete).toBe(true);
    await expect(stat(recordPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(runLimitOverflowSidecarPath(recordPath))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(await artifacts.has(binding.bindingSha256)).toBe(false);
    expect(await artifacts.has(sharedDigest)).toBe(true);
    expect(await stat(join(stateDirectory, `${retained.id}.json`))).toBeDefined();
  });

  it("preserves a colliding dotted run and its object instead of treating it as the target sidecar", async () => {
    const parent = await realpath(await mkdtemp(join(tmpdir(), "docsfab-run-delete-")));
    roots.push(parent);
    const stateDirectory = join(parent, "state");
    const artifacts = new DurableArtifactStore(join(parent, "artifacts"));
    const target = authoringReviewFindingsRecord();
    const digest = "a".repeat(64);
    await artifacts.putRecord(digest, {
      kind: "fixture-retained-record",
      runId: `${target.id}.limit-overflow`,
    });
    const retained = {
      ...target,
      id: `${target.id}.limit-overflow`,
      artifacts: [
        {
          role: "output" as const,
          reference: {
            kind: "ia-plan" as const,
            schemaVersion: 1 as const,
            digest,
            repositoryRevision: target.repository.revision,
            repositoryContentDigest: "5".repeat(64),
          },
        },
      ],
    };
    await new FileRunStore(stateDirectory).save(target);
    await new FileRunStore(stateDirectory).save(retained);
    const preview = await previewRunDeletion(stateDirectory, target.id);
    const result = await applyRunDeletion(stateDirectory, target.id, preview.confirmation);
    expect(result.complete).toBe(true);
    expect(await stat(join(stateDirectory, `${retained.id}.json`))).toBeDefined();
    expect(await artifacts.has(digest)).toBe(true);
  });

  it.each(["malformed", "mismatched"])(
    "refuses a %s target overflow sidecar without deletion",
    async (damage) => {
      const parent = await realpath(await mkdtemp(join(tmpdir(), "docsfab-run-delete-")));
      roots.push(parent);
      const stateDirectory = join(parent, "state");
      const target = authoringReviewFindingsRecord();
      await new FileRunStore(stateDirectory).save(target);
      const recordPath = join(stateDirectory, `${target.id}.json`);
      const sidecar = runLimitOverflowSidecarPath(recordPath);
      await writeFile(
        sidecar,
        damage === "malformed"
          ? "{"
          : JSON.stringify({
              schemaVersion: 1,
              kind: "docsfab-run-limit-overflow",
              runId: "wrong-run",
              sourceRepresentations: [{ limitations: ["byte-budget-truncated"] }],
            }),
        { mode: 0o600 },
      );
      await expect(previewRunDeletion(stateDirectory, target.id)).rejects.toMatchObject({
        code: "artifact-owner-invalid",
      });
      expect(await stat(recordPath)).toBeDefined();
      expect(await stat(sidecar)).toBeDefined();
    },
  );

  it.each(["malformed", "mismatched"])(
    "refuses a %s retained overflow sidecar without deletion",
    async (damage) => {
      const parent = await realpath(await mkdtemp(join(tmpdir(), "docsfab-run-delete-")));
      roots.push(parent);
      const stateDirectory = join(parent, "state");
      const base = authoringReviewFindingsRecord();
      const retained = { ...base, id: `${base.id}-retained` };
      await new FileRunStore(stateDirectory).save(base);
      await new FileRunStore(stateDirectory).save(retained);
      const sidecar = runLimitOverflowSidecarPath(join(stateDirectory, `${retained.id}.json`));
      await writeFile(
        sidecar,
        damage === "malformed"
          ? "{"
          : JSON.stringify({
              schemaVersion: 1,
              kind: "docsfab-run-limit-overflow",
              runId: "wrong-run",
              sourceRepresentations: [{ limitations: ["byte-budget-truncated"] }],
            }),
        { mode: 0o600 },
      );
      await expect(previewRunDeletion(stateDirectory, base.id)).rejects.toMatchObject({
        code: "artifact-owner-invalid",
      });
      expect(await stat(join(stateDirectory, `${base.id}.json`))).toBeDefined();
      expect(await stat(sidecar)).toBeDefined();
    },
  );

  it("retains an unrelated valid overflow sidecar while deleting a dotted target", async () => {
    const parent = await realpath(await mkdtemp(join(tmpdir(), "docsfab-run-delete-")));
    roots.push(parent);
    const stateDirectory = join(parent, "state");
    const base = authoringReviewFindingsRecord();
    const target = { ...base, id: `${base.id}.limit-overflow` };
    const retained = { ...base, id: `${base.id}-retained` };
    await new FileRunStore(stateDirectory).save(target);
    await new FileRunStore(stateDirectory).save(retained);
    const targetPath = join(stateDirectory, `${target.id}.json`);
    const retainedPath = join(stateDirectory, `${retained.id}.json`);
    for (const [recordPath, runId] of [
      [targetPath, target.id],
      [retainedPath, retained.id],
    ] as const) {
      await persistRunLimitOverflowSidecar({
        recordPath,
        runId,
        evidence: { sourceRepresentations: [{ limitations: ["byte-budget-truncated"] }] },
      });
    }
    const preview = await previewRunDeletion(stateDirectory, target.id);
    expect((await applyRunDeletion(stateDirectory, target.id, preview.confirmation)).complete).toBe(
      true,
    );
    await expect(stat(targetPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(runLimitOverflowSidecarPath(targetPath))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(await stat(retainedPath)).toBeDefined();
    expect(await stat(runLimitOverflowSidecarPath(retainedPath))).toBeDefined();
  });

  it.each([
    "valid",
    "changed-failure",
    "omitted-failure",
    "retained-valid",
    "retained-changed-failure",
    "retained-omitted-failure",
  ])(
    "classifies production inventory-derived navigation %s without accepting altered evidence",
    async (variant) => {
      const parent = await realpath(await mkdtemp(join(tmpdir(), "docsfab-run-delete-")));
      roots.push(parent);
      const repository = join(parent, "repository");
      const bound = limitDefinition("repository.navigationMaxSourceBytes");
      await initFixtureRepo(repository, {
        "README.md": "# Fixture\n",
        "mkdocs.yml": `${"#".repeat(bound.min + 1)}\nnav: []\n`,
      });
      const workspace = await prepareRepositoryWorkspace(repository, "HEAD");
      let inventory;
      try {
        inventory = await buildRepositoryDiscoveryInventory({
          workspace,
          limits: {
            environment: { [bound.override!]: String(bound.min) },
            hostFile: null,
            projectFile: null,
          },
        });
      } finally {
        await workspace.dispose();
      }
      const record = attachSealedInventory(authoringReviewFindingsRecord(), inventory);
      const evidence = collectRunLimitOverflowEvidence(record);
      expect(evidence.navigation?.failures.length).toBeGreaterThan(0);
      const { evidenceSha256, ...body } = evidence.navigation!;
      expect(canonicalDigest(body)).not.toBe(evidenceSha256);
      const stateDirectory = join(parent, "state");
      await new FileRunStore(stateDirectory).save(record);
      const retainedSidecar = variant.startsWith("retained-");
      const deletionId = retainedSidecar ? `${record.id}-target` : record.id;
      if (retainedSidecar)
        await new FileRunStore(stateDirectory).save({ ...record, id: deletionId });
      const recordPath = join(stateDirectory, `${record.id}.json`);
      const sidecar = runLimitOverflowSidecarPath(recordPath);
      await persistRunLimitOverflowSidecar({ recordPath, runId: record.id, evidence });
      if (!variant.endsWith("valid")) {
        const payload = JSON.parse(await readFile(sidecar, "utf8")) as {
          navigation: { failures: Array<{ code: string; overflow: { observed: number } }> };
        };
        if (variant.endsWith("changed-failure")) {
          payload.navigation.failures[0]!.code = "forged-evidence";
          payload.navigation.failures[0]!.overflow.observed += 1;
        } else payload.navigation.failures = [];
        await writeFile(sidecar, JSON.stringify(payload), { mode: 0o600 });
        await expect(previewRunDeletion(stateDirectory, deletionId)).rejects.toMatchObject({
          code: "artifact-owner-invalid",
        });
        expect(await stat(recordPath)).toBeDefined();
        return;
      }
      const preview = await previewRunDeletion(stateDirectory, deletionId);
      expect(
        (await applyRunDeletion(stateDirectory, deletionId, preview.confirmation)).complete,
      ).toBe(true);
      if (retainedSidecar) expect(await stat(sidecar)).toBeDefined();
      else await expect(stat(sidecar)).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  it("serializes an overflow writer started while confirmed deletion is removing its sidecar", async () => {
    const parent = await realpath(await mkdtemp(join(tmpdir(), "docsfab-run-delete-")));
    roots.push(parent);
    const stateDirectory = join(parent, "state");
    const record = authoringReviewFindingsRecord();
    await new FileRunStore(stateDirectory).save(record);
    const recordPath = join(stateDirectory, `${record.id}.json`);
    const input = {
      recordPath,
      runId: record.id,
      evidence: { sourceRepresentations: [{ limitations: ["byte-budget-truncated"] }] },
    };
    await persistRunLimitOverflowSidecar(input);
    const sidecar = runLimitOverflowSidecarPath(recordPath);
    const preview = await previewRunDeletion(stateDirectory, record.id);
    let resume!: () => void;
    const held = new Promise<void>((resolve) => {
      resume = resolve;
    });
    let reached!: () => void;
    const removedSidecar = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const deleting = applyRunDeletion(stateDirectory, record.id, preview.confirmation, {
      afterRemove: async (path) => {
        if (path === sidecar) {
          reached();
          await held;
        }
      },
    });
    await removedSidecar;
    const lateWriter = persistRunLimitOverflowSidecar(input);
    await Promise.resolve();
    resume();
    expect((await deleting).complete).toBe(true);
    await expect(lateWriter).rejects.toMatchObject({ code: "tombstoned" });
    await expect(stat(sidecar)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a wrong confirmation before creating deletion state", async () => {
    const parent = await mkdtemp(join(tmpdir(), "docsfab-run-delete-"));
    roots.push(parent);
    const stateDirectory = join(parent, "state");
    const record = authoringReviewFindingsRecord();
    await new FileRunStore(stateDirectory).save(record);
    const preview = await previewRunDeletion(stateDirectory, record.id);

    await expect(applyRunDeletion(stateDirectory, record.id, "0".repeat(64))).rejects.toMatchObject(
      {
        code: "confirmation-changed",
      },
    );
    expect(await readFile(join(stateDirectory, `${record.id}.json`), "utf8")).toContain(record.id);
    await expect(stat(join(stateDirectory, ".docsfab-run-delete-journals"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(
      stat(join(stateDirectory, ".docsfab-run-delete-tombstones")),
    ).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(preview.confirmation).not.toBe("0".repeat(64));
  });

  it("quotes the printed confirmation command for a state path with spaces and apostrophes", async () => {
    const parent = await realpath(await mkdtemp(join(tmpdir(), "docsfab-run-delete-")));
    roots.push(parent);
    const stateDirectory = join(parent, "state's files");
    const record = authoringReviewFindingsRecord();
    await new FileRunStore(stateDirectory).save(record);
    const output = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await handleRunsCommand(["delete", record.id, "--state-dir", stateDirectory]);

    const command = output.mock.calls
      .map(([line]) => String(line))
      .find((line) => line.includes("Confirm with:"));
    expect(command).toContain("--state-dir '");
    expect(command).toContain("state'\\''s files'");
    expect(command).toContain("--confirm '");
    const preview = await previewRunDeletion(stateDirectory, record.id);
    const partial = await applyRunDeletion(stateDirectory, record.id, preview.confirmation, {
      afterRemove: () => {
        throw new Error("injected-after-fixture-unlink");
      },
    });
    expect(partial.complete).toBe(false);
    expect(partial.nextAction).toContain("state'\\''s files'");
  });

  it("includes a completed delivery attempt in the same confirmed deletion", async () => {
    const parent = await realpath(await mkdtemp(join(tmpdir(), "docsfab-run-delete-")));
    roots.push(parent);
    const stateDirectory = join(parent, "state");
    const deliveryRoot = join(parent, "delivery");
    const record = authoringReviewFindingsRecord();
    await new FileRunStore(stateDirectory).save(record);
    await mkdir(deliveryRoot, { mode: 0o700 });
    await mkdir(join(deliveryRoot, "attempts"), { mode: 0o700 });
    await mkdir(join(deliveryRoot, "attempts", "completed"), { mode: 0o700 });
    const attemptPath = join(deliveryRoot, "attempts", "completed");
    const privatePath = join(attemptPath, "validation.json");
    await writeFile(privatePath, "private delivery validation", { mode: 0o600 });
    const recordSha256 = createHash("sha256")
      .update(await readFile(join(stateDirectory, `${record.id}.json`)))
      .digest("hex");
    const metadataPath = await recordRunDeliveryAttemptLocation({
      schemaVersion: 1,
      kind: "docsfab-run-delivery-attempt-location",
      stateDirectory,
      runId: record.id,
      recordSha256,
      deliveryRoot,
      attemptPath,
      planSha256: "a".repeat(64),
    });
    const preview = await previewRunDeletion(stateDirectory, record.id);
    expect(preview.files).toBeGreaterThan(1);
    const result = await applyRunDeletion(stateDirectory, record.id, preview.confirmation);
    expect(result.complete).toBe(true);
    await expect(stat(privatePath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(metadataPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(join(stateDirectory, `${record.id}.json`))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("requires an explicit historical delivery root and then deletes its pinned attempt", async () => {
    const parent = await realpath(await mkdtemp(join(tmpdir(), "docsfab-run-delete-")));
    roots.push(parent);
    const stateDirectory = join(parent, "state");
    const deliveryRoot = join(parent, "historical-delivery");
    const record = authoringReviewFindingsRecord();
    await new FileRunStore(stateDirectory).save(record);
    await mkdir(deliveryRoot, { mode: 0o700 });
    await mkdir(join(deliveryRoot, "attempts"), { mode: 0o700 });
    const attemptPath = join(deliveryRoot, "attempts", "completed");
    await mkdir(attemptPath, { mode: 0o700 });
    const privatePath = join(attemptPath, "validation.json");
    await writeFile(privatePath, "historical private delivery", { mode: 0o600 });
    const recordSha256 = createHash("sha256")
      .update(await readFile(join(stateDirectory, `${record.id}.json`)))
      .digest("hex");
    await recordRunDeliveryAttemptLocation({
      schemaVersion: 1,
      kind: "docsfab-run-delivery-attempt-location",
      stateDirectory,
      runId: record.id,
      recordSha256,
      deliveryRoot,
      attemptPath,
      planSha256: "b".repeat(64),
    });
    const missingRoot = await previewRunDeletion(stateDirectory, record.id);
    expect(missingRoot.unresolved).toBeGreaterThan(0);
    const preview = await capture(() =>
      handleRunsCommand([
        "delete",
        record.id,
        "--state-dir",
        stateDirectory,
        "--delivery-root",
        deliveryRoot,
        "--json",
      ]),
    );
    const approved = JSON.parse(preview.stdout) as { confirmation: string; unresolved: number };
    expect(approved.unresolved).toBe(0);
    const result = await capture(() =>
      handleRunsCommand([
        "delete",
        record.id,
        "--state-dir",
        stateDirectory,
        "--delivery-root",
        deliveryRoot,
        "--confirm",
        approved.confirmation,
        "--json",
      ]),
    );
    expect(JSON.parse(result.stdout).complete).toBe(true);
    await expect(stat(privatePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("reports a registered attempt as incomplete without deleting the source or attempt", async () => {
    const parent = await realpath(await mkdtemp(join(tmpdir(), "docsfab-run-delete-")));
    roots.push(parent);
    const stateDirectory = join(parent, "state");
    const deliveryRoot = join(parent, "delivery");
    const record = authoringReviewFindingsRecord();
    await new FileRunStore(stateDirectory).save(record);
    await mkdir(deliveryRoot, { mode: 0o700 });
    await mkdir(join(deliveryRoot, "attempts"), { mode: 0o700 });
    const attemptPath = join(deliveryRoot, "attempts", "registered");
    const worktreePath = join(attemptPath, "capsule", "repository");
    await mkdir(worktreePath, { recursive: true, mode: 0o700 });
    await writeFile(join(worktreePath, ".git"), "gitdir: elsewhere\n", { mode: 0o600 });
    const recordSha256 = createHash("sha256")
      .update(await readFile(join(stateDirectory, `${record.id}.json`)))
      .digest("hex");
    await recordRunDeliveryAttemptLocation({
      schemaVersion: 1,
      kind: "docsfab-run-delivery-attempt-location",
      stateDirectory,
      runId: record.id,
      recordSha256,
      deliveryRoot,
      attemptPath,
      planSha256: "c".repeat(64),
    });
    const preview = await previewRunDeletion(stateDirectory, record.id);
    expect(preview.unresolved).toBeGreaterThan(0);
    const result = await applyRunDeletion(stateDirectory, record.id, preview.confirmation);
    expect(result.complete).toBe(false);
    expect(result.removed).toBe(0);
    expect(await readFile(join(worktreePath, ".git"), "utf8")).toBe("gitdir: elsewhere\n");
    expect(await new FileRunStore(stateDirectory).get(record.id)).toMatchObject({ id: record.id });
  });

  it("previews and confirms exact ordinary legacy run files while retaining another run", async () => {
    const parent = await mkdtemp(join(tmpdir(), "docsfab-run-delete-"));
    roots.push(parent);
    const stateDirectory = join(parent, "state");
    const record = authoringReviewFindingsRecord();
    const retained = { ...record, id: `${record.id}-retained` };
    await new FileRunStore(stateDirectory).save(record);
    await new FileRunStore(stateDirectory).save(retained);
    await writeStudy(stateDirectory, record.id);
    await mkdir(join(parent, "patches"));
    await writeFile(join(parent, "patches", `${record.id}.patch`), "private-patch", {
      mode: 0o600,
    });
    await writeFile(join(parent, "patches", `${record.id}.candidate1.patch`), "candidate-patch", {
      mode: 0o600,
    });
    await mkdir(join(stateDirectory, "reports", record.id), { recursive: true });
    await writeFile(join(stateDirectory, "reports", record.id, "index.html"), "private-report", {
      mode: 0o600,
    });

    const preview = await capture(() =>
      handleRunsCommand(["delete", record.id, "--state-dir", stateDirectory, "--json"]),
    );
    expect(preview.stdout).toContain('"confirmation"');
    expect(await readFile(join(stateDirectory, `${record.id}.json`), "utf8")).toContain(record.id);
    const token = JSON.parse(preview.stdout).confirmation as string;
    const result = await capture(() =>
      handleRunsCommand([
        "delete",
        record.id,
        "--state-dir",
        stateDirectory,
        "--confirm",
        token,
        "--json",
      ]),
    );
    expect(JSON.parse(result.stdout).complete).toBe(true);
    await expect(stat(join(stateDirectory, `${record.id}.json`))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(stat(join(stateDirectory, "study", `${record.id}.json`))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(stat(join(parent, "patches", `${record.id}.patch`))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(
      stat(join(parent, "patches", `${record.id}.candidate1.patch`)),
    ).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(stat(join(stateDirectory, "reports", record.id))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect((await readdir(stateDirectory)).some((name) => name === `${retained.id}.json`)).toBe(
      true,
    );
    expect(await new FileRunStore(stateDirectory).get(retained.id)).toMatchObject({
      id: retained.id,
    });
  });

  it("uses a validated historical patch path outside the current standard roots", async () => {
    const parent = await mkdtemp(join(tmpdir(), "docsfab-run-delete-"));
    roots.push(parent);
    const stateDirectory = join(parent, "state");
    const customRoot = join(parent, "historical-patches");
    await mkdir(customRoot);
    const base = authoringReviewFindingsRecord();
    const artifactPath = join(customRoot, `${base.id}.patch`);
    const patch = "private historical patch\n";
    await writeFile(artifactPath, patch, { mode: 0o600 });
    const record = {
      ...base,
      changes: {
        files: [],
        patch: {
          sha256: createHash("sha256").update(patch).digest("hex"),
          byteLength: Buffer.byteLength(patch),
          lineCount: 1,
          artifactPath,
          format: "git-diff" as const,
        },
      },
    };
    await new FileRunStore(stateDirectory).save(record);
    const preview = await previewRunDeletion(stateDirectory, record.id);
    expect(preview.files).toBe(2);
    expect((await applyRunDeletion(stateDirectory, record.id, preview.confirmation)).complete).toBe(
      true,
    );
    await expect(stat(artifactPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses a changed leaf after preview without removing the replacement", async () => {
    const parent = await mkdtemp(join(tmpdir(), "docsfab-run-delete-"));
    roots.push(parent);
    const stateDirectory = join(parent, "state");
    const record = authoringReviewFindingsRecord();
    await new FileRunStore(stateDirectory).save(record);
    const preview = await capture(() =>
      handleRunsCommand(["delete", record.id, "--state-dir", stateDirectory, "--json"]),
    );
    const token = JSON.parse(preview.stdout).confirmation as string;
    await writeFile(join(stateDirectory, `${record.id}.json`), "replacement-private-record", {
      mode: 0o600,
    });
    await expect(
      handleRunsCommand([
        "delete",
        record.id,
        "--state-dir",
        stateDirectory,
        "--confirm",
        token,
        "--json",
      ]),
    ).rejects.toThrow();
    expect(await readFile(join(stateDirectory, `${record.id}.json`), "utf8")).toBe(
      "replacement-private-record",
    );
  });

  it("refuses a replaced patch directory after preview without traversing the replacement", async () => {
    const parent = await mkdtemp(join(tmpdir(), "docsfab-run-delete-"));
    roots.push(parent);
    const stateDirectory = join(parent, "state");
    const record = authoringReviewFindingsRecord();
    await new FileRunStore(stateDirectory).save(record);
    const patchRoot = join(parent, "patches");
    await mkdir(patchRoot);
    const patchPath = join(patchRoot, `${record.id}.patch`);
    await writeFile(patchPath, "original patch", { mode: 0o600 });
    const preview = await previewRunDeletion(stateDirectory, record.id);
    await rm(patchRoot, { recursive: true });
    await mkdir(patchRoot);
    await writeFile(patchPath, "replacement patch", { mode: 0o600 });
    await expect(
      applyRunDeletion(stateDirectory, record.id, preview.confirmation),
    ).rejects.toThrow();
    expect(await readFile(patchPath, "utf8")).toBe("replacement patch");
    expect(await readFile(join(stateDirectory, `${record.id}.json`), "utf8")).toContain(record.id);
  });

  it("physically removes every target run-index row and keeps retained rows", async () => {
    const parent = await mkdtemp(join(tmpdir(), "docsfab-run-delete-"));
    roots.push(parent);
    const stateDirectory = join(parent, "state");
    const record = authoringReviewFindingsRecord();
    const retained = { ...record, id: `${record.id}-retained` };
    await createIndexedFileRunStore(stateDirectory).save(record);
    await createIndexedFileRunStore(stateDirectory).save(retained);
    const indexPath = join(parent, "run-index", "runs.jsonl");
    expect(await readFile(indexPath, "utf8")).toContain(record.id);
    const preview = await capture(() =>
      handleRunsCommand(["delete", record.id, "--state-dir", stateDirectory, "--json"]),
    );
    expect(JSON.parse(preview.stdout).indexRows).toBeGreaterThan(0);
    await capture(() =>
      handleRunsCommand([
        "delete",
        record.id,
        "--state-dir",
        stateDirectory,
        "--confirm",
        JSON.parse(preview.stdout).confirmation,
      ]),
    );
    const index = await readFile(indexPath, "utf8");
    expect(index).not.toContain(`"runId":"${record.id}"`);
    expect(index).toContain(`"runId":"${retained.id}"`);
  });

  it("removes a target-identifying overflow signal even when no snapshot was appended", async () => {
    const parent = await mkdtemp(join(tmpdir(), "docsfab-run-delete-"));
    roots.push(parent);
    const stateDirectory = join(parent, "state");
    const record = authoringReviewFindingsRecord();
    await new FileRunStore(stateDirectory).save(record);
    const indexDirectory = join(parent, "run-index");
    await mkdir(indexDirectory);
    await writeFile(
      join(indexDirectory, "overflow.json"),
      JSON.stringify({
        schemaVersion: 1,
        kind: "docsfab-run-index-overflow",
        refusedSnapshots: 1,
        firstRefusedAt: "2026-01-01T00:00:00.000Z",
        lastRefusedAt: "2026-01-01T00:00:00.000Z",
        lastRefusedRunId: record.id,
        lastRefusal: {
          code: "runs-index-max-bytes-bound",
          limitName: "runs.indexMaxBytes",
          limitValue: 1,
          observed: 2,
        },
      }),
    );
    const preview = await previewRunDeletion(stateDirectory, record.id);
    expect(preview.indexOverflow).toBe(true);
    const result = await applyRunDeletion(stateDirectory, record.id, preview.confirmation);
    expect(result.complete).toBe(true);
    await expect(stat(join(indexDirectory, "overflow.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("refuses an aggregate overflow signal that cannot be attributed only to the target", async () => {
    const parent = await mkdtemp(join(tmpdir(), "docsfab-run-delete-"));
    roots.push(parent);
    const stateDirectory = join(parent, "state");
    const record = authoringReviewFindingsRecord();
    await new FileRunStore(stateDirectory).save(record);
    const indexDirectory = join(parent, "run-index");
    await mkdir(indexDirectory);
    await writeFile(
      join(indexDirectory, "overflow.json"),
      JSON.stringify({
        schemaVersion: 1,
        kind: "docsfab-run-index-overflow",
        refusedSnapshots: 2,
        firstRefusedAt: "2026-01-01T00:00:00.000Z",
        lastRefusedAt: "2026-01-02T00:00:00.000Z",
        lastRefusedRunId: record.id,
        lastRefusal: {
          code: "runs-index-max-bytes-bound",
          limitName: "runs.indexMaxBytes",
          limitValue: 1,
          observed: 2,
        },
      }),
    );
    const preview = await previewRunDeletion(stateDirectory, record.id);
    expect(preview.unresolved).toBe(1);
    const result = await applyRunDeletion(stateDirectory, record.id, preview.confirmation);
    expect(result.complete).toBe(false);
    expect(result.removed).toBe(0);
    expect(await readFile(join(stateDirectory, `${record.id}.json`), "utf8")).toContain(record.id);
  });

  it("retains a validated semantic-key context cache entry as shared and deletes the ordinary run", async () => {
    const parent = await mkdtemp(join(tmpdir(), "docsfab-run-delete-"));
    roots.push(parent);
    const stateDirectory = join(parent, "state");
    const record = authoringReviewFindingsRecord();
    await new FileRunStore(stateDirectory).save(record);
    const cacheRoot = join(parent, "context-cache");
    const revision = "a".repeat(40);
    const contentDigest = "b".repeat(64);
    const identity = {
      schemaVersion: 1 as const,
      repositoryRevision: revision,
      repositoryContentDigest: contentDigest,
      indexDigest: "c".repeat(64),
      ontologyDigest: "d".repeat(64),
      semanticStateDigest: "e".repeat(64),
      activePlanDigest: null,
      queryDigest: "f".repeat(64),
      policyDigest: "1".repeat(64),
      budgetDigest: "2".repeat(64),
    };
    await new FileContextCache(cacheRoot).write(identity, {
      status: "unnecessary",
      reasons: [{ code: "context-unnecessary" }],
      provenance: {
        repository: { revision, contentDigest },
        indexDigest: identity.indexDigest,
        ontology: {
          kind: "ontology",
          schemaVersion: 1,
          digest: identity.ontologyDigest,
          repositoryRevision: revision,
          repositoryContentDigest: contentDigest,
        },
        semanticPackets: [],
        consultedNodeIds: [],
        activeDecisionIds: [],
        policy: {
          id: "context-preflight",
          version: "1",
          digest: identity.policyDigest,
          allowDegradedRead: true,
        },
        budget: {
          class: "local",
          maxNodes: 1,
          maxEdges: 1,
          maxPaths: 1,
          maxDepth: 0,
          maxBytes: 1,
          maxEstimatedTokens: 1,
          maxDurationMs: 1,
        },
      },
    });
    const preview = await previewRunDeletion(stateDirectory, record.id);
    expect(preview.unresolved).toBe(0);
    expect(preview.sharedRetained).toBe(1);
    const result = await applyRunDeletion(stateDirectory, record.id, preview.confirmation);
    expect(result.complete).toBe(true);
    expect(result.sharedRetained).toBe(1);
    expect(await readdir(cacheRoot)).toHaveLength(1);
    await expect(stat(join(stateDirectory, `${record.id}.json`))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("reports a corrupt legacy cache as incomplete without claiming deletion", async () => {
    const parent = await mkdtemp(join(tmpdir(), "docsfab-run-delete-"));
    roots.push(parent);
    const stateDirectory = join(parent, "state");
    const record = authoringReviewFindingsRecord();
    await new FileRunStore(stateDirectory).save(record);
    const cacheRoot = join(parent, "context-cache");
    await mkdir(cacheRoot);
    await writeFile(join(cacheRoot, `${"a".repeat(64)}.json`), "corrupt cached context", {
      mode: 0o600,
    });
    const preview = await previewRunDeletion(stateDirectory, record.id);
    expect(preview.unresolved).toBe(1);
    const result = await applyRunDeletion(stateDirectory, record.id, preview.confirmation);
    expect(result.complete).toBe(false);
    expect(result.removed).toBe(0);
    expect(result.unresolved).toBe(1);
    expect(result.nextAction).toContain("context-cache");
    expect(await readFile(join(stateDirectory, `${record.id}.json`), "utf8")).toContain(record.id);
  });

  it("blocks a stale writer from recreating an erased run record", async () => {
    const parent = await mkdtemp(join(tmpdir(), "docsfab-run-delete-"));
    roots.push(parent);
    const stateDirectory = join(parent, "state");
    const record = authoringReviewFindingsRecord();
    const stale = new FileRunStore(stateDirectory);
    await stale.save(record);
    const preview = await capture(() =>
      handleRunsCommand(["delete", record.id, "--state-dir", stateDirectory, "--json"]),
    );
    await capture(() =>
      handleRunsCommand([
        "delete",
        record.id,
        "--state-dir",
        stateDirectory,
        "--confirm",
        JSON.parse(preview.stdout).confirmation,
      ]),
    );
    await expect(new FileRunStore(stateDirectory).save(record)).rejects.toThrow(/deleted/u);
    await expect(stale.save(record)).rejects.toThrow(/deleted/u);
    await expect(stat(join(stateDirectory, `${record.id}.json`))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("blocks old study and hosted-report writers after the run tombstone", async () => {
    const parent = await mkdtemp(join(tmpdir(), "docsfab-run-delete-"));
    roots.push(parent);
    const stateDirectory = join(parent, "state");
    const record = authoringReviewFindingsRecord();
    await new FileRunStore(stateDirectory).save(record);
    await writeStudy(stateDirectory, record.id);
    const preview = await previewRunDeletion(stateDirectory, record.id);
    expect((await applyRunDeletion(stateDirectory, record.id, preview.confirmation)).complete).toBe(
      true,
    );
    await expect(writeStudy(stateDirectory, record.id)).rejects.toThrow(/deleted/u);
    await expect(
      persistHostedQualityReport({
        stateDirectory,
        runId: record.id,
        quality: null,
        markdown: "private report",
      }),
    ).rejects.toThrow(/deleted/u);
    await expect(stat(join(stateDirectory, "study", `${record.id}.json`))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(stat(join(stateDirectory, "reports", record.id))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("resumes the approved inventory after a sidecar unlink and removes its private journal", async () => {
    const parent = await mkdtemp(join(tmpdir(), "docsfab-run-delete-"));
    roots.push(parent);
    const stateDirectory = join(parent, "state");
    const record = authoringReviewFindingsRecord();
    await new FileRunStore(stateDirectory).save(record);
    await writeStudy(stateDirectory, record.id);
    const preview = await previewRunDeletion(stateDirectory, record.id);
    const partial = await applyRunDeletion(stateDirectory, record.id, preview.confirmation, {
      afterRemove: () => {
        throw new Error("injected-stop-after-unlink");
      },
    });
    expect(partial.complete).toBe(false);
    expect(partial.removed).toBe(1);
    expect(partial.nextAction).toContain("--confirm");
    expect((await previewRunDeletion(stateDirectory, record.id)).confirmation).toBe(
      preview.confirmation,
    );
    const resumed = await applyRunDeletion(stateDirectory, record.id, preview.confirmation);
    expect(resumed.complete).toBe(true);
    expect(resumed.removed).toBe(2);
    await expect(stat(join(stateDirectory, `${record.id}.json`))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(await readdir(join(stateDirectory, ".docsfab-run-delete-journals"))).toEqual([]);
  });

  it("resumes journal cleanup after the source record was already removed", async () => {
    const parent = await mkdtemp(join(tmpdir(), "docsfab-run-delete-"));
    roots.push(parent);
    const stateDirectory = join(parent, "state");
    const record = authoringReviewFindingsRecord();
    await new FileRunStore(stateDirectory).save(record);
    const preview = await previewRunDeletion(stateDirectory, record.id);
    const partial = await applyRunDeletion(stateDirectory, record.id, preview.confirmation, {
      afterRemove: () => {
        throw new Error("injected-after-source-unlink");
      },
    });
    expect(partial.complete).toBe(false);
    expect(partial.removed).toBe(1);
    expect(partial.unresolved).toBe(0);
    expect((await previewRunDeletion(stateDirectory, record.id)).confirmation).toBe(
      preview.confirmation,
    );
    const resumed = await applyRunDeletion(stateDirectory, record.id, preview.confirmation);
    expect(resumed.complete).toBe(true);
    expect(resumed.removed).toBe(1);
    expect(await readdir(join(stateDirectory, ".docsfab-run-delete-journals"))).toEqual([]);
  });

  it("keeps a shared content object until its last retained run is deleted", async () => {
    const parent = await mkdtemp(join(tmpdir(), "docsfab-run-delete-"));
    roots.push(parent);
    const stateDirectory = join(parent, "state");
    const artifactRoot = join(parent, "artifacts");
    const value = { evidence: "private-artifact-content" };
    const digest = createHash("sha256").update(JSON.stringify(value)).digest("hex");
    await new DurableArtifactStore(artifactRoot).putRecord(digest, value);
    const use = {
      role: "output" as const,
      reference: {
        kind: "ia-plan" as const,
        schemaVersion: 1 as const,
        digest,
        repositoryRevision: "a".repeat(40),
        repositoryContentDigest: "b".repeat(64),
      },
    };
    const first = { ...authoringReviewFindingsRecord(), artifacts: [use] };
    const second = { ...first, id: `${first.id}-retained` };
    await new FileRunStore(stateDirectory).save(first);
    await new FileRunStore(stateDirectory).save(second);
    const objectPath = join(artifactRoot, "objects", "sha256", `${digest}.json`);
    const firstPreview = await previewRunDeletion(stateDirectory, first.id);
    const firstResult = await applyRunDeletion(stateDirectory, first.id, firstPreview.confirmation);
    expect(firstResult.complete).toBe(true);
    expect(firstResult.sharedRetained).toBe(1);
    expect(await readFile(objectPath, "utf8")).toContain("private-artifact-content");
    const secondPreview = await previewRunDeletion(stateDirectory, second.id);
    const secondResult = await applyRunDeletion(
      stateDirectory,
      second.id,
      secondPreview.confirmation,
    );
    expect(secondResult.complete).toBe(true);
    await expect(stat(objectPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("retains an artifact digest held by a supported non-run object", async () => {
    const parent = await mkdtemp(join(tmpdir(), "docsfab-run-delete-"));
    roots.push(parent);
    const stateDirectory = join(parent, "state");
    const artifactRoot = join(parent, "artifacts");
    const value = { evidence: "private-artifact-content" };
    const digest = createHash("sha256").update(JSON.stringify(value)).digest("hex");
    const store = new DurableArtifactStore(artifactRoot);
    await store.putRecord(digest, value);
    const owner = { kind: "docsfab-foundation-onboarding-questions", canonSha256: digest };
    const ownerDigest = createHash("sha256").update(JSON.stringify(owner)).digest("hex");
    await store.putRecord(ownerDigest, owner);
    const base = authoringReviewFindingsRecord();
    const record = {
      ...base,
      artifacts: [
        {
          role: "output" as const,
          reference: {
            kind: "ia-plan" as const,
            schemaVersion: 1 as const,
            digest,
            repositoryRevision: "a".repeat(40),
            repositoryContentDigest: "b".repeat(64),
          },
        },
      ],
    };
    await new FileRunStore(stateDirectory).save(record);
    const preview = await previewRunDeletion(stateDirectory, record.id);
    expect(preview.sharedRetained).toBe(1);
    expect((await applyRunDeletion(stateDirectory, record.id, preview.confirmation)).complete).toBe(
      true,
    );
    expect(
      await readFile(join(artifactRoot, "objects", "sha256", `${digest}.json`), "utf8"),
    ).toContain("private-artifact-content");
    expect(
      await readFile(join(artifactRoot, "objects", "sha256", `${ownerDigest}.json`), "utf8"),
    ).toContain("docsfab-foundation-onboarding-questions");
  });

  it("does not publish another run's reference to an object removed during confirmation", async () => {
    const parent = await mkdtemp(join(tmpdir(), "docsfab-run-delete-"));
    roots.push(parent);
    const stateDirectory = join(parent, "state");
    const artifactRoot = join(parent, "artifacts");
    const value = { evidence: "private-artifact-content" };
    const digest = createHash("sha256").update(JSON.stringify(value)).digest("hex");
    await new DurableArtifactStore(artifactRoot).putRecord(digest, value);
    const use = {
      role: "output" as const,
      reference: {
        kind: "ia-plan" as const,
        schemaVersion: 1 as const,
        digest,
        repositoryRevision: "a".repeat(40),
        repositoryContentDigest: "b".repeat(64),
      },
    };
    const first = { ...authoringReviewFindingsRecord(), artifacts: [use] };
    await new FileRunStore(stateDirectory).save(first);
    await writeStudy(stateDirectory, first.id);
    const preview = await previewRunDeletion(stateDirectory, first.id);
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let reached!: () => void;
    const atSidecar = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const deleting = applyRunDeletion(stateDirectory, first.id, preview.confirmation, {
      afterRemove: async (path) => {
        if (path.endsWith(`${first.id}.json`)) {
          reached();
          await held;
        }
      },
    });
    await atSidecar;
    const other = { ...first, id: `${first.id}-later` };
    const publishing = new FileRunStore(stateDirectory).save(other);
    await new Promise((resolve) => setTimeout(resolve, 50));
    await expect(stat(join(stateDirectory, `${other.id}.json`))).rejects.toMatchObject({
      code: "ENOENT",
    });
    release();
    expect((await deleting).complete).toBe(true);
    await expect(publishing).rejects.toThrow(/object was deleted/u);
    await expect(stat(join(stateDirectory, `${other.id}.json`))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await new DurableArtifactStore(artifactRoot).putRecord(digest, value);
    await expect(
      stat(join(artifactRoot, ".docsfab-run-deleted-objects", digest)),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(new FileRunStore(stateDirectory).save(other)).resolves.toBeUndefined();
    expect(await new FileRunStore(stateDirectory).get(other.id)).toMatchObject({ id: other.id });
  });
});

async function writeStudy(stateDirectory: string, runId: string): Promise<void> {
  const session = new StudySession({ directory: studyDirectory(stateDirectory) });
  await session.ensureRun({
    runId,
    observationMode: "corpus",
    modelRef: { provider: "nvidia-api-catalog", catalogId: "operator-profile-model" },
  });
}

async function capture(action: () => Promise<void>): Promise<{ stdout: string; stderr: string }> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  vi.spyOn(console, "log").mockImplementation((value: unknown) => stdout.push(String(value)));
  vi.spyOn(console, "error").mockImplementation((value: unknown) => stderr.push(String(value)));
  try {
    await action();
  } finally {
    vi.restoreAllMocks();
  }
  return { stdout: stdout.join("\n"), stderr: stderr.join("\n") };
}
