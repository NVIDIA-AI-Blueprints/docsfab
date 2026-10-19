// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * A continued InputAsk run binds exactly the stopped run's `--source` files
 * and `--change` commits on every continuation route, or refuses by code
 * before it reads anything.
 *
 * Every stop and every continuation runs through a shipped entry point:
 * `executeRunRequest` for the original run, `handleDoCommand` for `do
 * --attach`, an implicit reply and `do --continue`, and the live-agent reply
 * planner with `continueLiveAgentEditorialInputAsk` over the shipped
 * `runBoundedWorkflow`. The model is the real Pi harness over a scripted
 * provider. Assertions read the run records the store wrote and the source
 * inventory the planner's own `docsfab_list_sources` call returned.
 */
import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it, vi } from "vitest";

import { handleDoCommand, parseDoArguments, type DoRunArguments } from "../src/cli/commands/do.js";
import { parseRunArguments } from "../src/cli/run-arguments.js";
import { executeRunRequest } from "../src/cli/run-request.js";
import { PiHarness } from "../src/harness/pi.js";
import type { CommandRunner } from "../src/init/types.js";
import { CHANGE_SOURCE_KINDS, GIT_EMPTY_TREE_IDS } from "../src/inputs/change-source.js";
import {
  continuationEvidenceRequest,
  listOpenEditorialRuns,
  OPERATOR_INPUT_FILL_ERROR_CODES,
  OperatorInputFillError,
} from "../src/inputs/operator-input-fill.js";
import {
  assembleLiveAgentHost,
  continueLiveAgentEditorialInputAsk,
  runBoundedWorkflow,
} from "../src/live-agent/host.js";
import { DOCUMENTATION_WORK_REFUSAL } from "../src/live-agent/documentation-work-state.js";
import { createLiveAgentSourceSelection } from "../src/live-agent/source-commands.js";
import { planLiveAgentEditorialInputAskTurn } from "../src/live-agent/workflow-delivery.js";
import { createModelConnection } from "../src/model/provider.js";
import { operatorCodeFailureClass } from "../src/operator/failure-classification.js";
import type { RunChangeSourceV1 } from "../src/records/change-sources.js";
import type { RunRecord } from "../src/records/contracts.js";
import {
  decodeRetainedEvidenceBindings,
  RetainedEvidenceBindingsError,
} from "../src/records/retained-evidence-bindings.js";
import { validModelConfig } from "./helpers.js";
import { testTimeoutMs } from "./helpers/test-timeouts.js";
import { installedLiveAgentCapabilities } from "./support/live-agent-installed-capabilities.js";
import { git, orbitOptionChangeRepository } from "./helpers/orbit-option-change-fixture.js";
import {
  boundStyleContext,
  qualityDirectory,
  skillCrateDirectory,
  textTurn,
  toolTurn,
} from "./support/pi-harness-session-fixtures.js";

const execFile = promisify(execFileCallback);
const INSTRUCTION = "Assess whether docs/cli.md needs an update for the changed option source.";
const REPLY = "Admit the product requirements: the public option is --new.";
const SOURCE = "src/orbit.ts";
/** Sorts after `SOURCE`, so a check of only the first pin misses it. */
const SECOND_SOURCE = "src/release-notes.txt";
const SHA1_ID_LENGTH = GIT_EMPTY_TREE_IDS.sha1.length;
const DIGEST_A = createHash("sha256").update("a").digest("hex");
const DIGEST_B = createHash("sha256").update("b").digest("hex");
/** Each case runs real git fixtures and the real Pi harness through whole runs. */
const JOURNEY_TIMEOUT_MS = testTimeoutMs(240_000);
const MR_HOST = "gitlab.example.test";
const MR_PROJECT_PATH = "team/docs-project";
const MR_PROJECT_ID = 4242;
const MR_IID = 813;
const MR_URL = `https://${MR_HOST}/${MR_PROJECT_PATH}/-/merge_requests/${MR_IID}`;

const temporaryDirectories: string[] = [];

afterEach(async () => {
  vi.unstubAllGlobals();
  process.exitCode = undefined;
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

/** The planner's reply: keep both pages unchanged, which the admitted evidence cannot support. */
function plannerReply(): string {
  return JSON.stringify({
    summary: "The kept pages need no change.",
    planBinding: {
      mode: "update",
      pages: [
        { path: "docs/absent.md", disposition: "retain" },
        { path: "docs/cli.md", disposition: "retain" },
      ],
      sourceBindings: [],
    },
    editorialDecisionProposal: {
      candidate: "no-change",
      rationale: "The Orbit CLI page already documents the option, so no kept page needs an edit.",
      slotIds: ["current-documentation", "request"],
    },
  });
}

/**
 * The scripted provider. Each request takes the next queued reply, or the
 * planner's reply when none is queued, and every request body is kept.
 */
class ScriptedModel {
  public readonly bodies: string[] = [];
  private readonly queue: Response[] = [];

  public readonly fetch = (async (_url: unknown, init?: { body?: unknown }) => {
    this.bodies.push(typeof init?.body === "string" ? init.body : "");
    return this.queue.shift() ?? textTurn(plannerReply());
  }) as unknown as typeof globalThis.fetch;

  /** The planner lists its sources first, so the inventory it read can be checked. */
  public listSourcesFirst(callId: string): void {
    this.queue.push(toolTurn([{ id: callId, name: "docsfab_list_sources", arguments: {} }]));
  }

  /** Repository paths in the inventory the planner's `callId` call returned. */
  public listedPaths(callId: string): string[] {
    for (const body of this.bodies) {
      const { messages } = JSON.parse(body) as {
        messages: Array<{ role: string; tool_call_id?: string; content: unknown }>;
      };
      const result = messages.find(
        (message) => message.role === "tool" && message.tool_call_id === callId,
      );
      if (!result) continue;
      const text =
        typeof result.content === "string"
          ? result.content
          : (result.content as Array<{ text?: string }>).map((part) => part.text ?? "").join("");
      const inventory = JSON.parse(text) as { sources: Array<{ repositoryPath: string }> };
      return [...new Set(inventory.sources.map((source) => source.repositoryPath))].sort();
    }
    throw new Error(`No provider request carried the result of ${callId}.`);
  }
}

interface Fixture {
  readonly repository: string;
  readonly stateDirectory: string;
  readonly config: Awaited<ReturnType<typeof orbitOptionChangeRepository>>["config"];
  readonly model: ScriptedModel;
  readonly harness: PiHarness;
  readonly captured: DoRunArguments[];
  readonly runWorkflow: (request: DoRunArguments) => Promise<RunRecord | undefined>;
}

async function fixture(name: string): Promise<Fixture> {
  const orbit = await orbitOptionChangeRepository(`docsfab-binding-${name}`, temporaryDirectories);
  const repository = await realpath(orbit.repository);
  const model = new ScriptedModel();
  vi.stubGlobal("fetch", model.fetch);
  const harness = new PiHarness({
    skillCrateDirectory,
    qualityDirectory,
    styleContext: await boundStyleContext(),
    model: validModelConfig,
    createConnection: createModelConnection,
  });
  const captured: DoRunArguments[] = [];
  return {
    repository,
    stateDirectory: orbit.config.stateDirectory,
    config: orbit.config,
    model,
    harness,
    captured,
    runWorkflow: async (request) => {
      captured.push(structuredClone(request));
      return executeRunRequest(request, orbit.config, { silent: true, executionHarness: harness });
    },
  };
}

/** Commit `files` on the fixture's checked-out branch. */
async function commit(
  repository: string,
  files: Record<string, string>,
  message: string,
): Promise<string> {
  for (const [path, text] of Object.entries(files)) {
    await writeFile(join(repository, path), text);
  }
  await git(repository, "add", "--all");
  await git(
    repository,
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "--quiet",
    "-m",
    message,
  );
  return git(repository, "rev-parse", "HEAD");
}

/**
 * The original update stop, through the shipped `run` writer. It is
 * read-only, as a read-only live-agent session's runs are: only an assessment
 * asks for the text slots an implicit reply fills, and `run` has no read-only
 * update, so the parsed `--patch-only` request drops its write grant.
 */
async function originalStop(
  f: Fixture,
  extra: readonly string[],
  runOptions: { readonly changeRequestCommands?: CommandRunner } = {},
): Promise<Record<string, unknown>> {
  const record = await executeRunRequest(
    {
      ...parseRunArguments([
        "update-documentation",
        "--repo",
        f.repository,
        "--instruction",
        INSTRUCTION,
        "--patch-only",
        ...extra,
      ]),
      allowWrite: false,
    },
    f.config,
    {
      silent: true,
      executionHarness: f.harness,
      ...(runOptions.changeRequestCommands
        ? { changeRequestCommands: runOptions.changeRequestCommands, changeRequestEnvironment: {} }
        : {}),
    },
  );
  if (!record) throw new Error("the original run saved no record");
  const saved = await persisted(f, record.id);
  expect(saved.status).toBe("needs-input");
  expect((await listOpenEditorialRuns(f.stateDirectory)).map((run) => run.runId)).toContain(
    record.id,
  );
  return saved;
}

async function persisted(f: Fixture, runId: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(join(f.stateDirectory, `${runId}.json`), "utf8")) as Record<
    string,
    unknown
  >;
}

/** Every supersession claim on disk, as `{ originalRunId, supersededBy }`. */
async function claims(f: Fixture): Promise<Array<{ originalRunId: string; supersededBy: string }>> {
  const directory = join(f.stateDirectory, "input-ask-supersession");
  let names: string[];
  try {
    names = (await readdir(directory)).filter((name) => name.endsWith(".json"));
  } catch {
    return [];
  }
  return Promise.all(
    names.map(async (name) => {
      const value = JSON.parse(await readFile(join(directory, name), "utf8")) as {
        originalRunId: string;
        supersededBy: string;
      };
      return { originalRunId: value.originalRunId, supersededBy: value.supersededBy };
    }),
  );
}

/** The continuation id the stopped run's supersession claim names. */
async function continuationOf(f: Fixture, originalRunId: string): Promise<string> {
  const claim = (await claims(f)).find((item) => item.originalRunId === originalRunId);
  if (!claim) throw new Error(`No supersession claim names ${originalRunId}.`);
  return claim.supersededBy;
}

async function blobSha256(repository: string, path: string): Promise<string> {
  const { stdout } = await execFile("git", ["show", `HEAD:${path}`], {
    cwd: repository,
    encoding: "buffer",
  });
  return createHash("sha256").update(stdout).digest("hex");
}

type Route = "attach" | "reply" | "continue" | "live-agent";
const ROUTES: readonly Route[] = ["attach", "reply", "continue", "live-agent"];

/** Continue the one open run through `route`; `extra` adds options to a `do` route. */
async function continueBy(
  f: Fixture,
  route: Route,
  runId: string,
  options: {
    readonly extra?: readonly string[];
    readonly selection?: ReturnType<typeof createLiveAgentSourceSelection>;
  } = {},
): Promise<void> {
  const extra = options.extra ?? [];
  const doOptions = { stateDirectory: f.stateDirectory, runWorkflow: f.runWorkflow };
  if (route === "attach") {
    await handleDoCommand(
      ["--repo", f.repository, "--attach", "docs/cli.md", "--patch-only", "--quiet", ...extra],
      doOptions,
    );
  } else if (route === "reply") {
    await handleDoCommand(
      [REPLY, "--repo", f.repository, "--patch-only", "--quiet", ...extra],
      doOptions,
    );
  } else if (route === "continue") {
    await handleDoCommand(
      [REPLY, "--repo", f.repository, "--continue", runId, "--patch-only", "--quiet", ...extra],
      doOptions,
    );
  } else {
    const turn = await planLiveAgentEditorialInputAskTurn({
      stateDirectory: f.stateDirectory,
      repositoryPath: f.repository,
      revision: "HEAD",
      replyText: REPLY,
    });
    if (turn.kind !== "input-ask-resume") throw new Error(`live-agent turn was ${turn.kind}`);
    expect(turn.plan.originalRunId).toBe(runId);
    await continueLiveAgentEditorialInputAsk(turn.plan, {
      repositoryPath: f.repository,
      allowWrite: false,
      config: f.config,
      persist: async () => ({ status: "not-needed" }),
      runWorkflow: (request) => runBoundedWorkflow({ ...request, executionHarness: f.harness }),
      selection: options.selection ?? createLiveAgentSourceSelection(),
    });
  }
}

/** The refusal `attempt` raised before the claim: nothing called, saved, claimed or hidden. */
async function refusedWithRunOpen(
  f: Fixture,
  runId: string,
  attempt: () => Promise<unknown>,
): Promise<OperatorInputFillError> {
  const calls = f.model.bodies.length;
  const files = (await readdir(f.stateDirectory)).filter((name) => name.endsWith(".json"));
  const error = await attempt().then(
    () => undefined,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(OperatorInputFillError);
  expect(f.model.bodies.length, "a refused continuation calls no model").toBe(calls);
  expect(
    (await readdir(f.stateDirectory)).filter((name) => name.endsWith(".json")),
    "a refused continuation saves no record",
  ).toEqual(files);
  expect(await claims(f), "a refused continuation leaves no claim").toEqual([]);
  expect((await listOpenEditorialRuns(f.stateDirectory)).map((run) => run.runId)).toEqual([runId]);
  return error as OperatorInputFillError;
}

/** The fields that fix which commits a change names; never its labels or sealing digest. */
function changePins(entry: Record<string, unknown>): Record<string, unknown> {
  const {
    labels: _labels,
    changeSourceSha256: _digest,
    observations: _observations,
    ...pins
  } = entry;
  return pins;
}

/** The one-file binding a `--source` original must carry, so no comparison passes on absence. */
async function expectSourceBound(f: Fixture, record: Record<string, unknown>): Promise<void> {
  expect(record.retainedEvidenceBindings).toEqual({
    schemaVersion: 1,
    kind: "docsfab-retained-evidence-bindings",
    sources: [{ path: SOURCE, sha256: await blobSha256(f.repository, SOURCE) }],
  });
}

function onlyChange(record: Record<string, unknown>): Record<string, unknown> {
  const entries = record.changeSources as Array<Record<string, unknown>>;
  expect(entries).toHaveLength(1);
  return entries[0]!;
}

describe("a continuation binds the stopped run's --source files", () => {
  it.each(ROUTES)(
    "%s binds the same file and digest, as the planner's own inventory lists",
    async (route) => {
      const f = await fixture(`source-${route}`);
      const original = await originalStop(f, ["--source", SOURCE]);
      // The original record holds the binding, with the digest of the bytes at HEAD.
      await expectSourceBound(f, original);
      const before = f.model.bodies.length;
      f.model.listSourcesFirst(`list-${route}`);
      await continueBy(f, route, original.id as string);
      expect(f.model.bodies.length, "the continuation called the model").toBeGreaterThan(before);
      const continuationId = await continuationOf(f, original.id as string);
      const continued = await persisted(f, continuationId);
      expect(continued.id).toBe(continuationId);
      expect(continued.retainedEvidenceBindings).toEqual(original.retainedEvidenceBindings);
      expect(f.model.listedPaths(`list-${route}`)).toEqual([SOURCE]);
    },
    JOURNEY_TIMEOUT_MS,
  );

  it(
    "carries the binding down a chain: the second continuation's record still names the file",
    async () => {
      const f = await fixture("source-chain");
      const original = await originalStop(f, ["--source", SOURCE]);
      await expectSourceBound(f, original);
      await continueBy(f, "live-agent", original.id as string);
      const first = await continuationOf(f, original.id as string);
      expect((await persisted(f, first)).status).toBe("needs-input");
      await continueBy(f, "live-agent", first);
      const second = await continuationOf(f, first);
      const record = await persisted(f, second);
      expect(record.id).toBe(second);
      expect(record.retainedEvidenceBindings).toEqual(original.retainedEvidenceBindings);
    },
    JOURNEY_TIMEOUT_MS,
  );

  it(
    "admits a continuation after another file changed, since the bound file did not",
    async () => {
      const f = await fixture("source-unrelated");
      const original = await originalStop(f, ["--source", SOURCE]);
      await expectSourceBound(f, original);
      await commit(f.repository, { "docs/other.md": "# Other\n" }, "unrelated");
      await continueBy(f, "continue", original.id as string);
      const continued = await persisted(f, await continuationOf(f, original.id as string));
      expect(continued.retainedEvidenceBindings).toEqual(original.retainedEvidenceBindings);
    },
    JOURNEY_TIMEOUT_MS,
  );
});

describe("a continuation binds the stopped run's --change commits", () => {
  it.each(ROUTES)(
    "%s binds the same commits and the same sealed change",
    async (route) => {
      const f = await fixture(`change-${route}`);
      const original = await originalStop(f, ["--change", "HEAD~1..HEAD"]);
      const pinned = onlyChange(original);
      expect(pinned).toMatchObject({ sourceKind: "local-range", rangeSemantics: "two-dot" });
      expect(original).not.toHaveProperty("retainedEvidenceBindings");
      const before = f.model.bodies.length;
      f.model.listSourcesFirst(`list-${route}`);
      await continueBy(f, route, original.id as string);
      expect(f.model.bodies.length).toBeGreaterThan(before);
      const continued = await persisted(f, await continuationOf(f, original.id as string));
      const entry = onlyChange(continued);
      // Nothing in the workspace changed, so even the sealing digest is equal.
      expect({ ...entry, observations: undefined }).toEqual({ ...pinned, observations: undefined });
      expect(continued).not.toHaveProperty("retainedEvidenceBindings");
      const listed = f.model.listedPaths(`list-${route}`);
      expect(listed.length).toBeGreaterThan(0);
      expect(listed.every((path) => path.includes(pinned.head as string))).toBe(true);
    },
    JOURNEY_TIMEOUT_MS,
  );

  it(
    "binds the original commits after an unrelated commit moves HEAD",
    async () => {
      const f = await fixture("change-head-moved");
      const original = await originalStop(f, ["--change", "HEAD~1..HEAD"]);
      const pinned = onlyChange(original);
      const moved = await commit(f.repository, { "docs/other.md": "# Other\n" }, "unrelated");
      expect(moved).not.toBe(pinned.head);
      await continueBy(f, "continue", original.id as string);
      const continued = await persisted(f, await continuationOf(f, original.id as string));
      expect(changePins(onlyChange(continued))).toEqual(changePins(pinned));
    },
    JOURNEY_TIMEOUT_MS,
  );

  it(
    "binds the original commits after a branch switch labels the head off the workspace",
    async () => {
      const f = await fixture("change-branch-switch");
      const original = await originalStop(f, ["--change", "HEAD~1..HEAD"]);
      const pinned = onlyChange(original);
      await git(f.repository, "checkout", "--quiet", "-b", "other", "HEAD~1");
      await continueBy(f, "continue", original.id as string);
      const continued = await persisted(f, await continuationOf(f, original.id as string));
      const entry = onlyChange(continued);
      expect(entry.labels).toContain("head-not-ancestor-of-workspace");
      expect(entry.changeSourceSha256).not.toBe(pinned.changeSourceSha256);
      expect(changePins(entry)).toEqual(changePins(pinned));
    },
    JOURNEY_TIMEOUT_MS,
  );

  it(
    "binds the original commits beside a carried comparison, at the comparison's head",
    async () => {
      const f = await fixture("change-comparison");
      const root = await git(f.repository, "rev-list", "--max-parents=0", "HEAD");
      const head = await git(f.repository, "rev-parse", "HEAD");
      const original = await originalStop(f, [
        "--change",
        "HEAD~1..HEAD",
        "--comparison-base",
        root,
        "--revision",
        head,
      ]);
      const pinned = onlyChange(original);
      expect(original.readerEvidenceRequest).toBeDefined();
      await commit(f.repository, { "docs/other.md": "# Other\n" }, "unrelated");
      await continueBy(f, "continue", original.id as string);
      const continued = await persisted(f, await continuationOf(f, original.id as string));
      expect(changePins(onlyChange(continued))).toEqual(changePins(pinned));
      expect(continued.readerEvidenceRequest).toEqual(original.readerEvidenceRequest);
      expect((continued.repository as { revision: string }).revision).toBe(head);
    },
    JOURNEY_TIMEOUT_MS,
  );

  it(
    "binds a root commit's change, whose base is null",
    async () => {
      const f = await fixture("change-root");
      const root = await git(f.repository, "rev-list", "--max-parents=0", "HEAD");
      expect(root).toHaveLength(SHA1_ID_LENGTH);
      const original = await originalStop(f, ["--change", root]);
      const pinned = onlyChange(original);
      expect(pinned).toMatchObject({
        rangeSemantics: "first-parent-commit",
        base: null,
        head: root,
      });
      await continueBy(f, "continue", original.id as string);
      const continued = await persisted(f, await continuationOf(f, original.id as string));
      expect(changePins(onlyChange(continued))).toEqual(changePins(pinned));
    },
    JOURNEY_TIMEOUT_MS,
  );
});

/**
 * The pin check runs in the shared assembly, after the supersession claim:
 * the claim is released, no record exists for the continuation, the stop is
 * still the one open run, and no model was called.
 */
async function refusedAfterClaim(
  f: Fixture,
  runId: string,
  attempt: () => Promise<unknown>,
): Promise<OperatorInputFillError> {
  const records = async () =>
    (await readdir(f.stateDirectory)).filter((name) => name.endsWith(".json")).sort();
  const calls = f.model.bodies.length;
  const before = await records();
  const error = await attempt().then(
    () => undefined,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(OperatorInputFillError);
  expect(f.model.bodies.length, "a refused continuation calls no model").toBe(calls);
  expect(await records(), "a refused continuation saves no record").toEqual(before);
  expect(await claims(f), "the claim is released").toEqual([]);
  expect((await listOpenEditorialRuns(f.stateDirectory)).map((run) => run.runId)).toEqual([runId]);
  return error as OperatorInputFillError;
}

describe("a continuation whose bound file moved refuses before anything is saved", () => {
  it(
    "refuses continue-binding-moved when the bound file changed at the continued revision",
    async () => {
      const f = await fixture("moved-one");
      const original = await originalStop(f, ["--source", SOURCE]);
      await commit(f.repository, { [SOURCE]: "export const option = '--newer';\n" }, "edit");
      const error = await refusedAfterClaim(f, original.id as string, () =>
        continueBy(f, "continue", original.id as string),
      );
      expect(error.code).toBe("continue-binding-moved");
      expect(error.message).toContain(SOURCE);
    },
    JOURNEY_TIMEOUT_MS,
  );

  it(
    "refuses when only the second of two bound files changed",
    async () => {
      const f = await fixture("moved-second");
      await commit(f.repository, { [SECOND_SOURCE]: "Notes.\n" }, "notes");
      const original = await originalStop(f, ["--source", SOURCE, "--source", SECOND_SOURCE]);
      const bound = (original.retainedEvidenceBindings as { sources: Array<{ path: string }> })
        .sources;
      expect(bound.map((source) => source.path)).toEqual([SOURCE, SECOND_SOURCE]);
      await commit(f.repository, { [SECOND_SOURCE]: "Changed notes.\n" }, "edit notes");
      const error = await refusedAfterClaim(f, original.id as string, () =>
        continueBy(f, "live-agent", original.id as string),
      );
      expect(error.code).toBe("continue-binding-moved");
      expect(error.message).toContain(`bound ${SECOND_SOURCE} with --source`);
    },
    JOURNEY_TIMEOUT_MS,
  );
});

describe("malformed retained local-range pins refuse before a continuation claim", () => {
  it.each(["attach", "reply", "continue"] as const)(
    "%s reports retained-evidence-bindings-malformed and leaves the stopped run open",
    async (route) => {
      const f = await fixture(`malformed-local-range-${route}`);
      const original = await originalStop(f, ["--change", "HEAD~1..HEAD"]);
      const record = await persisted(f, original.id as string);
      const changeSources = record.changeSources as Array<Record<string, unknown>>;
      expect(changeSources).toHaveLength(1);
      changeSources[0] = { ...changeSources[0]!, base: null };
      await writeFile(
        join(f.stateDirectory, `${original.id as string}.json`),
        `${JSON.stringify(record, null, 2)}\n`,
      );

      const error = await refusedWithRunOpen(f, original.id as string, () =>
        continueBy(f, route, original.id as string),
      );
      expect(error.code).toBe("retained-evidence-bindings-malformed");
      expect(error.message).toContain("base");
    },
    JOURNEY_TIMEOUT_MS,
  );
});

describe("a continuation that names its own evidence refuses", () => {
  it.each([
    ["--attach with --source", ["--attach", "docs/cli.md", "--source", SOURCE]],
    ["--continue with --source", ["--continue", "run-1", "--source", SOURCE]],
    ["--attach with --pr", ["--attach", "docs/cli.md", "--pr", "!7"]],
    ["--continue with --mr", ["--continue", "run-1", "--mr", "!7"]],
  ] as const)("do %s refuses continue-binding-conflict while parsing", (_label, args) => {
    let error: unknown;
    try {
      parseDoArguments(["--repo", "/tmp/example-repo", ...args]);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(OperatorInputFillError);
    expect((error as OperatorInputFillError).code).toBe("continue-binding-conflict");
  });

  it("parses --source on a do command that continues nothing", () => {
    expect(
      parseDoArguments(["Update docs/cli.md", "--repo", "/tmp/example-repo", "--source", SOURCE])
        .sourcePaths,
    ).toEqual([SOURCE]);
    expect(
      parseDoArguments(["--repo", "/tmp/example-repo", "--attach", "docs/cli.md"]).attachPaths,
    ).toEqual(["docs/cli.md"]);
  });

  it(
    "refuses an implicit reply that names --source while a run is open",
    async () => {
      const f = await fixture("conflict-reply");
      const original = await originalStop(f, ["--source", SOURCE]);
      const error = await refusedWithRunOpen(f, original.id as string, () =>
        continueBy(f, "reply", original.id as string, { extra: ["--source", SOURCE] }),
      );
      expect(error.code).toBe("continue-binding-conflict");
    },
    JOURNEY_TIMEOUT_MS,
  );

  it(
    "runs a fresh do --source when no run is open, instead of refusing",
    async () => {
      const f = await fixture("fresh-source");
      await handleDoCommand(
        [
          "Update docs/cli.md for the changed option source.",
          "--repo",
          f.repository,
          "--source",
          SOURCE,
          "--patch-only",
          "--quiet",
        ],
        { stateDirectory: f.stateDirectory, runWorkflow: f.runWorkflow },
      );
      expect(f.captured).toHaveLength(1);
      expect(f.captured[0]!.sourcePaths).toEqual([SOURCE]);
      expect(f.captured[0]!.operatorInputResume).toBeUndefined();
    },
    JOURNEY_TIMEOUT_MS,
  );

  it(
    "refuses a live-agent answer whose conversation attached other files",
    async () => {
      const f = await fixture("conflict-live");
      const original = await originalStop(f, ["--source", SOURCE]);
      const error = await refusedWithRunOpen(f, original.id as string, () =>
        continueBy(f, "live-agent", original.id as string, {
          selection: createLiveAgentSourceSelection({ sourcePaths: ["docs/cli.md"] }),
        }),
      );
      expect(error.code).toBe("continue-binding-conflict");
    },
    JOURNEY_TIMEOUT_MS,
  );

  it(
    "refuses a live-agent answer whose conversation adds a merge request to the same file",
    async () => {
      const f = await fixture("conflict-live-mr");
      const original = await originalStop(f, ["--source", SOURCE]);
      const changeRequestSelector = parseDoArguments([
        "Update the docs",
        "--repo",
        "/tmp/example-repo",
        "--pr",
        "!7",
      ]).changeRequestSelector!;
      const error = await refusedWithRunOpen(f, original.id as string, () =>
        continueBy(f, "live-agent", original.id as string, {
          selection: createLiveAgentSourceSelection({
            sourcePaths: [SOURCE],
            changeRequestSelector,
          }),
        }),
      );
      expect(error.code).toBe("continue-binding-conflict");
    },
    JOURNEY_TIMEOUT_MS,
  );

  it(
    "admits a live-agent answer whose conversation attached the same file",
    async () => {
      const f = await fixture("same-live");
      const original = await originalStop(f, ["--source", SOURCE]);
      await expectSourceBound(f, original);
      await continueBy(f, "live-agent", original.id as string, {
        selection: createLiveAgentSourceSelection({ sourcePaths: [SOURCE] }),
      });
      const continued = await persisted(f, await continuationOf(f, original.id as string));
      expect(continued.retainedEvidenceBindings).toEqual(original.retainedEvidenceBindings);
    },
    JOURNEY_TIMEOUT_MS,
  );
});

/**
 * A merged merge request in the fixture's checkout: a two-commit feature
 * merged with a merge commit, answered by a recorded `glab` stand-in. The
 * continuation never reads it, so any second read fails the test.
 */
async function mergedMergeRequest(f: Fixture): Promise<CommandRunner> {
  const base = await git(f.repository, "rev-parse", "HEAD");
  await git(f.repository, "checkout", "--quiet", "-b", "feature/export-path");
  await commit(f.repository, { "src/export.txt": "Exports go to the current directory.\n" }, "a");
  const head = await commit(f.repository, { "src/export.txt": "Exports need a path.\n" }, "b");
  await git(f.repository, "checkout", "--quiet", "main");
  await git(
    f.repository,
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "merge",
    "--quiet",
    "--no-ff",
    "-m",
    "Merge branch 'feature/export-path'",
    "feature/export-path",
  );
  const merge = await git(f.repository, "rev-parse", "HEAD");
  const ids: Record<string, string> = { base, start: base, head, merge };
  const recorded = JSON.parse(
    await readFile(
      join(import.meta.dirname, "fixtures", "change-source-gitlab", "merge-request-get.json"),
      "utf8",
    ),
    (_key, value: unknown) =>
      typeof value === "string" && value.startsWith("@") ? ids[value.slice(1)] : value,
  ) as Record<string, unknown>;
  return {
    async run(_command, args) {
      const endpoint = String(args.at(-1));
      const body = endpoint.includes("/merge_requests/")
        ? recorded
        : { id: MR_PROJECT_ID, path_with_namespace: MR_PROJECT_PATH };
      return { stdout: JSON.stringify(body), stderr: "", exitCode: 0 };
    },
  };
}

describe("the assembled live-agent host carries attached sources into continuation", () => {
  async function assembledContinuation(f: Fixture, sourcePaths: readonly string[]) {
    const host = await assembleLiveAgentHost({
      repositoryPath: f.repository,
      allowWrite: false,
      environment: { PATH: process.env.PATH },
      config: f.config,
      capabilities: await installedLiveAgentCapabilities(["update-documentation"]),
      sourcePaths,
      sourcePorts: {} as never,
      onNotice: () => undefined,
      writeError: () => undefined,
    });
    // Terminal chat requires a named answer; keep this source-binding probe
    // on the continuation path without treating ordinary prose as InputAsk.
    const planned = await host.terminalOptions.planEditorialInputAskTurn?.(`prd: ${REPLY}`);
    if (planned?.kind !== "input-ask-resume") {
      throw new Error(`assembled host planned ${planned?.kind ?? "no turn"}`);
    }
    const continuation = host.terminalOptions.continueEditorialInputAsk;
    if (!continuation) throw new Error("assembled host omitted its continuation callback");
    return { continued: await continuation(planned.plan), host };
  }

  it(
    "refuses conflicting attached sources before claims, records, or model calls",
    async () => {
      const f = await fixture("assembled-host-conflict");
      const original = await originalStop(f, ["--source", SOURCE]);
      const calls = f.model.bodies.length;
      const records = await readdir(f.stateDirectory);

      const error = await assembledContinuation(f, ["docs/cli.md"]).then(
        () => undefined,
        (caught: unknown) => caught,
      );

      expect(error).toBeInstanceOf(OperatorInputFillError);
      expect((error as OperatorInputFillError).code).toBe("continue-binding-conflict");
      expect(f.model.bodies.length, "a refused continuation calls no model").toBe(calls);
      expect(await readdir(f.stateDirectory), "a refused continuation saves no record").toEqual(
        records,
      );
      expect(await claims(f), "a conflicting host selection creates no claim").toEqual([]);
      expect((await listOpenEditorialRuns(f.stateDirectory)).map((run) => run.runId)).toEqual([
        original.id,
      ]);
    },
    JOURNEY_TIMEOUT_MS,
  );

  it(
    "admits the matching attached source through the assembled callback",
    async () => {
      const f = await fixture("assembled-host-match");
      const original = await originalStop(f, ["--source", SOURCE]);
      const calls = f.model.bodies.length;
      const { continued, host } = await assembledContinuation(f, [SOURCE]);
      if (!continued) throw new Error("The assembled continuation returned no run.");
      const continuationId = await continuationOf(f, original.id as string);

      expect(continued.id).toBe(continuationId);
      expect((await persisted(f, continuationId)).retainedEvidenceBindings).toEqual(
        original.retainedEvidenceBindings,
      );
      expect(f.model.bodies.length, "the matching source uses the scripted model").toBeGreaterThan(
        calls,
      );

      host.terminalOptions.onUserTurn?.("Inspect the latest saved result.");
      const read = host.customTools.find((tool) => tool.name === "docsfab_read_run");
      if (!read) throw new Error("The assembled host omitted its saved-run reader.");
      await expect(
        read.execute("continued-run", { runId: continued.id }, undefined, undefined, {} as never),
      ).resolves.toMatchObject({ details: { runId: continued.id } });
      expect(() =>
        read.execute(
          "unrelated-run",
          { runId: "unrelated-run" },
          undefined,
          undefined,
          {} as never,
        ),
      ).toThrow(DOCUMENTATION_WORK_REFUSAL);
    },
    JOURNEY_TIMEOUT_MS,
  );
});

describe("a continuation of a forge-bound run refuses instead of dropping the binding", () => {
  it(
    "pins --pr on the original record, and every route refuses continue-binding-forge-unsupported",
    async () => {
      const f = await fixture("forge-pr");
      const commands = await mergedMergeRequest(f);
      const original = await originalStop(f, ["--pr", MR_URL], { changeRequestCommands: commands });
      // The writer proof the forge carry reads: the canonical selector, the
      // project id the forge proved, and the digest of the text bound.
      expect(original.retainedEvidenceBindings).toEqual({
        schemaVersion: 1,
        kind: "docsfab-retained-evidence-bindings",
        changeRequest: {
          selector: {
            schemaVersion: 1,
            kind: "docsfab-change-request-selector",
            provider: "gitlab",
            host: MR_HOST,
            projectPath: MR_PROJECT_PATH,
            number: MR_IID,
          },
          projectId: MR_PROJECT_ID,
          textSha256: expect.any(String),
        },
      });
      expect(onlyChange(original).sourceKind).toBe("gitlab-merge-request");
      // The strict decoder holds the text digest to its 64-hex shape.
      expect(
        decodeRetainedEvidenceBindings(original.retainedEvidenceBindings, "update-documentation"),
      ).toEqual(original.retainedEvidenceBindings);
      for (const route of ROUTES) {
        const error = await refusedWithRunOpen(f, original.id as string, () =>
          continueBy(f, route, original.id as string),
        );
        expect(error.code, route).toBe("continue-binding-forge-unsupported");
      }
    },
    JOURNEY_TIMEOUT_MS,
  );

  it(
    "refuses every forge change kind a record can name, and carries only a local range",
    async () => {
      const f = await fixture("forge-kinds");
      const original = await originalStop(f, ["--change", "HEAD~1..HEAD"]);
      const path = join(f.stateDirectory, `${original.id as string}.json`);
      for (const kind of CHANGE_SOURCE_KINDS.filter((item) => item !== "local-range")) {
        const entry = { ...onlyChange(original), sourceKind: kind };
        await writeFile(
          path,
          `${JSON.stringify({ ...original, changeSources: [entry] }, null, 2)}\n`,
        );
        for (const route of ROUTES) {
          const error = await refusedWithRunOpen(f, original.id as string, () =>
            continueBy(f, route, original.id as string),
          );
          expect(error.code, `${kind} by ${route}`).toBe(
            kind === "release-range"
              ? "continue-release-unsupported"
              : "continue-binding-forge-unsupported",
          );
        }
      }
      await writeFile(path, `${JSON.stringify(original, null, 2)}\n`);
      await continueBy(f, "continue", original.id as string);
      const continued = await persisted(f, await continuationOf(f, original.id as string));
      expect(changePins(onlyChange(continued))).toEqual(changePins(onlyChange(original)));
    },
    JOURNEY_TIMEOUT_MS,
  );
});

describe("release-bound editorial runs refuse unsupported continuation", () => {
  it(
    "refuses every route for a valid index-only release page and keeps the original open",
    async () => {
      const f = await fixture("release-index-only");
      await commit(
        f.repository,
        {
          "src/release-a.ts": "export const a = 1;\n",
          "src/release-b.ts": "export const b = 2;\n",
        },
        "two release paths",
      );
      vi.stubEnv("DOCSFAB_CHANGE_SOURCES_CHANGED_FILES_MAX", "1");
      let original: Record<string, unknown>;
      try {
        original = await originalStop(f, ["--change", "release:HEAD~1..HEAD"]);
      } finally {
        vi.unstubAllEnvs();
      }
      expect(original.changeSources).toBeUndefined();
      expect(original.changeSourceRelease).toMatchObject({
        units: 1,
        pageUnits: 1,
        omittedUnits: 1,
      });
      for (const route of ROUTES) {
        const error = await refusedWithRunOpen(f, original.id as string, () =>
          continueBy(f, route, original.id as string),
        );
        expect(error.code, route).toBe("continue-release-unsupported");
      }
    },
    JOURNEY_TIMEOUT_MS,
  );

  it.each([
    [
      "malformed release citation",
      (record: Record<string, unknown>) => ({
        ...record,
        changeSourceRelease: { schemaVersion: 1 },
      }),
    ],
    [
      "release entry without its citation",
      (record: Record<string, unknown>) => ({
        ...record,
        changeSources: [
          {
            ...onlyChange(record),
            sourceKind: "release-range",
          },
        ],
      }),
    ],
  ] as const)(
    "refuses every route for %s before claim or model call",
    async (_label, corrupt) => {
      const f = await fixture(`malformed-release-${_label.replaceAll(" ", "-")}`);
      const original = await originalStop(f, ["--change", "HEAD~1..HEAD"]);
      await writeFile(
        join(f.stateDirectory, `${original.id as string}.json`),
        `${JSON.stringify(corrupt(original), null, 2)}\n`,
      );
      for (const route of ROUTES) {
        const error = await refusedWithRunOpen(f, original.id as string, () =>
          continueBy(f, route, original.id as string),
        );
        expect(error.code, `${_label} by ${route}`).toBe("continue-release-unsupported");
      }
    },
    JOURNEY_TIMEOUT_MS,
  );
});

describe("a run with no bound evidence retains its legacy continuation shape", () => {
  it(
    "keeps legacy continuation keys with patch-only authority and CLI retry metadata",
    async () => {
      const f = await fixture("golden");
      const original = await originalStop(f, []);
      await continueBy(f, "continue", original.id as string);
      const continued = await persisted(f, await continuationOf(f, original.id as string));
      const golden = JSON.parse(
        await readFile(
          join(
            import.meta.dirname,
            "fixtures/continuation-evidence-bindings/no-binding-golden.json",
          ),
          "utf8",
        ),
      ) as Record<string, string[]>;
      const capturedRequest = f.captured[0]!;
      expect(Object.hasOwn(capturedRequest, "patchOnly")).toBe(true);
      expect(capturedRequest.patchOnly).toBe(true);
      expect({
        requestKeys: Object.keys(capturedRequest)
          .filter((key) => key !== "patchOnly")
          .sort(),
        planKeys: Object.keys(capturedRequest.operatorInputResume!).sort(),
        originalRecordKeys: Object.keys(original).sort(),
        continuedRecordKeys: Object.keys(continued).sort(),
      }).toEqual(golden);
    },
    JOURNEY_TIMEOUT_MS,
  );

  it(
    "continues a --source record saved before the field existed without inventing a binding",
    async () => {
      const f = await fixture("pre-field");
      const original = await originalStop(f, ["--source", SOURCE]);
      await expectSourceBound(f, original);
      const { retainedEvidenceBindings: _field, ...preField } = original;
      await writeFile(
        join(f.stateDirectory, `${original.id as string}.json`),
        `${JSON.stringify(preField, null, 2)}\n`,
      );
      await continueBy(f, "continue", original.id as string);
      expect(f.captured.at(-1)!.sourcePaths).toBeUndefined();
      const continued = await persisted(f, await continuationOf(f, original.id as string));
      expect(continued).not.toHaveProperty("retainedEvidenceBindings");
    },
    JOURNEY_TIMEOUT_MS,
  );

  it.each([
    [
      "a malformed digest",
      (value: Record<string, unknown>) => ({
        ...value,
        sources: [{ path: SOURCE, sha256: "not-a-digest" }],
      }),
    ],
    ["an extra key", (value: Record<string, unknown>) => ({ ...value, extra: true })],
  ] as const)(
    "refuses retained-evidence-bindings-malformed for %s, and keeps the run listed",
    async (label, corrupt) => {
      const f = await fixture(`malformed-${label.replaceAll(" ", "-")}`);
      const original = await originalStop(f, ["--source", SOURCE]);
      const retained = original.retainedEvidenceBindings as Record<string, unknown>;
      await writeFile(
        join(f.stateDirectory, `${original.id as string}.json`),
        `${JSON.stringify({ ...original, retainedEvidenceBindings: corrupt(retained) }, null, 2)}\n`,
      );
      const error = await refusedWithRunOpen(f, original.id as string, () =>
        continueBy(f, "continue", original.id as string),
      );
      expect(error.code).toBe("retained-evidence-bindings-malformed");
    },
    JOURNEY_TIMEOUT_MS,
  );
});

describe("the retained evidence decoder", () => {
  const valid = {
    schemaVersion: 1,
    kind: "docsfab-retained-evidence-bindings",
    sources: [{ path: SOURCE, sha256: DIGEST_A }],
  };
  /** The `--pr` pin the writer keeps, with `selector` fields overridden. */
  const pr = (selector: Record<string, unknown> = {}) => ({
    selector: {
      schemaVersion: 1,
      kind: "docsfab-change-request-selector",
      provider: "gitlab",
      host: MR_HOST,
      projectPath: MR_PROJECT_PATH,
      number: MR_IID,
      ...selector,
    },
    projectId: MR_PROJECT_ID,
    textSha256: DIGEST_B,
  });

  it("admits what the writer writes, only on the source-aware workflows", () => {
    expect(decodeRetainedEvidenceBindings(valid, "update-documentation")).toEqual(valid);
    const withPr = { ...valid, changeRequest: pr() };
    expect(decodeRetainedEvidenceBindings(withPr, "create-documentation")).toEqual(withPr);
    expect(() => decodeRetainedEvidenceBindings(valid, "review-documentation")).toThrow(
      RetainedEvidenceBindingsError,
    );
  });

  it.each([
    ["no binding at all", { schemaVersion: 1, kind: "docsfab-retained-evidence-bindings" }],
    ["an empty source list", { ...valid, sources: [] }],
    ["a path outside the grammar", { ...valid, sources: [{ path: "../x", sha256: DIGEST_A }] }],
    ["a duplicate path", { ...valid, sources: [valid.sources[0], valid.sources[0]] }],
    [
      "an unsorted path list",
      {
        ...valid,
        sources: [
          { path: SECOND_SOURCE, sha256: DIGEST_B },
          { path: SOURCE, sha256: DIGEST_A },
        ],
      },
    ],
    ["another kind", { ...valid, kind: "docsfab-other" }],
    [
      "a merge request whose project was never resolved",
      { ...valid, changeRequest: pr({ host: null, projectPath: null }) },
    ],
    ["a merge request with no project id", { ...valid, changeRequest: { ...pr(), projectId: 0 } }],
    ["a merge request with an extra key", { ...valid, changeRequest: { ...pr(), extra: true } }],
  ])("refuses %s", (_label, value) => {
    expect(() => decodeRetainedEvidenceBindings(value, "update-documentation")).toThrow(
      RetainedEvidenceBindingsError,
    );
  });
});

describe("the commits a continuation names for a local range", () => {
  // SHA-256 object ids, so the rebuilt selector holds the longer id form too.
  const id = (digit: string) => digit.repeat(GIT_EMPTY_TREE_IDS.sha256.length);
  const entry = (pins: { rangeSemantics: string; base: string | null; head: string }) =>
    ({ ...pins }) as unknown as RunChangeSourceV1;

  it.each([
    ["a two-dot range", "two-dot", id("a"), "two-dot", id("a")],
    ["a three-dot range", "three-dot", id("a"), "three-dot", id("a")],
    ["one commit", "first-parent-commit", id("a"), "single-commit", null],
    ["a root commit", "first-parent-commit", null, "single-commit", null],
  ] as const)("names %s by its full ids", (_label, rangeSemantics, base, form, selectorBase) => {
    const request = continuationEvidenceRequest({
      changeSources: [entry({ rangeSemantics, base, head: id("b") })] as never,
    });
    expect(request.changeSource).toMatchObject({
      source: "local-range",
      form,
      base: selectorBase,
      head: id("b"),
    });
    expect(request).not.toHaveProperty("sourcePaths");
  });

  it("refuses a two-dot range whose saved base is null instead of guessing one", () => {
    let error: unknown;
    try {
      continuationEvidenceRequest({
        changeSources: [entry({ rangeSemantics: "two-dot", base: null, head: id("b") })] as never,
      });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(OperatorInputFillError);
    expect((error as OperatorInputFillError).code).toBe("retained-evidence-bindings-malformed");
  });

  it("names nothing for a run that bound nothing", () => {
    expect(continuationEvidenceRequest({})).toEqual({});
  });
});

describe("every continuation refusal code is catalogued", () => {
  it("classes each code the continuation can raise", () => {
    const expected: Record<(typeof OPERATOR_INPUT_FILL_ERROR_CODES)[number], string> = {
      "retained-reader-input-malformed": "contract-shape",
      "continue-planner-input-unsupported": "operator-input",
      "continue-revision-mismatch": "operator-input",
      "retained-evidence-bindings-malformed": "contract-shape",
      "continue-binding-forge-unsupported": "operator-input",
      "continue-release-unsupported": "operator-input",
      "continue-binding-conflict": "operator-input",
      "continue-binding-moved": "operator-input",
    };
    for (const code of OPERATOR_INPUT_FILL_ERROR_CODES) {
      expect(operatorCodeFailureClass(code), code).toBe(expected[code]);
    }
  });
});
