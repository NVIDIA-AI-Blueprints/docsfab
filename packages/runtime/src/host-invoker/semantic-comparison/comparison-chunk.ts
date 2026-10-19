// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";

import { SEMANTIC_INPUT_CAPACITY } from "../../live-agent/input-capacity.js";
import { deepFreezeGraph } from "../../contract-kit/freeze.js";
import { parseSemanticDocumentTargets } from "../semantic-document-projection.js";
import {
  bad,
  canonicalJson,
  containsCredentialDeep,
  digest,
  enumeration,
  id,
  nonnegative,
  positive,
  record,
  recordWithOptional,
  sha,
} from "../wire-decode.js";
import {
  parseHostRuntimeAcceptedEffectRevalidationData,
  parseHostRuntimeCorrectiveProposalRevalidationData,
} from "./accepted-effects.js";
import { assertHostRuntimeSemanticData } from "./inert-data.js";
import { HOST_RUNTIME_SEMANTIC_SOURCE_KINDS } from "./types.js";
import type {
  HostRuntimeAcceptedEffectRevalidation,
  HostRuntimeCorrectiveProposalRevalidationV1,
  HostRuntimeSemanticComparisonChunkV1,
  HostRuntimeSemanticMergeMessageV1,
} from "./types.js";

const OBJECT_ID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;

/**
 * The merge message a chunk may carry: exactly `{title, description}` strings, a non-empty
 * one-line title, no NUL and no credential shape under the chunk's own screen. Null for any
 * other value, so the host leaves the message out and the comparison judges no intent.
 */
export function admitHostRuntimeSemanticMergeMessage(
  input: unknown,
): HostRuntimeSemanticMergeMessageV1 | null {
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    Object.getPrototypeOf(input) !== Object.prototype
  )
    return null;
  const { title, description } = input as Record<string, unknown>;
  if (
    Object.keys(input).length !== 2 ||
    typeof title !== "string" ||
    typeof description !== "string" ||
    !title.trim() ||
    /[\r\n]/u.test(title) ||
    `${title}${description}`.includes("\0") ||
    containsCredentialDeep({ title, description }, "hosted-semantic:comparisonChunk")
  )
    return null;
  return Object.freeze({ title, description });
}

export function sealHostRuntimeSemanticComparisonChunk(
  input: Omit<HostRuntimeSemanticComparisonChunkV1, "inputSha256">,
  original?: (item: HostRuntimeSemanticComparisonChunkV1["evidence"][number]) => string | undefined,
): HostRuntimeSemanticComparisonChunkV1 {
  assertHostRuntimeSemanticData(input);
  const value = {
    ...input,
    inputSha256: digest(input),
  };
  return original
    ? qualifyHostRuntimeSemanticComparisonSources(value, original)
    : parseHostRuntimeSemanticComparisonChunk(value);
}

type SemanticSourceItem = HostRuntimeSemanticComparisonChunkV1["evidence"][number];
function semanticRepositorySourceItem(item: SemanticSourceItem): boolean {
  return (
    item.sourcePath !== null &&
    OBJECT_ID.test(item.version) &&
    ["repository-before", "repository-after", "supporting-context"].includes(item.kind)
  );
}

/** Structural data only. Execution still requires the default, qualified parser. */
export function parseHostRuntimeSemanticComparisonChunkData(
  input: unknown,
): HostRuntimeSemanticComparisonChunkV1 {
  return parseSemanticComparisonChunk(input, true);
}

/**
 * Source items that carry one of DocsFab's own configured credentials, matched
 * exactly. Text that only looks like a credential is not listed: the chunk
 * screen flags it and admits it (#1807).
 */
export function semanticComparisonSourceProofInputs(input: unknown): readonly SemanticSourceItem[] {
  const chunk = parseHostRuntimeSemanticComparisonChunkData(input);
  return chunk.evidence.filter((item) => containsCredentialDeep(item.content));
}

/**
 * Qualify a chunk's repository sources before execution. Full original bytes
 * once discharged source slots that only looked like a credential; under #1807
 * such text needs no proof, and the chunk screen flags it. A source item that
 * carries DocsFab's own configured credential is refused, because its original
 * carries the same credential. `original` stays for the existing callers.
 */
export function qualifyHostRuntimeSemanticComparisonSources(
  input: unknown,
  _original: (item: SemanticSourceItem) => string | undefined,
): HostRuntimeSemanticComparisonChunkV1 {
  const chunk = parseHostRuntimeSemanticComparisonChunkData(input);
  if (semanticComparisonSourceProofInputs(chunk).length > 0)
    bad("semantic-source-original-credential");
  return parseHostRuntimeSemanticComparisonChunk(chunk);
}

export function parseHostRuntimeSemanticComparisonChunk(
  input: unknown,
): HostRuntimeSemanticComparisonChunkV1 {
  return parseSemanticComparisonChunk(input, false);
}
function parseSemanticComparisonChunk(
  input: unknown,
  dataOnly: boolean,
): HostRuntimeSemanticComparisonChunkV1 {
  assertHostRuntimeSemanticData(input);
  const root = recordWithOptional(
    input,
    [
      "schemaVersion",
      "kind",
      "projectId",
      "caseKind",
      "caseSha256",
      "comparisonSha256",
      "baselineGeneration",
      "baselineSha256",
      "approvalReceiptSha256",
      "modelSha256",
      "canonSha256",
      "sourceInventorySha256",
      "ordinal",
      "chunkCount",
      "claims",
      "evidence",
      "inputSha256",
    ],
    [
      "acceptedEffectRevalidation",
      "correctiveProposalRevalidation",
      "repositoryObservationVersion",
      "documentTargets",
      "mergeMessage",
    ],
  );
  if (root.schemaVersion !== 1 || root.kind !== "docsfab-semantic-comparison-chunk")
    bad("semantic-input-kind");
  if (
    root.mergeMessage !== undefined &&
    canonicalJson(admitHostRuntimeSemanticMergeMessage(root.mergeMessage)) !==
      canonicalJson(root.mergeMessage)
  )
    bad("semantic-merge-message");
  const { inputSha256, ...body } = root;
  if (sha(inputSha256) !== digest(body)) bad("semantic-input-digest");
  if (root.documentTargets !== undefined) {
    if (root.acceptedEffectRevalidation !== undefined)
      bad("semantic-projection-is-not-effect-revalidation");
    parseSemanticDocumentTargets(root.documentTargets);
  }
  id(root.projectId);
  enumeration(root.caseKind, ["merge", "source-case"] as const);
  for (const key of [
    "caseSha256",
    "comparisonSha256",
    "baselineSha256",
    "approvalReceiptSha256",
    "modelSha256",
    "canonSha256",
    "sourceInventorySha256",
  ])
    sha(root[key]);
  nonnegative(root.baselineGeneration);
  if (positive(root.ordinal) > positive(root.chunkCount)) bad("semantic-chunk-ordinal");
  if (
    !Array.isArray(root.claims) ||
    root.claims.length === 0 ||
    !Array.isArray(root.evidence) ||
    root.evidence.length === 0
  )
    bad("semantic-empty-evidence");
  const claimIds = new Set<string>(),
    evidenceIds = new Set<string>();
  for (const value of root.claims) {
    const claim = record(value, [
      "claimId",
      "statement",
      "statementSha256",
      "scope",
      "recordSha256",
    ]);
    const key = id(claim.claimId);
    if (
      claimIds.has(key) ||
      typeof claim.statement !== "string" ||
      !claim.statement ||
      typeof claim.scope !== "string" ||
      !claim.scope ||
      sha(claim.statementSha256) !== createHash("sha256").update(claim.statement).digest("hex")
    )
      bad("semantic-model-claim");
    sha(claim.recordSha256);
    claimIds.add(key);
  }
  for (const value of root.evidence) {
    const item = recordWithOptional(
      value,
      [
        "evidenceId",
        "kind",
        "version",
        "sourcePath",
        "change",
        "content",
        "contentSha256",
        "sourceContentSha256",
        "startByte",
        "endByte",
        "totalBytes",
        "sourceVersionSha256",
      ],
      ["repositoryRole"],
    );
    const key = id(item.evidenceId);
    id(item.version);
    enumeration(item.kind, [
      "repository-before",
      "repository-after",
      "supporting-context",
      "issue-observation",
      "proposed-intent",
    ] as const);
    enumeration(item.change, [
      "added",
      "modified",
      "deleted",
      "context",
      "source-observation",
    ] as const);
    if (
      item.sourcePath !== null &&
      (typeof item.sourcePath !== "string" ||
        !item.sourcePath ||
        item.sourcePath.startsWith("/") ||
        /[\\\u0000-\u001f\u007f]/u.test(item.sourcePath) ||
        item.sourcePath.split("/").some((part) => !part || part === "." || part === ".."))
    )
      bad("semantic-source-path");
    if (
      evidenceIds.has(key) ||
      typeof item.content !== "string" ||
      sha(item.contentSha256) !==
        createHash("sha256")
          .update(item.content as string)
          .digest("hex")
    )
      bad("semantic-source-evidence");
    sha(item.sourceContentSha256);
    const startByte = nonnegative(item.startByte),
      endByte = nonnegative(item.endByte),
      totalBytes = nonnegative(item.totalBytes);
    if (
      endByte < startByte ||
      endByte > totalBytes ||
      endByte - startByte !== Buffer.byteLength(item.content as string) ||
      (startByte === 0 && endByte === totalBytes && item.contentSha256 !== item.sourceContentSha256)
    )
      bad("semantic-source-span");
    if (item.sourceVersionSha256 !== null) sha(item.sourceVersionSha256);
    if (Object.hasOwn(item, "repositoryRole")) {
      assertHostRuntimeSemanticData(item.repositoryRole);
      const role = record(item.repositoryRole, [
        "sourceKind",
        "classification",
        "coveragePlanSha256",
      ]);
      if (role.sourceKind !== null)
        enumeration(role.sourceKind, HOST_RUNTIME_SEMANTIC_SOURCE_KINDS);
      enumeration(role.classification, [
        "implementation",
        "context",
        "own-projection",
        "unclassified",
      ] as const);
      sha(role.coveragePlanSha256);
      if (
        (role.classification === "implementation" && role.sourceKind !== "repository-source") ||
        (role.classification === "context" &&
          (role.sourceKind === null || role.sourceKind === "repository-source")) ||
        (role.classification === "unclassified" && role.sourceKind !== null)
      )
        bad("semantic-repository-role");
    }
    evidenceIds.add(key);
  }
  if (root.repositoryObservationVersion !== undefined && root.repositoryObservationVersion !== 3)
    bad("semantic-repository-version");
  if (
    root.repositoryObservationVersion === 3 &&
    root.evidence.some((value: unknown) => {
      const item = value as Record<string, unknown>;
      return (
        (item.sourcePath !== null ||
          item.kind === "repository-before" ||
          item.kind === "repository-after") &&
        item.repositoryRole === undefined
      );
    })
  )
    bad("semantic-repository-role-required");
  if (root.acceptedEffectRevalidation !== undefined) {
    const purpose = parseHostRuntimeAcceptedEffectRevalidationData(root.acceptedEffectRevalidation);
    if (purpose.schemaVersion === 3 && root.repositoryObservationVersion !== 3)
      bad("semantic-repository-version");
    if (
      purpose.baseline.projectId !== root.projectId ||
      purpose.baseline.generation !== root.baselineGeneration ||
      purpose.baseline.baselineSha256 !== root.baselineSha256 ||
      purpose.baseline.modelSha256 !== root.modelSha256 ||
      purpose.baseline.canonSha256 !== root.canonSha256 ||
      purpose.baseline.approvalReceiptSha256 !== root.approvalReceiptSha256
    )
      bad("accepted-effect-baseline");
    const originalClaim = (root.claims as HostRuntimeSemanticComparisonChunkV1["claims"]).find(
      (claim) => claim.claimId === purpose.claim.before.claim_id,
    );
    if (
      originalClaim &&
      (originalClaim.recordSha256 !== purpose.claim.beforeRecordSha256 ||
        originalClaim.statement !== purpose.claim.before.statement ||
        originalClaim.scope !== canonicalJson(purpose.claim.before.scope))
    )
      bad("accepted-effect-before-record");
  }
  if (root.correctiveProposalRevalidation !== undefined) {
    if (root.acceptedEffectRevalidation === undefined) bad("corrective-proposal-effect-required");
    parseHostRuntimeCorrectiveProposalRevalidationData(
      root.correctiveProposalRevalidation,
      parseHostRuntimeAcceptedEffectRevalidationData(root.acceptedEffectRevalidation),
    );
  }
  // The structural parse leaves repository source text to the qualified one.
  const screened =
    root.repositoryObservationVersion === 3 && dataOnly
      ? {
          ...root,
          evidence: (root.evidence as SemanticSourceItem[]).map((item) =>
            semanticRepositorySourceItem(item) ? { ...item, content: "" } : item,
          ),
        }
      : root;
  if (
    containsCredentialDeep(screened, "hosted-semantic:comparisonChunk") ||
    Buffer.byteLength(canonicalJson(root)) > SEMANTIC_INPUT_CAPACITY.frozenInputsBytes
  )
    bad("semantic-input-size-or-credential");
  return deepFreezeGraph(root) as unknown as HostRuntimeSemanticComparisonChunkV1;
}
