// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The `release-range` kind's `source` member, its closed decoder, and its
 * `--change` grammar. The kind owns the whole `release:` namespace: git ref
 * names cannot hold `:`, so no branch, tag, or commit name is ever read as a
 * release form, and a calendar-versioned tag such as `2026.09` stays a ref.
 *
 * `change-source.ts` registers the arm and the decoder and hands them the
 * contract's refusal and endpoint check, so this module imports nothing from
 * it but types and stays a leaf.
 */
import type {
  ChangeSourceDecodeKit,
  ChangeSourceRefusalCode,
  ChangeSourceSelectorArm,
  ChangeSourceSelectorMemberV1,
} from "../change-source.js";

/**
 * One first-parent unit of a release range. Its objects are local and
 * re-hashed, so the member carries no provenance; the units index names the
 * release it belongs to.
 */
export interface ReleaseRangeSourceV1 {
  readonly kind: "release-range";
}

/** `release:<base>..<head>`: the first-parent units on head since base. */
export interface ReleaseRangeSelectorV1 extends ChangeSourceSelectorMemberV1 {
  readonly source: "release-range";
  readonly form: "range";
  readonly base: string;
  readonly head: string;
}

export const RELEASE_SELECTOR_PREFIX = "release:" as const;

/**
 * Sub-forms the namespace reserves for releases named by their last tag or by
 * a date window. They parse here so their grammar cannot drift, and refuse
 * until their resolver ships.
 */
const RESERVED_FORMS = Object.freeze([
  { name: "release:since-last", matches: (rest: string) => /^since-last(?:\.\.|$)/u.test(rest) },
  { name: "release:dates:", matches: (rest: string) => rest.startsWith("dates:") },
]);

/** Values another kind owns even behind the prefix: a URL, or a trailing `!N`. */
const FOREIGN_FORM = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/|!\d+$/u;

/** The contract's refusal and range-endpoint check, injected so this module stays a leaf. */
export type ReleaseSelectorRefusal = (code: ChangeSourceRefusalCode, detail?: string) => never;

export function releaseRangeSelectorArm(
  fail: ReleaseSelectorRefusal,
  endpoint: (value: string) => string,
): ChangeSourceSelectorArm<ReleaseRangeSelectorV1> {
  return (value) => {
    if (!value.startsWith(RELEASE_SELECTOR_PREFIX) || FOREIGN_FORM.test(value)) return undefined;
    const rest = value.slice(RELEASE_SELECTOR_PREFIX.length);
    const reserved = RESERVED_FORMS.find((form) => form.matches(rest));
    if (reserved !== undefined) fail("change-source-release-form-unsupported", reserved.name);
    // Only the two-dot form: three dots would split into an endpoint `.x`,
    // which the endpoint check refuses as grammar.
    const separator = rest.indexOf("..");
    if (separator < 0) fail("change-source-release-form-unsupported");
    return Object.freeze({
      schemaVersion: 1 as const,
      kind: "docsfab-change-source-selector" as const,
      source: "release-range" as const,
      form: "range" as const,
      base: endpoint(rest.slice(0, separator)),
      head: endpoint(rest.slice(separator + "..".length)),
    });
  };
}

export function releaseRangeSourceDecoder(
  root: Record<string, unknown>,
  decode: ChangeSourceDecodeKit,
): ReleaseRangeSourceV1 {
  decode.exact(root, ["kind"]);
  return { kind: "release-range" as const };
}
