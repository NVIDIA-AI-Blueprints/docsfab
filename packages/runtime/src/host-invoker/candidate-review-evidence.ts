// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";

import {
  candidateSourceManifestSha256V1,
  normalizeCandidateSourceManifestV1,
  type CandidateSourceChangeV1,
} from "../candidate-source-manifest.js";
import {
  credentialFindingsAt,
  recordCredentialFindings,
  ruleIdsInValue,
  screenCredentialText,
} from "../security/credential-shape-findings.js";
import { findConfiguredCredentialInValue } from "../security/configured-credentials.js";
import { detectCredentialRuleIds } from "../security/repository-scanner.js";
import type { CandidateReviewSourceEvidenceV1 } from "../execution/contracts.js";
import {
  HOST_RUNTIME_WRITE_OPERATIONS,
  type HostRuntimeWriteOperation,
} from "./write-authority.js";
import {
  bad,
  digest,
  enumeration,
  freezeDeep,
  id,
  objectId,
  record,
  sha,
  writePath,
} from "./wire-decode.js";
import { runTrustedGit } from "./trusted-git.js";

export interface HostRuntimeCandidateReviewTargetV1 {
  readonly path: string;
  readonly operations: readonly HostRuntimeWriteOperation[];
  readonly preimageObjectId: string | null;
}

export interface HostRuntimeCandidateReviewV1 {
  readonly schemaVersion: 1;
  readonly kind: "docsfab-candidate-review-binding";
  readonly requestKey: string;
  readonly sourceBaseRevision: string;
  readonly sourceHeadRevision: string;
  readonly sourceHeadTreeObjectId: string;
  readonly sourceManifestSha256: string;
  readonly sourceImpactSha256: string;
  readonly targetManifestSha256: string;
  readonly targets: readonly HostRuntimeCandidateReviewTargetV1[];
  readonly candidateTreeObjectId: string;
  readonly reviewCommitObjectId: string;
  readonly patchSha256: string;
  readonly policySha256: string;
  readonly contextAuthoritySha256: string;
  readonly authorRunRecordSha256: string;
  readonly authorDispatcherReceiptSha256: string;
  readonly authorExecutionIdentitySha256: string;
  readonly authorSessionSha256: string;
  readonly reviewerSessionSha256: string;
  readonly requestIdentitySha256: string;
  readonly bindingSha256: string;
}

/** Strict transport decoder for the candidate-review binding packet. */
export function parseCandidateReviewInput(input: unknown): HostRuntimeCandidateReviewV1 {
  const root = record(input, [
    "schemaVersion",
    "kind",
    "requestKey",
    "sourceBaseRevision",
    "sourceHeadRevision",
    "sourceHeadTreeObjectId",
    "sourceManifestSha256",
    "sourceImpactSha256",
    "targetManifestSha256",
    "targets",
    "candidateTreeObjectId",
    "reviewCommitObjectId",
    "patchSha256",
    "policySha256",
    "contextAuthoritySha256",
    "authorRunRecordSha256",
    "authorDispatcherReceiptSha256",
    "authorExecutionIdentitySha256",
    "authorSessionSha256",
    "reviewerSessionSha256",
    "requestIdentitySha256",
    "bindingSha256",
  ]);
  if (root.schemaVersion !== 1 || root.kind !== "docsfab-candidate-review-binding")
    bad("invalid-candidate-review");
  if (!Array.isArray(root.targets) || root.targets.length < 1 || root.targets.length > 512)
    bad("invalid-candidate-review");
  const targets = root.targets.map((value) => {
    const target = record(value, ["path", "operations", "preimageObjectId"]);
    const path = writePath(target.path, false);
    if (
      !Array.isArray(target.operations) ||
      target.operations.length < 1 ||
      target.operations.length > 3
    )
      bad("invalid-candidate-review");
    const operations = target.operations.map((operation) =>
      enumeration(operation, HOST_RUNTIME_WRITE_OPERATIONS),
    );
    if (new Set(operations).size !== operations.length) bad("invalid-candidate-review");
    const preimageObjectId =
      target.preimageObjectId === null ? null : objectId(target.preimageObjectId);
    if ((preimageObjectId === null) !== (operations.length === 1 && operations[0] === "add"))
      bad("invalid-candidate-review");
    return Object.freeze({ path, operations: Object.freeze(operations), preimageObjectId });
  });
  if (new Set(targets.map((target) => target.path)).size !== targets.length)
    bad("invalid-candidate-review");
  const body = {
    schemaVersion: 1 as const,
    kind: "docsfab-candidate-review-binding" as const,
    requestKey: id(root.requestKey),
    sourceBaseRevision: objectId(root.sourceBaseRevision),
    sourceHeadRevision: objectId(root.sourceHeadRevision),
    sourceHeadTreeObjectId: objectId(root.sourceHeadTreeObjectId),
    sourceManifestSha256: sha(root.sourceManifestSha256),
    sourceImpactSha256: sha(root.sourceImpactSha256),
    targetManifestSha256: sha(root.targetManifestSha256),
    targets: Object.freeze(targets),
    candidateTreeObjectId: objectId(root.candidateTreeObjectId),
    reviewCommitObjectId: objectId(root.reviewCommitObjectId),
    patchSha256: sha(root.patchSha256),
    policySha256: sha(root.policySha256),
    contextAuthoritySha256: sha(root.contextAuthoritySha256),
    authorRunRecordSha256: sha(root.authorRunRecordSha256),
    authorDispatcherReceiptSha256: sha(root.authorDispatcherReceiptSha256),
    authorExecutionIdentitySha256: sha(root.authorExecutionIdentitySha256),
    authorSessionSha256: sha(root.authorSessionSha256),
    reviewerSessionSha256: sha(root.reviewerSessionSha256),
    requestIdentitySha256: sha(root.requestIdentitySha256),
  };
  if (body.authorSessionSha256 === body.reviewerSessionSha256) bad("invalid-candidate-review");
  if (sha(root.bindingSha256) !== digest(body)) bad("candidate-review-digest-mismatch");
  return freezeDeep({ ...body, bindingSha256: digest(body) });
}

/** Where a changed path that only looks like a credential is recorded (#1807). */
export const CANDIDATE_REVIEW_MANIFEST_FINDING_LOCATION = "candidate-review:source-manifest";
export const CANDIDATE_REVIEW_SOURCE_MAXIMUM_FILE_BYTES = 96 * 1024;
export const CANDIDATE_REVIEW_SOURCE_MAXIMUM_TOTAL_BYTES = 128 * 1024;

export class CandidateReviewEvidenceError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(`Candidate review source evidence is unavailable: ${code}.`);
    this.name = "CandidateReviewEvidenceError";
    this.code = code;
  }
}

/** Resolve and bind the exact C..H source bytes before any reviewer harness runs. */
export async function assembleCandidateReviewEvidenceV1(input: {
  workspacePath: string;
  candidate: HostRuntimeCandidateReviewV1;
  signal?: AbortSignal;
}): Promise<CandidateReviewSourceEvidenceV1> {
  const { candidate } = input;
  const [head, reviewTree, parents, sourceHead, sourceTree, sourceBase] = await Promise.all([
    gitText(input, ["rev-parse", "--verify", "HEAD^{commit}"], 256),
    gitText(input, ["rev-parse", "--verify", `${candidate.reviewCommitObjectId}^{tree}`], 256),
    gitText(input, ["rev-list", "--parents", "-n", "1", candidate.reviewCommitObjectId], 512),
    gitText(input, ["rev-parse", "--verify", `${candidate.sourceHeadRevision}^{commit}`], 256),
    gitText(input, ["rev-parse", "--verify", `${candidate.sourceHeadRevision}^{tree}`], 256),
    gitText(input, ["rev-parse", "--verify", `${candidate.sourceBaseRevision}^{commit}`], 256),
  ]);
  if (
    head !== candidate.reviewCommitObjectId ||
    reviewTree !== candidate.candidateTreeObjectId ||
    parents !== `${candidate.reviewCommitObjectId} ${candidate.sourceHeadRevision}` ||
    sourceHead !== candidate.sourceHeadRevision ||
    sourceTree !== candidate.sourceHeadTreeObjectId ||
    sourceBase !== candidate.sourceBaseRevision
  )
    fail("identity-mismatch");
  await git(
    input,
    ["merge-base", "--is-ancestor", candidate.sourceBaseRevision, candidate.sourceHeadRevision],
    256,
  ).catch(() => fail("ancestry-mismatch"));
  const diff = await git(
    input,
    [
      "diff",
      "--name-status",
      "-z",
      "-M",
      "--no-ext-diff",
      "--no-textconv",
      candidate.sourceBaseRevision,
      candidate.sourceHeadRevision,
      "--",
    ],
    1024 * 1024,
  );
  const changes = parseSourceDiff(diff.toString("utf8"));
  if (candidateSourceManifestSha256V1(changes, manifestHooks) !== candidate.sourceManifestSha256)
    fail("manifest-mismatch");
  // A changed path that only looks like a credential is reviewed. Its rule is
  // recorded once, without the path, because the worker's standard error is
  // screened by shape (#1807).
  recordCredentialFindings(
    credentialFindingsAt(
      CANDIDATE_REVIEW_MANIFEST_FINDING_LOCATION,
      ruleIdsInValue(changes, detectCredentialRuleIds),
    ),
  );

  let retainedBytes = 0;
  const evidenceChanges = [];
  for (const change of changes) {
    const before =
      change.status === "added"
        ? null
        : await readBlob(
            input,
            candidate.sourceBaseRevision,
            change.previousPath ?? change.path,
            "base",
          );
    const after =
      change.status === "deleted"
        ? null
        : await readBlob(input, candidate.sourceHeadRevision, change.path, "head");
    retainedBytes += (before?.byteLength ?? 0) + (after?.byteLength ?? 0);
    if (retainedBytes > CANDIDATE_REVIEW_SOURCE_MAXIMUM_TOTAL_BYTES) fail("aggregate-size");
    evidenceChanges.push(Object.freeze({ ...change, before, after }));
  }
  return Object.freeze({
    schemaVersion: 1 as const,
    kind: "docsfab-candidate-review-source-evidence" as const,
    source: Object.freeze({
      baseRevision: candidate.sourceBaseRevision,
      headRevision: candidate.sourceHeadRevision,
      headTreeObjectId: candidate.sourceHeadTreeObjectId,
      manifestSha256: candidate.sourceManifestSha256,
    }),
    candidate: Object.freeze({
      reviewCommitObjectId: candidate.reviewCommitObjectId,
      treeObjectId: candidate.candidateTreeObjectId,
      targetManifestSha256: candidate.targetManifestSha256,
    }),
    changes: Object.freeze(evidenceChanges),
  });
}

async function readBlob(
  input: Parameters<typeof assembleCandidateReviewEvidenceV1>[0],
  revision: string,
  path: string,
  side: "base" | "head",
) {
  const listing = await git(input, ["ls-tree", "-z", revision, "--", `:(literal)${path}`], 2048);
  const rows = listing.toString("utf8").split("\0").filter(Boolean);
  if (rows.length !== 1) fail("blob-unavailable");
  const match = /^([0-7]{6}) (blob) ([a-f0-9]{40}|[a-f0-9]{64})\t([^\0]+)$/u.exec(rows[0]!);
  if (!match || match[4] !== path || (match[1] !== "100644" && match[1] !== "100755"))
    fail("blob-unavailable");
  const objectId = match[3]!;
  const bytes = await git(
    input,
    ["cat-file", "blob", objectId],
    CANDIDATE_REVIEW_SOURCE_MAXIMUM_FILE_BYTES,
  ).catch(() => fail("file-size"));
  if (bytes.includes(0)) fail("unsupported-encoding");
  let content: string;
  try {
    content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    fail("unsupported-encoding");
  }
  if (!Buffer.from(content, "utf8").equals(bytes)) fail("unsupported-encoding");
  // DocsFab's own configured credential, matched exactly, refuses the review
  // evidence. Source that only looks like it carries a credential is reviewed,
  // and its rule is recorded without the text or the path (#1807).
  if (
    screenCredentialText(content, `candidate-review:source-${side}`, detectCredentialRuleIds) !==
    null
  )
    fail("credential-material");
  return Object.freeze({
    revision,
    path,
    objectId,
    byteLength: bytes.byteLength,
    contentSha256: createHash("sha256").update(bytes).digest("hex"),
    content,
  });
}

function parseSourceDiff(output: string): readonly CandidateSourceChangeV1[] {
  const fields = output.split("\0");
  if (fields.pop() !== "") fail("manifest-unavailable");
  const changes: CandidateSourceChangeV1[] = [];
  for (let index = 0; index < fields.length; ) {
    const status = fields[index++];
    const firstPath = fields[index++];
    if (!status || !firstPath) fail("manifest-unavailable");
    if (status === "A" || status === "M" || status === "D") {
      changes.push({
        path: firstPath,
        status: status === "A" ? "added" : status === "D" ? "deleted" : "modified",
        previousPath: null,
      });
      continue;
    }
    if (/^R[0-9]{1,3}$/u.test(status)) {
      const path = fields[index++];
      if (!path) fail("manifest-unavailable");
      changes.push({ path, status: "renamed", previousPath: firstPath });
      continue;
    }
    fail("unsupported-change");
  }
  return normalizeCandidateSourceManifestV1(changes, manifestHooks);
}

const manifestHooks = {
  fail(code: "invalid-shape" | "invalid-value" | "credential-material"): never {
    fail(code === "credential-material" ? code : "manifest-unavailable");
  },
  // Only DocsFab's own configured credential refuses a changed path (#1807).
  // A path that only looks like a credential is flagged once, after parsing.
  rejectCredentials(value: unknown): void {
    if (findConfiguredCredentialInValue(value) !== null) fail("credential-material");
  },
};

async function gitText(
  input: Parameters<typeof assembleCandidateReviewEvidenceV1>[0],
  args: readonly string[],
  maximumBytes: number,
): Promise<string> {
  return (await git(input, args, maximumBytes)).toString("utf8").trim();
}

function git(
  input: Parameters<typeof assembleCandidateReviewEvidenceV1>[0],
  args: readonly string[],
  maximumBytes: number,
): Promise<Buffer> {
  return runTrustedGit(input.workspacePath, args, input.signal, maximumBytes).catch(() =>
    fail("git-unavailable"),
  );
}

function fail(code: string): never {
  throw new CandidateReviewEvidenceError(code);
}
