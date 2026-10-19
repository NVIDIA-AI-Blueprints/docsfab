// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { assertReviewFindingDisclosure, type ReviewFindingV1 } from "../contracts.js";
import type { JsonEvidenceValue } from "../../operator/json-evidence.js";
import type { StepRunRecord } from "../../records/contracts.js";
import {
  normalizeRepositoryLocator,
  type TechnicalSourceFact,
  type VerificationResult,
} from "../../workflow-execution/review-response.js";
import {
  SAFE_CODE,
  object,
  text,
  safeText,
  safeCode,
  mapSeverity,
  truncate,
  parseLocation,
  parseEvidenceLocation,
  hasOnlyKeys,
  hasKeys,
  keysWithin,
  type ProjectedFindingBatch,
} from "./projection-primitives.js";

export const REVIEW_CATEGORIES = new Set([
  "technical_accuracy",
  "source_grounding",
  "completeness",
  "task_success",
  "example_validity",
  "information_architecture",
  "style_compliance",
  "security_compliance",
]);

export function projectReviewResultFindings(
  root: Record<string, JsonEvidenceValue>,
  step: StepRunRecord,
  verification?: VerificationResult,
): ProjectedFindingBatch {
  if (!Array.isArray(root.issues)) return { findings: [], limitations: [] };
  const limitations: string[] = [];
  const findings = root.issues.flatMap((value, index) => {
    const issue = object(value);
    if (
      !issue ||
      !hasOnlyKeys(issue, [
        "id",
        "severity",
        "category",
        "location",
        "finding",
        "evidence",
        "required_change",
      ])
    )
      return [];
    try {
      assertReviewFindingDisclosure(issue);
    } catch {
      return [];
    }
    const evidence = object(issue.evidence);
    if (!evidence || !hasOnlyKeys(evidence, ["source_id", "locator"])) return [];
    const id = text(issue.id);
    if (
      !id ||
      !/^[A-Z]+-[0-9]{3}$/u.test(id) ||
      !["critical", "major", "minor"].includes(String(issue.severity)) ||
      !REVIEW_CATEGORIES.has(String(issue.category))
    )
      return [];
    const summary = safeText(issue.finding);
    const recommendation = safeText(issue.required_change);
    const source = safeText(evidence.source_id);
    const locator = safeText(evidence.locator);
    if (!summary || !recommendation || !source || !locator) return [];
    const location = parseLocation(issue.location);
    if (location.malformed) return [];
    if (location.fidelity !== "exact") {
      limitations.push(`review-finding-location-${location.fidelity}:${id}`);
    }
    const issueFinding = {
      id: `finding:${step.skill}:${id}:${index + 1}`,
      severity: mapSeverity(issue.severity),
      code: safeCode(id),
      summary: truncate(summary),
      path: location.path,
      ...(location.line !== undefined ? { line: location.line } : {}),
      origin: "agent" as const,
      evidence: truncate(`${source}: ${locator}`),
      recommendation: truncate(recommendation),
    };
    const facts = verification?.factInventory.dimensions.flatMap((assessment) =>
      assessment.facts.filter((fact) => fact.issueIds.includes(id)),
    );
    const factFindings = (facts ?? []).flatMap((fact, factIndex) =>
      projectTechnicalFactFindings({
        fact,
        factIndex,
        issueId: id,
        issueFinding,
        recommendation,
        limitations,
        stepId: step.id,
      }),
    );
    return factFindings.length > 0 ? factFindings : [issueFinding];
  });
  return { findings, limitations };
}

function projectTechnicalFactFindings(input: {
  fact: TechnicalSourceFact;
  factIndex: number;
  issueId: string;
  issueFinding: ReviewFindingV1;
  recommendation: string;
  limitations: string[];
  stepId: string;
}): ReviewFindingV1[] {
  const retained = `run-step:${input.stepId}:summary:fact:${input.fact.id}`;
  if (input.fact.statement.length > 512) {
    input.limitations.push(
      `review-finding-fact-statement-omitted:${input.fact.id}:retained=${retained}`,
    );
  }
  const locatorFields: Array<readonly [value: string, label: string]> = [];
  for (const [sourceIndex, sourceLocator] of input.fact.sourceLocators.entries()) {
    const normalized = normalizeRepositoryLocator(sourceLocator);
    const normalizedLocator = normalized.path
      ? `${normalized.path}${normalized.line === undefined ? "" : `:${normalized.line}`}`
      : "unavailable";
    if (normalized.fidelity !== "exact") {
      input.limitations.push(
        `review-finding-fact-source-${normalized.fidelity}:${input.fact.id}:${sourceIndex + 1}:retained=${retained}`,
      );
    }
    locatorFields.push(
      [`source-locator=${sourceLocator}`, `source-${sourceIndex + 1}`],
      [`normalized-source-locator=${normalizedLocator}`, `normalized-source-${sourceIndex + 1}`],
    );
  }
  const evidence = boundedFactEvidence(
    [
      [`source-fact=${input.fact.id}`, "identity"],
      [`technical-issue=${input.issueId}`, "issue"],
      ...locatorFields,
      [`uncertainty=${input.fact.uncertainty}`, "uncertainty"],
    ],
    input.fact.id,
    retained,
    input.limitations,
  );
  return [
    {
      id: `${input.issueFinding.id}:fact:${input.factIndex + 1}`,
      severity: input.issueFinding.severity,
      code: safeCode(input.fact.id),
      summary: truncate(input.fact.statement),
      path: input.issueFinding.path,
      ...(input.issueFinding.line === undefined ? {} : { line: input.issueFinding.line }),
      origin: "agent",
      evidence,
      recommendation: truncate(input.recommendation),
    },
  ];
}

function boundedFactEvidence(
  fields: ReadonlyArray<readonly [value: string, label: string]>,
  factId: string,
  retained: string,
  limitations: string[],
): string {
  let result = "";
  for (const field of fields) {
    const candidate = result ? `${result}; ${field[0]}` : field[0];
    if (candidate.length <= 512) result = candidate;
    else {
      limitations.push(
        `review-finding-fact-metadata-omitted:${factId}:${field[1]}:retained=${retained}`,
      );
    }
  }
  return result;
}

export function projectQualityFindings(
  root: Record<string, JsonEvidenceValue>,
): ProjectedFindingBatch {
  if (root.model_version !== "documentation-quality-model-v0.2") {
    return { findings: [], limitations: [] };
  }
  const raw = root.findings;
  if (!Array.isArray(raw)) return { findings: [], limitations: [] };
  const limitations: string[] = [];
  const findings = raw.flatMap((value) => {
    const finding = object(value);
    if (
      !finding ||
      !hasKeys(finding, [
        "id",
        "severity",
        "dimension_id",
        "description",
        "evidence",
        "owner",
        "acceptance_condition",
        "status",
      ]) ||
      !keysWithin(finding, [
        "id",
        "severity",
        "dimension_id",
        "description",
        "evidence",
        "owner",
        "acceptance_condition",
        "status",
        "resolution",
        "verification_evidence",
        "dismissal_rationale",
      ]) ||
      !["open", "addressed-awaiting-verification", "verified", "dismissed-with-rationale"].includes(
        String(finding.status),
      )
    )
      return [];
    try {
      assertReviewFindingDisclosure(finding);
    } catch {
      return [];
    }
    const id = text(finding.id);
    const dimensionId = safeText(finding.dimension_id);
    const owner = safeText(finding.owner);
    const summary = safeText(finding.description);
    const recommendation = safeText(finding.acceptance_condition);
    if (
      !id ||
      !SAFE_CODE.test(id) ||
      !dimensionId ||
      !owner ||
      !summary ||
      !recommendation ||
      !["critical", "major", "moderate", "minor"].includes(String(finding.severity))
    )
      return [];
    const evidence = Array.isArray(finding.evidence)
      ? finding.evidence
          .map(formatEvidence)
          .filter((item): item is { text: string; location: string } => item !== null)
      : [];
    if (evidence.length === 0) return [];
    if (finding.status === "verified") {
      if (!safeText(finding.resolution) || !Array.isArray(finding.verification_evidence)) return [];
      if (finding.verification_evidence.map(formatEvidence).some((item) => item === null))
        return [];
    }
    if (finding.status === "dismissed-with-rationale" && !safeText(finding.dismissal_rationale)) {
      return [];
    }
    const location = parseEvidenceLocation(evidence[0]!.location);
    if (location.malformed) return [];
    if (location.fidelity !== "exact") {
      limitations.push(`review-finding-location-${location.fidelity}:${id}`);
    }
    return [
      {
        id,
        severity: mapSeverity(finding.severity),
        code: safeCode(id),
        summary: truncate(summary),
        path: location.path,
        ...(location.line !== undefined ? { line: location.line } : {}),
        origin: "agent" as const,
        evidence: truncate(evidence.map((item) => item.text).join("; ")),
        recommendation: truncate(recommendation),
      },
    ];
  });
  return { findings, limitations };
}

function formatEvidence(value: JsonEvidenceValue): { text: string; location: string } | null {
  const root = object(value);
  if (!root) return null;
  if (
    !hasKeys(root, ["evidence_class", "strength", "locator", "description"]) ||
    !keysWithin(root, [
      "evidence_class",
      "strength",
      "population",
      "provider_id",
      "task_or_scenario_id",
      "locator",
      "description",
    ]) ||
    ![
      "deterministic-conformance",
      "grounded-judgment",
      "outcome-evaluation",
      "longitudinal-observation",
    ].includes(String(root.evidence_class)) ||
    !["direct", "derived", "proxy", "none"].includes(String(root.strength))
  )
    return null;
  const locator = safeText(root.locator);
  const description = safeText(root.description);
  if (
    (Object.hasOwn(root, "population") &&
      !["human", "agent", "mixed", "not-applicable"].includes(String(root.population))) ||
    (Object.hasOwn(root, "provider_id") && !safeText(root.provider_id)) ||
    (Object.hasOwn(root, "task_or_scenario_id") && !safeText(root.task_or_scenario_id))
  )
    return null;
  if (!locator && !description) return null;
  return {
    text: [locator, description].filter(Boolean).join(": "),
    location: locator ?? description ?? "",
  };
}
