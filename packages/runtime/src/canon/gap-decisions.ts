// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Host-owned foundation gap answer/decision authority.
 *
 * Opaque capabilities are minted only through createHostAuthorityFactory.
 * Decoded historical decision records and model lookalikes never mint or replay
 * answer authority. Decisions bind question, canon, repository/input versions,
 * authority identity, and expiry; stale bindings fail closed.
 */

import {
  createContractKit,
  createHostAuthorityFactory,
  createReceiptReplayGuard,
  deepFreeze,
  type ContractFail,
} from "../contract-kit/index.js";
import { sha256 } from "../content-ir/canonical.js";
import {
  createFoundationCanon,
  createFoundationCanonAffectedArtifact,
  createFoundationCanonAssumption,
  createFoundationCanonClaim,
  createFoundationCanonConflict,
  createFoundationCanonEvidence,
  decodeFoundationCanon,
  type FoundationCanonAssumptionV1,
  type FoundationCanonClaimV1,
  type FoundationCanonConflictV1,
  type FoundationCanonEvidenceV1,
  type FoundationCanonV1,
} from "./contracts.js";
import { decodeFoundationGapQuestion, type FoundationGapQuestionV1 } from "./gap-questions.js";

export const FOUNDATION_GAP_DECISION_DISPOSITIONS = [
  "answer",
  "reject",
  "defer",
  "accept-assumption",
] as const;

export type FoundationGapDecisionDisposition =
  (typeof FOUNDATION_GAP_DECISION_DISPOSITIONS)[number];

export type FoundationGapDecisionErrorCode =
  | "invalid-shape"
  | "invalid-value"
  | "digest-mismatch"
  | "credential-material"
  | "migration-required"
  | "authority-required"
  | "authority-replayed"
  | "authority-expired"
  | "stale-binding"
  | "over-broad-answer"
  | "unauthorized";

export class FoundationGapDecisionError extends Error {
  public constructor(public readonly code: FoundationGapDecisionErrorCode) {
    super(`Foundation gap decision rejected: ${code}.`);
    this.name = "FoundationGapDecisionError";
  }
}

function fail(code: FoundationGapDecisionErrorCode): never {
  throw new FoundationGapDecisionError(code);
}

const kit = createContractKit({
  fail: fail as ContractFail<FoundationGapDecisionErrorCode>,
  inertMode: "strict",
  codes: {
    invalidShape: "invalid-shape",
    invalidValue: "invalid-value",
    digestMismatch: "digest-mismatch",
    credentialMaterial: "credential-material",
    schemaMismatch: "migration-required",
  },
});

const receiptGuard = createReceiptReplayGuard(fail, "authority-replayed");

export interface FoundationGapDecisionChallengeV1 {
  schemaVersion: 1;
  kind: "docsfab-foundation-gap-decision-challenge";
  questionSha256: string;
  canonSha256: string;
  disposition: FoundationGapDecisionDisposition;
  answerValueSha256: string | null;
  authorityIdentitySha256: string;
  expiresAt: string;
  challengeSha256: string;
}

export interface FoundationGapDecisionHostVerifierV1 {
  verifyCurrent(challenge: FoundationGapDecisionChallengeV1): {
    status: "current";
    challengeSha256: string;
    observedAt: string;
    authorityReceiptSha256: string;
    authorityIdentitySha256: string;
  };
}

export type FoundationGapDecisionHostAuthority = {
  readonly kind: "docsfab-foundation-gap-decision-host-authority";
};

const hostAuthorities = createHostAuthorityFactory<
  "docsfab-foundation-gap-decision-host-authority",
  FoundationGapDecisionHostVerifierV1
>({
  kind: "docsfab-foundation-gap-decision-host-authority",
  invalidMessage: "Invalid foundation gap decision host verifier.",
});

/** Opaque decision capability; private object identity is the lease. */
export type FoundationGapDecisionCapability = {
  readonly kind: "docsfab-foundation-gap-decision-capability";
};

interface CapabilityState {
  decision: FoundationGapDecisionV1;
}

const capabilities = new WeakMap<object, CapabilityState>();

export interface FoundationGapDecisionBodyV1 {
  id: string;
  disposition: FoundationGapDecisionDisposition;
  questionId: string;
  questionSha256: string;
  questionKind: FoundationGapQuestionV1["questionKind"];
  canonId: string;
  canonVersion: string;
  canonSha256: string;
  repository: FoundationGapQuestionV1["repository"];
  inputBinding: FoundationGapQuestionV1["inputBinding"];
  authorityIdentitySha256: string;
  answerValueSha256: string | null;
  decidedAt: string;
  expiresAt: string;
  authorityReceiptSha256: string;
}

export type FoundationGapDecisionV1 = FoundationGapDecisionBodyV1 & {
  schemaVersion: 1;
  kind: "docsfab-foundation-gap-decision";
  decisionSha256: string;
};

export interface FoundationGapDecisionApplyResultV1 {
  priorCanon: FoundationCanonV1;
  canon: FoundationCanonV1;
  decisions: readonly FoundationGapDecisionV1[];
  acceptedAssumptionIds: readonly string[];
  verifiedClaimIds: readonly string[];
}

/** Mint an opaque host authority; lookalike objects never resolve. */
export function createFoundationGapDecisionHostAuthority(
  verifier: FoundationGapDecisionHostVerifierV1,
): FoundationGapDecisionHostAuthority {
  return hostAuthorities.create(verifier);
}

/**
 * Mint a single-use decision capability for one question. Decoded records and
 * forged authority objects cannot call this successfully.
 */
export function mintFoundationGapDecisionCapability(
  input: {
    question: FoundationGapQuestionV1;
    disposition: FoundationGapDecisionDisposition;
    /** Content-free digest of the bounded answer; required for answer/accept-assumption. */
    answerValueSha256?: string | null;
    authorityIdentitySha256: string;
    expiresAt: string;
    now: string;
  },
  authority: FoundationGapDecisionHostAuthority,
): FoundationGapDecisionCapability {
  kit.assertInert(input);
  kit.rejectCredentials(input);
  const verifier = hostAuthorities.lookup(authority);
  if (!verifier) fail("unauthorized");

  const question = decodeFoundationGapQuestion(input.question);
  const disposition = kit.enumeration(input.disposition, FOUNDATION_GAP_DECISION_DISPOSITIONS);
  const answerValueSha256 = normalizeAnswerDigest(disposition, input.answerValueSha256 ?? null);
  const authorityIdentitySha256 = kit.hash(input.authorityIdentitySha256);
  const expiresAt = kit.timestamp(input.expiresAt);
  const now = kit.timestamp(input.now);
  if (now >= expiresAt) fail("authority-expired");

  const challengeBody = {
    questionSha256: question.questionSha256,
    canonSha256: question.canonSha256,
    disposition,
    answerValueSha256,
    authorityIdentitySha256,
    expiresAt,
  };
  const challenge = kit.seal(
    "docsfab-foundation-gap-decision-challenge",
    "challengeSha256",
    challengeBody,
  ) as FoundationGapDecisionChallengeV1;

  const verified = verifier.verifyCurrent(challenge);
  kit.assertInert(verified);
  kit.rejectCredentials(verified);
  kit.exact(kit.object(verified), [
    "status",
    "challengeSha256",
    "observedAt",
    "authorityReceiptSha256",
    "authorityIdentitySha256",
  ]);
  if (
    verified.status !== "current" ||
    verified.challengeSha256 !== challenge.challengeSha256 ||
    kit.hash(verified.authorityIdentitySha256) !== authorityIdentitySha256
  ) {
    fail("authority-required");
  }
  const observedAt = kit.timestamp(verified.observedAt);
  if (observedAt >= expiresAt) fail("authority-expired");
  const receipt = kit.hash(verified.authorityReceiptSha256);
  receiptGuard.consume(verifier as object, receipt);

  const decision = kit.seal("docsfab-foundation-gap-decision", "decisionSha256", {
    id: kit.identifier(`decision:${question.id}`),
    disposition,
    questionId: question.id,
    questionSha256: question.questionSha256,
    questionKind: question.questionKind,
    canonId: question.canonId,
    canonVersion: question.canonVersion,
    canonSha256: question.canonSha256,
    repository: { ...question.repository },
    inputBinding: {
      manifestSha256: question.inputBinding.manifestSha256,
      inputIds: [...question.inputBinding.inputIds],
    },
    authorityIdentitySha256,
    answerValueSha256,
    decidedAt: observedAt,
    expiresAt,
    authorityReceiptSha256: receipt,
  }) as FoundationGapDecisionV1;

  const capability = Object.freeze({
    kind: "docsfab-foundation-gap-decision-capability" as const,
  });
  capabilities.set(capability, { decision });
  return capability;
}

/** Materialize the sealed decision from a live capability. */
export function createFoundationGapDecision(
  capability: FoundationGapDecisionCapability,
): FoundationGapDecisionV1 {
  const state = capabilities.get(capability as object);
  if (!state) fail("unauthorized");
  return state.decision;
}

/** Structural decode only — confers no authority and cannot be applied. */
export function decodeFoundationGapDecision(value: unknown): FoundationGapDecisionV1 {
  return kit.decodeSealed(
    value,
    "docsfab-foundation-gap-decision",
    "decisionSha256",
    [
      "id",
      "disposition",
      "questionId",
      "questionSha256",
      "questionKind",
      "canonId",
      "canonVersion",
      "canonSha256",
      "repository",
      "inputBinding",
      "authorityIdentitySha256",
      "answerValueSha256",
      "decidedAt",
      "expiresAt",
      "authorityReceiptSha256",
    ],
    normalizeDecisionBody,
  ) as FoundationGapDecisionV1;
}

/**
 * Apply live decision capabilities to a prior canon, producing a superseding
 * proposal. Decoded decision JSON is rejected (no capability → unauthorized).
 */
export function applyFoundationGapDecisions(input: {
  priorCanon: FoundationCanonV1;
  questions: readonly FoundationGapQuestionV1[];
  capabilities: readonly FoundationGapDecisionCapability[];
  /** Next canon version label (e.g. v2). */
  nextVersion: string;
  now: string;
}): FoundationGapDecisionApplyResultV1 {
  kit.assertInert({
    nextVersion: input.nextVersion,
    now: input.now,
  });
  const prior = decodeFoundationCanon(input.priorCanon);
  const now = kit.timestamp(input.now);
  const questionsById = new Map(
    input.questions.map((question) => {
      const decoded = decodeFoundationGapQuestion(question);
      return [decoded.id, decoded] as const;
    }),
  );

  const decisions: FoundationGapDecisionV1[] = [];
  for (const capability of input.capabilities) {
    const decision = createFoundationGapDecision(capability);
    decisions.push(decision);
  }
  decisions.sort((left, right) => kit.compare(left.id, right.id));
  if (new Set(decisions.map((item) => item.questionId)).size !== decisions.length) {
    fail("invalid-value");
  }

  for (const decision of decisions) {
    validateDecisionAgainstPrior(decision, prior, questionsById, now);
  }

  const built = buildSupersedingCanon({
    prior,
    decisions,
    questionsById,
    nextVersion: kit.identifier(input.nextVersion),
  });

  return deepFreeze({
    priorCanon: prior,
    canon: built.canon,
    decisions,
    acceptedAssumptionIds: built.acceptedAssumptionIds,
    verifiedClaimIds: built.verifiedClaimIds,
  }) as FoundationGapDecisionApplyResultV1;
}

function validateDecisionAgainstPrior(
  decision: FoundationGapDecisionV1,
  prior: FoundationCanonV1,
  questionsById: Map<string, FoundationGapQuestionV1>,
  now: string,
): void {
  const question = questionsById.get(decision.questionId);
  if (!question) fail("stale-binding");
  if (decision.questionSha256 !== question.questionSha256) fail("stale-binding");
  if (decision.canonSha256 !== prior.canonSha256) fail("stale-binding");
  if (decision.canonId !== prior.canonId || decision.canonVersion !== prior.version) {
    fail("stale-binding");
  }
  if (
    decision.repository.identitySha256 !== prior.repository.identitySha256 ||
    decision.repository.revision !== prior.repository.revision ||
    decision.repository.contentDigestSha256 !== prior.repository.contentDigestSha256
  ) {
    fail("stale-binding");
  }
  if (decision.inputBinding.manifestSha256 !== prior.inputBinding.manifestSha256) {
    fail("stale-binding");
  }
  if (!sameIds(decision.inputBinding.inputIds, prior.inputBinding.inputIds)) {
    fail("stale-binding");
  }
  if (decision.questionKind !== question.questionKind) fail("stale-binding");
  if (now >= decision.expiresAt) fail("authority-expired");
  // Answers resolve only the bound question — no write-scope / path expansion.
  if (decision.disposition === "answer" || decision.disposition === "accept-assumption") {
    if (decision.answerValueSha256 === null) fail("over-broad-answer");
  }
  if (decision.disposition === "reject" || decision.disposition === "defer") {
    if (decision.answerValueSha256 !== null) fail("over-broad-answer");
  }
}

function buildSupersedingCanon(input: {
  prior: FoundationCanonV1;
  decisions: readonly FoundationGapDecisionV1[];
  questionsById: Map<string, FoundationGapQuestionV1>;
  nextVersion: string;
}): {
  canon: FoundationCanonV1;
  acceptedAssumptionIds: string[];
  verifiedClaimIds: string[];
} {
  const evidence = new Map<string, FoundationCanonEvidenceV1>();
  for (const item of input.prior.evidence) evidence.set(item.id, item);
  const assumptions = new Map<string, FoundationCanonAssumptionV1>();
  for (const item of input.prior.assumptions) assumptions.set(item.id, item);
  const claims = new Map<string, FoundationCanonClaimV1>();
  for (const item of input.prior.claims) claims.set(item.id, item);
  const artifacts = new Map(input.prior.affectedArtifacts.map((item) => [item.id, item] as const));
  const conflicts = new Map<string, FoundationCanonConflictV1>(
    input.prior.conflicts.map((item) => [item.id, item] as const),
  );
  const inputIds = new Set(input.prior.inputBinding.inputIds);
  const acceptedAssumptionIds: string[] = [];
  const verifiedClaimIds: string[] = [];

  // Default affected artifact for host-attested onboarding claims.
  const onboardingArtifactId = "artifact-foundation-onboarding";
  if (!artifacts.has(onboardingArtifactId)) {
    artifacts.set(
      onboardingArtifactId,
      createFoundationCanonAffectedArtifact({
        id: onboardingArtifactId,
        path: "AGENTS.md",
        digestSha256: sha256(`foundation-onboarding-artifact:${input.prior.repository.revision}`),
      }),
    );
  }

  for (const decision of input.decisions) {
    if (decision.disposition === "defer" || decision.disposition === "reject") {
      continue;
    }
    const question = input.questionsById.get(decision.questionId)!;
    if (decision.disposition === "accept-assumption") {
      const assumptionId = `assumption:${decision.questionId}`;
      const assumption = createFoundationCanonAssumption({
        id: assumptionId,
        statementSha256: decision.answerValueSha256!,
      });
      assumptions.set(assumptionId, assumption);
      acceptedAssumptionIds.push(assumptionId);
      const claim = createFoundationCanonClaim({
        id: `claim:${decision.questionId}`,
        subjectSha256: sha256(`subject:${question.questionKind}`),
        assertionSha256: decision.answerValueSha256!,
        confidence: "medium",
        verificationStatus: "accepted-assumption",
        applicabilitySha256: sha256(`applicability:${question.questionKind}`),
        ownerAuthorityId: null,
        statementSha256: decision.answerValueSha256!,
        evidenceIds: [],
        assumptionIds: [assumptionId],
        dependencyIds: [],
        affectedArtifactIds: [onboardingArtifactId],
        conflictGroupId: null,
        supersededByClaimId: null,
      });
      claims.set(claim.id, claim);
      continue;
    }

    // answer
    const inputId = `input:host-attested:${decision.questionId}`;
    inputIds.add(inputId);
    const evidenceId = `evidence:${decision.questionId}`;
    evidence.set(
      evidenceId,
      createFoundationCanonEvidence({
        id: evidenceId,
        inputId,
        digestSha256: decision.answerValueSha256!,
      }),
    );
    if (question.questionKind === "conflict-resolution" && question.gapToken) {
      const conflictId = question.gapToken.replace(/^unresolved-conflict:/u, "");
      const existing = conflicts.get(conflictId);
      if (existing) {
        conflicts.set(
          conflictId,
          createFoundationCanonConflict({
            id: existing.id,
            claimIds: [...existing.claimIds],
            resolutionSha256: decision.answerValueSha256!,
          }),
        );
      }
    }
    const claim = createFoundationCanonClaim({
      id: `claim:${decision.questionId}`,
      subjectSha256: sha256(`subject:${question.questionKind}`),
      assertionSha256: decision.answerValueSha256!,
      confidence: "high",
      verificationStatus: "verified",
      applicabilitySha256: sha256(`applicability:${question.questionKind}`),
      ownerAuthorityId: null,
      statementSha256: decision.answerValueSha256!,
      evidenceIds: [evidenceId],
      assumptionIds: [],
      dependencyIds: [],
      affectedArtifactIds: [onboardingArtifactId],
      conflictGroupId: null,
      supersededByClaimId: null,
    });
    claims.set(claim.id, claim);
    verifiedClaimIds.push(claim.id);
  }

  // Drop conflicts that gained a resolution.
  const remainingConflicts = [...conflicts.values()].filter(
    (item) => item.resolutionSha256 === null,
  );

  const sortedInputIds = [...inputIds].sort(kit.compare);
  const canon = createFoundationCanon({
    canonId: input.prior.canonId,
    version: input.nextVersion,
    proposedBy: "operator",
    repository: { ...input.prior.repository },
    inputBinding: {
      manifestSha256: sha256(
        `foundation-onboarding-manifest:${sortedInputIds.join(",")}:${input.prior.canonSha256}`,
      ),
      inputIds: sortedInputIds,
    },
    state: "proposal",
    authority: null,
    claims: [...claims.values()],
    evidence: [...evidence.values()],
    conflicts: remainingConflicts,
    assumptions: [...assumptions.values()],
    dependencies: [...input.prior.dependencies],
    affectedArtifacts: [...artifacts.values()],
    supersession: {
      supersedesCanonSha256: input.prior.canonSha256,
      reasonSha256: sha256("foundation-gap-decision-rescore"),
    },
  });

  return {
    canon,
    acceptedAssumptionIds: acceptedAssumptionIds.sort(kit.compare),
    verifiedClaimIds: verifiedClaimIds.sort(kit.compare),
  };
}

function normalizeAnswerDigest(
  disposition: FoundationGapDecisionDisposition,
  value: string | null,
): string | null {
  if (disposition === "answer" || disposition === "accept-assumption") {
    if (value === null) fail("invalid-value");
    return kit.hash(value);
  }
  if (value !== null) fail("over-broad-answer");
  return null;
}

function normalizeDecisionBody(root: Record<string, unknown>): FoundationGapDecisionBodyV1 {
  kit.exact(root, [
    "id",
    "disposition",
    "questionId",
    "questionSha256",
    "questionKind",
    "canonId",
    "canonVersion",
    "canonSha256",
    "repository",
    "inputBinding",
    "authorityIdentitySha256",
    "answerValueSha256",
    "decidedAt",
    "expiresAt",
    "authorityReceiptSha256",
  ]);
  const repository = kit.object(root.repository);
  kit.exact(repository, ["identitySha256", "revision", "contentDigestSha256"]);
  const inputBinding = kit.object(root.inputBinding);
  kit.exact(inputBinding, ["manifestSha256", "inputIds"]);
  const disposition = kit.enumeration(root.disposition, FOUNDATION_GAP_DECISION_DISPOSITIONS);
  return {
    id: kit.identifier(root.id),
    disposition,
    questionId: kit.identifier(root.questionId),
    questionSha256: kit.hash(root.questionSha256),
    questionKind: kit.enumeration(root.questionKind, [
      "missing-fact",
      "conflict-resolution",
      "applicability",
      "audience",
      "ownership",
      "support-commitment",
      "output-scope",
      "accepted-assumption",
    ] as const),
    canonId: kit.identifier(root.canonId),
    canonVersion: kit.identifier(root.canonVersion),
    canonSha256: kit.hash(root.canonSha256),
    repository: {
      identitySha256: kit.hash(repository.identitySha256),
      revision: kit.revision(repository.revision),
      contentDigestSha256: kit.hash(repository.contentDigestSha256),
    },
    inputBinding: {
      manifestSha256: kit.hash(inputBinding.manifestSha256),
      inputIds: kit.array(inputBinding.inputIds).map(kit.identifier).sort(kit.compare),
    },
    authorityIdentitySha256: kit.hash(root.authorityIdentitySha256),
    answerValueSha256: root.answerValueSha256 === null ? null : kit.hash(root.answerValueSha256),
    decidedAt: kit.timestamp(root.decidedAt),
    expiresAt: kit.timestamp(root.expiresAt),
    authorityReceiptSha256: kit.hash(root.authorityReceiptSha256),
  };
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}
