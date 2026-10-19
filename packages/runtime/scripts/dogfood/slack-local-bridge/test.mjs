#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Acceptance checks for the non-product Slack local docsfab bridge.
 * Does not call Slack or spawn a real docsfab workflow.
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHmac } from "node:crypto";
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { createSlashServer, formatPlan, parseBridgeArgs, verifySlackSignature } from "./cli.mjs";
import { loadAllowlist, planInvoke } from "./plan.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const cliPath = join(here, "cli.mjs");

async function withFixture() {
  const root = await mkdtemp(join(tmpdir(), "docsfab-slack-bridge-"));
  const allowed = join(root, "allowed-repo");
  const nested = join(allowed, "docs");
  const outside = join(root, "outside-repo");
  await mkdir(nested, { recursive: true });
  await mkdir(outside, { recursive: true });
  const allowlistPath = join(root, "allowlist.json");
  await writeFile(
    allowlistPath,
    JSON.stringify({
      workflows: ["review-documentation", "readiness"],
      repoRoots: [allowed],
    }),
  );
  return {
    root,
    allowed: await realpath(allowed),
    nested: await realpath(nested),
    outside: await realpath(outside),
    allowlistPath,
    allowlist: await loadAllowlist(allowlistPath),
  };
}

async function testDryRunPrintsArgvWithoutExecuting() {
  const fx = await withFixture();
  const planned = await planInvoke({
    text: `run review-documentation --repo ${fx.allowed}`,
    allowlist: fx.allowlist,
  });
  assert.equal(planned.ok, true);
  assert.deepEqual(planned.argv, ["run", "review-documentation", "--repo", fx.allowed]);
  const envelope = formatPlan(planned, { execute: false, docsfabBin: "docsfab" });
  assert.equal(envelope.mode, "dry-run");
  assert.equal(envelope.executed, false);
  assert.match(envelope.command, /^docsfab run review-documentation --repo /);
  assert.equal(envelope.argv.includes("--allow-write"), false);

  const { stdout, code } = await runCli([
    "--allowlist",
    fx.allowlistPath,
    "--text",
    `run review-documentation --repo ${fx.allowed}`,
    "--json",
  ]);
  assert.equal(code, 0);
  const parsed = JSON.parse(stdout);
  assert.equal(parsed.mode, "dry-run");
  assert.equal(parsed.executed, false);
  assert.deepEqual(parsed.argv, ["run", "review-documentation", "--repo", fx.allowed]);
}

async function testRefuseUnknownWorkflow() {
  const fx = await withFixture();
  const planned = await planInvoke({
    text: `run polish --repo ${fx.allowed}`,
    allowlist: fx.allowlist,
  });
  assert.equal(planned.ok, false);
  assert.equal(planned.code, "unknown-workflow");
}

async function testRefusePathOutsideAllowlist() {
  const fx = await withFixture();
  const planned = await planInvoke({
    text: `run review-documentation --repo ${fx.outside}`,
    allowlist: fx.allowlist,
  });
  assert.equal(planned.ok, false);
  assert.equal(planned.code, "path-not-allowlisted");
}

async function testRefuseRelativeAndDotDot() {
  const fx = await withFixture();
  const relative = await planInvoke({
    text: "run review-documentation --repo ./allowed-repo",
    allowlist: fx.allowlist,
  });
  assert.equal(relative.ok, false);
  assert.equal(relative.code, "path-not-allowlisted");

  const traversal = await planInvoke({
    text: `run review-documentation --repo ${fx.allowed}/../outside-repo`,
    allowlist: fx.allowlist,
  });
  assert.equal(traversal.ok, false);
  assert.equal(traversal.code, "path-not-allowlisted");
}

async function testRefuseSymlinkEscape() {
  const fx = await withFixture();
  const link = join(fx.allowed, "escape");
  await symlink(fx.outside, link);
  const planned = await planInvoke({
    text: `run review-documentation --repo ${link}`,
    allowlist: fx.allowlist,
  });
  assert.equal(planned.ok, false);
  assert.equal(planned.code, "path-not-allowlisted");
}

async function testNestedRepoAllowed() {
  const fx = await withFixture();
  const planned = await planInvoke({
    text: `run review-documentation --repo ${fx.nested} --revision HEAD --json`,
    allowlist: fx.allowlist,
  });
  assert.equal(planned.ok, true);
  assert.deepEqual(planned.argv, [
    "run",
    "review-documentation",
    "--repo",
    fx.nested,
    "--revision",
    "HEAD",
    "--json",
  ]);
}

async function testRefuseWriteAndPublishFromChat() {
  const fx = await withFixture();
  const cases = [
    `run review-documentation --repo ${fx.allowed} --allow-write`,
    `publish abc --repo ${fx.allowed}`,
    `run review-documentation --repo ${fx.allowed} --execute`,
    `auto --dry-run --repo ${fx.allowed}`,
    `run review-documentation --repo ${fx.allowed} --instruction please --allow-write`,
  ];
  for (const text of cases) {
    const planned = await planInvoke({ text, allowlist: fx.allowlist });
    assert.equal(planned.ok, false, text);
    assert.ok(planned.code === "forbidden-token" || planned.code === "unknown-workflow", text);
    assert.match(planned.message, /write grant|not on the host allowlist|Refusing workflow/i);
  }
}

async function testRefuseShellMetacharacters() {
  const fx = await withFixture();
  const planned = await planInvoke({
    text: `run review-documentation --repo ${fx.allowed}; rm -rf /`,
    allowlist: fx.allowlist,
  });
  assert.equal(planned.ok, false);
  assert.equal(planned.code, "invalid-syntax");
}

async function testSignatureAndHttpDryRun() {
  const fx = await withFixture();
  const secret = "test-signing-secret";
  const nowMs = 1_700_000_000_000;
  const timestamp = String(Math.floor(nowMs / 1000));
  const rawBody = new URLSearchParams({
    text: `run review-documentation --repo ${fx.allowed}`,
    command: "/docsfab",
  }).toString();
  const signature = `v0=${createHmac("sha256", secret).update(`v0:${timestamp}:${rawBody}`).digest("hex")}`;
  assert.equal(
    verifySlackSignature({
      signingSecret: secret,
      timestamp,
      signature,
      rawBody,
      nowMs,
    }),
    true,
  );
  assert.equal(
    verifySlackSignature({
      signingSecret: secret,
      timestamp,
      signature: "v0=deadbeef",
      rawBody,
      nowMs,
    }),
    false,
  );

  const server = createSlashServer({
    allowlist: fx.allowlist,
    execute: false,
    docsfabBin: "docsfab",
    signingSecret: secret,
    now: () => nowMs,
  });
  await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const response = await fetch(`http://127.0.0.1:${address.port}/slack/commands`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "x-slack-request-timestamp": timestamp,
        "x-slack-signature": signature,
      },
      body: rawBody,
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.match(body.text, /DRY-RUN/);
    const commandLine = body.text.split("\n")[1] ?? "";
    assert.match(commandLine, /^docsfab run review-documentation --repo /);
    assert.equal(commandLine.includes(" --allow-write"), false);
  } finally {
    await new Promise((resolveClose) => server.close(resolveClose));
  }
}

async function testParseBridgeArgsDoesNotTakeExecuteFromText() {
  const parsed = parseBridgeArgs([
    "--allowlist",
    "a.json",
    "--text",
    "run review-documentation --repo /x",
  ]);
  assert.equal(parsed.execute, false);
}

async function testExecuteResponseDelivery({ invokeFails, delivery }) {
  const fx = await withFixture();
  const signingSecret = "test-signing-secret";
  const responseUrl = "https://hooks.slack.com/commands/synthetic-response-url";
  const output = "synthetic invoke output";
  const nativeFetch = globalThis.fetch;
  const writeStderr = process.stderr.write;
  const diagnostics = [];
  const unhandled = [];
  const originBodies = [];
  const destinationBodies = [];
  const deliveries = [];
  let deliveryStarted;
  const firstDelivery = new Promise((resolveDelivery) => {
    deliveryStarted = resolveDelivery;
  });
  const captureUnhandled = (error) => unhandled.push(error);
  const destination = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    destinationBodies.push(Buffer.concat(chunks).toString("utf8"));
    response.end("ok");
  });
  await new Promise((resolveListen) => destination.listen(0, "127.0.0.1", resolveListen));
  const destinationUrl = `http://127.0.0.1:${destination.address().port}/unapproved`;
  const origin = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    originBodies.push(Buffer.concat(chunks).toString("utf8"));
    if (delivery === "redirect") {
      response.writeHead(307, { location: destinationUrl });
    } else if (delivery === "network-error") {
      request.socket.destroy();
      return;
    }
    response.end("ok");
  });
  await new Promise((resolveListen) => origin.listen(0, "127.0.0.1", resolveListen));
  const originUrl = `http://127.0.0.1:${origin.address().port}/response`;
  const docsfabBin = join(fx.root, invokeFails ? "missing-docsfab" : "synthetic-docsfab");
  if (!invokeFails) {
    await writeFile(
      docsfabBin,
      `#!${process.execPath}\nprocess.stdout.write(${JSON.stringify(output)});\n`,
      {
        mode: 0o700,
      },
    );
  }
  const server = createSlashServer({
    allowlist: fx.allowlist,
    execute: true,
    docsfabBin,
    signingSecret,
  });
  await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  try {
    process.on("unhandledRejection", captureUnhandled);
    process.stderr.write = (chunk) => {
      diagnostics.push(String(chunk));
      return true;
    };
    // Only the allowlisted initial URL is adapted. Native fetch must enforce redirects.
    globalThis.fetch = (url, options) => {
      assert.equal(url, responseUrl, "unexpected external response URL");
      const pending = nativeFetch(originUrl, options);
      deliveries.push(pending);
      deliveryStarted();
      return pending;
    };
    const timestamp = String(Math.floor(Date.now() / 1000));
    const rawBody = new URLSearchParams({
      text: `run review-documentation --repo ${fx.allowed}`,
      command: "/docsfab",
      response_url: responseUrl,
    }).toString();
    const signature = `v0=${createHmac("sha256", signingSecret).update(`v0:${timestamp}:${rawBody}`).digest("hex")}`;
    const serverUrl = `http://127.0.0.1:${server.address().port}/slack/commands`;
    const acknowledgment = await nativeFetch(serverUrl, {
      method: "POST",
      headers: {
        "x-slack-request-timestamp": timestamp,
        "x-slack-signature": signature,
      },
      body: rawBody,
    });
    assert.equal(acknowledgment.status, 200);
    assert.match((await acknowledgment.json()).text, /^Running \(host --execute;/);
    await firstDelivery;
    let observed;
    do {
      observed = deliveries.length;
      await Promise.allSettled(deliveries);
      await new Promise(setImmediate);
    } while (observed !== deliveries.length);
    assert.equal(originBodies.length, 1, "response delivery must not retry as an invoke failure");
    const delivered = JSON.parse(originBodies[0]);
    assert.equal(delivered.response_type, "ephemeral");
    if (invokeFails) {
      assert.match(delivered.text, /^Invoke failed: spawn .* ENOENT$/);
    } else {
      assert.match(delivered.text, /^Executed \(still without --allow-write \/ publish\)/);
      assert.ok(
        delivered.text.endsWith(output),
        "completion must include synthetic command output",
      );
    }
    assert.equal(
      destinationBodies.length,
      0,
      "response redirect destination must receive zero requests",
    );
    assert.equal(unhandled.length, 0, "response delivery rejection must be handled");
    if (delivery === "direct") {
      assert.deepEqual(diagnostics, [], "successful delivery must not report a failure");
    } else {
      assert.equal(
        diagnostics.join(""),
        "Slack response delivery failed; redirects are refused. Check bridge connectivity and Slack response URL.\n",
        "delivery diagnostic must be actionable and contain no URL, secret, or command output",
      );
    }
    const health = await nativeFetch(serverUrl, { method: "POST", body: rawBody });
    assert.equal(health.status, 401, "bridge must stay responsive and require a signed request");
    assert.equal(await health.text(), "unauthorized");
    assert.equal(deliveries.length, 1, "unsigned request must not deliver a response");
  } finally {
    globalThis.fetch = nativeFetch;
    process.stderr.write = writeStderr;
    process.off("unhandledRejection", captureUnhandled);
    await Promise.all(
      [server, origin, destination].map(
        (item) => new Promise((resolveClose) => item.close(resolveClose)),
      ),
    );
    await rm(fx.root, { recursive: true, force: true });
  }
}

function runCli(args) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      resolveRun({
        code: code ?? 1,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    });
  });
}

const tests = [
  ["dry-run prints argv without executing", testDryRunPrintsArgvWithoutExecuting],
  ["refuse unknown workflow names", testRefuseUnknownWorkflow],
  ["refuse paths outside allowlist", testRefusePathOutsideAllowlist],
  ["refuse relative and .. paths", testRefuseRelativeAndDotDot],
  ["refuse symlink escape from allowlisted root", testRefuseSymlinkEscape],
  ["allow nested repo under root", testNestedRepoAllowed],
  ["refuse write/publish tokens from chat", testRefuseWriteAndPublishFromChat],
  ["refuse shell metacharacters", testRefuseShellMetacharacters],
  ["verify Slack signature and HTTP dry-run", testSignatureAndHttpDryRun],
  ["host --execute is not implied by slash text", testParseBridgeArgsDoesNotTakeExecuteFromText],
  ...[false, true].flatMap((invokeFails) =>
    ["direct", "redirect", "network-error"].map((delivery) => [
      `${invokeFails ? "invoke failure" : "completion"} response delivery: ${delivery}`,
      () => testExecuteResponseDelivery({ invokeFails, delivery }),
    ]),
  ),
];

let failed = 0;
for (const [name, fn] of tests) {
  try {
    await fn();
    process.stdout.write(`ok  ${name}\n`);
  } catch (error) {
    failed += 1;
    process.stderr.write(
      `not ok  ${name}\n${error instanceof Error ? error.stack : String(error)}\n`,
    );
  }
}
if (failed > 0) {
  process.stderr.write(`${failed} failed\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`${tests.length} passed\n`);
}
