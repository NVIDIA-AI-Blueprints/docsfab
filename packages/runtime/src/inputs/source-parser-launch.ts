// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Byte-extraction launcher. Source parsers are where untrusted bytes meet code,
 * so the launcher never claims a sandbox it has not probed on this host.
 *
 * - `in-process-inert`: the adapter is an allocation-bounded, inert transform
 *   with no network, filesystem, subprocess, or evaluation capability. It runs
 *   on this event loop under the same budgets, deadline, and cancellation
 *   signal, and is not preemptible: the deadline reaches it only where it yields.
 * - `confined-subprocess`: reserved and not implemented. It always refuses, with
 *   `confinement-unavailable` without a successful probe and
 *   `subprocess-unimplemented` with one.
 */
import { execFileSync } from "node:child_process";
import { untrustedChildEnvironment } from "../security/child-process-environment.js";

import {
  DEFAULT_SOURCE_EXTRACTION_LIMITS,
  SourceExtractionError,
  extractSourceRepresentation,
  type ExtractSourceRepresentationResult,
  type SourceExtractorAdapterV1,
  type SourceExtractionLimitsV1,
} from "./source-extraction.js";

export const SOURCE_PARSER_EXECUTION_MODES = ["confined-subprocess", "in-process-inert"] as const;
export type SourceParserExecutionMode = (typeof SOURCE_PARSER_EXECUTION_MODES)[number];

export const SOURCE_PARSER_CONFINEMENT_MECHANISMS = ["bubblewrap", "none", "sandbox-exec"] as const;
export type SourceParserConfinementMechanism =
  (typeof SOURCE_PARSER_CONFINEMENT_MECHANISMS)[number];

export type SourceParserLaunchErrorCode =
  | "confinement-unavailable"
  | "subprocess-unimplemented"
  | "deadline-exceeded"
  | "cancelled"
  | "unsupported-execution-mode";

export class SourceParserLaunchError extends Error {
  public constructor(public readonly code: SourceParserLaunchErrorCode) {
    super(`Source parser launch rejected: ${code}.`);
    this.name = "SourceParserLaunchError";
  }
}

function fail(code: SourceParserLaunchErrorCode): never {
  throw new SourceParserLaunchError(code);
}

/** Content-free probe result. Safe to record and to show an operator. */
export interface SourceParserConfinementProbeV1 {
  schemaVersion: 1;
  kind: "docsfab-source-parser-confinement";
  platform: string;
  mechanism: SourceParserConfinementMechanism;
  available: boolean;
  reasonCode: string;
}

const PROBES: Readonly<
  Record<string, { mechanism: SourceParserConfinementMechanism; file: string; args: string[] }>
> = Object.freeze({
  linux: {
    mechanism: "bubblewrap",
    file: "bwrap",
    args: ["--ro-bind", "/", "/", "--unshare-all", "--dev", "/dev", "/bin/true"],
  },
  darwin: {
    mechanism: "sandbox-exec",
    file: "/usr/bin/sandbox-exec",
    args: ["-p", "(version 1)(deny default)(allow process-exec)", "/usr/bin/true"],
  },
});

/**
 * Run the platform's confinement mechanism. A missing binary, a non-zero exit,
 * or an unsupported platform reports `available: false`; capability is never
 * inferred from the platform name alone.
 */
export function probeSourceParserConfinement(
  options: {
    platform?: string;
    environment?: NodeJS.ProcessEnv;
    run?: (file: string, args: string[], environment: NodeJS.ProcessEnv) => void;
  } = {},
): SourceParserConfinementProbeV1 {
  const platform = options.platform ?? process.platform;
  const probe = PROBES[platform];
  if (!probe) {
    return Object.freeze({
      schemaVersion: 1 as const,
      kind: "docsfab-source-parser-confinement" as const,
      platform,
      mechanism: "none" as const,
      available: false,
      reasonCode: "unsupported-platform",
    });
  }
  const run =
    options.run ??
    ((file: string, args: string[], environment: NodeJS.ProcessEnv) => {
      execFileSync(file, args, { stdio: "ignore", timeout: 10_000, env: environment });
    });
  try {
    run(probe.file, probe.args, untrustedChildEnvironment(options.environment ?? process.env));
  } catch {
    return Object.freeze({
      schemaVersion: 1 as const,
      kind: "docsfab-source-parser-confinement" as const,
      platform,
      mechanism: probe.mechanism,
      available: false,
      reasonCode: "probe-failed",
    });
  }
  return Object.freeze({
    schemaVersion: 1 as const,
    kind: "docsfab-source-parser-confinement" as const,
    platform,
    mechanism: probe.mechanism,
    available: true,
    reasonCode: "probe-succeeded",
  });
}

export interface LaunchSourceParserInput {
  adapter: SourceExtractorAdapterV1;
  bytes: Uint8Array;
  mediaType: string;
  executionMode: SourceParserExecutionMode;
  /** Required for `confined-subprocess`; ignored for `in-process-inert`. */
  confinement?: SourceParserConfinementProbeV1;
  options?: Record<string, unknown>;
  limits?: Partial<SourceExtractionLimitsV1>;
  deadlineMs?: number;
  signal?: AbortSignal;
  now?: () => number;
}

export interface LaunchSourceParserResult extends ExtractSourceRepresentationResult {
  executionMode: SourceParserExecutionMode;
  elapsedMs: number;
}

/**
 * Launch one extraction under finite budgets. Only `in-process-inert` runs.
 *
 * The deadline is an in-process timer: `extractSourceRepresentation` races the
 * adapter against `limits.maxExtractionMs` and discards partial work from an
 * adapter that awaits or never resolves, but synchronous CPU work is not
 * preemptible; `maxOriginalBytes` bounds that case. `deadlineMs` only narrows
 * the ceiling, and the post-call elapsed check catches an overrun after the fact.
 */
export async function launchSourceParser(
  input: LaunchSourceParserInput,
): Promise<LaunchSourceParserResult> {
  const now = input.now ?? (() => Date.now());
  if (!SOURCE_PARSER_EXECUTION_MODES.includes(input.executionMode)) {
    fail("unsupported-execution-mode");
  }
  if (input.executionMode === "confined-subprocess") {
    if (input.confinement?.available !== true) fail("confinement-unavailable");
    // A successful probe proves the mechanism exists, not that this module uses
    // it; running in-process here would be an unbacked confinement claim.
    fail("subprocess-unimplemented");
  }
  if (input.signal?.aborted) fail("cancelled");
  const started = now();
  if (input.deadlineMs !== undefined && input.deadlineMs <= 0) fail("deadline-exceeded");
  let result: ExtractSourceRepresentationResult;
  try {
    result = await extractSourceRepresentation({
      adapter: input.adapter,
      bytes: input.bytes,
      mediaType: input.mediaType,
      options: input.options,
      limits: narrowExtractionDeadline(input.limits, input.deadlineMs),
      signal: input.signal,
    });
  } catch (error) {
    if (error instanceof SourceExtractionError && error.code === "extraction-deadline-exceeded") {
      fail("deadline-exceeded");
    }
    if (error instanceof SourceExtractionError && error.code === "extraction-cancelled") {
      fail("cancelled");
    }
    throw error;
  }
  const elapsedMs = now() - started;
  if (input.deadlineMs !== undefined && elapsedMs > input.deadlineMs) fail("deadline-exceeded");
  if (input.signal?.aborted) fail("cancelled");
  return { ...result, executionMode: input.executionMode, elapsedMs };
}

function narrowExtractionDeadline(
  limits: Partial<SourceExtractionLimitsV1> | undefined,
  deadlineMs: number | undefined,
): Partial<SourceExtractionLimitsV1> | undefined {
  if (deadlineMs === undefined) return limits;
  const ceiling = limits?.maxExtractionMs ?? DEFAULT_SOURCE_EXTRACTION_LIMITS.maxExtractionMs;
  return { ...limits, maxExtractionMs: Math.min(deadlineMs, ceiling) };
}
