// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

import type { DocsFabConfig } from "../src/config/runtime-loader.js";
import { bindFirstPassKnowledge } from "../src/cli/first-pass.js";
import {
  firstPassAssessmentBindingSha256,
  FirstPassSupportValidationError,
  type FirstPassSupportModelBridge,
  type FirstPassSupportModelRequest,
} from "../src/cli/first-pass-support.js";
import type { RunRequestWithPublishProjection } from "../src/cli/run/request.js";
import { parseEvidenceFrames } from "./helpers/knowledge-evidence-frames.js";
import { temporaryRoots } from "./helpers/temp.js";

const runtimeRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const knowledgeSupport = pathToFileURL(
  resolve(runtimeRoot, "..", "knowledge", "src", "first-pass-support.mjs"),
).href;
const REVISION = "f".repeat(40);
const INSTALL_INSTRUCTION =
  "Create exactly docs/get-started.md, an installation guide for Widget CLI. Include Linux install, macOS install, and verification from current repository evidence. Change no other path.";
const FULL_INSTRUCTION =
  "Create exactly docs/get-started.md, an installation guide for Widget CLI. Include Linux install and verification from current repository evidence. Change no other path.";
const SCAFFOLD_INSTRUCTION =
  "Create exactly docs/get-started.md as a labeled scaffold outline for an installation guide. Do not invent product commands. Change no other path.";
const OUT_OF_SCOPE_INSTRUCTION =
  "Create exactly vendor/get-started.md, an installation guide for Widget CLI from current repository evidence. Change no other path.";
const temporary = temporaryRoots();

describe("professional partial documentation", () => {
  it("rich-input-full-admission continues original CREATE without a partial envelope", async () => {
    const setup = await workspace({
      readme:
        "# Widget\n\nInstall on Linux with `apt install widget`.\nVerify with `widget --version`.\n",
    });
    const binding = await bindFirstPassKnowledge({
      request: request(FULL_INSTRUCTION),
      config: stubConfig(setup.stateDirectory),
      workspacePath: setup.workspace,
      revision: REVISION,
      status: () => undefined,
      supportModelBridge: installBridge("full"),
    });
    expect(binding?.firstPassTargetControl?.targetPaths).toEqual(["docs/get-started.md"]);
  });

  // Label, don't block (planning/design/label-not-block-decision.md, sentence
  // 1): a first-pass evidence gap labels the run instead of stopping it, so
  // the original CREATE reaches the workflow with each gap recorded (#2113).
  it("missing-independent-section continues to the workflow with the unsupported section named", async () => {
    const setup = await workspace({
      readme: "# Widget\n\nInstall on Linux with `apt install widget`.\n",
    });
    const { binding, statuses } = await expectContinued(
      setup,
      INSTALL_INSTRUCTION,
      "missing-macos",
    );
    expect(binding?.firstPassEvidenceWarnings).toEqual([
      "first-pass-evidence-gaps: first pass continued after 1 assessment round with 1 mandatory obligation its repository evidence did not support. It ended no-progress: an attempt to read further found no new evidence, so reading further was not expected to close an open obligation. The run used the evidence first pass gathered; to give an obligation its evidence, name its source by path in the request or with --source <path>.",
      "first-pass-evidence-gaps: obligation decomposed-macos is missing.",
    ]);
    expect(statuses).toEqual(expect.arrayContaining([...binding!.firstPassEvidenceWarnings!]));
  });

  it("contradictory-installation-commands does not mint either command", async () => {
    const setup = await workspace({
      readme:
        "# Widget\n\nInstall with `apt install widget`.\nInstall with `brew install widget`.\n",
    });
    // Only sources that disagree: the stop asks one question, and the
    // independently supported sections still classify as a partial draft.
    const error = await expectInsufficient(
      setup,
      INSTALL_INSTRUCTION,
      "contradict",
      "contradicted",
    );
    expect(error.partial?.draftApplicability).toBe("useful-partial");
    expect(error.partial?.originalRequestCompletion).toBe("incomplete");
    const envelope = error.partial?.envelope as {
      obligations: { id: string; proposedDeliverable: string; condition: string }[];
      claimsNotMade: string[];
    };
    expect(envelope.obligations.some((item) => item.proposedDeliverable === "conflicted")).toBe(
      true,
    );
    const stored = await readStoredPartial(setup.stateDirectory, error.partial?.locator);
    expect(stored).not.toMatch(/`apt install widget`/u);
    expect(stored).not.toMatch(/`brew install widget`/u);
    const conflicted = envelope.obligations.filter(
      (item) => item.proposedDeliverable === "conflicted",
    );
    expect(envelope.claimsNotMade).toEqual(
      expect.arrayContaining(
        conflicted.map((item) => `Either disagreeing source for ${item.id} as product truth`),
      ),
    );
    expect(envelope.claimsNotMade.join("\n")).not.toMatch(/install command/u);
  });

  it("no-supported-product-facts continues with every product obligation and the page named", async () => {
    const setup = await workspace({ readme: "# Widget\n\nNo install commands.\n" });
    const { binding } = await expectContinued(setup, INSTALL_INSTRUCTION, "no-facts");
    expect(binding?.firstPassEvidenceWarnings).toEqual([
      "first-pass-evidence-gaps: first pass continued after 1 assessment round with 4 mandatory obligations its repository evidence did not support, leaving 1 of 1 target page without page support of its own. It ended no-progress: an attempt to read further found no new evidence, so reading further was not expected to close an open obligation. The run used the evidence first pass gathered; to give an obligation its evidence, name its source by path in the request or with --source <path>.",
      "first-pass-evidence-gaps: obligation target-01 is missing.",
      "first-pass-evidence-gaps: obligation decomposed-linux is missing.",
      "first-pass-evidence-gaps: obligation decomposed-macos is missing.",
      "first-pass-evidence-gaps: obligation decomposed-verify is missing.",
    ]);
  });

  it("explicit-scaffold-request continues with its product obligations named", async () => {
    const setup = await workspace({ readme: "# Widget\n\nNo install commands.\n" });
    const { binding } = await expectContinued(setup, SCAFFOLD_INSTRUCTION, "no-facts");
    expect(binding?.firstPassTargetControl?.targetPaths).toEqual(["docs/get-started.md"]);
    expect(binding?.firstPassEvidenceWarnings).toEqual(
      expect.arrayContaining([
        "first-pass-evidence-gaps: obligation decomposed-linux is missing.",
        "first-pass-evidence-gaps: obligation decomposed-verify is missing.",
      ]),
    );
  });

  it("out-of-scope-destination writes nothing at first pass and leaves the refusal to the run's write scope", async () => {
    const setup = await workspace({
      readme: "# Widget\n\nInstall on Linux with `apt install widget`.\n",
    });
    // First pass never held destination authority: a supported first pass
    // binds an out-of-scope page as well. Plan admission refuses any write
    // outside the run's roots (plan-write-scope-run.test.ts).
    const { binding } = await expectContinued(setup, OUT_OF_SCOPE_INSTRUCTION, "no-facts");
    expect(binding?.firstPassTargetControl?.targetPaths).toEqual(["vendor/get-started.md"]);
    await expect(
      readFile(join(setup.workspace, "vendor", "get-started.md"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("canned-object-without-execution cannot mint a useful-partial", async () => {
    const { classifyDocumentationPartialFallback, FirstPassSupportError } = (await import(
      knowledgeSupport
    )) as {
      classifyDocumentationPartialFallback: (input: unknown) => unknown;
      FirstPassSupportError: new (...args: unknown[]) => Error;
    };
    expect(() =>
      classifyDocumentationPartialFallback({
        support: {
          schemaVersion: 1,
          kind: "docsfab-documentation-partial-result",
          publicationEligible: false,
          applicability: "useful-partial",
        },
        instruction: INSTALL_INSTRUCTION,
        authorizedWriteRoots: ["docs/", "fern/"],
      }),
    ).toThrow(FirstPassSupportError);
  });

  it("budget-exhaustion continues with the obligations the model could not assess named", async () => {
    const setup = await workspace({
      readme: "# Widget\n\nInstall on Linux with `apt install widget`.\n",
    });
    const { binding } = await expectContinued(setup, INSTALL_INSTRUCTION, "budget");
    const lines = binding?.firstPassEvidenceWarnings ?? [];
    expect(lines[0]).toMatch(
      / It ended budget-exhausted: an evidence bound stopped its reading\./u,
    );
    expect(lines).toContain(
      "first-pass-evidence-gaps: obligation decomposed-linux is budget-exhausted.",
    );
  });
});

/** A first pass that continued past evidence gaps, and the status lines it printed. */
async function expectContinued(
  setup: { workspace: string; stateDirectory: string },
  instruction: string,
  variant: "full" | "missing-macos" | "contradict" | "no-facts" | "budget",
): Promise<{
  binding: Awaited<ReturnType<typeof bindFirstPassKnowledge>>;
  statuses: string[];
}> {
  const statuses: string[] = [];
  const binding = await bindFirstPassKnowledge({
    request: request(instruction),
    config: stubConfig(setup.stateDirectory),
    workspacePath: setup.workspace,
    revision: REVISION,
    status: (message) => statuses.push(message),
    supportModelBridge: installBridge(variant),
  });
  expect(binding?.firstPassEvidenceWarnings?.length).toBeGreaterThan(0);
  return { binding, statuses };
}

async function expectInsufficient(
  setup: { workspace: string; stateDirectory: string },
  instruction: string,
  variant: "full" | "missing-macos" | "contradict" | "no-facts" | "budget",
  code: FirstPassSupportValidationError["code"] = "insufficient-evidence",
): Promise<FirstPassSupportValidationError> {
  const caught = await bindFirstPassKnowledge({
    request: request(instruction),
    config: stubConfig(setup.stateDirectory),
    workspacePath: setup.workspace,
    revision: REVISION,
    status: () => undefined,
    supportModelBridge: installBridge(variant),
  }).catch((error: unknown) => error);
  expect(caught).toBeInstanceOf(FirstPassSupportValidationError);
  const error = caught as FirstPassSupportValidationError;
  expect(error.code).toBe(code);
  return error;
}

async function workspace(input: { readme: string }): Promise<{
  workspace: string;
  stateDirectory: string;
}> {
  const root = await temporary.create("docsfab-partial-");
  const workspacePath = join(root, "workspace");
  const stateDirectory = join(root, "state", "runs");
  await mkdir(join(workspacePath, "docs"), { recursive: true });
  await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
  await writeFile(join(workspacePath, "README.md"), input.readme);
  return { workspace: workspacePath, stateDirectory };
}

function request(instruction: string): RunRequestWithPublishProjection {
  return {
    workflow: "create-documentation",
    repositoryPath: "/tmp/repo",
    revision: "HEAD",
    instruction,
    allowWrite: true,
    releaseGate: false,
    verbose: false,
    json: false,
    showScan: false,
  };
}

function stubConfig(stateDirectory: string): DocsFabConfig {
  return {
    projectRoot: runtimeRoot,
    skillCrateDirectory: join(runtimeRoot, "skill-crate"),
    qualityDirectory: join(runtimeRoot, "..", "quality"),
    qualityPackDirectory: join(runtimeRoot, "quality-pack"),
    stateDirectory,
    retryPolicy: {
      maxRetries: 0,
      baseDelayMs: 0,
      maxDelayMs: 0,
      retryableCategories: [],
    },
    model: { provider: "none", model: "none" },
  } as unknown as DocsFabConfig;
}

function digestText(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function digestCanonical(value: unknown): string {
  return digestText(canonical(value));
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

function additionalObligations(prompt: string): unknown[] {
  const target = prompt.includes("vendor/get-started.md")
    ? "vendor/get-started.md"
    : "docs/get-started.md";
  const rows: unknown[] = [
    {
      id: "decomposed-linux",
      origin: "inferred",
      instructionQuote: null,
      targetPaths: [target],
      condition: "Linux install uses apt install widget.",
      requiredSourceSupport: true,
    },
  ];
  if (/\bmacos\b/iu.test(prompt)) {
    rows.push({
      id: "decomposed-macos",
      origin: "inferred",
      instructionQuote: null,
      targetPaths: [target],
      condition: "macOS install uses brew install widget.",
      requiredSourceSupport: true,
    });
  }
  rows.push({
    id: "decomposed-verify",
    origin: "inferred",
    instructionQuote: null,
    targetPaths: [target],
    condition: "Verify the installation with widget --version.",
    requiredSourceSupport: true,
  });
  return rows;
}

function installBridge(
  variant: "full" | "missing-macos" | "contradict" | "no-facts" | "budget",
): FirstPassSupportModelBridge {
  let lastIdentitySha256: string | undefined;
  let lastAssessmentBindingSha256: string | undefined;
  return {
    call: async (request: FirstPassSupportModelRequest) => {
      let value: unknown;
      if (request.prompt.startsWith("Phase: obligation-decomposition")) {
        value = {
          schemaVersion: 1,
          additionalObligations: additionalObligations(request.prompt),
        };
      } else if (request.prompt.startsWith("Phase: obligation-completeness-audit")) {
        value = { schemaVersion: 1, complete: true, omissions: [] };
      } else {
        const obligationsLine = request.prompt
          .split("\n")
          .find((line) => line.startsWith("Mandatory obligations: "))!;
        const obligations = JSON.parse(
          obligationsLine.slice("Mandatory obligations: ".length),
        ) as Array<{ id: string; requiredSourceSupport: boolean }>;
        const productSpans = parseEvidenceFrames(request.prompt).filter(
          (frame) => frame.path !== ".docsfab.json",
        );
        const cited = productSpans[0]?.id;
        value = {
          schemaVersion: 1,
          assessments: obligations.map((obligation) => {
            if (!obligation.requiredSourceSupport) {
              return {
                obligationId: obligation.id,
                status: "supported",
                evidenceSpanIds: [],
                detail: "Structural obligation.",
              };
            }
            let status = cited ? "supported" : "missing";
            if (variant === "missing-macos" && obligation.id === "decomposed-macos")
              status = "missing";
            if (
              variant === "contradict" &&
              (obligation.id === "decomposed-linux" || obligation.id === "decomposed-macos")
            ) {
              status = "contradicted";
            }
            if (variant === "no-facts") status = "missing";
            if (variant === "budget") status = "budget-exhausted";
            const supported = status === "supported" && cited !== undefined;
            return {
              obligationId: obligation.id,
              status,
              evidenceSpanIds: supported ? [cited] : [],
              detail: `${status} by scripted install bridge.`,
            };
          }),
        };
      }
      const responseText = JSON.stringify(value);
      const identity = {
        providerId: "scripted-provider",
        modelId: "scripted-model",
        profileSha256: digestText("profile"),
        compositionSha256: null,
        requestPolicySha256: null,
        systemPromptSha256: digestText(request.systemPrompt),
        promptSha256: request.promptSha256,
        procedureSha256: request.procedureSha256,
        responseSha256: digestText(responseText),
        turnEvidenceSha256: digestText("turn-evidence"),
      };
      lastIdentitySha256 = digestCanonical(identity);
      if (!request.prompt.startsWith("Phase:")) {
        lastAssessmentBindingSha256 = firstPassAssessmentBindingSha256(
          request.prompt,
          responseText,
          parseEvidenceFrames,
        );
      }
      return { responseText, identity, usage: { inputTokens: 100, outputTokens: 50 } };
    },
    lastAssessmentIdentitySha256: () => lastIdentitySha256,
    lastAssessmentBindingSha256: () => lastAssessmentBindingSha256,
  };
}

async function readStoredPartial(
  stateDirectory: string,
  locator: string | undefined,
): Promise<string> {
  if (!locator?.startsWith("record:sha256:")) return "";
  const digest = locator.slice("record:sha256:".length);
  const { DurableArtifactStore } = await import("../src/artifacts/store.js");
  const store = new DurableArtifactStore(resolve(dirname(stateDirectory), "artifacts"));
  const record = (await store.getRecord(digest)) as { markdown?: unknown };
  return typeof record.markdown === "string" ? record.markdown : "";
}
