// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  decodeDocumentationNavigationFixture,
  evaluateDocumentationNavigationFixture,
  type DocumentationNavigationFixtureV1,
} from "../src/quality-evaluation/documentation-navigation.js";
import {
  formatRepositoryNavigationLimitations,
  observeRepositoryNavigation,
} from "../src/repository/navigation-observation.js";
import {
  buildRepositoryDiscoveryInventory,
  decodeRepositoryDiscoveryInventory,
} from "../src/repository/inventory.js";
import type { RunRecord } from "../src/records/contracts.js";
import {
  attachSealedInventory,
  captureProductionLimitOverflow,
} from "./helpers/limit-overflow-cli.js";
import { prepareRepositoryWorkspace } from "../src/repository/workspace/materialize.js";
import { listTrackedRepositoryEntries } from "../src/repository/workspace/tracked-read.js";
import { initFixtureRepo } from "./helpers/git.js";
import { internalOnly } from "./helpers/internal-path.js";

const canonicalFixturePath = new URL(
  "../docs/internal/navigation-query-fixture.json",
  import.meta.url,
);
// A pinned copy of the canonical fixture; only query wording that named a
// retired codename differs.
const pinnedFixturePath = new URL(
  "./fixtures/public-export/documentation-navigation-fixture.json",
  import.meta.url,
);
const internalDocs = internalOnly(
  "packages/runtime/docs/internal",
  "it pins the internal IA decision record, which is not exported",
);
const temporary: string[] = [];
const MKDOCS = "site_name: Product\nnav:\n  - Home: README.md\n";
const README = "# Nav\n";

afterEach(async () => {
  vi.unstubAllEnvs();
  process.exitCode = undefined;
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function fixture(path = pinnedFixturePath): Promise<DocumentationNavigationFixtureV1> {
  return decodeDocumentationNavigationFixture(JSON.parse(await readFile(path, "utf8")));
}

function withoutQueryWording(value: DocumentationNavigationFixtureV1) {
  return { ...value, queries: value.queries.map(({ query: _query, ...rest }) => rest) };
}

describe("canonical documentation navigation fixture", () => {
  it.skipIf(internalDocs.skip)(
    internalDocs.title("preserves the IA decision-record query IDs and passes the Recall@3 gate"),
    async () => {
      const value = await fixture(canonicalFixturePath);
      expect(withoutQueryWording(await fixture())).toEqual(withoutQueryWording(value));
      const decisionRecord = await readFile(
        new URL("../docs/internal/ia-decision-record.md", import.meta.url),
        "utf8",
      );
      for (const query of value.queries) {
        expect(decisionRecord).toContain(`\`${query.id}\``);
        await Promise.all(
          query.expectedPaths.map((path) =>
            readFile(new URL(`../${path}`, import.meta.url), "utf8"),
          ),
        );
      }

      const rankings = Object.fromEntries(
        value.queries.map((query) => [
          query.id,
          ["docs/README.md", "docs/internal/README.md", query.expectedPaths[0]!],
        ]),
      );
      const evaluation = evaluateDocumentationNavigationFixture(value, rankings);
      expect(evaluation).toMatchObject({
        recallAtK: 3,
        minimumRecall: 0.8,
        recall: 1,
        passed: true,
      });
    },
  );

  it("fails when Recall@3 drops below the required 80 percent", async () => {
    const value = await fixture();
    const rankings = Object.fromEntries(
      value.queries.map((query, index) => [
        query.id,
        index < 8 ? [query.expectedPaths[0]!] : ["docs/README.md"],
      ]),
    );
    const evaluation = evaluateDocumentationNavigationFixture(value, rankings);
    expect(evaluation).toMatchObject({
      recalledQueries: 8,
      queryCount: 11,
      recall: 8 / 11,
      passed: false,
    });
  });

  it("rejects malformed or substituted fixture fields and rankings", async () => {
    const value = await fixture();
    expect(() => decodeDocumentationNavigationFixture({ ...value, recallAtK: 10 })).toThrow(
      "The documentation navigation fixture is invalid or unsafe.",
    );
    expect(() => evaluateDocumentationNavigationFixture(value, { attacker: [] })).toThrow(
      "The documentation navigation fixture is invalid or unsafe.",
    );
  });
});

describe("central repository navigation budgets (T5 / #1021)", () => {
  it("observes every source at the catalog bound", async () => {
    const repository = await mkdocsSourceRepository(2);
    const workspace = await prepareRepositoryWorkspace(repository, "HEAD");
    try {
      const observation = await observeRepositoryNavigation({
        workspace,
        entries: await listTrackedRepositoryEntries(workspace),
        limits: navigationLimits({ DOCSFAB_REPOSITORY_NAVIGATION_MAX_SOURCES: "2" }),
      });
      expect(observation.failures.map((item) => item.code)).not.toContain("source-budget-exceeded");
      expect(observation.sources.length).toBe(2);
      expect(
        formatRepositoryNavigationLimitations(
          observation,
          navigationLimits({ DOCSFAB_REPOSITORY_NAVIGATION_MAX_SOURCES: "2" }),
        ).join("\n"),
      ).not.toContain("repository.navigationMaxSources");
    } finally {
      await workspace.dispose();
    }
  });

  it("records source count overflow at bound plus one with the actual count", async () => {
    const repository = await mkdocsSourceRepository(3);
    const limits = navigationLimits({ DOCSFAB_REPOSITORY_NAVIGATION_MAX_SOURCES: "2" });
    const workspace = await prepareRepositoryWorkspace(repository, "HEAD");
    try {
      const observation = await observeRepositoryNavigation({
        workspace,
        entries: await listTrackedRepositoryEntries(workspace),
        limits,
      });
      expect(observation.failures).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: "source-budget-exceeded",
            overflow: { limitName: "repository.navigationMaxSources", observed: 3 },
          }),
        ]),
      );
      const summary = formatRepositoryNavigationLimitations(observation, limits).join("\n");
      expect(summary).toMatch(/3 exceeds repository\.navigationMaxSources = 2 count/);
      expect(summary).toContain("repository-navigation-max-sources-bound");
      expect(summary).toContain("Follow the named remediation.");
      vi.stubEnv("DOCSFAB_REPOSITORY_NAVIGATION_MAX_SOURCES", "2");
      const inventory = await buildRepositoryDiscoveryInventory({ workspace, limits });
      const persisted = decodeRepositoryDiscoveryInventory(JSON.parse(JSON.stringify(inventory)));
      const captured = await captureProductionLimitOverflow({
        record: attachSealedInventory(overflowRunRecord(), persisted),
        roots: temporary,
      });
      for (const human of [captured.runHuman, captured.showHuman]) {
        expect(human).toMatch(/3 exceeds repository\.navigationMaxSources = 2 count/);
        expect(human).toContain("LIMITATIONS");
        expect(human).toContain("Follow the named remediation.");
      }
      expect(captured.envelope.limitOverflow?.join("\n")).toMatch(
        /3 exceeds repository\.navigationMaxSources = 2 count/,
      );
      expect(captured.runJson).toMatch(/3 exceeds repository\.navigationMaxSources = 2 count/);
      expect(captured.showJson).toMatch(/3 exceeds repository\.navigationMaxSources = 2 count/);
    } finally {
      await workspace.dispose();
    }
  });

  it("reports the actual source count when overflow is greater than bound plus one", async () => {
    const limits = navigationLimits({ DOCSFAB_REPOSITORY_NAVIGATION_MAX_SOURCES: "2" });
    const workspace = await prepareRepositoryWorkspace(await mkdocsSourceRepository(4), "HEAD");
    try {
      const observation = await observeRepositoryNavigation({
        workspace,
        entries: await listTrackedRepositoryEntries(workspace),
        limits,
      });
      expect(observation.failures).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: "source-budget-exceeded",
            overflow: { limitName: "repository.navigationMaxSources", observed: 4 },
          }),
        ]),
      );
      const summary = formatRepositoryNavigationLimitations(observation, limits).join("\n");
      expect(summary).toMatch(/4 exceeds repository\.navigationMaxSources = 2 count/);
      expect(summary).not.toMatch(/3 exceeds repository\.navigationMaxSources/);
    } finally {
      await workspace.dispose();
    }
  });

  it("records total source-byte overflow at bound plus one with the actual bytes", async () => {
    const source = MKDOCS;
    const sourceBytes = Buffer.byteLength(source);
    const repository = await writeTrackedRepo({
      "nav-0/mkdocs.yml": source,
      "nav-0/README.md": README,
      "nav-1/mkdocs.yml": source,
      "nav-1/README.md": README,
    });
    const atBound = navigationLimits({
      DOCSFAB_REPOSITORY_NAVIGATION_MAX_TOTAL_SOURCE_BYTES: String(sourceBytes),
    });
    const workspaceBound = await prepareRepositoryWorkspace(
      await writeTrackedRepo({
        "nav-0/mkdocs.yml": source,
        "nav-0/README.md": README,
      }),
      "HEAD",
    );
    const workspaceOver = await prepareRepositoryWorkspace(repository, "HEAD");
    try {
      const complete = await observeRepositoryNavigation({
        workspace: workspaceBound,
        entries: await listTrackedRepositoryEntries(workspaceBound),
        limits: atBound,
      });
      expect(complete.failures.map((item) => item.code)).not.toContain("source-budget-exceeded");

      const over = await observeRepositoryNavigation({
        workspace: workspaceOver,
        entries: await listTrackedRepositoryEntries(workspaceOver),
        limits: atBound,
      });
      expect(over.failures).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: "source-budget-exceeded",
            overflow: {
              limitName: "repository.navigationMaxTotalSourceBytes",
              observed: sourceBytes * 2,
            },
          }),
        ]),
      );
      const summary = formatRepositoryNavigationLimitations(over, atBound).join("\n");
      expect(summary).toContain("repository.navigationMaxTotalSourceBytes");
      expect(summary).toMatch(
        new RegExp(
          `${sourceBytes * 2} exceeds repository\\.navigationMaxTotalSourceBytes = ${sourceBytes} bytes`,
        ),
      );
    } finally {
      await workspaceBound.dispose();
      await workspaceOver.dispose();
    }
  });

  it("records target count overflow at bound plus one with the actual count", async () => {
    const atBound = navigationLimits({ DOCSFAB_REPOSITORY_NAVIGATION_MAX_TARGETS: "2" });
    const workspaceBound = await prepareRepositoryWorkspace(
      await mkdocsTargetRepository(2),
      "HEAD",
    );
    const workspaceOver = await prepareRepositoryWorkspace(await mkdocsTargetRepository(3), "HEAD");
    try {
      const complete = await observeRepositoryNavigation({
        workspace: workspaceBound,
        entries: await listTrackedRepositoryEntries(workspaceBound),
        limits: atBound,
      });
      expect(complete.failures.map((item) => item.code)).not.toContain("target-budget-exceeded");

      const over = await observeRepositoryNavigation({
        workspace: workspaceOver,
        entries: await listTrackedRepositoryEntries(workspaceOver),
        limits: atBound,
      });
      expect(over.failures).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: "target-budget-exceeded",
            overflow: { limitName: "repository.navigationMaxTargets", observed: 3 },
          }),
        ]),
      );
      const summary = formatRepositoryNavigationLimitations(over, atBound).join("\n");
      expect(summary).toMatch(/3 exceeds repository\.navigationMaxTargets = 2 count/);
    } finally {
      await workspaceBound.dispose();
      await workspaceOver.dispose();
    }
  });

  it("records total target-byte overflow at bound plus one with the actual bytes", async () => {
    const page = "# Page\n";
    const pageBytes = Buffer.byteLength(page);
    const mkdocs = ["site_name: Product", "nav:", "  - One: one.md", "  - Two: two.md", ""].join(
      "\n",
    );
    const atBound = navigationLimits({
      DOCSFAB_REPOSITORY_NAVIGATION_MAX_TOTAL_TARGET_BYTES: String(pageBytes),
    });
    const workspaceBound = await prepareRepositoryWorkspace(
      await writeTrackedRepo({
        "mkdocs.yml": "site_name: Product\nnav:\n  - One: one.md\n",
        "one.md": page,
      }),
      "HEAD",
    );
    const workspaceOver = await prepareRepositoryWorkspace(
      await writeTrackedRepo({
        "mkdocs.yml": mkdocs,
        "one.md": page,
        "two.md": page,
      }),
      "HEAD",
    );
    try {
      const complete = await observeRepositoryNavigation({
        workspace: workspaceBound,
        entries: await listTrackedRepositoryEntries(workspaceBound),
        limits: atBound,
      });
      expect(complete.failures.map((item) => item.code)).not.toContain("target-budget-exceeded");

      const over = await observeRepositoryNavigation({
        workspace: workspaceOver,
        entries: await listTrackedRepositoryEntries(workspaceOver),
        limits: atBound,
      });
      expect(over.failures).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: "target-budget-exceeded",
            overflow: {
              limitName: "repository.navigationMaxTotalTargetBytes",
              observed: pageBytes * 2,
            },
          }),
        ]),
      );
      const summary = formatRepositoryNavigationLimitations(over, atBound).join("\n");
      expect(summary).toContain("repository.navigationMaxTotalTargetBytes");
      expect(summary).toMatch(
        new RegExp(
          `${pageBytes * 2} exceeds repository\\.navigationMaxTotalTargetBytes = ${pageBytes} bytes`,
        ),
      );
    } finally {
      await workspaceBound.dispose();
      await workspaceOver.dispose();
    }
  });
});

function navigationLimits(overrides: Record<string, string>) {
  return {
    environment: {
      ...process.env,
      ...overrides,
    },
    hostFile: null as const,
    projectFile: null as const,
  };
}

async function mkdocsSourceRepository(count: number): Promise<string> {
  const files: Record<string, string> = {};
  for (let index = 0; index < count; index += 1) {
    files[`nav-${index}/README.md`] = README;
    files[`nav-${index}/mkdocs.yml`] = MKDOCS;
  }
  return await writeTrackedRepo(files);
}

async function mkdocsTargetRepository(count: number): Promise<string> {
  const nav = Array.from({ length: count }, (_, index) => `  - Page ${index}: page-${index}.md`);
  const files: Record<string, string> = {
    "mkdocs.yml": `site_name: Product\nnav:\n${nav.join("\n")}\n`,
  };
  for (let index = 0; index < count; index += 1) {
    files[`page-${index}.md`] = `# Page ${index}\n`;
  }
  return await writeTrackedRepo(files);
}

async function writeTrackedRepo(files: Record<string, string>): Promise<string> {
  const repository = await mkdtemp(join(tmpdir(), "docsfab-nav-bound-"));
  temporary.push(repository);
  await initFixtureRepo(repository, files, { message: "bounded navigation fixture" });
  return repository;
}

function overflowRunRecord(): RunRecord {
  return {
    schemaVersion: 2,
    id: "run-limit-overflow",
    workflow: "review-documentation",
    repository: {
      sourcePath: "/tmp/example",
      requestedRevision: "HEAD",
      revision: "a".repeat(40),
    },
    workspace: { strategy: "tracked-export", disposable: true },
    status: "succeeded",
    createdAt: "2026-09-21T16:00:00.000Z",
    models: [],
    skills: [],
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, turns: 0 },
    tools: { totalCalls: 0, failedCalls: 0, byTool: [] },
    steps: [],
  };
}
