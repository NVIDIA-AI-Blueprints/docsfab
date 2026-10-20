// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Read-only foundation inspection: claim proposals → FoundationCanonV1 → readiness.
 *
 * Consumes public `src/canon/` APIs only. Never grants write tools or mutates the
 * selected repository checkout.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";

import {
  createFoundationCanon,
  createFoundationCanonAffectedArtifact,
  createFoundationCanonClaim,
  createFoundationCanonConflict,
  createFoundationCanonEvidence,
  projectFoundationCanonSurfaces,
  projectFoundationGapQuestions,
  type FoundationCanonV1,
} from "../canon/index.js";
import { buildContentIndex, canonicalDigest } from "../content-ir/index.js";
import { sha256 } from "../content-ir/canonical.js";
import { limit } from "../config/limits.js";
import { createContractKit, type ContractFail } from "../contract-kit/index.js";
import {
  foundationReadinessToProductDisposition,
  type FoundationInspectReadiness,
} from "./readiness.js";

/**
 * Admitted length of one claim label, in UTF-16 units.
 *
 * Named here and resolved per inspection so the bound an operator reads in
 * `config/limits.yaml` is the bound this decoder enforces.
 */
export const FOUNDATION_CLAIM_LABEL_MAX_CHARS_LIMIT = "foundation.claimLabelMaxChars" as const;

export type FoundationInspectErrorCode =
  | "invalid-shape"
  | "invalid-value"
  | "digest-mismatch"
  | "credential-material"
  | "migration-required"
  | "host-mutation-denied";

export class FoundationInspectError extends Error {
  public constructor(public readonly code: FoundationInspectErrorCode) {
    super(`Foundation inspection rejected: ${code}.`);
    this.name = "FoundationInspectError";
  }
}

function fail(code: FoundationInspectErrorCode): never {
  throw new FoundationInspectError(code);
}

const kit = createContractKit({
  fail: fail as ContractFail<FoundationInspectErrorCode>,
  codes: {
    invalidShape: "invalid-shape",
    invalidValue: "invalid-value",
    digestMismatch: "digest-mismatch",
    credentialMaterial: "credential-material",
    schemaMismatch: "migration-required",
  },
});

const INSTRUCTION_NAMES = ["AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"] as const;

/** Registered evidence available to citation (never raw payload in the result). */
export interface FoundationRegisteredEvidenceV1 {
  id: string;
  inputId: string;
  digestSha256: string;
  /** Strength used only for readiness scoring; blocked sources stay explicit. */
  strength: "authoritative" | "weak" | "blocked";
  stale?: boolean;
}

export interface FoundationClaimProposalV1 {
  id: string;
  subjectLabel: string;
  assertionLabel: string;
  statementLabel: string;
  applicabilityLabel: string;
  evidenceIds: string[];
  /** Omit all three when an approved model claim has no nominated repository artifact. */
  affectedArtifactId?: string;
  affectedArtifactPath?: string;
  affectedArtifactDigestSha256?: string;
  confidence: "low" | "medium" | "high";
  verificationStatus: "unverified" | "verified";
  conflictGroupId?: string | null;
}

export interface FoundationInspectInputV1 {
  /** Exact disposable checkout selected by the workflow runner. */
  repositoryPath: string;
  repositoryRevision: string;
  /** Optional precomputed repository binding; otherwise derived from Content IR. */
  repositoryIdentitySha256?: string;
  repositoryContentDigestSha256?: string;
  /** Empty binding when no external inputs are registered. */
  inputBinding?: {
    manifestSha256: string;
    inputIds: string[];
  };
  registeredEvidence?: readonly FoundationRegisteredEvidenceV1[];
  claimProposals?: readonly FoundationClaimProposalV1[];
  /** Retained source conflicts can cite source-thread claims outside this canon. */
  sourceConflicts?: readonly { id: string; claimIds: readonly string[] }[];
  /** Named limitations the caller already knows about this inspection's inputs. */
  evidenceLimitations?: readonly string[];
  priorCanon?: FoundationCanonV1 | null;
  /** Stable proposal identity; defaults to a digest of revision + inputs. */
  canonId?: string;
  version?: string;
}

export interface FoundationInspectArtifactRefV1 {
  role: "candidate-canon" | "prior-canon" | "machine-projection" | "human-report";
  canonSha256?: string;
  projectionSha256?: string;
  reportSha256?: string;
}

export interface FoundationInspectResultV1 {
  schemaVersion: 1;
  kind: "docsfab-foundation-inspect-result";
  readiness: FoundationInspectReadiness;
  productDisposition: ReturnType<typeof foundationReadinessToProductDisposition>;
  canon: FoundationCanonV1;
  summary: {
    canonId: string;
    version: string;
    state: FoundationCanonV1["state"];
    claimCount: number;
    evidenceCount: number;
    conflictCount: number;
    instructionPresent: boolean;
    documentCount: number;
  };
  conflicts: readonly { id: string; claimIds: readonly string[] }[];
  missingFacts: readonly string[];
  nextQuestions: readonly string[];
  evidenceLimitations: readonly string[];
  artifactReferences: readonly FoundationInspectArtifactRefV1[];
  /** Explicit proof the inspection path never granted mutation. */
  guarantees: {
    writeToolsGranted: false;
    hostMutation: false;
    allowWriteRequired: false;
  };
  resultSha256: string;
}

/**
 * Inspect a revision-bound workspace and produce a closed candidate canon plus
 * readiness. Read-only: never writes into `repositoryPath`.
 */
export async function inspectFoundation(
  input: FoundationInspectInputV1,
): Promise<FoundationInspectResultV1> {
  kit.assertInert(input);
  kit.rejectCredentials(input);
  if (typeof input.repositoryPath !== "string" || input.repositoryPath.length === 0) {
    fail("invalid-value");
  }
  const revision = kit.revision(input.repositoryRevision);

  const index = await buildContentIndex({
    repositoryPath: input.repositoryPath,
    repositoryRevision: revision,
  });
  const contentDigestSha256 = input.repositoryContentDigestSha256
    ? kit.hash(input.repositoryContentDigestSha256)
    : kit.hash(index.repository.contentDigest);
  // Content IR exposes revision + content digest only; canon identity is a
  // content-free binding over those digests (never a host path).
  const identitySha256 = input.repositoryIdentitySha256
    ? kit.hash(input.repositoryIdentitySha256)
    : sha256(`foundation-repo-identity:${revision}:${contentDigestSha256}`);

  const instruction = discoverInstructionIdentity(input.repositoryPath);
  const registeredEvidence = [...(input.registeredEvidence ?? [])]
    .map(normalizeEvidence)
    .sort((left, right) => kit.compare(left.id, right.id));
  const evidenceById = new Map(registeredEvidence.map((item) => [item.id, item]));
  const inputBinding = normalizeInputBinding(input.inputBinding, registeredEvidence);

  // Resolved once per inspection, not once per label: `limit()` re-reads the
  // effective catalog, and a claim carries four labels.
  const labelMaxChars = limit(FOUNDATION_CLAIM_LABEL_MAX_CHARS_LIMIT).value;
  const proposals = [...(input.claimProposals ?? [])]
    .map((proposal) =>
      normalizeProposal(proposal, evidenceById, inputBinding.inputIds, labelMaxChars),
    )
    .sort((left, right) => kit.compare(left.id, right.id));

  const evidenceRecords = registeredEvidence.map((item) =>
    createFoundationCanonEvidence({
      id: item.id,
      inputId: item.inputId,
      digestSha256: item.digestSha256,
    }),
  );

  const affectedById = new Map<string, ReturnType<typeof createFoundationCanonAffectedArtifact>>();
  for (const proposal of proposals) {
    // Condition: this claim nominated a repository artifact. A general claim
    // that nominated none must NOT mint a placeholder artifact identity.
    if (proposal.affectedArtifactId === undefined) continue;
    if (!affectedById.has(proposal.affectedArtifactId)) {
      affectedById.set(
        proposal.affectedArtifactId,
        createFoundationCanonAffectedArtifact({
          id: proposal.affectedArtifactId,
          path: proposal.affectedArtifactPath!,
          digestSha256: proposal.affectedArtifactDigestSha256!,
        }),
      );
    }
  }

  const claims = proposals.map((proposal) =>
    createFoundationCanonClaim({
      id: proposal.id,
      subjectSha256: sha256(proposal.subjectLabel),
      assertionSha256: sha256(proposal.assertionLabel),
      confidence: proposal.confidence,
      verificationStatus: proposal.verificationStatus,
      applicabilitySha256: sha256(proposal.applicabilityLabel),
      ownerAuthorityId: null,
      statementSha256: sha256(proposal.statementLabel),
      evidenceIds: [...proposal.evidenceIds],
      assumptionIds: [],
      dependencyIds: [],
      affectedArtifactIds:
        proposal.affectedArtifactId === undefined ? [] : [proposal.affectedArtifactId],
      conflictGroupId: proposal.conflictGroupId ?? null,
      supersededByClaimId: null,
    }),
  );

  const conflictGroups = new Map<string, string[]>();
  for (const claim of claims) {
    if (claim.conflictGroupId === null) continue;
    const group = conflictGroups.get(claim.conflictGroupId) ?? [];
    group.push(claim.id);
    conflictGroups.set(claim.conflictGroupId, group);
  }
  const conflicts = [...conflictGroups.entries()]
    .filter(([, claimIds]) => claimIds.length >= 2)
    .map(([id, claimIds]) =>
      createFoundationCanonConflict({
        id,
        claimIds: [...claimIds].sort((left, right) => kit.compare(left, right)),
        resolutionSha256: null,
      }),
    )
    .sort((left, right) => kit.compare(left.id, right.id));

  const prior = input.priorCanon ?? null;
  const supersession = prior
    ? {
        supersedesCanonSha256: prior.canonSha256,
        reasonSha256: sha256("foundation-inspect-rescore"),
      }
    : null;

  const canonId = input.canonId
    ? kit.identifier(input.canonId)
    : kit.identifier(`foundation-${revision.slice(0, 12)}`);
  const version = input.version ? kit.identifier(input.version) : "v1";

  const canon = createFoundationCanon({
    canonId,
    version,
    proposedBy: "operator",
    repository: {
      identitySha256,
      revision,
      contentDigestSha256,
    },
    inputBinding,
    state: "proposal",
    authority: null,
    claims,
    evidence: evidenceRecords,
    conflicts,
    assumptions: [],
    dependencies: [],
    affectedArtifacts: [...affectedById.values()].sort((left, right) =>
      kit.compare(left.id, right.id),
    ),
    supersession,
  });

  // Conflicts this canon minted, plus retained conflicts the caller carried in
  // that cite claims outside it. A retained conflict with an id the canon
  // already minted is NOT added twice: the canon's own record wins.
  const sourceConflicts = (input.sourceConflicts ?? []).map((item) => ({
    id: kit.identifier(item.id),
    claimIds: item.claimIds.map((id) => kit.string(id)),
  }));
  const observedConflicts = [
    ...conflicts,
    ...sourceConflicts.filter((item) => !conflicts.some((existing) => existing.id === item.id)),
  ];
  const readiness = computeReadiness({
    claims,
    conflicts: observedConflicts,
    registeredEvidence,
    instructionPresent: instruction !== null,
    documentCount: index.nodes.filter((node) => node.kind === "document").length,
  });
  const { missingFacts, nextQuestions, evidenceLimitations } = projectGaps({
    readiness,
    registeredEvidence,
    claims,
    conflicts: observedConflicts,
    instructionPresent: instruction !== null,
    canon,
  });

  const surfaces = projectFoundationCanonSurfaces(canon);
  const artifactReferences: FoundationInspectArtifactRefV1[] = [
    { role: "candidate-canon", canonSha256: canon.canonSha256 },
    {
      role: "machine-projection",
      canonSha256: canon.canonSha256,
      projectionSha256: surfaces.machine.projectionSha256,
    },
    {
      role: "human-report",
      canonSha256: canon.canonSha256,
      reportSha256: surfaces.report.reportSha256,
    },
  ];
  if (prior) {
    artifactReferences.push({ role: "prior-canon", canonSha256: prior.canonSha256 });
  }

  const body = {
    schemaVersion: 1 as const,
    kind: "docsfab-foundation-inspect-result" as const,
    readiness,
    productDisposition: foundationReadinessToProductDisposition(readiness),
    canon,
    summary: {
      canonId: canon.canonId,
      version: canon.version,
      state: canon.state,
      claimCount: canon.claims.length,
      evidenceCount: canon.evidence.length,
      conflictCount: observedConflicts.length,
      instructionPresent: instruction !== null,
      documentCount: index.nodes.filter((node) => node.kind === "document").length,
    },
    conflicts: observedConflicts.map((item) => ({ id: item.id, claimIds: item.claimIds })),
    missingFacts,
    nextQuestions,
    evidenceLimitations: [
      ...evidenceLimitations,
      ...(input.evidenceLimitations ?? []).map((value) => kit.string(value)),
    ],
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

/**
 * Stable empty-input inspection used when the operator has not registered
 * external evidence yet. Always yields needs-input on incomplete goldens.
 */
export function incompleteFoundationInspectSeed(
  revision: string,
): Pick<FoundationInspectInputV1, "inputBinding" | "registeredEvidence" | "claimProposals"> {
  return {
    inputBinding: {
      manifestSha256: sha256(`foundation-empty-manifest:${revision}`),
      inputIds: [],
    },
    registeredEvidence: [],
    claimProposals: [],
  };
}

function computeReadiness(input: {
  claims: ReturnType<typeof createFoundationCanonClaim>[];
  conflicts: readonly { id: string; claimIds: readonly string[] }[];
  registeredEvidence: FoundationRegisteredEvidenceV1[];
  instructionPresent: boolean;
  documentCount: number;
}): FoundationInspectReadiness {
  if (input.registeredEvidence.some((item) => !SHA256.test(item.digestSha256))) {
    return "invalid";
  }
  if (input.registeredEvidence.some((item) => item.stale)) {
    return "stale";
  }
  if (input.conflicts.length > 0) {
    return "conflict";
  }
  const verifiedCritical = input.claims.filter(
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

function projectGaps(input: {
  readiness: FoundationInspectReadiness;
  registeredEvidence: FoundationRegisteredEvidenceV1[];
  claims: ReturnType<typeof createFoundationCanonClaim>[];
  conflicts: readonly { id: string; claimIds: readonly string[] }[];
  instructionPresent: boolean;
  canon: FoundationCanonV1;
}): {
  missingFacts: string[];
  nextQuestions: string[];
  evidenceLimitations: string[];
} {
  const missingFacts: string[] = [];
  const evidenceLimitations: string[] = [];
  if (!input.instructionPresent) {
    missingFacts.push("repository-instructions-absent");
  }
  if (input.registeredEvidence.length === 0) {
    missingFacts.push("registered-evidence-absent");
  }
  if (input.claims.length === 0) {
    missingFacts.push("verified-claims-absent");
  }
  for (const item of input.registeredEvidence) {
    if (item.strength === "blocked") {
      evidenceLimitations.push(`blocked-source:${item.id}`);
    } else if (item.strength === "weak") {
      evidenceLimitations.push(`weak-source:${item.id}`);
    }
    if (item.stale) {
      evidenceLimitations.push(`stale-source:${item.id}`);
    }
  }
  for (const conflict of input.conflicts) {
    evidenceLimitations.push(`unresolved-conflict:${conflict.id}`);
  }

  const nextQuestions =
    input.readiness === "ready"
      ? []
      : projectFoundationGapQuestions({
          canon: input.canon,
          missingFacts,
          conflictIds: input.conflicts.map((item) => item.id),
          evidenceLimitations,
        }).map((question) => question.promptLabel);

  return {
    missingFacts: Object.freeze(missingFacts) as unknown as string[],
    nextQuestions: Object.freeze(nextQuestions) as unknown as string[],
    evidenceLimitations: Object.freeze(evidenceLimitations) as unknown as string[],
  };
}

function discoverInstructionIdentity(
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

function normalizeEvidence(value: FoundationRegisteredEvidenceV1): FoundationRegisteredEvidenceV1 {
  kit.assertInert(value);
  kit.rejectCredentials(value);
  return {
    id: kit.identifier(value.id),
    inputId: kit.identifier(value.inputId),
    digestSha256: kit.hash(value.digestSha256),
    strength: kit.enumeration(value.strength, ["authoritative", "weak", "blocked"] as const),
    ...(value.stale ? { stale: true } : {}),
  };
}

function normalizeInputBinding(
  binding: FoundationInspectInputV1["inputBinding"],
  evidence: readonly FoundationRegisteredEvidenceV1[],
): { manifestSha256: string; inputIds: string[] } {
  if (binding) {
    const inputIds = [...binding.inputIds]
      .map((id) => kit.identifier(id))
      .sort((left, right) => kit.compare(left, right));
    return { manifestSha256: kit.hash(binding.manifestSha256), inputIds };
  }
  const inputIds = [...new Set(evidence.map((item) => item.inputId))].sort((left, right) =>
    kit.compare(left, right),
  );
  return {
    manifestSha256: sha256(`foundation-derived-manifest:${inputIds.join(",")}`),
    inputIds,
  };
}

function normalizeProposal(
  proposal: FoundationClaimProposalV1,
  evidenceById: Map<string, FoundationRegisteredEvidenceV1>,
  inputIds: readonly string[],
  labelMaxChars: number,
): FoundationClaimProposalV1 {
  kit.assertInert(proposal);
  kit.rejectCredentials(proposal);
  const evidenceIds = [...proposal.evidenceIds]
    .map((id) => kit.identifier(id))
    .sort((left, right) => kit.compare(left, right));
  if (evidenceIds.length === 0) fail("invalid-value");
  for (const evidenceId of evidenceIds) {
    const evidence = evidenceById.get(evidenceId);
    if (!evidence) fail("invalid-value");
    if (!inputIds.includes(evidence.inputId)) fail("invalid-value");
  }
  const verificationStatus = kit.enumeration(proposal.verificationStatus, [
    "unverified",
    "verified",
  ] as const);
  // Condition: the nominated-artifact triple is present. It is all-or-nothing:
  // any one of the three field names present requires the other two to parse,
  // so a half-populated nomination is refused rather than silently dropped. A
  // proposal naming NONE of the three keeps no artifact at all.
  const affected =
    proposal.affectedArtifactId !== undefined ||
    proposal.affectedArtifactPath !== undefined ||
    proposal.affectedArtifactDigestSha256 !== undefined
      ? {
          affectedArtifactId: kit.identifier(proposal.affectedArtifactId),
          affectedArtifactPath: safePath(kit.string(proposal.affectedArtifactPath)),
          affectedArtifactDigestSha256: kit.hash(proposal.affectedArtifactDigestSha256),
        }
      : {};
  // Unverified claims remain proposed; verified claims still must cite evidence.
  return {
    id: kit.identifier(proposal.id),
    subjectLabel: nonEmptyLabel(proposal.subjectLabel, labelMaxChars),
    assertionLabel: nonEmptyLabel(proposal.assertionLabel, labelMaxChars),
    statementLabel: nonEmptyLabel(proposal.statementLabel, labelMaxChars),
    applicabilityLabel: nonEmptyLabel(proposal.applicabilityLabel, labelMaxChars),
    evidenceIds,
    ...affected,
    confidence: kit.enumeration(proposal.confidence, ["low", "medium", "high"] as const),
    verificationStatus,
    conflictGroupId:
      proposal.conflictGroupId === undefined || proposal.conflictGroupId === null
        ? null
        : kit.identifier(proposal.conflictGroupId),
  };
}

function nonEmptyLabel(value: string, maxChars: number): string {
  // Condition: the label is absent, empty, longer than the admitted claim-label
  // ceiling, or carries a NUL. The ceiling is `foundation.claimLabelMaxChars`,
  // sized so an inherited approved statement, a complete sentence, fits.
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maxChars ||
    value.includes("\0")
  ) {
    fail("invalid-value");
  }
  kit.rejectCredentials(value);
  return value;
}

function safePath(value: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.startsWith("/") ||
    value.includes("\\") ||
    value.includes("\0") ||
    !value
      .split("/")
      .every(
        (part) =>
          part.length > 0 &&
          part !== "." &&
          part !== ".." &&
          /^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(part),
      )
  ) {
    fail("invalid-value");
  }
  return value;
}

const SHA256 = /^[a-f0-9]{64}$/u;
