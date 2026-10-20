// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Foundation onboarding orchestration.
 *
 * Projects typed gap questions from inspection, applies host-owned decisions,
 * and rescores readiness without mutating the repository checkout.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";

import {
  applyFoundationGapDecisions,
  createFoundationGapDecision,
  mintFoundationGapDecisionCapability,
  type FoundationGapDecisionCapability,
  type FoundationGapDecisionDisposition,
  type FoundationGapDecisionHostAuthority,
  type FoundationGapDecisionV1,
} from "../canon/gap-decisions.js";
import {
  projectFoundationGapQuestions,
  type FoundationGapQuestionV1,
} from "../canon/gap-questions.js";
import { projectFoundationCanonSurfaces, type FoundationCanonV1 } from "../canon/index.js";
import { buildContentIndex, canonicalDigest } from "../content-ir/index.js";
import {
  foundationReadinessToProductDisposition,
  type FoundationInspectReadiness,
} from "./readiness.js";
import type {
  FoundationInspectArtifactRefV1,
  FoundationInspectResultV1,
  FoundationRegisteredEvidenceV1,
} from "./inspect.js";

export interface FoundationOnboardingDecisionSpecV1 {
  questionId: string;
  disposition: FoundationGapDecisionDisposition;
  answerValueSha256?: string | null;
}

export interface FoundationOnboardingSessionV1 {
  schemaVersion: 1;
  kind: "docsfab-foundation-onboarding-session";
  priorInspect: FoundationInspectResultV1;
  questions: readonly FoundationGapQuestionV1[];
  decisions: readonly FoundationGapDecisionV1[];
  priorCanon: FoundationCanonV1;
  canon: FoundationCanonV1;
  inspect: FoundationInspectResultV1;
  acceptedAssumptionIds: readonly string[];
  verifiedClaimIds: readonly string[];
  sessionSha256: string;
}

const INSTRUCTION_NAMES = ["AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"] as const;

/** Project typed questions for an inspection that still needs input. */
export function projectFoundationOnboardingQuestions(
  inspect: FoundationInspectResultV1,
): readonly FoundationGapQuestionV1[] {
  return projectFoundationGapQuestions({
    canon: inspect.canon,
    missingFacts: inspect.missingFacts,
    conflictIds: inspect.conflicts.map((item) => item.id),
    evidenceLimitations: inspect.evidenceLimitations,
  });
}

/**
 * Apply authoritative host decisions and rescore foundation readiness.
 * Requires live decision capabilities — decoded decision JSON cannot be applied.
 */
export async function completeFoundationOnboarding(input: {
  /** Exact disposable checkout selected by the workflow runner. */
  repositoryPath: string;
  inspect: FoundationInspectResultV1;
  authority: FoundationGapDecisionHostAuthority;
  authorityIdentitySha256: string;
  decisions: readonly FoundationOnboardingDecisionSpecV1[];
  expiresAt: string;
  now: string;
  nextVersion?: string;
}): Promise<FoundationOnboardingSessionV1> {
  const questions = projectFoundationOnboardingQuestions(input.inspect);
  const questionsById = new Map(questions.map((question) => [question.id, question]));
  const capabilities: FoundationGapDecisionCapability[] = [];

  for (const spec of [...input.decisions].sort((left, right) =>
    left.questionId.localeCompare(right.questionId),
  )) {
    const question = questionsById.get(spec.questionId);
    if (!question) {
      throw new Error(
        `Foundation onboarding rejected an unknown typed gap question id: ${spec.questionId}.`,
      );
    }
    capabilities.push(
      mintFoundationGapDecisionCapability(
        {
          question,
          disposition: spec.disposition,
          answerValueSha256: spec.answerValueSha256 ?? null,
          authorityIdentitySha256: input.authorityIdentitySha256,
          expiresAt: input.expiresAt,
          now: input.now,
        },
        input.authority,
      ),
    );
  }

  const applied = applyFoundationGapDecisions({
    priorCanon: input.inspect.canon,
    questions,
    capabilities,
    nextVersion: input.nextVersion ?? nextVersion(input.inspect.canon.version),
    now: input.now,
  });

  const decisions = capabilities
    .map((capability) => createFoundationGapDecision(capability))
    .sort((left, right) => left.id.localeCompare(right.id));

  const inspect = await rescoreFoundationOnboarding({
    repositoryPath: input.repositoryPath,
    priorInspect: input.inspect,
    canon: applied.canon,
    decisions,
    questions,
  });

  const body = {
    schemaVersion: 1 as const,
    kind: "docsfab-foundation-onboarding-session" as const,
    priorInspect: input.inspect,
    questions,
    decisions,
    priorCanon: applied.priorCanon,
    canon: applied.canon,
    inspect,
    acceptedAssumptionIds: applied.acceptedAssumptionIds,
    verifiedClaimIds: applied.verifiedClaimIds,
  };
  return Object.freeze({
    ...body,
    sessionSha256: canonicalDigest(body),
  }) as FoundationOnboardingSessionV1;
}

/**
 * Deterministic readiness rescoring for an identical canon + decision set.
 * Does not re-mint authority; callers must already hold applied results.
 */
export async function rescoreFoundationOnboarding(input: {
  repositoryPath: string;
  priorInspect: FoundationInspectResultV1;
  canon: FoundationCanonV1;
  decisions: readonly FoundationGapDecisionV1[];
  questions: readonly FoundationGapQuestionV1[];
}): Promise<FoundationInspectResultV1> {
  const index = await buildContentIndex({
    repositoryPath: input.repositoryPath,
    repositoryRevision: input.canon.repository.revision,
  });
  const instructionPresent = discoverInstruction(input.repositoryPath) !== null;
  const documentCount = index.nodes.filter((node) => node.kind === "document").length;
  const registeredEvidence = evidenceFromCanon(input.canon);
  const deferredOrRejected = new Set(
    input.decisions
      .filter((item) => item.disposition === "defer" || item.disposition === "reject")
      .map((item) => item.questionId),
  );
  const answeredQuestionIds = new Set(
    input.decisions
      .filter((item) => item.disposition === "answer" || item.disposition === "accept-assumption")
      .map((item) => item.questionId),
  );
  const openCritical = input.questions.filter(
    (question) =>
      !answeredQuestionIds.has(question.id) &&
      (deferredOrRejected.has(question.id) ||
        !input.decisions.some((d) => d.questionId === question.id)),
  );

  const readiness = computePostDecisionReadiness({
    canon: input.canon,
    registeredEvidence,
    instructionPresent,
    documentCount,
    openCriticalCount: openCritical.length,
    deferredCritical: input.questions.some(
      (question) => deferredOrRejected.has(question.id) && isCriticalKind(question.questionKind),
    ),
  });

  const missingFacts: string[] = [];
  const evidenceLimitations: string[] = [];
  if (!instructionPresent) missingFacts.push("repository-instructions-absent");
  if (registeredEvidence.length === 0) missingFacts.push("registered-evidence-absent");
  if (input.canon.claims.every((claim) => claim.verificationStatus !== "verified")) {
    missingFacts.push("verified-claims-absent");
  }
  for (const item of registeredEvidence) {
    if (item.strength === "blocked") evidenceLimitations.push(`blocked-source:${item.id}`);
    if (item.strength === "weak") evidenceLimitations.push(`weak-source:${item.id}`);
    if (item.stale) evidenceLimitations.push(`stale-source:${item.id}`);
  }
  for (const conflict of input.canon.conflicts) {
    if (conflict.resolutionSha256 === null) {
      evidenceLimitations.push(`unresolved-conflict:${conflict.id}`);
    }
  }

  const nextQuestions =
    readiness === "ready" ? [] : openCritical.map((question) => question.promptLabel);

  const surfaces = projectFoundationCanonSurfaces(input.canon);
  const artifactReferences: FoundationInspectArtifactRefV1[] = [
    { role: "candidate-canon", canonSha256: input.canon.canonSha256 },
    {
      role: "machine-projection",
      canonSha256: input.canon.canonSha256,
      projectionSha256: surfaces.machine.projectionSha256,
    },
    {
      role: "human-report",
      canonSha256: input.canon.canonSha256,
      reportSha256: surfaces.report.reportSha256,
    },
    { role: "prior-canon", canonSha256: input.priorInspect.canon.canonSha256 },
  ];

  const body = {
    schemaVersion: 1 as const,
    kind: "docsfab-foundation-inspect-result" as const,
    readiness,
    productDisposition: foundationReadinessToProductDisposition(readiness),
    canon: input.canon,
    summary: {
      canonId: input.canon.canonId,
      version: input.canon.version,
      state: input.canon.state,
      claimCount: input.canon.claims.length,
      evidenceCount: input.canon.evidence.length,
      conflictCount: input.canon.conflicts.length,
      instructionPresent,
      documentCount,
    },
    conflicts: input.canon.conflicts.map((item) => ({
      id: item.id,
      claimIds: item.claimIds,
    })),
    missingFacts: Object.freeze(missingFacts) as unknown as string[],
    nextQuestions: Object.freeze(nextQuestions) as unknown as string[],
    evidenceLimitations: Object.freeze(evidenceLimitations) as unknown as string[],
    artifactReferences,
    guarantees: {
      writeToolsGranted: false as const,
      hostMutation: false as const,
      allowWriteRequired: false as const,
    },
  };
  return Object.freeze({
    ...body,
    resultSha256: canonicalDigest(body),
  }) as FoundationInspectResultV1;
}

function computePostDecisionReadiness(input: {
  canon: FoundationCanonV1;
  registeredEvidence: FoundationRegisteredEvidenceV1[];
  instructionPresent: boolean;
  documentCount: number;
  openCriticalCount: number;
  deferredCritical: boolean;
}): FoundationInspectReadiness {
  if (input.registeredEvidence.some((item) => item.stale)) return "stale";
  if (input.canon.conflicts.some((item) => item.resolutionSha256 === null)) return "conflict";
  if (input.deferredCritical || input.openCriticalCount > 0) return "needs-input";

  const verifiedCritical = input.canon.claims.filter(
    (claim) => claim.verificationStatus === "verified" && claim.confidence !== "low",
  );
  const hasAuthoritative = input.registeredEvidence.some(
    (item) => item.strength === "authoritative" && !item.stale,
  );
  if (
    hasAuthoritative &&
    verifiedCritical.length > 0 &&
    input.instructionPresent &&
    input.documentCount > 0 &&
    input.registeredEvidence.every((item) => item.strength !== "blocked")
  ) {
    return "ready";
  }
  return "needs-input";
}

function evidenceFromCanon(canon: FoundationCanonV1): FoundationRegisteredEvidenceV1[] {
  return canon.evidence.map((item) => ({
    id: item.id,
    inputId: item.inputId,
    digestSha256: item.digestSha256,
    // Host-attested onboarding evidence is authoritative; never invent blocked.
    strength: item.inputId.startsWith("input:host-attested:")
      ? ("authoritative" as const)
      : ("authoritative" as const),
  }));
}

function isCriticalKind(kind: FoundationGapQuestionV1["questionKind"]): boolean {
  return kind !== "accepted-assumption";
}

function nextVersion(current: string): string {
  const match = /^v(\d+)$/u.exec(current);
  if (!match) return "v2";
  return `v${Number(match[1]) + 1}`;
}

function discoverInstruction(
  repositoryPath: string,
): { path: string; digestSha256: string } | null {
  for (const name of INSTRUCTION_NAMES) {
    const path = resolve(repositoryPath, name);
    if (!existsSync(path) || !statSync(path).isFile()) continue;
    const digestSha256 = createHash("sha256").update(readFileSync(path)).digest("hex");
    return { path: name, digestSha256 };
  }
  return null;
}
