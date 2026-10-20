// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The shared credential shapes. Dependency-free so plain `node`
 * (docsfab-preflight.mjs) and host strip-types can both load it.
 *
 * `DOCUMENT_CREDENTIAL_SHAPES` screens repository content, job inputs, hosted
 * patches and run records, which legitimately quote example bearer values,
 * JWTs and AWS key ids. `TEXT_CREDENTIAL_SHAPES` adds those families for text
 * posted to a shared channel or MR.
 */

/**
 * Issuer token families, the single source for every credential screen.
 *
 * A token starts after any character other than an ASCII letter or digit. `\b`
 * counts `_` as part of a word, so it would miss the token in `x_<token>`; no
 * shape here uses it. An uppercase-led prefix (AWS, Google) also starts after
 * a lowercase letter, a camelCase segment, and an AWS key id is complete at its
 * 16th body character whatever follows. A Google key ends at its 35th body
 * character before a non-alphanumeric, or at a final `-` before anything. A
 * lowercase-led prefix after a lowercase letter is inside a word (`task-`,
 * `laughs_`), so only GitHub's fixed-length bodies mark a token there.
 */
export const CREDENTIAL_TOKEN_SHAPES = Object.freeze({
  gitlab: /(?<![A-Za-z0-9])(?:glpat|gldt|glrt|glptt)-[A-Za-z0-9_-]{20,}/u,
  github:
    /(?<![A-Za-z0-9])(?:gh[pousr]_|github_pat_)[A-Za-z0-9_]{20,}|(?:gh[pousr]_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9]{22}_[A-Za-z0-9]{59})(?![A-Za-z0-9])/u,
  slack: /(?<![A-Za-z0-9])xox[baprcds]-[A-Za-z0-9-]{20,}/u,
  slackRefresh: /(?<![A-Za-z0-9])xoxe(?:\.(?:xoxb|xoxp))?-[A-Za-z0-9-]{10,}/u,
  slackApp: /(?<![A-Za-z0-9])xapp-[A-Za-z0-9-]{10,}/u,
  nvidia: /(?<![A-Za-z0-9])nvapi-[A-Za-z0-9_-]{20,}/u,
  openai: /(?<![A-Za-z0-9])sk-(?:proj-)?[A-Za-z0-9_-]{20,}/u,
  googleOauth: /(?<![A-Za-z0-9])ya29\.[A-Za-z0-9_-]{20,}/u,
  googleApiKey: /(?<![A-Z0-9])AIza[A-Za-z0-9_-]{35}(?:(?<=-)|(?![A-Za-z0-9]))/u,
  aws: /(?<![A-Z0-9])(?:A3T[A-Z0-9]|AKIA|ASIA)[A-Z0-9]{16}/u,
  jwt: /(?<![A-Za-z0-9])eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/u,
});

/**
 * The assignment shape (last entry) matches a symmetrically quoted key only
 * when the value is quoted too: a quoted key followed by a JSON subtree is a
 * structural field, not an assignment. Its leading boundary admits `--` for a
 * CLI long flag but not a single `-`, so `x-token:` stays unflagged.
 */
export const DOCUMENT_CREDENTIAL_SHAPES = Object.freeze([
  CREDENTIAL_TOKEN_SHAPES.gitlab,
  CREDENTIAL_TOKEN_SHAPES.github,
  CREDENTIAL_TOKEN_SHAPES.slack,
  CREDENTIAL_TOKEN_SHAPES.slackRefresh,
  CREDENTIAL_TOKEN_SHAPES.slackApp,
  CREDENTIAL_TOKEN_SHAPES.nvidia,
  CREDENTIAL_TOKEN_SHAPES.openai,
  /(?:^|--|[^A-Za-z0-9_-])(?:token|secret|password|api[_-]?key|private[_-]?token|authorization)(?:(["'])\s*[:=]\s*\1|\s*[:=]\s*)\S{8,}/iu,
]);

/**
 * Adds a bearer value, a JWT's first two segments, a PEM private-key banner,
 * and AWS access-key ids. Long hex runs stay allowed: answers cite
 * `<path> @ <revision>` and `cas:` locators.
 */
export const TEXT_CREDENTIAL_SHAPES = Object.freeze([
  ...DOCUMENT_CREDENTIAL_SHAPES,
  /(?<![A-Za-z0-9])Bearer\s+[A-Za-z0-9._~+/-]{16,}={0,2}/iu,
  /(?<![A-Za-z0-9])eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./u,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/u,
  CREDENTIAL_TOKEN_SHAPES.aws,
]);

/** True when `text` carries any shape in `TEXT_CREDENTIAL_SHAPES`. */
export function containsTextCredentialShape(text) {
  return TEXT_CREDENTIAL_SHAPES.some((shape) => shape.test(text));
}
