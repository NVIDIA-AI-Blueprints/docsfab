// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { readFile } from "node:fs/promises";

import {
  applyProfileConfiguration,
  applyProfileRollback,
  loadProfileApplyReceipt,
  prepareProfileApply,
  prepareProfileRollback,
  readOwnerHostFile,
} from "../src/model/profile-apply.js";

interface CrashInput {
  operation: "apply" | "rollback";
  root: string;
  purpose: "policy" | "judge";
  inspectionPath: string;
  bundlePath: string;
  publicKeyPath: string;
  authorityId: string;
  applyReceiptPath: string;
  outputReceiptPath: string;
  now: string;
  crashPoint: "after-intent" | "after-rename" | "after-receipt-link" | "after-receipt";
}

const input = JSON.parse(await readFile(process.argv[2]!, "utf8")) as CrashInput;
const authority = {
  id: input.authorityId,
  publicKey: new TextDecoder("utf-8", { fatal: true }).decode(
    await readOwnerHostFile(input.publicKeyPath),
  ),
};

if (input.operation === "apply") {
  const inspection = await readOwnerHostFile(input.inspectionPath);
  const bundle = await readOwnerHostFile(input.bundlePath);
  const prepared = await prepareProfileApply({
    projectRoot: input.root,
    purpose: input.purpose,
    inspection,
    approvalBundle: bundle,
    authority,
    ambientEnvironment: {},
    now: new Date(input.now),
  });
  await applyProfileConfiguration({
    prepared,
    confirmPatchSha256: prepared.preview.patch.sha256,
    inspection,
    approvalBundle: bundle,
    authority,
    ambientEnvironment: {},
    now: new Date(input.now),
    receiptPath: input.outputReceiptPath,
    hooks: crashHooks(input.crashPoint),
  });
} else {
  const receipt = await loadProfileApplyReceipt(input.applyReceiptPath);
  const prepared = await prepareProfileRollback({ projectRoot: input.root, receipt });
  await applyProfileRollback({
    prepared,
    receipt,
    confirmRollbackSha256: prepared.preview.sha256,
    receiptPath: input.outputReceiptPath,
    now: new Date(input.now),
    hooks: crashHooks(input.crashPoint),
  });
}

throw new Error("Crash hook did not terminate the process.");

function crashHooks(point: CrashInput["crashPoint"]) {
  const kill = (): void => {
    process.kill(process.pid, "SIGKILL");
  };
  return {
    ...(point === "after-intent" ? { afterIntentSync: kill } : {}),
    ...(point === "after-rename" ? { afterRename: kill } : {}),
    ...(point === "after-receipt-link" ? { afterReceiptLink: kill } : {}),
    ...(point === "after-receipt" ? { afterReceiptPublish: kill } : {}),
  };
}
