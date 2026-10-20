// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** Synthetic producer/range/profile ports: never native or producer admission evidence. */
import { canonicalJson, sha256 } from "../../../../src/content-ir/canonical.js";
import { createReviewDeliveryPlan } from "../../../../src/review-delivery/plan.js";
import { resolveReviewAnchor } from "../../../../src/review-delivery/anchors.js";
import {
  createReviewSuggestionCompilerV1,
  reviewSuggestionLinesV1,
} from "../../../../src/review-delivery/suggestions.js";
import type {
  ReviewSuggestionPortsV1,
  ReviewSuggestionProfileV1,
} from "../../../../src/review-delivery/suggestions.js";
import type {
  ReviewIssueV4,
  ReviewSourceContextV3,
  ReviewResultV6,
} from "../../../../src/review/contracts.js";
import { createReviewTarget, createReviewResultV5 } from "../../../../src/review/contracts.js";
import { createChangeSource } from "../../../../src/inputs/change-source.js";
import {
  createReviewTargetV2,
  createReviewResultV2,
} from "../../../../src/review/target-migration.js";
import { migrateReviewTargetToV2 } from "../../../../src/review/target-migration.js";
import { fixture, richFixture } from "../presentation/synthetic.js";

export function profile(provider: "gitlab" | "github"): ReviewSuggestionProfileV1 {
  return {
    provider,
    host: provider === "gitlab" ? "gitlab.example.com" : "github.com",
    version: "synthetic-profile-v1",
    evidence: "offline-fixture",
    grammar: "backtick-suggestion-v1",
    fence: "variable-backticks",
    bytes: "exact-line-envelope-v1",
    // A technical fixture capability; no compiler operational ceiling.
    ...(provider === "gitlab" ? { gitlabOffsets: { before: 1, after: 0 } } : {}),
  };
}

export function suggestionFixture(
  provider: "gitlab" | "github",
  options: {
    text?: string;
    bytes?: Uint8Array;
    legacyV5?: boolean;
    renamedFrom?: string;
    advice?: boolean;
    legacyAdvice?: boolean;
    thirdUnrelated?: boolean;
    original?: string;
    replacement?: string;
    path?: string;
    start?: number;
    end?: number;
    competitor?: {
      path?: string;
      original: string;
      replacement: string;
      line: number;
      end?: number;
      summary?: boolean;
    };
  } = {},
) {
  const path = options.path ?? "docs/guide.md";
  const text = options.text ?? "after\n";
  const seed = richFixture(provider, {
    kind: "replacement",
    text: "Keep the scoped override and run `docs check`.",
    path,
    originalText: options.original ?? "after",
    replacementText: options.replacement ?? "Only in one project: run `docs check`.",
  });
  const original = (seed.result as { issues: readonly ReviewIssueV4[] }).issues[0]!;
  const issue: ReviewIssueV4 = {
    ...original,
    path,
    line: options.start ?? 1,
    location: `${path}:${options.start ?? 1}`,
    ...(options.advice && original.rich.status === "admitted"
      ? {
          rich: {
            ...original.rich,
            proposedEdit: {
              kind: "advice" as const,
              text: "Keep all qualifications and run `docs check`.",
            },
          },
        }
      : {}),
  };
  const competitor = options.competitor;
  const second = competitor
    ? {
        ...issue,
        id: "issue:second",
        originalId: "TECH-SECOND",
        path: competitor.path ?? path,
        line: competitor.line,
        rich:
          issue.rich.status === "admitted"
            ? {
                ...issue.rich,
                proposedEdit: {
                  kind: "replacement" as const,
                  text: "Second correction",
                  path: competitor.path ?? path,
                  originalText: competitor.original,
                  replacementText: competitor.replacement,
                },
              }
            : issue.rich,
      }
    : null;
  const third: ReviewIssueV4 | null = options.thirdUnrelated
    ? {
        ...issue,
        id: "issue:third",
        originalId: "TECH-THIRD",
        path: "docs/other.md",
        rich:
          issue.rich.status === "admitted" && issue.rich.proposedEdit.kind === "replacement"
            ? { ...issue.rich, proposedEdit: { ...issue.rich.proposedEdit, path: "docs/other.md" } }
            : issue.rich,
      }
    : null;
  const issues = [issue, ...(second ? [second] : []), ...(third ? [third] : [])];
  const contexts = (seed.result as { sourceContexts: readonly ReviewSourceContextV3[] })
    .sourceContexts;
  const sourceContexts = contexts.map((context) => ({
    ...context,
    dimensions: context.dimensions.map((dimension) => ({
      ...dimension,
      facts: dimension.facts.map((fact) => ({
        ...fact,
        issueIds: ["TECH-1", ...(second ? ["TECH-SECOND"] : []), ...(third ? ["TECH-THIRD"] : [])],
      })),
    })),
  }));
  let base = fixture(provider, "addition", {
    filePath: path,
    issues: options.legacyAdvice ? issues.map(({ rich: _rich, ...legacy }) => legacy) : issues,
    contexts: sourceContexts,
    findings: [],
  });
  const lines = reviewSuggestionLinesV1(text);
  const bytes = options.bytes ?? new TextEncoder().encode(text);
  if (options.renamedFrom) {
    const {
      schemaVersion: _sourceVersion,
      kind: _sourceKind,
      changeSourceSha256: _sourceDigest,
      ...sourceBody
    } = base.source;
    const source = createChangeSource({
      ...sourceBody,
      files: base.source.files.map((file) => ({
        ...file,
        status: "R",
        similarity: 100,
        oldPath: options.renamedFrom!,
        added: 0,
        removed: 0,
      })),
    });
    const originalTarget = base.target;
    if ("targetProjection" in originalTarget)
      throw new Error("Expected an unmigrated fixture target");
    const {
      schemaVersion: _targetVersion,
      kind: _targetKind,
      targetSha256: _targetDigest,
      ...targetBody
    } = originalTarget;
    const target = createReviewTargetV2(
      { ...targetBody, changeSourceSha256: source.changeSourceSha256 },
      source,
    );
    const {
      schemaVersion: _version,
      kind: _kind,
      resultSha256: _digest,
      target: _oldTarget,
      targetSha256: _targetHash,
      reviewedHeadSha: _head,
      ...resultBody
    } = base.result as ReviewResultV6;
    const result = createReviewResultV2(target, source, resultBody);
    base = {
      ...base,
      source,
      target,
      result,
      artifact: { ...base.artifact, resultSha256: result.resultSha256 },
    };
  }
  const snapshot = {
    ...base.snapshot,
    changeSourceSha256: base.source.changeSourceSha256,
    files: [
      {
        ...base.snapshot.files[0]!,
        ...(options.renamedFrom
          ? { oldPath: options.renamedFrom, beforeBytes: bytes, beforeSha256: sha256(bytes) }
          : {}),
        afterBytes: bytes,
        afterSha256: sha256(bytes),
        hunks: [
          {
            lines: lines.map((raw, index) => ({
              kind: options.renamedFrom ? ("context" as const) : ("added" as const),
              text: raw.endsWith("\n") ? raw.slice(0, -1).replace(/\r$/u, "") : raw,
              beforeLine: options.renamedFrom ? index + 1 : null,
              afterLine: index + 1,
            })),
          },
        ],
      },
    ],
  };
  let effective = base;
  if (options.legacyV5) {
    const t = base.target;
    if (!("scmProvider" in t) || t.scmProvider !== "gitlab")
      throw new Error("V5 is a historical GitLab result");
    const legacyTarget = createReviewTarget({
      scmProvider: "gitlab",
      host: t.host,
      projectId: t.projectId,
      mergeRequestIid: t.mergeRequestIid,
      sourceBranch: t.sourceBranch,
      targetBranch: t.targetBranch,
      headSha: t.headSha,
      trigger: t.trigger,
      requestIdentitySha256: t.requestIdentitySha256,
      workflow: t.workflow,
      deliveryIntent: t.deliveryIntent,
      logicalRequestId: t.logicalRequestId,
    });
    const {
      schemaVersion: _schema,
      kind: _kind,
      target: _target,
      targetSha256: _targetHash,
      reviewedHeadSha: _head,
      resultSha256: _digest,
      ...body
    } = base.result as ReviewResultV6;
    const legacyResult = createReviewResultV5(legacyTarget, {
      ...body,
      qualityReport: body.qualityReport ?? null,
    });
    effective = {
      ...base,
      target: migrateReviewTargetToV2(legacyTarget, base.source),
      result: legacyResult,
      artifact: { ...base.artifact, resultSha256: legacyResult.resultSha256 },
    };
  }
  const plan = createReviewDeliveryPlan({
    ...effective,
    snapshot,
    extensions: competitor?.summary
      ? {
          presentation: {
            select: (finding) => (finding.originalId === "issue:second" ? "summary" : "inline"),
          },
        }
      : undefined,
  });
  const finding = plan.findings[0]!;
  const action =
    plan.actions.find((a) => a.kind === "publish-inline" && a.findingId === finding.inventoryId) ??
    plan.actions[0]!;
  const binding = action.binding;
  const ranges = plan.findings.flatMap((f, index) => {
    const start = index === 0 ? (options.start ?? 1) : (competitor?.line ?? 1);
    const end = index === 0 ? (options.end ?? start) : (competitor?.end ?? start);
    const resolved = resolveReviewAnchor(
      { path: f.path!, side: "after", line: start, endLine: end },
      snapshot.files,
    );
    return resolved.status === "anchored"
      ? [
          {
            proof: "offline-synthetic-range" as const,
            binding,
            inventoryId: f.inventoryId,
            anchor: resolved,
            observedLines: lines.slice(start - 1, end),
          },
        ]
      : [];
  });
  const input = { plan, action, inventoryId: finding.inventoryId, snapshot };
  const retainedBytes = new TextEncoder().encode(canonicalJson(effective.result));
  const ports: ReviewSuggestionPortsV1 = {
    retained: { load: () => ({ artifact: effective.artifact, bytes: retainedBytes }) },
    source: { readBoundSnapshot: () => ({ binding, snapshot, ranges }) },
    admission: {
      verify: (query) => ({
        kind: "admitted",
        assessmentRef: "synthetic-producer-assessment:1",
        issue,
        facts: query.facts,
        sourceBinding: binding,
      }),
    },
    generated: { classify: (query) => ({ ...query, classification: "authored", sourcePaths: [] }) },
    codec: { profile: () => profile(provider) },
  };
  const position =
    provider === "gitlab"
      ? {
          base_sha: plan.target.baseSha,
          start_sha: binding.startSha!,
          head_sha: binding.reviewedHeadSha,
          position_type: "text" as const,
          old_path: options.renamedFrom ?? null,
          new_path: path,
          new_line: options.end ?? options.start ?? 1,
        }
      : {
          commit_id: binding.reviewedHeadSha,
          path,
          line: options.end ?? options.start ?? 1,
          side: "RIGHT" as const,
          ...((options.start ?? 1) === (options.end ?? options.start ?? 1)
            ? {}
            : { start_line: options.start ?? 1, start_side: "RIGHT" as const }),
        };
  return {
    input,
    ports,
    position,
    issue,
    retainedBytes,
    ranges,
    snapshot,
    compile: (
      overrides: Partial<typeof input> = {},
      portOverrides: Partial<ReviewSuggestionPortsV1> = {},
    ) =>
      createReviewSuggestionCompilerV1({ ...ports, ...portOverrides }).compile({
        ...input,
        ...overrides,
      }),
  };
}
