// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  stat,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { inventoryRunDelivery } from "../src/delivery/run-deletion-adapter.js";
import { DurableArtifactStore, opaqueRecordDigest } from "../src/artifacts/store.js";
import {
  decodeSourceSnapshotPart,
  decodeSourceSnapshotRoot,
  retainSourceSnapshotParts,
} from "../src/review-delivery/source-snapshot-store.js";
import { LIMIT_DEFINITION_BY_NAME } from "../src/config/limits.js";
import {
  withDeliveryRootGates,
  withPinnedDeliveryRootGates,
} from "../src/delivery/delivery-root-gates.js";
import { FileRunStore } from "../src/records/file-store.js";
import * as maintenanceGates from "../src/records/run-maintenance-gate.js";
import { applyRunDeletion, previewRunDeletion } from "../src/records/run-deletion.js";
import { authoringReviewFindingsRecord } from "./helpers/authoring-review-record.js";

async function sealedSourceDeletionFixture(name: string, twoParts = false) {
  const parent = await realpath(await mkdtemp(join(tmpdir(), `docsfab-${name}-`)));
  const stateDirectory = join(parent, "runs");
  const run = { ...authoringReviewFindingsRecord(), id: `run-${name}` };
  await new FileRunStore(stateDirectory).save(run);
  const artifactRoot = join(parent, "artifacts");
  const artifacts = new DurableArtifactStore(artifactRoot);
  const partLimit = LIMIT_DEFINITION_BY_NAME["reviewDelivery.snapshotPartBytes"]!;
  const retained = await retainSourceSnapshotParts(
    artifacts,
    {
      runId: run.id,
      sourceSha256: "a".repeat(64),
      repositoryIdentitySha256: "b".repeat(64),
      reviewedHeadSha: "c".repeat(40),
      snapshotSha256: "d".repeat(64),
      manifest: {
        observationId: "fixture:manifest",
        bytes: twoParts
          ? new Uint8Array(partLimit.min + 1).fill(65)
          : new TextEncoder().encode("manifest\n"),
      },
      diff: { observationId: "fixture:diff", bytes: new TextEncoder().encode("diff\n") },
      rows: [],
    },
    twoParts
      ? {
          limits: {
            environment: { [partLimit.override]: String(partLimit.min) },
            hostFile: null,
            projectFile: null,
          },
        }
      : {},
  );
  const sourceRoot = decodeSourceSnapshotRoot(
    await artifacts.getRecord(retained.rootObjectSha256, { readOnly: true }),
  );
  const objectDirectory = join(artifactRoot, "objects", "sha256");
  const partPaths = sourceRoot.partDigests.map((digest) => join(objectDirectory, `${digest}.json`));
  const rootPath = join(objectDirectory, `${retained.rootObjectSha256}.json`);
  const reportDirectory = join(stateDirectory, "reports", run.id);
  await mkdir(reportDirectory, { recursive: true, mode: 0o700 });
  const marker = join(reportDirectory, "interrupt.txt");
  await writeFile(marker, "interrupt after the confirmed journal\n", { mode: 0o600 });
  return {
    stateDirectory,
    runId: run.id,
    artifactRoot,
    artifacts,
    sourceRoot,
    rootPath,
    partPaths,
    marker,
  };
}

async function interruptApprovedSourcePartDeletion(
  fixture: Awaited<ReturnType<typeof sealedSourceDeletionFixture>>,
): Promise<string> {
  const preview = await previewRunDeletion(fixture.stateDirectory, fixture.runId);
  expect(preview.unresolved).toBe(0);
  let interruptedAtMarker = false;
  const first = await applyRunDeletion(
    fixture.stateDirectory,
    fixture.runId,
    preview.confirmation,
    {
      async afterRemove(path) {
        if (path !== fixture.marker) return;
        interruptedAtMarker = true;
        await maintenanceGates.markArtifactObjectForDeletion(
          fixture.artifactRoot,
          fixture.sourceRoot.partDigests[0]!,
        );
        await unlink(fixture.partPaths[0]!);
        throw new Error("injected interruption after approved source part removal");
      },
    },
  );
  expect(interruptedAtMarker).toBe(true);
  expect(first.complete).toBe(false);
  expect(first.nextAction).toContain("injected interruption after approved source part removal");
  expect((await stat(fixture.rootPath)).isFile()).toBe(true);
  expect(await readdir(join(fixture.artifactRoot, "objects", "sha256"))).not.toContain(
    `${fixture.sourceRoot.partDigests[0]}.json`,
  );
  expect(await new FileRunStore(fixture.stateDirectory).get(fixture.runId)).toBeDefined();
  expect(await maintenanceGates.isRunTombstoned(fixture.stateDirectory, fixture.runId)).toBe(true);
  return preview.confirmation;
}

describe("run delivery deletion inventory", () => {
  afterEach(() => vi.restoreAllMocks());

  it("uses the established code-unit order for mixed-case and punctuation receipt roots", async () => {
    const parent = await realpath(await mkdtemp(join(tmpdir(), "docsfab-deletion-order-")));
    const roots = ["a-receipts", "B-receipts", "~receipts"].map((name) => join(parent, name));
    for (const root of roots) await mkdir(root, { mode: 0o700 });
    const actual = maintenanceGates.withRunMaintenanceGate;
    const acquired: string[] = [];
    vi.spyOn(maintenanceGates, "withRunMaintenanceGate").mockImplementation(
      async (root, action, onContention) =>
        actual(
          root,
          async () => {
            acquired.push(root);
            return action();
          },
          onContention,
        ),
    );
    await withDeliveryRootGates(roots, async () => undefined);
    const established = [...acquired];
    acquired.length = 0;
    await withPinnedDeliveryRootGates(roots, async () => undefined);
    expect(acquired).toEqual(established);
    expect(established).toEqual([roots[1], roots[0], roots[2]]);
  });

  it("lets a real preview finish before confirmed apply takes the same first receipt root", async () => {
    const parent = await realpath(await mkdtemp(join(tmpdir(), "docsfab-deletion-contention-")));
    const stateDirectory = join(parent, "runs");
    const run = { ...authoringReviewFindingsRecord(), id: "run-root-order-contention" };
    await new FileRunStore(stateDirectory).save(run);
    const upper = join(parent, "B-receipts");
    const lower = join(parent, "a-receipts");
    await mkdir(upper, { mode: 0o700 });
    await mkdir(lower, { mode: 0o700 });
    const suppliedRoots = { receiptRoots: [lower, upper] };
    const initial = await previewRunDeletion(stateDirectory, run.id, suppliedRoots);
    const role = new AsyncLocalStorage<"preview" | "apply">();
    const actual = maintenanceGates.withRunMaintenanceGate;
    let releasePreview!: () => void;
    const previewRelease = new Promise<void>((resolve) => {
      releasePreview = resolve;
    });
    let signalPreviewHeld!: () => void;
    const previewHeld = new Promise<void>((resolve) => {
      signalPreviewHeld = resolve;
    });
    let signalContention!: (root: string) => void;
    const contention = new Promise<string>((resolve) => {
      signalContention = resolve;
    });
    const applyAcquired: string[] = [];
    let held = false;
    let finalPhase = false;
    vi.spyOn(maintenanceGates, "withRunMaintenanceGate").mockImplementation(
      async (root, action, onContention) =>
        actual(
          root,
          async () => {
            if (role.getStore() === "preview" && root === upper && !held) {
              held = true;
              signalPreviewHeld();
              await previewRelease;
            }
            if (role.getStore() === "apply" && finalPhase && (root === upper || root === lower))
              applyAcquired.push(root);
            return action();
          },
          role.getStore() === "apply" && finalPhase && (root === upper || root === lower)
            ? async () => {
                signalContention(root);
                await onContention?.();
                if (applyAcquired.length > 0)
                  throw new Error("Confirmed deletion acquired a later receipt root first.");
              }
            : onContention,
        ),
    );
    let competingPreview: Promise<Awaited<ReturnType<typeof previewRunDeletion>>> | undefined;
    const apply = role
      .run("apply", () =>
        applyRunDeletion(
          stateDirectory,
          run.id,
          initial.confirmation,
          {
            async beforeFinalReceiptGate() {
              finalPhase = true;
              competingPreview = role.run("preview", () =>
                previewRunDeletion(stateDirectory, run.id, suppliedRoots),
              );
              await previewHeld;
            },
          },
          suppliedRoots,
        ),
      )
      .then(
        (result) => ({ kind: "result" as const, result }),
        (error: unknown) => ({ kind: "error" as const, error }),
      );
    const observed = await Promise.race([
      contention.then((root) => ({ kind: "contention" as const, root })),
      apply.then(() => ({ kind: "settled" as const })),
    ]);
    const acquiredWhilePreviewHeld = [...applyAcquired];
    releasePreview();
    const [laterPreview, settled] = await Promise.all([competingPreview!, apply]);
    expect(observed).toEqual({ kind: "contention", root: upper });
    expect(acquiredWhilePreviewHeld).toEqual([]);
    expect(laterPreview.confirmation).toBe(initial.confirmation);
    if (settled.kind === "error") throw settled.error;
    expect(settled.result.complete).toBe(true);
    expect(applyAcquired[0]).toBe(upper);
  });

  it("inventories ordinary empty publication roots without creating or deleting bytes", async () => {
    const parent = await realpath(await mkdtemp(join(tmpdir(), "docsfab-delivery-delete-")));
    const stateDirectory = join(parent, "state");
    await mkdir(stateDirectory, { mode: 0o700 });
    const before = await readdir(parent);
    const inventory = await inventoryRunDelivery({
      stateDirectory,
      runId: "run-empty",
      recordSha256: "a".repeat(64),
    });
    expect(inventory).toMatchObject({
      runId: "run-empty",
      receipts: [],
      plans: [],
      attempts: [],
      sharedRetained: 0,
      unresolved: [],
    });
    expect(await readdir(parent)).toEqual(before);
  });

  it("resumes confirmed deletion after an approved review source part was already removed", async () => {
    const fixture = await sealedSourceDeletionFixture("partial-review-source");
    expect(fixture.sourceRoot.partDigests).toHaveLength(1);
    const confirmation = await interruptApprovedSourcePartDeletion(fixture);
    const resumed = await applyRunDeletion(fixture.stateDirectory, fixture.runId, confirmation);
    expect(resumed.complete, resumed.nextAction).toBe(true);
    expect(await readdir(join(fixture.artifactRoot, "objects", "sha256"))).not.toContain(
      basename(fixture.rootPath),
    );
  });

  it("does not treat a source part missing before preview as approved deletion progress", async () => {
    const fixture = await sealedSourceDeletionFixture("missing-source-before-preview");
    await unlink(fixture.partPaths[0]!);
    await expect(previewRunDeletion(fixture.stateDirectory, fixture.runId)).rejects.toMatchObject({
      code: "artifact-owner-invalid",
    });
    expect((await stat(fixture.rootPath)).isFile()).toBe(true);
    expect(await new FileRunStore(fixture.stateDirectory).get(fixture.runId)).toBeDefined();
  });

  it("refuses an approved part that became shared before a partial resume", async () => {
    const fixture = await sealedSourceDeletionFixture("shared-part-resume");
    const partDigest = fixture.sourceRoot.partDigests[0]!;
    const foreign = {
      kind: "foreign-artifact-reference",
      reference: {
        kind: "review-result",
        digest: partDigest,
        repositoryRevision: "foreign-revision",
        repositoryContentDigest: "foreign-content",
      },
    };
    const foreignDigest = opaqueRecordDigest(foreign);
    await fixture.artifacts.putRecord(foreignDigest, foreign);
    const preview = await previewRunDeletion(fixture.stateDirectory, fixture.runId);
    expect(preview.sharedRetained).toBeGreaterThan(0);
    let interrupted = false;
    const first = await applyRunDeletion(
      fixture.stateDirectory,
      fixture.runId,
      preview.confirmation,
      {
        async afterRemove(path) {
          if (path !== fixture.marker) return;
          interrupted = true;
          await unlink(fixture.partPaths[0]!);
          throw new Error("injected external loss of shared source part");
        },
      },
    );
    expect(interrupted).toBe(true);
    expect(first.nextAction).toContain("injected external loss of shared source part");
    const resumed = await applyRunDeletion(
      fixture.stateDirectory,
      fixture.runId,
      preview.confirmation,
    );
    expect(resumed.complete).toBe(false);
    expect(resumed.nextAction).toContain("artifact-owner-invalid");
    expect((await stat(fixture.rootPath)).isFile()).toBe(true);
    expect(await new FileRunStore(fixture.stateDirectory).get(fixture.runId)).toBeDefined();
    expect(await fixture.artifacts.getRecord(foreignDigest, { readOnly: true })).toEqual(foreign);
  });

  it("refuses a new foreign reference to a part already removed by confirmed deletion", async () => {
    const fixture = await sealedSourceDeletionFixture("late-shared-part-resume");
    const confirmation = await interruptApprovedSourcePartDeletion(fixture);
    const foreign = {
      kind: "foreign-artifact-reference",
      reference: {
        kind: "review-result",
        digest: fixture.sourceRoot.partDigests[0],
        repositoryRevision: "foreign-revision",
        repositoryContentDigest: "foreign-content",
      },
    };
    const foreignDigest = opaqueRecordDigest(foreign);
    await fixture.artifacts.putRecord(foreignDigest, foreign);
    const before = await readdir(join(fixture.artifactRoot, "objects", "sha256"));
    const resumed = await applyRunDeletion(fixture.stateDirectory, fixture.runId, confirmation);
    expect(resumed.complete).toBe(false);
    expect(resumed.nextAction).toContain("newly shared review source part");
    expect(await readdir(join(fixture.artifactRoot, "objects", "sha256"))).toEqual(before);
    expect((await stat(fixture.rootPath)).isFile()).toBe(true);
    expect(await new FileRunStore(fixture.stateDirectory).get(fixture.runId)).toBeDefined();
    expect(await fixture.artifacts.getRecord(foreignDigest, { readOnly: true })).toEqual(foreign);
  });

  it("refuses a changed surviving part even when its replacement is correctly sealed", async () => {
    const fixture = await sealedSourceDeletionFixture("changed-survivor-resume", true);
    expect(fixture.partPaths.length).toBeGreaterThan(1);
    const confirmation = await interruptApprovedSourcePartDeletion(fixture);
    const survivorPath = fixture.partPaths[1]!;
    const original = JSON.parse(await readFile(survivorPath, "utf8")) as Record<string, unknown>;
    const originalRaw = Buffer.from(original.rawBase64 as string, "base64");
    const replacedRaw = Buffer.from(originalRaw);
    replacedRaw[0] = replacedRaw[0]! ^ 1;
    const replacement = {
      ...original,
      rawBase64: replacedRaw.toString("base64"),
      rawSha256: createHash("sha256").update(replacedRaw).digest("hex"),
    };
    decodeSourceSnapshotPart(replacement);
    await writeFile(survivorPath, JSON.stringify(replacement), { mode: 0o600 });
    const before = await readdir(join(fixture.artifactRoot, "objects", "sha256"));
    const resumed = await applyRunDeletion(fixture.stateDirectory, fixture.runId, confirmation);
    expect(resumed.complete).toBe(false);
    expect(resumed.nextAction).toContain("artifact-owner-invalid");
    expect(await readdir(join(fixture.artifactRoot, "objects", "sha256"))).toEqual(before);
    expect(await new FileRunStore(fixture.stateDirectory).get(fixture.runId)).toBeDefined();
  });

  it("refuses a changed source root or a new malformed owned root during resume", async () => {
    for (const changed of ["root", "new-root"] as const) {
      const fixture = await sealedSourceDeletionFixture(`changed-${changed}-resume`);
      const confirmation = await interruptApprovedSourcePartDeletion(fixture);
      if (changed === "root") {
        const replacement = { ...fixture.sourceRoot, reviewedHeadSha: "e".repeat(40) };
        decodeSourceSnapshotRoot(replacement);
        await writeFile(fixture.rootPath, JSON.stringify(replacement), { mode: 0o600 });
      } else {
        await writeFile(
          join(fixture.artifactRoot, "objects", "sha256", `${"e".repeat(64)}.json`),
          JSON.stringify({ kind: "docsfab-review-delivery-snapshot", runId: fixture.runId }),
          { mode: 0o600 },
        );
      }
      const before = await readdir(join(fixture.artifactRoot, "objects", "sha256"));
      const resumed = await applyRunDeletion(fixture.stateDirectory, fixture.runId, confirmation);
      expect(resumed.complete).toBe(false);
      expect(resumed.nextAction).toContain("artifact-owner-invalid");
      expect(await readdir(join(fixture.artifactRoot, "objects", "sha256"))).toEqual(before);
      expect(await new FileRunStore(fixture.stateDirectory).get(fixture.runId)).toBeDefined();
    }
  });

  it("rejects stale confirmation and a replaced artifact root before partial resume", async () => {
    const stale = await sealedSourceDeletionFixture("stale-partial-source");
    const staleConfirmation = await interruptApprovedSourcePartDeletion(stale);
    await expect(
      applyRunDeletion(stale.stateDirectory, stale.runId, "f".repeat(staleConfirmation.length)),
    ).rejects.toMatchObject({ code: "confirmation-changed" });
    expect((await stat(stale.rootPath)).isFile()).toBe(true);
    const replaced = await sealedSourceDeletionFixture("replaced-source-root");
    const confirmation = await interruptApprovedSourcePartDeletion(replaced);
    await rename(replaced.artifactRoot, `${replaced.artifactRoot}-replaced`);
    await mkdir(replaced.artifactRoot, { mode: 0o700 });
    await expect(
      applyRunDeletion(replaced.stateDirectory, replaced.runId, confirmation),
    ).rejects.toMatchObject({
      code: "root-changed",
    });
    expect(await new FileRunStore(replaced.stateDirectory).get(replaced.runId)).toBeDefined();
  });

  it("prepares only the absent default receipt root during confirmed deletion", async () => {
    const parent = await realpath(await mkdtemp(join(tmpdir(), "docsfab-deletion-root-")));
    const stateDirectory = join(parent, "runs");
    const run = { ...authoringReviewFindingsRecord(), id: "run-absent-receipt-root" };
    await new FileRunStore(stateDirectory).save(run);
    const preview = await previewRunDeletion(stateDirectory, run.id);
    expect(await readdir(parent)).not.toContain("receipts");
    const result = await applyRunDeletion(stateDirectory, run.id, preview.confirmation);
    expect(result.complete).toBe(true);
    expect((await stat(join(parent, "receipts"))).mode & 0o7777).toBe(0o700);
  });

  it("deduplicates physical receipt-root aliases before acquiring a gate", async () => {
    const parent = await realpath(await mkdtemp(join(tmpdir(), "docsfab-deletion-alias-")));
    const root = join(parent, "receipts");
    const alias = join(parent, "receipt-alias");
    await mkdir(root, { mode: 0o700 });
    await symlink(root, alias);
    const held = await withPinnedDeliveryRootGates([alias, root, alias], async (roots) => roots);
    expect(held).toEqual([root]);
  });

  it("refuses an unsafe root appearing after preview without tightening its permissions", async () => {
    const parent = await realpath(await mkdtemp(join(tmpdir(), "docsfab-deletion-mode-")));
    const stateDirectory = join(parent, "runs");
    const run = { ...authoringReviewFindingsRecord(), id: "run-unsafe-receipt-root" };
    await new FileRunStore(stateDirectory).save(run);
    const preview = await previewRunDeletion(stateDirectory, run.id);
    const root = join(parent, "receipts");
    await mkdir(root, { mode: 0o700 });
    await chmod(root, 0o755);
    await expect(applyRunDeletion(stateDirectory, run.id, preview.confirmation)).rejects.toThrow(
      "unsafe",
    );
    expect((await stat(root)).mode & 0o7777).toBe(0o755);
    expect(await new FileRunStore(stateDirectory).get(run.id)).toBeDefined();
  });
});
