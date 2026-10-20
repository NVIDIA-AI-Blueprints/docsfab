// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { renameSync, symlinkSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

const fsRaceHooks = vi.hoisted(() => ({
  beforeSpawn: undefined as (() => void) | undefined,
  workerPrelude: "",
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: (...args: Parameters<typeof actual.spawn>) => {
      const [command, workerArgs, options] = args;
      if (
        typeof workerArgs[2] === "string" &&
        workerArgs[2].includes("DOCSFAB_TASK_EXPORT_WRITER_WORKER_V1")
      ) {
        fsRaceHooks.beforeSpawn?.();
        const source = `${fsRaceHooks.workerPrelude}\n${workerArgs[2]}`;
        return actual.spawn(command, [workerArgs[0], workerArgs[1], source], options);
      }
      return actual.spawn(...args);
    },
  };
});

import { canonicalDigest, sha256 } from "../src/content-ir/canonical.js";
import {
  finalizeLiveAgentTaskCompletionV1,
  bindLiveAgentTaskCompletionV1,
} from "../src/live-agent/task-finalization.js";
import {
  createLiveAgentTaskExportV1,
  writeLiveAgentTaskExport,
} from "../src/live-agent/task-export.js";
import {
  LIVE_AGENT_TASK_REQUEST_KIND,
  type LiveAgentTaskRequestV1,
} from "../src/live-agent/task-contract.js";
import { registerConfiguredCredential } from "../src/security/configured-credentials.js";

function request(promptText = "Write the product usage page."): LiveAgentTaskRequestV1 {
  return {
    schemaVersion: 1,
    kind: LIVE_AGENT_TASK_REQUEST_KIND,
    taskId: "task-export-1",
    sessionId: "session-export-1",
    prompt: {
      encoding: "utf-8",
      text: promptText,
      sha256: sha256(Buffer.from(promptText, "utf8")),
    },
    baseline: { repositoryRevision: "a".repeat(40), contentSha256: "b".repeat(64) },
    sources: [],
    scope: {
      documentationRoots: ["docs"],
      requestedPaths: ["docs/usage.md"],
      writeClass: "documentation",
    },
    requiredEvidence: ["final-diff"],
    effectiveConfig: {
      profileId: "profile-default",
      modelId: "model-default",
      configurationSha256: "c".repeat(64),
      values: {},
    },
  };
}

function resultFor(task: LiveAgentTaskRequestV1) {
  const completion = finalizeLiveAgentTaskCompletionV1({
    executionStatus: "completed",
    declaration: {
      schemaVersion: 1,
      kind: "docsfab-live-agent-task-declaration",
      decision: "change",
      evidenceIds: [],
    },
    artifacts: [],
    evidence: [
      { evidenceId: "final-diff", kind: "diff", availability: "available", sha256: "d".repeat(64) },
    ],
    checks: [
      { checkId: "diff-present", status: "passed", authority: "host", evidenceIds: ["final-diff"] },
    ],
    diff: { status: "non-empty", sha256: "d".repeat(64) },
    nativeChildRecords: [],
    usage: { status: "unavailable", inputTokens: null, outputTokens: null, totalTokens: null },
    trace: {
      status: "unavailable",
      activitySha256: null,
      childRecordIds: [],
      missing: ["native-trace"],
    },
    limitations: ["Provider usage was unavailable."],
  });
  return bindLiveAgentTaskCompletionV1(task, completion);
}

function interposeWorker(source: string): void {
  fsRaceHooks.workerPrelude = [
    'import fs from "node:fs";',
    'import { syncBuiltinESMExports } from "node:module";',
    source,
    "syncBuiltinESMExports();",
  ].join("\n");
}

function clearWorkerInterposition(): void {
  fsRaceHooks.beforeSpawn = undefined;
  fsRaceHooks.workerPrelude = "";
}

describe("live-agent task export", () => {
  it("writes a private digest-bound export atomically and refuses to overwrite it", async () => {
    const directory = await mkdtemp(join(tmpdir(), "docsfab-task-export-"));
    try {
      const task = request();
      const result = resultFor(task);
      const first = await writeLiveAgentTaskExport(directory, task, result);
      const file = await readFile(first.path, "utf8");
      const parsed = JSON.parse(file) as ReturnType<typeof createLiveAgentTaskExportV1>;
      expect(parsed.exportSha256).toBe(first.exportSha256);
      expect(parsed.requestSha256).toBe(canonicalDigest(parsed.request));
      expect(parsed.result.requestSha256).toBe(parsed.requestSha256);
      expect((await stat(directory)).mode & 0o777).toBe(0o700);
      expect((await stat(first.path)).mode & 0o777).toBe(0o600);

      await expect(writeLiveAgentTaskExport(directory, task, result)).rejects.toMatchObject({
        code: "record-exists",
      });
      expect(await readFile(first.path, "utf8")).toBe(file);

      const tampered = { ...result, requestSha256: "f".repeat(64) };
      expect(() => createLiveAgentTaskExportV1(task, tampered)).toThrow(
        expect.objectContaining({ code: "task-binding-mismatch" }),
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("preserves multibyte UTF-8 when the serialized request spans stdin chunks", async () => {
    const directory = await mkdtemp(join(tmpdir(), "docsfab-task-export-utf8-stream-"));
    try {
      const task = request("€".repeat(30_000));
      const result = resultFor(task);
      const saved = await writeLiveAgentTaskExport(directory, task, result);
      const parsed = JSON.parse(await readFile(saved.path, "utf8")) as ReturnType<
        typeof createLiveAgentTaskExportV1
      >;
      expect(parsed.request.prompt.text).toBe(task.prompt.text);
      expect(parsed.request.prompt.sha256).toBe(task.prompt.sha256);
      expect(parsed.exportSha256).toBe(saved.exportSha256);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("refuses configured credentials instead of redacting or retaining them", () => {
    const secret = `task-export-secret-${randomUUID()}`;
    expect(registerConfiguredCredential(secret, "live-agent-task-export test")).toBe("screened");
    const task = request();
    const result = resultFor(task);
    const credentialTask = request(`Write a page using ${secret}.`);
    let thrown: unknown;
    try {
      createLiveAgentTaskExportV1(credentialTask, result);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({ code: "credential-material" });
  });

  it("rejects a result-directory swap before child startup without writing through the replacement", async () => {
    if (process.platform === "win32") return;
    const parent = await mkdtemp(join(tmpdir(), "docsfab-task-export-root-swap-"));
    const directory = join(parent, "result");
    const displaced = join(parent, "displaced-result");
    const attacker = join(parent, "attacker");
    await mkdir(directory, { mode: 0o700 });
    await mkdir(attacker, { mode: 0o700 });
    fsRaceHooks.beforeSpawn = () => {
      renameSync(directory, displaced);
      symlinkSync(attacker, directory, "dir");
    };
    try {
      await expect(
        writeLiveAgentTaskExport(directory, request(), resultFor(request())),
      ).rejects.toMatchObject({
        code: "write-failed",
      });
      const attackerFiles = await readdir(attacker);
      expect(attackerFiles.some((name) => name.endsWith(".json"))).toBe(false);
      expect(attackerFiles).toEqual([]);
      expect(await readdir(displaced)).toEqual([]);
    } finally {
      clearWorkerInterposition();
      await rm(parent, { recursive: true, force: true });
    }
  });

  it("uses the pinned child working directory after the named root is swapped", async () => {
    if (process.platform === "win32") return;
    const parent = await mkdtemp(join(tmpdir(), "docsfab-task-export-post-cwd-swap-"));
    const directory = join(parent, "result");
    const displaced = join(parent, "displaced-result");
    const attacker = join(parent, "attacker");
    await mkdir(directory, { mode: 0o700 });
    await mkdir(attacker, { mode: 0o700 });
    interposeWorker(`
const originalMkdirSync = fs.mkdirSync;
let swapped = false;
fs.mkdirSync = (...args) => {
  const result = originalMkdirSync(...args);
  if (!swapped) {
    swapped = true;
    fs.renameSync(${JSON.stringify(directory)}, ${JSON.stringify(displaced)});
    fs.symlinkSync(${JSON.stringify(attacker)}, ${JSON.stringify(directory)}, "dir");
  }
  return result;
};`);
    try {
      const task = request();
      await expect(
        writeLiveAgentTaskExport(directory, task, resultFor(task)),
      ).rejects.toMatchObject({ code: "write-failed" });
      expect((await readdir(attacker)).some((name) => name.endsWith(".json"))).toBe(false);
      const published = (await readdir(displaced)).find((name) => name.endsWith(".json"));
      expect(published).toBeDefined();
      const parsed = JSON.parse(await readFile(join(displaced, published!), "utf8")) as ReturnType<
        typeof createLiveAgentTaskExportV1
      >;
      expect(parsed.kind).toBe("docsfab-live-agent-task-export");
    } finally {
      clearWorkerInterposition();
      await rm(parent, { recursive: true, force: true });
    }
  });

  it("cleans the captured temporary inode after an early file-sync failure", async () => {
    const directory = await mkdtemp(join(tmpdir(), "docsfab-task-export-sync-failure-"));
    interposeWorker(`fs.fsyncSync = () => { throw new Error("injected file sync failure"); };`);
    try {
      const task = request();
      await expect(
        writeLiveAgentTaskExport(directory, task, resultFor(task)),
      ).rejects.toMatchObject({ code: "write-failed" });
      expect(await readdir(directory)).toEqual([]);
    } finally {
      clearWorkerInterposition();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("preserves a competing destination replacement observed after link", async () => {
    const directory = await mkdtemp(join(tmpdir(), "docsfab-task-export-destination-swap-"));
    interposeWorker(`
const originalLinkSync = fs.linkSync;
fs.linkSync = (source, destination) => {
  originalLinkSync(source, destination);
  fs.unlinkSync(destination);
  fs.writeFileSync(destination, "another writer\\n", { mode: 0o600 });
};`);
    try {
      const task = request();
      await expect(
        writeLiveAgentTaskExport(directory, task, resultFor(task)),
      ).rejects.toMatchObject({
        code: "write-failed",
      });
      const destination = (await readdir(directory)).find((name) => name.endsWith(".json"));
      expect(destination).toBeDefined();
      expect(await readFile(join(directory, destination!), "utf8")).toBe("another writer\n");
    } finally {
      clearWorkerInterposition();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("leaves a substituted private staging entry untouched after identity mismatch", async () => {
    const directory = await mkdtemp(join(tmpdir(), "docsfab-task-export-stage-swap-"));
    interposeWorker(`
const originalLinkSync = fs.linkSync;
fs.linkSync = (source, destination) => {
  fs.unlinkSync(source);
  fs.writeFileSync(source, "substituted staging bytes\\n", { mode: 0o600 });
  originalLinkSync(source, destination);
};`);
    try {
      const task = request();
      await expect(
        writeLiveAgentTaskExport(directory, task, resultFor(task)),
      ).rejects.toMatchObject({ code: "write-failed" });
      const stage = (await readdir(directory)).find((name) => name.startsWith(".task-export-"));
      expect(stage).toBeDefined();
      expect(
        await readFile(
          join(directory, stage!, (await readdir(join(directory, stage!)))[0]!),
          "utf8",
        ),
      ).toBe("substituted staging bytes\n");
      const destination = (await readdir(directory)).find((name) => name.endsWith(".json"));
      expect(destination).toBeDefined();
      expect(await readFile(join(directory, destination!), "utf8")).toBe(
        "substituted staging bytes\n",
      );
    } finally {
      clearWorkerInterposition();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
