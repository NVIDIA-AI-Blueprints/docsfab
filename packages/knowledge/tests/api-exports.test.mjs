// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { EvidenceSourceError } from "../src/evidence-source.mjs";
import { KnowledgeBackend } from "../src/backend.mjs";
import {
  documentationBriefMarkdown,
  knowledgeAcceptedSnapshot,
  sharedModelMarkdown,
  workflowRecordMarkdown,
} from "../src/exports.mjs";
import { createKnowledgeServer } from "../src/server.mjs";
import { KnowledgeStore } from "../src/store.mjs";

const temporaryDirectories = [];
const services = [];

async function newBackend() {
  const directory = await mkdtemp(path.join(tmpdir(), "knowledge-gathering-api-"));
  temporaryDirectories.push(directory);
  const store = new KnowledgeStore(directory);
  await store.initialize();
  return new KnowledgeBackend(store);
}

async function dispatch(backend, command, input, actor = "test-operator") {
  return backend.dispatch(command, {
    expectedVersion: backend.getState().version,
    actor,
    input,
  });
}

async function populatedBackend() {
  const backend = await newBackend();
  await dispatch(backend, "project.activate", {
    name: "Example Product",
    productVersion: "Preview",
    outcome: "Continuously improve trustworthy documentation",
    audience: "Product teams",
    targetTask: "Build an accurate shared mental model",
    authority: {
      requesterEntitlement: "Contribute",
      repositoryGrant: "Observe",
      workflowPolicy: "Contribute",
      backendCapability: "Contribute",
    },
    policy: { localOnly: true },
  });
  await dispatch(backend, "source.register", {
    projectId: "PRJ-001",
    title: "Product design",
    kind: "design",
    evidenceRole: "intent",
  });
  await dispatch(backend, "claim.propose", {
    projectId: "PRJ-001",
    statement: "The knowledge-gathering workflow establishes a shared model before documentation generation.",
    kind: "intent",
    scope: "Example Product",
    evidenceIds: ["SRC-001"],
  });
  await dispatch(backend, "claim.update-status", {
    projectId: "PRJ-001",
    claimId: "CL-001",
    field: "intentApproval",
    value: "approved",
  });
  await dispatch(backend, "model.create-version", {
    projectId: "PRJ-001",
    title: "Candidate model",
    claimIds: ["CL-001"],
  });
  await dispatch(backend, "model.approve-version", {
    projectId: "PRJ-001",
    modelVersionId: "MODEL-001",
    approver: { name: "Andrew", authority: "product-decision-owner" },
  });
  await dispatch(backend, "docs.create-plan", {
    projectId: "PRJ-001",
    modelVersionId: "MODEL-001",
    title: "Example Product overview",
    audience: "Product teams",
    targetTask: "Understand Example Product",
    outcome: "Decide whether to pilot it",
    scope: "Shared-model-first documentation lifecycle",
    exclusions: "Production deployment",
    requiredChecks: ["Intent owner review", "Behavior verification"],
  });
  await dispatch(backend, "workflow.create", {
    projectId: "PRJ-001",
    outcome: "Create the Example Product overview",
    version: "draft-v1",
  });
  return backend;
}

test.after(async () => {
  for (const service of services) {
    await service.close();
  }
  for (const directory of temporaryDirectories) {
    await rm(directory, { recursive: true, force: true });
  }
});

test("exports are deterministic projections of canonical state", async () => {
  const backend = await populatedBackend();
  const state = backend.getState();
  const model = sharedModelMarkdown(state, "PRJ-001");
  assert.equal(model, sharedModelMarkdown(state, "PRJ-001"));
  assert.match(model, /MODEL-001/);
  assert.match(model, /Intent approval: approved/);
  const brief = documentationBriefMarkdown(state, "PRJ-001");
  assert.match(brief, /Example Product overview/);
  assert.match(brief, /CL-001/);
  const workflow = workflowRecordMarkdown(state, "WF-001");
  assert.match(workflow, /activate: not-started/);
});

test("accepted knowledge snapshot is sealed JSON without interview bodies", async () => {
  const backend = await populatedBackend();
  const state = backend.getState();
  const snapshot = knowledgeAcceptedSnapshot(state, "PRJ-001");
  assert.equal(snapshot.kind, "knowledge-accepted-snapshot");
  assert.equal(snapshot.schemaVersion, 1);
  assert.equal(snapshot.status, "approved");
  assert.equal(snapshot.projectId, "PRJ-001");
  assert.equal(snapshot.modelVersionId, "MODEL-001");
  assert.equal(snapshot.streamVersion, state.version);
  assert.equal(snapshot.claims[0]?.id, "CL-001");
  assert.equal(snapshot.sources[0]?.id, "SRC-001");
  assert.deepEqual(snapshot.conflicts, []);
  assert.match(snapshot.snapshotSha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(snapshot, knowledgeAcceptedSnapshot(state, "PRJ-001"));
  const serialized = JSON.stringify(snapshot);
  assert.equal(serialized.includes("turns"), false);
  assert.equal(serialized.includes("question"), false);
  assert.equal(serialized.includes("answer"), false);
  assert.equal(serialized.includes('"title"'), false);
  const candidate = state.modelVersions["MODEL-001"];
  candidate.status = "candidate";
  assert.throws(
    () => knowledgeAcceptedSnapshot(state, "PRJ-001", "MODEL-001"),
    /not approved/,
  );
});

test("localhost API accepts versioned commands and exposes state", async () => {
  const backend = await newBackend();
  const service = createKnowledgeServer({ backend, port: 0 });
  services.push(service);
  const address = await service.listen();
  const origin = `http://${address.host}:${address.port}`;
  const response = await fetch(`${origin}/v1/commands`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      command: "project.activate",
      expectedVersion: 0,
      actor: "api-test",
      input: {
        name: "Example Product",
        productVersion: "Preview",
        outcome: "Build the shared model",
        audience: "Product teams",
        targetTask: "Understand the product",
        authority: {
          requesterEntitlement: "Contribute",
          repositoryGrant: "Observe",
          workflowPolicy: "Contribute",
          backendCapability: "Contribute",
        },
        policy: { localOnly: true },
      },
    }),
  });
  assert.equal(response.status, 201);
  assert.equal((await response.json()).state.version, 1);
  const stateResponse = await fetch(`${origin}/v1/state`);
  assert.equal(stateResponse.status, 200);
  assert.equal((await stateResponse.json()).projects["PRJ-001"].name, "Example Product");
});

test("API rejects evidence kebab codes as 400 rather than HTTP 500", async () => {
  const backend = {
    health: () => ({ ok: true }),
    getState: () => ({ version: 0, tasks: {}, projects: {} }),
    getEvents: () => [],
    dispatch() {
      throw new EvidenceSourceError("invalid-shape");
    },
  };
  const service = createKnowledgeServer({ backend, port: 0 });
  services.push(service);
  const address = await service.listen();
  const response = await fetch(`http://${address.host}:${address.port}/v1/commands`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      command: "source.register",
      expectedVersion: 0,
      actor: "evidence-test",
      input: { projectId: "PRJ-001" },
    }),
  });
  assert.equal(response.status, 400);
  assert.notEqual(response.status, 500);
  assert.match((await response.json()).error, /invalid-shape/);
});

test("API still treats Node errno codes as HTTP 500", async () => {
  const backend = {
    health: () => ({ ok: true }),
    getState: () => ({ version: 0, tasks: {}, projects: {} }),
    getEvents: () => [],
    dispatch() {
      const error = new Error("read failed");
      error.code = "EIO";
      throw error;
    },
  };
  const service = createKnowledgeServer({ backend, port: 0 });
  services.push(service);
  const address = await service.listen();
  const response = await fetch(`http://${address.host}:${address.port}/v1/commands`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      command: "source.register",
      expectedVersion: 0,
      actor: "errno-test",
      input: { projectId: "PRJ-001" },
    }),
  });
  assert.equal(response.status, 500);
});

test("API rejects stale mutations and non-loopback binding", async () => {
  const backend = await populatedBackend();
  const service = createKnowledgeServer({ backend, port: 0 });
  services.push(service);
  const address = await service.listen();
  const response = await fetch(`http://${address.host}:${address.port}/v1/commands`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      command: "source.register",
      expectedVersion: 0,
      actor: "stale-client",
      input: {
        projectId: "PRJ-001",
        title: "Stale source",
        kind: "design",
        evidenceRole: "intent",
      },
    }),
  });
  assert.equal(response.status, 409);
  assert.throws(
    () => createKnowledgeServer({ backend, host: "0.0.0.0" }),
    /loopback/,
  );
});
