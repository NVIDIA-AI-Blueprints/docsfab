// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  createPublicKey,
  sign as signBytes,
  verify as verifyBytes,
  type KeyObject,
} from "node:crypto";
import { canonicalDigest } from "../../content-ir/canonical.js";
import {
  digestValue,
  exactObject,
  fail,
  revisionValue,
  stringArray,
  text,
  timestamp,
  unique,
} from "./primitives.js";
import type {
  CorpusLiveCampaignApproval,
  CorpusLiveCohortIdentity,
  CorpusLiveExecutionAuthorization,
  CorpusObservationSet,
  CorpusRunObservation,
  CorpusThresholdApproval,
  CorpusThresholdPolicy,
  CorpusThresholds,
  LivingDocumentationDataset,
} from "../corpus.js";
import type { IaPlanTaskInput } from "../../workflow-contracts/contracts.js";
import type { InferenceEvidenceIdentity } from "../../records/contracts.js";
import type { ContentIndexV1 } from "../../content-ir/contracts.js";
import { validateIaPlanReviewerPolicy, type IaPlanReviewerPolicy } from "../../ia/plan-review.js";

const datasetDigest = canonicalDigest;

export interface CorpusSignedApprovalCore {
  schemaVersion: 1;
  policy: { id: string; version: string; digest: string };
  reviewer: { id: string; role: "maintainer" | "product-owner" };
  approvedAt: string;
  expiresAt: string;
  signature: string;
  digest: string;
}

export function thresholdRegressed(
  previous: CorpusThresholds | undefined,
  next: CorpusThresholds,
): boolean {
  if (!previous) return false;
  const minimums: Array<keyof CorpusThresholds> = [
    "artifactValidityRate",
    "evidenceCoverage",
    "placementAgreement",
    "recallAt3",
    "meanReciprocalRank",
  ];
  const maximums: Array<keyof CorpusThresholds> = [
    "maximumNoResultRate",
    "maximumOrphans",
    "maximumDuplicateCanonicalHomes",
    "maximumProviderBlanks",
    "maximumUnclassifiedFailures",
  ];
  return (
    minimums.some((key) => next[key] < previous[key]) ||
    maximums.some((key) => next[key] > previous[key])
  );
}

export function validateCorpusLiveExecutionAuthorization(
  value: unknown,
  dataset: LivingDocumentationDataset,
  options: {
    reviewerPolicy?: IaPlanReviewerPolicy;
    now?: Date;
    expectedTestedRevision?: string;
    expectedModel?: { provider: string; model: string; profileSha256: string };
  },
): CorpusLiveExecutionAuthorization {
  const root = exactObject(
    value,
    [
      "schemaVersion",
      "kind",
      "policy",
      "reviewer",
      "dataset",
      "testedRevision",
      "scope",
      "model",
      "cohorts",
      "approvedAt",
      "expiresAt",
      "signature",
      "digest",
    ],
    "live-execution-authorization",
  );
  if (
    root.schemaVersion !== 1 ||
    root.kind !== "corpus-live-execution-authorization" ||
    root.scope !== "read-only-ia-planning"
  )
    fail("live-execution-authorization");
  const datasetRoot = exactObject(
    root.dataset,
    ["id", "revision", "digest"],
    "live-execution-dataset",
  );
  const testedRevision = revisionValue(root.testedRevision, "live-tested-revision");
  const modelRoot = exactObject(
    root.model,
    ["provider", "model", "profileSha256"],
    "live-execution-model",
  );
  const model = {
    provider: text(modelRoot.provider, "live-execution-provider"),
    model: text(modelRoot.model, "live-execution-model-id"),
    profileSha256: digestValue(modelRoot.profileSha256, "live-execution-profile"),
  };
  const cohorts = parseLiveCohorts(root.cohorts);
  const expectedCaseIds = dataset.cases
    .filter((item) => item.planning && item.expectedDisposition === "recommendation-ready")
    .map((item) => item.id)
    .sort();
  if (
    canonicalDigest(cohorts.map((item) => item.caseId).sort()) !==
      canonicalDigest(expectedCaseIds) ||
    cohorts.some((cohort) => cohort.providerRunIds.length !== 5)
  ) {
    fail("live-execution-cohorts");
  }
  if (
    options.expectedTestedRevision === undefined ||
    testedRevision !== options.expectedTestedRevision ||
    datasetRoot.id !== dataset.id ||
    datasetRoot.revision !== dataset.revision ||
    datasetRoot.digest !== datasetDigest(dataset) ||
    (options.expectedModel && canonicalDigest(model) !== canonicalDigest(options.expectedModel))
  ) {
    fail("live-execution-binding");
  }
  const statement = {
    schemaVersion: 1 as const,
    kind: "corpus-live-execution-authorization" as const,
    policy: parsePolicyReference(root.policy),
    reviewer: parseReviewer(root.reviewer),
    dataset: { id: dataset.id, revision: dataset.revision, digest: datasetDigest(dataset) },
    testedRevision,
    scope: "read-only-ia-planning" as const,
    model,
    cohorts,
    approvedAt: timestamp(root.approvedAt, "live-execution-approved-at"),
    expiresAt: timestamp(root.expiresAt, "live-execution-expires-at"),
  };
  return validateSignedApproval(
    statement,
    root.signature,
    root.digest,
    options,
  ) as CorpusLiveExecutionAuthorization;
}

export function createCorpusLiveExecutionAuthorizer(input: {
  authorization: unknown;
  dataset: LivingDocumentationDataset;
  reviewerPolicy: IaPlanReviewerPolicy;
  expectedTestedRevision: string;
  caseId: string;
  model: { provider: string; model: string; profileSha256: string };
  now?: () => Date;
}): {
  authorize(request: {
    runId: string;
    index: ContentIndexV1;
    task: Readonly<IaPlanTaskInput>;
    evidenceIdentity: InferenceEvidenceIdentity;
  }): void;
} {
  const consumed = new Set<string>();
  return {
    authorize(request): void {
      const authorization = validateCorpusLiveExecutionAuthorization(
        input.authorization,
        input.dataset,
        {
          reviewerPolicy: input.reviewerPolicy,
          now: input.now?.() ?? new Date(),
          expectedTestedRevision: input.expectedTestedRevision,
          expectedModel: input.model,
        },
      );
      const cohort = authorization.cohorts.find((item) => item.caseId === input.caseId);
      const consulted = request.evidenceIdentity.consultedNodeIds;
      if (
        !cohort ||
        consumed.has(request.runId) ||
        !cohort.providerRunIds.includes(request.runId) ||
        request.index.repository.revision !== cohort.actualRepositoryRevision ||
        request.index.repository.contentDigest !== cohort.actualRepositoryContentDigest ||
        canonicalDigest(request.task) !== cohort.planningTaskDigest ||
        request.evidenceIdentity.contextPacketDigest !== cohort.contextPacketDigest ||
        !consulted?.length ||
        canonicalDigest(consulted) !== cohort.consultedNodeIdsDigest
      ) {
        fail("live-provider-execution-authorization");
      }
      consumed.add(request.runId);
    },
  };
}

export function parseLiveCohorts(value: unknown): CorpusLiveCohortIdentity[] {
  if (!Array.isArray(value) || value.length === 0) fail("live-execution-cohorts");
  const cohorts = value.map((entry) => {
    const root = exactObject(
      entry,
      [
        "caseId",
        "actualRepositoryRevision",
        "actualRepositoryContentDigest",
        "planningTaskDigest",
        "contextPacketDigest",
        "consultedNodeIdsDigest",
        "providerRunIds",
      ],
      "live-execution-cohort",
    );
    return {
      caseId: text(root.caseId, "live-execution-case-id"),
      actualRepositoryRevision: revisionValue(
        root.actualRepositoryRevision,
        "live-execution-repository-revision",
      ),
      actualRepositoryContentDigest: digestValue(
        root.actualRepositoryContentDigest,
        "live-execution-repository-content-digest",
      ),
      planningTaskDigest: digestValue(root.planningTaskDigest, "live-execution-task-digest"),
      contextPacketDigest: digestValue(root.contextPacketDigest, "live-execution-context-digest"),
      consultedNodeIdsDigest: digestValue(
        root.consultedNodeIdsDigest,
        "live-execution-consulted-digest",
      ),
      providerRunIds: stringArray(root.providerRunIds, "live-execution-provider-run-ids"),
    };
  });
  unique(
    cohorts.map((item) => item.caseId),
    "live-execution-case-id",
  );
  unique(
    cohorts.flatMap((item) => item.providerRunIds),
    "live-execution-provider-run-id",
  );
  return cohorts;
}

export function parseLiveCampaignApproval(
  value: unknown,
  dataset: LivingDocumentationDataset,
  runs: CorpusRunObservation[],
  options: {
    reviewerPolicy?: IaPlanReviewerPolicy;
    now?: Date;
    expectedTestedRevision?: string;
  },
): CorpusLiveCampaignApproval {
  const root = exactObject(
    value,
    [
      "schemaVersion",
      "kind",
      "policy",
      "reviewer",
      "dataset",
      "testedRevision",
      "scope",
      "runEvidenceDigests",
      "approvedAt",
      "expiresAt",
      "signature",
      "digest",
    ],
    "live-authorization",
  );
  if (
    root.schemaVersion !== 1 ||
    root.kind !== "corpus-live-evidence-approval" ||
    root.scope !== "read-only-ia-planning"
  )
    fail("live-authorization");
  const datasetRoot = exactObject(
    root.dataset,
    ["id", "revision", "digest"],
    "live-authorization-dataset",
  );
  const testedRevision = revisionValue(root.testedRevision, "live-tested-revision");
  if (
    options.expectedTestedRevision === undefined ||
    testedRevision !== options.expectedTestedRevision ||
    datasetRoot.id !== dataset.id ||
    datasetRoot.revision !== dataset.revision ||
    datasetRoot.digest !== datasetDigest(dataset)
  )
    fail("live-authorization-binding");
  const runEvidenceDigests = stringArray(root.runEvidenceDigests, "live-run-evidence-digests").map(
    (item) => digestValue(item, "live-run-evidence-digest"),
  );
  const expectedRunDigests = runs.map((run) => canonicalDigest(run.evidence));
  if (
    new Set(runEvidenceDigests).size !== runEvidenceDigests.length ||
    canonicalDigest(runEvidenceDigests) !== canonicalDigest(expectedRunDigests)
  ) {
    fail("live-authorization-run-records");
  }
  const statement = {
    schemaVersion: 1 as const,
    kind: "corpus-live-evidence-approval" as const,
    policy: parsePolicyReference(root.policy),
    reviewer: parseReviewer(root.reviewer),
    dataset: { id: dataset.id, revision: dataset.revision, digest: datasetDigest(dataset) },
    testedRevision,
    scope: "read-only-ia-planning" as const,
    runEvidenceDigests,
    approvedAt: timestamp(root.approvedAt, "live-approved-at"),
    expiresAt: timestamp(root.expiresAt, "live-expires-at"),
  };
  if (runs.some((run) => Date.parse(statement.approvedAt) < Date.parse(run.completedAt!))) {
    fail("live-evidence-approval-timing");
  }
  return validateSignedApproval(
    statement,
    root.signature,
    root.digest,
    options,
  ) as CorpusLiveCampaignApproval;
}

export function parseThresholdApproval(
  value: unknown,
  thresholdPolicy: CorpusThresholdPolicy,
  options: { reviewerPolicy?: IaPlanReviewerPolicy; now?: Date },
): CorpusThresholdApproval {
  const root = exactObject(
    value,
    [
      "schemaVersion",
      "kind",
      "policy",
      "reviewer",
      "thresholdPolicy",
      "approvedAt",
      "expiresAt",
      "signature",
      "digest",
    ],
    "threshold-approval",
  );
  if (
    root.schemaVersion !== 1 ||
    root.kind !== "corpus-threshold-regression-approval" ||
    !thresholdPolicy.previous ||
    !thresholdPolicy.regressionReason
  )
    fail("threshold-approval");
  const binding = exactObject(
    root.thresholdPolicy,
    ["id", "revision", "predecessorDigest", "thresholdsDigest", "regressionReason"],
    "threshold-approval-binding",
  );
  const expectedBinding = {
    id: thresholdPolicy.id,
    revision: thresholdPolicy.revision,
    predecessorDigest: thresholdPolicy.previous.digest,
    thresholdsDigest: thresholdRevisionDigest(
      thresholdPolicy.id,
      thresholdPolicy.revision,
      thresholdPolicy.thresholds,
    ),
    regressionReason: thresholdPolicy.regressionReason,
  };
  if (canonicalDigest(binding) !== canonicalDigest(expectedBinding))
    fail("threshold-approval-binding");
  const statement = {
    schemaVersion: 1 as const,
    kind: "corpus-threshold-regression-approval" as const,
    policy: parsePolicyReference(root.policy),
    reviewer: parseReviewer(root.reviewer),
    thresholdPolicy: expectedBinding,
    approvedAt: timestamp(root.approvedAt, "threshold-approved-at"),
    expiresAt: timestamp(root.expiresAt, "threshold-expires-at"),
  };
  return validateSignedApproval(
    statement,
    root.signature,
    root.digest,
    options,
  ) as CorpusThresholdApproval;
}

export function validateSignedApproval(
  statement: Omit<
    CorpusLiveCampaignApproval | CorpusLiveExecutionAuthorization | CorpusThresholdApproval,
    "signature" | "digest"
  >,
  signatureValue: unknown,
  digestValueInput: unknown,
  options: { reviewerPolicy?: IaPlanReviewerPolicy; now?: Date },
): CorpusLiveCampaignApproval | CorpusLiveExecutionAuthorization | CorpusThresholdApproval {
  if (!options.reviewerPolicy) fail("trusted-reviewer-policy-required");
  let policy: IaPlanReviewerPolicy;
  try {
    policy = validateIaPlanReviewerPolicy(options.reviewerPolicy);
  } catch {
    fail("invalid-reviewer-policy");
  }
  if (
    statement.policy.id !== policy.id ||
    statement.policy.version !== policy.version ||
    statement.policy.digest !== policy.digest
  )
    fail("approval-policy-binding");
  const reviewer = policy.reviewers.find(
    (item) => item.id === statement.reviewer.id && item.role === statement.reviewer.role,
  );
  if (!reviewer) fail("approval-reviewer");
  const approvedAt = Date.parse(statement.approvedAt);
  const expiresAt = Date.parse(statement.expiresAt);
  const now = (options.now ?? new Date()).getTime();
  if (!(approvedAt < expiresAt) || now < approvedAt || now >= expiresAt) fail("approval-expired");
  const signature = signatureText(signatureValue, "approval-signature");
  const digest = digestValue(digestValueInput, "approval-digest");
  if (canonicalDigest({ ...statement, signature }) !== digest) fail("approval-digest");
  let valid = false;
  try {
    valid = verifyBytes(
      null,
      Buffer.from(canonicalDigest(statement), "hex"),
      reviewer.publicKey,
      Buffer.from(signature, "base64url"),
    );
  } catch {
    fail("approval-signature");
  }
  if (!valid) fail("approval-signature");
  return { ...statement, signature, digest } as
    | CorpusLiveCampaignApproval
    | CorpusLiveExecutionAuthorization
    | CorpusThresholdApproval;
}

export function parsePolicyReference(value: unknown): CorpusSignedApprovalCore["policy"] {
  const root = exactObject(value, ["id", "version", "digest"], "approval-policy");
  return {
    id: text(root.id, "approval-policy-id"),
    version: text(root.version, "approval-policy-version"),
    digest: digestValue(root.digest, "approval-policy-digest"),
  };
}

export function parseReviewer(value: unknown): CorpusSignedApprovalCore["reviewer"] {
  const root = exactObject(value, ["id", "role"], "approval-reviewer");
  if (root.role !== "maintainer" && root.role !== "product-owner") fail("approval-reviewer-role");
  return { id: text(root.id, "approval-reviewer-id"), role: root.role };
}

export function signatureText(value: unknown, code: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{32,}$/u.test(value)) fail(code);
  return value;
}

export function thresholdRevisionDigest(
  id: string,
  revision: number,
  thresholds: CorpusThresholds,
): string {
  return canonicalDigest({ id, revision, thresholds });
}

export function thresholdPolicyStatement(policy: CorpusThresholdPolicy): object {
  return {
    schemaVersion: 1,
    id: policy.id,
    revision: policy.revision,
    thresholds: policy.thresholds,
    ...(policy.previous ? { previous: policy.previous } : {}),
    ...(policy.regressionReason ? { regressionReason: policy.regressionReason } : {}),
    ...(policy.approval ? { approvalDigest: policy.approval.digest } : {}),
  };
}

export function corpusThresholdPolicyDigest(policy: Omit<CorpusThresholdPolicy, "digest">): string {
  return canonicalDigest(thresholdPolicyStatement(policy as CorpusThresholdPolicy));
}

export function signingAuthority(
  policyValue: IaPlanReviewerPolicy,
  reviewerId: string,
  privateKey: KeyObject,
): { policy: IaPlanReviewerPolicy; reviewer: IaPlanReviewerPolicy["reviewers"][number] } {
  const policy = validateIaPlanReviewerPolicy(policyValue);
  const reviewer = policy.reviewers.find((item) => item.id === reviewerId);
  if (!reviewer || privateKey.type !== "private" || privateKey.asymmetricKeyType !== "ed25519") {
    fail("invalid-signing-authority");
  }
  const publicPem = createPublicKey(privateKey).export({ type: "spki", format: "pem" }).toString();
  if (publicPem !== reviewer.publicKey) fail("invalid-signing-authority");
  return { policy, reviewer };
}

export function signApproval<T extends object>(
  statement: T,
  privateKey: KeyObject,
): T & { signature: string; digest: string } {
  const signature = signBytes(
    null,
    Buffer.from(canonicalDigest(statement), "hex"),
    privateKey,
  ).toString("base64url");
  return { ...statement, signature, digest: canonicalDigest({ ...statement, signature }) };
}

export function createCorpusLiveExecutionAuthorization(input: {
  policy: IaPlanReviewerPolicy;
  reviewerId: string;
  privateKey: KeyObject;
  dataset: LivingDocumentationDataset;
  /** Preallocated cohort identities known before any provider call. */
  cohorts: CorpusLiveCohortIdentity[];
  testedRevision: string;
  model: { provider: string; model: string; profileSha256: string };
  approvedAt: string;
  expiresAt: string;
}): CorpusLiveExecutionAuthorization {
  const { policy, reviewer } = signingAuthority(input.policy, input.reviewerId, input.privateKey);
  const statement = {
    schemaVersion: 1 as const,
    kind: "corpus-live-execution-authorization" as const,
    policy: { id: policy.id, version: policy.version, digest: policy.digest },
    reviewer: { id: reviewer.id, role: reviewer.role },
    dataset: {
      id: input.dataset.id,
      revision: input.dataset.revision,
      digest: datasetDigest(input.dataset),
    },
    testedRevision: revisionValue(input.testedRevision, "live-tested-revision"),
    scope: "read-only-ia-planning" as const,
    model: {
      provider: text(input.model.provider, "live-execution-provider"),
      model: text(input.model.model, "live-execution-model-id"),
      profileSha256: digestValue(input.model.profileSha256, "live-execution-profile"),
    },
    cohorts: parseLiveCohorts(structuredClone(input.cohorts)),
    approvedAt: timestamp(input.approvedAt, "live-execution-approved-at"),
    expiresAt: timestamp(input.expiresAt, "live-execution-expires-at"),
  };
  return signApproval(statement, input.privateKey);
}

export function createCorpusThresholdApproval(input: {
  policy: IaPlanReviewerPolicy;
  reviewerId: string;
  privateKey: KeyObject;
  thresholdPolicy: Omit<CorpusThresholdPolicy, "approval" | "digest">;
  approvedAt: string;
  expiresAt: string;
}): CorpusThresholdApproval {
  const { policy, reviewer } = signingAuthority(input.policy, input.reviewerId, input.privateKey);
  const thresholdPolicy = input.thresholdPolicy;
  if (
    !thresholdPolicy.previous ||
    !thresholdPolicy.regressionReason ||
    !thresholdRegressed(thresholdPolicy.previous.thresholds, thresholdPolicy.thresholds)
  ) {
    fail("threshold-approval");
  }
  const statement = {
    schemaVersion: 1 as const,
    kind: "corpus-threshold-regression-approval" as const,
    policy: { id: policy.id, version: policy.version, digest: policy.digest },
    reviewer: { id: reviewer.id, role: reviewer.role },
    thresholdPolicy: {
      id: thresholdPolicy.id,
      revision: thresholdPolicy.revision,
      predecessorDigest: thresholdPolicy.previous.digest,
      thresholdsDigest: thresholdRevisionDigest(
        thresholdPolicy.id,
        thresholdPolicy.revision,
        thresholdPolicy.thresholds,
      ),
      regressionReason: thresholdPolicy.regressionReason,
    },
    approvedAt: timestamp(input.approvedAt, "threshold-approved-at"),
    expiresAt: timestamp(input.expiresAt, "threshold-expires-at"),
  };
  return signApproval(statement, input.privateKey);
}
