// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * First pass reads the admitted intent's sources and constraints: at the
 * shipped entry (`executeRunRequest` with an injected interpreter port), and
 * at `bindFirstPassKnowledge` for the tracked-snapshot and embedder rows.
 * Intent sources bind beside `--source` selections and are checked against
 * the tracked set on the gathering arm only. One that does not bind is a
 * coded notice, never a stop (#2112), and none of its bytes reaches the
 * model; constraints seed obligations the runtime support decoder accepts.
 */
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { beforeEach, describe, expect, it, vi } from "vitest";

const capture = vi.hoisted(() => ({ invocations: [] as unknown[] }));
const bridgeHolder = vi.hoisted(() => ({ bridge: undefined as unknown }));
const STOP_AT_EXECUTION = "test sentinel: the run reached workflow execution";

vi.mock("../src/cli/first-pass-support.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/cli/first-pass-support.js")>();
  return {
    ...actual,
    createFirstPassSupportModelBridge: (
      ...args: Parameters<typeof actual.createFirstPassSupportModelBridge>
    ) =>
      (bridgeHolder.bridge as ReturnType<typeof actual.createFirstPassSupportModelBridge>) ??
      actual.createFirstPassSupportModelBridge(...args),
  };
});

vi.mock("../src/cli/run/execution.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/cli/run/execution.js")>();
  return {
    ...actual,
    executeWorkflowRun: async (..._args: Parameters<typeof actual.executeWorkflowRun>) => {
      capture.invocations.push(_args[0]);
      throw new Error(STOP_AT_EXECUTION);
    },
  };
});

import {
  bindFirstPassKnowledge,
  FIRST_PASS_KNOWLEDGE_SNAPSHOT_PATH,
  constraintConditionLimitError,
  FirstPassConstraintLimitError,
} from "../src/cli/first-pass.js";
import {
  firstPassAssessmentBindingSha256,
  type FirstPassSupportModelBridge,
  type FirstPassSupportModelRequest,
} from "../src/cli/first-pass-support.js";
import { executeRunRequest } from "../src/cli/run-request.js";
import type { CliRunInvocation, RunRequestWithPublishProjection } from "../src/cli/run/request.js";
import { CliSourceAcquisitionError } from "../src/cli/run/source-acquisition.js";
import { formatLimitRefusal, limit, OperationalLimitError } from "../src/config/limits.js";
import type { DocsFabConfig } from "../src/config/runtime-loader.js";
import type { TrackedSourceReaderV1 } from "../src/inputs/source-acquisition.js";
import type { RunRecord } from "../src/records/contracts.js";
import { toOperatorErrorEnvelope } from "../src/operator/error-envelope.js";
import type { RequestIntentInterpreterPort } from "../src/request-intent/interpret.js";
import { recordedIntent, type IntentSpec } from "./helpers/first-pass-intent.js";
import { initFixtureRepo } from "./helpers/git.js";
import { validModelConfig } from "./helpers.js";
import { parseEvidenceFrames } from "./helpers/knowledge-evidence-frames.js";
import { temporaryRoots } from "./helpers/temp.js";
import { testTimeoutMs } from "./helpers/test-timeouts.js";

const runtimeRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const knowledgeAssess = pathToFileURL(
  resolve(runtimeRoot, "..", "knowledge", "src", "first-pass", "assess.mjs"),
).href;
const roots = temporaryRoots();
/** A journey runs interpretation, first pass and the shipped entry once. */
const JOURNEY_MS = testTimeoutMs(30_000);
const TARGETS = ["docs/a.md", "docs/b.md"] as const;
const REVISION = "e".repeat(40);

beforeEach(() => {
  capture.invocations.length = 0;
  bridgeHolder.bridge = undefined;
});

const sha = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");

function stubConfig(stateDirectory: string): DocsFabConfig {
  return {
    projectRoot: runtimeRoot,
    skillCrateDirectory: join(runtimeRoot, "skill-crate"),
    qualityDirectory: join(runtimeRoot, "quality"),
    qualityPackDirectory: join(runtimeRoot, "quality-pack"),
    stateDirectory,
    retryPolicy: {
      maxRetries: 0,
      baseDelayMs: 0,
      maxDelayMs: 0,
      retryableCategories: [],
    },
    model: validModelConfig,
  };
}

const PROJECT_CONFIG = {
  schemaVersion: 1,
  gitlab: { remote: "origin", defaultBranch: "main" },
  provider: { configuration: "host" },
  storage: { scope: "user-private" },
};

async function fixture(
  files: Readonly<Record<string, string>> = {},
): Promise<{ repositoryPath: string; stateDirectory: string }> {
  const root = await roots.create("docsfab-intent-sources-");
  const repositoryPath = join(root, "repo");
  await initFixtureRepo(repositoryPath, {
    "README.md": "# Widget\n\nWidget reads its configuration from widget.yaml.\n",
    "src/a.ts": "export const alpha = 'alpha source evidence';\n",
    "src/b.ts": "export const beta = 'beta source evidence';\n",
    // Formats the scan never ranks: read only when bound.
    "notes/alpha.textile": "h1. Alpha\n\nAlpha notes.\n",
    "notes/beta.textile": "h1. Beta\n\nBeta notes.\n",
    ".docsfab.json": `${JSON.stringify(PROJECT_CONFIG)}\n`,
    ...files,
  });
  // Run state under its own root: first pass keeps its records beside it.
  const stateDirectory = join(root, "state", "runs");
  await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
  return {
    repositoryPath,
    stateDirectory,
  };
}

function request(
  repositoryPath: string,
  instruction: string,
  sourcePaths?: readonly string[],
): RunRequestWithPublishProjection {
  return {
    workflow: "create-documentation",
    repositoryPath,
    revision: "HEAD",
    instruction,
    allowWrite: true,
    releaseGate: false,
    verbose: false,
    json: false,
    showScan: false,
    patchOnly: true,
    ...(sourcePaths ? { sourcePaths: [...sourcePaths] } : {}),
  } as RunRequestWithPublishProjection;
}

/** An interpreter answering with two new pages and the given sources and constraints. */
function port(
  proposal: {
    sources?: readonly { path: string; quote: string }[];
    constraints?: readonly { kind: string; quote: string }[];
  } = {},
): RequestIntentInterpreterPort {
  return {
    async call() {
      return {
        text: JSON.stringify({
          operation: "create",
          targets: TARGETS.map((path) => ({
            path,
            role: "write",
            chosenFrom: "named",
            quote: path,
          })),
          sources: proposal.sources ?? [],
          preserve: [],
          exclusions: [],
          constraints: proposal.constraints ?? [],
          authorityPreference: { preference: "unspecified", quote: null },
        }),
        usage: { inputTokens: 3, outputTokens: 2 },
      };
    },
  };
}

async function run(
  runRequest: RunRequestWithPublishProjection,
  stateDirectory: string,
  interpreter: RequestIntentInterpreterPort,
): Promise<{ result?: RunRecord; error?: unknown }> {
  const log = console.log;
  const error = console.error;
  console.log = () => undefined;
  console.error = () => undefined;
  try {
    return {
      result: (await executeRunRequest(runRequest, stubConfig(stateDirectory), {
        requestInterpreter: interpreter,
      })) as RunRecord,
    };
  } catch (caught) {
    return { error: caught };
  } finally {
    console.log = log;
    console.error = error;
  }
}

/**
 * Supports every obligation from the first offered span, and counts its calls.
 * `prompts` keeps each prompt whole: everything first pass showed the model.
 */
function countingBridge(): FirstPassSupportModelBridge & {
  readonly calls: string[];
  readonly prompts: string[];
} {
  const calls: string[] = [];
  const prompts: string[] = [];
  let lastIdentitySha256: string | undefined;
  let lastAssessmentBindingSha256: string | undefined;
  return {
    calls,
    prompts,
    call: async (call: FirstPassSupportModelRequest) => {
      calls.push(call.prompt.split("\n", 1)[0]!);
      prompts.push(call.prompt);
      let value: unknown;
      if (call.prompt.startsWith("Phase: obligation-decomposition")) {
        value = { schemaVersion: 1, additionalObligations: [] };
      } else if (call.prompt.startsWith("Phase: obligation-completeness-audit")) {
        value = { schemaVersion: 1, complete: true, omissions: [] };
      } else {
        const line = call.prompt
          .split("\n")
          .find((entry) => entry.startsWith("Mandatory obligations: "))!;
        const obligations = JSON.parse(line.slice("Mandatory obligations: ".length)) as Array<{
          id: string;
          requiredSourceSupport: boolean;
        }>;
        const firstSpan = parseEvidenceFrames(call.prompt)[0]!.id;
        value = {
          schemaVersion: 1,
          assessments: obligations.map((obligation) => ({
            obligationId: obligation.id,
            status: "supported",
            evidenceSpanIds: obligation.requiredSourceSupport ? [firstSpan] : [],
            detail: "Supported by the offered repository span.",
          })),
        };
      }
      const responseText = JSON.stringify(value);
      const identity = {
        providerId: "scripted-provider",
        modelId: "scripted-model",
        profileSha256: sha("profile"),
        compositionSha256: null,
        requestPolicySha256: null,
        systemPromptSha256: sha(call.systemPrompt),
        promptSha256: call.promptSha256,
        procedureSha256: call.procedureSha256,
        responseSha256: sha(responseText),
        turnEvidenceSha256: sha("turn-evidence"),
      };
      lastIdentitySha256 = sha(canonical(identity));
      if (!call.prompt.startsWith("Phase:")) {
        lastAssessmentBindingSha256 = firstPassAssessmentBindingSha256(
          call.prompt,
          responseText,
          parseEvidenceFrames,
        );
      }
      return {
        responseText,
        identity,
        usage: { inputTokens: 20, outputTokens: 10 },
      };
    },
    lastAssessmentIdentitySha256: () => lastIdentitySha256,
    lastAssessmentBindingSha256: () => lastAssessmentBindingSha256,
  };
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const root = value as Record<string, unknown>;
    return `{${Object.keys(root)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(root[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

interface SupportRecord {
  readonly targetPaths: readonly string[];
  readonly terminationReason: string;
  readonly sourceSpans: readonly { readonly path: string }[];
  readonly obligations: readonly {
    readonly id: string;
    readonly origin: string;
    readonly instructionSpan?: { readonly start: number; readonly end: number };
    readonly condition: string;
    readonly requiredSourceSupport: boolean;
    readonly targetPaths: readonly string[];
  }[];
}

/** The support record the run's first pass persisted, read from disk. */
async function persistedSupport(stateDirectory: string): Promise<SupportRecord> {
  const base = join(dirname(stateDirectory), "knowledge", "first-pass");
  const revisions = await readdir(base);
  expect(revisions).toHaveLength(1);
  return JSON.parse(
    await readFile(join(base, revisions[0]!, "docsfab-first-pass-support.json"), "utf8"),
  ) as SupportRecord;
}

function admitted(invocation: unknown): void {
  expect((invocation as CliRunInvocation).request.requestIntent?.admission.outcome).toBe(
    "admitted",
  );
}

const readPaths = (support: SupportRecord) =>
  [...new Set(support.sourceSpans.map((span) => span.path))]
    .filter((path) => path.startsWith("notes/"))
    .sort();

function explicitSeeds(instruction: string, support: SupportRecord) {
  const seeds = support.obligations.filter((item) => item.origin === "explicit");
  for (const seed of seeds) {
    // The runtime decoder's own invariant, on the raw instruction.
    expect(instruction.slice(seed.instructionSpan!.start, seed.instructionSpan!.end)).toBe(
      seed.condition,
    );
  }
  return seeds.map(
    ({ id, origin, instructionSpan, condition, requiredSourceSupport, targetPaths }) => ({
      id,
      origin,
      instructionSpan,
      condition,
      requiredSourceSupport,
      targetPaths,
    }),
  );
}

function spanOf(instruction: string, text: string) {
  const start = instruction.indexOf(text);
  expect(start).toBeGreaterThanOrEqual(0);
  return { start, end: start + text.length };
}

/** The coded notice for a source the reading names that first pass does not bind. */
const readingNotice = (path: string, reason: string, sentence: string) =>
  `first-pass-reading-source-unbound: ${JSON.stringify(path)} (${reason}): the request's reading names it as a source, but ${sentence}`;

const NOT_TRACKED =
  "the selected revision tracks no regular file at that path or under it, so first pass did not read it and went on with the evidence it could bind. To use it as evidence, check the path or commit it, then run again, or pass a tracked file with --source.";

/** The same reason from a reader that lists no tracked files, so cannot see directories. */
const NOT_TRACKED_UNLISTED =
  "it is not a tracked regular file at the selected revision, so first pass did not read it and went on with the evidence it could bind. To use it as evidence, check the path or commit it, then run again, or pass a tracked file with --source.";

/** The notices the run handed to workflow execution, as its record keeps them. */
const notices = (invocation: unknown) => (invocation as CliRunInvocation).firstPassNotices ?? [];

describe("intent sources and constraints, through executeRunRequest", {
  timeout: JOURNEY_MS,
}, () => {
  it("binds intent sources beside --source selections and reads both (row 7a)", async () => {
    const instruction = "Create docs/a.md and docs/b.md from the beta notes.";
    const reading = [{ path: "notes/beta.textile", quote: "the beta notes" }];
    // Positive control first: an unranked format is read only when bound.
    for (const [label, sourcePaths, sources, expected] of [
      ["unbound", undefined, [], []],
      ["distinct", ["notes/alpha.textile"], reading, ["notes/alpha.textile", "notes/beta.textile"]],
      ["intent only", undefined, reading, ["notes/beta.textile"]],
      ["same path", ["notes/beta.textile"], reading, ["notes/beta.textile"]],
    ] as const) {
      const bridge = countingBridge();
      bridgeHolder.bridge = bridge;
      capture.invocations.length = 0;
      const { repositoryPath, stateDirectory } = await fixture();
      const outcome = await run(
        request(repositoryPath, instruction, sourcePaths),
        stateDirectory,
        port({ sources }),
      );
      expect((outcome.error as Error).message, label).toBe(STOP_AT_EXECUTION);
      admitted(capture.invocations[0]);
      expect(bridge.calls.length, label).toBeGreaterThan(0);
      const support = await persistedSupport(stateDirectory);
      expect(support.targetPaths).toEqual(TARGETS);
      expect(readPaths(support), label).toEqual(expected);
    }
  });

  it("goes on past an absent or untracked intent source with one coded notice, and never shows the model its bytes (row 7b)", async () => {
    // Was a path-not-tracked stop before #2112: the reading is model output.
    for (const [label, path, quote] of [
      ["absent", "src/missing.ts", "the missing module"],
      ["untracked", "src/untracked.ts", "the untracked module"],
    ] as const) {
      const bridge = countingBridge();
      bridgeHolder.bridge = bridge;
      capture.invocations.length = 0;
      const { repositoryPath, stateDirectory } = await fixture();
      // On disk, never committed.
      await writeFile(
        join(repositoryPath, "src", "untracked.ts"),
        "export const zebraMarker = 'UNTRACKED-ZEBRA-7B';\n",
      );
      const instruction = `Create docs/a.md and docs/b.md from ${quote} and the beta notes.`;
      // No --source at all: the binding keys on the intent, not on the selections.
      const outcome = await run(
        request(repositoryPath, instruction),
        stateDirectory,
        port({
          sources: [
            { path, quote },
            { path: "notes/beta.textile", quote: "the beta notes" },
          ],
        }),
      );
      expect((outcome.error as Error).message, label).toBe(STOP_AT_EXECUTION);
      admitted(capture.invocations[0]);
      expect(notices(capture.invocations[0]), label).toEqual([
        readingNotice(path, "not-tracked", NOT_TRACKED),
      ]);
      expect(bridge.calls.length, label).toBeGreaterThan(0);
      const support = await persistedSupport(stateDirectory);
      // The source that binds is read, which the prompts show; the other is not.
      expect(readPaths(support), label).toEqual(["notes/beta.textile"]);
      expect(
        bridge.prompts.some((prompt) => prompt.includes("Beta notes.")),
        label,
      ).toBe(true);
      expect(
        support.sourceSpans.map((span) => span.path),
        label,
      ).not.toContain(path);
      expect(
        bridge.prompts.some((prompt) => prompt.includes("UNTRACKED-ZEBRA-7B")),
        label,
      ).toBe(false);
    }
    // Positive control: an untracked --source keeps its own refusal, byte for
    // byte, even beside an admitted intent; the operator chose that path.
    const bridge = countingBridge();
    bridgeHolder.bridge = bridge;
    const { repositoryPath, stateDirectory } = await fixture();
    await writeFile(join(repositoryPath, "src", "untracked.ts"), "export const u = 1;\n");
    const outcome = await run(
      request(repositoryPath, "Create docs/a.md and docs/b.md from the beta module.", [
        "src/untracked.ts",
      ]),
      stateDirectory,
      port({ sources: [{ path: "src/b.ts", quote: "the beta module" }] }),
    );
    expect(outcome.error).toBeInstanceOf(CliSourceAcquisitionError);
    expect((outcome.error as CliSourceAcquisitionError).code).toBe("path-not-tracked");
    expect((outcome.error as CliSourceAcquisitionError).refusal.repositoryPath).toBe(
      "src/untracked.ts",
    );
    expect((outcome.error as Error).message).toBe(
      "No such source: src/untracked.ts is not a tracked regular file at the selected revision. " +
        "Nothing was read and no model call was made. Check the path, or commit the file, then run again.",
    );
    expect(bridge.calls).toEqual([]);
  });

  it("goes on past a tracked intent source under host state with a notice, and never shows the model its bytes (row 7b)", async () => {
    // Was a bound-source-unavailable stop before #2112.
    const bridge = countingBridge();
    bridgeHolder.bridge = bridge;
    const { repositoryPath, stateDirectory } = await fixture({
      ".docsfab/notes.md": "# Notes\n\nHOSTSTATE-QUAIL-7B\n",
    });
    const outcome = await run(
      request(repositoryPath, "Create docs/a.md and docs/b.md from .docsfab/notes.md."),
      stateDirectory,
      port({
        sources: [{ path: ".docsfab/notes.md", quote: ".docsfab/notes.md" }],
      }),
    );
    expect((outcome.error as Error).message).toBe(STOP_AT_EXECUTION);
    admitted(capture.invocations[0]);
    // First, so a run that read the file fails here whatever else it did.
    expect(bridge.prompts.some((prompt) => prompt.includes("HOSTSTATE-QUAIL-7B"))).toBe(false);
    expect(notices(capture.invocations[0])).toEqual([
      readingNotice(
        ".docsfab/notes.md",
        "host-state",
        "it is host state in .docsfab/, which first pass never reads, so first pass did not read it and went on with the evidence it could bind. Name a tracked product file outside that directory.",
      ),
    ]);
    expect(bridge.calls.length).toBeGreaterThan(0);
  });

  it("decides each benign intent source: expand a tracked directory, notice a glob, bind as a write target, or read (row 7k)", async () => {
    const files = {
      "docs/open-api/indexes.yaml": "openapi: 3.0.0\npaths: {}\n",
      "vendor/lib/util.js": "export const vendored = 'vendored evidence';\n",
    };
    // Was a path-not-tracked stop for both before #2112. `notes/` holds a
    // format the scan never ranks, so its files are read only when bound.
    for (const [label, path, quote, expected, expectedNotices] of [
      [
        "directory",
        "notes",
        "the notes directory",
        ["notes/alpha.textile", "notes/beta.textile"],
        [],
      ],
      [
        "glob",
        "notes/*.textile",
        "notes/*.textile",
        [],
        [
          readingNotice(
            "notes/*.textile",
            "glob",
            "it is a pattern, and first pass binds a source only by its exact path, so it read nothing for it and went on with the evidence it could bind. Name the files, or the directory that holds them, in the request, or pass the files with --source.",
          ),
        ],
      ],
    ] as const) {
      const bridge = countingBridge();
      bridgeHolder.bridge = bridge;
      capture.invocations.length = 0;
      const { repositoryPath, stateDirectory } = await fixture(files);
      const instruction = `Create docs/a.md and docs/b.md from ${quote}.`;
      const outcome = await run(
        request(repositoryPath, instruction),
        stateDirectory,
        port({ sources: [{ path, quote }] }),
      );
      expect((outcome.error as Error).message, label).toBe(STOP_AT_EXECUTION);
      admitted(capture.invocations[0]);
      expect(notices(capture.invocations[0]), label).toEqual(expectedNotices);
      expect(bridge.calls.length, label).toBeGreaterThan(0);
      expect(readPaths(await persistedSupport(stateDirectory)), label).toEqual(expected);
    }
    // The create's own new page, a tracked YAML spec and a vendored file: no
    // notice; the page stays a write target, the files are read.
    const bridge = countingBridge();
    bridgeHolder.bridge = bridge;
    capture.invocations.length = 0;
    const { repositoryPath, stateDirectory } = await fixture(files);
    const instruction =
      "Create docs/a.md and docs/b.md from docs/open-api/indexes.yaml and vendor/lib/util.js.";
    const outcome = await run(
      request(repositoryPath, instruction),
      stateDirectory,
      port({
        sources: [
          { path: "docs/a.md", quote: "docs/a.md" },
          {
            path: "docs/open-api/indexes.yaml",
            quote: "docs/open-api/indexes.yaml",
          },
          { path: "vendor/lib/util.js", quote: "vendor/lib/util.js" },
        ],
      }),
    );
    expect((outcome.error as Error).message).toBe(STOP_AT_EXECUTION);
    admitted(capture.invocations[0]);
    // The new page is the run's own target, not an unbound source.
    expect(notices(capture.invocations[0])).toEqual([]);
    const support = await persistedSupport(stateDirectory);
    expect(support.targetPaths).toEqual(TARGETS);
    const paths = new Set(support.sourceSpans.map((span) => span.path));
    expect(paths.has("docs/open-api/indexes.yaml")).toBe(true);
    expect(paths.has("vendor/lib/util.js")).toBe(true);
    expect(paths.has("docs/a.md")).toBe(false);
  });

  it("seeds every constraint kind and both non-publication forms, which the runtime decoder accepts (rows 7e, 7f)", async () => {
    const bridge = countingBridge();
    bridgeHolder.bridge = bridge;
    const { repositoryPath, stateDirectory } = await fixture();
    const keyword = "Keep the result local; do not publish";
    const evidence = "Ground every detail in the repository code";
    const stop = "Halt and ask before any write if a third page is needed";
    const operations = "List the follow-up actions for operators";
    const never = "Never publish this anywhere";
    const instruction = `Create docs/a.md and docs/b.md. ${evidence}. ${stop}. ${operations}. ${never}. ${keyword}.`;
    const outcome = await run(
      request(repositoryPath, instruction),
      stateDirectory,
      port({
        constraints: [
          { kind: "evidence-only", quote: evidence },
          { kind: "stop-before-mutation", quote: stop },
          { kind: "operational-next-steps", quote: operations },
          { kind: "non-publication", quote: never },
        ],
      }),
    );
    // Reaching execution means validateFirstPassSupport accepted the record,
    // including its unique-id and span checks.
    expect((outcome.error as Error).message).toBe(STOP_AT_EXECUTION);
    admitted(capture.invocations[0]);
    expect(bridge.calls.length).toBeGreaterThan(0);
    const support = await persistedSupport(stateDirectory);
    const seed = (id: string, text: string, requiredSourceSupport: boolean) => ({
      id,
      origin: "explicit",
      instructionSpan: spanOf(instruction, text),
      condition: text,
      requiredSourceSupport,
      targetPaths: TARGETS,
    });
    expect(explicitSeeds(instruction, support)).toEqual([
      seed("explicit-nonpublication", keyword, false),
      seed("explicit-evidence", evidence, true),
      seed("explicit-typed-stop", stop, false),
      seed("explicit-operations", operations, true),
      seed("explicit-nonpublication-2", never, false),
    ]);
  });

  it("refuses a constraint over the condition bound before any model call, and admits one at the bound (row 7l)", async () => {
    const conditionLimit = limit("firstPass.maxObligationConditionChars");
    const bound = conditionLimit.value;
    // One catalog bound: the knowledge provider reads the same value from its mirror.
    const { MAX_OBLIGATION_CONDITION_CHARS: knowledgeBound } = (await import(knowledgeAssess)) as {
      MAX_OBLIGATION_CONDITION_CHARS: number;
    };
    expect(knowledgeBound).toBe(bound);
    const sentence = (length: number) => {
      const lead = "Cite the code for";
      const words = " every flag".repeat(Math.ceil(length / " every flag".length));
      const text = `${lead}${words}`.slice(0, length);
      return text.endsWith(" ") ? `${text.slice(0, -1)}s` : text;
    };
    for (const [label, length] of [
      ["at the bound", bound],
      ["one over", bound + 1],
    ] as const) {
      const quote = sentence(length);
      expect(quote.length, label).toBe(length);
      const bridge = countingBridge();
      bridgeHolder.bridge = bridge;
      capture.invocations.length = 0;
      const { repositoryPath, stateDirectory } = await fixture();
      const instruction = `Create docs/a.md and docs/b.md. ${quote}.`;
      const outcome = await run(
        request(repositoryPath, instruction),
        stateDirectory,
        port({ constraints: [{ kind: "evidence-only", quote }] }),
      );
      if (length === bound) {
        expect((outcome.error as Error).message, label).toBe(STOP_AT_EXECUTION);
        admitted(capture.invocations[0]);
        const support = await persistedSupport(stateDirectory);
        expect(explicitSeeds(instruction, support).map((item) => item.condition)).toEqual([quote]);
      } else {
        const start = instruction.indexOf(quote);
        expect(outcome.error, label).toBeInstanceOf(FirstPassConstraintLimitError);
        expect(outcome.error, label).toMatchObject({
          code: "first-pass-max-obligation-condition-chars-bound",
          limitName: "firstPass.maxObligationConditionChars",
          configured: bound,
          observed: length,
          constraint: { kind: "evidence-only", start, end: start + length },
        });
        expect((outcome.error as Error).message, label).toBe(
          `${formatLimitRefusal(conditionLimit, length)} Scope: the request's evidence-only constraint, characters ${String(start)} to ${String(start + length)} of the request as written. No model call was made.`,
        );
        const envelope = toOperatorErrorEnvelope(outcome.error);
        expect(envelope, label).toMatchObject({
          code: conditionLimit.refusal,
          message: (outcome.error as Error).message,
          failure: { class: "bound" },
        });
        expect(bridge.calls, label).toEqual([]);
      }
    }
  });

  it("keeps the --source budget stop on the first-pass support path, not the condition bound (row 7c, adjacent)", async () => {
    // The operator's own selections pass the budget; the reading's source
    // beside them is only a notice, so the stop is the selections' alone.
    vi.stubEnv("DOCSFAB_FIRST_PASS_MAX_SOURCE_FILES", "1");
    try {
      const bridge = countingBridge();
      bridgeHolder.bridge = bridge;
      const { repositoryPath, stateDirectory } = await fixture();
      const instruction = "Create docs/a.md and docs/b.md from the beta notes.";
      const outcome = await run(
        request(repositoryPath, instruction, ["src/a.ts", "src/b.ts"]),
        stateDirectory,
        port({ sources: [{ path: "notes/beta.textile", quote: "the beta notes" }] }),
      );
      expect(outcome.error).not.toBeInstanceOf(OperationalLimitError);
      expect(outcome.error).toMatchObject({
        code: "first-pass-support-invalid",
        evidence: { phase: "request", rule: "budget-exhausted", location: "$instruction" },
      });
      expect(bridge.calls).toEqual([]);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("goes on past a reading's source over the source budget with a notice naming the limit (#2112)", async () => {
    // Was the budget-exhausted stop above before #2112: the union with the
    // reading's source passed the budget, though the operator's did not.
    vi.stubEnv("DOCSFAB_FIRST_PASS_MAX_SOURCE_FILES", "1");
    try {
      const bridge = countingBridge();
      bridgeHolder.bridge = bridge;
      capture.invocations.length = 0;
      const { repositoryPath, stateDirectory } = await fixture();
      const instruction = "Create docs/a.md and docs/b.md from the beta notes.";
      const outcome = await run(
        request(repositoryPath, instruction, ["src/a.ts"]),
        stateDirectory,
        port({ sources: [{ path: "notes/beta.textile", quote: "the beta notes" }] }),
      );
      expect((outcome.error as Error).message).toBe(STOP_AT_EXECUTION);
      admitted(capture.invocations[0]);
      expect(notices(capture.invocations[0])).toEqual([
        readingNotice(
          "notes/beta.textile",
          "over-budget",
          `binding it would bring first pass to 2 sources, so first pass did not bind it and went on with the evidence it could bind. ${formatLimitRefusal(limit("firstPass.maxSourceFiles"), 2)}`,
        ),
      ]);
      expect(bridge.calls.length).toBeGreaterThan(0);
      expect(readPaths(await persistedSupport(stateDirectory))).toEqual([]);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

/**
 * Set-backed stand-in for the workspace tracked-source reader. With `listing`
 * it also lists the tracked files, as the workspace reader does, so the
 * provider ranks only those instead of walking the directory.
 */
function trackedReaderFor(
  paths: readonly string[],
  options: { readonly listing?: boolean } = {},
): TrackedSourceReaderV1 {
  const tracked = new Set(paths);
  return {
    isTrackedRegularFile: async (repositoryPath: string) => tracked.has(repositoryPath),
    ...(options.listing ? { listTrackedRegularFiles: async () => [...paths] } : {}),
    readTrackedBytes: async () => {
      throw new Error("first-pass never reads through the tracked reader");
    },
  };
}

async function plainWorkspace(): Promise<{
  workspacePath: string;
  stateDirectory: string;
}> {
  const root = await roots.create("docsfab-intent-sources-bind-");
  const workspacePath = join(root, "workspace");
  await mkdir(join(workspacePath, "src"), { recursive: true });
  await writeFile(join(workspacePath, "README.md"), "# Widget\n\nWidget reads widget.yaml.\n");
  await writeFile(join(workspacePath, "src", "a.ts"), "export const alpha = 'alpha';\n");
  // On disk in this workspace, but no reader below tracks it.
  await writeFile(
    join(workspacePath, "src", "untracked.ts"),
    "export const otterMarker = 'UNTRACKED-OTTER-7J';\n",
  );
  const stateDirectory = join(root, "state", "runs");
  await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
  return { workspacePath, stateDirectory };
}

const SNAPSHOT_INSTRUCTION = "Create docs/a.md and docs/b.md from the alpha module.";

function bindingRequest(spec: Partial<IntentSpec> = {}): RunRequestWithPublishProjection {
  return {
    workflow: "create-documentation",
    repositoryPath: "/tmp/repo",
    revision: "HEAD",
    instruction: SNAPSHOT_INSTRUCTION,
    allowWrite: true,
    releaseGate: false,
    verbose: false,
    json: false,
    showScan: false,
    requestIntent: recordedIntent(SNAPSHOT_INSTRUCTION, {
      operation: "create",
      targets: TARGETS.map((path) => ({ path, quote: path })),
      ...spec,
    }),
  } as RunRequestWithPublishProjection;
}

function bind(
  workspace: { workspacePath: string; stateDirectory: string },
  spec: Partial<IntentSpec>,
  trackedSourceReader?: TrackedSourceReaderV1,
  bridge: FirstPassSupportModelBridge = countingBridge(),
  notice?: (line: string) => void,
) {
  return bindFirstPassKnowledge({
    request: bindingRequest(spec),
    config: stubConfig(workspace.stateDirectory),
    workspacePath: workspace.workspacePath,
    revision: REVISION,
    status: () => undefined,
    supportModelBridge: bridge,
    ...(trackedSourceReader ? { trackedSourceReader } : {}),
    ...(notice ? { notice } : {}),
  });
}

const UNTRACKED_SOURCE = {
  sources: [{ path: "src/untracked.ts", quote: "the alpha module" }],
};

describe("intent sources at bindFirstPassKnowledge", () => {
  it("leaves a tracked-snapshot run as it was, with no intent-source notice (row 7j)", async () => {
    // Positive control: without a snapshot the same intent source is a notice
    // (a path-not-tracked stop before #2112) and first pass gathers.
    const fresh = await plainWorkspace();
    const freshBridge = countingBridge();
    const seen: string[] = [];
    const noticed = await bind(
      fresh,
      UNTRACKED_SOURCE,
      trackedReaderFor(["src/a.ts"]),
      freshBridge,
      (line) => seen.push(line),
    );
    expect(noticed?.firstPassTargetControl?.targetPaths).toEqual(TARGETS);
    expect(seen).toEqual([readingNotice("src/untracked.ts", "not-tracked", NOT_TRACKED_UNLISTED)]);
    expect(freshBridge.calls.length).toBeGreaterThan(0);
    const workspace = await plainWorkspace();
    // A gathering run writes the snapshot the next run reuses.
    const gathered = await bind(
      workspace,
      { sources: [{ path: "src/a.ts", quote: "the alpha module" }] },
      trackedReaderFor(["src/a.ts"]),
    );
    expect(gathered?.firstPassTargetControl?.targetPaths).toEqual(TARGETS);
    await expect(
      readFile(join(workspace.workspacePath, FIRST_PASS_KNOWLEDGE_SNAPSHOT_PATH), "utf8"),
    ).resolves.toContain("knowledge-accepted-snapshot");
    // With the snapshot in the revision: no notice, with or without a reader.
    for (const reader of [trackedReaderFor(["src/a.ts"]), undefined]) {
      const bridge = countingBridge();
      const onSnapshot: string[] = [];
      const binding = await bind(workspace, UNTRACKED_SOURCE, reader, bridge, (line) =>
        onSnapshot.push(line),
      );
      expect(binding?.completed).toBe(true);
      expect(bridge.calls).toEqual([]);
      expect(onSnapshot).toEqual([]);
    }
  });

  it("never shows the model an untracked source's bytes, even when they sit on disk beside tracked files (#2112)", async () => {
    // The workspace holds src/untracked.ts, which the reader does not track.
    // Only a binding could reach it: the provider ranks the listed files only.
    const workspace = await plainWorkspace();
    const bridge = countingBridge();
    const seen: string[] = [];
    const binding = await bind(
      workspace,
      {
        sources: [
          { path: "src/untracked.ts", quote: "the alpha module" },
          { path: "src/a.ts", quote: "the alpha module" },
        ],
      },
      trackedReaderFor(["README.md", "src/a.ts"], { listing: true }),
      bridge,
      (line) => seen.push(line),
    );
    expect(binding?.firstPassTargetControl?.targetPaths).toEqual(TARGETS);
    expect(seen).toEqual([readingNotice("src/untracked.ts", "not-tracked", NOT_TRACKED)]);
    // Positive control: the tracked source the reading names is in front of the model.
    expect(bridge.prompts.some((prompt) => prompt.includes("export const alpha = 'alpha';"))).toBe(
      true,
    );
    expect(bridge.prompts.some((prompt) => prompt.includes("UNTRACKED-OTTER-7J"))).toBe(false);
  });

  it("fails closed without a tracked-source reader when the intent names sources to gather", async () => {
    const workspace = await plainWorkspace();
    await expect(
      bind(workspace, {
        sources: [{ path: "src/a.ts", quote: "the alpha module" }],
      }),
    ).rejects.toThrow(
      "First-pass knowledge binding requires a tracked-source reader when the admitted request intent names sources.",
    );
    // An intent naming no source, or only its own write target, needs no reader.
    const plain = await bind(await plainWorkspace(), {});
    expect(plain?.firstPassTargetControl?.targetPaths).toEqual(TARGETS);
    const ownPage = await bind(await plainWorkspace(), {
      sources: [{ path: "docs/a.md", quote: "docs/a.md" }],
    });
    expect(ownPage?.firstPassTargetControl?.targetPaths).toEqual(TARGETS);
  });

  it("passes a reader failure through unchanged instead of calling the source untracked", async () => {
    const workspace = await plainWorkspace();
    const failure = new Error("tracked-set listing failed: git exited 128");
    const reader: TrackedSourceReaderV1 = {
      isTrackedRegularFile: async () => {
        throw failure;
      },
      readTrackedBytes: async () => {
        throw new Error("first-pass never reads through the tracked reader");
      },
    };
    await expect(
      bind(workspace, { sources: [{ path: "src/a.ts", quote: "the alpha module" }] }, reader),
    ).rejects.toBe(failure);
  });
});

describe("the condition-bound stop the knowledge provider reports", () => {
  /** A knowledge-shaped error, as `intentConstraint` throws it. */
  const knowledgeStop = (limitName: string, observed: number, constraint: object) =>
    Object.assign(new Error("over the condition bound"), {
      name: "FirstPassSupportError",
      code: "budget-exhausted",
      limit: { name: limitName, observed },
      constraint,
    });
  const name = "firstPass.maxObligationConditionChars";

  it("converts only a consistent condition-bound stop, and nothing adjacent to it", () => {
    const converted = constraintConditionLimitError(
      knowledgeStop(name, 3, { kind: "non-publication", start: 4, end: 7 }),
    );
    expect(converted).toBeInstanceOf(FirstPassConstraintLimitError);
    expect(converted).toMatchObject({ observed: 3, constraint: { start: 4, end: 7 } });
    for (const [label, error] of [
      [
        "another bound",
        knowledgeStop("firstPass.maxSourceFiles", 3, { kind: "evidence-only", start: 4, end: 7 }),
      ],
      [
        "span and length disagree",
        knowledgeStop(name, 3, { kind: "evidence-only", start: 4, end: 8 }),
      ],
      ["unknown kind", knowledgeStop(name, 3, { kind: "preserve", start: 4, end: 7 })],
      ["no constraint", Object.assign(knowledgeStop(name, 3, {}), { constraint: undefined })],
      [
        "not a first-pass error",
        Object.assign(knowledgeStop(name, 3, { kind: "evidence-only", start: 4, end: 7 }), {
          name: "Error",
        }),
      ],
    ] as const) {
      expect(constraintConditionLimitError(error), label).toBeUndefined();
    }
  });
});
