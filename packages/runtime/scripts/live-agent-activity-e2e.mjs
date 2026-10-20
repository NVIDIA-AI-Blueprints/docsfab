// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** Installed-package activity proof. Scripted model choices test events, not model quality. */
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { chmod, mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { installPackedDocsFab, packDocsFab } from "./lib/packed-cli.mjs";

const execute = promisify(execFile);
const projectRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const fixture = join(projectRoot, "test/fixtures/live-agent-activity");
const root = await realpath(await mkdtemp(join(tmpdir(), "docsfab-activity-e2e-")));
const model = "example/model";
const rich = process.env.DOCSFAB_TEST_RICH === "1";
const delay = (ms) => new Promise((done) => setTimeout(done, ms));
let server;
try {
  const paths = Object.fromEntries(
    ["pack", "install", "repository", "configuration", "home"].map((key) => [key, join(root, key)]),
  );
  await Promise.all(
    Object.values(paths).map((path) => mkdir(path, { recursive: true, mode: 0o700 })),
  );
  await writeFile(
    join(paths.repository, "README.md"),
    "# Sample CLI\n\nRun `node cli.mjs --help` for usage.\n",
  );
  await writeFile(
    join(paths.repository, "cli.mjs"),
    'console.log("Usage: sample --output <path>");\n',
  );
  await execute("git", ["init", "-q", paths.repository]);
  await execute("git", ["-C", paths.repository, "add", "."]);
  await execute("git", [
    "-C",
    paths.repository,
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.test",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-qm",
    "fixture",
  ]);
  const { tarball } = await packDocsFab({
    projectRoot,
    packDestination: paths.pack,
    env: process.env,
  });
  const { executable } = await installPackedDocsFab({
    tarball,
    installRoot: paths.install,
    cwd: root,
    env: process.env,
  });
  const cert = join(root, "certificate.pem");
  const key = join(root, "key.pem");
  await execute("openssl", [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-sha256",
    "-nodes",
    "-keyout",
    key,
    "-out",
    cert,
    "-days",
    "1",
    "-config",
    join(fixture, "openssl.cnf"),
  ]);
  await chmod(key, 0o600);
  const calls = new Map();
  let nestedCalls = 0;
  let providerFailure;
  server = createServer(
    { cert: readFileSync(cert), key: readFileSync(key) },
    async (request, response) => {
      try {
        const chunks = [];
        for await (const chunk of request) chunks.push(chunk);
        const payload = JSON.parse(Buffer.concat(chunks).toString());
        const outer = payload.tools?.some((tool) => tool.function?.name === "docsfab_use_skill");
        if (!outer) {
          nestedCalls++;
          await delay(2300);
          response.writeHead(200, { "content-type": "text/event-stream" });
          response.end(
            turn(
              "This synthetic response intentionally does not satisfy the workflow output contract.",
            ),
          );
          return;
        }
        const latest = payload.messages.filter((message) => message.role === "user").at(-1);
        const scenario = JSON.stringify(latest?.content).match(/ACTIVITY (\w+)/)?.[1];
        const count = (calls.get(scenario) ?? 0) + 1;
        calls.set(scenario, count);
        let body;
        if (scenario === "direct") {
          await delay(2300);
          body = turn(
            rich
              ? "## Direct answer.\n\nUse **Bluebird**.\n\n```bash\nnode cli.mjs export --output report.txt\n```\n"
              : "Direct answer.",
          );
        } else if (scenario === "skill")
          body =
            count === 1
              ? turn(null, "docsfab_use_skill", { skill: "review-documentation" })
              : turn("Skill loaded.");
        else if (scenario === "workflow")
          body =
            count === 1
              ? turn(null, "docsfab_run_workflow", {
                  workflow: "review-documentation",
                  instruction: "Review this repository documentation.",
                })
              : turn("Workflow result received.");
        else if (scenario === "blank") body = turn("");
        else if (scenario === "resume") body = turn("Resumed.");
        else if (scenario === "interrupt") {
          await delay(5000);
          body = turn("Late answer must not appear.");
        } else if (scenario === "error" || scenario === "context") {
          response.writeHead(scenario === "error" ? 401 : 400, {
            "content-type": "application/json",
          });
          response.end(
            JSON.stringify({
              error: {
                message:
                  scenario === "context"
                    ? "PRIVATE_PROVIDER_PAYLOAD maximum context length exceeded"
                    : "PRIVATE_PROVIDER_PAYLOAD failed",
              },
            }),
          );
          return;
        } else throw new Error("Unexpected scripted scenario");
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end(body);
      } catch (error) {
        providerFailure = error;
        response.writeHead(500).end();
      }
    },
  );
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  await writeFile(
    join(paths.configuration, ".env"),
    [
      "MODEL_PROVIDER=test-provider",
      `MODEL_BASE_URL=https://127.0.0.1:${server.address().port}/v1`,
      `MODEL_ID=${model}`,
      "MODEL_API_FORMAT=chat_completions",
      "MODEL_API_KEY=docsfab-e2e-placeholder",
      "MODEL_CONTEXT_WINDOW=128000",
      "MODEL_MAX_INPUT_TOKENS=128000",
      "MODEL_MAX_OUTPUT_TOKENS=16384",
      "MODEL_API_MIN_OUTPUT_TOKENS=16",
      "MODEL_CONTEXT_RESERVE_TOKENS=4096",
      "MODEL_REASONING=false",
      "MODEL_INPUT_TYPES=text",
      "MODEL_SUPPORTS_DEVELOPER_ROLE=false",
      "MODEL_SUPPORTS_REASONING_EFFORT=false",
      "MODEL_COMPATIBLE_API_FORMATS=chat_completions",
      "MODEL_INPUT_COST_PER_MILLION=unknown",
      "MODEL_OUTPUT_COST_PER_MILLION=unknown",
      "MODEL_CACHE_READ_COST_PER_MILLION=unknown",
      "MODEL_CACHE_WRITE_COST_PER_MILLION=unknown",
      "MODEL_PROFILE_APPROVED_SOURCE=https://metadata.example.test/models/example-model",
      "MODEL_PROFILE_EFFECTIVE_DATE=2020-01-01",
      "MODEL_PROFILE_REVIEW_AFTER=2099-12-31",
      "",
    ].join("\n"),
    { mode: 0o600 },
  );
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) =>
        !/^(?:MODEL|JUDGE|DOCSFAB|DOCSFAB|INFERENCE_HUB|PI)_/.test(name) &&
        name !== "NODE_EXTRA_CA_CERTS",
    ),
  );
  delete environment.NO_COLOR;
  delete environment.FORCE_COLOR;
  const { stdout } = await execute(
    "python3",
    [join(fixture, "terminal.py"), executable, paths.repository],
    {
      cwd: root,
      env: {
        ...environment,
        DOCSFAB_CONFIG_ROOT: paths.configuration,
        NODE_EXTRA_CA_CERTS: cert,
        ...(rich ? { DOCSFAB_TEST_RICH: "1" } : { NO_COLOR: "1" }),
        TERM: "xterm",
        PI_CODING_AGENT_DIR: join(paths.home, ".pi"),
      },
      timeout: 180000,
      maxBuffer: 1024 * 1024,
    },
  );
  if (providerFailure) throw providerFailure;
  if (!nestedCalls) throw new Error("Workflow never reached the delayed provider");
  if (stdout.includes("Late answer must not appear."))
    throw new Error("Aborted turn leaked late text");
  // Retain only bounded, synthetic milestone evidence. No session file is read.
  console.log(stdout.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "").replaceAll("\r", ""));
  console.log(
    "PASS installed activity E2E: delayed model and workflow, skill, safe errors, blank/context failures, interruption, resume, exit. Scripted choices do not prove model selection quality.",
  );
} finally {
  server?.closeAllConnections();
  if (server) await new Promise((done) => server.close(done));
  await rm(root, { recursive: true, force: true });
}

function turn(content, name, args) {
  const delta = name
    ? {
        role: "assistant",
        tool_calls: [
          {
            index: 0,
            id: "activity-tool",
            type: "function",
            function: { name, arguments: JSON.stringify(args) },
          },
        ],
      }
    : { role: "assistant", content };
  return (
    [
      { delta, finish_reason: null },
      { delta: {}, finish_reason: name ? "tool_calls" : "stop" },
    ]
      .map(
        (choice) =>
          `data: ${JSON.stringify({ id: "activity", object: "chat.completion.chunk", created: 1, model, choices: [{ index: 0, ...choice }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })}\n\n`,
      )
      .join("") + "data: [DONE]\n\n"
  );
}
