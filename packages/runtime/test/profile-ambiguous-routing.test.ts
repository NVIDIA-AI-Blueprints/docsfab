// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";

const controls = vi.hoisted(() => ({
  readOwnerHostFile: vi.fn(),
  decodeModelProfileApprovalBundleAtCreation: vi.fn(),
  recoverProfileTransaction: vi.fn(),
  assertSafeProfileReceiptTarget: vi.fn(),
  loadProfileApplyReceipt: vi.fn(),
  loadProfileRollbackReceipt: vi.fn(),
}));

vi.mock("../src/config/host-paths.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/config/host-paths.js")>();
  return { ...actual, resolveDocsFabConfigurationRoot: () => "/tmp/docsfab-profile-owner-root" };
});

vi.mock("../src/model/profile-approval.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/model/profile-approval.js")>();
  return {
    ...actual,
    decodeModelProfileApprovalBundleAtCreation: controls.decodeModelProfileApprovalBundleAtCreation,
  };
});

vi.mock("../src/model/profile-apply.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/model/profile-apply.js")>();
  return {
    ...actual,
    readOwnerHostFile: controls.readOwnerHostFile,
    recoverProfileTransaction: controls.recoverProfileTransaction,
    assertSafeProfileReceiptTarget: controls.assertSafeProfileReceiptTarget,
    loadProfileApplyReceipt: controls.loadProfileApplyReceipt,
    loadProfileRollbackReceipt: controls.loadProfileRollbackReceipt,
  };
});

import { handleProfileCommand } from "../src/cli/commands/profile.js";
import {
  ProfileApplyAmbiguousError,
  ProfileOwnerArtifactOperatorError,
  ProfileRollbackAmbiguousError,
} from "../src/model/profile-apply/types.js";
import { toOperatorErrorEnvelope } from "../src/operator/error-envelope.js";

async function invokeProfileCommand(args: string[]): Promise<unknown> {
  return handleProfileCommand(args).then(
    () => undefined,
    (error: unknown) => error,
  );
}

function expectTransactionEvidencePreserved(action: string | undefined): void {
  expect(action).toContain("Do not retry");
  expect(action).toContain(".env.docsfab-apply.lock");
  expect(action).toContain(".env.docsfab-transaction.json");
  expect(action).toContain(".env.docsfab-recovery.claim");
  expect(action).toContain("owner reconcile");
  expect(action).toContain("before any further profile mutation");
}

describe("ambiguous profile transaction routing", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    controls.readOwnerHostFile.mockResolvedValue(new TextEncoder().encode("owner evidence"));
    controls.decodeModelProfileApprovalBundleAtCreation.mockReturnValue({
      sha256: "bundle-sha",
      inspectionSha256: "inspection-sha",
      patchSha256: "patch-sha",
      purpose: "policy",
    });
    controls.assertSafeProfileReceiptTarget.mockResolvedValue(undefined);
    controls.loadProfileApplyReceipt.mockResolvedValue({
      purpose: "policy",
      sha256: "apply-receipt-sha",
      patchSha256: "patch-sha",
    });
    controls.loadProfileRollbackReceipt.mockResolvedValue({
      purpose: "policy",
      sha256: "rollback-receipt-sha",
      patchSha256: "patch-sha",
    });
  });

  it("routes an ambiguous approval transaction through the executing handler", async () => {
    controls.recoverProfileTransaction.mockRejectedValueOnce(new ProfileApplyAmbiguousError());
    const error = await invokeProfileCommand([
      "approve",
      "--apply",
      "--inspection",
      "/tmp/inspection.json",
      "--authority-id",
      "owner",
      "--public-key",
      "/tmp/authority.pub",
      "--bundle",
      "/tmp/approval.json",
      "--confirm-bundle-sha256",
      "bundle-sha",
      "--confirm-patch-sha256",
      "patch-sha",
      "--receipt",
      "/tmp/apply-receipt.json",
    ]);

    expect(error).toBeInstanceOf(ProfileApplyAmbiguousError);
    const envelope = toOperatorErrorEnvelope(error);
    expect(envelope.code).toBe("profile-apply-ambiguous");
    expectTransactionEvidencePreserved(envelope.nextAction);
    expect(envelope.nextAction).not.toContain("docsfab profile approve");
    expect(controls.recoverProfileTransaction).toHaveBeenCalledWith(
      expect.objectContaining({ operation: "apply" }),
    );
  });

  it("routes an ambiguous rollback transaction through the executing handler", async () => {
    controls.recoverProfileTransaction.mockRejectedValueOnce(new ProfileRollbackAmbiguousError());
    const error = await invokeProfileCommand([
      "rollback",
      "--apply",
      "--receipt",
      "/tmp/apply-receipt.json",
      "--confirm-rollback-sha256",
      "rollback-preview-sha",
      "--rollback-receipt",
      "/tmp/rollback-receipt.json",
    ]);

    expect(error).toBeInstanceOf(ProfileRollbackAmbiguousError);
    const envelope = toOperatorErrorEnvelope(error);
    expect(envelope.code).toBe("profile-rollback-ambiguous");
    expectTransactionEvidencePreserved(envelope.nextAction);
    expect(envelope.nextAction).not.toContain("docsfab profile rollback");
    expect(controls.recoverProfileTransaction).toHaveBeenCalledWith(
      expect.objectContaining({ operation: "rollback" }),
    );
  });

  it("routes a non-UTF-8 signing-key artifact to owner repair through the handler", async () => {
    controls.readOwnerHostFile.mockImplementation(async (_path: string, artifact: string) =>
      artifact === "public signing key"
        ? new Uint8Array([0xff])
        : new TextEncoder().encode("owner evidence"),
    );
    const error = await invokeProfileCommand([
      "approve",
      "--inspection",
      "/tmp/inspection.json",
      "--proposal-sha256",
      "proposal-sha",
      "--effective-date",
      "2026-10-08",
      "--review-after",
      "2026-11-08",
      "--authority-id",
      "owner",
      "--public-key",
      "/tmp/authority.pub",
      "--private-key",
      "/tmp/authority.key",
      "--bundle",
      "/tmp/approval.json",
    ]);

    expect(error).toBeInstanceOf(ProfileOwnerArtifactOperatorError);
    const envelope = toOperatorErrorEnvelope(error);
    expect(envelope.code).toBe("profile-owner-artifact-rejected");
    expect(envelope.message).toContain("public signing key");
    expect(envelope.nextAction).toContain("owner verify the key identity");
    expect(envelope.nextAction).not.toContain("docsfab doctor");
    expect(envelope.nextAction).not.toContain("docsfab profile approve");
  });
});
