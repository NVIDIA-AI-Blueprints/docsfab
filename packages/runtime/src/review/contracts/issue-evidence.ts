// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { contractDecodeLimits } from "../../contract-kit/index.js";
import { LIMIT_DEFINITION_BY_NAME } from "../../config/limits.generated.js";
import {
  reviewRichFieldLimit,
  type ReviewRichFieldLimitName,
} from "../../config/limit-snapshot.js";
import { kit, failReviewTarget, REVIEW_FINDING_SEVERITIES } from "./codec-kit.js";
import { PATCH_MARKERS, positiveInteger, relativePath } from "./value-primitives.js";
import type {
  ReviewIssueFactRefV3,
  ReviewIssueRichV4,
  ReviewIssueV3,
  ReviewIssueV4,
  ReviewProposedEditV4,
  ReviewSourceContextV3,
  ReviewSourceFactV3,
} from "../contracts.js";

function issueText(value: unknown): string {
  const result = kit.string(value);
  // Canonical technical prose can contain meaningful boundary whitespace.
  // Keep its exact bytes through the result seal; location uses a narrower rule.
  if (result.trim().length === 0 || PATCH_MARKERS.test(result)) {
    failReviewTarget("invalid-value");
  }
  return result;
}

function issueLocationText(value: unknown): string {
  const result = issueText(value);
  if (/^\s|\s$/u.test(result)) failReviewTarget("invalid-value");
  return result;
}

function richText(
  value: unknown,
  name: ReviewRichFieldLimitName | "runtime.contract.maxStringChars",
  allowEmpty = false,
): string {
  if (
    typeof value !== "string" ||
    value.includes("\0") ||
    Buffer.from(value, "utf8").toString("utf8") !== value ||
    (!allowEmpty && value.length === 0)
  )
    failReviewTarget("invalid-value");
  const bound = LIMIT_DEFINITION_BY_NAME[name];
  if (!bound) failReviewTarget("invalid-value");
  const effectiveValue =
    name === "runtime.contract.maxStringChars"
      ? contractDecodeLimits().maxStringChars
      : reviewRichFieldLimit(name);
  if (value.length > effectiveValue)
    throw new Error(
      `${bound.refusal}: ${value.length} exceeds ${name} = ${effectiveValue} ${bound.unit} (scope ${bound.scope}). ${bound.remediation} Follow the named remediation.`,
    );
  return value;
}

function richProse(
  value: unknown,
  name: ReviewRichFieldLimitName | "runtime.contract.maxStringChars",
): string {
  const text = richText(value, name);
  if (text.trim().length === 0) failReviewTarget("invalid-value");
  return text;
}

function normalizeRichEdit(value: unknown): ReviewProposedEditV4 {
  const root = kit.object(value);
  if (root.kind === "advice") {
    kit.exact(root, ["kind", "text"]);
    return { kind: "advice", text: richProse(root.text, "runtime.contract.maxStringChars") };
  }
  if (root.kind !== "replacement") failReviewTarget("invalid-value");
  kit.exact(root, ["kind", "text", "path", "originalText", "replacementText"]);
  return {
    kind: "replacement",
    text: richProse(root.text, "runtime.contract.maxStringChars"),
    path: relativePath(root.path),
    originalText: richText(root.originalText, "runtime.contract.maxStringChars"),
    replacementText: richText(root.replacementText, "runtime.contract.maxStringChars", true),
  };
}

function normalizeRichIssue(
  value: unknown,
  facts: readonly ReviewSourceFactV3[],
): ReviewIssueRichV4 {
  const root = kit.object(value);
  if (root.status === "unavailable") {
    kit.exact(root, ["status", "reason"]);
    return {
      status: "unavailable",
      reason: kit.enumeration(root.reason, [
        "candidate-absent",
        "link-changed",
        "contradicted",
        "unresolved",
        "source-unavailable",
        "qualification-unproven",
      ] as const),
    };
  }
  if (root.status !== "admitted") failReviewTarget("invalid-value");
  kit.exact(root, [
    "status",
    "candidateSha256",
    "title",
    "readerConsequence",
    "proposedEdit",
    "grounding",
  ]);
  if (facts.length === 0) failReviewTarget("invalid-value");
  const grounding = kit.array(root.grounding).map((entry) => {
    const ground = kit.object(entry);
    kit.exact(ground, ["factId", "qualification", "status", "rationale", "sourceLocators"]);
    const factId = kit.identifier(ground.factId);
    const fact = facts.find((candidate) => candidate.id === factId);
    if (!fact || ground.qualification !== fact.uncertainty || ground.status !== "supported")
      failReviewTarget("invalid-value");
    const sourceLocators = kit.array(ground.sourceLocators).map(issueText);
    if (kit.canonicalJson(sourceLocators) !== kit.canonicalJson(fact.sourceLocators))
      failReviewTarget("invalid-value");
    return {
      factId,
      qualification: fact.uncertainty,
      status: "supported" as const,
      rationale: richProse(ground.rationale, "technicalCorrection.proseMaxChars"),
      sourceLocators,
    };
  });
  kit.unique(grounding.map((entry) => entry.factId));
  if (grounding.length !== facts.length) failReviewTarget("invalid-value");
  return {
    status: "admitted",
    candidateSha256: kit.hash(root.candidateSha256),
    title: richProse(root.title, "technicalCorrection.fieldMaxChars"),
    readerConsequence: richProse(root.readerConsequence, "technicalCorrection.proseMaxChars"),
    proposedEdit: normalizeRichEdit(root.proposedEdit),
    grounding,
  };
}

function nonNegativeIndex(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    failReviewTarget("invalid-value");
  }
  return value;
}

function normalizeSourceContexts(value: unknown): ReviewSourceContextV3[] {
  const contexts = kit.array(value).map((entry): ReviewSourceContextV3 => {
    const root = kit.object(entry);
    kit.exact(root, ["id", "completeness", "limitations", "dimensions"]);
    if (root.completeness !== "bounded-not-proven") failReviewTarget("invalid-value");
    const dimensions = kit.array(root.dimensions).map((entry) => {
      const dimension = kit.object(entry);
      kit.exact(dimension, ["dimension", "status", "reason", "sourceLocators", "facts"]);
      const name = kit.identifier(dimension.dimension);
      const facts = kit.array(dimension.facts).map((entry): ReviewSourceFactV3 => {
        const fact = kit.object(entry);
        kit.exact(fact, [
          "id",
          "dimension",
          "sourceLocators",
          "statement",
          "documentationDisposition",
          "uncertainty",
          "issueIds",
        ]);
        if (fact.dimension !== name) failReviewTarget("invalid-value");
        return {
          id: kit.identifier(fact.id),
          dimension: name,
          sourceLocators: kit.array(fact.sourceLocators).map(issueText),
          statement: issueText(fact.statement),
          documentationDisposition: kit.enumeration(fact.documentationDisposition, [
            "documented",
            "omitted",
            "conflicting",
            "unverified-policy",
            "product-defect",
          ] as const),
          uncertainty: issueText(fact.uncertainty),
          issueIds: kit.array(fact.issueIds).map((id) => kit.identifier(id)),
        };
      });
      return {
        dimension: name,
        status: kit.enumeration(dimension.status, [
          "applicable",
          "not-applicable",
          "unverified",
        ] as const),
        reason: issueText(dimension.reason),
        sourceLocators: kit.array(dimension.sourceLocators).map(issueText),
        facts,
      };
    });
    return {
      id: kit.identifier(root.id),
      completeness: "bounded-not-proven",
      limitations: kit.array(root.limitations).map(issueText),
      dimensions,
    };
  });
  kit.unique(contexts.map((entry) => entry.id));
  return contexts;
}

function normalizeIssues(
  value: unknown,
  contexts: readonly ReviewSourceContextV3[],
): ReviewIssueV3[];
function normalizeIssues(
  value: unknown,
  contexts: readonly ReviewSourceContextV3[],
  rich: true,
): ReviewIssueV4[];
function normalizeIssues(
  value: unknown,
  contexts: readonly ReviewSourceContextV3[],
  rich = false,
): ReviewIssueV3[] | ReviewIssueV4[] {
  const issues = kit.array(value).map((entry): ReviewIssueV3 | ReviewIssueV4 => {
    const root = kit.object(entry);
    kit.exact(root, [
      "id",
      "producerStepId",
      "producerSkill",
      "originalId",
      "severity",
      "originalSeverity",
      "category",
      "finding",
      "location",
      "path",
      "line",
      "locationFidelity",
      "evidence",
      "requiredChange",
      "limitations",
      "sourceContextId",
      "factRefs",
      ...(rich ? ["rich"] : []),
    ]);
    const evidence = kit.object(root.evidence);
    kit.exact(evidence, ["sourceId", "locator"]);
    const originalId = kit.identifier(root.originalId);
    const sourceContextId =
      root.sourceContextId === null ? null : kit.identifier(root.sourceContextId);
    const context = contexts.find((entry) => entry.id === sourceContextId);
    if (sourceContextId !== null && !context) failReviewTarget("invalid-value");
    const factRefs = kit.array(root.factRefs).map((entry): ReviewIssueFactRefV3 => {
      const ref = kit.object(entry);
      kit.exact(ref, ["dimensionIndex", "factIndex"]);
      const dimensionIndex = nonNegativeIndex(ref.dimensionIndex);
      const factIndex = nonNegativeIndex(ref.factIndex);
      const fact = context?.dimensions[dimensionIndex]?.facts[factIndex];
      if (!fact || !fact.issueIds.includes(originalId)) failReviewTarget("invalid-value");
      return { dimensionIndex, factIndex };
    });
    kit.unique(factRefs.map((ref) => `${ref.dimensionIndex}:${ref.factIndex}`));
    const issue: ReviewIssueV3 = {
      id: kit.identifier(root.id),
      producerStepId: kit.identifier(root.producerStepId),
      producerSkill: kit.identifier(root.producerSkill),
      originalId,
      severity: kit.enumeration(root.severity, REVIEW_FINDING_SEVERITIES),
      originalSeverity: kit.enumeration(root.originalSeverity, [
        "critical",
        "major",
        "minor",
      ] as const),
      category: kit.identifier(root.category),
      finding: issueText(root.finding),
      location: issueLocationText(root.location),
      path: root.path === null ? null : relativePath(root.path),
      line: root.line === null ? null : positiveInteger(root.line),
      locationFidelity: kit.enumeration(root.locationFidelity, [
        "exact",
        "normalized",
        "unresolved",
      ] as const),
      evidence: { sourceId: issueText(evidence.sourceId), locator: issueText(evidence.locator) },
      requiredChange: issueText(root.requiredChange),
      limitations: kit.array(root.limitations).map(issueText),
      sourceContextId,
      factRefs,
    };
    return rich
      ? {
          ...issue,
          rich: normalizeRichIssue(
            root.rich,
            factRefs.map((ref) => context!.dimensions[ref.dimensionIndex]!.facts[ref.factIndex]!),
          ),
        }
      : issue;
  });
  kit.unique(issues.map((entry) => entry.id));
  const originalIdsByContext = new Map<string, Set<string>>();
  for (const issue of issues) {
    const contextId = issue.sourceContextId ?? "";
    const originalIds = originalIdsByContext.get(contextId) ?? new Set<string>();
    if (originalIds.has(issue.originalId)) failReviewTarget("invalid-value");
    originalIds.add(issue.originalId);
    originalIdsByContext.set(contextId, originalIds);
  }
  if (rich) {
    for (const issue of issues) {
      const context = contexts.find((entry) => entry.id === issue.sourceContextId);
      const refs = new Set(issue.factRefs.map((ref) => `${ref.dimensionIndex}:${ref.factIndex}`));
      context?.dimensions.forEach((dimension, dimensionIndex) =>
        dimension.facts.forEach((fact, factIndex) => {
          if (
            fact.issueIds.includes(issue.originalId) !== refs.has(`${dimensionIndex}:${factIndex}`)
          )
            failReviewTarget("invalid-value");
        }),
      );
    }
    for (const context of contexts) {
      for (const dimension of context.dimensions) {
        for (const fact of dimension.facts) {
          if (new Set(fact.issueIds).size !== fact.issueIds.length)
            failReviewTarget("invalid-value");
          if (fact.documentationDisposition === "documented") continue;
          for (const issueId of fact.issueIds) {
            if (
              !issues.some(
                (issue) => issue.sourceContextId === context.id && issue.originalId === issueId,
              )
            )
              failReviewTarget("invalid-value");
          }
        }
      }
    }
  }
  return issues;
}

export { normalizeIssues, normalizeSourceContexts };
