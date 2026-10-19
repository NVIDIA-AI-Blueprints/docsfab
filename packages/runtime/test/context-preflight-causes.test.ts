// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Context preflight names the real cause of an index or compile failure under
 * a catalogued code and class; a read-only step runs on without a packet, and
 * a write step, which needs one, stops as before (#1924). A file whose on-disk
 * name the content index cannot hold is left out by name and never stops a
 * run (#1941). Every case runs the real indexer, `preflightContext`, and the
 * runner; `content-index-byte-exact-names.test.ts` covers decomposed names on
 * a byte-exact file system.
 */
import { createHash } from "node:crypto";
import { mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import {
  buildContentIndex,
  contentIndexLimitations,
  contentIndexNameWarnings,
  describeContentIndexLimitation,
  type DocumentNode,
} from "../src/content-ir/index.js";
import type {
  ContextPacketV1,
  ContextPreflightCauseReason,
  ContextPreflightInput,
  ContextPreflightResult,
  ContextPreflightTarget,
} from "../src/context/contracts.js";
import { contextPreflightCause, UNDISPLAYABLE_CAUSE_TEXT } from "../src/context/diagnostic.js";
import { ContextService, LocalContextPreflightService } from "../src/context/index.js";
import { diagnoseRun } from "../src/diagnosis/engine.js";
import { createHostedContextPreflightService } from "../src/host-invoker/context-preflight.js";
import { classifyThrownFailure } from "../src/operator/failure-classification.js";
import {
  collectRunLimitOverflowEvidence,
  projectRunLimitOverflowLines,
} from "../src/operator/run-limit-overflow.js";
import { situationRowForId } from "../src/operator/situation-catalog.js";
import type { RunReviewScope } from "../src/execution/contracts.js";
import type { RunRecord } from "../src/records/contracts.js";
import { projectRunIndexRows } from "../src/records/run-index.js";
import { prepareRepositoryWorkspace } from "../src/repository/workspace/materialize.js";
import type { RepositoryWorkspace } from "../src/repository/workspace/contracts.js";
import { decodeContextPreflight } from "../src/scorecard-record-decode.js";
import { escapeUndisplayable, UNDISPLAYABLE_CODE_POINT } from "../src/shared/display-text.js";
import { LocalWorkflowSearchCoordinator } from "../src/search/local-workflow-coordinator.js";
import {
  contextPreflightAllowsExecution,
  normalizeContextPreflight,
  preflightContext,
} from "../src/workflow-execution/runner-evidence.js";
import { ContextPreflightAuthorizationError } from "../src/workflow-execution/runner-step-loop.js";
import { WorkflowRunner } from "../src/workflow-execution/runner.js";
import { getWorkflow } from "../src/workflow-registry/catalog.js";
import { commitFixture, initFixtureRepo } from "./helpers/git.js";
import { captureProductionLimitOverflow } from "./helpers/limit-overflow-cli.js";
import { temporaryRoots } from "./helpers/temp.js";
import { sourceObligationObserverFixture, verificationFixture } from "./helpers/verification.js";

/**
 * Code points built at run time, so this file holds no raw format, separator,
 * or combining character.
 */
const RLO = String.fromCodePoint(0x202e);
const LRI = String.fromCodePoint(0x2066);
const ZERO_WIDTH_SPACE = String.fromCodePoint(0x200b);
const SOFT_HYPHEN = String.fromCodePoint(0xad);
const NEXT_LINE = String.fromCodePoint(0x85);
const LINE_SEPARATOR = String.fromCodePoint(0x2028);
const PARAGRAPH_SEPARATOR = String.fromCodePoint(0x2029);
const BYTE_ORDER_MARK = String.fromCodePoint(0xfeff);
const COMBINING_ACUTE = String.fromCodePoint(0x301);
const REPLACEMENT_CHARACTER = String.fromCodePoint(0xfffd);
const CONTROL = String.fromCodePoint(0x1);

const REVISION = "a".repeat(40);
const SCOPE_SHA = "c".repeat(64);
const roots = temporaryRoots();
const scratch: string[] = [];
afterAll(async () => {
  await Promise.all(scratch.map((path) => rm(path, { recursive: true, force: true })));
});

const passedScanner = {
  scan: async () => ({
    ruleSet: "context-preflight-causes-test-v1",
    status: "passed" as const,
    scannedFiles: 3,
    binaryFiles: 0,
    findings: [],
  }),
};
const emptyPatchEvidence = {
  capture: async () => ({
    files: [],
    patch: {
      sha256: "d".repeat(64),
      byteLength: 0,
      lineCount: 0,
      artifactPath: "/durable/empty.patch",
      format: "git-diff" as const,
    },
  }),
};

async function writeTree(root: string, files: Record<string, string>): Promise<void> {
  for (const [path, contents] of Object.entries(files)) {
    await mkdir(dirname(resolve(root, path)), { recursive: true });
    await writeFile(resolve(root, path), contents, "utf8");
  }
}

async function checkout(
  files: Record<string, string>,
): Promise<{ repository: string; cache: string }> {
  const root = await roots.create("docsfab-context-preflight-causes-");
  const repository = resolve(root, "repository");
  await writeTree(repository, files);
  return { repository, cache: resolve(root, "cache") };
}

function inputFor(
  repository: string,
  workflowName: "readiness" | "bootstrap" | "review-documentation",
  extra: Partial<ContextPreflightInput> = {},
): ContextPreflightInput {
  const workflow = getWorkflow(workflowName);
  return {
    runId: "context-preflight-causes",
    repository: { sourcePath: repository, requestedRevision: "HEAD", revision: REVISION },
    workspacePath: repository,
    workflow,
    step: workflow.steps[0]!,
    policy: workflow.contextPolicy.steps[0]!,
    ...extra,
  };
}

function documentPaths(index: { nodes: readonly { kind: string }[] }): string[] {
  return index.nodes
    .filter((node): node is DocumentNode => node.kind === "document")
    .map((node) => node.sourcePath)
    .sort();
}

/** One read-only `readiness` run through the real runner; the model is a stub. */
async function runReadiness(
  repository: string,
  contextPreflight: LocalContextPreflightService,
): Promise<{ record: RunRecord; modelCalls: number; packets: unknown[] }> {
  const packets: unknown[] = [];
  const record = await new WorkflowRunner({
    harness: {
      runStep: async (input) => {
        packets.push(input.contextPacket);
        return { summary: "readiness result" };
      },
    },
    store: { save: async () => undefined },
    repositoryScanner: passedScanner,
    contextPreflight,
    id: () => "context-preflight-causes-read",
    now: () => new Date("2026-10-06T12:00:00.000Z"),
  }).run({
    workflow: "readiness",
    workspacePath: repository,
    repository: { sourcePath: repository, requestedRevision: "HEAD", revision: REVISION },
    allowWrite: false,
  });
  return { record, modelCalls: packets.length, packets };
}

/** One `bootstrap` run, whose only step writes and so needs a packet. */
async function runBootstrap(input: {
  workspacePath: string;
  sourcePath?: string;
  revision?: string;
  contextPreflight: LocalContextPreflightService;
  contextTarget?: ContextPreflightTarget;
}): Promise<{ record: RunRecord; modelCalls: number }> {
  let modelCalls = 0;
  const record = await new WorkflowRunner({
    harness: {
      inspectSkill: async () => {
        modelCalls += 1;
        return undefined;
      },
      runStep: async () => {
        modelCalls += 1;
        return { summary: "must not run" };
      },
    },
    store: { save: async () => undefined },
    repositoryScanner: passedScanner,
    contextPreflight: input.contextPreflight,
    repositoryEvidence: emptyPatchEvidence,
    id: () => "context-preflight-causes-write",
    now: () => new Date("2026-10-06T12:00:00.000Z"),
  }).run({
    workflow: "bootstrap",
    workspacePath: input.workspacePath,
    repository: {
      sourcePath: input.sourcePath ?? input.workspacePath,
      requestedRevision: "HEAD",
      revision: input.revision ?? REVISION,
    },
    ...(input.contextTarget ? { contextTarget: input.contextTarget } : {}),
    allowWrite: true,
  });
  return { record, modelCalls };
}

/** What `docsfab why` reads for a run: its terminal finding from the run index rows. */
function whyFinding(record: RunRecord) {
  const projection = projectRunIndexRows(record, {
    origin: "import",
    snapshotId: "snapshot-context-preflight-causes",
    indexedAt: "2026-10-06T12:00:01.000Z",
    recordSha256: "a".repeat(64),
    fieldMaxChars: 512,
  });
  if (!projection.ok) throw new Error(`record refused by the run index: ${projection.reason}`);
  const diagnosis = diagnoseRun(projection.rows, {
    location: { indexArgs: "", showArgs: "" },
    source: "record",
    population: null,
    lookbackRuns: 20,
  });
  expect(diagnosis.findings).toHaveLength(1);
  return diagnosis.findings[0]!;
}

function packetless(reason: ContextPreflightCauseReason, code: string, message: string) {
  return { status: "degraded", reason, cause: { code, message } };
}

describe("files the content index cannot name (#1941)", () => {
  it("leaves a backslash name out by name, never reading it as the path its backslash spells", async () => {
    const { repository } = await checkout({
      "README.md": "# Home\n",
      "docs/a\\b.md": "# Backslash\n",
      // The page `docs/a\b.md` would be renamed to, a different file.
      "docs/a/b.md": "# Decoy\n\nA different page.\n",
    });
    const index = await buildContentIndex({
      repositoryPath: repository,
      repositoryRevision: REVISION,
    });
    expect(documentPaths(index)).toEqual(["README.md", "docs/a/b.md"]);
    const decoy = index.nodes.find(
      (node): node is DocumentNode => node.kind === "document" && node.sourcePath === "docs/a/b.md",
    );
    expect(decoy?.byteLength).toBe(Buffer.byteLength("# Decoy\n\nA different page.\n"));
    expect(contentIndexLimitations(index)).toEqual([
      {
        path: "docs/a\\b.md",
        reason: "unindexable-name",
        detail: "its name holds a backslash, which a content index path cannot hold",
      },
    ]);
    expect(contentIndexNameWarnings(index)).toEqual([
      'content-index-name-left-out: "docs/a\\\\b.md" is left out of the content index: its name holds a backslash, which a content index path cannot hold. Rename it to index it.',
    ]);
  });

  it("runs a readiness step past a backslash name and names it, escaped, in the record and runs show", async () => {
    const { repository, cache } = await checkout({
      "README.md": "# Home\n\nSee [guide](docs/guide.md).\n",
      "docs/guide.md": "# Guide\n",
      "docs/a\\b.md": "# Backslash\n",
    });
    const warning =
      'content-index-name-left-out: "docs/a\\\\b.md" is left out of the content index: its name holds a backslash, which a content index path cannot hold. Rename it to index it.';
    const { record, modelCalls } = await runReadiness(
      repository,
      new LocalContextPreflightService({ cacheRoot: cache }),
    );
    expect(record.status, record.error).toBe("succeeded");
    expect(modelCalls).toBe(1);
    expect(record.steps[0]!.contextPreflight).toMatchObject({ status: "ready" });
    expect(record.evidenceWarnings).toEqual([warning]);
    expect(projectRunLimitOverflowLines(collectRunLimitOverflowEvidence(record))).toEqual([
      warning,
    ]);
    const shown = await captureProductionLimitOverflow({ record, roots: scratch });
    expect(shown.showHuman).toContain("LIMITATIONS");
    expect(shown.showHuman).toContain(warning);
    expect(shown.envelope.limitOverflow).toEqual([warning]);
  });

  it("binds nothing for a request that names a backslash file, never the page its backslash spells", async () => {
    const { repository, cache } = await checkout({
      // The README links the decoy, so the packet would carry it had the
      // focused index read `docs/a/`.
      "README.md": "# Home\n\nSee [decoy](docs/a/b.md).\n",
      "docs/guide.md": "# Guide\n",
      "docs/a\\b.md": "# Backslash\n",
      "docs/a/b.md": "# Decoy\n",
    });
    const { evidence, packet, limitations } = await preflightContext({
      ...inputFor(repository, "review-documentation", {
        scope: { targetPaths: ["README.md", "docs/a\\b.md"], scopeSha256: SCOPE_SHA },
      }),
      contextPreflight: new LocalContextPreflightService({ cacheRoot: cache }),
    });
    expect(evidence).toMatchObject({
      status: "degraded",
      reason: "scope-target-partially-unresolved",
      unboundTargets: ["docs/a\\b.md"],
    });
    const bound = (packet as ContextPacketV1).nodes.map((node) => node.sourcePath);
    expect(bound).toContain("README.md");
    expect(bound).not.toContain("docs/a/b.md");
    expect(limitations).toEqual([
      'content-index-name-left-out: "docs/a\\\\b.md" is left out of the content index: its name holds a backslash, which a content index path cannot hold. Rename it to index it.',
    ]);
  });

  it("leaves out a control character, a drive-like root name, and a backslash directory, and indexes the rest", async () => {
    const { repository, cache } = await checkout({
      "README.md": "# Home\n",
      "docs/guide.md": "# Guide\n",
      "docs/bell\u0007.md": "# Bell\n",
      "c:notes.md": "# Drive\n",
      "docs/old\\pages/a.md": "# Old A\n",
    });
    const index = await buildContentIndex({
      repositoryPath: repository,
      repositoryRevision: REVISION,
    });
    expect(documentPaths(index)).toEqual(["README.md", "docs/guide.md"]);
    expect(contentIndexNameWarnings(index)).toEqual([
      'content-index-name-left-out: "c:notes.md" is left out of the content index: its name begins like a Windows drive, which a content index path cannot. Rename it to index it.',
      'content-index-name-left-out: "docs/bell\\u0007.md" is left out of the content index: its name holds a control character, which a content index path cannot hold. Rename it to index it.',
      'content-index-name-left-out: "docs/old\\\\pages" is a directory the content index leaves out, with every page under it: its name holds a backslash, which a content index path cannot hold. Rename it to index its pages.',
    ]);
    // Each would otherwise reach a decoder that refuses it, and fail the step.
    const result = await new LocalContextPreflightService({ cacheRoot: cache }).preflight(
      inputFor(repository, "readiness"),
    );
    expect(result.status).toBe("ready");
    expect(result.limitations).toEqual(contentIndexNameWarnings(index));
  });

  it("names a left-out file by the SHA-256 of its path when its warning would pass 1,024 characters, one warning per file", async () => {
    // Each control character escapes to six characters, so a 165-byte name
    // makes a warning far past the run record's 1,024-character bound.
    const long = (suffix: string): string => `docs/${"\u0001".repeat(160)}${suffix}.md`;
    const { repository, cache } = await checkout({
      "README.md": "# Home\n",
      [long("a")]: "# A\n",
      [long("b")]: "# B\n",
      "docs/short\u0001.md": "# Short\n",
    });
    const index = await buildContentIndex({
      repositoryPath: repository,
      repositoryRevision: REVISION,
    });
    const cause = "its name holds a control character, which a content index path cannot hold";
    const hashed = (path: string): string =>
      `content-index-name-left-out: a file whose path is too long to show here, with path SHA-256 ${createHash("sha256").update(path).digest("hex")}, is left out of the content index: ${cause}. Rename it to index it.`;
    const limitations = contentIndexLimitations(index);
    expect(limitations.map((limitation) => limitation.path)).toEqual([
      long("a"),
      long("b"),
      "docs/short\u0001.md",
    ]);
    // Positive control: the full sentence of a long name does pass the bound.
    expect(
      `content-index-name-left-out: ${describeContentIndexLimitation(limitations[0]!)}`.length,
    ).toBeGreaterThan(1_024);
    const warnings = contentIndexNameWarnings(index);
    expect(warnings).toEqual([
      hashed(long("a")),
      hashed(long("b")),
      `content-index-name-left-out: "docs/short\\u0001.md" is left out of the content index: ${cause}. Rename it to index it.`,
    ]);
    expect(warnings[0]).not.toBe(warnings[1]);
    for (const warning of warnings) expect(warning.length).toBeLessThanOrEqual(1_024);
    // The runner keeps each one, never one placeholder for both.
    const { record } = await runReadiness(
      repository,
      new LocalContextPreflightService({ cacheRoot: cache }),
    );
    expect(record.status, record.error).toBe("succeeded");
    expect(record.evidenceWarnings).toEqual(warnings);
    expect(projectRunLimitOverflowLines(collectRunLimitOverflowEvidence(record))).toEqual(warnings);
  });

  it("keeps a name warning of exactly 1,024 characters whole and names one of 1,025 by SHA-256", async () => {
    const cause = "its name holds a control character, which a content index path cannot hold";
    // The whole warning for `docs/<filler><140 controls>.md`, as the index writes it.
    const pathWith = (filler: string): string => `docs/${filler}${CONTROL.repeat(140)}.md`;
    const warningFor = (filler: string): string =>
      `content-index-name-left-out: ${JSON.stringify(pathWith(filler))} is left out of the content index: ${cause}. Rename it to index it.`;
    const base = warningFor("").length;
    const exact = "a".repeat(1_024 - base);
    const over = "b".repeat(1_025 - base);
    expect(warningFor(exact)).toHaveLength(1_024);
    expect(warningFor(over)).toHaveLength(1_025);
    const { repository } = await checkout({
      "README.md": "# Home\n",
      [pathWith(exact)]: "# Exact\n",
      [pathWith(over)]: "# Over\n",
    });
    const index = await buildContentIndex({
      repositoryPath: repository,
      repositoryRevision: REVISION,
    });
    expect(contentIndexNameWarnings(index)).toEqual([
      warningFor(exact),
      `content-index-name-left-out: a file whose path is too long to show here, with path SHA-256 ${createHash("sha256").update(pathWith(over)).digest("hex")}, is left out of the content index: ${cause}. Rename it to index it.`,
    ]);
  });

  it("keeps a left-out directory's scope and remedy when its warning names it by SHA-256", async () => {
    const cause = "its name holds a control character, which a content index path cannot hold";
    const directory = `docs/${CONTROL.repeat(160)}dir`;
    const { repository } = await checkout({
      "README.md": "# Home\n",
      [`${directory}/a.md`]: "# A\n",
      [`${directory}/b.md`]: "# B\n",
    });
    const index = await buildContentIndex({
      repositoryPath: repository,
      repositoryRevision: REVISION,
    });
    expect(contentIndexLimitations(index)).toEqual([
      { path: directory, reason: "unindexable-name", detail: cause, directory: true },
    ]);
    // Positive control: the whole sentence would pass the bound.
    expect(
      `content-index-name-left-out: ${describeContentIndexLimitation(contentIndexLimitations(index)[0]!)}`
        .length,
    ).toBeGreaterThan(1_024);
    expect(contentIndexNameWarnings(index)).toEqual([
      `content-index-name-left-out: a directory whose path is too long to show here, with path SHA-256 ${createHash("sha256").update(directory).digest("hex")}, is left out of the content index, with every page under it: ${cause}. Rename it to index its pages.`,
    ]);
  });

  it("escapes a right-to-left override in a left-out backslash name", async () => {
    const name = `docs/a${"\\"}b${RLO}c.md`;
    const { repository } = await checkout({ "README.md": "# Home\n", [name]: "# ABC\n" });
    const index = await buildContentIndex({
      repositoryPath: repository,
      repositoryRevision: REVISION,
    });
    const [warning] = contentIndexNameWarnings(index);
    expect(warning).toBe(
      `content-index-name-left-out: "docs/a\\\\b\\u{202e}c.md" is left out of the content index: its name holds a backslash, which a content index path cannot hold. Rename it to index it.`,
    );
    expect(warning).not.toContain(RLO);
  });

  it("escapes a format character in a page anchor notice, which only the sentence escape reaches", async () => {
    const page = `docs/notes${RLO}dm.txt.md`;
    const { repository } = await checkout({
      "README.md": "# Home\n",
      [page]: "# Notes\n\n## !!!\n",
    });
    const index = await buildContentIndex({
      repositoryPath: repository,
      repositoryRevision: REVISION,
    });
    const anchor = contentIndexLimitations(index).find(
      (limitation) => limitation.reason === "empty-page-anchor",
    );
    // The recorded detail holds the raw name; the notice built from it must not.
    expect(anchor?.detail).toContain(RLO);
    const notice = describeContentIndexLimitation(anchor!);
    expect(notice).toContain("of docs/notes\\u{202e}dm.txt.md has no letter or digit");
    expect(notice).not.toContain(RLO);
  });

  it("escapes a format character in a duplicate-identity refusal, which only the quoted-name escape reaches", async () => {
    const one = `docs/one${RLO}.md`;
    const { repository } = await checkout({
      "README.md": "# Home\n",
      [one]: "---\nid: shared\n---\n# One\n",
      "docs/two.md": "---\nid: shared\n---\n# Two\n",
    });
    const refusal = await buildContentIndex({
      repositoryPath: repository,
      repositoryRevision: REVISION,
    }).then(
      () => undefined,
      (error: unknown) => error as Error & { code?: string },
    );
    expect(refusal?.code).toBe("duplicate-node-identity");
    expect(refusal?.message).toBe(
      'Content index contains a duplicate document identity: "docs/one\\u{202e}.md" and "docs/two.md" share one. Give each page its own frontmatter id.',
    );
    expect(refusal?.message).not.toContain(RLO);
  });

  it("escapes one set of code points in cause messages and in the names the content index reports", () => {
    // One regular expression, not two that can drift apart.
    expect(UNDISPLAYABLE_CAUSE_TEXT).toBe(UNDISPLAYABLE_CODE_POINT);
    const undisplayable = [
      0x0, 0x1, 0x1f, 0x7f, 0x80, 0x85, 0x9f, 0xad, 0x200b, 0x200e, 0x202e, 0x2066, 0x2069, 0xfeff,
      0x2028, 0x2029,
    ];
    const displayable = [0x20, 0x41, 0xa0, 0xe9, 0x301, 0x3000, 0x1f680];
    for (const codePoint of undisplayable) {
      const character = String.fromCodePoint(codePoint);
      expect(UNDISPLAYABLE_CODE_POINT.test(character), codePoint.toString(16)).toBe(true);
      expect(escapeUndisplayable(character), codePoint.toString(16)).toBe(
        `${"\\"}u{${codePoint.toString(16)}}`,
      );
    }
    for (const codePoint of displayable) {
      const character = String.fromCodePoint(codePoint);
      expect(UNDISPLAYABLE_CODE_POINT.test(character), codePoint.toString(16)).toBe(false);
      expect(escapeUndisplayable(character), codePoint.toString(16)).toBe(character);
    }
  });

  it("agrees in the hosted preflight: the same left-out name with a real packet", async () => {
    const { repository, cache } = await checkout({
      "README.md": "# Home\n",
      "docs/a\\b.md": "# Backslash\n",
    });
    const local = await new LocalContextPreflightService({ cacheRoot: cache }).preflight(
      inputFor(repository, "review-documentation"),
    );
    const hosted = await createHostedContextPreflightService({
      capsule: {
        sha256: "f".repeat(64),
        receiptSha256: "d".repeat(64),
        expiresAt: "2099-01-01T00:00:00.000Z",
        selectedEvidence: [{ evidenceId: "product-model", content: "Approved product context." }],
      },
      stateDirectory: resolve(cache, "..", "hosted-state"),
    }).preflight(inputFor(repository, "review-documentation"));
    expect(local.status).toBe("ready");
    expect(hosted.status).toBe("ready");
    expect(hosted.packetDigest).not.toBe("f".repeat(64));
    expect(hosted.limitations).toEqual(local.limitations);
    expect(hosted.limitations).toHaveLength(1);
  });
});

describe("context preflight causes (#1924)", () => {
  /** A committed checkout tracking `docs/latest.md -> a.md`, exported as runs read it. */
  async function trackedSymlinkExport(): Promise<{
    source: string;
    workspace: RepositoryWorkspace;
    cache: string;
  }> {
    const root = await roots.create("docsfab-context-preflight-symlink-");
    const source = resolve(root, "source");
    await initFixtureRepo(source, {
      "README.md": "# Product\n\nSee [a](docs/a.md) and [b](docs/b.md).\n",
      "docs/a.md": "# A\n\nThe current page.\n",
      "docs/b.md": "# B\n\nAnother page.\n",
    });
    await symlink("a.md", resolve(source, "docs", "latest.md"));
    const revision = await commitFixture(source, "track a symlink");
    const workspace = await prepareRepositoryWorkspace(source, revision);
    return { source, workspace, cache: resolve(root, "cache") };
  }

  const aliasMessage = "Focused context does not follow a selected alias: docs/latest.md.";

  it("runs a read-only review past a selected tracked symlink without a packet and names it", async () => {
    const { source, workspace, cache } = await trackedSymlinkExport();
    try {
      const service = new LocalContextPreflightService({ cacheRoot: cache, workspace });
      const scope: RunReviewScope = {
        scope: "focused-set",
        reason: "operator-named",
        targetPaths: ["docs/latest.md", "docs/b.md"],
        deferredPaths: [],
        scopeSha256: SCOPE_SHA,
        corpusFileCount: null,
      };
      const harnessSteps: string[] = [];
      const record = await new WorkflowRunner({
        harness: {
          runStep: async (stepInput) => {
            harnessSteps.push(stepInput.step.id);
            expect(stepInput.contextPacket).toBeUndefined();
            return {
              summary: `${stepInput.step.id} fixture result`,
              ...(await verificationFixture(stepInput)),
            };
          },
        },
        workflowSearch: new LocalWorkflowSearchCoordinator(),
        sourceObligationObserver: sourceObligationObserverFixture,
        hostOperations: { runStep: async () => ({ summary: "deterministic fixture result" }) },
        store: { save: async () => undefined },
        repositoryScanner: passedScanner,
        contextPreflight: service,
        id: () => "context-preflight-symlink-review",
        now: () => new Date("2026-10-06T12:00:00.000Z"),
      }).run({
        workflow: "review-documentation",
        workspacePath: workspace.path,
        repository: { sourcePath: source, requestedRevision: "HEAD", revision: workspace.revision },
        reviewScope: scope,
        allowWrite: false,
      });
      const workflow = getWorkflow("review-documentation");
      expect(record.status, record.error).toBe("succeeded");
      expect(harnessSteps.length).toBeGreaterThan(1);
      expect(record.steps.map((step) => step.id)).toEqual(workflow.steps.map((step) => step.id));
      for (const step of record.steps) {
        expect(step.contextPreflight, step.id).toEqual(
          packetless("navigation-alias-refused", "selected-alias", aliasMessage),
        );
        expect(decodeContextPreflight(step.contextPreflight), step.id).toEqual(
          step.contextPreflight,
        );
      }
      expect(projectRunLimitOverflowLines(collectRunLimitOverflowEvidence(record))).toEqual(
        workflow.steps.map(
          (step) =>
            `navigation-alias-refused: step "${step.id}" ran without a context packet (selected-alias): ${aliasMessage}`,
        ),
      );
    } finally {
      await workspace.dispose();
    }
  }, 120_000);

  it("stops a write step on a selected tracked symlink, coded and classed, and why names the fix", async () => {
    const { source, workspace, cache } = await trackedSymlinkExport();
    try {
      const { record, modelCalls } = await runBootstrap({
        workspacePath: workspace.path,
        sourcePath: source,
        revision: workspace.revision,
        contextPreflight: new LocalContextPreflightService({ cacheRoot: cache, workspace }),
        contextTarget: { sourcePath: "docs/latest.md" },
      });
      // Unchanged for a write step: it stops before the model, as before.
      expect(modelCalls).toBe(0);
      expect(record.status).toBe("failed");
      const step = record.steps[0]!;
      expect(step.contextPreflight).toEqual(
        packetless("navigation-alias-refused", "selected-alias", aliasMessage),
      );
      // What changed: a catalogued class and an error that names the file.
      expect(step.failure).toEqual({
        class: "operator-input",
        layer: "workflow",
        code: "navigation-alias-refused",
      });
      expect(step.error).toBe(
        `Context preflight did not authorize workflow step "bootstrap-guidance", which needs a context packet: navigation-alias-refused (selected-alias): ${aliasMessage}`,
      );
      expect(projectRunLimitOverflowLines(collectRunLimitOverflowEvidence(record))).toEqual([
        `navigation-alias-refused: step "bootstrap-guidance" stopped before it called the model, because a write step needs a context packet (selected-alias): ${aliasMessage}`,
      ]);
      const finding = whyFinding(record);
      expect(finding).toMatchObject({
        cause: "operator-input-refused",
        ownerClass: "operator-configuration",
        nextAction: situationRowForId("navigation-alias-refused")!.nextAction,
      });
      expect(finding.why).toContain("contextPreflight.cause names the symlink");
    } finally {
      await workspace.dispose();
    }
  }, 120_000);

  it("codes two pages with one frontmatter id: a read-only step names both, a write step stops", async () => {
    const { repository, cache } = await checkout({
      "README.md": "# Home\n",
      "docs/one.md": "---\nid: shared\n---\n# One\n",
      "docs/two.md": "---\nid: shared\n---\n# Two\n",
    });
    const service = new LocalContextPreflightService({ cacheRoot: cache });
    const message =
      'Content index contains a duplicate document identity: "docs/one.md" and "docs/two.md" share one. Give each page its own frontmatter id.';
    const expected = packetless("content-index-refused", "duplicate-node-identity", message);

    const { record, modelCalls, packets } = await runReadiness(repository, service);
    expect(record.status, record.error).toBe("succeeded");
    expect(modelCalls).toBe(1);
    expect(packets).toEqual([undefined]);
    expect(record.steps[0]!.contextPreflight).toEqual(expected);
    expect(decodeContextPreflight(record.steps[0]!.contextPreflight)).toEqual(expected);
    expect(projectRunLimitOverflowLines(collectRunLimitOverflowEvidence(record))).toEqual([
      `content-index-refused: step "assess-readiness" ran without a context packet (duplicate-node-identity): ${message}`,
    ]);

    const write = await runBootstrap({ workspacePath: repository, contextPreflight: service });
    expect(write.modelCalls).toBe(0);
    expect(write.record.status).toBe("failed");
    expect(write.record.steps[0]!.contextPreflight).toEqual(expected);
    expect(write.record.steps[0]!.failure).toEqual({
      class: "operator-input",
      layer: "workflow",
      code: "content-index-refused",
    });
    expect(write.record.error).toContain(message);
    expect(whyFinding(write.record)).toMatchObject({
      cause: "operator-input-refused",
      nextAction: situationRowForId("content-index-refused")!.nextAction,
    });
  });

  it("codes a compiler reason it has no mapping for, through the real compiler, and keeps read-only steps running", async () => {
    // A fence language the index records decomposed (NFD) is text its own
    // decoder refuses, so the real compiler returns `invalid-input`.
    const { repository, cache } = await checkout({
      "README.md": `# Home\n\n\`\`\`cafe${COMBINING_ACUTE}\nprint(1)\n\`\`\`\n`,
    });
    const service = new LocalContextPreflightService({ cacheRoot: cache });
    const message =
      "The context compiler returned invalid-input (context-rebuild-failed) for the input DocsFab built.";
    const { record, modelCalls } = await runReadiness(repository, service);
    expect(record.status, record.error).toBe("succeeded");
    expect(modelCalls).toBe(1);
    expect(record.steps[0]!.contextPreflight).toMatchObject(
      packetless("context-compile-failed", "invalid-input", message),
    );
    expect(record.steps[0]!.contextPreflight!.packetDigest).toBeUndefined();
    expect(decodeContextPreflight(record.steps[0]!.contextPreflight)).toEqual(
      record.steps[0]!.contextPreflight,
    );

    const write = await runBootstrap({ workspacePath: repository, contextPreflight: service });
    expect(write.modelCalls).toBe(0);
    expect(write.record.steps[0]!.failure).toEqual({
      class: "contract-shape",
      layer: "workflow",
      code: "context-compile-failed",
    });
    expect(whyFinding(write.record)).toMatchObject({
      cause: "host-built-value-refused",
      ownerClass: "docsfab-defect",
      nextAction: situationRowForId("context-compile-failed")!.nextAction,
    });
  });

  it("names a raw repository-mismatch from a compiler seam with its own code", async () => {
    const { repository, cache } = await checkout({ "README.md": "# Home\n" });
    // The real service compiles; the seam swaps in the one compiler reason
    // the real pipeline never produces.
    const real = ContextService.withFileCache(cache);
    const mismatched = {
      resolve: async (request: Parameters<ContextService["resolve"]>[0]) => {
        const response = await real.resolve(request);
        const { packet: _packet, ...result } = response.result;
        return {
          ...response,
          result: { ...result, status: "failed", reasons: [{ code: "repository-mismatch" }] },
        };
      },
    } as unknown as ContextService;
    const { evidence } = await preflightContext({
      ...inputFor(repository, "readiness"),
      contextPreflight: new LocalContextPreflightService({ cacheRoot: cache, service: mismatched }),
    });
    expect(evidence).toMatchObject(
      packetless(
        "context-compile-failed",
        "repository-mismatch",
        "The context compiler returned repository-mismatch for the input DocsFab built.",
      ),
    );
    expect(evidence.measurements).toBeDefined();
    expect(decodeContextPreflight(evidence)).toEqual(evidence);
  });

  it("falls back to the hosted capsule for an index refusal, coded with the local cause, for read and write steps", async () => {
    const { repository, cache } = await checkout({
      "README.md": "# Home\n",
      "docs/one.md": "---\nid: shared\n---\n# One\n",
      "docs/two.md": "---\nid: shared\n---\n# Two\n",
    });
    const capsule = {
      sha256: "f".repeat(64),
      receiptSha256: "d".repeat(64),
      expiresAt: "2099-01-01T00:00:00.000Z",
      selectedEvidence: [{ evidenceId: "product-model", content: "Approved product context." }],
    };
    const local = await new LocalContextPreflightService({ cacheRoot: cache }).preflight(
      inputFor(repository, "readiness"),
    );
    expect(local).toMatchObject({ status: "degraded", reason: "content-index-refused" });
    const hosted = createHostedContextPreflightService({
      capsule,
      stateDirectory: resolve(cache, "..", "hosted-state"),
    });
    for (const workflowName of ["readiness", "bootstrap"] as const) {
      const preflightInput = inputFor(repository, workflowName);
      const fallback = await hosted.preflight(preflightInput);
      expect(fallback, workflowName).toMatchObject({
        status: "degraded",
        reason: "content-index-refused",
        cause: local.cause,
        packetDigest: capsule.sha256,
      });
      // As before these causes had codes, the capsule stands in for the packet.
      expect(
        contextPreflightAllowsExecution(preflightInput.step.mode, preflightInput.policy, fallback),
        workflowName,
      ).toBe(true);
      const { evidence } = await preflightContext({ ...preflightInput, contextPreflight: hosted });
      expect(decodeContextPreflight(evidence), workflowName).toEqual(evidence);
    }
  });

  it("escapes a right-to-left override a cause's file name carries, in the record and LIMITATIONS", async () => {
    // A target page whose name holds U+202E and whose heading the index cannot
    // admit: the refusal's message names the page raw.
    const page = `docs/notes${RLO}dm.txt.md`;
    const { repository, cache } = await checkout({
      "README.md": "# Home\n",
      [page]: "# Notes\n\n## 🚀\n\nText.\n",
    });
    const { evidence } = await preflightContext({
      ...inputFor(repository, "review-documentation", { contextTarget: { sourcePath: page } }),
      contextPreflight: new LocalContextPreflightService({ cacheRoot: cache }),
    });
    expect(evidence).toMatchObject({
      status: "degraded",
      reason: "content-index-refused",
      cause: {
        code: "empty-page-anchor",
        message:
          "The heading at line 3 of docs/notes\\u{202e}dm.txt.md has no letter or digit to form an anchor. Add a letter or digit to the heading text, or give the heading an explicit {#anchor}.",
      },
    });
    expect(evidence.cause!.message).not.toContain(RLO);
    expect(decodeContextPreflight(evidence)).toEqual(evidence);
    const record = {
      steps: [
        {
          id: "audit-documentation",
          mode: "read-only",
          status: "succeeded",
          contextPreflight: evidence,
        },
      ],
    } as unknown as RunRecord;
    const [line] = projectRunLimitOverflowLines(collectRunLimitOverflowEvidence(record));
    expect(line).toContain("docs/notes\\u{202e}dm.txt.md");
    expect(line).not.toContain(RLO);
  });

  it("classes each cause code from its catalog row, and why reads that row's next action", () => {
    const classes: Record<ContextPreflightCauseReason, string> = {
      "content-index-refused": "operator-input",
      "content-index-unreadable": "infrastructure",
      "context-compile-failed": "contract-shape",
      "navigation-alias-refused": "operator-input",
    };
    for (const [code, failureClass] of Object.entries(classes)) {
      const row = situationRowForId(code);
      expect(row, code).toMatchObject({ family: "operator", failureClass });
      expect(row!.nextAction, code).toContain("contextPreflight.cause");
      const cause = contextPreflightCause("example", "Example cause.");
      expect(
        classifyThrownFailure(
          new ContextPreflightAuthorizationError("write-documentation", code, undefined, cause),
          "workflow",
        ),
        code,
      ).toEqual({ class: failureClass, layer: "workflow", code });
    }
    // An uncoded internal failure stays uncatalogued: a DocsFab defect with no single cause.
    expect(situationRowForId("preflight-internal-failure")).toBeUndefined();
  });
});

describe("recorded preflight causes", () => {
  const cause = { code: "duplicate-node-identity", message: "Two pages share one id." };
  const measurements = { byteLength: 0, estimatedTokens: 0, latencyMs: 1 };

  it("records a cause only beside a cause reason on a degraded step, both ways", () => {
    const accepted: ContextPreflightResult[] = [
      { status: "degraded", reason: "content-index-refused", cause },
      { status: "degraded", reason: "context-compile-failed", cause, measurements },
      {
        status: "degraded",
        reason: "content-index-unreadable",
        cause,
        packetDigest: "e".repeat(64),
        consultedNodeIds: ["product-model"],
      },
    ];
    for (const result of accepted) {
      const evidence = normalizeContextPreflight(result);
      expect(evidence.cause).toEqual(cause);
      expect(decodeContextPreflight(evidence)).toEqual(evidence);
    }
    const refused: unknown[] = [
      // A cause reason with nothing to say why.
      { status: "degraded", reason: "content-index-refused" },
      // A cause beside a reason that names no cause, or on a step that ran.
      { status: "degraded", reason: "navigation-coverage-incomplete", cause, measurements },
      { status: "failed", reason: "content-index-refused", cause },
      { status: "unnecessary", reason: "target-not-applicable", cause },
    ];
    for (const result of refused) {
      expect(() => normalizeContextPreflight(result as ContextPreflightResult)).toThrow(
        "do not name each other",
      );
      expect(() => decodeContextPreflight(result)).toThrow();
    }
  });

  it("refuses a cause the record cannot hold, and the cause builder never writes one", () => {
    for (const bad of [
      { code: "has space", message: "fine" },
      { code: "ok", message: "line\nbreak" },
      { code: "ok", message: "" },
      { code: "ok", message: "x".repeat(513) },
      { code: "ok", message: "lone \uD800 surrogate" },
      { code: "ok", message: "right-to-left \u202E override" },
      { code: "ok", message: "zero-width \u200B space" },
      { code: "ok", message: "next \u0085 line" },
      { code: "ok", message: `left-to-right isolate ${LRI} mark` },
      { code: "ok", message: `paragraph ${PARAGRAPH_SEPARATOR} separator` },
      { code: "ok", message: "fine", extra: true },
    ]) {
      const result = { status: "degraded", reason: "content-index-refused", cause: bad };
      expect(() => decodeContextPreflight(result), JSON.stringify(bad)).toThrow();
      if (!("extra" in bad)) {
        expect(() => normalizeContextPreflight(result as ContextPreflightResult)).toThrow(
          "invalid cause",
        );
      }
    }
    // The builder escapes, repairs, and bounds what it is given.
    expect(
      contextPreflightCause(
        "ok",
        `rlo ${RLO} zero-width ${ZERO_WIDTH_SPACE} next-line ${NEXT_LINE} soft ${SOFT_HYPHEN} separator ${LINE_SEPARATOR} end`,
      ).message,
    ).toBe(
      "rlo \\u{202e} zero-width \\u{200b} next-line \\u{85} soft \\u{ad} separator \\u{2028} end",
    );
    // A separator or U+FEFF in a page name is escaped before whitespace
    // collapses, so the name keeps its spelling.
    expect(
      contextPreflightCause(
        "ok",
        `docs/a${LINE_SEPARATOR}b.md, docs/c${PARAGRAPH_SEPARATOR}d.md, and docs/e${BYTE_ORDER_MARK}f.md are refused`,
      ).message,
    ).toBe("docs/a\\u{2028}b.md, docs/c\\u{2029}d.md, and docs/e\\u{feff}f.md are refused");
    const built = contextPreflightCause(
      "not a code",
      `bell${String.fromCodePoint(0x7)} lone ${String.fromCharCode(0xd800)} ${"x".repeat(600)}`,
    );
    expect(built.code).toBe("Error");
    expect(built.message.startsWith(`bell\\u{7} lone ${REPLACEMENT_CHARACTER} `)).toBe(true);
    expect(built.message.endsWith("...")).toBe(true);
    expect(built.message).toHaveLength(512);
    const evidence = normalizeContextPreflight({
      status: "degraded",
      reason: "context-compile-failed",
      cause: built,
    });
    expect(decodeContextPreflight(evidence)).toEqual(evidence);
  });
});
