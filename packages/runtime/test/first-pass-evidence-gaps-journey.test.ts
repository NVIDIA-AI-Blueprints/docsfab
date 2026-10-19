// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * A first pass that leaves a mandatory obligation without repository support
 * continues to a delivered patch, and the gap reaches every operator surface
 * (#2113). Before #2113 the same run stopped at first pass with
 * `insufficient-evidence`. Every run goes through the shipped entry,
 * `executeRunRequest`. The model is scripted three times over: the
 * interpretation port, the first-pass bridge, and the workflow harness.
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

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

import {
  firstPassAssessmentBindingSha256,
  type FirstPassSupportModelBridge,
  type FirstPassSupportModelRequest,
} from "../src/cli/first-pass-support.js";
import { FIRST_PASS_EVIDENCE_GAPS_LIMITATION } from "../src/cli/first-pass-evidence-gaps.js";
import { executeRunRequest } from "../src/cli/run-request.js";
import type { RunRequestWithPublishProjection } from "../src/cli/run/request.js";
import type { RunRecord } from "../src/records/contracts.js";
import type { RequestIntentInterpreterPort } from "../src/request-intent/interpret.js";
import { parseEvidenceFrames } from "./helpers/knowledge-evidence-frames.js";
import { temporaryRoots } from "./helpers/temp.js";
import { testTimeoutMs } from "./helpers/test-timeouts.js";
import { createFixtureRepository, runtimeConfig } from "./support/execution-convergence.js";
import { PAGE_PATH, skillResolver, SourceToolHarness } from "./support/source-acquisition-cli.js";

const roots = temporaryRoots();
/** One journey: interpretation, a gathering first pass and the workflow's steps. */
const JOURNEY_MS = testTimeoutMs(60_000);
const sha = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");

/** A page elsewhere than the one the scripted workflow plans for. */
const OTHER_PAGE = "docs/other-page.md";
const instructionFor = (page: string) =>
  `Create ${page} for operators, and state how long each release line is supported.`;
const GAP_ID = "decomposed-support-window";
const LINES = [
  "first-pass-evidence-gaps: first pass continued after 1 assessment round with 1 mandatory obligation its repository evidence did not support. It ended no-progress: an attempt to read further found no new evidence, so reading further was not expected to close an open obligation. The run used the evidence first pass gathered; to give an obligation its evidence, name its source by path in the request or with --source <path>.",
  `first-pass-evidence-gaps: obligation ${GAP_ID} is missing.`,
];

beforeEach(() => {
  bridgeHolder.bridge = undefined;
});

afterEach(() => {
  process.exitCode = undefined;
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

/**
 * First pass's model: one inferred obligation, `GAP_ID`, that no offered span
 * supports unless `supportsGap`; every other obligation cites the first span.
 */
function gapBridge(supportsGap: boolean, page: string): FirstPassSupportModelBridge {
  let lastIdentitySha256: string | undefined;
  let lastAssessmentBindingSha256: string | undefined;
  return {
    call: async (call: FirstPassSupportModelRequest) => {
      let value: unknown;
      if (call.prompt.startsWith("Phase: obligation-decomposition")) {
        value = {
          schemaVersion: 1,
          additionalObligations: [
            {
              id: GAP_ID,
              origin: "inferred",
              instructionQuote: null,
              targetPaths: [page],
              condition: "The page states how long each release line is supported.",
              requiredSourceSupport: true,
            },
          ],
        };
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
          assessments: obligations.map((obligation) =>
            obligation.id === GAP_ID && !supportsGap
              ? {
                  obligationId: obligation.id,
                  status: "missing",
                  evidenceSpanIds: [],
                  detail: "No offered span states a support window.",
                }
              : {
                  obligationId: obligation.id,
                  status: "supported",
                  evidenceSpanIds: obligation.requiredSourceSupport ? [firstSpan] : [],
                  detail: "Supported by the offered repository span.",
                },
          ),
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

/** The interpretation's model: a create of the page, naming no source. */
function createReading(page: string): RequestIntentInterpreterPort {
  return {
    async call() {
      return {
        text: JSON.stringify({
          operation: "create",
          targets: [{ path: page, role: "write", chosenFrom: "named", quote: page }],
          sources: [],
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

interface Journey {
  readonly record: RunRecord | undefined;
  /** What the run printed: the operator summary or the `--json` result. */
  readonly stdout: string;
  /** The live status lines. */
  readonly stderr: string;
}

interface JourneyOptions {
  readonly json?: boolean;
  /** `--quiet`: the summary's VERDICT and LIMITATIONS only, and no status lines. */
  readonly quiet?: boolean;
  /** The page the request creates; the scripted workflow plans for `PAGE_PATH` only. */
  readonly page?: string;
}

/** `docsfab run create-documentation`, with console and stderr captured. */
async function journey(supportsGap: boolean, options: JourneyOptions = {}): Promise<Journey> {
  const page = options.page ?? PAGE_PATH;
  const fixture = await createFixtureRepository("documented-html");
  roots.track(fixture.root);
  bridgeHolder.bridge = gapBridge(supportsGap, page);
  const request = {
    workflow: "create-documentation",
    instruction: instructionFor(page),
    repositoryPath: fixture.repository,
    revision: "HEAD",
    allowWrite: true,
    releaseGate: false,
    verbose: false,
    json: options.json ?? false,
    quiet: options.quiet ?? false,
    showScan: false,
    patchOnly: true,
  } as RunRequestWithPublishProjection;
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
    const record = (await executeRunRequest(request, runtimeConfig(fixture.stateDirectory), {
      executionHarness: new SourceToolHarness({
        readOnSkill: null,
        planSourcePaths: ["README.md"],
      }),
      skillResolver,
      requestInterpreter: createReading(page),
    })) as RunRecord;
    return { record, stdout: out.join("\n"), stderr: err.join("") };
  } finally {
    console.log = log;
    console.error = error;
    process.stderr.write = write;
  }
}

/** The run delivered a patch for the requested page. */
async function expectDelivered(run: Journey): Promise<void> {
  const record = run.record;
  expect(
    record?.status,
    JSON.stringify({ error: record?.error, steps: record?.steps.map((step) => step.status) }),
  ).toBe("succeeded");
  const patch = await readFile(record!.changes!.patch!.artifactPath, "utf8");
  expect(patch).toContain(PAGE_PATH);
}

/** The `--json` run result the command printed: the one top-level object on stdout. */
function jsonResult(stdout: string) {
  const lines = stdout.split("\n");
  const start = lines.indexOf("{");
  const end = lines.lastIndexOf("}");
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return JSON.parse(lines.slice(start, end + 1).join("\n")) as {
    readonly kind: string;
    readonly product: { readonly limitations: readonly string[] };
    readonly limitOverflow?: readonly string[];
  };
}

describe("a first pass with an evidence gap at the shipped entry (#2113)", {
  timeout: JOURNEY_MS,
}, () => {
  it("delivers past the gap, with its lines in PREFLIGHT, the saved record, and LIMITATIONS", async () => {
    const run = await journey(false);
    await expectDelivered(run);
    expect(run.record?.evidenceWarnings).toEqual(LINES);
    for (const line of LINES) expect(run.stderr).toContain(line);
    const summary = run.stdout.split("\n").map((line) => line.trim());
    const limitations = summary.indexOf("LIMITATIONS");
    expect(limitations).toBeGreaterThanOrEqual(0);
    expect(summary.slice(limitations + 1, limitations + 1 + LINES.length)).toEqual(LINES);
  });

  it("delivers past the gap with the coded limitation and its lines in the --json result", async () => {
    const run = await journey(false, { json: true });
    await expectDelivered(run);
    const result = jsonResult(run.stdout);
    expect(result.kind).toBe("docsfab-run-result");
    expect(result.product.limitations).toContain(FIRST_PASS_EVIDENCE_GAPS_LIMITATION);
    expect(result.limitOverflow?.slice(0, LINES.length)).toEqual(LINES);
  });

  it("leads LIMITATIONS with the lines under --quiet, which prints no PREFLIGHT", async () => {
    const run = await journey(false, { quiet: true });
    await expectDelivered(run);
    expect(run.record?.evidenceWarnings).toEqual(LINES);
    // --quiet drops the live status lines; the summary's LIMITATIONS section
    // is the one place the operator sees the gaps.
    expect(run.stderr).not.toContain("first-pass-evidence-gaps:");
    const summary = run.stdout.split("\n").map((line) => line.trim());
    const limitations = summary.indexOf("LIMITATIONS");
    expect(limitations).toBeGreaterThanOrEqual(0);
    expect(summary.slice(limitations + 1, limitations + 1 + LINES.length)).toEqual(LINES);
  });

  it("keeps the lines when a later step stops the run: the saved record, LIMITATIONS, and --json", async () => {
    // The scripted workflow plans for the fixture's page only, so a request for
    // another page stops at plan admission, after first pass continued past
    // its gap. The saved record still holds the lines.
    const failed = await journey(false, { page: OTHER_PAGE });
    expect(failed.record?.status).toBe("failed");
    expect(failed.record?.error).toContain("omitted-mandatory-obligation");
    expect(failed.record?.evidenceWarnings).toEqual(LINES);
    for (const line of LINES) expect(failed.stderr).toContain(line);
    const summary = failed.stdout.split("\n").map((line) => line.trim());
    const limitations = summary.indexOf("LIMITATIONS");
    expect(limitations).toBeGreaterThanOrEqual(0);
    expect(summary.slice(limitations + 1, limitations + 1 + LINES.length)).toEqual(LINES);

    const asJson = await journey(false, { page: OTHER_PAGE, json: true });
    expect(asJson.record?.status).toBe("failed");
    const result = jsonResult(asJson.stdout);
    expect(result.product.limitations).toContain(FIRST_PASS_EVIDENCE_GAPS_LIMITATION);
    expect(result.limitOverflow?.slice(0, LINES.length)).toEqual(LINES);
  });

  it("records no gap when the same run's first pass supports every obligation (control)", async () => {
    const run = await journey(true, { json: true });
    await expectDelivered(run);
    expect(run.record?.evidenceWarnings ?? []).not.toEqual(
      expect.arrayContaining([expect.stringMatching(/^first-pass-evidence-gaps: /u)]),
    );
    expect(run.stderr).not.toContain("first-pass-evidence-gaps:");
    expect(jsonResult(run.stdout).product.limitations).not.toContain(
      FIRST_PASS_EVIDENCE_GAPS_LIMITATION,
    );
  });
});
