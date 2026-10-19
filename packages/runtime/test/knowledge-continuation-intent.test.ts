// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * A knowledge continuation's pages come from the admitted reading its stopped
 * run stored in the private task, re-verified by the decoder for every reader:
 * a version 1 task (captured from the previous writer) stores none and reads
 * the request words as before, and a stored reading that no longer verifies
 * refuses with a named code, which `docsfab runs` reports as unverifiable.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { DurableArtifactStore } from "../src/artifacts/store.js";
import {
  createKnowledgeAcceptedSnapshot,
  type KnowledgeAcceptedSnapshotBodyV1,
} from "../src/canon/from-knowledge-snapshot.js";
import { continuationRequestedPageIntent } from "../src/cli/knowledge-resume.js";
import { loadKnowledgeContinuation } from "../src/cli/run/knowledge-continuation.js";
import type { RunRequestWithPublishProjection } from "../src/cli/run/request.js";
import { canonicalDigest } from "../src/contract-kit/index.js";
import type { RunRecord } from "../src/records/contracts.js";
import {
  createKnowledgeContinuationReceipt,
  createKnowledgeContinuationRetainedBytes,
  decodeKnowledgeContinuationPrivateTask,
  KnowledgeContinuationError,
} from "../src/records/knowledge-continuation.js";
import {
  classifyRunResumability,
  knowledgeContinuationArtifactsDirectory,
  projectRunContinuationCommand,
} from "../src/operator/run-resumability.js";
import type { RunRecordRequestIntentV1 } from "../src/request-intent/interpret-record.js";
import { advisoryIntent, recordedIntent, type IntentSpec } from "./helpers/first-pass-intent.js";
import { validModelConfig } from "./helpers.js";
import { temporaryRoots } from "./helpers/temp.js";

const runtimeRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const roots = temporaryRoots();
const PAGES = ["docs/guide.md", "docs/reference.md"] as const;
const UPDATE_PAGES: IntentSpec = {
  operation: "update",
  targets: PAGES.map((path) => ({ path, quote: path })),
};
const OTHER_INSTRUCTION = "Rewrite docs/guide.md and docs/reference.md from scratch.";

/** A version 1 private task, as the previous writer stored it, byte for byte. */
async function legacyTask(): Promise<Record<string, unknown>> {
  return JSON.parse(
    await readFile(
      join(runtimeRoot, "test/fixtures/knowledge-continuation/private-task-v1.json"),
      "utf8",
    ),
  ) as Record<string, unknown>;
}

function withTargets(
  legacy: Record<string, unknown>,
  continuationTargets: unknown,
): Record<string, unknown> {
  return { ...legacy, schemaVersion: 2, continuationTargets };
}

const admitted = (requestIntent: RunRecordRequestIntentV1) => ({
  source: "admitted-intent",
  requestIntent,
});

/** A candidate snapshot with nothing left to answer: it supports a multi-page request. */
function answeredSnapshotBody(): KnowledgeAcceptedSnapshotBodyV1 {
  return {
    projectId: "PRJ-001",
    modelVersionId: "MODEL-001",
    streamVersion: 4,
    status: "candidate",
    claims: [
      {
        id: "CL-BEHAVIOR",
        kind: "behavior",
        scope: "Fixture",
        statement: "The fixture prints its version.",
        modelState: "candidate",
        evidenceIds: ["SRC-README"],
      },
    ],
    sources: [{ id: "SRC-README", locator: "readme:README.md" }],
    conflicts: [],
  };
}

/**
 * A coherent stopped run around `privateTask`, whatever it holds: the
 * receipt and run record are recomputed over it, so only the private-task
 * decoder stands between a forged stored reading and its readers.
 */
async function stoppedRunAround(privateTask: Record<string, unknown>) {
  const root = await roots.create("docsfab-continuation-intent-");
  const stateDirectory = join(root, "state", "runs");
  const store = new DurableArtifactStore(knowledgeContinuationArtifactsDirectory(stateDirectory));
  const task = privateTask as {
    originalRunId: string;
    workflow: "create-documentation" | "update-documentation";
    instructionSha256: string;
    repository: { identitySha256: string; revision: string; sourcePath: string };
    taskLineage: { projectionSha256: string };
  };
  const snapshot = createKnowledgeAcceptedSnapshot(answeredSnapshotBody());
  const candidate = createKnowledgeContinuationRetainedBytes(
    "candidate-snapshot",
    `${JSON.stringify(snapshot)}\n`,
  );
  const binding = createKnowledgeContinuationRetainedBytes(
    "original-task-binding",
    `${JSON.stringify({ fixture: "original-task-binding" })}\n`,
  );
  const origin = { fixture: "origin" };
  const lineage = { fixture: "lineage" };
  const originalTaskArtifactSha256 = canonicalDigest(privateTask);
  await Promise.all([
    store.putRecord(originalTaskArtifactSha256, privateTask),
    store.putRecord(canonicalDigest(candidate), candidate),
    store.putRecord(canonicalDigest(binding), binding),
    store.putRecord(canonicalDigest(origin), origin),
    store.putRecord(canonicalDigest(lineage), lineage),
  ]);
  const receipt = createKnowledgeContinuationReceipt({
    schemaVersion: 1,
    kind: "docsfab-knowledge-continuation-receipt",
    originalRunId: task.originalRunId,
    repositoryIdentitySha256: task.repository.identitySha256,
    repositoryRevision: task.repository.revision,
    workflow: task.workflow,
    instructionSha256: task.instructionSha256,
    candidateSnapshotSha256: snapshot.snapshotSha256,
    candidateArtifactSha256: canonicalDigest(candidate),
    candidateBytesSha256: candidate.bytesSha256,
    originalTaskArtifactSha256,
    originalTaskBindingArtifactSha256: canonicalDigest(binding),
    originalTaskBindingBytesSha256: binding.bytesSha256,
    originArtifactSha256: canonicalDigest(origin),
    lineageArtifactSha256: canonicalDigest(lineage),
    taskLineageProjectionSha256: task.taskLineage.projectionSha256,
    targetConflictReceipt: null,
    targetConflictReceiptSha256: null,
  });
  const now = new Date().toISOString();
  const record: RunRecord = {
    schemaVersion: 2,
    id: task.originalRunId,
    workflow: task.workflow,
    repository: {
      sourcePath: task.repository.sourcePath,
      requestedRevision: "HEAD",
      revision: task.repository.revision,
    },
    workspace: { strategy: "tracked-export", disposable: true },
    taskLineage: privateTask.taskLineage as RunRecord["taskLineage"],
    knowledgeContinuationReceipt: receipt,
    status: "needs-input",
    error: "unresolved-claim",
    createdAt: now,
    completedAt: now,
    models: [],
    skills: [],
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, turns: 0 },
    tools: { totalCalls: 0, failedCalls: 0, byTool: [] },
    steps: [],
  };
  await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
  await writeFile(join(stateDirectory, `${record.id}.json`), `${JSON.stringify(record)}\n`, {
    mode: 0o600,
  });
  const snapshotPath = join(root, "answered.json");
  await writeFile(snapshotPath, `${JSON.stringify(snapshot)}\n`);
  return { stateDirectory, record, snapshotPath };
}

async function project(privateTask: Record<string, unknown>) {
  const stopped = await stoppedRunAround(privateTask);
  return await projectRunContinuationCommand({
    record: stopped.record,
    resumability: await classifyRunResumability(stopped.record, stopped.stateDirectory),
    stateDirectory: stopped.stateDirectory,
    stateDirectoryExplicit: true,
    canonSnapshotPath: stopped.snapshotPath,
    acceptCandidateSnapshot: true,
    authorityId: "operator-test-1",
  });
}

async function load(privateTask: Record<string, unknown>): Promise<unknown> {
  const stopped = await stoppedRunAround(privateTask);
  const task = privateTask as { workflow: string; instruction: string };
  return await loadKnowledgeContinuation(
    {
      workflow: task.workflow,
      repositoryPath: (privateTask.repository as { sourcePath: string }).sourcePath,
      revision: "HEAD",
      instruction: task.instruction,
      allowWrite: true,
      releaseGate: false,
      verbose: false,
      json: false,
      showScan: false,
      resumeFrom: stopped.record.id,
      canonSnapshotPath: stopped.snapshotPath,
      acceptCandidateSnapshot: true,
      canonSnapshotAuthorityId: "operator-test-1",
    } as RunRequestWithPublishProjection,
    {
      projectRoot: runtimeRoot,
      skillCrateDirectory: join(runtimeRoot, "skill-crate"),
      qualityDirectory: join(runtimeRoot, "quality"),
      qualityPackDirectory: join(runtimeRoot, "quality-pack"),
      stateDirectory: stopped.stateDirectory,
      retryPolicy: { maxRetries: 0, baseDelayMs: 0, maxDelayMs: 0, retryableCategories: [] },
      model: validModelConfig,
    },
  ).catch((error: unknown) => error);
}

describe("the private task's stored reading, at the decoder (V1, V2)", () => {
  it("decodes a version 1 task as stored, with no pages to bind", async () => {
    const legacy = await legacyTask();
    const decoded = decodeKnowledgeContinuationPrivateTask(legacy);
    expect(decoded.schemaVersion).toBe(1);
    expect(canonicalDigest(decoded)).toBe(canonicalDigest(legacy));
    expect(continuationRequestedPageIntent(decoded)).toBeUndefined();
  });

  it("binds the pages of a stored admission that verifies", async () => {
    const legacy = await legacyTask();
    const instruction = legacy.instruction as string;
    const decoded = decodeKnowledgeContinuationPrivateTask(
      withTargets(legacy, admitted(recordedIntent(instruction, UPDATE_PAGES))),
    );
    expect(continuationRequestedPageIntent(decoded)).toEqual({ writeTargets: PAGES });
    expect(
      continuationRequestedPageIntent(
        decodeKnowledgeContinuationPrivateTask(withTargets(legacy, null)),
      ),
    ).toBeUndefined();
  });

  const refusals: ReadonlyArray<
    readonly [string, string, (legacy: Record<string, unknown>) => Record<string, unknown>]
  > = [
    [
      "a version 2 task without the key",
      "invalid-shape",
      (legacy) => ({ ...legacy, schemaVersion: 2 }),
    ],
    [
      "a reading sealed for other words",
      "digest-mismatch",
      (legacy) => withTargets(legacy, admitted(recordedIntent(OTHER_INSTRUCTION, UPDATE_PAGES))),
    ],
    [
      "an advisory reading",
      "binding-mismatch",
      (legacy) =>
        withTargets(
          legacy,
          admitted(
            advisoryIntent(
              legacy.instruction as string,
              UPDATE_PAGES,
              "request-intent-operation-mismatch",
            ),
          ),
        ),
    ],
    [
      "an admission for another operation",
      "binding-mismatch",
      (legacy) =>
        withTargets(
          legacy,
          admitted(
            recordedIntent(legacy.instruction as string, { ...UPDATE_PAGES, operation: "create" }),
          ),
        ),
    ],
    [
      // Not a seal or instruction mismatch: a record that is not a reading at all.
      "a malformed reading",
      "invalid-value",
      (legacy) => withTargets(legacy, admitted({} as RunRecordRequestIntentV1)),
    ],
    [
      "an unknown target source",
      "invalid-value",
      (legacy) =>
        withTargets(legacy, {
          source: "structure",
          requestIntent: recordedIntent(legacy.instruction as string, UPDATE_PAGES),
        }),
    ],
  ];
  it.each(refusals)("refuses %s with %s", async (_name, code, build) => {
    const legacy = await legacyTask();
    expect(() => decodeKnowledgeContinuationPrivateTask(build(legacy))).toThrow(
      expect.objectContaining({ name: "KnowledgeContinuationError", code }),
    );
  });

  it("never falls back to the words for a stored admission without an intent", async () => {
    const legacy = await legacyTask();
    const admission = recordedIntent(legacy.instruction as string, UPDATE_PAGES);
    // Only a task that skipped the decoder can carry this; the helper refuses it.
    const undecoded = withTargets(legacy, admitted({ ...admission, intent: null }));
    expect(() =>
      continuationRequestedPageIntent(
        undecoded as unknown as Parameters<typeof continuationRequestedPageIntent>[0],
      ),
    ).toThrow(expect.objectContaining({ code: "binding-mismatch" }));
  });

  it("refuses a forged stored reading at the continuation load with its code (V2)", async () => {
    const legacy = await legacyTask();
    const forged = withTargets(legacy, admitted(recordedIntent(OTHER_INSTRUCTION, UPDATE_PAGES)));
    const error = await load(forged);
    expect(error).toBeInstanceOf(KnowledgeContinuationError);
    expect(error).toMatchObject({ code: "digest-mismatch" });
  });
});

describe("the docsfab runs continuation command reads the stored pages (R1, R1t)", () => {
  it("projects the command for a stored admission the words alone do not support (R1)", async () => {
    const legacy = await legacyTask();
    const instruction = legacy.instruction as string;
    expect(
      await project(withTargets(legacy, admitted(recordedIntent(instruction, UPDATE_PAGES)))),
    ).toMatchObject({ disposition: "ready" });
    // A version 1 task and a run with no admitted reading keep today's answer:
    // these verb-free words name no page the candidate supports.
    for (const task of [legacy, withTargets(legacy, null)]) {
      expect(await project(task), String(task.schemaVersion)).toMatchObject({
        disposition: "missing-input",
      });
    }
  });

  it("reports a forged or non-admitted stored reading as unverifiable, never a throw (R1t)", async () => {
    const legacy = await legacyTask();
    for (const forged of [
      withTargets(legacy, admitted(recordedIntent(OTHER_INSTRUCTION, UPDATE_PAGES))),
      withTargets(
        legacy,
        admitted(
          advisoryIntent(
            legacy.instruction as string,
            UPDATE_PAGES,
            "request-intent-operation-mismatch",
          ),
        ),
      ),
    ]) {
      expect(await project(forged)).toEqual({
        disposition: "unverifiable",
        reason: "Unverifiable: the retained original-task evidence for this run is malformed.",
      });
    }
  });
});
