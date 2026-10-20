// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createRequire } from "node:module";

import { CREDENTIAL_TOKEN_SHAPES } from "./text-credential-shapes.js";

const CREDENTIAL_KEY_SUFFIXES = [
  "apikey",
  "api_key",
  "api-key",
  "access_token",
  "access-token",
  "auth_token",
  "auth-token",
  "client_secret",
  "client-secret",
  "password",
  "secret",
  "authorization",
  "private_token",
  "private-token",
  "cookie",
];
const LEGACY_CREDENTIAL_KEYS = new Set([
  "apikey",
  "api_key",
  "api-key",
  "access_token",
  "access-token",
  "auth_token",
  "auth-token",
  "client_secret",
  "client-secret",
  "password",
  "secret",
  "authorization",
  "private_token",
  "private-token",
]);
/**
 * `token` counts only as an exact key that is known to be a field name: a
 * quoted key in text, or any own key in the structured walk. A suffix rule
 * would misclassify `token-count` or `non-token`, and an unquoted `token` in
 * text is usually a code identifier (quality-pack Python assigns a local named
 * `token`, which the integrity check scans; the reference filter parses only
 * TypeScript/JSX). An unquoted YAML `token:` or dotenv `TOKEN=` stays
 * unclassified here; the preflight `containsTokenShapedText` screen flags them,
 * but `repository-scanner.ts`'s per-file rule does not.
 */
const FIELD_ONLY_CREDENTIAL_KEY = "token";
/**
 * Also used for redaction. A key starts after any character other than an
 * ASCII letter or digit, as the issuer families in text-credential-shapes.js
 * do, so a hyphen or underscore before it (`x-nvapi-...`, `x_ihub_api_...`)
 * never hides it, and a prefix inside a word (`unvapi-...`) is not a key.
 * `ihub_api_` is matched in lower case only, as Inference Hub issues it, so an
 * upper-case environment name such as `X_IHUB_API_KEY_...` stays unflagged.
 */
const SECRET_SHAPES = [
  /(?<![A-Za-z0-9])nvapi-[A-Za-z0-9_-]{20,}(?![A-Za-z0-9_-])/giu,
  /(?<![A-Za-z0-9])ihub_api_[A-Za-z0-9_-]{20,}(?![A-Za-z0-9_-])/gu,
];
const PLACEHOLDERS = new Set([
  "changeme",
  "example",
  "placeholder",
  "replace-me",
  "replace_me",
  "test",
  "todo",
  "your-api-key",
  "your_api_key",
  "your-key-here",
  "your-token-here",
]);
/** Detect assigned credential material without returning or logging the value. */
export function containsAssignedCredential(value) {
  const classes = assignedCredentialClasses(value, DETECTED);
  return classes.legacy || classes.metadata;
}
export function containsLegacyAssignedCredential(value) {
  return assignedCredentialClasses(value, DETECTED).legacy;
}
export function containsMetadataAssignedCredential(value) {
  return assignedCredentialClasses(value, DETECTED).metadata;
}
/**
 * The same assignment check under the strict value rule, for screens where a
 * false positive costs nothing, such as text posted to a forge.
 */
export function containsStrictAssignedCredential(value) {
  const classes = assignedCredentialClasses(value, STRICT);
  return classes.legacy || classes.metadata;
}
export function containsStrictLegacyAssignedCredential(value) {
  return assignedCredentialClasses(value, STRICT).legacy;
}
export function containsStrictMetadataAssignedCredential(value) {
  return assignedCredentialClasses(value, STRICT).metadata;
}
function assignedCredentialClasses(value, rule) {
  const result = { legacy: false, metadata: false };
  // credentialAssignments has already admitted only credential values.
  for (const { match } of credentialAssignments(value, rule)) {
    const classification = credentialKeyClass(match[3] ?? "", (match[2] ?? "") !== "");
    if (classification) result[classification] = true;
  }
  return result;
}
/**
 * Descriptor-only bounded traversal. Malformed, cyclic, accessor-backed, or
 * oversized values fail closed without invoking attacker-controlled getters.
 */
export function inspectCredentialMetadata(value, onString = () => undefined) {
  const active = new WeakSet();
  const state = {
    nodes: 0,
    legacyAssignedCredential: false,
    metadataAssignedCredential: false,
    unsafeStructure: false,
  };
  const visit = (candidate, depth) => {
    if (state.unsafeStructure) return;
    state.nodes += 1;
    if (state.nodes > 20_000 || depth > 24) {
      state.unsafeStructure = true;
      return;
    }
    if (typeof candidate === "string") {
      onString(candidate);
      return;
    }
    if (
      candidate === null ||
      typeof candidate === "boolean" ||
      typeof candidate === "number" ||
      candidate === undefined
    )
      return;
    if (typeof candidate !== "object" || active.has(candidate)) {
      state.unsafeStructure = true;
      return;
    }
    active.add(candidate);
    try {
      if (Object.getOwnPropertySymbols(candidate).length > 0) {
        state.unsafeStructure = true;
        return;
      }
      const descriptors = Object.getOwnPropertyDescriptors(candidate);
      if (Array.isArray(candidate)) {
        if (Object.getPrototypeOf(candidate) !== Array.prototype) {
          state.unsafeStructure = true;
          return;
        }
        const length = descriptors.length;
        if (
          !length ||
          !Object.hasOwn(length, "value") ||
          !Number.isSafeInteger(length.value) ||
          Number(length.value) > 10_000
        ) {
          state.unsafeStructure = true;
          return;
        }
        const keys = Object.keys(descriptors).filter((key) => key !== "length");
        if (keys.length !== length.value || keys.some((key, index) => key !== String(index))) {
          state.unsafeStructure = true;
          return;
        }
        for (const key of keys) {
          const descriptor = descriptors[key];
          if (!descriptor || !Object.hasOwn(descriptor, "value") || !descriptor.enumerable) {
            state.unsafeStructure = true;
            return;
          }
          visit(descriptor.value, depth + 1);
        }
        return;
      }
      if (Object.getPrototypeOf(candidate) !== Object.prototype) {
        state.unsafeStructure = true;
        return;
      }
      const entries = Object.entries(descriptors);
      if (entries.length > 256) {
        state.unsafeStructure = true;
        return;
      }
      for (const [key, descriptor] of entries) {
        if (key.length > 256 || !Object.hasOwn(descriptor, "value") || !descriptor.enumerable) {
          state.unsafeStructure = true;
          return;
        }
        onString(key);
        const child = descriptor.value;
        // Every own key of a decoded object is a field name, so the `token`
        // class applies here without a quote.
        const classification = credentialKeyClass(key, true);
        // A decoded field's string is a literal, never a reference, so a
        // credential-named field keeps the strict value rule.
        if (classification && typeof child === "string" && isStrictCredentialValue(child)) {
          state[
            classification === "legacy" ? "legacyAssignedCredential" : "metadataAssignedCredential"
          ] = true;
        }
        visit(child, depth + 1);
      }
    } finally {
      active.delete(candidate);
    }
  };
  visit(value, 0);
  return {
    legacyAssignedCredential: state.legacyAssignedCredential,
    metadataAssignedCredential: state.metadataAssignedCredential,
    unsafeStructure: state.unsafeStructure,
  };
}
/** Associate structured metadata names and values without touching accessors. */
export function containsCredentialMetadata(value) {
  const result = inspectCredentialMetadata(value);
  return (
    result.legacyAssignedCredential || result.metadataAssignedCredential || result.unsafeStructure
  );
}
/** Detect the two provider credential classes used by catalog discovery. */
export function containsCatalogCredential(value) {
  return SECRET_SHAPES.some((pattern) => new RegExp(pattern.source, pattern.flags).test(value));
}
export function containsInferenceCredential(value) {
  return new RegExp(SECRET_SHAPES[0].source, SECRET_SHAPES[0].flags).test(value);
}
export function containsMetadataCredential(value) {
  return new RegExp(SECRET_SHAPES[1].source, SECRET_SHAPES[1].flags).test(value);
}
/** Remove both the metadata name and value so content-free errors cannot echo either. */
export function redactCredentialMaterial(value) {
  let output = "";
  let cursor = 0;
  const ranges = [];
  // Redaction never stops a run, so it keeps the strict value rule: redacting a
  // reference or a placeholder costs nothing, and missing a value leaks it.
  for (const { match, end } of credentialAssignments(value, STRICT)) {
    const start = match.index + match[1].length;
    const previous = ranges.at(-1);
    if (previous && start <= previous.end) previous.end = Math.max(previous.end, end);
    else ranges.push({ start, end });
  }
  for (const range of ranges) {
    output += `${value.slice(cursor, range.start)}[REDACTED_CREDENTIAL]`;
    cursor = range.end;
  }
  output += value.slice(cursor);
  for (const pattern of SECRET_SHAPES) {
    output = output.replace(new RegExp(pattern.source, pattern.flags), "[REDACTED]");
  }
  return output;
}
/**
 * The [start, end) ranges of `value` that `redactCredentialMaterial` replaces,
 * in `value`'s own coordinates, unsorted and possibly overlapping. A caller
 * that cuts the text redacts from these, so a cut never splits a credential
 * into an unrecognizable fragment.
 */
export function credentialMaterialSpans(value) {
  const spans = [];
  for (const { match, end } of credentialAssignments(value, STRICT)) {
    spans.push([match.index + match[1].length, end]);
  }
  for (const pattern of SECRET_SHAPES) {
    for (const match of value.matchAll(new RegExp(pattern.source, pattern.flags))) {
      spans.push([match.index, match.index + match[0].length]);
    }
  }
  return spans;
}
/** The strict value rule: redaction, structured fields, and query strings. */
const STRICT = "strict";
/** The detector's value rule: the strict rule minus documented exemptions. */
const DETECTED = "detected";
function credentialAssignments(value, rule) {
  const scanner = assignmentScanner();
  const matches = [];
  const literalEnds = new Map();
  let match;
  while ((match = scanner.exec(value))) {
    if (rule === STRICT) {
      if (
        credentialKeyClass(match[3] ?? "", (match[2] ?? "") !== "") &&
        isStrictCredentialValue(match[4])
      ) {
        matches.push(match);
        // Redaction also covers a literal beside a reference or a type, such as
        // `Optional[str] = "<literal>"`, which the strict match alone ends before.
        // The literal is judged by the strict rule too, so redaction never
        // keeps what the strict rule would remove.
        const literalEnd = adjacentLiteralEnd(value, match, isStrictCredentialValue);
        if (literalEnd !== undefined) literalEnds.set(match, literalEnd);
      }
    } else if (
      credentialKeyClass(match[3] ?? "", (match[2] ?? "") !== "") &&
      !isNestedMappingKey(match) &&
      !isNameSegment(match)
    ) {
      // A URL query parameter's value is a literal, never a reference.
      if (
        isQueryParameter(match) ? isStrictCredentialValue(match[4]) : isCredentialValue(match[4])
      ) {
        matches.push(match);
      } else {
        // A reference or code shape can sit beside a literal that holds the
        // value; that literal is still the assignment, and still counts.
        const literalEnd = adjacentLiteralEnd(value, match, isCredentialValue);
        if (literalEnd !== undefined) {
          matches.push(match);
          literalEnds.set(match, literalEnd);
        }
      }
    }
    // A call expression can contain another assignment. Never hide the inner literal.
    scanner.lastIndex = match.index + match[0].length - match[4].length;
  }
  const valueStart = (entry) => entry.index + entry[0].length - entry[4].length;
  const { references, assignmentEnds } = inspectSourceCredentialAssignments(
    value,
    new Set(matches.map(valueStart)),
  );
  return matches
    .filter((entry) => !references.has(valueStart(entry)))
    .map((match) => ({
      match,
      end: Math.max(
        match.index + match[0].length,
        assignmentEnds.get(valueStart(match)) ?? 0,
        literalEnds.get(match) ?? 0,
      ),
    }));
}
// Inside quotes, `#`, `;`, and `,` belong to the literal; only whitespace and
// quotes end it.
const QUOTED_LITERAL_BODY = /^[^\s"'`]{12,4096}$/u;
/**
 * `os.environ.get("NAME", "<literal>")`, `process.env.NAME || "<literal>"`,
 * `Optional[str] = "<literal>"`, `SecretStr("<literal>")`, and
 * `&Secret{Value: "<literal>"}`: a reference, a type, or a code
 * shape names or builds a value, but a quoted literal beside it can hold one.
 * Scans from the value to the end of its line, or past the line until its
 * opening brackets close, for a quoted literal that `accepts` counts: the
 * strict rule for redaction, the detector's rule for findings. Returns where
 * that literal ends, or `undefined`.
 */
function adjacentLiteralEnd(text, match, accepts) {
  if (!isCredentialReference(stripValueFraming(match[4]))) return undefined;
  let depth = 0;
  for (
    let index = match.index + match[0].length - match[4].length;
    index < text.length;
    index += 1
  ) {
    const character = text[index];
    if (character === "\n" && depth <= 0) return undefined;
    if (character === "(" || character === "[" || character === "{") depth += 1;
    else if (character === ")" || character === "]" || character === "}") {
      depth -= 1;
      if (depth < 0) return undefined;
    } else if (character === '"' || character === "'" || character === "`") {
      const close = text.indexOf(character, index + 1);
      const literal = close < 0 ? "" : text.slice(index + 1, close);
      // An unclosed quote on this line, such as an apostrophe in a comment, ends the scan.
      if (close < 0 || literal.includes("\n")) return undefined;
      if (QUOTED_LITERAL_BODY.test(literal) && accepts(literal)) return close + 1;
      index = close;
    }
  }
  return undefined;
}
/** `?name=` or `&name=`: a URL query parameter, whose value is always literal. */
function isQueryParameter(match) {
  return match[1] === "?" || match[1] === "&";
}
/**
 * A YAML key whose own line ends at the colon holds a nested block, not a
 * scalar. The scanner's whitespace reaches the next line, so the "value" it
 * finds there is that block's first key (`secret:` then `description: ...`).
 */
function isNestedMappingKey(match) {
  const keyEnd = match[1].length + match[2].length * 2 + match[3].length;
  const separator = match[0].slice(keyEnd, match[0].length - match[4].length);
  return /^[ \t]*:[ \t]*\r?\n/u.test(separator) && match[4].endsWith(":");
}
/**
 * A `:secret:` segment inside a colon-joined name, such as an AWS ARN
 * (`arn:aws:secretsmanager:...:secret:db-*`), names a resource, not a value.
 */
function isNameSegment(match) {
  const keyEnd = match[1].length + match[2].length * 2 + match[3].length;
  return match[1] === ":" && match[2] === "" && match[0][keyEnd] === ":";
}
function assignmentScanner() {
  // A bounded generic token matcher avoids nested-prefix backtracking; key
  // classification happens separately in credentialKeyClass. The boundary also
  // accepts `--` so a CLI long flag (`--private-token=<value>`) matches; a lone
  // `-` stays excluded so `non-secret:` and `x-token:` do not read as `secret`
  // and `token`. Group 1 stays capturing: redaction starts at `match[1].length`,
  // so a long flag redacts to a legible `--[REDACTED_CREDENTIAL]`.
  return /(^|--|[^A-Za-z0-9_-])(["']?)([A-Za-z0-9][A-Za-z0-9_-]{0,255})\2\s*[:=]\s*["']?(?:bearer\s+)?([^\s"'#;,]{12,4096})/gimu;
}
/**
 * `isFieldName` means the key is known to be a data field, not a possible code
 * identifier. Only the `token` class reads it; every other class is unconditional.
 */
function credentialKeyClass(value, isFieldName = false) {
  const normalized = value.toLowerCase();
  if (normalized === "cookie") return "metadata";
  if (normalized === FIELD_ONLY_CREDENTIAL_KEY) return isFieldName ? "legacy" : undefined;
  if (LEGACY_CREDENTIAL_KEYS.has(normalized)) return "legacy";
  return CREDENTIAL_KEY_SUFFIXES.some(
    (suffix) => normalized.endsWith(`_${suffix}`) || normalized.endsWith(`-${suffix}`),
  )
    ? "metadata"
    : undefined;
}
/**
 * The strict value rule, unchanged by #1807: at least 12 characters, not one of
 * the fixed PLACEHOLDERS, and not a braced `${...}` reference.
 */
function isStrictCredentialValue(value) {
  if (!value) return false;
  const candidate = value
    .replace(/^bearer\s+/iu, "")
    .replace(/^<|>$/g, "")
    .toLowerCase();
  return candidate.length >= 12 && !PLACEHOLDERS.has(candidate) && !candidate.startsWith("${");
}
/**
 * Owner decision pending on #1807. When `true`, a value built only from
 * documentation placeholder words (`mysecretpassword`, `changeme1234`,
 * `your-anthropic-api-key`, `encrypted_token_data`), or base64 of such a value,
 * is not a credential to the detector, so it passes the gates, the provider
 * backstop, the response screen, and egress. When `false`, such a value counts:
 * a repository file holding one is withheld and the run continues.
 */
export const PLACEHOLDER_WORD_GRAMMAR = false;
/** The detector's value rule for text: the strict rule minus documented exemptions. */
function isCredentialValue(value) {
  if (!value) return false;
  const bare = stripValueFraming(value);
  return (
    isStrictCredentialValue(bare) &&
    !isCredentialReference(bare) &&
    !isSyntacticPlaceholder(bare) &&
    !(PLACEHOLDER_WORD_GRAMMAR && isPlaceholderWordGrammar(bare))
  );
}
/** Markdown inline-code backticks and a bearer scheme frame a value; they are not part of it. */
function stripValueFraming(value) {
  return value.replace(/^bearer\s+/iu, "").replace(/^`+|`+$/gu, "");
}
// Values that name or build a credential instead of holding one.
const ENVIRONMENT_REFERENCE = /^\$(?:[A-Za-z_][A-Za-z0-9_]*|\([A-Za-z_][A-Za-z0-9_]*\))$/u;
const TEMPLATE_REFERENCE = /^\{\{.*\}\}$/u;
const COMPOSITE_LITERAL =
  /^&?(?:\[\])*\*?[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*\{(?:\}|[A-Za-z_][A-Za-z0-9_]*:)?$/u;
const FIELD_PATH = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)+$/u;
const ENVIRONMENT_NAME = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/u;
const UPPER_WORD_NAME = /^[A-Z]+[0-9]*(?:_[A-Z]+[0-9]*)+$/u;
const TYPE_NAME =
  /^(?:[A-Z][a-z0-9]+){2,}(?:Str|String|Type|Secret|Token|Key|Config|Credentials?|Field|Model|Ref)$/u;
const PATH_REFERENCE = /^(?:~|\.{1,2})?\/[a-z0-9._-]+(?:\/[a-z0-9._-]+)+$/u;
const QUALIFIED_CALL = /^[A-Za-z_][A-Za-z0-9_]*(?:(?:\.|::)[A-Za-z_][A-Za-z0-9_]*)+\(\)?$/u;
const SCHEME_ENVIRONMENT_NAME =
  /^[a-z][a-z0-9-]*(?::[a-z][a-z0-9-]*)*:([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)$/u;
const TYPE_SUBSCRIPT =
  /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*\[[A-Za-z_][A-Za-z0-9_.,[\]|]*\]$/u;
const CREDENTIAL_NAME_PART =
  /(?:^|_)(?:API|APIKEY|KEY|KEYS|SECRET|SECRETS|TOKEN|TOKENS|PASSWORD|PASSWD|PASS|PWD|CREDENTIAL|CREDENTIALS|AUTH|ACCESS)(?:_|$)/u;
const CREDENTIAL_FIELD_NAME =
  /(?:password|passwd|secret|token|api_?key|access_?key|secret_?key|private_?key|credentials?)$/iu;
/**
 * An environment reference (`$NAME`, `$(NAME)`; `${NAME}` is checked above), the
 * bare name of an environment variable (`--api-key=NVIDIA_API_KEY`), a type name
 * (`SerializableSecretStr`), a file path of plain names (`/run/secrets/db-key`), a
 * scheme-qualified credential variable name (`tool:resolve:env:GITHUB_TOKEN`), a
 * template expression (`{{ ... }}`), a composite literal of a named type
 * (`&pkg.Type{`, `Type{}`, `Type{Field:`), a type annotation (`Optional[str]`),
 * a qualified call (`os.environ.get(`, `std::env::var(`), or a copy of another
 * credential field (`opts.Password`). A dotted path counts only when its last name is a
 * credential field, so a dotted literal token such as `SG.abc.def` still counts;
 * an upper-case name counts only when it is plain words or has a credential
 * word between underscores, so `X7K2_M9P3_Q8R5` still counts.
 */
function isCredentialReference(value) {
  // The scanner reads Go's `:=` as a `:` separator, so the value keeps the `=`,
  // and an expression inside a call or literal keeps the caller's closers.
  const unprefixed = value.startsWith("=") ? value.slice(1) : value;
  const expression = unprefixed.replace(/[)\]}]+$/u, "");
  if (
    ENVIRONMENT_REFERENCE.test(unprefixed) ||
    TEMPLATE_REFERENCE.test(unprefixed) ||
    COMPOSITE_LITERAL.test(expression) ||
    QUALIFIED_CALL.test(expression) ||
    TYPE_SUBSCRIPT.test(unprefixed.replace(/\)+$/u, "")) ||
    (ENVIRONMENT_NAME.test(expression) && CREDENTIAL_NAME_PART.test(expression)) ||
    UPPER_WORD_NAME.test(expression) ||
    TYPE_NAME.test(expression) ||
    PATH_REFERENCE.test(expression) ||
    CREDENTIAL_NAME_PART.test(SCHEME_ENVIRONMENT_NAME.exec(expression)?.[1] ?? "")
  ) {
    return true;
  }
  return FIELD_PATH.test(expression) && CREDENTIAL_FIELD_NAME.test(expression.split(".").at(-1));
}
const ANGLE_PLACEHOLDER = /^<(?:[A-Za-z]+[0-9]*|[0-9]+)(?:[-_.](?:[A-Za-z]+[0-9]*|[0-9]+))*>$/u;
const MASK_PLACEHOLDER = /^[xX*#._-]+$/u;
const CANONICAL_BASE64 = /^[A-Za-z0-9+/]+={0,2}$/u;
const PRINTABLE_ASCII = /^[\x20-\x7e]+$/u;
/**
 * Words a documentation example spells a credential with. A value made only of
 * these words, digits, and `-`, `_`, or `.` is an illustration, such as
 * `mysecretpassword` or `YOUR_DB_PASSWORD`. A vendor token with such a prefix
 * (`secret_` and a random tail) does not split into these words, so it counts.
 */
const PLACEHOLDER_WORDS = Object.freeze([
  "access",
  "admin",
  "api",
  "change",
  "changeme",
  "db",
  "default",
  "demo",
  "dummy",
  "enter",
  "example",
  "fake",
  "here",
  "insert",
  "key",
  "me",
  "my",
  "new",
  "our",
  "pass",
  "passwd",
  "password",
  "placeholder",
  "redacted",
  "replace",
  "root",
  "sample",
  "secret",
  "super",
  "test",
  "the",
  "this",
  "token",
  "user",
  "value",
  "with",
  "word",
  "your",
]);
/** An angle-bracketed name (`<your-password>`) or a mask (`xxxxxxxxxxxx`). */
function isSyntacticPlaceholder(value) {
  return ANGLE_PLACEHOLDER.test(value) || MASK_PLACEHOLDER.test(value);
}
/**
 * The word grammar `PLACEHOLDER_WORD_GRAMMAR` switches: a phrase or run of
 * documentation placeholder words, or base64 of a placeholder
 * (`cGFzc3dvcmQxMjM=`). Exported so tests can pin it in either setting.
 */
export function isPlaceholderWordGrammar(value) {
  if (isPlaceholderPhrase(value) || isPlaceholderWords(value)) return true;
  if (!CANONICAL_BASE64.test(value)) return false;
  const decoded = Buffer.from(value, "base64");
  if (decoded.toString("base64") !== value) return false;
  const text = decoded.toString("latin1");
  return (
    PRINTABLE_ASCII.test(text) &&
    (isSyntacticPlaceholder(text) || isPlaceholderPhrase(text) || isPlaceholderWords(text))
  );
}
/** Placeholder words that mark a phrase such as `your-openai-api-key` as an example. */
const PLACEHOLDER_MARKERS = new Set([
  "changeme",
  "dummy",
  "enter",
  "example",
  "fake",
  "here",
  "insert",
  "my",
  "placeholder",
  "redacted",
  "replace",
  "sample",
  "your",
]);
/** Words that make a phrase of plain words name its content (`encrypted_token_data`). */
const NAMING_WORDS = new Set([
  "credential",
  "credentials",
  "data",
  "key",
  "passwd",
  "password",
  "secret",
  "token",
  "value",
]);
const WORD_SEGMENT = /^[a-z]+[0-9]*$/u;
/**
 * A phrase of plain words joined by `-`, `_`, or `.` that one marker word makes
 * an example (`your-openai-api-key`, `YOUR_API_KEY_HERE`), or three or more
 * lower-case words without digits, one of them a naming word, that name a value
 * (`encrypted_token_data`). A random segment such as `Q7mZp2` is not a plain
 * word, so a token with a marker prefix still counts, and a pass phrase such as
 * `correct-horse-battery-staple` names nothing, so it counts too.
 */
function isPlaceholderPhrase(value) {
  const segments = value.toLowerCase().split(/[-_.]/u);
  if (segments.length < 2 || !segments.every((segment) => WORD_SEGMENT.test(segment))) {
    return false;
  }
  return (
    segments.some((segment) => PLACEHOLDER_MARKERS.has(segment)) ||
    (segments.length > 2 &&
      /^[a-z_.-]+$/u.test(value) &&
      segments.some((segment) => NAMING_WORDS.has(segment)))
  );
}
/** Splits the value into placeholder words, digit runs, and separators, needing one word. */
function isPlaceholderWords(value) {
  const text = value.toLowerCase();
  if (!/^[a-z0-9_.-]+$/u.test(text)) return false;
  const reachable = [true];
  const afterWord = [false];
  for (let start = 0; start < text.length; start += 1) {
    if (!reachable[start]) continue;
    if (/[0-9_.-]/u.test(text[start])) {
      reachable[start + 1] = true;
      afterWord[start + 1] ||= afterWord[start];
      continue;
    }
    for (const word of PLACEHOLDER_WORDS) {
      if (!text.startsWith(word, start)) continue;
      reachable[start + word.length] = true;
      afterWord[start + word.length] = true;
    }
  }
  return afterWord[text.length] === true;
}
const MAX_SOURCE_CHARACTERS = 1024 * 1024;
const MAX_SYNTAX_NODES = 100_000;
const REPOSITORY_SOURCE_PARSER_PACKAGE = "@babel/parser";
/**
 * Refusal to screen. Host tooling that never screens source (the recovery
 * export CLI) loads this module without the parser; an absent parser is never
 * read as complete or credential-free source.
 */
export class RepositorySourceParserUnavailableError extends Error {
  constructor(cause) {
    super(
      `repository-source-parser-unavailable: ${REPOSITORY_SOURCE_PARSER_PACKAGE} is not installed for packages/runtime; install the runtime dependencies before screening repository source`,
      cause === undefined ? undefined : { cause },
    );
    this.name = "RepositorySourceParserUnavailableError";
    this.code = "repository-source-parser-unavailable";
  }
}
let repositorySourceParse;
/**
 * Resolve the parser on first use, outside any syntax `try`: a parse-failure
 * fallback must never absorb a missing package (in the initializer scan it
 * would mean no detection).
 */
function repositorySourceParser() {
  if (repositorySourceParse === undefined) {
    let loaded;
    try {
      loaded = createRequire(import.meta.url)(REPOSITORY_SOURCE_PARSER_PACKAGE);
    } catch (error) {
      throw new RepositorySourceParserUnavailableError(error);
    }
    if (typeof loaded?.parse !== "function") throw new RepositorySourceParserUnavailableError();
    repositorySourceParse = loaded.parse;
  }
  return repositorySourceParse;
}
/** Content recognition only; it grants neither a source role nor execution. */
export function isCompleteRepositoryCode(source) {
  if (typeof source !== "string" || source.length > MAX_SOURCE_CHARACTERS) return false;
  const parse = repositorySourceParser();
  try {
    const tree = parse(source, { sourceType: "unambiguous", plugins: ["typescript", "jsx"] });
    const pending = [tree.program];
    let remaining = MAX_SYNTAX_NODES;
    while (pending.length) {
      if (--remaining < 0) return false;
      const node = syntaxNode(pending.pop());
      if (!node) continue;
      for (const child of Object.values(node)) {
        if (Array.isArray(child)) pending.push(...child);
        else if (syntaxNode(child)) pending.push(child);
      }
    }
    return true;
  } catch {
    return false;
  }
}
/**
 * Identify references in complete JavaScript/TypeScript source, without executing it.
 * An ambiguous fragment, configuration value, or parse failure grants no exemption.
 * Only the start of a nonliteral RHS is returned; adjacent/nested literals stay scanned.
 */
function inspectSourceCredentialAssignments(source, candidates, minimumLiteralCharacters = 12) {
  const references = new Set();
  const assignmentEnds = new Map();
  const empty = () => ({
    references: new Set(),
    assignmentEnds: new Map(),
  });
  if (candidates.size === 0 || source.length > MAX_SOURCE_CHARACTERS) return empty();
  const parse = repositorySourceParser();
  try {
    const tree = parse(source, { sourceType: "unambiguous", plugins: ["typescript", "jsx"] });
    const pending = [tree.program];
    const budget = { remaining: MAX_SYNTAX_NODES };
    while (pending.length > 0) {
      if (--budget.remaining < 0) return empty();
      const node = syntaxNode(pending.pop());
      if (!node) continue;
      let rhs;
      if (node.type === "VariableDeclarator") rhs = syntaxNode(node.init);
      if (node.type === "ObjectProperty") rhs = syntaxNode(node.value);
      if (rhs?.start !== undefined && typeof rhs.end === "number") {
        assignmentEnds.set(rhs.start, rhs.end);
        if (rhs.type === "StringLiteral") assignmentEnds.set(rhs.start + 1, rhs.end);
        const annotation = syntaxNode(
          syntaxNode(syntaxNode(node.id)?.typeAnnotation)?.typeAnnotation,
        );
        if (annotation?.start !== undefined) assignmentEnds.set(annotation.start, rhs.end);
      }
      if (rhs?.start !== undefined && candidates.has(rhs.start)) {
        if (
          rhs.type === "Identifier" ||
          ((rhs.type === "CallExpression" || rhs.type === "MemberExpression") &&
            !containsLiteralData(rhs, budget, minimumLiteralCharacters))
        ) {
          references.add(rhs.start);
        }
      }
      // Parameter/interface annotations carry types, not assigned values. Do not
      // exempt variable annotations: an initializer can still contain a literal secret.
      if (
        ["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"].includes(
          node.type,
        ) &&
        Array.isArray(node.params)
      ) {
        for (const parameter of node.params) {
          const parameterNode = syntaxNode(parameter);
          if (parameterNode?.type === "Identifier") addTypeReference(parameterNode);
        }
      }
      if (budget.remaining < 0) return empty();
      if (node.type === "TSPropertySignature") addTypeReference(node);
      for (const child of Object.values(node)) {
        if (Array.isArray(child)) pending.push(...child);
        else if (syntaxNode(child)) pending.push(child);
      }
    }
    return { references, assignmentEnds };
    function addTypeReference(node) {
      const type = syntaxNode(syntaxNode(node.typeAnnotation)?.typeAnnotation);
      if (type?.start !== undefined && typeof type.end === "number") {
        assignmentEnds.set(type.start, type.end);
      }
      if (
        type?.type === "TSTypeReference" &&
        type.start !== undefined &&
        candidates.has(type.start) &&
        !containsLiteralData(type, budget, minimumLiteralCharacters)
      ) {
        references.add(type.start);
      }
    }
  } catch {
    // Unrecognized or incomplete source retains the ordinary credential check.
    return empty();
  }
}
/**
 * Complete repository originals only, never metadata. A parsed nonliteral
 * RHS/type reference can discharge just its ambiguous assignment match; literal
 * token shapes and URL/private-key material never do.
 */
export function containsRepositorySourceCredentialMaterial(source) {
  const hardShapes = [
    CREDENTIAL_TOKEN_SHAPES.gitlab,
    CREDENTIAL_TOKEN_SHAPES.github,
    CREDENTIAL_TOKEN_SHAPES.slack,
    CREDENTIAL_TOKEN_SHAPES.slackRefresh,
    CREDENTIAL_TOKEN_SHAPES.slackApp,
    CREDENTIAL_TOKEN_SHAPES.openai,
    /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/u,
  ];
  if (
    hardShapes.some((pattern) => pattern.test(source)) ||
    containsCatalogCredential(source) ||
    containsAssignedCredential(source) ||
    containsRepositoryCredentialInitializer(source)
  )
    return true;
  for (const match of source.replace(/[\t\r\n]/gu, "").matchAll(/https?:[^\s<>"'`]+/giu)) {
    try {
      const url = new URL(match[0]);
      if (url.username || url.password) return true;
    } catch {
      /* Unrecognized prose has no URL authority. */
    }
  }
  // Generic key names, including bare `token`, use the lower 8-character
  // threshold; quoted source and configuration keys also match.
  const assignments = [
    ...source.matchAll(
      /(?:^|[^A-Za-z0-9_-])(["']?)(?:token|secret|password|api[_-]?key|private[_-]?token|authorization)\1\s*[:=]\s*(\S{8,})/giu,
    ),
  ];
  const starts = assignments.map((match) => match.index + match[0].length - match[2].length);
  const { references } = inspectSourceCredentialAssignments(source, new Set(starts), 8);
  return starts.some((start) => !references.has(start));
}

/** Type annotations and line breaks must not conceal named scalar initializers. */
function containsRepositoryCredentialInitializer(source) {
  if (source.length > MAX_SOURCE_CHARACTERS) return false;
  const parse = repositorySourceParser();
  try {
    const tree = parse(source, { sourceType: "unambiguous", plugins: ["typescript", "jsx"] });
    const pending = [tree.program],
      budget = { remaining: MAX_SYNTAX_NODES };
    const nameOf = (node) =>
      node?.type === "Identifier"
        ? node.name
        : node?.type === "StringLiteral"
          ? node.value
          : node?.type === "PrivateName"
            ? node.id?.name
            : null;
    while (pending.length) {
      if (--budget.remaining < 0) return true;
      const node = syntaxNode(pending.pop());
      if (!node) continue;
      let key = null,
        value = null;
      if (node.type === "VariableDeclarator") {
        key = nameOf(node.id);
        value = node.init;
      }
      if (["ObjectProperty", "ClassProperty", "ClassPrivateProperty"].includes(node.type)) {
        key = nameOf(node.key);
        value = node.value;
      }
      if (["AssignmentExpression", "AssignmentPattern"].includes(node.type)) {
        key =
          node.left?.type === "MemberExpression" ? nameOf(node.left.property) : nameOf(node.left);
        value = node.right;
      }
      const generic =
        typeof key === "string" &&
        /^(?:token|secret|password|api[_-]?key|private[_-]?token|authorization)$/iu.test(key);
      if (generic || (typeof key === "string" && credentialKeyClass(key))) {
        let expression = syntaxNode(value);
        while (
          expression &&
          [
            "TSAsExpression",
            "TSSatisfiesExpression",
            "TSNonNullExpression",
            "ParenthesizedExpression",
          ].includes(expression.type)
        ) {
          if (--budget.remaining < 0) return true;
          expression = syntaxNode(expression.expression);
        }
        // Object literals are screened through their named children below. A
        // function is not its result.
        if (
          expression &&
          [
            "StringLiteral",
            "NumericLiteral",
            "BigIntLiteral",
            "TemplateLiteral",
            "RegExpLiteral",
            "CallExpression",
            "OptionalCallExpression",
            "MemberExpression",
            "OptionalMemberExpression",
            "BinaryExpression",
            "LogicalExpression",
            "ConditionalExpression",
            "ArrayExpression",
          ].includes(expression.type) &&
          containsLiteralData(expression, budget, generic ? 8 : 12)
        )
          return true;
      }
      for (const child of Object.values(node)) {
        if (Array.isArray(child)) pending.push(...child);
        else if (syntaxNode(child)) pending.push(child);
      }
    }
  } catch {
    /* Unsupported syntax grants no exception in the separate reference check. */
  }
  return false;
}
function syntaxNode(value) {
  return value && typeof value === "object" && "type" in value && typeof value.type === "string"
    ? value
    : undefined;
}
function containsLiteralData(root, budget, minimumLiteralCharacters) {
  const pending = [root];
  let literalCharacters = 0;
  while (pending.length > 0) {
    if (--budget.remaining < 0) return true;
    const node = syntaxNode(pending.pop());
    if (!node) continue;
    if (
      node.type === "TemplateLiteral" ||
      node.type === "RegExpLiteral" ||
      node.computed === true
    ) {
      return true;
    }
    if (["StringLiteral", "NumericLiteral", "BigIntLiteral"].includes(node.type)) {
      const extra = node.extra;
      literalCharacters += Math.max(
        String(node.value).length,
        typeof extra?.raw === "string" ? extra.raw.length : 0,
      );
      if (literalCharacters >= minimumLiteralCharacters) return true;
    }
    for (const child of Object.values(node)) {
      if (Array.isArray(child)) pending.push(...child);
      else if (syntaxNode(child)) pending.push(child);
    }
  }
  return false;
}
