// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Journey tests: one operator journey through the shipped entry point, with
 * only the model provider scripted. The argv goes through `parseRunArguments`
 * and `executeRunRequest`, the step runs on the real `PiHarness` with its real
 * tool grant, and results are read back through the persisted record and
 * `docsfab runs show --json`. Component fakes (`SourceToolHarness`,
 * `FakeHarness`, `EditorialProtocolHarness`) never appear here.
 */
import { cp, mkdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, expect, vi } from "vitest";

import { handleRunsCommand } from "../../src/cli/commands/runs.js";
import { parseRunArguments } from "../../src/cli/run-arguments.js";
import { executeRunRequest } from "../../src/cli/run-request.js";
import type { CliRunOptions } from "../../src/cli/run/request.js";
import { LIMIT_DEFINITION_BY_NAME } from "../../src/config/limits.generated.js";
import type { RunRecord } from "../../src/records/contracts.js";
import { commitFixture, initFixtureRepo } from "../helpers/git.js";
import type { TemporaryRoots } from "../helpers/temp.js";
import { testTimeoutMs } from "../helpers/test-timeouts.js";
import { runtimeConfig } from "./execution-convergence.js";
import {
  assertJourneyProviderSettled,
  journeyProvider,
  type JourneyProvider,
  type JourneyTurn,
} from "./journey-provider.js";

const runtimeRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const journeyFixtureRoot = join(runtimeRoot, "test", "journeys", "fixtures");

/** The per-case journey budget, declared once in config/limits/test.yaml. */
export const JOURNEY_TIMEOUT_LIMIT = "test.journeyLocalTimeoutMs";

type Environment = Readonly<Record<string, string | undefined>>;

export class JourneyBudgetError extends Error {
  public constructor(
    public readonly code: "journey-budget-missing" | "journey-budget-unit",
    message: string,
  ) {
    super(message);
    this.name = "JourneyBudgetError";
  }
}

/**
 * The journey case budget: the declared local value, raised to the shared CI
 * floor when `CI` is set. Refuses by name when the entry is absent or not in
 * milliseconds, so a mirror that lost the entry never falls back to a default.
 */
export function journeyTestTimeoutMs(
  environment: Environment = process.env,
  definitions: Readonly<
    Record<string, { readonly value: number; readonly unit: string }>
  > = LIMIT_DEFINITION_BY_NAME,
): number {
  const definition = definitions[JOURNEY_TIMEOUT_LIMIT];
  if (definition === undefined) {
    throw new JourneyBudgetError(
      "journey-budget-missing",
      `Journey budget ${JOURNEY_TIMEOUT_LIMIT} is missing from the generated limits mirror; declare it in config/limits/test.yaml and run npm run generate:limits.`,
    );
  }
  if (definition.unit !== "ms") {
    throw new JourneyBudgetError(
      "journey-budget-unit",
      `Journey budget ${JOURNEY_TIMEOUT_LIMIT} must use unit ms, found ${definition.unit}.`,
    );
  }
  return testTimeoutMs(definition.value, environment);
}

export interface JourneyFixture {
  readonly root: string;
  readonly repository: string;
  readonly stateDirectory: string;
  readonly revision: string;
}

/** Copy one journey fixture into a fresh Git repository with one commit. */
export async function createJourneyFixture(
  name: string,
  roots: TemporaryRoots,
): Promise<JourneyFixture> {
  const root = await roots.create("docsfab-journey-");
  const repository = join(root, "repository");
  const stateDirectory = join(root, "state", "runs");
  await cp(join(journeyFixtureRoot, name), repository, { recursive: true });
  await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
  await initFixtureRepo(repository, undefined, { branch: "main" });
  const revision = await commitFixture(repository, "journey fixture");
  return { root, repository, stateDirectory, revision };
}

/**
 * Journey providers for one test file. After every test, pass or fail, each
 * provider must have an empty ledger and every scripted turn consumed.
 */
export function journeyProviders(): (turns: readonly JourneyTurn[]) => JourneyProvider {
  const created: JourneyProvider[] = [];
  afterEach(() => {
    vi.unstubAllGlobals();
    process.exitCode = undefined;
    const providers = created.splice(0);
    for (const provider of providers) assertJourneyProviderSettled(provider);
  });
  return (turns) => {
    const provider = journeyProvider(turns);
    created.push(provider);
    return provider;
  };
}

/**
 * Run one `docsfab run` argv the way the router does: `parseRunArguments`,
 * then `executeRunRequest`. The config is the convergence fixture config,
 * whose zero retry budget keeps each scripted turn single-use.
 *
 * The run is silent unless `statusLines` is given. Then the lines the operator
 * sees on stderr while it runs (PREFLIGHT and PROGRESS, trimmed) are appended
 * to it, also when the run refuses, and the printed summary stays off the test
 * output. `options` carries what the router injects, such as the publication
 * freshness check a default run makes.
 */
export async function runJourney(input: {
  readonly fixture: JourneyFixture;
  readonly argv: readonly string[];
  readonly provider: JourneyProvider;
  readonly options?: CliRunOptions;
  readonly statusLines?: string[];
}): Promise<RunRecord> {
  vi.stubGlobal("fetch", input.provider.fetch);
  const request = parseRunArguments([...input.argv]);
  const release = input.statusLines ? captureLiveOutput(input.statusLines) : undefined;
  try {
    const record = await executeRunRequest(request, runtimeConfig(input.fixture.stateDirectory), {
      ...input.options,
      silent: input.statusLines === undefined,
    });
    // `executeRunRequest` returns no record only for `--dry-run`, which runs nothing.
    if (!record) {
      throw new Error("journey run returned no record: a --dry-run argv runs no journey");
    }
    return record;
  } finally {
    release?.();
  }
}

/** Append each stderr line to `lines` and mute `console`; the returned function restores both. */
function captureLiveOutput(lines: string[]): () => void {
  const stderr = vi.spyOn(process.stderr, "write").mockImplementation(((
    chunk: string | Uint8Array,
  ) => {
    const text = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    lines.push(
      ...text
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line !== ""),
    );
    return true;
  }) as typeof process.stderr.write);
  const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
  const error = vi.spyOn(console, "error").mockImplementation((...parts: unknown[]) => {
    lines.push(
      ...parts
        .map(String)
        .join(" ")
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line !== ""),
    );
  });
  return () => {
    stderr.mockRestore();
    log.mockRestore();
    error.mockRestore();
  };
}

/** The run record exactly as the run store persisted it. */
export async function readPersistedRecord(
  fixture: JourneyFixture,
  runId: string,
): Promise<RunRecord> {
  return JSON.parse(
    await readFile(join(fixture.stateDirectory, `${runId}.json`), "utf8"),
  ) as RunRecord;
}

/** `docsfab runs show <id> --json`, parsed, with its exit code. */
export async function runsShowJson(
  fixture: JourneyFixture,
  runId: string,
): Promise<{ readonly value: Record<string, unknown>; readonly exitCode: number }> {
  const lines: string[] = [];
  const log = vi.spyOn(console, "log").mockImplementation((...parts: unknown[]) => {
    lines.push(parts.map(String).join(" "));
  });
  process.exitCode = undefined;
  try {
    await handleRunsCommand(["show", runId, "--state-dir", fixture.stateDirectory, "--json"]);
  } finally {
    log.mockRestore();
  }
  const exitCode = typeof process.exitCode === "number" ? process.exitCode : 0;
  process.exitCode = undefined;
  return { value: JSON.parse(lines.join("\n")) as Record<string, unknown>, exitCode };
}

/**
 * Under Vitest `PI_OFFLINE=1`, so request interpretation never calls the
 * model; every journey records that outcome instead of a scripted turn.
 */
export function expectOfflineInterpretation(record: RunRecord): void {
  expect(record.requestIntent).toEqual({
    schemaVersion: 1,
    admission: {
      outcome: "offline",
      code: null,
      location: null,
      reason: "pi-offline",
      boundary: null,
      calls: [],
      clippedTitles: 0,
    },
    intent: null,
  });
}
