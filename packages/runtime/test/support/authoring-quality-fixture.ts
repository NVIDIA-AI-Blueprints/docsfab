// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  HarnessStepInput,
  QualityArtifactCandidateV1,
} from "../../src/execution/contracts.js";

const runtimeRoot = fileURLToPath(new URL("../..", import.meta.url));

/** Scripted model candidate only; the real host still validates it and mints every receipt. */
export async function authoringFixtureCandidateForInput(input: HarnessStepInput) {
  const selection = input.qualityProfileSelection;
  if (!selection) throw new Error("The authored fixture requires an admitted quality profile.");
  const bytes = await readFile(join(runtimeRoot, "quality", selection.profileAssetPath));
  if (createHash("sha256").update(bytes).digest("hex") !== selection.profilePayloadSha256)
    throw new Error("The authored fixture profile does not match its locked selection.");
  const candidate = authoringFixtureCandidate(
    JSON.parse(bytes.toString("utf8")),
    selection.repositoryRevision,
  );
  candidate.selectionSha256 = selection.selectionSha256;
  return candidate;
}
export function authoringFixtureEvaluation(
  profile: Readonly<Record<string, unknown>>,
  revision: string,
  findings: readonly Record<string, unknown>[] = [],
): Record<string, unknown> {
  const applicability = profile.applicability as {
    documentation_set: {
      required_dimensions_by_layer: Record<string, string[]>;
    };
  };
  const dimension = (dimensionId: string) => ({
    dimension_id: dimensionId,
    applicability: "required",
    assessment: "not-assessed",
    confidence: 0,
    evidence: [],
    measures: [],
    rationale: "No direct evidence is available for this deterministic fixture.",
  });
  const constraint = (dimensionId: string, optional = false) => ({
    dimension_id: dimensionId,
    applicability: optional ? "not-applicable" : "required",
    assessment: optional ? "not-applicable" : "not-assessed",
    confidence: 0,
    evidence: [],
    measures: [],
    rationale: optional
      ? "The fixture does not declare global readiness."
      : "No direct evidence is available for this deterministic fixture.",
  });
  return {
    evaluation_id: "quality-artifact-fixture",
    evaluation_version: "v0.1",
    evaluated_at: "2026-09-11T12:00:00Z",
    model_version: "documentation-quality-model-v0.2",
    profile: { id: "docsfab-documentation-quality", version: "v0.1" },
    evaluator: {
      provider_id: "fixture-evaluator",
      provider_type: "agent",
      independent_of_authors: true,
      independence_evidence: "The fixture evaluator is independent of the target author.",
    },
    target: {
      scope_type: "documentation-set",
      documentation_families: ["procedural"],
      documentation_family_evidence: [
        {
          family: "procedural",
          paths: ["docs/"],
          method: "path-convention",
          evidence_locator: "inventory:docs",
          rationale: "The tracked documentation path identifies a procedural family.",
        },
      ],
      repository_revision: revision,
      documentation_revision: revision,
      paths: ["README.md", "docs/"],
      product_reference_model: { id: "fixture-product", version: "v1" },
      approved_evidence_revision: "fixture-evidence-v1",
      product_version: "fixture-v1",
      environment: "deterministic-test",
      delivery_surface_locator: "fixture:docs",
      risk_boundary: "General information only.",
      risk_classes: ["general-information"],
      audiences: ["developer"],
      intended_outcomes: ["complete the documented task"],
      intended_outcome_classes: ["task-completion"],
    },
    layers: Object.fromEntries(
      Object.entries(applicability.documentation_set.required_dimensions_by_layer).map(
        ([layerId, dimensions]) => [
          layerId,
          {
            decision: "insufficient-evidence",
            confidence: 0,
            dimensions: dimensions.map(dimension),
            hard_gate_failures: [],
            limitations: ["Direct outcome evidence is unavailable."],
          },
        ],
      ),
    ),
    constraints: {
      accessibility_and_inclusion: constraint("accessibility-and-inclusion"),
      global_and_localization_readiness: constraint("global-and-localization-readiness", true),
      safety_security_privacy: constraint("safety-security-privacy"),
      legal_policy_support: constraint("legal-policy-support"),
      human_agent_representation_parity: constraint("human-agent-representation-parity"),
    },
    outcomes: { human: [], agent: [] },
    hard_gate_failures: [],
    overall_decision: "insufficient-evidence",
    conditions: [],
    confidence: 0,
    findings,
    limitations: ["Direct outcome evidence is unavailable."],
  };
}

export function authoringFixtureCandidate(
  profile: Readonly<Record<string, unknown>>,
  revision: string,
  findings: readonly Record<string, unknown>[] = [],
): QualityArtifactCandidateV1 & {
  evaluation: Record<string, unknown>;
  qualityScore: Record<string, unknown> | null;
} {
  return {
    evaluation: authoringFixtureEvaluation(profile, revision, findings),
    qualityScore: null,
    reportMarkdown: [
      "# Documentation quality evaluation report",
      "",
      "## Evidence gaps and limitations",
      "",
      "- Limitation: Direct outcome evidence is unavailable.",
    ].join("\n"),
    selectionSha256: "",
  };
}
