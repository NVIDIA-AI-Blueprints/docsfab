// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { redactCredentialMaterial } from "../security/credential-material.js";
import {
  ExternalInputContractError,
  type ExternalInputDisclosurePolicy,
  type ExternalInputHostCapability,
  type ExternalInputRegistrationV1,
  type ExternalInputVisibility,
} from "./contracts.js";
import { getRegisteredExternalInput } from "./access.js";
import type { ExternalInputCitationV1 } from "./citation.js";
import { createInputsDialect, deepFreeze } from "./dialect.js";

function fail(code: ExternalInputContractError["code"]): never {
  throw new ExternalInputContractError(code);
}

const { canonicalDigest, assertInert, rejectCredentials, object, noUnknown, string, enumeration } =
  createInputsDialect(fail);

export const EXTERNAL_INPUT_DISCLOSURE_LEVELS = [
  "opaque-identity",
  "safe-label",
  "permission-aware-link",
  "bounded-excerpt",
  "public-content",
] as const;
export type ExternalInputDisclosureLevel = (typeof EXTERNAL_INPUT_DISCLOSURE_LEVELS)[number];

export const EXTERNAL_INPUT_DISCLOSURE_SURFACES = [
  "prompt",
  "log",
  "run-record",
  "patch",
  "commit-message",
  "mr-description",
  "terminal",
] as const;
export type ExternalInputDisclosureSurface = (typeof EXTERNAL_INPUT_DISCLOSURE_SURFACES)[number];

export interface ExternalInputDisclosureProjectionV1 {
  schemaVersion: 1;
  kind: "docsfab-external-input-disclosure-projection";
  inputIdSha256: string;
  sourceKind: string;
  level: ExternalInputDisclosureLevel;
  surface: ExternalInputDisclosureSurface;
  /** Present only at safe-label and above when policy permits. */
  safeLabel: string | null;
  /** Present only at permission-aware-link and above when policy permits. */
  permissionAwareLink: string | null;
  /** Present only at bounded-excerpt/public-content when policy permits. */
  boundedExcerpt: string | null;
  locatorSha256: string;
  contentDigestPresent: boolean;
  projectionSha256: string;
}

const POLICY_MAX_LEVEL: Record<ExternalInputDisclosurePolicy, ExternalInputDisclosureLevel> = {
  "cite-and-quote": "bounded-excerpt",
  "cite-only": "permission-aware-link",
  "identity-only": "safe-label",
  redacted: "opaque-identity",
  forbidden: "opaque-identity",
};

const SURFACE_MAX_LEVEL: Record<ExternalInputDisclosureSurface, ExternalInputDisclosureLevel> = {
  prompt: "bounded-excerpt",
  log: "safe-label",
  "run-record": "safe-label",
  patch: "opaque-identity",
  "commit-message": "safe-label",
  "mr-description": "permission-aware-link",
  terminal: "safe-label",
};

const LEVEL_RANK: Record<ExternalInputDisclosureLevel, number> = {
  "opaque-identity": 0,
  "safe-label": 1,
  "permission-aware-link": 2,
  "bounded-excerpt": 3,
  "public-content": 4,
};

const EXCERPT_MAX = 240;
const LABEL_MAX = 120;

/**
 * Project an input for a publication or prompt surface without upgrading
 * disclosure beyond host policy. Citation cannot raise this ceiling.
 */
export function projectExternalInputDisclosure(
  capability: ExternalInputHostCapability,
  input: {
    inputId: string;
    surface: ExternalInputDisclosureSurface;
    /** Clamped to the policy, surface, and visibility ceilings. */
    requestedLevel?: ExternalInputDisclosureLevel;
    /** Used for permission-aware links; never persisted raw. */
    canonicalLocator?: string;
    /** Redacted and bounded before emission. */
    excerptCandidate?: string;
    /** Used only to verify identity, never to upgrade policy. */
    citation?: ExternalInputCitationV1;
  },
): ExternalInputDisclosureProjectionV1 {
  assertInert(input);
  requireDisclosureShape(object(input), [
    "inputId",
    "surface",
    "requestedLevel",
    "canonicalLocator",
    "excerptCandidate",
    "citation",
  ]);
  const registration = getRegisteredExternalInput(capability, input.inputId);
  if (input.citation && input.citation.inputId !== registration.inputId) {
    fail("substitution");
  }
  if (input.citation && input.citation.disclosurePolicy !== registration.disclosurePolicy) {
    // Citation cannot claim a more permissive disclosure than registration.
    fail("substitution");
  }
  rejectCredentials({
    safeTitle: registration.safeTitle,
    locator: input.canonicalLocator,
    excerpt: input.excerptCandidate,
  });

  const surface = enumeration(input.surface, EXTERNAL_INPUT_DISCLOSURE_SURFACES);
  const requested =
    input.requestedLevel === undefined
      ? POLICY_MAX_LEVEL[registration.disclosurePolicy]
      : enumeration(input.requestedLevel, EXTERNAL_INPUT_DISCLOSURE_LEVELS);
  const level = clampLevel(
    requested,
    POLICY_MAX_LEVEL[registration.disclosurePolicy],
    SURFACE_MAX_LEVEL[surface],
    visibilityCeiling(registration.visibility),
  );

  const safeLabel =
    LEVEL_RANK[level] >= LEVEL_RANK["safe-label"] ? sanitizeLabel(registration.safeTitle) : null;
  const permissionAwareLink =
    LEVEL_RANK[level] >= LEVEL_RANK["permission-aware-link"]
      ? sanitizePermissionAwareLink(input.canonicalLocator, registration)
      : null;
  const boundedExcerpt =
    LEVEL_RANK[level] >= LEVEL_RANK["bounded-excerpt"]
      ? sanitizeExcerpt(input.excerptCandidate, registration)
      : null;

  return sealProjection({
    inputIdSha256: canonicalDigest(registration.inputId),
    sourceKind: registration.sourceKind,
    level,
    surface,
    safeLabel,
    permissionAwareLink,
    boundedExcerpt,
    locatorSha256: registration.locator.locatorSha256,
    contentDigestPresent: registration.contentDigestSha256 !== null,
  });
}

/** Sanitize free-form metadata that might appear in Git or terminal surfaces. */
export function sanitizeExternalInputMetadata(value: string): string {
  if (typeof value !== "string") fail("invalid-value");
  let text = value.normalize("NFC");
  if (text.includes("\0")) fail("invalid-value");
  rejectCredentials({ metadata: text });
  text = redactCredentialMaterial(text);
  // Neutralize Markdown/HTML structure and provenance-marker injection. The
  // `-ref` lookahead keeps a second pass from appending another suffix.
  text = text
    .replace(/[\r\n\t]+/gu, " ")
    .replace(/[<>[`\]#]/gu, "")
    .replace(/\bdocsfab-(?:publication-)?provenance\b(?!-ref)/giu, "$&-ref")
    .replace(/\s+/gu, " ")
    .trim();
  if (text.length > 512) text = `${text.slice(0, 509)}...`;
  return text;
}

function visibilityCeiling(visibility: ExternalInputVisibility): ExternalInputDisclosureLevel {
  if (visibility === "public") return "public-content";
  if (visibility === "internal") return "bounded-excerpt";
  if (visibility === "restricted") return "permission-aware-link";
  return "safe-label";
}

function clampLevel(
  requested: ExternalInputDisclosureLevel,
  policyMax: ExternalInputDisclosureLevel,
  surfaceMax: ExternalInputDisclosureLevel,
  visibilityMax: ExternalInputDisclosureLevel,
): ExternalInputDisclosureLevel {
  const rank = Math.min(
    LEVEL_RANK[requested],
    LEVEL_RANK[policyMax],
    LEVEL_RANK[surfaceMax],
    LEVEL_RANK[visibilityMax],
  );
  return EXTERNAL_INPUT_DISCLOSURE_LEVELS[rank]!;
}

function sanitizeLabel(value: string): string {
  const cleaned = sanitizeExternalInputMetadata(value);
  if (cleaned.length === 0) return "source";
  return cleaned.length > LABEL_MAX ? `${cleaned.slice(0, LABEL_MAX - 3)}...` : cleaned;
}

function sanitizePermissionAwareLink(
  locator: string | undefined,
  registration: ExternalInputRegistrationV1,
): string | null {
  if (locator === undefined) {
    return `docsfab-input://${registration.sourceKind}/${registration.locator.locatorSha256.slice(0, 12)}`;
  }
  if (
    typeof locator !== "string" ||
    locator !== locator.normalize("NFC") ||
    locator.length === 0 ||
    locator.length > 2_048 ||
    locator.includes("\0")
  ) {
    fail("invalid-value");
  }
  rejectCredentials({ locator });
  // Strip query credentials and fragments that often carry tokens.
  let cleaned = locator.split("#", 1)[0] ?? locator;
  cleaned = cleaned.replace(
    /([?&])(token|access_token|key|password|secret)=[^&]*/giu,
    "$1$2=[REDACTED]",
  );
  cleaned = sanitizeExternalInputMetadata(cleaned);
  return cleaned.length === 0 ? null : cleaned;
}

function sanitizeExcerpt(
  excerpt: string | undefined,
  registration: ExternalInputRegistrationV1,
): string | null {
  if (excerpt === undefined) return null;
  if (registration.disclosurePolicy !== "cite-and-quote") return null;
  if (typeof excerpt !== "string" || excerpt !== excerpt.normalize("NFC") || excerpt.includes("\0"))
    fail("invalid-value");
  rejectCredentials({ excerpt });
  let text = redactCredentialMaterial(excerpt)
    .replace(/[\r\n]+/gu, " ")
    .replace(/[<>]/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
  if (text.length > EXCERPT_MAX) text = `${text.slice(0, EXCERPT_MAX - 3)}...`;
  return text.length === 0 ? null : text;
}

function sealProjection(
  body: Omit<ExternalInputDisclosureProjectionV1, "schemaVersion" | "kind" | "projectionSha256">,
): ExternalInputDisclosureProjectionV1 {
  const envelope = {
    schemaVersion: 1 as const,
    kind: "docsfab-external-input-disclosure-projection" as const,
    ...body,
  };
  return deepFreeze({ ...envelope, projectionSha256: canonicalDigest(envelope) });
}

function requireDisclosureShape(root: Record<string, unknown>, keys: string[]): void {
  noUnknown(root, keys);
  if (!("inputId" in root) || !("surface" in root)) fail("invalid-shape");
}
