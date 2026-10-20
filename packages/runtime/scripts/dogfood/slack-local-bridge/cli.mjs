#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Temporary Slack slash → local `docsfab` invoke bridge.
 *
 * NON-PRODUCT. Not a queue. Not a Blueprint default. Chat text cannot
 * mint write or publish authority.
 *
 *   node cli.mjs --allowlist FILE --text "run review-documentation --repo /abs/path"
 *   node cli.mjs --allowlist FILE --serve --port 8787
 *
 * Add --execute on this host process to spawn `docsfab` (still never
 * `--allow-write`). Slack text cannot enable execute.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { loadAllowlist, planInvoke } from "./plan.mjs";

const MAX_BODY = 64 * 1024;
const SLACK_MAX_AGE_SEC = 5 * 60;
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

export function parseBridgeArgs(argv) {
  const options = {
    allowlist: undefined,
    text: undefined,
    serve: false,
    port: 8787,
    execute: false,
    docsfabBin: process.env.DOCSFAB_BIN ?? "docsfab",
    json: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--serve") {
      options.serve = true;
    } else if (token === "--execute") {
      options.execute = true;
    } else if (token === "--json") {
      options.json = true;
    } else if (token === "--allowlist") {
      options.allowlist = argv[index + 1];
      index += 1;
    } else if (token === "--text") {
      options.text = argv[index + 1];
      index += 1;
    } else if (token === "--port") {
      options.port = Number(argv[index + 1]);
      index += 1;
    } else if (token === "--docsfab-bin") {
      options.docsfabBin = argv[index + 1];
      index += 1;
    } else if (token === "--help" || token === "-h") {
      options.help = true;
    } else {
      throw new Error(`Unknown bridge argument: ${token}`);
    }
  }
  if (options.help) return options;
  if (typeof options.allowlist !== "string") {
    throw new Error("--allowlist <file> is required.");
  }
  if (!options.serve && typeof options.text !== "string") {
    throw new Error("Pass --text <slash-text> or --serve.");
  }
  if (options.serve && (!Number.isInteger(options.port) || options.port < 1)) {
    throw new Error("--port must be a positive integer.");
  }
  return options;
}

export function verifySlackSignature({ signingSecret, timestamp, signature, rawBody, nowMs }) {
  if (typeof signingSecret !== "string" || signingSecret.length === 0) return false;
  if (typeof timestamp !== "string" || typeof signature !== "string") return false;
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(nowMs / 1000 - ts) > SLACK_MAX_AGE_SEC) return false;
  const digest = createHmac("sha256", signingSecret)
    .update(`v0:${timestamp}:${rawBody}`)
    .digest("hex");
  const expected = Buffer.from(`v0=${digest}`);
  const actual = Buffer.from(signature);
  if (expected.length !== actual.length) return false;
  return timingSafeEqual(expected, actual);
}

export function formatPlan(result, { execute, docsfabBin }) {
  if (!result.ok) {
    return {
      ok: false,
      code: result.code,
      message: result.message,
      executed: false,
    };
  }
  return {
    ok: true,
    mode: execute ? "execute" : "dry-run",
    docsfabBin,
    argv: result.argv,
    command: [docsfabBin, ...result.argv].join(" "),
    executed: false,
    note: "Chat text is not a write grant; --allow-write / publish are never implied.",
  };
}

export async function runDocsFab({ docsfabBin, argv, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  return await new Promise((resolveRun, reject) => {
    const child = spawn(docsfabBin, argv, {
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const chunks = { stdout: [], stderr: [] };
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error("docsfab invoke timed out"));
    }, timeoutMs);
    child.stdout.on("data", (data) => chunks.stdout.push(data));
    child.stderr.on("data", (data) => chunks.stderr.push(data));
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolveRun({
        exitCode: code ?? 1,
        stdout: Buffer.concat(chunks.stdout).toString("utf8"),
        stderr: Buffer.concat(chunks.stderr).toString("utf8"),
      });
    });
  });
}

function slackText(envelope) {
  if (!envelope.ok) {
    return `Refused (${envelope.code}): ${envelope.message}`;
  }
  if (envelope.mode === "dry-run") {
    return `DRY-RUN (not executed)\n${envelope.command}\n\n${envelope.note}`;
  }
  const output = [envelope.stdout, envelope.stderr].filter(Boolean).join("\n").trim();
  const clipped = output.length > 2500 ? `${output.slice(0, 2500)}\n…truncated` : output;
  return `Executed (still without --allow-write / publish)\n${envelope.command}\nexit ${envelope.exitCode}\n${clipped}`;
}

export function createSlashServer({
  allowlist,
  execute,
  docsfabBin,
  signingSecret,
  now = () => Date.now(),
}) {
  return createServer((request, response) => {
    void handleRequest(request, response, {
      allowlist,
      execute,
      docsfabBin,
      signingSecret,
      now,
    });
  });
}

async function handleRequest(request, response, context) {
  if (request.method !== "POST" || request.url !== "/slack/commands") {
    response.writeHead(404, { "content-type": "text/plain" });
    response.end("not found");
    return;
  }
  let raw;
  try {
    raw = await readBody(request);
  } catch {
    response.writeHead(413, { "content-type": "text/plain" });
    response.end("payload too large");
    return;
  }
  const timestamp = request.headers["x-slack-request-timestamp"];
  const signature = request.headers["x-slack-signature"];
  const verified = verifySlackSignature({
    signingSecret: context.signingSecret,
    timestamp: Array.isArray(timestamp) ? timestamp[0] : timestamp,
    signature: Array.isArray(signature) ? signature[0] : signature,
    rawBody: raw.toString("utf8"),
    nowMs: context.now(),
  });
  if (!verified) {
    response.writeHead(401, { "content-type": "text/plain" });
    response.end("unauthorized");
    return;
  }
  const params = new URLSearchParams(raw.toString("utf8"));
  const text = params.get("text") ?? "";
  const planned = await planInvoke({ text, allowlist: context.allowlist });
  const envelope = formatPlan(planned, {
    execute: context.execute,
    docsfabBin: context.docsfabBin,
  });
  if (!planned.ok || !context.execute) {
    writeSlackJson(response, { response_type: "ephemeral", text: slackText(envelope) });
    return;
  }
  writeSlackJson(response, {
    response_type: "ephemeral",
    text: `Running (host --execute; still no --allow-write):\n${envelope.command}`,
  });
  const responseUrl = params.get("response_url");
  try {
    const run = await runDocsFab({ docsfabBin: context.docsfabBin, argv: planned.argv });
    const finished = { ...envelope, executed: true, ...run };
    if (typeof responseUrl === "string" && responseUrl.startsWith("https://hooks.slack.com/")) {
      await deliverSlackResponse(responseUrl, {
        response_type: "ephemeral",
        text: slackText(finished),
      });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "invoke failed";
    if (typeof responseUrl === "string" && responseUrl.startsWith("https://hooks.slack.com/")) {
      await deliverSlackResponse(responseUrl, {
        response_type: "ephemeral",
        text: `Invoke failed: ${message}`,
      });
    }
  }
}

async function deliverSlackResponse(responseUrl, body) {
  try {
    await fetch(responseUrl, {
      method: "POST",
      redirect: "error",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    // Transport errors can contain the private response URL; never log them or retry the payload.
    process.stderr.write(
      "Slack response delivery failed; redirects are refused. Check bridge connectivity and Slack response URL.\n",
    );
  }
}

function writeSlackJson(response, body) {
  const payload = Buffer.from(JSON.stringify(body), "utf8");
  response.writeHead(200, {
    "content-type": "application/json; charset=utf-8",
    "content-length": String(payload.length),
  });
  response.end(payload);
}

function readBody(request) {
  return new Promise((resolveBody, reject) => {
    const chunks = [];
    let size = 0;
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error("too large"));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolveBody(Buffer.concat(chunks)));
    request.on("error", reject);
  });
}

export function helpText() {
  return `Temporary Slack → local docsfab invoke bridge (NON-PRODUCT)

Usage:
  node cli.mjs --allowlist FILE --text "run review-documentation --repo /abs/path"
  node cli.mjs --allowlist FILE --serve --port 8787

Default is dry-run (prints argv, does not spawn docsfab).
Host-only --execute spawns docsfab still without --allow-write.
Slack text cannot enable execute, write, or publish.

See README.md for setup, allowlist, threat notes, and teardown.
`;
}

async function main(argv) {
  const options = parseBridgeArgs(argv);
  if (options.help) {
    process.stdout.write(helpText());
    return 0;
  }
  const allowlist = await loadAllowlist(resolve(options.allowlist));
  if (options.serve) {
    const signingSecret = process.env.SLACK_SIGNING_SECRET ?? "";
    if (signingSecret.length === 0) {
      throw new Error("SLACK_SIGNING_SECRET is required for --serve (do not commit it).");
    }
    const server = createSlashServer({
      allowlist,
      execute: options.execute,
      docsfabBin: options.docsfabBin,
      signingSecret,
    });
    await new Promise((resolveListen) => {
      server.listen(options.port, "127.0.0.1", resolveListen);
    });
    const mode = options.execute ? "execute (no --allow-write)" : "dry-run";
    process.stdout.write(
      `slack-local-bridge listening on http://127.0.0.1:${options.port}/slack/commands (${mode})\n`,
    );
    return undefined;
  }
  const planned = await planInvoke({ text: options.text, allowlist });
  const envelope = formatPlan(planned, {
    execute: options.execute,
    docsfabBin: options.docsfabBin,
  });
  if (!planned.ok) {
    if (options.json) {
      process.stdout.write(`${JSON.stringify(envelope)}\n`);
    } else {
      process.stderr.write(`${slackText(envelope)}\n`);
    }
    return 2;
  }
  if (!options.execute) {
    if (options.json) {
      process.stdout.write(`${JSON.stringify(envelope)}\n`);
    } else {
      process.stdout.write(`${slackText(envelope)}\n`);
    }
    return 0;
  }
  const run = await runDocsFab({ docsfabBin: options.docsfabBin, argv: planned.argv });
  const finished = { ...envelope, executed: true, exitCode: run.exitCode };
  if (options.json) {
    process.stdout.write(`${JSON.stringify(finished)}\n`);
  } else {
    process.stdout.write(`${slackText({ ...finished, stdout: run.stdout, stderr: run.stderr })}\n`);
  }
  return run.exitCode === 0 ? 0 : 1;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main(process.argv.slice(2)).then(
    (code) => {
      if (typeof code === "number") process.exitCode = code;
    },
    (error) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    },
  );
}
