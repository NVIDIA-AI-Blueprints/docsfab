#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Generate the "Inspect Operational Limits" doc tables from
 * `config/limits.catalog.json`, the mirror `check-limits.mjs` writes. It never
 * re-parses `config/limits.yaml` or its fragments.
 *
 * Each table is a whole generated file, `<TABLES_DIR>/<region id>.md`, that
 * its declared reference page includes with Fern's `<Markdown src>` snippet tag.
 * The pages themselves are prose only and generation never reads them, so a
 * prose edit to a page is not an input
 * or output of the limits product and does not select the runtime CI jobs;
 * an edit to a table file does. Each file keeps its `GENERATED:<id>`
 * start/end markers, in the MDX expression-comment form because Fern compiles
 * pages and snippets as MDX, where HTML comments fail.
 *
 * Usage:
 *   node scripts/docs-limits-table.mjs           # regenerate in place
 *   node scripts/docs-limits-table.mjs --check    # verify, no write, exit 1 on drift
 *   node scripts/docs-limits-table.mjs --check-includes # read-only page check for docs CI
 */
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const runtimeRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(runtimeRoot, "../..");

const referenceDir = "docs/reference/status-and-configuration";
/** The directory of generated table files, one per region; every file in it is generated. */
export const TABLES_DIR = "docs/reference/status-and-configuration/operational-limits-tables";
export const CATALOG_JSON_PATH = "config/limits.catalog.json";

/**
 * Row order and column shape for each generated table. `keyBy` selects the
 * first column: the catalog `name` (needed where rows have `override: null`)
 * or the `override` env name (the Slack tables, documented by env var).
 */
export const TABLE_REGIONS = Object.freeze([
  Object.freeze({
    id: "operational-limits-defaults",
    pagePath: `${referenceDir}/operational-limits.md`,
    header: Object.freeze(["Catalog Setting", "Default", "Applies To"]),
    keyBy: "name",
    names: Object.freeze([
      "compositionExecution.maxCumulativeInputTokens",
      "compositionExecution.maxCumulativeOutputTokens",
      "compositionExecution.timeoutMs",
      "compositionExecution.answerNowElapsedShareBasisPoints",
      "compositionExecution.answerPlan.defaultTokens",
      "compositionExecution.answerNowDecodeTokensPerSecond",
      "compositionExecution.answerNowTurnLatencyMs",
      "execution.readLoopRepeatStreak",
      "execution.readLoopWithheldReads",
      "execution.readLoopUnchangedReReads",
      "execution.readerSourceNominations",
      "checks.commandTimeoutMs",
      "checks.outputRetainedBytes",
      "checks.nativeCommandMax",
      "checks.credentialScanMaxEntries",
      "retry.maxRetries",
      "retry.maxTimeoutRetries",
      "retry.maxCutAnswerRetries",
      "retry.maxNoProgressRetries",
      "retry.maxTransportRetries",
      "retry.transportMaxDelayMs",
      "retry.transportMaxElapsedMs",
      "liveAgent.agentCausedRefusalRetries",
      "liveAgent.workflowContextMaxChars",
      "liveAgent.commandProcessStopMs",
      "liveAgent.commandOutputBytes",
      "liveAgent.sessionMaxAgeDays",
      "providerAttempt.maxAttemptsPerTurn",
      "providerAttempt.maxBlankAttemptsPerTurn",
      "providerAttempt.baseDelayMs",
      "providerAttempt.maxDelayMs",
      "providerAttempt.maxTotalDelayMs",
      "providerAttempt.maxThrottledAttemptsPerTurn",
      "providerAttempt.maxThrottledTotalDelayMs",
      "providerAttempt.maxPhysicalRequestsPerStep",
      "hostInvoker.contextPreflightBudgetMs",
      "contentIndex.maxAssets",
      "contentIndex.maxAssetBytes",
      "contentIndex.maxTotalAssetBytes",
      "contentIndex.maxSourceBytes",
      "technicalCorrection.proposalMaxBytes",
      "technicalCorrection.evidenceMaxBytes",
      "technicalCorrection.derivedResultMaxBytes",
      "recovery.serviceHistoryMaxHostJobs",
      "slackRoutes.documentMaxBytes",
      "slackRoutes.candidateMaxBytes",
      "slackRoutes.replacementCandidateMaxBytes",
      "slackRoutes.reasonMaxChars",
      "slackRoutes.replacementMaxRoutesPerProject",
      "context.localPacketInputShareBasisPoints",
      "context.corpusPacketInputShareBasisPoints",
      "context.packetFallbackInputTokens",
      "context.packetMaxDepth",
      "repository.trackedWriteAdmissionMaxBytes",
      "repository.evidenceGitOutputMaxBytes",
      "githubReview.bodyMaxBytes",
    ]),
  }),
  Object.freeze({
    id: "slack-message-settings",
    pagePath: `${referenceDir}/slack-output-limits.md`,
    header: Object.freeze(["Setting", "Default", "Behavior"]),
    keyBy: "override",
    names: Object.freeze([
      "host.slack.transportTextChars",
      "host.slack.liveAgentAnswerChunkBudget",
      "host.slack.liveAgentAnswerMaxChunks",
    ]),
  }),
  Object.freeze({
    id: "slack-question-settings",
    pagePath: `${referenceDir}/slack-output-limits.md`,
    header: Object.freeze(["Setting", "Default", "Behavior"]),
    keyBy: "override",
    names: Object.freeze(["host.slack.liveAgentTurnTextMaxBytes"]),
  }),
  Object.freeze({
    id: "slack-question-index-settings",
    pagePath: `${referenceDir}/slack-output-limits.md`,
    header: Object.freeze(["Setting", "Default", "Behavior"]),
    keyBy: "override",
    names: Object.freeze([
      "liveAgent.askIndexPages",
      "liveAgent.askIndexPageTextBytes",
      "liveAgent.askIndexTextBytes",
    ]),
  }),
  Object.freeze({
    id: "repository-text-index-settings",
    pagePath: `${referenceDir}/repository-text-index.md`,
    header: Object.freeze(["Setting", "Default", "Behavior"]),
    keyBy: "override",
    names: Object.freeze([
      "repository.inventoryTextMaxFileBytes",
      "repository.inventoryTextMaxTotalBytes",
    ]),
  }),
  Object.freeze({
    id: "artifact-and-run-record-settings",
    pagePath: `${referenceDir}/artifact-limits.md`,
    header: Object.freeze(["Setting", "Default", "Behavior"]),
    keyBy: "override",
    names: Object.freeze([
      "artifacts.maxObjectBytes",
      "runs.recordMaxBytes",
      "artifacts.hostedRetentionMaxObjects",
      "artifacts.hostedRetentionMaxTotalBytes",
      "artifacts.hostedRetentionManifestMaxBytes",
    ]),
  }),
  Object.freeze({
    id: "first-pass-settings",
    pagePath: `${referenceDir}/source-acquisition-limits.md`,
    header: Object.freeze(["Setting", "Default", "Behavior"]),
    keyBy: "override",
    names: Object.freeze([
      "firstPass.maxScannedFiles",
      "firstPass.maxSourceFiles",
      "firstPass.maxFileBytes",
      "firstPass.maxTotalReadBytes",
      "firstPass.maxSpans",
      "firstPass.assessmentInputWindowShare",
      "firstPass.maxPresentedBytes",
      "firstPass.evidenceExpansionModelTurns",
      "firstPass.modelInputTokensPerTurn",
      "firstPass.modelOutputTokensPerTurn",
      "firstPass.readDeadlineMs",
      "firstPass.modelDeadlineMs",
    ]),
  }),
  // Sealed first-pass bounds have no host override, so they key by name.
  Object.freeze({
    id: "first-pass-sealed-settings",
    pagePath: `${referenceDir}/source-acquisition-limits.md`,
    header: Object.freeze(["Catalog Setting", "Default", "Behavior"]),
    keyBy: "name",
    names: Object.freeze(["firstPass.maxObligationConditionChars"]),
  }),
  Object.freeze({
    id: "configured-credential-settings",
    pagePath: `${referenceDir}/credential-matching-limits.md`,
    header: Object.freeze(["Setting", "Default", "Behavior"]),
    keyBy: "override",
    names: Object.freeze([
      "secrets.configuredCredentialMinChars",
      "secrets.configuredCredentialFragmentChars",
      "secrets.configuredCredentialMinDistinctChars",
    ]),
  }),
]);

/** The generated file of one region, relative to the repository root. */
export function regionPath(region, tablesDir = TABLES_DIR) {
  return `${tablesDir}/${region.id}.md`;
}

/** Every generated table file, in region order. */
export const TABLE_PATHS = Object.freeze(TABLE_REGIONS.map((region) => regionPath(region)));

/** The prose pages that include generated tables; generation never reads them. */
export const PAGE_PATHS = Object.freeze([
  ...new Set(TABLE_REGIONS.map((region) => region.pagePath)),
]);

/** The `<Markdown src>` tag the page uses to include one region's table. */
export function regionInclude(region) {
  const pageDir = dirname(region.pagePath);
  if (!TABLES_DIR.startsWith(`${pageDir}/`)) {
    throw new Error(`docs-limits-table: ${TABLES_DIR} must sit beside ${region.pagePath}`);
  }
  return `<Markdown src="${regionPath(region).slice(pageDir.length + 1)}" />`;
}

/** Preserve line boundaries while excluding code and comments from directives. */
function activePageText(page) {
  let visible = "";
  let at = 0;
  const hideThrough = (end) => {
    visible += page.slice(at, end).replace(/[^\r\n]/gu, " ");
    at = end;
  };
  const frontmatter = /^(?:\uFEFF)?---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/u.exec(page);
  if (frontmatter) hideThrough(frontmatter[0].length);
  while (at < page.length) {
    if (at === 0 || page[at - 1] === "\n") {
      const lineEnd = page.indexOf("\n", at) < 0 ? page.length : page.indexOf("\n", at);
      const line = page.slice(at, lineEnd);
      // These widths are Markdown grammar, not execution limits.
      if (/^(?: {4}|\t)/u.test(line)) {
        hideThrough(lineEnd);
        continue;
      }
      const fence = /^ {0,3}(`{3,}|~{3,})(.*)$/u.exec(line);
      if (fence && !(fence[1][0] === "`" && fence[2].includes("`"))) {
        let end = page.length;
        for (let next = lineEnd + 1; next < page.length; ) {
          const finish = page.indexOf("\n", next) < 0 ? page.length : page.indexOf("\n", next);
          const closing = /^ {0,3}(`{3,}|~{3,})[ \t\r]*$/u.exec(page.slice(next, finish));
          if (closing && closing[1][0] === fence[1][0] && closing[1].length >= fence[1].length) {
            end = finish;
            break;
          }
          next = finish + 1;
        }
        hideThrough(end);
        continue;
      }
    }
    if (page[at] === "\\") {
      visible += page.slice(at, at + 2);
      at += 2;
      continue;
    }
    if (page.startsWith("<!--", at)) {
      const end = page.indexOf("-->", at + 4);
      hideThrough(end < 0 ? page.length : end + 3);
      continue;
    }
    const comment = /^\{\s*\/\*/u.exec(page.slice(at));
    if (comment) {
      const tail = page.slice(at + comment[0].length);
      const end = /\*\/\s*\}/u.exec(tail);
      hideThrough(end ? at + comment[0].length + end.index + end[0].length : page.length);
      continue;
    }
    if (page[at] === "`") {
      const ticks = /^`+/u.exec(page.slice(at))[0];
      const closing = new RegExp("(?<!`)" + ticks + "(?!`)", "gu");
      closing.lastIndex = at + ticks.length;
      const end = closing.exec(page);
      if (end && !/\n[ \t]*\r?\n/u.test(page.slice(at + ticks.length, end.index))) {
        hideThrough(end.index + ticks.length);
        continue;
      }
      visible += ticks;
      at += ticks.length;
      continue;
    }
    visible += page[at++];
  }
  return visible;
}

/** The prose pages are checked by their selected docs lane, without generation. */
export function checkPageIncludes() {
  const messages = [];
  const pages = new Map(
    PAGE_PATHS.map((path) => {
      const page = readRepo(path);
      if (page.includes("GENERATED:"))
        messages.push(`docs table include: ${path} must not hold generated regions`);
      return [
        path,
        activePageText(page)
          .split(/\r?\n/u)
          .map((line) => line.trim()),
      ];
    }),
  );
  for (const region of TABLE_REGIONS) {
    const include = regionInclude(region);
    const count = pages.get(region.pagePath).filter((line) => line === include).length;
    if (count !== 1)
      messages.push(
        `docs table include: ${region.id} expected exactly one active include in ${region.pagePath}; found ${count}`,
      );
    for (const [path, lines] of pages) {
      if (path !== region.pagePath && lines.includes(include))
        messages.push(
          `docs table include: ${region.id} belongs in ${region.pagePath}, not ${path}`,
        );
    }
  }
  return messages.length
    ? { status: "drifted", messages, message: messages.join("\n") }
    : { status: "current" };
}

function readRepo(path) {
  // `resolve`, not `join`, so an absolute test-only `docPath` stays absolute.
  return readFileSync(resolve(repoRoot, path), "utf8");
}

function writeRepo(path, contents) {
  const full = resolve(repoRoot, path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, contents);
}

/**
 * Load the generated catalog mirror, not the fragment sources, so a fragment
 * change reaches the docs only through the mirror.
 */
export function loadCatalog({ path = CATALOG_JSON_PATH } = {}) {
  const parsed = JSON.parse(readRepo(path));
  if (!parsed || parsed.kind !== "docsfab-limits-catalog" || !parsed.limits) {
    throw new Error(`${path}: expected a docsfab-limits-catalog document`);
  }
  return parsed.limits;
}

function escapeCell(value) {
  // A pipe or newline would break the Markdown table; refuse it by name.
  if (value.includes("|") || value.includes("\n")) {
    throw new Error(`docs-limits-table: cell value cannot contain '|' or a newline: ${value}`);
  }
  return value;
}

function rowKey(entry, name, keyBy) {
  if (keyBy === "name") return name;
  if (keyBy === "override") {
    if (!entry.override) {
      throw new Error(
        `docs-limits-table: ${name} has no override but region uses keyBy: "override"`,
      );
    }
    return entry.override;
  }
  throw new Error(`docs-limits-table: unknown keyBy ${keyBy}`);
}

/**
 * Render one region's table body (header row, separator row, and one row per
 * declared name, in declared order) as it appears between its markers: no
 * leading/trailing blank line.
 */
export function renderRegionTable(region, catalog) {
  const lines = [
    `| ${region.header.join(" | ")} |`,
    `| ${region.header.map(() => "---").join(" | ")} |`,
  ];
  for (const name of region.names) {
    const entry = catalog[name];
    if (!entry) {
      throw new Error(
        `docs-limits-table: catalog has no entry named ${name} (region ${region.id})`,
      );
    }
    if (typeof entry.docSummary !== "string") {
      throw new Error(
        `docs-limits-table: ${name} is missing docSummary; add it under config/limits/<owner>.yaml`,
      );
    }
    // `docValueCode` renders the bare `value` as inline code.
    const valueCell = entry.docValueCode ? `\`${entry.value}\`` : entry.docValue;
    if (typeof valueCell !== "string") {
      throw new Error(
        `docs-limits-table: ${name} is missing docValue (or docValueCode); add one under config/limits/<owner>.yaml`,
      );
    }
    const key = rowKey(entry, name, region.keyBy);
    lines.push(
      `| \`${escapeCell(key)}\` | ${escapeCell(valueCell)} | ${escapeCell(entry.docSummary)} |`,
    );
  }
  return lines.join("\n");
}

export function markerLine(id, edge) {
  if (edge === "start") {
    return `{/* GENERATED:${id} start - run \`npm run generate:limits\` from packages/runtime to refresh; do not hand-edit between these markers */}`;
  }
  return `{/* GENERATED:${id} end */}`;
}

/**
 * Render one region's whole generated file: the start marker, the table, the
 * end marker, and a final newline.
 */
export function renderRegionFile(region, catalog) {
  return `${markerLine(region.id, "start")}\n${renderRegionTable(region, catalog)}\n${markerLine(region.id, "end")}\n`;
}

function strayTableFiles(tablesDir, expected) {
  const full = resolve(repoRoot, tablesDir);
  if (!existsSync(full)) return [];
  const known = new Set(expected);
  return readdirSync(full)
    .map((name) => `${tablesDir}/${name}`)
    .filter((path) => !known.has(path))
    .sort();
}

export function runDocsLimitsTool(options = {}) {
  // check-limits `--check` passes its freshly rendered catalog, since the
  // on-disk mirror may be stale (reported separately).
  let catalog = options.catalog;
  if (!catalog) {
    const catalogPath = options.catalogPath ?? CATALOG_JSON_PATH;
    if (!existsSync(join(repoRoot, catalogPath))) {
      throw new Error(
        `docs-limits-table: ${catalogPath} does not exist; run npm run generate:limits`,
      );
    }
    catalog = loadCatalog({ path: catalogPath });
  }
  // `tablesDir` is a test-only override for exercising the real call site
  // against a scratch directory.
  const tablesDir = options.tablesDir ?? TABLES_DIR;
  // Render every region before touching disk, so a catalog refusal writes nothing.
  const files = TABLE_REGIONS.map((region) => ({
    path: regionPath(region, tablesDir),
    contents: renderRegionFile(region, catalog),
  }));
  const current = (path) => (existsSync(resolve(repoRoot, path)) ? readRepo(path) : null);
  const stray = strayTableFiles(
    tablesDir,
    files.map((file) => file.path),
  );
  if (options.checkOnly) {
    const messages = [];
    for (const { path, contents } of files) {
      const before = current(path);
      if (before === null) {
        messages.push(`docs table drift: ${path} is missing; run npm run generate:limits`);
      } else if (before !== contents) {
        messages.push(
          `docs table drift: ${path} does not match the catalog; run npm run generate:limits`,
        );
      }
    }
    for (const path of stray) {
      messages.push(
        `docs table drift: ${path} is not a generated limits table; run npm run generate:limits`,
      );
    }
    if (messages.length === 0) return { status: "current" };
    return { status: "drifted", messages, message: messages.join("\n") };
  }
  const changedPaths = [];
  for (const { path, contents } of files) {
    if (current(path) === contents) continue;
    writeRepo(path, contents);
    changedPaths.push(path);
  }
  // The directory holds generated tables only; a file for a retired region goes.
  for (const path of stray) {
    rmSync(resolve(repoRoot, path), { recursive: true, force: true });
    changedPaths.push(path);
  }
  return { status: "generated", changed: changedPaths.length > 0, changedPaths };
}

function isMain() {
  // Realpath both sides: `import.meta.url` is symlink-resolved but argv[1] is
  // not, and a mismatch would exit 0 having checked nothing.
  const real = (value) => {
    try {
      return realpathSync(value);
    } catch {
      return value;
    }
  };
  const invoked = process.argv[1] ? real(resolve(process.argv[1])) : "";
  return invoked === real(fileURLToPath(import.meta.url));
}

if (isMain()) {
  const checkOnly = process.argv.includes("--check");
  const includesOnly = process.argv.includes("--check-includes");
  try {
    const result = includesOnly ? checkPageIncludes() : runDocsLimitsTool({ checkOnly });
    if (result.status === "drifted") {
      console.error(`check:limits failed: ${result.message}`);
      process.exitCode = 1;
    } else if (result.status === "current") {
      console.log(
        includesOnly
          ? "Documentation pages include all generated limits tables."
          : `${TABLES_DIR} generated tables are current.`,
      );
    } else {
      console.log(
        result.changed
          ? `Updated generated tables: ${result.changedPaths.join(", ")}`
          : `${TABLES_DIR} already current.`,
      );
    }
  } catch (error) {
    console.error(`check:limits failed: ${error.message}`);
    process.exitCode = 1;
  }
}
