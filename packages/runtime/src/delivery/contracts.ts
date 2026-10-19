// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";

import { canonicalizeJsonEvidence, type JsonEvidenceValue } from "../json-evidence.js";
import {
  DELIVERY_ACTIONS,
  PUBLICATION_ACTIONS,
  type DeliveryWorktreeFailureCode,
  type LocalUserPublicationFailureCode,
} from "../operator/situation-catalog.js";
import { detectCredentialRuleIds, SECURITY_RULE_IDS } from "../security/repository-scanner.js";
import {
  screenCredentialText,
  URL_USERINFO_RULE_ID,
} from "../security/credential-shape-findings.js";
import { redactCredentialMaterial } from "../security/credential-material.js";
import {
  assertDocumentationValidationBinding,
  DocumentationValidationError,
  resolveHostDocumentationValidator,
  type DocumentationValidationBindingV1,
  type DocumentationValidationBindingV2,
} from "./validation-profile.js";
import type { AuthorityBasis } from "./delivery-authority.js";
import { isDnsHostname } from "../shared/dns-hostname.js";
import { isRecord } from "../shared/primitives.js";

export type { DeliveryWorktreeFailureCode, LocalUserPublicationFailureCode };

/** GitLab Developer access; shared by preflight and every later mutation boundary. */
export const LOCAL_USER_MINIMUM_PUSH_ACCESS_LEVEL = 30;

export const DELIVERY_VALIDATION_FAILURE_REASONS = [
  "validation-check-failed",
  "validation-command-failed",
  "validation-backend-unavailable",
  "validation-state-mutated",
  "validation-exception",
] as const;
export type DeliveryValidationFailureReason = (typeof DELIVERY_VALIDATION_FAILURE_REASONS)[number];

/** Bounded, content-free validation evidence that is safe to retain and project. */
export interface DeliveryValidationFailureEvidence {
  readonly reasonCode: DeliveryValidationFailureReason;
  readonly planSha256?: string;
  readonly runId?: string;
  readonly runRecordSha256?: string;
  readonly patchSha256?: string;
  readonly workspaceKey?: string;
  readonly commandSha256?: string;
  readonly profileId?: string;
  readonly profileVersion?: string;
  readonly checkIds?: readonly string[];
  readonly selectorInputSha256?: string;
  readonly validatorIdentity?: string;
  readonly candidateTreeSha256?: string;
  readonly checkSetSha256?: string;
  readonly applicabilitySha256?: string;
  readonly backendIdentity?: string;
  readonly results?: readonly {
    readonly id: string;
    readonly status: "failed" | "limitation";
  }[];
}

/** Content-free failure. Delivery paths, Git output, patch data, and validation output are excluded. */
export class DeliveryWorktreeError extends Error {
  public readonly action: string;
  public readonly validation?: DeliveryValidationFailureEvidence;

  public constructor(
    public readonly code: DeliveryWorktreeFailureCode,
    validation?: DeliveryValidationFailureEvidence,
  ) {
    const action = DELIVERY_ACTIONS[code];
    super(`Delivery worktree operation failed (${code}). ${action}`);
    this.name = "DeliveryWorktreeError";
    this.action = action;
    this.validation = normalizeDeliveryValidationFailureEvidence(validation);
  }
}

export function normalizeDeliveryValidationFailureEvidence(
  value: DeliveryValidationFailureEvidence | undefined,
): DeliveryValidationFailureEvidence | undefined {
  if (value === undefined) return undefined;
  if (
    !value ||
    typeof value !== "object" ||
    !DELIVERY_VALIDATION_FAILURE_REASONS.includes(value.reasonCode) ||
    Object.keys(value).some(
      (key) =>
        ![
          "reasonCode",
          "planSha256",
          "runId",
          "runRecordSha256",
          "patchSha256",
          "workspaceKey",
          "commandSha256",
          "profileId",
          "profileVersion",
          "checkIds",
          "selectorInputSha256",
          "validatorIdentity",
          "candidateTreeSha256",
          "checkSetSha256",
          "applicabilitySha256",
          "backendIdentity",
          "results",
        ].includes(key),
    )
  ) {
    return undefined;
  }
  const sha = (candidate: unknown): candidate is string =>
    typeof candidate === "string" && /^[a-f0-9]{64}$/u.test(candidate);
  const id = (candidate: unknown): candidate is string =>
    typeof candidate === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(candidate) &&
    !containsConfiguredCredentialText(candidate, "publication-plan:documentationValidation");
  for (const candidate of [
    value.planSha256,
    value.runRecordSha256,
    value.patchSha256,
    value.workspaceKey,
    value.commandSha256,
    value.selectorInputSha256,
    value.candidateTreeSha256,
    value.checkSetSha256,
    value.applicabilitySha256,
  ]) {
    if (candidate !== undefined && !sha(candidate)) return undefined;
  }
  for (const candidate of [
    value.runId,
    value.profileId,
    value.profileVersion,
    value.validatorIdentity,
    value.backendIdentity,
  ]) {
    if (candidate !== undefined && !id(candidate)) return undefined;
  }
  const candidateBinding = [
    value.planSha256,
    value.runId,
    value.runRecordSha256,
    value.patchSha256,
    value.workspaceKey,
    value.candidateTreeSha256,
  ];
  if (
    candidateBinding.some((candidate) => candidate !== undefined) &&
    candidateBinding.some((candidate) => candidate === undefined)
  ) {
    return undefined;
  }
  if (
    value.checkIds !== undefined &&
    (!Array.isArray(value.checkIds) || value.checkIds.length === 0 || value.checkIds.length > 64)
  ) {
    return undefined;
  }
  if (value.checkIds?.some((candidate) => !id(candidate))) return undefined;
  if (value.checkIds && new Set(value.checkIds).size !== value.checkIds.length) return undefined;
  if (
    value.results !== undefined &&
    (!Array.isArray(value.results) || value.results.length === 0 || value.results.length > 64)
  ) {
    return undefined;
  }
  if (
    value.results?.some(
      (result) =>
        !result ||
        typeof result !== "object" ||
        Object.keys(result).some((key) => key !== "id" && key !== "status") ||
        !id(result.id) ||
        (result.status !== "failed" && result.status !== "limitation"),
    )
  ) {
    return undefined;
  }
  if (
    value.results &&
    new Set(value.results.map((result) => result.id)).size !== value.results.length
  ) {
    return undefined;
  }
  const normalized: DeliveryValidationFailureEvidence = Object.freeze({
    reasonCode: value.reasonCode,
    ...(value.planSha256 ? { planSha256: value.planSha256 } : {}),
    ...(value.runId ? { runId: value.runId } : {}),
    ...(value.runRecordSha256 ? { runRecordSha256: value.runRecordSha256 } : {}),
    ...(value.patchSha256 ? { patchSha256: value.patchSha256 } : {}),
    ...(value.workspaceKey ? { workspaceKey: value.workspaceKey } : {}),
    ...(value.commandSha256 ? { commandSha256: value.commandSha256 } : {}),
    ...(value.profileId ? { profileId: value.profileId } : {}),
    ...(value.profileVersion ? { profileVersion: value.profileVersion } : {}),
    ...(value.checkIds ? { checkIds: Object.freeze([...value.checkIds]) } : {}),
    ...(value.selectorInputSha256 ? { selectorInputSha256: value.selectorInputSha256 } : {}),
    ...(value.validatorIdentity ? { validatorIdentity: value.validatorIdentity } : {}),
    ...(value.candidateTreeSha256 ? { candidateTreeSha256: value.candidateTreeSha256 } : {}),
    ...(value.checkSetSha256 ? { checkSetSha256: value.checkSetSha256 } : {}),
    ...(value.applicabilitySha256 ? { applicabilitySha256: value.applicabilitySha256 } : {}),
    ...(value.backendIdentity ? { backendIdentity: value.backendIdentity } : {}),
    ...(value.results
      ? { results: Object.freeze(value.results.map((result) => Object.freeze({ ...result }))) }
      : {}),
  });
  return normalized;
}

const ACTIONS: Readonly<Record<LocalUserPublicationFailureCode, string>> = PUBLICATION_ACTIONS;

const SELECTED_DIRECTORY_HOME =
  /^(?:(?:[A-Za-z]:)?[\\/]Users[\\/][^\\/]+(?=[\\/]|$)|(?:[A-Za-z]:)?[\\/]home[\\/][^\\/]+(?=[\\/]|$)|(?:[A-Za-z]:)?[\\/]root(?=[\\/]|$))/u;

function selectedDirectoryDisplay(path: string): string {
  const escaped = path.replace(/[\u0000-\u001f\u007f]/gu, (character) => {
    const code = character.charCodeAt(0).toString(16).padStart(2, "0");
    return `\\x${code}`;
  });
  const redacted = escaped
    .replace(SELECTED_DIRECTORY_HOME, "[REDACTED]")
    .replace(/https?:\/\/[^\s"'<>]*/giu, "[REDACTED]");
  const credentialSafe = redactCredentialMaterial(redacted);
  return credentialSafe.length > 0 ? credentialSafe : "[REDACTED]";
}

/** A Git configuration origin for a message: a `file:` path is redacted like a selected directory. */
function configurationOriginDisplay(origin: string): string {
  return origin.startsWith("file:")
    ? `file:${selectedDirectoryDisplay(origin.slice("file:".length))}`
    : selectedDirectoryDisplay(origin);
}

/** Optional revision or operator-selected --state-dir evidence on preflight failures. */
export interface LocalUserPublicationPreflightDetails {
  readonly runRevision?: string;
  readonly gitlabTargetRevision?: string;
  readonly gitlabTargetBranch?: string;
  /** Operator-selected --state-dir when it is the parent of an intact run-store. */
  readonly selectedDirectory?: string;
  /**
   * The refusal sentence of a crossed operational limit: its code, the
   * observed value, the bound, and the remediation. Never caller text.
   */
  readonly limitRefusal?: string;
  /**
   * The advance field a revision refusal names, with the value the parent
   * chain requires and the value observed. Revisions, branch names, states,
   * and GitLab usernames only.
   */
  readonly revision?: {
    readonly field: string;
    readonly expected?: string;
    readonly observed?: string;
  };
  /**
   * The Git setting a configuration refusal names: its key, which never
   * carries a subsection, and the file or source it is set in. Never a value.
   * `reason` is set when the file is a global file that DocsFab does not trust
   * for this setting because `HOME` is not an absolute path outside the checkout.
   */
  readonly configuration?: {
    readonly key: string;
    readonly origin: string;
    readonly reason?: "home-not-operator-owned";
  };
}

/**
 * Content-free failure: command output, URLs, identities, and credentials are
 * excluded. Operator-selected `--state-dir` may be named with a privacy-safe
 * display when that directory is the parent of an intact run-store.
 */
export class LocalUserPublicationPreflightError extends Error {
  public readonly action: string;
  public readonly details?: LocalUserPublicationPreflightDetails;

  public constructor(
    public readonly code: LocalUserPublicationFailureCode,
    details?: LocalUserPublicationPreflightDetails,
  ) {
    const safeDetails =
      details === undefined
        ? undefined
        : {
            ...details,
            ...(typeof details.selectedDirectory === "string"
              ? { selectedDirectory: selectedDirectoryDisplay(details.selectedDirectory) }
              : {}),
            ...(details.configuration
              ? {
                  configuration: {
                    key: selectedDirectoryDisplay(details.configuration.key),
                    origin: configurationOriginDisplay(details.configuration.origin),
                    ...(details.configuration.reason === "home-not-operator-owned"
                      ? { reason: details.configuration.reason }
                      : {}),
                  },
                }
              : {}),
          };
    const action = ACTIONS[code];
    const revisionEvidence =
      details?.runRevision !== undefined && details?.gitlabTargetRevision !== undefined
        ? ` Run base ${details.runRevision}; GitLab target ${details.gitlabTargetRevision}${
            details.gitlabTargetBranch ? ` (${details.gitlabTargetBranch})` : ""
          }.`
        : details?.runRevision !== undefined
          ? ` Run base ${details.runRevision}.`
          : "";
    const selectedDirectoryEvidence =
      typeof safeDetails?.selectedDirectory === "string" && safeDetails.selectedDirectory.length > 0
        ? ` Selected directory ${safeDetails.selectedDirectory}.`
        : "";
    const limitEvidence =
      typeof details?.limitRefusal === "string" && details.limitRefusal.length > 0
        ? ` ${details.limitRefusal}`
        : "";
    const configurationEvidence = safeDetails?.configuration
      ? ` The setting ${safeDetails.configuration.key} comes from ${safeDetails.configuration.origin}.${
          safeDetails.configuration.reason === "home-not-operator-owned"
            ? " DocsFab does not trust that file for this setting because HOME is not an absolute path outside the checkout."
            : ""
        }`
      : "";
    const advanceEvidence = details?.revision
      ? ` Field ${details.revision.field}${
          details.revision.expected !== undefined ? `: expected ${details.revision.expected}` : ""
        }${details.revision.observed !== undefined ? `; observed ${details.revision.observed}` : ""}.`
      : "";
    super(
      `Local-user GitLab publication preflight failed (${code}). ${action}${revisionEvidence}${selectedDirectoryEvidence}${limitEvidence}${advanceEvidence}${configurationEvidence}`,
    );
    this.name = "LocalUserPublicationPreflightError";
    this.action = action;
    this.details = safeDetails;
  }
}

export interface LocalUserPublicationPlanV1 {
  schemaVersion: 1;
  kind: "docsfab-local-user-gitlab-publication-plan";
  deliveryMode: "local-user";
  /** Durable isolation bar for validation. */
  authorityBasis: AuthorityBasis;
  run: {
    id: string;
    recordSha256: string;
  };
  project: {
    id: number;
    host: string;
    path: string;
  };
  remote: {
    name: string;
    transport: "ssh" | "https";
  };
  identity: {
    git: "configured";
    gitIdentitySha256: string;
    gitlabUsername: string;
  };
  baseRevision: string;
  targetBranch: {
    name: string;
    protected: boolean;
  };
  proposedSourceBranch: string;
  patch: {
    format: "git-diff";
    sha256: string;
    byteLength: number;
    changedFileCount: number;
  };
  validationCommand: string;
  /**
   * Built-in documentation-validation profile selected at preflight when the
   * trusted host omitted `--validation-command`. Explicit host commands stay
   * opaque and omit this field.
   */
  documentationValidation?: DocumentationValidationBindingV1;
  mergeRequest: {
    draft: true;
  };
  fallback: {
    mode: "patch-only";
    preserved: true;
  };
  checks: {
    repository: "passed";
    remote: "passed";
    revision: "current" | "ancestor-of-target";
    gitIdentity: "configured";
    gitlabAuthentication: "authenticated";
    pushAccess: "allowed";
    sourceBranch: "unprotected";
  };
  /** SHA-256 over this exact content-minimized plan with this field omitted. */
  sha256: string;
}

export interface LocalUserPublicationPlanV2
  extends Omit<LocalUserPublicationPlanV1, "schemaVersion" | "documentationValidation"> {
  schemaVersion: 2;
  documentationValidation?: DocumentationValidationBindingV2;
}

/**
 * Typed request to add one commit to a DocsFab-minted draft-MR branch. Every
 * field is an assertion that preflight cross-checks against the stored parent
 * receipt and plan; none of it is trusted as given.
 */
export interface LocalUserPublicationAdvanceV1 {
  kind: "docsfab-local-user-publication-advance";
  parent: {
    runId: string;
    recordSha256: string;
    deliveryReceiptSha256: string;
    idempotencyKey: string;
    planSha256: string;
  };
  mergeRequest: {
    projectId: number;
    iid: number;
  };
  sourceBranch: string;
  /** The head DocsFab last pushed: the parent receipt's pushed revision. */
  lastRecordedHead: string;
  /** The MR head the child run started from; the push lease expects it. */
  observedHead: string;
  /** Position in the revision chain; the root publication is 0. */
  ordinal: number;
}

/** A plan that advances an existing DocsFab-minted branch instead of creating one. */
export interface LocalUserPublicationPlanV3
  extends Omit<LocalUserPublicationPlanV2, "schemaVersion" | "identity" | "checks"> {
  schemaVersion: 3;
  identity: LocalUserPublicationPlanV2["identity"] & {
    /** Recorded for a later tightening; the requester check compares the username. */
    gitlabUserId: number;
  };
  checks: Omit<LocalUserPublicationPlanV2["checks"], "revision"> & {
    revision: "descends-from-recorded-head";
  };
  advance: LocalUserPublicationAdvanceV1;
}

export type LocalUserPublicationPlan =
  | LocalUserPublicationPlanV1
  | LocalUserPublicationPlanV2
  | LocalUserPublicationPlanV3;

/** The advance a plan carries, or undefined for a plan that creates its branch. */
export function localUserPublicationAdvance(
  plan: LocalUserPublicationPlan,
): LocalUserPublicationAdvanceV1 | undefined {
  return plan.schemaVersion === 3 ? plan.advance : undefined;
}

/** Canonical bytes of an advance, for comparing a stored plan with a typed request. */
export function canonicalLocalUserPublicationAdvance(
  advance: LocalUserPublicationAdvanceV1,
): string {
  return canonicalizeJsonEvidence(advance as unknown as JsonEvidenceValue);
}

/** Strictly validate the shape of an advance request; refuses `invalid-input`. */
export function assertLocalUserPublicationAdvance(
  value: unknown,
): asserts value is LocalUserPublicationAdvanceV1 {
  // hygiene: envelope — the catalog row for invalid-input renders the action.
  if (!validAdvance(value)) throw new LocalUserPublicationPreflightError("invalid-input");
}

function validAdvance(value: unknown): value is LocalUserPublicationAdvanceV1 {
  return (
    isRecord(value) &&
    exactKeys(value, [
      "kind",
      "parent",
      "mergeRequest",
      "sourceBranch",
      "lastRecordedHead",
      "observedHead",
      "ordinal",
    ]) &&
    value.kind === "docsfab-local-user-publication-advance" &&
    isRecord(value.parent) &&
    exactKeys(value.parent, [
      "runId",
      "recordSha256",
      "deliveryReceiptSha256",
      "idempotencyKey",
      "planSha256",
    ]) &&
    safeId(value.parent.runId) &&
    sha(value.parent.recordSha256) &&
    sha(value.parent.deliveryReceiptSha256) &&
    sha(value.parent.idempotencyKey) &&
    sha(value.parent.planSha256) &&
    isRecord(value.mergeRequest) &&
    exactKeys(value.mergeRequest, ["projectId", "iid"]) &&
    positiveInteger(value.mergeRequest.projectId) &&
    positiveInteger(value.mergeRequest.iid) &&
    safeBranch(value.sourceBranch) &&
    revision(value.lastRecordedHead) &&
    revision(value.observedHead) &&
    positiveInteger(value.ordinal)
  );
}

/** Prevent an historical plan from authorizing a new mutation. */
export function requireFreshDocumentationPlanForMutation(
  plan: LocalUserPublicationPlan,
  historical: boolean,
  disposition?: "active" | "failed" | "succeeded" | "recovered",
): void {
  assertLocalUserPublicationPlan(plan);
  if (historical && plan.schemaVersion === 1 && disposition !== "succeeded") {
    throw new Error(
      "Stored publication plan version 1 is historical. Run fresh preflight and confirm the new plan before publication.",
    );
  }
}

export interface LocalUserPublicationAuthorizationV1 {
  schemaVersion: 1;
  kind: "docsfab-local-user-gitlab-publication-authorization";
  deliveryMode: "local-user";
  command: "publish";
  decision: "authorized";
  planSha256: string;
}

/**
 * Delivery's issuer token families, each with the scanner rule it reports.
 * Before #1807 any match refused content-free delivery data; now each is a
 * `credential-like-content` finding.
 */
const CREDENTIAL_LIKE_TEXT_RULES: readonly (readonly [RegExp, string])[] = [
  [/\b(?:glpat|gldt|glrt|glptt)-[A-Za-z0-9_-]{12,}\b/u, SECURITY_RULE_IDS.gitlabToken],
  [
    /\bgh[pousr]_[A-Za-z0-9_]{20,}\b|\bgithub_pat_[A-Za-z0-9_]{20,}\b/u,
    SECURITY_RULE_IDS.githubToken,
  ],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/u, SECURITY_RULE_IDS.slackToken],
  [/\bAIza[A-Za-z0-9_-]{20,}\b/u, SECURITY_RULE_IDS.googleApiKey],
  [/\bya29\.[A-Za-z0-9._-]{20,}\b/u, SECURITY_RULE_IDS.googleOauthToken],
  [/\bnvapi-[A-Za-z0-9_-]{20,}\b/u, SECURITY_RULE_IDS.nvidiaApiKey],
  [/\bsk-(?:proj-)?[A-Za-z0-9_-]{12,}\b/u, SECURITY_RULE_IDS.openAiApiKey],
];
/** A URL that carries a user name and password, such as `https://user:password@host`. */
const URL_USERINFO = /https?:\/\/[^\s/@]+:[^\s/@]+@/u;

/**
 * Rule ids that delivery flags in content-free data: its issuer token
 * families, the repository scanner's rules, and a URL with a user name and
 * password.
 */
export function deliveryCredentialRuleIds(value: string): string[] {
  const rules = new Set(detectCredentialRuleIds(value));
  for (const [shape, rule] of CREDENTIAL_LIKE_TEXT_RULES) if (shape.test(value)) rules.add(rule);
  if (URL_USERINFO.test(value)) rules.add(URL_USERINFO_RULE_ID);
  return [...rules].sort();
}

/**
 * Screen content-free delivery data (#1807). True only when it carries one of
 * DocsFab's own configured credentials, matched exactly; the caller refuses
 * with its existing code. Text that only looks like a credential passes, and
 * each rule `deliveryCredentialRuleIds` reports is recorded at `location`.
 */
export function containsConfiguredCredentialText(value: string, location: string): boolean {
  return screenCredentialText(value, location, deliveryCredentialRuleIds) !== null;
}

/**
 * Publication authorization is an ephemeral host capability, not a serializable
 * self-attestation. Durable receipts retain only its safe plan-bound projection.
 */
const issuedLocalUserPublicationAuthorizations = new WeakSet<object>();
const localUserPublicationAuthorizationWindows = new WeakMap<
  object,
  {
    issuedAt: number;
    expiresAt: number;
  }
>();

export function assertLocalUserPublicationAuthorization(
  value: unknown,
  plan: LocalUserPublicationPlan,
): asserts value is LocalUserPublicationAuthorizationV1 {
  assertLocalUserPublicationPlan(plan);
  if (
    !isRecord(value) ||
    !exactKeys(value, [
      "schemaVersion",
      "kind",
      "deliveryMode",
      "command",
      "decision",
      "planSha256",
    ]) ||
    value.schemaVersion !== 1 ||
    value.kind !== "docsfab-local-user-gitlab-publication-authorization" ||
    value.deliveryMode !== "local-user" ||
    value.command !== "publish" ||
    value.decision !== "authorized" ||
    !sha(value.planSha256) ||
    value.planSha256 !== plan.sha256 ||
    !issuedLocalUserPublicationAuthorizations.has(value)
  ) {
    throw new LocalUserPublicationPreflightError("invalid-input");
  }
}

/** Revalidate the process-local authorization window at every mutating boundary. */
export function assertCurrentLocalUserPublicationAuthorization(
  value: unknown,
  plan: LocalUserPublicationPlan,
  currentTime: Date = new Date(),
): asserts value is LocalUserPublicationAuthorizationV1 {
  assertLocalUserPublicationAuthorization(value, plan);
  const window = localUserPublicationAuthorizationWindows.get(value as object);
  const now = currentTime.getTime();
  if (!window || !Number.isFinite(now) || now < window.issuedAt || now >= window.expiresAt) {
    throw new LocalUserPublicationPreflightError("authorization-expired");
  }
}

export function localUserPublicationPlanSha256(
  plan: Omit<LocalUserPublicationPlan, "sha256"> | LocalUserPublicationPlan,
): string {
  const { sha256: _sha256, ...digestible } = plan as LocalUserPublicationPlan;
  return createHash("sha256")
    .update(canonicalizeJsonEvidence(digestible as unknown as JsonEvidenceValue))
    .digest("hex");
}

/**
 * Bind publication to the configured local Git identity without placing the
 * operator's name or email address in the plan or durable delivery receipt.
 */
export function localUserGitIdentitySha256(name: string, email: string): string {
  const { name: normalizedName, email: normalizedEmail } = canonicalLocalUserGitIdentity(
    name,
    email,
  );
  return createHash("sha256")
    .update(
      canonicalizeJsonEvidence({
        email: normalizedEmail,
        name: normalizedName,
      }),
    )
    .digest("hex");
}

export function canonicalLocalUserGitIdentity(
  name: string,
  email: string,
): { name: string; email: string } {
  return Object.freeze({
    name: normalizeGitIdentityPart(name),
    email: normalizeGitIdentityPart(email),
  });
}

/** Strictly validate a persisted plan before it crosses the publication boundary. */
export function assertLocalUserPublicationPlan(
  value: unknown,
): asserts value is LocalUserPublicationPlan {
  if (
    !isRecord(value) ||
    !exactPlanKeys(value) ||
    ![1, 2, 3].includes(value.schemaVersion as number) ||
    value.kind !== "docsfab-local-user-gitlab-publication-plan" ||
    value.deliveryMode !== "local-user" ||
    !["interactive-once", "standing-repo-grant"].includes(value.authorityBasis as string) ||
    !isRecord(value.run) ||
    !exactKeys(value.run, ["id", "recordSha256"]) ||
    !safeId(value.run.id) ||
    !sha(value.run.recordSha256) ||
    !isRecord(value.project) ||
    !exactKeys(value.project, ["id", "host", "path"]) ||
    !positiveInteger(value.project.id) ||
    !safeHost(value.project.host) ||
    !safeProject(value.project.path) ||
    !isRecord(value.remote) ||
    !exactKeys(value.remote, ["name", "transport"]) ||
    !safeId(value.remote.name) ||
    !["ssh", "https"].includes(value.remote.transport as string) ||
    !isRecord(value.identity) ||
    !exactKeys(
      value.identity,
      value.schemaVersion === 3
        ? ["git", "gitIdentitySha256", "gitlabUsername", "gitlabUserId"]
        : ["git", "gitIdentitySha256", "gitlabUsername"],
    ) ||
    (value.schemaVersion === 3 && !positiveInteger(value.identity.gitlabUserId)) ||
    value.identity.git !== "configured" ||
    !sha(value.identity.gitIdentitySha256) ||
    !safeId(value.identity.gitlabUsername) ||
    !revision(value.baseRevision) ||
    !isRecord(value.targetBranch) ||
    !exactKeys(value.targetBranch, ["name", "protected"]) ||
    !safeBranch(value.targetBranch.name) ||
    typeof value.targetBranch.protected !== "boolean" ||
    !safeBranch(value.proposedSourceBranch) ||
    value.proposedSourceBranch === value.targetBranch.name ||
    !isRecord(value.patch) ||
    !exactKeys(value.patch, ["format", "sha256", "byteLength", "changedFileCount"]) ||
    value.patch.format !== "git-diff" ||
    !sha(value.patch.sha256) ||
    !positiveInteger(value.patch.byteLength) ||
    !positiveInteger(value.patch.changedFileCount) ||
    !safeValidation(value.validationCommand) ||
    !validDocumentationValidation(value) ||
    !isRecord(value.mergeRequest) ||
    !exactKeys(value.mergeRequest, ["draft"]) ||
    value.mergeRequest.draft !== true ||
    !isRecord(value.fallback) ||
    !exactKeys(value.fallback, ["mode", "preserved"]) ||
    value.fallback.mode !== "patch-only" ||
    value.fallback.preserved !== true ||
    !isRecord(value.checks) ||
    !exactKeys(value.checks, [
      "repository",
      "remote",
      "revision",
      "gitIdentity",
      "gitlabAuthentication",
      "pushAccess",
      "sourceBranch",
    ]) ||
    value.checks.repository !== "passed" ||
    value.checks.remote !== "passed" ||
    !(value.schemaVersion === 3
      ? value.checks.revision === "descends-from-recorded-head"
      : ["current", "ancestor-of-target"].includes(value.checks.revision as string)) ||
    !validPlanAdvance(value) ||
    value.checks.gitIdentity !== "configured" ||
    value.checks.gitlabAuthentication !== "authenticated" ||
    value.checks.pushAccess !== "allowed" ||
    value.checks.sourceBranch !== "unprotected" ||
    !safeDurablePublicationValue(value) ||
    !sha(value.sha256) ||
    localUserPublicationPlanSha256(value as unknown as LocalUserPublicationPlan) !== value.sha256
  ) {
    throw new LocalUserPublicationPreflightError("invalid-input");
  }
}

export {
  AUTHORITY_BASES,
  DELIVERY_CONTROLLERS,
  DELIVERY_INTENTS,
  DELIVERY_TRIGGERS,
  DeliveryAuthorityError,
  DeliveryKeyLedger,
  EXCLUDED_DELIVERY_POWERS,
  SUPPORTED_DELIVERY_COMBINATIONS,
  assertAllowedDeliveryCombination,
  assertExcludedDeliveryPowerDenied,
  createDeliveryRequest,
  decodeDeliveryRequest,
  deliveryCombinationStatus,
  deliveryKeyForRequest,
  type AuthorityBasis,
  type DeliveryController,
  type DeliveryIntent,
  type DeliveryRequestV1,
  type DeliveryTrigger,
} from "./delivery-authority.js";
export {
  CREDENTIAL_BROKER_IDENTITY_CLASS,
  GRANT_TIER_OPERATIONS,
  INTENT_REQUIRED_OPERATIONS,
  REPOSITORY_GRANT_OPERATIONS,
  REPOSITORY_GRANT_TIERS,
  createCredentialBrokerIdentityClass,
  createRepositoryGrant,
  decodeCredentialBrokerIdentityClass,
  decodeEffectiveAuthority,
  decodeRepositoryGrant,
  intersectEffectiveAuthority,
  mintFreshDeliveryRevalidation,
  scmStateSha256,
  type EffectiveAuthorityV1,
  type RepositoryGrantV1,
} from "./effective-authority.js";

function safeDurablePublicationValue(value: Record<string, unknown>): boolean {
  return !containsConfiguredCredentialText(JSON.stringify(value), "publication-plan");
}

/** Deterministic, collision-resistant default derived only from immutable reviewed identities. */
export function deterministicLocalUserSourceBranch(
  runId: string,
  revision: string,
  recordSha256: string,
  patchSha256: string,
): string {
  if (!safeId(runId) || !revisionPattern(revision) || !sha(recordSha256) || !sha(patchSha256)) {
    throw new LocalUserPublicationPreflightError("invalid-input");
  }
  const safeRun = runId
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/gu, "-")
    .slice(0, 40);
  const suffix = createHash("sha256")
    .update(runId)
    .update("\0")
    .update(revision)
    .update("\0")
    .update(recordSha256)
    .update("\0")
    .update(patchSha256)
    .digest("hex")
    .slice(0, 16);
  return `docsfab-run/${safeRun}-${revision.slice(0, 12)}-${suffix}`;
}

/**
 * Create the affirmative gate consumed by the later mutating publisher.
 * Possession of Git/glab permissions and a successful preflight is insufficient.
 */
export function authorizeLocalUserPublication(input: {
  plan: LocalUserPublicationPlan;
  confirmedPlanSha256: string;
  command: "publish";
  currentTime?: Date;
  expiresAt?: string;
}): LocalUserPublicationAuthorizationV1 {
  let validDigest = false;
  try {
    assertLocalUserPublicationPlan(input.plan);
    validDigest = true;
  } catch {
    validDigest = false;
  }
  if (
    !validDigest ||
    input.command !== "publish" ||
    input.confirmedPlanSha256 !== input.plan.sha256
  ) {
    throw new LocalUserPublicationPreflightError("invalid-input");
  }
  const authorization: LocalUserPublicationAuthorizationV1 = Object.freeze({
    schemaVersion: 1,
    kind: "docsfab-local-user-gitlab-publication-authorization",
    deliveryMode: "local-user",
    command: "publish",
    decision: "authorized",
    planSha256: input.plan.sha256,
  });
  issuedLocalUserPublicationAuthorizations.add(authorization);
  const issuedAt = (input.currentTime ?? new Date()).getTime();
  const requestedExpiry =
    input.expiresAt === undefined ? issuedAt + 15 * 60_000 : Date.parse(input.expiresAt);
  if (
    !Number.isFinite(issuedAt) ||
    !Number.isFinite(requestedExpiry) ||
    requestedExpiry <= issuedAt ||
    requestedExpiry - issuedAt > 60 * 60_000
  ) {
    issuedLocalUserPublicationAuthorizations.delete(authorization);
    throw new LocalUserPublicationPreflightError("invalid-input");
  }
  localUserPublicationAuthorizationWindows.set(authorization, {
    issuedAt,
    expiresAt: requestedExpiry,
  });
  assertLocalUserPublicationAuthorization(authorization, input.plan);
  return authorization;
}

const LOCAL_USER_PUBLICATION_PLAN_KEYS = [
  "schemaVersion",
  "kind",
  "deliveryMode",
  "authorityBasis",
  "run",
  "project",
  "remote",
  "identity",
  "baseRevision",
  "targetBranch",
  "proposedSourceBranch",
  "patch",
  "validationCommand",
  "mergeRequest",
  "fallback",
  "checks",
  "sha256",
] as const;

function exactPlanKeys(value: Record<string, unknown>): boolean {
  const keys: readonly string[] =
    value.schemaVersion === 3
      ? [...LOCAL_USER_PUBLICATION_PLAN_KEYS, "advance"]
      : LOCAL_USER_PUBLICATION_PLAN_KEYS;
  return exactKeys(value, keys) || exactKeys(value, [...keys, "documentationValidation"]);
}

/** A V3 plan's advance must name this plan's own branch, base, and project. */
function validPlanAdvance(value: Record<string, unknown>): boolean {
  if (value.schemaVersion !== 3) return value.advance === undefined;
  return (
    validAdvance(value.advance) &&
    value.advance.sourceBranch === value.proposedSourceBranch &&
    value.advance.observedHead === value.baseRevision &&
    isRecord(value.project) &&
    value.advance.mergeRequest.projectId === value.project.id
  );
}

function validDocumentationValidation(value: Record<string, unknown>): boolean {
  if (value.documentationValidation === undefined) return true;
  try {
    assertDocumentationValidationBinding(value.documentationValidation);
  } catch (error) {
    if (error instanceof DocumentationValidationError) return false;
    throw error;
  }
  const binding = value.documentationValidation as
    | DocumentationValidationBindingV1
    | DocumentationValidationBindingV2;
  // An advance plan carries the version-2 validation binding unchanged.
  const bindingVersion = value.schemaVersion === 3 ? 2 : value.schemaVersion;
  if (bindingVersion !== binding.schemaVersion) return false;
  const resolved = resolveHostDocumentationValidator(binding.profileId, binding.profileVersion);
  return value.validationCommand === resolved.entrypointCommand;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).sort().join("\0") === [...keys].sort().join("\0");
}

function safeId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value);
}

function normalizeGitIdentityPart(value: string): string {
  if (typeof value !== "string") {
    throw new LocalUserPublicationPreflightError("git-identity-missing");
  }
  const normalized = value.trim().normalize("NFC");
  if (
    !normalized ||
    Buffer.byteLength(normalized, "utf8") > 1_024 ||
    /[\0\r\n]/u.test(normalized)
  ) {
    throw new LocalUserPublicationPreflightError("git-identity-missing");
  }
  return normalized;
}

function sha(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function revision(value: unknown): value is string {
  return typeof value === "string" && revisionPattern(value);
}

function revisionPattern(value: string): boolean {
  return /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(value);
}

function safeHost(value: unknown): value is string {
  return isDnsHostname(value, { anyCase: true });
}

function safeProject(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.split("/").length >= 2 &&
    value.split("/").every((part) => /^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(part))
  );
}

function safeBranch(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 200 &&
    value === value.normalize("NFC") &&
    !/[\0-\x20\x7f~^:?*[\\]/u.test(value) &&
    !containsConfiguredCredentialText(value, "publication-plan:branch") &&
    !/(?:[A-Za-z]:\\|\/(?:Users|home|private|tmp)\/)/u.test(value) &&
    !value.startsWith("-") &&
    !value.startsWith("/") &&
    !value.endsWith("/") &&
    !value.endsWith(".") &&
    !value.includes("..") &&
    !value.includes("@{") &&
    !value.includes("//") &&
    !value.split("/").some((part) => !part || part.startsWith(".") || part.endsWith(".lock"))
  );
}

function positiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function nonnegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function safeValidation(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9 ._/:@+,-]{0,199}$/u.test(value) &&
    value.trim() === value &&
    !/\b(?:token|secret|password|credential|bearer)\b/iu.test(value)
  );
}
