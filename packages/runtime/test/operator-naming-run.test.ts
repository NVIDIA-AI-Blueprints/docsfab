// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** Real local CLI admission and writing with a scripted planner and interpreter. */
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { handleDoCommand } from "../src/cli/commands/do.js";
import { executeRunRequest } from "../src/cli/run-request.js";
import { parseRunArguments } from "../src/cli/run-arguments.js";
import { readRunFailure } from "../src/operator/failure-classification.js";
import { toOperatorErrorEnvelope } from "../src/operator/error-envelope.js";
import { buildRunHumanNextCommand } from "../src/operator/run-summary.js";
import { planTargetNamingRecoveryInstruction } from "../src/operator/run-next-action.js";
import type { RunRecord } from "../src/records/contracts.js";
import { PLAN_TARGET_NOT_NAMED_CODE } from "../src/workflow-execution/plan-binding.js";
import { EditorialProtocolHarness } from "./helpers/editorial-protocol-harness.js";
import {
  observePublicContract,
  orbitOptionChangeRepository,
} from "./helpers/orbit-option-change-fixture.js";
import { testTimeoutMs } from "./helpers/test-timeouts.js";

const roots: string[] = [];
const budget = { timeout: testTimeoutMs(90_000) };
const BEFORE = "# Guide\n\nThe public option is --old.\n";
const SPECIAL = [
  "docs/AGENTS.md",
  "docs/CLAUDE.md",
  "docs/SKILL.md",
  "docs/WARP.md",
  "fern/QWEN.md",
  "docs/CRUSH.md",
  "docs/.hidden.md",
  "docs/.cursor/rules/guide.md",
];
const NORMAL = [
  "docs/guide.md",
  "docs/agents-guide.md",
  "docs/agents/index.md",
  "docs/CONVENTIONS.md",
];
afterEach(async () => {
  vi.unstubAllEnvs();
  process.exitCode = undefined;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function run(input: {
  path: string;
  instruction?: string;
  contextPath?: string;
  companion?: string;
  reading?: Record<string, unknown>;
  throughDo?: boolean;
  sourceNomination?: boolean;
}) {
  const fixture = await orbitOptionChangeRepository("docsfab-operator-naming-run", roots, {
    files: Object.fromEntries(
      [...SPECIAL, ...NORMAL, "AGENTS.md", "fern/SKILL.md"].map((path) => [path, BEFORE]),
    ),
  });
  const impactSource = await observePublicContract(fixture.repository, fixture.head);
  const harness = new EditorialProtocolHarness({
    candidate: "update",
    impactSource,
    writePlannedPages: true,
    plannerPages: [
      { path: input.path, disposition: "update" },
      ...(input.companion ? [{ path: input.companion, disposition: "update" as const }] : []),
    ],
  });
  vi.stubEnv("PI_OFFLINE", "1");
  const instruction = input.instruction ?? "Update the documentation for the new option.";
  const request = {
    workflow: "update-documentation" as const,
    repositoryPath: fixture.repository,
    revision: fixture.head,
    instruction,
    canonSnapshotPath: fixture.canonSnapshotPath,
    comparisonRequest: {
      kind: "base-head" as const,
      baseRevision: fixture.base,
      headRevision: fixture.head,
    },
    readerSources: [
      { role: "public-contract" as const, path: "src/orbit.ts" },
      ...(input.sourceNomination
        ? [{ role: "current-documentation" as const, path: input.path }]
        : []),
    ],
    ...(input.contextPath ? { contextTarget: { sourcePath: input.contextPath } } : {}),
    allowWrite: true,
    releaseGate: false,
    verbose: false,
    json: false,
    showScan: false,
  };
  const options = {
    silent: true,
    harness,
    ...(input.reading
      ? {
          requestInterpreter: {
            async call() {
              return {
                text: JSON.stringify({
                  authorityPreference: { preference: "unspecified", quote: null },
                  targets: [],
                  ...input.reading,
                }),
                usage: { inputTokens: 2, outputTokens: 1 },
              };
            },
          },
        }
      : {}),
  };
  let record: RunRecord | undefined;
  if (input.throughDo) {
    await handleDoCommand([instruction, "--repo", fixture.repository, "--patch-only", "--quiet"], {
      stateDirectory: fixture.config.stateDirectory,
      runWorkflow: async (routed) => {
        record = await executeRunRequest({ ...request, ...routed }, fixture.config, options);
        return record;
      },
    });
  } else {
    record = await executeRunRequest(request, fixture.config, options);
  }
  expect(record).toBeDefined();
  return { fixture, harness, record: record!, request, options };
}

function expectUnnamed(
  result: Awaited<ReturnType<typeof run>>,
  path: string,
  refusalStage: "before-planner" | "at-planner" = "at-planner",
) {
  expect(
    readRunFailure(result.record)?.code,
    "an unnamed special file must be refused at plan admission",
  ).toBe(PLAN_TARGET_NOT_NAMED_CODE);
  expect(result.record.status).toBe("failed");
  if (refusalStage === "before-planner") {
    expect(result.harness.stepIds).toEqual([]);
  } else {
    expect(result.harness.stepIds.at(-1)).toBe("plan-documentation");
  }
  expect(result.harness.stepIds).not.toContain("write-documentation");
  expect(result.record.changes?.files ?? []).toEqual([]);
  expect(result.record.steps.find((step) => step.status === "failed")?.error).toContain(path);
  const next = buildRunHumanNextCommand({
    record: result.record,
    recordPath: join(result.fixture.config.stateDirectory, `${result.record.id}.json`),
    exitCode: 1,
  });
  expect(next?.reason).toContain("exact repository path");
  expect(next?.reason).not.toContain("doctor");
  expect(
    next?.command,
    "NEXT must name the original checkout and the refused file literally",
  ).toContain(result.fixture.repository);
  expect(next?.command).toContain(path);
  expect(next?.command).not.toContain("<original target checkout>");
}

function expectDelivered(result: Awaited<ReturnType<typeof run>>, path: string) {
  expect(result.record.status, result.record.error).toBe("succeeded");
  expect(result.record.changes?.files.map((file) => file.path)).toEqual([path]);
  expect(result.harness.stepIds).toContain("write-documentation");
}

async function expectEarlyScopeRefusal(input: Parameters<typeof run>[0], unchangedPath: string) {
  const previousRoots = roots.length;
  const failure = await run(input).catch((error: unknown) => error);
  expect(failure).toMatchObject({
    name: "FirstRunProposalScopeError",
    code: "proposal-scope-unsafe-target",
    phase: "proposal-scope-admission",
    noWorkPerformed: true,
  });
  expect(toOperatorErrorEnvelope(failure)).toMatchObject({
    code: "proposal-scope-unsafe-target",
    failure: { class: "planning-refusal", code: "proposal-scope-unsafe-target" },
    nextAction: expect.stringContaining("documentationRoots"),
  });
  expect(await readFile(join(roots[previousRoots]!, unchangedPath), "utf8")).toBe(BEFORE);
}

function inventoryReading(path: string, quote: string) {
  return {
    operation: "update",
    targets: [{ path, role: "write", chosenFrom: "inventory", quote }],
  };
}

describe("only the operator names special files for a local plan", () => {
  it("the literal NEXT request delivers the previously refused file", budget, async () => {
    const original = await run({ path: "docs/AGENTS.md" });
    expectUnnamed(original, "docs/AGENTS.md");
    const instruction = planTargetNamingRecoveryInstruction(original.record);
    expect(instruction).toContain("docs/AGENTS.md");
    const comparison = original.record.readerEvidenceRequest!.comparisonRequest!;
    expect(comparison.kind).toBe("base-head");
    if (comparison.kind !== "base-head")
      throw new Error("The retry fixture needs a saved comparison.");
    // Exactly the arguments printed in NEXT, without borrowing the original
    // explicit canon flag or other unprinted request fields.
    const recovered = await executeRunRequest(
      parseRunArguments([
        "update-documentation",
        "--repo",
        original.record.repository.sourcePath,
        "--revision",
        original.record.repository.revision,
        "--instruction",
        instruction!,
        "--comparison-base",
        comparison.baseRevision,
        ...original.record.readerEvidenceRequest!.readerSources!.flatMap(({ role, path }) => [
          "--reader-source",
          `${role}=${path}`,
        ]),
        "--patch-only",
      ]),
      original.fixture.config,
      original.options,
    );
    expect(recovered?.status, recovered?.error).toBe("succeeded");
    expect(recovered?.changes?.files.map((file) => file.path)).toEqual(["docs/AGENTS.md"]);
  });
  it.each(SPECIAL)("refuses the offline planner's unnamed %s", budget, async (path) => {
    const result = await run({ path });
    expect(result.record.requestIntent?.admission.outcome).toBe("offline");
    expectUnnamed(result, path);
    expect(await readFile(join(result.fixture.repository, path), "utf8")).toBe(BEFORE);
  });
  it.each(SPECIAL)("delivers the exact request-named %s (control)", budget, async (path) => {
    expectDelivered(await run({ path, instruction: `Update ${path} for the new option.` }), path);
  });
  it.each(NORMAL)(
    "delivers ordinary %s without naming the file (control)",
    budget,
    async (path) => {
      expectDelivered(await run({ path }), path);
    },
  );
  it("refuses an advisory reading even when its source quote names the file", budget, async () => {
    const result = await run({
      path: "docs/AGENTS.md",
      reading: {
        operation: "review",
        sources: [{ path: "docs/AGENTS.md", quote: "documentation" }],
      },
    });
    expect(result.record.requestIntent?.admission.outcome).toBe("advisory");
    expectUnnamed(result, "docs/AGENTS.md");
  });
  it("the model's inventory-selected write target never grants named-ness", budget, async () => {
    const result = await run({
      path: "docs/AGENTS.md",
      reading: {
        operation: "update",
        targets: [
          {
            path: "docs/AGENTS.md",
            role: "write",
            chosenFrom: "inventory",
            quote: "documentation",
          },
        ],
      },
    });
    expect(result.record.requestIntent?.intent?.targets[0]?.path).toBe("docs/AGENTS.md");
    expectUnnamed(result, "docs/AGENTS.md", "before-planner");
  });
  it("reader-source nominations supply evidence, not target authority", budget, async () => {
    expectUnnamed(await run({ path: "docs/AGENTS.md", sourceNomination: true }), "docs/AGENTS.md");
  });
  it("docs/agents.md does not name docs/AGENTS.md in an executing run", budget, async () => {
    expectUnnamed(
      await run({
        path: "docs/AGENTS.md",
        instruction: "Update docs/agents.md for the new option.",
        reading: inventoryReading("docs/AGENTS.md", "docs/agents.md"),
      }),
      "docs/AGENTS.md",
      "before-planner",
    );
  });
  it.each(["./docs/AGENTS.md", "docs/x/../AGENTS.md", "docs/ＡGENTS.md"])(
    "%s refuses the full raw unsafe path before interpretation",
    budget,
    async (mention) => {
      await expectEarlyScopeRefusal(
        {
          path: "docs/AGENTS.md",
          instruction: `Update ${mention} for the new option.`,
          reading: inventoryReading("docs/AGENTS.md", mention),
        },
        "docs/AGENTS.md",
      );
    },
  );
  it("a basename inside another out-of-root path grants no write authority", budget, async () => {
    await expectEarlyScopeRefusal(
      {
        path: "docs/WARP.md",
        instruction: "Update guides/WARP.md for the new option.",
        reading: inventoryReading("docs/WARP.md", "guides/WARP.md"),
      },
      "docs/WARP.md",
    );
  });
  it("a duplicated basename names neither tracked file", budget, async () => {
    expectUnnamed(
      await run({
        path: "docs/SKILL.md",
        instruction: "Update SKILL.md for the new option.",
        reading: inventoryReading("docs/SKILL.md", "SKILL.md"),
      }),
      "docs/SKILL.md",
      "before-planner",
    );
  });
  it("a unique bare basename delivers its tracked file (control)", budget, async () => {
    expectDelivered(
      await run({
        path: "docs/WARP.md",
        instruction: "Update WARP.md for the new option.",
        reading: inventoryReading("docs/WARP.md", "WARP.md"),
      }),
      "docs/WARP.md",
    );
  });
  it(
    "an explicit operator target delivers without a path in request text (control)",
    budget,
    async () => {
      expectDelivered(
        await run({ path: "docs/AGENTS.md", contextPath: "docs/AGENTS.md" }),
        "docs/AGENTS.md",
      );
    },
  );
  it("do preserves Unicode operator text before workflow admission (control)", async () => {
    const typed = "Update docs/SKILL.md for the new option.";
    let routedInstruction: string | undefined;
    await handleDoCommand([typed, "--patch-only", "--quiet"], {
      runWorkflow: async (request) => {
        routedInstruction = request.instruction;
        return {};
      },
    });
    expect(routedInstruction).toBe(typed);
    expect(routedInstruction).not.toBe(typed.normalize("NFC"));
  });
  it("do refuses a planner-selected hidden target", budget, async () => {
    expectUnnamed(await run({ path: "docs/.hidden.md", throughDo: true }), "docs/.hidden.md");
  });
  it("do delivers the named hidden target (control)", budget, async () => {
    expectDelivered(
      await run({
        path: "docs/.hidden.md",
        instruction: "Update docs/.hidden.md for the new option.",
        throughDo: true,
      }),
      "docs/.hidden.md",
    );
  });
});

describe("literal NEXT retains the complete operator request", () => {
  it("retains prior explicit target authority while adding refused companion", budget, async () => {
    const original = await run({
      path: "docs/AGENTS.md",
      companion: "docs/SKILL.md",
      contextPath: "docs/SKILL.md",
    });
    expectUnnamed(original, "docs/AGENTS.md");
    const instruction = planTargetNamingRecoveryInstruction(original.record)!;
    const comparison = original.record.readerEvidenceRequest!.comparisonRequest!;
    if (comparison.kind !== "base-head") throw Error("fixture needs base-head");
    const retry = await executeRunRequest(
      parseRunArguments([
        original.record.workflow,
        "--repo",
        original.record.repository.sourcePath,
        "--revision",
        original.record.repository.revision,
        "--instruction",
        instruction,
        "--comparison-base",
        comparison.baseRevision,
        ...original.record.readerEvidenceRequest!.readerSources!.flatMap(({ role, path }) => [
          "--reader-source",
          `${role}=${path}`,
        ]),
        "--patch-only",
      ]),
      original.fixture.config,
      original.options,
    );
    expect(retry?.status, retry?.error).toBe("succeeded");
    expect(retry?.changes?.files.map((f) => f.path).sort()).toEqual([
      "docs/AGENTS.md",
      "docs/SKILL.md",
    ]);
  });
});
