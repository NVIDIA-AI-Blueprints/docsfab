// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import {
  createKnowledgeAcceptedSnapshot,
  type KnowledgeAcceptedSnapshotBodyV1,
} from "../src/canon/from-knowledge-snapshot.js";
import { handleRunsCommand, parseRunsArguments } from "../src/cli/commands/runs.js";
import { instructionSha256 } from "../src/cli/knowledge-resume.js";
import { parseRunArguments } from "../src/cli/run-arguments.js";
import { canonicalDigest } from "../src/contract-kit/index.js";
import { inspectProcessBirth, requireProcessBirthIdentity } from "../src/init/storage.js";
import { captureRunTaskLineage, serializeRunTaskLineage } from "../src/lineage/run-capture.js";
import { mintCliOperatorDirectedLineage } from "../src/lineage/cli-operator-directed.js";
import {
  classifyRunResumability,
  knowledgeContinuationArtifactsDirectory,
  knowledgeContinuationAttemptsDirectory,
  projectRunContinuationCommand,
} from "../src/operator/index.js";
import { buildRunHumanNextCommand } from "../src/operator/run-summary.js";
import { DurableArtifactStore } from "../src/artifacts/store.js";
import type { RunRecord } from "../src/records/contracts.js";
import {
  createWorkflowOutcome,
  workflowOutcomeStepEvidence,
} from "../src/workflow-contracts/outcome.js";
import {
  createKnowledgeContinuationDeliveryIntent,
  createKnowledgeContinuationPrivateTask,
  createKnowledgeContinuationReceipt,
  decodeKnowledgeContinuationStoppedRun,
} from "../src/records/knowledge-continuation.js";
import { KnowledgeContinuationAttemptStore } from "../src/records/knowledge-continuation-store.js";
import * as workflowCatalog from "../src/workflow-registry/catalog.js";
import { temporaryRoots } from "./helpers/temp.js";

const executeFile = promisify(execFile);
const roots = temporaryRoots();
const revision = "f".repeat(40);
const behaviorStatement = "The widget --version command prints the installed version.";
const boundInstruction = [
  "Write `docs/get-started.md` using only these repository-observed behavior claims:",
  `- ${behaviorStatement}`,
].join("\n");

interface StoppedRunFixture {
  root: string;
  stateDirectory: string;
  runId: string;
  record: RunRecord;
  recordPath: string;
  repositorySourcePath: string;
}

async function buildStoppedRun(options: {
  runId: string;
  workflow?: "create-documentation" | "update-documentation";
  instruction?: string;
  deliveryMode?: "patch-only" | "draft-mr";
  remoteName?: string;
  /** Reuse an existing state directory (and its artifact/attempt roots). */
  stateDirectory?: string;
  repositorySourcePath?: string;
}): Promise<StoppedRunFixture> {
  const root = await roots.create("docsfab-runs-resume-");
  const repositorySourcePath = options.repositorySourcePath ?? join(root, "workspace");
  await mkdir(repositorySourcePath, { recursive: true });
  const stateDirectory = options.stateDirectory ?? join(root, "state", "runs");
  await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
  const workflow = options.workflow ?? "create-documentation";
  const instruction = options.instruction ?? boundInstruction;
  const store = new DurableArtifactStore(knowledgeContinuationArtifactsDirectory(stateDirectory));

  const repositoryIdentitySha256 = createHash("sha256").update(repositorySourcePath).digest("hex");
  const mintedLineage = await mintCliOperatorDirectedLineage({
    instruction,
    task: null,
    workflow,
    repository: { identitySha256: repositoryIdentitySha256, revision },
    authorityId: "operator-test-1",
    runId: options.runId,
  });
  const projection = captureRunTaskLineage(
    {
      workflow,
      repository: { sourcePath: repositorySourcePath, requestedRevision: "HEAD", revision },
    },
    mintedLineage,
  );
  const serializedLineage = serializeRunTaskLineage(mintedLineage);
  const origin = JSON.parse(serializedLineage.origin) as unknown;
  const lineage = JSON.parse(serializedLineage.lineage) as unknown;
  const originArtifactSha256 = canonicalDigest(origin);
  const lineageArtifactSha256 = canonicalDigest(lineage);
  await store.putRecord(originArtifactSha256, origin);
  await store.putRecord(lineageArtifactSha256, lineage);

  const delivery = createKnowledgeContinuationDeliveryIntent({
    mode: options.deliveryMode ?? "patch-only",
    remoteName: options.deliveryMode === "draft-mr" ? (options.remoteName ?? "origin") : null,
    targetBranch: options.deliveryMode === "draft-mr" ? "main" : null,
    targetRevision: options.deliveryMode === "draft-mr" ? revision : null,
  });

  const privateTask = createKnowledgeContinuationPrivateTask({
    schemaVersion: 2,
    kind: "docsfab-knowledge-continuation-private-task",
    originalRunId: options.runId,
    workflow,
    instruction,
    instructionSha256: instructionSha256(instruction),
    repository: {
      identitySha256: repositoryIdentitySha256,
      revision,
      sourcePath: repositorySourcePath,
      requestedRevision: "HEAD",
    },
    delivery,
    targetConflictReceipt: null,
    taskLineage: projection,
    continuationTargets: null,
  });
  const originalTaskArtifactSha256 = canonicalDigest(privateTask);
  await store.putRecord(originalTaskArtifactSha256, privateTask);

  const receipt = createKnowledgeContinuationReceipt({
    schemaVersion: 1,
    kind: "docsfab-knowledge-continuation-receipt",
    originalRunId: options.runId,
    repositoryIdentitySha256,
    repositoryRevision: revision,
    workflow,
    instructionSha256: instructionSha256(instruction),
    candidateSnapshotSha256: "a".repeat(64),
    candidateArtifactSha256: "b".repeat(64),
    candidateBytesSha256: "c".repeat(64),
    originalTaskArtifactSha256,
    originalTaskBindingArtifactSha256: "e".repeat(64),
    originalTaskBindingBytesSha256: "f".repeat(64),
    originArtifactSha256,
    lineageArtifactSha256,
    taskLineageProjectionSha256: projection.projectionSha256,
    targetConflictReceipt: null,
    targetConflictReceiptSha256: null,
  });

  const now = new Date().toISOString();
  const record: RunRecord = {
    schemaVersion: 2,
    id: options.runId,
    workflow,
    repository: { sourcePath: repositorySourcePath, requestedRevision: "HEAD", revision },
    workspace: { strategy: "tracked-export", disposable: true },
    taskLineage: projection,
    knowledgeContinuationReceipt: receipt,
    status: "needs-input",
    error: "needs-input: attributed knowledge required to continue this Task.",
    createdAt: now,
    completedAt: now,
    models: [],
    skills: [],
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, turns: 0 },
    tools: { totalCalls: 0, failedCalls: 0, byTool: [] },
    steps: [],
  };
  decodeKnowledgeContinuationStoppedRun(record);
  const recordPath = join(stateDirectory, `${options.runId}.json`);
  await writeFile(recordPath, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  return { root, stateDirectory, runId: options.runId, record, recordPath, repositorySourcePath };
}
function resolvedSnapshotBody(): KnowledgeAcceptedSnapshotBodyV1 {
  return {
    projectId: "PRJ-001",
    modelVersionId: "MODEL-001",
    streamVersion: 4,
    status: "candidate",
    claims: [
      {
        id: "CL-BEHAVIOR",
        kind: "behavior",
        scope: "Widget CLI",
        statement: behaviorStatement,
        modelState: "candidate",
        evidenceIds: ["SRC-README"],
      },
    ],
    sources: [{ id: "SRC-README", locator: "readme:README.md" }],
    conflicts: [],
  };
}

function unresolvedSnapshotBody(): KnowledgeAcceptedSnapshotBodyV1 {
  return {
    ...resolvedSnapshotBody(),
    claims: [
      ...resolvedSnapshotBody().claims,
      {
        id: "CL-INTENT-1",
        kind: "intent",
        scope: "Widget audience",
        statement: "The widget is built for operators.",
        modelState: "disputed",
        evidenceIds: ["SRC-README"],
      },
      {
        id: "CL-INTENT-2",
        kind: "intent",
        scope: "Widget audience",
        statement: "The widget is built for developers.",
        modelState: "disputed",
        evidenceIds: ["SRC-README"],
      },
    ],
    conflicts: [{ id: "CF-INTENT", claimIds: ["CL-INTENT-1", "CL-INTENT-2"] }],
  };
}

async function writeSnapshot(
  root: string,
  name: string,
  body: KnowledgeAcceptedSnapshotBodyV1,
): Promise<string> {
  const path = join(root, name);
  await writeFile(path, `${JSON.stringify(createKnowledgeAcceptedSnapshot(body), null, 2)}\n`);
  return path;
}

async function captureIo(fn: () => Promise<void>): Promise<{ stdout: string; stderr: string }> {
  const logs: string[] = [];
  const errors: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (message?: unknown) => logs.push(String(message ?? ""));
  console.error = (message?: unknown) => errors.push(String(message ?? ""));
  try {
    await fn();
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
  return { stdout: logs.join("\n"), stderr: errors.join("\n") };
}

/** Real bash tokenization proof for the rendered NEXT argv (quoting correctness). */
async function splitViaRealShell(argsPortion: string): Promise<string[]> {
  const { stdout } = await executeFile("bash", [
    "-c",
    `set -- ${argsPortion}; printf "%s\\n" "$@"`,
  ]);
  return stdout.split("\n").filter((token) => token.length > 0);
}

function currentOwner(): { pid: number; processBirthIdentity: string } {
  try {
    return { pid: process.pid, processBirthIdentity: requireProcessBirthIdentity(process.pid) };
  } catch {
    return {
      pid: process.pid,
      processBirthIdentity: createHash("sha256").update(`test-owner:${process.pid}`).digest("hex"),
    };
  }
}

function deadOwner(): { pid: number; processBirthIdentity: string } {
  return { pid: 999_999, processBirthIdentity: "d".repeat(64) };
}
describe("docsfab runs show resume projection (#694)", () => {
  it("projects a positive resumable run into exactly the expected continuation command", async () => {
    const fixture = await buildStoppedRun({ runId: "resume-positive-001" });
    const snapshotPath = await writeSnapshot(fixture.root, "answered.json", resolvedSnapshotBody());
    const recordBytesBefore = await readFile(fixture.recordPath);

    const io = await captureIo(() =>
      handleRunsCommand([
        "show",
        fixture.runId,
        "--state-dir",
        fixture.stateDirectory,
        "--canon-snapshot",
        snapshotPath,
        "--accept-candidate-snapshot",
        "--authority-id",
        "operator-test-1",
      ]),
    );

    const expected =
      `env DOCSFAB_STATE_DIR=${fixture.stateDirectory} docsfab run create-documentation ` +
      `--repo ${fixture.repositorySourcePath} --resume-from ${fixture.runId} ` +
      `--canon-snapshot ${resolve(snapshotPath)} --accept-candidate-snapshot ` +
      `--authority-id operator-test-1 --allow-write --patch-only`;
    expect(io.stdout).toContain(expected);
    expect(io.stdout).toContain("Resumability: resumable (no-attempt-yet)");
    expect(io.stdout).not.toContain(fixture.record.error);

    // The exact argv must parse back to the request docsfab run would execute.
    const argsPortion = expected.slice(expected.indexOf("docsfab run ") + "docsfab run ".length);
    const reparsed = parseRunArguments(argsPortion.split(" "));
    expect(reparsed).toMatchObject({
      workflow: "create-documentation",
      resumeFrom: fixture.runId,
      canonSnapshotPath: resolve(snapshotPath),
      acceptCandidateSnapshot: true,
      canonSnapshotAuthorityId: "operator-test-1",
      allowWrite: true,
      draftMr: false,
    });

    expect(await readFile(fixture.recordPath)).toEqual(recordBytesBefore);
  });

  it("shell-round-trips a rendered command whose path contains a space and a single quote", async () => {
    const fixture = await buildStoppedRun({ runId: "resume-quoting-001" });
    const answerDir = join(fixture.root, "answer dir with a quote");
    await mkdir(answerDir, { recursive: true });
    const snapshotPath = await writeSnapshot(answerDir, "snap shot.json", resolvedSnapshotBody());

    const io = await captureIo(() =>
      handleRunsCommand([
        "show",
        fixture.runId,
        "--state-dir",
        fixture.stateDirectory,
        "--canon-snapshot",
        snapshotPath,
        "--accept-candidate-snapshot",
        "--authority-id",
        "operator-test-1",
      ]),
    );
    const nextLine = io.stdout
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.startsWith("env DOCSFAB_STATE_DIR="));
    expect(nextLine).toBeDefined();
    const argsPortion = nextLine!.slice(nextLine!.indexOf("docsfab run ") + "docsfab run ".length);
    const tokens = await splitViaRealShell(argsPortion);
    expect(tokens).toContain(resolve(snapshotPath));
    expect(tokens).toContain("--canon-snapshot");
    const reparsed = parseRunArguments(tokens);
    expect(reparsed.canonSnapshotPath).toBe(resolve(snapshotPath));
  });
});
async function writePlainRecord(
  stateDirectory: string,
  id: string,
  overrides: Record<string, unknown>,
): Promise<string> {
  const recordPath = join(stateDirectory, `${id}.json`);
  await writeFile(
    recordPath,
    JSON.stringify({
      schemaVersion: 2,
      id,
      workflow: "review-documentation",
      repository: { sourcePath: "/tmp/docsfab-resume-fixture", revision: "b".repeat(40) },
      workspace: { strategy: "tracked-export", disposable: true },
      createdAt: "2026-08-14T10:00:00.000Z",
      models: [],
      skills: [],
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, turns: 0 },
      tools: { totalCalls: 0, failedCalls: 0, byTool: [] },
      steps: [],
      ...overrides,
    }),
    { mode: 0o600 },
  );
  return recordPath;
}

describe("docsfab runs show resumability negative controls (#694)", () => {
  it.each([
    { status: "succeeded", extra: {}, line: "Resumability: terminal (succeeded)" },
    { status: "failed", extra: { error: "boom" }, line: "Resumability: non-resumable (failed)" },
    { status: "queued", extra: {}, line: "Resumability: blocked (queued)" },
    { status: "running", extra: {}, line: "Resumability: blocked (running)" },
    {
      status: "needs-human-decision",
      extra: {},
      line: "Resumability: blocked (needs-human-decision)",
    },
    { status: "needs-input", extra: {}, line: "Resumability: blocked (needs-input)" },
  ])(
    "classifies $status saved work with no invented NEXT command",
    async ({ status, extra, line }) => {
      const root = await roots.create("docsfab-runs-resume-neg-");
      const stateDirectory = join(root, "state");
      await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
      const recordPath = await writePlainRecord(stateDirectory, `neg-${status}`, {
        status,
        ...extra,
      });
      const bytesBefore = await readFile(recordPath);
      const io = await captureIo(() =>
        handleRunsCommand(["show", `neg-${status}`, "--state-dir", stateDirectory]),
      );
      expect(io.stdout).toContain(line);
      expect(io.stdout).not.toContain("--resume-from");
      expect(io.stdout).not.toContain("docsfab doctor --repo");
      expect(await readFile(recordPath)).toEqual(bytesBefore);
    },
  );

  it("reports missing input with no command when a resumable run has no explicit selection", async () => {
    const fixture = await buildStoppedRun({ runId: "resume-missing-input-001" });
    const io = await captureIo(() =>
      handleRunsCommand(["show", fixture.runId, "--state-dir", fixture.stateDirectory]),
    );
    expect(io.stdout).toContain("Resumability: resumable (no-attempt-yet)");
    expect(io.stdout).not.toContain("--resume-from");
    expect(io.stdout).not.toContain("Missing input:");
  });

  it("reports the specific missing-input message when the supplied snapshot does not yet resolve the stop", async () => {
    const fixture = await buildStoppedRun({ runId: "resume-unresolved-001" });
    const snapshotPath = await writeSnapshot(
      fixture.root,
      "still-conflicted.json",
      unresolvedSnapshotBody(),
    );
    const io = await captureIo(() =>
      handleRunsCommand([
        "show",
        fixture.runId,
        "--state-dir",
        fixture.stateDirectory,
        "--canon-snapshot",
        snapshotPath,
        "--accept-candidate-snapshot",
        "--authority-id",
        "operator-test-1",
      ]),
    );
    expect(io.stdout).toContain(
      "Missing input: the supplied knowledge snapshot does not yet resolve this stop",
    );
    expect(io.stdout).not.toContain("--resume-from");
  });

  it("rejects a substituted original-task artifact as unverifiable with no command", async () => {
    const fixture = await buildStoppedRun({ runId: "resume-substituted-001" });
    const snapshotPath = await writeSnapshot(fixture.root, "answered.json", resolvedSnapshotBody());
    const artifactsRoot = knowledgeContinuationArtifactsDirectory(fixture.stateDirectory);
    const store = new DurableArtifactStore(artifactsRoot);
    const originalTaskArtifactSha256 =
      fixture.record.knowledgeContinuationReceipt!.originalTaskArtifactSha256;
    const tampered = {
      ...((await store.getRecord(originalTaskArtifactSha256)) as Record<string, unknown>),
      instruction: "a substituted instruction the operator never approved",
    };
    // Bypass the append-only store API on purpose: this proves the read path
    // rejects substituted bytes (the write path forbids them separately).
    const objectPath = join(
      artifactsRoot,
      "objects",
      "sha256",
      `${originalTaskArtifactSha256}.json`,
    );
    await writeFile(objectPath, `${JSON.stringify(tampered)}\n`, { mode: 0o600 });

    const io = await captureIo(() =>
      handleRunsCommand([
        "show",
        fixture.runId,
        "--state-dir",
        fixture.stateDirectory,
        "--canon-snapshot",
        snapshotPath,
        "--accept-candidate-snapshot",
        "--authority-id",
        "operator-test-1",
      ]),
    );
    expect(io.stdout).toContain("Unverifiable:");
    expect(io.stdout).not.toContain("--resume-from");
    expect(io.stdout).not.toContain("a substituted instruction");
  });
});
describe("docsfab runs list/show attempt-journal classification (#694)", () => {
  it("does not cross-contaminate attempt journals between two divergent run ids", async () => {
    const root = await roots.create("docsfab-runs-resume-divergent-");
    const stateDirectory = join(root, "state", "runs");
    await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
    const a = await buildStoppedRunInto(stateDirectory, "divergent-a");
    const b = await buildStoppedRunInto(stateDirectory, "divergent-b");

    const attempts = new KnowledgeContinuationAttemptStore(
      knowledgeContinuationAttemptsDirectory(stateDirectory),
      { inspect: inspectProcessBirth },
    );
    const claimA = await attempts.claim({
      originalRunId: a.runId,
      snapshotSha256: "a".repeat(64),
      deliveryIntentSha256: a.record.knowledgeContinuationReceipt!.originalTaskArtifactSha256,
      childRunId: "child-of-a",
      owner: currentOwner(),
    });
    expect(claimA.disposition).toBe("claimed");
    await attempts.transition({
      originalRunId: a.runId,
      attemptId: claimA.attempt.attemptId,
      owner: currentOwner(),
      phase: "executing",
    });
    await attempts.transition({
      originalRunId: a.runId,
      attemptId: claimA.attempt.attemptId,
      owner: currentOwner(),
      phase: "writer-completed",
      childRecordSha256: "b".repeat(64),
    });

    const resumabilityA = await classifyRunResumability(a.record, stateDirectory);
    const resumabilityB = await classifyRunResumability(b.record, stateDirectory);
    expect(resumabilityA).toEqual({ category: "terminal", reason: "already-completed" });
    expect(resumabilityB).toEqual({ category: "resumable", reason: "no-attempt-yet" });
  });

  it("classifies a live attempt as blocked and a dead pre-execution attempt as a safe retry", async () => {
    const root = await roots.create("docsfab-runs-resume-attempts-");
    const stateDirectory = join(root, "state", "runs");
    await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
    const busy = await buildStoppedRunInto(stateDirectory, "attempt-busy");
    const deadPrepared = await buildStoppedRunInto(stateDirectory, "attempt-dead-prepared");
    const deadExecuting = await buildStoppedRunInto(stateDirectory, "attempt-dead-executing");
    const recoveryRequired = await buildStoppedRunInto(stateDirectory, "attempt-recovery");

    const attempts = new KnowledgeContinuationAttemptStore(
      knowledgeContinuationAttemptsDirectory(stateDirectory),
      { inspect: inspectProcessBirth },
    );

    const busyClaim = await attempts.claim({
      originalRunId: busy.runId,
      snapshotSha256: "a".repeat(64),
      deliveryIntentSha256: busy.record.knowledgeContinuationReceipt!.originalTaskArtifactSha256,
      childRunId: "child-busy",
      owner: currentOwner(),
    });
    expect(busyClaim.disposition).toBe("claimed");

    await claimWithDeadOwner(attempts, deadPrepared.runId, deadPrepared.record);
    const deadExecutingClaim = await claimWithDeadOwner(
      attempts,
      deadExecuting.runId,
      deadExecuting.record,
      "executing",
    );
    void deadExecutingClaim;

    const recoveryClaim = await claimWithDeadOwner(
      attempts,
      recoveryRequired.runId,
      recoveryRequired.record,
    );
    await attempts
      .transition({
        originalRunId: recoveryRequired.runId,
        attemptId: recoveryClaim.attemptId,
        owner: recoveryClaim.owner,
        phase: "recovery-required",
      })
      .catch(() => undefined);

    expect(await classifyRunResumability(busy.record, stateDirectory)).toEqual({
      category: "blocked",
      reason: "attempt-in-progress",
    });
    expect(await classifyRunResumability(deadPrepared.record, stateDirectory)).toEqual({
      category: "resumable",
      reason: "safe-pre-execution-retry",
    });
    expect(await classifyRunResumability(deadExecuting.record, stateDirectory)).toEqual({
      category: "non-resumable",
      reason: "recovery-required",
    });
  });
});

async function buildStoppedRunInto(
  stateDirectory: string,
  runId: string,
): Promise<StoppedRunFixture> {
  // Build straight into the shared state directory: the artifact store pins
  // directory identity and permissions at creation, so a copied store would be
  // rejected by the real reader.
  return buildStoppedRun({ runId, stateDirectory });
}

async function claimWithDeadOwner(
  attempts: KnowledgeContinuationAttemptStore,
  originalRunId: string,
  record: RunRecord,
  finalPhase: "prepared" | "executing" = "prepared",
): Promise<{ attemptId: string; owner: { pid: number; processBirthIdentity: string } }> {
  const owner = deadOwner();
  const claim = await attempts.claim({
    originalRunId,
    snapshotSha256: "a".repeat(64),
    deliveryIntentSha256: record.knowledgeContinuationReceipt!.originalTaskArtifactSha256,
    childRunId: `child-of-${originalRunId}`,
    owner,
  });
  if (claim.disposition !== "claimed") {
    throw new Error(`expected a fresh claim for ${originalRunId}, got ${claim.disposition}`);
  }
  if (finalPhase === "executing") {
    await attempts.transition({
      originalRunId,
      attemptId: claim.attempt.attemptId,
      owner,
      phase: "executing",
    });
  }
  return { attemptId: claim.attempt.attemptId, owner };
}
describe("docsfab runs show selector argument parsing (#694)", () => {
  it("rejects --json combined with any new selector in either flag order", () => {
    expect(() =>
      parseRunsArguments([
        "show",
        "run-1",
        "--json",
        "--canon-snapshot",
        "snap.json",
        "--accept-candidate-snapshot",
        "--authority-id",
        "op-1",
      ]),
    ).toThrow(/cannot be combined with --canon-snapshot/u);
    expect(() =>
      parseRunsArguments([
        "show",
        "run-1",
        "--canon-snapshot",
        "snap.json",
        "--accept-candidate-snapshot",
        "--authority-id",
        "op-1",
        "--json",
      ]),
    ).toThrow(/cannot be combined with --canon-snapshot/u);
  });

  it("rejects duplicated and incomplete selector combinations", () => {
    expect(() =>
      parseRunsArguments([
        "show",
        "run-1",
        "--canon-snapshot",
        "a.json",
        "--canon-snapshot",
        "b.json",
      ]),
    ).toThrow(/--canon-snapshot option must not be duplicated/u);
    expect(() => parseRunsArguments(["show", "run-1", "--accept-candidate-snapshot"])).toThrow(
      /requires a --canon-snapshot/u,
    );
    expect(() =>
      parseRunsArguments([
        "show",
        "run-1",
        "--canon-snapshot",
        "a.json",
        "--accept-candidate-snapshot",
      ]),
    ).toThrow(/requires an --authority-id/u);
    expect(() => parseRunsArguments(["show", "run-1", "--authority-id", "op-1"])).toThrow(
      /requires --accept-candidate-snapshot/u,
    );
    expect(() => parseRunsArguments(["show", "run-1", "--canon-snapshot"])).toThrow(
      /requires a file path value/u,
    );
    expect(() => parseRunsArguments(["show", "../escape", "--canon-snapshot", "a.json"])).toThrow(
      /safe record identity/u,
    );
  });

  it("parses a full explicit selection and records whether --state-dir was explicit", () => {
    const explicit = parseRunsArguments([
      "show",
      "run-1",
      "--state-dir",
      "/tmp/example",
      "--canon-snapshot",
      "snap.json",
      "--accept-candidate-snapshot",
      "--authority-id",
      "op-1",
    ]);
    expect(explicit).toMatchObject({
      command: "show",
      stateDirectoryExplicit: true,
      acceptCandidateSnapshot: true,
      authorityId: "op-1",
    });
    expect((explicit as { canonSnapshotPath?: string }).canonSnapshotPath).toContain("snap.json");
  });
});

describe("docsfab runs list resumability projection (#694)", () => {
  it("adds a minimized resumability field per available entry without ever emitting a command", async () => {
    const fixture = await buildStoppedRun({ runId: "list-resumability-001" });
    const io = await captureIo(() =>
      handleRunsCommand(["list", "--json", "--state-dir", fixture.stateDirectory]),
    );
    const envelope = JSON.parse(io.stdout) as {
      runs: Array<{ runId: string; resumability?: { category: string; reason: string } }>;
    };
    const entry = envelope.runs.find((run) => run.runId === fixture.runId);
    expect(entry?.resumability).toEqual({ category: "resumable", reason: "no-attempt-yet" });
    expect(io.stdout).not.toContain("--resume-from");
    expect(io.stdout).not.toContain("docsfab run");
  });
});

describe("docsfab runs show state-directory rendering (#694)", () => {
  it("renders the env DOCSFAB_STATE_DIR prefix only when --state-dir was explicit", async () => {
    const fixture = await buildStoppedRun({ runId: "resume-state-dir-001" });
    const snapshotPath = await writeSnapshot(fixture.root, "answered.json", resolvedSnapshotBody());

    const explicit = await captureIo(() =>
      handleRunsCommand([
        "show",
        fixture.runId,
        "--state-dir",
        fixture.stateDirectory,
        "--canon-snapshot",
        snapshotPath,
        "--accept-candidate-snapshot",
        "--authority-id",
        "operator-test-1",
      ]),
    );
    expect(explicit.stdout).toContain(
      `env DOCSFAB_STATE_DIR=${fixture.stateDirectory} docsfab run`,
    );

    const previousStateDir = process.env.DOCSFAB_STATE_DIR;
    process.env.DOCSFAB_STATE_DIR = fixture.stateDirectory;
    try {
      const ambient = await captureIo(() =>
        handleRunsCommand([
          "show",
          fixture.runId,
          "--canon-snapshot",
          snapshotPath,
          "--accept-candidate-snapshot",
          "--authority-id",
          "operator-test-1",
        ]),
      );
      expect(ambient.stdout).not.toContain("env DOCSFAB_STATE_DIR=");
      expect(ambient.stdout).toContain("docsfab run create-documentation");
    } finally {
      if (previousStateDir === undefined) delete process.env.DOCSFAB_STATE_DIR;
      else process.env.DOCSFAB_STATE_DIR = previousStateDir;
    }
  });
});
describe("docsfab runs show never emits a command outside resumable (#694 F1)", () => {
  it.each([
    {
      name: "terminal (already-completed)",
      setup: "completed" as const,
      line: "Resumability: terminal (already-completed)",
    },
    {
      name: "blocked (attempt-in-progress)",
      setup: "busy" as const,
      line: "Resumability: blocked (attempt-in-progress)",
    },
    {
      name: "non-resumable (recovery-required)",
      setup: "recovery" as const,
      line: "Resumability: non-resumable (recovery-required)",
    },
  ])(
    "prints no --resume-from NEXT for $name even with a full explicit selection",
    async ({ setup, line }) => {
      const root = await roots.create("docsfab-runs-resume-f1-");
      const stateDirectory = join(root, "state", "runs");
      await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
      const fixture = await buildStoppedRunInto(stateDirectory, `f1-${setup}`);
      const attempts = new KnowledgeContinuationAttemptStore(
        knowledgeContinuationAttemptsDirectory(stateDirectory),
        { inspect: inspectProcessBirth },
      );
      if (setup === "completed") {
        const claim = await attempts.claim({
          originalRunId: fixture.runId,
          snapshotSha256: "a".repeat(64),
          deliveryIntentSha256:
            fixture.record.knowledgeContinuationReceipt!.originalTaskArtifactSha256,
          childRunId: `child-of-${fixture.runId}`,
          owner: currentOwner(),
        });
        if (claim.disposition !== "claimed") throw new Error("expected a fresh claim");
        await attempts.transition({
          originalRunId: fixture.runId,
          attemptId: claim.attempt.attemptId,
          owner: currentOwner(),
          phase: "executing",
        });
        await attempts.transition({
          originalRunId: fixture.runId,
          attemptId: claim.attempt.attemptId,
          owner: currentOwner(),
          phase: "writer-completed",
          childRecordSha256: "b".repeat(64),
        });
      } else if (setup === "busy") {
        const claim = await attempts.claim({
          originalRunId: fixture.runId,
          snapshotSha256: "a".repeat(64),
          deliveryIntentSha256:
            fixture.record.knowledgeContinuationReceipt!.originalTaskArtifactSha256,
          childRunId: `child-of-${fixture.runId}`,
          owner: currentOwner(),
        });
        if (claim.disposition !== "claimed") throw new Error("expected a fresh claim");
      } else {
        const claim = await attempts.claim({
          originalRunId: fixture.runId,
          snapshotSha256: "a".repeat(64),
          deliveryIntentSha256:
            fixture.record.knowledgeContinuationReceipt!.originalTaskArtifactSha256,
          childRunId: `child-of-${fixture.runId}`,
          owner: currentOwner(),
        });
        if (claim.disposition !== "claimed") throw new Error("expected a fresh claim");
        await attempts.transition({
          originalRunId: fixture.runId,
          attemptId: claim.attempt.attemptId,
          owner: currentOwner(),
          phase: "recovery-required",
        });
      }
      const snapshotPath = await writeSnapshot(
        root,
        `answered-${setup}.json`,
        resolvedSnapshotBody(),
      );
      const io = await captureIo(() =>
        handleRunsCommand([
          "show",
          fixture.runId,
          "--state-dir",
          stateDirectory,
          "--canon-snapshot",
          snapshotPath,
          "--accept-candidate-snapshot",
          "--authority-id",
          "operator-test-1",
        ]),
      );
      expect(io.stdout).toContain(line);
      expect(io.stdout).not.toContain("--resume-from");
      expect(io.stdout).not.toContain("docsfab run create-documentation");
    },
  );
});
describe("docsfab runs show attempt owner-liveness edge cases (#694 F3)", () => {
  it("treats an alive-but-unknown-identity owner as recovery-required, matching #761s own claim() semantics", async () => {
    const root = await roots.create("docsfab-runs-resume-f3-");
    const stateDirectory = join(root, "state", "runs");
    await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
    const fixture = await buildStoppedRunInto(stateDirectory, "f3-alive-unknown-identity");
    const attempts = new KnowledgeContinuationAttemptStore(
      knowledgeContinuationAttemptsDirectory(stateDirectory),
      { inspect: inspectProcessBirth },
    );
    const owner = { pid: 424_242, processBirthIdentity: "9".repeat(64) };
    const claim = await attempts.claim({
      originalRunId: fixture.runId,
      snapshotSha256: "a".repeat(64),
      deliveryIntentSha256: fixture.record.knowledgeContinuationReceipt!.originalTaskArtifactSha256,
      childRunId: `child-of-${fixture.runId}`,
      owner,
    });
    if (claim.disposition !== "claimed") throw new Error("expected a fresh claim");

    // "alive: true, identity: undefined" models EPERM, a ps failure/timeout, or
    // an unparsable /proc entry. claim() treats it as neither busy nor dead, so
    // it is not a safe retry.
    const aliveUnknownIdentity = { inspect: () => ({ alive: true }) };
    const resumability = await classifyRunResumability(
      fixture.record,
      stateDirectory,
      aliveUnknownIdentity,
    );
    expect(resumability).toEqual({ category: "non-resumable", reason: "recovery-required" });

    // Contrast: the real inspector sees this fabricated PID as dead, which falls
    // to the resumable "abandon-pre-execution" path.
    const deadRealResumability = await classifyRunResumability(fixture.record, stateDirectory, {
      inspect: inspectProcessBirth,
    });
    expect(deadRealResumability).toEqual({
      category: "resumable",
      reason: "safe-pre-execution-retry",
    });
  });
});
describe("docsfab runs list/show stay read-only against an unwritable state root (#694 F4)", () => {
  it("classifies honestly and creates no directory when the attempt-journal root cannot be written", async () => {
    const root = await roots.create("docsfab-runs-resume-f4-");
    const stateParent = join(root, "state");
    const stateDirectory = join(stateParent, "runs");
    const fixture = await buildStoppedRun({ runId: "f4-readonly" });
    // Re-home the record and its artifacts under a fresh state root, so
    // classification has no pre-existing attempt journal to work from.
    await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
    const record = { ...fixture.record, id: "f4-readonly" };
    await writeFile(
      join(stateDirectory, "f4-readonly.json"),
      `${JSON.stringify(record, null, 2)}\n`,
      {
        mode: 0o600,
      },
    );
    const artifactsRoot = knowledgeContinuationArtifactsDirectory(stateDirectory);
    await mkdir(artifactsRoot, { recursive: true });
    const { cp } = await import("node:fs/promises");
    await cp(knowledgeContinuationArtifactsDirectory(fixture.stateDirectory), artifactsRoot, {
      recursive: true,
      force: true,
    });
    const attemptsRoot = knowledgeContinuationAttemptsDirectory(stateDirectory);
    await expect(lstat(attemptsRoot)).rejects.toMatchObject({ code: "ENOENT" });

    await chmod(stateParent, 0o500);
    try {
      const resumability = await classifyRunResumability(record, stateDirectory);
      expect(resumability).toEqual({ category: "resumable", reason: "no-attempt-yet" });
      await expect(lstat(attemptsRoot)).rejects.toMatchObject({ code: "ENOENT" });

      const io = await captureIo(() =>
        handleRunsCommand(["show", "f4-readonly", "--state-dir", stateDirectory]),
      );
      expect(io.stdout).toContain("Resumability: resumable (no-attempt-yet)");
      expect(io.stdout).not.toContain("unverifiable-attempt-journal");
      await expect(lstat(attemptsRoot)).rejects.toMatchObject({ code: "ENOENT" });

      const listIo = await captureIo(() =>
        handleRunsCommand(["list", "--json", "--state-dir", stateDirectory]),
      );
      const envelope = JSON.parse(listIo.stdout) as {
        runs: Array<{ runId: string; resumability?: { category: string; reason: string } }>;
      };
      expect(envelope.runs.find((run) => run.runId === "f4-readonly")?.resumability).toEqual({
        category: "resumable",
        reason: "no-attempt-yet",
      });
      await expect(lstat(attemptsRoot)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await chmod(stateParent, 0o700);
    }
  });

  it.skipIf(process.getuid?.() === 0)(
    "classifies non-resumable (unverifiable-attempt-journal) when an existing attempts root cannot be read, instead of swallowing EACCES as no-attempt-yet",
    async () => {
      const fixture = await buildStoppedRun({ runId: "f4-unreadable-attempts" });
      const attemptsRoot = knowledgeContinuationAttemptsDirectory(fixture.stateDirectory);
      // The root exists, so the reader must tell "unreadable" (EACCES,
      // unverifiable) from "never created" (ENOENT, no attempt yet); swallowing
      // EACCES would wrongly report this run resumable.
      await mkdir(attemptsRoot, { recursive: true, mode: 0o700 });
      await chmod(attemptsRoot, 0o000);
      try {
        const resumability = await classifyRunResumability(fixture.record, fixture.stateDirectory);
        expect(resumability).toEqual({
          category: "non-resumable",
          reason: "unverifiable-attempt-journal",
        });
      } finally {
        await chmod(attemptsRoot, 0o700);
      }
    },
  );
});
describe("docsfab runs show exported API guards (#694 F5a)", () => {
  it("projectRunContinuationCommand itself reports missing-input with no command when the selection is incomplete", async () => {
    const fixture = await buildStoppedRun({ runId: "f5a-missing-input" });
    const snapshotPath = await writeSnapshot(fixture.root, "answered.json", resolvedSnapshotBody());

    const resumability = await classifyRunResumability(fixture.record, fixture.stateDirectory);
    expect(resumability).toEqual({ category: "resumable", reason: "no-attempt-yet" });

    const noneSelected = await projectRunContinuationCommand({
      record: fixture.record,
      resumability,
      stateDirectory: fixture.stateDirectory,
      stateDirectoryExplicit: true,
      acceptCandidateSnapshot: false,
    });
    expect(noneSelected).toMatchObject({ disposition: "missing-input" });
    expect(noneSelected).not.toHaveProperty("rendered");

    const onlySnapshot = await projectRunContinuationCommand({
      record: fixture.record,
      resumability,
      stateDirectory: fixture.stateDirectory,
      stateDirectoryExplicit: true,
      canonSnapshotPath: snapshotPath,
      acceptCandidateSnapshot: false,
    });
    expect(onlySnapshot).toMatchObject({ disposition: "missing-input" });

    const missingAuthority = await projectRunContinuationCommand({
      record: fixture.record,
      resumability,
      stateDirectory: fixture.stateDirectory,
      stateDirectoryExplicit: true,
      canonSnapshotPath: snapshotPath,
      acceptCandidateSnapshot: true,
    });
    expect(missingAuthority).toMatchObject({ disposition: "missing-input" });
  });

  it("rejects a terminal run even with a fully valid explicit selection, proving the gate lives in the function itself", async () => {
    const fixture = await buildStoppedRun({ runId: "f5a-terminal-direct" });
    const snapshotPath = await writeSnapshot(fixture.root, "answered.json", resolvedSnapshotBody());
    const outcome = await projectRunContinuationCommand({
      record: fixture.record,
      resumability: { category: "terminal", reason: "already-completed" },
      stateDirectory: fixture.stateDirectory,
      stateDirectoryExplicit: true,
      canonSnapshotPath: snapshotPath,
      acceptCandidateSnapshot: true,
      authorityId: "operator-test-1",
    });
    expect(outcome).toMatchObject({
      disposition: "unverifiable",
      reason:
        "Unverifiable: this run is terminal (already-completed); no continuation command is available.",
    });
  });
});
async function buildDivergentPrivateTaskFixture(
  suffix: string,
  divergence: {
    originalRunId?: string;
    workflow?: "create-documentation" | "update-documentation";
    instruction?: string;
    repositorySourcePath?: string;
    revision?: string;
    lineageRunIdSuffix?: string;
  },
): Promise<{ stateDirectory: string; runId: string; record: RunRecord; snapshotPath: string }> {
  const root = await roots.create("docsfab-runs-resume-divergent-");
  const runId = `divergent-${suffix}`;
  const repositorySourcePath = join(root, "workspace");
  await mkdir(repositorySourcePath, { recursive: true });
  const stateDirectory = join(root, "state", "runs");
  await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
  const store = new DurableArtifactStore(knowledgeContinuationArtifactsDirectory(stateDirectory));
  const fixedNow = () => new Date("2026-01-01T00:00:00.000Z");

  const repositoryIdentitySha256 = createHash("sha256").update(repositorySourcePath).digest("hex");

  // Record-facing bundle: decodeKnowledgeContinuationStoppedRun cross-checks the
  // receipt against the record itself, independent of the retained private task.
  const correctLineage = await mintCliOperatorDirectedLineage({
    instruction: boundInstruction,
    task: null,
    workflow: "create-documentation",
    repository: { identitySha256: repositoryIdentitySha256, revision },
    authorityId: "operator-test-1",
    runId,
    now: fixedNow,
  });
  const correctProjection = captureRunTaskLineage(
    {
      workflow: "create-documentation",
      repository: { sourcePath: repositorySourcePath, requestedRevision: "HEAD", revision },
    },
    correctLineage,
  );
  const serializedCorrect = serializeRunTaskLineage(correctLineage);
  const correctOrigin = JSON.parse(serializedCorrect.origin) as unknown;
  const correctLineageObj = JSON.parse(serializedCorrect.lineage) as unknown;
  const originArtifactSha256 = canonicalDigest(correctOrigin);
  const lineageArtifactSha256 = canonicalDigest(correctLineageObj);
  await store.putRecord(originArtifactSha256, correctOrigin);
  await store.putRecord(lineageArtifactSha256, correctLineageObj);

  // Retained private-task bundle: diverges from the record-facing bundle in the
  // dimension under test, but is self-consistent, so
  // createKnowledgeContinuationPrivateTask accepts it.
  const taskWorkflow = divergence.workflow ?? "create-documentation";
  const taskInstruction = divergence.instruction ?? boundInstruction;
  const taskRepositorySourcePath = divergence.repositorySourcePath ?? repositorySourcePath;
  const taskRevision = divergence.revision ?? revision;
  const taskRepositoryIdentitySha256 = createHash("sha256")
    .update(taskRepositorySourcePath)
    .digest("hex");
  const taskLineageMint = await mintCliOperatorDirectedLineage({
    instruction: taskInstruction,
    task: null,
    workflow: taskWorkflow,
    repository: { identitySha256: taskRepositoryIdentitySha256, revision: taskRevision },
    authorityId: "operator-test-1",
    runId: divergence.lineageRunIdSuffix ? `${runId}-${divergence.lineageRunIdSuffix}` : runId,
    now: fixedNow,
  });
  const taskProjection = captureRunTaskLineage(
    {
      workflow: taskWorkflow,
      repository: {
        sourcePath: taskRepositorySourcePath,
        requestedRevision: "HEAD",
        revision: taskRevision,
      },
    },
    taskLineageMint,
  );

  const delivery = createKnowledgeContinuationDeliveryIntent({
    mode: "patch-only",
    remoteName: null,
    targetBranch: null,
    targetRevision: null,
  });

  const privateTask = createKnowledgeContinuationPrivateTask({
    schemaVersion: 2,
    kind: "docsfab-knowledge-continuation-private-task",
    originalRunId: divergence.originalRunId ?? runId,
    workflow: taskWorkflow,
    instruction: taskInstruction,
    instructionSha256: instructionSha256(taskInstruction),
    repository: {
      identitySha256: taskRepositoryIdentitySha256,
      revision: taskRevision,
      sourcePath: taskRepositorySourcePath,
      requestedRevision: "HEAD",
    },
    delivery,
    targetConflictReceipt: null,
    taskLineage: taskProjection,
    continuationTargets: null,
  });
  const originalTaskArtifactSha256 = canonicalDigest(privateTask);
  await store.putRecord(originalTaskArtifactSha256, privateTask);

  const receipt = createKnowledgeContinuationReceipt({
    schemaVersion: 1,
    kind: "docsfab-knowledge-continuation-receipt",
    originalRunId: runId,
    repositoryIdentitySha256,
    repositoryRevision: revision,
    workflow: "create-documentation",
    instructionSha256: instructionSha256(boundInstruction),
    candidateSnapshotSha256: "a".repeat(64),
    candidateArtifactSha256: "b".repeat(64),
    candidateBytesSha256: "c".repeat(64),
    originalTaskArtifactSha256,
    originalTaskBindingArtifactSha256: "e".repeat(64),
    originalTaskBindingBytesSha256: "f".repeat(64),
    originArtifactSha256,
    lineageArtifactSha256,
    taskLineageProjectionSha256: correctProjection.projectionSha256,
    targetConflictReceipt: null,
    targetConflictReceiptSha256: null,
  });

  const now = new Date().toISOString();
  const record: RunRecord = {
    schemaVersion: 2,
    id: runId,
    workflow: "create-documentation",
    repository: { sourcePath: repositorySourcePath, requestedRevision: "HEAD", revision },
    workspace: { strategy: "tracked-export", disposable: true },
    taskLineage: correctProjection,
    knowledgeContinuationReceipt: receipt,
    status: "needs-input",
    error: "needs-input: attributed knowledge required to continue this Task.",
    createdAt: now,
    completedAt: now,
    models: [],
    skills: [],
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, turns: 0 },
    tools: { totalCalls: 0, failedCalls: 0, byTool: [] },
    steps: [],
  };
  decodeKnowledgeContinuationStoppedRun(record);
  const recordPath = join(stateDirectory, `${runId}.json`);
  await writeFile(recordPath, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  const snapshotPath = await writeSnapshot(root, "answered.json", resolvedSnapshotBody());
  return { stateDirectory, runId, record, snapshotPath };
}
describe("docsfab runs show divergent private-task bindings (#694 F5b)", () => {
  it.each([
    { field: "originalRunId", divergence: { originalRunId: "a-materially-different-run-id" } },
    { field: "workflow", divergence: { workflow: "update-documentation" as const } },
    {
      field: "instructionSha256",
      divergence: { instruction: "A materially different, never-approved instruction." },
    },
    {
      field: "repositoryIdentity",
      divergence: { repositorySourcePath: "/tmp/a-materially-different-repository-path" },
    },
    { field: "repositoryRevision", divergence: { revision: "e".repeat(40) } },
    { field: "lineageProjection", divergence: { lineageRunIdSuffix: "alt-lineage" } },
  ])(
    "rejects a $field divergence between the retained private task and its receipt even though the stored bytes digest matches",
    async ({ field, divergence }) => {
      const fixture = await buildDivergentPrivateTaskFixture(field, divergence);
      const resumability = await classifyRunResumability(fixture.record, fixture.stateDirectory);
      expect(resumability).toEqual({ category: "resumable", reason: "no-attempt-yet" });
      const outcome = await projectRunContinuationCommand({
        record: fixture.record,
        resumability,
        stateDirectory: fixture.stateDirectory,
        stateDirectoryExplicit: true,
        canonSnapshotPath: fixture.snapshotPath,
        acceptCandidateSnapshot: true,
        authorityId: "operator-test-1",
      });
      expect(outcome.disposition).toBe("unverifiable");
      if (outcome.disposition === "unverifiable") {
        expect(outcome.reason).toContain("Unverifiable:");
      }

      const io = await captureIo(() =>
        handleRunsCommand([
          "show",
          fixture.runId,
          "--state-dir",
          fixture.stateDirectory,
          "--canon-snapshot",
          fixture.snapshotPath,
          "--accept-candidate-snapshot",
          "--authority-id",
          "operator-test-1",
        ]),
      );
      expect(io.stdout).not.toContain("--resume-from");
    },
  );
});

describe("editorial needs-input class (#910)", () => {
  it("classifies InputAsk needs-input as resumable and NEXT is continue, not doctor", async () => {
    const root = await roots.create("docsfab-editorial-resume-");
    const stateDirectory = join(root, "state");
    await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
    const record = editorialInputAskRecord("editorial-resume-001");
    const recordPath = join(stateDirectory, `${record.id}.json`);
    await writeFile(recordPath, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
    const resumability = await classifyRunResumability(record, stateDirectory);
    expect(resumability).toEqual({ category: "resumable", reason: "needs-input" });
    const next = buildRunHumanNextCommand({
      record,
      recordPath,
      repositoryPath: record.repository.sourcePath,
      exitCode: 2,
    });
    expect(next?.command).toBe("docsfab do --continue editorial-resume-001");
    expect(next?.command).not.toContain("docsfab doctor");
    expect(next?.reason).toContain("InputAsk");
    const io = await captureIo(() =>
      handleRunsCommand(["show", record.id, "--state-dir", stateDirectory]),
    );
    expect(io.stdout).toContain("Resumability: resumable (needs-input)");
    expect(io.stdout).toContain("docsfab do --continue editorial-resume-001");
    expect(io.stdout).not.toContain("docsfab doctor");
  });
});

function editorialInputAskRecord(runId: string): RunRecord {
  const record: RunRecord = {
    schemaVersion: 2,
    id: runId,
    workflow: "update-documentation",
    repository: {
      sourcePath: "/tmp/docsfab-editorial-resume",
      requestedRevision: "HEAD",
      revision: "b".repeat(40),
    },
    workspace: { strategy: "tracked-export", disposable: true },
    instruction: "Update docs/cli.md so it documents the current public option.",
    status: "needs-input",
    createdAt: "2026-09-16T12:00:00.000Z",
    completedAt: "2026-09-16T12:00:01.000Z",
    models: [],
    skills: [],
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, turns: 0 },
    tools: { totalCalls: 0, failedCalls: 0, byTool: [] },
    steps: [
      {
        id: "plan-documentation",
        title: "Plan documentation",
        skill: "plan-documentation",
        mode: "read-only",
        status: "needs-input",
        summary: "The planner asked for named InputAsk fills.",
      },
    ],
  };
  const evidence = workflowOutcomeStepEvidence(record, "plan-documentation");
  record.workflowOutcome = createWorkflowOutcome(
    {
      disposition: "needs-input",
      findings: [
        {
          id: "finding:editorial:prd",
          kind: "missing-governed-input",
          severity: "warning",
          code: "independent-rejection",
          inputId: "prd",
          evidenceIds: [evidence.id],
        },
      ],
      evidence: [evidence],
      limitations: [],
      openDecisions: [
        {
          id: "decision:editorial:prd",
          kind: "governed-input",
          inputId: "prd",
          evidenceIds: [evidence.id],
        },
      ],
      producedArtifacts: [],
    },
    record,
  );
  return record;
}
