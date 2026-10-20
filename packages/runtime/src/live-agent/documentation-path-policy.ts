// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { classifyTaskWritePath } from "../execution/task-scope.js";
import { isAgentInstructionFile } from "../repository/agent-instruction-files.js";
import { isAbsolute } from "node:path";

const CODE_FILE =
  /\.(?:[cm]?[jt]sx?|py|go|rs|java|kt|kts|rb|php|cs|c|cc|cpp|h|hpp|m|swift|scala|sh|bash|zsh|ps1)$/iu;
const KNOWN_BINARY_FILE = /\.(?:avif|bmp|gif|ico|jpe?g|png|webp)$/iu;
const THIRD_PARTY_SEGMENT = /^(?:node_modules|vendor)$/iu;
const CODE_DIRECTORY =
  /^(?:app|bin|build|ci|cmd|config|deploy|dist|internal|lib|pkg|scripts|skills|spec|specs|src|test|tests|third_party)$/iu;
const DOCUMENTATION_DIRECTORY_SEGMENT = /^[\p{L}\p{M}\p{N}_-][\p{L}\p{M}\p{N} ._'\u2019-]*$/u;
const PAGE_FILE = /^[A-Za-z0-9_.-]+\.mdx?$/u;

/** Shared repository-relative path syntax for configured and session roots. */
export function isSafeRepositoryRelativePath(path: string): boolean {
  return (
    Boolean(path) &&
    !isAbsolute(path) &&
    !path.includes("\\") &&
    !/[\u0000-\u001f\u007f]/u.test(path) &&
    path.split("/").every((part) => part !== "" && part !== "." && part !== "..")
  );
}

function safeDocumentationPath(path: string): boolean {
  const segments = path.split("/");
  if (
    !isSafeRepositoryRelativePath(path) ||
    segments.some((segment) => segment.startsWith(".") || /^\.+$/u.test(segment)) ||
    segments.slice(0, -1).some((segment) => THIRD_PARTY_SEGMENT.test(segment)) ||
    CODE_FILE.test(path) ||
    KNOWN_BINARY_FILE.test(path) ||
    isAgentInstructionFile(path)
  ) {
    return false;
  }
  const classification = classifyTaskWritePath(path);
  return classification !== "source" && classification !== "ci";
}

/** Configured text-document directory roots for the live-agent's direct tools. */
export function isLiveAgentDocumentationDirectoryRoot(root: string): boolean {
  const normalized = root.endsWith("/") ? root.slice(0, -1) : root;
  const segments = normalized.split("/");
  if (
    !isSafeRepositoryRelativePath(normalized) ||
    segments.some(
      (segment) =>
        segment.startsWith(".") ||
        !DOCUMENTATION_DIRECTORY_SEGMENT.test(segment) ||
        THIRD_PARTY_SEGMENT.test(segment),
    ) ||
    (segments.length === 1 && CODE_DIRECTORY.test(segments[0]!)) ||
    (segments[0]?.toLowerCase() === "packages" && segments.length === 1) ||
    (segments[0]?.toLowerCase() === "packages" &&
      segments.length > 2 &&
      CODE_DIRECTORY.test(segments[2]!))
  )
    return false;
  const classification = classifyTaskWritePath(`${normalized}/__docsfab_scope_probe__.md`);
  return classification !== "source" && classification !== "ci";
}

/** Markdown/MDX page paths for an operator-confirmed live-agent session root. */
export function isLiveAgentSessionDocumentationPage(path: string): boolean {
  const segments = path.split("/");
  if (
    !isSafeRepositoryRelativePath(path) ||
    !PAGE_FILE.test(segments.at(-1) ?? "") ||
    segments.some((segment) => segment.startsWith(".")) ||
    segments.slice(0, -1).some((segment) => THIRD_PARTY_SEGMENT.test(segment)) ||
    CODE_FILE.test(path) ||
    isAgentInstructionFile(path)
  )
    return false;
  const classification = classifyTaskWritePath(path);
  return classification !== "source" && classification !== "ci";
}

/** Exact tracked file roots and text paths below a configured documentation root. */
export function isLiveAgentConfiguredDocumentationPath(path: string): boolean {
  return safeDocumentationPath(path);
}

/** Existing code-file exclusions shared with layout discovery. */
export function isLiveAgentCodeFilePath(path: string): boolean {
  return CODE_FILE.test(path);
}

/**
 * Resolve tracked config entries for live-agent direct editing. Tracked regular
 * files grant that exact path; directory entries grant eligible text documents.
 */
export function liveAgentDocumentationRoots(
  configured: readonly string[] | undefined,
  trackedFiles: readonly string[],
): { roots: readonly string[]; dropped: readonly string[] } {
  if (configured === undefined) return { roots: [], dropped: [] };
  const tracked = new Set(trackedFiles);
  const admitted = (entry: string) =>
    tracked.has(entry)
      ? safeDocumentationPath(entry)
      : isLiveAgentDocumentationDirectoryRoot(entry);
  return {
    roots: [
      ...new Set(
        configured
          .filter(admitted)
          .map((entry) => (tracked.has(entry) ? entry : entry.endsWith("/") ? entry : `${entry}/`)),
      ),
    ].sort(),
    dropped: configured.filter((entry) => !admitted(entry)),
  };
}
