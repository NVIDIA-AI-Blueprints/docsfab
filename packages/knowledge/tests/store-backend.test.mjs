// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { KnowledgeBackend } from "../src/backend.mjs";
import { KnowledgeStore } from "../src/store.mjs";

const temporaryDirectories = [];

async function newBackend() {
  const directory = await mkdtemp(path.join(tmpdir(), "knowledge-gathering-backend-"));
  temporaryDirectories.push(directory);
  const store = new KnowledgeStore(directory);
  await store.initialize();
  return { backend: new KnowledgeBackend(store), directory, store };
}

function command(expectedVersion, input, actor = "test-operator") {
  return { expectedVersion, actor, input };
}

async function activate(backend, expectedVersion = 0) {
  return backend.dispatch(
    "project.activate",
    command(expectedVersion, {
      name: "Example Product",
      productVersion: "Preview",
      outcome: "Create a shared model and documentation brief",
      audience: "Product and documentation teams",
      targetTask: "Understand and document Example Product",
      authority: {
        requesterEntitlement: "Contribute",
        repositoryGrant: "Observe",
        workflowPolicy: "Contribute",
        backendCapability: "Contribute",
      },
      policy: { localOnly: true },
    }),
  );
}

test.after(async () => {
  for (const directory of temporaryDirectories) {
    await rm(directory, { recursive: true, force: true });
  }
});

test("event log persists and reconstructs identical state", async () => {
  const { backend, directory } = await newBackend();
  await activate(backend);
  await backend.dispatch(
    "source.register",
    command(1, {
      projectId: "PRJ-001",
      title: "Product design",
      kind: "design",
      evidenceRole: "intent",
    }),
  );

  const restoredStore = new KnowledgeStore(directory);
  await restoredStore.initialize();
  assert.deepEqual(restoredStore.getState(), backend.getState());
  assert.equal(restoredStore.getEvents().length, 2);
});

test("malformed event logs fail initialization", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "knowledge-gathering-backend-"));
  temporaryDirectories.push(directory);
  await writeFile(path.join(directory, "events.jsonl"), "{not-json}\n", { encoding: "utf8", mode: 0o600 });
  const store = new KnowledgeStore(directory);
  await assert.rejects(store.initialize(), /invalid JSON at line 1/);
});

test("concurrent commands serialize and reject the stale writer", async () => {
  const { backend } = await newBackend();
  await activate(backend);
  const first = backend.dispatch(
    "source.register",
    command(1, {
      projectId: "PRJ-001",
      title: "Source A",
      kind: "design",
      evidenceRole: "intent",
    }),
  );
  const second = backend.dispatch(
    "source.register",
    command(1, {
      projectId: "PRJ-001",
      title: "Source B",
      kind: "repository",
      evidenceRole: "behavior",
    }),
  );
  const results = await Promise.allSettled([first, second]);
  assert.deepEqual(
    results.map((result) => result.status),
    ["fulfilled", "rejected"],
  );
  assert.match(results[1].reason.message, /Stale command/);
  assert.equal(Object.keys(backend.getState().sources).length, 1);
});

test("work packets capture the canonical input version", async () => {
  const { backend } = await newBackend();
  await activate(backend);
  await backend.dispatch(
    "workflow.create",
    command(1, {
      projectId: "PRJ-001",
      outcome: "Develop the shared model",
      version: "draft-v1",
    }),
  );
  const result = await backend.dispatch(
    "task.queue",
    command(2, {
      projectId: "PRJ-001",
      workflowId: "WF-001",
      stepId: "model",
      workPacket: {
        kind: "interview-product-model",
        skill: "skills/interview-product-model/SKILL.md",
        inputRefs: ["PRJ-001"],
        expectedOutputs: ["candidate claims"],
        stopConditions: ["missing consent"],
      },
    }),
  );
  assert.equal(result.state.tasks["TASK-001"].workPacket.inputVersion, 2);
  assert.equal(result.state.tasks["TASK-001"].state, "queued");
});

test("artifact registration writes content before recording its digest", async () => {
  const { backend, directory } = await newBackend();
  await activate(backend);
  const result = await backend.dispatch(
    "artifact.register",
    command(1, {
      projectId: "PRJ-001",
      title: "Candidate shared model",
      kind: "shared-model",
      extension: "md",
      content: "# Candidate shared model\n",
      state: "draft",
    }),
  );
  const artifact = result.state.artifacts["ART-001"];
  assert.equal(
    await readFile(path.join(directory, artifact.path), "utf8"),
    "# Candidate shared model\n",
  );
  assert.match(artifact.digest, /^[a-f0-9]{64}$/);
});

