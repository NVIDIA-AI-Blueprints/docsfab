// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Opaque freeze and independent-review authority for harness qualification.
 *
 * Host-authority identity, exact-commit GitLab approval, or owner-private Ed25519
 * may admit a corpus freeze. Lookalike objects, replayed receipts, and stale
 * bindings never resolve. Python scoring cannot mint these capabilities.
 */

import {
  createPublicKey,
  sign as signBytes,
  verify as verifyBytes,
  type KeyObject,
} from "node:crypto";

import {
  canonicalDigest,
  createContractKit,
  createHostAuthorityFactory,
  createReceiptReplayGuard,
  type ContractFail,
} from "../contract-kit/index.js";
import { isDnsHostname } from "../shared/dns-hostname.js";

export const QUALIFICATION_CORPUS_ID = "docsfab-harness-role-qualification-v1" as const;
export const QUALIFICATION_FREEZE_KIND = "docsfab-harness-qualification-corpus-freeze" as const;
export const QUALIFICATION_FREEZE_AUTHORITY_KIND =
  "docsfab-harness-qualification-freeze-authority" as const;
export const QUALIFICATION_REVIEW_AUTHORITY_KIND =
  "docsfab-harness-qualification-review-authority" as const;
export const QUALIFICATION_GITLAB_PROTOCOL = "external-gitlab-approval-v1" as const;

export const QUALIFICATION_BINDING_KEYS = [
  "corpus_id",
  "corpus_manifest_sha256",
  "private_manifest_sha256",
  "case_id",
  "case_sha256",
  "clean_case_id",
  "clean_case_sha256",
  "workflow_sha256",
  "skill_sha256",
  "quality_sha256",
  "output_schema_sha256",
  "thresholds_sha256",
  "scorer_sha256",
  "mutation_sha256",
  "baseline_sha256",
  "oracle_sha256",
  "governed_inputs_sha256",
  "seeded_prompt_sha256",
  "seeded_staging_manifest_sha256",
  "clean_prompt_sha256",
  "clean_staging_manifest_sha256",
] as const;

export type QualificationFreezeErrorCode =
  | "invalid-shape"
  | "invalid-value"
  | "digest-mismatch"
  | "credential-material"
  | "schema-mismatch"
  | "migration-required"
  | "unauthorized"
  | "authority-required"
  | "authority-replayed"
  | "authority-expired"
  | "stale-binding"
  | "invalid-review"
  | "gitlab-commit-mismatch"
  | "gitlab-host-required";

export class QualificationFreezeError extends Error {
  public constructor(public readonly code: QualificationFreezeErrorCode) {
    super(`Harness qualification freeze rejected (${code}).`);
    this.name = "QualificationFreezeError";
  }
}

function fail(code: QualificationFreezeErrorCode): never {
  throw new QualificationFreezeError(code);
}

const kit = createContractKit({
  fail: fail as ContractFail<QualificationFreezeErrorCode>,
  inertMode: "strict",
  codes: {
    invalidShape: "invalid-shape",
    invalidValue: "invalid-value",
    digestMismatch: "digest-mismatch",
    credentialMaterial: "credential-material",
    schemaMismatch: "migration-required",
  },
});

const freezeReceipts = createReceiptReplayGuard(fail, "authority-replayed");
const reviewReceipts = createReceiptReplayGuard(fail, "authority-replayed");

export type QualificationFreezeAuthorizationMethod =
  | "host-authority"
  | "gitlab-exact-commit"
  | "ed25519";

export interface QualificationCorpusBindingsV1 {
  readonly corpus_id: typeof QUALIFICATION_CORPUS_ID;
  readonly corpus_manifest_sha256: string;
  readonly private_manifest_sha256: string;
  readonly case_id: "seeded-comprehensive-evaluation-v1";
  readonly case_sha256: string;
  readonly clean_case_id: "clean-comparison-v1";
  readonly clean_case_sha256: string;
  readonly workflow_sha256: string;
  readonly skill_sha256: string;
  readonly quality_sha256: string;
  readonly output_schema_sha256: string;
  readonly thresholds_sha256: string;
  readonly scorer_sha256: string;
  readonly mutation_sha256: string;
  readonly baseline_sha256: string;
  readonly oracle_sha256: string;
  readonly governed_inputs_sha256: string;
  readonly seeded_prompt_sha256: string;
  readonly seeded_staging_manifest_sha256: string;
  readonly clean_prompt_sha256: string;
  readonly clean_staging_manifest_sha256: string;
}

export interface QualificationCorpusFreezeV1 {
  readonly schemaVersion: 1;
  readonly kind: typeof QUALIFICATION_FREEZE_KIND;
  readonly bindings: QualificationCorpusBindingsV1;
  readonly authorizedCommit: string;
  readonly expiresAt: string;
  readonly freezeSha256: string;
}

export interface QualificationFreezeChallengeV1 {
  readonly schemaVersion: 1;
  readonly kind: "docsfab-harness-qualification-freeze-challenge";
  readonly freezeSha256: string;
  readonly qualificationId: string;
  readonly expiresAt: string;
  readonly challengeSha256: string;
}

export interface QualificationFreezeVerificationV1 {
  readonly status: "current";
  readonly challengeSha256: string;
  readonly observedAt: string;
  readonly authorityReceiptSha256: string;
  readonly authorityIdentitySha256: string;
}

export interface QualificationFreezeVerifier {
  readonly freeze: QualificationCorpusFreezeV1;
  readonly method: QualificationFreezeAuthorizationMethod;
  verifyCurrent(challenge: QualificationFreezeChallengeV1): QualificationFreezeVerificationV1;
}

export type QualificationFreezeAuthority = {
  readonly kind: typeof QUALIFICATION_FREEZE_AUTHORITY_KIND;
};

export interface QualificationReviewBindingV1 {
  readonly evaluatorId: string;
  readonly sessionId: string;
  readonly priorContextPolicy: "none";
  readonly subjectSha256: string;
  readonly reportSha256: string;
  readonly attestationSha256: string;
  readonly decision: "accepted";
  readonly unresolvedFindingCount: 0;
}

export interface QualificationReviewVerifier {
  readonly binding: QualificationReviewBindingV1;
  verifyCurrent(challenge: { readonly bindingSha256: string }): { readonly status: "current" };
}

export type QualificationReviewAuthority = {
  readonly kind: typeof QUALIFICATION_REVIEW_AUTHORITY_KIND;
};

export interface QualificationGitlabCommitObservationV1 {
  readonly gitlabHost: string;
  readonly protocol: typeof QUALIFICATION_GITLAB_PROTOCOL;
  readonly projectPath: string;
  readonly mergeRequestIid: number;
  readonly authorizedCommit: string;
  readonly observedHeadSha: string;
  readonly approved: true;
  readonly freezeSha256: string;
  readonly observedAt: string;
}

export interface QualificationEd25519TrustV1 {
  readonly authorityId: string;
  readonly publicKeyPem: string;
}

export interface QualificationFreezeAdmissionV1 {
  readonly freeze: QualificationCorpusFreezeV1;
  readonly method: QualificationFreezeAuthorizationMethod;
  readonly observedAt: string;
  readonly authorityIdentitySha256: string;
}

const freezeAuthorities = createHostAuthorityFactory<
  typeof QUALIFICATION_FREEZE_AUTHORITY_KIND,
  QualificationFreezeVerifier
>({
  kind: QUALIFICATION_FREEZE_AUTHORITY_KIND,
  invalidMessage: "Harness qualification freeze verifier must expose verifyCurrent.",
});

const reviewAuthorities = createHostAuthorityFactory<
  typeof QUALIFICATION_REVIEW_AUTHORITY_KIND,
  QualificationReviewVerifier
>({
  kind: QUALIFICATION_REVIEW_AUTHORITY_KIND,
  invalidMessage: "Harness qualification review verifier must expose verifyCurrent.",
});

const PROJECT_PATH = /^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+$/u;
const QUALIFICATION_ID = /^mrq-[a-z0-9][a-z0-9-]{7,127}$/u;
const SESSION_ID =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$/u;
const SUBJECT_ID = /^[A-Za-z0-9][A-Za-z0-9._:/+@-]{0,255}$/u;
const COMMIT = /^[a-f0-9]{40}$/u;

export function decodeQualificationCorpusBindings(value: unknown): QualificationCorpusBindingsV1 {
  kit.assertInert(value);
  kit.rejectCredentials(value);
  const root = kit.object(value);
  kit.exact(root, QUALIFICATION_BINDING_KEYS);
  return {
    corpus_id: kit.enumeration(root.corpus_id, [QUALIFICATION_CORPUS_ID]),
    corpus_manifest_sha256: kit.hash(root.corpus_manifest_sha256),
    private_manifest_sha256: kit.hash(root.private_manifest_sha256),
    case_id: kit.enumeration(root.case_id, ["seeded-comprehensive-evaluation-v1"] as const),
    case_sha256: kit.hash(root.case_sha256),
    clean_case_id: kit.enumeration(root.clean_case_id, ["clean-comparison-v1"] as const),
    clean_case_sha256: kit.hash(root.clean_case_sha256),
    workflow_sha256: kit.hash(root.workflow_sha256),
    skill_sha256: kit.hash(root.skill_sha256),
    quality_sha256: kit.hash(root.quality_sha256),
    output_schema_sha256: kit.hash(root.output_schema_sha256),
    thresholds_sha256: kit.hash(root.thresholds_sha256),
    scorer_sha256: kit.hash(root.scorer_sha256),
    mutation_sha256: kit.hash(root.mutation_sha256),
    baseline_sha256: kit.hash(root.baseline_sha256),
    oracle_sha256: kit.hash(root.oracle_sha256),
    governed_inputs_sha256: kit.hash(root.governed_inputs_sha256),
    seeded_prompt_sha256: kit.hash(root.seeded_prompt_sha256),
    seeded_staging_manifest_sha256: kit.hash(root.seeded_staging_manifest_sha256),
    clean_prompt_sha256: kit.hash(root.clean_prompt_sha256),
    clean_staging_manifest_sha256: kit.hash(root.clean_staging_manifest_sha256),
  };
}

export function createQualificationCorpusFreeze(input: {
  bindings: QualificationCorpusBindingsV1;
  authorizedCommit: string;
  expiresAt: string;
}): QualificationCorpusFreezeV1 {
  kit.assertInert(input);
  kit.rejectCredentials(input);
  const root = kit.object(input);
  kit.exact(root, ["bindings", "authorizedCommit", "expiresAt"]);
  return kit.seal(QUALIFICATION_FREEZE_KIND, "freezeSha256", {
    bindings: decodeQualificationCorpusBindings(root.bindings),
    authorizedCommit: commitSha(root.authorizedCommit),
    expiresAt: kit.timestamp(root.expiresAt),
  }) as QualificationCorpusFreezeV1;
}

export function decodeQualificationCorpusFreeze(value: unknown): QualificationCorpusFreezeV1 {
  return kit.decodeSealed(
    value,
    QUALIFICATION_FREEZE_KIND,
    "freezeSha256",
    ["bindings", "authorizedCommit", "expiresAt"],
    (root) => ({
      bindings: decodeQualificationCorpusBindings(root.bindings),
      authorizedCommit: commitSha(root.authorizedCommit),
      expiresAt: kit.timestamp(root.expiresAt),
    }),
  );
}

export function createQualificationFreezeHostAuthority(
  verifier: QualificationFreezeVerifier,
): QualificationFreezeAuthority {
  decodeQualificationCorpusFreeze(verifier?.freeze);
  kit.enumeration(verifier.method, ["host-authority", "gitlab-exact-commit", "ed25519"] as const);
  try {
    return freezeAuthorities.create(verifier) as QualificationFreezeAuthority;
  } catch {
    fail("authority-required");
  }
}

export function signQualificationCorpusFreeze(
  freeze: QualificationCorpusFreezeV1,
  privateKey: KeyObject,
): string {
  const sealed = decodeQualificationCorpusFreeze(freeze);
  if (privateKey.type !== "private" || privateKey.asymmetricKeyType !== "ed25519") {
    fail("authority-required");
  }
  return signBytes(null, Buffer.from(sealed.freezeSha256, "hex"), privateKey).toString("base64url");
}

export function createQualificationFreezeFromEd25519(input: {
  freeze: QualificationCorpusFreezeV1;
  trust: QualificationEd25519TrustV1;
  signature: string;
  now: string;
}): QualificationFreezeAuthority {
  kit.assertInert(input);
  kit.rejectCredentials(input);
  const freeze = decodeQualificationCorpusFreeze(input.freeze);
  const now = kit.timestamp(input.now);
  if (now >= freeze.expiresAt) fail("authority-expired");
  const trustRoot = kit.object(input.trust);
  kit.exact(trustRoot, ["authorityId", "publicKeyPem"]);
  const authorityId = subjectId(trustRoot.authorityId);
  const publicKeyPem = kit.string(trustRoot.publicKeyPem);
  const signature = kit.string(input.signature);
  let publicKey: KeyObject;
  try {
    publicKey = createPublicKey(publicKeyPem);
  } catch {
    fail("authority-required");
  }
  if (publicKey.asymmetricKeyType !== "ed25519") fail("authority-required");
  let signatureBytes: Buffer;
  try {
    signatureBytes = Buffer.from(signature, "base64url");
  } catch {
    fail("unauthorized");
  }
  let verified = false;
  try {
    verified = verifyBytes(
      null,
      Buffer.from(freeze.freezeSha256, "hex"),
      publicKey,
      signatureBytes,
    );
  } catch {
    fail("unauthorized");
  }
  if (!verified) fail("unauthorized");
  const identity = kit.hash(
    canonicalDigest({ authorityId, publicKeyPem, method: "ed25519" as const }),
  );
  const receipt = kit.hash(canonicalDigest({ freezeSha256: freeze.freezeSha256, signature }));
  return createQualificationFreezeHostAuthority({
    freeze,
    method: "ed25519",
    verifyCurrent(challenge) {
      return currentVerification(challenge, freeze, now, receipt, identity);
    },
  });
}

/**
 * `trustedGitlabHost` is the host's configured GitLab; an observation from any
 * other host is refused, and there is no default host.
 */
export function createQualificationFreezeFromGitlabCommit(input: {
  freeze: QualificationCorpusFreezeV1;
  observation: QualificationGitlabCommitObservationV1;
  trustedGitlabHost: string;
  now: string;
}): QualificationFreezeAuthority {
  kit.assertInert(input);
  kit.rejectCredentials(input);
  const trustedGitlabHost = input.trustedGitlabHost;
  if (!isDnsHostname(trustedGitlabHost)) {
    fail("gitlab-host-required");
  }
  const freeze = decodeQualificationCorpusFreeze(input.freeze);
  const now = kit.timestamp(input.now);
  if (now >= freeze.expiresAt) fail("authority-expired");
  const observation = decodeGitlabObservation(input.observation, trustedGitlabHost);
  if (observation.freezeSha256 !== freeze.freezeSha256) fail("stale-binding");
  if (observation.authorizedCommit !== freeze.authorizedCommit) fail("gitlab-commit-mismatch");
  if (observation.observedHeadSha !== freeze.authorizedCommit) fail("gitlab-commit-mismatch");
  if (observation.observedAt >= freeze.expiresAt) fail("authority-expired");
  const identity = kit.hash(
    canonicalDigest({
      gitlabHost: observation.gitlabHost,
      projectPath: observation.projectPath,
      mergeRequestIid: observation.mergeRequestIid,
      authorizedCommit: observation.authorizedCommit,
    }),
  );
  const receipt = kit.hash(
    canonicalDigest({
      freezeSha256: freeze.freezeSha256,
      observedHeadSha: observation.observedHeadSha,
      observedAt: observation.observedAt,
    }),
  );
  return createQualificationFreezeHostAuthority({
    freeze,
    method: "gitlab-exact-commit",
    verifyCurrent(challenge) {
      return currentVerification(challenge, freeze, observation.observedAt, receipt, identity);
    },
  });
}

export function createQualificationReviewHostAuthority(
  verifier: QualificationReviewVerifier,
): QualificationReviewAuthority {
  decodeReviewBinding(verifier?.binding);
  try {
    return reviewAuthorities.create(verifier) as QualificationReviewAuthority;
  } catch {
    fail("authority-required");
  }
}

export function requireQualificationFreeze(input: {
  authority: QualificationFreezeAuthority;
  bindings: QualificationCorpusBindingsV1;
  qualificationId: string;
  now: string;
}): QualificationFreezeAdmissionV1 {
  const verifier = freezeAuthorities.lookup(input.authority);
  if (!verifier) fail("unauthorized");
  const freeze = decodeQualificationCorpusFreeze(verifier.freeze);
  const bindings = decodeQualificationCorpusBindings(input.bindings);
  const now = kit.timestamp(input.now);
  const qualificationId = qualificationIdValue(input.qualificationId);
  if (now >= freeze.expiresAt) fail("authority-expired");
  if (canonicalDigest(bindings) !== canonicalDigest(freeze.bindings)) fail("stale-binding");
  const challenge = kit.seal("docsfab-harness-qualification-freeze-challenge", "challengeSha256", {
    freezeSha256: freeze.freezeSha256,
    qualificationId,
    expiresAt: freeze.expiresAt,
  }) as QualificationFreezeChallengeV1;
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
  if (verified.status !== "current" || verified.challengeSha256 !== challenge.challengeSha256) {
    fail("authority-required");
  }
  const observedAt = kit.timestamp(verified.observedAt);
  if (observedAt >= freeze.expiresAt) fail("authority-expired");
  const receipt = kit.hash(
    canonicalDigest({
      authorityReceiptSha256: verified.authorityReceiptSha256,
      freezeSha256: freeze.freezeSha256,
      qualificationId,
    }),
  );
  freezeReceipts.consume(verifier as object, receipt);
  return {
    freeze,
    method: kit.enumeration(verifier.method, [
      "host-authority",
      "gitlab-exact-commit",
      "ed25519",
    ] as const),
    observedAt,
    authorityIdentitySha256: kit.hash(verified.authorityIdentitySha256),
  };
}

export function requireQualificationReview(input: {
  authority: QualificationReviewAuthority;
  evaluation: QualificationReviewBindingV1;
}): QualificationReviewBindingV1 {
  const verifier = reviewAuthorities.lookup(input.authority);
  if (!verifier) fail("unauthorized");
  const expected = decodeReviewBinding(verifier.binding);
  const actual = decodeReviewBinding(input.evaluation);
  if (canonicalDigest(expected) !== canonicalDigest(actual)) fail("invalid-review");
  const bindingSha256 = canonicalDigest(expected);
  const verified = verifier.verifyCurrent({ bindingSha256 });
  kit.assertInert(verified);
  kit.rejectCredentials(verified);
  kit.exact(kit.object(verified), ["status"]);
  if (verified.status !== "current") fail("invalid-review");
  reviewReceipts.consume(verifier as object, kit.hash(bindingSha256));
  return expected;
}

export function decodeReviewBinding(value: unknown): QualificationReviewBindingV1 {
  kit.assertInert(value);
  kit.rejectCredentials(value);
  const root = kit.object(value);
  kit.exact(root, [
    "evaluatorId",
    "sessionId",
    "priorContextPolicy",
    "subjectSha256",
    "reportSha256",
    "attestationSha256",
    "decision",
    "unresolvedFindingCount",
  ]);
  const unresolvedFindingCount = root.unresolvedFindingCount;
  if (unresolvedFindingCount !== 0) fail("invalid-review");
  return {
    evaluatorId: subjectId(root.evaluatorId),
    sessionId: sessionId(root.sessionId),
    priorContextPolicy: kit.enumeration(root.priorContextPolicy, ["none"] as const),
    subjectSha256: kit.hash(root.subjectSha256),
    reportSha256: kit.hash(root.reportSha256),
    attestationSha256: kit.hash(root.attestationSha256),
    decision: kit.enumeration(root.decision, ["accepted"] as const),
    unresolvedFindingCount: 0,
  };
}

function currentVerification(
  challenge: QualificationFreezeChallengeV1,
  freeze: QualificationCorpusFreezeV1,
  observedAt: string,
  receipt: string,
  identity: string,
): QualificationFreezeVerificationV1 {
  kit.assertInert(challenge);
  kit.rejectCredentials(challenge);
  const root = kit.object(challenge);
  kit.exact(root, [
    "schemaVersion",
    "kind",
    "freezeSha256",
    "qualificationId",
    "expiresAt",
    "challengeSha256",
  ]);
  if (
    root.schemaVersion !== 1 ||
    root.kind !== "docsfab-harness-qualification-freeze-challenge" ||
    kit.hash(root.freezeSha256) !== freeze.freezeSha256 ||
    kit.timestamp(root.expiresAt) !== freeze.expiresAt
  ) {
    fail("authority-required");
  }
  qualificationIdValue(root.qualificationId);
  return {
    status: "current",
    challengeSha256: kit.hash(root.challengeSha256),
    observedAt,
    authorityReceiptSha256: receipt,
    authorityIdentitySha256: identity,
  };
}

function decodeGitlabObservation(
  value: unknown,
  trustedGitlabHost: string,
): QualificationGitlabCommitObservationV1 {
  kit.assertInert(value);
  kit.rejectCredentials(value);
  const root = kit.object(value);
  kit.exact(root, [
    "gitlabHost",
    "protocol",
    "projectPath",
    "mergeRequestIid",
    "authorizedCommit",
    "observedHeadSha",
    "approved",
    "freezeSha256",
    "observedAt",
  ]);
  if (root.approved !== true) fail("unauthorized");
  const projectPath = kit.string(root.projectPath);
  if (!PROJECT_PATH.test(projectPath)) fail("invalid-value");
  const mergeRequestIid = root.mergeRequestIid;
  if (!Number.isSafeInteger(mergeRequestIid) || (mergeRequestIid as number) < 1) {
    fail("invalid-value");
  }
  return {
    gitlabHost: kit.enumeration(root.gitlabHost, [trustedGitlabHost]),
    protocol: kit.enumeration(root.protocol, [QUALIFICATION_GITLAB_PROTOCOL]),
    projectPath,
    mergeRequestIid: mergeRequestIid as number,
    authorizedCommit: commitSha(root.authorizedCommit),
    observedHeadSha: commitSha(root.observedHeadSha),
    approved: true,
    freezeSha256: kit.hash(root.freezeSha256),
    observedAt: kit.timestamp(root.observedAt),
  };
}

function commitSha(value: unknown): string {
  const result = kit.revision(value);
  if (!COMMIT.test(result)) fail("invalid-value");
  return result;
}

function qualificationIdValue(value: unknown): string {
  const result = kit.string(value);
  if (!QUALIFICATION_ID.test(result)) fail("invalid-value");
  return result;
}

function subjectId(value: unknown): string {
  const result = kit.string(value);
  if (!SUBJECT_ID.test(result)) fail("invalid-value");
  return result;
}

function sessionId(value: unknown): string {
  const result = kit.string(value);
  if (!SESSION_ID.test(result)) fail("invalid-value");
  return result;
}
