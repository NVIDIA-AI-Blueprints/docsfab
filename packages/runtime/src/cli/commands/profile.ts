// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { existsSync } from "node:fs";
import { resolve } from "node:path";

import {
  ensureDocsFabConfigurationRoot,
  resolveDocsFabConfigurationRoot,
} from "../../config/host-paths.js";
import { canonicalizeJsonEvidence, type JsonEvidenceValue } from "../../json-evidence.js";
import {
  approveModelProfile,
  decodeModelProfileApprovalBundle,
  decodeModelProfileApprovalBundleAtCreation,
} from "../../model/profile-approval.js";
import {
  applyProfileConfiguration,
  applyProfileRollback,
  applyProfileSeed,
  assertSafeProfileReceiptTarget,
  loadProfileApprovalEndpoint,
  loadProfileApplyReceipt,
  loadProfileRollbackReceipt,
  loadProfileSeedReceipt,
  persistCredentialFreeHostArtifact,
  prepareProfileApply,
  prepareProfileRollback,
  prepareProfileSeed,
  ProfileOwnerArtifactOperatorError,
  PROFILE_SEED_RECEIPT_NAME,
  readOwnerHostFile,
  recoverProfileTransaction,
  serializeProfileSeedReceipt,
  verifyProfileApplyReceiptPostimage,
  verifyProfileRollbackReceiptPostimage,
  verifyProfileSeedReceiptPostimage,
  type ProfileSeedReceiptV1,
} from "../../model/profile-apply.js";
import {
  inspectModelEndpointProfile,
  serializeModelProfileInspection,
} from "../../model/profile-inspection.js";
import { decodeHostText, ProfileCliUsageError } from "../options.js";
import { presentDecision, presentResult } from "../../operator/index.js";
import {
  loadSelectedProfileInspectionEndpoint,
  parseProfileApproveArguments,
  parseProfileDraftArguments,
  parseProfileInspectionArguments,
  parseProfileProbeArguments,
  parseProfileRollbackArguments,
  parseProfileSeedArguments,
} from "../profile-arguments.js";
import { runProfileDraft, serializeProfileDraft } from "../profile-draft.js";
import { runProfileProbe, serializeProfileProbeObservation } from "../profile-probe.js";
import {
  projectProfileDraft,
  projectProfileInspection,
  projectProfileProbe,
} from "../profile-presentation.js";
import { writeCliPresentation } from "../presentation.js";

const profileField = (label: string, value: string, importance?: "ordinary" | "material") => ({
  label,
  evidence: { state: "known" as const, value },
  ...(importance === undefined ? {} : { importance }),
});

export async function handleProfileCommand(args: string[]): Promise<void> {
  if (args[0] === "seed") {
    const request = parseProfileSeedArguments(args.slice(1));
    const now = new Date();
    const root = await ensureDocsFabConfigurationRoot();
    const receiptPath = resolve(root, PROFILE_SEED_RECEIPT_NAME);
    await assertSafeProfileReceiptTarget({ projectRoot: root, receiptPath });
    const prepared = await prepareProfileSeed({
      projectRoot: root,
      preset: request.preset,
      ambientEnvironment: process.env,
    });
    const recovered = await recoverProfileTransaction({
      projectRoot: root,
      operation: "seed",
      purpose: "policy",
      previewSha256: prepared.preview.sha256,
      patchSha256: prepared.preview.patch.sha256,
      receiptPath,
    });
    if (recovered.status === "completed") {
      const receipt = recovered.receipt;
      if (receipt.kind !== "docsfab-profile-seed-receipt") {
        throw new Error("Recovered profile seed transaction has the wrong receipt kind.");
      }
      printSeedReceipt(request.json, receipt, receiptPath, true);
      return;
    }
    if (existsSync(receiptPath)) {
      const existing = await loadProfileSeedReceipt(receiptPath);
      if (
        existing.purpose !== "policy" ||
        existing.afterSha256 !== prepared.preview.patch.afterSha256 ||
        existing.preview.patch.preset !== prepared.preview.patch.preset
      ) {
        throw new Error("Existing seed receipt does not bind the exact unsigned example profile.");
      }
      await verifyProfileSeedReceiptPostimage({
        projectRoot: root,
        receiptPath,
        receipt: existing,
      });
      printSeedReceipt(request.json, existing, receiptPath, true);
      return;
    }
    const receipt = await applyProfileSeed({
      prepared,
      receiptPath,
      ambientEnvironment: process.env,
      now,
    });
    printSeedReceipt(request.json, receipt, receiptPath, false);
    return;
  }
  if (args[0] === "approve") {
    const request = parseProfileApproveArguments(args.slice(1));
    const now = new Date();
    const root = resolveDocsFabConfigurationRoot();
    const [inspection, publicKeyBytes] = await Promise.all([
      readOwnerHostFile(resolve(request.inspectionPath), "inspection evidence"),
      readOwnerHostFile(resolve(request.publicKeyPath), "public signing key"),
    ]);
    const publicKey = decodeProfileOwnerText(publicKeyBytes, "public signing key");
    const authority = { id: request.authorityId, publicKey };
    let bundle;
    let savedBundleBytes: Uint8Array | undefined;
    if (request.apply) {
      savedBundleBytes = await readOwnerHostFile(
        resolve(request.bundlePath),
        "saved approval bundle",
      );
      bundle = decodeModelProfileApprovalBundleAtCreation(savedBundleBytes, inspection, authority);
      if (bundle.sha256 !== request.confirmBundleSha256) {
        throw new Error("Saved approval bundle digest does not match exact confirmation.");
      }
    } else {
      const endpoint = await loadProfileApprovalEndpoint({
        projectRoot: root,
        purpose: request.purpose,
        ambientEnvironment: process.env,
        now,
      });
      const privateKey = decodeProfileOwnerText(
        await readOwnerHostFile(resolve(request.privateKeyPath), "private signing key"),
        "private signing key",
      );
      bundle = approveModelProfile({
        inspection,
        purpose: request.purpose,
        proposalSha256: request.proposalSha256,
        effectiveDate: request.effectiveDate,
        reviewAfter: request.reviewAfter,
        conflictFields: request.conflictFields,
        authority,
        privateKey,
        endpoint,
        now,
      });
      await persistCredentialFreeHostArtifact(resolve(request.bundlePath), bundle);
    }
    const receiptTarget = request.receiptPath ? resolve(request.receiptPath) : undefined;
    if (request.apply && receiptTarget) {
      await assertSafeProfileReceiptTarget({ projectRoot: root, receiptPath: receiptTarget });
      const recovered = await recoverProfileTransaction({
        projectRoot: root,
        operation: "apply",
        purpose: request.purpose,
        patchSha256: request.confirmPatchSha256!,
        approvalBundleSha256: bundle.sha256,
        receiptPath: receiptTarget,
      });
      if (recovered.status === "completed") {
        const receipt = recovered.receipt;
        if (receipt.kind !== "docsfab-profile-apply-receipt") {
          throw new Error("Recovered transaction has the wrong receipt kind.");
        }
        if (request.json) {
          console.log(canonicalizeJsonEvidence(receipt as unknown as JsonEvidenceValue));
        } else {
          writeCliPresentation(
            presentResult({
              title: "Profile apply",
              outcome: profileField(
                "Apply",
                `Recovered completed profile apply: ${receipt.sha256}`,
              ),
              effects: [profileField("Receipt", receiptTarget, "material")],
              primaryAction: {
                kind: "argv",
                label: "Preview rollback",
                executable: "docsfab",
                args: ["profile", "rollback", "--receipt", receiptTarget],
              },
              attention: null,
            }),
          );
        }
        return;
      }
    }
    if (request.apply && receiptTarget && existsSync(receiptTarget)) {
      const existing = await loadProfileApplyReceipt(receiptTarget);
      if (
        existing.purpose !== request.purpose ||
        existing.approvalBundleSha256 !== bundle.sha256 ||
        existing.patchSha256 !== request.confirmPatchSha256 ||
        existing.inspectionSha256 !== bundle.inspectionSha256
      ) {
        throw new Error("Existing receipt does not bind the exact confirmed approval and patch.");
      }
      await verifyProfileApplyReceiptPostimage({
        projectRoot: root,
        receiptPath: receiptTarget,
        receipt: existing,
      });
      if (request.json) {
        console.log(canonicalizeJsonEvidence(existing as unknown as JsonEvidenceValue));
      } else {
        writeCliPresentation(
          presentResult({
            title: "Profile apply",
            outcome: profileField(
              "Apply",
              `Already applied; exact receipt replayed: ${existing.sha256}`,
            ),
            effects: [profileField("Receipt", receiptTarget, "material")],
            primaryAction: {
              kind: "argv",
              label: "Preview rollback",
              executable: "docsfab",
              args: ["profile", "rollback", "--receipt", receiptTarget],
            },
            attention: null,
          }),
        );
      }
      return;
    }
    if (request.apply) {
      if (!savedBundleBytes) throw new Error("Saved approval bundle is unavailable.");
      bundle = decodeModelProfileApprovalBundle(savedBundleBytes, inspection, authority, now);
    }
    const prepared = await prepareProfileApply({
      projectRoot: root,
      purpose: request.purpose,
      inspection,
      approvalBundle: bundle,
      authority,
      ambientEnvironment: process.env,
      now,
    });
    if (!request.apply) {
      const preview = {
        schemaVersion: 1,
        kind: "docsfab-profile-approval-command-preview",
        approvalBundle: bundle,
        applyPreview: prepared.preview,
        mutationAuthorized: false,
      };
      if (request.json) {
        console.log(canonicalizeJsonEvidence(preview as unknown as JsonEvidenceValue));
      } else {
        const changes = prepared.preview.patch.changes;
        writeCliPresentation(
          presentDecision({
            title: "Profile approval preview",
            question: "Approve and apply this exact profile patch?",
            choices: [
              profileField("Approval bundle digest", bundle.sha256),
              profileField("Bundle path", resolve(request.bundlePath)),
              profileField("Patch digest", prepared.preview.patch.sha256),
              ...changes.map((change) =>
                profileField(change.key, `${change.before ?? "<unset>"} -> ${change.after}`),
              ),
              ...(changes.length === 0
                ? [profileField("Profile changes", "No profile fields change.")]
                : []),
              profileField(
                "Rollback boundary",
                "Rollback restores only these fields and is refused after any owner edit or replacement.",
              ),
            ],
            selected: { state: "known", value: "Not applied; configuration is unchanged." },
            actions: [
              {
                kind: "instruction",
                text: "Review this bundle and patch. To apply, rerun without signing inputs, add --apply, confirm the exact bundle and patch digests with --confirm-bundle-sha256 and --confirm-patch-sha256, and supply the required --receipt path.",
              },
            ],
            attention: null,
          }),
        );
      }
      return;
    }
    const receipt = await applyProfileConfiguration({
      prepared,
      confirmPatchSha256: request.confirmPatchSha256!,
      inspection,
      approvalBundle: bundle,
      authority,
      ambientEnvironment: process.env,
      now,
      receiptPath: resolve(request.receiptPath!),
    });
    if (request.json) {
      console.log(canonicalizeJsonEvidence(receipt as unknown as JsonEvidenceValue));
    } else {
      const receiptPath = resolve(request.receiptPath!);
      writeCliPresentation(
        presentResult({
          title: "Profile apply",
          outcome: profileField(
            "Apply",
            `${receipt.applied ? "Applied" : "Already current"}: ${receipt.sha256}`,
          ),
          effects: [profileField("Receipt", receiptPath, "material")],
          primaryAction: {
            kind: "argv",
            label: "Preview rollback",
            executable: "docsfab",
            args: ["profile", "rollback", "--receipt", receiptPath],
          },
          attention: null,
        }),
      );
    }
    return;
  }
  if (args[0] === "rollback") {
    const request = parseProfileRollbackArguments(args.slice(1));
    const root = resolveDocsFabConfigurationRoot();
    const receipt = await loadProfileApplyReceipt(resolve(request.receiptPath));
    const rollbackReceiptTarget = request.rollbackReceiptPath
      ? resolve(request.rollbackReceiptPath)
      : undefined;
    if (request.apply && rollbackReceiptTarget) {
      await assertSafeProfileReceiptTarget({
        projectRoot: root,
        receiptPath: rollbackReceiptTarget,
      });
      const recovered = await recoverProfileTransaction({
        projectRoot: root,
        operation: "rollback",
        purpose: receipt.purpose,
        previewSha256: request.confirmRollbackSha256!,
        patchSha256: receipt.patchSha256,
        applyReceiptSha256: receipt.sha256,
        receiptPath: rollbackReceiptTarget,
      });
      if (recovered.status === "completed") {
        const rollbackReceipt = recovered.receipt;
        if (rollbackReceipt.kind !== "docsfab-profile-rollback-receipt") {
          throw new Error("Recovered transaction has the wrong receipt kind.");
        }
        if (request.json) {
          console.log(canonicalizeJsonEvidence(rollbackReceipt as unknown as JsonEvidenceValue));
        } else {
          writeCliPresentation(
            presentResult({
              title: "Profile rollback",
              outcome: profileField(
                "Rollback",
                `Recovered completed rollback: ${rollbackReceipt.sha256}`,
              ),
              effects: [profileField("Receipt", rollbackReceiptTarget, "material")],
              attention: null,
            }),
          );
        }
        return;
      }
    }
    if (request.apply && rollbackReceiptTarget && existsSync(rollbackReceiptTarget)) {
      const existing = await loadProfileRollbackReceipt(rollbackReceiptTarget);
      if (
        existing.applyReceiptSha256 !== receipt.sha256 ||
        existing.rollbackPreviewSha256 !== request.confirmRollbackSha256 ||
        existing.purpose !== receipt.purpose
      ) {
        throw new Error("Existing rollback receipt does not bind the exact confirmed operation.");
      }
      await verifyProfileRollbackReceiptPostimage({
        projectRoot: root,
        receiptPath: rollbackReceiptTarget,
        receipt: existing,
      });
      if (request.json) {
        console.log(canonicalizeJsonEvidence(existing as unknown as JsonEvidenceValue));
      } else {
        writeCliPresentation(
          presentResult({
            title: "Profile rollback",
            outcome: profileField(
              "Rollback",
              `Already rolled back; exact receipt replayed: ${existing.sha256}`,
            ),
            effects: [profileField("Receipt", rollbackReceiptTarget, "material")],
            attention: null,
          }),
        );
      }
      return;
    }
    const prepared = await prepareProfileRollback({ projectRoot: root, receipt });
    if (!request.apply) {
      if (request.json) {
        console.log(canonicalizeJsonEvidence(prepared.preview as unknown as JsonEvidenceValue));
      } else {
        writeCliPresentation(
          presentDecision({
            title: "Profile rollback preview",
            question: "Apply this exact rollback preview?",
            choices: [profileField("Rollback digest", prepared.preview.sha256)],
            selected: { state: "known", value: "Not applied; configuration is unchanged." },
            actions: [
              {
                kind: "instruction",
                text: "Review the rollback preview. To apply it, rerun with --apply, confirm this exact digest with --confirm-rollback-sha256, and supply both required receipt paths with --receipt and --rollback-receipt.",
              },
            ],
            attention: null,
          }),
        );
      }
      return;
    }
    const rollbackReceipt = await applyProfileRollback({
      prepared,
      receipt,
      confirmRollbackSha256: request.confirmRollbackSha256!,
      receiptPath: resolve(request.rollbackReceiptPath!),
      now: new Date(),
    });
    if (request.json) {
      console.log(canonicalizeJsonEvidence(rollbackReceipt as unknown as JsonEvidenceValue));
    } else {
      writeCliPresentation(
        presentResult({
          title: "Profile rollback",
          outcome: profileField("Rollback", `Applied: ${rollbackReceipt.sha256}`),
          effects: [profileField("Receipt", resolve(request.rollbackReceiptPath!), "material")],
          attention: null,
        }),
      );
    }
    return;
  }
  if (args[0] === "inspect") {
    const inspectionArgs = parseProfileInspectionArguments(args.slice(1));
    const endpoint = loadSelectedProfileInspectionEndpoint(inspectionArgs);
    if (!endpoint) return;
    const report = await inspectModelEndpointProfile(endpoint, inspectionArgs.purpose, {
      catalog: inspectionArgs.catalog,
    });
    const boundProfile = endpoint.compositionId;
    if (inspectionArgs.json) {
      console.log(serializeModelProfileInspection(report));
    } else {
      writeCliPresentation(projectProfileInspection(report, inspectionArgs.verbose, boundProfile));
    }
    return;
  }
  if (args[0] === "probe") {
    const request = parseProfileProbeArguments(args.slice(1));
    const observation = await runProfileProbe(request);
    if (request.json) console.log(serializeProfileProbeObservation(observation));
    else writeCliPresentation(projectProfileProbe(observation));
    return;
  }
  if (args[0] === "draft") {
    const request = parseProfileDraftArguments(args.slice(1));
    const draft = await runProfileDraft(request);
    if (request.json) console.log(serializeProfileDraft(draft));
    else writeCliPresentation(projectProfileDraft(draft));
    return;
  }
  throw new ProfileCliUsageError(
    'profile requires the "inspect", "approve", "rollback", "seed", "probe", or "draft" subcommand.',
  );
}

function decodeProfileOwnerText(
  bytes: Uint8Array,
  artifact: "public signing key" | "private signing key",
): string {
  try {
    return decodeHostText(bytes);
  } catch {
    throw new ProfileOwnerArtifactOperatorError(artifact);
  }
}

function printSeedReceipt(
  json: boolean,
  receipt: ProfileSeedReceiptV1,
  receiptPath: string,
  replayed: boolean,
): void {
  if (json) {
    console.log(serializeProfileSeedReceipt(receipt));
  } else {
    writeCliPresentation(
      presentResult({
        title: "Profile seed",
        outcome: profileField(
          "Seed",
          `${receipt.applied && !replayed ? "Seeded" : "Already current"}: ${receipt.sha256}`,
        ),
        effects: [profileField("Receipt", receiptPath, "material")],
        attention: null,
      }),
    );
  }
}
