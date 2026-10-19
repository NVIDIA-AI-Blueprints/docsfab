// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import http from "node:http";
import { PassThrough } from "node:stream";
import test from "node:test";

import { DocsFabRuntimeAdapter } from "../src/adapters/docsfab.mjs";
import { HermesRuntimeAdapter } from "../src/adapters/hermes.mjs";
import {
  renderWorkPacketPrompt,
  validateRuntimeAdapter,
} from "../src/runtime-adapter.mjs";

const servers = [];

class FakeChild extends EventEmitter {
  constructor({
    closeSignals = ["SIGTERM", "SIGKILL"],
    groupExitSignals = closeSignals,
    pid,
  } = {}) {
    super();
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    this.kills = [];
    this.closeSignals = new Set(closeSignals);
    this.groupAlive = true;
    this.groupExitSignals = new Set(groupExitSignals);
    this.pid = pid;
  }

  kill(signal) {
    this.kills.push(signal);
    if (this.groupExitSignals.has(signal)) this.groupAlive = false;
    if (this.closeSignals.has(signal)) {
      queueMicrotask(() => this.emit("close", null, signal));
    }
    return true;
  }
}

function fakeDocsFab({ immediateRunOutput, closeSignals, groupExitSignals } = {}) {
  const calls = [];
  const runs = [];
  let nextPid = 10000;
  const spawnImplementation = (executable, args, options) => {
    const child = new FakeChild({ closeSignals, groupExitSignals, pid: nextPid });
    nextPid += 1;
    calls.push({ executable, args, options, child });
    queueMicrotask(() => {
      child.emit("spawn");
      if (args[0] === "list") {
        child.stdout.end(
          "audit      Audit documentation\nfoundation Foundation inspection\npolish     Polish documentation\n",
        );
        child.emit("close", 0, null);
      } else {
        runs.push(child);
        if (immediateRunOutput !== undefined) {
          child.stdout.end(JSON.stringify(immediateRunOutput));
          child.emit("close", 0, null);
        }
      }
    });
    return child;
  };
  const groupSignals = [];
  const killImplementation = (pid, signal) => {
    groupSignals.push({ pid, signal });
    const call = calls.find((item) => item.child.pid === -pid);
    if (!call) {
      const error = new Error("missing process group");
      error.code = "ESRCH";
      throw error;
    }
    if (signal === 0) {
      if (call.child.groupAlive) return true;
      const error = new Error("process group exited");
      error.code = "ESRCH";
      throw error;
    }
    return call.child.kill(signal);
  };
  return { calls, groupSignals, killImplementation, runs, spawnImplementation };
}

function runtimeContext(overrides = {}) {
  return {
    version: 7,
    runtimeDisclosure: {
      classification: "nvidia-internal",
      processArgvApproved: true,
    },
    ...overrides,
  };
}

function runResult(runId = "R-1") {
  return {
    schemaVersion: 1,
    kind: "docsfab-run-result",
    execution: { runId, status: "completed" },
    resultSha256: "a".repeat(64),
  };
}

function claimedTask() {
  return {
    id: "TASK-001",
    projectId: "PRJ-001",
    workflowId: "WF-001",
    stepId: "model",
    state: "claimed",
    workPacket: {
      kind: "interview-product-model",
      skill: "skills/interview-product-model/SKILL.md",
      inputVersion: 7,
      inputRefs: ["PRJ-001", "P-001"],
      expectedOutputs: ["candidate claims", "unresolved questions"],
      stopConditions: ["missing consent", "lost provenance"],
    },
  };
}

async function fakeHermes(features = {}) {
  const requests = [];
  const server = http.createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) {
      body += chunk.toString("utf8");
    }
    requests.push({
      method: request.method,
      url: request.url,
      authorization: request.headers.authorization,
      body: body ? JSON.parse(body) : null,
    });
    response.setHeader("content-type", "application/json");
    if (request.url === "/health") {
      response.end(JSON.stringify({ status: "ok" }));
      return;
    }
    if (request.url === "/v1/capabilities") {
      response.end(
        JSON.stringify({
          platform: "hermes-agent",
          features: {
            run_submission: true,
            run_status: true,
            run_stop: true,
            ...features,
          },
        }),
      );
      return;
    }
    if (request.method === "POST" && request.url === "/v1/runs") {
      response.end(JSON.stringify({ run_id: "run_001", status: "started" }));
      return;
    }
    if (request.method === "GET" && request.url === "/v1/runs/run_001") {
      response.end(
        JSON.stringify({ run_id: "run_001", status: "completed", output: "Done" }),
      );
      return;
    }
    if (request.method === "POST" && request.url === "/v1/runs/run_001/stop") {
      response.end(JSON.stringify({ status: "stopping" }));
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ error: "not found" }));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  servers.push(server);
  return { baseUrl: `http://127.0.0.1:${server.address().port}`, requests };
}

test.after(async () => {
  for (const server of servers) {
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
});

test("work-packet prompts preserve input version and authority boundary", () => {
  const prompt = renderWorkPacketPrompt(claimedTask(), {
    version: 7,
    claims: [{ id: "CL-001", statement: "Candidate" }],
  });
  assert.match(prompt, /Canonical input version: 7/);
  assert.match(prompt, /DocsFab knowledge control plane is the canonical system of record/);
  assert.match(prompt, /Do not approve a shared\s+model/);
  assert.throws(
    () => renderWorkPacketPrompt(claimedTask(), { version: 8 }),
    /does not match work packet/,
  );
});

test("DocsFab adapter invokes the product CLI and tracks a completed run", async () => {
  const fake = fakeDocsFab();
  const adapter = new DocsFabRuntimeAdapter({
    repositoryPath: process.cwd(),
    workflow: "audit",
    killImplementation: fake.killImplementation,
    spawnImplementation: fake.spawnImplementation,
  });
  validateRuntimeAdapter(adapter);
  await assert.rejects(
    adapter.startRun({ task: claimedTask(), canonicalContext: runtimeContext() }),
    /not initialized/,
  );
  const initialized = await adapter.initialize();
  assert.equal(initialized.capabilities.platform, "docsfab-cli");
  assert.equal(adapter.name, "docsfab");

  const started = await adapter.startRun({
    task: claimedTask(),
    canonicalContext: runtimeContext({ claims: [] }),
  });
  assert.equal(started.status, "started");
  const runCall = fake.calls.find((call) => call.args[0] === "run");
  assert.equal(runCall.executable, "docsfab");
  assert.equal(runCall.options.shell, false);
  assert.equal(runCall.options.detached, true);
  assert.deepEqual(runCall.args.slice(0, 3), ["run", "audit", "--repo"]);
  assert.ok(runCall.args.includes("--json"));
  assert.match(runCall.args[runCall.args.indexOf("--instruction") + 1], /Task: TASK-001/);

  fake.runs[0].stdout.end(JSON.stringify(runResult()));
  fake.runs[0].emit("close", 0, null);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(await adapter.getRun(started.run_id), {
    run_id: started.run_id,
    status: "completed",
    exit_code: 0,
    signal: null,
    output: runResult(),
  });
});

test("DocsFab adapter fails a missing workflow and stops an active CLI run", async () => {
  const missingFake = fakeDocsFab();
  const missing = new DocsFabRuntimeAdapter({
    repositoryPath: process.cwd(),
    workflow: "not-catalogued",
    killImplementation: missingFake.killImplementation,
    spawnImplementation: missingFake.spawnImplementation,
  });
  await assert.rejects(missing.initialize(), /does not list the configured workflow/);

  const fake = fakeDocsFab();
  const adapter = new DocsFabRuntimeAdapter({
    repositoryPath: process.cwd(),
    killImplementation: fake.killImplementation,
    spawnImplementation: fake.spawnImplementation,
  });
  await adapter.initialize();
  const started = await adapter.startRun({
    task: claimedTask(),
    canonicalContext: runtimeContext(),
  });
  assert.equal((await adapter.getRun(started.run_id)).status, "running");
  const stopped = await adapter.stopRun(started.run_id);
  assert.equal(stopped.status, "stopped");
  assert.deepEqual(
    fake.groupSignals.filter((entry) => entry.signal !== 0),
    [{ pid: -fake.runs[0].pid, signal: "SIGTERM" }],
  );
  assert.ok(fake.groupSignals.some((entry) => entry.signal === 0));
  await assert.rejects(adapter.getRun("unknown"), /Unknown DocsFab run/);
});

test("DocsFab adapter bounds executor output", async () => {
  const fake = fakeDocsFab();
  const adapter = new DocsFabRuntimeAdapter({
    repositoryPath: process.cwd(),
    killImplementation: fake.killImplementation,
    maxOutputBytes: 128,
    spawnImplementation: fake.spawnImplementation,
  });
  await adapter.initialize();
  const started = await adapter.startRun({
    task: claimedTask(),
    canonicalContext: runtimeContext(),
  });
  fake.runs[0].stdout.write("x".repeat(129));
  await new Promise((resolve) => setImmediate(resolve));
  const failed = await adapter.getRun(started.run_id);
  assert.equal(failed.status, "failed");
  assert.match(failed.error, /exceeded the configured byte limit/);
  assert.deepEqual(fake.groupSignals, [{ pid: -fake.runs[0].pid, signal: "SIGKILL" }]);
});

test("DocsFab adapter preserves an immediate terminal run status", async () => {
  const fake = fakeDocsFab({ immediateRunOutput: runResult("R-fast") });
  const adapter = new DocsFabRuntimeAdapter({
    repositoryPath: process.cwd(),
    killImplementation: fake.killImplementation,
    spawnImplementation: fake.spawnImplementation,
  });
  await adapter.initialize();
  const completed = await adapter.startRun({
    task: claimedTask(),
    canonicalContext: runtimeContext(),
  });
  assert.equal(completed.status, "completed");
  assert.deepEqual(completed.output, runResult("R-fast"));
  assert.equal((await adapter.getRun(completed.run_id)).status, "completed");
});

test("DocsFab adapter binds probed configuration and narrows the child environment", async () => {
  const fake = fakeDocsFab();
  const adapter = new DocsFabRuntimeAdapter({
    repositoryPath: process.cwd(),
    environment: { HOME: "/safe", PATH: "/bin", SECRET_TOKEN: "do-not-forward" },
    killImplementation: fake.killImplementation,
    spawnImplementation: fake.spawnImplementation,
  });
  await adapter.initialize();
  assert.throws(() => {
    adapter.executable = "substituted";
  }, TypeError);
  assert.throws(() => {
    adapter.workflow = "unprobed";
  }, TypeError);
  assert.throws(() => {
    adapter.repositoryPath = "/substituted";
  }, TypeError);
  assert.throws(() => {
    adapter.revision = "unprobed";
  }, TypeError);
  await adapter.startRun({
    task: claimedTask(),
    canonicalContext: runtimeContext(),
  });
  const runCall = fake.calls.find((call) => call.args[0] === "run");
  assert.equal(runCall.executable, "docsfab");
  assert.equal(runCall.args[1], "audit");
  assert.deepEqual(runCall.options.env, { HOME: "/safe", PATH: "/bin" });
});

test("DocsFab adapter requires disclosure approval and rejects credential-like argv", async () => {
  const fake = fakeDocsFab();
  const adapter = new DocsFabRuntimeAdapter({
    repositoryPath: process.cwd(),
    killImplementation: fake.killImplementation,
    spawnImplementation: fake.spawnImplementation,
  });
  await adapter.initialize();
  await assert.rejects(
    adapter.startRun({
      task: claimedTask(),
      canonicalContext: { version: 7 },
    }),
    /process-visible instruction requires/,
  );
  await assert.rejects(
    adapter.startRun({
      task: claimedTask(),
      canonicalContext: runtimeContext({ token: `glpat-${"a".repeat(24)}` }),
    }),
    /credential-like material/,
  );
  assert.equal(fake.calls.filter((call) => call.args[0] === "run").length, 0);
});

test("DocsFab adapter fails closed on invalid JSON run results", async () => {
  for (const output of [
    "not-json",
    `${JSON.stringify(runResult())}\n${JSON.stringify(runResult("R-2"))}`,
    JSON.stringify({ ...runResult(), schemaVersion: 2 }),
    JSON.stringify({ schemaVersion: 1, kind: "docsfab-run-result" }),
  ]) {
    const fake = fakeDocsFab();
    const adapter = new DocsFabRuntimeAdapter({
      repositoryPath: process.cwd(),
      killImplementation: fake.killImplementation,
      spawnImplementation: fake.spawnImplementation,
    });
    await adapter.initialize();
    const started = await adapter.startRun({
      task: claimedTask(),
      canonicalContext: runtimeContext(),
    });
    fake.runs[0].stdout.end(output);
    fake.runs[0].emit("close", 0, null);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal((await adapter.getRun(started.run_id)).status, "failed");
  }
});

test("DocsFab adapter records unconfirmed process-group termination as failed", async () => {
  const fake = fakeDocsFab({ closeSignals: [], groupExitSignals: [] });
  const adapter = new DocsFabRuntimeAdapter({
    repositoryPath: process.cwd(),
    killImplementation: fake.killImplementation,
    spawnImplementation: fake.spawnImplementation,
  });
  await adapter.initialize();
  const started = await adapter.startRun({
    task: claimedTask(),
    canonicalContext: runtimeContext(),
  });
  const failed = await adapter.stopRun(started.run_id, { timeoutMs: 5 });
  assert.equal(failed.status, "failed");
  assert.match(failed.error, /termination is unconfirmed/);
  assert.deepEqual(
    fake.groupSignals.filter((entry) => entry.signal !== 0),
    [
      { pid: -fake.runs[0].pid, signal: "SIGTERM" },
      { pid: -fake.runs[0].pid, signal: "SIGKILL" },
    ],
  );
  assert.ok(fake.groupSignals.some((entry) => entry.signal === 0));
});

test("DocsFab adapter escalates and coalesces concurrent stop requests", async () => {
  const fake = fakeDocsFab({ closeSignals: ["SIGKILL"] });
  const adapter = new DocsFabRuntimeAdapter({
    repositoryPath: process.cwd(),
    killImplementation: fake.killImplementation,
    spawnImplementation: fake.spawnImplementation,
  });
  await adapter.initialize();
  const started = await adapter.startRun({
    task: claimedTask(),
    canonicalContext: runtimeContext(),
  });
  const [first, second] = await Promise.all([
    adapter.stopRun(started.run_id, { timeoutMs: 5 }),
    adapter.stopRun(started.run_id, { timeoutMs: 5 }),
  ]);
  assert.equal(first.status, "stopped");
  assert.deepEqual(second, first);
  assert.deepEqual(
    fake.groupSignals.filter((entry) => entry.signal !== 0),
    [
      { pid: -fake.runs[0].pid, signal: "SIGTERM" },
      { pid: -fake.runs[0].pid, signal: "SIGKILL" },
    ],
  );
  assert.ok(fake.groupSignals.some((entry) => entry.signal === 0));
});

test("DocsFab adapter escalates when the launcher closes but its group survives", async () => {
  const fake = fakeDocsFab({
    closeSignals: ["SIGTERM"],
    groupExitSignals: ["SIGKILL"],
  });
  const adapter = new DocsFabRuntimeAdapter({
    repositoryPath: process.cwd(),
    killImplementation: fake.killImplementation,
    spawnImplementation: fake.spawnImplementation,
  });
  await adapter.initialize();
  const started = await adapter.startRun({
    task: claimedTask(),
    canonicalContext: runtimeContext(),
  });
  const stopped = await adapter.stopRun(started.run_id, { timeoutMs: 5 });
  assert.equal(stopped.status, "stopped");
  assert.deepEqual(
    fake.groupSignals.filter((entry) => entry.signal !== 0),
    [
      { pid: -fake.runs[0].pid, signal: "SIGTERM" },
      { pid: -fake.runs[0].pid, signal: "SIGKILL" },
    ],
  );
  assert.ok(fake.groupSignals.some((entry) => entry.signal === 0));
});

test("Hermes adapter capability-probes before starting a run", async () => {
  const fake = await fakeHermes();
  const adapter = new HermesRuntimeAdapter({
    baseUrl: fake.baseUrl,
    apiKey: "test-secret",
  });
  validateRuntimeAdapter(adapter);
  await assert.rejects(
    adapter.startRun({ task: claimedTask(), canonicalContext: { version: 7 } }),
    /not initialized/,
  );
  await adapter.initialize();
  const run = await adapter.startRun({
    task: claimedTask(),
    canonicalContext: { version: 7, claims: [] },
  });
  assert.deepEqual(run, { run_id: "run_001", status: "started" });
  assert.equal((await adapter.getRun(run.run_id)).status, "completed");
  assert.equal((await adapter.stopRun(run.run_id)).status, "stopping");
  const runRequest = fake.requests.find((request) => request.url === "/v1/runs");
  assert.equal(runRequest.authorization, "Bearer test-secret");
  assert.equal(runRequest.body.session_id, "docsfab-knowledge-TASK-001");
  assert.match(runRequest.body.input, /Expected outputs/);
});

test("Hermes adapter rejects missing capabilities and remote plaintext endpoints", async () => {
  const fake = await fakeHermes({ run_stop: false });
  const adapter = new HermesRuntimeAdapter({
    baseUrl: fake.baseUrl,
    apiKey: "test-secret",
  });
  await assert.rejects(adapter.initialize(), /run_stop/);
  assert.throws(
    () =>
      new HermesRuntimeAdapter({
        baseUrl: "http://brev.example.test:8642",
        apiKey: "test-secret",
      }),
    /loopback/,
  );
});
