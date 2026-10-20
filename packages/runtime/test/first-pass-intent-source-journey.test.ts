// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The benchmark shape of #2112, end to end. The request says the code change
 * "is under upstream/ in this workspace", and its reading names `upstream` as
 * a source. Before #2112 first pass stopped there with `path-not-tracked`,
 * whether the directory was tracked or not. Now a tracked directory binds its
 * tracked files, and an untracked one is a coded notice, and either run goes
 * on to a delivered patch. Every run goes through the shipped entry,
 * `executeRunRequest`, directly or through `docsfab do`. The model is
 * scripted three times over: the interpretation port, the first-pass bridge,
 * and the workflow harness.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const bridgeHolder = vi.hoisted(() => ({ bridge: undefined as unknown }));

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

import { handleDoCommand } from "../src/cli/commands/do.js";
import {
  firstPassAssessmentBindingSha256,
  type FirstPassSupportModelBridge,
  type FirstPassSupportModelRequest,
} from "../src/cli/first-pass-support.js";
import { executeRunRequest } from "../src/cli/run-request.js";
import type { RunRequestWithPublishProjection } from "../src/cli/run/request.js";
import { formatLimitObservation, limit } from "../src/config/limits.js";
import type { HarnessStepInput } from "../src/execution/contracts.js";
import type { RunRecord } from "../src/records/contracts.js";
import type { RequestIntentInterpreterPort } from "../src/request-intent/interpret.js";
import { commitFixture } from "./helpers/git.js";
import { parseEvidenceFrames } from "./helpers/knowledge-evidence-frames.js";
import { temporaryRoots } from "./helpers/temp.js";
import { testTimeoutMs } from "./helpers/test-timeouts.js";
import { createFixtureRepository, runtimeConfig } from "./support/execution-convergence.js";
import { PAGE_PATH, skillResolver, SourceToolHarness } from "./support/source-acquisition-cli.js";

const roots = temporaryRoots();
/** One journey: interpretation, a gathering first pass and nine workflow steps. */
const JOURNEY_MS = testTimeoutMs(60_000);
const sha = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");

/** The benchmark trigger's own words (rr-20261007a, LD-1). */
const INSTRUCTION = `Create ${PAGE_PATH} for developers. The code change, from the llm-d-router repository, is under upstream/ in this workspace.`;
const UPSTREAM_QUOTE = "under upstream/ in this workspace";
/** The `do` sentence the routing table sends to create-documentation. */
const CREATE_SENTENCE = "Create a documentation page for the new export behavior.";

/**
 * Each upstream file carries its own marker, in a format the first-pass scan
 * never ranks, so a marker in front of the model means the file was bound.
 */
const UPSTREAM_FILES = {
  "upstream/notes/scorer.textile": "h1. Scorer\n\nUPSTREAM-HERON-SCORER ranks endpoints.\n",
  "upstream/notes/filter.textile": "h1. Filter\n\nUPSTREAM-HERON-FILTER drops endpoints.\n",
  "upstream/notes/picker.textile": "h1. Picker\n\nUPSTREAM-HERON-PICKER picks one.\n",
} as const;
const MARKERS = ["UPSTREAM-HERON-SCORER", "UPSTREAM-HERON-FILTER", "UPSTREAM-HERON-PICKER"];

const NOTICE_NOT_TRACKED =
  'first-pass-reading-source-unbound: "upstream" (not-tracked): the request\'s reading names it as a source, but the selected revision tracks no regular file at that path or under it, so first pass did not read it and went on with the evidence it could bind. To use it as evidence, check the path or commit it, then run again, or pass a tracked file with --source.';

beforeEach(() => {
  bridgeHolder.bridge = undefined;
});

afterEach(() => {
  vi.unstubAllEnvs();
});

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

/** First pass's model: supports every obligation from the first span, and keeps each prompt. */
function supportingBridge(): FirstPassSupportModelBridge & { readonly prompts: string[] } {
  const prompts: string[] = [];
  let lastIdentitySha256: string | undefined;
  let lastAssessmentBindingSha256: string | undefined;
  return {
    prompts,
    call: async (call: FirstPassSupportModelRequest) => {
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
      return { responseText, identity, usage: { inputTokens: 20, outputTokens: 10 } };
    },
    lastAssessmentIdentitySha256: () => lastIdentitySha256,
    lastAssessmentBindingSha256: () => lastAssessmentBindingSha256,
  };
}

/** The workflow's model, keeping every step prompt it was shown. */
class PromptKeepingHarness extends SourceToolHarness {
  public readonly prompts: string[] = [];

  public constructor() {
    super({ readOnSkill: null, planSourcePaths: ["README.md"] });
  }

  public override async runStep(input: HarnessStepInput) {
    this.prompts.push(input.step.prompt);
    return super.runStep(input);
  }
}

/** The interpretation's model: the benchmark reading, which names `upstream` as a source. */
function benchmarkReading(): RequestIntentInterpreterPort {
  return {
    async call() {
      return {
        text: JSON.stringify({
          operation: "create",
          targets: [{ path: PAGE_PATH, role: "write", chosenFrom: "named", quote: PAGE_PATH }],
          sources: [{ path: "upstream", quote: UPSTREAM_QUOTE }],
          preserve: [],
          exclusions: [],
          constraints: [],
          authorityPreference: { preference: "unspecified", quote: null },
        }),
        usage: { inputTokens: 3, outputTokens: 2 },
      };
    },
  };
}

/** The fixture repository with `upstream/` committed, or on disk and never committed. */
async function workspaceWithUpstream(
  upstream: "tracked" | "untracked",
  files: Readonly<Record<string, string>> = UPSTREAM_FILES,
) {
  const fixture = await createFixtureRepository("documented-html");
  roots.track(fixture.root);
  for (const [path, text] of Object.entries(files)) {
    await mkdir(dirname(join(fixture.repository, path)), { recursive: true });
    await writeFile(join(fixture.repository, path), text);
  }
  if (upstream === "tracked") await commitFixture(fixture.repository, "add upstream");
  return fixture;
}

interface Journey {
  readonly record: RunRecord | undefined;
  readonly firstPass: ReturnType<typeof supportingBridge>;
  readonly workflow: PromptKeepingHarness;
  /** What the run printed: the operator summary or the `--json` result. */
  readonly stdout: string;
  /** The live status lines. */
  readonly stderr: string;
}

/** Run with console and stderr captured, so the operator's surfaces can be read back. */
async function capturing(body: () => Promise<RunRecord | undefined>) {
  const out: string[] = [];
  const err: string[] = [];
  const log = console.log;
  const error = console.error;
  const write = process.stderr.write.bind(process.stderr);
  console.log = (...args: unknown[]) => void out.push(args.map(String).join(" "));
  console.error = (...args: unknown[]) => void err.push(args.map(String).join(" "));
  process.stderr.write = ((chunk: string | Uint8Array) => {
    err.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  }) as typeof process.stderr.write;
  try {
    const record = await body();
    return { record, stdout: out.join("\n"), stderr: err.join("") };
  } finally {
    console.log = log;
    console.error = error;
    process.stderr.write = write;
  }
}

function runOptions(workflow: PromptKeepingHarness) {
  return {
    executionHarness: workflow,
    skillResolver,
    requestInterpreter: benchmarkReading(),
  };
}

/** `docsfab run create-documentation`, as the CLI parses it. */
async function viaRun(repository: string, stateDirectory: string, json: boolean): Promise<Journey> {
  const firstPass = supportingBridge();
  bridgeHolder.bridge = firstPass;
  const workflow = new PromptKeepingHarness();
  const request: RunRequestWithPublishProjection = {
    workflow: "create-documentation",
    instruction: INSTRUCTION,
    repositoryPath: repository,
    revision: "HEAD",
    allowWrite: true,
    releaseGate: false,
    verbose: false,
    json,
    showScan: false,
    patchOnly: true,
  } as RunRequestWithPublishProjection;
  const captured = await capturing(
    async () =>
      (await executeRunRequest(
        request,
        runtimeConfig(stateDirectory),
        runOptions(workflow),
      )) as RunRecord,
  );
  return { ...captured, firstPass, workflow };
}

/** `docsfab do`, routed by its table to create-documentation, onto the shared run path. */
async function viaDo(repository: string, stateDirectory: string): Promise<Journey> {
  const firstPass = supportingBridge();
  bridgeHolder.bridge = firstPass;
  const workflow = new PromptKeepingHarness();
  let record: RunRecord | undefined;
  const captured = await capturing(async () => {
    const decision = await handleDoCommand(
      [
        CREATE_SENTENCE,
        "--repo",
        repository,
        "--instruction",
        INSTRUCTION,
        "--patch-only",
        "--json",
      ],
      {
        stateDirectory,
        admitCatalogWorkflow: async () => undefined,
        runWorkflow: async (request) => {
          record = (await executeRunRequest(
            request,
            runtimeConfig(stateDirectory),
            runOptions(workflow),
          )) as RunRecord;
          return record;
        },
      },
    );
    expect(decision).toMatchObject({ status: "selected", workflow: "create-documentation" });
    return record;
  });
  return { ...captured, firstPass, workflow };
}

/** The run delivered a patch for the requested page. */
async function expectDelivered(journey: Journey): Promise<string> {
  const record = journey.record;
  expect(
    record?.status,
    JSON.stringify({ error: record?.error, steps: record?.steps.map((s) => s.status) }),
  ).toBe("succeeded");
  expect(record?.requestIntent?.admission.outcome).toBe("admitted");
  expect(journey.firstPass.prompts.length).toBeGreaterThan(0);
  expect(journey.workflow.prompts.length).toBeGreaterThan(0);
  const patch = await readFile(record!.changes!.patch!.artifactPath, "utf8");
  expect(patch).toContain(PAGE_PATH);
  return patch;
}

/** Everything a model was shown, by first pass or by a workflow step. */
const shownToModels = (journey: Journey) =>
  [...journey.firstPass.prompts, ...journey.workflow.prompts].join("\n");

/** The `--json` run result the command printed: the one top-level object on stdout. */
function jsonResult(stdout: string): { readonly limitOverflow?: readonly string[] } {
  const lines = stdout.split("\n");
  const start = lines.indexOf("{");
  const end = lines.lastIndexOf("}");
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  const result = JSON.parse(lines.slice(start, end + 1).join("\n")) as {
    readonly kind: string;
    readonly limitOverflow?: readonly string[];
  };
  expect(result.kind).toBe("docsfab-run-result");
  return result;
}

describe("a reading that names upstream/ (#2112 benchmark shape)", { timeout: JOURNEY_MS }, () => {
  it("delivers past an untracked upstream/ with a notice in the record, the live status, and LIMITATIONS, never showing a model its bytes", async () => {
    const fixture = await workspaceWithUpstream("untracked");
    const journey = await viaRun(fixture.repository, fixture.stateDirectory, false);
    const patch = await expectDelivered(journey);
    expect(journey.record?.evidenceWarnings).toEqual([NOTICE_NOT_TRACKED]);
    // The saved record keeps it from the queued save.
    const saved = await readFile(
      join(fixture.stateDirectory, `${journey.record!.id}.json`),
      "utf8",
    );
    expect((JSON.parse(saved) as RunRecord).evidenceWarnings).toEqual([NOTICE_NOT_TRACKED]);
    // The operator summary lists it under LIMITATIONS; the live status names it first.
    const summary = journey.stdout.split("\n").map((line) => line.trim());
    expect(summary).toContain("LIMITATIONS");
    expect(summary).toContain(NOTICE_NOT_TRACKED);
    expect(journey.stderr).toContain(NOTICE_NOT_TRACKED);
    // Nothing of the untracked directory reached a model, the record, or the patch.
    for (const marker of MARKERS) {
      expect(shownToModels(journey)).not.toContain(marker);
      expect(saved).not.toContain(marker);
      expect(patch).not.toContain(marker);
    }
  });

  it("delivers past a tracked upstream/ by binding its tracked files, with no notice", async () => {
    const fixture = await workspaceWithUpstream("tracked");
    const journey = await viaRun(fixture.repository, fixture.stateDirectory, true);
    await expectDelivered(journey);
    expect(journey.record?.evidenceWarnings ?? []).toEqual([]);
    expect(jsonResult(journey.stdout).limitOverflow ?? []).toEqual([]);
    // Each file is in a format the scan never ranks: first pass read it because it bound it.
    for (const marker of MARKERS) expect(journey.firstPass.prompts.join("\n")).toContain(marker);
    expect(journey.stderr).toContain(
      'first pass binds the 3 tracked files under "upstream", which the request\'s reading names as a source',
    );
  });

  it("delivers through docsfab do past an untracked upstream/, with the notice in the --json result", async () => {
    const fixture = await workspaceWithUpstream("untracked");
    const journey = await viaDo(fixture.repository, fixture.stateDirectory);
    await expectDelivered(journey);
    expect(journey.record?.evidenceWarnings).toEqual([NOTICE_NOT_TRACKED]);
    expect(jsonResult(journey.stdout).limitOverflow).toEqual([NOTICE_NOT_TRACKED]);
    for (const marker of MARKERS) expect(shownToModels(journey)).not.toContain(marker);
  });

  it("delivers through docsfab do past a tracked upstream/, reading its tracked files", async () => {
    const fixture = await workspaceWithUpstream("tracked");
    const journey = await viaDo(fixture.repository, fixture.stateDirectory);
    await expectDelivered(journey);
    expect(journey.record?.evidenceWarnings ?? []).toEqual([]);
    for (const marker of MARKERS) expect(journey.firstPass.prompts.join("\n")).toContain(marker);
  });

  it("binds a tracked upstream/ whole at the source budget, and goes on with one notice one file over", async () => {
    // Eight leaves first pass a per-round share of two of its own files once
    // the directory is left out, so the run still finds evidence to deliver.
    vi.stubEnv("DOCSFAB_FIRST_PASS_MAX_SOURCE_FILES", "8");
    const budget = limit("firstPass.maxSourceFiles");
    expect(budget.value).toBe(8);
    const upstream = (count: number) =>
      Object.fromEntries(
        Array.from({ length: count }, (_, index) => [
          `upstream/notes/part-${String(index + 1).padStart(2, "0")}.textile`,
          `h1. Part ${String(index + 1)}\n\nUPSTREAM-KITE-${String(index + 1)} routes.\n`,
        ]),
      );
    const kites = (count: number) =>
      Array.from({ length: count }, (_, index) => `UPSTREAM-KITE-${String(index + 1)} routes`);
    // At the budget: all eight files bind, and first pass reads each.
    const atLimit = await workspaceWithUpstream("tracked", upstream(8));
    const bound = await viaRun(atLimit.repository, atLimit.stateDirectory, true);
    await expectDelivered(bound);
    expect(bound.record?.evidenceWarnings ?? []).toEqual([]);
    for (const marker of kites(8)) expect(bound.firstPass.prompts.join("\n")).toContain(marker);
    // One file over: none binds, one notice names the limit, and the run delivers.
    const overLimit = await workspaceWithUpstream("tracked", upstream(9));
    const over = await viaRun(overLimit.repository, overLimit.stateDirectory, true);
    await expectDelivered(over);
    const notice = `first-pass-reading-source-unbound: "upstream" (over-budget): the request's reading names this directory as a source, but binding its 9 tracked files would bring first pass to 9 sources, so first pass bound none of them and went on with the evidence it could bind. ${formatLimitObservation(budget, 9)}`;
    expect(over.record?.evidenceWarnings).toEqual([notice]);
    expect(jsonResult(over.stdout).limitOverflow).toEqual([notice]);
    for (const marker of kites(9)) expect(over.firstPass.prompts.join("\n")).not.toContain(marker);
  });
});
