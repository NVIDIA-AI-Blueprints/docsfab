// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { lstat, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { canonicalDigest, createContractKit, deepFreeze } from "../contract-kit/index.js";
import { detectCredentialRuleIdsInValue } from "../security/repository-scanner.js";
import { NativePilotContractError } from "./pilot-contracts.js";
import { NATIVE_PILOT_ATTEMPT_RECEIPT_KIND } from "./pilot-runner-constants.js";
import {
  NativePilotRunnerError,
  fail,
  type NativePilotRunnerErrorCode,
} from "./pilot-runner-error.js";
import {
  assertNoSymlinkAncestors,
  compareText,
  readBoundedRegularFile,
  sha256,
} from "./pilot-paths.js";
import { gitPatch, snapshotRepository } from "./pilot-repository.js";
import type {
  AttemptPrivateState,
  NativePilotAggregateUsageV1,
  NativePilotAttemptReceiptV1,
  NativePilotFailurePhase,
  PrivateArtifactLedgerEntry,
  RunnerState,
} from "./pilot-runner.js";

export const kit = createContractKit<NativePilotRunnerErrorCode>({
  fail,
  inertMode: "strict",
  codes: {
    invalidShape: "invalid-shape",
    invalidValue: "invalid-value",
    digestMismatch: "attempt-binding-mismatch",
    credentialMaterial: "credential-material",
    schemaMismatch: "migration-required",
  },
});

export const attemptAuthorities = new WeakMap<object, AttemptPrivateState>();

export function zeroAggregateUsage(): NativePilotAggregateUsageV1 {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoningOutput: 0, total: 0 };
}

export function phaseForStep(index: number): NativePilotFailurePhase {
  if (index < 1) return "before-write";
  if (index === 1) return "during-write";
  return "after-write";
}

export function failureCode(error: unknown): string {
  if (error instanceof NativePilotRunnerError || error instanceof NativePilotContractError) {
    const code: string = error.code;
    return /^[a-z][a-z0-9-]{0,63}$/u.test(code) ? code : "host-operation-failed";
  }
  if (error instanceof Error && "code" in error && typeof error.code === "string") {
    return /^[a-z][a-z0-9-]{0,63}$/u.test(error.code) ? error.code : "host-operation-failed";
  }
  return "host-operation-failed";
}

export function sealAttemptReceipt(
  body: Omit<NativePilotAttemptReceiptV1, "schemaVersion" | "kind" | "receiptSha256">,
): NativePilotAttemptReceiptV1 {
  if (detectCredentialRuleIdsInValue(body).length > 0) fail("credential-material");
  return deepFreeze(
    kit.seal(
      NATIVE_PILOT_ATTEMPT_RECEIPT_KIND,
      "receiptSha256",
      body,
    ) as NativePilotAttemptReceiptV1,
  );
}

export async function registerAttempt(
  state: RunnerState,
  receipt: NativePilotAttemptReceiptV1,
  repository: string,
  documentBytes: Buffer | null,
  attemptRoot: string,
): Promise<NativePilotAttemptReceiptV1> {
  const repositorySnapshot = await snapshotRepository(repository);
  const artifactLedger = await buildPrivateArtifactLedger(attemptRoot, repository);
  const documentCopy = documentBytes === null ? null : Buffer.from(documentBytes);
  const attestationSha256 = attemptAttestationSha256({
    receipt,
    repositorySha256: repositorySnapshot.sha256,
    documentBytes: documentCopy,
    authorIdentities: receipt.authorExecutionIdentitySha256s,
    artifactLedger,
    campaignNonceSha256: state.campaignNonceSha256,
  });
  const privateState: AttemptPrivateState = {
    runner: state.runnerKey,
    receipt,
    repository,
    attemptRoot,
    documentBytes: documentCopy,
    authorIdentities: Object.freeze([...receipt.authorExecutionIdentitySha256s]),
    repositorySha256: repositorySnapshot.sha256,
    artifactLedger,
    attestationSha256,
    consumed: false,
    verifyCurrent: () =>
      attestationSha256 ===
      attemptAttestationSha256({
        receipt: privateState.receipt,
        repositorySha256: privateState.repositorySha256,
        documentBytes: privateState.documentBytes,
        authorIdentities: privateState.authorIdentities,
        artifactLedger: privateState.artifactLedger,
        campaignNonceSha256: state.campaignNonceSha256,
      }),
  };
  attemptAuthorities.set(receipt, privateState);
  return receipt;
}

export async function buildPrivateArtifactLedger(
  attemptRoot: string,
  repository: string,
): Promise<readonly PrivateArtifactLedgerEntry[]> {
  await assertNoSymlinkAncestors(attemptRoot);
  const rootMetadata = await lstat(attemptRoot);
  const rootOwner = typeof process.getuid === "function" ? process.getuid() : rootMetadata.uid;
  if (
    rootMetadata.isSymbolicLink() ||
    !rootMetadata.isDirectory() ||
    rootMetadata.uid !== rootOwner ||
    (rootMetadata.mode & 0o077) !== 0
  ) {
    fail("artifact-permissions-invalid");
  }
  const entries: PrivateArtifactLedgerEntry[] = [];
  const visit = async (directory: string): Promise<void> => {
    const children = await readdir(directory, { withFileTypes: true });
    children.sort((left, right) => compareText(left.name, right.name));
    for (const child of children) {
      const path = join(directory, child.name);
      if (path === repository) continue;
      const metadata = await lstat(path);
      if (metadata.isSymbolicLink()) fail("re-attestation-failed");
      if (metadata.isDirectory()) {
        const owner = typeof process.getuid === "function" ? process.getuid() : metadata.uid;
        if (metadata.uid !== owner || (metadata.mode & 0o077) !== 0) {
          fail("artifact-permissions-invalid");
        }
        entries.push({
          path,
          kind: "directory",
          sha256: null,
          mode: metadata.mode & 0o777,
          allowEmpty: true,
        });
        await visit(path);
        continue;
      }
      if (!metadata.isFile() || metadata.nlink !== 1) fail("re-attestation-failed");
      const owner = typeof process.getuid === "function" ? process.getuid() : metadata.uid;
      if (metadata.uid !== owner || (metadata.mode & 0o077) !== 0) {
        fail("artifact-permissions-invalid");
      }
      const bytes = await readFile(path);
      entries.push({
        path,
        kind: "file",
        sha256: sha256(bytes),
        mode: metadata.mode & 0o777,
        allowEmpty: bytes.byteLength === 0,
      });
    }
  };
  await visit(attemptRoot);
  entries.sort((left, right) => compareText(left.path, right.path));
  return deepFreeze(entries);
}

function attemptAttestationSha256(input: {
  readonly receipt: NativePilotAttemptReceiptV1;
  readonly repositorySha256: string;
  readonly documentBytes: Buffer | null;
  readonly authorIdentities: readonly string[];
  readonly artifactLedger: readonly PrivateArtifactLedgerEntry[];
  readonly campaignNonceSha256: string;
}): string {
  return canonicalDigest({
    receiptSha256: input.receipt.receiptSha256,
    repositorySha256: input.repositorySha256,
    documentSha256: input.documentBytes === null ? null : sha256(input.documentBytes),
    authorIdentities: input.authorIdentities,
    artifactLedger: input.artifactLedger,
    campaignNonceSha256: input.campaignNonceSha256,
  });
}

export async function reattestAttempt(
  state: RunnerState,
  attempt: AttemptPrivateState,
): Promise<void> {
  if (!attempt.verifyCurrent() || attempt.runner !== state.runnerKey) {
    fail("re-attestation-failed");
  }
  const repositorySnapshot = await snapshotRepository(attempt.repository);
  if (repositorySnapshot.sha256 !== attempt.repositorySha256) fail("re-attestation-failed");
  const observedArtifactLedger = await buildPrivateArtifactLedger(
    attempt.attemptRoot,
    attempt.repository,
  );
  if (canonicalDigest(observedArtifactLedger) !== canonicalDigest(attempt.artifactLedger)) {
    fail("re-attestation-failed");
  }
  if (attempt.documentBytes !== null) {
    const document = await readBoundedRegularFile(
      join(attempt.repository, state.corpus.allowedPage),
      state.corpus.limits.maxResponseBytes,
    );
    if (!document.equals(attempt.documentBytes)) fail("re-attestation-failed");
  }
  if (attempt.receipt.patchSha256 !== null && attempt.receipt.harnessId !== "pi") {
    const patch = await gitPatch(attempt.repository, state.corpus.allowedPage);
    if (sha256(patch) !== attempt.receipt.patchSha256) fail("re-attestation-failed");
  }
}
