// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { formatLimitObservation, limit, limitDefinition } from "../config/limits.js";
import { repositoryWorkspaceExportLimits } from "../config/repository-discovery-limits.js";
import {
  canonicalDigest,
  createContractKit,
  createHostAuthorityFactory,
  deepFreeze,
  escapePathText,
  UNSAFE_PATH_CODE_POINT,
} from "../contract-kit/index.js";
import {
  containsConfiguredCredential,
  redactConfiguredCredentials,
} from "../security/configured-credentials.js";
import { redactCredentialMaterial } from "../security/credential-material.js";
import { detectCredentialRuleIdsInValue } from "../security/repository-scanner.js";

export const ORIGINAL_SOURCE_AUTHORITY_KIND = "docsfab-original-source-authority" as const;
export const ORIGINAL_SOURCE_AUTHORITY_EVIDENCE_KIND =
  "docsfab-original-source-authority-evidence" as const;

/** A tracked path the member-path rule refuses; the message names the path and the rule. */
export const SOURCE_AUTHORITY_PATH_REFUSED = "source-authority-path-refused" as const;
/** Evidence, a binding, or a request that breaks the authority's own contract. */
export const INVALID_ORIGINAL_SOURCE_AUTHORITY = "invalid-original-source-authority" as const;

/** Same text as the `source-authority-path-refused` situation catalog row. */
export const SOURCE_AUTHORITY_PATH_REFUSED_NEXT_ACTION =
  "Rename the tracked file or directory the message names so its path follows the named rule, or stop tracking it, then commit the change and rerun the same command.";
/** Same text as the `invalid-original-source-authority` situation catalog row. */
export const INVALID_ORIGINAL_SOURCE_AUTHORITY_NEXT_ACTION =
  "Start a new run from the current checkout; do not edit or reuse the refused run evidence. If a new run stops with the same rule, report the run id and the rule to DocsFab maintainers.";

/** Every refusal this module raises: a catalogued code and the rule that refused. */
export class OriginalSourceAuthorityError extends Error {
  public readonly code: string;
  public readonly nextAction: string;

  public constructor(code: string, message: string, nextAction: string) {
    super(message);
    this.name = "OriginalSourceAuthorityError";
    this.code = code;
    this.nextAction = nextAction;
  }
}

const HASH = /^[a-f0-9]{64}$/u;
const REVISION = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u;
/**
 * The tracked-tree ceilings an authority's members answer to: the workspace
 * export's own, host overrides included, so every exported tree validates.
 */
function memberBounds(): { readonly maxMembers: number; readonly maxBytes: number } {
  const exportLimits = repositoryWorkspaceExportLimits();
  return {
    maxMembers: exportLimits.maxTreeEntries.value,
    maxBytes: exportLimits.maxAggregateBytes.value,
  };
}
// Sealed, so durable evidence validates the same way on every host.
const MEMBER_PATH_MAX_CHARS = limitDefinition("sources.authorityMemberPathMaxChars");
// A whole-segment brace placeholder such as "{name}" in a templated tracked
// path; any other brace use in a segment fails closed.
const MEMBER_PATH_PLACEHOLDER_SEGMENT = /^\{[A-Za-z0-9_]+\}$/u;

export type OriginalSourceAuthorityScope = "create-plan-sources" | "review-tracked-workspace";

export interface OriginalSourceAuthorityDescriptorV1 {
  readonly kind: typeof ORIGINAL_SOURCE_AUTHORITY_KIND;
  readonly schemaVersion: 1;
  readonly scope: OriginalSourceAuthorityScope;
  readonly repositoryRevision: string;
  readonly scopeSha256: string;
  readonly workspaceSnapshotSha256: string;
  readonly memberCount: number;
  readonly membersSha256: string;
  readonly digest: string;
}

export interface OriginalSourceAuthorityMemberV1 {
  readonly path: string;
  readonly mode: number;
  readonly byteLength: number;
  readonly sourceSha256: string;
}

export interface OriginalSourceAuthorityEvidenceV1 {
  readonly kind: typeof ORIGINAL_SOURCE_AUTHORITY_EVIDENCE_KIND;
  readonly schemaVersion: 1;
  readonly descriptor: OriginalSourceAuthorityDescriptorV1;
  readonly members: readonly OriginalSourceAuthorityMemberV1[];
  readonly digest: string;
}

export interface SourceAuthorityProposalV1 {
  readonly path: string;
  readonly reason: string;
}

export function validateSourceAuthorityProposalV1(value: unknown): SourceAuthorityProposalV1 {
  kit.assertInert(value);
  kit.rejectCredentials(value);
  const proposal = kit.object(value);
  kit.exact(proposal, ["path", "reason"]);
  const path = validateMemberPath(proposal.path);
  const reason = kit.string(proposal.reason);
  if (
    reason.length < limit("factInventory.minDimensionReasonChars").value ||
    reason.length > limit("factInventory.maxDimensionReasonChars").value ||
    reason !== reason.trim() ||
    /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(reason)
  ) {
    return fail("proposal-reason-bound");
  }
  return deepFreeze({ path, reason });
}

export type SourceAuthorityProposalRefusalCodeV1 =
  | "source-untracked"
  | "source-not-regular"
  | "write-target-source"
  | "sources-create-added-authority-sources-max";

export interface SourceAuthorityProposalAdmissionV1 {
  readonly schemaVersion: 1;
  readonly kind: "docsfab-source-proposal-admission";
  readonly attempt: number;
  readonly path: string;
  readonly reason: string;
  readonly status: "admitted" | "refused";
  readonly refusalCode?: SourceAuthorityProposalRefusalCodeV1;
}

export interface SourceAuthorityTrackedEntryV1 {
  readonly path: string;
  readonly kind: string;
  readonly mode: number | null;
  readonly byteLength: number | null;
  readonly sha256: string | null;
}

export function validateSourceAuthorityProposalAdmissionV1(
  value: unknown,
): SourceAuthorityProposalAdmissionV1 {
  kit.assertInert(value);
  kit.rejectCredentials(value);
  const root = kit.object(value);
  const baseKeys = ["schemaVersion", "kind", "attempt", "path", "reason", "status"];
  const keys = root.status === "refused" ? [...baseKeys, "refusalCode"] : baseKeys;
  kit.exact(root, keys);
  const path = validateMemberPath(root.path);
  const reason = kit.string(root.reason);
  if (
    reason.length < limit("factInventory.minDimensionReasonChars").value ||
    reason.length > limit("factInventory.maxDimensionReasonChars").value ||
    reason !== reason.trim() ||
    /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(reason)
  ) {
    return fail("proposal-reason-bound");
  }
  if (
    root.schemaVersion !== 1 ||
    root.kind !== "docsfab-source-proposal-admission" ||
    !Number.isSafeInteger(root.attempt) ||
    (root.attempt as number) < 1 ||
    (root.status !== "admitted" && root.status !== "refused")
  ) {
    return fail("proposal-receipt-shape");
  }
  if (root.status === "admitted") {
    return deepFreeze({
      schemaVersion: 1,
      kind: "docsfab-source-proposal-admission",
      attempt: root.attempt as number,
      path,
      reason,
      status: "admitted",
    });
  }
  const refusalCode = root.refusalCode;
  if (
    refusalCode !== "source-untracked" &&
    refusalCode !== "source-not-regular" &&
    refusalCode !== "write-target-source" &&
    refusalCode !== "sources-create-added-authority-sources-max"
  ) {
    return fail("proposal-refusal-code");
  }
  return deepFreeze({
    schemaVersion: 1,
    kind: "docsfab-source-proposal-admission",
    attempt: root.attempt as number,
    path,
    reason,
    status: "refused",
    refusalCode,
  });
}

export interface OriginalSourceAuthorityCapture {
  readonly kind: "docsfab-original-source-authority-capture";
}

export interface OriginalSourceAuthorityAdmission {
  readonly kind: "docsfab-original-source-authority-admission";
}

export interface OriginalSourceAuthoritySourceObserver {
  observe(paths: readonly string[]): Promise<readonly { path: string; sha256: string }[]>;
}

export interface OriginalSourceAuthorityCheckV1 {
  readonly path: string;
  readonly sourceSha256: string;
}

interface OriginalSourceAuthorityBinding {
  readonly runId: string;
  readonly repositoryRevision: string;
  readonly scopeSha256: string;
  readonly workspaceSnapshotSha256: string;
}

interface CaptureState extends OriginalSourceAuthorityBinding {
  readonly evidence: OriginalSourceAuthorityEvidenceV1;
  readonly membersByPath: ReadonlyMap<string, OriginalSourceAuthorityMemberV1>;
}

interface CaptureVerifier {
  verifyCurrent(binding: OriginalSourceAuthorityBinding): void;
  boundState(): CaptureState;
}

interface AdmissionVerifier {
  preflight(input: { runId: string; descriptor: OriginalSourceAuthorityDescriptorV1 }): void;
  verifyCurrent(input: {
    runId: string;
    descriptor: OriginalSourceAuthorityDescriptorV1;
    paths: readonly string[];
  }): Promise<{
    originalSourceAuthoritySha256: string;
    sourceChecks: readonly OriginalSourceAuthorityCheckV1[];
  }>;
}

// The kit's codes name the refused rule; the thrown code is always
// INVALID_ORIGINAL_SOURCE_AUTHORITY.
const kit = createContractKit({
  fail: (rule) => fail(rule),
  inertMode: "strict",
  codes: {
    invalidShape: "shape",
    invalidValue: "value",
    digestMismatch: "digest",
    credentialMaterial: "credential-material",
    schemaMismatch: "schema",
  },
});

const captureAuthorities = createHostAuthorityFactory<
  OriginalSourceAuthorityCapture["kind"],
  CaptureVerifier
>({
  kind: "docsfab-original-source-authority-capture",
  invalidMessage: "Original source authority capture verifier is invalid.",
});

const admissionAuthorities = createHostAuthorityFactory<
  OriginalSourceAuthorityAdmission["kind"],
  AdmissionVerifier
>({
  kind: "docsfab-original-source-authority-admission",
  invalidMessage: "Original source authority admission verifier is invalid.",
});

function fail(rule: string): never {
  return refuse(
    INVALID_ORIGINAL_SOURCE_AUTHORITY,
    `Original source authority evidence did not satisfy the host-owned contract: ${rule}.`,
    INVALID_ORIGINAL_SOURCE_AUTHORITY_NEXT_ACTION,
  );
}

function refusePath(path: string, rule: string): never {
  return refuse(
    SOURCE_AUTHORITY_PATH_REFUSED,
    `Tracked path ${displayPath(path)} cannot enter the original source authority: ${rule}. Rename it or stop tracking it, commit the change, and rerun the same command.`,
    SOURCE_AUTHORITY_PATH_REFUSED_NEXT_ACTION,
  );
}

function refuse(code: string, message: string, nextAction: string): never {
  // hygiene: envelope - the coded error carries its own next action to the operator boundary.
  throw new OriginalSourceAuthorityError(code, message, nextAction);
}

/**
 * The path as operator text: quoted, with each unsafe code point escaped, any
 * configured credential and credential-shaped text redacted. A path the scanner
 * still flags is withheld; display redaction stays strict.
 */
function displayPath(path: string): string {
  const escaped = escapePathText(path);
  const shown = `"${redactCredentialMaterial(redactConfiguredCredentials(escaped))}"`;
  return detectCredentialRuleIdsInValue(shown).length > 0 ? "[REDACTED]" : shown;
}

export function sealOriginalSourceAuthority(input: {
  runId: string;
  scope: OriginalSourceAuthorityScope;
  repositoryRevision: string;
  scopeSha256: string;
  workspaceSnapshotSha256: string;
  members: readonly OriginalSourceAuthorityMemberV1[];
}): {
  capture: OriginalSourceAuthorityCapture;
  evidence: OriginalSourceAuthorityEvidenceV1;
} {
  const members = validateMembers(input.members);
  const descriptorContent = {
    kind: ORIGINAL_SOURCE_AUTHORITY_KIND,
    schemaVersion: 1 as const,
    scope: validateScope(input.scope),
    repositoryRevision: validateRevision(input.repositoryRevision),
    scopeSha256: validateHash(input.scopeSha256),
    workspaceSnapshotSha256: validateHash(input.workspaceSnapshotSha256),
    memberCount: members.length,
    membersSha256: canonicalDigest(members),
  };
  const descriptor = deepFreeze({
    ...descriptorContent,
    digest: canonicalDigest(descriptorContent),
  });
  const evidenceContent = {
    kind: ORIGINAL_SOURCE_AUTHORITY_EVIDENCE_KIND,
    schemaVersion: 1 as const,
    descriptor,
    members,
  };
  const evidence = deepFreeze({ ...evidenceContent, digest: canonicalDigest(evidenceContent) });
  const binding: OriginalSourceAuthorityBinding = {
    runId: validateRunId(input.runId),
    repositoryRevision: descriptor.repositoryRevision,
    scopeSha256: descriptor.scopeSha256,
    workspaceSnapshotSha256: descriptor.workspaceSnapshotSha256,
  };
  const state: CaptureState = {
    ...binding,
    evidence,
    membersByPath: new Map(members.map((member) => [member.path, member])),
  };
  const verifier: CaptureVerifier = {
    verifyCurrent(candidate): void {
      if (!sameBinding(binding, candidate)) fail("capture-binding");
    },
    boundState(): CaptureState {
      return state;
    },
  };
  return { capture: captureAuthorities.create(verifier), evidence };
}

/**
 * Admit text or records-path source proposals through the same host authority
 * decision. The caller supplies only metadata observed from the run's tracked
 * repository snapshot; model fields never supply member mode, length, or hash.
 */
export function admitOriginalSourceAuthorityProposals(input: {
  runId: string;
  authority: OriginalSourceAuthorityEvidenceV1;
  originalPaths: readonly string[];
  writePaths: readonly string[];
  trackedEntries: readonly SourceAuthorityTrackedEntryV1[];
  proposals: readonly SourceAuthorityProposalV1[];
  attempt: number;
}): {
  readonly capture?: OriginalSourceAuthorityCapture;
  readonly evidence: OriginalSourceAuthorityEvidenceV1;
  readonly admissions: readonly SourceAuthorityProposalAdmissionV1[];
} {
  const authority = validateOriginalSourceAuthorityEvidence(input.authority, {
    scope: "create-plan-sources",
  });
  if (!Number.isSafeInteger(input.attempt) || input.attempt < 1) return fail("proposal-attempt");
  const originalPaths = new Set(input.originalPaths.map(validateMemberPath));
  const writePaths = new Set(input.writePaths.map(validateMemberPath));
  const tracked = new Map(input.trackedEntries.map((entry) => [entry.path, entry]));
  const currentMembers = new Map(authority.members.map((member) => [member.path, member]));
  const additions = authority.members.filter((member) => !originalPaths.has(member.path));
  const maxAdded = limit("sources.createAddedAuthoritySourcesMax");
  if (input.proposals.length > maxAdded.value) return fail("proposal-count");
  const validatedProposals = input.proposals.map(validateSourceAuthorityProposalV1);
  if (new Set(validatedProposals.map(({ path }) => path)).size !== validatedProposals.length) {
    return fail("proposal-duplicate");
  }
  let admittedAdditionCount = additions.length;
  const newMembers: OriginalSourceAuthorityMemberV1[] = [];
  const admissions: SourceAuthorityProposalAdmissionV1[] = [];

  for (const proposal of validatedProposals) {
    const path = proposal.path;
    const base = {
      schemaVersion: 1 as const,
      kind: "docsfab-source-proposal-admission" as const,
      attempt: input.attempt,
      path,
      reason: proposal.reason,
    };
    const refuse = (refusalCode: SourceAuthorityProposalRefusalCodeV1): void => {
      admissions.push(Object.freeze({ ...base, status: "refused", refusalCode }));
    };

    if (writePaths.has(path)) {
      refuse("write-target-source");
      continue;
    }
    if (currentMembers.has(path)) {
      admissions.push(Object.freeze({ ...base, status: "admitted" }));
      continue;
    }
    const entry = tracked.get(path);
    if (!entry) {
      refuse("source-untracked");
      continue;
    }
    if (
      entry.kind !== "regular" ||
      entry.mode === null ||
      entry.byteLength === null ||
      entry.sha256 === null
    ) {
      refuse("source-not-regular");
      continue;
    }
    if (admittedAdditionCount >= maxAdded.value) {
      refuse(maxAdded.refusal as SourceAuthorityProposalRefusalCodeV1);
      continue;
    }
    newMembers.push({
      path,
      mode: entry.mode,
      byteLength: entry.byteLength,
      sourceSha256: validateHash(entry.sha256),
    });
    admittedAdditionCount += 1;
    admissions.push(Object.freeze({ ...base, status: "admitted" }));
  }

  if (newMembers.length === 0) {
    return Object.freeze({ evidence: authority, admissions: Object.freeze(admissions) });
  }
  const sealed = sealOriginalSourceAuthority({
    runId: input.runId,
    scope: authority.descriptor.scope,
    repositoryRevision: authority.descriptor.repositoryRevision,
    scopeSha256: authority.descriptor.scopeSha256,
    workspaceSnapshotSha256: authority.descriptor.workspaceSnapshotSha256,
    members: [...authority.members, ...newMembers].sort((left, right) =>
      left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
    ),
  });
  return Object.freeze({
    capture: sealed.capture,
    evidence: sealed.evidence,
    admissions: Object.freeze(admissions),
  });
}

export function issueOriginalSourceAuthorityAdmission(input: {
  capture: OriginalSourceAuthorityCapture;
  observer: OriginalSourceAuthoritySourceObserver;
  runId: string;
  repositoryRevision: string;
  scopeSha256: string;
  workspaceSnapshotSha256: string;
}): OriginalSourceAuthorityAdmission {
  const capture = captureAuthorities.lookup(input.capture);
  if (!capture) return fail("capture-authority");
  const binding = {
    runId: validateRunId(input.runId),
    repositoryRevision: validateRevision(input.repositoryRevision),
    scopeSha256: validateHash(input.scopeSha256),
    workspaceSnapshotSha256: validateHash(input.workspaceSnapshotSha256),
  };
  capture.verifyCurrent(binding);
  const state = capture.boundState();
  return admissionAuthorities.create({
    preflight(candidate): void {
      capture.verifyCurrent(binding);
      if (candidate.runId !== binding.runId) return fail("admission-run");
      const descriptor = validateOriginalSourceAuthorityDescriptor(candidate.descriptor);
      if (canonicalDigest(descriptor) !== canonicalDigest(state.evidence.descriptor)) {
        return fail("admission-descriptor");
      }
    },
    async verifyCurrent(candidate) {
      this.preflight(candidate);
      const paths = validateAuthorityPaths(candidate.paths);
      if (paths.some((path) => !state.membersByPath.has(path))) return fail("admission-member");
      if (paths.length === 0) {
        return {
          originalSourceAuthoritySha256: state.evidence.digest,
          sourceChecks: Object.freeze([]),
        };
      }
      const observations = await input.observer.observe(paths);
      if (observations.length !== paths.length) return fail("observation-count");
      const checks = observations.map((observation, index) => {
        const path = paths[index];
        const member = path ? state.membersByPath.get(path) : undefined;
        if (!path || observation.path !== path || observation.sha256 !== member?.sourceSha256) {
          return fail("observation-source");
        }
        return { path, sourceSha256: observation.sha256 };
      });
      return {
        originalSourceAuthoritySha256: state.evidence.digest,
        sourceChecks: deepFreeze(checks),
      };
    },
  });
}

export function assertOriginalSourceAuthorityAdmission(
  authority: OriginalSourceAuthorityAdmission,
  input: { runId: string; descriptor: OriginalSourceAuthorityDescriptorV1 },
): void {
  const verifier = admissionAuthorities.lookup(authority);
  if (!verifier) return fail("admission-authority");
  verifier.preflight(input);
}

export async function admitOriginalSourceAuthorityChecks(
  authority: OriginalSourceAuthorityAdmission,
  input: {
    runId: string;
    descriptor: OriginalSourceAuthorityDescriptorV1;
    paths: readonly string[];
  },
): Promise<{
  originalSourceAuthoritySha256: string;
  sourceChecks: readonly OriginalSourceAuthorityCheckV1[];
}> {
  const verifier = admissionAuthorities.lookup(authority);
  if (!verifier) return fail("admission-authority");
  return verifier.verifyCurrent(input);
}

export function validateOriginalSourceAuthorityEvidence(
  value: unknown,
  expected?: Partial<
    Pick<
      OriginalSourceAuthorityDescriptorV1,
      "scope" | "repositoryRevision" | "scopeSha256" | "workspaceSnapshotSha256"
    >
  >,
): OriginalSourceAuthorityEvidenceV1 {
  const root = kit.object(value);
  kit.exact(root, ["kind", "schemaVersion", "descriptor", "members", "digest"]);
  if (root.kind !== ORIGINAL_SOURCE_AUTHORITY_EVIDENCE_KIND || root.schemaVersion !== 1) {
    return fail("evidence-kind");
  }
  const descriptor = validateOriginalSourceAuthorityDescriptor(root.descriptor);
  const members = validateMembers(kit.array(root.members) as OriginalSourceAuthorityMemberV1[]);
  if (
    descriptor.memberCount !== members.length ||
    descriptor.membersSha256 !== canonicalDigest(members) ||
    (expected?.scope !== undefined && descriptor.scope !== expected.scope) ||
    (expected?.repositoryRevision !== undefined &&
      descriptor.repositoryRevision !== expected.repositoryRevision) ||
    (expected?.scopeSha256 !== undefined && descriptor.scopeSha256 !== expected.scopeSha256) ||
    (expected?.workspaceSnapshotSha256 !== undefined &&
      descriptor.workspaceSnapshotSha256 !== expected.workspaceSnapshotSha256)
  ) {
    return fail("evidence-binding");
  }
  const content = {
    kind: ORIGINAL_SOURCE_AUTHORITY_EVIDENCE_KIND,
    schemaVersion: 1 as const,
    descriptor,
    members,
  };
  if (root.digest !== canonicalDigest(content)) return fail("evidence-digest");
  return deepFreeze({ ...content, digest: root.digest as string });
}

export function validateOriginalSourceAuthorityDescriptor(
  value: unknown,
): OriginalSourceAuthorityDescriptorV1 {
  kit.assertInert(value);
  kit.rejectCredentials(value);
  const root = kit.object(value);
  kit.exact(root, [
    "kind",
    "schemaVersion",
    "scope",
    "repositoryRevision",
    "scopeSha256",
    "workspaceSnapshotSha256",
    "memberCount",
    "membersSha256",
    "digest",
  ]);
  if (root.kind !== ORIGINAL_SOURCE_AUTHORITY_KIND || root.schemaVersion !== 1) {
    return fail("descriptor-kind");
  }
  const content = {
    kind: ORIGINAL_SOURCE_AUTHORITY_KIND,
    schemaVersion: 1 as const,
    scope: validateScope(root.scope),
    repositoryRevision: validateRevision(root.repositoryRevision),
    scopeSha256: validateHash(root.scopeSha256),
    workspaceSnapshotSha256: validateHash(root.workspaceSnapshotSha256),
    memberCount: validateMemberCount(root.memberCount),
    membersSha256: validateHash(root.membersSha256),
  };
  if (root.digest !== canonicalDigest(content)) return fail("descriptor-digest");
  return deepFreeze({ ...content, digest: root.digest as string });
}

export function originalSourceAuthorityMemberMap(
  evidence: OriginalSourceAuthorityEvidenceV1,
): ReadonlyMap<string, OriginalSourceAuthorityMemberV1> {
  const validated = validateOriginalSourceAuthorityEvidence(evidence);
  return new Map(validated.members.map((member) => [member.path, member]));
}

function validateMembers(value: readonly OriginalSourceAuthorityMemberV1[]) {
  const { maxMembers, maxBytes } = memberBounds();
  const rawMembers = kit.array(value);
  if (rawMembers.length === 0 || rawMembers.length > maxMembers) return fail("member-count");
  let totalBytes = 0;
  const members = rawMembers.map((raw) => {
    kit.assertInert(raw);
    const member = kit.object(raw);
    kit.exact(member, ["path", "mode", "byteLength", "sourceSha256"]);
    // The path first, so a credential-shaped name is a named, redacted path refusal.
    const path = validateMemberPath(member.path);
    kit.rejectCredentials(raw);
    const mode = boundedInteger(member.mode, 0, 0o777);
    const byteLength = boundedInteger(member.byteLength, 0, maxBytes);
    totalBytes += byteLength;
    return { path, mode, byteLength, sourceSha256: validateHash(member.sourceSha256) };
  });
  if (totalBytes > maxBytes) {
    return fail("member-bytes");
  }
  const sorted = [...members].sort((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
  );
  if (
    new Set(members.map((member) => member.path)).size !== members.length ||
    sorted.some((member, index) => member.path !== members[index]?.path)
  ) {
    return fail("member-order");
  }
  return deepFreeze(sorted);
}

function validateAuthorityPaths(value: readonly string[]): string[] {
  const rawPaths = kit.array(value);
  if (rawPaths.length > memberBounds().maxMembers) return fail("path-count");
  const paths = rawPaths.map(validateMemberPath);
  const sorted = [...paths].sort();
  if (new Set(paths).size !== paths.length || paths.some((path, index) => path !== sorted[index])) {
    return fail("path-order");
  }
  return paths;
}

/**
 * Members name literal tracked files. The authority compares, sorts, and
 * digests them as exact strings and never parses them as citations, URLs,
 * globs, or shell words, so the rule refuses only what breaks path identity,
 * containment, or safe display. Internal spaces are kept as they are.
 */
function validateMemberPath(value: unknown): string {
  if (typeof value !== "string") return fail("value");
  if (value.length > MEMBER_PATH_MAX_CHARS.value) {
    return refuse(
      MEMBER_PATH_MAX_CHARS.refusal,
      `Tracked path ${displayPath(value)} cannot enter the original source authority: ${formatLimitObservation(MEMBER_PATH_MAX_CHARS, value.length)}`,
      MEMBER_PATH_MAX_CHARS.remediation,
    );
  }
  const rule = memberPathRule(value);
  if (rule !== undefined) return refusePath(value, rule);
  return kit.string(value);
}

function memberPathRule(path: string): string | undefined {
  if (!path) return "it is empty";
  if (UNSAFE_PATH_CODE_POINT.test(path)) {
    return "it contains a control, format, or line-separator character";
  }
  if (path !== path.normalize("NFC")) return "it is not in Unicode normalization form C";
  if (path.includes("\\")) return "it contains a backslash";
  if (path.includes(":")) {
    return "it contains a colon, which reads as a drive letter, URL scheme, or line citation";
  }
  if (path.startsWith("/")) return "it is absolute";
  if (path.startsWith("~")) return "it starts with ~, which reads as a home directory";
  if (path.startsWith("-")) return "it starts with -, which reads as a command option";
  for (const segment of path.split("/")) {
    if (!segment) return "it has an empty segment";
    if (segment === "." || segment === "..") return "it has a . or .. segment";
    if (segment.trim() !== segment) return "a segment starts or ends with whitespace";
    if (
      (segment.includes("{") || segment.includes("}")) &&
      !MEMBER_PATH_PLACEHOLDER_SEGMENT.test(segment)
    ) {
      return "it uses { or } outside a whole-segment {name} placeholder";
    }
  }
  // Only a configured credential refuses a path (#1807); a credential-shaped
  // name is redacted in operator text but still names a member.
  if (containsConfiguredCredential(path)) return "it holds a configured credential";
  return undefined;
}

function validateScope(value: unknown): OriginalSourceAuthorityScope {
  if (value !== "create-plan-sources" && value !== "review-tracked-workspace") return fail("scope");
  return value;
}

function validateRevision(value: unknown): string {
  const revision = kit.string(value);
  if (!REVISION.test(revision)) return fail("revision");
  return revision;
}

function validateHash(value: unknown): string {
  const hash = kit.string(value);
  if (!HASH.test(hash)) return fail("digest-format");
  return hash;
}

function validateMemberCount(value: unknown): number {
  return boundedInteger(value, 1, memberBounds().maxMembers);
}

function boundedInteger(value: unknown, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) {
    return fail("integer-range");
  }
  return value as number;
}

function validateRunId(value: unknown): string {
  const runId = kit.string(value);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(runId)) return fail("run-id");
  return runId;
}

function sameBinding(
  left: OriginalSourceAuthorityBinding,
  right: OriginalSourceAuthorityBinding,
): boolean {
  return (
    left.runId === right.runId &&
    left.repositoryRevision === right.repositoryRevision &&
    left.scopeSha256 === right.scopeSha256 &&
    left.workspaceSnapshotSha256 === right.workspaceSnapshotSha256
  );
}
