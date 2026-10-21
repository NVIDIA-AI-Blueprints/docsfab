// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** Read-only PR finding citations; independent of post-write page coverage. */
import { createHash } from "node:crypto";
import { canonicalDigest } from "../contract-kit/index.js";
import {
  sourceClaimSha256,
  verifySourceSpanCitations,
} from "../inputs/source-evidence-artifacts.js";
import {
  decodeSourceBinding,
  decodeSourceObservation,
  decodeSourceSpanAccess,
  SOURCE_EXACT_ORIGINAL_FORM,
  type SourceBindingV1,
  type SourceObservationV1,
  type SourceSpanAccessV1,
} from "../inputs/source-evidence.js";
import type { SourceRunCapabilityV1 } from "../inputs/source-resolver.js";
import type { RunRecord, StepRunRecord } from "./contracts.js";
import type { SourceRunSpanCitationV1 } from "./source-citations.js";
import { decodeSourceRunCitations } from "./source-citations.js";
import { projectReviewFindingsFromRun } from "../review/findings.js";
import type { ProjectedReviewFindingsV1 } from "../review/findings.js";

export interface PrReviewFindingCitationV1 {
  readonly stepId: string;
  readonly findingId: string;
  readonly claimSha256: string;
  readonly status: "cited" | "uncited";
  readonly citations: readonly SourceRunSpanCitationV1[];
}

export interface PrReviewSourceCitationsV1 {
  readonly schemaVersion: 1;
  readonly kind: "docsfab-pr-review-source-citations";
  readonly runId: string;
  readonly basisSha256: string;
  readonly bindingSha256: string;
  readonly sourceBinding: SourceBindingV1;
  readonly sourceObservations: readonly SourceObservationV1[];
  readonly spanAccesses: readonly SourceSpanAccessV1[];
  readonly findings: readonly PrReviewFindingCitationV1[];
  readonly digestSha256: string;
}

/** The canonical review-result projector selects the same finding text used in delivery. */
function stepFindings(record: RunRecord, step: StepRunRecord) {
  return projectReviewFindingsFromRun({ ...record, steps: [step] }).findings;
}

export function settlePrReviewFindingCitations(input: {
  readonly record: RunRecord;
  readonly step: StepRunRecord;
  readonly capability: SourceRunCapabilityV1;
}): void {
  const { record, step, capability } = input;
  if (
    !record.prReviewBasis ||
    record.workflow !== "review-documentation" ||
    !["review-documentation", "verify-technical-accuracy"].includes(step.id) ||
    step.status !== "succeeded"
  )
    return;
  const citations = capability.spanCitationsFor(step.id);
  const residual = verifySourceSpanCitations({
    binding: capability.binding,
    observations: capability.observations,
    spanAccesses: capability.spanAccesses(),
    spanCitations: citations,
    materialClaimSha256s: [],
  });
  if (residual.length > 0)
    throw new Error(
      `PR review citation ledger rejected ${step.id}: ${residual.map((row) => row.code).join(",")}.`,
    );
  const projected = stepFindings(record, step);
  const claimCounts = new Map<string, number>();
  for (const finding of projected) {
    const claim = sourceClaimSha256(finding.summary);
    claimCounts.set(claim, (claimCounts.get(claim) ?? 0) + 1);
  }
  const findings = projected.map((finding): PrReviewFindingCitationV1 => {
    const claimSha256 = sourceClaimSha256(finding.summary);
    const joined =
      claimCounts.get(claimSha256) === 1
        ? citations.filter(
            (citation) =>
              citation.stepId === step.id && citation.supportedClaimSha256 === claimSha256,
          )
        : [];
    return {
      stepId: step.id,
      findingId: finding.id,
      claimSha256,
      status: joined.length > 0 ? "cited" : "uncited",
      citations: [...joined],
    };
  });
  const prior = record.prReviewSourceCitations?.findings ?? [];
  const body = {
    schemaVersion: 1 as const,
    kind: "docsfab-pr-review-source-citations" as const,
    runId: record.id,
    basisSha256: record.prReviewBasis.basisSha256,
    bindingSha256: capability.binding.bindingSha256,
    sourceBinding: capability.binding,
    sourceObservations: [...capability.observations],
    // The capability's ledger records actual delivered reads, including reads
    // without a finding or citation. Observation inventory alone is not a read.
    spanAccesses: [...capability.spanAccesses()],
    findings: [...prior.filter((row) => row.stepId !== step.id), ...findings],
  };
  record.prReviewSourceCitations = { ...body, digestSha256: canonicalDigest(body) };
}

/** Saved bytes cannot appoint a finding or claim: recompute both from retained steps. */
export function decodePrReviewSourceCitations(
  value: unknown,
  record: RunRecord,
): PrReviewSourceCitationsV1 {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Malformed PR review citations cannot be decoded from this saved run.");
  const root = value as Record<string, unknown>;
  if (
    Object.keys(root).sort().join("|") !==
      [
        "schemaVersion",
        "kind",
        "runId",
        "basisSha256",
        "bindingSha256",
        "sourceBinding",
        "sourceObservations",
        "spanAccesses",
        "findings",
        "digestSha256",
      ]
        .sort()
        .join("|") ||
    root.schemaVersion !== 1 ||
    root.kind !== "docsfab-pr-review-source-citations" ||
    root.runId !== record.id ||
    root.basisSha256 !== record.prReviewBasis?.basisSha256 ||
    !Array.isArray(root.findings) ||
    !Array.isArray(root.sourceObservations) ||
    !Array.isArray(root.spanAccesses) ||
    typeof root.bindingSha256 !== "string" ||
    root.digestSha256 !==
      canonicalDigest(
        Object.fromEntries(Object.entries(root).filter(([key]) => key !== "digestSha256")),
      )
  ) {
    throw new Error("PR review citations differ from the retained run.");
  }
  const binding = decodeSourceBinding(root.sourceBinding);
  if (
    binding.bindingSha256 !== root.bindingSha256 ||
    binding.runIdSha256 !== createHash("sha256").update(record.id, "utf8").digest("hex") ||
    binding.repository.identitySha256 !==
      createHash("sha256").update(record.repository.sourcePath, "utf8").digest("hex") ||
    binding.repository.revision !== record.repository.revision ||
    binding.repository.revision !== record.prReviewBasis?.H
  )
    throw new Error("PR review source binding differs from the retained run.");
  const observations = root.sourceObservations.map(decodeSourceObservation);
  const observationById = new Map(observations.map((row) => [row.observationId, row]));
  if (
    observationById.size !== observations.length ||
    observations.length !== binding.observations.length ||
    binding.observations.some((reference) => {
      const observation = observationById.get(reference.observationId);
      return !observation || observation.observationSha256 !== reference.observationSha256;
    }) ||
    observations.some(
      (observation) =>
        observation.runIdSha256 !== binding.runIdSha256 ||
        observation.repository.identitySha256 !== binding.repository.identitySha256 ||
        observation.repository.revision !== binding.repository.revision ||
        observation.requestSha256 !== binding.requestSha256,
    )
  )
    throw new Error("PR review source observations differ from the admitted binding.");
  const rows = root.findings as unknown[];
  const accesses = root.spanAccesses.map(decodeSourceSpanAccess);
  const accessByDigest = new Map(accesses.map((access) => [access.spanAccessSha256, access]));
  if (
    accessByDigest.size !== accesses.length ||
    accesses.some((access) => {
      const observation = observationById.get(access.observationId);
      const representation = observation?.representations.find(
        (row) => row.representationId === access.representationId,
      );
      return (
        access.bindingSha256 !== binding.bindingSha256 ||
        !record.steps.some((step) => step.id === access.stepId) ||
        !representation ||
        representation.representationSha256 !== access.representationSha256 ||
        access.spanIds.some((id) => !representation.spans.some((span) => span.spanId === id)) ||
        (representation.form === SOURCE_EXACT_ORIGINAL_FORM) !==
          (access.serializedChargeBytes !== undefined)
      );
    })
  )
    throw new Error("PR review access receipt differs from its source binding.");
  const seen = new Set<string>();
  for (const raw of rows) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw))
      throw new Error("Malformed PR review citation row cannot be trusted in this saved run.");
    const row = raw as unknown as PrReviewFindingCitationV1;
    if (
      Object.keys(raw).sort().join("|") !==
        ["stepId", "findingId", "claimSha256", "status", "citations"].sort().join("|") ||
      !["review-documentation", "verify-technical-accuracy"].includes(row.stepId) ||
      typeof row.findingId !== "string" ||
      typeof row.claimSha256 !== "string" ||
      !Array.isArray(row.citations) ||
      !["cited", "uncited"].includes(row.status) ||
      seen.has(row.findingId)
    )
      throw new Error("Malformed PR review citation row cannot be trusted in this saved run.");
    seen.add(row.findingId);
    const step = record.steps.find(
      (candidate) => candidate.id === row.stepId && candidate.status === "succeeded",
    );
    const projected = step ? stepFindings(record, step) : [];
    const finding = projected.find((candidate) => candidate.id === row.findingId);
    if (
      row.status === "cited" &&
      projected.filter((candidate) => sourceClaimSha256(candidate.summary) === row.claimSha256)
        .length !== 1
    ) {
      throw new Error("PR review citation has an ambiguous canonical finding claim.");
    }
    if (
      !finding ||
      sourceClaimSha256(finding.summary) !== row.claimSha256 ||
      (row.status === "cited") !== row.citations.length > 0 ||
      row.citations.some(
        (citation) =>
          citation.stepId !== row.stepId ||
          citation.bindingSha256 !== root.bindingSha256 ||
          citation.supportedClaimSha256 !== row.claimSha256 ||
          citation.spanAccessSha256s.some((digest: string) => {
            const access = accessByDigest.get(digest);
            return (
              !access ||
              access.stepId !== citation.stepId ||
              access.observationId !== citation.observationId ||
              access.representationId !== citation.representationId ||
              citation.spanIds.some((spanId: string) => !access.spanIds.includes(spanId))
            );
          }),
      )
    ) {
      throw new Error("PR review citation has no canonical finding and exact-step source join.");
    }
    decodeSourceRunCitations({
      schemaVersion: 1,
      kind: "docsfab-source-run-citations",
      bindingSha256: root.bindingSha256,
      steps: [
        { stepId: row.stepId, materialClaimSha256s: [row.claimSha256], citations: row.citations },
      ],
    });
  }
  const expected = record.steps.flatMap((step) =>
    ["review-documentation", "verify-technical-accuracy"].includes(step.id) &&
    step.status === "succeeded"
      ? stepFindings(record, step).map((finding) => finding.id)
      : [],
  );
  if (expected.length !== rows.length || expected.some((id) => !seen.has(id))) {
    throw new Error("PR review citation inventory omits a canonical review finding.");
  }
  return root as unknown as PrReviewSourceCitationsV1;
}

/** Decorate only findings that survive the canonical delivery projection. */
export function projectPrReviewFindingCitations(
  record: RunRecord,
  projection: ProjectedReviewFindingsV1,
): ProjectedReviewFindingsV1 {
  if (!record.prReviewBasis) return projection;
  const retained = record.prReviewSourceCitations;
  if (!retained)
    return {
      ...projection,
      limitations: [...projection.limitations, "pr-review-finding-citations-unavailable"],
    };
  const decoded = decodePrReviewSourceCitations(retained, record);
  const byFinding = new Map(decoded.findings.map((row) => [row.findingId, row]));
  const limitations = [...projection.limitations];
  const findings = projection.findings.map((finding) => {
    const row = byFinding.get(finding.id);
    if (!row) return finding;
    if (row.status === "uncited") {
      limitations.push(`pr-review-finding-uncited:${finding.id}`);
      return finding;
    }
    const locations = row.citations.flatMap((citation) =>
      citation.spanIds.map(
        (spanId) => `${citation.observationId}/${citation.representationId}/${spanId}`,
      ),
    );
    return {
      ...finding,
      evidence: [finding.evidence, `Admitted source spans: ${locations.join(", ")}`]
        .filter(Boolean)
        .join("; "),
    };
  });
  return { ...projection, findings, limitations };
}
