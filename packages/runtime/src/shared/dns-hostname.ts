// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The one DNS hostname grammar: RFC 1123 labels of 1 to 63 letters, digits,
 * and inner hyphens, joined by dots, at most 253 characters. A match is a
 * bare hostname with no scheme, port, userinfo, path, or trailing dot.
 *
 * Keep this module free of runtime-source imports so any module can use it.
 */

export interface DnsHostnameGrammar {
  /** Also admit ASCII uppercase letters. Never widened with the `i` flag, which folds non-ASCII letters. */
  readonly anyCase?: boolean;
  /** Also admit a single-label name such as `localhost`. */
  readonly singleLabel?: boolean;
}

const PATTERNS = new Map<string, RegExp>();

/** Anchored, length-bounded expression for one grammar variant; the default is lowercase with two or more labels. */
export function dnsHostnamePattern(grammar: DnsHostnameGrammar = {}): RegExp {
  const anyCase = grammar.anyCase === true;
  const singleLabel = grammar.singleLabel === true;
  const key = `${anyCase}:${singleLabel}`;
  const cached = PATTERNS.get(key);
  if (cached) return cached;
  const character = anyCase ? "A-Za-z0-9" : "a-z0-9";
  const label = `[${character}](?:[${character}-]{0,61}[${character}])?`;
  const pattern = new RegExp(
    `^(?=.{1,253}$)${label}(?:\\.${label})${singleLabel ? "*" : "+"}$`,
    "u",
  );
  PATTERNS.set(key, pattern);
  return pattern;
}

/** Whether `value` is a bare hostname under `grammar`. */
export function isDnsHostname(value: unknown, grammar?: DnsHostnameGrammar): value is string {
  return typeof value === "string" && dnsHostnamePattern(grammar).test(value);
}
