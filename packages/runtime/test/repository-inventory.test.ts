// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { canonicalDigest, canonicalJson } from "../src/content-ir/index.js";
import {
  buildRepositoryDiscoveryInventory,
  decodeRepositoryBatchProbeEvidenceShape,
  decodeRepositoryDiscoveryInventory,
  formatRepositoryInventoryLimitations,
  RepositoryInventoryError,
  runRepositoryBatchProbes,
  validateRepositoryBatchProbeEvidenceAuthority,
  type RepositoryBatchProbeEvidenceV1,
  type RepositoryBatchProbeRequestV1,
} from "../src/repository/inventory.js";
import type { RunRecord } from "../src/records/contracts.js";
import {
  attachSealedInventory,
  captureProductionLimitOverflow,
} from "./helpers/limit-overflow-cli.js";
import { prepareRepositoryWorkspace } from "../src/repository/workspace/materialize.js";
import type { RepositoryWorkspace } from "../src/repository/workspace/contracts.js";
import { listTrackedRepositoryEntries } from "../src/repository/workspace/tracked-read.js";
import {
  fernVersionNavigationPaths,
  observeFernNavigation,
} from "../src/repository/fern-navigation.js";
import { observeRepositoryNavigation } from "../src/repository/navigation-observation.js";
import { SEARCH_ARTIFACT_REQUIRED_PROBES } from "../src/search/index.js";
import { documentationAuditSearch } from "../src/maturity/audit-search-plan.js";
import { getWorkflow } from "../src/workflow-registry/catalog.js";
import { LocalWorkflowSearchCoordinator } from "../src/search/local-workflow-coordinator.js";
import {
  instantiateWorkflowSearchTargets,
  normalizeWorkflowSearchEvidence,
} from "../src/workflow-contracts/search.js";
import { commitFixture, git, initFixtureRepo } from "./helpers/git.js";

/** Git/archive inventory suites need headroom under parallel Vitest workers. */
const HEAVY_SUITE_TIMEOUT_MS = 180_000;
const temporary: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  process.exitCode = undefined;
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("governed repository discovery inventory", { timeout: HEAVY_SUITE_TIMEOUT_MS }, () => {
  it("is deterministic, content-minimized, and declares exact coverage policies", async () => {
    const repository = await fixtureRepository();
    await writeFile(join(repository, "ignored-private.md"), "IGNORED_CONTENT_SENTINEL\n");
    await writeFile(join(repository, "untracked.md"), "UNTRACKED_CONTENT_SENTINEL\n");
    const first = await inventoryAt(repository, "HEAD");
    const second = await inventoryAt(repository, "HEAD");

    expect(canonicalJson(first)).toBe(canonicalJson(second));
    expect(first.status).toBe("complete");
    expect(first.coverage).toMatchObject({
      structure: { policy: "tracked-tree-v1", status: "complete", omittedCount: 0 },
      text: { policy: "tracked-regular-utf8-v1", status: "complete", omittedCount: 0 },
      navigation: { policy: "repository-navigation-observation-v1", status: "complete" },
      metadata: { policy: "repository-metadata-v1", status: "complete" },
    });
    expect(first.files.map((item) => item.path)).toEqual(
      expect.arrayContaining(["README.md", "package.json", "docs/guide.md"]),
    );
    expect(first.documents.map((item) => item.path)).toEqual([
      "AGENTS.md",
      "README.md",
      "docs/guide.md",
      "docs/internal/runbook.md",
    ]);
    expect(first.navigation.graphEdgeCount).toBeGreaterThan(0);
    expect(first.signals).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ category: "site-generator", name: "docusaurus" }),
        expect.objectContaining({ category: "ci-validation", paths: [".gitlab-ci.yml"] }),
      ]),
    );
    expect(first.commands).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ purpose: "docs-build", invocation: "npm run docs:build" }),
        expect.objectContaining({ purpose: "lint", invocation: "npm run lint" }),
      ]),
    );
    const serialized = canonicalJson(first);
    expect(serialized).not.toContain(repository);
    expect(serialized).not.toContain("IGNORED_CONTENT_SENTINEL");
    expect(serialized).not.toContain("UNTRACKED_CONTENT_SENTINEL");
    expect(serialized).not.toContain("echo repository script body");
    expect(decodeRepositoryDiscoveryInventory(JSON.parse(serialized))).toEqual(first);

    let getterCalls = 0;
    const hostile = Object.defineProperty({}, "schemaVersion", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return 1;
      },
    });
    expect(() => decodeRepositoryDiscoveryInventory(hostile)).toThrow(RepositoryInventoryError);
    expect(getterCalls).toBe(0);
  });

  it("finds exact paths, filenames, and literal symbols from a fixture inventory", async () => {
    const repository = await fixtureRepository();
    await mkdir(join(repository, "src/cli"), { recursive: true });
    await writeFile(join(repository, "src/cli.ts"), "export const cli = true;\n");
    await writeFile(
      join(repository, "src/cli/run-request.ts"),
      "export class LocalWorkflowSearchCoordinator {}\n",
    );
    await commitFixture(repository, "add cli symbols");
    const workspace = await prepareRepositoryWorkspace(repository, "HEAD");
    try {
      const inventory = await buildRepositoryDiscoveryInventory({ workspace });
      const requests: RepositoryBatchProbeRequestV1[] = [
        { id: "exact-cli", question: { kind: "exact-path", path: "src/cli.ts" } },
        { id: "filename-cli", question: { kind: "filename", name: "cli.ts" } },
        {
          id: "literal-coordinator",
          question: { kind: "literal-text", value: "LocalWorkflowSearchCoordinator" },
        },
      ];
      const evidence = runRepositoryBatchProbes({
        inventory,
        target: readinessTarget(workspace),
        probes: requests,
      });
      expect(evidence.results).toEqual([
        expect.objectContaining({ id: "exact-cli", disposition: "found", paths: ["src/cli.ts"] }),
        expect.objectContaining({
          id: "filename-cli",
          disposition: "found",
          paths: expect.arrayContaining(["src/cli.ts"]),
        }),
        expect.objectContaining({
          id: "literal-coordinator",
          disposition: "found",
          paths: expect.arrayContaining(["src/cli/run-request.ts"]),
        }),
      ]);
    } finally {
      await workspace.dispose();
    }
  });

  it("binds durable evidence to the exact ordered request set and semantic mapping", async () => {
    const repository = await fixtureRepository();
    const workspace = await prepareRepositoryWorkspace(repository, "HEAD");
    try {
      const inventory = await buildRepositoryDiscoveryInventory({ workspace });
      const target = readinessTarget(workspace);
      const requests: RepositoryBatchProbeRequestV1[] = [
        { id: "readme", question: { kind: "exact-path", path: "README.md" } },
        { id: "guide", question: { kind: "exact-path", path: "docs/guide.md" } },
      ];
      const evidence = runRepositoryBatchProbes({ inventory, target, probes: requests });
      expect(decodeRepositoryBatchProbeEvidenceShape(structuredClone(evidence))).toEqual(evidence);
      expect(
        validateRepositoryBatchProbeEvidenceAuthority(evidence, {
          inventory,
          target,
          requests,
        }),
      ).toEqual(evidence);

      const substituted = structuredClone(evidence);
      substituted.results[0]!.paths = [...substituted.results[1]!.paths];
      substituted.results[0]!.evidenceIds = [...substituted.results[1]!.evidenceIds];
      rehashEvidence(substituted, 0);
      expect(decodeRepositoryBatchProbeEvidenceShape(substituted)).toEqual(substituted);
      expect(() =>
        validateRepositoryBatchProbeEvidenceAuthority(substituted, {
          inventory,
          target,
          requests,
        }),
      ).toThrow(RepositoryInventoryError);

      const reordered = [...requests].reverse();
      const reorderedEvidence = runRepositoryBatchProbes({ inventory, target, probes: reordered });
      expect(() =>
        validateRepositoryBatchProbeEvidenceAuthority(reorderedEvidence, {
          inventory,
          target,
          requests,
        }),
      ).toThrow(RepositoryInventoryError);
      expect(
        validateRepositoryBatchProbeEvidenceAuthority(reorderedEvidence, {
          inventory,
          target,
          requests: reordered,
        }),
      ).toEqual(reorderedEvidence);

      const substitutedRequest: RepositoryBatchProbeRequestV1[] = [
        { id: "readme", question: { kind: "exact-path", path: "docs/guide.md" } },
        requests[1]!,
      ];
      const substitutedRequestEvidence = runRepositoryBatchProbes({
        inventory,
        target,
        probes: substitutedRequest,
      });
      expect(() =>
        validateRepositoryBatchProbeEvidenceAuthority(substitutedRequestEvidence, {
          inventory,
          target,
          requests,
        }),
      ).toThrow(RepositoryInventoryError);
    } finally {
      await workspace.dispose();
    }
  });

  it("returns supported mixed-batch results while typing unsupported probes separately", async () => {
    const repository = await fixtureRepository();
    const workspace = await prepareRepositoryWorkspace(repository, "HEAD");
    try {
      const inventory = await buildRepositoryDiscoveryInventory({ workspace });
      const evidence = runRepositoryBatchProbes({
        inventory,
        target: readinessTarget(workspace),
        probes: [
          { id: "readme", question: { kind: "filename", name: "README.md" } },
          { id: "semantic", question: { kind: "unsupported", operation: "semantic-assessment" } },
          { id: "missing", question: { kind: "exact-path", path: "docs/missing.md" } },
        ],
      });
      expect(evidence.results).toEqual([
        expect.objectContaining({ id: "readme", disposition: "found" }),
        expect.objectContaining({
          id: "semantic",
          disposition: "unsupported",
          failureCategory: "unsupported-question",
          matchCount: 0,
          paths: [],
          evidenceIds: [],
        }),
        expect.objectContaining({ id: "missing", disposition: "not-found-after-bounded-search" }),
      ]);
    } finally {
      await workspace.dispose();
    }
  });

  it("rejects extra fields, shell forms, absolute paths, globs, NULs, and cross-revision targets", async () => {
    const repository = await fixtureRepository();
    const workspace = await prepareRepositoryWorkspace(repository, "HEAD");
    try {
      const inventory = await buildRepositoryDiscoveryInventory({ workspace });
      const target = readinessTarget(workspace);
      for (const probe of [
        { id: "hostile", question: { kind: "filename", name: "README.md" }, shell: "env" },
        { id: "hostile", question: { kind: "filename", name: "README.md", glob: "*.md" } },
        { id: "hostile", question: { kind: "filename", name: "*.md" } },
        { id: "hostile", question: { kind: "exact-path", path: "/etc/passwd" } },
        { id: "hostile", question: { kind: "exact-path", path: "../secret" } },
        { id: "hostile", question: { kind: "literal-text", value: "bad\0value" } },
        { id: "hostile", question: { kind: "shell", command: "env" } },
      ]) {
        expect(() =>
          runRepositoryBatchProbes({
            inventory,
            target,
            probes: [probe as never],
          }),
        ).toThrow(RepositoryInventoryError);
      }
      const hostileTarget = instantiateWorkflowSearchTargets(
        getWorkflow("readiness").steps[0]!.search!,
        { identitySha256: "a".repeat(64), revision: "f".repeat(40) },
      )[0]!;
      expect(() =>
        runRepositoryBatchProbes({
          inventory,
          target: hostileTarget,
          probes: [{ id: "docs", question: { kind: "metadata", field: "documentation" } }],
        }),
      ).toThrowError(/does not match/u);
    } finally {
      await workspace.dispose();
    }
  });

  it("never derives absence from symlink, redaction, invalid text, oversize, or raced coverage", async () => {
    const repository = await fixtureRepository();
    await symlink("../guide.md", join(repository, "docs", "linked.md"));
    await writeFile(join(repository, ".env.production"), "TOKEN=TRACKED_SECRET_SENTINEL\n");
    await writeFile(join(repository, "invalid.txt"), Buffer.from([0xff, 0xfe, 0xfd]));
    await writeFile(join(repository, "large.txt"), "x".repeat(1024 * 1024 + 1));
    await writeFile(join(repository, "asset.pdf"), "TRACKED_BINARY_TEXT_SENTINEL\n");
    await commitFixture(repository, "unsafe coverage cases");
    // One byte past a 1 MiB file limit, set through the supported override.
    vi.stubEnv("DOCSFAB_REPOSITORY_INVENTORY_TEXT_MAX_FILE_BYTES", String(1024 * 1024));
    const workspace = await prepareRepositoryWorkspace(repository, "HEAD");
    try {
      const inventory = await buildRepositoryDiscoveryInventory({ workspace });
      expect(inventory.status).toBe("incomplete");
      expect(inventory.failures).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ category: "entry-redacted", affects: ["structure", "text"] }),
          expect.objectContaining({ category: "invalid-text-input", path: "invalid.txt" }),
          expect.objectContaining({ category: "text-index-limit-exceeded", path: "large.txt" }),
          expect.objectContaining({ category: "unsupported-text-format", path: "asset.pdf" }),
          expect.objectContaining({ category: "unsafe-tracked-entry", path: "docs/linked.md" }),
        ]),
      );
      const evidence = runRepositoryBatchProbes({
        inventory,
        target: readinessTarget(workspace),
        probes: [
          { id: "linked", question: { kind: "exact-path", path: "docs/linked.md" } },
          { id: "missing-path", question: { kind: "exact-path", path: "docs/missing.md" } },
          { id: "missing-text", question: { kind: "literal-text", value: "definitely absent" } },
        ],
      });
      expect(evidence.results[0]).toMatchObject({
        disposition: "found",
        paths: ["docs/linked.md"],
      });
      expect(evidence.results[1]).toMatchObject({
        disposition: "incomplete",
        failureCategory: "structure-incomplete",
      });
      expect(evidence.results[2]).toMatchObject({
        disposition: "incomplete",
        failureCategory: "text-index-incomplete",
      });
      expect(JSON.stringify(inventory)).not.toContain("TRACKED_SECRET_SENTINEL");
      expect(JSON.stringify(inventory)).not.toContain(".env.production");
    } finally {
      await workspace.dispose();
    }

    const racedRepository = await fixtureRepository();
    const racedWorkspace = await prepareRepositoryWorkspace(racedRepository, "HEAD");
    try {
      await writeFile(
        join(racedWorkspace.path, "package.json"),
        '{"scripts":{"lint":"changed"}}\n',
      );
      const raced = await buildRepositoryDiscoveryInventory({ workspace: racedWorkspace });
      expect(raced.failures).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ category: "tracked-file-changed", path: "package.json" }),
        ]),
      );
      expect(raced.coverage.metadata.status).toBe("incomplete");
      expect(raced.coverage.text.status).toBe("incomplete");
      const racedEvidence = runRepositoryBatchProbes({
        inventory: raced,
        target: readinessTarget(racedWorkspace),
        probes: [
          { id: "missing-command", question: { kind: "metadata", field: "command" } },
          { id: "missing-literal", question: { kind: "literal-text", value: "absent after race" } },
        ],
      });
      expect(racedEvidence.results).toEqual([
        expect.objectContaining({
          disposition: "incomplete",
          failureCategory: "metadata-index-incomplete",
        }),
        expect.objectContaining({
          disposition: "incomplete",
          failureCategory: "text-index-incomplete",
        }),
      ]);

      const authorized = await buildRepositoryDiscoveryInventory({
        workspace: racedWorkspace,
        authorizedWritePaths: ["package.json"],
      });
      expect(authorized.failures).not.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ category: "tracked-file-changed", path: "package.json" }),
        ]),
      );
      expect(authorized.files.some((item) => item.path === "package.json")).toBe(true);
      await writeFile(join(racedWorkspace.path, "README.md"), "unexpected dirty readme\n");
      const mixed = await buildRepositoryDiscoveryInventory({
        workspace: racedWorkspace,
        authorizedWritePaths: ["package.json"],
      });
      expect(mixed.failures).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ category: "tracked-file-changed", path: "README.md" }),
        ]),
      );
      expect(mixed.failures).not.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ category: "tracked-file-changed", path: "package.json" }),
        ]),
      );
    } finally {
      await racedWorkspace.dispose();
    }

    const oversizeRepository = await fixtureRepository();
    await writeFile(join(oversizeRepository, "package.json"), " ".repeat(1024 * 1024 + 1));
    await commitFixture(oversizeRepository, "oversize metadata");
    const oversizeWorkspace = await prepareRepositoryWorkspace(oversizeRepository, "HEAD");
    try {
      const oversize = await buildRepositoryDiscoveryInventory({ workspace: oversizeWorkspace });
      expect(oversize.failures).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ category: "oversize-input", path: "package.json" }),
        ]),
      );
      const evidence = runRepositoryBatchProbes({
        inventory: oversize,
        target: readinessTarget(oversizeWorkspace),
        probes: [{ id: "missing-command", question: { kind: "metadata", field: "command" } }],
      });
      expect(evidence.results[0]).toMatchObject({
        disposition: "incomplete",
        failureCategory: "metadata-index-incomplete",
      });
    } finally {
      await oversizeWorkspace.dispose();
    }

    const submoduleRepository = await fixtureRepository();
    const gitlinkRevision = await git(submoduleRepository, ["rev-parse", "HEAD"]);
    await git(submoduleRepository, [
      "update-index",
      "--add",
      "--cacheinfo",
      `160000,${gitlinkRevision},vendor/submodule`,
    ]);
    await git(submoduleRepository, ["commit", "-m", "tracked gitlink"]);
    const submoduleWorkspace = await prepareRepositoryWorkspace(submoduleRepository, "HEAD");
    try {
      const submodule = await buildRepositoryDiscoveryInventory({ workspace: submoduleWorkspace });
      expect(submodule.failures).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ category: "unsafe-tracked-entry", path: "vendor/submodule" }),
        ]),
      );
      const evidence = runRepositoryBatchProbes({
        inventory: submodule,
        target: readinessTarget(submoduleWorkspace),
        probes: [
          { id: "gitlink", question: { kind: "exact-path", path: "vendor/submodule" } },
          { id: "missing", question: { kind: "exact-path", path: "vendor/missing" } },
        ],
      });
      expect(evidence.results[0]).toMatchObject({
        disposition: "found",
        paths: ["vendor/submodule"],
      });
      expect(evidence.results[1]).toMatchObject({
        disposition: "incomplete",
        failureCategory: "structure-incomplete",
      });
    } finally {
      await submoduleWorkspace.dispose();
    }
  });

  it("final-verifies binary and content-skipped entries before structural absence", async () => {
    const repository = await fixtureRepository();
    await mkdir(join(repository, "assets"), { recursive: true });
    await writeFile(join(repository, "assets", "deleted.png"), Buffer.from("binary-one"));
    await writeFile(join(repository, "assets", "replaced.png"), Buffer.from("binary-two"));
    await writeFile(join(repository, "assets", "mode.png"), Buffer.from("binary-mode"));
    await writeFile(join(repository, "changed-text.txt"), "CHANGED_ENTRY_LITERAL\n");
    await writeFile(join(repository, "oversize-skipped.txt"), "z".repeat(1024 * 1024 + 1));
    await commitFixture(repository, "tracked skipped structures");
    const workspace = await prepareRepositoryWorkspace(repository, "HEAD");
    try {
      await rm(join(workspace.path, "assets", "deleted.png"));
      await writeFile(join(workspace.path, "assets", "replaced.png"), Buffer.from("binary-new"));
      await chmod(join(workspace.path, "assets", "mode.png"), 0o755);
      await rm(join(workspace.path, "changed-text.txt"));
      await rm(join(workspace.path, "oversize-skipped.txt"));
      const inventory = await buildRepositoryDiscoveryInventory({ workspace });
      expect(inventory.coverage.structure.status).toBe("incomplete");
      expect(inventory.failures).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ category: "tracked-file-changed", path: "assets/deleted.png" }),
          expect.objectContaining({
            category: "tracked-file-changed",
            path: "assets/replaced.png",
          }),
          expect.objectContaining({ category: "tracked-file-changed", path: "assets/mode.png" }),
          expect.objectContaining({ category: "tracked-file-changed", path: "changed-text.txt" }),
          expect.objectContaining({
            category: "tracked-file-changed",
            path: "oversize-skipped.txt",
          }),
        ]),
      );
      const evidence = runRepositoryBatchProbes({
        inventory,
        target: readinessTarget(workspace),
        probes: [
          { id: "changed-exact", question: { kind: "exact-path", path: "assets/deleted.png" } },
          { id: "changed-filename", question: { kind: "filename", name: "deleted.png" } },
          { id: "changed-segment", question: { kind: "path-segment", segment: "assets" } },
          {
            id: "changed-literal",
            question: { kind: "literal-text", value: "CHANGED_ENTRY_LITERAL" },
          },
          {
            id: "unrelated-missing",
            question: { kind: "exact-path", path: "unrelated/missing.png" },
          },
        ],
      });
      expect(evidence.results).toEqual([
        expect.objectContaining({
          id: "changed-exact",
          disposition: "incomplete",
          failureCategory: "structure-incomplete",
          matchCount: 0,
          evidenceIds: [],
          paths: [],
        }),
        expect.objectContaining({
          id: "changed-filename",
          disposition: "incomplete",
          failureCategory: "structure-incomplete",
          matchCount: 0,
          evidenceIds: [],
          paths: [],
        }),
        expect.objectContaining({
          id: "changed-segment",
          disposition: "incomplete",
          failureCategory: "structure-incomplete",
          matchCount: 0,
          evidenceIds: [],
          paths: [],
        }),
        expect.objectContaining({
          id: "changed-literal",
          disposition: "incomplete",
          failureCategory: "text-index-incomplete",
          matchCount: 0,
          evidenceIds: [],
          paths: [],
        }),
        expect.objectContaining({
          id: "unrelated-missing",
          disposition: "incomplete",
          failureCategory: "structure-incomplete",
          matchCount: 0,
          evidenceIds: [],
          paths: [],
        }),
      ]);
    } finally {
      await workspace.dispose();
    }
  });

  it("keeps documentation inventory separate from a graph-absent navigation answer", async () => {
    const repository = await fixtureRepository({ graphAbsent: true });
    const workspace = await prepareRepositoryWorkspace(repository, "HEAD");
    try {
      const inventory = await buildRepositoryDiscoveryInventory({ workspace });
      expect(inventory.documents.length).toBeGreaterThan(0);
      expect(inventory.navigation.graphEdgeCount).toBe(0);
      const evidence = runRepositoryBatchProbes({
        inventory,
        target: readinessTarget(workspace),
        probes: [
          { id: "docs", question: { kind: "metadata", field: "documentation" } },
          { id: "nav", question: { kind: "metadata", field: "navigation-graph" } },
        ],
      });
      expect(evidence.results).toEqual([
        expect.objectContaining({ id: "docs", disposition: "found" }),
        expect.objectContaining({
          id: "nav",
          disposition: "not-found-after-bounded-search",
          matchCount: 0,
        }),
      ]);

      const workflow = getWorkflow("review-documentation");
      const step = { ...workflow.steps[0]!, search: documentationAuditSearch };
      const repositoryTarget = {
        sourcePath: repository,
        requestedRevision: "HEAD",
        revision: workspace.revision,
      };
      const result = await new LocalWorkflowSearchCoordinator({ workspace }).search({
        runId: "graph-absent-production-path",
        repositoryPath: workspace.path,
        repository: repositoryTarget,
        workflow,
        step,
        plan: documentationAuditSearch,
      });
      const search = result.searches[0]!;
      const docProbe = search.bounded.probes.find((probe) => probe.id === "audit-doc-inventory")!;
      const navProbe = search.bounded.probes.find((probe) => probe.id === "audit-nav-graph")!;
      expect(docProbe.outcome).toBe("match");
      expect(navProbe.outcome).toBe("no-match");
      expect(search.bounded.coverage.sufficient).toBe(false);
      expect(search.bounded.confidence.disposition).not.toBe("found");
      expect(search.bounded.confidence.level).not.toBe("confirmed");
    } finally {
      await workspace.dispose();
    }
  });

  it("completes tracked Fern navigation while retaining unrelated global Content IR failure", async () => {
    const repository = await fernRepository();
    const workspace = await prepareRepositoryWorkspace(repository, "HEAD");
    try {
      const inventory = await buildRepositoryDiscoveryInventory({ workspace });
      expect(inventory.status).toBe("incomplete");
      expect(inventory.contentIndex.status).toBe("incomplete");
      expect(inventory.coverage.navigation).toMatchObject({
        policy: "repository-navigation-observation-v1",
        status: "complete",
        indexedCount: 6,
      });
      expect(inventory.failures).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ category: "content-index-incomplete", affects: [] }),
        ]),
      );
      expect(inventory.navigation.navigationEdgeCount).toBe(6);
      expect(inventory.navigation.routes?.map(({ path, route }) => ({ path, route }))).toEqual([
        { path: "fern/pages/collections/_index.mdx", route: "/router/collections" },
        {
          path: "fern/pages/collections/authoring/create.mdx",
          route: "/router/collections/authoring/create",
        },
        {
          path: "fern/pages/collections/authoring/delete.mdx",
          route: "/router/collections/authoring/delete",
        },
        {
          path: "fern/pages/collections/authoring/update.mdx",
          route: "/router/collections/authoring/update",
        },
        { path: "fern/pages/collections/concepts.mdx", route: "/router/collections/concepts" },
        { path: "fern/pages/collections/guide.mdx", route: "/router/collections/guide" },
      ]);
      expect(inventory.navigation.sources?.map((source) => source.path)).toEqual([
        "fern/docs.yml",
        "fern/versions/nightly.yml",
      ]);

      const target = readinessTarget(workspace);
      const batch = runRepositoryBatchProbes({
        inventory,
        target,
        probes: [{ id: "nav", question: { kind: "metadata", field: "navigation-graph" } }],
      });
      expect(batch.results[0]).toMatchObject({
        disposition: "found",
        matchCount: 1,
        paths: expect.arrayContaining([
          "fern/docs.yml",
          "fern/versions/nightly.yml",
          "fern/pages/collections/authoring/update.mdx",
        ]),
      });

      const workflow = getWorkflow("update-documentation");
      const step = workflow.steps[0]!;
      const repositoryTarget = {
        sourcePath: repository,
        requestedRevision: "HEAD",
        revision: workspace.revision,
      };
      const result = await new LocalWorkflowSearchCoordinator({ workspace }).search({
        runId: "router-navigation-independent-of-content-ir",
        repositoryPath: workspace.path,
        repository: repositoryTarget,
        workflow,
        step,
        plan: step.search!,
      });
      const nav = result.searches
        .flatMap((search) => search.bounded.probes)
        .find((probe) => probe.id === "observation-nav-graph");
      expect(nav).toMatchObject({ outcome: "match" });
      expect(nav?.matchCount).toBeGreaterThan(0);
      expect(nav?.citations.map((citation) => citation.path)).toEqual(
        expect.arrayContaining([
          "fern/docs.yml",
          "fern/versions/nightly.yml",
          "fern/pages/collections/authoring/update.mdx",
        ]),
      );
    } finally {
      await workspace.dispose();
    }
  });

  it("resolves Fern version references using the source path platform", () => {
    expect(
      fernVersionNavigationPaths(
        "C:\\repository\\fern\\docs.yml",
        "versions:\n  - path: ./versions/nightly.yml\n",
      ),
    ).toEqual(["C:\\repository\\fern\\versions\\nightly.yml"]);
    expect(
      fernVersionNavigationPaths(
        "/repository/fern/docs.yml",
        "versions:\n  - path: ./versions/nightly.yml\n",
      ),
    ).toEqual(["/repository/fern/versions/nightly.yml"]);
  });

  it.each([
    ["MkDocs", "mkdocs.yml", "nav:\n  - docs/guide.md\n  - docs/internal/runbook.md\n"],
    [
      "Jupyter Book",
      "_toc.yml",
      "root: docs/guide.md\nchapters:\n  - file: docs/internal/runbook.md\n",
    ],
    ["Docusaurus JSON", "sidebars.json", '["docs/guide","docs/internal/runbook"]\n'],
  ])("preserves %s navigation through the common observation", async (_name, path, source) => {
    const repository = await fixtureRepository({ graphAbsent: true });
    await writeFile(join(repository, path), source);
    await writeFile(
      join(repository, "README.md"),
      "# Product\n\n[Unrelated historical link](../../docs/missing.md)\n",
    );
    await commitFixture(repository, `add ${path}`);
    const workspace = await prepareRepositoryWorkspace(repository, "HEAD");
    try {
      const inventory = await buildRepositoryDiscoveryInventory({ workspace });
      expect(inventory.contentIndex.status).toBe("incomplete");
      expect(inventory.coverage.navigation.status).toBe("complete");
      expect(inventory.navigation.navigationEdgeCount).toBeGreaterThan(0);
      expect(inventory.navigation.paths).toContain(path);
      expect(
        runRepositoryBatchProbes({
          inventory,
          target: readinessTarget(workspace),
          probes: [{ id: "nav", question: { kind: "metadata", field: "navigation-graph" } }],
        }).results[0],
      ).toMatchObject({ disposition: "found" });
    } finally {
      await workspace.dispose();
    }
  });

  it("does not turn MkDocs metadata paths into navigation evidence", async () => {
    const repository = await fixtureRepository({ graphAbsent: true });
    await writeFile(
      join(repository, "mkdocs.yml"),
      "site_name: Product\nwatch:\n  - docs/guide.md\n  - docs/internal/runbook.md\n",
    );
    await commitFixture(repository, "add MkDocs metadata without nav");
    const workspace = await prepareRepositoryWorkspace(repository, "HEAD");
    try {
      const observation = await observeRepositoryNavigation({
        workspace,
        entries: await listTrackedRepositoryEntries(workspace),
      });
      const inventory = await buildRepositoryDiscoveryInventory({ workspace });
      expect(inventory.coverage.navigation.status).toBe("incomplete");
      expect(inventory.navigation.navigationEdgeCount).toBe(0);
      expect(inventory.navigation.routes).toEqual([]);
      expect(observation.failures).toEqual([
        expect.objectContaining({
          adapter: "mkdocs-yaml-v1",
          code: "navigation-missing",
          path: "mkdocs.yml",
        }),
      ]);

      const workflow = getWorkflow("update-documentation");
      const step = workflow.steps[0]!;
      const result = await new LocalWorkflowSearchCoordinator({ workspace }).search({
        runId: "mkdocs-metadata-is-not-navigation",
        repositoryPath: workspace.path,
        repository: {
          sourcePath: repository,
          requestedRevision: "HEAD",
          revision: workspace.revision,
        },
        workflow,
        step,
        plan: step.search!,
      });
      const nav = result.searches
        .flatMap((search) => search.bounded.probes)
        .find((probe) => probe.id === "observation-nav-graph");
      expect(nav).toMatchObject({ outcome: "blocked", matchCount: 0 });
    } finally {
      await workspace.dispose();
    }
  });

  it("binds MkDocs navigation only to the explicit nav field", async () => {
    const repository = await fixtureRepository({ graphAbsent: true });
    await writeFile(join(repository, "docs", "watched.md"), "# Watched metadata\n");
    await writeFile(
      join(repository, "mkdocs.yml"),
      [
        "site_name: Product",
        "watch:",
        "  - docs/watched.md",
        "nav:",
        "  - Guide: docs/guide.md",
        "  - Internal:",
        "      - Runbook: docs/internal/runbook.md",
        "",
      ].join("\n"),
    );
    await commitFixture(repository, "add explicit MkDocs nav beside path metadata");
    const workspace = await prepareRepositoryWorkspace(repository, "HEAD");
    try {
      const inventory = await buildRepositoryDiscoveryInventory({ workspace });
      expect(inventory.coverage.navigation.status).toBe("complete");
      expect(inventory.navigation.navigationEdgeCount).toBe(1);
      const routes = inventory.navigation.routes;
      expect(routes).toBeDefined();
      if (!routes) throw new Error("Expected host-produced navigation routes.");
      expect(routes.map((route) => route.path)).toEqual([
        "docs/guide.md",
        "docs/internal/runbook.md",
      ]);
      expect(inventory.navigation.paths).not.toContain("docs/watched.md");
    } finally {
      await workspace.dispose();
    }
  });

  it.each([
    [
      "MkDocs unsupported target",
      "mkdocs.yml",
      "nav:\n  - Guide: docs/guide.md\n  - Reference: docs/reference.rst\n",
      "unsupported-navigation-target",
    ],
    [
      "Jupyter Book unsupported child",
      "_toc.yml",
      "root: README.md\nchapters:\n  - file: docs/guide.md\n  - glob: docs/*.md\n",
      "unsupported-navigation-shape",
    ],
    [
      "Docusaurus autogenerated sibling",
      "sidebars.json",
      '{"tutorialSidebar":["docs/guide",{"type":"autogenerated","dirName":"docs"}]}\n',
      "unsupported-navigation-shape",
    ],
  ])(
    "fails %s closed instead of omitting the relevant member",
    async (_name, path, source, failureCode) => {
      const repository = await fixtureRepository({ graphAbsent: true });
      await writeFile(join(repository, "docs", "reference.rst"), "Reference\n=========\n");
      await writeFile(join(repository, path), source);
      await commitFixture(repository, `add unsupported ${path} member`);
      const workspace = await prepareRepositoryWorkspace(repository, "HEAD");
      try {
        const observation = await observeRepositoryNavigation({
          workspace,
          entries: await listTrackedRepositoryEntries(workspace),
        });
        const inventory = await buildRepositoryDiscoveryInventory({ workspace });
        expect(inventory.coverage.navigation.status).toBe("incomplete");
        expect(inventory.navigation.navigationEdgeCount).toBe(0);
        expect(inventory.navigation.routes).toEqual([]);
        expect(observation.failures).toEqual([
          expect.objectContaining({ code: failureCode, path }),
        ]);
        expect(
          runRepositoryBatchProbes({
            inventory,
            target: readinessTarget(workspace),
            probes: [{ id: "nav", question: { kind: "metadata", field: "navigation-graph" } }],
          }).results[0],
        ).toMatchObject({ disposition: "incomplete", matchCount: 0 });
      } finally {
        await workspace.dispose();
      }
    },
  );

  it("keeps tracked navigation complete across an unrelated missing Markdown anchor", async () => {
    const repository = await fixtureRepository({ graphAbsent: true });
    await writeFile(
      join(repository, "_toc.yml"),
      "root: docs/guide.md\nchapters:\n  - file: docs/internal/runbook.md\n",
    );
    await writeFile(
      join(repository, "README.md"),
      "# Product\n\n[Unrelated missing anchor](docs/guide.md#not-present)\n",
    );
    await commitFixture(repository, "add toc beside unrelated broken anchor");
    const workspace = await prepareRepositoryWorkspace(repository, "HEAD");
    try {
      const inventory = await buildRepositoryDiscoveryInventory({ workspace });
      expect(inventory.contentIndex.status).toBe("incomplete");
      expect(inventory.coverage.navigation.status).toBe("complete");
      expect(inventory.navigation.navigationEdgeCount).toBe(1);
      expect(inventory.failures).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ category: "content-index-incomplete", affects: [] }),
        ]),
      );
    } finally {
      await workspace.dispose();
    }
  });

  it("retains complete MkDocs evidence when an independent Fern adapter fails", async () => {
    const repository = await fixtureRepository({ graphAbsent: true });
    await writeFile(
      join(repository, "mkdocs.yml"),
      "nav:\n  - docs/guide.md\n  - docs/internal/runbook.md\n",
    );
    await mkdir(join(repository, "fern"), { recursive: true });
    await writeFile(join(repository, "fern", "docs.yml"), "versions: [\n");
    await commitFixture(repository, "add mixed navigation sources");
    const workspace = await prepareRepositoryWorkspace(repository, "HEAD");
    try {
      const inventory = await buildRepositoryDiscoveryInventory({ workspace });
      expect(inventory.coverage.navigation.status).toBe("incomplete");
      expect(inventory.navigation.navigationEdgeCount).toBe(1);
      expect(inventory.navigation.routes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            adapter: "mkdocs-yaml-v1",
            sourcePath: "mkdocs.yml",
            path: "docs/guide.md",
          }),
        ]),
      );
      expect(inventory.failures).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ category: "navigation-observation-incomplete" }),
        ]),
      );
      expect(
        runRepositoryBatchProbes({
          inventory,
          target: readinessTarget(workspace),
          probes: [{ id: "nav", question: { kind: "metadata", field: "navigation-graph" } }],
        }).results[0],
      ).toMatchObject({ disposition: "found", matchCount: 1 });
    } finally {
      await workspace.dispose();
    }
  });

  it("types traversal in a non-Fern navigation source and fails that adapter closed", async () => {
    const repository = await fixtureRepository({ graphAbsent: true });
    await writeFile(
      join(repository, "mkdocs.yml"),
      "nav:\n  - docs/guide.md\n  - ../../outside.md\n",
    );
    await commitFixture(repository, "add unsafe MkDocs target");
    const workspace = await prepareRepositoryWorkspace(repository, "HEAD");
    try {
      const inventory = await buildRepositoryDiscoveryInventory({ workspace });
      expect(inventory.coverage.navigation.status).toBe("incomplete");
      expect(inventory.navigation.navigationEdgeCount).toBe(0);
      expect(inventory.navigation.routes).toEqual([]);
      expect(inventory.failures).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            category: "navigation-observation-incomplete",
            path: "mkdocs.yml",
          }),
        ]),
      );
    } finally {
      await workspace.dispose();
    }
  });

  it("does not count generic links or untracked Fern-shaped substitutions as navigation", async () => {
    const repository = await fixtureRepository({ graphAbsent: true });
    await writeFile(join(repository, "README.md"), "# Product\n\n[Guide](docs/guide.md)\n");
    await commitFixture(repository, "add generic link");
    const workspace = await prepareRepositoryWorkspace(repository, "HEAD");
    try {
      await mkdir(join(workspace.path, "fern", "versions"), { recursive: true });
      await writeFile(
        join(workspace.path, "fern", "docs.yml"),
        "versions:\n  - path: ./versions/nightly.yml\n",
      );
      await writeFile(
        join(workspace.path, "fern", "versions", "nightly.yml"),
        "navigation:\n  - page: Injected\n    path: ../../docs/guide.md\n",
      );
      const inventory = await buildRepositoryDiscoveryInventory({ workspace });
      expect(inventory.navigation.graphEdgeCount).toBeGreaterThan(0);
      expect(inventory.navigation.navigationEdgeCount).toBe(0);
      expect(inventory.navigation.routes).toEqual([]);
      expect(
        runRepositoryBatchProbes({
          inventory,
          target: readinessTarget(workspace),
          probes: [{ id: "nav", question: { kind: "metadata", field: "navigation-graph" } }],
        }).results[0],
      ).toMatchObject({ disposition: "not-found-after-bounded-search", matchCount: 0 });
    } finally {
      await workspace.dispose();
    }
  });

  it.each([
    [
      "missing version",
      "versions:\n  - path: ./versions/missing.yml\n",
      undefined,
      "source-missing",
    ],
    ["malformed YAML", "versions: [\n", undefined, "malformed-navigation"],
    [
      "YAML alias",
      "versions:\n  - &version\n    path: ./versions/nightly.yml\n  - *version\n",
      "navigation:\n  - page: Guide\n    path: ../pages/guide.mdx\n",
      "malformed-navigation",
    ],
    [
      "traversal",
      "versions:\n  - path: ../../../outside.yml\n",
      undefined,
      "unsafe-navigation-path",
    ],
    [
      "missing page",
      "versions:\n  - path: ./versions/nightly.yml\n",
      "navigation:\n  - page: Missing\n    path: ../pages/missing.mdx\n",
      "target-missing",
    ],
    [
      "conflicting route",
      "versions:\n  - path: ./versions/nightly.yml\n",
      "navigation:\n  - page: First\n    path: ../pages/guide.mdx\n    slug: guide\n  - page: Second\n    path: ../pages/other.mdx\n    slug: guide\n",
      "conflicting-route",
    ],
    [
      "source budget exhaustion",
      `versions:\n${Array.from(
        { length: 33 },
        (_, index) => `  - path: ./versions/version-${String(index)}.yml`,
      ).join("\n")}\n`,
      undefined,
      "source-budget-exceeded",
    ],
  ])("fails closed with typed Fern evidence for %s", async (_name, docsYml, navigation, code) => {
    const repository = await minimalFernRepository(docsYml, navigation);
    const workspace = await prepareRepositoryWorkspace(repository, "HEAD");
    try {
      const observation = await observeFernNavigation({
        workspace,
        entries: await listTrackedRepositoryEntries(workspace),
      });
      expect(observation?.status).toBe("incomplete");
      expect(observation?.failures).toEqual(
        expect.arrayContaining([expect.objectContaining({ code })]),
      );
      const inventory = await buildRepositoryDiscoveryInventory({ workspace });
      expect(inventory.coverage.navigation.status).toBe("incomplete");
      expect(inventory.failures).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ category: "navigation-observation-incomplete" }),
        ]),
      );
    } finally {
      await workspace.dispose();
    }
  });

  it("fails closed when a Fern target is a tracked symlink", async () => {
    const repository = await minimalFernRepository(
      "versions:\n  - path: ./versions/nightly.yml\n",
      "navigation:\n  - page: Guide\n    path: ../pages/guide.mdx\n",
    );
    await rm(join(repository, "fern", "pages", "guide.mdx"));
    await symlink("../../README.md", join(repository, "fern", "pages", "guide.mdx"));
    await commitFixture(repository, "replace Fern target with symlink");
    const workspace = await prepareRepositoryWorkspace(repository, "HEAD");
    try {
      const observation = await observeFernNavigation({
        workspace,
        entries: await listTrackedRepositoryEntries(workspace),
      });
      expect(observation?.status).toBe("incomplete");
      expect(observation?.failures).toEqual(
        expect.arrayContaining([expect.objectContaining({ code: "target-unsafe" })]),
      );
      expect(observation?.routes).toEqual([]);
    } finally {
      await workspace.dispose();
    }
  });

  it("rejects mismatched workflow revision before inventory construction", async () => {
    const repository = await fernRepository();
    const workspace = await prepareRepositoryWorkspace(repository, "HEAD");
    try {
      const workflow = getWorkflow("update-documentation");
      const step = workflow.steps[0]!;
      await expect(
        new LocalWorkflowSearchCoordinator({ workspace }).search({
          runId: "stale-fern-workspace",
          repositoryPath: workspace.path,
          repository: {
            sourcePath: repository,
            requestedRevision: "HEAD",
            revision: "f".repeat(40),
          },
          workflow,
          step,
          plan: step.search!,
        }),
      ).rejects.toThrow(/does not match the workflow workspace/u);
    } finally {
      await workspace.dispose();
    }
  });

  it("wires all supported artifact discovery through the production coordinator", async () => {
    const repository = await fixtureRepository();
    const workspace = await prepareRepositoryWorkspace(repository, "HEAD");
    try {
      const workflow = getWorkflow("readiness");
      const step = workflow.steps[0]!;
      const repositoryTarget = {
        sourcePath: repository,
        requestedRevision: "HEAD",
        revision: workspace.revision,
      };
      const plan = {
        schemaVersion: 1 as const,
        id: "release-discovery",
        version: "1.0.0",
        targets: (["configuration", "dependency", "script", "ci-definition"] as const).map(
          (artifactClass) => ({
            id: `${artifactClass}-target`,
            targetKey: `${artifactClass}-target`,
            targetType: "artifact-existence" as const,
            artifactClass,
            question: `Find ${artifactClass}.`,
            requiredProbes: SEARCH_ARTIFACT_REQUIRED_PROBES[artifactClass].map((probe, index) => ({
              ...probe,
              id: `${artifactClass}-probe-${index + 1}`,
            })),
          }),
        ),
      };
      const releaseStep = { ...step, id: "release-discovery", search: plan };
      const releaseWorkflow = { ...workflow, steps: [releaseStep, ...workflow.steps.slice(1)] };
      const release = await new LocalWorkflowSearchCoordinator({ workspace }).search({
        runId: "inventory-release-production-path",
        repositoryPath: workspace.path,
        repository: repositoryTarget,
        workflow: releaseWorkflow,
        step: releaseStep,
        plan,
      });
      expect(release.searches.map((search) => search.bounded.finding.disposition)).toEqual([
        "found",
        "found",
        "found",
        "found",
      ]);
      expect(release.searches.flatMap((search) => search.bounded.limitations)).toEqual([]);
      const normalized = normalizeWorkflowSearchEvidence({
        plan,
        repository: repositoryTarget,
        repositoryIdentitySha256: release.repositoryIdentitySha256,
        searches: release.searches,
      });
      expect(JSON.stringify(normalized)).not.toContain(repository);
    } finally {
      await workspace.dispose();
    }
  });
});

function rehashEvidence(evidence: RepositoryBatchProbeEvidenceV1, resultIndex: number): void {
  const result = evidence.results[resultIndex]!;
  const resultBody = { ...result };
  delete (resultBody as Partial<typeof result>).evidenceSha256;
  result.evidenceSha256 = canonicalDigest({
    inventorySha256: evidence.inventorySha256,
    targetSha256: evidence.targetSha256,
    requestSha256: result.requestSha256,
    result: resultBody,
  });
  const body = { ...evidence };
  delete (body as Partial<typeof evidence>).evidenceSha256;
  evidence.evidenceSha256 = canonicalDigest(body);
}

describe("central repository inventory entry limit (T5 / #1021)", {
  timeout: HEAVY_SUITE_TIMEOUT_MS,
}, () => {
  it("keeps every tracked file at the catalog bound and records no clip", async () => {
    const repository = await trackedCountRepository(2);
    const inventory = await inventoryAt(repository, "HEAD", inventoryLimitEnv(2));
    expect(inventory.files).toHaveLength(2);
    expect(inventory.failures.map((item) => item.category)).not.toContain("entry-limit-exceeded");
    expect(inventory.coverage.structure.omittedCount).toBe(0);
    expect(
      formatRepositoryInventoryLimitations(inventory, inventoryLimitEnv(2)).join("\n"),
    ).not.toContain("repository.inventoryMaxEntries");
  });

  it("records entry-limit-exceeded at bound plus one and keeps the flag in the summary", async () => {
    const repository = await trackedCountRepository(3);
    const limits = inventoryLimitEnv(2);
    const inventory = await inventoryAt(repository, "HEAD", limits);
    expect(inventory.files).toHaveLength(2);
    expect(inventory.failures.map((item) => item.category)).toContain("entry-limit-exceeded");
    expect(inventory.coverage.structure.omittedCount).toBeGreaterThan(0);
    const summary = formatRepositoryInventoryLimitations(inventory, limits).join("\n");
    expect(summary).toContain("repository.inventoryMaxEntries");
    expect(summary).toContain("repository-inventory-max-entries-bound");
    expect(summary).toMatch(/3 exceeds repository\.inventoryMaxEntries = 2 count/);
    expect(summary).toContain("Follow the named remediation.");
    vi.stubEnv("DOCSFAB_REPOSITORY_INVENTORY_MAX_ENTRIES", "2");
    const persisted = decodeRepositoryDiscoveryInventory(JSON.parse(JSON.stringify(inventory)));
    const captured = await captureProductionLimitOverflow({
      record: attachSealedInventory(overflowRunRecord(), persisted),
      roots: temporary,
    });
    for (const human of [captured.runHuman, captured.showHuman]) {
      expect(human).toMatch(/3 exceeds repository\.inventoryMaxEntries = 2 count/);
      expect(human).toContain("LIMITATIONS");
      expect(human).toContain("Follow the named remediation.");
    }
    expect(captured.envelope.limitOverflow?.join("\n")).toMatch(
      /3 exceeds repository\.inventoryMaxEntries = 2 count/,
    );
    expect(captured.runJson).toMatch(/3 exceeds repository\.inventoryMaxEntries = 2 count/);
    expect(captured.showJson).toMatch(/3 exceeds repository\.inventoryMaxEntries = 2 count/);
  });
});

async function trackedCountRepository(count: number): Promise<string> {
  const repository = await mkdtemp(join(tmpdir(), "docsfab-inventory-bound-"));
  temporary.push(repository);
  await initFixtureRepo(repository);
  for (let index = 0; index < count; index += 1) {
    await writeFile(join(repository, `file-${index}.md`), `# File ${index}\n`);
  }
  await commitFixture(repository, "bounded inventory fixture");
  return repository;
}

function inventoryLimitEnv(maxEntries: number) {
  return {
    environment: {
      ...process.env,
      DOCSFAB_REPOSITORY_INVENTORY_MAX_ENTRIES: String(maxEntries),
    },
    hostFile: null as const,
    projectFile: null as const,
  };
}

async function fixtureRepository(options: { graphAbsent?: boolean } = {}): Promise<string> {
  const repository = await mkdtemp(join(tmpdir(), "docsfab-inventory-"));
  temporary.push(repository);
  const docs = options.graphAbsent ? "plain documentation without structure\n" : "# Product\n";
  const files: Record<string, string> = {
    ".gitignore": "ignored-private.md\n",
    ".gitlab-ci.yml": "test: { script: npm run lint }\n",
    "AGENTS.md": docs,
    "README.md": docs,
    "docs/guide.md": docs,
    "docs/internal/runbook.md": docs,
    "docusaurus.config.ts": "export default {};\n",
    "package-lock.json": "{}\n",
    "package.json": JSON.stringify({
      scripts: {
        "docs:build": "echo repository script body",
        "docs:link-check": "echo repository script body",
        lint: "echo repository script body",
      },
      dependencies: { "@docusaurus/core": "1.0.0" },
    }),
  };
  await initFixtureRepo(repository, files, { message: "inventory fixture" });
  return repository;
}

async function fernRepository(): Promise<string> {
  const repository = await minimalFernRepository(
    "instances:\n  - url: https://docs.example.test/router\nversions:\n  - path: ./versions/nightly.yml\n",
    [
      "navigation:",
      "  - section: Collections",
      "    slug: collections",
      "    contents:",
      "      - page: Overview",
      "        path: ../pages/collections/_index.mdx",
      '        slug: ""',
      "      - page: Concepts",
      "        path: ../pages/collections/concepts.mdx",
      "        slug: concepts",
      "      - page: Guide",
      "        path: ../pages/collections/guide.mdx",
      "        slug: guide",
      "      - folder: ../pages/collections/authoring",
      "        slug: authoring",
      "",
    ].join("\n"),
  );
  await writeFile(
    join(repository, "README.md"),
    "# Product\n\n[Unrelated historical link](../../docs/missing.md)\n",
  );
  await commitFixture(repository, "retain unrelated content defect");
  return repository;
}

async function minimalFernRepository(
  docsYml: string,
  navigation: string | undefined,
): Promise<string> {
  const repository = await mkdtemp(join(tmpdir(), "docsfab-fern-inventory-"));
  temporary.push(repository);
  const files: Record<string, string> = {
    "README.md": "# Product\n",
    "fern/docs.yml": docsYml,
    "fern/pages/guide.mdx": "# Guide\n",
    "fern/pages/other.mdx": "# Other\n",
    "fern/pages/collections/_index.mdx": "# Collections\n",
    "fern/pages/collections/concepts.mdx": "# Concepts\n",
    "fern/pages/collections/guide.mdx": "# Guide\n",
    "fern/pages/collections/authoring/create.mdx": "# Create\n",
    "fern/pages/collections/authoring/delete.mdx": "# Delete\n",
    "fern/pages/collections/authoring/update.mdx": "# Update\n",
    ...(navigation === undefined ? {} : { "fern/versions/nightly.yml": navigation }),
  };
  await initFixtureRepo(repository, files, { message: "Fern navigation fixture" });
  return repository;
}

async function inventoryAt(
  repository: string,
  revision: string,
  limits?: {
    environment: NodeJS.ProcessEnv;
    hostFile: null;
    projectFile: null;
  },
) {
  const workspace = await prepareRepositoryWorkspace(repository, revision);
  try {
    return await buildRepositoryDiscoveryInventory({
      workspace,
      ...(limits ? { limits } : {}),
    });
  } finally {
    await workspace.dispose();
  }
}

function readinessTarget(workspace: RepositoryWorkspace) {
  const workflow = getWorkflow("readiness");
  return instantiateWorkflowSearchTargets(workflow.steps[0]!.search!, {
    identitySha256: "a".repeat(64),
    revision: workspace.revision,
  })[0]!;
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
