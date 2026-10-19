// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { posix } from "node:path";

import { limit } from "../config/limits.js";
import { createContractKit, type ContractFail } from "../contract-kit/index.js";
import { parseJsonEvidence } from "../json-evidence.js";
import type { RunRecord } from "../records/contracts.js";
import { listTemplates } from "./catalog.js";
import type {
  GovernedTemplateBundle,
  TemplateCatalogEntry,
  TemplateFormat,
  TemplateOutputPreview,
} from "./contracts.js";
import { fencedCodeLines, validatePage, type TemplateValidationFinding } from "./validate.js";

/**
 * Path and frontmatter conventions that bind an existing page to one
 * governed template. Only templates with a structural schema appear here.
 * A keyword names the template base id, its schema name, or a common alias.
 * `exact` keywords map only a filename stem equal to them. `suffix` keywords
 * name a page genre, so they also map a stem that ends in `-<keyword>`, such
 * as `runner-quickstart`; subject nouns such as `architecture` never do,
 * because `lens-architecture` is not an architecture overview.
 */
const TEMPLATE_KEYWORDS: Readonly<
  Record<string, { readonly exact: readonly string[]; readonly suffix: readonly string[] }>
> = Object.freeze({
  "architecture-overview": { exact: ["architecture", "architecture-overview"], suffix: [] },
  "beginner-tutorial": { exact: ["beginner-tutorial", "tutorial"], suffix: [] },
  ecosystem: { exact: ["ecosystem"], suffix: [] },
  "environment-variables": { exact: ["env-vars"], suffix: ["environment-variables"] },
  glossary: { exact: [], suffix: ["glossary"] },
  "helm-parameters": { exact: ["helm-values"], suffix: ["helm-parameters"] },
  installation: { exact: ["install"], suffix: ["installation"] },
  "key-features": { exact: ["key-features", "features"], suffix: [] },
  prerequisites: { exact: [], suffix: ["prerequisites"] },
  quickstart: { exact: [], suffix: ["quickstart", "quick-start"] },
  "release-notes": { exact: [], suffix: ["release-notes"] },
  troubleshooting: { exact: [], suffix: ["troubleshooting"] },
});

/** Keywords that name a template in a frontmatter declaration. */
function declarationKeywords(base: string): readonly string[] {
  const entry = TEMPLATE_KEYWORDS[base];
  return entry ? [...entry.exact, ...entry.suffix] : (DECLARATION_ONLY[base] ?? []);
}

/**
 * Directory names that select a template by themselves: the template set
 * files exactly one structural template under each of these categories.
 */
const DIRECTORY_KEYWORDS: Readonly<Record<string, string>> = Object.freeze({
  "release-notes": "release-notes",
  troubleshooting: "troubleshooting",
});

/**
 * Frontmatter keys that declare a page's template. `template` is explicit and
 * always decides. `page_type` and `content_type` decide only when they name a
 * catalog template; a generic value such as `concept` leaves the page to the
 * path conventions.
 */
const EXPLICIT_TEMPLATE_KEY = "template";
const PAGE_TYPE_KEYS = ["page_type", "content_type"] as const;

/** Section landing pages; path conventions never map them. */
const INDEX_STEMS = Object.freeze(["_index", "index", "readme"]);

/** Templates that only an explicit frontmatter declaration can select. */
const DECLARATION_ONLY: Readonly<Record<string, readonly string[]>> = Object.freeze({
  "about-feature": ["about-feature"],
  "about-procedural-task": ["about-procedural-task"],
  "single-procedural": ["single-procedural", "procedural"],
});

const MAPPING_POLICY_BODY = {
  id: "docsfab:template-audit-mapping",
  version: "2",
} as const;

/**
 * The per-page read bound: the content index source bound the repository
 * inventory applies to the same pages, with the same overrides.
 */
export const TEMPLATE_AUDIT_PAGE_BYTES_LIMIT = "contentIndex.maxSourceBytes" as const;

export const TEMPLATE_AUDIT_WORKFLOW = "audit-documentation" as const;
export const TEMPLATE_AUDIT_STEP_ID = "audit-template-conformance" as const;

const TEMPLATE_AUDIT_KIND = "docsfab-template-audit" as const;
const TEMPLATE_AUDIT_BODY_KEYS = ["mappingPolicy", "catalogDigest", "scope", "coverage", "pages"];

export type TemplateAuditDecodeErrorCode =
  | "invalid-shape"
  | "invalid-value"
  | "digest-mismatch"
  | "credential-material"
  | "schema-mismatch";

export class TemplateAuditDecodeError extends Error {
  public constructor(public readonly code: TemplateAuditDecodeErrorCode) {
    super(`The template audit report is invalid: ${code}.`);
    this.name = "TemplateAuditDecodeError";
  }
}

const kit = createContractKit({
  fail: ((code: TemplateAuditDecodeErrorCode) => {
    throw new TemplateAuditDecodeError(code);
  }) as ContractFail<TemplateAuditDecodeErrorCode>,
  codes: {
    invalidShape: "invalid-shape",
    invalidValue: "invalid-value",
    digestMismatch: "digest-mismatch",
    credentialMaterial: "credential-material",
    schemaMismatch: "schema-mismatch",
  },
});

export const TEMPLATE_AUDIT_MAPPING_POLICY = Object.freeze({
  ...MAPPING_POLICY_BODY,
  digest: kit.canonicalDigest({
    ...MAPPING_POLICY_BODY,
    keywords: TEMPLATE_KEYWORDS,
    directories: DIRECTORY_KEYWORDS,
    explicitKey: EXPLICIT_TEMPLATE_KEY,
    pageTypeKeys: PAGE_TYPE_KEYS,
    indexStems: INDEX_STEMS,
    declarationOnly: DECLARATION_ONLY,
    h1: "frontmatter-title-when-no-markdown-h1",
    myst: "directive-fence-role-or-target",
  }),
});

const MAPPING_BASES = ["frontmatter", "filename", "filename-suffix", "directory"] as const;
const UNMAPPED_REASONS = [
  "no-template-signal",
  "ambiguous-template-signal",
  "unknown-declared-template",
  "section-index",
  "unsupported-format",
] as const;
const REFUSAL_CODES = ["page-too-large", "page-not-utf8", "page-unreadable"] as const;
const H1_SOURCES = ["markdown", "frontmatter-title", "none"] as const;
const FINDING_RULES = [
  "missing-required-heading",
  "duplicate-h1",
  "wrong-section-order",
  "unresolved-template-placeholder",
] as const;
const FINDING_SEVERITIES = ["error", "warning", "info"] as const;
const SCOPE_KINDS = ["documentation-set", "focused-set"] as const;
const ENUMERATION_STATUSES = ["complete", "incomplete"] as const;

export type TemplateMappingBasis = (typeof MAPPING_BASES)[number];
export type TemplateUnmappedReason = (typeof UNMAPPED_REASONS)[number];
export type TemplateAuditRefusalCode = (typeof REFUSAL_CODES)[number];

export type TemplatePageMapping =
  | {
      readonly status: "mapped";
      readonly templateId: string;
      readonly format: TemplateFormat;
      readonly basis: TemplateMappingBasis;
      /** The frontmatter value, filename stem, or directory that decided it. */
      readonly signal: string;
    }
  | {
      readonly status: "unmapped";
      readonly reason: TemplateUnmappedReason;
      /** Every candidate template the conventions produced, sorted. */
      readonly candidates: readonly string[];
    };

export type TemplateAuditPageV1 =
  | {
      readonly path: string;
      readonly status: "passed" | "failed";
      readonly templateId: string;
      readonly basis: TemplateMappingBasis;
      readonly signal: string;
      readonly h1Source: (typeof H1_SOURCES)[number];
      readonly findings: readonly TemplateValidationFinding[];
      readonly validationDigest: string;
    }
  | {
      readonly path: string;
      readonly status: "unmapped";
      readonly reason: TemplateUnmappedReason;
      readonly candidates: readonly string[];
    }
  | {
      readonly path: string;
      readonly status: "refused";
      readonly code: TemplateAuditRefusalCode;
      /** Page size and read bound, both in bytes; set only for `page-too-large`. */
      readonly observedBytes: number | null;
      readonly limitBytes: number | null;
    };

export interface TemplateAuditScopeV1 {
  readonly kind: (typeof SCOPE_KINDS)[number];
  /**
   * Whether the repository inventory listed every tracked entry. Text and
   * navigation gaps never remove a page from the list, so only structure
   * coverage decides this.
   */
  readonly enumeration: (typeof ENUMERATION_STATUSES)[number];
  /** Tracked entries that could not be listed as auditable pages. */
  readonly omittedEntries: number;
  /** One line per structure-affecting inventory limitation, with its bound. */
  readonly limitations: readonly string[];
}

export interface TemplateAuditCoverageV1 {
  readonly enumerated: number;
  readonly checked: number;
  readonly passed: number;
  readonly failed: number;
  readonly unmapped: number;
  readonly refused: number;
}

export interface TemplateAuditReportV1 {
  readonly schemaVersion: 1;
  readonly kind: typeof TEMPLATE_AUDIT_KIND;
  readonly mappingPolicy: typeof TEMPLATE_AUDIT_MAPPING_POLICY;
  readonly catalogDigest: string;
  readonly scope: TemplateAuditScopeV1;
  readonly coverage: TemplateAuditCoverageV1;
  /** Sorted by path. */
  readonly pages: readonly TemplateAuditPageV1[];
  readonly digest: string;
}

export type TemplateAuditInputPage =
  | { readonly path: string; readonly content: string }
  | {
      readonly path: string;
      readonly refused: TemplateAuditRefusalCode;
      /** Tracked size in bytes, for `page-too-large`. */
      readonly observedBytes?: number;
      /** The resolved page bound in bytes, for `page-too-large`. */
      readonly limitBytes?: number;
    };

/** Map one existing page to a governed template, or say why it cannot be mapped. */
export function mapPageToTemplate(input: {
  readonly path: string;
  readonly content: string;
  readonly templateIds: ReadonlySet<string>;
}): TemplatePageMapping {
  const extension = posix.extname(input.path).toLowerCase();
  if (extension !== ".md" && extension !== ".mdx") {
    return { status: "unmapped", reason: "unsupported-format", candidates: [] };
  }
  const content = normalizeLineEndings(input.content);
  const format: TemplateFormat = isMyst(content) ? "myst" : "gfm";
  const mapped = (
    base: string,
    basis: TemplateMappingBasis,
    signal: string,
  ): TemplatePageMapping =>
    input.templateIds.has(`${base}-${format}`)
      ? { status: "mapped", templateId: `${base}-${format}`, format, basis, signal }
      : { status: "unmapped", reason: "unknown-declared-template", candidates: [base] };
  const frontmatter = frontmatterScalars(content);
  const explicit = frontmatter.get(EXPLICIT_TEMPLATE_KEY);
  if (explicit !== undefined) {
    const base = declaredTemplate(explicit);
    if (base === undefined) {
      return { status: "unmapped", reason: "unknown-declared-template", candidates: [] };
    }
    return mapped(base, "frontmatter", `${EXPLICIT_TEMPLATE_KEY}: ${explicit}`);
  }
  const typed = PAGE_TYPE_KEYS.flatMap((key) => {
    const value = frontmatter.get(key);
    const base = value === undefined ? undefined : declaredTemplate(value);
    return base === undefined ? [] : [{ base, signal: `${key}: ${value!}` }];
  });
  const typedBases = [...new Set(typed.map((entry) => entry.base))].sort();
  if (typedBases.length > 1) {
    return { status: "unmapped", reason: "ambiguous-template-signal", candidates: typedBases };
  }
  if (typed.length > 0) return mapped(typed[0]!.base, "frontmatter", typed[0]!.signal);

  const stem = posix.basename(input.path, posix.extname(input.path)).toLowerCase();
  if (INDEX_STEMS.includes(stem)) {
    return { status: "unmapped", reason: "section-index", candidates: [] };
  }
  const byFilename = Object.entries(TEMPLATE_KEYWORDS).flatMap(
    ([base, keywords]): Array<{ base: string; basis: "filename" | "filename-suffix" }> => {
      if ([...keywords.exact, ...keywords.suffix].includes(stem)) {
        return [{ base, basis: "filename" as const }];
      }
      return keywords.suffix.some((keyword) => stem.endsWith(`-${keyword}`))
        ? [{ base, basis: "filename-suffix" as const }]
        : [];
    },
  );
  const byDirectory = posix
    .dirname(input.path)
    .toLowerCase()
    .split("/")
    .flatMap((segment) => {
      const base = DIRECTORY_KEYWORDS[segment];
      return base === undefined ? [] : [{ base, segment }];
    });
  const candidates = [
    ...new Set([
      ...byFilename.map((entry) => entry.base),
      ...byDirectory.map((entry) => entry.base),
    ]),
  ].sort();
  if (candidates.length === 0) {
    return { status: "unmapped", reason: "no-template-signal", candidates };
  }
  if (candidates.length > 1) {
    return { status: "unmapped", reason: "ambiguous-template-signal", candidates };
  }
  const base = candidates[0]!;
  if (!input.templateIds.has(`${base}-${format}`)) {
    return { status: "unmapped", reason: "no-template-signal", candidates };
  }
  const filename = byFilename[0];
  return mapped(
    base,
    filename?.basis ?? "directory",
    filename ? stem : `${byDirectory[0]!.segment}/`,
  );
}

/**
 * Audit every page against its mapped template with the structural
 * `validatePage` rules. Deterministic: it reads no repository state and calls
 * no model.
 */
export function auditTemplateConformance(input: {
  readonly bundle: GovernedTemplateBundle;
  readonly pages: readonly TemplateAuditInputPage[];
  readonly scope: TemplateAuditScopeV1;
}): TemplateAuditReportV1 {
  const catalog = listTemplates({ bundle: input.bundle });
  const entries = new Map(catalog.templates.map((entry) => [entry.id, entry]));
  const templateIds = new Set(entries.keys());
  const pages = [...input.pages]
    .sort((left, right) => kit.compare(left.path, right.path))
    .map((page): TemplateAuditPageV1 => {
      if ("refused" in page) {
        const sized = page.refused === "page-too-large";
        return {
          path: page.path,
          status: "refused",
          code: page.refused,
          observedBytes: sized ? (page.observedBytes ?? null) : null,
          limitBytes: sized ? (page.limitBytes ?? null) : null,
        };
      }
      const mapping = mapPageToTemplate({ path: page.path, content: page.content, templateIds });
      if (mapping.status === "unmapped") {
        return {
          path: page.path,
          status: "unmapped",
          reason: mapping.reason,
          candidates: mapping.candidates,
        };
      }
      const rendered = renderedStructure(normalizeLineEndings(page.content));
      const validation = validatePage({
        bundle: input.bundle,
        page: auditPreview(page.path, rendered.content, entries.get(mapping.templateId)!),
      });
      return {
        path: page.path,
        status: validation.status,
        templateId: mapping.templateId,
        basis: mapping.basis,
        signal: mapping.signal,
        h1Source: rendered.h1Source,
        findings: validation.findings,
        validationDigest: validation.digest,
      };
    });
  kit.unique(pages.map((page) => page.path));
  return kit.seal(TEMPLATE_AUDIT_KIND, "digest", {
    mappingPolicy: TEMPLATE_AUDIT_MAPPING_POLICY,
    catalogDigest: catalog.digest,
    scope: {
      kind: input.scope.kind,
      enumeration: input.scope.enumeration,
      omittedEntries: input.scope.omittedEntries,
      limitations: [...new Set(input.scope.limitations)].sort(kit.compare),
    },
    coverage: coverageOf(pages),
    pages,
  });
}

/** Strictly decode a retained report; its digest and coverage counts must agree. */
export function decodeTemplateAuditReport(value: unknown): TemplateAuditReportV1 {
  return kit.decodeSealed(
    value,
    TEMPLATE_AUDIT_KIND,
    "digest",
    TEMPLATE_AUDIT_BODY_KEYS,
    // Coverage and the mapping policy are rebuilt rather than read, so the
    // sealed round trip refuses an edited count or policy.
    (root) => {
      const scope = kit.object(root.scope);
      kit.exact(scope, ["kind", "enumeration", "omittedEntries", "limitations"]);
      const pages = kit.array(root.pages).map(decodePage);
      kit.unique(pages.map((page) => page.path));
      const coverage = coverageOf(pages);
      return {
        mappingPolicy: TEMPLATE_AUDIT_MAPPING_POLICY,
        catalogDigest: kit.hash(root.catalogDigest),
        scope: {
          kind: kit.enumeration(scope.kind, SCOPE_KINDS),
          enumeration: kit.enumeration(scope.enumeration, ENUMERATION_STATUSES),
          omittedEntries: count(scope.omittedEntries),
          limitations: kit.array(scope.limitations).map(kit.string),
        },
        coverage,
        pages,
      };
    },
  ) as TemplateAuditReportV1;
}

/** The report a run's audit step retained, or `undefined` when absent or invalid. */
export function retainedTemplateAuditReport(
  record: Pick<RunRecord, "workflow" | "steps">,
): TemplateAuditReportV1 | undefined {
  if (record.workflow !== TEMPLATE_AUDIT_WORKFLOW) return undefined;
  const step = record.steps.find(
    (candidate) =>
      candidate.id === TEMPLATE_AUDIT_STEP_ID &&
      candidate.kind === "host-operation" &&
      candidate.status === "succeeded",
  );
  if (!step?.summary) return undefined;
  try {
    return decodeTemplateAuditReport(parseJsonEvidence(step.summary));
  } catch {
    // hygiene: refusal — an unreadable retained report presents as unavailable.
    return undefined;
  }
}

/** Coverage lines for the human PRODUCT section of a template audit run. */
export function templateAuditOutcomeLines(record: RunRecord): readonly string[] {
  if (record.workflow !== TEMPLATE_AUDIT_WORKFLOW) return [];
  const report = retainedTemplateAuditReport(record);
  if (!report) return ["Template audit: report unavailable."];
  const { coverage, scope } = report;
  const lines = [
    `Template audit: ${coverage.checked} of ${coverage.enumerated} pages checked (${coverage.passed} passed, ${coverage.failed} failed); ${coverage.unmapped} unmapped; ${coverage.refused} refused.`,
  ];
  const unmapped = new Map<string, number>();
  for (const page of report.pages) {
    if (page.status === "unmapped") unmapped.set(page.reason, (unmapped.get(page.reason) ?? 0) + 1);
    if (page.status === "refused") lines.push(refusedPageLine(page));
  }
  for (const reason of [...unmapped.keys()].sort(kit.compare)) {
    lines.push(`Unmapped pages: ${unmapped.get(reason)!} (${reason}).`);
  }
  if (coverage.unmapped > 0) {
    lines.push(
      "Declare a `template:` frontmatter key on an unmapped page to audit it against that template.",
    );
  }
  if (scope.enumeration === "incomplete") {
    lines.push(
      `Enumeration incomplete: ${scope.omittedEntries} tracked ${scope.omittedEntries === 1 ? "entry could" : "entries could"} not be audited (${scope.limitations.join("; ")}).`,
    );
  }
  return lines;
}

/** The refusal with its code, observed value, bound, and next action. */
function refusedPageLine(page: Extract<TemplateAuditPageV1, { status: "refused" }>): string {
  switch (page.code) {
    case "page-too-large":
      return `Refused page: ${page.path} (page-too-large: ${page.observedBytes ?? "unknown"} bytes exceeds ${TEMPLATE_AUDIT_PAGE_BYTES_LIMIT}, ${page.limitBytes ?? "unknown"} bytes). Next: ${limit(TEMPLATE_AUDIT_PAGE_BYTES_LIMIT).remediation}`;
    case "page-not-utf8":
      return `Refused page: ${page.path} (page-not-utf8: the tracked bytes are not valid UTF-8). Next: save the page as UTF-8, then run the audit again.`;
    case "page-unreadable":
      return `Refused page: ${page.path} (page-unreadable: the tracked file could not be read at this revision). Next: confirm it is a tracked regular file at the selected revision, then run the audit again.`;
  }
}

/** One deterministic review finding per template rule a checked page broke. */
export function templateAuditReviewFindings(report: TemplateAuditReportV1): Array<{
  id: string;
  severity: TemplateValidationFinding["severity"];
  code: string;
  summary: string;
  path: string;
  origin: "deterministic";
  line?: number;
  evidence: string;
  recommendation: string;
}> {
  return report.pages.flatMap((page) =>
    page.status === "passed" || page.status === "failed"
      ? page.findings.map((finding) => ({
          id: `template-audit:${kit.canonicalDigest({ path: page.path, templateId: page.templateId, ...finding })}`,
          severity: finding.severity,
          code: `template:${finding.rule}`,
          summary: findingSummary(finding, page.templateId),
          path: page.path,
          origin: "deterministic" as const,
          ...(finding.line === null ? {} : { line: finding.line }),
          evidence: `Template ${page.templateId} mapped by ${page.basis} (${page.signal}); rule expects ${finding.expected}.`,
          recommendation: findingRecommendation(finding),
        }))
      : [],
  );
}

function findingSummary(finding: TemplateValidationFinding, templateId: string): string {
  const heading = /^h([1-6]):(.*)$/su.exec(finding.expected);
  switch (finding.rule) {
    case "missing-required-heading":
      return `Missing a required H${heading?.[1] ?? "?"} heading matching "${heading?.[2] ?? finding.expected}" for template ${templateId}.`;
    case "duplicate-h1":
      return `The page has more than one H1 heading; template ${templateId} allows one.`;
    case "wrong-section-order":
      return `Section "${finding.expected}" is out of the order template ${templateId} defines.`;
    case "unresolved-template-placeholder":
      return `The page still contains template placeholder text (${finding.expected}).`;
  }
}

function findingRecommendation(finding: TemplateValidationFinding): string {
  switch (finding.rule) {
    case "missing-required-heading":
      return "Add the section, or rename the existing section heading to match the template.";
    case "duplicate-h1":
      return "Keep one H1 and demote the others.";
    case "wrong-section-order":
      return "Move the section so the page follows the template section order.";
    case "unresolved-template-placeholder":
      return "Replace the bracketed placeholder with real content, or remove it.";
  }
}

function coverageOf(pages: readonly TemplateAuditPageV1[]): TemplateAuditCoverageV1 {
  const count = (status: TemplateAuditPageV1["status"]): number =>
    pages.filter((page) => page.status === status).length;
  return {
    enumerated: pages.length,
    checked: count("passed") + count("failed"),
    passed: count("passed"),
    failed: count("failed"),
    unmapped: count("unmapped"),
    refused: count("refused"),
  };
}

function decodePage(value: unknown): TemplateAuditPageV1 {
  const root = kit.object(value);
  const path = kit.string(root.path);
  if (path.length === 0) kit.fail("invalid-value");
  const status = kit.enumeration(root.status, ["passed", "failed", "unmapped", "refused"] as const);
  if (status === "refused") {
    kit.exact(root, ["path", "status", "code", "observedBytes", "limitBytes"]);
    return {
      path,
      status,
      code: kit.enumeration(root.code, REFUSAL_CODES),
      observedBytes: root.observedBytes === null ? null : count(root.observedBytes),
      limitBytes: root.limitBytes === null ? null : count(root.limitBytes),
    };
  }
  if (status === "unmapped") {
    kit.exact(root, ["path", "status", "reason", "candidates"]);
    return {
      path,
      status,
      reason: kit.enumeration(root.reason, UNMAPPED_REASONS),
      candidates: kit.array(root.candidates).map(kit.identifier),
    };
  }
  kit.exact(root, [
    "path",
    "status",
    "templateId",
    "basis",
    "signal",
    "h1Source",
    "findings",
    "validationDigest",
  ]);
  const findings = kit.array(root.findings).map((entry): TemplateValidationFinding => {
    const finding = kit.object(entry);
    kit.exact(finding, ["rule", "severity", "expected", "line"]);
    const line = finding.line;
    if (line !== null && (!Number.isSafeInteger(line) || (line as number) < 1))
      kit.fail("invalid-value");
    return {
      rule: kit.enumeration(finding.rule, FINDING_RULES),
      severity: kit.enumeration(finding.severity, FINDING_SEVERITIES),
      expected: kit.string(finding.expected),
      line: line as number | null,
    };
  });
  if ((status === "failed") !== findings.some((finding) => finding.severity === "error"))
    kit.fail("invalid-value");
  return {
    path,
    status,
    templateId: kit.identifier(root.templateId),
    basis: kit.enumeration(root.basis, MAPPING_BASES),
    signal: kit.string(root.signal),
    h1Source: kit.enumeration(root.h1Source, H1_SOURCES),
    findings,
    validationDigest: kit.hash(root.validationDigest),
  };
}

/**
 * The heading structure a reader sees. Frontmatter lines are blanked so line
 * numbers stay those of the source file. A page with no Markdown H1 whose
 * frontmatter has a `title` gets that title as its H1 on the title's own line,
 * because Fern, Docusaurus, and similar renderers display it as the page H1.
 */
function renderedStructure(content: string): {
  content: string;
  h1Source: (typeof H1_SOURCES)[number];
} {
  const lines = content.split("\n");
  const end = frontmatterEnd(lines);
  if (end === undefined) {
    return { content, h1Source: hasMarkdownH1(lines) ? "markdown" : "none" };
  }
  const body = lines.map((line, index) => (index <= end ? "" : line));
  if (hasMarkdownH1(body)) return { content: body.join("\n"), h1Source: "markdown" };
  for (let index = 1; index < end; index += 1) {
    const title = /^title:[ \t]*(.+?)[ \t]*$/u.exec(lines[index]!)?.[1];
    const text = title === undefined ? "" : yamlScalar(title);
    if (text) {
      body[index] = `# ${text}`;
      return { content: body.join("\n"), h1Source: "frontmatter-title" };
    }
  }
  return { content: body.join("\n"), h1Source: "none" };
}

function auditPreview(
  path: string,
  content: string,
  entry: TemplateCatalogEntry,
): TemplateOutputPreview {
  return {
    topicId: path,
    slug: path,
    path,
    format: entry.format,
    content,
    contentSha256: createHash("sha256").update(content).digest("hex"),
    template: entry.template,
    schema: entry.schema,
    evidenceNodeIds: [],
    evidenceGaps: [],
    todos: [],
  };
}

/** Index of the closing frontmatter delimiter, when line 0 opens a block. */
function frontmatterEnd(lines: readonly string[]): number | undefined {
  if (lines[0]?.trim() !== "---") return undefined;
  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index]!.trim();
    if (line === "---" || line === "...") return index;
  }
  return undefined;
}

function frontmatterScalars(content: string): Map<string, string> {
  const lines = content.split("\n");
  const end = frontmatterEnd(lines);
  const values = new Map<string, string>();
  if (end === undefined) return values;
  for (const line of lines.slice(1, end)) {
    const match = /^([A-Za-z_][A-Za-z0-9_-]*):[ \t]*(.+?)[ \t]*$/u.exec(line);
    if (!match || values.has(match[1]!)) continue;
    const value = yamlScalar(match[2]!);
    if (value) values.set(match[1]!, value);
  }
  return values;
}

function declaredTemplate(value: string): string | undefined {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/gu, "-")
    .replace(/-(?:gfm|myst)$/u, "");
  return [...Object.keys(TEMPLATE_KEYWORDS), ...Object.keys(DECLARATION_ONLY)].find(
    (base) => base === normalized || declarationKeywords(base).includes(normalized),
  );
}

function count(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) kit.fail("invalid-value");
  return value as number;
}

function normalizeLineEndings(content: string): string {
  return content.replace(/\r\n?/gu, "\n");
}

function hasMarkdownH1(lines: readonly string[]): boolean {
  const fenced = fencedCodeLines(lines);
  return lines.some((line, index) => !fenced[index] && /^#\s+\S/u.test(line.trim()));
}

/**
 * MyST syntax selects the MyST template variant: a directive fence
 * (```{note} or :::{note}), a role such as {ref}`label`, or a `(label)=` target.
 */
function isMyst(content: string): boolean {
  return /^[ \t]*(?:```+|:::+)\{[A-Za-z][\w-]*\}|(?<!`)\{[a-z][\w:-]*\}`[^`\n]|^\([\w.-]+\)=[ \t]*$/mu.test(
    content,
  );
}

function yamlScalar(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      return String(JSON.parse(trimmed));
    } catch {
      return "";
    }
  }
  if (trimmed.length >= 2 && trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1).replaceAll("''", "'");
  }
  if (/^[|>[{&*!]/u.test(trimmed)) return "";
  return trimmed.replace(/[ \t]+#.*$/u, "");
}
