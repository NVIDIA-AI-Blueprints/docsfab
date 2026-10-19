// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * HTML quality-report persistence and instance hosting.
 *
 * Renders the typed review projection plus escaped evaluator Markdown.
 * Writes under operator state and resolves a loopback or Brev-prefixed URL.
 * Does not accept model-authored HTML.
 */
import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";

import { runtimeEgressRootSet } from "../config/egress-roots.js";
import { egressValue, type EgressValueRefusalCode } from "../security/egress.js";
import { assertRunNotTombstoned, withRunMaintenanceGate } from "../records/run-maintenance-gate.js";
import type { QualityReportProjection } from "./contracts.js";

export const HOSTED_REPORT_DEFAULT_PORT = 8787;
export const HOSTED_REPORT_DEFAULT_BIND = "127.0.0.1";
export const HOSTED_QUALITY_REPORT_FILE = "index.html";
export const HOSTED_QUALITY_MARKDOWN_FILE = "quality-report.md";
export const HOSTED_QUALITY_REPORT_MAXIMUM_BYTES = 256 * 1024;
const HOSTED_AVAILABILITY_FILE = ".availability.json";
const HOSTED_HTML_REPORT_MAXIMUM_BYTES = 4 * 1024 * 1024;

const SAFE_RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const HOSTED_REPORT_URL =
  /^https?:\/\/(?:127\.0\.0\.1|(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)(?:\.(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?))*)(?::(?:[1-9]\d{0,3}|[1-5]\d{4}|6[0-4]\d{3}|65[0-4]\d{2}|655[0-2]\d|6553[0-5]))?\/reports\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}\/(?:index\.html)?$/u;
const ORIGIN_ONLY =
  /^https?:\/\/(?:127\.0\.0\.1|(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)(?:\.(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?))*)(?::(?:[1-9]\d{0,3}|[1-5]\d{4}|6[0-4]\d{3}|65[0-4]\d{2}|655[0-2]\d|6553[0-5]))?$/u;

export type HostedQualityReportErrorCode =
  | "invalid-url"
  | "invalid-run-id"
  | "invalid-origin"
  | EgressValueRefusalCode;

export class HostedQualityReportError extends Error {
  constructor(readonly code: HostedQualityReportErrorCode) {
    super(`Hosted quality report rejected: ${code}.`);
    this.name = "HostedQualityReportError";
  }
}

function failHostedQualityReport(code: HostedQualityReportErrorCode): never {
  throw new HostedQualityReportError(code);
}

export interface HostedQualityReportV1 {
  readonly url: string;
  readonly path: string;
  readonly digestSha256: string;
}

export interface HostedQualityReportMetadataV1 extends HostedQualityReportV1 {
  readonly reportAvailable: boolean;
  readonly reportUnavailableReason: "artifact-unavailable" | null;
  readonly markdownPath: string | null;
  readonly markdownDigestSha256: string | null;
  readonly markdownByteLength: number | null;
  readonly markdownAvailable: boolean;
  readonly markdownUnavailableReason: "byte-bound" | "artifact-unavailable" | null;
  readonly serveCommand: string;
}

interface HostedReportAvailabilityV1 {
  readonly schemaVersion: 1;
  readonly runId: string;
  readonly html: { readonly digestSha256: string; readonly byteLength: number };
  readonly markdown:
    | { readonly available: true; readonly digestSha256: string; readonly byteLength: number }
    | { readonly available: false; readonly reason: "byte-bound" };
}

interface HostedReviewFindingV1 {
  readonly id: string;
  readonly severity: string;
  readonly code: string;
  readonly summary: string;
  readonly path: string | null;
  readonly origin?: string;
  readonly line?: number;
  readonly evidence?: string;
  readonly recommendation?: string;
}

export function isHostedReportUrl(value: string): boolean {
  return HOSTED_REPORT_URL.test(value) && !value.includes("@") && !value.includes("\\");
}

export function assertHostedReportUrl(value: unknown): string {
  if (typeof value !== "string" || !isHostedReportUrl(value)) {
    failHostedQualityReport("invalid-url");
  }
  return value;
}

export function hostedQualityReportDirectory(stateDirectory: string, runId: string): string {
  assertRunId(runId);
  return join(resolve(stateDirectory), "reports", runId);
}

export function hostedQualityReportPath(stateDirectory: string, runId: string): string {
  return join(hostedQualityReportDirectory(stateDirectory, runId), HOSTED_QUALITY_REPORT_FILE);
}

export function hostedQualityMarkdownPath(stateDirectory: string, runId: string): string {
  return join(hostedQualityReportDirectory(stateDirectory, runId), HOSTED_QUALITY_MARKDOWN_FILE);
}

export function resolveHostedReportUrl(
  runId: string,
  environment: NodeJS.ProcessEnv = process.env,
): string {
  assertRunId(runId);
  const origin = resolveReportOrigin(environment);
  return assertHostedReportUrl(`${origin}/reports/${runId}/`);
}

export function renderQualityReportHtml(
  quality: QualityReportProjection | null,
  markdown: string,
  reviewFindings: readonly HostedReviewFindingV1[] = [],
  findingLimitations: readonly string[] = [],
): string {
  const markdownAvailable =
    Buffer.byteLength(markdown, "utf8") <= HOSTED_QUALITY_REPORT_MAXIMUM_BYTES;
  const qualitySummary = quality
    ? `
<dt>Decision</dt><dd>${escapeHtml(quality.decision)}</dd>
<dt>Confidence</dt><dd>${escapeHtml(String(quality.confidence))}</dd>
<dt>Score</dt><dd>${quality.rubric.status === "available" ? `${quality.rubric.total}/100 (${escapeHtml(quality.rubric.interpretationBand)}; threshold ${quality.rubric.threshold})` : `unavailable (${escapeHtml(quality.rubric.reason)})`}</dd>
<dt>Revision</dt><dd>${escapeHtml(quality.repositoryRevision)}</dd>
<dt>Digest</dt><dd>${escapeHtml(quality.reportLocator.digestSha256)}</dd>`
    : `
<dt>Quality</dt><dd>unavailable/not projected</dd>`;
  const gates = quality
    ? quality.hardGateFailures.length === 0
      ? "<li>No structured hard-gate failures were projected.</li>"
      : quality.hardGateFailures.map((entry) => `<li>${escapeHtml(entry)}</li>`).join("")
    : "";
  const limitationValues = [
    ...(quality
      ? quality.limitations.length > 0
        ? quality.limitations
        : ["No structured limitations were projected; inspect retained evaluator report."]
      : ["Structured quality projection: unavailable/not projected."]),
    ...findingLimitations,
  ];
  const limitations = [...new Set(limitationValues)]
    .map((entry) => `<li>${escapeHtml(entry)}</li>`)
    .join("");
  const findings =
    reviewFindings.length === 0
      ? "<li>No sealed structured review findings were projected.</li>"
      : reviewFindings
          .map(
            (finding) =>
              `<li><strong>${escapeHtml(finding.code)}</strong> (${escapeHtml(finding.severity)})` +
              `<br>Id: ${escapeHtml(finding.id)}` +
              `<br>Path: ${escapeHtml(finding.path ?? "null")}` +
              (finding.line !== undefined ? `<br>Line: ${escapeHtml(String(finding.line))}` : "") +
              (finding.origin !== undefined ? `<br>Origin: ${escapeHtml(finding.origin)}` : "") +
              `<br>${escapeHtml(finding.summary)}` +
              (finding.evidence ? `<br>Evidence: ${escapeHtml(finding.evidence)}` : "") +
              (finding.recommendation
                ? `<br>Recommendation: ${escapeHtml(finding.recommendation)}`
                : "") +
              `</li>`,
          )
          .join("");
  const bodyMarkdown = markdownAvailable
    ? markdown
    : "Evaluator Markdown exceeded the hosted-report byte bound and was omitted.";
  const markdownLink = markdownAvailable
    ? '<p>Retained evaluator report: <a href="quality-report.md">quality-report.md</a></p>'
    : "<p>Retained evaluator report: unavailable because it exceeded the byte bound.</p>";
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>DocsFab review${quality ? ` ${escapeHtml(quality.decision)}` : " (quality unavailable)"}</title>
<style>
body { font-family: ui-sans-serif, system-ui, sans-serif; margin: 2rem auto; max-width: 52rem; color: #111; }
h1 { font-size: 1.4rem; }
dl { display: grid; grid-template-columns: 8rem 1fr; gap: 0.35rem 1rem; }
dt { font-weight: 600; }
pre { white-space: pre-wrap; background: #f6f6f6; padding: 1rem; overflow-x: auto; }
</style>
</head>
<body>
<h1>DocsFab review report</h1>
<dl>
${qualitySummary}
</dl>
${quality ? `<h2>Hard-gate failures</h2>\n<ul>${gates}</ul>` : ""}
<h2>Limitations</h2>
<ul>${limitations}</ul>
<h2>Structured review findings</h2>
<ul>${findings}</ul>
<h2>Evaluator report</h2>
${markdownLink}
<pre>${escapeHtml(bodyMarkdown)}</pre>
</body>
</html>
`;
}

export async function persistHostedQualityReport(input: {
  stateDirectory: string;
  runId: string;
  quality: QualityReportProjection | null;
  markdown: string;
  reviewFindings?: readonly HostedReviewFindingV1[];
  findingLimitations?: readonly string[];
  environment?: NodeJS.ProcessEnv;
}): Promise<HostedQualityReportMetadataV1> {
  assertRunId(input.runId);
  return withRunMaintenanceGate(input.stateDirectory, async () => {
    await assertRunNotTombstoned(input.stateDirectory, input.runId);
    return persistHostedQualityReportUnderGate(input);
  });
}

async function persistHostedQualityReportUnderGate(input: {
  stateDirectory: string;
  runId: string;
  quality: QualityReportProjection | null;
  markdown: string;
  reviewFindings?: readonly HostedReviewFindingV1[];
  findingLimitations?: readonly string[];
  environment?: NodeJS.ProcessEnv;
}): Promise<HostedQualityReportMetadataV1> {
  const environment = input.environment ?? process.env;
  // The report is served over HTTP, so it carries no host root and no credential.
  const published = egressValue(
    {
      quality: input.quality,
      markdown: input.markdown,
      reviewFindings: input.reviewFindings,
      findingLimitations: input.findingLimitations,
    },
    runtimeEgressRootSet({
      ...(input.environment ? { environment: input.environment } : {}),
      stateDirectory: input.stateDirectory,
    }),
  );
  if (!published.ok) failHostedQualityReport(published.code);
  const { quality, markdown, reviewFindings, findingLimitations } = published.value;
  const markdownBytes = Buffer.from(markdown, "utf8");
  const markdownAvailable = markdownBytes.byteLength <= HOSTED_QUALITY_REPORT_MAXIMUM_BYTES;
  const html = renderQualityReportHtml(quality, markdown, reviewFindings, findingLimitations);
  const path = hostedQualityReportPath(input.stateDirectory, input.runId);
  const markdownPath = hostedQualityMarkdownPath(input.stateDirectory, input.runId);
  const directory = dirname(path);
  const reportsRoot = dirname(directory);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(reportsRoot, 0o700);
  await chmod(directory, 0o700);
  const htmlBytes = Buffer.from(html, "utf8");
  await writePrivateReplacement(path, htmlBytes);
  if (markdownAvailable) {
    await writePrivateReplacement(markdownPath, markdownBytes);
  } else {
    await rm(markdownPath, { force: true });
  }
  const availability: HostedReportAvailabilityV1 = {
    schemaVersion: 1,
    runId: input.runId,
    html: {
      digestSha256: digestBytes(htmlBytes),
      byteLength: htmlBytes.byteLength,
    },
    markdown: markdownAvailable
      ? {
          available: true,
          digestSha256: digestBytes(markdownBytes),
          byteLength: markdownBytes.byteLength,
        }
      : { available: false, reason: "byte-bound" },
  };
  const availabilityPath = join(directory, HOSTED_AVAILABILITY_FILE);
  await writePrivateReplacement(
    availabilityPath,
    Buffer.from(JSON.stringify(availability), "utf8"),
  );
  const verified = await readPersistedHostedQualityReport({
    stateDirectory: input.stateDirectory,
    runId: input.runId,
    environment,
  });
  if (!verified) {
    throw new Error("Hosted quality report failed its required post-write verification step.");
  }
  return verified;
}

export async function readPersistedHostedQualityReport(input: {
  stateDirectory: string;
  runId: string;
  environment?: NodeJS.ProcessEnv;
}): Promise<HostedQualityReportMetadataV1 | null> {
  if (!SAFE_RUN_ID.test(input.runId)) return null;
  const path = hostedQualityReportPath(input.stateDirectory, input.runId);
  const markdownPath = hostedQualityMarkdownPath(input.stateDirectory, input.runId);
  const availabilityPath = join(dirname(path), HOSTED_AVAILABILITY_FILE);
  try {
    const html = await readFile(path);
    const availability = parseAvailability(await readFile(availabilityPath, "utf8"), input.runId);
    if (!availability || !matchesArtifact(html, availability.html)) return null;
    let markdownAvailable = false;
    let markdownUnavailableReason: HostedQualityReportMetadataV1["markdownUnavailableReason"] =
      availability.markdown.available ? "artifact-unavailable" : "byte-bound";
    let markdown: Buffer | null = null;
    if (availability.markdown.available) {
      markdown = await readFile(markdownPath).catch(() => null);
      if (markdown && matchesArtifact(markdown, availability.markdown)) {
        markdownAvailable = true;
        markdownUnavailableReason = null;
      }
    }
    if (availability.markdown.available && !markdownAvailable) {
      const environment = input.environment ?? process.env;
      return {
        url: resolveHostedReportUrl(input.runId, environment),
        path,
        digestSha256: digestBytes(html),
        reportAvailable: false,
        reportUnavailableReason: "artifact-unavailable",
        markdownPath: null,
        markdownDigestSha256: null,
        markdownByteLength: null,
        markdownAvailable: false,
        markdownUnavailableReason: "artifact-unavailable",
        serveCommand: hostedReportServeCommand(input.stateDirectory, environment),
      };
    }
    const environment = input.environment ?? process.env;
    const markdownDigestSha256 = markdownAvailable && markdown ? digestBytes(markdown) : null;
    const markdownByteLength = markdownAvailable && markdown ? markdown.byteLength : null;
    return {
      url: resolveHostedReportUrl(input.runId, environment),
      path,
      digestSha256: digestBytes(html),
      reportAvailable: true,
      reportUnavailableReason: null,
      markdownPath: markdownAvailable ? markdownPath : null,
      markdownDigestSha256,
      markdownByteLength,
      markdownAvailable,
      markdownUnavailableReason,
      serveCommand: hostedReportServeCommand(input.stateDirectory, environment),
    };
  } catch {
    return null;
  }
}

export async function dispatchHostedReportRequest(input: {
  method: string;
  urlPath: string;
  reportsRoot: string;
}): Promise<{ status: number; contentType: string; body: string }> {
  if (input.method !== "GET") {
    return { status: 405, contentType: "text/plain; charset=utf-8", body: "Method not allowed.\n" };
  }
  const runId = hostedReportRunIdFromPath(input.urlPath);
  if (runId === null) {
    return { status: 404, contentType: "text/plain; charset=utf-8", body: "Not found.\n" };
  }
  const filename = hostedReportFilenameFromPath(input.urlPath);
  if (filename === null) {
    return { status: 404, contentType: "text/plain; charset=utf-8", body: "Not found.\n" };
  }
  const target = resolve(input.reportsRoot, runId, filename);
  const root = resolve(input.reportsRoot);
  const relativePath = relative(root, target);
  if (relativePath.startsWith(`..${sep}`) || relativePath === "..") {
    return { status: 404, contentType: "text/plain; charset=utf-8", body: "Not found.\n" };
  }
  try {
    const availability = parseAvailability(
      await readFile(join(root, runId, HOSTED_AVAILABILITY_FILE), "utf8"),
      runId,
    );
    if (!availability) {
      return { status: 404, contentType: "text/plain; charset=utf-8", body: "Not found.\n" };
    }
    const html = await readFile(join(root, runId, HOSTED_QUALITY_REPORT_FILE));
    if (!matchesArtifact(html, availability.html)) {
      return { status: 404, contentType: "text/plain; charset=utf-8", body: "Not found.\n" };
    }
    let markdown: Buffer | null = null;
    if (availability.markdown.available) {
      markdown = await readFile(join(root, runId, HOSTED_QUALITY_MARKDOWN_FILE));
      if (!matchesArtifact(markdown, availability.markdown)) {
        return { status: 404, contentType: "text/plain; charset=utf-8", body: "Not found.\n" };
      }
    }
    if (filename === HOSTED_QUALITY_MARKDOWN_FILE && !availability.markdown.available) {
      return { status: 404, contentType: "text/plain; charset=utf-8", body: "Not found.\n" };
    }
    const artifact = filename === HOSTED_QUALITY_MARKDOWN_FILE ? markdown! : html;
    const body = artifact.toString("utf8");
    return {
      status: 200,
      contentType:
        filename === HOSTED_QUALITY_MARKDOWN_FILE
          ? "text/markdown; charset=utf-8"
          : "text/html; charset=utf-8",
      body,
    };
  } catch {
    return { status: 404, contentType: "text/plain; charset=utf-8", body: "Not found.\n" };
  }
}

function digestBytes(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

async function writePrivateReplacement(path: string, bytes: Uint8Array): Promise<void> {
  const temporaryPath = `${path}.tmp-${randomUUID()}`;
  try {
    await writeFile(temporaryPath, bytes, { flag: "wx", mode: 0o600 });
    await chmod(temporaryPath, 0o600);
    await rename(temporaryPath, path);
    await chmod(path, 0o600);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

function matchesArtifact(
  bytes: Uint8Array,
  expected: { readonly digestSha256: string; readonly byteLength: number },
): boolean {
  return bytes.byteLength === expected.byteLength && digestBytes(bytes) === expected.digestSha256;
}

function parseAvailability(
  value: string,
  expectedRunId: string,
): HostedReportAvailabilityV1 | null {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== "object") return null;
    const candidate = parsed as {
      schemaVersion?: unknown;
      runId?: unknown;
      html?: { digestSha256?: unknown; byteLength?: unknown };
      markdown?: {
        available?: unknown;
        reason?: unknown;
        digestSha256?: unknown;
        byteLength?: unknown;
      };
    };
    const html = candidate.html;
    const markdown = candidate.markdown;
    if (
      !hasExactKeys(candidate, ["schemaVersion", "runId", "html", "markdown"]) ||
      candidate.schemaVersion !== 1 ||
      candidate.runId !== expectedRunId ||
      !SAFE_RUN_ID.test(expectedRunId) ||
      !html ||
      typeof html.digestSha256 !== "string" ||
      !/^[a-f0-9]{64}$/u.test(html.digestSha256) ||
      typeof html.byteLength !== "number" ||
      !Number.isSafeInteger(html.byteLength) ||
      html.byteLength < 0 ||
      html.byteLength > HOSTED_HTML_REPORT_MAXIMUM_BYTES ||
      !markdown
    ) {
      return null;
    }
    if (!hasExactKeys(html, ["digestSha256", "byteLength"])) return null;
    if (markdown.available === true) {
      if (!hasExactKeys(markdown, ["available", "digestSha256", "byteLength"])) return null;
      if (
        typeof markdown.digestSha256 !== "string" ||
        !/^[a-f0-9]{64}$/u.test(markdown.digestSha256) ||
        typeof markdown.byteLength !== "number" ||
        !Number.isSafeInteger(markdown.byteLength) ||
        markdown.byteLength < 0 ||
        markdown.byteLength > HOSTED_QUALITY_REPORT_MAXIMUM_BYTES
      ) {
        return null;
      }
      return {
        schemaVersion: 1,
        runId: expectedRunId,
        html: {
          digestSha256: html.digestSha256,
          byteLength: html.byteLength,
        },
        markdown: {
          available: true,
          digestSha256: markdown.digestSha256,
          byteLength: markdown.byteLength,
        },
      };
    }
    if (markdown.available === false && markdown.reason === "byte-bound") {
      if (!hasExactKeys(markdown, ["available", "reason"])) return null;
      return {
        schemaVersion: 1,
        runId: expectedRunId,
        html: {
          digestSha256: html.digestSha256,
          byteLength: html.byteLength,
        },
        markdown: { available: false, reason: "byte-bound" },
      };
    }
    return null;
  } catch {
    return null;
  }
}

function hasExactKeys(value: object, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === [...expected].sort()[index])
  );
}

export function hostedReportsRoot(stateDirectory: string): string {
  return join(resolve(stateDirectory), "reports");
}

export function hostedReportRunIdFromPath(urlPath: string): string | null {
  return hostedReportPathParts(urlPath)?.runId ?? null;
}

function hostedReportFilenameFromPath(urlPath: string): string | null {
  return hostedReportPathParts(urlPath)?.filename ?? null;
}

function hostedReportPathParts(urlPath: string): { runId: string; filename: string } | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPath.split("?")[0]!.split("#")[0]!);
  } catch {
    return null;
  }
  const match =
    /^\/reports\/([A-Za-z0-9][A-Za-z0-9._-]{0,127})\/(index\.html|quality-report\.md)?$/u.exec(
      decoded,
    );
  if (!match) return null;
  return {
    runId: match[1]!,
    filename: match[2] ?? HOSTED_QUALITY_REPORT_FILE,
  };
}

export function hostedReportServeCommand(
  stateDirectory: string,
  environment: NodeJS.ProcessEnv = process.env,
): string {
  const escapedStateDirectory = stateDirectory.replaceAll("'", "'\\''");
  return `docsfab reports serve --state-dir '${escapedStateDirectory}' --port ${parsePort(environment.DOCSFAB_REPORT_PORT)}`;
}

function resolveReportOrigin(environment: NodeJS.ProcessEnv): string {
  const configured = environment.DOCSFAB_REPORT_BASE_URL;
  if (configured !== undefined && configured !== "") {
    const origin = configured.endsWith("/") ? configured.slice(0, -1) : configured;
    if (!ORIGIN_ONLY.test(origin) || origin.includes("@")) {
      failHostedQualityReport("invalid-origin");
    }
    return origin;
  }
  const port = parsePort(environment.DOCSFAB_REPORT_PORT);
  const bind = environment.DOCSFAB_REPORT_BIND || HOSTED_REPORT_DEFAULT_BIND;
  const host = bind === "0.0.0.0" || bind === "::" ? "127.0.0.1" : bind;
  const origin = `http://${host}:${port}`;
  if (!ORIGIN_ONLY.test(origin)) failHostedQualityReport("invalid-origin");
  return origin;
}

function parsePort(value: string | undefined): number {
  if (value === undefined || value === "") return HOSTED_REPORT_DEFAULT_PORT;
  if (!/^[1-9][0-9]{0,4}$/u.test(value)) failHostedQualityReport("invalid-origin");
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    failHostedQualityReport("invalid-origin");
  }
  return port;
}

function assertRunId(runId: string): void {
  if (!SAFE_RUN_ID.test(runId)) failHostedQualityReport("invalid-run-id");
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
