// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { randomUUID } from "node:crypto";
import { cp, mkdir, realpath, utimes, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { DocsFabConfig } from "../src/config/runtime-loader.js";
import { createStyleTaskContext } from "../src/execution/task-context.js";
import { PiHarness } from "../src/harness/pi.js";
import { repositoryVirtualCwd } from "../src/harness/pi-session.js";
import { loadLiveAgentCapabilities } from "../src/live-agent/capabilities.js";
import {
  assembleLiveAgentHost,
  createLiveAgentPiSession,
  createLiveAgentResourceLoader,
  openLiveAgentSessionManager,
} from "../src/live-agent/host.js";
import { createModelConnection } from "../src/model/provider.js";
import { verifyQualityPackContext } from "../src/quality-pack/manifest.js";
import { getWorkflow } from "../src/workflow-registry/catalog.js";
import { initFixtureRepo } from "./helpers/git.js";
import { validModelConfig } from "./helpers.js";
import { temporaryRoots } from "./helpers/temp.js";
import { testTimeoutMs } from "./helpers/test-timeouts.js";
import { projectRoot, textTurn, toolTurn } from "./support/pi-harness-session-fixtures.js";

// Each case copies the installed assets and initializes a Git checkout.
const CANARY_CASE_MS = testTimeoutMs(60_000);
const roots = temporaryRoots();

afterEach(() => {
  vi.unstubAllGlobals();
});

/**
 * A checkout and an installation under one host directory whose path holds a
 * unique marker and a space, as a laptop install under a user's home would.
 */
async function canaryHost() {
  const marker = `HOSTPATHCANARY${randomUUID().replaceAll("-", "")}`;
  const root = await roots.create(`docsfab canary ${marker} `, { realpath: true });
  const repositoryPath = join(root, "checkout");
  await initFixtureRepo(
    repositoryPath,
    {
      "README.md": "# Fixture\n\nThe fixture product documentation.\n",
      "AGENTS.md": "Keep documentation changes small.\n",
    },
    { branch: "main" },
  );
  const install = join(root, "install");
  for (const directory of ["skill-crate", "quality", "quality-pack"]) {
    await cp(resolve(projectRoot, directory), join(install, directory), { recursive: true });
  }
  const hostRoots = [root, await realpath(root), marker];
  return { marker, root, repositoryPath, install, hostRoots };
}

/** Record every provider request body and answer from the script in order. */
function recordProvider(responses: readonly Response[]): string[] {
  const bodies: string[] = [];
  vi.stubGlobal("fetch", async (_request: RequestInfo | URL, init?: RequestInit) => {
    bodies.push(String(init?.body));
    const response = responses[bodies.length - 1];
    if (!response) throw new Error("Unexpected provider request.");
    return response.clone();
  });
  return bodies;
}

function expectNoHostPath(bodies: readonly string[], hostRoots: readonly string[]): void {
  expect(bodies.length).toBeGreaterThan(1);
  for (const [index, body] of bodies.entries()) {
    for (const root of hostRoots) {
      expect(body.includes(root), `provider request ${index} carries ${root}`).toBe(false);
    }
  }
}

describe("model boundary: no host path reaches the provider payload", {
  timeout: CANARY_CASE_MS,
}, () => {
  it("keeps the checkout and install paths out of a workflow step's provider requests", async () => {
    const host = await canaryHost();
    const workflow = getWorkflow("restructure-documentation");
    const step = workflow.steps.find((candidate) => candidate.id === "write-documentation")!;
    const virtualSkill = `.docsfab-governed-assets/skills/${step.skill}`;
    const bodies = recordProvider([
      toolTurn([
        { id: "call-1", name: "read", arguments: { path: "README.md" } },
        { id: "call-2", name: "read", arguments: { path: `${virtualSkill}/SKILL.md` } },
        { id: "call-3", name: "ls", arguments: { path: "." } },
      ]),
      textTurn("The requested documentation was updated."),
    ]);
    const harness = new PiHarness({
      skillCrateDirectory: join(host.install, "skill-crate"),
      qualityDirectory: join(host.install, "quality"),
      styleContext: await createStyleTaskContext(
        await verifyQualityPackContext({
          skillCrateDirectory: join(host.install, "skill-crate"),
          qualityDirectory: join(host.install, "quality"),
          qualityPackDirectory: join(host.install, "quality-pack"),
        }),
      ),
      model: validModelConfig,
      createConnection: createModelConnection,
    });

    await harness.runStep({
      runId: "host-path-canary-run",
      repositoryPath: host.repositoryPath,
      workflow,
      step,
      evidenceIdentity: { repositoryRevision: "a".repeat(40) },
    });

    expectNoHostPath(bodies, host.hostRoots);
    expect(bodies[0]).toContain("<cwd>\\n/workspace\\n</cwd>");
    expect(bodies[0]).toContain('<project_instructions path=\\"AGENTS.md\\">');
    expect(bodies[0]).toContain(`location=\\"${virtualSkill}/SKILL.md\\"`);
    expect(bodies[1]).toContain("The fixture product documentation.");
  });

  it("keeps the checkout and install paths out of a live-agent turn's provider requests", async () => {
    const host = await canaryHost();
    const config = {
      projectRoot: host.install,
      skillCrateDirectory: join(host.install, "skill-crate"),
      qualityDirectory: join(host.install, "quality"),
      qualityPackDirectory: join(host.install, "quality-pack"),
      stateDirectory: join(host.root, "state"),
      model: validModelConfig,
    } as DocsFabConfig;
    const sessionDirectory = join(host.root, "sessions");
    await mkdir(sessionDirectory, { recursive: true });
    const capabilities = await loadLiveAgentCapabilities(config);
    const liveHost = await assembleLiveAgentHost({
      repositoryPath: host.repositoryPath,
      allowWrite: true,
      environment: { PATH: process.env.PATH },
      config,
      capabilities,
      sessionDirectory,
      sourcePorts: {} as never,
      onNotice: () => undefined,
      writeError: () => undefined,
      runWorkflow: vi.fn() as never,
    });
    const bodies = recordProvider([
      toolTurn([
        { id: "call-1", name: "docsfab_use_skill", arguments: { skill: "review-documentation" } },
      ]),
      toolTurn([
        { id: "call-2", name: "read", arguments: { path: "README.md" } },
        { id: "call-3", name: "ls", arguments: { path: "." } },
      ]),
      textTurn("The README describes the fixture product."),
    ]);
    const connection = await createModelConnection(validModelConfig);
    const session = await createLiveAgentPiSession({
      repositoryPath: host.repositoryPath,
      modelRuntime: connection.runtime,
      model: connection.model,
      resourceLoader: await createLiveAgentResourceLoader({
        repositoryPath: host.repositoryPath,
        host: liveHost,
        agentDir: join(host.root, "agent"),
      }),
      sessionManager: openLiveAgentSessionManager({
        repositoryPath: host.repositoryPath,
        sessionDirectory,
        newSession: true,
      }),
      host: liveHost,
    });
    try {
      liveHost.terminalOptions.onUserTurn?.("Summarize the README.");
      await session.prompt("Summarize the README.");
    } finally {
      session.dispose();
    }

    expectNoHostPath(bodies, host.hostRoots);
    expect(bodies[0]).toContain("<cwd>\\n/workspace\\n</cwd>");
    expect(bodies[0]).not.toContain("<available_skills>");
    expect(bodies[1]).toContain("Apply the locked DocsFab skill review-documentation");
    expect(bodies[2]).toContain("The fixture product documentation.");
  });
});

describe("live-agent resume under a per-repository virtual cwd", () => {
  async function saveConversation(manager: SessionManager, text: string): Promise<string> {
    manager.appendMessage({ role: "user", content: text, timestamp: Date.now() });
    manager.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: `Noted: ${text}` }],
      api: "openai-completions",
      provider: "fixture",
      model: "fixture",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: Date.now(),
    } as never);
    return manager.getSessionFile()!;
  }

  function userTexts(manager: SessionManager): string[] {
    return manager
      .buildSessionContext()
      .messages.flatMap((message) =>
        message.role === "user" && typeof message.content === "string" ? [message.content] : [],
      );
  }

  async function repositories() {
    const root = await roots.create("docsfab-live-resume-");
    const first = join(root, "first");
    const second = join(root, "second");
    const sessionDirectory = join(root, "sessions");
    await Promise.all([first, second, sessionDirectory].map((path) => mkdir(path)));
    return { first, second, sessionDirectory };
  }

  it("resumes a repository's own conversation and never another repository's", async () => {
    const { first, second, sessionDirectory } = await repositories();
    const open = (repositoryPath: string, newSession = false) =>
      openLiveAgentSessionManager({ repositoryPath, sessionDirectory, newSession });

    const firstFile = await saveConversation(open(first, true), "first repository");
    const secondFile = await saveConversation(open(second, true), "second repository");
    // The second repository's conversation is newer, so an unscoped resume would pick it.
    await utimes(firstFile, new Date(1_000), new Date(1_000));

    const firstResumed = open(first);
    expect(firstResumed.getSessionFile()).toBe(firstFile);
    expect(firstResumed.getCwd()).toBe(repositoryVirtualCwd(first));
    expect(userTexts(firstResumed)).toEqual(["first repository"]);
    const secondResumed = open(second);
    expect(secondResumed.getSessionFile()).toBe(secondFile);
    expect(userTexts(secondResumed)).toEqual(["second repository"]);
  });

  it("resumes a newer virtual-cwd conversation over an older real-path one", async () => {
    const { first, sessionDirectory } = await repositories();
    const legacyFile = await saveConversation(
      SessionManager.create(first, sessionDirectory),
      "recorded before virtual cwds",
    );
    await utimes(legacyFile, new Date(1_000), new Date(1_000));
    const virtualFile = await saveConversation(
      openLiveAgentSessionManager({ repositoryPath: first, sessionDirectory, newSession: true }),
      "recorded under the virtual cwd",
    );

    const resumed = openLiveAgentSessionManager({
      repositoryPath: first,
      sessionDirectory,
      newSession: false,
    });
    expect(resumed.getSessionFile()).toBe(virtualFile);
    expect(resumed.getCwd()).toBe(repositoryVirtualCwd(first));
    expect(userTexts(resumed)).toEqual(["recorded under the virtual cwd"]);
  });

  it("resumes a conversation recorded under the real repository path", async () => {
    const { first, second, sessionDirectory } = await repositories();
    const legacyFile = await saveConversation(
      SessionManager.create(first, sessionDirectory),
      "recorded before virtual cwds",
    );
    await writeFile(join(sessionDirectory, "unrelated.txt"), "not a session\n");

    const resumed = openLiveAgentSessionManager({
      repositoryPath: first,
      sessionDirectory,
      newSession: false,
    });
    expect(resumed.getSessionFile()).toBe(legacyFile);
    expect(resumed.getCwd()).toBe(repositoryVirtualCwd(first));
    expect(userTexts(resumed)).toEqual(["recorded before virtual cwds"]);
    expect(
      userTexts(
        openLiveAgentSessionManager({
          repositoryPath: second,
          sessionDirectory,
          newSession: false,
        }),
      ),
    ).toEqual([]);
  });
});
