// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { cp, lstat, mkdir, symlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { sourceObligationObserverFixture, verificationFixture } from "./helpers/verification.js";
import type { ContextPreflightInput, ContextPreflightTarget } from "../src/context/contracts.js";
import type { ContextQueryKind } from "../src/workflow-contracts/contracts.js";
import { compileContext } from "../src/context/compiler.js";
import { toContextPreflightDiagnostic } from "../src/context/diagnostic.js";
import {
  resetStartupPublicRootsForTest,
  validateStartupPublicRoots,
} from "../src/security/host-roots.js";
import {
  ContextService,
  LocalContextPreflightService,
  packetBindsContextTarget,
  structuralOntology,
} from "../src/context/index.js";
import { buildContentIndex } from "../src/content-ir/index.js";
import { getWorkflow } from "../src/workflow-registry/catalog.js";
import { LocalWorkflowSearchCoordinator } from "../src/search/local-workflow-coordinator.js";
import { contextPreflightAllowsExecution } from "../src/workflow-execution/runner-evidence.js";
import { WorkflowRunner } from "../src/workflow-execution/runner.js";
import { contextPacketBudget } from "../src/context/budget.js";
import { temporaryRoots } from "./helpers/temp.js";
import { commitFixture, initFixtureRepo } from "./helpers/git.js";
import { createLocalWorkflowApplicationServices } from "../src/application/dependencies.js";
import type { RunReviewScope } from "../src/execution/contracts.js";
import type { ContextPreflightResult } from "../src/context/contracts.js";
import type { RunRecord } from "../src/records/contracts.js";
import { packetBindsEveryContextTarget } from "../src/context/preflight.js";
import {
  createHostedContextPreflightService,
  HOSTED_CONTEXT_PREFLIGHT_BUDGET_MS,
} from "../src/host-invoker/context-preflight.js";
import { prepareRepositoryWorkspace } from "../src/repository/workspace/materialize.js";
import { decodeContextPreflight } from "../src/scorecard-record-decode.js";
import { normalizeContextPreflight } from "../src/workflow-execution/runner-evidence.js";
import { taskContextScope } from "../src/workflow-execution/runner-schedule.js";

export interface registerContextPreflightScenariosInputs {
  readonly populateNoDoc: (destination: string) => Promise<void>;
}

export function registerContextPreflightScenarios(
  inputs: registerContextPreflightScenariosInputs,
): void {
  const REVISION_A = "a".repeat(40);
  const REVISION_B = "b".repeat(40);
  const roots = temporaryRoots();

  async function fixture(): Promise<{ repository: string; cache: string }> {
    const root = await roots.create("docsfab-context-preflight-");
    const repository = resolve(root, "repository");
    const cache = resolve(root, "cache");
    await mkdir(repository);
    await writeFile(
      resolve(repository, "README.md"),
      "# DocsFab\n\nSee [usage](usage.md).\n",
      "utf8",
    );
    await writeFile(resolve(repository, "usage.md"), "# Usage\n\nRun the tool.\n", "utf8");
    return { repository, cache };
  }

  function input(repository: string, revision = REVISION_A): ContextPreflightInput {
    const workflow = getWorkflow("readiness");
    const step = workflow.steps[0]!;
    const policy = workflow.contextPolicy.steps[0]!;
    return {
      runId: "context-preflight-test",
      repository: {
        sourcePath: repository,
        requestedRevision: "HEAD",
        revision,
      },
      workspacePath: repository,
      workflow,
      step,
      policy,
    };
  }

  function queryInput(
    repository: string,
    query: ContextQueryKind,
    contextTarget?: ContextPreflightTarget,
  ): ContextPreflightInput {
    const base = getWorkflow("readiness");
    const policy = {
      ...base.contextPolicy.steps[0]!,
      level: "local" as const,
      query,
    };
    const workflow = {
      ...base,
      contextPolicy: { schemaVersion: 1 as const, steps: [policy] },
    };
    return {
      ...input(repository),
      workflow,
      policy,
      ...(contextTarget ? { contextTarget } : {}),
    };
  }

  describe("local context preflight", () => {
    it("derives a validated revision-bound ontology from document evidence only", async () => {
      const { repository } = await fixture();
      const index = await buildContentIndex({
        repositoryPath: repository,
        repositoryRevision: REVISION_A,
      });
      const ontology = structuralOntology(index);

      expect(ontology.repository).toEqual(index.repository);
      expect(ontology.payload.relationships).toEqual([]);
      expect(ontology.payload.entities).toHaveLength(2);
      expect(ontology.payload.entities.every((entity) => entity.kind === "artifact")).toBe(true);
      expect(ontology.payload.entities.map((entity) => entity.label)).toEqual([
        "README.md",
        "usage.md",
      ]);
    });

    it("returns an actual ready corpus packet bound to the current revision", async () => {
      const { repository, cache } = await fixture();
      const result = await new LocalContextPreflightService({ cacheRoot: cache }).preflight(
        input(repository),
      );

      expect(result.status).toBe("ready");
      expect(result.packet).toMatchObject({
        schemaVersion: 1,
        digest: result.packetDigest,
        provenance: {
          repository: { revision: REVISION_A },
        },
      });
      const documentIds =
        (result.packet as { nodes?: Array<{ id: string; kind: string }> }).nodes
          ?.filter((node) => node.kind === "document")
          .map((node) => node.id) ?? [];
      expect(documentIds).toHaveLength(2);
      expect(result.consultedNodeIds).toEqual(expect.arrayContaining(documentIds));
      expect(result.ontologyVersion).toBe("ontology-v1");
      expect(result.measurements?.nodeCount).toBeGreaterThanOrEqual(2);
      expect(result.cache).toMatchObject({ disposition: "miss", rebuildAttempted: true });
    });

    it("degrades instead of failing when MkDocs navigation names a missing page", async () => {
      const { repository, cache } = await fixture();
      await writeFile(
        resolve(repository, "mkdocs.yml"),
        "nav:\n  - README.md\n  - usage.md\n",
        "utf8",
      );
      // Positive control: every entry resolves, so the packet stays ready.
      expect(
        (await new LocalContextPreflightService({ cacheRoot: cache }).preflight(input(repository)))
          .status,
      ).toBe("ready");
      await writeFile(
        resolve(repository, "mkdocs.yml"),
        "nav:\n  - README.md\n  - reference/runbooks.md\n  - usage.md\n",
        "utf8",
      );
      expect(
        await new LocalContextPreflightService({ cacheRoot: cache }).preflight(input(repository)),
      ).toMatchObject({ status: "degraded", reason: "navigation-coverage-incomplete" });
    });

    it("stays ready for a root README target in a standard MkDocs layout", async () => {
      const { repository, cache } = await fixture();
      await mkdir(resolve(repository, "docs"));
      await writeFile(resolve(repository, "docs", "index.md"), "# Home\n", "utf8");
      await writeFile(resolve(repository, "docs", "guide.md"), "# Guide\n", "utf8");
      await writeFile(resolve(repository, "mkdocs.yml"), "nav: [index.md, guide.md]\n", "utf8");
      const service = new LocalContextPreflightService({ cacheRoot: cache });
      // The focused index on README.md never reads docs/, so its entries are
      // out of scope rather than missing pages at the root.
      for (const sourcePath of ["README.md", "docs/guide.md"]) {
        const result = await service.preflight(
          queryInput(repository, "get-neighborhood", { sourcePath }),
        );
        expect(result.status, sourcePath).toBe("ready");
        expect(result.reason, sourcePath).toBeUndefined();
      }
    });

    it("reuses only the exact revision-bound cache identity", async () => {
      const { repository, cache } = await fixture();
      const service = new LocalContextPreflightService({ cacheRoot: cache });

      const first = await service.preflight(input(repository, REVISION_A));
      const repeated = await service.preflight(input(repository, REVISION_A));
      const nextRevision = await service.preflight(input(repository, REVISION_B));

      expect(first.cache?.disposition).toBe("miss");
      expect(repeated.cache).toMatchObject({ disposition: "hit", rebuildAttempted: false });
      expect(repeated.cache?.keyDigest).toBe(first.cache?.keyDigest);
      expect(nextRevision.cache).toMatchObject({ disposition: "miss", rebuildAttempted: true });
      expect(nextRevision.cache?.keyDigest).not.toBe(first.cache?.keyDigest);
      expect(nextRevision.packet).toMatchObject({
        provenance: { repository: { revision: REVISION_B } },
      });
    });

    it("returns ready structural context for a normal write workflow", async () => {
      const { repository, cache } = await fixture();
      const workflow = getWorkflow("bootstrap");
      const result = await new LocalContextPreflightService({ cacheRoot: cache }).preflight({
        ...input(repository),
        workflow,
        step: workflow.steps[0]!,
        policy: workflow.contextPolicy.steps[0]!,
      });

      expect(result.status).toBe("ready");
      expect(result.packet?.digest).toBe(result.packetDigest);
    });

    it("maps a targeted update-documentation step to a bounded neighborhood", async () => {
      const { repository, cache } = await fixture();
      const workflow = getWorkflow("update-documentation");
      const result = await new LocalContextPreflightService({ cacheRoot: cache }).preflight({
        ...input(repository),
        workflow,
        step: workflow.steps[0]!,
        policy: workflow.contextPolicy.steps[0]!,
        contextTarget: { sourcePath: "usage.md" },
      });

      expect(workflow.contextPolicy.steps).toEqual(
        workflow.steps.map((step) =>
          expect.objectContaining({
            stepId: step.id,
            level: "change-scoped",
            query: "get-neighborhood",
          }),
        ),
      );
      expect(result.status).toBe("ready");
      expect(result.measurements?.nodeCount).toBeLessThanOrEqual(
        contextPacketBudget("change-scoped").maxNodes,
      );
      expect(result.measurements?.byteLength).toBeLessThanOrEqual(
        contextPacketBudget("change-scoped").maxBytes,
      );
      expect(result.packet).toMatchObject({
        query: { kind: "get-neighborhood", depth: contextPacketBudget("change-scoped").maxDepth },
        provenance: { budget: { class: "local" } },
        nodes: expect.arrayContaining([expect.objectContaining({ sourcePath: "usage.md" })]),
      });
    });

    it("preserves a bounded degraded packet for an explicitly authorized write", async () => {
      const { repository, cache } = await fixture();
      const linked = Array.from({ length: 40 }, (_, index) => `page-${index}.md`);
      await writeFile(
        resolve(repository, "README.md"),
        `# DocsFab\n\n${linked.map((path) => `[page](${path})`).join("\n")}\n`,
        "utf8",
      );
      await Promise.all(
        linked.map((path, index) =>
          writeFile(resolve(repository, path), `# Page ${index}\n`, "utf8"),
        ),
      );
      const workflow = getWorkflow("update-documentation");
      const result = await new LocalContextPreflightService({ cacheRoot: cache }).preflight({
        ...input(repository),
        workflow,
        step: workflow.steps[1]!,
        policy: workflow.contextPolicy.steps[1]!,
        contextTarget: { sourcePath: "README.md" },
      });

      expect(result.status).toBe("degraded");
      expect(result.packet?.digest).toBe(result.packetDigest);
      expect(result.measurements?.nodeCount).toBeLessThanOrEqual(
        contextPacketBudget("local").maxNodes,
      );
    });

    it("treats a missing context target as unnecessary, not a generic refusal (owner fail-open directive)", async () => {
      const { repository, cache } = await fixture();
      const service = new LocalContextPreflightService({ cacheRoot: cache });
      const absent = await service.preflight(queryInput(repository, "get-neighborhood"));
      const unresolved = await service.preflight(
        queryInput(repository, "get-neighborhood", { sourcePath: "missing.md" }),
      );

      expect(absent).toEqual({ status: "unnecessary", reason: "target-not-applicable" });
      // A single named target that is not in the corpus is a benign "nothing
      // to review" outcome, the same as the untargeted `absent` case above --
      // never the generic-sounding failed/uncoded refusal a critic checklist
      // would otherwise mistake for a broken run.
      expect(unresolved).toEqual({ status: "unnecessary", reason: "target-not-applicable" });
    });

    it("persists exception name and a secret-free diagnostic when preflight throws", async () => {
      const { repository, cache } = await fixture();
      const secret = `nvapi-${"s".repeat(24)}`;
      const previous = process.env.NVIDIA_API_KEY;
      process.env.NVIDIA_API_KEY = secret;
      const failure = new Error(
        `Indexing exploded at ${repository}/docs/guide.md NVIDIA_API_KEY=${secret} config=/etc/docsfab.yaml`,
      );
      failure.name = "SecretError";
      try {
        const result = await new LocalContextPreflightService({
          cacheRoot: cache,
          service: { resolve: async () => Promise.reject(failure) } as unknown as ContextService,
        }).preflight(input(repository));

        // A compile that threw is DocsFab's own failure, coded, with no packet
        // (#1924); the recorded cause gets the same redaction as the diagnostic.
        expect(result.status).toBe("degraded");
        expect(result.reason).toBe("context-compile-failed");
        expect(result.packet).toBeUndefined();
        expect(result.cause?.code).toBe("SecretError");
        expect(result.cause?.message).toContain("at docs/guide.md");
        expect(result.cause?.message).not.toContain(secret);
        expect(result.cause?.message).not.toContain(repository);
        expect(result.diagnostic?.name).toBe("SecretError");
        expect(result.diagnostic?.message).toContain("Indexing exploded");
        expect(result.diagnostic?.message).not.toContain(secret);
        expect(result.diagnostic?.message).not.toContain(repository);
        expect(result.diagnostic?.message).toContain("at docs/guide.md");
        expect(result.diagnostic?.message).toContain("config=/etc/docsfab.yaml");
        expect(JSON.stringify(result)).not.toContain(secret);
      } finally {
        if (previous === undefined) delete process.env.NVIDIA_API_KEY;
        else process.env.NVIDIA_API_KEY = previous;
      }
    });

    it("keeps a declared public HOME in the diagnostic and replaces an undeclared one with ~", () => {
      const home = "/srv/docsfab-egress-canary/home/node";
      const previous = { home: process.env.HOME, declared: process.env.DOCSFAB_PUBLIC_ROOTS };
      const message = () =>
        toContextPreflightDiagnostic(new Error(`Index failed under ${home}/cache`), "/srv/checkout")
          .message;
      try {
        process.env.HOME = home;
        delete process.env.DOCSFAB_PUBLIC_ROOTS;
        expect(message()).toBe("Index failed under ~/cache");
        process.env.DOCSFAB_PUBLIC_ROOTS = home;
        expect(message()).toBe(`Index failed under ${home}/cache`);
      } finally {
        if (previous.home === undefined) delete process.env.HOME;
        else process.env.HOME = previous.home;
        if (previous.declared === undefined) delete process.env.DOCSFAB_PUBLIC_ROOTS;
        else process.env.DOCSFAB_PUBLIC_ROOTS = previous.declared;
      }
    });

    it("keeps the startup public-roots declaration in the diagnostic", () => {
      const home = "/srv/docsfab-egress-canary/home/node";
      const previous = { home: process.env.HOME, declared: process.env.DOCSFAB_PUBLIC_ROOTS };
      try {
        process.env.HOME = home;
        process.env.DOCSFAB_PUBLIC_ROOTS = home;
        validateStartupPublicRoots();
        // A later value is not a new declaration.
        process.env.DOCSFAB_PUBLIC_ROOTS = "relative";
        expect(
          toContextPreflightDiagnostic(
            new Error(`Index failed under ${home}/cache`),
            "/srv/checkout",
          ).message,
        ).toBe(`Index failed under ${home}/cache`);
      } finally {
        resetStartupPublicRootsForTest();
        if (previous.home === undefined) delete process.env.HOME;
        else process.env.HOME = previous.home;
        if (previous.declared === undefined) delete process.env.DOCSFAB_PUBLIC_ROOTS;
        else process.env.DOCSFAB_PUBLIC_ROOTS = previous.declared;
      }
    });

    it("surfaces ContentIndexError name and relative path when a target page refuses an anchor", async () => {
      const { repository, cache } = await fixture();
      await writeFile(
        resolve(repository, "usage.md"),
        "# Usage\n\n## 🚀\n\nRun the tool.\n",
        "utf8",
      );
      const result = await new LocalContextPreflightService({ cacheRoot: cache }).preflight(
        queryInput(repository, "locate", { sourcePath: "usage.md" }),
      );

      const message =
        "The heading at line 3 of usage.md has no letter or digit to form an anchor. Add a letter or digit to the heading text, or give the heading an explicit {#anchor}.";
      // A content index refusal keeps its own code in the recorded cause (#1924).
      expect(result).toMatchObject({
        status: "degraded",
        reason: "content-index-refused",
        cause: { code: "empty-page-anchor", message },
        diagnostic: { name: "ContentIndexError", message },
      });
    });

    it("stays ready for an anchor on a page it does not target and degrades for executable navigation", async () => {
      const { repository, cache } = await fixture();
      await writeFile(
        resolve(repository, "usage.md"),
        "# Usage\n\n## 🚀\n\nRun the tool.\n",
        "utf8",
      );
      const service = new LocalContextPreflightService({ cacheRoot: cache });
      // The untargeted index leaves the anchor out; every line stays in a section.
      expect(await service.preflight(input(repository))).toMatchObject({ status: "ready" });
      expect(
        await service.preflight(queryInput(repository, "locate", { sourcePath: "README.md" })),
      ).toMatchObject({ status: "ready" });

      await writeFile(resolve(repository, "sidebars.js"), "module.exports = {};\n", "utf8");
      expect(await service.preflight(input(repository))).toMatchObject({
        status: "degraded",
        reason: "navigation-coverage-incomplete",
      });
    });

    it("admits an in-repository symlink and records an escaping one without degrading", async () => {
      const { repository, cache } = await fixture();
      await symlink("README.md", resolve(repository, "trap-link"));
      await writeFile(resolve(repository, "..", "outside.md"), "# Outside\n", "utf8");
      await symlink("../outside.md", resolve(repository, "escape.md"));
      const result = await new LocalContextPreflightService({ cacheRoot: cache }).preflight(
        input(repository),
      );
      // A skipped symlink is not missing navigation, so the packet stays ready.
      expect(result.status).toBe("ready");
    });

    it("does not index unrelated sibling trees when a context target is set", async () => {
      const { repository, cache } = await fixture();
      await mkdir(resolve(repository, "unrelated"), { recursive: true });
      await Promise.all(
        Array.from({ length: 40 }, (_, index) =>
          writeFile(
            resolve(repository, "unrelated", `page-${String(index).padStart(3, "0")}.md`),
            `# Unrelated ${index}\n`,
            "utf8",
          ),
        ),
      );
      await symlink("README.md", resolve(repository, "unrelated", "trap-link"));
      const result = await new LocalContextPreflightService({ cacheRoot: cache }).preflight(
        queryInput(repository, "get-neighborhood", { sourcePath: "README.md" }),
      );

      expect(result.status).toBe("ready");
      const sourcePaths =
        (result.packet as { nodes?: Array<{ sourcePath: string }> }).nodes?.map(
          (node) => node.sourcePath,
        ) ?? [];
      expect(sourcePaths).toContain("README.md");
      expect(sourcePaths.every((path) => !path.startsWith("unrelated/"))).toBe(true);
    });

    it("resolves an anchored locate query without guessing a node", async () => {
      const { repository, cache } = await fixture();
      const result = await new LocalContextPreflightService({ cacheRoot: cache }).preflight(
        queryInput(repository, "locate", { sourcePath: "usage.md", anchor: "usage" }),
      );

      expect(result.status).toBe("ready");
      expect(result.packet).toMatchObject({
        query: { kind: "locate", sourcePath: "usage.md", anchor: "usage" },
        nodes: [expect.objectContaining({ sourcePath: "usage.md", anchor: "usage" })],
      });
    });

    it("resolves find-home and placement targets but fails unavailable semantics closed", async () => {
      const { repository, cache } = await fixture();
      const service = new LocalContextPreflightService({ cacheRoot: cache });
      const home = await service.preflight(
        queryInput(repository, "find-home", { sourcePath: "usage.md" }),
      );
      const placement = await service.preflight(
        queryInput(repository, "test-placement", {
          sourcePath: "usage.md",
          candidateParentPath: "README.md",
        }),
      );

      for (const result of [home, placement]) {
        expect(result.status).toBe("failed");
        expect(result.reason).toBe("semantic-state-unavailable");
        expect(result.packet).toBeUndefined();
      }
    });

    it("fails closed when injected write context diverges from its request", async () => {
      const { repository, cache } = await fixture();
      const workflow = getWorkflow("bootstrap");
      const context = new ContextService({
        compile: (compileInput) =>
          compileContext({
            ...compileInput,
            budget: { ...compileInput.budget, maxNodes: 1 },
          }),
      });
      const result = await new LocalContextPreflightService({
        cacheRoot: cache,
        service: context,
      }).preflight({
        ...input(repository),
        workflow,
        step: workflow.steps[0]!,
        policy: workflow.contextPolicy.steps[0]!,
      });

      // The compiler refuses the diverged result as `invalid-input`: coded, with
      // no packet, so the write step is not authorized.
      expect(result).toMatchObject({
        status: "degraded",
        reason: "context-compile-failed",
        cause: { code: "invalid-input" },
      });
      expect(result.packet).toBeUndefined();
      expect(
        contextPreflightAllowsExecution(
          workflow.steps[0]!.mode,
          workflow.contextPolicy.steps[0]!,
          result,
        ),
      ).toBe(false);
    });

    it("marks an indexed repository with no documents explicitly unnecessary", async () => {
      const root = await roots.create("docsfab-context-empty-");
      const repository = resolve(root, "repository");
      await mkdir(repository);

      const result = await new LocalContextPreflightService({
        cacheRoot: resolve(root, "cache"),
      }).preflight(input(repository));

      expect(result).toEqual({
        status: "unnecessary",
        reason: "target-not-applicable",
      });
    });

    it("records total preflight latency without invalidating a valid packet", async () => {
      const { repository, cache } = await fixture();
      const overBudgetClock = () => {
        let call = 0;
        return () => (call++ === 0 ? 0 : 1_501);
      };
      const read = await new LocalContextPreflightService({
        cacheRoot: cache,
        clock: overBudgetClock(),
      }).preflight(input(repository));

      expect(read.status).toBe("ready");
      expect(read.packet?.digest).toBe(read.packetDigest);
      expect(read.measurements?.latencyMs).toBe(1_501);

      const workflow = getWorkflow("bootstrap");
      const write = await new LocalContextPreflightService({
        cacheRoot: resolve(cache, "write"),
        clock: overBudgetClock(),
      }).preflight({
        ...input(repository),
        workflow,
        step: workflow.steps[0]!,
        policy: workflow.contextPolicy.steps[0]!,
      });

      expect(write.status).toBe("ready");
      expect(write.packet?.digest).toBe(write.packetDigest);
      expect(write.measurements?.latencyMs).toBe(1_501);
    });

    it("keeps a large disconnected corpus bounded with an explicit non-ready disposition", async () => {
      const root = await roots.create("docsfab-context-large-");
      const repository = resolve(root, "repository");
      await mkdir(repository);
      await Promise.all(
        Array.from({ length: 513 }, (_, index) =>
          writeFile(
            resolve(repository, `page-${String(index).padStart(3, "0")}.md`),
            `Document ${index}.\n`,
            "utf8",
          ),
        ),
      );

      const result = await new LocalContextPreflightService({
        cacheRoot: resolve(root, "cache"),
      }).preflight(input(repository));

      expect(result.status).toBe("degraded");
      expect(result.packet?.digest).toBe(result.packetDigest);
      expect(result.measurements?.nodeCount).toBeLessThanOrEqual(
        contextPacketBudget("corpus").maxNodes,
      );
      expect(result.measurements?.byteLength).toBeLessThanOrEqual(
        contextPacketBudget("corpus").maxBytes,
      );
      expect(result.measurements?.estimatedTokens).toBeLessThanOrEqual(
        contextPacketBudget("corpus").maxEstimatedTokens,
      );
      const packet = result.packet as {
        query?: { kind: string; targetNodeIds?: string[] };
        nodes?: Array<{ id: string }>;
      };
      expect(packet.query).toMatchObject({ kind: "expand" });
      expect(packet.query?.targetNodeIds?.length).toBeLessThan(513);
      expect(packet.nodes?.length).toBeGreaterThan(0);
    });

    it("authorizes lint and later evaluate after a write adds nested markdown to a no-doc workspace", async () => {
      const root = await roots.create("docsfab-context-no-doc-write-");
      const repository = resolve(root, "repository");
      const cache = resolve(root, "cache");
      await inputs.populateNoDoc(repository);
      const workflow = getWorkflow("create-documentation");
      const service = new LocalContextPreflightService({ cacheRoot: cache });

      const beforeWrite = await service.preflight({
        ...input(repository),
        workflow,
        step: workflow.steps.find((step) => step.id === "write-documentation")!,
        policy: workflow.contextPolicy.steps.find(
          (policy) => policy.stepId === "write-documentation",
        )!,
      });
      expect(beforeWrite).toEqual({
        status: "unnecessary",
        reason: "target-not-applicable",
      });

      await mkdir(resolve(repository, "docs"), { recursive: true });
      await writeFile(
        resolve(repository, "docs/get-started.md"),
        "# Getting Started\n\nIntro.\n\n## Check the documentation\n\nDetails.\n",
        "utf8",
      );

      for (const stepId of ["lint-documentation", "evaluate-document-quality"] as const) {
        const step = workflow.steps.find((candidate) => candidate.id === stepId)!;
        const policy = workflow.contextPolicy.steps.find(
          (candidate) => candidate.stepId === stepId,
        )!;
        const result = await service.preflight({
          ...input(repository),
          workflow,
          step,
          policy,
        });
        expect(result.status).toBe("ready");
        expect(result.packet?.digest).toBe(result.packetDigest);
        expect(result.reason).toBeUndefined();
        expect(contextPreflightAllowsExecution(step.mode, policy, result)).toBe(true);
        expect(
          (result.packet as { paths?: Array<{ edgeKinds: string[] }> }).paths?.some(
            (path) => path.edgeKinds.filter((kind) => kind === "child").length > 1,
          ),
        ).toBe(true);
      }
    });

    it("binds --context-path on every review-documentation step or fails closed", async () => {
      const { repository, cache } = await fixture();
      await mkdir(resolve(repository, "docs/about"), { recursive: true });
      await writeFile(
        resolve(repository, "docs/README.md"),
        "# Documentation\n\nSibling landing page.\n",
        "utf8",
      );
      await writeFile(
        resolve(repository, "docs/AGENTS.md"),
        "# Agent guidance\n\nAnother sibling page.\n",
        "utf8",
      );
      await writeFile(
        resolve(repository, "docs/about/use-cases.md"),
        "# Use Cases\n\nThe requested review target.\n",
        "utf8",
      );
      const workflow = getWorkflow("review-documentation");
      const service = new LocalContextPreflightService({ cacheRoot: cache });
      const contextTarget = { sourcePath: "docs/about/use-cases.md" };
      const preflights: {
        input: ContextPreflightInput;
        result: Awaited<ReturnType<LocalContextPreflightService["preflight"]>>;
      }[] = [];

      const record = await new WorkflowRunner({
        harness: {
          runStep: async (stepInput) => ({
            summary: `${stepInput.step.id} fixture result`,
            ...(await verificationFixture(stepInput)),
          }),
        },
        workflowSearch: new LocalWorkflowSearchCoordinator(),
        sourceObligationObserver: sourceObligationObserverFixture,
        hostOperations: {
          runStep: async () => ({ summary: "deterministic fixture result" }),
        },
        store: { save: async () => undefined },
        repositoryScanner: {
          scan: async () => ({
            ruleSet: "context-preflight-test-v1",
            status: "passed",
            scannedFiles: 4,
            binaryFiles: 0,
            findings: [],
          }),
        },
        contextPreflight: {
          preflight: async (preflightInput) => {
            const result = await service.preflight(preflightInput);
            preflights.push({ input: preflightInput, result });
            return result;
          },
        },
        id: () => "context-path-review",
        now: () => new Date("2026-09-15T12:00:00.000Z"),
      }).run({
        workflow: "review-documentation",
        workspacePath: repository,
        repository: {
          sourcePath: repository,
          requestedRevision: "HEAD",
          revision: REVISION_A,
        },
        contextTarget,
        allowWrite: false,
      });

      expect(record.status, JSON.stringify(record.error)).toBe("succeeded");
      expect(preflights.map(({ input }) => input.step.id)).toEqual(
        workflow.steps.map((step) => step.id),
      );
      for (const { input: preflightInput, result } of preflights) {
        expect(preflightInput.contextTarget, preflightInput.step.id).toEqual(contextTarget);
        expect(preflightInput.policy, preflightInput.step.id).toMatchObject({
          level: "change-scoped",
          query: "get-neighborhood",
        });
        expect(result.status, preflightInput.step.id).toBe("ready");
        expect(result.packet).toBeDefined();
        if (!result.packet) throw new Error("expected context packet");
        const packet = result.packet as {
          query?: { kind: string; targetNodeIds?: string[] };
          nodes?: Array<{ id: string; kind: string; sourcePath: string }>;
        };
        expect(packetBindsContextTarget(packet, contextTarget), preflightInput.step.id).toBe(true);
        const requestedDocumentId = packet.nodes?.find(
          (node) => node.kind === "document" && node.sourcePath === contextTarget.sourcePath,
        )?.id;
        expect(requestedDocumentId, preflightInput.step.id).toEqual(expect.any(String));
        expect(packet.query, preflightInput.step.id).toMatchObject({
          kind: "get-neighborhood",
          targetNodeId: requestedDocumentId,
        });
        expect(
          packet.nodes?.some((node) => node.sourcePath === contextTarget.sourcePath),
          preflightInput.step.id,
        ).toBe(true);
      }
    });

    it("treats an expand target that cannot bind as unnecessary, the same fail-open outcome as any other missing target", async () => {
      const { repository, cache } = await fixture();
      const workflow = getWorkflow("review-documentation");
      const step = workflow.steps[0]!;
      const policy = workflow.contextPolicy.steps[0]!;
      const result = await new LocalContextPreflightService({ cacheRoot: cache }).preflight({
        ...input(repository),
        workflow,
        step,
        policy,
        contextTarget: { sourcePath: "docs/about/use-cases.md" },
      });

      expect(result).toEqual({
        status: "unnecessary",
        reason: "target-not-applicable",
      });
      expect(result.packet).toBeUndefined();
    });
  });

  /**
   * A multi-page focused review forwards its complete page set, indexes by
   * relevance before rejecting any symlink, and records a typed reason when
   * required navigation is incomplete or a selected path is an alias. Symlink
   * fixtures are the hosted-checkout shape; the local export goes through
   * `prepareRepositoryWorkspace`.
   */
  describe("focused multi-page context preflight (#883)", () => {
    const SCOPE_SHA = "c".repeat(64);
    const TWO_PAGES = ["docs/setup/install.md", "guides/api/auth.md"] as const;

    function reviewScope(targetPaths: readonly string[]): RunReviewScope {
      return {
        scope: "focused-set",
        reason: "operator-named",
        targetPaths,
        deferredPaths: [],
        scopeSha256: SCOPE_SHA,
        corpusFileCount: null,
      };
    }

    async function writeTree(root: string, files: Record<string, string>): Promise<void> {
      for (const [path, contents] of Object.entries(files)) {
        await mkdir(dirname(resolve(root, path)), { recursive: true });
        await writeFile(resolve(root, path), contents, "utf8");
      }
    }

    async function twoDirectoryRepository(): Promise<{ repository: string; cache: string }> {
      const root = await roots.create("docsfab-context-scope-");
      const repository = resolve(root, "repository");
      await writeTree(repository, {
        "README.md": "# Product\n",
        "docs/setup/install.md": "# Install\n\nSee [upgrade](upgrade.md).\n",
        "docs/setup/upgrade.md": "# Upgrade\n",
        "guides/api/auth.md": "# Auth\n",
        "unrelated/huge.md": "# Huge\n",
      });
      await symlink("../README.md", resolve(repository, "unrelated", "trap-link"));
      return { repository, cache: resolve(root, "cache") };
    }

    function reviewInput(
      repository: string,
      extra: Partial<ContextPreflightInput> = {},
    ): ContextPreflightInput {
      const workflow = getWorkflow("review-documentation");
      return {
        runId: "context-scope-test",
        repository: { sourcePath: repository, requestedRevision: "HEAD", revision: REVISION_A },
        workspacePath: repository,
        workflow,
        step: workflow.steps[0]!,
        policy: workflow.contextPolicy.steps[0]!,
        ...extra,
      };
    }

    async function runScopedReview(input: {
      repository: string;
      cache: string;
      scope: RunReviewScope;
      contextTarget?: ContextPreflightTarget;
    }) {
      const service = new LocalContextPreflightService({ cacheRoot: input.cache });
      const preflights: { input: ContextPreflightInput; result: ContextPreflightResult }[] = [];
      const harnessSteps: string[] = [];
      const saved: RunRecord[] = [];
      const record = await new WorkflowRunner({
        harness: {
          runStep: async (stepInput) => {
            harnessSteps.push(stepInput.step.id);
            return {
              summary: `${stepInput.step.id} fixture result`,
              ...(await verificationFixture(stepInput)),
            };
          },
        },
        workflowSearch: new LocalWorkflowSearchCoordinator(),
        sourceObligationObserver: sourceObligationObserverFixture,
        hostOperations: { runStep: async () => ({ summary: "deterministic fixture result" }) },
        store: { save: async (value) => void saved.push(structuredClone(value)) },
        repositoryScanner: {
          scan: async () => ({
            ruleSet: "context-scope-test-v1",
            status: "passed",
            scannedFiles: 4,
            binaryFiles: 0,
            findings: [],
          }),
        },
        contextPreflight: {
          preflight: async (preflightInput) => {
            const result = await service.preflight(preflightInput);
            preflights.push({ input: preflightInput, result });
            return result;
          },
        },
        id: () => "context-scope-review",
        now: () => new Date("2026-09-25T12:00:00.000Z"),
      }).run({
        workflow: "review-documentation",
        workspacePath: input.repository,
        repository: {
          sourcePath: input.repository,
          requestedRevision: "HEAD",
          revision: REVISION_A,
        },
        reviewScope: input.scope,
        ...(input.contextTarget ? { contextTarget: input.contextTarget } : {}),
        allowWrite: false,
      });
      return { record, persisted: saved.at(-1)!, preflights, harnessSteps };
    }

    it("indexes, seeds and binds both pages of a two-directory scope on every review step", async () => {
      const { repository, cache } = await twoDirectoryRepository();
      const { record, persisted, preflights } = await runScopedReview({
        repository,
        cache,
        scope: reviewScope(TWO_PAGES),
      });
      const workflow = getWorkflow("review-documentation");
      expect(record.status, JSON.stringify(record.error)).toBe("succeeded");
      expect(preflights.map(({ input }) => input.step.id)).toEqual(
        workflow.steps.map((step) => step.id),
      );
      for (const { input: preflightInput, result } of preflights) {
        const id = preflightInput.step.id;
        expect(preflightInput.contextTarget, id).toBeUndefined();
        expect(preflightInput.scope, id).toEqual({
          targetPaths: TWO_PAGES,
          scopeSha256: SCOPE_SHA,
        });
        expect(preflightInput.policy, id).toMatchObject({ level: "corpus", query: "expand" });
        const packet = result.packet as unknown as {
          query: { kind: string; targetNodeIds: string[] };
          nodes: Array<{ id: string; kind: string; sourcePath: string }>;
        };
        const documentIds = TWO_PAGES.map(
          (path) =>
            packet.nodes.find((node) => node.kind === "document" && node.sourcePath === path)?.id,
        );
        expect(
          documentIds.every((value) => typeof value === "string"),
          id,
        ).toBe(true);
        expect(packet.query.kind, id).toBe("expand");
        expect([...packet.query.targetNodeIds].sort(), id).toEqual([...documentIds].sort());
        expect(
          packet.nodes.some((node) => node.sourcePath.startsWith("unrelated/")),
          id,
        ).toBe(false);
      }
      for (const step of persisted.steps) {
        expect(step.contextPreflight, step.id).toMatchObject({ status: "ready" });
        expect(step.contextPreflight?.reason, step.id).toBeUndefined();
        expect(decodeContextPreflight(step.contextPreflight)).toEqual(step.contextPreflight);
      }
    }, 120_000);

    it("invalidates a scoped context cache when the admitted scope seal changes with the same paths", async () => {
      const { repository, cache } = await twoDirectoryRepository();
      const service = new LocalContextPreflightService({ cacheRoot: cache });
      const scoped = (scopeSha256: string) =>
        reviewInput(repository, { scope: { targetPaths: TWO_PAGES, scopeSha256 } });
      const first = await service.preflight(scoped(SCOPE_SHA));
      const repeated = await service.preflight(scoped(SCOPE_SHA));
      const changedScope = await service.preflight(scoped("d".repeat(64)));
      expect(first.status).toBe("ready");
      expect(first.cache?.disposition).toBe("miss");
      expect(repeated.cache?.disposition).toBe("hit");
      expect(changedScope.cache?.disposition).toBe("miss");
      expect(changedScope.cache?.keyDigest).not.toBe(first.cache?.keyDigest);
    });

    it("records every step degraded with navigation-coverage-incomplete when required navigation is unsupported", async () => {
      const { repository, cache } = await twoDirectoryRepository();
      await writeFile(resolve(repository, "sidebars.js"), "module.exports = {};\n", "utf8");
      const { record, persisted, harnessSteps } = await runScopedReview({
        repository,
        cache,
        scope: reviewScope(TWO_PAGES),
      });
      expect(record.status, JSON.stringify(record.error)).toBe("succeeded");
      expect(harnessSteps.length).toBeGreaterThan(0);
      for (const step of persisted.steps) {
        expect(step.contextPreflight, step.id).toMatchObject({
          status: "degraded",
          reason: "navigation-coverage-incomplete",
        });
        expect(decodeContextPreflight(step.contextPreflight)).toEqual(step.contextPreflight);
      }
    }, 120_000);

    it("reviews the resolvable page of a mixed scope and degrades instead of failing the whole job closed", async () => {
      const { repository, cache } = await twoDirectoryRepository();
      const { record, persisted, harnessSteps, preflights } = await runScopedReview({
        repository,
        cache,
        scope: reviewScope(["docs/setup/install.md", "guides/api/missing.md"]),
      });
      // The defect this guards: a mixed scope used to hard-stop every step at
      // step 1 with a bare, uncoded throw (0 model attempts), even though one
      // of its two pages was perfectly reviewable.
      expect(record.status, JSON.stringify(record.error)).toBe("succeeded");
      expect(preflights.map(({ input }) => input.step.id)).toEqual(
        getWorkflow("review-documentation").steps.map((step) => step.id),
      );
      expect(harnessSteps.length).toBeGreaterThan(1);
      for (const step of persisted.steps) {
        expect(step.contextPreflight, step.id).toMatchObject({
          status: "degraded",
          reason: "scope-target-partially-unresolved",
        });
        expect(decodeContextPreflight(step.contextPreflight)).toEqual(step.contextPreflight);
      }
      // The compiled packet binds only the page that resolved; the missing one
      // is never silently substituted or widened to the rest of the corpus.
      for (const { result } of preflights) {
        const packet = result.packet as unknown as {
          nodes?: Array<{ kind: string; sourcePath: string }>;
        };
        const boundPaths = (packet.nodes ?? [])
          .filter((node) => node.kind === "document")
          .map((node) => node.sourcePath);
        expect(boundPaths).toContain("docs/setup/install.md");
        expect(boundPaths).not.toContain("guides/api/missing.md");
      }
    }, 120_000);

    it("codes a genuine compiler failure on a multi-target scope, never mistaking it for unnecessary or a partial scope", async () => {
      // Adjacent condition for `resolvedTargets`/`allTargetsUnresolved`: a
      // compile failure is coded `context-compile-failed` (#1924) regardless
      // of how many targets would otherwise have resolved. It must never be
      // absorbed into the `unnecessary` or `scope-target-partially-unresolved`
      // outcomes above, which both require a SUCCESSFULLY built index/compile
      // that legitimately found no (or a partial) match.
      const { repository, cache } = await twoDirectoryRepository();
      const broken = {
        resolve: async () => Promise.reject(new Error("compiler unavailable")),
      } as unknown as ContextService;
      const result = await new LocalContextPreflightService({
        cacheRoot: cache,
        service: broken,
      }).preflight(
        reviewInput(repository, { scope: { targetPaths: TWO_PAGES, scopeSha256: SCOPE_SHA } }),
      );
      expect(result).toEqual({
        status: "degraded",
        reason: "context-compile-failed",
        cause: { code: "Error", message: "compiler unavailable" },
        diagnostic: { name: "Error", message: "compiler unavailable" },
      });
    });

    it("still fails the first step closed when a scoped page resolves but its query cannot be built for an unrelated reason", async () => {
      // Adjacent condition `withPartialScopeCoverage`/`allTargetsUnresolved`
      // must not absorb: a resolved target whose OWN query construction fails
      // for a reason that has nothing to do with corpus membership. Proven
      // directly against `contextQuery`'s `test-placement` branch, the one
      // query kind with a second required field (`candidateParentPath`)
      // beyond the target itself.
      const { repository, cache } = await fixture();
      const result = await new LocalContextPreflightService({ cacheRoot: cache }).preflight(
        queryInput(repository, "test-placement", {
          sourcePath: "usage.md",
          candidateParentPath: "missing-parent.md",
        }),
      );
      expect(result).toMatchObject({ status: "failed", reason: "target-not-applicable" });
    });

    it("runs review-documentation to a succeeded record when every scoped page is code-only (#1465)", async () => {
      const { repository, cache } = await twoDirectoryRepository();
      await writeTree(repository, {
        "src/app.ts": "export const app = 1;\n",
        "ci/deploy.sh": "#!/bin/sh\necho deploy\n",
      });
      const workflow = getWorkflow("review-documentation");
      const { record, persisted, harnessSteps, preflights } = await runScopedReview({
        repository,
        cache,
        scope: reviewScope(["src/app.ts", "ci/deploy.sh"]),
      });
      // The defect this guards: every step used to hard-stop at step 1 with a
      // bare, uncoded throw (0 model attempts) instead of running as a benign
      // no-op, because `missingTargetResult()` returned `failed` here.
      expect(record.status, JSON.stringify(record.error)).toBe("succeeded");
      // Every step reached context preflight (none stopped early), and every
      // inference-kind step actually ran its harness call, not just the first.
      expect(preflights.map(({ input }) => input.step.id)).toEqual(
        workflow.steps.map((step) => step.id),
      );
      expect(harnessSteps.length).toBeGreaterThan(1);
      for (const step of persisted.steps) {
        expect(step.contextPreflight, step.id).toEqual({
          status: "unnecessary",
          reason: "target-not-applicable",
        });
      }
    }, 120_000);

    it("treats an out-of-corpus markdown-only review scope as unnecessary too", async () => {
      const { repository, cache } = await twoDirectoryRepository();
      // `evaluation/` is a root-level name in content-ir/indexer.ts's
      // `EXCLUDED_ROOT_DIRECTORIES`: DocsFab's own evaluation corpora are
      // inputs to DocsFab, not product documentation, so the scoped walk never
      // enters it even though a scope names a file inside it directly.
      await writeTree(repository, {
        "evaluation/notes.md": "# Notes\n",
        "evaluation/other.md": "# Other\n",
      });
      const result = await new LocalContextPreflightService({ cacheRoot: cache }).preflight(
        reviewInput(repository, {
          scope: {
            targetPaths: ["evaluation/notes.md", "evaluation/other.md"],
            scopeSha256: SCOPE_SHA,
          },
        }),
      );
      expect(result).toEqual({ status: "unnecessary", reason: "target-not-applicable" });
    });

    it("also treats a single code-only target named via a one-page scope as unnecessary, same as an explicit contextTarget", async () => {
      const { repository, cache } = await twoDirectoryRepository();
      await writeTree(repository, { "src/app.ts": "export const app = 1;\n" });
      // A one-path scope becomes an explicit `contextTarget` before
      // `runner-step-loop.ts` ever builds this input (`taskContextTarget`,
      // `runner-schedule.ts`); this proves the same boundary directly at the
      // service level, bypassing that upstream fold, so it holds even for a
      // caller that hands the service a bare one-path scope.
      const single = await new LocalContextPreflightService({ cacheRoot: cache }).preflight(
        reviewInput(repository, {
          scope: { targetPaths: ["src/app.ts"], scopeSha256: SCOPE_SHA },
        }),
      );
      expect(single).toEqual({ status: "unnecessary", reason: "target-not-applicable" });
    });

    it("keeps a one-page scope on the single-target neighbourhood and lets an explicit target win over a scope", async () => {
      const { repository, cache } = await twoDirectoryRepository();
      const single = await runScopedReview({
        repository,
        cache,
        scope: reviewScope(["guides/api/auth.md"]),
      });
      expect(single.record.status, JSON.stringify(single.record.error)).toBe("succeeded");
      for (const { input: preflightInput } of single.preflights) {
        expect(preflightInput.scope).toBeUndefined();
        expect(preflightInput.contextTarget).toEqual({ sourcePath: "guides/api/auth.md" });
        expect(preflightInput.policy).toMatchObject({
          level: "change-scoped",
          query: "get-neighborhood",
        });
      }
      // Adjacent condition: an explicit --context-path beside a multi-page scope.
      const explicit = await runScopedReview({
        repository,
        cache,
        scope: reviewScope(TWO_PAGES),
        contextTarget: { sourcePath: "docs/setup/install.md" },
      });
      expect(explicit.record.status, JSON.stringify(explicit.record.error)).toBe("succeeded");
      for (const { input: preflightInput } of explicit.preflights) {
        expect(preflightInput.scope).toBeUndefined();
        expect(preflightInput.contextTarget).toEqual({ sourcePath: "docs/setup/install.md" });
      }
      expect(taskContextScope({ reviewScope: reviewScope([]) } as never)).toBeUndefined();
    }, 120_000);

    it("degrades instead of failing closed when a compiled packet drops a scoped page that did resolve", async () => {
      // The defect this guards (found live on J3, 2026-09-30): a resolved,
      // in-corpus page can still be missing from a successfully compiled
      // packet -- for example the corpus byte/token budget trimming an
      // `expand` packet's own seeds once enough of them are requested
      // together -- and that used to hard-fail the whole step closed with an
      // uncoded `target-not-applicable`, even though the OTHER resolved page
      // was perfectly reviewable. This test drops one page directly at the
      // compiler seam so it exercises the binding gap on its own, independent
      // of any particular compiler-budget mechanism.
      const { repository, cache } = await twoDirectoryRepository();
      const real = ContextService.withFileCache(cache);
      const dropping = {
        resolve: async (request: Parameters<ContextService["resolve"]>[0]) => {
          const response = await real.resolve(request);
          const packet = response.result.packet;
          if (!packet) return response;
          return {
            ...response,
            result: {
              ...response.result,
              packet: {
                ...packet,
                nodes: packet.nodes.filter((node) => node.sourcePath !== "guides/api/auth.md"),
              },
            },
          };
        },
      } as unknown as ContextService;
      const dropped = await new LocalContextPreflightService({
        cacheRoot: cache,
        service: dropping,
      }).preflight(
        reviewInput(repository, { scope: { targetPaths: TWO_PAGES, scopeSha256: SCOPE_SHA } }),
      );
      expect(dropped).toMatchObject({
        status: "degraded",
        reason: "scope-target-partially-unresolved",
      });
      const droppedPacket = dropped.packet as unknown as {
        nodes?: Array<{ kind: string; sourcePath: string }>;
      };
      const boundPaths = (droppedPacket.nodes ?? [])
        .filter((node) => node.kind === "document")
        .map((node) => node.sourcePath);
      // The page the fake seam actually dropped is absent; the other resolved
      // page is still bound and still reviewable.
      expect(boundPaths).toContain("docs/setup/install.md");
      expect(boundPaths).not.toContain("guides/api/auth.md");
      // Positive control through the same seam, with nothing dropped.
      const kept = await new LocalContextPreflightService({
        cacheRoot: cache,
        service: real,
      }).preflight(
        reviewInput(repository, { scope: { targetPaths: TWO_PAGES, scopeSha256: SCOPE_SHA } }),
      );
      expect(kept.status).toBe("ready");
      expect(packetBindsEveryContextTarget({ nodes: [] }, [])).toBe(false);
    });

    it("degrades a single named target too when the compiled packet drops a page that did resolve", async () => {
      // Adjacent condition to the test above: `withPartialScopeCoverage` used
      // to skip its own check entirely for `targets.length <= 1` (a single
      // `contextTarget`), on the old assumption that a single target's
      // resolution and binding could never diverge. `resolvedTargets` (index
      // resolution) cannot diverge from `boundTargets` (packet binding) for a
      // SINGLE target through the shipped compiler today -- but the
      // preflight-level check should not silently depend on that compiler
      // fact never changing. Before this fix, a dropped single target read
      // as a bare `ready` (claiming success while quietly reviewing nothing);
      // after this fix, the same drop degrades and names the gap, exactly
      // like the multi-page case above.
      const { repository, cache } = await twoDirectoryRepository();
      const real = ContextService.withFileCache(cache);
      const droppingTarget = {
        resolve: async (request: Parameters<ContextService["resolve"]>[0]) => {
          const response = await real.resolve(request);
          const packet = response.result.packet;
          if (!packet) return response;
          return {
            ...response,
            result: {
              ...response.result,
              packet: {
                ...packet,
                nodes: packet.nodes.filter((node) => node.sourcePath !== "docs/setup/install.md"),
              },
            },
          };
        },
      } as unknown as ContextService;
      const droppedSingle = await new LocalContextPreflightService({
        cacheRoot: cache,
        service: droppingTarget,
      }).preflight(
        reviewInput(repository, { contextTarget: { sourcePath: "docs/setup/install.md" } }),
      );
      expect(droppedSingle).toMatchObject({
        status: "degraded",
        reason: "scope-target-partially-unresolved",
      });
      const singlePacket = droppedSingle.packet as unknown as {
        nodes?: Array<{ kind: string; sourcePath: string }>;
      };
      expect(
        (singlePacket.nodes ?? [])
          .filter((node) => node.kind === "document")
          .map((node) => node.sourcePath),
      ).not.toContain("docs/setup/install.md");
      // Positive control: the same single target, nothing dropped, stays ready.
      const keptSingle = await new LocalContextPreflightService({
        cacheRoot: cache,
        service: real,
      }).preflight(
        reviewInput(repository, { contextTarget: { sourcePath: "docs/setup/install.md" } }),
      );
      expect(keptSingle.status).toBe("ready");
    });

    it("marks only a usable packet incomplete: a failed compile stays failed and an earlier reason stays", async () => {
      const { repository, cache } = await twoDirectoryRepository();
      await writeFile(resolve(repository, "sidebars.js"), "module.exports = {};\n", "utf8");
      const real = ContextService.withFileCache(cache);
      const scoped = reviewInput(repository, {
        scope: { targetPaths: TWO_PAGES, scopeSha256: SCOPE_SHA },
      });
      const rewriting = (
        rewrite: (
          response: Awaited<ReturnType<ContextService["resolve"]>>,
        ) => Awaited<ReturnType<ContextService["resolve"]>>,
      ) =>
        new LocalContextPreflightService({
          cacheRoot: cache,
          service: {
            resolve: async (request: Parameters<ContextService["resolve"]>[0]) =>
              rewrite(await real.resolve(request)),
          } as unknown as ContextService,
        });
      // Positive control: a usable packet with incomplete navigation degrades.
      expect(await rewriting((response) => response).preflight(scoped)).toMatchObject({
        status: "degraded",
        reason: "navigation-coverage-incomplete",
      });
      // A packet over the total byte budget is withheld, and the record names
      // the budget, never an internal failure. The step gets no packet; the
      // runner's own rule then lets a read-only step continue.
      const corpus = contextPacketBudget("corpus");
      const overBudget = await rewriting((response) => ({
        ...response,
        evidence: { ...response.evidence, byteLength: corpus.maxBytes + 1 },
      })).preflight(scoped);
      expect(overBudget).toMatchObject({
        status: "degraded",
        reason: "preflight-budget-exceeded",
        limit: {
          name: "context.corpusPacketInputShareBasisPoints",
          unit: "tokens",
          configured: corpus.maxEstimatedTokens,
          observed: corpus.maxEstimatedTokens + 1,
        },
      });
      expect(overBudget.packet).toBeUndefined();
      expect(overBudget.packetDigest).toBeUndefined();
      expect(overBudget.consultedNodeIds).toBeUndefined();
      // A packet already degraded for another cause keeps that cause.
      const semantic = await rewriting((response) => ({
        ...response,
        result: {
          ...response.result,
          status: "degraded",
          reasons: [{ code: "page-role-unresolved" }],
        },
      })).preflight(scoped);
      expect(semantic).toMatchObject({ status: "degraded", reason: "semantic-state-unavailable" });
    });

    it("stays ready for a focused page when an unrelated root alias and a non-source alias exist", async () => {
      const { repository, cache } = await twoDirectoryRepository();
      await writeFile(resolve(repository, "AGENTS.md"), "# Agents\n", "utf8");
      await writeFile(resolve(repository, "envrc.real"), "export A=1\n", "utf8");
      await symlink("AGENTS.md", resolve(repository, "CLAUDE.md"));
      await symlink("envrc.real", resolve(repository, ".envrc"));
      const result = await new LocalContextPreflightService({ cacheRoot: cache }).preflight(
        queryInput(repository, "get-neighborhood", { sourcePath: "docs/setup/install.md" }),
      );
      expect(result.status, JSON.stringify(result)).toBe("ready");
      expect(result.reason).toBeUndefined();
    });

    it("refuses a selected page alias with a typed, recordable reason", async () => {
      const { repository, cache } = await twoDirectoryRepository();
      await symlink("install.md", resolve(repository, "docs", "setup", "alias.md"));
      const result = await new LocalContextPreflightService({ cacheRoot: cache }).preflight(
        reviewInput(repository, {
          scope: {
            targetPaths: ["docs/setup/alias.md", "guides/api/auth.md"],
            scopeSha256: SCOPE_SHA,
          },
        }),
      );
      const message = "Focused context does not follow a selected alias: docs/setup/alias.md.";
      // Never followed, and no packet: a read-only step runs on without one,
      // and the cause names the alias (#1924).
      expect(result).toMatchObject({
        status: "degraded",
        reason: "navigation-alias-refused",
        cause: { code: "selected-alias", message },
        diagnostic: { message },
      });
      expect(result.packet).toBeUndefined();
      const evidence = normalizeContextPreflight(result);
      expect(evidence).toEqual({
        status: "degraded",
        reason: "navigation-alias-refused",
        cause: { code: "selected-alias", message },
      });
      expect(decodeContextPreflight(evidence)).toEqual(evidence);
      // A record written before causes existed keeps decoding.
      const earlier = { status: "failed" as const, reason: "navigation-alias-refused" as const };
      expect(decodeContextPreflight(earlier)).toEqual(earlier);
    });

    it("detects a required navigation alias that the materialized local export leaves absent", async () => {
      const root = await roots.create("docsfab-context-scope-git-");
      const source = resolve(root, "source");
      await initFixtureRepo(source, {
        "docs/guide/x.md": "# X\n",
        "docs/guide/y.md": "# Y\n",
        "api/ref.md": "# Ref\n",
        "versioned/sidebars.json": '["guide/x", "guide/y"]\n',
      });
      await symlink("../versioned/sidebars.json", join(source, "docs", "sidebars.json"));
      const revision = await commitFixture(source, "alias sidebar");
      const workspace = await prepareRepositoryWorkspace(source, revision);
      try {
        // Premise: the export never writes the alias to disk.
        await expect(lstat(join(workspace.path, "docs", "sidebars.json"))).rejects.toMatchObject({
          code: "ENOENT",
        });
        const scoped = (workspacePath: string): ContextPreflightInput =>
          reviewInput(workspacePath, {
            repository: {
              sourcePath: source,
              requestedRevision: "HEAD",
              revision: workspace.revision,
            },
            scope: { targetPaths: ["docs/guide/x.md", "api/ref.md"], scopeSha256: SCOPE_SHA },
          });
        // Through the shipped local assembly (application/dependencies.ts).
        const { services } = await createLocalWorkflowApplicationServices({
          config: {
            stateDirectory: resolve(root, "state", "runs"),
            skillCrateDirectory: resolve("skill-crate"),
            qualityDirectory: resolve("quality"),
            qualityPackDirectory: resolve("quality-pack"),
          },
          request: { workflow: "update-documentation" },
          workflow: { schemaVersion: 2 },
          workspace,
          repositoryEvidence: {},
          baseHarness: {},
        } as never);
        const assembled = await services.contextPreflight!.preflight(scoped(workspace.path));
        expect(assembled).toMatchObject({
          status: "degraded",
          reason: "navigation-coverage-incomplete",
        });
        expect(decodeContextPreflight(normalizeContextPreflight(assembled))).toMatchObject({
          status: "degraded",
          reason: "navigation-coverage-incomplete",
        });

        // No workspace handle.
        const cache = resolve(root, "cache");
        const blind = await new LocalContextPreflightService({ cacheRoot: cache }).preflight(
          scoped(workspace.path),
        );
        expect(blind.status).toBe("ready");

        // A handle for a different directory is never charged.
        const copy = resolve(root, "copy");
        await cp(workspace.path, copy, { recursive: true });
        const elsewhere = await new LocalContextPreflightService({
          cacheRoot: cache,
          workspace,
        }).preflight(scoped(copy));
        expect(elsewhere.status).toBe("ready");

        // The same directory at a different revision is not charged with the
        // handle's aliases.
        const otherRevision = await new LocalContextPreflightService({
          cacheRoot: cache,
          workspace,
        }).preflight({
          ...scoped(workspace.path),
          repository: { sourcePath: source, requestedRevision: "HEAD", revision: REVISION_A },
        });
        expect(otherRevision.status).toBe("ready");
      } finally {
        await workspace.dispose();
      }
    });

    it("keeps the compiler's navigation reason in the hosted wrapper and never widens a scoped or targeted refusal", async () => {
      const workflow = getWorkflow("review-documentation");
      const capsule = {
        sha256: "f".repeat(64),
        receiptSha256: "d".repeat(64),
        expiresAt: "2099-01-01T00:00:00.000Z",
        selectedEvidence: [{ evidenceId: "product-model", content: "Approved product context." }],
      };
      const base = {
        runId: "hosted-scope",
        repository: { sourcePath: "/tmp/x", requestedRevision: "HEAD", revision: REVISION_A },
        workspacePath: "/tmp/x",
        workflow,
        step: workflow.steps[0]!,
        policy: workflow.contextPolicy.steps[0]!,
      } as ContextPreflightInput;
      const scope = { targetPaths: TWO_PAGES, scopeSha256: SCOPE_SHA };
      const hosted = (result: ContextPreflightResult) =>
        createHostedContextPreflightService({
          capsule,
          stateDirectory: "/tmp/x-state",
          budgetMs: HOSTED_CONTEXT_PREFLIGHT_BUDGET_MS,
          service: { preflight: async () => result },
        });
      const incomplete: ContextPreflightResult = {
        status: "degraded",
        reason: "navigation-coverage-incomplete",
        packetDigest: "e".repeat(64),
        measurements: { byteLength: 1, estimatedTokens: 1, latencyMs: 0 },
        packet: { schemaVersion: 1, digest: "e".repeat(64) },
      };
      expect(await hosted(incomplete).preflight({ ...base, scope })).toEqual(incomplete);

      const aliasRefused: ContextPreflightResult = {
        status: "degraded",
        reason: "navigation-alias-refused",
        cause: {
          code: "selected-alias",
          message: "Focused context does not follow a selected alias: docs/a.md.",
        },
      };
      // A selected alias keeps the compiler's verdict: never the capsule. The
      // read-only step runs without a packet, as it does locally.
      expect(await hosted(aliasRefused).preflight({ ...base, scope })).toEqual(aliasRefused);
      expect(
        await hosted(aliasRefused).preflight({
          ...base,
          contextTarget: { sourcePath: "docs/a.md" },
        }),
      ).toEqual(aliasRefused);
      expect(await hosted(aliasRefused).preflight(base)).toEqual(aliasRefused);
      // A write step needs a packet, so the scoped refusal stops it.
      const writeWorkflow = getWorkflow("create-documentation");
      const writeStep = writeWorkflow.steps.find((step) => step.mode === "write")!;
      const writePolicy = writeWorkflow.contextPolicy.steps.find(
        (policy) => policy.stepId === writeStep.id,
      )!;
      const writeRefused = await hosted(aliasRefused).preflight({
        ...base,
        workflow: writeWorkflow,
        step: writeStep,
        policy: writePolicy,
        scope,
      });
      expect(writeRefused).toEqual(aliasRefused);
      expect(contextPreflightAllowsExecution("write", writePolicy, writeRefused)).toBe(false);
      // An earlier compiler's `failed` refusal still stops a scoped step.
      const earlierRefusal: ContextPreflightResult = {
        status: "failed",
        reason: "navigation-alias-refused",
      };
      expect(await hosted(earlierRefusal).preflight({ ...base, scope })).toEqual(earlierRefusal);
      // Unscoped, it falls back to the capsule; with no cause to carry, the
      // claim is a seam violation, recorded as the coded internal failure.
      expect(await hosted(earlierRefusal).preflight(base)).toMatchObject({
        status: "degraded",
        reason: "preflight-internal-failure",
        packetDigest: capsule.sha256,
      });
      // A scoped compiler that broke is not a refusal.
      expect(
        await hosted({ status: "failed", reason: "preflight-internal-failure" }).preflight({
          ...base,
          scope,
        }),
      ).toMatchObject({
        status: "degraded",
        reason: "preflight-internal-failure",
        packetDigest: capsule.sha256,
      });

      const unbound: ContextPreflightResult = { status: "failed", reason: "target-not-applicable" };
      expect(await hosted(unbound).preflight({ ...base, scope })).toEqual(unbound);
      // An unscoped, untargeted run still falls back to the capsule.
      const widened = await hosted(unbound).preflight(base);
      expect(widened).toMatchObject({
        status: "degraded",
        reason: "target-not-applicable",
        packetDigest: capsule.sha256,
      });
    });

    const HOSTED_CAPSULE = {
      sha256: "f".repeat(64),
      receiptSha256: "d".repeat(64),
      expiresAt: "2099-01-01T00:00:00.000Z",
      selectedEvidence: [{ evidenceId: "product-model", content: "Approved product context." }],
    };

    it("runs a hosted real-checkout read-only step past a selected symlinked page without a packet, through the real compiler", async () => {
      const root = await roots.create("docsfab-context-scope-hosted-alias-");
      const repository = resolve(root, "repository");
      await writeTree(repository, { "docs/a.md": "# A\n", "docs/b.md": "# B\n" });
      await symlink("a.md", resolve(repository, "docs", "latest.md"));
      const hosted = createHostedContextPreflightService({
        capsule: HOSTED_CAPSULE,
        stateDirectory: resolve(root, "state"),
        budgetMs: HOSTED_CONTEXT_PREFLIGHT_BUDGET_MS,
      });
      const refused = await hosted.preflight(
        reviewInput(repository, {
          scope: { targetPaths: ["docs/latest.md", "docs/b.md"], scopeSha256: SCOPE_SHA },
        }),
      );
      expect(refused).toMatchObject({
        status: "degraded",
        reason: "navigation-alias-refused",
        cause: {
          code: "selected-alias",
          message: "Focused context does not follow a selected alias: docs/latest.md.",
        },
      });
      expect(refused.packetDigest).toBeUndefined();
      const workflow = getWorkflow("review-documentation");
      // The read-only review continues without a packet (#1924); a write step,
      // which needs one, would not.
      expect(
        contextPreflightAllowsExecution(
          workflow.steps[0]!.mode,
          workflow.contextPolicy.steps[0]!,
          refused,
        ),
      ).toBe(true);
      expect(
        contextPreflightAllowsExecution("write", workflow.contextPolicy.steps[0]!, refused),
      ).toBe(false);
      // The same checkout with only regular pages selected runs.
      const regular = await hosted.preflight(
        reviewInput(repository, {
          scope: { targetPaths: ["docs/a.md", "docs/b.md"], scopeSha256: SCOPE_SHA },
        }),
      );
      expect(regular.status, JSON.stringify(regular)).toBe("ready");
    }, 120_000);

    const ALIAS_TOC_FILES = {
      "_toc.yml": ["root: intro", "- file: latest", "- file: guide/a", "- file: guide/b", ""].join(
        "\n",
      ),
      "intro.md": "# Intro\n",
      "v2.md": "# V2\n",
      "guide/a.md": "# A\n",
      "guide/b.md": "# B\n",
    };
    const GUIDE_SCOPE = { targetPaths: ["guide/a.md", "guide/b.md"], scopeSha256: SCOPE_SHA };

    it("keeps a focused review ready when root navigation lists an unselected sibling alias (real checkout)", async () => {
      const root = await roots.create("docsfab-context-scope-toc-alias-");
      const repository = resolve(root, "repository");
      await writeTree(repository, ALIAS_TOC_FILES);
      await symlink("v2.md", resolve(repository, "latest.md"));
      const local = await new LocalContextPreflightService({
        cacheRoot: resolve(root, "cache"),
      }).preflight(reviewInput(repository, { scope: GUIDE_SCOPE }));
      expect(local.status, JSON.stringify(local)).toBe("ready");
      expect(local.reason).toBeUndefined();
      const hosted = await createHostedContextPreflightService({
        capsule: HOSTED_CAPSULE,
        stateDirectory: resolve(root, "state"),
        budgetMs: HOSTED_CONTEXT_PREFLIGHT_BUDGET_MS,
      }).preflight(reviewInput(repository, { scope: GUIDE_SCOPE }));
      expect(hosted.status, JSON.stringify(hosted)).toBe("ready");
      expect(hosted.packetDigest).not.toBe(HOSTED_CAPSULE.sha256);

      // An extensionless in-scope entry naming a missing page is not an alias:
      // the index records it, and the review continues on degraded context.
      await writeFile(
        resolve(repository, "_toc.yml"),
        ["root: intro", "- file: missing", "- file: guide/a", ""].join("\n"),
        "utf8",
      );
      const broken = await new LocalContextPreflightService({
        cacheRoot: resolve(root, "cache-broken"),
      }).preflight(reviewInput(repository, { scope: GUIDE_SCOPE }));
      expect(broken).toMatchObject({
        status: "degraded",
        reason: "navigation-coverage-incomplete",
      });
    }, 120_000);

    it("keeps a focused review ready when root navigation lists an unselected sibling alias (local export)", async () => {
      const root = await roots.create("docsfab-context-scope-toc-alias-git-");
      const source = resolve(root, "source");
      await initFixtureRepo(source, ALIAS_TOC_FILES);
      await symlink("v2.md", join(source, "latest.md"));
      const revision = await commitFixture(source, "toc alias");
      const workspace = await prepareRepositoryWorkspace(source, revision);
      try {
        // Premise: the export never writes the alias to disk.
        await expect(lstat(join(workspace.path, "latest.md"))).rejects.toMatchObject({
          code: "ENOENT",
        });
        // Through the shipped local assembly (application/dependencies.ts).
        const { services } = await createLocalWorkflowApplicationServices({
          config: {
            stateDirectory: resolve(root, "state", "runs"),
            skillCrateDirectory: resolve("skill-crate"),
            qualityDirectory: resolve("quality"),
            qualityPackDirectory: resolve("quality-pack"),
          },
          request: { workflow: "update-documentation" },
          workflow: { schemaVersion: 2 },
          workspace,
          repositoryEvidence: {},
          baseHarness: {},
        } as never);
        const result = await services.contextPreflight!.preflight(
          reviewInput(workspace.path, {
            repository: {
              sourcePath: source,
              requestedRevision: "HEAD",
              revision: workspace.revision,
            },
            scope: GUIDE_SCOPE,
          }),
        );
        expect(result.status, JSON.stringify(result)).toBe("ready");
        expect(result.reason).toBeUndefined();
      } finally {
        await workspace.dispose();
      }
    }, 120_000);
  });
}
