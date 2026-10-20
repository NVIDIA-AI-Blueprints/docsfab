// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** Host-resolved immutable native input bytes; selected task data is never authority. */
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { join } from "node:path";
import { createContractKit, deepFreeze, canonicalDigest } from "../contract-kit/index.js";
import {
  parseHostRuntimeApprovedModelReference,
  type HostRuntimeApprovedModelReferenceV1,
} from "./approved-model.js";
import { HostRuntimeContractError } from "./contract-error.js";
import {
  parseHostRuntimeNativeTask,
  type HostRuntimeNativeTaskV1,
  type HostRuntimeResolvedNativeInputV1,
} from "./native-task.js";

export interface HostRuntimeNativeCustodyV1 {
  readonly schemaVersion: 1;
  readonly kind: "docsfab-host-native-custody";
  readonly binding: {
    readonly deploymentId: string;
    readonly projectId: string;
    readonly deploymentEpoch: string;
  };
  readonly nativeTaskSha256: string;
  readonly repositoryIdentitySha256: string;
  readonly approvedCanonSha256: string;
  /**
   * The admitted approved-model baseline staged privately for this job. Absent
   * when no admitted generation names the frozen canon; that is not a custody
   * failure, so the worker still runs.
   */
  readonly approvedModel?: HostRuntimeApprovedModelReferenceV1;
  readonly inputs: readonly {
    readonly recordKey: string;
    readonly contentSha256: string;
    /** Exact size authenticated by the accepted producer manifest. */
    readonly bytes: number;
    /**
     * Signed-plan provenance when the host imported this row through the
     * approval ledger; absent for a producer output selected by its own receipt.
     */
    readonly approvedImport?: HostRuntimeResolvedNativeInputV1["approvedImport"];
    readonly source: HostRuntimeResolvedNativeInputV1["source"];
  }[];
  readonly custodySha256: string;
}

function fail(code: string): never {
  throw new HostRuntimeContractError(`native-custody-${code}`);
}
const kit = createContractKit({
  fail,
  inertMode: "strict",
  codes: {
    invalidShape: "invalid-shape",
    invalidValue: "invalid-value",
    digestMismatch: "digest-mismatch",
    credentialMaterial: "credential-material",
    schemaMismatch: "schema-version",
  },
});

/**
 * Inert provenance codec for one selected input's `source`, shared with the
 * host's approved-import receipt. A decoded value is not proof of custody.
 */
export function parseHostRuntimeNativeSource(
  value: unknown,
  expected?: { readonly receiptPrefix: string; readonly repositoryIdentitySha256: string },
): HostRuntimeResolvedNativeInputV1["source"] {
  const source = kit.object(value);
  kit.exact(source, [
    "requestKey",
    "runId",
    "principalId",
    "workflow",
    "revision",
    "repositoryIdentitySha256",
    "receiptLocator",
    "receiptSha256",
  ]);
  const receiptLocator = kit.string(source.receiptLocator),
    receiptSha256 = kit.hash(source.receiptSha256);
  // Custody supplies its receipt prefix and sealed repository identity. The host
  // receipt codec supplies neither and binds the locator itself; it still gets
  // the shape and digest-suffix checks.
  if (
    !/^cas:[a-f0-9]{32}:[a-f0-9]{64}$/u.test(receiptLocator) ||
    (expected !== undefined && !receiptLocator.startsWith(expected.receiptPrefix)) ||
    !receiptLocator.endsWith(`:${receiptSha256}`)
  )
    fail("receipt-binding");
  const repositoryIdentitySha256 = kit.hash(source.repositoryIdentitySha256);
  if (expected !== undefined && repositoryIdentitySha256 !== expected.repositoryIdentitySha256)
    fail("repository-binding");
  return {
    requestKey: kit.identifier(source.requestKey),
    runId: kit.identifier(source.runId),
    principalId: kit.identifier(source.principalId),
    workflow: kit.identifier(source.workflow),
    revision: kit.revision(source.revision),
    repositoryIdentitySha256,
    receiptLocator,
    receiptSha256,
  };
}

function normalize(root: Record<string, unknown>) {
  kit.exact(
    root,
    [
      "binding",
      "nativeTaskSha256",
      "repositoryIdentitySha256",
      "approvedCanonSha256",
      "inputs",
      "approvedModel",
    ],
    ["approvedModel"],
  );
  const rawBinding = kit.object(root.binding);
  kit.exact(rawBinding, ["deploymentId", "projectId", "deploymentEpoch"]);
  const binding = {
    deploymentId: kit.identifier(rawBinding.deploymentId),
    projectId: kit.identifier(rawBinding.projectId),
    deploymentEpoch: kit.identifier(rawBinding.deploymentEpoch),
  };
  const receiptPrefix = `cas:${canonicalDigest(binding).slice(0, 32)}:`;
  const repositoryIdentitySha256 = kit.hash(root.repositoryIdentitySha256);
  const inputs = kit.array(root.inputs).map((value) => {
    const row = kit.object(value);
    kit.exact(
      row,
      ["recordKey", "contentSha256", "bytes", "source", "approvedImport"],
      ["approvedImport"],
    );
    // An approval-ledger row: every proof field is re-derived, and the locator
    // must be this deployment's receipt prefix plus the proof's own receipt
    // digest, so an import cannot name another deployment's or approval's
    // receipt. A row without `approvedImport` keeps its bytes and digest.
    let approvedImport: HostRuntimeResolvedNativeInputV1["approvedImport"];
    if (row.approvedImport !== undefined) {
      const proof = kit.object(row.approvedImport);
      kit.exact(proof, [
        "kind",
        "receiptLocator",
        "receiptSha256",
        "authorityReceiptSha256",
        "reviewerPolicySha256",
        "reviewerPolicyContentSha256",
        "reviewerPolicyBytes",
      ]);
      const proofReceiptSha256 = kit.hash(proof.receiptSha256);
      if (
        proof.kind !== "site-bootstrap-approval" ||
        proof.receiptLocator !== receiptPrefix + proofReceiptSha256 ||
        !Number.isSafeInteger(proof.reviewerPolicyBytes) ||
        // Not a size bound: a zero-byte policy is no policy. The catalogued
        // maximum lives with its reader in the site arm.
        (proof.reviewerPolicyBytes as number) < 1
      )
        fail("approved-import-binding");
      approvedImport = {
        kind: "site-bootstrap-approval",
        receiptLocator: proof.receiptLocator as string,
        receiptSha256: proofReceiptSha256,
        authorityReceiptSha256: kit.hash(proof.authorityReceiptSha256),
        reviewerPolicySha256: kit.hash(proof.reviewerPolicySha256),
        reviewerPolicyContentSha256: kit.hash(proof.reviewerPolicyContentSha256),
        reviewerPolicyBytes: proof.reviewerPolicyBytes as number,
      };
    }
    const source = parseHostRuntimeNativeSource(row.source, {
      receiptPrefix,
      repositoryIdentitySha256,
    });
    const contentSha256 = kit.hash(row.contentSha256);
    if (!Number.isSafeInteger(row.bytes) || (row.bytes as number) < 1) fail("content-size");
    return {
      recordKey: kit.hash(row.recordKey),
      contentSha256,
      bytes: row.bytes as number,
      ...(approvedImport ? { approvedImport } : {}),
      source,
    };
  });
  return {
    binding,
    nativeTaskSha256: kit.hash(root.nativeTaskSha256),
    repositoryIdentitySha256,
    approvedCanonSha256: kit.hash(root.approvedCanonSha256),
    inputs,
    // Absent stays absent rather than a null key, so a record without a
    // baseline keeps its digest.
    ...(root.approvedModel === undefined
      ? {}
      : { approvedModel: parseHostRuntimeApprovedModelReference(root.approvedModel) }),
  };
}

function assertSelected(custody: HostRuntimeNativeCustodyV1, task: HostRuntimeNativeTaskV1): void {
  const parsedTask = parseHostRuntimeNativeTask(task);
  // A registered import is selected by the ledger receipt the host wrote, not
  // by the producing job's own receipt: the approving operator is not the
  // producer. Every other row keeps selecting by its producer receipt.
  const keys = custody.inputs.map(
    (input) =>
      `${input.approvedImport?.receiptLocator ?? input.source.receiptLocator}:${input.contentSha256}`,
  );
  if (
    // Only `site-bootstrap` consumes an approval-ledger row; under any other
    // workflow it is a mis-bound record.
    (custody.inputs.some((input) => input.approvedImport) &&
      parsedTask.workflow !== "site-bootstrap") ||
    custody.nativeTaskSha256 !== parsedTask.taskSha256 ||
    keys.length !== parsedTask.inputs.length ||
    new Set(keys).size !== keys.length ||
    parsedTask.inputs.some(
      (input) => !keys.includes(`${input.receiptLocator}:${input.artifactSha256}`),
    )
  ) {
    fail("task-input-binding");
  }
}

export function sealHostRuntimeNativeCustody(input: {
  readonly task: HostRuntimeNativeTaskV1;
  readonly binding: HostRuntimeNativeCustodyV1["binding"];
  readonly repositoryIdentitySha256: string;
  readonly approvedCanonSha256: string;
  readonly approvedModel?: HostRuntimeApprovedModelReferenceV1;
  readonly inputs: HostRuntimeNativeCustodyV1["inputs"];
}): HostRuntimeNativeCustodyV1 {
  const body = {
    binding: { ...input.binding },
    nativeTaskSha256: input.task.taskSha256,
    repositoryIdentitySha256: input.repositoryIdentitySha256,
    approvedCanonSha256: input.approvedCanonSha256,
    inputs: input.inputs,
    ...(input.approvedModel ? { approvedModel: input.approvedModel } : {}),
  };
  kit.assertInert(body);
  kit.rejectCredentials(body);
  const sealed = kit.seal(
    "docsfab-host-native-custody",
    "custodySha256",
    normalize(body),
  ) as HostRuntimeNativeCustodyV1;
  assertSelected(sealed, input.task);
  return deepFreeze(sealed);
}

export function parseHostRuntimeNativeCustody(
  value: unknown,
  task: HostRuntimeNativeTaskV1,
): HostRuntimeNativeCustodyV1 {
  const parsed = kit.decodeSealed(
    value,
    "docsfab-host-native-custody",
    "custodySha256",
    [
      "binding",
      "nativeTaskSha256",
      "repositoryIdentitySha256",
      "approvedCanonSha256",
      "inputs",
      // The digest is recomputed over this key list, so it follows the record
      // rather than always declaring the optional key.
      ...(Object.hasOwn(kit.object(value), "approvedModel") ? ["approvedModel"] : []),
    ],
    normalize,
  ) as HostRuntimeNativeCustodyV1;
  assertSelected(parsed, task);
  return deepFreeze(parsed);
}

/** Metadata only: large accepted packages never pass through a JSON scalar carrier. */
export function describeHostRuntimeNativeInput(
  input: HostRuntimeResolvedNativeInputV1,
): HostRuntimeNativeCustodyV1["inputs"][number] {
  if (createHash("sha256").update(input.bytes).digest("hex") !== input.contentSha256)
    fail("content-digest");
  return {
    recordKey: input.recordKey,
    contentSha256: input.contentSha256,
    bytes: input.bytes.byteLength,
    ...(input.approvedImport ? { approvedImport: { ...input.approvedImport } } : {}),
    source: { ...input.source },
  };
}

/** Load one fixed host-staged file lazily, verifying the authenticated metadata. */
export async function loadHostRuntimeNativeCustodyInput(
  value: HostRuntimeNativeCustodyV1,
  task: HostRuntimeNativeTaskV1,
  reference: HostRuntimeNativeTaskV1["inputs"][number],
  stateDirectory: string,
): Promise<HostRuntimeResolvedNativeInputV1> {
  const custody = parseHostRuntimeNativeCustody(value, task);
  const selected = custody.inputs.find(
    (input) =>
      (input.approvedImport?.receiptLocator ?? input.source.receiptLocator) ===
        reference.receiptLocator && input.contentSha256 === reference.artifactSha256,
  );
  if (!selected) fail("input-not-selected");
  const bytes = await loadHostRuntimeNativeBytes(
    stateDirectory,
    selected.contentSha256,
    selected.bytes,
  );
  return { ...selected, bytes };
}

/**
 * Fixed private leaf reader shared by selected native records and the staged
 * approved-model baseline.
 *
 * The caller has already authenticated `contentSha256` and `expectedBytes` out
 * of a sealed custody record; this reader proves the bytes on disk still are
 * those and nothing else. It never discovers a file: the digest names it.
 */
export async function loadHostRuntimeNativeBytes(
  stateDirectory: string,
  contentSha256: string,
  expectedBytes: number,
): Promise<Uint8Array> {
  kit.hash(contentSha256);
  if (!Number.isSafeInteger(expectedBytes) || expectedBytes < 1) fail("content-size");
  const directory = join(stateDirectory, "native-inputs");
  for (const path of [stateDirectory, directory]) {
    const stat = await lstat(path);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      stat.uid !== process.getuid?.() ||
      (stat.mode & 0o777) !== 0o700
    )
      fail("input-directory");
  }
  const handle = await open(
    join(directory, contentSha256 + ".json"),
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  try {
    const before = await handle.stat();
    if (
      !before.isFile() ||
      before.uid !== process.getuid?.() ||
      before.nlink !== 1 ||
      (before.mode & 0o777) !== 0o600 ||
      before.size !== expectedBytes
    )
      fail("input-file");
    const bytes = Buffer.allocUnsafe(before.size);
    let offset = 0;
    while (offset < bytes.length) {
      const read = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (!read.bytesRead) fail("input-changed");
      offset += read.bytesRead;
    }
    const after = await handle.stat();
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs ||
      createHash("sha256").update(bytes).digest("hex") !== contentSha256
    )
      fail("input-changed");
    return bytes;
  } finally {
    await handle.close();
  }
}
