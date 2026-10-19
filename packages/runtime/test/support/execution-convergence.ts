// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { DocsFabConfig } from "../../src/config/runtime-loader.js";
import {
  digest,
  parseHostRuntimeRequest,
  sealHostRuntimeComposition,
  type HostRuntimeRequestV1,
} from "../../src/host-invoker/contracts.js";
import { getWorkflow } from "../../src/workflow-registry/catalog.js";
import { grantedTools } from "../../src/harness/pi-tool-confine.js";
import { validModelConfig } from "../helpers.js";
import { commitFixture, git, initFixtureRepo } from "../helpers/git.js";

const runtimeRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const fixtureRoot = join(runtimeRoot, "test", "fixtures", "execution-convergence");
const safeToken = /^[#A-Za-z0-9][A-Za-z0-9._#-]{0,127}$/u;
const safePath = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9._/-]+$/u;

export interface BaselineScenario {
  id: string;
  entryAdapter: string;
  caseRef: string;
  operation: string;
  status: string;
  source: string;
  artifact: string;
  authority: string;
  retention: string;
  knownDefect?: { issue: string; signature: string; normativeStatus: string };
}

export interface BaselineObservation {
  status: string;
  source: string;
  artifact: string;
  authority: string;
  retention: string;
  defectSignature?: string;
}

export interface BaselineSummary {
  requiredPass: number;
  knownDefect: number;
  failed: number;
}

export interface BaselineManifest {
  schemaVersion: 1;
  evidenceClass: "deterministic-fixture";
  scenarios: BaselineScenario[];
}

const manifestKeys = ["schemaVersion", "evidenceClass", "scenarios"].sort();
const scenarioKeys = [
  "artifact",
  "authority",
  "caseRef",
  "entryAdapter",
  "id",
  "knownDefect",
  "operation",
  "retention",
  "source",
  "status",
].sort();

export async function loadBaselineManifest(): Promise<BaselineManifest> {
  return decodeBaselineManifest(
    JSON.parse(await readFile(join(fixtureRoot, "baseline.json"), "utf8")) as unknown,
  );
}

export function decodeBaselineManifest(value: unknown): BaselineManifest {
  if (!isPlainObject(value)) throw new Error("baseline manifest must be an object");
  assertKeys(value, manifestKeys, "manifest");
  if (value.schemaVersion !== 1 || value.evidenceClass !== "deterministic-fixture") {
    throw new Error("baseline manifest identity is invalid");
  }
  if (!Array.isArray(value.scenarios) || value.scenarios.length === 0) {
    throw new Error("baseline manifest requires scenarios");
  }
  const seen = new Set<string>();
  const scenarios = value.scenarios.map((candidate) => {
    if (!isPlainObject(candidate)) throw new Error("baseline scenario must be an object");
    const allowed =
      candidate.knownDefect === undefined
        ? scenarioKeys.filter((key) => key !== "knownDefect")
        : scenarioKeys;
    assertKeys(candidate, allowed, "scenario");
    for (const field of allowed.filter((key) => key !== "knownDefect")) {
      if (typeof candidate[field] !== "string" || !safeToken.test(candidate[field])) {
        throw new Error(`baseline scenario ${field} is invalid`);
      }
    }
    if (seen.has(candidate.id as string)) throw new Error("baseline scenario IDs must be unique");
    seen.add(candidate.id as string);
    if (candidate.knownDefect !== undefined) {
      if (!isPlainObject(candidate.knownDefect)) throw new Error("known defect is invalid");
      assertKeys(candidate.knownDefect, ["issue", "normativeStatus", "signature"], "known defect");
      if (
        typeof candidate.knownDefect.issue !== "string" ||
        !/^#[1-9][0-9]*$/u.test(candidate.knownDefect.issue) ||
        typeof candidate.knownDefect.signature !== "string" ||
        !safeToken.test(candidate.knownDefect.signature) ||
        typeof candidate.knownDefect.normativeStatus !== "string" ||
        !safeToken.test(candidate.knownDefect.normativeStatus)
      ) {
        throw new Error("known defect requires an issue and exact signature");
      }
    }
    return candidate as unknown as BaselineScenario;
  });
  return { schemaVersion: 1, evidenceClass: "deterministic-fixture", scenarios };
}

export function summarizeBaselineObservations(
  manifest: BaselineManifest,
  observations: ReadonlyMap<string, BaselineObservation>,
): BaselineSummary {
  const summary: BaselineSummary = { requiredPass: 0, knownDefect: 0, failed: 0 };
  const failures: string[] = [];
  for (const scenario of manifest.scenarios) {
    const observed = observations.get(scenario.id);
    if (!observed) {
      summary.failed += 1;
      failures.push(`${scenario.id}:missing-observation`);
      continue;
    }
    if (scenario.knownDefect && observed.status === scenario.knownDefect.normativeStatus) {
      summary.failed += 1;
      failures.push(`${scenario.id}:stale-known-defect:${scenario.knownDefect.issue}`);
      continue;
    }
    const expected = {
      status: scenario.status,
      source: scenario.source,
      artifact: scenario.artifact,
      authority: scenario.authority,
      retention: scenario.retention,
    };
    const actual = {
      status: observed.status,
      source: observed.source,
      artifact: observed.artifact,
      authority: observed.authority,
      retention: observed.retention,
    };
    if (
      JSON.stringify(actual) !== JSON.stringify(expected) ||
      (scenario.knownDefect
        ? observed.defectSignature !== scenario.knownDefect.signature
        : observed.defectSignature !== undefined)
    ) {
      summary.failed += 1;
      failures.push(`${scenario.id}:expectation-mismatch`);
      continue;
    }
    if (scenario.knownDefect) summary.knownDefect += 1;
    else summary.requiredPass += 1;
  }
  for (const id of observations.keys()) {
    if (!manifest.scenarios.some((scenario) => scenario.id === id)) {
      summary.failed += 1;
      failures.push(`${id}:unknown-observation`);
    }
  }
  if (failures.length > 0) {
    throw new Error(
      `baseline observations failed (${summary.requiredPass} required-pass, ${summary.knownDefect} known-defect, ${summary.failed} failed): ${failures.join(", ")}`,
    );
  }
  return summary;
}

export async function createFixtureRepository(
  seed: "documented" | "documented-html" | "intent-gap",
): Promise<{
  root: string;
  repository: string;
  stateDirectory: string;
  revision: string;
  tree: string;
}> {
  if (!safePath.test(seed)) throw new Error("unsafe convergence seed");
  const root = await mkdtemp(join(tmpdir(), "docsfab-convergence-"));
  const repository = join(root, "repository");
  const stateDirectory = join(root, "state", "runs");
  await cp(join(fixtureRoot, "repositories", seed), repository, { recursive: true });
  await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
  await initFixtureRepo(repository, undefined, { branch: "main" });
  const revision = await commitFixture(repository, "fixture baseline");
  const tree = await git(repository, ["rev-parse", "HEAD^{tree}"]);
  return { root, repository, stateDirectory, revision, tree };
}

export async function removeFixture(root: string): Promise<void> {
  await rm(root, { recursive: true, force: true });
}

export interface GitSnapshot {
  head: string;
  tree: string;
  index: string;
  worktree: string;
  untracked: Record<string, string>;
}

export async function captureGitSnapshot(repository: string): Promise<GitSnapshot> {
  const names = (await git(repository, ["ls-files", "--others", "--exclude-standard"]))
    .split("\n")
    .filter(Boolean)
    .sort();
  return {
    head: await git(repository, ["rev-parse", "HEAD"]),
    tree: await git(repository, ["rev-parse", "HEAD^{tree}"]),
    index: await git(repository, ["diff", "--cached", "--binary"]),
    worktree: await git(repository, ["diff", "--binary"]),
    untracked: Object.fromEntries(
      await Promise.all(
        names.map(async (name) => [
          name,
          createHash("sha256")
            .update(await readFile(join(repository, name)))
            .digest("hex"),
        ]),
      ),
    ),
  };
}

export function runtimeConfig(stateDirectory: string): DocsFabConfig {
  return {
    projectRoot: runtimeRoot,
    skillCrateDirectory: join(runtimeRoot, "skill-crate"),
    qualityDirectory: join(runtimeRoot, "quality"),
    qualityPackDirectory: join(runtimeRoot, "quality-pack"),
    stateDirectory,
    retryPolicy: { maxRetries: 0, baseDelayMs: 0, maxDelayMs: 0, retryableCategories: [] },
    model: validModelConfig,
  };
}

export function hostedReadinessRequest(input: {
  repository: string;
  stateDirectory: string;
  revision: string;
  tree: string;
  workflow?: "readiness" | "site-bootstrap";
}): HostRuntimeRequestV1 {
  const workflow = getWorkflow(input.workflow ?? "readiness");
  const stepIds = workflow.steps.map((step) => step.id);
  const tools = [
    ...new Set(workflow.steps.flatMap((step) => grantedTools(step.mode, step.kind, step.search))),
  ].sort();
  const composition = sealHostRuntimeComposition({
    compositionId: "execution-convergence-offline-v1",
    route: "offline-fixture",
    credentialFamily: "none",
    executionProfile: null,
    declaredTools: tools,
  });
  const selectedEvidence = [{ evidenceId: "fixture-product", content: "Bounded fixture context." }];
  const receiptSha256 = "d".repeat(64);
  const expiresAt = "2099-01-01T00:00:00.000Z";
  const inputContent = '{"schemaVersion":1,"kind":"fixture-input"}\n';
  return parseHostRuntimeRequest({
    schemaVersion: 1,
    kind: "docsfab-host-runtime-request",
    deploymentId: "deployment-fixture",
    projectId: "project-fixture",
    deploymentEpoch: "epoch-fixture",
    requestKey: "request-fixture",
    origin: { principalId: "principal-fixture", requestId: "origin-fixture" },
    runId: `convergence-${workflow.name}`,
    fence: 1,
    workflow: workflow.name,
    revision: input.revision,
    sourceTreeObjectId: input.tree,
    packet: {
      packetFingerprintSha256: "e".repeat(64),
      inputManifest: {
        kind: "input-manifest",
        sha256: createHash("sha256").update(inputContent).digest("hex"),
        sourcePathSha256: createHash("sha256").update("docs/input.json").digest("hex"),
        gitObjectId: "b".repeat(40),
        content: inputContent,
      },
      canon: null,
      reviewEvent: null,
    },
    stepIds,
    toolPolicySha256: digest({ workflow: workflow.name, stepIds, declaredTools: tools }),
    workspacePath: input.repository,
    stateDirectory: input.stateDirectory,
    capsule: {
      sha256: digest({ receiptSha256, expiresAt, selectedEvidence }),
      receiptSha256,
      expiresAt,
      selectedEvidence,
    },
    composition,
    allowWrite: false,
  });
}

export function scriptedProvider(responses: readonly Response[]): typeof fetch {
  let index = 0;
  return async () => {
    const response = responses[index++];
    if (!response) throw new Error("unexpected deterministic provider request");
    return response.clone();
  };
}

export function reasoningToolTurn(reasoning: string, callId: string): Response {
  return sseResponse([
    {
      id: `reasoning-${callId}`,
      object: "chat.completion.chunk",
      created: 1,
      model: validModelConfig.modelId,
      choices: [
        {
          index: 0,
          delta: { role: "assistant", reasoning_content: reasoning },
          finish_reason: null,
        },
      ],
    },
    {
      id: `reasoning-${callId}`,
      object: "chat.completion.chunk",
      created: 1,
      model: validModelConfig.modelId,
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index: 0,
                id: callId,
                type: "function",
                function: { name: "read", arguments: JSON.stringify({ path: "README.md" }) },
              },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    },
  ]);
}

export function textTurn(text: string): Response {
  return sseResponse([
    {
      id: "completion-text-turn",
      object: "chat.completion.chunk",
      created: 2,
      model: validModelConfig.modelId,
      choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }],
    },
    {
      id: "completion-text-turn",
      object: "chat.completion.chunk",
      created: 2,
      model: validModelConfig.modelId,
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    },
  ]);
}

function sseResponse(chunks: readonly object[]): Response {
  return new Response(
    [...chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`), "data: [DONE]\n\n"].join(""),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function assertKeys(value: Record<string, unknown>, expected: string[], label: string): void {
  const actual = Object.keys(value).sort();
  if (JSON.stringify(actual) !== JSON.stringify([...expected].sort())) {
    throw new Error(`${label} keys are invalid`);
  }
}
