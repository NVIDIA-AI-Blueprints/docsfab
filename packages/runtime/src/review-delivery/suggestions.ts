// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** Inactive, offline compiler. Every port is caller-owned; no port grants publication. */
import { canonicalDigest, canonicalJson, sha256 } from "../content-ir/canonical.js";
import { deepFreeze } from "../contract-kit/index.js";
import type { ChangeSourceV1 } from "../inputs/change-source.js";
import { decodeReviewResult, decodeReviewResultV2 } from "../review/contracts.js";
import type { ReviewIssueV3, ReviewIssueV4, ReviewResult } from "../review/contracts.js";
import { assertReviewTargetV2Source } from "../review/target-migration.js";
import { resolveReviewAnchor } from "./anchors.js";
import type { ReviewResolvedAnchor } from "./anchors.js";
import type {
  ReviewDeliveryAction,
  ReviewDeliveryActionBinding,
  ReviewDeliveryFinding,
  ReviewDeliveryPlan,
  ReviewDeliverySnapshot,
} from "./contracts.js";
import { reviewFindingAssociation } from "./placement.js";
import { reviewDeliverySnapshotDigest } from "./plan.js";

export type ReviewSuggestionReasonV1 =
  | "replacement-unavailable"
  | "producer-admission-unavailable"
  | "producer-admission-rejected"
  | "retained-association-mismatch"
  | "inventory-incomplete"
  | "original-mismatch"
  | "original-ambiguous"
  | "source-drift"
  | "range-unprovable"
  | "after-location-unavailable"
  | "overlapping-edits"
  | "conflict-unresolved"
  | "generated-source-mismatch"
  | "generated-source-unknown"
  | "source-invalid-encoding"
  | "byte-semantics-unproven"
  | "byte-semantics-unsupported"
  | "provider-capability-unqualified"
  | "fence-unqualified"
  | "native-contract-unavailable";

/** Technical observations only. No certification history or posting permission. */
export interface ReviewSuggestionProfileV1 {
  readonly provider: "gitlab" | "github";
  readonly host: string;
  readonly version: string;
  readonly evidence: "offline-fixture" | "host-observed";
  readonly grammar: "backtick-suggestion-v1" | "unknown";
  readonly fence: "variable-backticks" | "triple-only" | "unknown";
  readonly bytes: "exact-line-envelope-v1" | "lf-only-v1" | "unknown";
  /** Host-observed technical limits, not an invented compiler line cap. */
  readonly gitlabOffsets?: { readonly before: number; readonly after: number };
}

/** Synthetic until the D1/locator owner releases its authenticated range resolver. */
export interface ReviewSuggestionOfflineRangeV1 {
  readonly proof: "offline-synthetic-range";
  readonly binding: ReviewDeliveryActionBinding;
  readonly inventoryId: string;
  readonly anchor: ReviewResolvedAnchor;
  readonly observedLines: readonly string[];
}

export interface ReviewSuggestionSourceV1 {
  readonly binding: ReviewDeliveryActionBinding;
  readonly snapshot: ReviewDeliverySnapshot;
  readonly ranges: readonly ReviewSuggestionOfflineRangeV1[];
}

export interface ReviewSuggestionPortsV1 {
  readonly retained: {
    load(query: {
      readonly artifact: ReviewDeliveryPlan["artifact"];
      readonly resultSha256: string;
    }): { readonly artifact: ReviewDeliveryPlan["artifact"]; readonly bytes: Uint8Array } | null;
  };
  readonly source: {
    readBoundSnapshot(binding: ReviewDeliveryActionBinding): ReviewSuggestionSourceV1 | null;
  };
  readonly admission?: {
    verify(query: {
      readonly retainedResult: ReviewResult;
      readonly issue: ReviewIssueV4;
      readonly facts: readonly (readonly [string, number, number, string])[];
      readonly sourceBinding: ReviewDeliveryActionBinding;
    }):
      | { readonly kind: "unavailable" | "rejected" }
      | {
          readonly kind: "admitted";
          readonly assessmentRef: string;
          readonly issue: ReviewIssueV4;
          readonly facts: readonly (readonly [string, number, number, string])[];
          readonly sourceBinding: ReviewDeliveryActionBinding;
        };
  };
  readonly generated: {
    classify(query: {
      readonly binding: ReviewDeliveryActionBinding;
      readonly path: string;
      readonly headBlobSha256: string;
    }): {
      readonly binding: ReviewDeliveryActionBinding;
      readonly path: string;
      readonly headBlobSha256: string;
      readonly classification: "authored" | "generated" | "unknown";
      readonly sourcePaths: readonly string[];
    };
  };
  readonly codec: {
    profile(binding: ReviewDeliveryActionBinding): ReviewSuggestionProfileV1;
  };
}

export interface ReviewSuggestionFallbackV1 {
  readonly artifact: ReviewDeliveryPlan["artifact"];
  readonly resultSha256: string;
  readonly reference: ReviewDeliveryFinding["retained"] | null;
  /** Entire authentic result, including rich/legacy action, grounding and limitations. */
  readonly result: ReviewResult | null;
  readonly finding: ReviewDeliveryFinding | null;
  readonly unavailableReason: "retained-association-mismatch" | null;
  readonly generatedSourcePaths: readonly string[];
}

export interface ReviewSuggestionProposalV1 {
  readonly schemaVersion: 1;
  readonly proof: "offline-synthetic-range";
  readonly retained: ReviewSuggestionFallbackV1;
  readonly originalActionId: string;
  readonly binding: ReviewDeliveryActionBinding;
  readonly inventoryId: string;
  readonly logicalIssueId: string;
  readonly observationId: string;
  readonly assessmentRef: string;
  readonly issue: ReviewIssueV4;
  readonly facts: readonly (readonly [string, number, number, string])[];
  readonly profile: ReviewSuggestionProfileV1;
  readonly profileSha256: string;
  readonly path: string;
  readonly anchor: ReviewResolvedAnchor;
  readonly byteStart: number;
  readonly byteEnd: number;
  readonly envelopeByteStart: number;
  readonly envelopeByteEnd: number;
  readonly originalText: string;
  readonly replacementText: string;
  readonly originalSha256: string;
  readonly replacementSha256: string;
  readonly headBlobText: string;
  readonly headBlobSha256: string;
  /** Full emitted payload, including preserved sub-line prefix/suffix and terminators. */
  readonly payload: string;
  readonly payloadSha256: string;
  readonly expectedBlobSha256: string;
  readonly inventorySha256: string;
  readonly conflictIds: readonly string[];
}

export type ReviewSuggestionCompilationV1 =
  | { readonly kind: "offline-candidate"; readonly proposal: ReviewSuggestionProposalV1 }
  | {
      readonly kind: "unsupported";
      readonly reason: ReviewSuggestionReasonV1;
      readonly retained: ReviewSuggestionFallbackV1;
      readonly proposedActionRef: string;
      readonly conflictIds: readonly string[];
    };

export type ReviewSuggestionCodecResultV1<T> =
  | {
      readonly kind: "offline-fragment";
      readonly proof: "offline-codec-only";
      readonly body: string;
      readonly bodySha256: string;
      readonly payloadSha256: string;
      readonly coordinates: T;
      readonly coordinatesSha256: string;
    }
  | {
      readonly kind: "unsupported";
      readonly reason: ReviewSuggestionReasonV1;
      readonly retained: ReviewSuggestionFallbackV1;
    };

const encoder = new TextEncoder();
function decode(bytes: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
}
function validText(value: string): boolean {
  return decode(encoder.encode(value)) === value;
}
function equal(a: unknown, b: unknown): boolean {
  return canonicalJson(a) === canonicalJson(b);
}

/** Splitting at LF preserves every terminator, BOM and Unicode normalization form. */
export function reviewSuggestionLinesV1(text: string): readonly string[] {
  return text.match(/[^\n]*\n|[^\n]+$/gu) ?? [];
}

interface LocatedEdit {
  readonly anchor: ReviewResolvedAnchor;
  readonly blob: string;
  readonly start: number;
  readonly end: number;
  readonly envelopeStart: number;
  readonly envelopeEnd: number;
  readonly payload: string;
  readonly expectedBlobSha256: string;
}
type Location = LocatedEdit | ReviewSuggestionReasonV1;

function locate(
  issue: ReviewIssueV4,
  finding: ReviewDeliveryFinding,
  source: ReviewSuggestionSourceV1,
): Location {
  if (issue.rich.status !== "admitted" || issue.rich.proposedEdit.kind !== "replacement")
    return "replacement-unavailable";
  const edit = issue.rich.proposedEdit;
  if (!validText(edit.path) || !validText(edit.originalText) || !validText(edit.replacementText))
    return "source-invalid-encoding";
  if (edit.path !== issue.path || edit.path === "" || edit.path.includes("\0"))
    return "retained-association-mismatch";
  const file = source.snapshot.files.find((f) => f.newPath === edit.path);
  if (!file || file.afterBytes === null) return "after-location-unavailable";
  let blob: string;
  try {
    blob = decode(file.afterBytes);
  } catch {
    return "source-invalid-encoding";
  }
  const ranges = source.ranges.filter((range) => range.inventoryId === finding.inventoryId);
  const range = ranges[0];
  if (ranges.length !== 1 || !range || !equal(range.binding, source.binding))
    return "range-unprovable";
  const a = range.anchor;
  if (a.side !== "after") return "after-location-unavailable";
  if (a.path !== edit.path || a.startLine !== issue.line || a.sourceSha256 !== file.afterSha256)
    return "source-drift";
  if (sha256(file.afterBytes) !== a.sourceSha256) return "source-drift";
  const lines = reviewSuggestionLinesV1(blob);
  const verified = resolveReviewAnchor(
    { path: edit.path, side: "after", line: a.startLine, endLine: a.endLine },
    source.snapshot.files,
  );
  if (verified.status !== "anchored" || !equal(verified, a)) return "range-unprovable";
  const observed = lines.slice(a.startLine - 1, a.endLine);
  if (!equal(observed, range.observedLines)) return "range-unprovable";
  if (edit.originalText === "") return "range-unprovable";
  const window = observed.join("");
  const first = window.indexOf(edit.originalText);
  if (first < 0) return "original-mismatch";
  if (window.indexOf(edit.originalText, first + 1) >= 0) return "original-ambiguous";
  const rangeStart = encoder.encode(lines.slice(0, a.startLine - 1).join("")).length;
  const start = rangeStart + encoder.encode(window.slice(0, first)).length;
  const end = start + encoder.encode(edit.originalText).length;
  const startLine = a.startLine + (window.slice(0, first).match(/\n/gu) ?? []).length;
  const endLine =
    a.startLine +
    (window.slice(0, first + edit.originalText.length - 1).match(/\n/gu) ?? []).length;
  const envelopeStart = encoder.encode(lines.slice(0, startLine - 1).join("")).length;
  const envelopeEnd = encoder.encode(lines.slice(0, endLine).join("")).length;
  const payload =
    decode(file.afterBytes.slice(envelopeStart, start)) +
    edit.replacementText +
    decode(file.afterBytes.slice(end, envelopeEnd));
  const expected = new Uint8Array([
    ...file.afterBytes.slice(0, start),
    ...encoder.encode(edit.replacementText),
    ...file.afterBytes.slice(end),
  ]);
  return {
    anchor: { ...a, startLine, endLine },
    blob,
    start,
    end,
    envelopeStart,
    envelopeEnd,
    payload,
    expectedBlobSha256: sha256(expected),
  };
}

/** No registration or legacy SuggestionCompiler success adapter is installed. */
export function createReviewSuggestionCompilerV1(ports: ReviewSuggestionPortsV1) {
  return {
    compile(input: {
      readonly plan: ReviewDeliveryPlan<ChangeSourceV1>;
      readonly action: ReviewDeliveryAction;
      readonly inventoryId: string;
      readonly snapshot: ReviewDeliverySnapshot;
      readonly rangeEvidence?: ReviewSuggestionOfflineRangeV1;
    }): ReviewSuggestionCompilationV1 {
      // Detach inputs before any caller-owned callback, including retained storage.
      const { plan, action, inventoryId, snapshot, rangeEvidence } = structuredClone(input);
      let authentic: ReviewResult | null = null;
      let selected: ReviewDeliveryFinding | null = null;
      let associated = false;
      let generatedSourcePaths: readonly string[] = [];
      const retained = (): ReviewSuggestionFallbackV1 => ({
        artifact: plan.artifact,
        resultSha256: plan.artifact.resultSha256,
        reference: selected?.retained ?? null,
        result: authentic,
        finding: associated ? selected : null,
        unavailableReason: associated ? null : "retained-association-mismatch",
        generatedSourcePaths,
      });
      const refuse = (
        reason: ReviewSuggestionReasonV1,
        conflictIds: readonly string[] = [],
      ): ReviewSuggestionCompilationV1 =>
        deepFreeze({
          kind: "unsupported",
          reason,
          retained: retained(),
          proposedActionRef: action.id,
          conflictIds,
        });
      const loaded = ports.retained.load(
        deepFreeze(
          structuredClone({
            artifact: plan.artifact,
            resultSha256: plan.artifact.resultSha256,
          }),
        ),
      );
      if (!loaded || !equal(loaded.artifact, plan.artifact))
        return refuse("retained-association-mismatch");
      try {
        const raw: unknown = JSON.parse(decode(loaded.bytes));
        const version = (raw as { schemaVersion?: number }).schemaVersion;
        authentic =
          version === 4 || version === 6 ? decodeReviewResultV2(raw) : decodeReviewResult(raw);
      } catch {
        return refuse("retained-association-mismatch");
      }
      const result = plan.result;
      if (
        authentic.resultSha256 !== plan.artifact.resultSha256 ||
        result.originalResultSha256 !== authentic.resultSha256 ||
        result.originalResultCanonicalJson !== canonicalJson(authentic) ||
        !equal(result.originalResult, authentic) ||
        result.originalSchemaVersion !== authentic.schemaVersion ||
        result.reviewedHeadSha !== authentic.reviewedHeadSha ||
        result.resultTargetSha256 !== authentic.targetSha256 ||
        !equal(result.targetProjection, plan.target)
      )
        return refuse("retained-association-mismatch");
      for (const key of [
        "issues",
        "findings",
        "sourceContexts",
        "checks",
        "unresolvedQuestions",
        "affectedPaths",
      ] as const) {
        if (
          !equal(result[key], key in authentic ? authentic[key as keyof ReviewResult] : undefined)
        )
          return refuse("retained-association-mismatch");
      }
      const rawRows = [
        ...("issues" in authentic ? (authentic.issues ?? []) : []).map((issue, index) => ({
          source: "issue",
          index,
          id: issue.id,
        })),
        ...authentic.findings.map((finding, index) => ({
          source: "finding",
          index,
          id: finding.id,
        })),
      ];
      if (
        rawRows.length !== plan.findings.length ||
        new Set(plan.findings.map((f) => f.inventoryId)).size !== rawRows.length ||
        rawRows.some(
          (r) => !plan.findings.some((f) => f.inventoryId === `${r.source}:${r.index}:${r.id}`),
        )
      )
        return refuse("inventory-incomplete");
      selected = plan.findings.find((f) => f.inventoryId === inventoryId) ?? null;
      if (!selected) return refuse("retained-association-mismatch");
      for (const f of plan.findings) {
        // Inventory membership and retained association must describe the same canonical row.
        if (f.inventoryId !== `${f.source}:${f.sourceIndex}:${f.originalId}`)
          return refuse("retained-association-mismatch");
        const linked = reviewFindingAssociation(plan, f);
        const logical =
          f.source === "issue"
            ? `issue:${f.originalId}`
            : `legacy:${result.originalResultSha256}:${f.originalId}`;
        const observation = canonicalDigest({
          logicalIssueId: logical,
          targetSha256: plan.target.targetSha256,
          reviewedHeadSha: result.reviewedHeadSha,
          resultSha256: result.originalResultSha256,
        });
        if (linked.mismatch || f.logicalIssueId !== logical || f.observationId !== observation)
          return refuse("retained-association-mismatch");
      }
      // Reconstruct source metadata from retained content, never substituted plan prose.
      for (const finding of plan.findings) {
        const row = reviewFindingAssociation(plan, finding);
        const issue = row.issue;
        const legacy = row.legacy;
        const context =
          issue?.sourceContextId == null
            ? undefined
            : result.sourceContexts?.find((c) => c.id === issue.sourceContextId);
        const locators =
          issue?.factRefs.flatMap(
            (ref) =>
              context?.dimensions[ref.dimensionIndex]?.facts[ref.factIndex]?.sourceLocators ?? [],
          ) ?? [];
        const path = issue?.path ?? legacy?.path ?? null;
        if (
          finding.path !== path ||
          finding.severity !== (issue?.severity ?? legacy?.severity) ||
          !equal(finding.evidence, issue?.evidence ?? null) ||
          finding.sourceContextId !== (issue?.sourceContextId ?? null) ||
          !equal(
            finding.relatedLocations,
            issue === null
              ? []
              : [...new Set([issue.location, issue.evidence.locator, ...locators])],
          ) ||
          !equal(finding.groupIds, [
            ...(path === null ? [] : [`path:${path}`]),
            ...(context === undefined ? [] : [`context:${context.id}`]),
          ]) ||
          !equal(finding.limitations, issue?.limitations ?? ["legacy-finding-lineage-unavailable"])
        )
          return refuse("retained-association-mismatch");
      }
      associated = true;
      const linked = reviewFindingAssociation(plan, selected);
      const issue = linked.issue;
      if (
        !issue ||
        !("rich" in issue) ||
        issue.rich.status !== "admitted" ||
        issue.rich.proposedEdit.kind !== "replacement"
      )
        return refuse("replacement-unavailable");
      const binding: ReviewDeliveryActionBinding = {
        target: plan.target,
        sourceSha256: plan.source.changeSourceSha256,
        snapshotSha256: plan.snapshotSha256,
        artifact: plan.artifact,
        actor: plan.actor,
        reviewedHeadSha: result.reviewedHeadSha,
        startSha:
          plan.source.source.kind === "gitlab-merge-request"
            ? plan.source.source.diffRefs.start
            : null,
      };
      const covered = action.kind === "publish-inline" ? [action.findingId] : action.findingIds;
      const { id: _id, ...intent } = action;
      if (
        !covered.includes(inventoryId) ||
        !equal(action.binding, binding) ||
        canonicalDigest(intent) !== action.id ||
        !plan.actions.some((a) => equal(a, action))
      )
        return refuse("native-contract-unavailable");
      try {
        assertReviewTargetV2Source(plan.target, plan.source);
        if (
          reviewDeliverySnapshotDigest(snapshot, plan.source) !== plan.snapshotSha256 ||
          plan.target.headSha !== result.reviewedHeadSha
        )
          return refuse("source-drift");
      } catch {
        return refuse("source-drift");
      }
      const supplied = ports.source.readBoundSnapshot(deepFreeze(structuredClone(binding)));
      if (!supplied || !equal(supplied.binding, binding) || !equal(supplied.snapshot, snapshot))
        return refuse("source-drift");
      const source = structuredClone(supplied);
      if (rangeEvidence !== undefined && !source.ranges.some((r) => equal(r, rangeEvidence)))
        return refuse("range-unprovable");
      if (!ports.admission) return refuse("producer-admission-unavailable");
      const admission = ports.admission.verify(
        deepFreeze(
          structuredClone({
            retainedResult: authentic,
            issue,
            facts: linked.facts,
            sourceBinding: binding,
          }),
        ),
      );
      if (admission.kind === "unavailable") return refuse("producer-admission-unavailable");
      if (
        admission.kind !== "admitted" ||
        admission.assessmentRef === "" ||
        !equal(admission.issue, issue) ||
        !equal(admission.facts, linked.facts) ||
        !equal(admission.sourceBinding, binding)
      )
        return refuse("producer-admission-rejected");
      const located = locate(issue, selected, source);
      if (typeof located === "string") return refuse(located);
      const classification = ports.generated.classify({
        binding: structuredClone(binding),
        path: located.anchor.path,
        headBlobSha256: located.anchor.sourceSha256,
      });
      if (
        !equal(classification.binding, binding) ||
        classification.path !== located.anchor.path ||
        classification.headBlobSha256 !== located.anchor.sourceSha256
      )
        return refuse("generated-source-mismatch");
      generatedSourcePaths = structuredClone(classification.sourcePaths);
      if (classification.classification === "unknown") return refuse("generated-source-unknown");
      if (classification.classification !== "authored") return refuse("generated-source-mismatch");
      const conflicts: string[] = [];
      const inventory: unknown[] = [];
      for (const f of plan.findings) {
        const candidate = reviewFindingAssociation(plan, f).issue;
        if (
          !candidate ||
          !("rich" in candidate) ||
          candidate.rich.status !== "admitted" ||
          candidate.rich.proposedEdit.kind !== "replacement"
        )
          continue;
        const position = f.inventoryId === inventoryId ? located : locate(candidate, f, source);
        inventory.push({
          retained: f.retained,
          inventoryId: f.inventoryId,
          candidate,
          position:
            typeof position === "string"
              ? position
              : {
                  anchor: position.anchor,
                  byteStart: position.start,
                  byteEnd: position.end,
                  envelopeByteStart: position.envelopeStart,
                  envelopeByteEnd: position.envelopeEnd,
                  payloadSha256: sha256(position.payload),
                  expectedBlobSha256: position.expectedBlobSha256,
                },
        });
        if (
          candidate.rich.proposedEdit.path !== located.anchor.path ||
          f.inventoryId === inventoryId
        )
          continue;
        if (typeof position === "string")
          return refuse("conflict-unresolved", [inventoryId, f.inventoryId].sort());
        if (
          (located.start < position.end && position.start < located.end) ||
          (located.envelopeStart < position.envelopeEnd &&
            position.envelopeStart < located.envelopeEnd)
        )
          conflicts.push(f.inventoryId);
      }
      if (conflicts.length > 0)
        return refuse("overlapping-edits", [inventoryId, ...conflicts].sort());
      const technical = structuredClone(ports.codec.profile(deepFreeze(structuredClone(binding))));
      return deepFreeze({
        kind: "offline-candidate",
        proposal: {
          schemaVersion: 1,
          proof: "offline-synthetic-range",
          retained: retained(),
          originalActionId: action.id,
          binding,
          inventoryId,
          logicalIssueId: selected.logicalIssueId,
          observationId: selected.observationId,
          assessmentRef: admission.assessmentRef,
          issue,
          facts: linked.facts,
          profile: technical,
          profileSha256: canonicalDigest(technical),
          path: located.anchor.path,
          anchor: located.anchor,
          byteStart: located.start,
          byteEnd: located.end,
          envelopeByteStart: located.envelopeStart,
          envelopeByteEnd: located.envelopeEnd,
          originalText: issue.rich.proposedEdit.originalText,
          replacementText: issue.rich.proposedEdit.replacementText,
          originalSha256: sha256(issue.rich.proposedEdit.originalText),
          replacementSha256: sha256(issue.rich.proposedEdit.replacementText),
          headBlobText: located.blob,
          headBlobSha256: sha256(located.blob),
          payload: located.payload,
          payloadSha256: sha256(located.payload),
          expectedBlobSha256: located.expectedBlobSha256,
          inventorySha256: canonicalDigest(inventory),
          conflictIds: [],
        },
      });
    },
  };
}

/** Shared pure grammar/byte proof used by both codecs; all output remains inactive. */
export function reviewSuggestionBodyV1(
  proposal: ReviewSuggestionProposalV1,
  profile: ReviewSuggestionProfileV1,
  info: string,
): { readonly body: string } | { readonly reason: ReviewSuggestionReasonV1 } {
  if (
    !equal(proposal.profile, profile) ||
    proposal.profileSha256 !== canonicalDigest(profile) ||
    profile.host !== proposal.binding.target.host ||
    profile.provider !== proposal.binding.target.scmProvider ||
    !["offline-fixture", "host-observed"].includes(profile.evidence) ||
    profile.version === "" ||
    profile.grammar !== "backtick-suggestion-v1"
  )
    return { reason: "provider-capability-unqualified" };
  if (!["exact-line-envelope-v1", "lf-only-v1"].includes(profile.bytes))
    return { reason: "byte-semantics-unproven" };
  if (
    profile.bytes === "lf-only-v1" &&
    (proposal.payload.includes("\r") ||
      proposal.headBlobText.includes("\r") ||
      !proposal.headBlobText.endsWith("\n") ||
      (proposal.payload !== "" && !proposal.payload.endsWith("\n")))
  )
    return { reason: "byte-semantics-unsupported" };
  const edit = proposal.issue.rich.status === "admitted" ? proposal.issue.rich.proposedEdit : null;
  if (
    edit?.kind !== "replacement" ||
    edit.path !== proposal.path ||
    edit.originalText !== proposal.originalText ||
    edit.replacementText !== proposal.replacementText ||
    proposal.anchor.path !== proposal.path ||
    proposal.anchor.sourceSha256 !== proposal.headBlobSha256
  )
    return { reason: "byte-semantics-unsupported" };
  const lines = reviewSuggestionLinesV1(proposal.headBlobText);
  if (
    !Number.isSafeInteger(proposal.anchor.startLine) ||
    !Number.isSafeInteger(proposal.anchor.endLine) ||
    proposal.anchor.startLine < 1 ||
    proposal.anchor.endLine < proposal.anchor.startLine ||
    proposal.anchor.endLine > lines.length ||
    encoder.encode(lines.slice(0, proposal.anchor.startLine - 1).join("")).length !==
      proposal.envelopeByteStart ||
    encoder.encode(lines.slice(0, proposal.anchor.endLine).join("")).length !==
      proposal.envelopeByteEnd
  )
    return { reason: "byte-semantics-unsupported" };
  const blob = encoder.encode(proposal.headBlobText);
  const payload = encoder.encode(proposal.payload);
  const original = blob.slice(proposal.byteStart, proposal.byteEnd);
  const rebuiltPayload = new Uint8Array([
    ...blob.slice(proposal.envelopeByteStart, proposal.byteStart),
    ...encoder.encode(proposal.replacementText),
    ...blob.slice(proposal.byteEnd, proposal.envelopeByteEnd),
  ]);
  const expected = new Uint8Array([
    ...blob.slice(0, proposal.envelopeByteStart),
    ...payload,
    ...blob.slice(proposal.envelopeByteEnd),
  ]);
  if (
    ![
      proposal.byteStart,
      proposal.byteEnd,
      proposal.envelopeByteStart,
      proposal.envelopeByteEnd,
    ].every(Number.isSafeInteger) ||
    proposal.envelopeByteStart < 0 ||
    proposal.envelopeByteStart > proposal.byteStart ||
    proposal.byteStart >= proposal.byteEnd ||
    proposal.byteEnd > proposal.envelopeByteEnd ||
    proposal.envelopeByteEnd > blob.length ||
    sha256(original) !== proposal.originalSha256 ||
    sha256(rebuiltPayload) !== proposal.payloadSha256 ||
    !validText(proposal.replacementText) ||
    !validText(proposal.originalText) ||
    sha256(blob) !== proposal.headBlobSha256 ||
    sha256(payload) !== proposal.payloadSha256 ||
    sha256(expected) !== proposal.expectedBlobSha256 ||
    sha256(proposal.originalText) !== proposal.originalSha256 ||
    sha256(proposal.replacementText) !== proposal.replacementSha256
  )
    return { reason: "byte-semantics-unsupported" };
  // Three is Markdown's fence syntax minimum, not an operational bound.
  let longest = 0;
  for (const run of proposal.payload.matchAll(/`+/gu)) longest = Math.max(longest, run[0].length);
  const length = Math.max(3, longest + 1);
  if (
    !["variable-backticks", "triple-only"].includes(profile.fence) ||
    (profile.fence === "triple-only" && length !== 3)
  )
    return { reason: "fence-unqualified" };
  const fence = "`".repeat(length);
  // A protocol LF before the closing delimiter is outside payload bytes at EOF.
  const separator = proposal.payload.endsWith("\n") || proposal.payload === "" ? "" : "\n";
  const body = `${fence}${info}\n${proposal.payload}${separator}${fence}`;
  const opening = `${fence}${info}\n`;
  const closing = `${separator}${fence}`;
  if (
    !body.startsWith(opening) ||
    !body.endsWith(closing) ||
    body.slice(opening.length, body.length - closing.length) !== proposal.payload ||
    proposal.payload.split("\n").some((line) => line.startsWith(fence))
  )
    return { reason: "fence-unqualified" };
  return { body };
}
