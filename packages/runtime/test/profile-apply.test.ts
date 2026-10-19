// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash, randomUUID } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import {
  chmod,
  link,
  lstat,
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
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import { approveModelProfile } from "../src/model/profile-approval.js";
import {
  applyProfileRollback,
  applyProfileConfiguration,
  assertSafeProfileReceiptTarget,
  decodeProfileApplyReceipt,
  loadProfileApplyReceipt,
  prepareProfileApply,
  prepareProfileRollback,
  ProfileApplyAmbiguousError,
  ProfileApplyError,
  ProfileRollbackAmbiguousError,
  readOwnerHostFile,
  recoverProfileTransaction,
  verifyProfileApplyReceiptPostimage,
  verifyProfileRollbackReceiptPostimage,
} from "../src/model/profile-apply.js";
import { canonicalizeJsonEvidence, type JsonEvidenceValue } from "../src/json-evidence.js";
import { validModelEnvironment } from "./helpers.js";
import { PROFILE_APPROVAL_NOW as NOW, profileApprovalFixture } from "./profile-approval-fixture.js";
import { git, initFixtureRepo } from "./helpers/git.js";

const execFile = promisify(execFileCallback);
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const crashChildPath = resolve(repositoryRoot, "test/profile-transaction-crash-child.ts");
const tsxLoader = createRequire(import.meta.url).resolve("tsx");
/** Profile apply / rollback uses real git and child processes under load. */
const HEAVY_SUITE_TIMEOUT_MS = 180_000;

describe("atomic profile configuration apply", { timeout: HEAVY_SUITE_TIMEOUT_MS }, () => {
  it("previews without mutation, applies exact confirmation, and repeats without rewrite", async () => {
    const fixture = await applyFixture();
    try {
      const before = await readFile(fixture.envPath, "utf8");
      const prepared = await prepare(fixture);
      expect(await readFile(fixture.envPath, "utf8")).toBe(before);
      expect(JSON.stringify(prepared.preview)).not.toContain(fixture.secret);
      expect(prepared.preview).toMatchObject({
        tracked: false,
        inspectionSha256: fixture.catalog.report.sha256,
        approvalBundleSha256: fixture.bundle.sha256,
        authorizationSha256: fixture.bundle.authorization.sha256,
      });

      const receipt = await applyProfileConfiguration({
        prepared,
        confirmPatchSha256: prepared.preview.patch.sha256,
        inspection: fixture.catalog.report,
        approvalBundle: fixture.bundle,
        authority: fixture.catalog.input.authority,
        ambientEnvironment: {},
        now: NOW,
        receiptPath: resolve(fixture.root, "apply-receipt.json"),
      });
      expect(receipt.applied).toBe(true);
      const after = await readFile(fixture.envPath, "utf8");
      expect(after).toContain(`MODEL_API_KEY=${fixture.secret}`);
      expect(after).toContain("UNRELATED=preserved");
      expect(after).toContain("MODEL_MAX_INPUT_TOKENS=96000");
      expect(after).toContain("MODEL_INPUT_COST_PER_MILLION=unknown");
      expect(Number((await lstat(fixture.envPath)).mode & 0o777)).toBe(0o600);
      expect(JSON.stringify(receipt)).not.toContain(fixture.secret);

      const repeat = await prepare(fixture);
      const identity = await lstat(fixture.envPath);
      expect(repeat.preview.patch.changedKeys).toEqual([]);
      const repeatReceipt = await applyProfileConfiguration({
        prepared: repeat,
        confirmPatchSha256: repeat.preview.patch.sha256,
        inspection: fixture.catalog.report,
        approvalBundle: fixture.bundle,
        authority: fixture.catalog.input.authority,
        ambientEnvironment: {},
        now: NOW,
        receiptPath: resolve(fixture.root, "repeat-receipt.json"),
      });
      expect(repeatReceipt.applied).toBe(false);
      expect((await lstat(fixture.envPath)).ino).toBe(identity.ino);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("rejects bad confirmation and CAS drift without overwriting current bytes", async () => {
    const fixture = await applyFixture();
    try {
      const prepared = await prepare(fixture);
      const original = await readFile(fixture.envPath, "utf8");
      await expect(
        applyProfileConfiguration({
          prepared,
          confirmPatchSha256: "0".repeat(64),
          inspection: fixture.catalog.report,
          approvalBundle: fixture.bundle,
          authority: fixture.catalog.input.authority,
          ambientEnvironment: {},
          now: NOW,
          receiptPath: resolve(fixture.root, "bad-receipt.json"),
        }),
      ).rejects.toThrow(ProfileApplyError);
      expect(await readFile(fixture.envPath, "utf8")).toBe(original);

      await writeFile(fixture.envPath, `${original}CONCURRENT=owner-change\n`, { mode: 0o600 });
      await expect(
        applyProfileConfiguration({
          prepared,
          confirmPatchSha256: prepared.preview.patch.sha256,
          inspection: fixture.catalog.report,
          approvalBundle: fixture.bundle,
          authority: fixture.catalog.input.authority,
          ambientEnvironment: {},
          now: NOW,
          receiptPath: resolve(fixture.root, "drift-receipt.json"),
        }),
      ).rejects.toThrow(ProfileApplyError);
      expect(await readFile(fixture.envPath, "utf8")).toContain("CONCURRENT=owner-change");
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("rejects tracked, symlinked, hard-linked, permissive, ambient-overridden, and pre-creation inputs", async () => {
    for (const scenario of [
      "tracked",
      "symlink",
      "hardlink",
      "mode",
      "ambient",
      "before-created",
    ] as const) {
      const fixture = await applyFixture();
      try {
        let ambient: NodeJS.ProcessEnv = {};
        let now = NOW;
        if (scenario === "tracked") await git(fixture.root, ["add", "-f", ".env"]);
        if (scenario === "symlink") {
          await writeFile(`${fixture.envPath}.real`, await readFile(fixture.envPath), {
            mode: 0o600,
          });
          await rm(fixture.envPath);
          await symlink(`${fixture.envPath}.real`, fixture.envPath);
        }
        if (scenario === "hardlink") await link(fixture.envPath, `${fixture.envPath}.link`);
        if (scenario === "mode")
          await writeFile(fixture.envPath, await readFile(fixture.envPath), { mode: 0o644 });
        if (scenario === "mode")
          await import("node:fs/promises").then(({ chmod }) => chmod(fixture.envPath, 0o644));
        if (scenario === "ambient") ambient = { MODEL_CONTEXT_WINDOW: "999999" };
        // Adjacent condition: a clock before the bundle was created still refuses.
        if (scenario === "before-created") now = new Date("2026-08-04T00:00:00.000Z");
        await expect(
          prepareProfileApply({
            projectRoot: fixture.root,
            purpose: "policy",
            inspection: fixture.catalog.report,
            approvalBundle: fixture.bundle,
            authority: fixture.catalog.input.authority,
            ambientEnvironment: ambient,
            now,
          }),
        ).rejects.toThrow(ProfileApplyError);
      } finally {
        await rm(fixture.root, { recursive: true, force: true });
      }
    }
  });

  it("prepares a bundle whose review date has passed", async () => {
    const fixture = await applyFixture();
    try {
      const now = new Date("2026-09-02T00:00:00.000Z");
      expect(fixture.bundle.approval.reviewAfter < now.toISOString().slice(0, 10)).toBe(true);
      const prepared = await prepareProfileApply({
        projectRoot: fixture.root,
        purpose: "policy",
        inspection: fixture.catalog.report,
        approvalBundle: fixture.bundle,
        authority: fixture.catalog.input.authority,
        ambientEnvironment: {},
        now,
      });
      expect(prepared.preview).toMatchObject({ approvalBundleSha256: fixture.bundle.sha256 });
      expect(prepared.preview).toEqual((await prepare(fixture)).preview);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("rejects case-folded tracked aliases and malicious prepared accessors generically", async () => {
    const fixture = await applyFixture();
    try {
      const object = await git(fixture.root, ["hash-object", "-w", ".env"]);
      await git(fixture.root, ["update-index", "--add", "--cacheinfo", `100644,${object},.ENV`]);
      await expect(prepare(fixture)).rejects.toThrow(ProfileApplyError);
      await git(fixture.root, ["update-index", "--force-remove", ".ENV"]);

      const canary = "PRIVATE-PROJECT-ROOT-CANARY";
      const malicious = Object.create(null) as Record<string, unknown>;
      Object.defineProperty(malicious, "projectRoot", {
        enumerable: true,
        get() {
          throw new Error(canary);
        },
      });
      await expect(
        applyProfileConfiguration({
          prepared: malicious as never,
          confirmPatchSha256: "0".repeat(64),
          inspection: fixture.catalog.report,
          approvalBundle: fixture.bundle,
          authority: fixture.catalog.input.authority,
          ambientEnvironment: {},
          now: NOW,
          receiptPath: resolve(fixture.root, "malicious-receipt.json"),
        }),
      ).rejects.toMatchObject({ message: "Profile configuration apply was rejected." });
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("persists a strict receipt and rolls back only the exact installed postimage", async () => {
    const fixture = await applyFixture();
    try {
      const original = await readFile(fixture.envPath, "utf8");
      const prepared = await prepare(fixture);
      const applyReceiptPath = resolve(fixture.root, "apply-receipt.json");
      const receipt = await applyProfileConfiguration({
        prepared,
        confirmPatchSha256: prepared.preview.patch.sha256,
        inspection: fixture.catalog.report,
        approvalBundle: fixture.bundle,
        authority: fixture.catalog.input.authority,
        ambientEnvironment: {},
        now: NOW,
        receiptPath: applyReceiptPath,
      });
      expect(Object.isFrozen(receipt.preview.patch.reverse.operations)).toBe(true);
      expect(await loadProfileApplyReceipt(applyReceiptPath)).toEqual(receipt);
      expect(await readFile(applyReceiptPath, "utf8")).not.toContain(fixture.secret);

      const extended = structuredClone(receipt);
      Object.assign(extended.preview, { extension: "forged" });
      Object.assign(extended.preview, { sha256: evidenceDigest({ ...extended.preview }) });
      Object.assign(extended, { sha256: evidenceDigest({ ...extended }) });
      expect(() => decodeProfileApplyReceipt(extended)).toThrow(ProfileApplyError);

      const rollback = await prepareProfileRollback({ projectRoot: fixture.root, receipt });
      const rollbackReceipt = await applyProfileRollback({
        prepared: rollback,
        receipt,
        confirmRollbackSha256: rollback.preview.sha256,
        receiptPath: resolve(fixture.root, "rollback-receipt.json"),
        now: NOW,
      });
      expect(rollbackReceipt.toSha256).toBe(receipt.beforeSha256);
      expect(await readFile(fixture.envPath, "utf8")).toBe(original);

      const nextPrepared = await prepare(fixture);
      const nextReceipt = await applyProfileConfiguration({
        prepared: nextPrepared,
        confirmPatchSha256: nextPrepared.preview.patch.sha256,
        inspection: fixture.catalog.report,
        approvalBundle: fixture.bundle,
        authority: fixture.catalog.input.authority,
        ambientEnvironment: {},
        now: NOW,
        receiptPath: resolve(fixture.root, "next-apply-receipt.json"),
      });
      const laterRollback = await prepareProfileRollback({
        projectRoot: fixture.root,
        receipt: nextReceipt,
      });
      await writeFile(fixture.envPath, `${await readFile(fixture.envPath, "utf8")}OWNER_EDIT=1\n`, {
        mode: 0o600,
      });
      const edited = await readFile(fixture.envPath, "utf8");
      await expect(
        applyProfileRollback({
          prepared: laterRollback,
          receipt: nextReceipt,
          confirmRollbackSha256: laterRollback.preview.sha256,
          receiptPath: resolve(fixture.root, "refused-rollback-receipt.json"),
          now: NOW,
        }),
      ).rejects.toThrow(ProfileApplyError);
      expect(await readFile(fixture.envPath, "utf8")).toBe(edited);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  }, 15_000);

  it("fails closed at deterministic temporary and post-rename race boundaries", async () => {
    const temporaryFixture = await applyFixture();
    try {
      const original = await readFile(temporaryFixture.envPath);
      const prepared = await prepare(temporaryFixture);
      await expect(
        applyProfileConfiguration({
          prepared,
          confirmPatchSha256: prepared.preview.patch.sha256,
          inspection: temporaryFixture.catalog.report,
          approvalBundle: temporaryFixture.bundle,
          authority: temporaryFixture.catalog.input.authority,
          ambientEnvironment: {},
          now: NOW,
          receiptPath: resolve(temporaryFixture.root, "temp-race-receipt.json"),
          hooks: {
            async afterTemporarySync({ temporary }) {
              await writeFile(temporary, Buffer.alloc(prepared.bytes.length, 0x78), {
                mode: 0o600,
              });
            },
          },
        }),
      ).rejects.toThrow(ProfileApplyError);
      expect(await readFile(temporaryFixture.envPath)).toEqual(original);
    } finally {
      await rm(temporaryFixture.root, { recursive: true, force: true });
    }

    const applyRecoveryFixture = await applyFixture();
    try {
      const original = await readFile(applyRecoveryFixture.envPath);
      const prepared = await prepare(applyRecoveryFixture);
      await expect(
        applyProfileConfiguration({
          prepared,
          confirmPatchSha256: prepared.preview.patch.sha256,
          inspection: applyRecoveryFixture.catalog.report,
          approvalBundle: applyRecoveryFixture.bundle,
          authority: applyRecoveryFixture.catalog.input.authority,
          ambientEnvironment: {},
          now: NOW,
          receiptPath: resolve(applyRecoveryFixture.root, "post-rename-receipt.json"),
          hooks: {
            afterRename() {
              throw new Error("POST-RENAME-CANARY");
            },
          },
        }),
      ).rejects.toMatchObject({ message: "Profile configuration apply was rejected." });
      expect(await readFile(applyRecoveryFixture.envPath)).toEqual(original);
    } finally {
      await rm(applyRecoveryFixture.root, { recursive: true, force: true });
    }

    const rollbackRecoveryFixture = await applyFixture();
    try {
      const prepared = await prepare(rollbackRecoveryFixture);
      const applyReceipt = await applyProfileConfiguration({
        prepared,
        confirmPatchSha256: prepared.preview.patch.sha256,
        inspection: rollbackRecoveryFixture.catalog.report,
        approvalBundle: rollbackRecoveryFixture.bundle,
        authority: rollbackRecoveryFixture.catalog.input.authority,
        ambientEnvironment: {},
        now: NOW,
        receiptPath: resolve(rollbackRecoveryFixture.root, "race-apply-receipt.json"),
      });
      const installed = await readFile(rollbackRecoveryFixture.envPath);
      const rollback = await prepareProfileRollback({
        projectRoot: rollbackRecoveryFixture.root,
        receipt: applyReceipt,
      });
      await expect(
        applyProfileRollback({
          prepared: rollback,
          receipt: applyReceipt,
          confirmRollbackSha256: rollback.preview.sha256,
          receiptPath: resolve(rollbackRecoveryFixture.root, "race-rollback-receipt.json"),
          now: NOW,
          hooks: {
            afterRename() {
              throw new Error("ROLLBACK-POST-RENAME-CANARY");
            },
          },
        }),
      ).rejects.toMatchObject({ message: "Profile configuration apply was rejected." });
      expect(await readFile(rollbackRecoveryFixture.envPath)).toEqual(installed);
    } finally {
      await rm(rollbackRecoveryFixture.root, { recursive: true, force: true });
    }
  }, 15_000);

  it("reports ambiguous receipt publication races and preserves replacements", async () => {
    const preLinkFixture = await applyFixture();
    try {
      const prepared = await prepare(preLinkFixture);
      const receiptPath = resolve(preLinkFixture.root, "pre-link-owner-receipt.json");
      await expect(
        applyProfileConfiguration({
          prepared,
          confirmPatchSha256: prepared.preview.patch.sha256,
          inspection: preLinkFixture.catalog.report,
          approvalBundle: preLinkFixture.bundle,
          authority: preLinkFixture.catalog.input.authority,
          ambientEnvironment: {},
          now: NOW,
          receiptPath,
          hooks: {
            async afterRename() {
              await writeFile(receiptPath, "owner-pre-link", { mode: 0o600 });
            },
          },
        }),
      ).rejects.toThrow(ProfileApplyAmbiguousError);
      expect(await readFile(receiptPath, "utf8")).toBe("owner-pre-link");
      expect(await readFile(preLinkFixture.envPath)).toEqual(Buffer.from(prepared.bytes));
    } finally {
      await rm(preLinkFixture.root, { recursive: true, force: true });
    }

    const applyFixtureValue = await applyFixture();
    try {
      const original = await readFile(applyFixtureValue.envPath);
      const prepared = await prepare(applyFixtureValue);
      const receiptPath = resolve(applyFixtureValue.root, "raced-apply-receipt.json");
      await expect(
        applyProfileConfiguration({
          prepared,
          confirmPatchSha256: prepared.preview.patch.sha256,
          inspection: applyFixtureValue.catalog.report,
          approvalBundle: applyFixtureValue.bundle,
          authority: applyFixtureValue.catalog.input.authority,
          ambientEnvironment: {},
          now: NOW,
          receiptPath,
          hooks: {
            async afterReceiptLink({ target }) {
              await unlink(target);
              await writeFile(target, "owner-replacement", { mode: 0o600 });
            },
          },
        }),
      ).rejects.toThrow(ProfileApplyAmbiguousError);
      expect(await readFile(applyFixtureValue.envPath)).not.toEqual(original);
      expect(await readFile(applyFixtureValue.envPath)).toEqual(Buffer.from(prepared.bytes));
      expect(await readFile(receiptPath, "utf8")).toBe("owner-replacement");
    } finally {
      await rm(applyFixtureValue.root, { recursive: true, force: true });
    }

    const rollbackFixtureValue = await applyFixture();
    try {
      const prepared = await prepare(rollbackFixtureValue);
      const applyReceipt = await applyProfileConfiguration({
        prepared,
        confirmPatchSha256: prepared.preview.patch.sha256,
        inspection: rollbackFixtureValue.catalog.report,
        approvalBundle: rollbackFixtureValue.bundle,
        authority: rollbackFixtureValue.catalog.input.authority,
        ambientEnvironment: {},
        now: NOW,
        receiptPath: resolve(rollbackFixtureValue.root, "published-apply-receipt.json"),
      });
      const installed = await readFile(rollbackFixtureValue.envPath);
      const rollback = await prepareProfileRollback({
        projectRoot: rollbackFixtureValue.root,
        receipt: applyReceipt,
      });
      const rollbackReceiptPath = resolve(rollbackFixtureValue.root, "raced-rollback-receipt.json");
      await expect(
        applyProfileRollback({
          prepared: rollback,
          receipt: applyReceipt,
          confirmRollbackSha256: rollback.preview.sha256,
          receiptPath: rollbackReceiptPath,
          now: NOW,
          hooks: {
            async afterReceiptLink({ target }) {
              await unlink(target);
              await writeFile(target, "owner-replacement", { mode: 0o600 });
            },
          },
        }),
      ).rejects.toThrow(ProfileRollbackAmbiguousError);
      expect(await readFile(rollbackFixtureValue.envPath)).not.toEqual(installed);
      expect(await readFile(rollbackFixtureValue.envPath)).toEqual(Buffer.from(rollback.bytes));
      expect(await readFile(rollbackReceiptPath, "utf8")).toBe("owner-replacement");
    } finally {
      await rm(rollbackFixtureValue.root, { recursive: true, force: true });
    }
  }, 15_000);

  it("refuses force-added live transaction artifacts for apply and rollback", async () => {
    const artifacts = ["temporary", "lock", "intent", "stage", "final"] as const;
    for (const operation of ["apply", "rollback"] as const) {
      for (const artifact of artifacts) {
        const fixture = await applyFixture();
        try {
          const applyPrepared = await prepare(fixture);
          let rollbackReceipt: Awaited<ReturnType<typeof applyProfileConfiguration>> | undefined;
          let rollbackPrepared: Awaited<ReturnType<typeof prepareProfileRollback>> | undefined;
          if (operation === "rollback") {
            rollbackReceipt = await applyProfileConfiguration({
              prepared: applyPrepared,
              confirmPatchSha256: applyPrepared.preview.patch.sha256,
              inspection: fixture.catalog.report,
              approvalBundle: fixture.bundle,
              authority: fixture.catalog.input.authority,
              ambientEnvironment: {},
              now: NOW,
              receiptPath: resolve(fixture.root, `setup-${artifact}.json`),
            });
            rollbackPrepared = await prepareProfileRollback({
              projectRoot: fixture.root,
              receipt: rollbackReceipt,
            });
          }
          const before = await readFile(fixture.envPath);
          const receiptPath = resolve(fixture.root, `${operation}-${artifact}-receipt.json`);
          let trackedPath: string | undefined;
          const hooks = {
            async afterTemporarySync({ temporary }: { temporary: string }) {
              if (artifact !== "temporary" && artifact !== "lock") return;
              trackedPath =
                artifact === "temporary"
                  ? temporary
                  : resolve(fixture.root, ".env.docsfab-apply.lock");
              await git(fixture.root, ["add", "-f", "--", trackedPath]);
            },
            async afterIntentSync(intent: string) {
              if (artifact !== "intent" && artifact !== "stage") return;
              trackedPath =
                artifact === "intent"
                  ? intent
                  : resolve(
                      fixture.root,
                      (await readdir(fixture.root)).find((name) =>
                        name.startsWith(".docsfab-profile-receipt-"),
                      )!,
                    );
              await git(fixture.root, ["add", "-f", "--", trackedPath]);
            },
            async afterReceiptLink({ target }: { target: string }) {
              if (artifact !== "final") return;
              trackedPath = target;
              await git(fixture.root, ["add", "-f", "--", target]);
            },
          };
          const action =
            operation === "apply"
              ? applyProfileConfiguration({
                  prepared: applyPrepared,
                  confirmPatchSha256: applyPrepared.preview.patch.sha256,
                  inspection: fixture.catalog.report,
                  approvalBundle: fixture.bundle,
                  authority: fixture.catalog.input.authority,
                  ambientEnvironment: {},
                  now: NOW,
                  receiptPath,
                  hooks,
                })
              : applyProfileRollback({
                  prepared: rollbackPrepared!,
                  receipt: rollbackReceipt!,
                  confirmRollbackSha256: rollbackPrepared!.preview.sha256,
                  receiptPath,
                  now: NOW,
                  hooks,
                });
          await expect(action).rejects.toMatchObject({
            code: expect.stringMatching(
              /^profile-(?:apply-rejected|apply-ambiguous|rollback-ambiguous)$/u,
            ),
          });
          expect(trackedPath).toBeDefined();
          expect(await git(fixture.root, ["ls-files", "--", trackedPath!])).not.toBe("");
          if (artifact !== "final") {
            expect(await readFile(fixture.envPath)).toEqual(before);
            await expect(readFile(receiptPath)).rejects.toMatchObject({ code: "ENOENT" });
          }
        } finally {
          await rm(fixture.root, { recursive: true, force: true });
        }
      }
    }
  }, 90_000);

  it("rejects receipt targets in transaction and Git administrative namespaces", async () => {
    for (const operation of ["apply", "rollback"] as const) {
      const fixture = await applyFixture();
      try {
        const applyPrepared = await prepare(fixture);
        let applyReceipt: Awaited<ReturnType<typeof applyProfileConfiguration>> | undefined;
        let rollbackPrepared: Awaited<ReturnType<typeof prepareProfileRollback>> | undefined;
        if (operation === "rollback") {
          applyReceipt = await applyProfileConfiguration({
            prepared: applyPrepared,
            confirmPatchSha256: applyPrepared.preview.patch.sha256,
            inspection: fixture.catalog.report,
            approvalBundle: fixture.bundle,
            authority: fixture.catalog.input.authority,
            ambientEnvironment: {},
            now: NOW,
            receiptPath: resolve(fixture.root, "safe-setup-receipt.json"),
          });
          rollbackPrepared = await prepareProfileRollback({
            projectRoot: fixture.root,
            receipt: applyReceipt,
          });
        }
        const gitPrivate = resolve(fixture.root, ".git", "docsfab-private");
        await mkdir(gitPrivate, { mode: 0o700 });
        const before = await readFile(fixture.envPath);
        for (const receiptPath of [
          resolve(fixture.root, ".env"),
          resolve(fixture.root, ".env.docsfab-apply.lock"),
          resolve(fixture.root, ".env.docsfab-transaction.json"),
          resolve(fixture.root, ".env.docsfab-recovery.claim"),
          resolve(fixture.root, `.env.docsfab-new-${"a".repeat(24)}`),
          resolve(fixture.root, `.env.docsfab-rollback-${"b".repeat(24)}`),
          resolve(gitPrivate, "receipt.json"),
        ]) {
          await expect(
            assertSafeProfileReceiptTarget({
              projectRoot: fixture.root,
              receiptPath,
            }),
          ).rejects.toBeInstanceOf(ProfileApplyError);
          await expect(
            recoverProfileTransaction({
              projectRoot: fixture.root,
              operation: "apply",
              purpose: "policy",
              patchSha256: "0".repeat(64),
              approvalBundleSha256: "1".repeat(64),
              receiptPath,
            }),
          ).rejects.toMatchObject({ code: "profile-apply-ambiguous" });
          const action =
            operation === "apply"
              ? applyProfileConfiguration({
                  prepared: applyPrepared,
                  confirmPatchSha256: applyPrepared.preview.patch.sha256,
                  inspection: fixture.catalog.report,
                  approvalBundle: fixture.bundle,
                  authority: fixture.catalog.input.authority,
                  ambientEnvironment: {},
                  now: NOW,
                  receiptPath,
                })
              : applyProfileRollback({
                  prepared: rollbackPrepared!,
                  receipt: applyReceipt!,
                  confirmRollbackSha256: rollbackPrepared!.preview.sha256,
                  receiptPath,
                  now: NOW,
                });
          await expect(action).rejects.toBeInstanceOf(ProfileApplyError);
          expect(await readFile(fixture.envPath)).toEqual(before);
          await expect(
            readFile(resolve(fixture.root, ".env.docsfab-apply.lock")),
          ).rejects.toMatchObject({ code: "ENOENT" });
        }
      } finally {
        await rm(fixture.root, { recursive: true, force: true });
      }
    }
  }, 30_000);

  it("rejects configuration-root replacement during apply and rollback receipt replay", async () => {
    for (const operation of ["apply", "rollback"] as const) {
      const fixture = await applyFixture();
      const movedRoot = `${fixture.root}-replay-old`;
      try {
        const prepared = await prepare(fixture);
        const applyReceipt = await applyProfileConfiguration({
          prepared,
          confirmPatchSha256: prepared.preview.patch.sha256,
          inspection: fixture.catalog.report,
          approvalBundle: fixture.bundle,
          authority: fixture.catalog.input.authority,
          ambientEnvironment: {},
          now: NOW,
          receiptPath: resolve(fixture.root, "replay-apply.json"),
        });
        let replayReceipt: typeof applyReceipt | Awaited<ReturnType<typeof applyProfileRollback>> =
          applyReceipt;
        if (operation === "rollback") {
          const rollback = await prepareProfileRollback({
            projectRoot: fixture.root,
            receipt: applyReceipt,
          });
          replayReceipt = await applyProfileRollback({
            prepared: rollback,
            receipt: applyReceipt,
            confirmRollbackSha256: rollback.preview.sha256,
            receiptPath: resolve(fixture.root, "replay-rollback.json"),
            now: NOW,
          });
        }
        const replay =
          operation === "apply"
            ? verifyProfileApplyReceiptPostimage({
                projectRoot: fixture.root,
                receiptPath: resolve(fixture.root, "replay-apply.json"),
                receipt: replayReceipt,
                async afterCurrentRead() {
                  await replaceRootAndTransplantEnvironment(fixture.root, movedRoot);
                },
              })
            : verifyProfileRollbackReceiptPostimage({
                projectRoot: fixture.root,
                receiptPath: resolve(fixture.root, "replay-rollback.json"),
                receipt: replayReceipt,
                async afterCurrentRead() {
                  await replaceRootAndTransplantEnvironment(fixture.root, movedRoot);
                },
              });
        await expect(replay).rejects.toBeInstanceOf(ProfileApplyError);
      } finally {
        await rm(fixture.root, { recursive: true, force: true });
        await rm(movedRoot, { recursive: true, force: true });
      }
    }
  }, 30_000);

  it("revalidates named receipts and environments at the final replay boundary", async () => {
    for (const operation of ["apply", "rollback"] as const) {
      const fixture = await applyFixture();
      try {
        const prepared = await prepare(fixture);
        const applyReceiptPath = resolve(fixture.root, `replay-race-${operation}-apply.json`);
        const applyReceipt = await applyProfileConfiguration({
          prepared,
          confirmPatchSha256: prepared.preview.patch.sha256,
          inspection: fixture.catalog.report,
          approvalBundle: fixture.bundle,
          authority: fixture.catalog.input.authority,
          ambientEnvironment: {},
          now: NOW,
          receiptPath: applyReceiptPath,
        });
        let replayReceipt = applyReceipt;
        let replayReceiptPath = applyReceiptPath;
        if (operation === "rollback") {
          const rollback = await prepareProfileRollback({
            projectRoot: fixture.root,
            receipt: applyReceipt,
          });
          replayReceiptPath = resolve(fixture.root, "replay-race-rollback.json");
          replayReceipt = (await applyProfileRollback({
            prepared: rollback,
            receipt: applyReceipt,
            confirmRollbackSha256: rollback.preview.sha256,
            receiptPath: replayReceiptPath,
            now: NOW,
          })) as unknown as typeof applyReceipt;
        }
        for (const attack of [
          "target-tamper",
          "target-replace",
          "receipt-tamper",
          "receipt-replace",
          "receipt-hardlink",
        ] as const) {
          const targetBytes = await readFile(fixture.envPath);
          const receiptBytes = await readFile(replayReceiptPath);
          const targetBackup = `${fixture.envPath}.backup`;
          const receiptBackup = `${replayReceiptPath}.backup`;
          const receiptAlias = `${replayReceiptPath}.alias`;
          const replay =
            operation === "apply"
              ? verifyProfileApplyReceiptPostimage({
                  projectRoot: fixture.root,
                  receiptPath: replayReceiptPath,
                  receipt: replayReceipt,
                  async afterCurrentRead() {
                    if (attack === "target-tamper") await tamperFileSameSize(fixture.envPath);
                    if (attack === "target-replace") {
                      await rename(fixture.envPath, targetBackup);
                      await writeFile(fixture.envPath, targetBytes, { mode: 0o600 });
                    }
                    if (attack === "receipt-tamper") await tamperFileSameSize(replayReceiptPath);
                    if (attack === "receipt-replace") {
                      await rename(replayReceiptPath, receiptBackup);
                      await writeFile(replayReceiptPath, receiptBytes, { mode: 0o600 });
                    }
                    if (attack === "receipt-hardlink") await link(replayReceiptPath, receiptAlias);
                  },
                })
              : verifyProfileRollbackReceiptPostimage({
                  projectRoot: fixture.root,
                  receiptPath: replayReceiptPath,
                  receipt: replayReceipt,
                  async afterCurrentRead() {
                    if (attack === "target-tamper") await tamperFileSameSize(fixture.envPath);
                    if (attack === "target-replace") {
                      await rename(fixture.envPath, targetBackup);
                      await writeFile(fixture.envPath, targetBytes, { mode: 0o600 });
                    }
                    if (attack === "receipt-tamper") await tamperFileSameSize(replayReceiptPath);
                    if (attack === "receipt-replace") {
                      await rename(replayReceiptPath, receiptBackup);
                      await writeFile(replayReceiptPath, receiptBytes, { mode: 0o600 });
                    }
                    if (attack === "receipt-hardlink") await link(replayReceiptPath, receiptAlias);
                  },
                });
          await expect(replay).rejects.toBeInstanceOf(ProfileApplyError);
          if (attack === "target-replace") {
            await unlink(fixture.envPath);
            await rename(targetBackup, fixture.envPath);
          } else if (attack === "target-tamper") {
            await writeFile(fixture.envPath, targetBytes);
          } else if (attack === "receipt-replace") {
            await unlink(replayReceiptPath);
            await rename(receiptBackup, replayReceiptPath);
          } else if (attack === "receipt-tamper") {
            await writeFile(replayReceiptPath, receiptBytes);
          } else {
            await unlink(receiptAlias);
          }
        }
      } finally {
        await rm(fixture.root, { recursive: true, force: true });
      }
    }
  }, 60_000);

  it("requires owner-private parent directories for host inputs", async () => {
    const root = await realpath(await mkdtemp(resolve(tmpdir(), "docsfab-host-input-")));
    try {
      const privateParent = resolve(root, "private");
      const permissiveParent = resolve(root, "permissive");
      await mkdir(privateParent, { mode: 0o700 });
      await mkdir(permissiveParent, { mode: 0o700 });
      await chmod(permissiveParent, 0o755);
      const privateInput = resolve(privateParent, "input.json");
      const permissiveInput = resolve(permissiveParent, "input.json");
      await writeFile(privateInput, "{}", { mode: 0o600 });
      await writeFile(permissiveInput, "{}", { mode: 0o600 });
      expect(new TextDecoder().decode(await readOwnerHostFile(privateInput))).toBe("{}");
      await expect(readOwnerHostFile(permissiveInput)).rejects.toBeInstanceOf(ProfileApplyError);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("governs no-change receipt publication and refuses no-change target collisions", async () => {
    for (const race of ["stage", "final", "root-swap", "preexisting"] as const) {
      const fixture = await applyFixture();
      const movedRoot = `${fixture.root}-no-change-old`;
      try {
        const initial = await prepare(fixture);
        await applyProfileConfiguration({
          prepared: initial,
          confirmPatchSha256: initial.preview.patch.sha256,
          inspection: fixture.catalog.report,
          approvalBundle: fixture.bundle,
          authority: fixture.catalog.input.authority,
          ambientEnvironment: {},
          now: NOW,
          receiptPath: resolve(fixture.root, "no-change-setup.json"),
        });
        const noChange = await prepare(fixture);
        expect(noChange.preview.patch.changedKeys).toHaveLength(0);
        const receiptPath = resolve(fixture.root, `no-change-${race}.json`);
        if (race === "preexisting") {
          await writeFile(receiptPath, "owner-existing", { mode: 0o600 });
        }
        let trackedPath: string | undefined;
        const action = applyProfileConfiguration({
          prepared: noChange,
          confirmPatchSha256: noChange.preview.patch.sha256,
          inspection: fixture.catalog.report,
          approvalBundle: fixture.bundle,
          authority: fixture.catalog.input.authority,
          ambientEnvironment: {},
          now: NOW,
          receiptPath,
          hooks: {
            async afterReceiptStage({ temporary }) {
              if (race !== "stage") return;
              trackedPath = temporary;
              await git(fixture.root, ["add", "-f", "--", temporary]);
            },
            async afterReceiptLink({ target }) {
              if (race === "final") {
                trackedPath = target;
                await git(fixture.root, ["add", "-f", "--", target]);
              } else if (race === "root-swap") {
                await replaceRootAndTransplantEnvironment(fixture.root, movedRoot);
              }
            },
          },
        });
        await expect(action).rejects.toMatchObject({
          code: expect.stringMatching(/^profile-(?:apply-rejected|apply-ambiguous)$/u),
        });
        if (trackedPath) {
          expect(await git(fixture.root, ["ls-files", "--", trackedPath])).not.toBe("");
        }
        if (race === "preexisting") {
          expect(await readFile(receiptPath, "utf8")).toBe("owner-existing");
        }
      } finally {
        await rm(fixture.root, { recursive: true, force: true });
        await rm(movedRoot, { recursive: true, force: true });
      }
    }

    const fixture = await applyFixture();
    try {
      const initial = await prepare(fixture);
      await applyProfileConfiguration({
        prepared: initial,
        confirmPatchSha256: initial.preview.patch.sha256,
        inspection: fixture.catalog.report,
        approvalBundle: fixture.bundle,
        authority: fixture.catalog.input.authority,
        ambientEnvironment: {},
        now: NOW,
        receiptPath: resolve(fixture.root, "no-change-reserved-setup.json"),
      });
      const noChange = await prepare(fixture);
      for (const receiptPath of [
        resolve(fixture.root, ".env.docsfab-apply.lock"),
        resolve(fixture.root, ".git", "no-change-receipt.json"),
      ]) {
        await expect(
          applyProfileConfiguration({
            prepared: noChange,
            confirmPatchSha256: noChange.preview.patch.sha256,
            inspection: fixture.catalog.report,
            approvalBundle: fixture.bundle,
            authority: fixture.catalog.input.authority,
            ambientEnvironment: {},
            now: NOW,
            receiptPath,
          }),
        ).rejects.toBeInstanceOf(ProfileApplyError);
      }
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  }, 60_000);

  it("revalidates published receipt bytes, identity, mode, and link count before success", async () => {
    const attacks = ["hardlink", "mode", "tamper"] as const;
    const mutate = async (path: string, attack: (typeof attacks)[number]) => {
      if (attack === "hardlink") {
        await link(path, `${path}.alias`);
      } else if (attack === "mode") {
        await chmod(path, 0o640);
      } else {
        const bytes = await readFile(path);
        bytes[0] = bytes[0]! ^ 1;
        await writeFile(path, bytes);
      }
    };

    for (const operation of ["apply", "rollback", "no-change"] as const) {
      for (const attack of attacks) {
        const fixture = await applyFixture();
        try {
          const initial = await prepare(fixture);
          let applyReceipt: Awaited<ReturnType<typeof applyProfileConfiguration>> | undefined;
          let rollback: Awaited<ReturnType<typeof prepareProfileRollback>> | undefined;
          if (operation !== "apply") {
            applyReceipt = await applyProfileConfiguration({
              prepared: initial,
              confirmPatchSha256: initial.preview.patch.sha256,
              inspection: fixture.catalog.report,
              approvalBundle: fixture.bundle,
              authority: fixture.catalog.input.authority,
              ambientEnvironment: {},
              now: NOW,
              receiptPath: resolve(fixture.root, `${operation}-${attack}-setup.json`),
            });
          }
          if (operation === "rollback") {
            rollback = await prepareProfileRollback({
              projectRoot: fixture.root,
              receipt: applyReceipt!,
            });
          }
          const receiptPath = resolve(fixture.root, `${operation}-${attack}-receipt.json`);
          const hooks = {
            async afterReceiptPublish(path: string) {
              await mutate(path, attack);
            },
          };
          const actionPrepared = operation === "no-change" ? await prepare(fixture) : initial;
          const action =
            operation === "rollback"
              ? applyProfileRollback({
                  prepared: rollback!,
                  receipt: applyReceipt!,
                  confirmRollbackSha256: rollback!.preview.sha256,
                  receiptPath,
                  now: NOW,
                  hooks,
                })
              : applyProfileConfiguration({
                  prepared: actionPrepared,
                  confirmPatchSha256: actionPrepared.preview.patch.sha256,
                  inspection: fixture.catalog.report,
                  approvalBundle: fixture.bundle,
                  authority: fixture.catalog.input.authority,
                  ambientEnvironment: {},
                  now: NOW,
                  receiptPath,
                  hooks,
                });
          await expect(action).rejects.toMatchObject({
            code:
              operation === "rollback"
                ? "profile-rollback-ambiguous"
                : expect.stringMatching(/^profile-apply-(?:ambiguous|rejected)$/u),
          });
          const lockPath = resolve(fixture.root, ".env.docsfab-apply.lock");
          const intentPath = resolve(fixture.root, ".env.docsfab-transaction.json");
          if (operation === "no-change") {
            await expect(readFile(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
            await expect(readFile(intentPath)).rejects.toMatchObject({ code: "ENOENT" });
            expect(
              (await readdir(fixture.root)).filter((name) =>
                name.startsWith(".docsfab-profile-receipt-"),
              ),
            ).toEqual([]);
          } else {
            expect((await lstat(lockPath)).isFile()).toBe(true);
            expect((await lstat(intentPath)).isFile()).toBe(true);
          }
        } finally {
          await rm(fixture.root, { recursive: true, force: true });
        }
      }
    }
  }, 120_000);

  it("revalidates the exact receipt-bound environment after publication", async () => {
    for (const operation of ["apply", "rollback", "no-change"] as const) {
      for (const attack of ["tamper-after-link", "replace-after-publish"] as const) {
        const fixture = await applyFixture();
        try {
          const initial = await prepare(fixture);
          let applyReceipt: Awaited<ReturnType<typeof applyProfileConfiguration>> | undefined;
          let rollback: Awaited<ReturnType<typeof prepareProfileRollback>> | undefined;
          if (operation !== "apply") {
            applyReceipt = await applyProfileConfiguration({
              prepared: initial,
              confirmPatchSha256: initial.preview.patch.sha256,
              inspection: fixture.catalog.report,
              approvalBundle: fixture.bundle,
              authority: fixture.catalog.input.authority,
              ambientEnvironment: {},
              now: NOW,
              receiptPath: resolve(fixture.root, `${operation}-${attack}-setup.json`),
            });
          }
          if (operation === "rollback") {
            rollback = await prepareProfileRollback({
              projectRoot: fixture.root,
              receipt: applyReceipt!,
            });
          }
          const actionPrepared = operation === "no-change" ? await prepare(fixture) : initial;
          const receiptPath = resolve(fixture.root, `${operation}-${attack}-receipt.json`);
          const replaceConfiguration = async () => {
            const exactBytes = await readFile(fixture.envPath);
            // Recreate via exclusive temp+rename so the replacement keeps a
            // distinct inode even on filesystems that reuse inodes for same-path
            // create-after-unlink (observed on some Docker overlay setups).
            const temporary = `${fixture.envPath}.${randomUUID()}.swap`;
            await writeFile(temporary, exactBytes, { mode: 0o600 });
            await rename(temporary, fixture.envPath);
          };
          const hooks = {
            async afterReceiptLink() {
              if (attack !== "tamper-after-link") return;
              const bytes = await readFile(fixture.envPath);
              bytes[0] = bytes[0]! ^ 1;
              await writeFile(fixture.envPath, bytes);
            },
            async afterReceiptPublish() {
              if (attack === "replace-after-publish") await replaceConfiguration();
            },
          };
          const action =
            operation === "rollback"
              ? applyProfileRollback({
                  prepared: rollback!,
                  receipt: applyReceipt!,
                  confirmRollbackSha256: rollback!.preview.sha256,
                  receiptPath,
                  now: NOW,
                  hooks,
                })
              : applyProfileConfiguration({
                  prepared: actionPrepared,
                  confirmPatchSha256: actionPrepared.preview.patch.sha256,
                  inspection: fixture.catalog.report,
                  approvalBundle: fixture.bundle,
                  authority: fixture.catalog.input.authority,
                  ambientEnvironment: {},
                  now: NOW,
                  receiptPath,
                  hooks,
                });
          await expect(action).rejects.toMatchObject({
            code:
              operation === "rollback"
                ? "profile-rollback-ambiguous"
                : expect.stringMatching(/^profile-apply-(?:ambiguous|rejected)$/u),
          });
          const lockPath = resolve(fixture.root, ".env.docsfab-apply.lock");
          const intentPath = resolve(fixture.root, ".env.docsfab-transaction.json");
          if (operation === "no-change") {
            await expect(readFile(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
            await expect(readFile(intentPath)).rejects.toMatchObject({ code: "ENOENT" });
          } else {
            expect((await lstat(lockPath)).isFile()).toBe(true);
            expect((await lstat(intentPath)).isFile()).toBe(true);
          }
        } finally {
          await rm(fixture.root, { recursive: true, force: true });
        }
      }
    }
  }, 120_000);

  it("cleans no-change markers after a publication hook failure and preserves replay", async () => {
    const fixture = await applyFixture();
    try {
      const initial = await prepare(fixture);
      await applyProfileConfiguration({
        prepared: initial,
        confirmPatchSha256: initial.preview.patch.sha256,
        inspection: fixture.catalog.report,
        approvalBundle: fixture.bundle,
        authority: fixture.catalog.input.authority,
        ambientEnvironment: {},
        now: NOW,
        receiptPath: resolve(fixture.root, "no-change-hook-setup.json"),
      });
      const noChange = await prepare(fixture);
      const receiptPath = resolve(fixture.root, "no-change-hook-receipt.json");
      await expect(
        applyProfileConfiguration({
          prepared: noChange,
          confirmPatchSha256: noChange.preview.patch.sha256,
          inspection: fixture.catalog.report,
          approvalBundle: fixture.bundle,
          authority: fixture.catalog.input.authority,
          ambientEnvironment: {},
          now: NOW,
          receiptPath,
          hooks: {
            afterReceiptPublish() {
              throw new Error("PUBLISH-HOOK-CANARY");
            },
          },
        }),
      ).rejects.toBeInstanceOf(ProfileApplyError);
      await expect(
        readFile(resolve(fixture.root, ".env.docsfab-apply.lock")),
      ).rejects.toMatchObject({ code: "ENOENT" });
      await expect(
        readFile(resolve(fixture.root, ".env.docsfab-transaction.json")),
      ).rejects.toMatchObject({ code: "ENOENT" });
      expect(
        (await readdir(fixture.root)).filter((name) =>
          name.startsWith(".docsfab-profile-receipt-"),
        ),
      ).toEqual([]);
      const published = await loadProfileApplyReceipt(receiptPath);
      await expect(
        verifyProfileApplyReceiptPostimage({
          projectRoot: fixture.root,
          receiptPath,
          receipt: published,
        }),
      ).resolves.toEqual(published);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("supports an owner-private non-Git configuration root through apply and recovery", async () => {
    const fixture = await applyFixture();
    try {
      await rm(resolve(fixture.root, ".git"), { recursive: true, force: true });
      const prepared = await prepare(fixture);
      const receiptPath = resolve(fixture.root, "non-git-receipt.json");
      const privateRoot = resolve(fixture.root, "private");
      await mkdir(privateRoot, { mode: 0o700 });
      const inspectionPath = resolve(privateRoot, "inspection.json");
      const bundlePath = resolve(privateRoot, "bundle.json");
      const publicKeyPath = resolve(privateRoot, "public.pem");
      const inputPath = resolve(privateRoot, "crash.json");
      await writeFile(
        inspectionPath,
        canonicalizeJsonEvidence(fixture.catalog.report as unknown as JsonEvidenceValue),
        { mode: 0o600 },
      );
      await writeFile(
        bundlePath,
        canonicalizeJsonEvidence(fixture.bundle as unknown as JsonEvidenceValue),
        { mode: 0o600 },
      );
      await writeFile(publicKeyPath, fixture.catalog.input.authority.publicKey, { mode: 0o600 });
      await writeFile(
        inputPath,
        JSON.stringify({
          operation: "apply",
          root: fixture.root,
          purpose: "policy",
          inspectionPath,
          bundlePath,
          publicKeyPath,
          authorityId: fixture.catalog.input.authority.id,
          applyReceiptPath: receiptPath,
          outputReceiptPath: receiptPath,
          now: NOW.toISOString(),
          crashPoint: "after-receipt",
        }),
        { mode: 0o600 },
      );
      try {
        await execFile(process.execPath, ["--import", tsxLoader, crashChildPath, inputPath], {
          cwd: fixture.root,
        });
        throw new Error("Expected crash child to be killed.");
      } catch (error) {
        expect(error).toMatchObject({ signal: "SIGKILL" });
      }
      const recovered = await recoverProfileTransaction({
        projectRoot: fixture.root,
        operation: "apply",
        purpose: "policy",
        previewSha256: prepared.preview.sha256,
        patchSha256: prepared.preview.patch.sha256,
        approvalBundleSha256: fixture.bundle.sha256,
        receiptPath,
      });
      expect(recovered.status).toBe("completed");
      if (
        recovered.status !== "completed" ||
        recovered.receipt.kind !== "docsfab-profile-apply-receipt"
      )
        throw new Error("fixture");
      await expect(
        verifyProfileApplyReceiptPostimage({
          projectRoot: fixture.root,
          receiptPath,
          receipt: recovered.receipt,
        }),
      ).resolves.toEqual(recovered.receipt);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("detects tracked inode aliases from a nested configuration root", async () => {
    const fixture = await applyFixture();
    try {
      const nested = resolve(fixture.root, "private-config");
      await mkdir(nested, { mode: 0o700 });
      const nestedEnvironment = resolve(nested, ".env");
      await writeFile(nestedEnvironment, await readFile(fixture.envPath), { mode: 0o600 });
      await git(fixture.root, ["add", "-f", "--", fixture.envPath]);
      await expect(
        prepareProfileApply({
          projectRoot: nested,
          purpose: "policy",
          inspection: fixture.catalog.report,
          approvalBundle: fixture.bundle,
          authority: fixture.catalog.input.authority,
          ambientEnvironment: {},
          now: NOW,
        }),
      ).resolves.toBeDefined();
      const alias = resolve(fixture.root, "tracked-environment-alias");
      await link(nestedEnvironment, alias);
      await git(fixture.root, ["add", "-f", "--", alias]);
      await expect(
        prepareProfileApply({
          projectRoot: nested,
          purpose: "policy",
          inspection: fixture.catalog.report,
          approvalBundle: fixture.bundle,
          authority: fixture.catalog.input.authority,
          ambientEnvironment: {},
          now: NOW,
        }),
      ).rejects.toBeInstanceOf(ProfileApplyError);
      await git(fixture.root, ["rm", "--cached", "--quiet", "--", alias]);
      const blob = await git(fixture.root, ["hash-object", "-w", nestedEnvironment]);
      await git(fixture.root, [
        "update-index",
        "--add",
        "--cacheinfo",
        `100644,${blob},private-config/.ENV`,
      ]);
      await expect(
        prepareProfileApply({
          projectRoot: nested,
          purpose: "policy",
          inspection: fixture.catalog.report,
          approvalBundle: fixture.bundle,
          authority: fixture.catalog.input.authority,
          ambientEnvironment: {},
          now: NOW,
        }),
      ).rejects.toBeInstanceOf(ProfileApplyError);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("rejects receipts anywhere under a linked worktree common Git directory", async () => {
    const fixture = await applyFixture();
    const linkedRoot = resolve(
      await realpath(tmpdir()),
      `docsfab-linked-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );
    try {
      await git(fixture.root, ["add", ".gitignore"]);
      await git(fixture.root, ["commit", "--quiet", "-m", "fixture"]);
      await git(fixture.root, ["worktree", "add", "--quiet", "--detach", linkedRoot, "HEAD"]);
      await writeFile(resolve(linkedRoot, ".env"), await readFile(fixture.envPath), {
        mode: 0o600,
      });
      const linkedPrepared = await prepareProfileApply({
        projectRoot: linkedRoot,
        purpose: "policy",
        inspection: fixture.catalog.report,
        approvalBundle: fixture.bundle,
        authority: fixture.catalog.input.authority,
        ambientEnvironment: {},
        now: NOW,
      });
      const commonOutput = await git(linkedRoot, ["rev-parse", "--git-common-dir"]);
      const commonDirectory = resolve(linkedRoot, commonOutput);
      const commonPrivate = resolve(commonDirectory, "docsfab-private");
      await mkdir(commonPrivate, { mode: 0o700 });
      const before = await readFile(resolve(linkedRoot, ".env"));
      const commonReceiptPath = resolve(commonPrivate, "receipt.json");
      await expect(
        assertSafeProfileReceiptTarget({
          projectRoot: linkedRoot,
          receiptPath: commonReceiptPath,
        }),
      ).rejects.toBeInstanceOf(ProfileApplyError);
      await expect(
        recoverProfileTransaction({
          projectRoot: linkedRoot,
          operation: "apply",
          purpose: "policy",
          patchSha256: linkedPrepared.preview.patch.sha256,
          approvalBundleSha256: fixture.bundle.sha256,
          receiptPath: commonReceiptPath,
        }),
      ).rejects.toMatchObject({ code: "profile-apply-ambiguous" });
      await expect(
        applyProfileConfiguration({
          prepared: linkedPrepared,
          confirmPatchSha256: linkedPrepared.preview.patch.sha256,
          inspection: fixture.catalog.report,
          approvalBundle: fixture.bundle,
          authority: fixture.catalog.input.authority,
          ambientEnvironment: {},
          now: NOW,
          receiptPath: commonReceiptPath,
        }),
      ).rejects.toBeInstanceOf(ProfileApplyError);
      expect(await readFile(resolve(linkedRoot, ".env"))).toEqual(before);
    } finally {
      await rm(linkedRoot, { recursive: true, force: true });
      await rm(fixture.root, { recursive: true, force: true });
    }
  }, 30_000);

  it("canonicalizes a symlinked separate Git directory before receipt checks", async () => {
    const worktree = await realpath(await mkdtemp(resolve(tmpdir(), "docsfab-separate-worktree-")));
    const store = await realpath(await mkdtemp(resolve(tmpdir(), "docsfab-separate-store-")));
    try {
      const actualGitDirectory = resolve(store, "actual.git");
      const linkedGitDirectory = resolve(store, "linked.git");
      await git(worktree, ["init", "--quiet", `--separate-git-dir=${actualGitDirectory}`]);
      await symlink(actualGitDirectory, linkedGitDirectory);
      await writeFile(resolve(worktree, ".git"), `gitdir: ${linkedGitDirectory}\n`);
      const privateGitDirectory = resolve(actualGitDirectory, "docsfab-private");
      await mkdir(privateGitDirectory, { mode: 0o700 });
      await expect(
        assertSafeProfileReceiptTarget({
          projectRoot: worktree,
          receiptPath: resolve(privateGitDirectory, "receipt.json"),
        }),
      ).rejects.toBeInstanceOf(ProfileApplyError);
    } finally {
      await rm(worktree, { recursive: true, force: true });
      await rm(store, { recursive: true, force: true });
    }
  });
});

function evidenceDigest(value: Record<string, unknown>): string {
  const unsigned = structuredClone(value);
  delete unsigned.sha256;
  return createHash("sha256")
    .update(canonicalizeJsonEvidence(unsigned as JsonEvidenceValue))
    .digest("hex");
}

async function applyFixture() {
  const catalog = await profileApprovalFixture();
  const bundle = approveModelProfile(catalog.input);
  const root = await realpath(await mkdtemp(resolve(tmpdir(), "docsfab-profile-apply-")));
  await initFixtureRepo(root);
  await writeFile(
    resolve(root, ".gitignore"),
    ".env\n.env.docsfab-new-*\n.env.docsfab-rollback-*\n.env.docsfab-apply.lock\n.env.docsfab-transaction.json\n.env.docsfab-recovery.claim\n",
  );
  const envPath = resolve(root, ".env");
  const secret = catalog.endpoint.apiKey;
  const environment = {
    ...validModelEnvironment,
    MODEL_PROVIDER: catalog.endpoint.providerId,
    MODEL_BASE_URL: catalog.endpoint.baseUrl,
    MODEL_ID: catalog.endpoint.modelId,
    MODEL_API_KEY: secret,
    MODEL_CONTEXT_WINDOW: "8192",
    MODEL_MAX_OUTPUT_TOKENS: "4096",
    MODEL_PROFILE_APPROVED_SOURCE: "unknown",
    MODEL_PROFILE_EFFECTIVE_DATE: "unknown",
    MODEL_PROFILE_REVIEW_AFTER: "unknown",
  };
  const bytes = [
    "# owner configuration",
    ...Object.entries(environment).map(([key, value]) => `${key}=${value}`),
    "UNRELATED=preserved",
    "",
  ].join("\n");
  await writeFile(envPath, bytes, { mode: 0o600 });
  return { root, envPath, secret, catalog, bundle };
}

function prepare(fixture: Awaited<ReturnType<typeof applyFixture>>) {
  return prepareProfileApply({
    projectRoot: fixture.root,
    purpose: "policy",
    inspection: fixture.catalog.report,
    approvalBundle: fixture.bundle,
    authority: fixture.catalog.input.authority,
    ambientEnvironment: {},
    now: NOW,
  });
}

async function tamperFileSameSize(path: string): Promise<void> {
  const bytes = await readFile(path);
  bytes[0] = bytes[0]! ^ 1;
  await writeFile(path, bytes);
}

async function replaceRootAndTransplantEnvironment(root: string, movedRoot: string): Promise<void> {
  await rename(root, movedRoot);
  await mkdir(root, { mode: 0o700 });
  await rename(resolve(movedRoot, ".env"), resolve(root, ".env"));
}
