// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The repository inventory's text index under its declared limits (#1932):
 * `repository.inventoryTextMaxFileBytes` per file and
 * `repository.inventoryTextMaxTotalBytes` summed over files. Each holds at its
 * value, leaves one byte more out by path with the limit and the observed
 * value, admits it under a raised override, and reaches the run's LIMITATIONS
 * with the number of files left out and the setting to raise. A workspace
 * content index the inventory cannot build names its page and reason there too.
 */
import {
  mkdtemp,
  rename,
  rm,
  stat,
  symlink,
  truncate,
  unlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { LIMIT_DEFINITION_BY_NAME } from "../src/config/limits.generated.js";
import type { ResolveLimitsOptions } from "../src/config/limits.js";
import {
  isRepositoryInventoryTextLimitation,
  REPOSITORY_INVENTORY_INVALID_TEXT_LINE_CODE,
  REPOSITORY_INVENTORY_TEXT_MAX_FILE_BYTES_LIMIT,
  REPOSITORY_INVENTORY_TEXT_MAX_TOTAL_BYTES_LIMIT,
  repositoryInventoryLineCode,
} from "../src/config/repository-inventory-limit.js";
import { ContentIndexError } from "../src/content-ir/contracts.js";
import { buildContentIndexV2, contentIndexIncompleteWarning } from "../src/content-ir/indexer.js";
import {
  collectRunLimitOverflowEvidence,
  mergeRunLimitOverflowEvidence,
  projectRunLimitOverflowLines,
} from "../src/operator/run-limit-overflow.js";
import { formatRunSummary } from "../src/operator/run-summary.js";
import type { RunRecord } from "../src/records/contracts.js";
import {
  buildRepositoryDiscoveryInventory,
  decodeRepositoryDiscoveryInventory,
  formatRepositoryInventoryLimitations,
  invalidTextLine,
  runRepositoryBatchProbes,
  type RepositoryDiscoveryInventoryV1,
} from "../src/repository/inventory.js";
import type { RepositoryWorkspace } from "../src/repository/workspace/contracts.js";
import { prepareRepositoryWorkspace } from "../src/repository/workspace/materialize.js";
import { readTrackedRepositoryFilePrefix } from "../src/repository/workspace/tracked-read.js";
import { LocalWorkflowSearchCoordinator } from "../src/search/local-workflow-coordinator.js";
import { WorkflowRunner } from "../src/workflow-execution/runner.js";
import { instantiateWorkflowSearchTargets } from "../src/workflow-contracts/search.js";
import { getWorkflow } from "../src/workflow-registry/catalog.js";
import { commitFixture, initFixtureRepo } from "./helpers/git.js";

/** Git fixtures and workspace exports need headroom under parallel Vitest workers. */
const HEAVY_SUITE_TIMEOUT_MS = 180_000;
const FILE_LIMIT = LIMIT_DEFINITION_BY_NAME[REPOSITORY_INVENTORY_TEXT_MAX_FILE_BYTES_LIMIT]!;
const TOTAL_LIMIT = LIMIT_DEFINITION_BY_NAME[REPOSITORY_INVENTORY_TEXT_MAX_TOTAL_BYTES_LIMIT]!;
const PER_FILE = 4_096;
const LEFT_OUT = "the inventory records each by path.";
const temporary: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

/** Exactly `bytes` bytes of binary content: a NUL byte inside the first 8,000 bytes. */
function binaryOf(bytes: number): Buffer {
  const content = Buffer.alloc(bytes, 0x41);
  content[16] = 0;
  return content;
}

/** Exactly `bytes` bytes of ASCII text that starts with `token`. */
function textOf(token: string, bytes: number): string {
  return `${token}\n${"a".repeat(bytes - token.length - 1)}`;
}

async function repositoryWith(files: Record<string, string | Buffer>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "docsfab-inventory-text-"));
  temporary.push(root);
  await initFixtureRepo(root, files, { message: "text index fixture" });
  return root;
}

function limitsWith(environment: Record<string, string>): ResolveLimitsOptions {
  return { environment, hostFile: null };
}

async function inventoryOf(root: string, limits?: ResolveLimitsOptions) {
  const workspace = await prepareRepositoryWorkspace(root, "HEAD");
  const lines: string[] = [];
  try {
    const inventory = await buildRepositoryDiscoveryInventory({
      workspace,
      ...(limits ? { limits } : {}),
      recordWarning: (line) => lines.push(line),
    });
    return { inventory, lines, found: literalFinder(inventory, workspace) };
  } finally {
    await workspace.dispose();
  }
}

/** Whether the text index holds `token`, through the inventory's own literal-text probe. */
function literalFinder(inventory: RepositoryDiscoveryInventoryV1, workspace: RepositoryWorkspace) {
  const target = instantiateWorkflowSearchTargets(getWorkflow("readiness").steps[0]!.search!, {
    identitySha256: "a".repeat(64),
    revision: workspace.revision,
  })[0]!;
  return (token: string): boolean =>
    runRepositoryBatchProbes({
      inventory,
      target,
      probes: [{ id: "token", question: { kind: "literal-text", value: token } }],
    }).results[0]!.disposition === "found";
}

function textLimitFailures(inventory: RepositoryDiscoveryInventoryV1) {
  return inventory.failures.filter((failure) => failure.category === "text-index-limit-exceeded");
}

describe("repository.inventoryTextMaxFileBytes", { timeout: HEAVY_SUITE_TIMEOUT_MS }, () => {
  it("indexes a file at the limit and leaves one byte more out, naming its size and the setting", async () => {
    const root = await repositoryWith({
      "notes/at-limit.txt": textOf("AT_LIMIT_TOKEN", PER_FILE),
      "notes/over-limit.txt": textOf("OVER_LIMIT_TOKEN", PER_FILE + 1),
    });
    const limits = limitsWith({ [FILE_LIMIT.override!]: String(PER_FILE) });
    const { inventory, lines, found } = await inventoryOf(root, limits);

    expect(found("AT_LIMIT_TOKEN")).toBe(true);
    expect(found("OVER_LIMIT_TOKEN")).toBe(false);
    expect(textLimitFailures(inventory)).toEqual([
      expect.objectContaining({
        path: "notes/over-limit.txt",
        affects: ["text"],
        overflow: { limitName: FILE_LIMIT.name, observed: PER_FILE + 1 },
      }),
    ]);
    const line = `${FILE_LIMIT.refusal}: ${PER_FILE + 1} exceeds ${FILE_LIMIT.name} = ${PER_FILE} bytes. ${FILE_LIMIT.remediation} Follow the named remediation. 1 tracked file was left out of the repository text index; ${LEFT_OUT}`;
    expect(lines).toEqual([line]);
    expect(line).toContain(`Raise ${FILE_LIMIT.override}`);
    expect(formatRepositoryInventoryLimitations(inventory, limits)).toEqual([line]);
    // The recorded failure survives the sealed inventory decode.
    expect(decodeRepositoryDiscoveryInventory(structuredClone(inventory))).toEqual(inventory);

    const raised = await inventoryOf(
      root,
      limitsWith({ [FILE_LIMIT.override!]: String(PER_FILE + 1) }),
    );
    expect(raised.found("OVER_LIMIT_TOKEN")).toBe(true);
    expect(textLimitFailures(raised.inventory)).toEqual([]);
    expect(raised.lines).toEqual([]);
  });

  it("indexes a file larger than the former 1 MiB literal at the default", async () => {
    const root = await repositoryWith({
      "reference/openapi.json": textOf("GENERATED_SPEC_TOKEN", 3 * 1024 * 1024),
    });
    const { inventory, lines, found } = await inventoryOf(root);
    expect(FILE_LIMIT.value).toBe(8 * 1024 * 1024);
    expect(found("GENERATED_SPEC_TOKEN")).toBe(true);
    expect(textLimitFailures(inventory)).toEqual([]);
    expect(lines).toEqual([]);
  });

  it("excludes video and audio by extension without reading them, so no limit counts them", async () => {
    const root = await repositoryWith({
      "media/launch.mp4": Buffer.alloc(PER_FILE * 4, 7),
      "media/narration.mp3": Buffer.alloc(PER_FILE * 4, 7),
      "notes/readme.txt": textOf("NOTES_TOKEN", 64),
    });
    const { inventory, lines, found } = await inventoryOf(
      root,
      limitsWith({ [FILE_LIMIT.override!]: String(PER_FILE) }),
    );
    expect(found("NOTES_TOKEN")).toBe(true);
    expect(
      inventory.failures
        .filter((failure) => failure.category === "unsupported-text-format")
        .map((failure) => failure.path),
    ).toEqual(["media/launch.mp4", "media/narration.mp3"]);
    expect(inventory.coverage.text).toMatchObject({ indexedCount: 1, excludedCount: 2 });
    expect(textLimitFailures(inventory)).toEqual([]);
    expect(lines).toEqual([]);
  });
});

describe("repository.inventoryTextMaxTotalBytes", { timeout: HEAVY_SUITE_TIMEOUT_MS }, () => {
  const FIRST = 3_000;
  const SECOND = 2_000;

  it("holds the total at its value and leaves one byte more out, naming the total the index needed", async () => {
    const root = await repositoryWith({
      "a-first.txt": textOf("FIRST_TOKEN", FIRST),
      "b-second.txt": textOf("SECOND_TOKEN", SECOND),
    });
    const atLimit = await inventoryOf(
      root,
      limitsWith({ [TOTAL_LIMIT.override!]: String(FIRST + SECOND) }),
    );
    expect(atLimit.inventory.files.map((file) => file.path)).toEqual([
      "a-first.txt",
      "b-second.txt",
    ]);
    expect(atLimit.found("SECOND_TOKEN")).toBe(true);
    expect(textLimitFailures(atLimit.inventory)).toEqual([]);
    expect(atLimit.lines).toEqual([]);

    const limits = limitsWith({ [TOTAL_LIMIT.override!]: String(FIRST + SECOND - 1) });
    const past = await inventoryOf(root, limits);
    expect(past.found("FIRST_TOKEN")).toBe(true);
    expect(past.found("SECOND_TOKEN")).toBe(false);
    expect(textLimitFailures(past.inventory)).toEqual([
      expect.objectContaining({
        path: "b-second.txt",
        overflow: { limitName: TOTAL_LIMIT.name, observed: FIRST + SECOND },
      }),
    ]);
    const line = `${TOTAL_LIMIT.refusal}: ${FIRST + SECOND} exceeds ${TOTAL_LIMIT.name} = ${FIRST + SECOND - 1} bytes. ${TOTAL_LIMIT.remediation} Follow the named remediation. 1 tracked file was left out of the repository text index; ${LEFT_OUT}`;
    expect(past.lines).toEqual([line]);
    expect(line).toContain(`Raise ${TOTAL_LIMIT.override}`);
    expect(formatRepositoryInventoryLimitations(past.inventory, limits)).toEqual([line]);
  });

  it("counts every file it leaves out in one line per limit", async () => {
    const root = await repositoryWith({
      "a-first.txt": textOf("FIRST_TOKEN", FIRST),
      "b-big.txt": textOf("BIG_TOKEN", PER_FILE + 10),
      "c-second.txt": textOf("SECOND_TOKEN", SECOND),
      "d-third.txt": textOf("THIRD_TOKEN", SECOND),
    });
    const { inventory, lines } = await inventoryOf(
      root,
      limitsWith({
        [FILE_LIMIT.override!]: String(PER_FILE),
        [TOTAL_LIMIT.override!]: String(FIRST),
      }),
    );
    expect(textLimitFailures(inventory).map((failure) => failure.path)).toEqual([
      "b-big.txt",
      "c-second.txt",
      "d-third.txt",
    ]);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(
      new RegExp(
        `^${FILE_LIMIT.refusal}: ${PER_FILE + 10} exceeds .* 1 tracked file was left out of the repository text index;`,
        "u",
      ),
    );
    expect(lines[1]).toMatch(
      new RegExp(
        `^${TOTAL_LIMIT.refusal}: ${FIRST + 2 * SECOND} exceeds .* 2 tracked files were left out of the repository text index;`,
        "u",
      ),
    );
    expect(lines.every(isRepositoryInventoryTextLimitation)).toBe(true);
    expect(lines.every((line) => line.length <= 1_024)).toBe(true);
  });
});

describe("text index and content index lines on the run (#1932)", {
  timeout: HEAVY_SUITE_TIMEOUT_MS,
}, () => {
  it("records the text index and invalid-text lines through governed search and prints them in LIMITATIONS", async () => {
    const latin1 = Buffer.from([...Buffer.from("caf"), 0xe9, 0x0a]);
    const root = await repositoryWith({
      "README.md": "# Product\n",
      "legacy/notes.txt": latin1,
      "legacy/release.txt": latin1,
      "notes/over-limit.txt": textOf("OVER_LIMIT_TOKEN", PER_FILE + 1),
    });
    const workspace = await prepareRepositoryWorkspace(root, "HEAD");
    try {
      vi.stubEnv(FILE_LIMIT.override!, String(PER_FILE));
      const record = await runReadinessSearch(workspace);
      const line = `${FILE_LIMIT.refusal}: ${PER_FILE + 1} exceeds ${FILE_LIMIT.name} = ${PER_FILE} bytes. ${FILE_LIMIT.remediation} Follow the named remediation. 1 tracked file was left out of the repository text index; ${LEFT_OUT}`;
      const invalid = `${REPOSITORY_INVENTORY_INVALID_TEXT_LINE_CODE}: 2 tracked files were left out of the repository text index because they are not UTF-8 text, for example "legacy/notes.txt", "legacy/release.txt"; the inventory records each by path. Convert a file to UTF-8 to make it searchable.`;
      expect(record.evidenceWarnings).toEqual([line, invalid]);
      expect(projectRunLimitOverflowLines(collectRunLimitOverflowEvidence(record))).toEqual([
        line,
        invalid,
      ]);
      const summary = formatRunSummary({
        record,
        recordPath: "run.json",
        exitCode: 0,
        repositoryPath: root,
      }).join("\n");
      expect(summary).toContain("LIMITATIONS");
      expect(summary).toContain(line);
      expect(summary).toContain(invalid);
    } finally {
      await workspace.dispose();
    }
  });

  it("names the page and the reason when the content index cannot be built", async () => {
    const body = Buffer.from("# Operator\n\nInstall the operator.\n");
    const offset = body.length;
    const root = await repositoryWith({
      "README.md": "# Product\n",
      "docs/operator.md": Buffer.concat([body, Buffer.from([0]), Buffer.from("tail\n")]),
    });
    const workspace = await prepareRepositoryWorkspace(root, "HEAD");
    const sentence = `Content index document source "docs/operator.md" is not strict UTF-8 text: it holds a NUL byte at byte offset ${offset}.`;
    const warning = `content-index-incomplete: ${sentence} Governed search continues without the content index, and the probes that need it report local-index-incomplete. Fix what the sentence names, then rerun the same command.`;
    try {
      await expect(buildContentIndexV2({ workspace })).rejects.toMatchObject({
        code: "invalid-document-encoding",
        message: sentence,
        sourcePath: "docs/operator.md",
      });
      const lines: string[] = [];
      const inventory = await buildRepositoryDiscoveryInventory({
        workspace,
        recordWarning: (line) => lines.push(line),
      });
      expect(inventory.failures).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            category: "content-index-incomplete",
            path: "docs/operator.md",
          }),
        ]),
      );
      expect(lines).toEqual([warning]);
      expect(formatRepositoryInventoryLimitations(inventory)).toContain(
        'repository-inventory-content-index-incomplete ("docs/operator.md")',
      );

      const record = await runReadinessSearch(workspace);
      expect(record.evidenceWarnings).toEqual([warning]);
      const limitations = projectRunLimitOverflowLines(collectRunLimitOverflowEvidence(record));
      expect(limitations).toEqual([warning]);
    } finally {
      await workspace.dispose();
    }
  });

  it("names invalid UTF-8 as its own reason", async () => {
    const root = await repositoryWith({
      "README.md": "# Product\n",
      "docs/legacy.md": Buffer.from([0x23, 0x20, 0xff, 0xfe, 0x0a]),
    });
    const workspace = await prepareRepositoryWorkspace(root, "HEAD");
    try {
      await expect(buildContentIndexV2({ workspace })).rejects.toMatchObject({
        code: "invalid-document-encoding",
        message:
          'Content index document source "docs/legacy.md" is not strict UTF-8 text: it is not valid UTF-8.',
      });
    } finally {
      await workspace.dispose();
    }
  });

  it("escapes control characters in the page path and drops a path too long to keep", () => {
    const tabbed = new ContentIndexError(
      "invalid-document-encoding",
      'Content index document source "docs/tab\\tname.md" is not strict UTF-8 text: it is not valid UTF-8.',
      { sourcePath: "docs/tab\tname.md" },
    );
    const raw = new ContentIndexError(
      "broken-internal-target",
      "Broken target in docs/a\u0007b.md.",
    );
    expect(contentIndexIncompleteWarning(tabbed)).toContain('"docs/tab\\tname.md"');
    expect(contentIndexIncompleteWarning(raw)).toContain("docs/a\\u{7}b.md");
    for (const line of [tabbed, raw].map(contentIndexIncompleteWarning)) {
      expect(line).not.toMatch(/[\u0000-\u001f\u007f]/u);
    }
    const long = new ContentIndexError(
      "invalid-document-encoding",
      `Content index document source "${"d".repeat(1_100)}.md" is not strict UTF-8 text: it is not valid UTF-8.`,
    );
    const kept = contentIndexIncompleteWarning(long);
    expect(kept.length).toBeLessThanOrEqual(1_024);
    expect(kept).toContain("invalid-document-encoding");
    expect(kept).not.toContain("d".repeat(100));
  });

  it("keeps the line a run recorded over one recomputed from its kept inventory under a later limit", async () => {
    const root = await repositoryWith({
      "notes/over-limit.txt": textOf("OVER_LIMIT_TOKEN", PER_FILE + 1),
    });
    const { inventory, lines } = await inventoryOf(
      root,
      limitsWith({ [FILE_LIMIT.override!]: String(PER_FILE) }),
    );
    const later = limitsWith({ [FILE_LIMIT.override!]: String(PER_FILE - 1) });
    const recomputed = formatRepositoryInventoryLimitations(inventory, later);
    expect(recomputed[0]).toContain(`= ${PER_FILE - 1} bytes.`);
    expect(
      projectRunLimitOverflowLines(
        mergeRunLimitOverflowEvidence({ inventory, inventoryLimitations: lines, limits: later }),
      ),
    ).toEqual(lines);
  });
});

async function runReadinessSearch(workspace: RepositoryWorkspace): Promise<RunRecord> {
  let tick = 0;
  const runner = new WorkflowRunner({
    harness: {
      async runStep(input) {
        return { summary: input.searchEvidence?.evidenceSha256 ?? "missing", outcome: "succeeded" };
      },
    },
    store: { async save() {} },
    repositoryScanner: {
      async scan() {
        return {
          ruleSet: "text-index-fixture",
          status: "passed",
          scannedFiles: 1,
          binaryFiles: 0,
          findings: [],
        };
      },
    },
    contextPreflight: {
      async preflight() {
        return { status: "unnecessary", reason: "target-not-applicable" };
      },
    },
    workflowSearch: new LocalWorkflowSearchCoordinator({ workspace }),
    id: () => "text-index-run",
    now: () => new Date(Date.UTC(2026, 9, 6, 0, 0, tick++)),
  });
  return runner.run({
    workflow: "readiness",
    workspacePath: workspace.path,
    repository: {
      sourcePath: workspace.sourcePath,
      requestedRevision: workspace.requestedRevision,
      revision: workspace.revision,
    },
    allowWrite: false,
  });
}

describe("a deterministic inventory over several unreadable pages (#1932)", {
  timeout: HEAVY_SUITE_TIMEOUT_MS,
}, () => {
  it("names the first unreadable page in path order on every build, so the digest is stable", async () => {
    // The first page in path order is the largest, so it is the last read to
    // fail: refusing in completion order would name another page.
    const root = await repositoryWith({
      "README.md": "# Product\n",
      "docs/a-large.md": Buffer.concat([
        Buffer.from(`# Large\n\n${"Body text. ".repeat(190_000)}\n`),
        Buffer.from([0]),
      ]),
      "docs/m-legacy.md": Buffer.from([0x23, 0x20, 0xe9, 0x0a]),
      "docs/z-small.md": Buffer.from([0x23, 0x20, 0x00, 0x0a]),
    });
    const workspace = await prepareRepositoryWorkspace(root, "HEAD");
    try {
      const named = new Set<string>();
      const digests = new Set<string>();
      for (let build = 0; build < 4; build += 1) {
        const error = await buildContentIndexV2({ workspace }).then(
          () => undefined,
          (refusal: unknown) => refusal as ContentIndexError,
        );
        named.add(`${error?.code}:${error?.sourcePath}`);
        const inventory = await buildRepositoryDiscoveryInventory({ workspace });
        digests.add(inventory.inventorySha256);
        expect(inventory.failures).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              category: "content-index-incomplete",
              path: "docs/a-large.md",
            }),
          ]),
        );
      }
      expect([...named]).toEqual(["invalid-document-encoding:docs/a-large.md"]);
      expect(digests.size).toBe(1);
    } finally {
      await workspace.dispose();
    }
  });
});

describe("binary content and other encodings in the text index (#1932)", {
  timeout: HEAVY_SUITE_TIMEOUT_MS,
}, () => {
  it("excludes binary content past the per-file limit, and still after the limit is raised", async () => {
    const root = await repositoryWith({
      "models/weights.onnx": binaryOf(PER_FILE + 100),
      "notes/large-notes.txt": textOf("LARGE_NOTES_TOKEN", PER_FILE + 1),
    });
    const lowered = await inventoryOf(
      root,
      limitsWith({ [FILE_LIMIT.override!]: String(PER_FILE) }),
    );
    expect(textLimitFailures(lowered.inventory).map((failure) => failure.path)).toEqual([
      "notes/large-notes.txt",
    ]);
    expect(
      lowered.inventory.failures
        .filter((failure) => failure.category === "unsupported-text-format")
        .map((failure) => failure.path),
    ).toEqual(["models/weights.onnx"]);
    expect(lowered.inventory.coverage.text).toMatchObject({ excludedCount: 1, omittedCount: 1 });
    expect(lowered.lines).toHaveLength(1);
    expect(lowered.lines[0]).toMatch(
      new RegExp(
        `^${FILE_LIMIT.refusal}: ${PER_FILE + 1} exceeds .* 1 tracked file was left out`,
        "u",
      ),
    );

    const raised = await inventoryOf(
      root,
      limitsWith({ [FILE_LIMIT.override!]: String(1024 * 1024) }),
    );
    expect(raised.found("LARGE_NOTES_TOKEN")).toBe(true);
    expect(
      raised.inventory.failures
        .filter((failure) => failure.path === "models/weights.onnx")
        .map((failure) => failure.category),
    ).toEqual(["unsupported-text-format"]);
    expect(raised.inventory.coverage.text).toMatchObject({ excludedCount: 1, omittedCount: 0 });
    expect(raised.lines).toEqual([]);
  });

  it("excludes binary content within the limits and past the total, never counting it as text", async () => {
    const root = await repositoryWith({
      "a-notes.txt": textOf("NOTES_TOKEN", 3_000),
      "b-table.f32": binaryOf(500),
      "c-archive.gz": binaryOf(4_000),
    });
    const { inventory, lines } = await inventoryOf(
      root,
      limitsWith({ [TOTAL_LIMIT.override!]: String(3_000 + 600) }),
    );
    expect(
      inventory.failures
        .filter((failure) => failure.category === "unsupported-text-format")
        .map((failure) => failure.path),
    ).toEqual(["b-table.f32", "c-archive.gz"]);
    expect(textLimitFailures(inventory)).toEqual([]);
    expect(
      inventory.failures.filter((failure) => failure.category === "invalid-text-input"),
    ).toEqual([]);
    expect(inventory.coverage.text).toMatchObject({
      indexedCount: 1,
      excludedCount: 2,
      omittedCount: 0,
    });
    expect(lines).toEqual([]);
  });

  it("counts text in another encoding in LIMITATIONS and names up to three of the files", async () => {
    const latin1 = (word: string) => Buffer.from([...Buffer.from(`${word} caf`), 0xe9, 0x0a]);
    const root = await repositoryWith({
      "legacy/a.txt": latin1("alpha"),
      "legacy/b.txt": latin1("bravo"),
      "legacy/c.txt": latin1("charlie"),
      "legacy/d.txt": latin1("delta"),
      "notes/readme.txt": textOf("NOTES_TOKEN", 64),
    });
    const { inventory, lines } = await inventoryOf(root);
    const line = `${REPOSITORY_INVENTORY_INVALID_TEXT_LINE_CODE}: 4 tracked files were left out of the repository text index because they are not UTF-8 text, for example "legacy/a.txt", "legacy/b.txt", "legacy/c.txt"; the inventory records each by path. Convert a file to UTF-8 to make it searchable.`;
    expect(lines).toEqual([line]);
    expect(formatRepositoryInventoryLimitations(inventory)).toEqual([line]);
    expect(repositoryInventoryLineCode(line)).toBe(REPOSITORY_INVENTORY_INVALID_TEXT_LINE_CODE);
  });

  it("keeps the invalid-text line within 1,024 characters by naming fewer files", async () => {
    const deep = (name: string) => `${"d".repeat(200)}/${name}${"e".repeat(190)}.txt`;
    const latin1 = Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]);
    const root = await repositoryWith({
      [deep("a")]: latin1,
      [deep("b")]: latin1,
      [deep("c")]: latin1,
    });
    const { inventory } = await inventoryOf(root);
    const line = invalidTextLine(inventory)!;
    expect(line.length).toBeLessThanOrEqual(1_024);
    expect(line).toMatch(
      /^repository-inventory-invalid-text-input: 3 tracked files were left out/u,
    );
    expect(line).toContain(`"${deep("a")}"`);
    expect(line).not.toContain(`"${deep("c")}"`);
  });
});

describe("text index lines name the right value once per limit (#1932)", {
  timeout: HEAVY_SUITE_TIMEOUT_MS,
}, () => {
  it("names the largest left-out file and gives each limit one line however many files it left out", async () => {
    const root = await repositoryWith({
      "a-over.txt": textOf("A_TOKEN", PER_FILE + 5),
      "b-largest.txt": textOf("B_TOKEN", PER_FILE + 50),
      "c-over.txt": textOf("C_TOKEN", PER_FILE + 20),
      "d-first.txt": textOf("D_TOKEN", 2_000),
      "e-second.txt": textOf("E_TOKEN", 1_500),
      "f-third.txt": textOf("F_TOKEN", 1_000),
    });
    const limits = limitsWith({
      [FILE_LIMIT.override!]: String(PER_FILE),
      [TOTAL_LIMIT.override!]: String(2_000),
    });
    const { inventory, lines } = await inventoryOf(root, limits);
    const fileLine = `${FILE_LIMIT.refusal}: ${PER_FILE + 50} exceeds ${FILE_LIMIT.name} = ${PER_FILE} bytes. ${FILE_LIMIT.remediation} Follow the named remediation. 3 tracked files were left out of the repository text index; ${LEFT_OUT}`;
    const totalLine = `${TOTAL_LIMIT.refusal}: ${2_000 + 1_500 + 1_000} exceeds ${TOTAL_LIMIT.name} = 2000 bytes. ${TOTAL_LIMIT.remediation} Follow the named remediation. 2 tracked files were left out of the repository text index; ${LEFT_OUT}`;
    expect(lines).toEqual([fileLine, totalLine]);
    expect(formatRepositoryInventoryLimitations(inventory, limits)).toEqual([fileLine, totalLine]);
  });
});

describe("content index refusal text (#1932)", { timeout: HEAVY_SUITE_TIMEOUT_MS }, () => {
  it("keeps the whole warning at exactly 1,024 characters and drops the path at 1,025", () => {
    const fixed = contentIndexIncompleteWarning(
      new ContentIndexError("invalid-document-encoding", ""),
    ).length;
    const atBound = contentIndexIncompleteWarning(
      new ContentIndexError("invalid-document-encoding", "m".repeat(1_024 - fixed)),
    );
    expect(atBound).toHaveLength(1_024);
    expect(atBound).toContain("m".repeat(1_024 - fixed));
    const pastBound = contentIndexIncompleteWarning(
      new ContentIndexError("invalid-document-encoding", "m".repeat(1_025 - fixed)),
    );
    expect(pastBound).not.toContain("mmmm");
    expect(pastBound).toContain("invalid-document-encoding at a page whose path is too long");
  });

  it("escapes the page path in the refusal, the recomputed line, and keeps the recorded line over it", async () => {
    const page = "docs/zero\u200bwidth.md";
    const root = await repositoryWith({
      "README.md": "# Product\n",
      [page]: Buffer.from([0x23, 0x20, 0x00, 0x0a]),
    });
    const workspace = await prepareRepositoryWorkspace(root, "HEAD");
    try {
      const refusal = (await buildContentIndexV2({ workspace }).then(
        () => undefined,
        (error: unknown) => error,
      )) as ContentIndexError;
      expect(refusal.sourcePath).toBe(page);
      expect(refusal.message).toBe(
        'Content index document source "docs/zero\\u{200b}width.md" is not strict UTF-8 text: it holds a NUL byte at byte offset 2.',
      );
      expect(refusal.message).not.toContain("\u200b");

      const lines: string[] = [];
      const inventory = await buildRepositoryDiscoveryInventory({
        workspace,
        recordWarning: (line) => lines.push(line),
      });
      const recomputed =
        'repository-inventory-content-index-incomplete ("docs/zero\\u{200b}width.md")';
      expect(formatRepositoryInventoryLimitations(inventory)).toContain(recomputed);
      expect(projectRunLimitOverflowLines(mergeRunLimitOverflowEvidence({ inventory }))).toContain(
        recomputed,
      );
      const recorded = lines.filter((line) => line.startsWith("content-index-incomplete: "));
      expect(recorded).toHaveLength(1);
      const projected = projectRunLimitOverflowLines(
        mergeRunLimitOverflowEvidence({ inventory, contentIndexIncompleteWarnings: recorded }),
      );
      expect(projected).toContain(recorded[0]);
      expect(projected.some((line) => line.startsWith("repository-inventory-content-index"))).toBe(
        false,
      );
    } finally {
      await workspace.dispose();
    }
  });
});

describe("the tracked prefix read behind binary sniffing (#1932)", {
  timeout: HEAVY_SUITE_TIMEOUT_MS,
}, () => {
  it("refuses by code what the full read refuses, and returns at most the requested bytes", async () => {
    const big = Buffer.from(textOf("PREFIX_TOKEN", 20_000));
    const root = await repositoryWith({
      "README.md": "# Product\n",
      "big.txt": big,
      "rewrite.md": "original content\n",
      "rewrite-mtime.md": "original content\n",
      "truncate.md": "a longer original body\n",
      "swap.md": "# Swap\n",
      "sub/page.md": "# Page\n",
    });
    await symlink("README.md", join(root, "link.md"));
    await commitFixture(root, "tracked symlink");
    const workspace = await prepareRepositoryWorkspace(root, "HEAD");
    const read = (path: string, maxBytes = 8_000) =>
      readTrackedRepositoryFilePrefix(workspace, path, maxBytes);
    const exported = (path: string) => join(workspace.path, ...path.split("/"));
    try {
      expect(await read("big.txt")).toEqual(big.subarray(0, 8_000));
      expect((await read("big.txt", 0)).byteLength).toBe(0);
      expect(await read("README.md")).toEqual(Buffer.from("# Product\n"));

      for (const path of ["untracked.md", "../x", "/etc/hosts", "a/../b", "sub"]) {
        await expect(read(path), path).rejects.toMatchObject({ code: "not-tracked" });
      }
      await expect(read("link.md")).rejects.toMatchObject({ code: "unsafe-kind" });
      for (const maxBytes of [-1, 1.5, Number.NaN]) {
        await expect(read("README.md", maxBytes), String(maxBytes)).rejects.toMatchObject({
          code: "oversize",
        });
      }

      // A same-size rewrite changes the file's ctime, even with its mtime restored.
      await writeFile(exported("rewrite.md"), "replaced content\n");
      await expect(read("rewrite.md")).rejects.toMatchObject({ code: "changed" });
      const before = await stat(exported("rewrite-mtime.md"));
      await writeFile(exported("rewrite-mtime.md"), "replaced content\n");
      await utimes(exported("rewrite-mtime.md"), before.atime, before.mtime);
      await expect(read("rewrite-mtime.md")).rejects.toMatchObject({ code: "changed" });
      await truncate(exported("truncate.md"), 5);
      await expect(read("truncate.md")).rejects.toMatchObject({ code: "changed" });
      await unlink(exported("swap.md"));
      await symlink("README.md", exported("swap.md"));
      await expect(read("swap.md")).rejects.toMatchObject({ code: "changed" });
      await rename(exported("sub"), exported("sub-moved"));
      await symlink("sub-moved", exported("sub"));
      await expect(read("sub/page.md")).rejects.toMatchObject({ code: "changed" });
    } finally {
      await workspace.dispose();
    }
  });

  it("splits binary from text at the 8,000th byte, as Git does", async () => {
    // Exactly `bytes` bytes of text that starts with `token`, with one NUL at `offset`.
    const nulAt = (token: string, bytes: number, offset: number) => {
      const content = Buffer.from(textOf(token, bytes));
      content[offset] = 0;
      return content;
    };
    const root = await repositoryWith({
      "nul-7999.txt": nulAt("LAST_SNIFFED_TOKEN", 8_500, 7_999),
      "nul-8000.txt": nulAt("FIRST_UNSNIFFED_TOKEN", 8_500, 8_000),
    });
    const within = await inventoryOf(root);
    expect(
      within.inventory.failures
        .filter((failure) => failure.category === "unsupported-text-format")
        .map((failure) => failure.path),
    ).toEqual(["nul-7999.txt"]);
    expect(within.found("FIRST_UNSNIFFED_TOKEN")).toBe(true);
    expect(within.found("LAST_SNIFFED_TOKEN")).toBe(false);

    const past = await inventoryOf(root, limitsWith({ [FILE_LIMIT.override!]: String(PER_FILE) }));
    expect(
      past.inventory.failures
        .filter((failure) => failure.category === "unsupported-text-format")
        .map((failure) => failure.path),
    ).toEqual(["nul-7999.txt"]);
    expect(textLimitFailures(past.inventory).map((failure) => failure.path)).toEqual([
      "nul-8000.txt",
    ]);
  });
});

describe("the invalid-text line at its 1,024-character bound (#1932)", () => {
  /** The inventory fields the invalid-text line reads: one failure per left-out path. */
  const leftOut = (paths: readonly string[]) =>
    ({
      failures: paths.map((path) => ({
        category: "invalid-text-input",
        affects: ["text"],
        path,
        evidenceSha256: "0".repeat(64),
      })),
    }) as unknown as RepositoryDiscoveryInventoryV1;
  const EFFECT =
    "the inventory records each by path. Convert a file to UTF-8 to make it searchable.";
  const named = (examples: readonly string[]) =>
    `${REPOSITORY_INVENTORY_INVALID_TEXT_LINE_CODE}: 3 tracked files were left out of the repository text index because they are not UTF-8 text, for example ${examples.map((path) => `"${path}"`).join(", ")}; ${EFFECT}`;
  const first = `a/${"x".repeat(250)}`;
  const second = `b/${"y".repeat(250)}`;
  const thirdOf = (length: number) => `c/${"z".repeat(length - 2)}`;
  const exact = 1_024 - named([first, second, ""]).length;

  it("names all three files when the line is exactly 1,024 characters", () => {
    const line = invalidTextLine(leftOut([thirdOf(exact), second, first]));
    expect(line).toBe(named([first, second, thirdOf(exact)]));
    expect(line).toHaveLength(1_024);
  });

  it("drops the third file when naming it would make the line 1,025 characters", () => {
    expect(named([first, second, thirdOf(exact + 1)])).toHaveLength(1_025);
    const line = invalidTextLine(leftOut([first, second, thirdOf(exact + 1)]));
    expect(line).toBe(named([first, second]));
  });
});

describe("the first unreadable page in code-unit path order (#1932)", {
  timeout: HEAVY_SUITE_TIMEOUT_MS,
}, () => {
  it("names docs/Z-bad.md before docs/a-bad.md, as Git orders paths, not by locale", async () => {
    const root = await repositoryWith({
      "README.md": "# Product\n",
      "docs/Z-bad.md": Buffer.from([0x23, 0x20, 0x00, 0x0a]),
      "docs/a-bad.md": Buffer.from([0x23, 0x20, 0x00, 0x0a]),
    });
    const workspace = await prepareRepositoryWorkspace(root, "HEAD");
    try {
      await expect(buildContentIndexV2({ workspace })).rejects.toMatchObject({
        sourcePath: "docs/Z-bad.md",
      });
      const inventory = await buildRepositoryDiscoveryInventory({ workspace });
      expect(
        inventory.failures.find((failure) => failure.category === "content-index-incomplete"),
      ).toMatchObject({ path: "docs/Z-bad.md" });
    } finally {
      await workspace.dispose();
    }
  });
});

describe("UTF-16 text in the text index (#1932)", { timeout: HEAVY_SUITE_TIMEOUT_MS }, () => {
  it("names a file with either UTF-16 byte order mark as text in another encoding, not binary", async () => {
    const littleEndian = Buffer.from([0xff, 0xfe, 0x68, 0x00, 0x69, 0x00, 0x0a, 0x00]);
    const bigEndian = Buffer.from([0xfe, 0xff, 0x00, 0x68, 0x00, 0x69, 0x00, 0x0a]);
    const largeBigEndian = Buffer.concat([
      Buffer.from([0xfe, 0xff]),
      Buffer.from("\u0000a".repeat(PER_FILE), "latin1"),
    ]);
    const root = await repositoryWith({
      "notes/big-endian.txt": bigEndian,
      "notes/large-big-endian.txt": largeBigEndian,
      "notes/little-endian.txt": littleEndian,
    });
    const { inventory, lines } = await inventoryOf(
      root,
      limitsWith({ [FILE_LIMIT.override!]: String(PER_FILE) }),
    );
    expect(
      inventory.failures
        .filter((failure) => failure.category === "invalid-text-input")
        .map((failure) => failure.path),
    ).toEqual(["notes/big-endian.txt", "notes/large-big-endian.txt", "notes/little-endian.txt"]);
    expect(
      inventory.failures.filter(
        (failure) =>
          failure.category === "unsupported-text-format" ||
          failure.category === "text-index-limit-exceeded",
      ),
    ).toEqual([]);
    expect(lines).toEqual([
      `${REPOSITORY_INVENTORY_INVALID_TEXT_LINE_CODE}: 3 tracked files were left out of the repository text index because they are not UTF-8 text, for example "notes/big-endian.txt", "notes/large-big-endian.txt", "notes/little-endian.txt"; the inventory records each by path. Convert a file to UTF-8 to make it searchable.`,
    ]);
  });
});
