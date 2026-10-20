// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Content index asset limits (#1932 item 3). The caps are declared limits
 * (config/limits/contentIndex.yaml) a host can raise, and an asset past one is
 * left out of the index and named as a limitation instead of stopping it. A
 * run's workflow search reports each left-out asset on the run record.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  buildContentIndexV2,
  ContentIndexError,
  contentIndexAssetWarnings,
  contentIndexLimitations,
  describeContentIndexLimitation,
  resolveContentIndexLimits,
} from "../src/content-ir/index.js";
import type { ContentIndexV2, ContentIndexV3 } from "../src/content-ir/index.js";
import { sha256 } from "../src/content-ir/canonical.js";
import { buildContentIndexV3 } from "../src/content-ir/indexer.js";
import {
  collectRunLimitOverflowEvidence,
  mergeRunLimitOverflowEvidence,
  projectRunLimitOverflowLines,
} from "../src/operator/run-limit-overflow.js";
import type { RunRecord } from "../src/records/contracts.js";
import type { RepositoryWorkspace } from "../src/repository/workspace/contracts.js";
import { prepareRepositoryWorkspace } from "../src/repository/workspace/materialize.js";
import { LocalWorkflowSearchCoordinator } from "../src/search/local-workflow-coordinator.js";
import { WorkflowRunner } from "../src/workflow-execution/runner.js";
import { appendEvidenceWarnings } from "../src/workflow-execution/runner-evidence.js";
import { readyContextPreflight } from "./helpers.js";
import { commitFixture, initFixtureRepo } from "./helpers/git.js";
import { temporaryRoots } from "./helpers/temp.js";

const roots = temporaryRoots();

afterEach(() => {
  vi.unstubAllEnvs();
});

async function withWorkspace<T>(
  files: Record<string, string | Buffer>,
  use: (workspace: RepositoryWorkspace) => Promise<T>,
): Promise<T> {
  const source = await roots.create("docsfab-content-ir-asset-limits-");
  for (const [path, contents] of Object.entries(files)) {
    await mkdir(dirname(join(source, path)), { recursive: true });
    await writeFile(join(source, path), contents);
  }
  await initFixtureRepo(source, undefined, { branch: "main" });
  await commitFixture(source, "asset limit fixture");
  const workspace = await prepareRepositoryWorkspace(source, "HEAD");
  try {
    return await use(workspace);
  } finally {
    await workspace.dispose();
  }
}

async function workspaceIndex(files: Record<string, string | Buffer>): Promise<ContentIndexV2> {
  return withWorkspace(files, (workspace) => buildContentIndexV2({ workspace }));
}

function assetLinks(built: ContentIndexV2 | ContentIndexV3): number {
  return built.edges.filter((edge) => edge.kind === "asset-link").length;
}

/** What a left-out asset's limitation says, as `asset-too-large` under a 1,000-byte limit. */
const BIG_ASSET_SENTENCE =
  '"big.bin", linked from "index.md", is left out of the content index. content-index-max-asset-bytes-bound: 1200 exceeds contentIndex.maxAssetBytes = 1000 bytes. Raise contentIndex.maxAssetBytes with DOCSFAB_CONTENT_INDEX_MAX_ASSET_BYTES to index a larger asset. Until then the index leaves the asset out and names it. Follow the named remediation.';
/** `asset-bytes-exceeded` under a 1,500-byte total. */
const TOTAL_ASSET_SENTENCE =
  '"c.bin", linked from "index.md", is left out of the content index. content-index-max-total-asset-bytes-bound: 1800 exceeds contentIndex.maxTotalAssetBytes = 1500 bytes. Raise contentIndex.maxTotalAssetBytes with DOCSFAB_CONTENT_INDEX_MAX_TOTAL_ASSET_BYTES to index every linked asset. Until then the index leaves out each asset that would pass the total and names it. Follow the named remediation.';
/** `asset-count-exceeded` under a 3-asset count. */
const COUNT_ASSET_SENTENCE =
  '"e.bin", linked from "index.md", is left out of the content index. content-index-max-assets-bound: 4 exceeds contentIndex.maxAssets = 3 count. Raise contentIndex.maxAssets with DOCSFAB_CONTENT_INDEX_MAX_ASSETS to index every linked asset. Until then the index leaves out each asset past the bound and names it. Follow the named remediation.';

/**
 * One asset past each limit: under a 3-asset count, 1,000 bytes each, and
 * 1,500 bytes in total, a, b, and d fit (1,300 bytes in 3 assets), big.bin is
 * too large, c.bin passes the total, and e.bin passes the count.
 */
function stubThreeAssetLimits(): void {
  vi.stubEnv("DOCSFAB_CONTENT_INDEX_MAX_ASSETS", "3");
  vi.stubEnv("DOCSFAB_CONTENT_INDEX_MAX_ASSET_BYTES", "1000");
  vi.stubEnv("DOCSFAB_CONTENT_INDEX_MAX_TOTAL_ASSET_BYTES", "1500");
}
const THREE_ASSET_LIMIT_FILES: Readonly<Record<string, string | Buffer>> = {
  "index.md": [
    "# Assets",
    "",
    "[A](a.bin)",
    "[Big](big.bin)",
    "[B](b.bin)",
    "[C](c.bin)",
    "[D](d.bin)",
    "[E](e.bin)",
    "",
  ].join("\n"),
  // A second link to a left-out asset names it only once.
  "other.md": "# Other\n\n[Big again](big.bin)\n",
  "a.bin": Buffer.alloc(600, 1),
  "big.bin": Buffer.alloc(1200, 2),
  "b.bin": Buffer.alloc(600, 3),
  "c.bin": Buffer.alloc(600, 4),
  "d.bin": Buffer.alloc(100, 5),
  "e.bin": Buffer.alloc(100, 6),
};
const THREE_ASSET_WARNINGS = [BIG_ASSET_SENTENCE, TOTAL_ASSET_SENTENCE, COUNT_ASSET_SENTENCE].map(
  (sentence) => `content-index-asset-left-out: ${sentence}`,
);

/** A repository path of exactly `length` characters, in directories of 200. */
function pathOfLength(length: number, name: string): string {
  const file = `${name}.bin`;
  const segments: string[] = [];
  let remaining = length - file.length;
  while (remaining > 0) {
    // A directory of n characters takes n + 1 with its slash. Never leave
    // exactly 1, which no directory name can fill.
    let size = Math.min(200, remaining - 1);
    if (remaining - (size + 1) === 1) size -= 1;
    segments.push("d".repeat(size));
    remaining -= size + 1;
  }
  const result = [...segments, file].join("/");
  if (result.length !== length) throw new Error(`path is ${result.length}, not ${length}`);
  return result;
}

/** The fallback warning for a left-out asset whose full warning would pass 1,024 characters. */
function digestWarning(path: string, detail: string): string {
  return `content-index-asset-left-out: a linked asset whose path is too long to show here, with path SHA-256 ${sha256(path)}, is left out of the content index. ${detail}`;
}
const TOO_LARGE_DETAIL =
  "content-index-max-asset-bytes-bound: 1200 exceeds contentIndex.maxAssetBytes = 1000 bytes. Raise contentIndex.maxAssetBytes with DOCSFAB_CONTENT_INDEX_MAX_ASSET_BYTES to index a larger asset. Until then the index leaves the asset out and names it. Follow the named remediation.";

describe("content index asset limits", () => {
  it("indexes 300 linked images totalling 20 MiB with the default limits", async () => {
    const images = 300;
    const bytesEach = Math.ceil((20 * 1024 * 1024) / images);
    const files: Record<string, string | Buffer> = {};
    const links: string[] = [];
    for (let image = 0; image < images; image += 1) {
      files[`docs/img/shot-${image}.png`] = Buffer.alloc(bytesEach, image % 251);
      links.push(`![Shot ${image}](img/shot-${image}.png)`);
    }
    files["docs/index.md"] = `# Screenshots\n\n${links.join("\n")}\n`;
    const built = await workspaceIndex(files);
    expect(bytesEach * images).toBeGreaterThanOrEqual(20 * 1024 * 1024);
    expect(built.evidence.assetCount).toBe(images);
    expect(assetLinks(built)).toBe(images);
    expect(contentIndexLimitations(built)).toEqual([]);
  }, 120_000);

  it("names every asset past a limit and keeps indexing", async () => {
    stubThreeAssetLimits();
    const built = await workspaceIndex(THREE_ASSET_LIMIT_FILES);
    // a, b, and d fit: 1,300 bytes in 3 assets. A left-out asset adds no edge.
    expect(built.evidence.assetCount).toBe(3);
    expect(assetLinks(built)).toBe(3);
    expect(new Set(built.edges.map((edge) => edge.kind))).toEqual(
      new Set(["parent", "child", "asset-link"]),
    );
    const limitations = contentIndexLimitations(built);
    expect(
      limitations.map(({ path, reason, linkedFrom }) => ({ path, reason, linkedFrom })),
    ).toEqual([
      { path: "big.bin", reason: "asset-too-large", linkedFrom: "index.md" },
      { path: "c.bin", reason: "asset-bytes-exceeded", linkedFrom: "index.md" },
      { path: "e.bin", reason: "asset-count-exceeded", linkedFrom: "index.md" },
    ]);
    expect(limitations.map(describeContentIndexLimitation)).toEqual([
      BIG_ASSET_SENTENCE,
      TOTAL_ASSET_SENTENCE,
      COUNT_ASSET_SENTENCE,
    ]);
    // Each kind becomes its own run warning.
    expect(contentIndexAssetWarnings(built)).toEqual(THREE_ASSET_WARNINGS);
  }, 60_000);

  it("leaves an asset past a limit out of a V3 index by name", async () => {
    vi.stubEnv("DOCSFAB_CONTENT_INDEX_MAX_ASSET_BYTES", "1000");
    const built = await withWorkspace(
      {
        "index.md": "# Assets\n\n[Big](big.bin)\n[Small](small.bin)\n",
        "big.bin": Buffer.alloc(1200, 1),
        "small.bin": Buffer.alloc(100, 2),
      },
      (workspace) => buildContentIndexV3({ workspace }),
    );
    expect(built.evidence.assetCount).toBe(1);
    expect(assetLinks(built)).toBe(1);
    expect(contentIndexLimitations(built).map(describeContentIndexLimitation)).toEqual([
      BIG_ASSET_SENTENCE,
    ]);
  }, 60_000);

  it("keeps a run warning of exactly 1,024 characters whole and names a longer one by its path digest", async () => {
    vi.stubEnv("DOCSFAB_CONTENT_INDEX_MAX_ASSET_BYTES", "1000");
    // Characters of the full warning that are not the asset path.
    const overhead =
      `content-index-asset-left-out: ${BIG_ASSET_SENTENCE}`.length - "big.bin".length;
    const atBound = pathOfLength(1_024 - overhead, "at-bound");
    const pastBound = pathOfLength(1_025 - overhead, "past-bound");
    const built = await workspaceIndex({
      "index.md": `# Long\n\n[At](${atBound})\n[Past](${pastBound})\n`,
      [atBound]: Buffer.alloc(1200, 1),
      [pastBound]: Buffer.alloc(1200, 2),
    });
    const full = `content-index-asset-left-out: ${BIG_ASSET_SENTENCE.replace('"big.bin"', JSON.stringify(atBound))}`;
    expect(full).toHaveLength(1_024);
    expect(contentIndexAssetWarnings(built)).toEqual([
      full,
      digestWarning(pastBound, TOO_LARGE_DETAIL),
    ]);
  }, 60_000);

  it("keeps two and three left-out assets with too-long paths and equal observed values apart", async () => {
    vi.stubEnv("DOCSFAB_CONTENT_INDEX_MAX_ASSET_BYTES", "1000");
    const tooLarge = ["one", "two"].map((name) => pathOfLength(800, name));
    const twoBuilt = await workspaceIndex({
      "index.md": `# Long\n\n${tooLarge.map((path) => `[Big](${path})`).join("\n")}\n`,
      ...Object.fromEntries(tooLarge.map((path) => [path, Buffer.alloc(1200, 1)])),
    });
    // Both are 1,200 bytes against 1,000: the same detail, two warnings.
    expect(contentIndexAssetWarnings(twoBuilt)).toEqual(
      tooLarge.map((path) => digestWarning(path, TOO_LARGE_DETAIL)),
    );
    const twoRecord = {} as RunRecord;
    appendEvidenceWarnings(twoRecord, contentIndexAssetWarnings(twoBuilt));
    expect(twoRecord.evidenceWarnings).toHaveLength(2);

    vi.stubEnv("DOCSFAB_CONTENT_INDEX_MAX_ASSETS", "1");
    const counted = ["three", "four", "five"].map((name) => pathOfLength(800, name));
    const threeBuilt = await workspaceIndex({
      "index.md": `# Long\n\n[Small](small.bin)\n${counted.map((path) => `[More](${path})`).join("\n")}\n`,
      "small.bin": Buffer.alloc(10, 1),
      ...Object.fromEntries(counted.map((path) => [path, Buffer.alloc(10, 2)])),
    });
    // Each is the second asset against a count of 1: the same detail, three warnings.
    const countDetail =
      "content-index-max-assets-bound: 2 exceeds contentIndex.maxAssets = 1 count. Raise contentIndex.maxAssets with DOCSFAB_CONTENT_INDEX_MAX_ASSETS to index every linked asset. Until then the index leaves out each asset past the bound and names it. Follow the named remediation.";
    expect(contentIndexAssetWarnings(threeBuilt)).toEqual(
      counted.map((path) => digestWarning(path, countDetail)),
    );
    const threeRecord = {} as RunRecord;
    appendEvidenceWarnings(threeRecord, contentIndexAssetWarnings(threeBuilt));
    expect(threeRecord.evidenceWarnings).toHaveLength(3);
  }, 60_000);

  it("stops on a page past contentIndex.maxSourceBytes, naming the page, its size, and the limit", async () => {
    vi.stubEnv("DOCSFAB_CONTENT_INDEX_MAX_SOURCE_BYTES", "64");
    const page = `# Big\n\n${"x".repeat(91)}\n`;
    let error: unknown;
    try {
      await workspaceIndex({ "docs/big.md": page });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(ContentIndexError);
    expect(error).toMatchObject({
      code: "source-too-large",
      message: `docs/big.md is ${page.length} bytes. content-index-max-source-bytes-bound: ${page.length} exceeds contentIndex.maxSourceBytes = 64 bytes. Split the page, or raise contentIndex.maxSourceBytes with DOCSFAB_CONTENT_INDEX_MAX_SOURCE_BYTES, then rerun the same command. Follow the named remediation.`,
    });
  }, 60_000);

  it("indexes a page exactly at contentIndex.maxSourceBytes and stops on one a byte past it", async () => {
    vi.stubEnv("DOCSFAB_CONTENT_INDEX_MAX_SOURCE_BYTES", "64");
    const atLimit = `# At\n\n${"x".repeat(57)}\n`;
    expect(Buffer.byteLength(atLimit)).toBe(64);
    const built = await workspaceIndex({ "docs/at.md": atLimit });
    expect(built.evidence.documentCount).toBe(1);
    await expect(workspaceIndex({ "docs/past.md": `${atLimit}x` })).rejects.toMatchObject({
      code: "source-too-large",
      message: expect.stringMatching(
        /^docs\/past\.md is 65 bytes\. content-index-max-source-bytes-bound: 65 exceeds contentIndex\.maxSourceBytes = 64 bytes\./u,
      ),
    });
  }, 60_000);

  it("raises each limit with its host override, up to the declared maximum", () => {
    const defaults = resolveContentIndexLimits();
    expect({
      maxAssets: defaults.maxAssets.value,
      maxAssetBytes: defaults.maxAssetBytes.value,
      maxTotalAssetBytes: defaults.maxTotalAssetBytes.value,
      maxSourceBytes: defaults.maxSourceBytes.value,
    }).toEqual({
      maxAssets: 4096,
      maxAssetBytes: 64 * 1024 * 1024,
      maxTotalAssetBytes: 1024 * 1024 * 1024,
      maxSourceBytes: 4 * 1024 * 1024,
    });
    vi.stubEnv("DOCSFAB_CONTENT_INDEX_MAX_ASSETS", "8192");
    vi.stubEnv("DOCSFAB_CONTENT_INDEX_MAX_ASSET_BYTES", String(128 * 1024 * 1024));
    vi.stubEnv("DOCSFAB_CONTENT_INDEX_MAX_TOTAL_ASSET_BYTES", String(4 * 1024 * 1024 * 1024));
    vi.stubEnv("DOCSFAB_CONTENT_INDEX_MAX_SOURCE_BYTES", String(8 * 1024 * 1024));
    const raised = resolveContentIndexLimits();
    expect(raised.maxAssets).toMatchObject({ value: 8192, source: "host" });
    expect(raised.maxAssetBytes).toMatchObject({ value: 128 * 1024 * 1024, source: "host" });
    expect(raised.maxTotalAssetBytes).toMatchObject({
      value: 4 * 1024 * 1024 * 1024,
      source: "host",
    });
    expect(raised.maxSourceBytes).toMatchObject({ value: 8 * 1024 * 1024, source: "host" });
    vi.stubEnv("DOCSFAB_CONTENT_INDEX_MAX_ASSETS", "2000000");
    expect(() => resolveContentIndexLimits()).toThrow(
      "DOCSFAB_CONTENT_INDEX_MAX_ASSETS must be an integer between 1 and 1048576.",
    );
  });
});

describe("left-out assets on a run", () => {
  /** Runs one workflow through the real runner and governed search over the three-limit fixture. */
  async function runWithLeftOutAssets(
    workflow: "readiness" | "release-documentation-readiness",
  ): Promise<{ record: RunRecord; saved: RunRecord[] }> {
    stubThreeAssetLimits();
    return withWorkspace(
      {
        ...THREE_ASSET_LIMIT_FILES,
        // An anchor the index leaves out is a limitation, but not a left-out asset.
        "docs/emoji.md": "# Emoji\n\n## 🚀\n",
      },
      async (workspace) => {
        const saved: RunRecord[] = [];
        const runner = new WorkflowRunner({
          harness: { runStep: async () => ({ summary: "Readiness assessed." }) },
          store: { save: async (record) => void saved.push(structuredClone(record)) },
          repositoryScanner: {
            scan: async () => ({
              ruleSet: "test-v1",
              status: "passed",
              scannedFiles: 9,
              binaryFiles: 6,
              findings: [],
            }),
          },
          contextPreflight: readyContextPreflight,
          // The governed search builds the workspace inventory and its content index.
          workflowSearch: new LocalWorkflowSearchCoordinator({ workspace }),
          id: () => `run-asset-left-out-${workflow}`,
        });
        const record = await runner.run({
          workflow,
          workspacePath: workspace.path,
          // The release workflow binds the search to the workspace's own resolved source.
          repository: {
            sourcePath: workspace.sourcePath,
            requestedRevision: workspace.requestedRevision,
            revision: workspace.revision,
          },
          allowWrite: false,
          ...(workflow === "release-documentation-readiness"
            ? { releaseDefaultBranch: "main" }
            : {}),
        });
        return { record, saved };
      },
    );
  }

  function assetWarnings(record: RunRecord | undefined): string[] {
    return (record?.evidenceWarnings ?? []).filter((item) =>
      item.startsWith("content-index-asset-left-out:"),
    );
  }

  it("keeps each left-out asset on the run record and under LIMITATIONS, and the run succeeds", async () => {
    const { record, saved } = await runWithLeftOutAssets("readiness");
    expect(record.status).toBe("succeeded");
    // One warning for each limit kind, each named once.
    expect(assetWarnings(record)).toEqual(THREE_ASSET_WARNINGS);
    expect(assetWarnings(saved.at(-1))).toEqual(THREE_ASSET_WARNINGS);
    // The run summary, the JSON result, and `runs show` all project the
    // record's evidence through the same merge.
    expect(
      projectRunLimitOverflowLines(
        mergeRunLimitOverflowEvidence(collectRunLimitOverflowEvidence(record)),
      ),
    ).toEqual(THREE_ASSET_WARNINGS);
  }, 60_000);

  it("keeps each left-out asset on a release-documentation-readiness run record", async () => {
    const { record } = await runWithLeftOutAssets("release-documentation-readiness");
    expect({ status: record.status, error: record.error }).toEqual({
      status: "succeeded",
      error: undefined,
    });
    expect(assetWarnings(record)).toEqual(THREE_ASSET_WARNINGS);
  }, 60_000);
});
