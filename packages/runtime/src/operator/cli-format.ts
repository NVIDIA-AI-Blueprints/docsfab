// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { ProductDisposition } from "../workflow-contracts/contracts.js";
import type { DoctorReadinessArea } from "../doctor-readiness.js";
import { resolveProcessPresentationCapabilities } from "./presentation/capabilities.js";
import { paintTerminalText, type PresentationTerminalColor } from "./presentation/render.js";

export interface CliFormatOptions {
  tty?: boolean;
  noColor?: boolean;
  forceColor?: boolean;
  forceColorDisabled?: boolean;
  ci?: boolean;
  termDumb?: boolean;
}

export interface ResolvedCliFormat {
  tty: boolean;
  noColor: boolean;
  forceColor: boolean;
  ci: boolean;
  /** Unicode markers and `── TITLE ──` banners. TTY-only. */
  ornaments: boolean;
  /** 16-color + bold ANSI. Independent of ornaments when FORCE_COLOR is set. */
  color: boolean;
}

export type CliAnsiColor = Extract<PresentationTerminalColor, "green" | "red" | "yellow">;

export type ClassificationStatus = "selected" | "needs-input";
export type ExecutionStatus = "running" | "succeeded" | "failed" | "needs-input";
export type PublicationStatus = "not-requested" | "simulated" | "succeeded" | "failed";
export type CliStatusPlane = "classification" | "execution" | "product" | "publication";
export type CliStatusToken =
  | ClassificationStatus
  | ExecutionStatus
  | ProductDisposition
  | PublicationStatus;

/** Two-space hang indent under `── TITLE ──`. */
export const CLI_BODY_INDENT = "  ";

const STATUS_COLOR: Readonly<Partial<Record<CliStatusToken, CliAnsiColor>>> = {
  succeeded: "green",
  ready: "green",
  selected: "green",
  failed: "red",
  running: "yellow",
  "needs-input": "yellow",
  inconclusive: "yellow",
  "not-ready": "yellow",
  blocked: "yellow",
};

export function isInteractiveStdout(): boolean {
  return resolveProcessPresentationCapabilities().stdout.isTTY;
}

export function resolveCliFormatOptions(options: CliFormatOptions = {}): ResolvedCliFormat {
  const capabilities = resolveProcessPresentationCapabilities({
    ...(options.tty === undefined
      ? {}
      : { stdout: { isTTY: options.tty }, stderr: { isTTY: options.tty } }),
    environment: {
      ...(options.noColor === undefined ? {} : { noColorPresent: options.noColor }),
      ...(options.forceColor === undefined ? {} : { forceColor: options.forceColor }),
      ...(options.forceColorDisabled === undefined
        ? {}
        : { forceColorDisabled: options.forceColorDisabled }),
      ...(options.ci === undefined ? {} : { ci: options.ci }),
      ...(options.termDumb === undefined ? {} : { termDumb: options.termDumb }),
    },
  });
  return {
    tty: capabilities.stdout.isTTY,
    noColor: capabilities.environment.noColorPresent,
    forceColor: capabilities.environment.forceColor,
    ci: capabilities.environment.ci,
    ornaments: capabilities.stdout.ornaments,
    color: capabilities.stdout.color,
  };
}

export function paintCliText(
  text: string,
  style: { color?: CliAnsiColor; bold?: boolean; dim?: boolean } = {},
  options: CliFormatOptions = {},
): string {
  const resolved = resolveCliFormatOptions(options);
  return paintTerminalText(text, style, {
    isTTY: resolved.tty,
    color: resolved.color,
    ornaments: resolved.ornaments,
  });
}

export function cliStatusColor(token: CliStatusToken): CliAnsiColor | undefined {
  return STATUS_COLOR[token];
}

export function formatCliStatus(token: CliStatusToken, options: CliFormatOptions = {}): string {
  return paintCliText(token, { color: cliStatusColor(token), bold: true }, options);
}

export function formatSectionHeader(
  title: string,
  options: CliFormatOptions = {},
  header: { color?: CliAnsiColor } = {},
): string {
  const { ornaments } = resolveCliFormatOptions(options);
  const text = ornaments ? `── ${title} ──` : title;
  return paintCliText(text, { bold: true, color: header.color }, options);
}

export function pushSectionHeader(
  lines: string[],
  title: string,
  options: CliFormatOptions = {},
  header: { color?: CliAnsiColor } = {},
): void {
  if (lines.length > 0) lines.push("");
  lines.push(formatSectionHeader(title, options, header));
}

export function indentCliBody(line: string, depth = 1): string {
  if (line.length === 0) return line;
  return `${CLI_BODY_INDENT.repeat(depth)}${line}`;
}

export function pushIndentedBody(lines: string[], body: readonly string[], depth = 1): void {
  for (const line of body) lines.push(indentCliBody(line, depth));
}

export function formatCheckStatusIcon(
  status: "ready" | "blocked",
  options: CliFormatOptions = {},
): string {
  const { ornaments } = resolveCliFormatOptions(options);
  if (!ornaments) return status;
  return status === "ready" ? "✓" : "✗";
}

export interface ReadinessCheckRow {
  area: DoctorReadinessArea | string;
  status: "ready" | "blocked";
}

export function formatCheckGrid(
  checks: readonly ReadinessCheckRow[],
  options: CliFormatOptions = {},
): string[] {
  const { ornaments } = resolveCliFormatOptions(options);
  return checks.map((check) => {
    const word = paintCliText(
      check.status,
      { color: cliStatusColor(check.status), bold: true },
      options,
    );
    if (!ornaments) return `  ${check.area}: ${word}`;
    const icon = formatCheckStatusIcon(check.status, options);
    return `  ${icon} ${check.area}: ${word}`;
  });
}

export function formatCliDuration(durationMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(durationMs / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const parts: string[] = [];
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);
  if (seconds > 0 || parts.length === 0) parts.push(`${seconds}s`);
  return parts.join(" ");
}

export interface CliVerdictPlanes {
  classification?: ClassificationStatus;
  execution?: ExecutionStatus;
  product?: ProductDisposition;
  publication?: PublicationStatus;
}

function visiblePublicationStatus(planes: CliVerdictPlanes): PublicationStatus | undefined {
  return planes.publication !== undefined && planes.publication !== "not-requested"
    ? planes.publication
    : undefined;
}

function visibleCliVerdictTokens(planes: CliVerdictPlanes): CliStatusToken[] {
  const publication = visiblePublicationStatus(planes);
  return [planes.classification, planes.execution, planes.product, publication].filter(
    (item): item is CliStatusToken => item !== undefined,
  );
}

const VERDICT_WEAKNESS_RANK: Readonly<Partial<Record<CliStatusToken, number>>> = {
  failed: 0,
  blocked: 1,
  "needs-input": 1,
  inconclusive: 2,
  "not-ready": 2,
  running: 2,
  succeeded: 3,
  ready: 3,
  selected: 3,
  simulated: 3,
};

export function weakestCliVerdictToken(planes: CliVerdictPlanes): CliStatusToken | undefined {
  const tokens = visibleCliVerdictTokens(planes);
  if (tokens.length === 0) return undefined;
  return tokens.reduce((weakest, token) => {
    const current = VERDICT_WEAKNESS_RANK[token] ?? 4;
    const best = VERDICT_WEAKNESS_RANK[weakest] ?? 4;
    return current < best ? token : weakest;
  });
}

export function weakestCliVerdictColor(planes: CliVerdictPlanes): CliAnsiColor | undefined {
  const token = weakestCliVerdictToken(planes);
  return token === undefined ? undefined : cliStatusColor(token);
}

/** Nested VERDICT rows: always labeled (`execution succeeded`). */
export function formatCliVerdictPlaneRows(
  planes: CliVerdictPlanes,
  options: CliFormatOptions = {},
): string[] {
  const publication = visiblePublicationStatus(planes);
  const paint = (token: CliStatusToken): string => formatCliStatus(token, options);
  const rows: string[] = [];
  if (planes.classification !== undefined) {
    rows.push(`classification ${paint(planes.classification)}`);
  }
  if (planes.execution !== undefined) rows.push(`execution ${paint(planes.execution)}`);
  if (planes.product !== undefined) rows.push(`product ${paint(planes.product)}`);
  if (publication !== undefined) rows.push(`publication ${paint(publication)}`);
  return rows;
}

export function formatCliVerdictLine(
  planes: CliVerdictPlanes,
  options: CliFormatOptions = {},
): string {
  const publication = visiblePublicationStatus(planes);
  const planeCount = visibleCliVerdictTokens(planes).length;
  const paint = (token: CliStatusToken): string => formatCliStatus(token, options);
  const labeled = (label: string, token: CliStatusToken): string =>
    planeCount > 1 ? `${label} ${paint(token)}` : paint(token);
  const parts: string[] = [];
  if (planes.classification !== undefined) parts.push(paint(planes.classification));
  if (planes.execution !== undefined) parts.push(paint(planes.execution));
  if (planes.product !== undefined) parts.push(labeled("product", planes.product));
  if (publication !== undefined) parts.push(labeled("publication", publication));
  return parts.join(" · ");
}

const DISPOSITION_GLOSSARY: Readonly<
  Record<ProductDisposition | "legacy-no-product-disposition", string>
> = {
  ready: "The workflow's product criteria are satisfied.",
  "not-ready": "Execution succeeded, but documented product gaps remain.",
  inconclusive: "Evidence was insufficient for a definitive product verdict.",
  blocked: "A dependency or policy gate prevents completing the product outcome.",
  "needs-input": "Governed external input is required before the product outcome can finalize.",
  "legacy-no-product-disposition":
    "This run predates structured product disposition; inspect the run record.",
};

export function explainProductDisposition(
  disposition: ProductDisposition | "legacy-no-product-disposition",
): string | undefined {
  return DISPOSITION_GLOSSARY[disposition];
}

const FINDING_CODE_GLOSSARY: Readonly<
  Record<
    | "audit-search-blocked"
    | "audit-search-incomplete"
    | "audit-rubric-evidence-limited"
    | "audit-documentation-gap"
    | "experimental-quality-profile"
    | "insufficient-evidence"
    | "quality-rubric-unavailable",
    string
  >
> = {
  "audit-search-blocked": "A bounded search was blocked by a dependency or policy gate.",
  "audit-search-incomplete": "Bounded search did not finish; product evidence is incomplete.",
  "audit-rubric-evidence-limited":
    "Required audit rubric probes were not sufficiently assessed to confirm a product gap.",
  "audit-documentation-gap": "Bounded search admitted remaining documentation gaps.",
  "experimental-quality-profile":
    "The bound documentation-quality profile is experimental and cannot grant a product-ready verdict.",
  "insufficient-evidence":
    "Document quality evaluation reported insufficient evidence for a complete verdict.",
  "quality-rubric-unavailable":
    "No unambiguous content-type rubric was available for a quality score.",
};

/** Closed operator glossary for product finding codes. Unknown codes have no phrase. */
export function explainFindingCode(code: string): string | undefined {
  if (code in FINDING_CODE_GLOSSARY) {
    return FINDING_CODE_GLOSSARY[code as keyof typeof FINDING_CODE_GLOSSARY];
  }
  return undefined;
}
