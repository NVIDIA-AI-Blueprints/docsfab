// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createContractKit, type ContractFail } from "../../contract-kit/index.js";
import { assertConfinedToolResultCredentialFree } from "../../security/credential-isolation.js";

type SourceSnapshotError = "invalid-shape" | "invalid-value";
const sourceSnapshotKit = createContractKit<SourceSnapshotError>({
  fail: ((code: SourceSnapshotError) => {
    throw new Error(
      `Source snapshot rejected: ${code}. Start a new session and reselect sources from the current checkout.`,
    );
  }) as ContractFail<SourceSnapshotError>,
  inertMode: "strict",
  codes: {
    invalidShape: "invalid-shape",
    invalidValue: "invalid-value",
    digestMismatch: "invalid-value",
    credentialMaterial: "invalid-value",
    schemaMismatch: "invalid-value",
  },
});

export interface DecodedSourceSnapshotV1 {
  readonly value: unknown;
  readonly records: readonly unknown[];
  readonly changeReviewReference?: string;
}

/** Decode the outer snapshot and record shapes before selection restoration. */
export function decodeSourceSnapshot(value: unknown): DecodedSourceSnapshotV1 {
  sourceSnapshotKit.assertInert(value);
  assertConfinedToolResultCredentialFree(value);
  const root = sourceSnapshotKit.object(value);
  sourceSnapshotKit.exact(root, [
    "schema_version",
    "entries",
    ...(Object.hasOwn(root, "changeReviewReference") ? ["changeReviewReference"] : []),
  ]);
  if (root.schema_version !== 1) sourceSnapshotKit.fail("invalid-value");
  if (
    Object.hasOwn(root, "changeReviewReference") &&
    typeof root.changeReviewReference !== "string"
  )
    sourceSnapshotKit.fail("invalid-value");
  const records = sourceSnapshotKit.array(root.entries);
  return Object.freeze({
    value,
    records,
    ...(typeof root.changeReviewReference === "string"
      ? { changeReviewReference: root.changeReviewReference }
      : {}),
  });
}

/** Decode one record at its original position in the restore sequence. */
export function decodeSourceSnapshotRecord(value: unknown): Record<string, unknown> {
  const item = sourceSnapshotKit.object(value);
  sourceSnapshotKit.exact(item, [
    "kind",
    "repositoryPath",
    "selector",
    "admission",
    "version",
    "status",
    "limitations",
    "refreshCount",
    "revalidationCount",
    "revalidation",
  ]);
  const admission = sourceSnapshotKit.object(item.admission);
  sourceSnapshotKit.exact(admission, [
    "kind",
    "label",
    "locator",
    "repositoryPath",
    "host",
    "projectPath",
    "projectId",
    "changeNumber",
    "format",
  ]);
  if (
    !Number.isSafeInteger(item.refreshCount) ||
    (item.refreshCount as number) < 0 ||
    !Number.isSafeInteger(item.revalidationCount) ||
    (item.revalidationCount as number) < 0 ||
    (item.version !== null && typeof item.version !== "string") ||
    !["attached", "drifted", "unavailable"].includes(item.status as string) ||
    !Array.isArray(item.limitations) ||
    item.limitations.some((entry) => typeof entry !== "string")
  )
    sourceSnapshotKit.fail("invalid-value");
  return item;
}

/** Check the exact private verdict shape; selection restoration checks its admissible pair. */
export function decodeSourceSnapshotVerdict(value: unknown): Record<string, unknown> {
  const verdict = sourceSnapshotKit.object(value);
  sourceSnapshotKit.exact(verdict, ["state", "basis", "atMs"]);
  return verdict;
}

export function failSourceSnapshot(code: SourceSnapshotError): never {
  return sourceSnapshotKit.fail(code);
}
