// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { generateKeyPairSync } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import {
  createArtifact,
  DurableArtifactStore,
  recomputeNavigationMetrics,
  type Artifact,
  type ArtifactReference,
  type NavigationEvaluationPayload,
} from "../src/artifacts/index.js";
import {
  buildContentIndex,
  type ContentIndexV1,
  type DocumentNode,
} from "../src/content-ir/index.js";
import type { HarnessStepInput } from "../src/execution/contracts.js";
import {
  approveIaPlanForBootstrap,
  DEFAULT_IA_NAVIGATION_TASKS,
  inspectIaLifecycleInput,
  LocalIaAnalysisOutputPublisher,
  provisionDefaultIaAnalysisInput,
  provisionIaPlanningInputFromAnalysis,
} from "../src/ia/lifecycle.js";
import { iaPlanReviewerPolicyDigest } from "../src/ia/plan-review.js";
import { IaPlanningHostOperation } from "../src/ia/operation.js";
import { LocalIaPlanningInputProvider } from "../src/ia/input-provider.js";
import {
  TPL_DESIGN_IA_EVALUATION_ID,
  TPL_DESIGN_IA_EVALUATION_VERSION,
  TPL_DESIGN_IA_PROVENANCE_STATUS,
  TPL_DESIGN_IA_SKILL,
  TPL_DESIGN_IA_SKILL_VERSION,
  tplDesignIaDigest,
} from "../src/skills/tpl-design-ia/index.js";
import { getWorkflow } from "../src/workflow-registry/catalog.js";
import { validModelEnvironment } from "./helpers.js";

const REVISION = "a".repeat(40);
const NOW = new Date("2026-08-05T12:00:00.000Z");
const EXPIRES = "2099-08-10T12:00:00.000Z";
const TASK = { kind: "ia-plan", scope: "site", mode: "create" } as const;
const roots: string[] = [];
const execFile = promisify(execFileCallback);
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = resolve(repositoryRoot, "src/cli.ts");
const tsxLoader = createRequire(import.meta.url).resolve("tsx/esm");
/** Real CLI / git identity suites need headroom under parallel Vitest workers. */
const HEAVY_SUITE_TIMEOUT_MS = 180_000;

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("self-service IA lifecycle", { timeout: HEAVY_SUITE_TIMEOUT_MS }, () => {
  it("provisions, inspects, analyzes, plans, approves, rejects stale state, and hands off bootstrap", async () => {
    const fixture = await repositoryFixture();
    const before = await sourceSnapshot(fixture.repositoryPath);
    const index = await buildContentIndex({
      repositoryPath: fixture.repositoryPath,
      repositoryRevision: REVISION,
    });
    const identity = "1".repeat(64);

    const created = await provisionDefaultIaAnalysisInput({
      packageRoot: join(fixture.stateRoot, "ia-analysis-inputs", identity),
      repositoryPath: fixture.repositoryPath,
      repositoryRevision: REVISION,
      repositoryIdentity: identity,
      task: TASK,
      expiresAt: EXPIRES,
      now: NOW,
    });
    const replay = await provisionDefaultIaAnalysisInput({
      packageRoot: join(fixture.stateRoot, "ia-analysis-inputs", identity),
      repositoryPath: fixture.repositoryPath,
      repositoryRevision: REVISION,
      repositoryIdentity: identity,
      task: TASK,
      expiresAt: EXPIRES,
      now: NOW,
    });
    expect(created).toMatchObject({
      created: true,
      repositoryIdentity: identity,
      expiresAt: EXPIRES,
    });
    expect(replay).toMatchObject({ created: false, digest: created.digest });
    expect(
      await inspectIaLifecycleInput({
        packageKind: "analysis-input",
        packageRoot: join(fixture.stateRoot, "ia-analysis-inputs", identity),
        repositoryPath: fixture.repositoryPath,
        repositoryRevision: REVISION,
        repositoryIdentity: identity,
        task: TASK,
        now: NOW,
      }),
    ).toMatchObject({ disposition: "ready", package: { digest: created.digest } });

    const analysis = analysisOutput(index);
    const publisher = new LocalIaAnalysisOutputPublisher(
      join(fixture.stateRoot, "ia-analysis-outputs", identity),
      identity,
    );
    await publisher.publish({
      runId: "analysis-1",
      index,
      task: TASK,
      result: analysis.result,
      artifacts: analysis.artifacts,
      navigationTasks: [...DEFAULT_IA_NAVIGATION_TASKS],
      inputPackage: { digest: created.digest, repositoryIdentity: identity, expiresAt: EXPIRES },
    });
    const planningReceipt = await provisionIaPlanningInputFromAnalysis({
      analysisOutputRoot: join(fixture.stateRoot, "ia-analysis-outputs", identity),
      planningInputRoot: join(fixture.stateRoot, "ia-inputs", identity),
      repositoryPath: fixture.repositoryPath,
      repositoryRevision: REVISION,
      repositoryIdentity: identity,
      task: TASK,
      analysisRunId: "analysis-1",
      projectRoot: resolve("."),
      now: NOW,
    });
    expect(planningReceipt).toMatchObject({
      planningOutcome: "plan-ready",
      analysisRunId: "analysis-1",
      created: true,
    });

    const store = new DurableArtifactStore(join(fixture.stateRoot, "artifacts"));
    const operation = new IaPlanningHostOperation({
      artifactStore: store,
      inputProvider: new LocalIaPlanningInputProvider({
        packageRoot: join(fixture.stateRoot, "ia-inputs", identity),
        repositoryRevision: REVISION,
        repositoryIdentity: identity,
        now: () => NOW,
      }),
    });
    const workflow = getWorkflow("ia-plan");
    const planResult = await operation.runStep({
      repositoryPath: fixture.repositoryPath,
      workflow,
      step: workflow.steps[0]!,
      task: TASK,
    } satisfies HarnessStepInput);
    const planReference = planResult.artifacts.find(
      (item) => item.role === "output" && item.reference.kind === "ia-plan",
    )?.reference;
    expect(planResult).toMatchObject({ planningOutcome: "plan-ready", outcome: "succeeded" });
    expect(planReference).toBeDefined();

    await mkdir(join(fixture.stateRoot, "runs"), { mode: 0o700 });
    await writeFile(
      join(fixture.stateRoot, "runs", "planning-1.json"),
      JSON.stringify({
        id: "planning-1",
        workflow: "ia-plan",
        repository: { revision: REVISION },
        artifacts: [{ role: "output", reference: planReference }],
      }),
      { mode: 0o600 },
    );
    const keys = generateKeyPairSync("ed25519");
    const policyValue = {
      id: "docsfab:ia-reviewers",
      version: "1",
      reviewers: [
        {
          id: "maintainer:docs",
          role: "maintainer" as const,
          publicKey: keys.publicKey.export({ type: "spki", format: "pem" }).toString(),
        },
      ],
    };
    const policy = { ...policyValue, digest: iaPlanReviewerPolicyDigest(policyValue) };
    const policyPath = join(
      fixture.root,
      "reviewer's policy; $(touch HANDOFF_INJECTED) `touch HANDOFF_INJECTED2` *.json",
    );
    const keyPath = join(
      fixture.root,
      "reviewer's key; $(touch KEY_INJECTED) `touch KEY_INJECTED2` *.pem",
    );
    await writeFile(policyPath, JSON.stringify(policy), { mode: 0o600 });
    await writeFile(keyPath, keys.privateKey.export({ type: "pkcs8", format: "pem" }), {
      mode: 0o600,
    });
    const handoff = await approveIaPlanForBootstrap({
      stateRoot: fixture.stateRoot,
      repositoryPath: fixture.repositoryPath,
      repositoryRevision: REVISION,
      repositoryIdentity: identity,
      task: TASK,
      planningRunId: "planning-1",
      reviewerPolicyPath: policyPath,
      reviewerId: "maintainer:docs",
      privateKeyPath: keyPath,
      now: NOW,
    });
    expect(handoff).toMatchObject({
      disposition: "approved",
      repositoryRevision: REVISION,
      writesAuthorized: false,
    });
    expect(handoff.nextCommand).toContain("--allow-write");
    const binRoot = join(fixture.root, "handoff-bin");
    const capture = join(fixture.root, "handoff-arguments.txt");
    await mkdir(binRoot, { mode: 0o700 });
    await writeFile(
      join(binRoot, "docsfab"),
      ["#!/bin/sh", 'printf \'%s\\n\' "$@" > "$DOCSFAB_CAPTURE"', ""].join("\n"),
      { mode: 0o700 },
    );
    await execFile("/bin/sh", ["-c", handoff.nextCommand], {
      cwd: fixture.repositoryPath,
      env: {
        PATH: `${binRoot}:${process.env.PATH ?? ""}`,
        DOCSFAB_CAPTURE: capture,
      },
    });
    const handoffArguments = (await readFile(capture, "utf8")).trimEnd().split("\n");
    expect(handoffArguments).toEqual([
      "run",
      "site-bootstrap",
      "--repo",
      fixture.repositoryPath,
      "--revision",
      REVISION,
      "--plan",
      handoff.applicationPath,
      "--reviewer-policy",
      policyPath,
      "--allow-write",
    ]);
    for (const marker of [
      "HANDOFF_INJECTED",
      "HANDOFF_INJECTED2",
      "KEY_INJECTED",
      "KEY_INJECTED2",
    ]) {
      await expect(readFile(join(fixture.repositoryPath, marker))).rejects.toMatchObject({
        code: "ENOENT",
      });
    }
    expect(JSON.parse(await readFile(handoff.applicationPath, "utf8"))).toMatchObject({
      kind: "site-bootstrap-application",
      digest: handoff.applicationDigest,
    });
    const attackerKeys = generateKeyPairSync("ed25519");
    const attackerKeyPath = join(fixture.root, "attacker.pem");
    await writeFile(
      attackerKeyPath,
      attackerKeys.privateKey.export({
        type: "pkcs8",
        format: "pem",
      }),
      { mode: 0o600 },
    );
    await expect(
      approveIaPlanForBootstrap({
        stateRoot: fixture.stateRoot,
        repositoryPath: fixture.repositoryPath,
        repositoryRevision: REVISION,
        repositoryIdentity: identity,
        task: TASK,
        planningRunId: "planning-1",
        reviewerPolicyPath: policyPath,
        reviewerId: "maintainer:docs",
        privateKeyPath: attackerKeyPath,
        now: NOW,
      }),
    ).rejects.toThrow("invalid-authority");

    await writeFile(join(fixture.repositoryPath, "connect.md"), "# Changed\n", "utf8");
    expect(
      await inspectIaLifecycleInput({
        packageKind: "planning-input",
        packageRoot: join(fixture.stateRoot, "ia-inputs", identity),
        repositoryPath: fixture.repositoryPath,
        repositoryRevision: REVISION,
        repositoryIdentity: identity,
        task: TASK,
        now: NOW,
      }),
    ).toMatchObject({ disposition: "stale-package" });
    await writeFile(join(fixture.repositoryPath, "connect.md"), before["connect.md"]!, "utf8");
    expect(await sourceSnapshot(fixture.repositoryPath)).toEqual(before);
  });

  it("fails closed for expiry, repository substitution, tamper, and insecure permissions", async () => {
    const fixture = await repositoryFixture();
    const identity = "1".repeat(64);
    const receipt = await provisionDefaultIaAnalysisInput({
      packageRoot: join(fixture.stateRoot, "ia-analysis-inputs", identity),
      repositoryPath: fixture.repositoryPath,
      repositoryRevision: REVISION,
      repositoryIdentity: identity,
      task: TASK,
      expiresAt: "2026-08-06T12:00:00.000Z",
      now: NOW,
    });
    expect(
      await inspectIaLifecycleInput({
        packageKind: "planning-input",
        packageRoot: join(fixture.stateRoot, "ia-inputs", identity),
        repositoryPath: fixture.repositoryPath,
        repositoryRevision: REVISION,
        repositoryIdentity: identity,
        task: TASK,
        now: NOW,
      }),
    ).toMatchObject({ disposition: "missing-package" });
    expect(
      await inspectIaLifecycleInput({
        packageKind: "analysis-input",
        packageRoot: join(fixture.stateRoot, "ia-analysis-inputs", identity),
        repositoryPath: fixture.repositoryPath,
        repositoryRevision: REVISION,
        repositoryIdentity: "2".repeat(64),
        task: TASK,
        now: NOW,
      }),
    ).toMatchObject({ disposition: "wrong-repository" });
    expect(
      await inspectIaLifecycleInput({
        packageKind: "analysis-input",
        packageRoot: join(fixture.stateRoot, "ia-analysis-inputs", identity),
        repositoryPath: fixture.repositoryPath,
        repositoryRevision: "b".repeat(40),
        repositoryIdentity: identity,
        task: TASK,
        now: NOW,
      }),
    ).toMatchObject({ disposition: "wrong-revision" });
    expect(
      await inspectIaLifecycleInput({
        packageKind: "analysis-input",
        packageRoot: join(fixture.stateRoot, "ia-analysis-inputs", identity),
        repositoryPath: fixture.repositoryPath,
        repositoryRevision: REVISION,
        repositoryIdentity: identity,
        task: TASK,
        now: new Date("2026-08-07T12:00:00.000Z"),
      }),
    ).toMatchObject({ disposition: "expired" });

    const value = JSON.parse(await readFile(receipt.path, "utf8")) as {
      navigationTasks: Array<{ query: string }>;
    };
    value.navigationTasks[0]!.query = "tampered";
    await writeFile(receipt.path, JSON.stringify(value), { mode: 0o600 });
    expect(
      await inspectIaLifecycleInput({
        packageKind: "analysis-input",
        packageRoot: join(fixture.stateRoot, "ia-analysis-inputs", identity),
        repositoryPath: fixture.repositoryPath,
        repositoryRevision: REVISION,
        repositoryIdentity: identity,
        task: TASK,
        now: NOW,
      }),
    ).toMatchObject({ disposition: "invalid-package" });
    await chmod(receipt.path, 0o644);
    expect(
      await inspectIaLifecycleInput({
        packageKind: "analysis-input",
        packageRoot: join(fixture.stateRoot, "ia-analysis-inputs", identity),
        repositoryPath: fixture.repositoryPath,
        repositoryRevision: REVISION,
        repositoryIdentity: identity,
        task: TASK,
        now: NOW,
      }),
    ).toMatchObject({ disposition: "invalid-package" });
  });

  it("fails closed because IA is not bound to a catalog skill", async () => {
    await expect(
      execFile(
        process.execPath,
        ["--import", tsxLoader, cliPath, "ia", "input", "provision", "analysis"],
        {
          env: { ...process.env, ...validModelEnvironment },
          maxBuffer: 1024 * 1024,
        },
      ),
    ).rejects.toThrow(/not bound to a catalog skill/u);
  });
});

async function repositoryFixture(): Promise<{
  root: string;
  repositoryPath: string;
  stateRoot: string;
}> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "docsfab-ia-lifecycle-")));
  roots.push(root);
  const repositoryPath = join(root, "repository");
  const stateRoot = join(root, "state");
  await mkdir(repositoryPath, { mode: 0o700 });
  await mkdir(stateRoot, { mode: 0o700 });
  await writeFile(join(repositoryPath, "README.md"), "# Product\n\nStart here.\n");
  await writeFile(join(repositoryPath, "connect.md"), "# Connect\n\nConnect a cluster.\n");
  await writeFile(join(repositoryPath, "publish.md"), "# Publish\n\nPublish a service.\n");
  return { root, repositoryPath, stateRoot };
}

function analysisOutput(index: ContentIndexV1): {
  artifacts: Artifact[];
  result: Parameters<LocalIaAnalysisOutputPublisher["publish"]>[0]["result"];
} {
  const documents = index.nodes
    .filter((node): node is DocumentNode => node.kind === "document")
    .sort((left, right) => left.sourcePath.localeCompare(right.sourcePath));
  const readme = documents.find((item) => item.sourcePath === "README.md")!;
  const connect = documents.find((item) => item.sourcePath === "connect.md")!;
  const publish = documents.find((item) => item.sourcePath === "publish.md")!;
  const evidence = (node: DocumentNode) => [{ path: node.sourcePath, nodeId: node.id }];
  const ontology = createArtifact(
    "ontology",
    {
      entities: [
        { id: "entity:operator", label: "Operator", kind: "actor", evidence: evidence(readme) },
        { id: "entity:connect", label: "Connect", kind: "user-job", evidence: evidence(connect) },
        { id: "entity:publish", label: "Publish", kind: "user-job", evidence: evidence(publish) },
      ],
      relationships: [],
    },
    { index },
  );
  const candidates = createArtifact(
    "ia-candidates",
    {
      scope: "site",
      candidates: [
        {
          id: "candidate:jobs",
          primaryAxis: "reader-job",
          secondaryAxes: [],
          score: 92,
          groups: [
            {
              id: "group:connect",
              label: "Connect",
              axis: "reader-job",
              members: [connect.id],
              canonicalPath: "connect",
              evidence: evidence(connect),
            },
            {
              id: "group:publish",
              label: "Publish",
              axis: "reader-job",
              members: [publish.id],
              canonicalPath: "publish",
              evidence: evidence(publish),
            },
          ],
          evidence: evidence(readme),
        },
        {
          id: "candidate:capabilities",
          primaryAxis: "capability",
          secondaryAxes: [],
          score: 68,
          groups: [
            {
              id: "group:platform",
              label: "Platform",
              axis: "capability",
              members: [connect.id, publish.id],
              canonicalPath: "platform",
              evidence: evidence(readme),
            },
          ],
          evidence: evidence(readme),
        },
      ],
      recommendedCandidateId: "candidate:jobs",
      rejectedCandidates: [{ candidateId: "candidate:capabilities", reason: "lower-score" }],
      openDecisions: [],
    },
    { index },
  );
  const tasks: NavigationEvaluationPayload["tasks"] = [
    ...DEFAULT_IA_NAVIGATION_TASKS.map((task) => ({
      ...task,
      expectedNodeIds:
        task.id === "expected-no-result"
          ? []
          : task.id === "reference-lookup"
            ? [publish.id]
            : task.id === "ambiguous-placement"
              ? [connect.id, publish.id]
              : [connect.id],
      acceptableNodeIds: [],
    })),
  ];
  const results: NavigationEvaluationPayload["results"] = [
    { taskId: "routine-task", rankedNodeIds: [connect.id], outcome: "matched" },
    { taskId: "reference-lookup", rankedNodeIds: [publish.id], outcome: "matched" },
    { taskId: "troubleshooting", rankedNodeIds: [connect.id], outcome: "matched" },
    {
      taskId: "ambiguous-placement",
      rankedNodeIds: [connect.id, publish.id],
      outcome: "ambiguous",
    },
    { taskId: "expected-no-result", rankedNodeIds: [], outcome: "no-result" },
  ];
  const navigationEvaluation = createArtifact(
    "navigation-evaluation",
    {
      tasks,
      results,
      metrics: recomputeNavigationMetrics({ tasks, results }),
    },
    { index },
  );
  const references = {
    ontology: reference(ontology),
    iaCandidates: reference(candidates),
    navigationEvaluation: reference(navigationEvaluation),
  };
  const withoutDigest = {
    schemaVersion: 1 as const,
    skill: {
      id: TPL_DESIGN_IA_SKILL,
      version: TPL_DESIGN_IA_SKILL_VERSION,
      provenanceStatus: TPL_DESIGN_IA_PROVENANCE_STATUS,
    },
    evaluation: { id: TPL_DESIGN_IA_EVALUATION_ID, version: TPL_DESIGN_IA_EVALUATION_VERSION },
    repository: { ...index.repository },
    scope: "site" as const,
    mode: "create" as const,
    status: "recommendation-ready" as const,
    artifacts: references,
    useCases: [
      {
        id: "use:connect",
        actor: "operator",
        trigger: "a cluster exists",
        goal: "connect it",
        input: "cluster endpoint",
        outcome: "connected cluster",
        evidence: evidence(connect),
      },
    ],
    recommendation: {
      candidateId: "candidate:jobs",
      primaryAxis: "reader-job" as const,
      groups: [
        { id: "group:connect", memberNodeIds: [connect.id] },
        { id: "group:publish", memberNodeIds: [publish.id] },
      ],
      rationale: "Reader jobs provide direct paths.",
      evidence: evidence(readme),
    },
    rejections: [
      {
        candidateId: "candidate:capabilities",
        primaryAxis: "capability" as const,
        reason: "lower-score" as const,
        rationale: "Capability labels obscure jobs.",
        evidence: evidence(readme),
      },
    ],
    openDecisions: [],
  };
  return {
    artifacts: [ontology, candidates, navigationEvaluation],
    result: { ...withoutDigest, digest: tplDesignIaDigest(withoutDigest) },
  };
}

function reference<K extends Artifact["kind"]>(
  artifact: Extract<Artifact, { kind: K }>,
): ArtifactReference<K> {
  return {
    kind: artifact.kind,
    schemaVersion: artifact.schemaVersion,
    digest: artifact.digest,
    repositoryRevision: artifact.repository.revision,
    repositoryContentDigest: artifact.repository.contentDigest,
  };
}

async function sourceSnapshot(repositoryPath: string): Promise<Record<string, string>> {
  return Object.fromEntries(
    await Promise.all(
      ["README.md", "connect.md", "publish.md"].map(async (path) => [
        path,
        await readFile(join(repositoryPath, path), "utf8"),
      ]),
    ),
  );
}

function analysisSubmission(index: ContentIndexV1): Record<string, unknown> {
  const analysis = analysisOutput(index);
  const ontology = analysis.artifacts.find((item) => item.kind === "ontology");
  const candidates = analysis.artifacts.find((item) => item.kind === "ia-candidates");
  const navigation = analysis.artifacts.find((item) => item.kind === "navigation-evaluation");
  if (!ontology || !candidates || !navigation || !analysis.result.recommendation) {
    throw new Error("Invalid external model fixture.");
  }
  return {
    schemaVersion: 1,
    kind: "docsfab-ia-analysis-submission",
    repository: { ...index.repository, indexDigest: index.indexDigest },
    task: { scope: "site", mode: "create" },
    design: {
      status: analysis.result.status,
      useCases: analysis.result.useCases,
      recommendation: analysis.result.recommendation,
      rejections: analysis.result.rejections,
      openDecisions: analysis.result.openDecisions,
    },
    artifacts: {
      ontology: ontology.payload,
      iaCandidates: candidates.payload,
      navigationEvaluation: navigation.payload,
    },
  };
}

async function fakeIaModelTransport(
  root: string,
  submission: Record<string, unknown>,
): Promise<string> {
  const chunks = [
    {
      id: "ia-e2e-response",
      object: "chat.completion.chunk",
      created: 1,
      model: validModelEnvironment.MODEL_ID,
      choices: [
        {
          index: 0,
          delta: { role: "assistant", content: JSON.stringify(submission) },
          finish_reason: null,
        },
      ],
    },
    {
      id: "ia-e2e-response",
      object: "chat.completion.chunk",
      created: 1,
      model: validModelEnvironment.MODEL_ID,
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage: { prompt_tokens: 100, completion_tokens: 100, total_tokens: 200 },
    },
  ];
  const body = [
    ...chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`),
    "data: [DONE]\n\n",
  ].join("");
  const path = join(root, "external-model-transport.mjs");
  await writeFile(
    path,
    [
      `const body = ${JSON.stringify(body)};`,
      "globalThis.fetch = async () => new Response(body, {",
      "  status: 200, headers: { 'content-type': 'text/event-stream' },",
      "});",
      "",
    ].join("\n"),
    { mode: 0o600 },
  );
  return path;
}

function requiredRunId(stdout: string): string {
  const runId = stdout.match(/Run ([A-Za-z0-9._-]+):/u)?.[1];
  if (!runId) throw new Error(`Missing run ID in CLI output: ${stdout}`);
  return runId;
}

function requiredRecordPath(stdout: string): string {
  const recordPath = stdout.match(/^RECORD\n(.+)$/mu)?.[1]?.trim();
  if (!recordPath) throw new Error(`Missing record path in CLI output: ${stdout}`);
  return recordPath;
}

function requiredNextCommand(stdout: string): string {
  const value = stdout.match(/\bNext: (.+)$/mu)?.[1];
  if (!value) throw new Error(`Missing Next in CLI output: ${stdout}`);
  return value;
}

function requiredLabel(stdout: string, label: string): string {
  const value = stdout.match(new RegExp(`^${label}: (.+)$`, "mu"))?.[1];
  if (!value) throw new Error(`Missing ${label} in CLI output: ${stdout}`);
  return value;
}

async function captureCliFailure(
  promise: ReturnType<typeof execFile>,
): Promise<{ stdout: string; stderr: string }> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof Error && "stdout" in error && "stderr" in error) {
      return {
        stdout: String(error.stdout),
        stderr: String(error.stderr),
      };
    }
    throw error;
  }
  throw new Error("Expected the external CLI process to fail.");
}

function shellWord(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}
