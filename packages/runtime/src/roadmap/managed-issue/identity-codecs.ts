// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { deepFreeze } from "../../contract-kit/freeze.js";
import { roadmapCanonicalJson, roadmapDigest } from "../contracts/decode.js";
import { ManagedIssueContractError, closed, requireValue } from "./inert-data.js";
import {
  MANAGED_ISSUE_CONVENTION_VERSION,
  MANAGED_ISSUE_MARKER_NAME,
  descriptionText,
  digest,
  identifier,
  revision,
} from "./value-primitives.js";
import type {
  ManagedIssueIdentityV1,
  ManagedIssueMarkerV1,
  ManagedIssueStateBindingV1,
} from "../managed-issue.js";

const MARKER_PREFIX = `<!-- ${MANAGED_ISSUE_MARKER_NAME}:`;

const MARKER_PATTERN = /<!--\s*docsfab-managed-issue:[\s\S]*?-->/gu;

export function validateManagedIssueMarker(value: unknown): ManagedIssueMarkerV1 {
  const root = closed(value, "$", [
    "schemaVersion",
    "repositoryKeyDigest",
    "findingFingerprint",
    "identityDigest",
  ]);
  requireValue(
    root.schemaVersion === MANAGED_ISSUE_CONVENTION_VERSION,
    "invalid-value",
    "$.schemaVersion",
  );
  const marker: ManagedIssueMarkerV1 = {
    schemaVersion: MANAGED_ISSUE_CONVENTION_VERSION,
    repositoryKeyDigest: digest(root.repositoryKeyDigest, "$.repositoryKeyDigest"),
    findingFingerprint: digest(root.findingFingerprint, "$.findingFingerprint"),
    identityDigest: digest(root.identityDigest, "$.identityDigest"),
  };
  const { identityDigest: _identityDigest, ...material } = marker;
  requireValue(
    roadmapDigest(material) === marker.identityDigest,
    "digest-mismatch",
    "$.identityDigest",
  );
  return deepFreeze(marker);
}

export function renderManagedIssueMarker(markerValue: ManagedIssueMarkerV1): string {
  const marker = validateManagedIssueMarker(markerValue);
  return `${MARKER_PREFIX}${roadmapCanonicalJson(marker)} -->`;
}

export function assertManagedIssueMarkerMatchesIdentity(
  markerValue: unknown,
  identityValue: ManagedIssueIdentityV1,
): ManagedIssueMarkerV1 {
  const marker = validateManagedIssueMarker(markerValue);
  const expected = validateIdentity(identityValue).marker;
  requireValue(
    marker.repositoryKeyDigest === expected.repositoryKeyDigest,
    "repository-mismatch",
    "$.repositoryKeyDigest",
  );
  requireValue(
    marker.findingFingerprint === expected.findingFingerprint,
    "finding-mismatch",
    "$.findingFingerprint",
  );
  requireValue(
    marker.identityDigest === expected.identityDigest,
    "digest-mismatch",
    "$.identityDigest",
  );
  return marker;
}

export function createManagedIssueStateBinding(
  identityValue: ManagedIssueIdentityV1,
): ManagedIssueStateBindingV1 {
  const identity = validateIdentity(identityValue);
  const material = {
    schemaVersion: MANAGED_ISSUE_CONVENTION_VERSION,
    markerIdentityDigest: identity.marker.identityDigest,
    findingId: identity.findingId,
    ledgerDigest: identity.ledgerDigest,
    repositoryStateDigest: identity.repositoryStateDigest,
    testedRevision: identity.testedRevision,
  };
  return deepFreeze({ ...material, digest: roadmapDigest(material) });
}

export function validateManagedIssueStateBinding(
  value: unknown,
  identityValue?: ManagedIssueIdentityV1,
): ManagedIssueStateBindingV1 {
  const root = closed(value, "$", [
    "schemaVersion",
    "markerIdentityDigest",
    "findingId",
    "ledgerDigest",
    "repositoryStateDigest",
    "testedRevision",
    "digest",
  ]);
  requireValue(
    root.schemaVersion === MANAGED_ISSUE_CONVENTION_VERSION,
    "invalid-value",
    "$.schemaVersion",
  );
  const binding: ManagedIssueStateBindingV1 = {
    schemaVersion: MANAGED_ISSUE_CONVENTION_VERSION,
    markerIdentityDigest: digest(root.markerIdentityDigest, "$.markerIdentityDigest"),
    findingId: identifier(root.findingId, "$.findingId"),
    ledgerDigest: digest(root.ledgerDigest, "$.ledgerDigest"),
    repositoryStateDigest: digest(root.repositoryStateDigest, "$.repositoryStateDigest"),
    testedRevision: revision(root.testedRevision, "$.testedRevision"),
    digest: digest(root.digest, "$.digest"),
  };
  requireValue(roadmapDigest(binding) === binding.digest, "digest-mismatch", "$.digest");
  if (identityValue) {
    const identity = validateIdentity(identityValue);
    requireValue(
      binding.markerIdentityDigest === identity.marker.identityDigest &&
        binding.findingId === identity.findingId,
      "finding-mismatch",
      "$",
    );
    requireValue(
      binding.ledgerDigest === identity.ledgerDigest &&
        binding.repositoryStateDigest === identity.repositoryStateDigest &&
        binding.testedRevision === identity.testedRevision,
      "repository-mismatch",
      "$",
    );
  }
  return deepFreeze(binding);
}

export function extractManagedIssueMarker(description: string): ManagedIssueMarkerV1 | undefined {
  descriptionText(description, "$.description");
  const matches = [...description.matchAll(MARKER_PATTERN)];
  if (matches.length === 0) {
    requireValue(
      !description.includes(MANAGED_ISSUE_MARKER_NAME),
      "unsafe-content",
      "$.description.marker",
    );
    return undefined;
  }
  requireValue(matches.length === 1, "multiple-markers", "$.description");
  const raw = matches[0]![0];
  requireValue(
    raw.startsWith(MARKER_PREFIX) && raw.endsWith(" -->"),
    "unsafe-content",
    "$.description.marker",
  );
  const encoded = raw.slice(MARKER_PREFIX.length, -4);
  let parsed: unknown;
  try {
    parsed = JSON.parse(encoded);
  } catch {
    throw new ManagedIssueContractError("unsafe-content", "$.description.marker");
  }
  const marker = validateManagedIssueMarker(parsed);
  requireValue(renderManagedIssueMarker(marker) === raw, "unsafe-content", "$.description.marker");
  return marker;
}

export function validateIdentity(value: unknown): ManagedIssueIdentityV1 {
  const root = closed(value, "$", [
    "marker",
    "findingId",
    "ledgerDigest",
    "repositoryStateDigest",
    "testedRevision",
  ]);
  return deepFreeze({
    marker: validateManagedIssueMarker(root.marker),
    findingId: identifier(root.findingId, "$.findingId"),
    ledgerDigest: digest(root.ledgerDigest, "$.ledgerDigest"),
    repositoryStateDigest: digest(root.repositoryStateDigest, "$.repositoryStateDigest"),
    testedRevision: revision(root.testedRevision, "$.testedRevision"),
  });
}
