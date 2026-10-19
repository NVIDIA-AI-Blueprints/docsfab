// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFile as execFileCallback, spawn } from "node:child_process";
import {
  copyFile,
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import { parseProfileApproveArguments, parseProfileRollbackArguments } from "../src/cli.js";
import {
  canonicalizeJsonEvidence,
  parseJsonEvidence,
  type JsonEvidenceValue,
} from "../src/json-evidence.js";
import {
  PROFILE_APPROVAL_MAX_EVIDENCE_AGE_MS,
  approveModelProfile,
} from "../src/model/profile-approval.js";
import {
  ProfileApplyAmbiguousError,
  ProfileRollbackAmbiguousError,
  applyProfileConfiguration,
  loadProfileApplyReceipt,
  prepareProfileApply,
  recoverProfileTransaction,
} from "../src/model/profile-apply.js";
import { validModelEnvironment } from "./helpers.js";
import { profileApprovalFixture } from "./profile-approval-fixture.js";

const execFile = promisify(execFileCallback);
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
let cliPath: string | undefined;
const sourceCrashChildPath = resolve(repositoryRoot, "test/profile-transaction-crash-child.ts");
let crashChildPath: string | undefined;

describe("profile approval CLI", () => {
  it("requires closed preview/apply/rollback authorization shapes", () => {
    const common = [
      "--inspection",
      "inspection.json",
      "--authority-id",
      "owner",
      "--public-key",
      "public.pem",
      "--bundle",
      "bundle.json",
    ];
    expect(() =>
      parseProfileApproveArguments([
        ...common,
        "--apply",
        "--confirm-patch-sha256",
        "a".repeat(64),
        "--receipt",
        "r.json",
      ]),
    ).toThrow("confirm-bundle");
    expect(() =>
      parseProfileApproveArguments([
        ...common,
        "--apply",
        "--confirm-bundle-sha256",
        "a".repeat(64),
        "--confirm-patch-sha256",
        "b".repeat(64),
        "--receipt",
        "r.json",
        "--private-key",
        "private.pem",
      ]),
    ).toThrow("does not accept signing inputs");
    expect(() =>
      parseProfileRollbackArguments([
        "--receipt",
        "r.json",
        "--apply",
        "--confirm-rollback-sha256",
        "a".repeat(64),
      ]),
    ).toThrow("rollback-receipt");
  });

  it("persists one exact bundle and applies it without reloading a private key", async () => {
    const wallClock = new Date();
    const fixtureNow = new Date(wallClock.valueOf() - 60_000);
    const catalog = await profileApprovalFixture({}, fixtureNow);
    const root = await realpath(await mkdtemp(resolve(tmpdir(), "docsfab-profile-cli-")));
    let replacedRoot: string | undefined;
    let buildRoot: string | undefined;
    try {
      buildRoot = await mkdtemp(resolve(tmpdir(), "docsfab-profile-cli-built-"));
      ({ cliPath, crashChildPath } = await buildProfileCli(buildRoot));
      await run(root, "git", ["init", "--quiet"]);
      await writeFile(
        resolve(root, ".gitignore"),
        ".env\n.env.docsfab-new-*\n.env.docsfab-rollback-*\n.env.docsfab-apply.lock\n.env.docsfab-transaction.json\n.env.docsfab-recovery.claim\n",
      );
      const privateRoot = resolve(root, "private");
      await mkdir(privateRoot, { mode: 0o700 });
      const inspectionPath = resolve(privateRoot, "inspection.json");
      const publicKeyPath = resolve(privateRoot, "public.pem");
      const privateKeyPath = resolve(privateRoot, "private.pem");
      const bundlePath = resolve(privateRoot, "bundle.json");
      const receiptPath = resolve(privateRoot, "apply-receipt.json");
      const alternateBundlePath = resolve(privateRoot, "alternate-bundle.json");
      await writeFile(
        inspectionPath,
        canonicalizeJsonEvidence(catalog.report as unknown as JsonEvidenceValue),
        { mode: 0o600 },
      );
      await writeFile(publicKeyPath, catalog.input.authority.publicKey, { mode: 0o600 });
      await writeFile(
        privateKeyPath,
        catalog.input.privateKey.export({
          type: "pkcs8",
          format: "pem",
        }),
        { mode: 0o600 },
      );
      await writeFile(resolve(root, ".env"), modelEnvironment(catalog), { mode: 0o600 });

      const proposal = catalog.report.catalog.reconciliation!.proposal!;
      const approveWithRolloverRetry = async () => {
        for (let attempt = 0; attempt < 2; attempt += 1) {
          const approvalClock = new Date();
          const effectiveDate = approvalClock.toISOString().slice(0, 10);
          const reviewAfter = new Date(approvalClock.valueOf() + 28 * 24 * 60 * 60 * 1_000)
            .toISOString()
            .slice(0, 10);
          try {
            return await docsfab(root, [
              "profile",
              "approve",
              "--inspection",
              inspectionPath,
              "--proposal-sha256",
              proposal.sha256,
              "--effective-date",
              effectiveDate,
              "--review-after",
              reviewAfter,
              "--authority-id",
              catalog.input.authority.id,
              "--public-key",
              publicKeyPath,
              "--private-key",
              privateKeyPath,
              "--bundle",
              bundlePath,
              ...catalog.input.conflictFields.flatMap((field) => ["--resolve-conflict", field]),
            ]);
          } catch (error) {
            if (attempt > 0 || new Date().toISOString().slice(0, 10) === effectiveDate) throw error;
            await rm(bundlePath, { force: true });
          }
        }
        throw new Error("Profile approval did not complete after a UTC rollover retry.");
      };
      const preview = await approveWithRolloverRetry();
      expect(preview.stdout).toContain("Profile approval preview");
      expect(preview.stdout).toContain("Approve and apply this exact profile patch?");
      expect(preview.stdout).toContain(`Bundle path: ${bundlePath}`);
      expect(preview.stdout).toContain("--confirm-bundle-sha256");
      expect(preview.stdout).toContain("--confirm-patch-sha256");
      expect(preview.stdout).toContain("--receipt path");
      expect(preview.stdout).toContain("MODEL_MAX_INPUT_TOKENS");
      expect(preview.stdout).not.toContain(catalog.endpoint.apiKey);
      const patchSha = /Patch digest: ([a-f0-9]{64})/u.exec(preview.stdout)?.[1];
      const saved = parseJsonEvidence(await readFile(bundlePath)) as { sha256: string };
      expect(patchSha).toMatch(/^[a-f0-9]{64}$/u);
      const applyArgs = ({
        bundle = bundlePath,
        bundleSha256 = saved.sha256,
        patchSha256 = patchSha!,
        receipt = receiptPath,
      } = {}): string[] => [
        "profile",
        "approve",
        "--inspection",
        inspectionPath,
        "--authority-id",
        catalog.input.authority.id,
        "--public-key",
        publicKeyPath,
        "--bundle",
        bundle,
        "--apply",
        "--confirm-bundle-sha256",
        bundleSha256,
        "--confirm-patch-sha256",
        patchSha256,
        "--receipt",
        receipt,
      ];
      const applyRecovery = (
        overrides: Partial<Parameters<typeof recoverProfileTransaction>[0]> = {},
      ): Parameters<typeof recoverProfileTransaction>[0] => ({
        projectRoot: root,
        operation: "apply",
        purpose: "policy",
        patchSha256: patchSha!,
        approvalBundleSha256: saved.sha256,
        receiptPath,
        ...overrides,
      });

      const alternate = approveModelProfile({
        ...catalog.input,
        now: catalog.input.now,
      });
      expect(alternate.sha256).not.toBe(saved.sha256);
      await writeFile(
        alternateBundlePath,
        canonicalizeJsonEvidence(alternate as unknown as JsonEvidenceValue),
        { mode: 0o600 },
      );
      const beforeRejected = await readFile(resolve(root, ".env"));
      await expect(docsfab(root, applyArgs({ bundle: alternateBundlePath }))).rejects.toMatchObject(
        { stderr: expect.stringContaining("digest") },
      );
      expect(await readFile(resolve(root, ".env"))).toEqual(beforeRejected);

      await rm(privateKeyPath);
      const applyCrashInput = resolve(privateRoot, "apply-crash-input.json");
      const applyCrash = {
        operation: "apply",
        root,
        purpose: "policy",
        inspectionPath,
        bundlePath,
        publicKeyPath,
        authorityId: catalog.input.authority.id,
        applyReceiptPath: receiptPath,
        outputReceiptPath: receiptPath,
        now: new Date().toISOString(),
        crashPoint: "after-intent",
      };
      await writeFile(applyCrashInput, JSON.stringify(applyCrash), { mode: 0o600 });
      await expectCrash(root, applyCrashInput);
      const intentTemporary = (await readdir(root)).find((name) =>
        name.startsWith(".env.docsfab-new-"),
      );
      expect(intentTemporary).toBeDefined();
      for (const trackedTransactionPath of [
        ".env.docsfab-apply.lock",
        ".env.docsfab-transaction.json",
        intentTemporary!,
      ]) {
        await run(root, "git", ["add", "-f", "--", trackedTransactionPath]);
        await expect(recoverProfileTransaction(applyRecovery())).rejects.toThrow(
          ProfileApplyAmbiguousError,
        );
        await run(root, "git", ["rm", "--cached", "--quiet", "--", trackedTransactionPath]);
      }
      await expect(
        recoverProfileTransaction(
          applyRecovery({
            afterTemporaryCleanup() {
              throw new Error("RECOVERY-TEMP-CLEANUP-CRASH");
            },
          }),
        ),
      ).rejects.toThrow(ProfileApplyAmbiguousError);
      await expect(
        recoverProfileTransaction(
          applyRecovery({
            async afterClaimCleanup() {
              await tamperSameSize(resolve(root, ".env"));
            },
          }),
        ),
      ).rejects.toThrow(ProfileApplyAmbiguousError);
      expect(await readFile(resolve(root, ".env.docsfab-transaction.json"))).toBeDefined();
      await writeFile(resolve(root, ".env"), beforeRejected, { mode: 0o600 });
      await expect(
        recoverProfileTransaction(
          applyRecovery({
            async afterClaimCleanup() {
              await writeFile(receiptPath, "owner-created", { mode: 0o600 });
            },
          }),
        ),
      ).rejects.toThrow(ProfileApplyAmbiguousError);
      expect(await readFile(resolve(root, ".env.docsfab-transaction.json"))).toBeDefined();
      await unlink(receiptPath);
      const abandoned = await recoverProfileTransaction(applyRecovery());
      expect(abandoned.status).toBe("abandoned");
      expect(await readFile(resolve(root, ".env"))).toEqual(beforeRejected);
      await writeFile(
        applyCrashInput,
        JSON.stringify({
          ...applyCrash,
          crashPoint: "after-rename",
          now: new Date().toISOString(),
        }),
        { mode: 0o600 },
      );
      await expectCrash(root, applyCrashInput);
      const crashPostimage = await readFile(resolve(root, ".env"));
      await run(root, "git", ["add", "-f", "--", ".env"]);
      await expect(docsfab(root, applyArgs())).rejects.toMatchObject({
        stderr: expect.stringContaining("ambiguous"),
      });
      await run(root, "git", ["rm", "--cached", "--quiet", "--", ".env"]);
      await run(root, "git", ["add", "-f", "--", ".env.docsfab-transaction.json"]);
      await expect(docsfab(root, applyArgs())).rejects.toMatchObject({
        stderr: expect.stringContaining("ambiguous"),
      });
      await run(root, "git", ["rm", "--cached", "--quiet", "--", ".env.docsfab-transaction.json"]);
      for (const orphanName of [
        `.env.docsfab-new-${"f".repeat(24)}`,
        `.env.docsfab-rollback-${"e".repeat(24)}`,
      ]) {
        const orphanTemporary = resolve(root, orphanName);
        await writeFile(orphanTemporary, "orphan", { mode: 0o600 });
        await expect(docsfab(root, applyArgs())).rejects.toMatchObject({
          stderr: expect.stringContaining("ambiguous"),
        });
        await unlink(orphanTemporary);
      }
      const racedClaim = resolve(root, ".env.docsfab-recovery.claim");
      await writeFile(racedClaim, "owner-claim", { mode: 0o600 });
      await expect(docsfab(root, applyArgs())).rejects.toMatchObject({
        stderr: expect.stringContaining("ambiguous"),
      });
      expect(await readFile(resolve(root, ".env"))).toEqual(crashPostimage);
      expect(await readFile(racedClaim, "utf8")).toBe("owner-claim");
      await unlink(racedClaim);
      await expect(
        recoverProfileTransaction(
          applyRecovery({
            afterClaim() {
              throw new Error("RECOVERY-CLAIM-CRASH");
            },
          }),
        ),
      ).rejects.toThrow(ProfileApplyAmbiguousError);
      await run(root, "git", ["add", "-f", "--", ".env.docsfab-recovery.claim"]);
      await expect(recoverProfileTransaction(applyRecovery())).rejects.toThrow(
        ProfileApplyAmbiguousError,
      );
      await run(root, "git", ["rm", "--cached", "--quiet", "--", ".env.docsfab-recovery.claim"]);
      await expect(
        recoverProfileTransaction(
          applyRecovery({
            afterClaimCleanup() {
              throw new Error("RECOVERY-MARKER-CLEANUP-CRASH");
            },
          }),
        ),
      ).rejects.toThrow(ProfileApplyAmbiguousError);
      await expect(
        recoverProfileTransaction(
          applyRecovery({
            afterIntentClaim() {
              throw new Error("RECOVERY-INTENT-LINK-CRASH");
            },
          }),
        ),
      ).rejects.toThrow(ProfileApplyAmbiguousError);
      await expect(
        recoverProfileTransaction(
          applyRecovery({
            async afterClaimCleanup() {
              await tamperSameSize(resolve(root, ".env"));
            },
          }),
        ),
      ).rejects.toThrow(ProfileApplyAmbiguousError);
      expect(await readFile(resolve(root, ".env.docsfab-transaction.json"))).toBeDefined();
      await writeFile(resolve(root, ".env"), crashPostimage, { mode: 0o600 });
      const exactRecoveryReceipt = await readFile(receiptPath);
      await expect(
        recoverProfileTransaction(
          applyRecovery({
            async afterClaimCleanup() {
              await tamperSameSize(receiptPath);
            },
          }),
        ),
      ).rejects.toThrow(ProfileApplyAmbiguousError);
      expect(await readFile(resolve(root, ".env.docsfab-transaction.json"))).toBeDefined();
      await writeFile(receiptPath, exactRecoveryReceipt, { mode: 0o600 });
      const applied = await docsfab(root, applyArgs());
      expect(applied.stdout).toContain("Preview rollback:");
      expect(applied.stdout).not.toContain(catalog.endpoint.apiKey);
      expect(await readFile(receiptPath, "utf8")).not.toContain(catalog.endpoint.apiKey);
      const inspection = await docsfab(root, ["profile", "inspect"]);
      expect(inspection.stdout).toContain("current");
      expect(inspection.stdout).not.toContain(catalog.endpoint.apiKey);

      const exactReceipt = await readFile(receiptPath);
      const replayed = await docsfab(root, applyArgs());
      expect(replayed.stdout).toContain("Apply: Already applied; exact receipt replayed:");
      expect(replayed.stdout).not.toContain("replayed: current");
      expect(replayed.stdout).toContain("exact receipt replayed");
      expect(await readFile(receiptPath)).toEqual(exactReceipt);

      const installed = await readFile(resolve(root, ".env"));
      const rollbackPreview = await docsfab(root, [
        "profile",
        "rollback",
        "--receipt",
        receiptPath,
      ]);
      const rollbackSha = /Rollback digest: ([a-f0-9]{64})/u.exec(rollbackPreview.stdout)?.[1];
      expect(rollbackSha).toMatch(/^[a-f0-9]{64}$/u);
      expect(rollbackPreview.stdout).toContain("--confirm-rollback-sha256");
      expect(rollbackPreview.stdout).toContain("--receipt");
      expect(rollbackPreview.stdout).toContain("--rollback-receipt");
      await expect(
        docsfab(
          root,
          rollbackApplyArgs(
            receiptPath,
            "0".repeat(64),
            resolve(privateRoot, "bad-rollback-receipt.json"),
          ),
        ),
      ).rejects.toMatchObject({ stderr: expect.stringContaining("rejected") });
      expect(await readFile(resolve(root, ".env"))).toEqual(installed);

      await writeFile(
        resolve(root, ".env"),
        Buffer.concat([installed, Buffer.from("OWNER_EDIT=1\n")]),
        {
          mode: 0o600,
        },
      );
      const edited = await readFile(resolve(root, ".env"));
      await expect(
        docsfab(root, ["profile", "rollback", "--receipt", receiptPath]),
      ).rejects.toMatchObject({ stderr: expect.stringContaining("rejected") });
      expect(await readFile(resolve(root, ".env"))).toEqual(edited);

      await writeFile(resolve(root, ".env"), installed, { mode: 0o600 });
      const rollbackReceiptPath = resolve(privateRoot, "rollback-receipt.json");
      const rollbackCrashInput = resolve(privateRoot, "rollback-crash-input.json");
      await writeFile(
        rollbackCrashInput,
        JSON.stringify({
          ...applyCrash,
          operation: "rollback",
          outputReceiptPath: rollbackReceiptPath,
          now: new Date().toISOString(),
          crashPoint: "after-rename",
        }),
        { mode: 0o600 },
      );
      await expectCrash(root, rollbackCrashInput);
      const rolledBack = await docsfab(
        root,
        rollbackApplyArgs(receiptPath, rollbackSha!, rollbackReceiptPath),
      );
      expect(rolledBack.stdout).toContain("Rollback: Recovered completed rollback:");
      expect(rolledBack.stdout).not.toContain(catalog.endpoint.apiKey);
      expect(await readFile(rollbackReceiptPath, "utf8")).not.toContain(catalog.endpoint.apiKey);
      const exactRollbackReceipt = await readFile(rollbackReceiptPath);
      const rollbackReplay = await docsfab(
        root,
        rollbackApplyArgs(receiptPath, rollbackSha!, rollbackReceiptPath),
      );
      expect(rollbackReplay.stdout).toContain("exact receipt replayed");
      expect(await readFile(rollbackReceiptPath)).toEqual(exactRollbackReceipt);

      const postReceiptPath = resolve(privateRoot, "apply-after-receipt.json");
      await writeFile(
        applyCrashInput,
        JSON.stringify({
          ...applyCrash,
          outputReceiptPath: postReceiptPath,
          crashPoint: "after-receipt-link",
          now: new Date().toISOString(),
        }),
        { mode: 0o600 },
      );
      await expectCrash(root, applyCrashInput);
      const recoveredAfterReceipt = await docsfab(root, applyArgs({ receipt: postReceiptPath }));
      expect(recoveredAfterReceipt.stdout).toContain("Recovered completed profile apply:");
      expect(await readFile(postReceiptPath, "utf8")).not.toContain(catalog.endpoint.apiKey);
      await expect(readFile(resolve(root, ".env.docsfab-transaction.json"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      await expect(readFile(resolve(root, ".env.docsfab-apply.lock"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      await expect(readFile(resolve(root, ".env.docsfab-recovery.claim"))).rejects.toMatchObject({
        code: "ENOENT",
      });

      const linkedRollbackPreview = await docsfab(root, [
        "profile",
        "rollback",
        "--receipt",
        postReceiptPath,
      ]);
      const linkedRollbackSha = /Rollback digest: ([a-f0-9]{64})/u.exec(
        linkedRollbackPreview.stdout,
      )?.[1];
      const linkedRollbackReceiptPath = resolve(privateRoot, "rollback-after-receipt-link.json");
      await writeFile(
        rollbackCrashInput,
        JSON.stringify({
          ...applyCrash,
          operation: "rollback",
          applyReceiptPath: postReceiptPath,
          outputReceiptPath: linkedRollbackReceiptPath,
          now: new Date().toISOString(),
          crashPoint: "after-receipt-link",
        }),
        { mode: 0o600 },
      );
      await expectCrash(root, rollbackCrashInput);
      const linkedApplyReceipt = await loadProfileApplyReceipt(postReceiptPath);
      const exactRollbackPostimage = await readFile(resolve(root, ".env"));
      await expect(
        recoverProfileTransaction({
          projectRoot: root,
          operation: "rollback",
          purpose: "policy",
          previewSha256: linkedRollbackSha!,
          patchSha256: linkedApplyReceipt.patchSha256,
          applyReceiptSha256: linkedApplyReceipt.sha256,
          receiptPath: linkedRollbackReceiptPath,
          async afterClaimCleanup() {
            await tamperSameSize(resolve(root, ".env"));
          },
        }),
      ).rejects.toThrow(ProfileRollbackAmbiguousError);
      expect(await readFile(resolve(root, ".env.docsfab-transaction.json"))).toBeDefined();
      await writeFile(resolve(root, ".env"), exactRollbackPostimage, { mode: 0o600 });
      const exactRecoveryRollbackReceipt = await readFile(linkedRollbackReceiptPath);
      await expect(
        recoverProfileTransaction({
          projectRoot: root,
          operation: "rollback",
          purpose: "policy",
          previewSha256: linkedRollbackSha!,
          patchSha256: linkedApplyReceipt.patchSha256,
          applyReceiptSha256: linkedApplyReceipt.sha256,
          receiptPath: linkedRollbackReceiptPath,
          async afterClaimCleanup() {
            await tamperSameSize(linkedRollbackReceiptPath);
          },
        }),
      ).rejects.toThrow(ProfileRollbackAmbiguousError);
      expect(await readFile(resolve(root, ".env.docsfab-transaction.json"))).toBeDefined();
      await writeFile(linkedRollbackReceiptPath, exactRecoveryRollbackReceipt, { mode: 0o600 });
      const recoveredRollbackLink = await docsfab(
        root,
        rollbackApplyArgs(postReceiptPath, linkedRollbackSha!, linkedRollbackReceiptPath),
      );
      expect(recoveredRollbackLink.stdout).toContain("Rollback: Recovered completed rollback:");
      expect(await readFile(linkedRollbackReceiptPath, "utf8")).not.toContain(
        catalog.endpoint.apiKey,
      );

      const expiredBundle = approveModelProfile({
        ...catalog.input,
        effectiveDate: catalog.input.effectiveDate,
        reviewAfter: catalog.input.effectiveDate,
        now: catalog.input.now,
      });
      const expiredBundlePath = resolve(privateRoot, "expired-recovery-bundle.json");
      const expiredReceiptPath = resolve(privateRoot, "expired-recovery-receipt.json");
      await writeFile(
        expiredBundlePath,
        canonicalizeJsonEvidence(expiredBundle as unknown as JsonEvidenceValue),
        { mode: 0o600 },
      );
      const expiredApproval = () => ({
        inspection: catalog.report,
        approvalBundle: expiredBundle,
        authority: catalog.input.authority,
        ambientEnvironment: {},
      });
      const expiredPrepared = await prepareProfileApply({
        projectRoot: root,
        purpose: "policy",
        ...expiredApproval(),
        now: catalog.input.now,
      });
      const expiredAt = new Date(
        Date.parse(`${expiredBundle.approval.reviewAfter}T23:59:59.999Z`) + 1,
      );
      expect(expiredAt.valueOf() - Date.parse(catalog.report.generatedAt)).toBeLessThanOrEqual(
        PROFILE_APPROVAL_MAX_EVIDENCE_AGE_MS,
      );
      // A passed review date is advisory, so the bundle still
      // prepares the same preview once that date has passed.
      const beforeOverduePrepare = await readFile(resolve(root, ".env"));
      await expect(
        prepareProfileApply({
          projectRoot: root,
          purpose: "policy",
          ...expiredApproval(),
          now: expiredAt,
        }),
      ).resolves.toMatchObject({ preview: expiredPrepared.preview });
      expect(await readFile(resolve(root, ".env"))).toEqual(beforeOverduePrepare);
      await writeFile(
        applyCrashInput,
        JSON.stringify({
          ...applyCrash,
          bundlePath: expiredBundlePath,
          outputReceiptPath: expiredReceiptPath,
          now: catalog.input.now.toISOString(),
          crashPoint: "after-rename",
        }),
        { mode: 0o600 },
      );
      await expectCrash(root, applyCrashInput);
      const recoveredExpired = await applyProfileConfiguration({
        prepared: expiredPrepared,
        confirmPatchSha256: expiredPrepared.preview.patch.sha256,
        ...expiredApproval(),
        now: expiredAt,
        receiptPath: expiredReceiptPath,
      });
      expect(recoveredExpired.approvalBundleSha256).toBe(expiredBundle.sha256);
      const replayedExpired = await docsfab(
        root,
        applyArgs({
          bundle: expiredBundlePath,
          bundleSha256: expiredBundle.sha256,
          patchSha256: expiredPrepared.preview.patch.sha256,
          receipt: expiredReceiptPath,
        }),
      );
      expect(replayedExpired.stdout).toContain("exact receipt replayed");

      const expiredRollbackPreview = await docsfab(root, [
        "profile",
        "rollback",
        "--receipt",
        expiredReceiptPath,
      ]);
      const expiredRollbackSha = /Rollback digest: ([a-f0-9]{64})/u.exec(
        expiredRollbackPreview.stdout,
      )?.[1];
      await docsfab(
        root,
        rollbackApplyArgs(
          expiredReceiptPath,
          expiredRollbackSha!,
          resolve(privateRoot, "expired-rollback-receipt.json"),
        ),
      );
      const beforeOverdueNewPrepare = await readFile(resolve(root, ".env"));
      await expect(
        prepareProfileApply({
          projectRoot: root,
          purpose: "policy",
          ...expiredApproval(),
          now: expiredAt,
        }),
      ).resolves.toMatchObject({ preview: { approvalBundleSha256: expiredBundle.sha256 } });
      expect(await readFile(resolve(root, ".env"))).toEqual(beforeOverdueNewPrepare);

      const rootSwapReceipt = resolve(root, "root-swap-receipt.json");
      await writeFile(
        applyCrashInput,
        JSON.stringify({
          ...applyCrash,
          outputReceiptPath: rootSwapReceipt,
          now: new Date().toISOString(),
          crashPoint: "after-rename",
        }),
        { mode: 0o600 },
      );
      await expectCrash(root, applyCrashInput);
      replacedRoot = `${root}-replaced`;
      await expect(
        recoverProfileTransaction(
          applyRecovery({
            receiptPath: rootSwapReceipt,
            async afterClaim() {
              await rename(root, replacedRoot!);
              await mkdir(root, { mode: 0o700 });
              for (const name of await readdir(replacedRoot!)) {
                if (
                  name === ".env" ||
                  name.startsWith(".env.docsfab-") ||
                  name.startsWith(".docsfab-profile-receipt-")
                ) {
                  await rename(resolve(replacedRoot!, name), resolve(root, name));
                }
              }
            },
          }),
        ),
      ).rejects.toThrow(ProfileApplyAmbiguousError);
      await expect(readFile(rootSwapReceipt)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      cliPath = undefined;
      crashChildPath = undefined;
      try {
        await rm(root, { recursive: true, force: true });
        if (replacedRoot) await rm(replacedRoot, { recursive: true, force: true });
      } finally {
        if (buildRoot) await rm(buildRoot, { recursive: true, force: true });
      }
    }
  }, 180_000);
});

function modelEnvironment(catalog: Awaited<ReturnType<typeof profileApprovalFixture>>): string {
  return [
    ...Object.entries({
      ...validModelEnvironment,
      MODEL_PROVIDER: catalog.endpoint.providerId,
      MODEL_BASE_URL: catalog.endpoint.baseUrl,
      MODEL_ID: catalog.endpoint.modelId,
      MODEL_API_KEY: catalog.endpoint.apiKey,
      MODEL_CONTEXT_WINDOW: "8192",
      MODEL_MAX_OUTPUT_TOKENS: "4096",
      MODEL_PROFILE_APPROVED_SOURCE: "unknown",
      MODEL_PROFILE_EFFECTIVE_DATE: "unknown",
      MODEL_PROFILE_REVIEW_AFTER: "unknown",
    }).map(([key, value]) => `${key}=${value}`),
    "UNRELATED=preserved",
    "",
  ].join("\n");
}

async function tamperSameSize(path: string): Promise<void> {
  const bytes = await readFile(path);
  bytes[0] = bytes[0]! ^ 1;
  await writeFile(path, bytes);
}

function rollbackApplyArgs(
  receiptPath: string,
  confirmRollbackSha256: string,
  rollbackReceiptPath: string,
): string[] {
  return [
    "profile",
    "rollback",
    "--receipt",
    receiptPath,
    "--apply",
    "--confirm-rollback-sha256",
    confirmRollbackSha256,
    "--rollback-receipt",
    rollbackReceiptPath,
  ];
}

function docsfab(cwd: string, args: string[]) {
  if (cliPath === undefined) throw new Error("Owned built profile CLI is unavailable.");
  return run(cwd, process.execPath, [cliPath, ...args]);
}

/** Build public code once inside the existing case budget, away from its Git fixture. */
async function buildProfileCli(
  buildRoot: string,
): Promise<{ cliPath: string; crashChildPath: string }> {
  const packageRoot = resolve(buildRoot, "package");
  const home = resolve(buildRoot, "home");
  const configurationRoot = resolve(buildRoot, "config");
  await mkdir(resolve(packageRoot, "bin"), { recursive: true, mode: 0o700 });
  await mkdir(home, { mode: 0o700 });
  await mkdir(configurationRoot, { mode: 0o700 });
  // The normal owning checkout's ensureDerived lifecycle is retained. The
  // output option isolates dist/licenses, not canonical generation or its lock.
  await new Promise<void>((resolveBuild, rejectBuild) => {
    const child = spawn(
      process.execPath,
      [
        resolve(repositoryRoot, "scripts/build-package.mjs"),
        "--output-dir",
        resolve(packageRoot, "dist"),
      ],
      {
        cwd: repositoryRoot,
        env: {
          PATH: process.env.PATH,
          LC_ALL: "C",
          HOME: home,
          TMPDIR: tmpdir(),
          CI: process.env.CI,
          PI_OFFLINE: "1",
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: "/dev/null",
          DOCSFAB_CONFIG_ROOT: configurationRoot,
          DOCSFAB_SERVICE_ENV_FILE: resolve(home, "absent-service.env"),
        },
        stdio: "inherit",
      },
    );
    child.once("error", rejectBuild);
    child.once("close", (code, signal) => {
      if (code === 0 && signal === null) resolveBuild();
      else rejectBuild(new Error("Owned profile CLI build did not complete successfully."));
    });
  });
  for (const filename of ["docsfab.mjs", "source-checkout-refresh.mjs"]) {
    await copyFile(resolve(repositoryRoot, "bin", filename), resolve(packageRoot, "bin", filename));
  }
  await copyFile(resolve(repositoryRoot, "package.json"), resolve(packageRoot, "package.json"));
  await cp(resolve(repositoryRoot, "workflows"), resolve(packageRoot, "workflows"), {
    recursive: true,
  });
  const compositionRoot = resolve(packageRoot, "model-compositions");
  await mkdir(compositionRoot);
  for (const filename of [
    "adapter-registry.json",
    "candidate-projections.json",
    "composition-registry.json",
    "installed-manifest.json",
    "workflow-catalog.json",
  ]) {
    await copyFile(
      resolve(repositoryRoot, "model-compositions", filename),
      resolve(compositionRoot, filename),
    );
  }
  await symlink(
    resolve(repositoryRoot, "node_modules"),
    resolve(packageRoot, "node_modules"),
    "dir",
  );
  const helperSource = await readFile(sourceCrashChildPath, "utf8");
  const sourceImport = '"../src/model/profile-apply.js"';
  const builtImport = '"../dist/model/profile-apply.js"';
  const sourceImportPosition = helperSource.indexOf(sourceImport);
  if (
    sourceImportPosition < 0 ||
    sourceImportPosition !== helperSource.lastIndexOf(sourceImport) ||
    helperSource.includes(builtImport)
  ) {
    throw new Error("Canonical profile crash helper import is not uniquely bound.");
  }
  const ownedHelperSource = helperSource.replace(sourceImport, builtImport);
  if (ownedHelperSource.replace(builtImport, sourceImport) !== helperSource) {
    throw new Error("Owned profile crash helper does not preserve the canonical body.");
  }
  const ownedCrashChildPath = resolve(packageRoot, "test/profile-transaction-crash-child.ts");
  await mkdir(dirname(ownedCrashChildPath), { mode: 0o700 });
  await writeFile(ownedCrashChildPath, ownedHelperSource, { flag: "wx", mode: 0o600 });
  if ((await readFile(ownedCrashChildPath, "utf8")) !== ownedHelperSource) {
    throw new Error("Owned profile crash helper readback differs.");
  }
  console.info(`Profile fixture Node runtime: ${process.version}`);
  return { cliPath: resolve(packageRoot, "bin/docsfab.mjs"), crashChildPath: ownedCrashChildPath };
}

async function expectCrash(cwd: string, inputPath: string): Promise<void> {
  if (crashChildPath === undefined) throw new Error("Owned profile crash helper is unavailable.");
  try {
    await run(cwd, process.execPath, [crashChildPath, inputPath]);
    throw new Error("Expected crash child to be killed.");
  } catch (error) {
    expect(error).toMatchObject({ signal: "SIGKILL" });
  }
}

function run(cwd: string, command: string, args: string[]) {
  return execFile(command, args, {
    cwd,
    env: {
      PATH: process.env.PATH,
      LC_ALL: "C",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      DOCSFAB_CONFIG_ROOT: cwd,
      DOCSFAB_SKILL_CRATE_DIR: resolve(repositoryRoot, "skill-crate"),
    },
    maxBuffer: 4 * 1024 * 1024,
  });
}
