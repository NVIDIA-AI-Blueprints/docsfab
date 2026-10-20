// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  SOURCE_OBLIGATION_LEDGER_KIND,
  type SourceObligationV1,
  type SourceObligationDimensionV1,
  type SourceObligationLedgerIdentityV1,
  type SourceObligationLedgerIdentityV2,
  type SourceObligationSourceIdentityV1,
  type SourceObligationLedgerV1,
  type SourceObligationLedgerV2,
  type SourceObligationLedger,
  type SourceObligationLedgerProposalV1,
  type ObligationAccountingRowV1,
} from ".././source-obligation/types.js";
import {
  hasHostWrittenReason,
  hostDegradationLimitation,
  hostFilledDimensionReason,
  HOST_DEGRADATION_STEM,
  hostWrittenReasonsFor,
  isHostLocatorDegradationNote,
  markHostWrittenReason,
  rememberHostWrittenReasons,
  type RemovedLocator,
} from ".././source-obligation/locator-degradation.js";
import { canonicalDigest } from "../../content-ir/canonical.js";
import { limit } from "../../config/limits.js";
import { InferenceStepError, type HarnessStepInput } from "../../execution/contracts.js";
import { rejectCorrectable, type LocationOf } from "../../contracts/model-output.generated.js";
import { jsonEnvelopeBody } from "../../execution/json-envelope.js";
import {
  canonicalizeJsonEvidence,
  JsonEvidenceError,
  parseJsonEvidence,
  type JsonEvidenceValue,
} from "../../json-evidence.js";
import {
  rejectFactInventoryLimitationBound,
  rejectTechnicalCorrection,
  technicalCorrectionBoundary,
  normalizeRepositoryLocator,
  TECHNICAL_FACT_DIMENSIONS,
  type TechnicalFactDimension,
  type VerificationResult,
} from ".././review-response.js";
import { documentationPlanPagePaths } from ".././plan-binding.js";
import { sourcePathRejectionSubject } from "../../execution/rejection-subject.js";
import { admitPlanSourceLocator, isPlanSourceLocatorRefusal } from ".././repository-locator.js";
import {
  originalSourceAuthorityMemberMap,
  validateOriginalSourceAuthorityDescriptor,
  validateOriginalSourceAuthorityEvidence,
  type OriginalSourceAuthorityCheckV1,
  type OriginalSourceAuthorityEvidenceV1,
  type SourceAuthorityProposalV1,
} from ".././source-obligation-authority.js";
import {
  OBLIGATION_ACCOUNTING_KEYS,
  SOURCE_OBLIGATION_PROPOSAL_KEYS,
  SOURCE_OBLIGATION_DIMENSION_KEYS,
  SOURCE_OBLIGATION_KEYS,
} from "../../execution/response-contract-keys.js";
import {
  OBLIGATION_ID,
  MAX_OBLIGATIONS_LIMIT,
  MAX_PER_DIMENSION_LIMIT,
  MAX_LOCATORS_LIMIT,
  SourceObligationSourceReferenceError,
  failSourceReference,
  SOURCE_OBLIGATION_FAILURES,
  projectSourceObligationRejection,
  refusedReasonDimensions,
  reject,
  sourceObligationRejectionError,
  rejectRule,
  fail,
  jsonRejectionCode,
  at,
  exactKeys,
  kit,
  compareCodePoints,
} from "./validation-kernel.js";
import type { SourceObligationRejectionLocation } from "./validation-kernel.js";
import {
  boundedDigest,
  boundedText,
  boundedTextArray,
  validateFactIds,
  validateLocators,
} from "./ledger-value-codecs.js";
export {
  boundedDigest,
  boundedText,
  boundedTextArray,
  validateFactIds,
  validateLocators,
} from "./ledger-value-codecs.js";

export function expectedSourceObligationIdentity(
  input: Pick<
    HarnessStepInput,
    | "workflow"
    | "evidenceIdentity"
    | "searchEvidence"
    | "planBinding"
    | "reviewScope"
    | "contextTarget"
  >,
  sources: readonly SourceObligationSourceIdentityV1[],
): SourceObligationLedgerIdentityV1 {
  const repositoryRevision = input.evidenceIdentity?.repositoryRevision;
  const sourceEvidenceSha256 = input.searchEvidence?.evidenceSha256;
  const workspaceSnapshotSha256 = input.searchEvidence?.workspaceSnapshotSha256;
  if (!repositoryRevision || !sourceEvidenceSha256 || !workspaceSnapshotSha256) {
    return fail("Source-obligation derivation requires revision-bound search evidence.", false);
  }
  const scopeSha256 = sourceObligationScopeSha256(input);
  return {
    repositoryRevision,
    scopeSha256,
    sourceEvidenceSha256,
    workspaceSnapshotSha256,
    sources: validateSourceIdentities(sources),
  };
}

export function sourceObligationScopeSha256(
  input: Pick<HarnessStepInput, "workflow" | "planBinding" | "reviewScope" | "contextTarget">,
): string {
  return canonicalDigest({
    workflow: input.workflow.name,
    scope: input.planBinding
      ? { planDigest: input.planBinding.digest }
      : input.reviewScope
        ? { reviewScopeSha256: input.reviewScope.scopeSha256 }
        : { contextTarget: input.contextTarget ?? null },
  });
}

export function bindSourceObligationLedger(
  value: unknown,
  input: Pick<
    HarnessStepInput,
    | "workflow"
    | "evidenceIdentity"
    | "searchEvidence"
    | "planBinding"
    | "reviewScope"
    | "contextTarget"
  >,
  sources: readonly SourceObligationSourceIdentityV1[],
): SourceObligationLedgerV1 {
  const proposal = hostMintObligationIdentity(validateSourceObligationProposal(value, input));
  assertSourceIdentitiesCoverContent(proposal, sources);
  const identity = expectedSourceObligationIdentity(input, sources);
  const content = {
    kind: SOURCE_OBLIGATION_LEDGER_KIND,
    schemaVersion: 1 as const,
    identity,
    ...proposal,
  };
  return Object.freeze({ ...content, digest: canonicalDigest(content) });
}

export function bindSourceObligationLedgerV2(
  value: unknown,
  input: Pick<
    HarnessStepInput,
    | "workflow"
    | "evidenceIdentity"
    | "searchEvidence"
    | "planBinding"
    | "reviewScope"
    | "contextTarget"
  >,
  sources: readonly SourceObligationSourceIdentityV1[],
  authorityEvidence: OriginalSourceAuthorityEvidenceV1,
): SourceObligationLedgerV2 {
  const proposal = hostMintObligationIdentity(validateSourceObligationProposal(value, input));
  assertSourceIdentitiesCoverContent(proposal, sources);
  const baseIdentity = expectedSourceObligationIdentity(input, sources);
  const authority = validateOriginalSourceAuthorityEvidence(authorityEvidence, {
    scope:
      input.workflow.name === "create-documentation"
        ? "create-plan-sources"
        : "review-tracked-workspace",
    repositoryRevision: baseIdentity.repositoryRevision,
    scopeSha256: baseIdentity.scopeSha256,
    workspaceSnapshotSha256: baseIdentity.workspaceSnapshotSha256,
  });
  assertObservedSourcesAuthorized(baseIdentity.sources, authority);
  const identity: SourceObligationLedgerIdentityV2 = {
    ...baseIdentity,
    originalSourceAuthority: authority.descriptor,
  };
  const content = {
    kind: SOURCE_OBLIGATION_LEDGER_KIND,
    schemaVersion: 2 as const,
    identity,
    ...proposal,
  };
  return Object.freeze({ ...content, digest: canonicalDigest(content) });
}

/** The key an older host sealed into some V2 ledgers; see {@link SourceObligationLedgerV2}. */
export const LEDGER_PATH_TOKEN_KEY = "repositoryPathTokenSha256";

export const SHA256_HEX = /^[0-9a-f]{64}$/u;

/**
 * The retained token digest list, exactly as sealed: a non-empty, sorted,
 * distinct list of SHA-256 digests. The ledger digest covers it, so it is
 * copied unchanged.
 */
export function legacyPathTokenDigests(value: unknown): string[] {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    !value.every(
      (entry, index) =>
        typeof entry === "string" &&
        SHA256_HEX.test(entry) &&
        (index === 0 || (value[index - 1] as string) < entry),
    )
  ) {
    return fail(
      "Source-obligation V2 repository path tokens are not a sorted list of distinct digests.",
      false,
    );
  }
  return [...(value as string[])];
}

export function validateSourceObligationLedger(
  value: unknown,
  input?: Pick<
    HarnessStepInput,
    | "workflow"
    | "evidenceIdentity"
    | "searchEvidence"
    | "planBinding"
    | "reviewScope"
    | "contextTarget"
  >,
  authorityEvidence?: OriginalSourceAuthorityEvidenceV1,
): SourceObligationLedger {
  at("$", () => kit.assertInert(value));
  at("$", () => kit.rejectCredentials(value));
  const root = at("$", () => kit.object(value));
  const ledgerKeys = [
    "kind",
    "schemaVersion",
    "identity",
    "completeness",
    "dimensions",
    "limitations",
    "digest",
  ];
  // Only a V2 ledger may carry the older host-sealed token list.
  if (root.schemaVersion === 2) {
    exactKeys("$", root, [...ledgerKeys, LEDGER_PATH_TOKEN_KEY], [LEDGER_PATH_TOKEN_KEY]);
  } else {
    exactKeys("$", root, ledgerKeys);
  }
  if (
    root.kind !== SOURCE_OBLIGATION_LEDGER_KIND ||
    (root.schemaVersion !== 1 && root.schemaVersion !== 2)
  ) {
    return reject("unsupported-identity", "$");
  }
  const identity =
    root.schemaVersion === 1 ? validateIdentity(root.identity) : validateIdentityV2(root.identity);
  if (input) {
    const expected = expectedSourceObligationIdentity(input, identity.sources);
    if (
      identity.repositoryRevision !== expected.repositoryRevision ||
      identity.scopeSha256 !== expected.scopeSha256 ||
      identity.sourceEvidenceSha256 !== expected.sourceEvidenceSha256 ||
      identity.workspaceSnapshotSha256 !== expected.workspaceSnapshotSha256 ||
      canonicalDigest(identity.sources) !== canonicalDigest(expected.sources)
    ) {
      return reject("stale-evidence", "$.identity");
    }
  }
  const proposal = validateLedgerContent(root, sourceLocatorAuthority(input), true);
  assertSourceIdentitiesCoverContent(proposal, identity.sources);
  const sealedTokens = Object.hasOwn(root, LEDGER_PATH_TOKEN_KEY)
    ? legacyPathTokenDigests(root[LEDGER_PATH_TOKEN_KEY])
    : undefined;
  const content = {
    kind: SOURCE_OBLIGATION_LEDGER_KIND,
    schemaVersion: root.schemaVersion,
    identity,
    ...proposal,
    ...(sealedTokens !== undefined ? { [LEDGER_PATH_TOKEN_KEY]: sealedTokens } : {}),
  };
  if (typeof root.digest !== "string" || root.digest !== canonicalDigest(content)) {
    return reject("digest-mismatch", "$.digest");
  }
  if (root.schemaVersion === 2) {
    const identityV2 = identity as SourceObligationLedgerIdentityV2;
    if (!authorityEvidence) {
      return fail(
        "Source-obligation V2 evidence requires retained original source authority.",
        false,
      );
    }
    const authority = validateOriginalSourceAuthorityEvidence(authorityEvidence, {
      ...(input
        ? {
            scope:
              input.workflow.name === "create-documentation"
                ? ("create-plan-sources" as const)
                : ("review-tracked-workspace" as const),
          }
        : {}),
      repositoryRevision: identity.repositoryRevision,
      scopeSha256: identity.scopeSha256,
      workspaceSnapshotSha256: identity.workspaceSnapshotSha256,
    });
    if (
      canonicalDigest(identityV2.originalSourceAuthority) !== canonicalDigest(authority.descriptor)
    ) {
      return fail(
        "Source-obligation V2 authority descriptor is not bound to retained evidence.",
        false,
      );
    }
    assertObservedSourcesAuthorized(identity.sources, authority);
    return Object.freeze({ ...content, digest: root.digest }) as SourceObligationLedgerV2;
  }
  return Object.freeze({ ...content, digest: root.digest }) as SourceObligationLedgerV1;
}

/** How a decode treats model content it may degrade. */
export interface SourceObligationDecodeOptions {
  /**
   * No retry follows this attempt (`HarnessStepInput.finalInferenceAttempt`):
   * a locator with no line span is removed and labeled instead of refused.
   * Absent is not final.
   */
  readonly finalAttempt?: boolean;
  /**
   * The step's own input. A CREATE reply's citations are then checked against
   * the plan's bound sources here, inside the attempt.
   */
  readonly input?: SourceAuthorityInput;
}

export function validateSourceObligationProposal(
  value: unknown,
  input?: SourceAuthorityInput,
  runRevision?: string,
  options: SourceObligationDecodeOptions = {},
): SourceObligationLedgerProposalV1 {
  at("$", () => kit.assertInert(value));
  at("$", () => kit.rejectCredentials(value));
  const root = at("$", () => kit.object(value));
  const keys = Object.keys(root);
  const hasSourceProposals = Object.hasOwn(root, "sourceProposals");
  const expectedKeys = hasSourceProposals
    ? [...SOURCE_OBLIGATION_PROPOSAL_KEYS, "sourceProposals"]
    : SOURCE_OBLIGATION_PROPOSAL_KEYS;
  if (keys.length !== expectedKeys.length || keys.some((key) => !expectedKeys.includes(key))) {
    exactKeys("$", root, SOURCE_OBLIGATION_PROPOSAL_KEYS);
    return fail(SOURCE_OBLIGATION_FAILURES.contract, false);
  }
  const sourceProposals = hasSourceProposals
    ? validateSourceAuthorityProposals(root.sourceProposals)
    : [];
  const content = Object.fromEntries(
    Object.entries(root).filter(([key]) => key !== "sourceProposals"),
  );
  // Validation removes envelope-only fields into a fresh object. Carry any
  // host-origin annotations already attached to a normalized proposal so a
  // second validation does not reinterpret host text as model-authored prose.
  rememberHostWrittenReasons(content, hostWrittenReasonsFor(root));
  // The harness decodes without a step input and threads the revision
  // explicitly; the runner and the seal carry it on `evidenceIdentity`. Both
  // reach the same locator rule.
  const temporaryAuthority = sourceLocatorAuthority(
    input,
    sourceProposals.map(({ path }) => path),
  );
  const validated = validateLedgerContent(
    content,
    temporaryAuthority,
    false,
    runRevision ?? input?.evidenceIdentity?.repositoryRevision,
    options.finalAttempt === true,
  );
  if (sourceProposals.length === 0) return validated;
  const withSourceProposals = { ...validated, sourceProposals };
  // `validateLedgerContent` associates host-filled dimension reasons with its
  // normalized proposal by object identity. Preserve that provenance when the
  // CREATE proposal envelope is added; otherwise a later validation mistakes
  // the host sentence for model prose and reapplies the model minimum.
  rememberHostWrittenReasons(withSourceProposals, hostWrittenReasonsFor(validated));
  return withSourceProposals;
}

export function validateSourceAuthorityProposals(value: unknown): SourceAuthorityProposalV1[] {
  const proposals = at("$.sourceProposals", () => kit.array(value));
  if (proposals.length > limit("sources.createAddedAuthoritySourcesMax").value) {
    return reject("bounds-exceeded", "$.sourceProposals");
  }
  const result: SourceAuthorityProposalV1[] = [];
  const seen = new Set<string>();
  for (const item of proposals) {
    const location = "$.sourceProposals[]" as const;
    const row = at(location, () => kit.object(item));
    exactKeys(location, row, ["path", "reason"]);
    const path = at("$.sourceProposals[].path", () => kit.string(row.path));
    const reason = at("$.sourceProposals[].reason", () => kit.string(row.reason));
    if (!isSourceProposalPath(path)) {
      return reject("invalid-locator", "$.sourceProposals[].path");
    }
    if (seen.has(path)) return reject("duplicate-entry", "$.sourceProposals[].path");
    seen.add(path);
    const boundedReason = boundedText(
      reason,
      limit("factInventory.maxDimensionReasonChars").value,
      "$.sourceProposals[].reason",
      limit("factInventory.minDimensionReasonChars").value,
    );
    if (/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(boundedReason)) {
      return reject("invalid-value", "$.sourceProposals[].reason");
    }
    result.push(Object.freeze({ path, reason: boundedReason }));
  }
  return result;
}

export function isSourceProposalPath(path: string): boolean {
  if (
    !path ||
    path.length > limit("sources.authorityMemberPathMaxChars").value ||
    path !== path.normalize("NFC") ||
    /[\\\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(path) ||
    path.includes(":") ||
    path.startsWith("/") ||
    path.startsWith("~") ||
    path.startsWith("-")
  ) {
    return false;
  }
  const segments = path.split("/");
  return segments.every(
    (segment) =>
      segment.length > 0 &&
      segment !== "." &&
      segment !== ".." &&
      segment.trim() === segment &&
      (!(segment.includes("{") || segment.includes("}")) || /^\{[A-Za-z0-9_]+\}$/u.test(segment)),
  );
}

/** Validate one independently submitted S2 record before the ledger issues its receipt. */
export function validateSourceObligationRecordForAdmission(
  type: string,
  value: unknown,
  input: SourceAuthorityInput,
  parentStatus?: SourceObligationDimensionV1["status"],
): void {
  kit.assertInert(value);
  kit.rejectCredentials(value);
  const item = at("$", () => kit.object(value));
  const authority = sourceLocatorAuthority(input);
  if (type === "dimension") {
    exactKeys("$.dimensions[]", item, ["status", "reason", "sourceLocators", "obligations"]);
    const status = item.status;
    if (status !== "applicable" && status !== "not-applicable" && status !== "unverified") {
      return reject("invalid-value", "$.dimensions[].status");
    }
    boundedText(
      item.reason,
      limit("factInventory.maxDimensionReasonChars").value,
      "$.dimensions[].reason",
      limit("factInventory.minDimensionReasonChars").value,
    );
    const locators = validateLocators(
      item.sourceLocators,
      false,
      authority,
      false,
      "$.dimensions[].sourceLocators",
      "$.dimensions[].sourceLocators[]",
    );
    const obligations = at("$.dimensions[].obligations", () => kit.array(item.obligations));
    if (obligations.length !== 0) return reject("invalid-value", "$.dimensions[].obligations");
    if (status === "applicable" && locators.length !== 0) {
      return rejectRule(
        rejectCorrectable(
          "source-obligation",
          "dimension-applicable-with-locators",
          "$.dimensions[].sourceLocators",
        ),
      );
    }
    if (status === "not-applicable" && locators.length === 0) {
      return rejectRule(
        rejectCorrectable(
          "source-obligation",
          "dimension-not-applicable-unsourced",
          "$.dimensions[].sourceLocators",
        ),
      );
    }
    return;
  }
  if (type === "obligation") {
    exactKeys("$.dimensions[].obligations[]", item, [
      "sourceLocators",
      "statement",
      "evidenceClass",
      "uncertainty",
      "dimensionKey",
    ]);
    const dimension = item.dimensionKey;
    if (
      typeof dimension !== "string" ||
      !TECHNICAL_FACT_DIMENSIONS.includes(dimension as TechnicalFactDimension)
    ) {
      return reject("invalid-value", "$.dimensions[].obligations[].dimension");
    }
    if (parentStatus === "not-applicable") {
      return rejectRule(
        rejectCorrectable(
          "source-obligation",
          "dimension-not-applicable-with-obligations",
          "$.dimensions[].obligations",
        ),
      );
    }
    if (parentStatus === "unverified") {
      return rejectRule(
        rejectCorrectable(
          "source-obligation",
          "dimension-unverified-with-obligations",
          "$.dimensions[].obligations",
        ),
      );
    }
    if (item.evidenceClass !== "source-observation" && item.evidenceClass !== "source-inference") {
      return reject("invalid-value", "$.dimensions[].obligations[].evidenceClass");
    }
    validateLocators(
      item.sourceLocators,
      true,
      authority,
      false,
      "$.dimensions[].obligations[].sourceLocators",
      "$.dimensions[].obligations[].sourceLocators[]",
    );
    boundedText(item.statement, 4_096, "$.dimensions[].obligations[].statement", 8);
    boundedText(item.uncertainty, 2_048, "$.dimensions[].obligations[].uncertainty");
    return;
  }
  if (type === "proposal-note") {
    exactKeys("$.limitations", item, ["limitations", "closed"]);
    boundedTextArray(
      item.limitations,
      limit("factInventory.maxLimitations").value,
      "$.limitations",
      "$.limitations[]",
    );
    return;
  }
  return reject("invalid-value", "$");
}

/**
 * UPDATE must seal every citation it accepts. Check observability inside the
 * inference attempt so the model may correct a citation before the host reads
 * its bytes. CREATE's plan authority and review's degradation are separate.
 * Actual reads and digest checks remain terminal at seal.
 */
export function assertObservableUpdateSourceLocators(
  proposal: SourceObligationLedgerProposalV1,
  input: Pick<HarnessStepInput, "workflow">,
  observable: (path: string) => boolean,
  hostKnown: (path: string) => boolean,
): void {
  if (input.workflow.name !== "update-documentation") return;
  const check = (
    locators: readonly string[],
    location: LocationOf<"source-locator-unobservable">,
  ): void => {
    for (const locator of locators) {
      const { path } = normalizeRepositoryLocator(locator);
      // Strict proposal validation runs first; a nonspecific locator keeps
      // its existing decoder rejection instead of becoming an observability rule.
      if (path !== null && !observable(path)) {
        rejectRule(
          rejectCorrectable("source-obligation", "source-locator-unobservable", location),
          sourcePathRejectionSubject(path, hostKnown),
        );
      }
    }
  };
  for (const dimension of proposal.dimensions) {
    check(dimension.sourceLocators, "$.dimensions[].sourceLocators[]");
    for (const obligation of dimension.obligations) {
      check(obligation.sourceLocators, "$.dimensions[].obligations[].sourceLocators[]");
    }
  }
}

export function sourceObligationLocatorPaths(value: SourceObligationLedgerProposalV1): string[] {
  const paths = value.dimensions
    .flatMap((dimension) => [
      ...dimension.sourceLocators,
      ...dimension.obligations.flatMap((obligation) => obligation.sourceLocators),
    ])
    .map((locator) => normalizeRepositoryLocator(locator).path);
  if (paths.some((path) => path === null)) {
    return fail("Source-obligation evidence requires specific repository locators.");
  }
  return [...new Set(paths as string[])].sort();
}

export function decodeSourceObligationResponse(
  response: string,
  runRevision?: string,
  options: SourceObligationDecodeOptions = {},
): SourceObligationLedgerProposalV1 {
  let parsed: JsonEvidenceValue;
  try {
    // `jsonEnvelopeBody` only chooses which span is the candidate; the strict
    // parser still decides, and with no unambiguous envelope the reply is
    // parsed untouched.
    parsed = parseJsonEvidence(jsonEnvelopeBody(response));
  } catch (error) {
    // A strict-JSON refusal names the whole response. The parser's message is
    // not host-authored and must not reach a retained record; its closed code
    // is kept.
    return reject(jsonRejectionCode(error), "$response");
  }
  try {
    // With the step input, the citation authority check runs here, inside the
    // attempt, where a refusal keeps its excerpt and its retry rule.
    return validateSourceObligationProposal(parsed, options.input, runRevision, options);
  } catch (error) {
    if (error instanceof SourceObligationSourceReferenceError) throw error;
    if (error instanceof InferenceStepError && !error.retryable) throw error;
    // Canonical re-serialization inside validation can raise the same
    // strict-JSON refusal, recorded the same way.
    if (error instanceof JsonEvidenceError) return reject(jsonRejectionCode(error), "$response");
    // Re-raise under this module's reason, not the inner message; an uncoded
    // failure records `unknown`.
    const rejection = projectSourceObligationRejection(error);
    const wrapped = sourceObligationRejectionError(
      rejection?.code ?? "unknown",
      rejection?.location ?? "$",
      // What a coded rule refused stays with its code.
      rejection && error instanceof InferenceStepError ? error.rejectionSubject : undefined,
    );
    if (error instanceof InferenceStepError) {
      const dimension = refusedReasonDimensions.get(error);
      if (dimension !== undefined) refusedReasonDimensions.set(wrapped, dimension);
    }
    throw wrapped;
  }
}

export function canonicalSourceObligationProposal(value: SourceObligationLedgerProposalV1): string {
  return canonicalizeJsonEvidence(value as unknown as JsonEvidenceValue).trimEnd();
}

/**
 * Replace model-printed obligation ids at derive seal. Identity is dimension
 * order, then admitted content. The model id is not an input to the mint.
 */
export function hostMintObligationIdentity(
  proposal: SourceObligationLedgerProposalV1,
): SourceObligationLedgerProposalV1 {
  const { sourceProposals: _sourceProposals, ...ledger } = proposal;
  return {
    ...ledger,
    dimensions: ledger.dimensions.map((dimension) => {
      const ranked = dimension.obligations.map((obligation, index) => ({ obligation, index }));
      ranked.sort((left, right) => {
        const order = compareObligationContent(left.obligation, right.obligation);
        return order === 0 ? left.index - right.index : order;
      });
      return {
        ...dimension,
        // Mint IDs from content rank, then seal in the lexical ID order the
        // durable V1/V2 ledger readers have always used.
        obligations: ranked
          .map((entry, ordinal) => ({
            ...entry.obligation,
            id: hostObligationId(dimension.dimension, ordinal + 1),
          }))
          .sort((left, right) => left.id.localeCompare(right.id)),
      };
    }),
  };
}

export function compareObligationContent(
  left: SourceObligationV1,
  right: SourceObligationV1,
): number {
  return compareCodePoints(obligationContentKey(left), obligationContentKey(right));
}

export function obligationContentKey(obligation: SourceObligationV1): string {
  return [
    obligation.statement,
    [...obligation.sourceLocators].sort().join("\n"),
    obligation.uncertainty,
    obligation.evidenceClass,
    obligation.dimension,
  ].join("\u0000");
}

export function hostObligationId(dimension: TechnicalFactDimension, ordinal: number): string {
  const id = `OBL-${dimension.toUpperCase()}-${ordinal}`;
  if (!OBLIGATION_ID.test(id)) {
    return fail("Host-minted obligation id is outside the closed format.");
  }
  return id;
}

export function validateLedgerContent(
  value: unknown,
  authority?: SourceLocatorAuthority,
  requireHostIdentity = false,
  runRevision?: string,
  finalAttempt = false,
): SourceObligationLedgerProposalV1 {
  at("$", () => kit.assertInert(value));
  at("$", () => kit.rejectCredentials(value));
  const root = at("$", () => kit.object(value));
  const hostWritten = hostWrittenReasonsFor(value);
  if (root.completeness !== "bounded-not-proven") {
    return reject("invalid-value", "$.completeness");
  }
  // Model content degrades only while it is model content. A sealed ledger
  // (`requireHostIdentity`) is re-validated with no degradation, so later
  // steps refuse a locator the host never admitted.
  const degrading = !requireHostIdentity;
  const modelLimitationBound = limit("factInventory.maxLimitations").value;
  const hostLimitationBound = limit("factInventory.maxHostLimitations").value;
  const limitationsOverBound = (entries: readonly string[]): boolean => {
    const hostAuthored = entries.filter((entry) => entry.startsWith(HOST_DEGRADATION_STEM)).length;
    return (
      entries.length - hostAuthored > modelLimitationBound || hostAuthored > hostLimitationBound
    );
  };
  const limitations = boundedTextArray(
    root.limitations,
    modelLimitationBound + hostLimitationBound,
    "$.limitations",
    "$.limitations[]",
  ).sort();
  // The model keeps its own bound; the headroom above it is the host's own
  // degradation notes, at most one per technical dimension, which this same
  // function reads back when the runner re-validates the degraded proposal.
  if (limitationsOverBound(limitations)) {
    return reject("bounds-exceeded", "$.limitations");
  }
  const hostLimitations = new Set<string>();
  const dimensions = at("$.dimensions", () => kit.array(root.dimensions));
  if (dimensions.length > TECHNICAL_FACT_DIMENSIONS.length) {
    return reject("bounds-exceeded", "$.dimensions");
  }
  if (dimensions.length < TECHNICAL_FACT_DIMENSIONS.length) {
    return reject("incomplete-required-set", "$.dimensions");
  }
  const seenDimensions = new Set<string>();
  const seenObligations = new Set<string>();
  let obligationCount = 0;
  const normalized = dimensions.map((raw) => {
    const item = at("$.dimensions[]", () => kit.object(raw));
    exactKeys("$.dimensions[]", item, SOURCE_OBLIGATION_DIMENSION_KEYS);
    const dimension = item.dimension;
    if (
      typeof dimension !== "string" ||
      !TECHNICAL_FACT_DIMENSIONS.includes(dimension as TechnicalFactDimension)
    ) {
      return reject("invalid-value", "$.dimensions[].dimension");
    }
    if (seenDimensions.has(dimension)) {
      return reject("duplicate-entry", "$.dimensions[].dimension");
    }
    seenDimensions.add(dimension);
    const status = item.status;
    if (status !== "applicable" && status !== "not-applicable" && status !== "unverified") {
      return reject("invalid-value", "$.dimensions[].status");
    }
    const missingModelReason =
      degrading && typeof item.reason === "string" && item.reason.trim() === "";
    // One collector per dimension: its removals are named in the one limitation
    // that dimension contributes, never in a rejection reason.
    const removed: RemovedLocator[] = [];
    const degradation = degrading ? { runRevision, removed, finalAttempt } : undefined;
    const sourceLocators = validateLocators(
      item.sourceLocators,
      false,
      authority,
      false,
      "$.dimensions[].sourceLocators",
      "$.dimensions[].sourceLocators[]",
      degradation,
    );
    const obligations = at("$.dimensions[].obligations", () => kit.array(item.obligations));
    const observedHostReason = hostFilledDimensionReason(
      dimension as TechnicalFactDimension,
      status,
      obligations.length,
      sourceLocators.length,
    );
    // Proposal readback carries host origin privately. Model text never earns
    // the minimum exemption by imitating a host sentence or limitation.
    const hostReasonReadback =
      typeof item.reason === "string" &&
      hasHostWrittenReason(hostWritten, dimension, item.reason) &&
      (item.reason === observedHostReason ||
        (status === "unverified" && limitations.includes(item.reason)));
    // A persisted ledger has no object-local provenance. Only its host-sealed
    // path recognizes the exact sentence shapes the decoder and observer write.
    const sealedHostReason =
      requireHostIdentity &&
      typeof item.reason === "string" &&
      (item.reason === observedHostReason ||
        (status === "unverified" &&
          limitations.includes(item.reason) &&
          isHostLocatorDegradationNote(dimension as TechnicalFactDimension, item.reason)));
    let reason: string;
    try {
      reason = boundedText(
        missingModelReason ? observedHostReason : item.reason,
        limit("factInventory.maxDimensionReasonChars").value,
        "$.dimensions[].reason",
        // The configured minimum governs model prose. The host's attributed
        // account is accepted for every supported minimum override.
        missingModelReason || hostReasonReadback || sealedHostReason
          ? undefined
          : limit("factInventory.minDimensionReasonChars").value,
      );
    } catch (error) {
      if (error instanceof InferenceStepError) {
        const rejection = projectSourceObligationRejection(error);
        if (rejection?.location === "$.dimensions[].reason") {
          refusedReasonDimensions.set(error, dimension as TechnicalFactDimension);
        }
      }
      throw error;
    }
    if (missingModelReason) markHostWrittenReason(hostWritten, dimension, reason);
    if (obligations.length > limit(MAX_PER_DIMENSION_LIMIT).value) {
      return reject("bounds-exceeded", "$.dimensions[].obligations");
    }
    // Each status pairing is its own catalog rule, so a retry names the one
    // the reply broke.
    if (status === "applicable" && obligations.length === 0) {
      return rejectRule(
        rejectCorrectable(
          "source-obligation",
          "dimension-applicable-without-obligations",
          "$.dimensions[].obligations",
        ),
      );
    }
    if (status === "applicable" && sourceLocators.length !== 0) {
      return rejectRule(
        rejectCorrectable(
          "source-obligation",
          "dimension-applicable-with-locators",
          "$.dimensions[].sourceLocators",
        ),
      );
    }
    if (status === "not-applicable" && obligations.length !== 0) {
      return rejectRule(
        rejectCorrectable(
          "source-obligation",
          "dimension-not-applicable-with-obligations",
          "$.dimensions[].obligations",
        ),
      );
    }
    if (status === "unverified" && obligations.length !== 0) {
      return rejectRule(
        rejectCorrectable(
          "source-obligation",
          "dimension-unverified-with-obligations",
          "$.dimensions[].obligations",
        ),
      );
    }
    // A not-applicable dimension the host stripped every locator from is
    // demoted; one whose locators the model simply omitted keeps its refusal.
    let demoted = false;
    if (status === "not-applicable" && sourceLocators.length === 0) {
      if (removed.length === 0) {
        return rejectRule(
          rejectCorrectable(
            "source-obligation",
            "dimension-not-applicable-unsourced",
            "$.dimensions[].sourceLocators",
          ),
        );
      }
      demoted = true;
    }
    if (status === "unverified" && !missingModelReason && !limitations.includes(reason)) {
      return rejectRule(
        rejectCorrectable(
          "source-obligation",
          "dimension-unverified-reason-unlisted",
          "$.dimensions[].reason",
        ),
      );
    }
    const normalizedObligations = obligations.map((obligationValue) => {
      const obligation = at("$.dimensions[].obligations[]", () => kit.object(obligationValue));
      exactKeys(
        "$.dimensions[].obligations[]",
        obligation,
        SOURCE_OBLIGATION_KEYS,
        requireHostIdentity ? [] : ["id"],
      );
      const id = requireHostIdentity
        ? boundedText(obligation.id, 64, "$.dimensions[].obligations[].id")
        : "OBL-IGNORED";
      if (requireHostIdentity) {
        if (!OBLIGATION_ID.test(id)) {
          return reject("invalid-value", "$.dimensions[].obligations[].id");
        }
        if (seenObligations.has(id)) {
          return reject("duplicate-entry", "$.dimensions[].obligations[].id");
        }
        seenObligations.add(id);
      }
      obligationCount += 1;
      if (obligationCount > limit(MAX_OBLIGATIONS_LIMIT).value) {
        return reject("bounds-exceeded", "$.dimensions[].obligations");
      }
      if (obligation.dimension !== dimension) {
        // Not a status disagreement: the obligation named the wrong dimension.
        return reject("invalid-value", "$.dimensions[].obligations[].dimension");
      }
      if (
        obligation.evidenceClass !== "source-observation" &&
        obligation.evidenceClass !== "source-inference"
      ) {
        return reject("invalid-value", "$.dimensions[].obligations[].evidenceClass");
      }
      const obligationLocators = validateLocators(
        obligation.sourceLocators,
        true,
        authority,
        false,
        "$.dimensions[].obligations[].sourceLocators",
        "$.dimensions[].obligations[].sourceLocators[]",
        degradation,
      );
      // The model cited locators (an empty array is refused above) and the
      // host could read none, so the obligation has no evidence and goes.
      if (obligationLocators.length === 0) return undefined;
      return {
        id,
        dimension: dimension as TechnicalFactDimension,
        sourceLocators: obligationLocators,
        statement: boundedText(
          obligation.statement,
          4_096,
          "$.dimensions[].obligations[].statement",
          8,
        ),
        evidenceClass: obligation.evidenceClass,
        uncertainty: boundedText(
          obligation.uncertainty,
          2_048,
          "$.dimensions[].obligations[].uncertainty",
        ),
      } as SourceObligationV1;
    });
    const keptObligations = normalizedObligations.filter(
      (obligation): obligation is SourceObligationV1 => obligation !== undefined,
    );
    // Every obligation lost its locators to host removal, so the dimension
    // demotes; a zero-obligation model reply is refused above.
    if (status === "applicable" && keptObligations.length === 0) {
      if (removed.length === 0) {
        return rejectRule(
          rejectCorrectable(
            "source-obligation",
            "dimension-applicable-without-obligations",
            "$.dimensions[].obligations",
          ),
        );
      }
      demoted = true;
    }
    if (demoted) {
      // Both demotion branches above refuse when `removed` is empty, so a
      // demoted dimension always has removals to name in its own reason.
      const limitation = hostDegradationLimitation(
        dimension as TechnicalFactDimension,
        removed,
        true,
      );
      hostLimitations.add(limitation);
      markHostWrittenReason(hostWritten, dimension, limitation);
      return {
        dimension: dimension as TechnicalFactDimension,
        status: "unverified",
        reason: limitation,
        sourceLocators: [],
        obligations: [],
      } as SourceObligationDimensionV1;
    }
    // A removal is recorded whenever the host makes one, not only when it
    // costs the dimension its status; a dimension with no removal adds no note.
    if (removed.length > 0) {
      const removalNote = hostDegradationLimitation(
        dimension as TechnicalFactDimension,
        removed,
        false,
      );
      hostLimitations.add(removalNote);
      markHostWrittenReason(hostWritten, dimension, removalNote);
      // An unverified dimension's reason must be present in limitations.
      // Reuse its one host note when both the reason and a locator were missing.
      if (missingModelReason && status === "unverified") reason = removalNote;
    } else if (missingModelReason && status === "unverified") {
      hostLimitations.add(reason);
      markHostWrittenReason(hostWritten, dimension, reason);
    }
    keptObligations.sort((left, right) => left.id.localeCompare(right.id));
    return {
      dimension: dimension as TechnicalFactDimension,
      status,
      reason,
      sourceLocators,
      obligations: keptObligations,
    } as SourceObligationDimensionV1;
  });
  normalized.sort(
    (left, right) =>
      TECHNICAL_FACT_DIMENSIONS.indexOf(left.dimension) -
      TECHNICAL_FACT_DIMENSIONS.indexOf(right.dimension),
  );
  const finalLimitations =
    hostLimitations.size === 0
      ? limitations
      : [...new Set([...limitations, ...hostLimitations])].sort();
  if (limitationsOverBound(finalLimitations)) {
    return reject("bounds-exceeded", "$.limitations");
  }
  const proposal: SourceObligationLedgerProposalV1 = {
    completeness: "bounded-not-proven",
    dimensions: normalized,
    limitations: finalLimitations,
  };
  rememberHostWrittenReasons(proposal, hostWritten);
  return proposal;
}

export function validateAccounting(
  value: unknown,
  ledger: SourceObligationLedger,
  verificationResult: VerificationResult,
  authorityPathsOverride?: ReadonlySet<string>,
  preserveOrder = false,
): ObligationAccountingRowV1[] {
  const rows = kit.array(value);
  const obligations = ledger.dimensions.flatMap((dimension) => dimension.obligations);
  if (rows.length !== obligations.length) {
    return fail("Technical correction must account for every source obligation exactly once.");
  }
  const obligationsById = new Map(obligations.map((item) => [item.id, item]));
  const facts = verificationResult.factInventory.dimensions.flatMap((item) => item.facts);
  const factsById = new Map(facts.map((item) => [item.id, item]));
  const authorityPaths =
    authorityPathsOverride ??
    (ledger.schemaVersion === 1
      ? new Set(
          ledger.dimensions
            .flatMap((dimension) => [
              ...dimension.sourceLocators,
              ...dimension.obligations.flatMap((obligation) => obligation.sourceLocators),
            ])
            .flatMap((locator) => {
              const path = normalizeRepositoryLocator(locator).path;
              return path ? [path] : [];
            }),
        )
      : undefined);
  const seen = new Set<string>();
  const normalized: ObligationAccountingRowV1[] = rows.map((raw) => {
    const row = kit.object(raw);
    const obligationId = boundedText(row.obligationId, 64);
    const obligation = obligationsById.get(obligationId);
    if (!obligation || seen.has(obligationId)) {
      return fail("Technical correction contains an unknown or duplicate obligation ID.");
    }
    seen.add(obligationId);
    if (row.disposition === "retained") {
      kit.exact(row, ["obligationId", "disposition", "factIds"]);
      const factIds = validateFactIds(row.factIds, factsById, preserveOrder);
      if (factIds.length !== 1) {
        return fail("A retained obligation must name exactly one final fact.");
      }
      const fact = factsById.get(factIds[0]!)!;
      if (
        fact.dimension !== obligation.dimension ||
        fact.statement !== obligation.statement ||
        fact.uncertainty !== obligation.uncertainty ||
        JSON.stringify(fact.sourceLocators) !== JSON.stringify(obligation.sourceLocators)
      ) {
        return fail("A retained obligation must carry its source statement exactly.");
      }
      return {
        obligationId,
        disposition: "retained" as const,
        factIds: [factIds[0]!],
      };
    }
    if (row.disposition !== "refined" && row.disposition !== "rejected") {
      return fail("Technical correction contains an invalid disposition.");
    }
    kit.exact(row, OBLIGATION_ACCOUNTING_KEYS);
    const factIds = validateFactIds(row.factIds, factsById, preserveOrder);
    if (row.disposition === "refined" && factIds.length === 0) {
      return fail("A refined obligation must name at least one replacement fact.");
    }
    if (row.disposition === "rejected" && factIds.length !== 0) {
      return fail("A rejected obligation cannot name a final fact.");
    }
    for (const factId of factIds) {
      const fact = factsById.get(factId)!;
      if (fact.dimension !== obligation.dimension) {
        return fail(
          `Refined obligation ${obligationId} references final fact ${factId} in dimension ${fact.dimension}; expected ${obligation.dimension}.`,
        );
      }
    }
    const sourceLocators = technicalCorrectionBoundary("source-authority", () =>
      validateLocators(
        row.sourceLocators,
        true,
        authorityPaths ? { paths: authorityPaths } : undefined,
        preserveOrder,
      ),
    );
    return {
      obligationId,
      disposition: row.disposition as "refined" | "rejected",
      factIds,
      reason: boundedText(row.reason, 2_048, undefined, 12),
      sourceLocators,
    };
  });
  if (!preserveOrder) {
    normalized.sort((left, right) => left.obligationId.localeCompare(right.obligationId));
  }
  return normalized;
}

/** What a CREATE source-obligation reply may cite, from the step input. */
export type SourceAuthorityInput = Pick<
  HarnessStepInput,
  | "workflow"
  | "planBinding"
  | "evidenceIdentity"
  | "trackedRepositoryPaths"
  | "admittedSourceAuthorityPaths"
>;

/** The paths a citation may name, and the paths the host can name a refused citation by. */
export interface SourceLocatorAuthority {
  readonly paths: ReadonlySet<string>;
  /** The plan's write paths: citing one is `write-target-source`. */
  readonly writePaths?: ReadonlySet<string>;
  /** CREATE citations outside the plan must declare a host-admission proposal. */
  readonly requiresProposal?: boolean;
  /** Absent: a refusal records no subject. */
  readonly knownPath?: (path: string) => boolean;
}

/**
 * The CREATE citation authority: the plan's bound sources. A refused citation
 * is named on the record only by a path the host knows: one of the plan's
 * write paths, or a tracked regular file at the run's revision.
 */
export function sourceLocatorAuthority(
  input?: SourceAuthorityInput,
  proposedPaths: readonly string[] = [],
): SourceLocatorAuthority | undefined {
  const paths = sourceAuthorityPaths(input);
  if (!paths || !input?.planBinding) return undefined;
  const temporaryPaths = new Set([
    ...paths,
    ...(input.admittedSourceAuthorityPaths ?? []),
    ...proposedPaths,
  ]);
  const writePaths = new Set(documentationPlanPagePaths(input.planBinding));
  const tracked = input.trackedRepositoryPaths;
  return {
    paths: temporaryPaths,
    writePaths,
    requiresProposal: true,
    knownPath: (path) => writePaths.has(path) || tracked?.has(path) === true,
  };
}

export function assertSourceObligationSourceAuthority(
  input: Pick<HarnessStepInput, "workflow" | "planBinding" | "evidenceIdentity">,
): readonly string[] {
  return [...(sourceAuthorityPaths(input) ?? [])].sort();
}

export function sourceAuthorityPaths(
  input?: Pick<HarnessStepInput, "workflow" | "planBinding" | "evidenceIdentity">,
): ReadonlySet<string> | undefined {
  if (!input?.planBinding || input.workflow.name !== "create-documentation") return undefined;
  const expectedRevision = input.evidenceIdentity?.repositoryRevision;
  if (!expectedRevision) {
    return failSourceReference("invalid-reference");
  }
  const paths = input.planBinding.sourceBindings.flatMap((binding) =>
    binding.sources.flatMap((locator) => {
      const path = sourceReferencePath(locator, expectedRevision);
      return path ? [path] : [];
    }),
  );
  if (paths.length === 0) {
    return failSourceReference("invalid-reference");
  }
  const writePaths = new Set(documentationPlanPagePaths(input.planBinding));
  if (paths.some((path) => writePaths.has(path))) {
    return failSourceReference("source-write-intersection");
  }
  return new Set(paths);
}

/**
 * The repository path a plan source locator names, read through the one plan
 * source locator grammar plan admission also uses. A refusal keeps its
 * recorded derivation code.
 */
export function sourceReferencePath(value: string, expectedRevision: string): string {
  const admitted = admitPlanSourceLocator(value, expectedRevision);
  if (isPlanSourceLocatorRefusal(admitted)) return failSourceReference(admitted.refusal);
  return admitted.path;
}

/**
 * The final limitations: the inventory's own, plus one per rejected
 * obligation. A rejected obligation of a demoted dimension already has
 * the host's per-obligation demotion evidence limitation, which stands in for
 * the generic one (`superseded`), so each rejected obligation has exactly one.
 */
export function withRejectedObligationLimitations(
  limitations: readonly string[],
  accounting: readonly ObligationAccountingRowV1[],
  superseded: ReadonlySet<string> = new Set(),
): string[] {
  const result = [...limitations];
  for (const row of accounting) {
    if (row.disposition !== "rejected" || superseded.has(row.obligationId)) continue;
    const limitation =
      `Rejected source obligation ${row.obligationId}: ${row.reason} ` +
      `Source locators: ${row.sourceLocators.join("; ")}`;
    if (limitation.length > 4_096) {
      return fail(
        "A rejected source obligation exceeds the final limitation representation bound.",
      );
    }
    if (!result.includes(limitation)) result.push(limitation);
  }
  return result;
}

/**
 * Refuse, by name, a final limitation count over
 * `factInventory.maxLimitations`. Terminal: see
 * `FACT_INVENTORY_LIMITATION_BOUND_REJECTION`.
 */
export function assertFactInventoryLimitationCount(
  count: number,
  location: "$.obligationJudgments" | "$.obligationAccounting",
): void {
  const resolved = limit("factInventory.maxLimitations");
  if (count <= resolved.value) return;
  rejectFactInventoryLimitationBound(
    `${resolved.refusal}: ${count} limitations exceed ${resolved.name} = ${resolved.value} ${resolved.unit} for one technical fact inventory. ${resolved.remediation}`,
    location,
  );
}

/**
 * How one rejected obligation's demotion evidence limitation begins.
 * Formatting only: the skip decision reads host dimension status, not this.
 */
export function demotionEvidencePrefix(obligationId: string): string {
  return `Host demotion evidence for rejected source obligation ${obligationId} (`;
}

/**
 * The rejected obligations of the dimensions the host demoted; their
 * per-obligation demotion evidence limitation stands in for the generic one.
 *
 * Decided from host data only (an applicable ledger dimension the host-built
 * inventory marks unverified). Limitation text is never evidence here, because
 * ledger limitations are model-proposed and obligation IDs are predictable. A
 * host-built inventory missing a host evidence limitation is refused as a host
 * defect.
 */
export function demotionSupersededObligationIds(
  ledger: SourceObligationLedgerV2,
  inventory: VerificationResult["factInventory"],
  accounting: readonly ObligationAccountingRowV1[],
): Set<string> {
  const unverified = new Set(
    inventory.dimensions
      .filter(({ status }) => status === "unverified")
      .map(({ dimension }) => dimension),
  );
  const dimensionOf = new Map<string, TechnicalFactDimension>();
  // Only an applicable ledger dimension has obligations, so an unverified
  // inventory dimension that owns one is a host demotion.
  for (const { dimension, obligations } of ledger.dimensions) {
    if (!unverified.has(dimension)) continue;
    for (const { id } of obligations) dimensionOf.set(id, dimension);
  }
  const superseded = new Set<string>();
  for (const { disposition, obligationId } of accounting) {
    const dimension = dimensionOf.get(obligationId);
    if (disposition !== "rejected" || dimension === undefined) continue;
    const marker = `${demotionEvidencePrefix(obligationId)}${dimension}): `;
    if (!inventory.limitations.some((limitation) => limitation.startsWith(marker))) {
      return fail(
        "A demoted dimension's rejected obligation has no host evidence limitation.",
        false,
      );
    }
    superseded.add(obligationId);
  }
  return superseded;
}

export function projectRejectedObligationLimitations(
  verificationResult: VerificationResult,
  accounting: readonly ObligationAccountingRowV1[],
  superseded?: ReadonlySet<string>,
): VerificationResult {
  const limitations = withRejectedObligationLimitations(
    verificationResult.factInventory.limitations,
    accounting,
    superseded,
  );
  assertFactInventoryLimitationCount(limitations.length, "$.obligationAccounting");
  return {
    ...verificationResult,
    factInventory: { ...verificationResult.factInventory, limitations },
  };
}

export function validateSourceIdentities(
  value: readonly SourceObligationSourceIdentityV1[],
): SourceObligationSourceIdentityV1[] {
  // An inventory whose every dimension degraded to `unverified` cites no
  // source, so an empty identity set is admitted here;
  // {@link assertSourceIdentitiesCoverContent} refuses it beside content that
  // cites a path.
  if (!Array.isArray(value) || value.length > limit(MAX_LOCATORS_LIMIT).value) {
    return fail(SOURCE_OBLIGATION_FAILURES.sourceIdentitySet);
  }
  const seen = new Set<string>();
  const result = value.map((item) => {
    const root = kit.object(item);
    kit.exact(root, ["path", "sha256"]);
    const path = normalizeRepositoryLocator(root.path).path;
    if (!path || seen.has(path)) {
      return fail("Source-obligation evidence contains an invalid source identity.");
    }
    seen.add(path);
    return { path, sha256: boundedDigest(root.sha256) };
  });
  return result.sort((left, right) => left.path.localeCompare(right.path));
}

/**
 * Refuse an empty observed source set beside ledger content that names a
 * source path the host recorded no observation of.
 */
export function assertSourceIdentitiesCoverContent(
  proposal: SourceObligationLedgerProposalV1,
  sources: readonly SourceObligationSourceIdentityV1[],
): void {
  if (sources.length === 0 && sourceObligationLocatorPaths(proposal).length !== 0) {
    return fail(SOURCE_OBLIGATION_FAILURES.sourceIdentitySet);
  }
}

export function validateIdentity(value: unknown): SourceObligationLedgerIdentityV1 {
  const identity = kit.object(value);
  kit.exact(identity, [
    "repositoryRevision",
    "scopeSha256",
    "sourceEvidenceSha256",
    "workspaceSnapshotSha256",
    "sources",
  ]);
  const repositoryRevision = boundedText(identity.repositoryRevision, 512);
  return {
    repositoryRevision,
    scopeSha256: boundedDigest(identity.scopeSha256),
    sourceEvidenceSha256: boundedDigest(identity.sourceEvidenceSha256),
    workspaceSnapshotSha256: boundedDigest(identity.workspaceSnapshotSha256),
    sources: validateSourceIdentities(
      kit.array(identity.sources) as SourceObligationSourceIdentityV1[],
    ),
  };
}

export function validateIdentityV2(value: unknown): SourceObligationLedgerIdentityV2 {
  const identity = kit.object(value);
  kit.exact(identity, [
    "repositoryRevision",
    "scopeSha256",
    "sourceEvidenceSha256",
    "workspaceSnapshotSha256",
    "sources",
    "originalSourceAuthority",
  ]);
  const common = validateIdentity({
    repositoryRevision: identity.repositoryRevision,
    scopeSha256: identity.scopeSha256,
    sourceEvidenceSha256: identity.sourceEvidenceSha256,
    workspaceSnapshotSha256: identity.workspaceSnapshotSha256,
    sources: identity.sources,
  });
  return {
    ...common,
    originalSourceAuthority: validateOriginalSourceAuthorityDescriptor(
      identity.originalSourceAuthority,
    ),
  };
}

export function assertObservedSourcesAuthorized(
  sources: readonly SourceObligationSourceIdentityV1[],
  evidence: OriginalSourceAuthorityEvidenceV1,
): void {
  const members = originalSourceAuthorityMemberMap(evidence);
  for (const source of sources) {
    if (members.get(source.path)?.sourceSha256 !== source.sha256) {
      return fail("Source-obligation observation is outside the original source authority.", false);
    }
  }
}

export function technicalCorrectionAuthorityPaths(
  verificationResult: VerificationResult,
  accounting: readonly ObligationAccountingRowV1[],
): string[] {
  const locators = [
    ...verificationResult.factInventory.dimensions.flatMap((dimension) => [
      ...dimension.sourceLocators,
      ...dimension.facts.flatMap((fact) => fact.sourceLocators),
    ]),
    ...accounting.flatMap((row) => (row.disposition === "retained" ? [] : row.sourceLocators)),
  ];
  const paths = locators.map((locator) => normalizeRepositoryLocator(locator).path);
  if (paths.some((path) => path === null)) {
    return fail("Technical correction requires specific original source locators.");
  }
  return [...new Set(paths as string[])].sort();
}

export function validateSourceChecks(
  value: unknown,
  requiredPaths: readonly string[],
  authority: OriginalSourceAuthorityEvidenceV1,
): OriginalSourceAuthorityCheckV1[] {
  const members = originalSourceAuthorityMemberMap(authority);
  const checks = kit.array(value).map((raw) => {
    const check = kit.object(raw);
    kit.exact(check, ["path", "sourceSha256"]);
    const path = normalizeRepositoryLocator(check.path).path;
    if (!path) return fail("Technical correction source check contains an invalid path.");
    return { path, sourceSha256: boundedDigest(check.sourceSha256) };
  });
  const sorted = [...checks].sort((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
  );
  if (
    checks.length !== requiredPaths.length ||
    new Set(checks.map((check) => check.path)).size !== checks.length ||
    checks.some((check, index) => check.path !== sorted[index]?.path) ||
    checks.some((check, index) => check.path !== requiredPaths[index]) ||
    checks.some((check) => members.get(check.path)?.sourceSha256 !== check.sourceSha256)
  ) {
    return fail(
      "Technical correction source checks do not exactly match required authority.",
      false,
    );
  }
  return checks;
}

/**
 * How much source evidence a sealed ledger kept, counted per technical
 * dimension: a run whose every dimension is unverified carries no source
 * evidence, however its later steps end.
 */
export interface SourceEvidenceTallyV1 {
  readonly dimensions: number;
  /**
   * Counted by status, never by reason text: a model can write a reason that
   * reads like a host note, so the reason cannot say who made it unverified.
   */
  readonly unverified: number;
}

/**
 * Tally a sealed ledger from the source-obligation step that sealed it: its
 * summary is the ledger, and a V2 ledger validates against the original
 * source authority the same step retains. `undefined` when the two are not a
 * ledger this host validates, so a caller reports the tally as unknown rather
 * than guessing.
 */
export function sealedLedgerSourceEvidence(step: {
  readonly summary?: unknown;
  readonly originalSourceAuthority?: unknown;
}): SourceEvidenceTallyV1 | undefined {
  if (typeof step.summary !== "string") return undefined;
  let ledger: SourceObligationLedger;
  try {
    ledger = validateSourceObligationLedger(
      parseJsonEvidence(step.summary),
      undefined,
      step.originalSourceAuthority as OriginalSourceAuthorityEvidenceV1 | undefined,
    );
  } catch (error) {
    // Only a refused ledger reads as unknown; anything else is a host defect.
    if (error instanceof InferenceStepError || error instanceof JsonEvidenceError) return undefined;
    throw error;
  }
  return Object.freeze({
    dimensions: ledger.dimensions.length,
    unverified: ledger.dimensions.filter((dimension) => dimension.status === "unverified").length,
  });
}
