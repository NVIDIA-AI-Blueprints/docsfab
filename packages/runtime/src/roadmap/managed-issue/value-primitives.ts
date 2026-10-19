// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  screenCredentialText,
  tokenPrefixRuleIds,
} from "../../security/credential-shape-findings.js";
import { requireValue } from "./inert-data.js";

export const MANAGED_ISSUE_CONVENTION_VERSION = 1 as const;

export const MANAGED_ISSUE_MARKER_NAME = "docsfab-managed-issue" as const;

export const SHA256 = /^[a-f0-9]{64}$/u;

export const REVISION = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;

export const SAFE_REFERENCE = /^[a-z0-9](?:[a-z0-9._:/#-]{0,255})$/u;

export const MAX_TEXT_BYTES = 16_384;

export const MAX_DESCRIPTION_BYTES = 1_048_576;

/**
 * Whether managed-issue text carries DocsFab's own configured credential,
 * matched exactly, which refuses (#1807). An issuer token prefix, such as
 * `glpat-` or `sk-`, only flags: it is recorded as a `credential-like-content`
 * finding at the field's path, and the text continues.
 */
export function carriesConfiguredCredential(value: string, path: string): boolean {
  return (
    screenCredentialText(value, `managed-issue:${path}`, (text) =>
      tokenPrefixRuleIds(text, { ignoreCase: true }),
    ) !== null
  );
}

export function text(value: unknown, path: string, allowEmpty = false): string {
  requireValue(typeof value === "string", "invalid-type", path);
  requireValue(allowEmpty || value.trim().length > 0, "invalid-value", path);
  requireValue(Buffer.byteLength(value, "utf8") <= MAX_TEXT_BYTES, "unsafe-content", path);
  requireValue(!value.includes("\0"), "unsafe-content", path);
  return value;
}

export function descriptionText(value: unknown, path: string): string {
  requireValue(typeof value === "string", "invalid-type", path);
  requireValue(
    Buffer.byteLength(value, "utf8") <= MAX_DESCRIPTION_BYTES && !value.includes("\0"),
    "unsafe-content",
    path,
  );
  return value;
}

export function identifier(value: unknown, path: string): string {
  const candidate = text(value, path);
  requireValue(
    SAFE_REFERENCE.test(candidate) && !carriesConfiguredCredential(candidate, path),
    "invalid-value",
    path,
  );
  return candidate;
}

export function digest(value: unknown, path: string): string {
  requireValue(typeof value === "string" && SHA256.test(value), "invalid-value", path);
  return value;
}

export function revision(value: unknown, path: string): string {
  requireValue(typeof value === "string" && REVISION.test(value), "invalid-value", path);
  return value;
}
