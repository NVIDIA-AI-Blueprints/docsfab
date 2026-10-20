// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** Proposed placement is source-bound data, never new document or write authority. */
import { assertInertTransportData } from "../reader-task-transport.js";
import { deepFreezeGraph } from "../contract-kit/freeze.js";
import {
  bad,
  record,
  id,
  sha,
  digest,
  canonicalJson,
  containsCredentialDeep,
} from "./wire-decode.js";
export interface SemanticDocumentTargets {
  readonly schemaVersion: 2;
  readonly kind: "docsfab-product-feedback-document-targets";
  readonly targets: readonly {
    readonly targetId: string;
    readonly path: string;
    readonly delivery: "repository-planning" | "public-documentation";
    readonly sourceKind: "prd" | "srd" | "por" | "repository-documentation";
  }[];
}
export interface SemanticDocumentProjection {
  readonly schemaVersion: 1;
  readonly kind: "docsfab-claim-document-projection";
  readonly policySha256: string;
  readonly documents: readonly {
    readonly targetId: string;
    readonly path: string;
    readonly sourceRevision: string;
    readonly sourceSha256: string;
    readonly impact: "update" | "none";
    readonly explanation: string;
    readonly citations: readonly {
      readonly evidenceId: string;
      readonly startByte: number;
      readonly endByte: number;
      readonly sha256: string;
    }[];
    readonly placement: null | {
      readonly heading: string | null;
      readonly beforeText: string | null;
      readonly selection:
        | { readonly kind: "controlled-region" }
        | {
            readonly kind: "claim-span";
            readonly startByte: number;
            readonly endByte: number;
            readonly beforeText: string;
          };
    };
  }[];
}
/**
 * The approval-scope id of the product reference model package itself. The
 * package is the target of every accepted decision and never a document, so no
 * configured document target may take this id. This package cannot import the
 * knowledge materializer that defines it; a host test pins the two copies equal.
 */
export const PRODUCT_REFERENCE_MODEL_TARGET_ID = "product-reference-model";
const fail = () => bad("semantic-document-projection");
function documentPath(value: unknown): asserts value is string {
  if (
    typeof value !== "string" ||
    !/^(?:planning|docs)\/[A-Za-z0-9._/-]+\.md$/u.test(value) ||
    value.split("/").some((part) => ["", ".", "..", ".git"].includes(part))
  )
    fail();
}
export function parseSemanticDocumentTargets(input: unknown): SemanticDocumentTargets {
  assertInertTransportData(input, fail);
  const value = record(input, ["schemaVersion", "kind", "targets"]);
  if (
    value.schemaVersion !== 2 ||
    value.kind !== "docsfab-product-feedback-document-targets" ||
    !Array.isArray(value.targets) ||
    !value.targets.length
  )
    fail();
  const ids = new Set<string>(),
    paths = new Set<string>();
  for (const item of value.targets as unknown[]) {
    const target = record(item, ["targetId", "path", "delivery", "sourceKind"]);
    const key = id(target.targetId);
    documentPath(target.path);
    // A document target named like the package would let a projection stand in
    // for the package in an approval scope.
    if (
      key === PRODUCT_REFERENCE_MODEL_TARGET_ID ||
      ids.has(key) ||
      paths.has(target.path) ||
      !["prd", "srd", "por", "repository-documentation"].includes(String(target.sourceKind))
    )
      fail();
    ids.add(key);
    paths.add(target.path);
    if (target.delivery === "public-documentation") {
      if (!target.path.startsWith("docs/") || target.sourceKind !== "repository-documentation")
        fail();
    } else if (target.delivery !== "repository-planning" || !target.path.startsWith("planning/"))
      fail();
  }
  if (
    canonicalJson([...ids]) !== canonicalJson([...ids].sort()) ||
    containsCredentialDeep(value, "hosted-semantic:documentTargets")
  )
    fail();
  return deepFreezeGraph(value) as unknown as SemanticDocumentTargets;
}
export function parseSemanticDocumentProjection(input: unknown): SemanticDocumentProjection {
  assertInertTransportData(input, fail);
  const value = record(input, ["schemaVersion", "kind", "policySha256", "documents"]);
  if (
    value.schemaVersion !== 1 ||
    value.kind !== "docsfab-claim-document-projection" ||
    !Array.isArray(value.documents) ||
    !value.documents.length
  )
    fail();
  sha(value.policySha256);
  const ids = new Set<string>();
  for (const item of value.documents as unknown[]) {
    const document = record(item, [
      "targetId",
      "path",
      "sourceRevision",
      "sourceSha256",
      "impact",
      "explanation",
      "citations",
      "placement",
    ]);
    const key = id(document.targetId);
    documentPath(document.path);
    sha(document.sourceSha256);
    if (
      ids.has(key) ||
      typeof document.sourceRevision !== "string" ||
      !/^[a-f0-9]{40}$/u.test(document.sourceRevision) ||
      !["update", "none"].includes(String(document.impact)) ||
      typeof document.explanation !== "string" ||
      !document.explanation.trim() ||
      !Array.isArray(document.citations) ||
      !document.citations.length
    )
      fail();
    ids.add(key);
    for (const item of document.citations as unknown[]) {
      const citation = record(item, ["evidenceId", "startByte", "endByte", "sha256"]);
      id(citation.evidenceId);
      sha(citation.sha256);
      if (
        !Number.isSafeInteger(citation.startByte) ||
        !Number.isSafeInteger(citation.endByte) ||
        Number(citation.startByte) < 0 ||
        Number(citation.endByte) <= Number(citation.startByte)
      )
        fail();
    }
    if (document.impact === "none") {
      if (document.placement !== null) fail();
      continue;
    }
    const placement = record(document.placement, ["heading", "beforeText", "selection"]);
    if (
      placement.heading !== null &&
      (typeof placement.heading !== "string" ||
        !placement.heading.trim() ||
        /[\r\n\0]/u.test(placement.heading))
    )
      fail();
    const selection = record(placement.selection, [
      "kind",
      ...(typeof placement.selection === "object" &&
      placement.selection !== null &&
      (placement.selection as { kind?: unknown }).kind === "claim-span"
        ? ["startByte", "endByte", "beforeText"]
        : []),
    ]);
    if (selection.kind === "controlled-region") {
      if (placement.beforeText !== null) fail();
    } else if (
      selection.kind !== "claim-span" ||
      typeof placement.beforeText !== "string" ||
      !placement.beforeText.trim() ||
      typeof selection.beforeText !== "string" ||
      !selection.beforeText.trim() ||
      !Number.isSafeInteger(selection.startByte) ||
      !Number.isSafeInteger(selection.endByte) ||
      Number(selection.startByte) < 0 ||
      Number(selection.endByte) <= Number(selection.startByte) ||
      Number(selection.endByte) - Number(selection.startByte) !==
        Buffer.byteLength(selection.beforeText as string)
    )
      fail();
  }
  if (
    canonicalJson([...ids]) !== canonicalJson([...ids].sort()) ||
    containsCredentialDeep(value, "hosted-semantic:documentProjection")
  )
    fail();
  return deepFreezeGraph(value) as unknown as SemanticDocumentProjection;
}
export function bindSemanticDocumentProjection(
  policyInput: unknown,
  projectionInput: unknown,
): SemanticDocumentProjection {
  const policy = parseSemanticDocumentTargets(policyInput),
    projection = parseSemanticDocumentProjection(projectionInput);
  if (
    projection.policySha256 !== digest(policy) ||
    projection.documents.length !== policy.targets.length ||
    projection.documents.some(
      (document, index) =>
        document.targetId !== policy.targets[index]!.targetId ||
        document.path !== policy.targets[index]!.path,
    )
  )
    fail();
  return projection;
}

export function semanticDocumentPolicySha256(input: unknown): string {
  return digest(parseSemanticDocumentTargets(input));
}

/** Keep provenance aliases in the proposal; reconstruct each identical source byte range once. */
export function semanticDocumentByteRanges<
  T extends {
    readonly startByte: number;
    readonly endByte: number;
    readonly totalBytes: number;
    readonly contentSha256: string;
    readonly content?: string;
  },
>(input: readonly T[]): readonly T[] {
  assertInertTransportData(input, fail);
  const ordered = [...input].sort((a, b) => a.startByte - b.startByte || a.endByte - b.endByte),
    unique: T[] = [];
  for (const item of ordered) {
    if (
      !Number.isSafeInteger(item.startByte) ||
      !Number.isSafeInteger(item.endByte) ||
      !Number.isSafeInteger(item.totalBytes) ||
      item.startByte < 0 ||
      item.endByte < item.startByte ||
      item.endByte > item.totalBytes
    )
      fail();
    sha(item.contentSha256);
    const prior = unique.at(-1);
    if (prior && prior.startByte === item.startByte && prior.endByte === item.endByte) {
      if (
        prior.totalBytes !== item.totalBytes ||
        prior.contentSha256 !== item.contentSha256 ||
        prior.content !== item.content
      )
        fail();
      continue;
    }
    if ((prior?.endByte ?? 0) !== item.startByte || (prior && prior.totalBytes !== item.totalBytes))
      fail();
    unique.push(item);
  }
  if (!unique.length || unique.at(-1)!.endByte !== unique[0]!.totalBytes) fail();
  return unique;
}
