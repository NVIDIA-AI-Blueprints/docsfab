// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Display-text sanitizer shared by operator envelopes and the local E2E report.
 * Origin-only HTTPS tokens that match executable route origins are preserved;
 * every other URL and credential-shaped token is redacted. Host paths are the
 * caller's egress roots, not a shape: see `sanitizeDisplayText`.
 */
import { EXECUTABLE_ROUTE_ORIGINS } from "../config/executable-route-urls.js";

const URL_SHAPE = /https?:\/\//iu;
const HOME_PATH_SHAPE = /(?:^|[\\/])(?:Users|home|root)[\\/]/u;
const URL_TOKEN = /https?:\/\/[^\s"'<>]*/giu;
const CONTINUED_URL = /(https?:\/\/[^\s"'<>]+)(\r?\n)([^\s"'<>]+)/giu;
const UNFINISHED_URL_END = /[:@/?#=&._%+-]$/u;
const WRAP_CLASS_URL_TAIL = /@/u;
const REDACTED = "[REDACTED]";
// NAME: value or NAME=value for a secret-bearing name; group 1 is the value.
const SECRET_ASSIGNMENT = /(?:TOKEN|SECRET|PASSWORD|API[_-]?KEY|CREDENTIAL)\s*[:=]\s*(\S+)/giu;
// A key starts after any character other than an ASCII letter or digit, as in
// the shared credential shapes (../security/text-credential-shapes.js), so a
// hyphen or underscore before it (x-nvapi-..., x-ihub_api_...) never hides it.
// An underscore before ihub_api_ is part of a name, as
// ../security/credential-material-core.js decides, so an environment name such
// as X_IHUB_API_KEY_... stays readable.
const SECRET_SHAPES = [
  /(?<![A-Za-z0-9])nvapi-[A-Za-z0-9_-]{20,}(?![A-Za-z0-9_-])/giu,
  /(?<![A-Za-z0-9_])ihub_api_[A-Za-z0-9_-]{20,}(?![A-Za-z0-9_-])/giu,
];

export function isPreservedRecordedOriginToken(token) {
  let parsed;
  try {
    parsed = new URL(token);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:") return false;
  if (parsed.username !== "" || parsed.password !== "") return false;
  if (parsed.search !== "" || parsed.hash !== "") return false;
  if (parsed.pathname !== "/" && parsed.pathname !== "") return false;
  return EXECUTABLE_ROUTE_ORIGINS.has(parsed.origin);
}

export function projectHttpsOrigin(raw) {
  if (raw == null) return null;
  const text = String(raw).trim();
  if (!text) return null;
  let parsed;
  try {
    parsed = new URL(text);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:") return null;
  return parsed.origin;
}

/** Credential-free model identity: origin-only HTTPS from executable route origins. */
export function projectModelBaseUrl(raw) {
  const origin = projectHttpsOrigin(raw);
  if (!origin) return null;
  return EXECUTABLE_ROUTE_ORIGINS.has(origin) ? origin : null;
}

function shouldFoldUrlContinuation(head, tail) {
  // Punctuation/hyphen breaks, or a wrap-class split in userinfo whose next
  // line can still complete the URL (`secret\nword@host`).
  return UNFINISHED_URL_END.test(head) || WRAP_CLASS_URL_TAIL.test(tail);
}

function foldNewlineContinuedUrls(value) {
  let output = value;
  for (;;) {
    const next = output.replace(CONTINUED_URL, (match, head, _newline, tail) =>
      shouldFoldUrlContinuation(head, tail) ? head + tail : match,
    );
    if (next === output) return output;
    output = next;
  }
}

function scrubUrls(value) {
  const folded = URL_SHAPE.test(value) ? foldNewlineContinuedUrls(value) : value;
  return URL_SHAPE.test(folded)
    ? folded.replace(URL_TOKEN, (token) =>
        isPreservedRecordedOriginToken(token) ? token : REDACTED,
      )
    : folded;
}

/**
 * Redact credentials and URLs, then hand the text to `projectHostRoots`, which
 * replaces this host's exact roots (the runtime passes its egress function).
 *
 * @param {string | null | undefined} value
 * @param {(text: string) => string} [projectHostRoots]
 */
export function sanitizeDisplayText(value, projectHostRoots) {
  if (value == null) return value;
  let output = String(value);
  for (const pattern of SECRET_SHAPES) {
    output = output.replace(new RegExp(pattern.source, pattern.flags), REDACTED);
  }
  output = output.replace(
    new RegExp(SECRET_ASSIGNMENT.source, SECRET_ASSIGNMENT.flags),
    (match) => `${match.split(/[:=]/u)[0].trim()}=${REDACTED}`,
  );
  output = scrubUrls(output);
  return projectHostRoots ? projectHostRoots(output) : output;
}

/**
 * The ranges of value that sanitizeDisplayText redacts, as [start, end)
 * offsets into value itself, for a caller that combines them with ranges
 * from other redaction layers on the same text (so one layer never hides
 * text another layer needs to see). Same shapes as sanitizeDisplayText, plus
 * home-directory paths, because a span caller has no host roots to project.
 * Separators and line breaks are left outside the ranges.
 *
 * @param {string} value
 * @returns {Array<[number, number]>}
 */
export function sanitizeDisplaySpans(value) {
  const text = String(value ?? "");
  const spans = [];
  for (const pattern of SECRET_SHAPES) {
    for (const match of text.matchAll(new RegExp(pattern.source, pattern.flags))) {
      spans.push([match.index, match.index + match[0].length]);
    }
  }
  for (const match of text.matchAll(
    new RegExp(SECRET_ASSIGNMENT.source, SECRET_ASSIGNMENT.flags + "d"),
  )) {
    spans.push(match.indices[1]);
  }
  if (URL_SHAPE.test(text)) {
    for (const match of text.matchAll(new RegExp(URL_TOKEN.source, URL_TOKEN.flags))) {
      // Follow the same newline continuations foldNewlineContinuedUrls joins.
      const pieces = [[match.index, match.index + match[0].length]];
      let token = match[0];
      for (;;) {
        const end = pieces.at(-1)[1];
        const continued = /^(\r?\n)([^\s"'<>]+)/u.exec(text.slice(end));
        if (!continued || !shouldFoldUrlContinuation(token, continued[2])) break;
        const start = end + continued[1].length;
        pieces.push([start, start + continued[2].length]);
        token += continued[2];
      }
      if (!isPreservedRecordedOriginToken(token)) spans.push(...pieces);
    }
  }
  const detector = new RegExp(HOME_PATH_SHAPE.source, "gu");
  for (let match = detector.exec(text); match; match = detector.exec(text)) {
    let start = match.index;
    if (start >= 2 && /[A-Za-z]:/u.test(text.slice(start - 2, start))) start -= 2;
    let end = match.index + match[0].length;
    while (end < text.length && !/[\s"'<>]/u.test(text[end])) end += 1;
    spans.push([start, end]);
    detector.lastIndex = end;
  }
  return spans;
}

export function sanitizeReportValue(value, seen = new Set()) {
  if (typeof value === "string") return sanitizeDisplayText(value);
  if (value == null || typeof value !== "object") return value;
  if (seen.has(value)) return "[REDACTED]";
  seen.add(value);
  if (Array.isArray(value)) return value.map((entry) => sanitizeReportValue(entry, seen));
  const result = {};
  for (const [key, child] of Object.entries(value)) {
    result[sanitizeDisplayText(key)] = sanitizeReportValue(child, seen);
  }
  return result;
}
