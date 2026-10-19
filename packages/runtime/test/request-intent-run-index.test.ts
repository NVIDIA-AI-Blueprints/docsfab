// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The request interpretation in the run index: every admission outcome
 * written by its shipped producer (`executeRunRequest` with a stub port, the
 * request-intent stop, the first-pass contradiction stop), projected by
 * `projectRunIndexRows`, and counted by `docsfab runs import` and
 * `docsfab runs query --group-by intentAdmission`.
 */
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("../src/cli/first-pass.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/cli/first-pass.js")>();
  // First-pass knowledge needs a model; every run here goes straight to its steps.
  return { ...actual, needsFirstPassKnowledgeForExecution: async () => false };
});

// Only the binding test reaches the shipped port, and its binding fails before any connection.
const modelPort = vi.hoisted(() => ({ shipped: false }));
vi.mock("../src/request-intent/interpret-model.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/request-intent/interpret-model.js")>();
  return {
    createRequestIntentModelPort: (
      ...args: Parameters<typeof actual.createRequestIntentModelPort>
    ) => {
      if (!modelPort.shipped) throw new Error("this test injects every interpretation port");
      return actual.createRequestIntentModelPort(...args);
    },
  };
});

import { handleRunsCommand } from "../src/cli/commands/runs.js";
import { executeRunRequest } from "../src/cli/run-request.js";
import { persistFirstPassContradictionStop } from "../src/cli/run/first-pass-contradiction-stop.js";
import {
  requestInterpretationStep,
  runRequestInterpretation,
} from "../src/cli/run/request-intent-stop.js";
import type { RunRequestWithPublishProjection } from "../src/cli/run/request.js";
import type { DocsFabConfig } from "../src/config/runtime-loader.js";
import type { HarnessStepInput } from "../src/execution/contracts.js";
import type { RunRecord } from "../src/records/contracts.js";
import {
  decodeRunIndexRow,
  projectRunIndexRows,
  RUN_INDEX_INTENT_ADMISSIONS,
  RUN_INDEX_LIMITS,
  RUN_INDEX_PROJECTION_REVISION,
  sha256Hex,
  type RunIndexRowV1,
} from "../src/records/run-index.js";
import {
  interpretRequest,
  RequestIntentModelUnavailableError,
  type RequestIntentInterpreterPort,
} from "../src/request-intent/interpret.js";
import { resolveRequestIntentLimits } from "../src/request-intent/limits.js";
import { limit } from "../src/config/limits.js";
import {
  formatRequestIntentLines,
  REQUEST_INTENT_ADMISSION_OUTCOMES,
} from "../src/request-intent/interpret-record.js";
import { validModelConfig } from "./helpers.js";
import { ModelCompositionError } from "../src/model-composition/types.js";
import { initFixtureRepo } from "./helpers/git.js";
import { testTimeoutMs } from "./helpers/test-timeouts.js";

const runtimeRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const INSTRUCTION = "Update docs/a.md to document the new --profile flag.";
const PI_OFFLINE = process.env.PI_OFFLINE;
/**
 * Local budget for work that runs whole fixture runs through the real runner,
 * about a second each; CI raises it through testTimeoutMs.
 */
const FIXTURE_LOCAL_MS = 60_000;

afterEach(() => {
  process.exitCode = undefined;
  if (PI_OFFLINE === undefined) delete process.env.PI_OFFLINE;
  else process.env.PI_OFFLINE = PI_OFFLINE;
});

type Workflow = RunRequestWithPublishProjection["workflow"];

function config(
  stateDirectory: string,
  overrides: { readonly maxRetries?: number; readonly model?: DocsFabConfig["model"] } = {},
): DocsFabConfig {
  return {
    projectRoot: runtimeRoot,
    skillCrateDirectory: join(runtimeRoot, "skill-crate"),
    qualityDirectory: join(runtimeRoot, "quality"),
    qualityPackDirectory: join(runtimeRoot, "quality-pack"),
    stateDirectory,
    retryPolicy: {
      maxRetries: overrides.maxRetries ?? 0,
      baseDelayMs: 0,
      maxDelayMs: 0,
      retryableCategories: [],
    },
    model: overrides.model ?? validModelConfig,
  };
}

function reply(operation: string, targets: readonly Record<string, unknown>[]): string {
  return JSON.stringify({
    operation,
    targets,
    authorityPreference: { preference: "unspecified", quote: null },
  });
}

const write = (path: string, chosenFrom: string, quote: string) => ({
  path,
  role: "write",
  chosenFrom,
  quote,
});

function port(answer: string | Error): RequestIntentInterpreterPort {
  return {
    async call() {
      if (answer instanceof Error) throw answer;
      return { text: answer, usage: { inputTokens: 3, outputTokens: 2 } };
    },
  };
}

/** A port that gives each reply in turn, each with its own token counts. */
function replies(
  ...answers: readonly { text: string; inputTokens: number; outputTokens: number }[]
): RequestIntentInterpreterPort {
  let next = 0;
  return {
    async call() {
      const { text, ...usage } = answers[next++]!;
      return { text, usage };
    },
  };
}

/** A harness whose every step completes with a summary and no model. */
const harness = {
  inspectSkill: async (input: HarnessStepInput) => ({
    id: input.step.skill,
    contentSha256: "a".repeat(64),
  }),
  runStep: async (input: HarnessStepInput) => ({
    summary: `Completed ${input.step.id}.`,
    model: { provider: "fixture", model: "fixture" },
    skill: { id: input.step.skill, contentSha256: "a".repeat(64) },
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, turns: 0 },
    tools: { totalCalls: 0, failedCalls: 0, byTool: [], failureCategories: [] },
  }),
};
const skillResolver = {
  resolveSkill: async (input: HarnessStepInput) => ({
    id: input.step.skill,
    contentSha256: "a".repeat(64),
  }),
};

interface Fixture {
  readonly name: string;
  readonly record: Record<string, unknown>;
  readonly path: string;
}

/** Record ids already in the state directory. */
async function savedIds(stateDirectory: string): Promise<Set<string>> {
  const names = await readdir(stateDirectory).catch(() => [] as string[]);
  return new Set(names.filter((name) => name.endsWith(".json")).map((name) => name.slice(0, -5)));
}

/** Run quietly; the thrown error, if any, is returned rather than raised. */
async function silenced<T>(run: () => Promise<T>): Promise<unknown> {
  const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
  const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
  const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  try {
    await run();
    return undefined;
  } catch (thrown) {
    // A stop or a step failure still saves its record; the record is the fixture.
    return thrown;
  } finally {
    log.mockRestore();
    error.mockRestore();
    stderr.mockRestore();
    process.exitCode = undefined;
  }
}

const FIXTURE_FILES: Readonly<Record<string, string>> = {
  "README.md": "# Fixture\n",
  "docs/a.md": "# Alpha\n\nThe CLI.\n",
  "docs/b.md": "---\ntitle: Beta\n---\nBody.\n",
  ".docsfab.json": `${JSON.stringify({
    schemaVersion: 1,
    gitlab: { remote: "origin", defaultBranch: "main" },
    provider: { configuration: "host" },
    storage: { scope: "user-private" },
  })}\n`,
};

interface RunOptions {
  readonly instruction?: string | undefined;
  readonly allowWrite?: boolean;
  readonly port?: RequestIntentInterpreterPort;
  readonly files?: Readonly<Record<string, string>>;
  readonly maxRetries?: number;
  readonly model?: DocsFabConfig["model"];
}

/** One run through `executeRunRequest`: the error it threw and the records it saved. */
async function execute(
  root: string,
  stateDirectory: string,
  name: string,
  workflow: Workflow,
  options: RunOptions,
): Promise<{ readonly error: unknown; readonly saved: readonly string[] }> {
  const repositoryPath = join(root, `repo-${name}`);
  await initFixtureRepo(repositoryPath, { ...FIXTURE_FILES, ...options.files });
  const before = await savedIds(stateDirectory);
  const request = {
    workflow,
    repositoryPath,
    revision: "HEAD",
    ...("instruction" in options
      ? options.instruction === undefined
        ? {}
        : { instruction: options.instruction }
      : { instruction: INSTRUCTION }),
    allowWrite: options.allowWrite ?? false,
    releaseGate: false,
    verbose: false,
    json: false,
    showScan: false,
    patchOnly: true,
  } as RunRequestWithPublishProjection;
  const error = await silenced(() =>
    executeRunRequest(request, config(stateDirectory, options), {
      ...(options.port ? { requestInterpreter: options.port } : {}),
      executionHarness: harness,
      skillResolver,
    } as never),
  );
  const saved = [...(await savedIds(stateDirectory))].filter((id) => !before.has(id));
  return { error, saved };
}

/** One run through `executeRunRequest`, and the one record it saved. */
async function runOnce(
  root: string,
  stateDirectory: string,
  name: string,
  workflow: Workflow,
  options: RunOptions,
): Promise<Fixture> {
  const { saved } = await execute(root, stateDirectory, name, workflow, options);
  expect(saved, name).toHaveLength(1);
  const path = join(stateDirectory, `${saved[0]!}.json`);
  return { name, path, record: JSON.parse(await readFile(path, "utf8")) };
}

/** Save `record` under a new id beside the others, as a later edit or copy would. */
async function saveCopy(
  stateDirectory: string,
  name: string,
  record: Record<string, unknown>,
): Promise<Fixture> {
  const id = `${name}-0000-4000-8000-000000000000`.slice(0, 36);
  const copy = { ...structuredClone(record), id };
  const path = join(stateDirectory, `${id}.json`);
  await writeFile(path, JSON.stringify(copy));
  return { name, path, record: copy };
}

/**
 * Every fixture, by name. The outcome each one must carry is asserted on the
 * record before any projection is read, so a matrix row cannot pass on an
 * outcome its producer never wrote.
 */
async function buildFixtures(root: string): Promise<{
  readonly stateDirectory: string;
  readonly fixtures: ReadonlyMap<string, Fixture>;
}> {
  const stateDirectory = join(root, "state", "runs");
  await mkdir(stateDirectory, { recursive: true });
  const fixtures = new Map<string, Fixture>();
  const add = (fixture: Fixture) => fixtures.set(fixture.name, fixture);
  const run = (name: string, workflow: Workflow, options: Parameters<typeof runOnce>[4]) =>
    runOnce(root, stateDirectory, name, workflow, options).then(add);

  await run("admitted-inventory", "update-documentation", {
    port: port(reply("update", [write("docs/a.md", "inventory", "docs/a.md")])),
  });
  await run("admitted-named", "update-documentation", {
    port: port(reply("update", [write("docs/a.md", "named", "docs/a.md")])),
  });
  // Two pages of one origin are that origin, not a mix.
  await run("admitted-named-pair", "update-documentation", {
    instruction: "Update docs/a.md and docs/b.md for the new --profile flag.",
    port: port(
      reply("update", [
        write("docs/a.md", "named", "docs/a.md"),
        write("docs/b.md", "named", "docs/b.md"),
      ]),
    ),
  });
  // One re-ask: the unparsable first reply's tokens count with the second's.
  await run("admitted-reasked", "update-documentation", {
    maxRetries: 1,
    port: replies(
      { text: "not json at all", inputTokens: 3, outputTokens: 2 },
      {
        text: reply("update", [write("docs/a.md", "named", "docs/a.md")]),
        inputTokens: 5,
        outputTokens: 7,
      },
    ),
  });
  await run("admitted-proposed-new", "create-documentation", {
    allowWrite: true,
    instruction: "Create docs/new.md to document the new --profile flag.",
    port: port(reply("create", [write("docs/new.md", "proposed-new", "docs/new.md")])),
  });
  await run("admitted-mixed", "update-documentation", {
    instruction: "Update docs/a.md and the Beta page for the new --profile flag.",
    port: port(
      reply("update", [
        write("docs/a.md", "named", "docs/a.md"),
        write("docs/b.md", "inventory", "the Beta page"),
      ]),
    ),
  });
  await run("admitted-none", "review-documentation", {
    instruction: "Review the documentation for the new --profile flag.",
    port: port(reply("review", [])),
  });
  // The run's declared update wins over a reading as a review.
  await run("advisory", "update-documentation", {
    port: port(reply("review", [write("docs/a.md", "named", "docs/a.md")])),
  });
  // A create that names no page is the host's question, which stops the run.
  await run("question", "create-documentation", {
    allowWrite: true,
    instruction: "Create a page for the new --profile flag.",
    port: port(reply("create", [])),
  });
  await run("refused", "review-documentation", {
    instruction: "Update .git/config to add the docs remote.",
    port: port(reply("update", [write(".git/config", "named", ".git/config")])),
  });
  await run("rejected", "review-documentation", { port: port("not json at all") });
  await run("unavailable", "review-documentation", {
    port: port(new RequestIntentModelUnavailableError()),
  });
  process.env.PI_OFFLINE = "1";
  await run("offline", "review-documentation", {});
  delete process.env.PI_OFFLINE;
  await run("not-applicable", "readiness", { instruction: undefined });

  // A continuation is recorded by the same step, before any model call.
  const continuation = await runRequestInterpretation({
    request: { workflow: "update-documentation", instruction: INSTRUCTION } as never,
    loadedContinuation: true,
    workflow: undefined as never,
    workspace: undefined as never,
    config: config(stateDirectory),
    documentationRoots: undefined,
    documentationRootPolicy: undefined as never,
  });
  const admittedRecord = fixtures.get("admitted-inventory")!.record;
  add(
    await saveCopy(stateDirectory, "continuation", {
      ...admittedRecord,
      requestIntent: continuation.recorded,
    }),
  );

  // A companion target needs a navigation set, which no shipped run reads
  // yet, so this one intent is admitted by the interpretation directly and
  // saved on a copy of a real record under its own instruction.
  const companionInstruction = "Create docs/new.md and list it in docs/index.md.";
  const companion = await interpretRequest({
    port: port(
      reply("create", [
        write("docs/new.md", "proposed-new", "docs/new.md"),
        {
          path: "docs/index.md",
          role: "companion-nav",
          chosenFrom: "named",
          quote: "docs/index.md",
        },
      ]),
    ),
    workflow: "create-documentation",
    operation: "create",
    instruction: companionInstruction,
    promptInventory: { entries: [], clippedTitles: 0 },
    admissionInventory: ["docs/index.md"],
    documentationRoots: [{ kind: "root", path: "docs" }],
    writeRoots: [{ kind: "root", path: "docs" }],
    navigationSet: ["docs/index.md"],
    existence: async () => [],
    limits: resolveRequestIntentLimits(),
    maxRetries: 0,
    window: {
      maxInputTokens: validModelConfig.profile!.maxInputTokens,
      maxOutputTokens: validModelConfig.profile!.maxOutputTokens,
    },
    deadlineMs: limit("requestIntent.interpretationTimeoutMs").value,
  });
  add(
    await saveCopy(stateDirectory, "admitted-companion", {
      ...admittedRecord,
      instruction: companionInstruction,
      requestIntent: requestInterpretationStep(companion, 0).recorded,
    }),
  );

  // The contradiction stop keeps the admitted intent the run interpreted.
  const contradiction = await persistFirstPassContradictionStop({
    request: {
      workflow: "update-documentation",
      instruction: INSTRUCTION,
      requestIntent: admittedRecord.requestIntent,
    } as never,
    config: config(stateDirectory),
    workspace: {
      sourcePath: "/fixture/repository",
      requestedRevision: "HEAD",
      revision: "e".repeat(40),
    } as never,
    contradictions: [
      {
        obligationId: "target-01",
        targetPaths: ["docs/a.md"],
        condition: "Document the listening port.",
        sides: [
          { path: "deploy.yaml", lineStart: 1, lineEnd: 4, value: "9090" },
          { path: "src/server.ts", lineStart: 2, lineEnd: 2, value: "8088" },
        ],
      },
    ],
  });
  add({
    name: "contradiction",
    path: join(stateDirectory, `${contradiction.id}.json`),
    record: JSON.parse(
      await readFile(join(stateDirectory, `${contradiction.id}.json`), "utf8"),
    ) as Record<string, unknown>,
  });

  // A record written before the field existed.
  const preFeature = structuredClone(admittedRecord);
  delete preFeature.requestIntent;
  add(await saveCopy(stateDirectory, "pre-feature", preFeature));

  // Tampered on disk after the run saved them.
  const editedOperation = structuredClone(admittedRecord) as {
    requestIntent: { intent: Record<string, unknown> };
  };
  editedOperation.requestIntent.intent.operation = "create";
  add(await saveCopy(stateDirectory, "tampered-operation", editedOperation));
  const nullIntent = structuredClone(admittedRecord) as { requestIntent: { intent: unknown } };
  nullIntent.requestIntent.intent = null;
  add(await saveCopy(stateDirectory, "tampered-null-intent", nullIntent));
  const forgedOutcome = structuredClone(fixtures.get("refused")!.record) as {
    requestIntent: { admission: { outcome: string } };
  };
  forgedOutcome.requestIntent.admission.outcome = "admitted";
  add(await saveCopy(stateDirectory, "tampered-outcome", forgedOutcome));
  const nullField = structuredClone(admittedRecord);
  nullField.requestIntent = null;
  add(await saveCopy(stateDirectory, "tampered-null-field", nullField));

  return { stateDirectory, fixtures };
}

/** The outcome each producer wrote, read from the saved record itself. */
const RECORDED_OUTCOMES: Readonly<Record<string, string>> = {
  "admitted-inventory": "admitted",
  "admitted-named": "admitted",
  "admitted-named-pair": "admitted",
  "admitted-reasked": "admitted",
  "admitted-proposed-new": "admitted",
  "admitted-mixed": "admitted",
  "admitted-companion": "admitted",
  "admitted-none": "admitted",
  advisory: "advisory",
  question: "question",
  refused: "refused",
  rejected: "rejected",
  unavailable: "unavailable",
  offline: "offline",
  "not-applicable": "not-applicable",
  continuation: "continuation",
  contradiction: "admitted",
};

/** `[intentAdmission, intentOperation, intentTargetSource]` per fixture. */
const EXPECTED: Readonly<Record<string, readonly [string | null, string | null, string | null]>> = {
  "admitted-inventory": ["admitted", "update", "inventory"],
  "admitted-named": ["admitted", "update", "named"],
  "admitted-named-pair": ["admitted", "update", "named"],
  "admitted-reasked": ["admitted", "update", "named"],
  "admitted-proposed-new": ["admitted", "create", "proposed-new"],
  "admitted-mixed": ["admitted", "update", "mixed"],
  "admitted-companion": ["admitted", "create", "proposed-new"],
  "admitted-none": ["admitted", "review", "none"],
  advisory: ["advisory", null, null],
  question: ["question", null, null],
  refused: ["refused", null, null],
  rejected: ["rejected", null, null],
  unavailable: ["model-unavailable", null, null],
  offline: ["offline", null, null],
  "not-applicable": ["not-applicable", null, null],
  continuation: ["continuation", null, null],
  contradiction: ["admitted", "update", "inventory"],
  "pre-feature": [null, null, null],
  "tampered-operation": ["unverified", null, null],
  "tampered-null-intent": ["unverified", null, null],
  "tampered-outcome": ["unverified", null, null],
  "tampered-null-field": ["unverified", null, null],
};

function project(fixture: Fixture, bytes: string): readonly RunIndexRowV1[] {
  const projection = projectRunIndexRows(JSON.parse(bytes), {
    origin: "import",
    snapshotId: `snapshot-${fixture.name}`,
    indexedAt: "2026-10-07T00:00:00.000Z",
    recordSha256: sha256Hex(bytes),
    fieldMaxChars: limit(RUN_INDEX_LIMITS.fieldMaxChars).value,
  });
  if (!projection.ok) throw new Error(`${fixture.name}: ${projection.reason}`);
  return projection.rows;
}

const intentColumns = (row: RunIndexRowV1) =>
  [row.intentAdmission, row.intentOperation, row.intentTargetSource] as const;

describe("request intent in the run index (row 9-index)", () => {
  let root: string;
  let built: Awaited<ReturnType<typeof buildFixtures>>;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "docsfab-intent-index-"));
    built = await buildFixtures(root);
  }, testTimeoutMs(FIXTURE_LOCAL_MS));

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("produced every recorded outcome through its shipped producer", () => {
    for (const [name, outcome] of Object.entries(RECORDED_OUTCOMES)) {
      const record = built.fixtures.get(name)!.record as unknown as RunRecord;
      expect(record.requestIntent?.admission, name).toMatchObject({ outcome });
    }
    // Every outcome the record can carry is in the matrix at least once.
    expect(new Set(Object.values(RECORDED_OUTCOMES))).toEqual(
      new Set(REQUEST_INTENT_ADMISSION_OUTCOMES),
    );
    expect(built.fixtures.get("advisory")!.record).toMatchObject({
      requestIntent: {
        admission: { code: "request-intent-operation-mismatch" },
        intent: { operation: "review", targets: [{ chosenFrom: "named" }] },
      },
    });
    expect(built.fixtures.get("question")!.record).toMatchObject({
      status: "needs-input",
      requestIntent: { admission: { code: "request-intent-target-missing" } },
    });
    expect(built.fixtures.get("contradiction")!.record).toMatchObject({
      status: "needs-input",
      firstPassContradiction: { question: expect.any(Object) },
    });
    expect(built.fixtures.get("pre-feature")!.record).not.toHaveProperty("requestIntent");
    // The pair names two write pages, both from the request.
    expect(built.fixtures.get("admitted-named-pair")!.record).toMatchObject({
      requestIntent: {
        intent: {
          targets: [
            { path: "docs/a.md", role: "write", chosenFrom: "named" },
            { path: "docs/b.md", role: "write", chosenFrom: "named" },
          ],
        },
      },
    });
  });

  it("projects each record's interpretation onto its run row only", async () => {
    for (const [name, expected] of Object.entries(EXPECTED)) {
      const fixture = built.fixtures.get(name)!;
      const rows = project(fixture, await readFile(fixture.path, "utf8"));
      const [run, ...others] = rows;
      expect(run!.rowKind).toBe("run");
      expect(intentColumns(run!), name).toEqual(expected);
      for (const row of others)
        expect(intentColumns(row), `${name} ${row.rowKind}`).toEqual([null, null, null]);
      // A stored row reads back the same, and only closed values survive.
      expect(intentColumns(decodeRunIndexRow(JSON.parse(JSON.stringify(run)))!)).toEqual(expected);
    }
  });

  it("records interpretation tokens on the field only, never in the run's usage (residue 7b)", () => {
    // The question stop ran no step, so its usage is the steps' sum: zero.
    const record = built.fixtures.get("question")!.record as unknown as RunRecord;
    const calls = record.requestIntent!.admission.calls;
    expect(calls.map((call) => [call.inputTokens, call.outputTokens])).toEqual([[3, 2]]);
    expect(record.usage).toMatchObject({ input: 0, output: 0, total: 0 });
    expect(formatRequestIntentLines(record)).toContain(
      "Model tokens: 3 input, 2 output (not in the run's usage)",
    );
    // A re-asked reading sums every call's tokens, and the run's usage holds none.
    const reasked = built.fixtures.get("admitted-reasked")!.record as unknown as RunRecord;
    const reaskedCalls = reasked.requestIntent!.admission.calls;
    expect(reaskedCalls.map((call) => [call.inputTokens, call.outputTokens])).toEqual([
      [3, 2],
      [5, 7],
    ]);
    expect(reasked.usage).toMatchObject({ input: 0, output: 0, total: 0 });
    expect(formatRequestIntentLines(reasked)).toEqual(
      expect.arrayContaining([
        "Model calls: 2",
        "Model tokens: 8 input, 9 output (not in the run's usage)",
      ]),
    );
  });

  it("keeps the model-unavailable outcome apart from a record without the field", async () => {
    const unavailable = built.fixtures.get("unavailable")!;
    const preFeature = built.fixtures.get("pre-feature")!;
    const [unavailableRow] = project(unavailable, await readFile(unavailable.path, "utf8"));
    const [preFeatureRow] = project(preFeature, await readFile(preFeature.path, "utf8"));
    expect(unavailableRow!.intentAdmission).toBe("model-unavailable");
    expect(preFeatureRow!.intentAdmission).toBeNull();
    expect(RUN_INDEX_INTENT_ADMISSIONS).not.toContain("unavailable");
  });

  it("propagates an error that is not a contract fault (adjacent to unverified)", () => {
    const record = structuredClone(built.fixtures.get("admitted-inventory")!.record);
    const defect = new TypeError("reader defect");
    // Every key the decoder expects is present, so it reaches the throwing read.
    record.requestIntent = Object.defineProperty({ admission: {}, intent: null }, "schemaVersion", {
      enumerable: true,
      get() {
        throw defect;
      },
    });
    expect(() =>
      projectRunIndexRows(record, {
        origin: "import",
        snapshotId: "snapshot-defect",
        indexedAt: "2026-10-07T00:00:00.000Z",
        recordSha256: "f".repeat(64),
        fieldMaxChars: limit(RUN_INDEX_LIMITS.fieldMaxChars).value,
      }),
    ).toThrow(defect);
  });

  it(
    "refuses a run whose model binding is retired with its own code and no record (residue 7c)",
    async () => {
      const stateDirectory = join(root, "binding-state");
      delete process.env.PI_OFFLINE;
      modelPort.shipped = true;
      const retired = await execute(root, stateDirectory, "retired", "review-documentation", {
        model: {
          ...validModelConfig,
          providerId: "nvidia-api-catalog",
          baseUrl: "https://integrate.api.nvidia.com/v1",
          modelId: "nvidia/llama-3.3-nemotron-super-49b-v1.5",
        },
      }).finally(() => {
        modelPort.shipped = false;
      });
      expect(retired.error).toBeInstanceOf(ModelCompositionError);
      expect(retired.error).toMatchObject({ code: "composition-retired" });
      expect(retired.saved).toEqual([]);
      // Adjacent: a provider that fails once bound is the model-unavailable stop.
      expect(built.fixtures.get("unavailable")!.record).toMatchObject({
        requestIntent: { admission: { code: "request-intent-model-unavailable" } },
      });
    },
    testTimeoutMs(FIXTURE_LOCAL_MS),
  );

  it("decodes a row stored before revision 15 with every intent field null", () => {
    expect(RUN_INDEX_PROJECTION_REVISION).toBe(19);
    const fixture = built.fixtures.get("admitted-inventory")!;
    const bytes = JSON.stringify(fixture.record);
    const [run] = project(fixture, bytes);
    const older: Record<string, unknown> = { ...run, projectionRevision: 14 };
    delete older.intentAdmission;
    delete older.intentOperation;
    delete older.intentTargetSource;
    expect(intentColumns(decodeRunIndexRow(older)!)).toEqual([null, null, null]);
    // An open value in a stored row is not a reading.
    expect(
      intentColumns(
        decodeRunIndexRow({
          ...run,
          intentAdmission: "unavailable",
          intentOperation: "rewrite",
          intentTargetSource: "guessed",
        })!,
      ),
    ).toEqual([null, null, null]);
    // Only a run row carries the reading; a step row that claims it reads null.
    const [, step] = project(fixture, bytes);
    expect(step!.rowKind).not.toBe("run");
    expect(
      intentColumns(
        decodeRunIndexRow({
          ...step,
          intentAdmission: "admitted",
          intentOperation: "update",
          intentTargetSource: "inventory",
        })!,
      ),
    ).toEqual([null, null, null]);
    // The same closed values on the run row are kept (positive control).
    expect(intentColumns(decodeRunIndexRow({ ...run })!)).toEqual([
      "admitted",
      "update",
      "inventory",
    ]);
  });

  async function runsCli(args: readonly string[]): Promise<Record<string, unknown>> {
    const out: string[] = [];
    const log = vi.spyOn(console, "log").mockImplementation((message?: unknown) => {
      out.push(String(message ?? ""));
    });
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      await handleRunsCommand([...args]);
    } finally {
      log.mockRestore();
      error.mockRestore();
    }
    return JSON.parse(out.join("\n")) as Record<string, unknown>;
  }

  it("groups imported runs by intentAdmission and the admitted reading (Acceptance)", async () => {
    const indexDirectory = join(root, "acceptance-index");
    const imported = await runsCli([
      "import",
      built.stateDirectory,
      "--index-dir",
      indexDirectory,
      "--json",
    ]);
    process.exitCode = undefined;
    // One tampered or pre-feature record never keeps another out of the index.
    expect((imported.imported as unknown[]).length).toBe(built.fixtures.size);
    expect(imported.refused).toEqual([]);

    const byAdmission = await runsCli([
      "query",
      "--index-dir",
      indexDirectory,
      "--where",
      "rowKind=run",
      "--group-by",
      "intentAdmission",
      "--json",
    ]);
    const counts = new Map<unknown, number>();
    for (const expected of Object.values(EXPECTED)) {
      counts.set(expected[0], (counts.get(expected[0]) ?? 0) + 1);
    }
    const groups = byAdmission.groups as { key: { intentAdmission: unknown }; runs: number }[];
    expect(new Map(groups.map((group) => [group.key.intentAdmission, group.runs]))).toEqual(counts);
    expect(counts.get("admitted")).toBe(9);
    expect(counts.get("unverified")).toBe(4);
    expect(counts.get("model-unavailable")).toBe(1);
    expect(counts.get(null)).toBe(1);

    const byReading = await runsCli([
      "query",
      "--index-dir",
      indexDirectory,
      "--where",
      "rowKind=run",
      "--where",
      "intentAdmission=admitted",
      "--group-by",
      "intentAdmission,intentOperation,intentTargetSource",
      "--json",
    ]);
    const readings = (
      byReading.groups as {
        key: Record<string, unknown>;
        runs: number;
      }[]
    ).map((group) => [group.key.intentOperation, group.key.intentTargetSource, group.runs]);
    expect(readings).toEqual(
      expect.arrayContaining([
        ["update", "inventory", 2],
        ["update", "named", 3],
        ["create", "proposed-new", 2],
        ["update", "mixed", 1],
        ["review", "none", 1],
      ]),
    );
    expect(readings).toHaveLength(5);

    // `unavailable` still selects only the runs without the field.
    const absent = await runsCli([
      "query",
      "--index-dir",
      indexDirectory,
      "--where",
      "rowKind=run",
      "--where",
      "intentAdmission=unavailable",
      "--group-by",
      "runId",
      "--json",
    ]);
    expect((absent.groups as { key: { runId: string } }[]).map((group) => group.key.runId)).toEqual(
      [built.fixtures.get("pre-feature")!.record.id],
    );
  });

  it("shows the same readings in runs show INTENT for the indexed records", async () => {
    const intent = async (name: string) => {
      const out: string[] = [];
      const log = vi.spyOn(console, "log").mockImplementation((message?: unknown) => {
        out.push(String(message ?? ""));
      });
      try {
        await handleRunsCommand([
          "show",
          String(built.fixtures.get(name)!.record.id),
          "--state-dir",
          built.stateDirectory,
        ]);
      } finally {
        log.mockRestore();
      }
      const lines = out
        .join("\n")
        .split("\n")
        .map((line) => line.trim());
      const start = lines.indexOf("INTENT");
      const end = lines.findIndex((line, index) => index > start && line === "");
      return start < 0 ? [] : lines.slice(start + 1, end < 0 ? undefined : end);
    };
    const admitted = await intent("admitted-inventory");
    expect(admitted[0]).toBe("Admission: admitted");
    expect(admitted).toContain("Operation: update");
    expect(admitted).toContain("Target: docs/a.md · write · inventory");
    expect((await intent("unavailable"))[0]).toBe(
      "Admission: unavailable (request-intent-model-unavailable)",
    );
    expect((await intent("tampered-operation"))[0]).toMatch(/^Admission: unverified \(/u);
    expect(await intent("pre-feature")).toEqual([]);
    const reasked = await intent("admitted-reasked");
    expect(reasked).toContain("Model calls: 2");
    expect(reasked).toContain("Model tokens: 8 input, 9 output (not in the run's usage)");
  });

  it("re-projects a revision-14 snapshot of the fixture on import", async () => {
    const indexDirectory = join(root, "reproject-index");
    const fixture = built.fixtures.get("admitted-inventory")!;
    const bytes = await readFile(fixture.path, "utf8");
    const rows = project(fixture, bytes).map((row) => {
      const older: Record<string, unknown> = { ...row, projectionRevision: 14 };
      delete older.intentAdmission;
      delete older.intentOperation;
      delete older.intentTargetSource;
      return older;
    });
    await mkdir(indexDirectory, { recursive: true });
    await writeFile(
      join(indexDirectory, "runs.jsonl"),
      `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`,
      { mode: 0o600 },
    );
    const imported = await runsCli([
      "import",
      fixture.path,
      "--index-dir",
      indexDirectory,
      "--json",
    ]);
    process.exitCode = undefined;
    expect(imported.unchanged).toEqual([]);
    expect((imported.imported as { runId: string }[]).map((entry) => entry.runId)).toEqual([
      fixture.record.id,
    ]);
    const query = await runsCli([
      "query",
      "--index-dir",
      indexDirectory,
      "--where",
      "rowKind=run",
      "--group-by",
      "intentAdmission,intentOperation,intentTargetSource",
      "--json",
    ]);
    expect(query.groups).toEqual([
      {
        key: {
          intentAdmission: "admitted",
          intentOperation: "update",
          intentTargetSource: "inventory",
        },
        rows: 1,
        runs: 1,
        share: 1,
      },
    ]);
  });
});

describe("prompt inventory limits at the shipped call site (row 11, residue 7a)", {
  timeout: testTimeoutMs(FIXTURE_LOCAL_MS),
}, () => {
  const ENTRIES = "DOCSFAB_REQUEST_INTENT_MAX_PROMPT_INVENTORY_ENTRIES";
  const PAGE_BYTES = "DOCSFAB_AUTHORING_PLANNED_PAGE_MAX_BYTES";
  let root: string;
  let stateDirectory: string;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "docsfab-intent-limits-"));
    stateDirectory = join(root, "state", "runs");
    await mkdir(stateDirectory, { recursive: true });
  });

  afterEach(() => {
    delete process.env[ENTRIES];
    delete process.env[PAGE_BYTES];
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  /** A review of docs/a.md over `files`, with the prompt the port was sent. */
  async function review(name: string, files: Readonly<Record<string, string>> = {}) {
    const prompts: string[] = [];
    const reading = port(reply("review", [write("docs/a.md", "named", "docs/a.md")]));
    const result = await execute(root, stateDirectory, name, "review-documentation", {
      instruction: "Review docs/a.md for the new --profile flag.",
      files,
      port: {
        call: (request) => {
          prompts.push(request.prompt);
          return reading.call(request);
        },
      },
    });
    const records = await Promise.all(
      result.saved.map(
        async (id) =>
          JSON.parse(await readFile(join(stateDirectory, `${id}.json`), "utf8")) as RunRecord,
      ),
    );
    return { ...result, prompts, records };
  }

  const pages = Object.keys(FIXTURE_FILES).filter(
    (path) => path.startsWith("docs/") && path.endsWith(".md"),
  );

  it("lists every page at requestIntent.maxPromptInventoryEntries and refuses one over it", async () => {
    process.env[ENTRIES] = String(pages.length);
    expect(limit("requestIntent.maxPromptInventoryEntries").value).toBe(pages.length);
    const at = await review("entries-at");
    expect(at.records[0]!.requestIntent!.admission.outcome).toBe("admitted");
    process.env[ENTRIES] = String(pages.length - 1);
    const over = await review("entries-over");
    expect(over.prompts).toEqual([]);
    expect(over.saved).toEqual([]);
    expect(over.error).toMatchObject({
      code: "request-intent-max-prompt-inventory-entries-bound",
      limitName: "requestIntent.maxPromptInventoryEntries",
      observed: pages.length,
    });
  });

  it("reads a page at authoring.plannedPageMaxBytes and refuses one byte over it", async () => {
    const largest = Math.max(
      ...pages.map((path) => Buffer.byteLength(FIXTURE_FILES[path]!, "utf8")),
    );
    process.env[PAGE_BYTES] = String(largest);
    expect(limit("authoring.plannedPageMaxBytes").value).toBe(largest);
    const at = await review("bytes-at");
    expect(at.records[0]!.requestIntent!.admission.outcome).toBe("admitted");
    process.env[PAGE_BYTES] = String(largest - 1);
    const over = await review("bytes-over");
    expect(over.prompts).toEqual([]);
    expect(over.error).toMatchObject({
      code: "authoring-planned-page-max-bytes-bound",
      limitName: "authoring.plannedPageMaxBytes",
      observed: largest,
    });
  });

  it("keeps a title at requestIntent.maxInventoryTitleChars and clips one over it", async () => {
    const bound = limit("requestIntent.maxInventoryTitleChars").value;
    const run = await review("titles", {
      "docs/at.md": `# ${"t".repeat(bound)}\n`,
      "docs/over.md": `# ${"u".repeat(bound + 1)}\n`,
    });
    const admission = run.records[0]!.requestIntent!.admission;
    expect(admission.outcome).toBe("admitted");
    expect(admission.clippedTitles).toBe(1);
    expect(run.prompts[0]).toContain(
      JSON.stringify({ path: "docs/at.md", title: "t".repeat(bound), navLabel: null }),
    );
    expect(run.prompts[0]).not.toContain("u".repeat(bound + 1));
  });

  it("lists a path at requestIntent.maxInventoryPathChars and refuses one over it", async () => {
    const bound = limit("requestIntent.maxInventoryPathChars").value;
    // Directory segments stay under every file system's name limit.
    const pathOf = (length: number) => {
      const inner = length - "docs/".length - ".md".length;
      const body = Array.from({ length: inner }, (_, index) =>
        index % 101 === 100 ? "/" : "p",
      ).join("");
      return `docs/${body}.md`;
    };
    const atPath = pathOf(bound);
    expect(atPath.length).toBe(bound);
    const at = await review("path-at", { [atPath]: "# At\n" });
    expect(at.records[0]!.requestIntent!.admission.outcome).toBe("admitted");
    expect(at.prompts[0]).toContain(JSON.stringify(atPath));
    const overPath = pathOf(bound + 1);
    expect(overPath.length).toBe(bound + 1);
    const over = await review("path-over", { [overPath]: "# Over\n" });
    expect(over.prompts).toEqual([]);
    expect(over.error).toMatchObject({
      code: "request-intent-max-inventory-path-chars-bound",
      limitName: "requestIntent.maxInventoryPathChars",
      observed: bound + 1,
    });
  });
});
