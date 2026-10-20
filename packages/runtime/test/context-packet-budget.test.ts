// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { createLocalWorkflowApplicationServices } from "../src/application/dependencies.js";
import { buildContentIndex } from "../src/content-ir/index.js";
import { contextPacketBudget, contextPacketInputWindow } from "../src/context/budget.js";
import { compileContext } from "../src/context/compiler.js";
import type {
  ContextBudget,
  ContextPacketV1,
  ContextPreflightInput,
  ContextResult,
} from "../src/context/contracts.js";
import { LocalContextPreflightService, structuralOntology } from "../src/context/index.js";
import { createHostedContextPreflightService } from "../src/host-invoker/context-preflight.js";
import { LIMIT_DEFINITION_BY_NAME } from "../src/config/limits.generated.js";
import { classifyThrownFailure } from "../src/operator/failure-classification.js";
import {
  collectRunLimitOverflowEvidence,
  projectRunLimitOverflowLines,
} from "../src/operator/run-limit-overflow.js";
import type { RunRecord, RunStore } from "../src/records/contracts.js";
import { decodeContextPreflight } from "../src/scorecard-record-decode.js";
import { ScorecardRecordError } from "../src/scorecard-record.js";
import {
  normalizeContextPreflight,
  preflightContext,
} from "../src/workflow-execution/runner-evidence.js";
import type { HarnessStepInput } from "../src/execution/contracts.js";
import { ContextPreflightAuthorizationError } from "../src/workflow-execution/runner-step-loop.js";
import { WorkflowRunner } from "../src/workflow-execution/runner.js";
import { getWorkflow } from "../src/workflow-registry/catalog.js";
import { temporaryRoots } from "./helpers/temp.js";

const REVISION = "a".repeat(40);
const SMALLEST_INSTALLED_WINDOW = 65_536;
const LARGEST_INSTALLED_WINDOW = 1_050_000;
const CORPUS_SHARE = "context.corpusPacketInputShareBasisPoints";
const roots = temporaryRoots();

class MemoryStore implements RunStore {
  public records: RunRecord[] = [];

  public async save(record: RunRecord): Promise<void> {
    this.records.push(structuredClone(record));
  }
}

/** A README linking `pages` pages of `sections` headings each: one corpus, many nodes. */
async function corpusRepository(
  pages: number,
  sections: number,
): Promise<{ repository: string; cache: string; root: string }> {
  const root = await roots.create("docsfab-context-packet-budget-");
  const repository = resolve(root, "repository");
  await mkdir(resolve(repository, "docs"), { recursive: true });
  const names = Array.from(
    { length: pages },
    (_unused, page) => `docs/page-${String(page).padStart(2, "0")}.md`,
  );
  await writeFile(
    resolve(repository, "README.md"),
    `# Guide\n\n${names.map((name) => `- [${name}](${name})`).join("\n")}\n`,
    "utf8",
  );
  await Promise.all(
    names.map((name, page) =>
      writeFile(
        resolve(repository, name),
        `# Page ${page}\n\n${Array.from(
          { length: sections },
          (_unused, section) => `## Topic ${section}\n\nDetail ${section} of page ${page}.\n`,
        ).join("\n")}`,
        "utf8",
      ),
    ),
  );
  return { repository, cache: resolve(root, "cache"), root };
}

/** The read-only corpus `expand` step of `readiness`, untargeted. */
function readinessInput(repository: string): ContextPreflightInput {
  const workflow = getWorkflow("readiness");
  return {
    runId: "context-packet-budget",
    repository: { sourcePath: repository, requestedRevision: "HEAD", revision: REVISION },
    workspacePath: repository,
    workflow,
    step: workflow.steps[0]!,
    policy: workflow.contextPolicy.steps[0]!,
  };
}

/**
 * The operator LIMITATIONS line one step's recorded packet budget projects: a
 * trimmed packet reports its size before the trim, a step that got no packet
 * reports its smallest packet.
 */
function summaryLine(
  stepId: string,
  limit: { name: string; configured: number; observed: number },
  outcome: string,
  unboundTargets: readonly string[] = [],
): string {
  const definition = LIMIT_DEFINITION_BY_NAME[limit.name]!;
  const budget = `the ${limit.configured}-token budget that ${limit.name} gives this run's input window`;
  const measured =
    outcome === "it ran with the packet trimmed to fit"
      ? `context packet measured ${limit.observed} estimated tokens before the trim, over ${budget}`
      : `smallest context packet, its first target alone, measured ${limit.observed} estimated tokens, over ${budget}`;
  const unbound =
    unboundTargets.length > 0
      ? ` Requested pages without context: ${unboundTargets.join(", ")}.`
      : "";
  return `${definition.refusal}: step "${stepId}" ${measured}; ${outcome}.${unbound} ${definition.remediation}`;
}

/** Context budget overrides that make the corpus budget exactly `tokens`. */
function exactCorpusBudget(tokens: number): Record<string, string> {
  return {
    DOCSFAB_CONTEXT_PACKET_FALLBACK_INPUT_TOKENS: String(tokens),
    DOCSFAB_CONTEXT_CORPUS_PACKET_INPUT_SHARE_BASIS_POINTS: "10000",
  };
}

function packetOf(result: { packet?: unknown }): ContextPacketV1 {
  if (!result.packet) throw new Error("expected a context packet");
  return result.packet as ContextPacketV1;
}

async function withEnvironment<T>(
  values: Record<string, string>,
  run: () => Promise<T> | T,
): Promise<T> {
  const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  Object.assign(process.env, values);
  try {
    return await run();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

async function runReadiness(
  repository: string,
  contextPreflight: LocalContextPreflightService,
): Promise<{ record: RunRecord; packets: Array<HarnessStepInput["contextPacket"]> }> {
  const packets: Array<HarnessStepInput["contextPacket"]> = [];
  const record = await new WorkflowRunner({
    harness: {
      runStep: async (input) => {
        packets.push(input.contextPacket);
        return { summary: "bounded readiness result" };
      },
    },
    store: new MemoryStore(),
    repositoryScanner: {
      scan: async () => ({
        ruleSet: "context-packet-budget-test-v1",
        status: "passed",
        scannedFiles: 1,
        binaryFiles: 0,
        findings: [],
      }),
    },
    contextPreflight,
    id: () => "context-packet-budget-run",
    now: () => new Date("2026-10-05T12:00:00.000Z"),
  }).run({
    workflow: "readiness",
    workspacePath: repository,
    repository: { sourcePath: repository, requestedRevision: "HEAD", revision: REVISION },
    allowWrite: false,
  });
  return { record, packets };
}

describe("context packet budgets follow the model input window (#1932)", () => {
  it("sizes each level's budget as its declared share of the input window", () => {
    expect(contextPacketBudget("corpus", SMALLEST_INSTALLED_WINDOW).maxEstimatedTokens).toBe(8_192);
    expect(contextPacketBudget("corpus", LARGEST_INSTALLED_WINDOW).maxEstimatedTokens).toBe(
      131_250,
    );
    expect(contextPacketBudget("change-scoped", SMALLEST_INSTALLED_WINDOW)).toMatchObject({
      class: "local",
      maxEstimatedTokens: 2_051,
    });
    expect(contextPacketBudget("local", LARGEST_INSTALLED_WINDOW).maxEstimatedTokens).toBe(32_865);
    // No bound model: the fallback window, the smallest installed one.
    expect(contextPacketBudget("corpus")).toEqual(
      contextPacketBudget("corpus", SMALLEST_INSTALLED_WINDOW),
    );
    // Bytes are the same bound, and no count binds before the token budget.
    const corpus = contextPacketBudget("corpus", LARGEST_INSTALLED_WINDOW);
    expect(corpus.maxBytes).toBe(corpus.maxEstimatedTokens * 4);
    expect([corpus.maxNodes, corpus.maxEdges, corpus.maxPaths]).toEqual([
      corpus.maxEstimatedTokens,
      corpus.maxEstimatedTokens,
      corpus.maxEstimatedTokens,
    ]);
    expect(() => contextPacketBudget("corpus", 0)).toThrow(
      "A context packet budget needs the model input window as a positive whole number of tokens; received 0.",
    );
  });

  it("trims an over-budget packet to its budget, records the bound, and the step proceeds with it", async () => {
    const { repository, cache } = await corpusRepository(20, 6);
    const budget = contextPacketBudget("corpus", SMALLEST_INSTALLED_WINDOW);
    const service = new LocalContextPreflightService({
      cacheRoot: cache,
      modelInputTokens: SMALLEST_INSTALLED_WINDOW,
    });
    const trimmed = await service.preflight(readinessInput(repository));

    expect(trimmed.status).toBe("degraded");
    expect(trimmed.reason).toBe("preflight-budget-exceeded");
    expect(trimmed.limit).toEqual({
      name: CORPUS_SHARE,
      unit: "tokens",
      configured: budget.maxEstimatedTokens,
      observed: expect.any(Number) as number,
    });
    expect(trimmed.limit!.observed).toBeGreaterThan(budget.maxEstimatedTokens);
    expect(trimmed.measurements!.estimatedTokens).toBeLessThanOrEqual(budget.maxEstimatedTokens);
    expect(trimmed.measurements!.byteLength).toBeLessThanOrEqual(budget.maxBytes);
    const packet = packetOf(trimmed);
    expect(packet.digest).toBe(trimmed.packetDigest);

    // The lowest ranks go first: every requested page (each document is a
    // seed of the untargeted expand) stays, and only their sections are cut.
    const index = await buildContentIndex({
      repositoryPath: repository,
      repositoryRevision: REVISION,
    });
    const documentIds = index.nodes
      .filter((node) => node.kind === "document")
      .map((node) => node.id)
      .sort();
    const sectionCount = index.nodes.filter((node) => node.kind === "section").length;
    expect(packet.query.kind === "expand" && [...packet.query.targetNodeIds].sort()).toEqual(
      documentIds,
    );
    expect(
      packet.nodes
        .filter((node) => node.kind === "document")
        .map((node) => node.id)
        .sort(),
    ).toEqual(documentIds);
    const keptSections = packet.nodes.filter((node) => node.kind === "section").length;
    expect(keptSections).toBeLessThan(sectionCount);

    // The observation is the whole walk, untrimmed: a window it fits compiles
    // the same walk ready, at that size (the budget figures alone differ).
    const whole = await new LocalContextPreflightService({
      cacheRoot: cache,
      modelInputTokens: LARGEST_INSTALLED_WINDOW,
    }).preflight(readinessInput(repository));
    expect(whole.status).toBe("ready");
    expect(
      Math.abs(whole.measurements!.estimatedTokens - trimmed.limit!.observed),
    ).toBeLessThanOrEqual(4);

    // Through the runner: the read-only step runs with the trimmed packet,
    // and the record keeps the bound in a shape its decoder admits.
    const { record, packets } = await runReadiness(
      repository,
      new LocalContextPreflightService({
        cacheRoot: cache,
        modelInputTokens: SMALLEST_INSTALLED_WINDOW,
      }),
    );
    expect(record.status, JSON.stringify(record.error)).toBe("succeeded");
    expect(packets).toHaveLength(1);
    expect(packets[0]?.digest).toBe(trimmed.packetDigest);
    const evidence = record.steps[0]!.contextPreflight!;
    expect(evidence).toMatchObject({
      status: "degraded",
      reason: "preflight-budget-exceeded",
      packetDigest: trimmed.packetDigest,
      limit: trimmed.limit,
    });
    expect(decodeContextPreflight(evidence)).toEqual(evidence);
    // The trim reaches the operator summary, not only the record.
    expect(projectRunLimitOverflowLines(collectRunLimitOverflowEvidence(record))).toEqual([
      summaryLine("assess-readiness", trimmed.limit!, "it ran with the packet trimmed to fit"),
    ]);
  });

  it("continues a read-only step without a packet that cannot fit at all, and stops a write step on the named bound", async () => {
    const { repository, cache } = await corpusRepository(2, 1);
    // A host-lowered budget that cannot hold even the first-ranked node.
    const lowered = 300;
    await withEnvironment(exactCorpusBudget(lowered), async () => {
      const service = new LocalContextPreflightService({ cacheRoot: cache });
      const readOnly = await service.preflight(readinessInput(repository));
      expect(readOnly).toMatchObject({
        status: "degraded",
        reason: "preflight-budget-exceeded",
        limit: { name: CORPUS_SHARE, unit: "tokens", configured: lowered },
      });
      const smallest = readOnly.limit!.observed;
      expect(smallest).toBeGreaterThan(lowered);
      expect(readOnly.packet).toBeUndefined();
      expect(readOnly.packetDigest).toBeUndefined();
      expect(readOnly.consultedNodeIds).toBeUndefined();
      expect(JSON.stringify(readOnly)).not.toContain("preflight-internal-failure");

      const { record, packets } = await runReadiness(repository, service);
      expect(record.status, JSON.stringify(record.error)).toBe("succeeded");
      expect(packets).toEqual([undefined]);
      expect(record.steps[0]!.contextPreflight).toMatchObject({
        status: "degraded",
        reason: "preflight-budget-exceeded",
        limit: readOnly.limit,
      });
      expect(decodeContextPreflight(record.steps[0]!.contextPreflight)).toEqual(
        record.steps[0]!.contextPreflight,
      );
      expect(projectRunLimitOverflowLines(collectRunLimitOverflowEvidence(record))).toEqual([
        summaryLine("assess-readiness", readOnly.limit!, "it ran without a packet"),
      ]);

      // Control: a write step needs a packet, so the same bound stops it before
      // any model call, coded as a bound that names the limit and both values.
      let writeCalls = 0;
      const write = await new WorkflowRunner({
        harness: {
          runStep: async () => {
            writeCalls += 1;
            return { summary: "must not run" };
          },
        },
        store: new MemoryStore(),
        repositoryScanner: {
          scan: async () => ({
            ruleSet: "context-packet-budget-test-v1",
            status: "passed",
            scannedFiles: 1,
            binaryFiles: 0,
            findings: [],
          }),
        },
        contextPreflight: service,
        repositoryEvidence: {
          capture: async () => ({
            files: [],
            patch: {
              sha256: "d".repeat(64),
              byteLength: 0,
              lineCount: 0,
              artifactPath: "/durable/empty.patch",
              format: "git-diff",
            },
          }),
        },
        id: () => "context-packet-budget-write",
        now: () => new Date("2026-10-05T12:00:00.000Z"),
      }).run({
        workflow: "bootstrap",
        workspacePath: repository,
        repository: { sourcePath: repository, requestedRevision: "HEAD", revision: REVISION },
        allowWrite: true,
      });
      expect(writeCalls).toBe(0);
      expect(write.status).toBe("failed");
      const step = write.steps[0]!;
      expect(step.contextPreflight).toMatchObject({
        status: "degraded",
        reason: "preflight-budget-exceeded",
        limit: { name: CORPUS_SHARE, unit: "tokens", configured: lowered },
      });
      expect(step.failure).toEqual({
        class: "bound",
        layer: "workflow",
        code: "preflight-budget-exceeded",
      });
      const limit = step.contextPreflight!.limit!;
      expect(write.error).toBe(
        `Context preflight did not authorize workflow step "${step.id}": ${limit.observed} tokens observed exceeds ${limit.configured} tokens under ${CORPUS_SHARE}.`,
      );
      expect(
        classifyThrownFailure(
          new ContextPreflightAuthorizationError(step.id, "preflight-budget-exceeded", limit),
          "workflow",
        ),
      ).toEqual({ class: "bound", layer: "workflow", code: "preflight-budget-exceeded" });
      expect(projectRunLimitOverflowLines(collectRunLimitOverflowEvidence(write))).toEqual([
        summaryLine(step.id, limit, "the write step stopped, because it needs a packet"),
      ]);

      // The observation is the smallest packet, not the whole walk: a budget of
      // exactly that many tokens gives the step its first target, and one token
      // less still gives it nothing. (Both budgets keep their figures' digit
      // counts, so the packet measures the same at each.)
      const whole = await new LocalContextPreflightService({
        cacheRoot: cache,
        modelInputTokens: LARGEST_INSTALLED_WINDOW,
      }).preflight(readinessInput(repository));
      expect(smallest).toBeLessThan(whole.measurements!.estimatedTokens);
      await withEnvironment(exactCorpusBudget(smallest), async () => {
        const enough = await new LocalContextPreflightService({ cacheRoot: cache }).preflight(
          readinessInput(repository),
        );
        expect(enough.status).toBe("degraded");
        expect(packetOf(enough).nodes).toHaveLength(1);
        expect(enough.measurements!.estimatedTokens).toBe(smallest);
      });
      await withEnvironment(exactCorpusBudget(smallest - 1), async () => {
        const short = await new LocalContextPreflightService({ cacheRoot: cache }).preflight(
          readinessInput(repository),
        );
        expect(short.packet).toBeUndefined();
        expect(short.limit).toEqual({
          name: CORPUS_SHARE,
          unit: "tokens",
          configured: smallest - 1,
          observed: smallest,
        });
      });
    });
  });

  it("projects each recorded packet budget into the operator summary by what the step did", () => {
    const limit = {
      name: CORPUS_SHARE,
      unit: "tokens" as const,
      configured: 8_192,
      observed: 9_000,
    };
    const budgeted = (packetDigest?: string, ontologyVersion?: string, unbound?: string[]) => ({
      status: "degraded",
      reason: "preflight-budget-exceeded",
      limit,
      ...(packetDigest ? { packetDigest } : {}),
      ...(ontologyVersion ? { ontologyVersion } : {}),
      ...(unbound ? { unboundTargets: unbound } : {}),
    });
    const record = {
      steps: [
        {
          id: "trimmed",
          status: "succeeded",
          contextPreflight: budgeted("a".repeat(64), "ontology-v1", ["docs/b.md", "docs/c.md"]),
        },
        {
          id: "capsule",
          status: "succeeded",
          contextPreflight: budgeted("b".repeat(64), "hosted-v1"),
        },
        { id: "withheld", status: "succeeded", contextPreflight: budgeted() },
        { id: "stopped", status: "failed", contextPreflight: budgeted() },
        {
          id: "unresolved",
          status: "succeeded",
          contextPreflight: {
            status: "degraded",
            reason: "scope-target-partially-unresolved",
            packetDigest: "c".repeat(64),
            unboundTargets: ["docs/missing.md"],
          },
        },
        {
          id: "hosted-wait",
          status: "succeeded",
          contextPreflight: {
            status: "degraded",
            reason: "preflight-budget-exceeded",
            limit: {
              name: "hostInvoker.contextPreflightBudgetMs",
              unit: "ms",
              configured: 1,
              observed: 2,
            },
          },
        },
      ],
    } as unknown as RunRecord;
    // The hosted wait is a latency bound, not a packet budget, so it adds no line here.
    expect(projectRunLimitOverflowLines(collectRunLimitOverflowEvidence(record))).toEqual([
      summaryLine("trimmed", limit, "it ran with the packet trimmed to fit", [
        "docs/b.md",
        "docs/c.md",
      ]),
      summaryLine("capsule", limit, "it ran with the host capsule in place of the packet"),
      summaryLine("withheld", limit, "it ran without a packet"),
      summaryLine("stopped", limit, "the write step stopped, because it needs a packet"),
      'scope-target-partially-unresolved: step "unresolved" context packet does not bind every requested page. Requested pages without context: docs/missing.md.',
    ]);
  });

  it("scales the budget with the bound window and honors an upward host override", async () => {
    const { repository, cache, root } = await corpusRepository(20, 6);
    const small = await new LocalContextPreflightService({
      cacheRoot: cache,
      modelInputTokens: SMALLEST_INSTALLED_WINDOW,
    }).preflight(readinessInput(repository));
    const large = await new LocalContextPreflightService({
      cacheRoot: cache,
      modelInputTokens: LARGEST_INSTALLED_WINDOW,
    }).preflight(readinessInput(repository));
    expect(small).toMatchObject({ status: "degraded", reason: "preflight-budget-exceeded" });
    expect(large.status).toBe("ready");
    expect(large.reason).toBeUndefined();
    expect(packetOf(small).provenance.budget.maxEstimatedTokens).toBe(8_192);
    expect(packetOf(large).provenance.budget.maxEstimatedTokens).toBe(131_250);
    expect(large.measurements!.estimatedTokens).toBeGreaterThan(8_192);

    // An upward override of the declared share, at the limit, is honored with
    // no bound model at all; one past the limit refuses by name.
    await withEnvironment(
      { DOCSFAB_CONTEXT_CORPUS_PACKET_INPUT_SHARE_BASIS_POINTS: "10000" },
      async () => {
        expect(contextPacketBudget("corpus").maxEstimatedTokens).toBe(SMALLEST_INSTALLED_WINDOW);
        const raised = await new LocalContextPreflightService({ cacheRoot: cache }).preflight(
          readinessInput(repository),
        );
        expect(raised.status).toBe("ready");
        expect(packetOf(raised).provenance.budget.maxEstimatedTokens).toBe(
          SMALLEST_INSTALLED_WINDOW,
        );
        expect(packetOf(raised).nodes).toEqual(packetOf(large).nodes);
      },
    );
    await withEnvironment(
      { DOCSFAB_CONTEXT_CORPUS_PACKET_INPUT_SHARE_BASIS_POINTS: "10001" },
      () => {
        expect(() => contextPacketBudget("corpus")).toThrow(
          "DOCSFAB_CONTEXT_CORPUS_PACKET_INPUT_SHARE_BASIS_POINTS must be an integer between 1 and 10000.",
        );
      },
    );
    await withEnvironment({ DOCSFAB_CONTEXT_PACKET_FALLBACK_INPUT_TOKENS: "1050000" }, () => {
      expect(contextPacketBudget("corpus")).toEqual(
        contextPacketBudget("corpus", LARGEST_INSTALLED_WINDOW),
      );
    });

    // The window reaches the packet through the local and hosted assemblies.
    const { services } = await createLocalWorkflowApplicationServices({
      config: {
        stateDirectory: resolve(root, "state", "runs"),
        skillCrateDirectory: resolve("skill-crate"),
        qualityDirectory: resolve("quality"),
        qualityPackDirectory: resolve("quality-pack"),
      },
      request: { workflow: "readiness" },
      workflow: { schemaVersion: 1 },
      workspace: { path: repository, revision: "f".repeat(40) },
      repositoryEvidence: {},
      baseHarness: {},
      modelInputTokens: LARGEST_INSTALLED_WINDOW,
    } as never);
    const assembled = await services.contextPreflight!.preflight(readinessInput(repository));
    expect(packetOf(assembled).provenance.budget.maxEstimatedTokens).toBe(131_250);
    const hosted = await createHostedContextPreflightService({
      capsule: { sha256: "c".repeat(64), selectedEvidence: [] } as never,
      stateDirectory: resolve(root, "hosted"),
      modelInputTokens: LARGEST_INSTALLED_WINDOW,
    }).preflight(readinessInput(repository));
    expect(hosted.status).toBe("ready");
    expect(packetOf(hosted).provenance.budget.maxEstimatedTokens).toBe(131_250);
  });

  it("leaves a packet within its budget unchanged", async () => {
    const { repository, cache } = await corpusRepository(3, 2);
    const atDefault = await new LocalContextPreflightService({ cacheRoot: cache }).preflight(
      readinessInput(repository),
    );
    const atLargest = await new LocalContextPreflightService({
      cacheRoot: cache,
      modelInputTokens: LARGEST_INSTALLED_WINDOW,
    }).preflight(readinessInput(repository));
    expect(atDefault.status).toBe("ready");
    expect(atDefault.reason).toBeUndefined();
    expect(atDefault.limit).toBeUndefined();
    const fitted = packetOf(atDefault);
    const roomy = packetOf(atLargest);
    // Nothing is trimmed: the same walk, node for node, edge for edge, path
    // for path; only the budget the provenance records differs.
    expect(fitted.nodes).toEqual(roomy.nodes);
    expect(fitted.edges).toEqual(roomy.edges);
    expect(fitted.paths).toEqual(roomy.paths);
    expect(fitted.query).toEqual(roomy.query);
    expect(fitted.paths).toHaveLength(fitted.nodes.length);
    const index = await buildContentIndex({
      repositoryPath: repository,
      repositoryRevision: REVISION,
    });
    expect(fitted.nodes.map((node) => node.id).sort()).toEqual(
      index.nodes.map((node) => node.id).sort(),
    );
  });

  it("reports the untrimmed size exactly and keeps the largest packet that fits", async () => {
    const { repository } = await corpusRepository(4, 3);
    const index = await buildContentIndex({
      repositoryPath: repository,
      repositoryRevision: REVISION,
    });
    const compile = (budget: ContextBudget): ContextResult =>
      compileContext({
        index,
        ontology: structuralOntology(index),
        semantics: [],
        query: {
          kind: "expand",
          targetNodeIds: index.nodes
            .filter((node) => node.kind === "document")
            .map((node) => node.id)
            .sort(),
          depth: 2,
        },
        policy: {
          id: "workflow:readiness:context",
          version: "1",
          digest: "d".repeat(64),
          allowDegradedRead: true,
        },
        budget,
      });
    // Two budgets whose figures have the same digit counts, so the packet
    // that fits the larger one is byte for byte the size the smaller one saw.
    const tight = { ...contextPacketBudget("corpus") };
    const roomyBudget: ContextBudget = {
      ...tight,
      maxNodes: 9_999,
      maxEdges: 9_999,
      maxPaths: 9_999,
      maxEstimatedTokens: 9_999,
      maxBytes: 39_996,
    };
    const tightBudget: ContextBudget = {
      ...tight,
      maxNodes: 2_500,
      maxEdges: 2_500,
      maxPaths: 2_500,
      maxEstimatedTokens: 2_500,
      maxBytes: 10_000,
    };
    const whole = compile(roomyBudget);
    expect(whole.status).toBe("ready");
    const size = whole.packet!.estimates;
    expect(size.estimatedTokens).toBeGreaterThan(tightBudget.maxEstimatedTokens);
    expect(size.estimatedTokens).toBeLessThanOrEqual(roomyBudget.maxEstimatedTokens);

    const trimmed = compile(tightBudget);
    expect(trimmed.status).toBe("degraded");
    expect(trimmed.reasons).toEqual(
      expect.arrayContaining([
        { code: "byte-budget-exceeded", detail: String(size.byteLength) },
        { code: "token-budget-exceeded", detail: String(size.estimatedTokens) },
      ]),
    );
    expect(trimmed.packet!.estimates.estimatedTokens).toBeLessThanOrEqual(
      tightBudget.maxEstimatedTokens,
    );
    // Nodes first: every node fits on its own here, so the trim takes only
    // the lowest-ranked edges and paths, and keeps as many of them as fit.
    const elements = (packet: ContextPacketV1): number =>
      packet.nodes.length + packet.edges.length + packet.paths.length;
    expect(trimmed.packet!.nodes).toEqual(whole.packet!.nodes);
    expect(elements(trimmed.packet!)).toBeLessThan(elements(whole.packet!));
    expect(trimmed.packet!.edges.length + trimmed.packet!.paths.length).toBeGreaterThan(0);
  });

  it("sizes packets only from a window DocsFab admits against, and never below the fallback window", () => {
    // An endpoint that matches no installed composition: setup writes a
    // placeholder window, and binding marks the profile provider-admitted.
    const placeholder = {
      contextAdmission: "provider" as const,
      profile: { maxInputTokens: 32_768 },
    };
    expect(contextPacketInputWindow(placeholder)).toBeUndefined();
    expect(
      contextPacketInputWindow({
        contextAdmission: "host-window",
        profile: { maxInputTokens: LARGEST_INSTALLED_WINDOW },
      }),
    ).toBe(LARGEST_INSTALLED_WINDOW);
    // An installed composition carries no admission field and is host-admitted.
    expect(
      contextPacketInputWindow({ profile: { maxInputTokens: LARGEST_INSTALLED_WINDOW } }),
    ).toBe(LARGEST_INSTALLED_WINDOW);
    expect(contextPacketInputWindow({ contextAdmission: "host-window" })).toBeUndefined();
    expect(contextPacketInputWindow(undefined)).toBeUndefined();
    // A smaller attested window is floored: no setup gets less than the
    // fallback window gives, which at the default is the former fixed budget.
    expect(contextPacketBudget("corpus", 32_768)).toEqual(contextPacketBudget("corpus"));
    expect(contextPacketBudget("change-scoped", 32_768).maxEstimatedTokens).toBe(2_051);
    expect(contextPacketBudget("corpus", 1).maxEstimatedTokens).toBeGreaterThanOrEqual(8_192);
    expect(contextPacketBudget("local", 1).maxEstimatedTokens).toBeGreaterThanOrEqual(2_048);
  });

  it("keeps a write step's packet for an endpoint that matches no installed composition", async () => {
    // The critic's setup: a 300-heading target page, written through
    // update-documentation, on an unattested endpoint whose setup window is the
    // 32,768-token placeholder. The write gets a trimmed packet and proceeds.
    const root = await roots.create("docsfab-context-packet-placeholder-");
    const repository = resolve(root, "repository");
    await mkdir(resolve(repository, "docs"), { recursive: true });
    await writeFile(
      resolve(repository, "docs", "reference.md"),
      `# Reference\n\n${Array.from({ length: 300 }, (_unused, index) => `## Option ${index}\n\nValue ${index}.\n`).join("\n")}`,
      "utf8",
    );
    const workflow = getWorkflow("update-documentation");
    const step = workflow.steps.find((candidate) => candidate.id === "write-documentation")!;
    const policy = workflow.contextPolicy.steps.find((candidate) => candidate.stepId === step.id)!;
    const placeholder = {
      contextAdmission: "provider" as const,
      profile: { maxInputTokens: 32_768 },
    };
    const window = contextPacketInputWindow(placeholder);
    const result = await new LocalContextPreflightService({
      cacheRoot: resolve(root, "cache"),
      ...(window !== undefined ? { modelInputTokens: window } : {}),
    }).preflight({
      ...readinessInput(repository),
      workflow,
      step,
      policy,
      contextTarget: { sourcePath: "docs/reference.md" },
    });
    expect(result.status).toBe("degraded");
    expect(result.packetDigest).toBeDefined();
    expect(packetOf(result).provenance.budget.maxEstimatedTokens).toBe(
      contextPacketBudget("change-scoped").maxEstimatedTokens,
    );
    expect(packetOf(result).nodes.some((node) => node.sourcePath === "docs/reference.md")).toBe(
      true,
    );
    // The same holds for a model that attests the small window itself.
    const attested = await new LocalContextPreflightService({
      cacheRoot: resolve(root, "cache"),
      modelInputTokens: 32_768,
    }).preflight({
      ...readinessInput(repository),
      workflow,
      step,
      policy,
      contextTarget: { sourcePath: "docs/reference.md" },
    });
    expect(attested.packetDigest).toBe(result.packetDigest);
  });

  it("keeps requested pages first, in request order, and names those a trim leaves without context", async () => {
    const { repository, cache } = await corpusRepository(8, 60);
    const workflow = getWorkflow("review-documentation");
    // A request order that is neither path nor node-ID order.
    const requested = [5, 2, 7, 0, 3, 6, 1, 4].map(
      (page) => `docs/page-${String(page).padStart(2, "0")}.md`,
    );
    const input: ContextPreflightInput = {
      ...readinessInput(repository),
      workflow,
      step: workflow.steps[0]!,
      policy: workflow.contextPolicy.steps[0]!,
      scope: { targetPaths: requested, scopeSha256: "c".repeat(64) },
    };
    const result = await withEnvironment(exactCorpusBudget(1_500), () =>
      new LocalContextPreflightService({ cacheRoot: cache }).preflight(input),
    );
    expect(result).toMatchObject({
      status: "degraded",
      reason: "preflight-budget-exceeded",
      limit: { name: CORPUS_SHARE, unit: "tokens", configured: 1_500 },
    });
    const kept = new Set(
      packetOf(result)
        .nodes.filter((node) => node.kind === "document")
        .map((node) => node.sourcePath),
    );
    const keptCount = requested.filter((path) => kept.has(path)).length;
    expect(keptCount).toBeGreaterThan(0);
    expect(keptCount).toBeLessThan(requested.length);
    // The kept pages are the first ones requested, whatever their paths or IDs.
    expect(requested.filter((path) => kept.has(path))).toEqual(requested.slice(0, keptCount));
    const unbound = [...requested.slice(keptCount)].sort();
    expect(result.unboundTargets).toEqual(unbound);
    const evidence = normalizeContextPreflight(result);
    expect(evidence.unboundTargets).toEqual(unbound);
    expect(decodeContextPreflight(evidence)).toEqual(evidence);
    const record = {
      steps: [{ id: "audit-documentation", status: "succeeded", contextPreflight: evidence }],
    } as unknown as RunRecord;
    expect(projectRunLimitOverflowLines(collectRunLimitOverflowEvidence(record))).toEqual([
      summaryLine(
        "audit-documentation",
        evidence.limit!,
        "it ran with the packet trimmed to fit",
        unbound,
      ),
    ]);
  });

  it("keeps a packet exactly at its budget whole, and trims it one token below", async () => {
    const { repository, cache } = await corpusRepository(3, 2);
    // Find the budget the whole walk exactly fills: its size depends on the
    // budget figures it records, so settle the two against each other.
    let budgetTokens = (
      await new LocalContextPreflightService({ cacheRoot: cache }).preflight(
        readinessInput(repository),
      )
    ).measurements!.estimatedTokens;
    let settled = false;
    for (let round = 0; round < 4 && !settled; round += 1) {
      const fitted = await withEnvironment(exactCorpusBudget(budgetTokens), () =>
        new LocalContextPreflightService({ cacheRoot: cache }).preflight(
          readinessInput(repository),
        ),
      );
      const size = fitted.measurements!.estimatedTokens;
      settled = fitted.status === "ready" && size === budgetTokens;
      if (!settled) budgetTokens = fitted.limit?.observed ?? size;
    }
    expect(settled).toBe(true);
    const atBudget = await withEnvironment(exactCorpusBudget(budgetTokens), () =>
      new LocalContextPreflightService({ cacheRoot: cache }).preflight(readinessInput(repository)),
    );
    expect(atBudget.status).toBe("ready");
    expect(atBudget.reason).toBeUndefined();
    expect(atBudget.limit).toBeUndefined();
    expect(atBudget.measurements!.estimatedTokens).toBe(budgetTokens);
    expect(String(budgetTokens - 1)).toHaveLength(String(budgetTokens).length);
    const below = await withEnvironment(exactCorpusBudget(budgetTokens - 1), () =>
      new LocalContextPreflightService({ cacheRoot: cache }).preflight(readinessInput(repository)),
    );
    expect(below).toMatchObject({
      status: "degraded",
      reason: "preflight-budget-exceeded",
      limit: {
        name: CORPUS_SHARE,
        unit: "tokens",
        configured: budgetTokens - 1,
        observed: budgetTokens,
      },
    });
    expect(below.measurements!.estimatedTokens).toBeLessThan(budgetTokens);
  });

  it("resolves a page requested by its decomposed name, and never fails a step for the name of a page it cannot bind", async () => {
    const root = await roots.create("docsfab-context-unbound-names-");
    const repository = resolve(root, "repository");
    await mkdir(resolve(repository, "docs"), { recursive: true });
    const composed = "docs/caf\u00e9.md";
    const decomposed = "docs/cafe\u0301.md";
    await writeFile(resolve(repository, "docs", "guide.md"), "# Guide\n\nText.\n", "utf8");
    await writeFile(resolve(repository, composed), "# Cafe\n\nText.\n", "utf8");
    const workflow = getWorkflow("review-documentation");
    const scoped = (targetPaths: string[]): ContextPreflightInput => ({
      ...readinessInput(repository),
      workflow,
      step: workflow.steps[0]!,
      policy: workflow.contextPolicy.steps[0]!,
      scope: { targetPaths, scopeSha256: "e".repeat(64) },
    });
    const service = new LocalContextPreflightService({ cacheRoot: resolve(root, "cache") });

    // The index names files NFC, so a request for the decomposed name binds
    // the page the index read.
    const bound = await preflightContext({
      ...scoped(["docs/guide.md", decomposed]),
      contextPreflight: service,
    });
    expect(bound.evidence.status).toBe("ready");
    expect(bound.evidence.unboundTargets).toBeUndefined();
    expect(
      (bound.packet as ContextPacketV1).nodes.some((node) => node.sourcePath === composed),
    ).toBe(true);

    // Requested pages the packet cannot bind are named NFC, a backslash kept;
    // one whose path a record cannot hold is counted. The step is degraded as
    // on main, never failed.
    const missingDecomposed = "docs/missing-cafe\u0301.md";
    const missingComposed = "docs/missing-caf\u00e9.md";
    const backslash = "docs/a\\b.md";
    const { evidence } = await preflightContext({
      ...scoped(["docs/guide.md", missingDecomposed, backslash, "docs/c\u0001d.md"]),
      contextPreflight: service,
    });
    expect(evidence).toMatchObject({
      status: "degraded",
      reason: "scope-target-partially-unresolved",
      unboundTargets: [backslash, missingComposed],
      unboundTargetsOmitted: 1,
    });
    expect(evidence.packetDigest).toMatch(/^[a-f0-9]{64}$/u);
    expect(decodeContextPreflight(evidence)).toEqual(evidence);
    const record = {
      steps: [{ id: "audit-documentation", status: "succeeded", contextPreflight: evidence }],
    } as unknown as RunRecord;
    expect(projectRunLimitOverflowLines(collectRunLimitOverflowEvidence(record))).toEqual([
      `scope-target-partially-unresolved: step "audit-documentation" context packet does not bind every requested page. Requested pages without context: ${backslash}, ${missingComposed}, and 1 more whose path the record cannot hold.`,
    ]);
    // A count alone, when no name can be held.
    const onlyUnnameable = normalizeContextPreflight({
      status: "degraded",
      reason: "scope-target-partially-unresolved",
      measurements: evidence.measurements!,
      unboundTargets: ["docs/c\u0001d.md", "/etc/x.md"],
    });
    expect(onlyUnnameable.unboundTargets).toBeUndefined();
    expect(onlyUnnameable.unboundTargetsOmitted).toBe(2);
    expect(decodeContextPreflight(onlyUnnameable)).toEqual(onlyUnnameable);
  });

  it("refuses unbound targets out of order, duplicated, or on a step that is not degraded", () => {
    const measurements = {
      byteLength: 1,
      estimatedTokens: 1,
      latencyMs: 0,
      nodeCount: 1,
      edgeCount: 0,
      pathCount: 1,
    };
    const ready = {
      status: "ready" as const,
      packetDigest: "a".repeat(64),
      consultedNodeIds: ["node-a"],
      ontologyVersion: "ontology-v1",
      effectiveDecisionIds: [],
      measurements,
      cache: { disposition: "disabled" as const, rebuildAttempted: false },
    };
    const degraded = {
      ...ready,
      status: "degraded" as const,
      reason: "scope-target-partially-unresolved" as const,
    };
    // Controls: each shape is admitted without the field, or with it in order.
    expect(decodeContextPreflight(ready)).toEqual(ready);
    const ordered = { ...degraded, unboundTargets: ["docs/a.md", "docs/b.md"] };
    expect(decodeContextPreflight(ordered)).toEqual(ordered);
    const counted = { ...degraded, unboundTargetsOmitted: 1 };
    expect(decodeContextPreflight(counted)).toEqual(counted);
    expect(normalizeContextPreflight(ordered)).toEqual(ordered);
    // The decoder: order, uniqueness, a positive count, and degraded only.
    for (const refused of [
      { ...degraded, unboundTargets: ["docs/b.md", "docs/a.md"] },
      { ...degraded, unboundTargets: ["docs/a.md", "docs/a.md"] },
      { ...degraded, unboundTargets: [] },
      { ...degraded, unboundTargetsOmitted: 0 },
      { ...ready, unboundTargets: ["docs/a.md"] },
      { ...ready, unboundTargetsOmitted: 1 },
      { status: "unnecessary", reason: "target-not-applicable", unboundTargets: ["docs/a.md"] },
    ]) {
      expect(() => decodeContextPreflight(refused), JSON.stringify(refused)).toThrow(
        ScorecardRecordError,
      );
    }
    // The normalizer: names or counts only on a degraded step.
    expect(() => normalizeContextPreflight({ ...ready, unboundTargets: ["docs/a.md"] })).toThrow(
      "Context preflight returned invalid unbound targets; only a degraded step names the requested paths its packet does not bind.",
    );
    expect(() => normalizeContextPreflight({ ...ready, unboundTargetsOmitted: 1 })).toThrow(
      "Context preflight returned an invalid count of unbound targets; only a degraded step counts the requested paths its packet does not bind.",
    );
  });
});
