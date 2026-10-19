// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { lstat, mkdtemp, mkdir, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { sha256 } from "../src/content-ir/canonical.js";
import { withTaskActivity, type TaskActivityObserver } from "../src/activity/observer.js";
import { loadConfig } from "../src/config/runtime-loader.js";
import { decodeLiveAgentTaskExportV1 } from "../src/live-agent/task-export.js";
import { preparedLocalSourceContentSha256 } from "../src/live-agent/prepared-source-ports.js";
import { authoringFixtureCandidate } from "./support/authoring-quality-fixture.js";
import {
  createLiveAgentBoundedRunner,
  narrowTaskDocumentationScope,
} from "../src/live-agent/host.js";
import { DocumentationScope } from "../src/live-agent/documentation-scope.js";
import { createLiveAgentSourceSelection } from "../src/live-agent/source-commands.js";
import { createRootTaskBudget, projectTaskBudget } from "../src/execution/task-budget.js";
import {
  createLiveAgentTaskPrivateDirectories,
  liveAgentTaskEvidenceIdentities,
  liveAgentTaskEffectiveConfiguration,
  repositoryBaselineContentSha256,
  repositoryBaselineSnapshot,
  runLiveAgentTask,
  taskDiff,
} from "../src/live-agent/task-runner.js";

const roots: string[] = [];
function observedFixtureServer(
  handler: (request: IncomingMessage, response: ServerResponse) => Promise<void>,
  errors: string[],
) {
  return createServer((request, response) => {
    void handler(request, response).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      errors.push(message);
      process.stderr.write(`offline fixture response failed: ${message}\n`);
      if (!response.headersSent) response.writeHead(500, { "content-type": "text/plain" });
      response.end("fixture-response-error");
    });
  });
}

function providerContentText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(providerContentText).join("\n");
  if (value && typeof value === "object") {
    const part = value as { text?: unknown; content?: unknown };
    if (typeof part.text === "string") return part.text;
    if (part.content !== undefined) return providerContentText(part.content);
  }
  return JSON.stringify(value);
}

function providerPromptText(body: string): string {
  return (JSON.parse(body).messages as { content: unknown }[])
    .map((message) => providerContentText(message.content))
    .join("\n");
}

function parentWorkflowResult(body: string):
  | {
      runId: string;
      status: string;
      steps: { id: string; status: string }[];
      editorialOutcome: string | null;
      qualityPresent: boolean;
      qualityLimitations: string[];
      qualityDeclineCode: string | null;
    }
  | undefined {
  const parsed = JSON.parse(body) as {
    messages: { role: string; content: unknown }[];
    tools?: { function?: { name?: string } }[];
  };
  if (!parsed.tools?.some((tool) => tool.function?.name === "docsfab_run_workflow")) {
    return undefined;
  }
  const last = parsed.messages.at(-1);
  if (last?.role !== "tool") return undefined;
  let result: unknown;
  try {
    result = JSON.parse(providerContentText(last.content));
  } catch {
    return undefined;
  }
  if (!result || typeof result !== "object") return undefined;
  const record = result as {
    kind?: unknown;
    runId?: unknown;
    status?: unknown;
    steps?: { id?: unknown; status?: unknown; summary?: unknown }[];
    editorial?: { outcome?: unknown };
    quality?: unknown;
    qualityLimitations?: unknown;
  };
  if (
    record.kind !== "docsfab-live-workflow-result" ||
    typeof record.runId !== "string" ||
    typeof record.status !== "string" ||
    !Array.isArray(record.steps)
  ) {
    return undefined;
  }
  return {
    runId: record.runId,
    status: record.status,
    steps: record.steps.map((step: { id: string; status: string }) => ({
      id: step.id,
      status: step.status,
    })),
    editorialOutcome:
      typeof record.editorial?.outcome === "string" ? record.editorial.outcome : null,
    qualityPresent: record.quality !== null && record.quality !== undefined,
    qualityLimitations: Array.isArray(record.qualityLimitations)
      ? record.qualityLimitations.filter((value): value is string => typeof value === "string")
      : [],
    qualityDeclineCode:
      /rejection code ([a-z0-9-]+)/u.exec(
        String(record.steps.find((step) => step.id === "evaluate-document-quality")?.summary ?? ""),
      )?.[1] ?? null,
  };
}

type ServerObservation = {
  method: string;
  path: string;
  model: string | null;
  requestBodyBytes: number;
  requestBodySha256: string;
  responseCount: number;
  responseStatus: number | null;
};

function observeProviderRequest(
  request: IncomingMessage,
  response: ServerResponse,
  body: string,
  observations: ServerObservation[],
): void {
  const parsed = JSON.parse(body) as { model?: unknown };
  const bytes = Buffer.from(body);
  const observation: ServerObservation = {
    method: request.method ?? "",
    path: new URL(request.url ?? "/", "http://127.0.0.1").pathname,
    model: typeof parsed.model === "string" ? parsed.model : null,
    requestBodyBytes: bytes.byteLength,
    requestBodySha256: sha256(bytes),
    responseCount: 0,
    responseStatus: null,
  };
  observations.push(observation);
  response.once("finish", () => {
    observation.responseCount += 1;
    observation.responseStatus = response.statusCode;
  });
}

function providerMessageMarkers(body: string): string {
  const parsed = JSON.parse(body) as {
    messages: { role: string; content: unknown }[];
    tools?: { function?: { name?: string } }[];
  };
  const messages = parsed.messages;
  const toolNames = (parsed.tools ?? []).map((tool) => tool.function?.name ?? "unknown");
  const timeline = messages
    .slice(-4)
    .map((message) => {
      const content =
        typeof message.content === "string"
          ? message.content
          : (JSON.stringify(message.content) ?? "");
      const markers = [
        ["planner", "Runtime reader-impact planner response contract"],
        ["technical", "Nested technical verification result contract"],
        ["editorial", "Nested editorial review result contract"],
        ["audience", "test-audience-understanding"],
        ["quality", "Runtime quality artifact response contract"],
        ["run-id", '"runId"'],
        ["declaration", "docsfab-live-agent-task-declaration"],
      ]
        .filter(([, marker]) => content.includes(marker))
        .map(([name]) => name);
      return `${message.role}:${markers.join(",") || "none"}`;
    })
    .join("|");
  return `tools=${toolNames.join(",")}; messages=${timeline}`;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "docsfab-task-runner-"));
  roots.push(root);
  const repositoryPath = join(root, "workspace");
  await mkdir(join(repositoryPath, "docs"), { recursive: true });
  await writeFile(join(repositoryPath, "docs", "guide.md"), "# Guide\n");
  execFileSync("git", ["-C", repositoryPath, "init", "-q"]);
  execFileSync("git", ["-C", repositoryPath, "config", "user.email", "test@example.invalid"]);
  execFileSync("git", ["-C", repositoryPath, "config", "user.name", "Test"]);
  execFileSync("git", ["-C", repositoryPath, "add", "."]);
  execFileSync("git", ["-C", repositoryPath, "commit", "-qm", "baseline"]);
  execFileSync("git", ["-C", repositoryPath, "switch", "-qc", "task-fixture"]);
  const head = execFileSync("git", ["-C", repositoryPath, "rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim();
  const prompt = "Check the guide and report whether it needs an update.";
  const request = {
    schemaVersion: 1,
    kind: "docsfab-live-agent-task-request",
    taskId: "task-fixture",
    sessionId: "session-fixture",
    prompt: { encoding: "utf-8", text: prompt, sha256: sha256(Buffer.from(prompt)) },
    baseline: {
      repositoryRevision: head,
      contentSha256: await repositoryBaselineContentSha256(repositoryPath),
    },
    sources: [],
    scope: { documentationRoots: ["docs"], requestedPaths: ["docs/guide.md"], writeClass: "none" },
    requiredEvidence: ["source-check"],
    effectiveConfig: {
      profileId: null,
      modelId: null,
      configurationSha256: "a".repeat(64),
      values: {},
    },
  };
  const taskFile = join(root, "task.json");
  const resultDirectory = join(root, "result");
  await writeFile(taskFile, JSON.stringify(request));
  return { root, repositoryPath, taskFile, resultDirectory, request };
}

describe("noninteractive live-agent task runner", () => {
  it("refuses a changed baseline before model work and retains an actionable export", async () => {
    const input = await fixture();
    await writeFile(join(input.repositoryPath, "docs", "guide.md"), "# Changed\n");
    const summary = await runLiveAgentTask({
      ...input,
      allowWrite: false,
      documentationDirectories: ["docs"],
      environment: {},
    });
    expect(summary.executionStatus).toBe("needs-input");
    const record = decodeLiveAgentTaskExportV1(
      JSON.parse(await readFile(summary.exportPath, "utf8")),
    );
    expect(record.result.limitations).toContainEqual(
      expect.stringContaining("baseline-content-mismatch"),
    );
    expect(record.result.evidence).toContainEqual(
      expect.objectContaining({ evidenceId: "source-check", availability: "missing" }),
    );
    expect(record.result.trace.status).toBe("unavailable");
  });

  it("requires explicit private configuration without creating a Pi session", async () => {
    const input = await fixture();
    const summary = await runLiveAgentTask({
      ...input,
      allowWrite: false,
      documentationDirectories: ["docs"],
      environment: {},
    });
    expect(summary.executionStatus).toBe("needs-input");
    const record = decodeLiveAgentTaskExportV1(
      JSON.parse(await readFile(summary.exportPath, "utf8")),
    );
    expect(record.result.limitations).toContainEqual(
      expect.stringContaining("explicit-host-configuration-required"),
    );
    await expect(
      readFile(join(input.resultDirectory, ".session", "session.jsonl")),
    ).rejects.toThrow();
  });

  it("refuses an unsafe public session identity before writing result bytes", async () => {
    const input = await fixture();
    const unsafe = {
      ...input.request,
      sessionId: "sk-abcdefghijklmnopqrstuvwxyz0123456789",
    };
    await writeFile(input.taskFile, JSON.stringify(unsafe));
    await expect(
      runLiveAgentTask({
        ...input,
        allowWrite: false,
        documentationDirectories: ["docs"],
        environment: {},
      }),
    ).rejects.toMatchObject({ code: "activity-identity-unsafe" });
    await expect(readdir(input.resultDirectory)).rejects.toThrow();
  });

  it("rejects unsafe public export paths before any prerequisite can write there", async () => {
    const input = await fixture();
    const metadataResult = join(input.repositoryPath, ".git", "task-result");
    await expect(
      runLiveAgentTask({
        ...input,
        resultDirectory: metadataResult,
        allowWrite: false,
        environment: {},
      }),
    ).rejects.toMatchObject({ code: "task-io-inside-workspace" });
    await expect(readdir(metadataResult)).rejects.toThrow();
    let publicError = "";
    try {
      execFileSync(
        process.execPath,
        [
          "--import",
          resolve("node_modules/tsx/dist/loader.mjs"),
          resolve("src/cli.ts"),
          "live-agent",
          "--repo",
          input.repositoryPath,
          "--task-file",
          input.taskFile,
          "--result-dir",
          metadataResult,
          "--docs-dir",
          "docs",
          "--json",
        ],
        { encoding: "utf8", env: { PATH: process.env.PATH } },
      );
    } catch (error) {
      publicError = (error as { stderr?: string }).stderr ?? "";
    }
    expect(publicError).toContain('"code": "task-io-inside-workspace"');
    expect(publicError).toContain('"nextAction"');
    await expect(readdir(metadataResult)).rejects.toThrow();

    const alias = join(input.root, "metadata-alias");
    await symlink(join(input.repositoryPath, ".git"), alias);
    await expect(
      runLiveAgentTask({
        ...input,
        resultDirectory: join(alias, "task-result"),
        allowWrite: false,
        environment: {},
      }),
    ).rejects.toMatchObject({ code: "task-io-inside-workspace" });
    await expect(readdir(metadataResult)).rejects.toThrow();

    await expect(
      runLiveAgentTask({
        ...input,
        resultDirectory: "relative-result",
        allowWrite: false,
        environment: {},
      }),
    ).rejects.toMatchObject({ code: "absolute-path-required" });
    await expect(
      runLiveAgentTask({
        ...input,
        allowWrite: false,
        environment: { DOCSFAB_STATE_DIR: input.resultDirectory },
      }),
    ).rejects.toMatchObject({ code: "task-state-overlaps-result" });
    await expect(readdir(input.resultDirectory)).rejects.toThrow();
  }, 30_000);

  it("places fresh private task sessions under host state while leaving the result directory public-only", async () => {
    const input = await fixture();
    const stateDirectory = join(input.root, "state");
    const first = await createLiveAgentTaskPrivateDirectories({
      stateDirectory,
      resultDirectory: input.resultDirectory,
      repositoryPath: input.repositoryPath,
    });
    const second = await createLiveAgentTaskPrivateDirectories({
      stateDirectory,
      resultDirectory: input.resultDirectory,
      repositoryPath: input.repositoryPath,
    });
    expect(first.sessionDirectory).not.toBe(second.sessionDirectory);
    expect(first.sessionDirectory).toMatch(/\/state\/live-agent-task-[^/]+\/session$/u);
    expect(first.agentDirectory).toMatch(/\/state\/live-agent-task-[^/]+\/agent$/u);
    expect((await lstat(first.sessionDirectory)).mode & 0o777).toBe(0o700);
    expect((await lstat(first.agentDirectory)).mode & 0o777).toBe(0o700);
    await expect(readdir(input.resultDirectory)).rejects.toThrow();
    await expect(
      createLiveAgentTaskPrivateDirectories({
        stateDirectory: input.resultDirectory,
        resultDirectory: input.resultDirectory,
        repositoryPath: input.repositoryPath,
      }),
    ).rejects.toMatchObject({ code: "task-state-overlaps-result" });
    await expect(
      createLiveAgentTaskPrivateDirectories({
        stateDirectory: join(input.repositoryPath, "internal-state"),
        resultDirectory: input.resultDirectory,
        repositoryPath: input.repositoryPath,
      }),
    ).rejects.toMatchObject({ code: "task-state-inside-workspace" });
  });

  it("refuses a task-supplied path without an independent host document grant", async () => {
    const input = await fixture();
    const summary = await runLiveAgentTask({ ...input, allowWrite: false, environment: {} });
    expect(summary.executionStatus).toBe("needs-input");
    const record = decodeLiveAgentTaskExportV1(
      JSON.parse(await readFile(summary.exportPath, "utf8")),
    );
    expect(record.result.limitations).toContainEqual(
      expect.stringContaining("documentation-grant-missing"),
    );
  });

  it("captures an admitted public child workflow from its real Pi read and provider sends", async () => {
    const input = await fixture();
    const configRoot = join(input.root, "config");
    const stateRoot = join(input.root, "state");
    await mkdir(configRoot, { mode: 0o700 });
    await mkdir(stateRoot, { mode: 0o700 });
    const replies = [
      {
        tool_calls: [
          {
            index: 0,
            id: "same-native-id",
            type: "function",
            function: {
              name: "docsfab_run_workflow",
              arguments: JSON.stringify({
                workflow: "readiness",
                instruction: input.request.prompt.text,
              }),
            },
          },
        ],
      },
      {
        tool_calls: [
          {
            index: 0,
            id: "same-native-id",
            type: "function",
            function: { name: "read", arguments: JSON.stringify({ path: "docs/guide.md" }) },
          },
        ],
      },
      { content: "__READINESS_RESPONSE__" },
      { content: "__TASK_DECLARATION__" },
    ];
    let sends = 0;
    const serverErrors: string[] = [];
    const serverObservations: ServerObservation[] = [];
    const server = observedFixtureServer(async (request, response) => {
      let body = "";
      for await (const chunk of request) body += chunk.toString();
      observeProviderRequest(request, response, body, serverObservations);
      let delta = replies.shift();
      sends += 1;
      if (!delta) throw new Error("Unexpected provider request");
      if (delta.content === "__READINESS_RESPONSE__") {
        const promptText = providerPromptText(body);
        const prefix = "Return one JSON object with no Markdown fences: ";
        const contract = promptText.split("\n").find((line) => line.startsWith(prefix));
        if (!contract) throw new Error("Readiness response contract was not supplied.");
        const skeleton = JSON.parse(contract.slice(prefix.length));
        delta = {
          content: JSON.stringify({
            ...skeleton,
            summary: "The observed guide establishes only a narrow source-readiness fact.",
            criteria: skeleton.criteria.map(
              (criterion: { criterionId: string }, index: number) => ({
                criterionId: criterion.criterionId,
                status: index === 0 ? "met" : "unassessed",
                reason:
                  index === 0
                    ? "The tracked guide was read."
                    : "The fixture has no evidence for this criterion.",
                citations: index === 0 ? [{ path: "docs/guide.md", startLine: 1, endLine: 1 }] : [],
              }),
            ),
          }),
        };
      }
      if (delta.content === "__TASK_DECLARATION__") {
        const runId = /"runId"\s*:\s*"([A-Za-z0-9._-]+)"/u.exec(providerPromptText(body))?.[1];
        if (!runId) throw new Error("The actual workflow tool result did not carry its run ID.");
        delta = {
          content: JSON.stringify({
            schemaVersion: 1,
            kind: "docsfab-live-agent-task-declaration",
            decision: "no-change",
            evidenceIds: [`child-${runId}`],
          }),
        };
      }
      const chunks = [
        {
          id: "reply",
          object: "chat.completion.chunk",
          created: 1,
          model: "gpt-6-sol",
          choices: [{ index: 0, delta: { role: "assistant", ...delta }, finish_reason: null }],
        },
        {
          id: "reply",
          object: "chat.completion.chunk",
          created: 1,
          model: "gpt-6-sol",
          choices: [
            { index: 0, delta: {}, finish_reason: "tool_calls" in delta ? "tool_calls" : "stop" },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        },
      ];
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(
        chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n",
      );
    }, serverErrors);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Loopback fixture did not bind.");
    try {
      await writeFile(
        join(configRoot, "host.yaml"),
        [
          "schemaVersion: 1",
          "kind: docsfab-host-config",
          "activeExecutionProfile: nvidia-inference-gpt-6-sol-pi",
          "compositionId: nvidia-inference-gpt-6-sol-pi",
          "active:",
          "  writing:",
          "    compositionId: nvidia-inference-gpt-6-sol-pi",
          "    qualification: not-run",
          "    settings:",
          `      baseUrl: http://127.0.0.1:${address.port}/v1`,
          "",
        ].join("\n"),
        { mode: 0o600 },
      );
      await writeFile(join(configRoot, "secrets.env"), "MODEL_API_KEY=offline-test-placeholder\n", {
        mode: 0o600,
      });
      const environment = {
        DOCSFAB_CONFIG_ROOT: configRoot,
        DOCSFAB_STATE_DIR: stateRoot,
        MODEL_API_KEY: "offline-test-placeholder",
      };
      await writeFile(
        input.taskFile,
        JSON.stringify({
          ...input.request,
          requiredEvidence: [],
          effectiveConfig: liveAgentTaskEffectiveConfiguration(
            loadConfig(environment),
            environment,
          ),
        }),
      );
      const summary = await runLiveAgentTask({
        ...input,
        allowWrite: false,
        documentationDirectories: ["docs"],
        environment,
      });
      const exported = decodeLiveAgentTaskExportV1(
        JSON.parse(await readFile(summary.exportPath, "utf8")),
      );
      const activity = (
        await readFile(
          join(input.resultDirectory, `${exported.requestSha256}.activity.jsonl`),
          "utf8",
        )
      )
        .trimEnd()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(serverErrors).toEqual([]);
      expect(sends).toBe(4);
      expect(activity[0].instrumentation.childScopes).toHaveLength(1);
      expect(activity[0].instrumentation.sessions).toHaveLength(2);
      expect(activity[0].instrumentation.providerRoutes).toHaveLength(2);
      expect(
        activity.filter(
          (event: { eventType?: string; phase?: string }) =>
            event.eventType === "tool-call" && event.phase === "started",
        ),
      ).toHaveLength(2);
      expect(activity.at(-1).coverage).toEqual({
        provider: "complete",
        tools: "complete",
        source: "complete",
        web: "complete",
        workspace: "complete",
        child: "complete",
      });
      expect(activity.at(-1).missing).toEqual([]);
      expect(exported.result.nativeChildRecords).toHaveLength(1);
      expect(exported.result.trace.status).toBe("complete");
      if (process.env.DOCSFAB_TEST_ACTIVITY_FIXTURE_DIR) {
        const output = join(process.env.DOCSFAB_TEST_ACTIVITY_FIXTURE_DIR, "readiness");
        await mkdir(output, { recursive: true });
        await writeFile(join(output, "request.json"), await readFile(input.taskFile));
        await writeFile(join(output, "export.json"), await readFile(summary.exportPath));
        await writeFile(
          join(output, "activity.jsonl"),
          await readFile(join(input.resultDirectory, `${exported.requestSha256}.activity.jsonl`)),
        );
        await writeFile(
          join(output, "server-observations.json"),
          JSON.stringify(serverObservations),
        );
      }
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 60_000);

  it("observes a prepared source through an admitted update workflow's tracked read", async () => {
    const input = await fixture();
    const configRoot = join(input.root, "config");
    const stateRoot = join(input.root, "state");
    const inputRoot = join(input.root, "mounted-input");
    const sourceRoot = join(inputRoot, "prepared-sources", "synthetic-source");
    await mkdir(configRoot, { mode: 0o700 });
    await mkdir(stateRoot, { mode: 0o700 });
    await mkdir(sourceRoot, { recursive: true });
    const sourceBytes = Buffer.from("# Pinned product source\n");
    const file = {
      path: "source.md",
      byteLength: sourceBytes.byteLength,
      sha256: sha256(sourceBytes),
    };
    const source = {
      schemaVersion: 1 as const,
      kind: "docsfab-prepared-local-source" as const,
      sourceId: "synthetic-source",
      repositoryRevision: input.request.baseline.repositoryRevision,
      contentSha256: preparedLocalSourceContentSha256({
        sourceId: "synthetic-source",
        repositoryRevision: input.request.baseline.repositoryRevision,
        files: [file],
      }),
      paths: [file.path],
    };
    await writeFile(join(sourceRoot, file.path), sourceBytes);
    await writeFile(
      join(inputRoot, "prepared-sources.json"),
      JSON.stringify({
        schemaVersion: 1,
        kind: "docsfab-prepared-local-sources",
        sources: [{ ref: source, files: [file] }],
      }),
    );
    let sends = 0;
    let plannerReadSent = false;
    let childSettlement: ReturnType<typeof parentWorkflowResult>;
    const serverErrors: string[] = [];
    const serverObservations: ServerObservation[] = [];
    const server = observedFixtureServer(async (request, response) => {
      let body = "";
      for await (const chunk of request) body += chunk.toString();
      observeProviderRequest(request, response, body, serverObservations);
      sends += 1;
      const promptText = providerPromptText(body);
      const assessment = (summary: unknown, kind: "accepted" | "not-applicable" = "accepted") => {
        const line = promptText
          .split("\n")
          .find((entry) =>
            entry.startsWith("The only artifact references admitted for evidenceRefs are: "),
          );
        if (!line) throw new Error("The real child prompt omitted its evidence admission set.");
        const admitted = JSON.parse(line.slice(line.indexOf(": ") + 2)) as unknown[];
        if (admitted.length === 0) throw new Error("The child has no admitted evidence reference.");
        return JSON.stringify({
          summary,
          editorialAssessmentProposal: {
            schemaVersion: 1,
            kind: "docsfab-editorial-assessment-proposal",
            assessment: kind,
            rationale:
              "The observed guide and bound source support this limited assessment; no broader product behavior is claimed.",
            evidenceRefs: [admitted[0]],
            limitations: kind === "not-applicable" ? ["audience-exercise-unavailable"] : [],
            recommendation: null,
          },
        });
      };
      let delta: { content?: string; tool_calls?: unknown[] };
      const settled = parentWorkflowResult(body);
      if (sends === 1) {
        delta = {
          tool_calls: [
            {
              index: 0,
              id: "update-call",
              type: "function",
              function: {
                name: "docsfab_run_workflow",
                arguments: JSON.stringify({
                  workflow: "update-documentation",
                  instruction:
                    "Assess docs/guide.md against the attached source without changing it.",
                }),
              },
            },
          ],
        };
      } else if (settled) {
        childSettlement = settled;
        delta = {
          content: JSON.stringify({
            schemaVersion: 1,
            kind: "docsfab-live-agent-task-declaration",
            decision: "no-change",
            evidenceIds: [`child-${settled.runId}`, "synthetic-source"],
          }),
        };
      } else if (promptText.includes("Runtime reader-impact planner response contract")) {
        if (!plannerReadSent) {
          plannerReadSent = true;
          delta = {
            tool_calls: [
              {
                index: 0,
                id: "source-read",
                type: "function",
                function: { name: "read", arguments: JSON.stringify({ path: "docs/guide.md" }) },
              },
            ],
          };
        } else {
          delta = {
            content: JSON.stringify({
              summary:
                "The attached source states no product behavior beyond the current guide heading.",
              planBinding: {
                mode: "update",
                pages: [{ path: "docs/guide.md", disposition: "retain" }],
                sourceBindings: [],
              },
              editorialDecisionProposal: {
                candidate: "no-change",
                rationale:
                  "The current guide remains a heading only, and the admitted source likewise supplies no changed public behavior to document.",
                slotIds: ["current-documentation"],
              },
            }),
          };
        }
      } else if (promptText.includes("Nested technical verification result contract")) {
        const dimensions = [
          "input-representations",
          "defaults-and-overrides",
          "mutable-state",
          "destination-and-trust",
          "error-status-retry",
          "environment-prerequisite",
        ].map((dimension) => ({
          dimension,
          status: "not-applicable",
          reason:
            "The bounded source and guide contain only headings and state no behavior in this dimension.",
          sourceLocators: ["docs/guide.md:1"],
          facts: [],
        }));
        delta = {
          content: assessment({
            review: { verdict: "pass", issues: [] },
            coverage: [
              {
                path: "docs/guide.md",
                status: "verified",
                evidence: ["docs/guide.md:1"],
                reason:
                  "The tracked guide heading was compared with the admitted source; no behavior claim was found.",
              },
            ],
            factInventory: { completeness: "bounded-not-proven", dimensions, limitations: [] },
          }),
        };
      } else if (promptText.includes("Nested editorial review result contract")) {
        delta = { content: assessment({ verdict: "pass", issues: [] }) };
      } else if (promptText.includes("Runtime quality artifact response contract")) {
        const marker =
          "The selected quality profile receipt below is authoritative and immutable:\n";
        const receiptLine = promptText
          .slice(promptText.indexOf(marker) + marker.length)
          .split("\n")[0];
        const receipt = JSON.parse(receiptLine) as {
          profileAssetPath: string;
          repositoryRevision: string;
        };
        const profile = JSON.parse(
          await readFile(join(process.cwd(), "quality", receipt.profileAssetPath), "utf8"),
        );
        const candidate = authoringFixtureCandidate(profile, receipt.repositoryRevision);
        delta = {
          content: assessment(
            `${JSON.stringify({ evaluation: candidate.evaluation, qualityScore: candidate.qualityScore })}\n\n${candidate.reportMarkdown}`,
          ),
        };
      } else if (
        promptText.includes("Runtime independent editorial assessment response contract") &&
        promptText.includes("test-audience-understanding")
      ) {
        delta = {
          content: assessment(
            "No authorized participant, reference model, scenario corpus, or oracle is available for an audience exercise.",
            "not-applicable",
          ),
        };
      } else {
        throw new Error(
          `Unexpected source-aware provider turn ${sends} (plannerReadSent=${plannerReadSent}; ${providerMessageMarkers(body)}).`,
        );
      }
      const chunks = [
        {
          id: "reply",
          object: "chat.completion.chunk",
          created: 1,
          model: "gpt-6-sol",
          choices: [{ index: 0, delta: { role: "assistant", ...delta }, finish_reason: null }],
        },
        {
          id: "reply",
          object: "chat.completion.chunk",
          created: 1,
          model: "gpt-6-sol",
          choices: [
            { index: 0, delta: {}, finish_reason: "tool_calls" in delta ? "tool_calls" : "stop" },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        },
      ];
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(
        chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n",
      );
    }, serverErrors);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Loopback fixture did not bind.");
    try {
      await writeFile(
        join(configRoot, "host.yaml"),
        [
          "schemaVersion: 1",
          "kind: docsfab-host-config",
          "activeExecutionProfile: nvidia-inference-gpt-6-sol-pi",
          "compositionId: nvidia-inference-gpt-6-sol-pi",
          "active:",
          "  writing:",
          "    compositionId: nvidia-inference-gpt-6-sol-pi",
          "    qualification: not-run",
          "    settings:",
          `      baseUrl: http://127.0.0.1:${address.port}/v1`,
          "",
        ].join("\n"),
        { mode: 0o600 },
      );
      await writeFile(join(configRoot, "secrets.env"), "MODEL_API_KEY=offline-test-placeholder\n", {
        mode: 0o600,
      });
      const environment = {
        DOCSFAB_CONFIG_ROOT: configRoot,
        DOCSFAB_STATE_DIR: stateRoot,
        DOCSFAB_TASK_INPUT_DIR: inputRoot,
        MODEL_API_KEY: "offline-test-placeholder",
      };
      const prompt = "Assess docs/guide.md against the attached source without changing it.";
      await writeFile(
        input.taskFile,
        JSON.stringify({
          ...input.request,
          prompt: { encoding: "utf-8", text: prompt, sha256: sha256(Buffer.from(prompt)) },
          sources: [source],
          requiredEvidence: ["synthetic-source"],
          scope: { ...input.request.scope, writeClass: "documentation" },
          effectiveConfig: liveAgentTaskEffectiveConfiguration(
            loadConfig(environment),
            environment,
          ),
        }),
      );
      const summary = await runLiveAgentTask({
        ...input,
        allowWrite: true,
        documentationDirectories: ["docs"],
        environment,
      });
      const exported = decodeLiveAgentTaskExportV1(
        JSON.parse(await readFile(summary.exportPath, "utf8")),
      );
      const activity = (
        await readFile(
          join(input.resultDirectory, `${exported.requestSha256}.activity.jsonl`),
          "utf8",
        )
      )
        .trimEnd()
        .split("\n")
        .map((line) => JSON.parse(line));
      if (process.env.DOCSFAB_TEST_ACTIVITY_FIXTURE_DIR) {
        const output = join(process.env.DOCSFAB_TEST_ACTIVITY_FIXTURE_DIR, "prepared-source");
        await mkdir(output, { recursive: true });
        await writeFile(join(output, "request.json"), await readFile(input.taskFile));
        await writeFile(join(output, "export.json"), await readFile(summary.exportPath));
        await writeFile(
          join(output, "activity.jsonl"),
          await readFile(join(input.resultDirectory, `${exported.requestSha256}.activity.jsonl`)),
        );
        await writeFile(
          join(output, "server-observations.json"),
          JSON.stringify(serverObservations),
        );
        await writeFile(
          join(output, "child-outcome.json"),
          JSON.stringify(childSettlement ?? null),
        );
      }
      expect(serverErrors).toEqual([]);
      expect(sends).toBeGreaterThanOrEqual(7);
      expect(childSettlement).toEqual(
        expect.objectContaining({
          status: "succeeded",
          editorialOutcome: "verified-no-change",
          // The no-write branch runs the evaluator assessment, while validated
          // authoring quality artifacts require an actual selected write step.
          qualityPresent: false,
          qualityLimitations: [],
          qualityDeclineCode: null,
        }),
      );
      expect(childSettlement?.steps).toEqual([
        { id: "plan-documentation", status: "succeeded" },
        { id: "verify-technical-accuracy", status: "succeeded" },
        { id: "review-documentation", status: "succeeded" },
        { id: "test-audience-understanding", status: "succeeded" },
        { id: "evaluate-document-quality", status: "succeeded" },
      ]);
      expect(exported.result.nativeChildRecords).toHaveLength(1);
      expect(exported.result.trace.status).toBe("complete");
      expect(activity.at(-1).coverage).toEqual({
        provider: "complete",
        tools: "complete",
        source: "complete",
        web: "complete",
        workspace: "complete",
        child: "complete",
      });
      expect(activity.at(-1).missing).toEqual([]);
      expect(activity[0].instrumentation.childScopes).toEqual([
        expect.objectContaining({ workflow: "update-documentation" }),
      ]);
      expect(activity).toContainEqual(
        expect.objectContaining({
          eventType: "resource-operation",
          resourceKind: "prepared-source",
          operation: "bind",
          phase: "settled",
          status: "ok",
          resourceId: "synthetic-source",
        }),
      );
      expect(activity).toContainEqual(
        expect.objectContaining({
          eventType: "resource-operation",
          resourceKind: "prepared-source",
          operation: "load",
          phase: "settled",
          status: "ok",
          bodySha256: sha256(sourceBytes),
        }),
      );
      expect(activity).toContainEqual(
        expect.objectContaining({
          eventType: "resource-operation",
          resourceKind: "prepared-source",
          operation: "read",
          phase: "settled",
          status: "ok",
          bodySha256: sha256(sourceBytes),
        }),
      );
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 60_000);

  it("backs no-change only with byte-verified prepared source IDs", async () => {
    const input = await fixture();
    const configRoot = join(input.root, "config");
    const stateRoot = join(input.root, "state");
    const inputRoot = join(input.root, "mounted-input");
    const sourcesRoot = join(inputRoot, "prepared-sources", "synthetic-source");
    await mkdir(configRoot, { mode: 0o700 });
    await mkdir(stateRoot, { mode: 0o700 });
    await mkdir(sourcesRoot, { recursive: true });
    const bytes = Buffer.from("# Pinned source\n");
    const file = { path: "source.md", byteLength: bytes.byteLength, sha256: sha256(bytes) };
    const source = {
      schemaVersion: 1 as const,
      kind: "docsfab-prepared-local-source" as const,
      sourceId: "synthetic-source",
      repositoryRevision: input.request.baseline.repositoryRevision,
      contentSha256: preparedLocalSourceContentSha256({
        sourceId: "synthetic-source",
        repositoryRevision: input.request.baseline.repositoryRevision,
        files: [file],
      }),
      paths: [file.path],
    };
    await writeFile(join(sourcesRoot, file.path), bytes);
    await writeFile(
      join(inputRoot, "prepared-sources.json"),
      JSON.stringify({
        schemaVersion: 1,
        kind: "docsfab-prepared-local-sources",
        sources: [{ ref: source, files: [file] }],
      }),
    );
    const declarations = ["synthetic-source", "unknown-evidence", "host-diff"];
    let sends = 0;
    const server = createServer(async (request, response) => {
      let body = "";
      for await (const chunk of request) body += chunk.toString();
      sends += 1;
      const model = JSON.parse(body).model;
      const evidenceId = declarations.shift();
      const declaration = JSON.stringify({
        schemaVersion: 1,
        kind: "docsfab-live-agent-task-declaration",
        decision: "no-change",
        evidenceIds: [evidenceId],
      });
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(
        `data: ${JSON.stringify({ id: "source", object: "chat.completion.chunk", created: 1, model, choices: [{ index: 0, delta: { role: "assistant", content: declaration }, finish_reason: null }] })}\n\n`,
      );
      response.write(
        `data: ${JSON.stringify({ id: "source", object: "chat.completion.chunk", created: 1, model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\n`,
      );
      response.end("data: [DONE]\n\n");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Loopback fixture did not bind.");
    try {
      await writeFile(
        join(configRoot, "host.yaml"),
        [
          "schemaVersion: 1",
          "kind: docsfab-host-config",
          "activeExecutionProfile: nvidia-inference-gpt-6-sol-pi",
          "compositionId: nvidia-inference-gpt-6-sol-pi",
          "active:",
          "  writing:",
          "    compositionId: nvidia-inference-gpt-6-sol-pi",
          "    qualification: not-run",
          "    settings:",
          `      baseUrl: http://127.0.0.1:${address.port}/v1`,
          "",
        ].join("\n"),
        { mode: 0o600 },
      );
      await writeFile(join(configRoot, "secrets.env"), "MODEL_API_KEY=offline-test-placeholder\n", {
        mode: 0o600,
      });
      const environment = {
        DOCSFAB_CONFIG_ROOT: configRoot,
        DOCSFAB_STATE_DIR: stateRoot,
        DOCSFAB_TASK_INPUT_DIR: inputRoot,
        MODEL_API_KEY: "offline-test-placeholder",
      };
      const request = {
        ...input.request,
        sources: [source],
        requiredEvidence: ["synthetic-source"],
        effectiveConfig: liveAgentTaskEffectiveConfiguration(loadConfig(environment), environment),
      };
      await writeFile(input.taskFile, JSON.stringify(request));
      const options = {
        ...input,
        allowWrite: false,
        documentationDirectories: ["docs"],
        environment,
      };
      const first = await runLiveAgentTask(options);
      const firstExport = decodeLiveAgentTaskExportV1(
        JSON.parse(await readFile(first.exportPath, "utf8")),
      );
      const firstResult = firstExport.result;
      expect(sends).toBe(1);
      const activityBytes = await readFile(
        join(input.resultDirectory, `${firstExport.requestSha256}.activity.jsonl`),
      );
      expect(firstResult.trace.activitySha256).toBe(sha256(activityBytes));
      const activityRows = activityBytes
        .toString("utf8")
        .trimEnd()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(activityRows[0]).toMatchObject({
        kind: "docsfab-task-activity-header",
        requestSha256: firstExport.requestSha256,
        sessionId: request.sessionId,
      });
      expect(activityRows.slice(1, -1)).toContainEqual(
        expect.objectContaining({
          producer: "provider-transport",
          eventType: "provider-request",
          phase: "started",
          status: "sent",
        }),
      );
      expect(activityRows.at(-1)).toMatchObject({
        kind: "docsfab-task-activity-footer",
        eventCount: activityRows.length - 2,
      });
      expect(firstResult.noChangeClaim.classification).toBe("evidence-backed");
      expect(firstResult.evidence).toContainEqual(
        expect.objectContaining({
          evidenceId: source.sourceId,
          availability: "available",
          sha256: source.contentSha256,
        }),
      );

      await writeFile(join(sourcesRoot, file.path), "tampered bytes");
      const tampered = await runLiveAgentTask({
        ...options,
        resultDirectory: join(input.root, "tampered-result"),
      });
      const tamperedResult = decodeLiveAgentTaskExportV1(
        JSON.parse(await readFile(tampered.exportPath, "utf8")),
      ).result;
      expect(sends).toBe(1);
      expect(tamperedResult.evidence).toContainEqual(
        expect.objectContaining({
          evidenceId: source.sourceId,
          availability: "missing",
          sha256: null,
        }),
      );

      await writeFile(join(sourcesRoot, file.path), bytes);
      await writeFile(
        input.taskFile,
        JSON.stringify({ ...request, requiredEvidence: ["unknown-evidence"] }),
      );
      const unknown = await runLiveAgentTask({
        ...options,
        resultDirectory: join(input.root, "unknown-result"),
      });
      const unknownResult = decodeLiveAgentTaskExportV1(
        JSON.parse(await readFile(unknown.exportPath, "utf8")),
      ).result;
      expect(sends).toBe(2);
      expect(unknownResult.noChangeClaim.classification).toBe("unsubstantiated");
      expect(unknownResult.evidence).toContainEqual(
        expect.objectContaining({
          evidenceId: "unknown-evidence",
          availability: "missing",
          sha256: null,
        }),
      );

      const collision = {
        ...source,
        sourceId: "host-diff",
        contentSha256: preparedLocalSourceContentSha256({
          sourceId: "host-diff",
          repositoryRevision: source.repositoryRevision,
          files: [file],
        }),
      };
      await mkdir(join(inputRoot, "prepared-sources", collision.sourceId));
      await writeFile(join(inputRoot, "prepared-sources", collision.sourceId, file.path), bytes);
      await writeFile(
        join(inputRoot, "prepared-sources.json"),
        JSON.stringify({
          schemaVersion: 1,
          kind: "docsfab-prepared-local-sources",
          sources: [{ ref: collision, files: [file] }],
        }),
      );
      await writeFile(
        input.taskFile,
        JSON.stringify({
          ...request,
          sources: [collision],
          requiredEvidence: [collision.sourceId],
        }),
      );
      const collided = await runLiveAgentTask({
        ...options,
        resultDirectory: join(input.root, "collision-result"),
      });
      const collidedResult = decodeLiveAgentTaskExportV1(
        JSON.parse(await readFile(collided.exportPath, "utf8")),
      ).result;
      expect(sends).toBe(3);
      expect(collidedResult.noChangeClaim.classification).toBe("evidence-backed");
      expect(collidedResult.evidence).toContainEqual(
        expect.objectContaining({
          evidenceId: "host-diff",
          kind: "host-record",
          availability: "available",
          sha256: collision.contentSha256,
        }),
      );
      expect(collidedResult.evidence).toContainEqual(
        expect.objectContaining({
          evidenceId: "host-diff-1",
          kind: "diff",
          availability: "available",
        }),
      );
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 30_000);

  it("allocates child and diff evidence away from source and unknown required IDs", () => {
    const source = (sourceId: string) => ({
      schemaVersion: 1 as const,
      kind: "docsfab-prepared-local-source" as const,
      sourceId,
      repositoryRevision: "a".repeat(40),
      contentSha256: "b".repeat(64),
      paths: ["docs/a.md"],
    });
    const identities = liveAgentTaskEvidenceIdentities(
      {
        sources: [source("host-diff"), source("child-record-a")],
        requiredEvidence: ["host-diff", "child-record-a", "host-diff-1", "child-record-a-1"],
      },
      ["record-a"],
    );
    expect(identities.diffId).toBe("host-diff-2");
    expect(identities.childIds.get("record-a")).toBe("child-record-a-2");
  });

  it("matches a byte-sensitive cross-package baseline fixture", async () => {
    const root = await mkdtemp(join(tmpdir(), "docsfab-baseline-"));
    roots.push(root);
    expect(await repositoryBaselineContentSha256(root)).toBe(
      "29066bcc91e893230ab4d0ff33321653497d362c5ddd3653f5b110013ad8884b",
    );
    await mkdir(join(root, ".git"));
    await writeFile(join(root, ".git", "ignored"), "metadata");
    await writeFile(join(root, ".hidden"), Buffer.from([0, 255, 10]));
    await mkdir(join(root, "docs"));
    await writeFile(join(root, "docs", "guide-λ.md"), Buffer.from([0, 128, 255, 10]));
    expect(await repositoryBaselineContentSha256(root)).toBe(
      "c9f42d61b26fc750bfb8b3e1e0c8e25dddbf6a313e89f57a0c838b072025b5bc",
    );
    await symlink("guide-λ.md", join(root, "docs", "alias.md"));
    await expect(repositoryBaselineContentSha256(root)).rejects.toMatchObject({
      code: "baseline-entry-unsupported",
    });
  });

  it("exports files changed under a requested directory while keeping exact files exact", async () => {
    const input = await fixture();
    const baseline = await repositoryBaselineSnapshot(input.repositoryPath);
    await writeFile(join(input.repositoryPath, "docs", "new.md"), "# New guide\n");
    await writeFile(join(input.repositoryPath, "outside.md"), "# Outside\n");
    const directory = await taskDiff(input.repositoryPath, baseline, ["docs"], ["docs"]);
    expect(directory.artifacts.map((artifact) => artifact.path)).toEqual(["docs/new.md"]);
    expect(directory.outside).toEqual(["outside.md"]);
    const exact = await taskDiff(input.repositoryPath, baseline, ["docs/guide.md"], []);
    expect(exact.artifacts).toEqual([]);
    expect(exact.outside).toEqual(expect.arrayContaining(["docs/new.md", "outside.md"]));
    await mkdir(join(input.repositoryPath, "docs", "nested"));
    await writeFile(join(input.repositoryPath, "docs", "nested", "new.md"), "# Nested\n");
    const nested = await taskDiff(input.repositoryPath, baseline, ["docs/nested"], ["docs/nested"]);
    expect(nested.artifacts.map((artifact) => artifact.path)).toEqual(["docs/nested/new.md"]);
    expect(nested.outside).toEqual(expect.arrayContaining(["docs/new.md", "outside.md"]));
  });

  it("compares ignored new and existing pages with the admitted regular-file inventory", async () => {
    const input = await fixture();
    await writeFile(
      join(input.repositoryPath, ".gitignore"),
      "docs/new-ignored.md\ndocs/existing-ignored.md\noutside-ignored.md\n",
    );
    await writeFile(join(input.repositoryPath, "docs", "existing-ignored.md"), "# Before\n");
    const baseline = await repositoryBaselineSnapshot(input.repositoryPath);
    await writeFile(join(input.repositoryPath, "docs", "new-ignored.md"), "# New\n");
    await writeFile(join(input.repositoryPath, "docs", "existing-ignored.md"), "# After\n");
    await writeFile(join(input.repositoryPath, "outside-ignored.md"), "# Outside\n");
    for (const path of ["docs/new-ignored.md", "docs/existing-ignored.md", "outside-ignored.md"])
      execFileSync("git", ["-C", input.repositoryPath, "check-ignore", "--quiet", path]);
    const observed = await taskDiff(input.repositoryPath, baseline, ["docs"], ["docs"]);
    expect(observed.artifacts).toEqual([
      expect.objectContaining({
        path: "docs/existing-ignored.md",
        kind: "document",
        sha256: sha256(Buffer.from("# After\n")),
      }),
      expect.objectContaining({
        path: "docs/new-ignored.md",
        kind: "document",
        sha256: sha256(Buffer.from("# New\n")),
      }),
    ]);
    expect(observed.outside).toContain("outside-ignored.md");
    expect(observed.diff).toEqual({ status: "unavailable", sha256: null });
    const exact = await taskDiff(input.repositoryPath, baseline, ["docs/existing-ignored.md"], []);
    expect(exact.artifacts.map((artifact) => artifact.path)).toEqual(["docs/existing-ignored.md"]);
    expect(exact.outside).toEqual(
      expect.arrayContaining(["docs/new-ignored.md", "outside-ignored.md"]),
    );
    await rm(join(input.repositoryPath, "outside-ignored.md"));
    const admitted = await taskDiff(input.repositoryPath, baseline, ["docs"], ["docs"]);
    expect(admitted.artifacts).toEqual(observed.artifacts);
    expect(admitted.outside).toEqual([]);
    expect(admitted.diff.status).toBe("non-empty");
    expect(admitted.diff.sha256).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("keeps proven partial artifacts when a new unsupported entry makes the diff incomplete", async () => {
    const input = await fixture();
    const baseline = await repositoryBaselineSnapshot(input.repositoryPath);
    await writeFile(join(input.repositoryPath, "docs", "changed.md"), "# Changed\n");
    await symlink("changed.md", join(input.repositoryPath, "docs", "alias.md"));
    const observed = await taskDiff(input.repositoryPath, baseline, ["docs"], ["docs"]);
    expect(observed.artifacts.map((artifact) => artifact.path)).toEqual(["docs/changed.md"]);
    expect(observed.unsupported).toEqual(["docs/alias.md"]);
    expect(observed.diff).toEqual({ status: "unavailable", sha256: null });
  });

  it("retains an ignored page written during a provider turn when that turn is cancelled", async () => {
    const input = await fixture();
    await writeFile(
      join(input.repositoryPath, ".gitignore"),
      "docs/ignored.md\ndocs/existing-ignored.md\n",
    );
    await writeFile(join(input.repositoryPath, "docs", "existing-ignored.md"), "# Before\n");
    execFileSync("git", ["-C", input.repositoryPath, "add", ".gitignore"]);
    execFileSync("git", ["-C", input.repositoryPath, "commit", "-qm", "ignore task page"]);
    const revision = execFileSync("git", ["-C", input.repositoryPath, "rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim();
    const configRoot = join(input.root, "config");
    const stateRoot = join(input.root, "state");
    await mkdir(configRoot, { mode: 0o700 });
    await mkdir(stateRoot, { mode: 0o700 });
    let dispatched!: () => void;
    const providerDispatched = new Promise<void>((resolve) => {
      dispatched = resolve;
    });
    const server = createServer(async (request, response) => {
      for await (const _chunk of request) {
        // Consume the complete physical request before signalling dispatch.
      }
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(": waiting for cancellation\n\n");
      dispatched();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Loopback fixture did not bind.");
    try {
      await writeFile(
        join(configRoot, "host.yaml"),
        [
          "schemaVersion: 1",
          "kind: docsfab-host-config",
          "activeExecutionProfile: nvidia-inference-gpt-6-sol-pi",
          "compositionId: nvidia-inference-gpt-6-sol-pi",
          "active:",
          "  writing:",
          "    compositionId: nvidia-inference-gpt-6-sol-pi",
          "    qualification: not-run",
          "    settings:",
          `      baseUrl: http://127.0.0.1:${address.port}/v1`,
          "",
        ].join("\n"),
        { mode: 0o600 },
      );
      await writeFile(join(configRoot, "secrets.env"), "MODEL_API_KEY=offline-test-placeholder\n", {
        mode: 0o600,
      });
      const environment = {
        DOCSFAB_CONFIG_ROOT: configRoot,
        DOCSFAB_STATE_DIR: stateRoot,
        MODEL_API_KEY: "offline-test-placeholder",
      };
      await writeFile(
        input.taskFile,
        JSON.stringify({
          ...input.request,
          baseline: {
            repositoryRevision: revision,
            contentSha256: await repositoryBaselineContentSha256(input.repositoryPath),
          },
          scope: {
            documentationRoots: ["docs"],
            requestedPaths: ["docs"],
            writeClass: "documentation",
          },
          requiredEvidence: [],
          effectiveConfig: liveAgentTaskEffectiveConfiguration(
            loadConfig(environment),
            environment,
          ),
        }),
      );
      const controller = new AbortController();
      const pending = runLiveAgentTask({
        ...input,
        allowWrite: true,
        documentationDirectories: ["docs"],
        environment,
        signal: controller.signal,
      });
      await providerDispatched;
      await writeFile(join(input.repositoryPath, "docs", "ignored.md"), "# Retained\n");
      await writeFile(join(input.repositoryPath, "docs", "existing-ignored.md"), "# After\n");
      execFileSync("git", [
        "-C",
        input.repositoryPath,
        "check-ignore",
        "--quiet",
        "docs/ignored.md",
      ]);
      controller.abort();
      const summary = await pending;
      const result = decodeLiveAgentTaskExportV1(
        JSON.parse(await readFile(summary.exportPath, "utf8")),
      ).result;
      expect(result.executionStatus).toBe("cancelled");
      expect(result.artifacts).toContainEqual(
        expect.objectContaining({
          path: "docs/ignored.md",
          sha256: sha256(Buffer.from("# Retained\n")),
          disposition: "partial",
        }),
      );
      expect(result.artifacts).toContainEqual(
        expect.objectContaining({
          path: "docs/existing-ignored.md",
          sha256: sha256(Buffer.from("# After\n")),
          disposition: "partial",
        }),
      );
      expect(result.diff.status).toBe("non-empty");
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("exports a proven regular edit when a later symlink makes the task diff unavailable", async () => {
    const input = await fixture();
    const configRoot = join(input.root, "config");
    const stateRoot = join(input.root, "state");
    await mkdir(configRoot, { mode: 0o700 });
    await mkdir(stateRoot, { mode: 0o700 });
    let dispatched!: () => void;
    let complete!: () => void;
    const providerDispatched = new Promise<void>((resolve) => {
      dispatched = resolve;
    });
    const finishProvider = new Promise<void>((resolve) => {
      complete = resolve;
    });
    const server = createServer(async (request, response) => {
      let body = "";
      for await (const chunk of request) body += chunk.toString();
      const model = JSON.parse(body).model;
      dispatched();
      await finishProvider;
      const declaration = JSON.stringify({
        schemaVersion: 1,
        kind: "docsfab-live-agent-task-declaration",
        decision: "needs-input",
        evidenceIds: [],
      });
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(
        `data: ${JSON.stringify({ id: "unsafe", object: "chat.completion.chunk", created: 1, model, choices: [{ index: 0, delta: { role: "assistant", content: declaration }, finish_reason: null }] })}\n\n`,
      );
      response.write(
        `data: ${JSON.stringify({ id: "unsafe", object: "chat.completion.chunk", created: 1, model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\n`,
      );
      response.end("data: [DONE]\n\n");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Loopback fixture did not bind.");
    try {
      await writeFile(
        join(configRoot, "host.yaml"),
        [
          "schemaVersion: 1",
          "kind: docsfab-host-config",
          "activeExecutionProfile: nvidia-inference-gpt-6-sol-pi",
          "compositionId: nvidia-inference-gpt-6-sol-pi",
          "active:",
          "  writing:",
          "    compositionId: nvidia-inference-gpt-6-sol-pi",
          "    qualification: not-run",
          "    settings:",
          `      baseUrl: http://127.0.0.1:${address.port}/v1`,
          "",
        ].join("\n"),
        { mode: 0o600 },
      );
      await writeFile(join(configRoot, "secrets.env"), "MODEL_API_KEY=offline-test-placeholder\n", {
        mode: 0o600,
      });
      const environment = {
        DOCSFAB_CONFIG_ROOT: configRoot,
        DOCSFAB_STATE_DIR: stateRoot,
        MODEL_API_KEY: "offline-test-placeholder",
      };
      await writeFile(
        input.taskFile,
        JSON.stringify({
          ...input.request,
          scope: {
            documentationRoots: ["docs"],
            requestedPaths: ["docs"],
            writeClass: "documentation",
          },
          requiredEvidence: [],
          effectiveConfig: liveAgentTaskEffectiveConfiguration(
            loadConfig(environment),
            environment,
          ),
        }),
      );
      const pending = runLiveAgentTask({
        ...input,
        allowWrite: true,
        documentationDirectories: ["docs"],
        environment,
      });
      await providerDispatched;
      await writeFile(join(input.repositoryPath, "docs", "retained.md"), "# Retained\n");
      await symlink("retained.md", join(input.repositoryPath, "docs", "alias.md"));
      complete();
      const summary = await pending;
      const result = decodeLiveAgentTaskExportV1(
        JSON.parse(await readFile(summary.exportPath, "utf8")),
      ).result;
      expect(result.executionStatus).toBe("refused");
      expect(result.artifacts).toContainEqual(
        expect.objectContaining({
          path: "docs/retained.md",
          sha256: sha256(Buffer.from("# Retained\n")),
          disposition: "partial",
        }),
      );
      expect(result.diff).toEqual({ status: "unavailable", sha256: null });
      expect(result.evidence).toContainEqual(
        expect.objectContaining({
          evidenceId: "host-diff",
          availability: "missing",
          sha256: null,
        }),
      );
      expect(result.limitations).toContainEqual(expect.stringContaining("task diff is incomplete"));
    } finally {
      complete();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("narrows the live host to a requested directory under an independent directory grant", async () => {
    const host = new DocumentationScope(["docs"]);
    const directory = narrowTaskDocumentationScope(host, ["docs"], ["docs"], []);
    expect(directory.allows("docs/new.md")).toBe(true);
    expect(directory.allows("README.md")).toBe(false);
    const exact = narrowTaskDocumentationScope(host, ["docs/guide.md"], ["docs"], []);
    expect(exact.allows("docs/guide.md")).toBe(true);
    expect(exact.allows("docs/new.md")).toBe(false);
    const nested = narrowTaskDocumentationScope(
      host,
      ["docs/nested"],
      ["docs"],
      [],
      ["docs/nested"],
    );
    expect(nested.allows("docs/nested/new.md")).toBe(true);
    expect(nested.allows("docs/sibling.md")).toBe(false);
  });

  it("intersects an exact tracked text-file grant with the requested task path", () => {
    const host = new DocumentationScope([], ["manual"]);
    const exact = narrowTaskDocumentationScope(
      host,
      ["manual/guide.adoc"],
      [],
      ["manual/guide.adoc"],
    );
    expect(exact.allows("manual/guide.adoc")).toBe(true);
    expect(exact.allows("manual/sibling.adoc")).toBe(false);
    expect(exact.allows("manual/sub/guide.adoc")).toBe(false);
    expect(exact.allows("src/docs/guide.adoc")).toBe(false);
  });
});

describe("live-agent child reservation", () => {
  const budget = () =>
    createRootTaskBudget({
      envelope: {
        "provider-turns": 2,
        "tool-calls": 0,
        "input-tokens": 0,
        "output-tokens": 0,
        "source-bytes": 0,
        "elapsed-ms": 0,
        "cost-microusd": 0,
      },
    });

  it("holds parent capacity until the child workflow and persistence drain", async () => {
    const parent = budget();
    let release!: () => void;
    let start!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      start = resolve;
    });
    const runner = createLiveAgentBoundedRunner({
      selection: createLiveAgentSourceSelection(),
      repositoryPath: "/synthetic/task",
      allowWrite: false,
      config: {} as never,
      taskBudget: parent,
      runWorkflow: async () => {
        start();
        await held;
        return {} as never;
      },
      persist: async () => ({ status: "not-needed" }),
    });
    const work = runner("update-documentation", "Check the guide.");
    await started;
    expect(projectTaskBudget(parent).remaining["provider-turns"]).toBe(0);
    expect(projectTaskBudget(parent).reservedOutstanding["provider-turns"]).toBe(2);
    release();
    await work;
    expect(projectTaskBudget(parent).remaining["provider-turns"]).toBe(2);
  });

  it("retains reservation when a child fails before drain is proven", async () => {
    const parent = budget();
    const runner = createLiveAgentBoundedRunner({
      selection: createLiveAgentSourceSelection(),
      repositoryPath: "/synthetic/task",
      allowWrite: false,
      config: {} as never,
      taskBudget: parent,
      runWorkflow: async () => {
        throw new Error("synthetic unproven child failure");
      },
      persist: async () => ({ status: "not-needed" }),
    });
    await expect(runner("update-documentation", "Check the guide.")).rejects.toThrow(
      "synthetic unproven child failure",
    );
    expect(projectTaskBudget(parent).reservedOutstanding["provider-turns"]).toBe(2);
  });

  it("settles a persisted child with a null identity pair when its saved digest is absent", async () => {
    const settlements: Parameters<TaskActivityObserver["settleChildScope"]>[0][] = [];
    const native: Array<{ id: string; sha256: string | null }> = [];
    const observer = {
      settleChildScope: (input: Parameters<TaskActivityObserver["settleChildScope"]>[0]) => {
        settlements.push(input);
      },
    } as unknown as TaskActivityObserver;
    const runner = createLiveAgentBoundedRunner({
      selection: createLiveAgentSourceSelection(),
      repositoryPath: "/synthetic/task",
      allowWrite: false,
      config: { stateDirectory: "/synthetic/absent-run-store" } as never,
      runWorkflow: async () => ({ id: "run-absent", status: "succeeded" }) as never,
      persist: async () => ({ status: "not-needed" }),
      onTaskChildRecord: (record, recordSha256) => {
        native.push({ id: record.id, sha256: recordSha256 });
      },
    });
    await withTaskActivity(
      { observer, childScopeId: "child-scope-1", producerSessionId: null },
      () => runner("update-documentation", "Check the guide."),
    );
    expect(native).toEqual([{ id: "run-absent", sha256: null }]);
    expect(settlements).toEqual([
      expect.objectContaining({
        childScopeId: "child-scope-1",
        status: "completed",
        recordId: null,
        recordSha256: null,
      }),
    ]);
  });
});
