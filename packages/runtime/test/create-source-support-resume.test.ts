// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * A CREATE that lacks source support stops as named InputAsk slots, and
 * supplying the source continues the same job to a verified result.
 *
 * The first plan binds only `docs/release-notes.html`, so the ledger marks
 * `environment-prerequisite` unverified (only README states it) and the run
 * ends `needs-input`. `docsfab do --continue <run-id> --attach README.md` binds
 * README and the CREATE verifies. The fixture proves binding README clears the
 * gap, not that README is cited as the locator. Only the model turn is
 * scripted; the CLI composition root, plan source authority, and runner are
 * shipped.
 */
import { readFile, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { handleDoCommand, type DoRunArguments } from "../src/cli/commands/do.js";
import { handleRunsCommand } from "../src/cli/commands/runs.js";
import { executeRunRequest } from "../src/cli/run-request.js";
import { limit } from "../src/config/limits.js";
import type { HarnessStepInput } from "../src/execution/contracts.js";
import {
  bindOperatorInputFills,
  listOpenEditorialRuns,
  operatorInputResumeInstructionContext,
} from "../src/inputs/operator-input-fill.js";
import { planLiveAgentEditorialInputAskTurn } from "../src/live-agent/workflow-delivery.js";
import { classifyRunResumability } from "../src/operator/run-resumability.js";
import type { RunRecord } from "../src/records/contracts.js";
import { INSTRUCTION_CONTEXT_MAX_CHARS_LIMIT } from "../src/records/instruction-context.js";
import { sourceClaimSha256 } from "../src/inputs/source-evidence-artifacts.js";
import { SOURCE_CITATION_GAPS_LIMITATION } from "../src/workflow-contracts/outcome.js";
import {
  canonicalSourceObligationProposal,
  requiresSourceObligationLedger,
  type SourceObligationLedgerProposalV1,
} from "../src/workflow-execution/source-obligation.js";
import { runtimeConfig } from "./support/execution-convergence.js";
import {
  createSourceFixture,
  HTML_SOURCE_PATH,
  PAGE_PATH,
  planBinding,
  runRequest,
  skillResolver,
  SourceToolHarness,
  writerClaim,
} from "./support/source-acquisition-cli.js";
import { temporaryRoots } from "./helpers/temp.js";
import { testTimeoutMs } from "./helpers/test-timeouts.js";

const roots = temporaryRoots();
const README = "README.md";
const GUIDE = "docs/guide.md";
const ENVIRONMENT = "environment-prerequisite";
const SLOT = `source-support:${ENVIRONMENT}:${PAGE_PATH}`;
const NOMINATION = /the tracked repository file (\S+) as an approved source/gu;

afterEach(() => {
  process.exitCode = undefined;
});

/** Plan source paths of one step input, without revision suffixes. */
function boundPlanSources(input: HarnessStepInput): string[] {
  return (input.planBinding?.sourceBindings ?? []).flatMap((binding) =>
    binding.sources.map((source) => source.replace(/@[a-f0-9]+$/u, "")),
  );
}

/**
 * The planner binds the implementation source plus any file the host context
 * names as approved. The ledger leaves the environment prerequisite
 * `unverified` while README is not a bound plan source. `failNextPlan` makes
 * the next planner call fail as a provider error would.
 */
class SourceGapHarness extends SourceToolHarness {
  readonly ledgers: { readonly bound: string[]; readonly environment: string }[] = [];
  readonly plannedSources: string[][] = [];
  failNextPlan = false;

  override async runStep(input: HarnessStepInput) {
    if (input.step.id === "plan-documentation" && this.failNextPlan) {
      this.failNextPlan = false;
      throw new Error("Provider returned HTTP 503 Service Unavailable.");
    }
    const result = await super.runStep(input);
    if (input.step.id === "plan-documentation") {
      const nominated = [...(input.instructionContext ?? "").matchAll(NOMINATION)].map(
        (match) => match[1]!,
      );
      const sources = [HTML_SOURCE_PATH, ...nominated];
      this.plannedSources.push(sources);
      return { ...result, planBinding: planBinding(sources) };
    }
    if (!requiresSourceObligationLedger(input)) return result;
    const bound = boundPlanSources(input);
    const proposal = structuredClone(
      (result as { sourceObligationProposal: SourceObligationLedgerProposalV1 })
        .sourceObligationProposal,
    );
    if (!bound.includes(README)) {
      const reason = "The bound sources do not establish the Node.js version prerequisite.";
      proposal.dimensions = proposal.dimensions.map((entry) =>
        entry.dimension === ENVIRONMENT
          ? { ...entry, status: "unverified", reason, sourceLocators: [], obligations: [] }
          : entry,
      );
      proposal.limitations = [reason];
    }
    this.ledgers.push({
      bound: [...bound].sort(),
      environment: proposal.dimensions.find((entry) => entry.dimension === ENVIRONMENT)!.status,
    });
    return {
      ...result,
      summary: canonicalSourceObligationProposal(proposal),
      sourceObligationProposal: proposal,
    };
  }
}

async function continueRun(
  fixture: { repository: string; stateDirectory: string },
  runId: string,
  attach: string,
  run: (request: DoRunArguments) => Promise<RunRecord>,
): Promise<{ request: DoRunArguments; record: RunRecord }> {
  const captured: { request?: DoRunArguments; record?: RunRecord } = {};
  await handleDoCommand(
    [
      "--repo",
      await realpath(fixture.repository),
      "--continue",
      runId,
      "--attach",
      attach,
      "--patch-only",
    ],
    {
      stateDirectory: fixture.stateDirectory,
      runWorkflow: async (request) => {
        captured.request = request;
        captured.record = await run(request);
        return undefined;
      },
    },
  );
  return { request: captured.request!, record: captured.record! };
}

describe("CREATE source-support InputAsk resume (#1297)", () => {
  it("stops needs-input without README bound, then completes verification after README is supplied", async () => {
    const fixture = await createSourceFixture();
    roots.track(fixture.root);
    const config = runtimeConfig(fixture.stateDirectory);
    const model = new SourceGapHarness({
      readOnSkill: "plan-documentation",
      planSourcePaths: [HTML_SOURCE_PATH],
    });
    const run = async (request: Parameters<typeof executeRunRequest>[0]) =>
      (await executeRunRequest(request, config, {
        silent: true,
        executionHarness: model,
        skillResolver,
      })) as RunRecord;

    const expectSavedExitCode = async (record: RunRecord, expectedExitCode: 0 | 2) => {
      const savedPath = join(fixture.stateDirectory, `${record.id}.json`);
      const savedBytes = await readFile(savedPath);
      for (const json of [false, true]) {
        const previousExitCode = process.exitCode;
        process.exitCode = undefined;
        try {
          const output = await runsShow(record.id, fixture.stateDirectory, json);
          const invocationExitCode = process.exitCode ?? 0;
          if (json) {
            expect(JSON.parse(output.at(-1) ?? "{}").execution.exitCode).toBe(expectedExitCode);
          } else {
            expect(output.join("\n")).toMatch(
              new RegExp(`^\\s*Exit code: ${expectedExitCode}\\s*$`, "m"),
            );
          }
          expect(invocationExitCode).toBe(expectedExitCode);
        } finally {
          process.exitCode = previousExitCode;
        }
      }
      expect(await readFile(savedPath)).toEqual(savedBytes);
    };

    const stopped = await run(runRequest(fixture));

    // The recorded shape: README is not a bound plan source.
    expect(
      stopped.steps.find((step) => step.id === "plan-documentation")?.planBinding?.sourceBindings,
    ).toEqual([{ pagePath: PAGE_PATH, sources: [HTML_SOURCE_PATH] }]);
    expect(model.ledgers).toEqual([{ bound: [HTML_SOURCE_PATH], environment: "unverified" }]);
    expect(stopped.status).toBe("needs-input");
    expect(stopped.workflowOutcome?.disposition).toBe("needs-input");
    expect(stopped.workflowOutcome?.findings.map((finding) => finding.inputId)).toEqual([SLOT]);
    expect(stopped.steps.find((step) => step.id === "verify-technical-accuracy")?.status).toBe(
      "needs-input",
    );
    await expectSavedExitCode(stopped, 2);
    expect(model.calls.some((call) => call.stepId === "evaluate-document-quality")).toBe(false);
    expect(await classifyRunResumability(stopped, fixture.stateDirectory)).toEqual({
      category: "resumable",
      reason: "needs-input",
    });

    const { request, record: resumed } = await continueRun(fixture, stopped.id, README, run);

    expect(request.instruction).toBe(stopped.instruction);
    expect(request.sourcePaths).toBeUndefined();
    expect(request.readerSources).toBeUndefined();
    expect(request.instructionContext).toBe(
      `InputAsk fill ${SLOT}: the operator supplied the tracked repository file ${README} as an approved source for environment prerequisite on ${PAGE_PATH}. Bind it to that page and verify the page against it.`,
    );
    expect(request.operatorInputResume).toMatchObject({
      originalRunId: stopped.id,
      skipPlanner: false,
      revalidate: true,
      fills: [{ inputId: SLOT, role: "approved-source", source: "tracked-path", locator: README }],
    });

    // The ledger keys on README's binding, not the context; the dimension then
    // takes the harness default `not-applicable`.
    expect(resumed.status).toBe("succeeded");
    expect(resumed.id).toBe(request.runId);
    expect(resumed.instructionContext).toBe(request.instructionContext);
    expect(
      resumed.steps.find((step) => step.id === "plan-documentation")?.planBinding?.sourceBindings,
    ).toEqual([{ pagePath: PAGE_PATH, sources: [HTML_SOURCE_PATH, README] }]);
    expect(model.ledgers.at(-1)).toEqual({
      bound: [HTML_SOURCE_PATH, README].sort(),
      environment: "not-applicable",
    });
    const technical = resumed.steps.find((step) => step.id === "verify-technical-accuracy");
    expect(technical?.status).toBe("succeeded");
    expect(JSON.parse(technical!.summary!).coverage).toEqual([
      expect.objectContaining({ path: PAGE_PATH, status: "verified" }),
    ]);
    expect(resumed.authoringExecution).toMatchObject({ selection: { branchId: "retain" } });
    await expectSavedExitCode(resumed, 0);

    // The stopped run is superseded, so a live reply is an ordinary turn again.
    expect(await listOpenEditorialRuns(fixture.stateDirectory)).toEqual([]);
    expect(
      await planLiveAgentEditorialInputAskTurn({
        stateDirectory: fixture.stateDirectory,
        repositoryPath: await realpath(fixture.repository),
        revision: "HEAD",
        replyText: "Thanks, what else should I document?",
      }),
    ).toEqual({ kind: "routing-turn" });
  }, 90_000);

  it("reopens the stop when its continuation fails after saving its record, and continues it", async () => {
    const fixture = await createSourceFixture();
    roots.track(fixture.root);
    const config = runtimeConfig(fixture.stateDirectory);
    const model = new SourceGapHarness({
      readOnSkill: "plan-documentation",
      planSourcePaths: [HTML_SOURCE_PATH],
    });
    const run = async (request: Parameters<typeof executeRunRequest>[0]) =>
      (await executeRunRequest(request, config, {
        silent: true,
        executionHarness: model,
        skillResolver,
      })) as RunRecord;

    const stopped = await run(runRequest(fixture));
    expect(stopped.status).toBe("needs-input");

    // The continuation saves its record, then the provider fails.
    model.failNextPlan = true;
    let failedRunId: string | undefined;
    await continueRun(fixture, stopped.id, README, async (request) => {
      failedRunId = request.runId;
      try {
        return await run(request);
      } catch {
        return undefined as unknown as RunRecord;
      }
    });
    const failed = JSON.parse(
      await readFile(join(fixture.stateDirectory, `${failedRunId}.json`), "utf8"),
    ) as RunRecord;
    expect(failed.status).toBe("failed");

    // The named input is not lost: the stop is open again and continuable.
    expect((await listOpenEditorialRuns(fixture.stateDirectory)).map((item) => item.runId)).toEqual(
      [stopped.id],
    );
    const { record: resumed } = await continueRun(fixture, stopped.id, README, run);
    expect(resumed.status).toBe("succeeded");
    expect(await listOpenEditorialRuns(fixture.stateDirectory)).toEqual([]);
    await expect(continueRun(fixture, stopped.id, README, run)).rejects.toThrow(
      `Run ${stopped.id} was already continued as ${resumed.id}, which completed.`,
    );
  }, 120_000);

  it("keeps one open run when a continuation stops again, and continues from it", async () => {
    const fixture = await createSourceFixture();
    roots.track(fixture.root);
    const config = runtimeConfig(fixture.stateDirectory);
    const model = new SourceGapHarness({
      readOnSkill: "plan-documentation",
      planSourcePaths: [HTML_SOURCE_PATH],
    });
    const run = async (request: Parameters<typeof executeRunRequest>[0]) =>
      (await executeRunRequest(request, config, {
        silent: true,
        executionHarness: model,
        skillResolver,
      })) as RunRecord;
    const repositoryPath = await realpath(fixture.repository);

    const first = await run(runRequest(fixture));
    expect(first.status).toBe("needs-input");

    // The guide does not state the prerequisite, so the continuation stops again.
    const { record: second } = await continueRun(fixture, first.id, GUIDE, run);
    expect(second.status).toBe("needs-input");
    expect(second.workflowOutcome?.findings.map((finding) => finding.inputId)).toEqual([SLOT]);
    expect(model.ledgers.at(-1)).toEqual({
      bound: [HTML_SOURCE_PATH, GUIDE].sort(),
      environment: "unverified",
    });

    // Exactly one open run per chain: the second stop, never the first.
    expect((await listOpenEditorialRuns(fixture.stateDirectory)).map((item) => item.runId)).toEqual(
      [second.id],
    );
    await expect(continueRun(fixture, first.id, README, run)).rejects.toThrow(
      `Run ${first.id} was already continued; ${second.id} is the open run in that chain. Continue ${second.id} instead.`,
    );

    // The live agent can still continue: a path reply fills the open run.
    const turn = await planLiveAgentEditorialInputAskTurn({
      stateDirectory: fixture.stateDirectory,
      repositoryPath,
      revision: "HEAD",
      replyText: README,
    });
    expect(turn.kind).toBe("input-ask-resume");
    if (turn.kind !== "input-ask-resume") return;
    expect(turn.plan.originalRunId).toBe(second.id);

    const { record: third } = await continueRun(fixture, second.id, README, run);
    expect(third.status).toBe("succeeded");
    expect(await listOpenEditorialRuns(fixture.stateDirectory)).toEqual([]);
  }, 120_000);
});

/** The messages `docsfab runs show` prints for a saved run, with or without `--json`. */
async function runsShow(runId: string, stateDirectory: string, json: boolean): Promise<string[]> {
  const output: string[] = [];
  const log = console.log;
  console.log = (message?: unknown): void => {
    output.push(String(message));
  };
  try {
    await handleRunsCommand([
      "show",
      runId,
      ...(json ? ["--json"] : []),
      "--state-dir",
      stateDirectory,
    ]);
  } finally {
    console.log = log;
  }
  return output;
}

describe("a source-support stop keeps the source-citation label (#1917)", () => {
  it(
    "labels the writer's uncited sentence on the needs-input outcome, with its location",
    async () => {
      // The writer cites nothing, and the ledger leaves the environment
      // prerequisite unverified, so the CREATE stops on source support after the
      // write step. That stop builds its outcome on its own path.
      const fixture = await createSourceFixture();
      roots.track(fixture.root);
      const model = new SourceGapHarness({
        readOnSkill: "plan-documentation",
        planSourcePaths: [HTML_SOURCE_PATH],
        citeOnStepIds: [],
      });

      const stopped = (await executeRunRequest(
        runRequest(fixture, [HTML_SOURCE_PATH]),
        runtimeConfig(fixture.stateDirectory),
        { silent: true, executionHarness: model, skillResolver },
      )) as RunRecord;

      expect(stopped.status, stopped.error).toBe("needs-input");
      expect(model.citeCalls).toBe(0);
      expect(stopped.workflowOutcome?.disposition).toBe("needs-input");
      expect(
        stopped.workflowOutcome?.findings.map((finding) => finding.inputId ?? finding.code),
      ).toEqual(expect.arrayContaining([SLOT, SOURCE_CITATION_GAPS_LIMITATION]));
      expect(stopped.workflowOutcome?.limitations).toEqual([SOURCE_CITATION_GAPS_LIMITATION]);
      expect(stopped.sourceCitations?.steps[0]?.uncitedClaims).toEqual([
        {
          path: PAGE_PATH,
          line: 3,
          claimSha256: sourceClaimSha256(writerClaim("write-documentation")),
        },
      ]);
      const json = JSON.parse(
        (await runsShow(stopped.id, fixture.stateDirectory, true)).at(-1) ?? "{}",
      );
      expect(json).toMatchObject({
        product: {
          disposition: "needs-input",
          limitations: expect.arrayContaining([SOURCE_CITATION_GAPS_LIMITATION]),
        },
      });
      expect((await runsShow(stopped.id, fixture.stateDirectory, false)).join("\n")).toContain(
        `Uncited sentences: write-documentation added 1 sentence with no verified source citation, at ${PAGE_PATH}:3.`,
      );
    },
    testTimeoutMs(90_000),
  );
});

describe("source-support fill admission (#1297)", () => {
  const fill = {
    inputId: SLOT,
    fillKind: "path" as const,
    role: "approved-source" as const,
    source: "tracked-path" as const,
    sha256: "a".repeat(64),
    byteLength: 1,
    attribution: { who: "operator" as const, what: SLOT, when: "2026-09-24T12:00:00.000Z" },
    locator: README,
  };

  it("never fills a source slot with an operator file outside the checkout", async () => {
    const fixture = await createSourceFixture();
    roots.track(fixture.root);
    const slots = [{ inputId: SLOT, fillKind: "path" as const, label: "Source" }];
    const outside = join(fixture.root, "outside-notes.md");
    await writeFile(outside, "Requires Node.js 22.\n");

    await expect(
      bindOperatorInputFills({
        slots,
        attachPaths: [outside],
        repositoryPath: fixture.repository,
        when: "2026-09-24T12:00:00.000Z",
      }),
    ).rejects.toThrow("no remaining InputAsk slot that can accept a file fill");
    await expect(
      bindOperatorInputFills({
        slots,
        attachPaths: [README],
        repositoryPath: fixture.repository,
        when: "2026-09-24T12:00:00.000Z",
      }),
    ).resolves.toEqual([
      expect.objectContaining({ inputId: SLOT, role: "approved-source", locator: README }),
    ]);
  });

  it("puts the nomination ahead of the original context and refuses past the context limit", () => {
    const bound = limit(INSTRUCTION_CONTEXT_MAX_CHARS_LIMIT);
    const nomination = operatorInputResumeInstructionContext({ fills: [fill] })!;
    expect(nomination).toContain(`the tracked repository file ${README} as an approved source`);
    expect(
      operatorInputResumeInstructionContext({ fills: [fill], instructionContext: "Earlier." }),
    ).toBe(`${nomination}\n\nEarlier.`);
    expect(operatorInputResumeInstructionContext({ fills: [] })).toBeUndefined();

    const fitting = "x".repeat(bound.value - nomination.length - 2);
    expect(
      operatorInputResumeInstructionContext({ fills: [fill], instructionContext: fitting }),
    ).toHaveLength(bound.value);
    expect(() =>
      operatorInputResumeInstructionContext({ fills: [fill], instructionContext: `${fitting}x` }),
    ).toThrow(`${bound.refusal}: ${bound.value + 1} exceeds ${bound.name}`);
  });
});
