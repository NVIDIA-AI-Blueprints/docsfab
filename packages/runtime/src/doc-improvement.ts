// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createPublicKey, verify as verifyBytes } from "node:crypto";

import type { RunRecord } from "./records/contracts.js";
import type { BoundedDocImprovementTaskInput } from "./workflow-contracts/contracts.js";
import { canonicalDigest, sha256 } from "./content-ir/canonical.js";
import { validateIaPlanReviewerPolicy, type IaPlanReviewerPolicy } from "./ia/plan-review.js";
import { detectCredentialRuleIds } from "./security/repository-scanner.js";
import { authorizeSecurityScan } from "./security/scan-override.js";
import { resolveSecurityScanEffectiveDisposition } from "./security/scan-disposition.js";
import type { WorkflowOutcomeDecodeOptionsV1 } from "./workflow-contracts/outcome.js";
import { isPlainRecord, compareText } from "./shared/primitives.js";
import { DocImprovementEvidenceError, fail } from "./doc-improvement/evidence-error.js";
import { SHA256, identifier, sameStrings, timestamp } from "./doc-improvement/primitives.js";
import { runSummary } from "./doc-improvement/run-record.js";
import type { RunEvidenceSummary } from "./doc-improvement/run-record-types.js";
export { DocImprovementEvidenceError } from "./doc-improvement/evidence-error.js";
export {
  DOC_IMPROVEMENT_RUN_KEYS,
  DOC_IMPROVEMENT_RUN_READER,
} from "./doc-improvement/run-record.js";
export type { RunEvidenceSummary } from "./doc-improvement/run-record-types.js";

const REVISION = /^[a-f0-9]{40,64}$/u;
const SAFE_REPOSITORY_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}\/[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const SAFE_PROVIDER = /^[a-z0-9][a-z0-9._-]{0,63}$/u;
const SAFE_MODEL = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/u;

const SECURITY_SCAN_POLICY: WorkflowOutcomeDecodeOptionsV1 = {
  authorizeSecurityScan,
  resolveSecurityScanEffectiveDisposition,
};

function securityDecodeOptions(
  options?: WorkflowOutcomeDecodeOptionsV1,
): WorkflowOutcomeDecodeOptionsV1 {
  return { ...SECURITY_SCAN_POLICY, ...(options ?? {}) };
}

export interface EvidenceLeafDeclaration {
  file: string;
  sha256: string;
}

export interface BoundedDocImprovementDeclarationV1 {
  schemaVersion: 1;
  kind: "bounded-doc-improvement-campaign";
  campaignId: string;
  repositoryId: string;
  testedCommit: string;
  repositoryIdentitySha256: string;
  gap: {
    id: string;
    evidence: Array<{ path: string; sha256: string }>;
    successCriterion: string;
  };
  inputs: {
    analysisRecord: EvidenceLeafDeclaration;
    authorization: EvidenceLeafDeclaration;
    applicationRecord: EvidenceLeafDeclaration;
    patch: EvidenceLeafDeclaration & { byteLength: number };
    independentReview: EvidenceLeafDeclaration;
  };
  validationProfile: "default" | "docsfab";
  generatedAt: string;
  digest: string;
}

export interface BoundedDocImprovementAuthorizationV1 {
  schemaVersion: 1;
  kind: "bounded-doc-improvement-authorization";
  campaignId: string;
  repository: { id: string; identitySha256: string; revision: string };
  analysis: { runId: string; recordSha256: string };
  gap: {
    id: string;
    evidenceSha256: string;
    successCriterionSha256: string;
  };
  intendedPaths: string[];
  approvedOutcomeSha256: string;
  decision: "approved";
  reviewer: { id: string; role: "maintainer" };
  policy: { id: string; version: string; digest: string };
  decidedAt: string;
  expiresAt: string;
  signature: string;
  digest: string;
}

export interface BoundedDocImprovementReviewV1 {
  schemaVersion: 1;
  kind: "bounded-doc-improvement-independent-review";
  campaignId: string;
  testedCommit: string;
  gap: {
    id: string;
    evidenceSha256: string;
    successCriterionSha256: string;
  };
  patchSha256: string;
  disposition: "addresses-gap-without-unsupported-additions";
  reviewer: { id: string; role: "maintainer" };
  policy: { id: string; version: string; digest: string };
  reviewedAt: string;
  signature: string;
  digest: string;
}

export interface CommandEvidence {
  id: "git-apply-check" | "git-apply" | "npm-ci" | "npm-check" | "npm-build";
  command: string[];
  exitCode: number;
  outputSha256: string;
}

export interface DocImprovementVerificationEvidence {
  npmCache: { contentSha256: string };
  source: {
    revisionBefore: string;
    revisionAfter: string;
    statusBefore: string;
    statusAfter: string;
  };
  patchApplyCheck: CommandEvidence;
  patchApply: CommandEvidence;
  appliedPatch: {
    sha256: string;
    byteLength: number;
    lineCount: number;
    changedPaths: string[];
  };
  dependencyInstall: CommandEvidence;
  validation: [CommandEvidence, CommandEvidence];
}

export interface BoundedDocImprovementEvidenceV1 {
  schemaVersion: 1;
  kind: "bounded-doc-improvement-evidence";
  campaign: {
    id: string;
    repositoryId: string;
    testedCommit: string;
    declarationSha256: string;
  };
  gap: {
    id: string;
    evidence: Array<{ path: string; sha256: string }>;
    successCriterionSha256: string;
  };
  analysis: RunEvidenceSummary;
  authorization: {
    sha256: string;
    digest: string;
    reviewer: { id: string; role: "maintainer" };
    policy: { id: string; version: string; digest: string };
    signatureSha256: string;
    decidedAt: string;
    expiresAt: string;
    intendedPaths: string[];
    approvedOutcomeSha256: string;
  };
  application: RunEvidenceSummary & {
    patch: {
      artifactId: string;
      sha256: string;
      byteLength: number;
      lineCount: number;
      changedPaths: string[];
    };
  };
  verification: {
    sourceCheckoutUnchanged: true;
    cleanCheckoutRevision: string;
    npmCacheContentSha256: string;
    commands: CommandEvidence[];
  };
  independentReview: {
    sha256: string;
    digest: string;
    disposition: "addresses-gap-without-unsupported-additions";
    reviewer: { id: string; role: "maintainer" };
    policy: { id: string; version: string; digest: string };
    signatureSha256: string;
    reviewedAt: string;
  };
  decision: "passed";
}

export interface BuildDocImprovementEvidenceInput {
  declaration: unknown;
  declarationBytes: Uint8Array;
  analysisRecord: unknown;
  analysisRecordBytes: Uint8Array;
  authorization: unknown;
  authorizationBytes: Uint8Array;
  applicationRecord: unknown;
  applicationRecordBytes: Uint8Array;
  patchBytes: Uint8Array;
  independentReview: unknown;
  independentReviewBytes: Uint8Array;
  verification: DocImprovementVerificationEvidence;
  reviewerPolicy: IaPlanReviewerPolicy;
}

export type DocImprovementCampaignInput = Omit<BuildDocImprovementEvidenceInput, "verification">;

export interface AuthorizedDocImprovementCampaign {
  declaration: BoundedDocImprovementDeclarationV1;
  authorization: BoundedDocImprovementAuthorizationV1;
}

export interface AuthorizeBoundedDocImprovementWriteInput {
  declaration: unknown;
  declarationBytes: Uint8Array;
  analysisRecord: unknown;
  analysisRecordBytes: Uint8Array;
  authorization: unknown;
  authorizationBytes: Uint8Array;
  reviewerPolicy: IaPlanReviewerPolicy;
  evaluatedAt: string;
}

export interface VerifyBoundedDocImprovementWriteResultInput {
  declaration: unknown;
  declarationBytes: Uint8Array;
  analysisRecord: unknown;
  analysisRecordBytes: Uint8Array;
  authorization: unknown;
  authorizationBytes: Uint8Array;
  applicationRecord: unknown;
  applicationRecordBytes: Uint8Array;
  patchBytes: Uint8Array;
  reviewerPolicy: IaPlanReviewerPolicy;
  editorialDecodeOptions?: WorkflowOutcomeDecodeOptionsV1;
}

export interface VerifiedBoundedDocImprovementWriteResult {
  declaration: BoundedDocImprovementDeclarationV1;
  authorization: BoundedDocImprovementAuthorizationV1;
  analysis: RunEvidenceSummary;
  application: RunEvidenceSummary;
  applicationRecord: RunRecord;
  patch: {
    sha256: string;
    byteLength: number;
    lineCount: number;
    changedPaths: string[];
  };
}

/** Strict public parser used before the campaign loader trusts declared leaf names. */
export function parseBoundedDocImprovementDeclaration(
  value: unknown,
): BoundedDocImprovementDeclarationV1 {
  return parseDeclaration(value);
}

/**
 * Verify the post-analysis human grant before a polish workflow can mutate its
 * disposable export, and return the exact content-free task recorded by the
 * workflow runner.
 */
export function authorizeBoundedDocImprovementWrite(
  input: AuthorizeBoundedDocImprovementWriteInput,
): BoundedDocImprovementTaskInput {
  assertJsonValueBinding(input.declarationBytes, input.declaration, "declaration-value");
  assertJsonValueBinding(input.analysisRecordBytes, input.analysisRecord, "analysis-value");
  assertJsonValueBinding(input.authorizationBytes, input.authorization, "authorization-value");
  const declaration = parseDeclaration(input.declaration);
  const analysisSha256 = bindLeaf(
    declaration.inputs.analysisRecord,
    input.analysisRecordBytes,
    "analysis-record",
  );
  const authorizationSha256 = bindLeaf(
    declaration.inputs.authorization,
    input.authorizationBytes,
    "authorization",
  );
  const analysis = runSummary(
    input.analysisRecord,
    analysisSha256,
    "review-documentation",
    declaration.testedCommit,
    SECURITY_SCAN_POLICY,
  );
  bindRunRepository(input.analysisRecord, declaration.repositoryIdentitySha256);
  const authorization = parseAuthorization(input.authorization);
  bindAuthorization(
    declaration,
    analysis,
    input.analysisRecord as RunRecord,
    authorization,
    authorizationSha256,
  );
  verifyReviewerDecision(authorization, input.reviewerPolicy, "authorization");
  const evaluatedAt = timestamp(input.evaluatedAt);
  if (
    evaluatedAt <= authorization.decidedAt ||
    evaluatedAt > authorization.expiresAt ||
    authorization.decidedAt <= analysis.completedAt
  ) {
    fail("write-authorization-time");
  }
  return expectedApplicationTask(
    declaration,
    analysis,
    input.analysisRecord as RunRecord,
    authorization,
    authorizationSha256,
  );
}

/**
 * Reconstruct and verify the complete post-write evidence chain without
 * requiring the later independent-review phase. This is the publication
 * boundary used by delivery acceptance: caller-authored summaries or hashes
 * cannot substitute for the signed authorization and authentic run records.
 */
export function verifyBoundedDocImprovementWriteResult(
  input: VerifyBoundedDocImprovementWriteResultInput,
): VerifiedBoundedDocImprovementWriteResult {
  assertJsonValueBinding(input.declarationBytes, input.declaration, "declaration-value");
  assertJsonValueBinding(input.analysisRecordBytes, input.analysisRecord, "analysis-value");
  assertJsonValueBinding(input.authorizationBytes, input.authorization, "authorization-value");
  assertJsonValueBinding(
    input.applicationRecordBytes,
    input.applicationRecord,
    "application-value",
  );
  const declaration = parseDeclaration(input.declaration);
  const analysisSha256 = bindLeaf(
    declaration.inputs.analysisRecord,
    input.analysisRecordBytes,
    "analysis-record",
  );
  const authorizationSha256 = bindLeaf(
    declaration.inputs.authorization,
    input.authorizationBytes,
    "authorization",
  );
  const applicationSha256 = bindLeaf(
    declaration.inputs.applicationRecord,
    input.applicationRecordBytes,
    "application-record",
  );
  const patchSha256 = bindLeaf(declaration.inputs.patch, input.patchBytes, "patch");
  if (input.patchBytes.byteLength !== declaration.inputs.patch.byteLength) {
    fail("patch-size-mismatch");
  }
  const analysis = runSummary(
    input.analysisRecord,
    analysisSha256,
    "review-documentation",
    declaration.testedCommit,
    SECURITY_SCAN_POLICY,
  );
  bindRunRepository(input.analysisRecord, declaration.repositoryIdentitySha256);
  const authorization = parseAuthorization(input.authorization);
  bindAuthorization(
    declaration,
    analysis,
    input.analysisRecord as RunRecord,
    authorization,
    authorizationSha256,
  );
  verifyReviewerDecision(authorization, input.reviewerPolicy, "authorization");
  const application = runSummary(
    input.applicationRecord,
    applicationSha256,
    "update-documentation",
    declaration.testedCommit,
    securityDecodeOptions(input.editorialDecodeOptions),
  );
  bindRunRepository(input.applicationRecord, declaration.repositoryIdentitySha256);
  if (
    authorization.decidedAt <= analysis.completedAt ||
    authorization.decidedAt >= application.createdAt ||
    application.completedAt > authorization.expiresAt
  ) {
    fail("phase-order");
  }
  const applicationRecord = input.applicationRecord as RunRecord;
  bindApplicationAuthorization(
    applicationRecord,
    declaration,
    analysis,
    input.analysisRecord as RunRecord,
    authorization,
    authorizationSha256,
  );
  const patch = applicationRecord.changes?.patch;
  if (
    !patch ||
    patch.format !== "git-diff" ||
    patch.sha256 !== patchSha256 ||
    patch.byteLength !== input.patchBytes.byteLength ||
    !Number.isSafeInteger(patch.lineCount) ||
    patch.lineCount < 0
  ) {
    fail("patch-record-mismatch");
  }
  const changedPaths = changedPathsFromRecord(applicationRecord);
  if (!sameStrings(changedPaths, authorization.intendedPaths)) fail("path-scope-exceeded");
  if (
    applicationRecord.impactPostflight?.status !== "completed" ||
    !sameStrings(changedPaths, applicationRecord.impactPostflight.changedPaths)
  ) {
    fail("impact-path-mismatch");
  }
  return {
    declaration,
    authorization,
    analysis,
    application,
    applicationRecord,
    patch: {
      sha256: patchSha256,
      byteLength: input.patchBytes.byteLength,
      lineCount: patch.lineCount,
      changedPaths,
    },
  };
}

/**
 * Validate every private campaign leaf, signed human decision, run record, and
 * patch binding before the verifier is allowed to apply bytes or execute a
 * repository-controlled validation command.
 */
export function authorizeBoundedDocImprovementCampaign(
  input: DocImprovementCampaignInput,
): AuthorizedDocImprovementCampaign {
  assertJsonValueBinding(input.declarationBytes, input.declaration, "declaration-value");
  assertJsonValueBinding(input.analysisRecordBytes, input.analysisRecord, "analysis-value");
  assertJsonValueBinding(input.authorizationBytes, input.authorization, "authorization-value");
  assertJsonValueBinding(
    input.applicationRecordBytes,
    input.applicationRecord,
    "application-value",
  );
  assertJsonValueBinding(
    input.independentReviewBytes,
    input.independentReview,
    "independent-review-value",
  );
  const declaration = parseDeclaration(input.declaration);
  const analysisSha256 = bindLeaf(
    declaration.inputs.analysisRecord,
    input.analysisRecordBytes,
    "analysis-record",
  );
  const authorizationSha256 = bindLeaf(
    declaration.inputs.authorization,
    input.authorizationBytes,
    "authorization",
  );
  const applicationSha256 = bindLeaf(
    declaration.inputs.applicationRecord,
    input.applicationRecordBytes,
    "application-record",
  );
  const patchSha256 = bindLeaf(declaration.inputs.patch, input.patchBytes, "patch");
  if (input.patchBytes.byteLength !== declaration.inputs.patch.byteLength) {
    fail("patch-size-mismatch");
  }
  bindLeaf(
    declaration.inputs.independentReview,
    input.independentReviewBytes,
    "independent-review",
  );

  const analysis = runSummary(
    input.analysisRecord,
    analysisSha256,
    "review-documentation",
    declaration.testedCommit,
    SECURITY_SCAN_POLICY,
  );
  bindRunRepository(input.analysisRecord, declaration.repositoryIdentitySha256);
  const authorization = parseAuthorization(input.authorization);
  bindAuthorization(
    declaration,
    analysis,
    input.analysisRecord as RunRecord,
    authorization,
    authorizationSha256,
  );
  const authorizationAuthority = verifyReviewerDecision(
    authorization,
    input.reviewerPolicy,
    "authorization",
  );

  const application = runSummary(
    input.applicationRecord,
    applicationSha256,
    "update-documentation",
    declaration.testedCommit,
    SECURITY_SCAN_POLICY,
  );
  bindRunRepository(input.applicationRecord, declaration.repositoryIdentitySha256);
  if (
    authorization.decidedAt <= analysis.completedAt ||
    authorization.decidedAt >= application.createdAt ||
    application.completedAt > authorization.expiresAt
  )
    fail("phase-order");
  const applicationRecord = input.applicationRecord as RunRecord;
  bindApplicationAuthorization(
    applicationRecord,
    declaration,
    analysis,
    input.analysisRecord as RunRecord,
    authorization,
    authorizationSha256,
  );
  const patch = applicationRecord.changes?.patch;
  if (
    !patch ||
    patch.format !== "git-diff" ||
    patch.sha256 !== patchSha256 ||
    patch.byteLength !== input.patchBytes.byteLength ||
    !Number.isSafeInteger(patch.lineCount) ||
    patch.lineCount < 0
  ) {
    fail("patch-record-mismatch");
  }
  const changedPaths = changedPathsFromRecord(applicationRecord);
  if (!sameStrings(changedPaths, authorization.intendedPaths)) {
    fail("path-scope-exceeded");
  }
  if (
    applicationRecord.impactPostflight?.status !== "completed" ||
    !sameStrings(changedPaths, applicationRecord.impactPostflight.changedPaths)
  ) {
    fail("impact-path-mismatch");
  }
  const review = parseReview(input.independentReview);
  if (
    review.campaignId !== declaration.campaignId ||
    review.testedCommit !== declaration.testedCommit ||
    !reviewGapMatchesDeclaration(review, declaration) ||
    review.patchSha256 !== patchSha256 ||
    review.reviewedAt <= application.completedAt ||
    declaration.generatedAt < review.reviewedAt ||
    review.reviewer.id === authorization.reviewer.id
  ) {
    fail("independent-review-mismatch");
  }
  const reviewAuthority = verifyReviewerDecision(
    review,
    input.reviewerPolicy,
    "independent-review",
  );
  if (reviewAuthority === authorizationAuthority) fail("independent-review-authority");
  return { declaration, authorization };
}

function assertJsonValueBinding(bytes: Uint8Array, value: unknown, code: string): void {
  try {
    const decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const parsed = JSON.parse(decoded) as unknown;
    if (canonicalDigest(parsed) !== canonicalDigest(value)) fail(code);
  } catch (error) {
    if (error instanceof DocImprovementEvidenceError) throw error;
    fail(code);
  }
}

export function buildBoundedDocImprovementEvidence(
  input: BuildDocImprovementEvidenceInput,
): BoundedDocImprovementEvidenceV1 {
  authorizeBoundedDocImprovementCampaign(input);
  const declaration = parseDeclaration(input.declaration);
  const declarationSha256 = sha256(input.declarationBytes);
  const analysisSha256 = bindLeaf(
    declaration.inputs.analysisRecord,
    input.analysisRecordBytes,
    "analysis-record",
  );
  const authorizationSha256 = bindLeaf(
    declaration.inputs.authorization,
    input.authorizationBytes,
    "authorization",
  );
  const applicationSha256 = bindLeaf(
    declaration.inputs.applicationRecord,
    input.applicationRecordBytes,
    "application-record",
  );
  const patchSha256 = bindLeaf(declaration.inputs.patch, input.patchBytes, "patch");
  if (input.patchBytes.byteLength !== declaration.inputs.patch.byteLength) {
    fail("patch-size-mismatch");
  }
  const reviewSha256 = bindLeaf(
    declaration.inputs.independentReview,
    input.independentReviewBytes,
    "independent-review",
  );

  const analysis = runSummary(
    input.analysisRecord,
    analysisSha256,
    "review-documentation",
    declaration.testedCommit,
    SECURITY_SCAN_POLICY,
  );
  bindRunRepository(input.analysisRecord, declaration.repositoryIdentitySha256);
  const authorization = parseAuthorization(input.authorization);
  bindAuthorization(
    declaration,
    analysis,
    input.analysisRecord as RunRecord,
    authorization,
    authorizationSha256,
  );
  const authorizationAuthority = verifyReviewerDecision(
    authorization,
    input.reviewerPolicy,
    "authorization",
  );
  const application = runSummary(
    input.applicationRecord,
    applicationSha256,
    "update-documentation",
    declaration.testedCommit,
    SECURITY_SCAN_POLICY,
  );
  bindRunRepository(input.applicationRecord, declaration.repositoryIdentitySha256);
  if (
    authorization.decidedAt <= analysis.completedAt ||
    authorization.decidedAt >= application.createdAt ||
    application.completedAt > authorization.expiresAt
  )
    fail("phase-order");

  const applicationRecord = input.applicationRecord as RunRecord;
  bindApplicationAuthorization(
    applicationRecord,
    declaration,
    analysis,
    input.analysisRecord as RunRecord,
    authorization,
    authorizationSha256,
  );
  const patch = applicationRecord.changes?.patch;
  if (
    !patch ||
    patch.format !== "git-diff" ||
    patch.sha256 !== patchSha256 ||
    patch.byteLength !== input.patchBytes.byteLength ||
    !Number.isSafeInteger(patch.lineCount) ||
    patch.lineCount < 0
  ) {
    fail("patch-record-mismatch");
  }
  const changedPaths = changedPathsFromRecord(applicationRecord);
  if (!sameStrings(changedPaths, authorization.intendedPaths)) {
    fail("path-scope-exceeded");
  }
  if (
    applicationRecord.impactPostflight?.status !== "completed" ||
    !sameStrings(changedPaths, applicationRecord.impactPostflight.changedPaths)
  ) {
    fail("impact-path-mismatch");
  }

  validateVerification(
    input.verification,
    declaration.testedCommit,
    patchSha256,
    input.patchBytes.byteLength,
    changedPaths,
    patch.lineCount,
  );
  const review = parseReview(input.independentReview);
  if (
    review.campaignId !== declaration.campaignId ||
    review.testedCommit !== declaration.testedCommit ||
    !reviewGapMatchesDeclaration(review, declaration) ||
    review.patchSha256 !== patchSha256 ||
    review.reviewedAt <= application.completedAt ||
    declaration.generatedAt < review.reviewedAt ||
    review.reviewer.id === authorization.reviewer.id
  ) {
    fail("independent-review-mismatch");
  }
  const reviewAuthority = verifyReviewerDecision(
    review,
    input.reviewerPolicy,
    "independent-review",
  );
  if (reviewAuthority === authorizationAuthority) fail("independent-review-authority");

  return {
    schemaVersion: 1,
    kind: "bounded-doc-improvement-evidence",
    campaign: {
      id: declaration.campaignId,
      repositoryId: declaration.repositoryId,
      testedCommit: declaration.testedCommit,
      declarationSha256,
    },
    gap: {
      id: declaration.gap.id,
      evidence: declaration.gap.evidence.map((entry) => ({ ...entry })),
      successCriterionSha256: canonicalDigest(declaration.gap.successCriterion),
    },
    analysis,
    authorization: {
      sha256: authorizationSha256,
      digest: authorization.digest,
      reviewer: { ...authorization.reviewer },
      policy: { ...authorization.policy },
      signatureSha256: sha256(Buffer.from(authorization.signature)),
      decidedAt: authorization.decidedAt,
      expiresAt: authorization.expiresAt,
      intendedPaths: [...authorization.intendedPaths],
      approvedOutcomeSha256: authorization.approvedOutcomeSha256,
    },
    application: {
      ...application,
      patch: {
        artifactId: `sha256:${patchSha256}`,
        sha256: patchSha256,
        byteLength: input.patchBytes.byteLength,
        lineCount: input.verification.appliedPatch.lineCount,
        changedPaths: [...input.verification.appliedPatch.changedPaths],
      },
    },
    verification: {
      sourceCheckoutUnchanged: true,
      cleanCheckoutRevision: declaration.testedCommit,
      npmCacheContentSha256: input.verification.npmCache.contentSha256,
      commands: [
        cloneCommand(input.verification.patchApplyCheck),
        cloneCommand(input.verification.patchApply),
        cloneCommand(input.verification.dependencyInstall),
        ...input.verification.validation.map(cloneCommand),
      ],
    },
    independentReview: {
      sha256: reviewSha256,
      digest: review.digest,
      disposition: review.disposition,
      reviewer: { ...review.reviewer },
      policy: { ...review.policy },
      signatureSha256: sha256(Buffer.from(review.signature)),
      reviewedAt: review.reviewedAt,
    },
    decision: "passed",
  };
}

export function serializeBoundedDocImprovementEvidence(
  value: BoundedDocImprovementEvidenceV1,
): string {
  assertSanitizedBoundedDocImprovementEvidence(value);
  return `${JSON.stringify(sortValue(value), null, 2)}\n`;
}

export function renderBoundedDocImprovementEvidenceMarkdown(
  value: BoundedDocImprovementEvidenceV1,
): string {
  assertSanitizedBoundedDocImprovementEvidence(value);
  const rows = value.verification.commands
    .map((command) => `| \`${command.id}\` | passed | \`${command.outputSha256}\` |`)
    .join("\n");
  return `# Bounded documentation improvement evidence

Decision: **passed**

- Campaign: \`${value.campaign.id}\`
- Repository: \`${value.campaign.repositoryId}\`
- Immutable revision: \`${value.campaign.testedCommit}\`
- Gap: \`${value.gap.id}\`
- Analysis: \`${value.analysis.workflow}\` / \`${value.analysis.id}\`
- Application: \`${value.application.workflow}\` / \`${value.application.id}\`
- Approved paths: ${value.authorization.intendedPaths.map((path) => `\`${path}\``).join(", ")}
- Patch: \`${value.application.patch.sha256}\` (${value.application.patch.byteLength} bytes)
- Npm cache: \`${value.verification.npmCacheContentSha256}\`
- Source checkout unchanged: **yes**
- Independent review: **${value.independentReview.disposition}**

| Verification | Result | Output digest |
| --- | --- | --- |
${rows}

Raw run records, authorization content, patch bytes, command output, model output, and host paths remain operator-private.
`;
}

export function assertSanitizedBoundedDocImprovementEvidence(
  value: BoundedDocImprovementEvidenceV1,
): void {
  assertSummaryShape(value);
  const serialized = JSON.stringify(value);
  if (
    /\/(?:Users|home|private|tmp)\//u.test(serialized) ||
    /(?:prompt|instruction|summary|artifactPath|sourcePath|api[_-]?key)/iu.test(serialized) ||
    detectCredentialRuleIds(serialized).length > 0 ||
    PUBLIC_CREDENTIAL_PATTERNS.some((pattern) => pattern.test(serialized))
  ) {
    fail("unsafe-summary");
  }
  for (const path of [
    ...value.gap.evidence.map((entry) => entry.path),
    ...value.authorization.intendedPaths,
    ...value.application.patch.changedPaths,
  ])
    safePath(path);
}

const PUBLIC_CREDENTIAL_PATTERNS: readonly RegExp[] = [
  /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/u,
  /\bxox(?:a|b|p|r|s)-[A-Za-z0-9-]{20,}\b/u,
  /\bAIza[0-9A-Za-z_-]{35}\b/u,
  /\bya29\.[0-9A-Za-z_-]{20,}\b/u,
];

function assertSummaryShape(value: BoundedDocImprovementEvidenceV1): void {
  const root = closed(value, [
    "schemaVersion",
    "kind",
    "campaign",
    "gap",
    "analysis",
    "authorization",
    "application",
    "verification",
    "independentReview",
    "decision",
  ]);
  if (
    root.schemaVersion !== 1 ||
    root.kind !== "bounded-doc-improvement-evidence" ||
    root.decision !== "passed"
  )
    fail("invalid-summary");
  const campaign = closed(root.campaign, [
    "id",
    "repositoryId",
    "testedCommit",
    "declarationSha256",
  ]);
  identifier(campaign.id);
  repositoryId(campaign.repositoryId);
  revision(campaign.testedCommit);
  digest(campaign.declarationSha256);
  const gap = closed(root.gap, ["id", "evidence", "successCriterionSha256"]);
  identifier(gap.id);
  pathEvidence(gap.evidence);
  digest(gap.successCriterionSha256);
  assertRunSummary(root.analysis, "review-documentation");
  const authorization = closed(root.authorization, [
    "sha256",
    "digest",
    "reviewer",
    "decidedAt",
    "expiresAt",
    "intendedPaths",
    "approvedOutcomeSha256",
    "policy",
    "signatureSha256",
  ]);
  digest(authorization.sha256);
  digest(authorization.digest);
  assertReviewer(authorization.reviewer);
  assertPolicyBinding(authorization.policy);
  digest(authorization.signatureSha256);
  const decidedAt = timestamp(authorization.decidedAt);
  const expiresAt = timestamp(authorization.expiresAt);
  if (decidedAt >= expiresAt) fail("invalid-summary");
  pathList(authorization.intendedPaths);
  digest(authorization.approvedOutcomeSha256);
  const application = closed(root.application, [
    "id",
    "recordSha256",
    "workflow",
    "status",
    "createdAt",
    "startedAt",
    "completedAt",
    "skills",
    "models",
    "patch",
  ]);
  assertRunSummary(application, "update-documentation", true);
  const patch = closed(application.patch, [
    "artifactId",
    "sha256",
    "byteLength",
    "lineCount",
    "changedPaths",
  ]);
  const patchSha256 = digest(patch.sha256);
  if (patch.artifactId !== `sha256:${patchSha256}`) fail("invalid-summary");
  integer(patch.byteLength, 1, 10 * 1024 * 1024);
  integer(patch.lineCount, 0, Number.MAX_SAFE_INTEGER);
  const changedPaths = pathList(patch.changedPaths);
  const authorizedPaths = pathList(authorization.intendedPaths);
  if (changedPaths.some((path) => !authorizedPaths.includes(path))) fail("invalid-summary");
  const verification = closed(root.verification, [
    "sourceCheckoutUnchanged",
    "cleanCheckoutRevision",
    "npmCacheContentSha256",
    "commands",
  ]);
  if (
    verification.sourceCheckoutUnchanged !== true ||
    verification.cleanCheckoutRevision !== campaign.testedCommit ||
    !Array.isArray(verification.commands) ||
    verification.commands.length !== 5
  ) {
    fail("invalid-summary");
  }
  digest(verification.npmCacheContentSha256);
  const commandSpecs: Array<[CommandEvidence["id"], string[]]> = [
    ["git-apply-check", ["git", "apply", "--check"]],
    ["git-apply", ["git", "apply"]],
    ["npm-ci", ["npm", "ci", "--offline", "--ignore-scripts"]],
    ["npm-check", ["npm", "run", "check"]],
    ["npm-build", ["npm", "run", "build"]],
  ];
  verification.commands.forEach((candidate, index) => {
    const command = closed(candidate, ["id", "command", "exitCode", "outputSha256"]);
    const spec = commandSpecs[index]!;
    if (
      command.id !== spec[0] ||
      command.exitCode !== 0 ||
      !Array.isArray(command.command) ||
      command.command.length !== spec[1].length ||
      command.command.some((part, partIndex) => part !== spec[1][partIndex])
    ) {
      fail("invalid-summary");
    }
    digest(command.outputSha256);
  });
  const review = closed(root.independentReview, [
    "sha256",
    "digest",
    "disposition",
    "reviewer",
    "policy",
    "signatureSha256",
    "reviewedAt",
  ]);
  digest(review.sha256);
  digest(review.digest);
  if (review.disposition !== "addresses-gap-without-unsupported-additions") {
    fail("invalid-summary");
  }
  assertReviewer(review.reviewer);
  assertPolicyBinding(review.policy);
  digest(review.signatureSha256);
  timestamp(review.reviewedAt);
}

function assertRunSummary(
  value: unknown,
  expectedWorkflow: "review-documentation" | "update-documentation",
  withPatch = false,
): void {
  const root = closed(value, [
    "id",
    "recordSha256",
    "workflow",
    "status",
    "createdAt",
    "startedAt",
    "completedAt",
    "skills",
    "models",
    ...(withPatch ? ["patch"] : []),
  ]);
  identifier(root.id);
  digest(root.recordSha256);
  if (root.workflow !== expectedWorkflow || root.status !== "succeeded") fail("invalid-summary");
  const createdAt = timestamp(root.createdAt);
  const startedAt = timestamp(root.startedAt);
  const completedAt = timestamp(root.completedAt);
  if (createdAt > startedAt || startedAt > completedAt) fail("invalid-summary");
  if (
    !Array.isArray(root.skills) ||
    root.skills.length === 0 ||
    !Array.isArray(root.models) ||
    root.models.length === 0
  )
    fail("invalid-summary");
  for (const candidate of root.skills) {
    const skill = candidate as Record<string, unknown>;
    const keys = Object.keys(skill).sort(compareText).join(",");
    if (keys !== "contentSha256,id" && keys !== "bundleSha256,contentSha256,id") {
      fail("invalid-summary");
    }
    identifier(skill.id);
    digest(skill.contentSha256);
    if (skill.bundleSha256 !== undefined) digest(skill.bundleSha256);
  }
  for (const candidate of root.models) {
    const model = closed(candidate, ["provider", "model", "profileStatus", "profileSha256"]);
    if (
      typeof model.provider !== "string" ||
      !SAFE_PROVIDER.test(model.provider) ||
      typeof model.model !== "string" ||
      !SAFE_MODEL.test(model.model) ||
      model.model.split("/").some((part) => !part || part === "." || part === "..") ||
      !["current", "stale", "unknown"].includes(model.profileStatus as string)
    ) {
      fail("invalid-summary");
    }
    digest(model.profileSha256);
  }
}

function assertReviewer(value: unknown): void {
  const reviewer = closed(value, ["id", "role"]);
  if (reviewer.role !== "maintainer") fail("invalid-summary");
  identifier(reviewer.id);
}

function assertPolicyBinding(value: unknown): void {
  const policy = closed(value, ["id", "version", "digest"]);
  identifier(policy.id);
  identifier(policy.version);
  digest(policy.digest);
}

function parsePolicyBinding(value: unknown): {
  id: string;
  version: string;
  digest: string;
} {
  const policy = closed(value, ["id", "version", "digest"]);
  return {
    id: identifier(policy.id),
    version: identifier(policy.version),
    digest: digest(policy.digest),
  };
}

function signature(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{80,128}$/u.test(value)) {
    fail("invalid-signature");
  }
  return value;
}

function verifyReviewerDecision(
  value: BoundedDocImprovementAuthorizationV1 | BoundedDocImprovementReviewV1,
  policyValue: IaPlanReviewerPolicy,
  label: "authorization" | "independent-review",
): string {
  let policy: IaPlanReviewerPolicy;
  try {
    policy = validateIaPlanReviewerPolicy(policyValue);
  } catch {
    fail("reviewer-policy");
  }
  if (
    value.policy.id !== policy.id ||
    value.policy.version !== policy.version ||
    value.policy.digest !== policy.digest
  )
    fail("reviewer-policy");
  const reviewer = policy.reviewers.find(
    (entry) => entry.id === value.reviewer.id && entry.role === value.reviewer.role,
  );
  if (!reviewer) fail("reviewer-policy");
  let authoritySha256: string;
  try {
    authoritySha256 = sha256(
      createPublicKey(reviewer.publicKey).export({
        type: "spki",
        format: "der",
      }),
    );
  } catch {
    fail("reviewer-policy");
  }
  const { digest: _digest, signature: signatureValue, ...statement } = value;
  let valid = false;
  try {
    valid = verifyBytes(
      null,
      Buffer.from(canonicalDigest(statement), "hex"),
      reviewer.publicKey,
      Buffer.from(signatureValue, "base64url"),
    );
  } catch {
    fail(`${label}-signature`);
  }
  if (!valid) fail(`${label}-signature`);
  return authoritySha256;
}

function analyzedOutcomeSha256(record: RunRecord): string {
  return canonicalDigest(analyzedOutcome(record));
}

function analyzedOutcome(record: RunRecord): string {
  const summary = record.steps.at(-1)?.summary;
  if (typeof summary !== "string" || !summary.trim()) fail("analysis-proposal-missing");
  return summary;
}

function parseDeclaration(value: unknown): BoundedDocImprovementDeclarationV1 {
  const root = closed(value, [
    "schemaVersion",
    "kind",
    "campaignId",
    "repositoryId",
    "testedCommit",
    "repositoryIdentitySha256",
    "gap",
    "inputs",
    "validationProfile",
    "generatedAt",
    "digest",
  ]);
  if (
    root.schemaVersion !== 1 ||
    root.kind !== "bounded-doc-improvement-campaign" ||
    (root.validationProfile !== "default" && root.validationProfile !== "docsfab")
  )
    fail("invalid-declaration");
  const gapRoot = closed(root.gap, ["id", "evidence", "successCriterion"]);
  const inputsRoot = closed(root.inputs, [
    "analysisRecord",
    "authorization",
    "applicationRecord",
    "patch",
    "independentReview",
  ]);
  const patchRoot = closed(inputsRoot.patch, ["file", "sha256", "byteLength"]);
  const patchLeaf = leaf({ file: patchRoot.file, sha256: patchRoot.sha256 });
  const result: BoundedDocImprovementDeclarationV1 = {
    schemaVersion: 1,
    kind: "bounded-doc-improvement-campaign",
    campaignId: identifier(root.campaignId),
    repositoryId: repositoryId(root.repositoryId),
    testedCommit: revision(root.testedCommit),
    repositoryIdentitySha256: digest(root.repositoryIdentitySha256),
    gap: {
      id: identifier(gapRoot.id),
      evidence: pathEvidence(gapRoot.evidence),
      successCriterion: boundedText(gapRoot.successCriterion, 1_000),
    },
    inputs: {
      analysisRecord: leaf(inputsRoot.analysisRecord),
      authorization: leaf(inputsRoot.authorization),
      applicationRecord: leaf(inputsRoot.applicationRecord),
      patch: {
        ...patchLeaf,
        byteLength: integer(patchRoot.byteLength, 1, 10 * 1024 * 1024),
      },
      independentReview: leaf(inputsRoot.independentReview),
    },
    validationProfile: root.validationProfile === "docsfab" ? "docsfab" : "default",
    generatedAt: timestamp(root.generatedAt),
    digest: digest(root.digest),
  };
  const { digest: _digest, ...digestible } = result;
  if (canonicalDigest(digestible) !== result.digest) fail("declaration-digest");
  const names = Object.values(result.inputs).map((entry) => entry.file);
  if (new Set(names).size !== names.length) fail("duplicate-input-file");
  return result;
}

function parseAuthorization(value: unknown): BoundedDocImprovementAuthorizationV1 {
  const root = closed(value, [
    "schemaVersion",
    "kind",
    "campaignId",
    "repository",
    "analysis",
    "gap",
    "intendedPaths",
    "approvedOutcomeSha256",
    "decision",
    "reviewer",
    "decidedAt",
    "expiresAt",
    "policy",
    "signature",
    "digest",
  ]);
  if (
    root.schemaVersion !== 1 ||
    root.kind !== "bounded-doc-improvement-authorization" ||
    root.decision !== "approved"
  )
    fail("invalid-authorization");
  const repositoryRoot = closed(root.repository, ["id", "identitySha256", "revision"]);
  const analysisRoot = closed(root.analysis, ["runId", "recordSha256"]);
  const gapRoot = closed(root.gap, ["id", "evidenceSha256", "successCriterionSha256"]);
  const reviewerRoot = closed(root.reviewer, ["id", "role"]);
  const policy = parsePolicyBinding(root.policy);
  if (reviewerRoot.role !== "maintainer") fail("invalid-authorization");
  const result: BoundedDocImprovementAuthorizationV1 = {
    schemaVersion: 1,
    kind: "bounded-doc-improvement-authorization",
    campaignId: identifier(root.campaignId),
    repository: {
      id: repositoryId(repositoryRoot.id),
      identitySha256: digest(repositoryRoot.identitySha256),
      revision: revision(repositoryRoot.revision),
    },
    analysis: {
      runId: identifier(analysisRoot.runId),
      recordSha256: digest(analysisRoot.recordSha256),
    },
    gap: {
      id: identifier(gapRoot.id),
      evidenceSha256: digest(gapRoot.evidenceSha256),
      successCriterionSha256: digest(gapRoot.successCriterionSha256),
    },
    intendedPaths: pathList(root.intendedPaths),
    approvedOutcomeSha256: digest(root.approvedOutcomeSha256),
    decision: "approved",
    reviewer: { id: identifier(reviewerRoot.id), role: "maintainer" },
    policy,
    decidedAt: timestamp(root.decidedAt),
    expiresAt: timestamp(root.expiresAt),
    signature: signature(root.signature),
    digest: digest(root.digest),
  };
  if (result.decidedAt >= result.expiresAt) fail("invalid-authorization-time");
  const { digest: _digest, ...digestible } = result;
  if (canonicalDigest(digestible) !== result.digest) fail("authorization-digest");
  return result;
}

function parseReview(value: unknown): BoundedDocImprovementReviewV1 {
  const root = closed(value, [
    "schemaVersion",
    "kind",
    "campaignId",
    "testedCommit",
    "gap",
    "patchSha256",
    "disposition",
    "reviewer",
    "policy",
    "reviewedAt",
    "signature",
    "digest",
  ]);
  const reviewerRoot = closed(root.reviewer, ["id", "role"]);
  const gapRoot = closed(root.gap, ["id", "evidenceSha256", "successCriterionSha256"]);
  const policy = parsePolicyBinding(root.policy);
  if (
    root.schemaVersion !== 1 ||
    root.kind !== "bounded-doc-improvement-independent-review" ||
    root.disposition !== "addresses-gap-without-unsupported-additions" ||
    reviewerRoot.role !== "maintainer"
  )
    fail("invalid-independent-review");
  const result: BoundedDocImprovementReviewV1 = {
    schemaVersion: 1,
    kind: "bounded-doc-improvement-independent-review",
    campaignId: identifier(root.campaignId),
    testedCommit: revision(root.testedCommit),
    gap: {
      id: identifier(gapRoot.id),
      evidenceSha256: digest(gapRoot.evidenceSha256),
      successCriterionSha256: digest(gapRoot.successCriterionSha256),
    },
    patchSha256: digest(root.patchSha256),
    disposition: "addresses-gap-without-unsupported-additions",
    reviewer: { id: identifier(reviewerRoot.id), role: "maintainer" },
    policy,
    reviewedAt: timestamp(root.reviewedAt),
    signature: signature(root.signature),
    digest: digest(root.digest),
  };
  const { digest: _digest, ...digestible } = result;
  if (canonicalDigest(digestible) !== result.digest) fail("independent-review-digest");
  return result;
}

function bindAuthorization(
  declaration: BoundedDocImprovementDeclarationV1,
  analysis: RunEvidenceSummary,
  analysisRecord: RunRecord,
  authorization: BoundedDocImprovementAuthorizationV1,
  authorizationSha256: string,
): void {
  if (
    authorizationSha256 !== declaration.inputs.authorization.sha256 ||
    authorization.campaignId !== declaration.campaignId ||
    authorization.repository.id !== declaration.repositoryId ||
    authorization.repository.identitySha256 !== declaration.repositoryIdentitySha256 ||
    authorization.repository.revision !== declaration.testedCommit ||
    authorization.analysis.runId !== analysis.id ||
    authorization.analysis.recordSha256 !== analysis.recordSha256 ||
    !authorizationGapMatchesDeclaration(authorization, declaration) ||
    authorization.approvedOutcomeSha256 !== analyzedOutcomeSha256(analysisRecord)
  ) {
    fail("authorization-binding");
  }
}

function gapEvidenceSha256(declaration: BoundedDocImprovementDeclarationV1): string {
  return canonicalDigest(declaration.gap.evidence);
}

function successCriterionSha256(declaration: BoundedDocImprovementDeclarationV1): string {
  return canonicalDigest(declaration.gap.successCriterion);
}

function authorizationGapMatchesDeclaration(
  authorization: BoundedDocImprovementAuthorizationV1,
  declaration: BoundedDocImprovementDeclarationV1,
): boolean {
  return (
    authorization.gap.id === declaration.gap.id &&
    authorization.gap.evidenceSha256 === gapEvidenceSha256(declaration) &&
    authorization.gap.successCriterionSha256 === successCriterionSha256(declaration)
  );
}

function reviewGapMatchesDeclaration(
  review: BoundedDocImprovementReviewV1,
  declaration: BoundedDocImprovementDeclarationV1,
): boolean {
  return (
    review.gap.id === declaration.gap.id &&
    review.gap.evidenceSha256 === gapEvidenceSha256(declaration) &&
    review.gap.successCriterionSha256 === successCriterionSha256(declaration)
  );
}

function bindApplicationAuthorization(
  record: RunRecord,
  declaration: BoundedDocImprovementDeclarationV1,
  analysis: RunEvidenceSummary,
  analysisRecord: RunRecord,
  authorization: BoundedDocImprovementAuthorizationV1,
  authorizationSha256: string,
): void {
  const expected = expectedApplicationTask(
    declaration,
    analysis,
    analysisRecord,
    authorization,
    authorizationSha256,
  );
  if (
    record.task?.kind !== "bounded-doc-improvement" ||
    canonicalDigest(record.task) !== canonicalDigest(expected)
  ) {
    fail("application-authorization-binding");
  }
}

function expectedApplicationTask(
  declaration: BoundedDocImprovementDeclarationV1,
  analysis: RunEvidenceSummary,
  analysisRecord: RunRecord,
  authorization: BoundedDocImprovementAuthorizationV1,
  authorizationSha256: string,
): BoundedDocImprovementTaskInput {
  return {
    kind: "bounded-doc-improvement",
    campaignId: declaration.campaignId,
    repositoryId: declaration.repositoryId,
    testedCommit: declaration.testedCommit,
    repositoryIdentitySha256: declaration.repositoryIdentitySha256,
    contextSourcePath: contextSourcePath(declaration),
    gap: {
      id: declaration.gap.id,
      evidenceSha256: gapEvidenceSha256(declaration),
      successCriterionSha256: successCriterionSha256(declaration),
    },
    analysis: {
      runId: analysis.id,
      recordSha256: analysis.recordSha256,
      approvedOutcomeSha256: authorization.approvedOutcomeSha256,
      approvedProposal: analyzedOutcome(analysisRecord),
    },
    authorization: {
      sha256: authorizationSha256,
      digest: authorization.digest,
    },
    intendedPaths: [...authorization.intendedPaths],
  };
}

function changedPathsFromRecord(record: RunRecord): string[] {
  if ((record.changes?.files ?? []).some((entry) => entry.status === "unknown")) {
    fail("invalid-change-evidence");
  }
  const paths = (record.changes?.files ?? []).flatMap((entry) => [
    ...(entry.previousPath ? [safePath(entry.previousPath)] : []),
    safePath(entry.path),
  ]);
  return [...new Set(paths)].sort(compareText);
}

function validateVerification(
  value: DocImprovementVerificationEvidence,
  revisionValue: string,
  patchSha256: string,
  patchByteLength: number,
  changedPaths: string[],
  lineCount: number,
): void {
  if (
    !isPlainRecord(value) ||
    !isPlainRecord(value.source) ||
    !isPlainRecord(value.npmCache) ||
    !SHA256.test(value.npmCache.contentSha256) ||
    value.source.revisionBefore !== revisionValue ||
    value.source.revisionAfter !== revisionValue ||
    value.source.statusBefore !== "" ||
    value.source.statusAfter !== "" ||
    !Array.isArray(value.validation) ||
    value.validation.length !== 2
  ) {
    fail("source-checkout-changed");
  }
  if (
    !isPlainRecord(value.appliedPatch) ||
    value.appliedPatch.sha256 !== patchSha256 ||
    value.appliedPatch.byteLength !== patchByteLength ||
    value.appliedPatch.lineCount !== lineCount ||
    !sameStrings(pathList(value.appliedPatch.changedPaths), changedPaths)
  ) {
    fail("patch-verification-mismatch");
  }
  const expected: Array<[CommandEvidence, CommandEvidence["id"], string[]]> = [
    [value.patchApplyCheck, "git-apply-check", ["git", "apply", "--check"]],
    [value.patchApply, "git-apply", ["git", "apply"]],
    [value.dependencyInstall, "npm-ci", ["npm", "ci", "--offline", "--ignore-scripts"]],
    [value.validation[0], "npm-check", ["npm", "run", "check"]],
    [value.validation[1], "npm-build", ["npm", "run", "build"]],
  ];
  for (const [command, id, prefix] of expected) {
    if (
      !isPlainRecord(command) ||
      command.id !== id ||
      command.exitCode !== 0 ||
      !Array.isArray(command.command) ||
      command.command.length < prefix.length ||
      !prefix.every((entry, index) => command.command[index] === entry) ||
      !SHA256.test(command.outputSha256)
    )
      fail("validation-failed");
  }
}

function bindLeaf(declaration: EvidenceLeafDeclaration, bytes: Uint8Array, code: string): string {
  const actual = sha256(bytes);
  if (actual !== declaration.sha256) fail(`${code}-digest`);
  return actual;
}

function leaf(value: unknown): EvidenceLeafDeclaration {
  const root = closed(value, ["file", "sha256"]);
  if (typeof root.file !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(root.file)) {
    fail("invalid-leaf");
  }
  return { file: root.file, sha256: digest(root.sha256) };
}

function pathEvidence(value: unknown): Array<{ path: string; sha256: string }> {
  if (!Array.isArray(value) || value.length === 0) fail("invalid-gap-evidence");
  const result = value.map((entry) => {
    const root = closed(entry, ["path", "sha256"]);
    return { path: safePath(root.path), sha256: digest(root.sha256) };
  });
  if (new Set(result.map((entry) => entry.path)).size !== result.length) {
    fail("invalid-gap-evidence");
  }
  return result.sort((left, right) => compareText(left.path, right.path));
}

function pathList(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0) fail("invalid-path-scope");
  const result = value.map(safePath);
  if (new Set(result).size !== result.length || result.some((path) => !documentationPath(path))) {
    fail("invalid-path-scope");
  }
  return result.sort(compareText);
}

function documentationPath(path: string): boolean {
  return /^(?:(?:docs\/.*|README|SECURITY|CONTRIBUTING|CHANGELOG)\.(?:md|mdx|rst|adoc))$/iu.test(
    path,
  );
}

function contextSourcePath(declaration: BoundedDocImprovementDeclarationV1): string {
  const evidence = declaration.gap.evidence.find((entry) => documentationPath(entry.path));
  if (!evidence) fail("context-source-missing");
  return evidence.path;
}

function bindRunRepository(value: unknown, expectedIdentity: string): void {
  const record = value as RunRecord;
  if (
    typeof record.repository?.sourcePath !== "string" ||
    sha256(Buffer.from(record.repository.sourcePath)) !== expectedIdentity
  ) {
    fail("run-repository-mismatch");
  }
}

function safePath(value: unknown): string {
  if (
    typeof value !== "string" ||
    value !== value.normalize("NFC") ||
    value.length === 0 ||
    value.length > 512 ||
    value.includes("\\") ||
    value.startsWith("/") ||
    /^[A-Za-z]:/u.test(value) ||
    value
      .split("/")
      .some((part) => !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(part) || part === "." || part === "..")
  ) {
    fail("invalid-path");
  }
  return value;
}

function revision(value: unknown): string {
  if (typeof value !== "string" || !REVISION.test(value)) fail("invalid-revision");
  return value;
}

function repositoryId(value: unknown): string {
  if (typeof value !== "string" || !SAFE_REPOSITORY_ID.test(value)) {
    fail("invalid-repository-id");
  }
  return value;
}

function digest(value: unknown): string {
  if (typeof value !== "string" || !SHA256.test(value)) fail("invalid-digest");
  return value;
}

function boundedText(value: unknown, maximum: number): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximum ||
    value !== value.normalize("NFC") ||
    /[\0\r\n]/u.test(value)
  )
    fail("invalid-text");
  return value;
}

function integer(value: unknown, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    fail("invalid-number");
  }
  return value as number;
}

function closed(value: unknown, keys: string[]): Record<string, unknown> {
  if (
    !isPlainRecord(value) ||
    Object.keys(value).sort(compareText).join(",") !== [...keys].sort(compareText).join(",")
  ) {
    fail("invalid-shape");
  }
  return value;
}

function cloneCommand(value: CommandEvidence): CommandEvidence {
  return { ...value, command: [...value.command] };
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => compareText(left, right))
      .map(([key, child]) => [key, sortValue(child)]),
  );
}
