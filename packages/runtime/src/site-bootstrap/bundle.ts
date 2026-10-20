// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { constants as fsConstants } from "node:fs";
import { lstat, open, type FileHandle } from "node:fs/promises";

import { validateArtifact, type PolicyBinding } from "../artifacts/index.js";
import { catalogCapacity } from "../config/catalog-capacity.js";
import { deepFreeze } from "../contract-kit/freeze.js";
import { canonicalDigest } from "../content-ir/index.js";
import { assertIaEvaluationPassed } from "../ia/evaluator.js";
import { assertIaPlanReviewApproved, type IaPlanReviewerPolicy } from "../ia/plan-review.js";
import { templateSelectionDigest } from "../templates/selection.js";
import type { SiteBootstrapApplicationBundle } from "./contracts.js";

const SHA256 = /^[a-f0-9]{64}$/u;
const GIT_REVISION = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const CONTRACT_CODE = /^[a-z](?:[a-z0-9-]{0,62}[a-z0-9])?$/u;

export class SiteBootstrapBundleError extends Error {
  public constructor(
    public readonly code: "invalid-bundle" | "bundle-changed" | "bundle-too-large",
    options?: ErrorOptions,
  ) {
    super(`Site bootstrap application bundle rejected: ${code}.`, options);
    this.name = "SiteBootstrapBundleError";
  }
}

export function createSiteBootstrapApplicationBundle(
  input: Omit<SiteBootstrapApplicationBundle, "digest">,
  options: { now: Date; reviewerPolicy: IaPlanReviewerPolicy },
): SiteBootstrapApplicationBundle {
  const canonical = jsonClone(input);
  const value = { ...canonical, digest: canonicalDigest(canonical) };
  return validateSiteBootstrapApplicationBundle(value, options);
}

export function validateSiteBootstrapApplicationBundle(
  value: unknown,
  options: { now: Date; reviewerPolicy: IaPlanReviewerPolicy },
): SiteBootstrapApplicationBundle {
  try {
    const root = plain(value);
    exactKeys(root, [
      "schemaVersion",
      "kind",
      "repository",
      "plan",
      "evaluation",
      "evaluationInput",
      "topics",
      "templateCatalogPolicy",
      "repositoryCheckPolicy",
      "review",
      "reviewerPolicy",
      "digest",
    ]);
    if (
      root.schemaVersion !== 1 ||
      root.kind !== "site-bootstrap-application" ||
      !(options.now instanceof Date) ||
      Number.isNaN(options.now.valueOf())
    )
      invalid();
    const repository = plain(root.repository);
    exactKeys(repository, ["revision", "contentDigest", "indexDigest"]);
    if (
      !GIT_REVISION.test(text(repository.revision)) ||
      !SHA256.test(text(repository.contentDigest)) ||
      !SHA256.test(text(repository.indexDigest))
    )
      invalid();

    const evaluationInput =
      root.evaluationInput as SiteBootstrapApplicationBundle["evaluationInput"];
    const index = evaluationInput?.index;
    if (
      !index ||
      index.repository.revision !== repository.revision ||
      index.repository.contentDigest !== repository.contentDigest ||
      index.indexDigest !== repository.indexDigest
    )
      invalid();
    const plan = validateArtifact(root.plan, { index, now: options.now });
    const evaluation = validateArtifact(root.evaluation, { index });
    if (
      plan.kind !== "ia-plan" ||
      evaluation.kind !== "ia-evaluation" ||
      plan.payload.scope !== "site" ||
      plan.payload.outputScope.length === 0 ||
      plan.payload.outputScope.some((output) => output.operation !== "create")
    )
      invalid();
    assertIaEvaluationPassed(evaluation, evaluationInput);
    if (
      plan.repository.revision !== repository.revision ||
      plan.repository.contentDigest !== repository.contentDigest ||
      evaluation.repository.revision !== repository.revision ||
      evaluation.repository.contentDigest !== repository.contentDigest ||
      !sameReference(plan.payload.candidateArtifact, evaluation.payload.candidateArtifact) ||
      !sameReference(plan.payload.navigationEvaluation, evaluation.payload.navigationEvaluation) ||
      !plan.payload.iaEvaluation ||
      !sameReference(plan.payload.iaEvaluation, artifactReference(evaluation))
    )
      invalid();
    const reviewerPolicy = policy(root.reviewerPolicy);
    if (
      reviewerPolicy.id !== options.reviewerPolicy.id ||
      reviewerPolicy.version !== options.reviewerPolicy.version ||
      reviewerPolicy.digest !== options.reviewerPolicy.digest
    )
      invalid();
    const review = assertIaPlanReviewApproved({
      index,
      plan,
      review: root.review as SiteBootstrapApplicationBundle["review"],
      policy: options.reviewerPolicy,
      now: options.now,
    });

    if (!Array.isArray(root.topics) || root.topics.length === 0) invalid();
    const topics = jsonClone(root.topics) as SiteBootstrapApplicationBundle["topics"];
    const outputPaths = topics.map((topic) => topic?.outputPath).sort(compare);
    const approvedPaths = plan.payload.outputScope.map((output) => output.path).sort(compare);
    if (
      outputPaths.length !== approvedPaths.length ||
      outputPaths.some((path, indexValue) => path !== approvedPaths[indexValue])
    )
      invalid();
    const selection = plan.payload.policyBindings.find(
      (binding) => binding.id === "docsfab:template-selection" && binding.version === "1",
    );
    if (!selection || selection.digest !== templateSelectionDigest(topics)) invalid();

    const templateCatalogPolicy = policy(root.templateCatalogPolicy);
    const repositoryCheckPolicy = policy(root.repositoryCheckPolicy);
    if (
      !hasPolicy(plan.payload.policyBindings, templateCatalogPolicy) ||
      !hasPolicy(plan.payload.policyBindings, repositoryCheckPolicy)
    )
      invalid();
    const digest = text(root.digest);
    if (!SHA256.test(digest)) invalid();
    const { digest: _digest, ...digestible } = root;
    if (canonicalDigest(digestible) !== digest) invalid();

    return deepFreeze(
      jsonClone({
        schemaVersion: 1,
        kind: "site-bootstrap-application",
        repository,
        plan,
        review,
        reviewerPolicy,
        evaluation,
        evaluationInput,
        topics,
        templateCatalogPolicy,
        repositoryCheckPolicy,
        digest,
      }),
    ) as SiteBootstrapApplicationBundle;
  } catch (error) {
    rethrowPreservedOrWrap(error);
  }
}

export async function loadSiteBootstrapApplicationBundle(
  path: string,
  options: { now: Date; reviewerPolicy: IaPlanReviewerPolicy },
): Promise<SiteBootstrapApplicationBundle> {
  let handle: FileHandle | undefined;
  try {
    const noFollow = typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;
    handle = await open(path, fsConstants.O_RDONLY | noFollow);
    const before = await handle.stat();
    if (!before.isFile() || before.size <= 0) invalid();
    // Condition: the file is larger than `siteBootstrap.bundleMaxBytes`, the
    // one admitted size for this document, which the hosted arm and the
    // operator import apply too. It is refused by its own code before a byte
    // is read; a file at the bound is the adjacent condition and is read, and
    // a malformed one stays `invalid-bundle`.
    if (before.size > catalogCapacity("siteBootstrap.bundleMaxBytes"))
      throw new SiteBootstrapBundleError("bundle-too-large"); // hygiene: ok -- stable typed code; the constructor supplies the operator-safe message.
    const bytes = await handle.readFile();
    const after = await handle.stat();
    const pathAfter = await lstat(path);
    if (
      !after.isFile() ||
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      bytes.byteLength !== after.size ||
      !pathAfter.isFile() ||
      pathAfter.isSymbolicLink() ||
      pathAfter.dev !== after.dev ||
      pathAfter.ino !== after.ino
    ) {
      throw new SiteBootstrapBundleError("bundle-changed");
    }
    return validateSiteBootstrapApplicationBundle(JSON.parse(bytes.toString("utf8")), options);
  } catch (error) {
    rethrowPreservedOrWrap(error);
  } finally {
    await handle?.close();
  }
  return invalid();
}

function policy(value: unknown): PolicyBinding {
  const root = plain(value);
  exactKeys(root, ["id", "version", "digest"]);
  if (
    typeof root.id !== "string" ||
    !root.id ||
    typeof root.version !== "string" ||
    !root.version ||
    typeof root.digest !== "string" ||
    !SHA256.test(root.digest)
  )
    invalid();
  return { id: root.id, version: root.version, digest: root.digest };
}

function hasPolicy(values: readonly PolicyBinding[], expected: PolicyBinding): boolean {
  return values.some(
    (value) =>
      value.id === expected.id &&
      value.version === expected.version &&
      value.digest === expected.digest,
  );
}

function sameReference(
  left: {
    kind: string;
    schemaVersion: number;
    digest: string;
    repositoryRevision: string;
    repositoryContentDigest: string;
  },
  right: typeof left,
): boolean {
  return (
    left.kind === right.kind &&
    left.schemaVersion === right.schemaVersion &&
    left.digest === right.digest &&
    left.repositoryRevision === right.repositoryRevision &&
    left.repositoryContentDigest === right.repositoryContentDigest
  );
}

function artifactReference(artifact: {
  kind: string;
  schemaVersion: 1;
  digest: string;
  repository: { revision: string; contentDigest: string };
}) {
  return {
    kind: artifact.kind,
    schemaVersion: artifact.schemaVersion,
    digest: artifact.digest,
    repositoryRevision: artifact.repository.revision,
    repositoryContentDigest: artifact.repository.contentDigest,
  };
}

function plain(value: unknown): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    invalid();
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): void {
  if (Object.keys(value).sort(compare).join("\0") !== [...keys].sort(compare).join("\0")) invalid();
}

function text(value: unknown): string {
  if (typeof value !== "string") invalid();
  return value;
}

function jsonClone<T>(value: T): T {
  const encoded = JSON.stringify(value);
  if (encoded === undefined) invalid();
  return JSON.parse(encoded) as T;
}

function compare(left: unknown, right: unknown): number {
  return String(left) < String(right) ? -1 : String(left) > String(right) ? 1 : 0;
}

function isContractErrorLike(error: unknown): error is Error & { readonly code: string } {
  if (!(error instanceof Error) || !("code" in error)) return false;
  const code = error.code;
  return typeof code === "string" && CONTRACT_CODE.test(code);
}

function rethrowPreservedOrWrap(error: unknown): never {
  if (isContractErrorLike(error)) throw error;
  invalid(error);
}

function invalid(cause?: unknown): never {
  throw new SiteBootstrapBundleError("invalid-bundle", cause === undefined ? undefined : { cause });
}
