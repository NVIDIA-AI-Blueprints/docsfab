// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { resolve } from "node:path";

import { egressText } from "../security/egress.js";
import { processHostRootSet, processPublicRoots } from "../security/host-roots.js";
import { PUBLIC_ROOTS_VARIABLE } from "../security/public-roots.js";
import { redactSecrets } from "../security/redaction.js";
import {
  escapeCodePoint,
  escapeUndisplayable,
  UNDISPLAYABLE_CODE_POINT,
} from "../shared/display-text.js";
import type { ContextPreflightCause, ContextPreflightDiagnostic } from "./contracts.js";

const SAFE_EXCEPTION_NAME = /^[A-Za-z][A-Za-z0-9._-]{0,127}$/u;
/** A UTF-16 surrogate without its pair, which a record cannot hold as text. */
export const LONE_SURROGATE =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/gu;
/** A cause code: a content index or compiler code, an error code, or an error name. */
export const CONTEXT_PREFLIGHT_CAUSE_CODE = SAFE_EXCEPTION_NAME;
/**
 * A code point a cause message never carries raw, so text an operator reads
 * shows what it holds: the one reader-facing set (`shared/display-text.ts`)
 * the content index also escapes in the names it reports.
 */
export const UNDISPLAYABLE_CAUSE_TEXT = UNDISPLAYABLE_CODE_POINT;
/**
 * The undisplayable code points a whitespace collapse would otherwise turn
 * into a space: the line and paragraph separators and U+FEFF. They are escaped
 * before the collapse, so a page name that holds one keeps its spelling.
 */
const COLLAPSIBLE_UNDISPLAYABLE = /[\u2028\u2029\uFEFF]/gu;
const MAX_MESSAGE_LENGTH = 512;
/** The longest cause message a step record keeps; longer ones end in `...`. */
export const CONTEXT_PREFLIGHT_CAUSE_MESSAGE_CHARACTERS = MAX_MESSAGE_LENGTH;
const ENV_VALUE_MIN_LENGTH = 12;
const WITHHELD_MESSAGE = "Context preflight failed; its message matched credential material.";

/** Map a thrown value to exception name plus a secret-free message with host roots replaced. */
export function toContextPreflightDiagnostic(
  error: unknown,
  workspacePath: string,
): ContextPreflightDiagnostic {
  const name =
    error instanceof Error && SAFE_EXCEPTION_NAME.test(error.name) ? error.name : "Error";
  return { name, message: sanitizePreflightMessage(thrownMessage(error), workspacePath) };
}

/**
 * Diagnostic for a message the runtime composed from repository-relative
 * paths only. It names no host root; secrets are still redacted and the
 * message is still bounded.
 */
export function repositoryRelativePreflightDiagnostic(message: string): ContextPreflightDiagnostic {
  return {
    name: "Error",
    message: boundPreflightMessage(redactSecrets(message, environmentSecretValues())),
  };
}

/**
 * The cause a step record keeps beside a coded preflight reason. `message` is
 * the thrown error's message, or one the runtime composed; either way it is
 * redacted and any host root under `workspacePath` is replaced. Every
 * undisplayable code point (`UNDISPLAYABLE_CAUSE_TEXT`) is written as
 * `\u{...}`, the line and paragraph separators and U+FEFF before the message
 * is bounded, so a page name keeps its spelling. A tab, line break, or other
 * ASCII whitespace run, and any other space, becomes one space. The record
 * decoder admits the result, and a reader sees what it holds.
 */
export function contextPreflightCause(
  code: string,
  message: string,
  workspacePath?: string,
): ContextPreflightCause {
  const spelled = message.replace(COLLAPSIBLE_UNDISPLAYABLE, escapeCodePoint);
  const sanitized =
    workspacePath === undefined
      ? repositoryRelativePreflightDiagnostic(spelled).message
      : sanitizePreflightMessage(spelled, workspacePath);
  return {
    code: CONTEXT_PREFLIGHT_CAUSE_CODE.test(code) ? code : "Error",
    message: boundPreflightMessage(
      escapeUndisplayable(sanitized.replace(LONE_SURROGATE, "\uFFFD")),
    ),
  };
}

/**
 * The code a thrown error names its cause by: a content index or other coded
 * error's own `code` (`unsafe-path`, `EACCES`), else its name.
 */
export function thrownCauseCode(error: unknown): string {
  const code =
    error instanceof Error && "code" in error ? (error as { code: unknown }).code : undefined;
  if (typeof code === "string" && CONTEXT_PREFLIGHT_CAUSE_CODE.test(code)) return code;
  return error instanceof Error && SAFE_EXCEPTION_NAME.test(error.name) ? error.name : "Error";
}

/** A thrown error's message, or a fixed sentence for a value that is not an `Error`. */
export function thrownMessage(error: unknown): string {
  return error instanceof Error
    ? error.message
    : "Context preflight failed without a typed Error instance.";
}

function sanitizePreflightMessage(message: string, workspacePath: string): string {
  const declared = processPublicRoots();
  const roots = processHostRootSet({
    workspaceRoots: [resolve(workspacePath)],
    publicRoots: declared,
  });
  // Roots are replaced before environment values are, since TMPDIR or HOME is
  // itself an environment value and would otherwise hide the root.
  const projected = egressText(redactSecrets(message, []), roots);
  if (!projected.ok) return WITHHELD_MESSAGE;
  return boundPreflightMessage(redactSecrets(projected.text, environmentSecretValues(declared)));
}

function boundPreflightMessage(message: string): string {
  let output = message.replaceAll("\0", "").replace(/\s+/gu, " ").trim();
  if (!output) output = "Context preflight failed with an empty error message.";
  if (output.length > MAX_MESSAGE_LENGTH) {
    // A cut never leaves half of a surrogate pair behind.
    output = `${output
      .slice(0, MAX_MESSAGE_LENGTH - 3)
      .replace(/[\uD800-\uDBFF]$/u, "")
      .trimEnd()}...`;
  }
  return output;
}

/** A declared public root, and the declaration itself, are public by definition. */
function environmentSecretValues(publicRoots: ReadonlySet<string> = new Set()): string[] {
  const values: string[] = [];
  for (const [name, value] of Object.entries(process.env)) {
    if (name === PUBLIC_ROOTS_VARIABLE || !value || publicRoots.has(value)) continue;
    if (value.length >= ENV_VALUE_MIN_LENGTH) values.push(value);
  }
  return values;
}
