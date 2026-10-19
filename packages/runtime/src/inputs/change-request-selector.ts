// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Parse half of the `--pr` input: turns operator text into a provider-neutral
 * change-request reference. It opens no transport, resolves no identity, and
 * grants nothing; resolution happens at the provider boundary.
 *
 * Accepted forms: a full URL, `host/group/project!123`, and `!123` or `123`
 * for this checkout's project. The first two may name another project; the
 * checkout's remote never silently replaces a host the operator typed, or
 * evidence from one project could be sealed under another's identity.
 */

/** Forges this selector can name. */
export const CHANGE_REQUEST_PROVIDERS = ["gitlab"] as const;

export type ChangeRequestProviderV1 = (typeof CHANGE_REQUEST_PROVIDERS)[number];

/**
 * One operator-named change basis, before any identity resolution.
 *
 * `host` and `projectPath` are null exactly for the bare number form; the
 * caller resolves them from its checkout. The record never carries the
 * operator's original text: refusals must not echo unvalidated input, and the
 * admitted request is digested, so extra URL text would split one merge
 * request into several run identities.
 */
export interface ChangeRequestSelectorV1 {
  readonly schemaVersion: 1;
  readonly kind: "docsfab-change-request-selector";
  readonly provider: ChangeRequestProviderV1;
  readonly host: string | null;
  readonly projectPath: string | null;
  /** Project-local change number: a GitLab MR iid, a GitHub PR number. */
  readonly number: number;
}

export const CHANGE_REQUEST_SELECTOR_REFUSAL_CODES = [
  "empty-selector",
  "selector-too-long",
  "unsupported-provider",
  "malformed-selector",
  "invalid-change-number",
  "invalid-project-path",
  "invalid-host",
  "ambiguous-reference",
  "checkout-project-unavailable",
  "selector-option-typo",
] as const;

export type ChangeRequestSelectorRefusalCode =
  (typeof CHANGE_REQUEST_SELECTOR_REFUSAL_CODES)[number];

/**
 * The failing condition, then the action. None interpolate operator text, so a
 * malformed value cannot smuggle bytes into a logged message.
 */
const SELECTOR_REMEDIATION: Readonly<Record<ChangeRequestSelectorRefusalCode, string>> =
  Object.freeze({
    "empty-selector":
      "The change-request selector was empty. Pass a merge-request URL, a host/group/project!number reference, or just the number to use this checkout's project.",
    "selector-too-long":
      "The change-request selector is longer than this input accepts. Pass the merge-request URL or a host/group/project!number reference instead of a longer value.",
    "unsupported-provider":
      "The change-request selector names a forge DocsFab cannot read yet. Pass a GitLab merge-request reference, which is the provider this release acquires.",
    "malformed-selector":
      "The change-request selector is not a merge-request URL, a host/group/project!number reference, or a bare number. Copy the merge request's URL from the browser, or write host/group/project!number, then run again.",
    "invalid-change-number":
      "The change-request selector does not carry a positive whole merge-request number. Use the project-local number GitLab shows after the exclamation mark, such as 813, then run again.",
    "invalid-project-path":
      "The change-request selector does not carry a usable project path. Use the group and project exactly as they appear in the merge request's URL, then run again.",
    "invalid-host":
      "The change-request selector does not carry a usable forge host. Use the host exactly as it appears in the merge request's URL, with no user name, port-only value or trailing path, then run again.",
    "ambiguous-reference":
      "The change-request selector looks like a project path with no forge host, so its first segment would have been read as a host name. Write host/group/project!number with the forge host first, or pass the merge request's URL, or pass the number alone to use this checkout's project.",
    "selector-option-typo":
      "An option starting with --pr or --mr was passed in a form this command does not accept, so it would otherwise have been ignored and the run left ungrounded. Write --pr <reference>, --mr <reference>, --pr=<reference> or --mr=<reference>, then run again.",
    "checkout-project-unavailable":
      "A bare merge-request number means the project this checkout points at, and this checkout has no supported GitLab remote to resolve. Pass the merge request's URL or a host/group/project!number reference, or run from a checkout whose origin is the GitLab project you mean.",
  });

export class ChangeRequestSelectorError extends Error {
  public constructor(public readonly code: ChangeRequestSelectorRefusalCode) {
    super(SELECTOR_REMEDIATION[code]);
    this.name = "ChangeRequestSelectorError";
  }
}

export function changeRequestSelectorRefusalMessage(
  code: ChangeRequestSelectorRefusalCode,
): string {
  return SELECTOR_REMEDIATION[code];
}

/**
 * Every layer that can stop a `--pr` run refuses through this, naming a code
 * rather than writing a sentence, so the remediation table stays the single
 * source of selector messages.
 */
export function failChangeRequestSelector(code: ChangeRequestSelectorRefusalCode): never {
  throw new ChangeRequestSelectorError(code);
}

const SELECTOR_TEXT_LIMIT = 512;
/** Same namespace-path grammar the GitLab source provider validates against. */
const PROJECT_PATH = /^[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)+$/u;
const HOST = /^[A-Za-z0-9][A-Za-z0-9.-]*(?::\d{1,5})?$/u;
/** `host/group/project!123`, with at least one namespace segment. */
const PATH_FORM = /^([^/]+)\/(.+)!(\d+)$/u;
const NUMBER_FORM = /^!?(\d+)$/u;

function requireNumber(text: string): number {
  const value = Number(text);
  if (!Number.isSafeInteger(value) || value <= 0)
    failChangeRequestSelector("invalid-change-number");
  return value;
}

function requireProjectPath(value: string): string {
  if (
    value.length === 0 ||
    value.length > SELECTOR_TEXT_LIMIT ||
    value !== value.normalize("NFC") ||
    value.includes("..") ||
    !PROJECT_PATH.test(value)
  ) {
    failChangeRequestSelector("invalid-project-path");
  }
  return value;
}

/**
 * Lower-cases the host: the canonical locator is keyed on the host string, so
 * two spellings would otherwise yield two observation ids for one merge
 * request. The WHATWG URL parser already lower-cases the URL form.
 */
function requireHost(value: string): string {
  if (value.length === 0 || value !== value.normalize("NFC") || !HOST.test(value)) {
    failChangeRequestSelector("invalid-host");
  }
  return value.toLowerCase();
}

/**
 * A GitLab breadcrumb like `group/project!813` would otherwise read `group` as
 * the host and fail later with a misleading network error. A host has a dot or
 * a port, or is `localhost`.
 */
function looksLikeHost(value: string): boolean {
  return value.includes(".") || value.includes(":") || value === "localhost";
}

/**
 * Only `https` is accepted: `http` can be rewritten in transit, and `file:`,
 * `ssh:`, or credential-bearing URLs are not forge references.
 */
function parseUrlForm(value: string): ChangeRequestSelectorV1 | undefined {
  if (!/^[A-Za-z][A-Za-z0-9+.-]*:/u.test(value)) return undefined;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    failChangeRequestSelector("malformed-selector");
  }
  if (url.protocol !== "https:") failChangeRequestSelector("malformed-selector");
  if (url.username.length > 0 || url.password.length > 0) failChangeRequestSelector("invalid-host");
  // The `/-/` separator is optional in older GitLab links. GitHub's
  // `/pull/<n>` is recognized only to refuse it as an unsupported provider.
  const gitlab = /^\/(.+?)\/(?:-\/)?merge_requests\/(\d+)\/?$/u.exec(url.pathname);
  if (!gitlab) {
    if (/^\/(.+?)\/pull\/(\d+)\/?$/u.test(url.pathname))
      failChangeRequestSelector("unsupported-provider");
    failChangeRequestSelector("malformed-selector");
  }
  return Object.freeze({
    schemaVersion: 1 as const,
    kind: "docsfab-change-request-selector" as const,
    provider: "gitlab" as const,
    host: requireHost(url.host),
    projectPath: requireProjectPath(decodeURIComponent(gitlab[1] as string)),
    number: requireNumber(gitlab[2] as string),
  });
}

/** Pure: nothing is read, resolved, or granted here. */
export function parseChangeRequestSelector(value: unknown): ChangeRequestSelectorV1 {
  if (typeof value !== "string") failChangeRequestSelector("malformed-selector");
  const text = value.trim();
  if (text.length === 0) failChangeRequestSelector("empty-selector");
  if (text.length > SELECTOR_TEXT_LIMIT) failChangeRequestSelector("selector-too-long");

  const fromUrl = parseUrlForm(text);
  if (fromUrl) return fromUrl;

  const bare = NUMBER_FORM.exec(text);
  if (bare) {
    return Object.freeze({
      schemaVersion: 1 as const,
      kind: "docsfab-change-request-selector" as const,
      provider: "gitlab" as const,
      host: null,
      projectPath: null,
      number: requireNumber(bare[1] as string),
    });
  }

  const pathForm = PATH_FORM.exec(text);
  if (!pathForm) failChangeRequestSelector("malformed-selector");
  if (!looksLikeHost(pathForm[1] as string)) failChangeRequestSelector("ambiguous-reference");
  return Object.freeze({
    schemaVersion: 1 as const,
    kind: "docsfab-change-request-selector" as const,
    provider: "gitlab" as const,
    host: requireHost(pathForm[1] as string),
    projectPath: requireProjectPath(pathForm[2] as string),
    number: requireNumber(pathForm[3] as string),
  });
}

export function changeRequestSelectorUsesCheckout(selector: ChangeRequestSelectorV1): boolean {
  return selector.host === null && selector.projectPath === null;
}

export const CHANGE_REQUEST_SELECTOR_FIELDS = [
  "schemaVersion",
  "kind",
  "provider",
  "host",
  "projectPath",
  "number",
] as const;

/**
 * True when a value is exactly what {@link parseChangeRequestSelector} mints.
 *
 * Checks values, not just keys, because `host` and `projectPath` are rendered
 * into operator- and model-facing text; it reuses the parser's grammars so the
 * two cannot drift. Host and project are null together or present together.
 */
export function isValidatedChangeRequestSelector(value: unknown): value is ChangeRequestSelectorV1 {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const expected = [...CHANGE_REQUEST_SELECTOR_FIELDS].sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    return false;
  }
  if (record.schemaVersion !== 1) return false;
  if (record.kind !== "docsfab-change-request-selector") return false;
  if (!(CHANGE_REQUEST_PROVIDERS as readonly unknown[]).includes(record.provider)) return false;
  if (!Number.isSafeInteger(record.number) || (record.number as number) <= 0) return false;
  if (record.host === null || record.projectPath === null) {
    return record.host === null && record.projectPath === null;
  }
  if (typeof record.host !== "string" || typeof record.projectPath !== "string") return false;
  if (record.host.length === 0 || record.host !== record.host.normalize("NFC")) return false;
  if (!HOST.test(record.host) || record.host !== record.host.toLowerCase()) return false;
  const projectPath = record.projectPath;
  return (
    projectPath.length > 0 &&
    projectPath.length <= SELECTOR_TEXT_LIMIT &&
    projectPath === projectPath.normalize("NFC") &&
    !projectPath.includes("..") &&
    PROJECT_PATH.test(projectPath)
  );
}
