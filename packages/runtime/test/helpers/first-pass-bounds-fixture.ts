// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Repository fixtures and a tool-free model stand-in for first-pass bound
 * tests that run the real knowledge gather and runtime validation.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  firstPassAssessmentBindingSha256,
  type FirstPassInputWindowSource,
  type FirstPassSupportModelBridge,
  type FirstPassSupportModelRequest,
} from "../../src/cli/first-pass-support.js";
import type { CompositionRunRuntime } from "../../src/cli/run/composition-runtime.js";
import type { RunRequestWithPublishProjection } from "../../src/cli/run/request.js";
import type { DocsFabConfig } from "../../src/config/runtime-loader.js";
import type { TrackedSourceReaderV1 } from "../../src/inputs/source-acquisition.js";
import { parseEvidenceFrames } from "./knowledge-evidence-frames.js";
import type { TemporaryRoots } from "./temp.js";

const runtimeRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

export const FIXTURE_REVISION = "e".repeat(40);

export type ModelWindow = { maxInputTokens: number; reservedContextTokens: number };

export type FixtureWorkspace = {
  root: string;
  workspace: string;
  stateDirectory: string;
  tracked: string[];
};

export async function workspaceWith(
  roots: TemporaryRoots,
  files: Record<string, string>,
): Promise<FixtureWorkspace> {
  const root = await roots.create("docsfab-first-pass-bounds-");
  const workspace = join(root, "workspace");
  const stateDirectory = join(root, "state", "runs");
  await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
  for (const [path, text] of Object.entries(files)) {
    await mkdir(dirname(join(workspace, path)), { recursive: true });
    await writeFile(join(workspace, path), text);
  }
  return { root, workspace, stateDirectory, tracked: Object.keys(files).sort() };
}

/** The workspace reader with the tracked inventory first pass ranks. */
export function inventoryReader(paths: readonly string[]): TrackedSourceReaderV1 {
  const tracked = new Set(paths);
  return {
    isTrackedRegularFile: async (repositoryPath: string) => tracked.has(repositoryPath),
    readTrackedBytes: async () => {
      throw new Error("first-pass never reads through the tracked reader");
    },
    listTrackedRegularFiles: async () => [...paths],
  };
}

export type RetainedSupport = {
  terminationReason: string;
  limits: {
    maxRounds: number;
    maxPresentedBytes: number;
    maxSpans: number;
    maxSourceFiles: number;
  };
  cost: {
    presentedBytes: number;
    rounds: number;
    spans: number;
    sourceFiles: number;
    scannedFiles: number;
    modelTurns: number;
  };
  exhaustedBounds?: Array<{ bound: string; observed: number; limit: number }>;
  unreadFiles?: { count: number; namedPaths: string[] };
  namedSourceGaps?: Array<{ path: string; reason: string }>;
  obligations: Array<{ id: string; status: string; requiredSourceSupport: boolean }>;
};

export async function retainedSupport(root: string): Promise<RetainedSupport> {
  return JSON.parse(
    await readFile(
      join(
        root,
        "state",
        "knowledge",
        "first-pass",
        FIXTURE_REVISION,
        "docsfab-first-pass-support.json",
      ),
      "utf8",
    ),
  ) as RetainedSupport;
}

/**
 * The binding context. `endpointWindow` puts a window in the configured
 * endpoint's profile, which first pass must not size its prompt from.
 */
export function bindingContext(
  workspace: { workspace: string; stateDirectory: string },
  endpointWindow?: ModelWindow,
) {
  return {
    config: {
      projectRoot: runtimeRoot,
      skillCrateDirectory: join(runtimeRoot, "skill-crate"),
      qualityDirectory: join(runtimeRoot, "..", "quality"),
      qualityPackDirectory: join(runtimeRoot, "quality-pack"),
      stateDirectory: workspace.stateDirectory,
      retryPolicy: { maxRetries: 0, baseDelayMs: 0, maxDelayMs: 0, retryableCategories: [] },
      model: {
        provider: "none",
        model: "none",
        ...(endpointWindow
          ? {
              profile: { maxInputTokens: endpointWindow.maxInputTokens },
              requestPolicy: {
                reservedContextTokens: endpointWindow.reservedContextTokens,
                minimumOutputTokens: 1,
              },
            }
          : {}),
      },
    } as unknown as DocsFabConfig,
    workspacePath: workspace.workspace,
    revision: FIXTURE_REVISION,
    status: () => undefined,
  };
}

/** A bound profile whose window an installed composition attests. */
export function attested(window: ModelWindow): FirstPassInputWindowSource & {
  readonly requestPolicy: { readonly reservedContextTokens: number; minimumOutputTokens: number };
} {
  return {
    profile: {
      maxInputTokens: window.maxInputTokens,
      effectiveLimitReason: "composition-candidate",
    },
    requestPolicy: { reservedContextTokens: window.reservedContextTokens, minimumOutputTokens: 1 },
  };
}

/** A selected composition whose bound profile attests `window`. */
export function compositionWith(window: ModelWindow): {
  compositionRuntime: CompositionRunRuntime;
} {
  return {
    compositionRuntime: { executionProfile: attested(window) } as unknown as CompositionRunRuntime,
  };
}

export function updateRequest(instruction: string): RunRequestWithPublishProjection {
  return {
    workflow: "update-documentation",
    repositoryPath: "/repository",
    revision: "HEAD",
    instruction,
    allowWrite: true,
    releaseGate: false,
    verbose: false,
    json: false,
    showScan: false,
  };
}

export type Assessment = {
  status: "supported" | "missing" | "unavailable";
  evidenceSpanIds: string[];
  detail: string;
};

export const supported = (spanId: string): Assessment => ({
  status: "supported",
  evidenceSpanIds: [spanId],
  detail: "The offered source supports it.",
});

export const missing = (detail: string): Assessment => ({
  status: "missing",
  evidenceSpanIds: [],
  detail,
});

/** Supported once a span of `sourcePath` is offered. */
export function implementationBridge(sourcePath: string): FirstPassSupportModelBridge {
  return scriptedBridge({
    obligations: [
      {
        id: "decomposed-implementation",
        condition: "The page describes the behavior the implementation source sets.",
      },
    ],
    assess: (_id, spanByPath) => {
      const span = spanByPath.get(sourcePath);
      return span ? supported(span) : missing("No implementation source was offered.");
    },
  });
}

/**
 * A tool-free model stand-in: inferred obligations for the first target, each
 * assessed by `assess`; every seeded obligation cites its own page unless
 * `seeded` assesses it.
 */
export function scriptedBridge(input: {
  readonly obligations: readonly {
    id: string;
    condition: string;
    /** Omitted, the obligation needs source support. */
    requiredSourceSupport?: boolean;
  }[];
  readonly assess: (
    obligationId: string,
    spanByPath: ReadonlyMap<string, string>,
    frames: readonly { id: string; path: string }[],
  ) => Assessment;
  /** A seeded obligation's assessment, or undefined for the default. */
  readonly seeded?: (
    obligation: { id: string; targetPaths: readonly string[] },
    spanByPath: ReadonlyMap<string, string>,
  ) => Assessment | undefined;
}): FirstPassSupportModelBridge {
  let lastIdentitySha256: string | undefined;
  let lastAssessmentBindingSha256: string | undefined;
  const inferred = new Set(input.obligations.map(({ id }) => id));
  return {
    call: async (request: FirstPassSupportModelRequest) => {
      let value: unknown;
      if (request.prompt.startsWith("Phase: obligation-decomposition")) {
        const targets = JSON.parse(lineAfter(request.prompt, "Exact write targets: ")) as string[];
        value = {
          schemaVersion: 1,
          additionalObligations: input.obligations.map(
            ({ id, condition, requiredSourceSupport }) => ({
              id,
              origin: "inferred",
              instructionQuote: null,
              targetPaths: [targets[0]],
              condition,
              requiredSourceSupport: requiredSourceSupport ?? true,
            }),
          ),
        };
      } else if (request.prompt.startsWith("Phase: obligation-completeness-audit")) {
        value = { schemaVersion: 1, complete: true, omissions: [] };
      } else {
        const obligations = JSON.parse(
          lineAfter(request.prompt, "Mandatory obligations: "),
        ) as Array<{
          id: string;
          targetPaths: string[];
          requiredSourceSupport: boolean;
        }>;
        const frames = parseEvidenceFrames(request.prompt);
        const spanByPath = new Map(frames.map((frame) => [frame.path, frame.id]));
        value = {
          schemaVersion: 1,
          assessments: obligations.map((obligation) => {
            if (inferred.has(obligation.id)) {
              return {
                obligationId: obligation.id,
                ...input.assess(obligation.id, spanByPath, frames),
              };
            }
            const scripted = input.seeded?.(obligation, spanByPath);
            if (scripted) return { obligationId: obligation.id, ...scripted };
            const page = spanByPath.get(obligation.targetPaths[0]!);
            return {
              obligationId: obligation.id,
              status: "supported",
              evidenceSpanIds: obligation.requiredSourceSupport && page ? [page] : [],
              detail: "Supported by the offered page.",
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
      lastIdentitySha256 = digestText(canonical(identity));
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

function lineAfter(prompt: string, prefix: string): string {
  return prompt
    .split("\n")
    .find((line) => line.startsWith(prefix))!
    .slice(prefix.length);
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

function digestText(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
