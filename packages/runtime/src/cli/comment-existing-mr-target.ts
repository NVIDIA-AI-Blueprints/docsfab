// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Parse one explicit existing-MR target from CLI argv.
 *
 * Accepts a numeric IID (`88` or `!88`) or one HTTPS GitLab merge-request
 * URL. Credentials, query tokens, and extra targets are rejected. The URL
 * is parsed into host/path/IID and is never retained as the bound packet.
 */

const SAFE_HOST = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
const SAFE_PROJECT_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;
const IID = /^!?([1-9][0-9]{0,9})$/u;
const CREDENTIAL_SHAPES = [
  /\b(?:glpat|gldt|glrt|glptt)-[A-Za-z0-9_-]{20,}\b/u,
  /(?:^|[^A-Za-z0-9_-])(?:token|secret|password|api[_-]?key|private[_-]?token)\s*[:=]/iu,
];

export type ParsedCommentMrTarget =
  | { readonly kind: "iid"; readonly mergeRequestIid: number }
  | {
      readonly kind: "url";
      readonly host: string;
      readonly projectPath: string;
      readonly mergeRequestIid: number;
    };

export function parseCommentMrTarget(value: string): ParsedCommentMrTarget {
  if (typeof value !== "string" || value !== value.normalize("NFC") || value.includes("\0")) {
    throw new Error("docsfab --comment-mr requires one unambiguous MR IID or URL.");
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new Error("docsfab --comment-mr requires one unambiguous MR IID or URL.");
  }
  if (CREDENTIAL_SHAPES.some((pattern) => pattern.test(trimmed))) {
    throw new Error("docsfab --comment-mr rejects credential material in the MR target.");
  }
  const iid = IID.exec(trimmed);
  if (iid) {
    return { kind: "iid", mergeRequestIid: Number(iid[1]) };
  }
  if (!trimmed.startsWith("https://")) {
    throw new Error("docsfab --comment-mr requires one unambiguous MR IID or URL.");
  }
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error("docsfab --comment-mr requires one unambiguous MR IID or URL.");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.port ||
    !SAFE_HOST.test(url.hostname) ||
    url.hostname.includes("/")
  ) {
    throw new Error("docsfab --comment-mr requires one unambiguous MR IID or URL.");
  }
  const match = /^\/(.+)\/-\/merge_requests\/([1-9][0-9]{0,9})(?:\/.*)?$/u.exec(url.pathname);
  if (!match) {
    throw new Error("docsfab --comment-mr requires one unambiguous MR IID or URL.");
  }
  const projectPath = decodeProjectPath(match[1]!);
  return {
    kind: "url",
    host: url.hostname.toLowerCase(),
    projectPath,
    mergeRequestIid: Number(match[2]),
  };
}

function decodeProjectPath(pathname: string): string {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname).replace(/^\/+|\/+$/gu, "");
  } catch {
    throw new Error("docsfab --comment-mr requires one unambiguous MR IID or URL.");
  }
  const segments = decoded.split("/");
  if (segments.length < 2 || segments.some((segment) => !SAFE_PROJECT_SEGMENT.test(segment))) {
    throw new Error("docsfab --comment-mr requires one unambiguous MR IID or URL.");
  }
  return segments.join("/");
}
