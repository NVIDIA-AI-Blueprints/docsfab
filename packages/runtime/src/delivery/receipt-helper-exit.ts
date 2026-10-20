// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { constants as osConstants } from "node:os";

/**
 * Receipt-store helper exit protocol, kept out of the public delivery index.
 *
 * A helper that fails without choosing its own verdict writes one line,
 * `DOCSFAB_HELPER_FAILURE <reason>`, to stderr before it exits. The reason is
 * drawn from a closed vocabulary, the helpers' own verdict messages and the
 * platform errno names, so the store can surface it without copying paths or
 * unbounded output from the child.
 */
export const RECEIPT_HELPER_REPORT_PREFIX = "DOCSFAB_HELPER_FAILURE ";

/** Messages a helper throws on purpose; an uncaught throw of one is its verdict. */
export const RECEIPT_HELPER_VERDICTS = Object.freeze([
  "invalid",
  "conflict",
  "missing",
  "missing request",
  "oversized",
  "oversized request",
  "unauthorized",
  "invalid settle budget",
]);

const RECEIPT_HELPER_REASONS: ReadonlySet<string> = new Set([
  ...RECEIPT_HELPER_VERDICTS,
  ...Object.keys(osConstants.errno),
  "syntax",
  "unexpected",
]);

/** Longest report line the vocabulary allows; longer stderr lines are discarded. */
const RECEIPT_HELPER_REPORT_LINE_CHARS =
  RECEIPT_HELPER_REPORT_PREFIX.length +
  Math.max(...[...RECEIPT_HELPER_REASONS].map((reason) => reason.length));

/**
 * Helper source that reports an uncaught failure as one closed-vocabulary line
 * and exits with `exitCode`. Interpolate it before any statement that can throw.
 */
export function receiptHelperFailureReportSource(exitCode: number): string {
  return String.raw`
process.on("uncaughtException", helperError => {
  const helperVerdicts = new Set(${JSON.stringify(RECEIPT_HELPER_VERDICTS)});
  const helperErrno = typeof helperError?.code === "string" && Object.hasOwn(helperOsConstants.errno, helperError.code) ? helperError.code : null;
  const helperReason = helperErrno ??
    (helperError?.constructor === Error && helperVerdicts.has(helperError.message) ? helperError.message :
      helperError instanceof SyntaxError ? "syntax" : "unexpected");
  try { process.stderr.write(${JSON.stringify(RECEIPT_HELPER_REPORT_PREFIX)} + helperReason + "\n"); } catch {}
  process.exit(${exitCode});
});
`;
}

/** Import line the report source needs; place it with the helper's other imports. */
export const RECEIPT_HELPER_REPORT_IMPORT =
  'import { constants as helperOsConstants } from "node:os";';

/**
 * Collect the helper's report line from its stderr. Only lines that match the
 * closed vocabulary are kept; anything else is drained and discarded.
 */
export function receiptHelperReportCollector(): {
  receive(chunk: Buffer | string): void;
  reason(): string | undefined;
} {
  let pending = "";
  let discarding = false;
  let reported: string | undefined;
  return {
    receive(chunk) {
      const lines = (pending + chunk.toString()).split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) {
        if (discarding) {
          discarding = false;
          continue;
        }
        if (reported === undefined && line.startsWith(RECEIPT_HELPER_REPORT_PREFIX)) {
          const reason = line.slice(RECEIPT_HELPER_REPORT_PREFIX.length);
          if (RECEIPT_HELPER_REASONS.has(reason)) reported = reason;
        }
      }
      if (pending.length > RECEIPT_HELPER_REPORT_LINE_CHARS) {
        pending = "";
        discarding = true;
      }
    },
    reason: () => reported,
  };
}

/** How a closed helper ended, before it is mapped to a store error code. */
export type ReceiptHelperExit =
  | { readonly kind: "success" }
  /** The helper's own root or lock integrity refusal. */
  | { readonly kind: "unsafe-root" }
  /** The helper's own invalid or failed verdict. */
  | { readonly kind: "verdict" }
  /** The helper stopped outside its protocol. */
  | { readonly kind: "stopped"; readonly failure: "signal" | "pipe" | "exit" };

/**
 * Classify a closed helper. A protocol exit code wins over a broken input pipe:
 * a helper that refuses before it reads its input also breaks the pipe, and
 * its refusal is the cause. A signal is the cause even when it broke the pipe.
 */
export function classifyReceiptHelperExit(outcome: {
  readonly code: number | null;
  readonly pipeFailed: boolean;
  readonly unsafeRootCodes: readonly number[];
  readonly verdictCodes: readonly number[];
}): ReceiptHelperExit {
  const { code } = outcome;
  if (code === 0) return { kind: "success" };
  if (code === null) return { kind: "stopped", failure: "signal" };
  if (outcome.unsafeRootCodes.includes(code)) return { kind: "unsafe-root" };
  if (outcome.verdictCodes.includes(code)) return { kind: "verdict" };
  return { kind: "stopped", failure: outcome.pipeFailed ? "pipe" : "exit" };
}
