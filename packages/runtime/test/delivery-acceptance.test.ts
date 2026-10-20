// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import { collectCredentialFindings } from "../src/security/credential-shape-findings.js";
import {
  clearPlantedCredential,
  plantConfiguredCredential,
} from "./helpers/planted-configured-credential.js";

import {
  assertDeliveryAcceptanceManifest,
  assembleVerifiedDeliveryAcceptanceChain,
  deliveryAcceptanceManifestSha256,
  deliveryAcceptanceSourceCheckoutSha256,
  DELIVERY_ACCEPTANCE_EMPTY_IGNORED_STATE_SUMMARY,
  DELIVERY_ACCEPTANCE_IGNORED_STATE_POLICY,
  DELIVERY_ACCEPTANCE_CASE_IDS,
  finalizeDeliveryAcceptanceChainBinding,
  finalizeDeliveryAcceptanceManifest,
  observeDeliveryAcceptanceSourceCheckout,
  parseDeliveryAcceptanceChainBinding,
  parseDeliveryAcceptanceManifest,
  runDeliveryAcceptanceCli,
  runOfflineDeliveryAcceptance,
} from "../src/delivery/index.js";
import { canonicalizeJsonEvidence } from "../src/json-evidence.js";
import { loadSavedRunEditorialDecodeOptions } from "../src/cli/run/editorial-replay.js";
import type { RunRecord } from "../src/records/contracts.js";
import { initFixtureRepo } from "./helpers/git.js";
import { limit } from "../src/config/limits.js";
import { testTimeoutMs } from "./helpers/test-timeouts.js";

const exec = promisify(execFile);
const roots: string[] = [];
/** Offline delivery + process recovery is heavy on shared runners. */
const offlineAcceptanceTimeoutMs = testTimeoutMs(
  limit("test.offlineDeliveryAcceptanceTimeoutMs").value,
);

afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("local-user GitLab delivery acceptance", () => {
  it(
    "runs the real offline delivery, strict failure matrix, idempotency, and OS-process recovery",
    async () => {
      const stateRoot = await temporary("docsfab-delivery-acceptance-state-");
      const evidenceRoot = await temporary("docsfab-delivery-acceptance-evidence-");
      const testedRevision = (
        await exec("git", ["rev-parse", "HEAD"], {
          cwd: process.cwd(),
          encoding: "utf8",
        })
      ).stdout.trim();
      const result = await runOfflineDeliveryAcceptance({
        stateRoot,
        evidenceRoot,
        testedRevision,
      });

      expect(result.workspacePreserved).toBe(true);
      expect(result.manifest.status).toBe("passed");
      expect(result.manifest.failureMatrix.map((item) => item.id)).toEqual(
        DELIVERY_ACCEPTANCE_CASE_IDS,
      );
      const fixture = JSON.parse(
        await readFile(
          resolve(process.cwd(), "test/fixtures/runtime-evaluation/delivery/acceptance-cases.json"),
          "utf8",
        ),
      );
      expect(fixture.schemaVersion).toBe(1);
      expect(fixture.cases.map((item: { id: string }) => item.id)).toEqual(
        DELIVERY_ACCEPTANCE_CASE_IDS,
      );
      expect(fixture.cases.map((item: { expected: string }) => item.expected)).toEqual(
        result.manifest.failureMatrix.map((item) => item.expectedFailureCode),
      );
      expect(result.manifest.sourceCheckout.beforeSha256).toBe(
        result.manifest.sourceCheckout.afterSha256,
      );
      expect(result.manifest.idempotency).toEqual({
        invocationCount: 2,
        mergeRequestCreateCount: 1,
        status: "reused",
      });
      expect(() => assertDeliveryAcceptanceManifest(result.manifest)).not.toThrow();

      const authenticEvidence = {
        testedRevision,
        readinessRecordBytes: await readFile(result.chainEvidencePaths.readinessRecordPath),
        declarationBytes: await readFile(result.chainEvidencePaths.declarationPath),
        analysisRecordBytes: await readFile(result.chainEvidencePaths.analysisRecordPath),
        authorizationBytes: await readFile(result.chainEvidencePaths.authorizationPath),
        reviewerPolicyBytes: await readFile(result.chainEvidencePaths.reviewerPolicyPath),
        applicationRecordBytes: await readFile(result.chainEvidencePaths.applicationRecordPath),
        patchBytes: await readFile(result.chainEvidencePaths.patchPath),
      };
      const applicationRecord = JSON.parse(
        authenticEvidence.applicationRecordBytes.toString("utf8"),
      ) as RunRecord;
      const editorialDecodeOptions = await loadSavedRunEditorialDecodeOptions(
        applicationRecord,
        dirname(result.chainEvidencePaths.applicationRecordPath),
      );
      expect(
        assembleVerifiedDeliveryAcceptanceChain(authenticEvidence, editorialDecodeOptions),
      ).toEqual(result.manifest.chain);
      const assembledPath = join(evidenceRoot, "verified-live-chain.json");
      await runDeliveryAcceptanceCli(
        [
          "--assemble-chain",
          "--tested-revision",
          testedRevision,
          "--readiness-record",
          result.chainEvidencePaths.readinessRecordPath,
          "--declaration",
          result.chainEvidencePaths.declarationPath,
          "--analysis-record",
          result.chainEvidencePaths.analysisRecordPath,
          "--authorization",
          result.chainEvidencePaths.authorizationPath,
          "--reviewer-policy",
          result.chainEvidencePaths.reviewerPolicyPath,
          "--write-record",
          result.chainEvidencePaths.applicationRecordPath,
          "--patch",
          result.chainEvidencePaths.patchPath,
          "--chain-output",
          assembledPath,
        ],
        { currentDocsFabRevision: async () => testedRevision, log: () => undefined },
      );
      expect(JSON.parse(await readFile(assembledPath, "utf8"))).toEqual(result.manifest.chain);
      const evidenceKeys = [
        "readinessRecordBytes",
        "declarationBytes",
        "analysisRecordBytes",
        "authorizationBytes",
        "reviewerPolicyBytes",
        "applicationRecordBytes",
        "patchBytes",
      ] as const;
      for (const [index, key] of evidenceKeys.entries()) {
        const substitute = evidenceKeys[(index + 1) % evidenceKeys.length]!;
        expect(
          () =>
            assembleVerifiedDeliveryAcceptanceChain(
              { ...authenticEvidence, [key]: authenticEvidence[substitute] },
              editorialDecodeOptions,
            ),
          `${key} substitution`,
        ).toThrow();
        expect(
          () =>
            assembleVerifiedDeliveryAcceptanceChain(
              { ...authenticEvidence, [key]: Buffer.alloc(0) },
              editorialDecodeOptions,
            ),
          `${key} missing`,
        ).toThrow();
      }
      for (const key of evidenceKeys.filter((candidate) => candidate !== "patchBytes")) {
        const original = authenticEvidence[key];
        const parsed = JSON.parse(Buffer.from(original).toString("utf8")) as {
          schemaVersion: number;
        };
        const duplicate = Buffer.from(
          Buffer.from(original)
            .toString("utf8")
            .replace("{", `{"schemaVersion":${parsed.schemaVersion},`),
        );
        expect(
          () =>
            assembleVerifiedDeliveryAcceptanceChain(
              { ...authenticEvidence, [key]: duplicate },
              editorialDecodeOptions,
            ),
          `${key} duplicate key`,
        ).toThrow();
      }

      const shared = await readFile(result.manifestPath, "utf8");
      expect(shared).not.toContain(stateRoot);
      expect(shared).not.toContain(evidenceRoot);
      expect(shared).not.toMatch(
        /(?:glpat-|AIza|BEGIN .*PRIVATE KEY|raw|transcript|prompt|sourcePath|artifactPath)/iu,
      );
      expect(shared).not.toContain("Governed delivery evidence.");
    },
    offlineAcceptanceTimeoutMs,
  );

  it("fails closed before every live publication or cleanup without its separate exact gate", async () => {
    const previousLive = process.env.DOCSFAB_DELIVERY_ACCEPTANCE_LIVE;
    const previousCleanup = process.env.DOCSFAB_DELIVERY_ACCEPTANCE_LIVE_CLEANUP;
    delete process.env.DOCSFAB_DELIVERY_ACCEPTANCE_LIVE;
    delete process.env.DOCSFAB_DELIVERY_ACCEPTANCE_LIVE_CLEANUP;
    try {
      await expect(runDeliveryAcceptanceCli(["--live"])).rejects.toThrow(
        "DOCSFAB_DELIVERY_ACCEPTANCE_LIVE=true",
      );
      await expect(runDeliveryAcceptanceCli(["--live-cleanup"])).rejects.toThrow(
        "DOCSFAB_DELIVERY_ACCEPTANCE_LIVE_CLEANUP=true",
      );
      process.env.DOCSFAB_DELIVERY_ACCEPTANCE_LIVE = "true";
      process.env.DOCSFAB_DELIVERY_ACCEPTANCE_LIVE_CLEANUP = "true";
      await expect(runDeliveryAcceptanceCli(["--live", "--merge"])).rejects.toThrow(
        "Unknown delivery acceptance option --merge",
      );
      await expect(
        runDeliveryAcceptanceCli(["--live-cleanup", "--approve-action", "merge"]),
      ).rejects.toThrow("exact close-and-delete approval action");
    } finally {
      if (previousLive === undefined) delete process.env.DOCSFAB_DELIVERY_ACCEPTANCE_LIVE;
      else process.env.DOCSFAB_DELIVERY_ACCEPTANCE_LIVE = previousLive;
      if (previousCleanup === undefined)
        delete process.env.DOCSFAB_DELIVERY_ACCEPTANCE_LIVE_CLEANUP;
      else process.env.DOCSFAB_DELIVERY_ACCEPTANCE_LIVE_CLEANUP = previousCleanup;
    }
  });

  it("binds offline evidence to the exact checkout revision and rejects symlinked roots", async () => {
    const stateRoot = await temporary("docsfab-delivery-boundary-state-");
    const evidenceRoot = await temporary("docsfab-delivery-boundary-evidence-");
    await expect(
      runOfflineDeliveryAcceptance({
        stateRoot,
        evidenceRoot,
        testedRevision: "a".repeat(40),
      }),
    ).rejects.toThrow("exact DocsFab checkout revision");

    const parent = await temporary("docsfab-delivery-boundary-parent-");
    const alias = join(parent, "alias");
    await symlink(stateRoot, alias);
    const testedRevision = (
      await exec("git", ["rev-parse", "HEAD"], {
        cwd: process.cwd(),
        encoding: "utf8",
      })
    ).stdout.trim();
    await expect(
      runOfflineDeliveryAcceptance({
        stateRoot: alias,
        evidenceRoot,
        testedRevision,
      }),
    ).rejects.toThrow("owner-controlled real directories");
  });

  it(
    "rejects unsafe, unknown-key, cross-link-mismatched, and digest-tampered manifests",
    async () => {
      const source = "a".repeat(40);
      const commit = "b".repeat(40);
      const tree = "c".repeat(40);
      const writeRecord = "d".repeat(64);
      const planSha256 = "e".repeat(64);
      const patchSha256 = "f".repeat(64);
      const outcome = "Improve the bounded documentation gap";
      const chain = finalizeDeliveryAcceptanceChainBinding({
        schemaVersion: 1,
        kind: "docsfab-delivery-acceptance-chain-binding",
        testedRevision: source,
        sourceRevision: source,
        readiness: {
          id: "readiness-run",
          recordSha256: "7".repeat(64),
          workflow: "readiness",
          status: "succeeded",
          outcome: "Repository is ready",
          changedPaths: [],
        },
        audit: {
          id: "audit-run",
          recordSha256: "8".repeat(64),
          workflow: "review-documentation",
          status: "succeeded",
          outcome: "Documentation gap identified",
          changedPaths: [],
        },
        write: {
          id: "write-run",
          recordSha256: writeRecord,
          workflow: "update-documentation",
          status: "succeeded",
          outcome,
          changedPaths: ["docs/guide.md"],
        },
        selection: {
          gapId: "gap-1",
          evidenceSha256: "9".repeat(64),
          successCriterionSha256: "0".repeat(64),
          intendedPaths: ["docs/guide.md"],
          approvedOutcomeSha256: createHash("sha256").update(outcome).digest("hex"),
        },
        authorization: {
          sha256: "1".repeat(64),
          digest: "2".repeat(64),
          decision: "approved",
          reviewerId: "maintainer-1",
          policyDigest: "3".repeat(64),
          decidedAt: "2026-08-04T00:00:00.000Z",
          expiresAt: "2026-08-04T01:00:00.000Z",
        },
        patch: {
          sha256: patchSha256,
          byteLength: 100,
          lineCount: 5,
          changedPaths: ["docs/guide.md"],
        },
      });
      const failureMatrix = DELIVERY_ACCEPTANCE_CASE_IDS.map((id) => {
        const externalMutations =
          id.startsWith("interruption-") || id === "duplicate-invocation" ? 2 : 0;
        return {
          id,
          status: "passed" as const,
          expectedFailureCode: "expected",
          observedFailureCode: "expected",
          patchPreserved: true as const,
          nextAction: externalMutations === 0 ? "review-preserved-patch" : "none",
          sourceCheckoutUnchanged: true as const,
          worktreeState: "preserved" as const,
          receiptState: externalMutations === 0 ? ("absent" as const) : ("opened" as const),
          remoteBranchState: externalMutations === 0 ? ("absent" as const) : ("present" as const),
          mergeRequestState: externalMutations === 0 ? ("absent" as const) : ("opened" as const),
          expectedExternalMutationCount: externalMutations,
          observedExternalMutationCount: externalMutations,
        };
      });
      const result = {
        manifest: finalizeDeliveryAcceptanceManifest({
          schemaVersion: 1,
          kind: "docsfab-local-user-gitlab-delivery-acceptance",
          mode: "offline",
          status: "passed",
          testedRevision: source,
          sourceRevision: source,
          chain,
          plan: {
            sha256: planSha256,
            baseRevision: source,
            runRecordSha256: writeRecord,
            patchSha256,
          },
          publicationAuthorization: {
            decision: "authorized",
            command: "publish",
            planSha256,
          },
          validation: {
            commandSha256: "4".repeat(64),
            summarySha256: "5".repeat(64),
            status: "passed",
            checkCount: 1,
          },
          commit: {
            revision: commit,
            treeRevision: tree,
            parentRevision: source,
            parentCount: 1,
            baseRevision: source,
          },
          remote: {
            identitySha256: "6".repeat(64),
            name: "origin",
            transport: "https",
            sourceBranch: "docsfab-run/write-run",
            targetBranch: "main",
            headRevision: commit,
          },
          mergeRequest: {
            iid: 17,
            draft: true,
            state: "opened",
            sourceBranch: "docsfab-run/write-run",
            targetBranch: "main",
            headRevision: commit,
            identitySha256: "7".repeat(64),
          },
          receipt: {
            idempotencyKey: "8".repeat(64),
            sha256: "9".repeat(64),
            state: "opened",
            disposition: "succeeded",
            planSha256,
          },
          sourceCheckout: {
            status: "unchanged",
            beforeSha256: "0".repeat(64),
            afterSha256: "0".repeat(64),
            ignored: emptyIgnoredSummary(),
          },
          idempotency: { invocationCount: 2, mergeRequestCreateCount: 1, status: "reused" },
          failureMatrix,
          failureMatrixSummary: {
            expectedCaseCount: failureMatrix.length,
            observedCaseCount: failureMatrix.length,
            expectedExternalMutationCount: 8,
            observedExternalMutationCount: 8,
          },
          liveGate: { status: "not-run", cleanup: "separately-gated" },
          dogfoodDisposition: "sufficient-for-complex-local-dogfood",
        }),
      };
      const canonicalManifest = canonicalizeJsonEvidence(result.manifest as never);
      expect(parseDeliveryAcceptanceManifest(canonicalManifest)).toEqual(result.manifest);
      expect(() => parseDeliveryAcceptanceManifest(canonicalManifest.trimEnd())).toThrow();
      expect(() =>
        parseDeliveryAcceptanceManifest(
          canonicalManifest.replace("{", '{"duplicate":1,"duplicate":1,'),
        ),
      ).toThrow();
      const sparseManifest = structuredClone(result.manifest);
      sparseManifest.failureMatrix = new Array(DELIVERY_ACCEPTANCE_CASE_IDS.length);
      expect(() => assertDeliveryAcceptanceManifest(sparseManifest)).toThrow();
      const poisonedManifest = structuredClone(result.manifest);
      Object.defineProperty(poisonedManifest.validation, "status", {
        enumerable: true,
        get: () => "passed",
      });
      expect(() => assertDeliveryAcceptanceManifest(poisonedManifest)).toThrow();
      const extendedArray = structuredClone(result.manifest);
      Object.defineProperty(extendedArray.failureMatrix, "poison", {
        enumerable: false,
        value: true,
      });
      expect(() => assertDeliveryAcceptanceManifest(extendedArray)).toThrow();
      for (const value of [
        "/tmp/private-host-path",
        // DocsFab's own configured credential; it looks like no credential.
        plantConfiguredCredential(),
        "raw transcript",
        "operator prompt",
      ]) {
        const tampered = structuredClone(result.manifest);
        tampered.failureMatrix[0]!.nextAction = value;
        tampered.sha256 = deliveryAcceptanceManifestSha256(tampered);
        expect(() => assertDeliveryAcceptanceManifest(tampered)).toThrow();
      }
      clearPlantedCredential();
      // Text that only looks like a credential crosses the boundary and is
      // recorded as a finding (#1807).
      const shaped = structuredClone(result.manifest);
      shaped.failureMatrix[0]!.nextAction = "glpat-abcdefghijklmnop";
      shaped.sha256 = deliveryAcceptanceManifestSha256(shaped);
      expect(
        collectCredentialFindings(() => assertDeliveryAcceptanceManifest(shaped)).findings,
      ).toEqual([
        {
          code: "credential-like-content",
          location: "delivery-acceptance-manifest",
          rule: "credential.gitlab-token",
        },
      ]);
      const digest = structuredClone(result.manifest);
      digest.sha256 = "0".repeat(64);
      expect(() => assertDeliveryAcceptanceManifest(digest)).toThrow();
      const extended = {
        ...structuredClone(result.manifest),
        safeExtraField: "value",
      } as unknown as typeof result.manifest & { safeExtraField: string };
      extended.sha256 = deliveryAcceptanceManifestSha256(extended);
      expect(() => assertDeliveryAcceptanceManifest(extended)).toThrow();
      const nestedExtended = structuredClone(
        result.manifest,
      ) as unknown as typeof result.manifest & {
        validation: typeof result.manifest.validation & { safeExtraField: string };
      };
      nestedExtended.validation.safeExtraField = "value";
      nestedExtended.sha256 = deliveryAcceptanceManifestSha256(nestedExtended);
      expect(() => assertDeliveryAcceptanceManifest(nestedExtended)).toThrow();
      const crossLink = structuredClone(result.manifest);
      crossLink.plan.patchSha256 = "a".repeat(64);
      crossLink.sha256 = deliveryAcceptanceManifestSha256(crossLink);
      expect(() => assertDeliveryAcceptanceManifest(crossLink)).toThrow();
      const revisionCrossLink = structuredClone(result.manifest);
      revisionCrossLink.testedRevision = "f".repeat(40);
      revisionCrossLink.sha256 = deliveryAcceptanceManifestSha256(revisionCrossLink);
      expect(() => assertDeliveryAcceptanceManifest(revisionCrossLink)).toThrow();
      const matrixMismatch = structuredClone(result.manifest);
      matrixMismatch.failureMatrix[0]!.observedFailureCode = "different";
      matrixMismatch.sha256 = deliveryAcceptanceManifestSha256(matrixMismatch);
      expect(() => assertDeliveryAcceptanceManifest(matrixMismatch)).toThrow();
    },
    offlineAcceptanceTimeoutMs,
  );

  it("rejects duplicate keys, noncanonical bytes, sparse arrays, and poisoned objects", () => {
    const chain = finalizeDeliveryAcceptanceChainBinding({
      schemaVersion: 1,
      kind: "docsfab-delivery-acceptance-chain-binding",
      testedRevision: "a".repeat(40),
      sourceRevision: "a".repeat(40),
      readiness: {
        id: "ready",
        recordSha256: "1".repeat(64),
        workflow: "readiness",
        status: "succeeded",
        outcome: "ready",
        changedPaths: [],
      },
      audit: {
        id: "audit",
        recordSha256: "2".repeat(64),
        workflow: "review-documentation",
        status: "succeeded",
        outcome: "gap",
        changedPaths: [],
      },
      write: {
        id: "write",
        recordSha256: "3".repeat(64),
        workflow: "update-documentation",
        status: "succeeded",
        outcome: "fixed",
        changedPaths: ["docs/a.md"],
      },
      selection: {
        gapId: "gap",
        evidenceSha256: "4".repeat(64),
        successCriterionSha256: "5".repeat(64),
        intendedPaths: ["docs/a.md"],
        approvedOutcomeSha256: "6".repeat(64),
      },
      authorization: {
        sha256: "7".repeat(64),
        digest: "8".repeat(64),
        decision: "approved",
        reviewerId: "reviewer",
        policyDigest: "9".repeat(64),
        decidedAt: "2026-08-04T00:00:00.000Z",
        expiresAt: "2026-08-04T01:00:00.000Z",
      },
      patch: { sha256: "a".repeat(64), byteLength: 1, lineCount: 1, changedPaths: ["docs/a.md"] },
    });
    const canonical = canonicalizeJsonEvidence(chain as never);
    expect(parseDeliveryAcceptanceChainBinding(canonical)).toEqual(chain);
    expect(() => parseDeliveryAcceptanceChainBinding(canonical.trimEnd())).toThrow();
    expect(() =>
      parseDeliveryAcceptanceChainBinding(canonical.replace("{", '{"duplicate":1,"duplicate":1,')),
    ).toThrow();

    const sparse = structuredClone(chain);
    const sparsePaths = new Array<string>(1);
    sparse.write.changedPaths = sparsePaths;
    expect(() => finalizeDeliveryAcceptanceChainBinding(sparse)).toThrow();
    const poisoned = Object.create({ inherited: true }) as Record<string, unknown>;
    Object.assign(poisoned, chain);
    expect(() => finalizeDeliveryAcceptanceChainBinding(poisoned as never)).toThrow();
    Object.defineProperty(poisoned, "kind", { enumerable: true, get: () => chain.kind });
    expect(() => finalizeDeliveryAcceptanceChainBinding(poisoned as never)).toThrow();
  });

  it("fingerprints bounded ignored-file creation, deletion, bytes, mode, and pathname", async () => {
    const root = await ignoredStateRepository();

    const baseline = await observeDeliveryAcceptanceSourceCheckout(root);
    const ignoredFile = join(root, ".private-state");
    const privateValue = ["runtime", "private", "value"].join("-");
    await writeFile(ignoredFile, privateValue, { mode: 0o600 });
    const created = await observeDeliveryAcceptanceSourceCheckout(root);
    expect(created.sha256).not.toBe(baseline.sha256);
    expect(JSON.stringify(created)).not.toContain(privateValue);
    await writeFile(ignoredFile, `${privateValue}-changed`, { mode: 0o600 });
    const bytesChanged = await deliveryAcceptanceSourceCheckoutSha256(root);
    expect(bytesChanged).not.toBe(created.sha256);
    await chmod(ignoredFile, 0o640);
    const modeChanged = await observeDeliveryAcceptanceSourceCheckout(root);
    expect(modeChanged.sha256).not.toBe(bytesChanged);
    expect(modeChanged.ignored).toMatchObject({
      disposition: "policy-approved-not-observed",
      notObservedReasons: ["not-owner-private"],
    });
    const renamed = join(root, ".private-state-renamed");
    await rename(ignoredFile, renamed);
    const pathChanged = await deliveryAcceptanceSourceCheckoutSha256(root);
    expect(pathChanged).not.toBe(modeChanged.sha256);
    await unlink(renamed);
    expect(await deliveryAcceptanceSourceCheckoutSha256(root)).not.toBe(pathChanged);

    await mkdir(join(root, ".cache"));
    await writeFile(join(root, ".cache", "opaque.bin"), privateValue, { mode: 0o600 });
    const directory = await observeDeliveryAcceptanceSourceCheckout(root);
    expect(directory.ignored).toMatchObject({
      disposition: "policy-approved-not-observed",
      notObservedReasons: ["directory-content"],
    });
    expect(JSON.stringify(directory)).not.toContain(privateValue);
  });

  it("does not follow ignored symlinks or retain external-target content", async () => {
    const root = await ignoredStateRepository();
    const externalRoot = await temporary("docsfab-delivery-ignored-external-");
    const target = join(externalRoot, "target.bin");
    const privateValue = "external-runtime-private-value";
    await writeFile(target, privateValue, { mode: 0o600 });
    await symlink(target, join(root, ".private-state-link"));

    const before = await observeDeliveryAcceptanceSourceCheckout(root);
    expect(before.ignored).toMatchObject({
      disposition: "policy-approved-not-observed",
      entryCount: 1,
      observedFileCount: 0,
      notObservedEntryCount: 1,
      notObservedReasons: ["unsupported-entry"],
    });
    expect(JSON.stringify(before)).not.toContain(privateValue);
    expect(JSON.stringify(before)).not.toContain(target);

    await writeFile(target, "changed-external-secret", { mode: 0o600 });
    const after = await observeDeliveryAcceptanceSourceCheckout(root);
    expect(after).toEqual(before);
  });

  it("enforces ignored per-file, aggregate-byte, and entry-count bounds", async () => {
    const root = await ignoredStateRepository();
    const fileLimit = DELIVERY_ACCEPTANCE_IGNORED_STATE_POLICY.maximumObservedFileBytes;
    const largePath = join(root, ".private-state-large");
    const largeBytes = Buffer.alloc(fileLimit + 1, 0x78);
    Buffer.from("oversize-private-marker").copy(largeBytes);
    await writeFile(largePath, largeBytes, { mode: 0o600 });

    const oversized = await observeDeliveryAcceptanceSourceCheckout(root);
    expect(oversized.ignored).toMatchObject({
      disposition: "policy-approved-not-observed",
      entryCount: 1,
      observedFileCount: 0,
      notObservedEntryCount: 1,
      notObservedReasons: ["file-size-limit"],
    });
    expect(JSON.stringify(oversized)).not.toContain("oversize-private-marker");
    await unlink(largePath);

    const aggregateFileCount =
      DELIVERY_ACCEPTANCE_IGNORED_STATE_POLICY.maximumTotalObservedBytes / fileLimit + 1;
    const aggregatePaths = Array.from({ length: aggregateFileCount }, (_, index) =>
      join(root, `.private-state-aggregate-${index.toString().padStart(2, "0")}`),
    );
    await Promise.all(
      aggregatePaths.map((path, index) =>
        writeFile(path, Buffer.alloc(fileLimit, index), { mode: 0o600 }),
      ),
    );
    const aggregate = await observeDeliveryAcceptanceSourceCheckout(root);
    expect(aggregate.ignored).toMatchObject({
      disposition: "policy-approved-not-observed",
      entryCount: aggregateFileCount,
      observedFileCount: aggregateFileCount - 1,
      notObservedEntryCount: 1,
      notObservedReasons: ["aggregate-byte-limit"],
    });
    await Promise.all(aggregatePaths.map((path) => unlink(path)));

    const maximumEntries = DELIVERY_ACCEPTANCE_IGNORED_STATE_POLICY.maximumEntries;
    for (let offset = 0; offset <= maximumEntries; offset += 100) {
      const count = Math.min(100, maximumEntries + 1 - offset);
      await Promise.all(
        Array.from({ length: count }, (_, index) =>
          writeFile(
            join(root, `.private-state-overflow-${(offset + index).toString().padStart(4, "0")}`),
            "",
            { mode: 0o600 },
          ),
        ),
      );
    }
    await expect(observeDeliveryAcceptanceSourceCheckout(root)).rejects.toThrow(
      "ignored-state observation exceeded its bounded policy",
    );
  });
});

function emptyIgnoredSummary() {
  return {
    ...DELIVERY_ACCEPTANCE_EMPTY_IGNORED_STATE_SUMMARY,
    notObservedReasons: [],
  };
}

async function temporary(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  roots.push(path);
  return path;
}

async function ignoredStateRepository(): Promise<string> {
  const root = await temporary("docsfab-delivery-ignored-state-");
  await initFixtureRepo(
    root,
    { ".gitignore": ".private-state*\n.cache/\n", "README.md": "fixture\n" },
    { branch: "main", message: "base" },
  );
  return root;
}
