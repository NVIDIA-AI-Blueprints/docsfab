// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { withTaskActivity } from "../src/activity/observer.js";
import { canonicalJson } from "../src/content-ir/canonical.js";
import { mkdir, open, readFile, rm, writeFile, symlink } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  DeliveryWorktreeError,
  LocalUserPublicationPreflightError,
} from "../src/delivery/contracts.js";
import { LocalUserGitLabPublisherError } from "../src/delivery/publisher.js";
import { loadVerifiedPublicationRun } from "../src/delivery/preflight.js";
import type { shipSucceededWrite } from "../src/operator/delivery-orchestrator.js";
import { decodeSavedRunRecord } from "../src/records/saved-run-record.js";
import { FileRunStore } from "../src/records/file-store.js";
import { runRecordMaxBytes } from "../src/records/run-record-limit.js";
import {
  LiveWorkflowDelivery,
  LIVE_DELIVERY_FAILURES,
  livePublicationFailure,
} from "../src/live-agent/workflow-delivery.js";
import type { RunRecord } from "../src/records/contracts.js";
import { createLiveAgentToolDefinitions } from "../src/live-agent/capabilities.js";
import { DocumentationScope } from "../src/live-agent/documentation-scope.js";
import { TaskActivityRecorder } from "../src/live-agent/task-activity.js";
import type { LiveAgentTaskRequestV1 } from "../src/live-agent/task-contract.js";
import {
  ExecFileGitPublisherCommandRunner,
  GitPublisherError,
} from "../src/delivery/git-publisher.js";
import { git, initFixtureRepo } from "./helpers/git.js";
import { temporaryRoots } from "./helpers/temp.js";

const roots = temporaryRoots();

async function fixture() {
  const root = await roots.create("docsfab-live-delivery-");
  const repositoryPath = join(root, "repository");
  const stateDirectory = join(root, "state");
  await mkdir(stateDirectory);
  const revision = await initFixtureRepo(
    repositoryPath,
    { "README.md": "Original documentation.\n" },
    { branch: "main", message: "Fixture base" },
  );
  await writeFile(join(repositoryPath, "README.md"), "Updated documentation.\n");
  const patchBytes = Buffer.from(await git(repositoryPath, ["diff", "--binary"], { trim: false }));
  await writeFile(join(repositoryPath, "README.md"), "Original documentation.\n");
  const artifactPath = join(stateDirectory, "run-1.patch");
  await writeFile(artifactPath, patchBytes, { mode: 0o600 });
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, turns: 0 };
  const toolUsage = { totalCalls: 0, failedCalls: 0, byTool: [] };
  const reference = {
    kind: "ia-plan",
    schemaVersion: 1,
    digest: "a".repeat(64),
    repositoryRevision: revision,
    repositoryContentDigest: "b".repeat(64),
  };
  const artifacts = [{ role: "input", stepId: "apply-site-bootstrap", reference }];
  const record = {
    schemaVersion: 2,
    id: "run-1",
    workflow: "site-bootstrap",
    repository: { sourcePath: repositoryPath, requestedRevision: "HEAD", revision },
    workspace: { strategy: "tracked-export", disposable: true },
    task: { kind: "site-bootstrap", plan: reference },
    status: "succeeded",
    createdAt: "2026-09-09T00:00:00.000Z",
    startedAt: "2026-09-09T00:00:01.000Z",
    completedAt: "2026-09-09T00:00:02.000Z",
    durationMs: 1000,
    models: [],
    skills: [],
    usage,
    tools: toolUsage,
    artifacts,
    securityScan: {
      ruleSet: "credential-rules-v1",
      status: "passed",
      scannedFiles: 1,
      binaryFiles: 0,
      findings: [],
    },
    securityScanEffectiveDisposition: { status: "passed" },
    steps: [
      {
        id: "apply-site-bootstrap",
        title: "Apply approved site bootstrap",
        kind: "host-operation",
        operation: "site-bootstrap",
        skill: "template-scaffold-site",
        mode: "write",
        status: "succeeded",
        startedAt: "2026-09-09T00:00:01.000Z",
        completedAt: "2026-09-09T00:00:02.000Z",
        durationMs: 1000,
        usage,
        tools: toolUsage,
        artifacts,
        summary: "Applied approved site plan.",
        contextPreflight: {
          status: "ready",
          packetDigest: "c".repeat(64),
          consultedNodeIds: ["node-a"],
          ontologyVersion: "ontology-v1",
          effectiveDecisionIds: [],
          measurements: {
            byteLength: 1,
            estimatedTokens: 1,
            latencyMs: 1,
            nodeCount: 1,
            edgeCount: 0,
            pathCount: 1,
          },
          cache: { disposition: "miss", keyDigest: "d".repeat(64), rebuildAttempted: true },
        },
      },
    ],
    changes: {
      files: [{ path: "README.md", status: "modified" }],
      patch: {
        sha256: createHash("sha256").update(patchBytes).digest("hex"),
        byteLength: patchBytes.byteLength,
        lineCount: patchBytes.toString().trimEnd().split("\n").length,
        artifactPath,
        format: "git-diff",
      },
    },
  } as RunRecord;
  await writeFile(join(stateDirectory, "run-1.json"), JSON.stringify(record), { mode: 0o600 });
  const confirmPublication = vi.fn(async () => true);
  const ship = vi.fn<typeof shipSucceededWrite>(async () => ({
    mergeRequest: {
      iid: 1,
      url: "https://gitlab.example.test/team/docs/-/merge_requests/1",
      draft: true,
      headRevision: "a".repeat(40),
    },
  }));
  const options = { repositoryPath, stateDirectory, allowWrite: true, confirmPublication, ship };
  const delivery = new LiveWorkflowDelivery(options);
  return { ...options, root, record, delivery, artifactPath };
}

describe("live workflow checkout persistence", () => {
  it("skips checkout inventory reads without an active child observer", async () => {
    const f = await fixture();
    const observe = vi.spyOn(
      f.delivery as unknown as {
        observedChangeSummary: (...args: unknown[]) => Promise<string | null>;
      },
      "observedChangeSummary",
    );
    expect(await f.delivery.persist(f.record)).toEqual({ status: "applied" });
    expect(observe).not.toHaveBeenCalled();
  });

  it("streams observed checkout bytes without reading the full file into memory", async () => {
    const f = await fixture();
    const content = Buffer.alloc(2 * 1024 * 1024, "a");
    const path = join(f.repositoryPath, "large.md");
    await writeFile(path, content);
    const handle = await open(path, "r");
    const readFileSpy = vi
      .spyOn(Object.getPrototypeOf(handle) as { readFile: typeof handle.readFile }, "readFile")
      .mockRejectedValue(new Error("Full-file reads are not allowed for observed checkout files."));
    await handle.close();
    try {
      const observed = f.delivery as unknown as {
        observedChangeSummary: (files: readonly { path: string }[]) => Promise<string | null>;
      };
      const sha256 = createHash("sha256").update(content).digest("hex");
      const inventory = canonicalJson([{ path: "large.md", sha256 }]);
      expect(await observed.observedChangeSummary([{ path: "large.md" }])).toBe(
        createHash("sha256").update(inventory).digest("hex"),
      );
      expect(readFileSpy).not.toHaveBeenCalled();
    } finally {
      readFileSpy.mockRestore();
    }
  });

  it("binds actual applied patch bytes and the observed checkout inventory", async () => {
    const f = await fixture();
    const prompt = "Update the guide.";
    const request: LiveAgentTaskRequestV1 = {
      schemaVersion: 1,
      kind: "docsfab-live-agent-task-request",
      taskId: "patch-test",
      sessionId: "patch-session",
      prompt: {
        encoding: "utf-8",
        text: prompt,
        sha256: createHash("sha256").update(prompt).digest("hex"),
      },
      baseline: { repositoryRevision: f.record.repository.revision, contentSha256: "a".repeat(64) },
      sources: [],
      scope: {
        documentationRoots: ["README.md"],
        requestedPaths: ["README.md"],
        writeClass: "documentation",
      },
      requiredEvidence: [],
      effectiveConfig: {
        profileId: null,
        modelId: null,
        configurationSha256: "b".repeat(64),
        values: {},
      },
    };
    const recorder = new TaskActivityRecorder(request, {});
    const scope = recorder.openChildScope({
      parentChildScopeId: null,
      parentProducerSessionId: "session-1",
      parentNativeToolCallId: "workflow-call",
      workflow: "site-bootstrap",
    });
    const result = await withTaskActivity(
      { observer: recorder, childScopeId: scope, producerSessionId: null },
      () => f.delivery.persist(f.record),
    );
    expect(result).toEqual({ status: "applied" });
    const rows = recorder
      .seal()
      .bytes.toString("utf8")
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line));
    const patch = rows.filter((row: { eventType?: string }) => row.eventType === "host-patch");
    expect(patch).toHaveLength(2);
    const patchBytes = await readFile(f.artifactPath);
    const changed = await readFile(join(f.repositoryPath, "README.md"));
    const digest = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
    expect(patch[0]).toMatchObject({ phase: "started", patchSha256: digest(patchBytes) });
    expect(patch[1]).toMatchObject({
      phase: "settled",
      status: "applied",
      patchSha256: digest(patchBytes),
      changeSummarySha256: digest(canonicalJson([{ path: "README.md", sha256: digest(changed) }])),
    });
  });

  it("finishes and verifies an already-started patch application after cancellation", async () => {
    const f = await fixture();
    const controller = new AbortController();
    const original = ExecFileGitPublisherCommandRunner.prototype.run;
    const commands: string[][] = [];
    const spy = vi
      .spyOn(ExecFileGitPublisherCommandRunner.prototype, "run")
      .mockImplementation(async function (this: ExecFileGitPublisherCommandRunner, ...args) {
        commands.push([...args[1]]);
        if (args[1].includes("--whitespace=nowarn")) controller.abort();
        return original.apply(this, args);
      });
    try {
      expect(await f.delivery.persist(f.record, controller.signal)).toEqual({ status: "applied" });
      expect(controller.signal.aborted).toBe(true);
      expect(commands.at(-1)).toContain("--reverse");
      expect(commands.at(-1)).toContain("--check");
      expect(await readFile(join(f.repositoryPath, "README.md"), "utf8")).toBe(
        "Updated documentation.\n",
      );
      expect(await readFile(f.artifactPath, "utf8")).toContain("+Updated documentation.");
    } finally {
      spy.mockRestore();
    }
  });

  it("retains the saved patch but does not apply it after cancellation during preparation", async () => {
    const f = await fixture();
    const savedPatch = await readFile(f.artifactPath);
    const controller = new AbortController();
    const delivery = new LiveWorkflowDelivery({
      ...f,
      loadRun: async (path, id) => {
        const run = await loadVerifiedPublicationRun(path, id);
        controller.abort("PRIVATE cancellation reason");
        return run;
      },
    });
    expect(await delivery.persist(f.record, controller.signal)).toEqual({
      status: "failed",
      error: "Workflow cancelled by user.",
    });
    expect(await readFile(join(f.repositoryPath, "README.md"), "utf8")).toBe(
      "Original documentation.\n",
    );
    expect(await readFile(f.artifactPath)).toEqual(savedPatch);
  });
  it("rejects out-of-scope workflow paths before checkout application or publication", async () => {
    const f = await fixture();
    const run = await loadVerifiedPublicationRun(join(f.stateDirectory, "run-1.json"), "run-1");
    const delivery = new LiveWorkflowDelivery({
      ...f,
      documentationScope: new DocumentationScope(),
      loadRun: async () => ({ ...run, changedFiles: [{ path: "src/app.js", status: "modified" }] }),
    });
    expect(await delivery.persist(f.record)).toMatchObject({
      status: "failed",
      error: LIVE_DELIVERY_FAILURES.documentationScope,
    });
    await expect(
      delivery
        .publicationTool()
        .execute("call", { runId: "run-1" }, undefined, undefined, {} as never),
    ).rejects.toThrow(LIVE_DELIVERY_FAILURES.documentationScope);
    expect(f.confirmPublication).not.toHaveBeenCalled();
    expect(f.ship).not.toHaveBeenCalled();
    expect(await readFile(join(f.repositoryPath, "README.md"), "utf8")).toBe(
      "Original documentation.\n",
    );
  });
  it("returns checkout failure separately from workflow success and retains artifact metadata", async () => {
    const f = await fixture();
    await writeFile(join(f.repositoryPath, "README.md"), "Local edits.\n");
    const tool = createLiveAgentToolDefinitions({
      capabilities: {
        skills: [],
        qualityPack: {} as never,
        workflows: [{ name: "update-documentation", title: "Update documentation" }],
      },
      runWorkflow: async () => ({
        ...f.record,
        livePersistence: await f.delivery.persist(f.record),
      }),
    }).find((tool) => tool.name === "docsfab_run_workflow")!;
    const result = await tool.execute(
      "call-1",
      { workflow: "update-documentation", instruction: "Update the docs." },
      undefined,
      undefined,
      {} as never,
    );
    expect(result.details).toMatchObject({
      status: "failed",
      workflowStatus: "succeeded",
      persistence: { status: "failed" },
      changes: { patch: { artifactPath: f.artifactPath } },
    });
    const failureContent = result.content[0];
    expect(failureContent?.type).toBe("text");
    if (failureContent?.type !== "text") throw new Error("Expected text delivery failure.");
    expect(JSON.parse(failureContent.text)).toMatchObject({
      error: LIVE_DELIVERY_FAILURES.conflict,
    });
  });

  it("does not follow a checkout symlink to overwrite an outside file", async () => {
    const f = await fixture();
    const outside = join(f.root, "outside.md");
    await writeFile(outside, "Original documentation.\n");
    await rm(join(f.repositoryPath, "README.md"));
    await symlink(outside, join(f.repositoryPath, "README.md"));
    expect(await f.delivery.persist(f.record)).toMatchObject({ status: "failed" });
    expect(await readFile(outside, "utf8")).toBe("Original documentation.\n");
  });

  it.each(["add", "delete", "rename"])("persists a %s patch", async (operation) => {
    const f = await fixture();
    const run = await loadVerifiedPublicationRun(join(f.stateDirectory, "run-1.json"), "run-1");
    const patches = {
      add: "diff --git a/guide.md b/guide.md\nnew file mode 100644\n--- /dev/null\n+++ b/guide.md\n@@ -0,0 +1 @@\n+New guide.\n",
      delete:
        "diff --git a/README.md b/README.md\ndeleted file mode 100644\n--- a/README.md\n+++ /dev/null\n@@ -1 +0,0 @@\n-Original documentation.\n",
      rename:
        "diff --git a/README.md b/guide.md\nsimilarity index 100%\nrename from README.md\nrename to guide.md\n",
    };
    const changedFiles =
      operation === "add"
        ? [{ path: "guide.md", status: "added" as const }]
        : operation === "delete"
          ? [{ path: "README.md", status: "deleted" as const }]
          : [{ path: "guide.md", previousPath: "README.md", status: "renamed" as const }];
    const delivery = new LiveWorkflowDelivery({
      ...f,
      loadRun: async () => ({
        ...run,
        changedFiles,
        patchBytes: Buffer.from(patches[operation as keyof typeof patches]),
      }),
    });
    expect(await delivery.persist(f.record)).toEqual({ status: "applied" });
    if (operation !== "delete")
      expect(await readFile(join(f.repositoryPath, "guide.md"), "utf8")).toContain(
        operation === "add" ? "New guide" : "Original documentation",
      );
    if (operation !== "add")
      await expect(readFile(join(f.repositoryPath, "README.md"))).rejects.toMatchObject({
        code: "ENOENT",
      });
  });

  it.each(["new file mode 120000", "index aaaaaaa..bbbbbbb 120000", "new file mode 160000"])(
    "rejects symlink or submodule patch modes: %s",
    async (header) => {
      const f = await fixture();
      const run = await loadVerifiedPublicationRun(join(f.stateDirectory, "run-1.json"), "run-1");
      const delivery = new LiveWorkflowDelivery({
        ...f,
        loadRun: async () => ({
          ...run,
          patchBytes: Buffer.from(`diff --git a/README.md b/README.md\n${header}\n`),
        }),
      });
      expect(await delivery.persist(f.record)).toMatchObject({
        error: LIVE_DELIVERY_FAILURES.patch,
      });
    },
  );

  it("loads a real private run and applies its verified patch without staging or committing", async () => {
    const f = await fixture();
    await writeFile(join(f.repositoryPath, "personal.txt"), "Keep my work.\n");
    expect(await f.delivery.persist(f.record)).toEqual({ status: "applied" });
    expect(await readFile(join(f.repositoryPath, "README.md"), "utf8")).toBe(
      "Updated documentation.\n",
    );
    expect(await readFile(join(f.repositoryPath, "personal.txt"), "utf8")).toBe("Keep my work.\n");
    expect(await git(f.repositoryPath, ["diff", "--cached"])).toBe("");
    expect(await git(f.repositoryPath, ["rev-parse", "HEAD"])).toBe(f.record.repository.revision);
    expect(await readFile(f.artifactPath)).not.toHaveLength(0);
    // A new session can verify the same durable run and recognize the applied patch.
    const reloaded = decodeSavedRunRecord(
      JSON.parse(await readFile(join(f.stateDirectory, "run-1.json"), "utf8")),
      "run-1",
    );
    expect(reloaded.checkoutPersistence?.outcome).toBe("applied");
    expect(await new LiveWorkflowDelivery(f).persist(reloaded)).toEqual({
      status: "already-applied",
    });
    expect(
      decodeSavedRunRecord(
        JSON.parse(await readFile(join(f.stateDirectory, "run-1.json"), "utf8")),
        "run-1",
      ).checkoutPersistence?.outcome,
    ).toBe("already-applied");
    expect(f.ship).not.toHaveBeenCalled();
  });

  it("refuses a saved patch substituted after the caller record was checked", async () => {
    const f = await fixture();
    let alternate: RunRecord | undefined;
    const delivery = new LiveWorkflowDelivery({
      ...f,
      beforeMutation: async () => {
        await writeFile(
          join(f.repositoryPath, "README.md"),
          "Different concurrent documentation.\n",
        );
        const patchBytes = Buffer.from(
          await git(f.repositoryPath, ["diff", "--binary"], { trim: false }),
        );
        await writeFile(join(f.repositoryPath, "README.md"), "Original documentation.\n");
        const artifactPath = join(f.stateDirectory, "alternate.patch");
        await writeFile(artifactPath, patchBytes, { mode: 0o600 });
        alternate = {
          ...f.record,
          changes: {
            ...f.record.changes!,
            patch: {
              ...f.record.changes!.patch!,
              artifactPath,
              sha256: createHash("sha256").update(patchBytes).digest("hex"),
              byteLength: patchBytes.byteLength,
              lineCount: patchBytes.toString().trimEnd().split("\n").length,
            },
          },
        };
        const store = new FileRunStore(f.stateDirectory);
        const saved = await store.getWithDigest(f.record.id, {
          maxBytes: runRecordMaxBytes().value,
        });
        await store.replaceIfDigest(
          f.record.id,
          saved.sha256,
          alternate,
          runRecordMaxBytes().value,
        );
      },
    });

    expect(await delivery.persist(f.record)).toEqual({
      status: "failed",
      error: LIVE_DELIVERY_FAILURES.retention,
    });
    expect(await readFile(join(f.repositoryPath, "README.md"), "utf8")).toBe(
      "Original documentation.\n",
    );
    expect(
      decodeSavedRunRecord(
        JSON.parse(await readFile(join(f.stateDirectory, "run-1.json"), "utf8")),
        "run-1",
      ),
    ).toEqual(alternate);
  });

  it("preserves conflicting user edits and the recovery patch", async () => {
    const f = await fixture();
    await writeFile(join(f.repositoryPath, "README.md"), "User changes.\n");
    expect(await f.delivery.persist(f.record)).toEqual({
      status: "failed",
      error: LIVE_DELIVERY_FAILURES.conflict,
    });
    expect(await readFile(join(f.repositoryPath, "README.md"), "utf8")).toBe("User changes.\n");
    expect(await readFile(f.artifactPath)).not.toHaveLength(0);
  });

  it("refuses read-only writes, changed HEAD, tampered artifacts, and foreign repositories", async () => {
    const f = await fixture();
    expect(
      await new LiveWorkflowDelivery({ ...f, allowWrite: false }).persist(f.record),
    ).toMatchObject({ error: LIVE_DELIVERY_FAILURES.write });
    expect(
      await new LiveWorkflowDelivery({ ...f, repositoryPath: f.root }).persist(f.record),
    ).toMatchObject({ error: LIVE_DELIVERY_FAILURES.repository });
    await git(f.repositoryPath, ["commit", "--allow-empty", "-qm", "User commit"]);
    expect(await f.delivery.persist(f.record)).toMatchObject({
      error: LIVE_DELIVERY_FAILURES.repository,
    });
    await writeFile(f.artifactPath, "Tampered patch.");
    // The gate's own code, not the generic patch message.
    expect(await f.delivery.persist(f.record)).toMatchObject({
      error: new LocalUserPublicationPreflightError("patch-mismatch").message,
    });
    expect(await readFile(join(f.repositoryPath, "README.md"), "utf8")).toBe(
      "Original documentation.\n",
    );
  });

  it.each([".git/config", ".env", "docs/private.pem"])(
    "rejects protected paths: %s",
    async (path) => {
      const f = await fixture();
      const run = await loadVerifiedPublicationRun(join(f.stateDirectory, "run-1.json"), "run-1");
      const delivery = new LiveWorkflowDelivery({
        ...f,
        loadRun: async () => ({ ...run, changedFiles: [{ path, status: "added" }] }),
      });
      expect(await delivery.persist(f.record)).toMatchObject({
        error: LIVE_DELIVERY_FAILURES.patch,
      });
    },
  );

  it("does not apply a patch whose actual paths disagree with its record", async () => {
    const f = await fixture();
    const run = await loadVerifiedPublicationRun(join(f.stateDirectory, "run-1.json"), "run-1");
    const delivery = new LiveWorkflowDelivery({
      ...f,
      loadRun: async () => ({ ...run, changedFiles: [{ path: "other.md", status: "modified" }] }),
    });
    expect(await delivery.persist(f.record)).toMatchObject({ error: LIVE_DELIVERY_FAILURES.patch });
  });

  it("applies a live-agent result whose record carries instructionContext (#1233)", async () => {
    const f = await fixture();
    const record = { ...f.record, instructionContext: "MR !1076 diff and reader evidence." };
    await writeFile(join(f.stateDirectory, "run-1.json"), JSON.stringify(record), { mode: 0o600 });
    expect(await f.delivery.persist(record)).toEqual({ status: "applied" });
    expect(await readFile(join(f.repositoryPath, "README.md"), "utf8")).toBe(
      "Updated documentation.\n",
    );
  });

  it("reports the delivery gate's code instead of the generic patch message (#1233)", async () => {
    const f = await fixture();
    const record = { ...f.record, futureWriterField: "not yet admitted" };
    await writeFile(join(f.stateDirectory, "run-1.json"), JSON.stringify(record), { mode: 0o600 });
    const persisted = await f.delivery.persist(record);
    expect(persisted).toEqual({
      status: "failed",
      error: new LocalUserPublicationPreflightError("run-record-contract-gap").message,
    });
    expect(persisted.error).toContain("(run-record-contract-gap)");
    // Rebuilt from the code alone: nothing from the record reaches the message.
    expect(persisted.error).not.toContain("not yet admitted");
    expect(
      decodeSavedRunRecord(
        JSON.parse(await readFile(join(f.stateDirectory, "run-1.json"), "utf8")),
        "run-1",
      ).checkoutPersistence,
    ).toEqual({
      schemaVersion: 1,
      kind: "checkout-persistence",
      outcome: "failed",
      errorCode: "run-record-contract-gap",
    });
    expect(await readFile(join(f.repositoryPath, "README.md"), "utf8")).toBe(
      "Original documentation.\n",
    );
  });

  it("reports failed retention without claiming a durable checkout outcome", async () => {
    const f = await fixture();
    const before = await readFile(join(f.stateDirectory, "run-1.json"));
    const delivery = new LiveWorkflowDelivery({
      ...f,
      allowWrite: false,
      runStore: new FileRunStore(f.stateDirectory, {
        beforeRename: () => {
          throw new Error("PRIVATE write failure");
        },
      }),
    });

    expect(await delivery.persist(f.record)).toEqual({
      status: "failed",
      error: LIVE_DELIVERY_FAILURES.retention,
    });
    expect(await readFile(join(f.stateDirectory, "run-1.json"))).toEqual(before);
    expect(await readFile(join(f.repositoryPath, "README.md"), "utf8")).toBe(
      "Original documentation.\n",
    );
  });

  it("does not persist failed workflows or claim changes when there are none", async () => {
    const f = await fixture();
    const failed = { ...f.record, status: "failed" as const };
    await writeFile(join(f.stateDirectory, "run-1.json"), JSON.stringify(failed), { mode: 0o600 });
    expect(await f.delivery.persist(failed)).toEqual({
      status: "not-needed",
    });
    const noChanges = { ...f.record, changes: { files: [] } } as RunRecord;
    await writeFile(join(f.stateDirectory, "run-1.json"), JSON.stringify(noChanges), {
      mode: 0o600,
    });
    expect(await f.delivery.persist(noChanges)).toEqual({
      status: "not-needed",
    });
  });
});

describe("live workflow draft-MR publication", () => {
  it("publishes the saved run through the existing publisher only after confirmation", async () => {
    const f = await fixture();
    await f.delivery.persist(f.record);
    const result = await f.delivery
      .publicationTool()
      .execute(
        "call-1",
        { runId: "run-1", branch: "docs/update" },
        undefined,
        undefined,
        {} as never,
      );
    expect(f.confirmPublication).toHaveBeenCalledWith(
      expect.stringContaining("not other checkout changes"),
    );
    expect(f.ship).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "run-1",
        repositoryPath: f.repositoryPath,
        dryRun: false,
        proposedSourceBranch: "docs/update",
      }),
      expect.anything(),
    );
    expect(result.details).toMatchObject({
      status: "succeeded",
      runId: "run-1",
      url: expect.stringContaining("merge_requests/1"),
    });
    expect(await readFile(join(f.repositoryPath, "README.md"), "utf8")).toBe(
      "Updated documentation.\n",
    );
  });

  it("cancels without publishing and refuses read-only sessions before confirmation", async () => {
    const f = await fixture();
    f.confirmPublication.mockResolvedValue(false);
    expect(
      (
        await f.delivery
          .publicationTool()
          .execute("call-1", { runId: "run-1" }, undefined, undefined, {} as never)
      ).details,
    ).toMatchObject({ status: "cancelled" });
    expect(f.ship).not.toHaveBeenCalled();
    f.confirmPublication.mockClear();
    await expect(
      new LiveWorkflowDelivery({ ...f, allowWrite: false })
        .publicationTool()
        .execute("call-1", { runId: "run-1" }, undefined, undefined, {} as never),
    ).rejects.toThrow(LIVE_DELIVERY_FAILURES.write);
    expect(f.confirmPublication).not.toHaveBeenCalled();
  });

  it("keeps a specific credential-free failure and retains files on publication failure", async () => {
    const f = await fixture();
    await f.delivery.persist(f.record);
    f.ship.mockRejectedValue(new LocalUserPublicationPreflightError("gitlab-unauthenticated"));
    await expect(
      f.delivery
        .publicationTool()
        .execute("call-1", { runId: "run-1" }, undefined, undefined, {} as never),
    ).rejects.toThrow("Authenticate glab");
    f.ship.mockRejectedValue(new Error("PRIVATE credential payload"));
    await expect(
      f.delivery
        .publicationTool()
        .execute("call-1", { runId: "run-1" }, undefined, undefined, {} as never),
    ).rejects.toThrow(LIVE_DELIVERY_FAILURES.publish);
    expect(await readFile(join(f.repositoryPath, "README.md"), "utf8")).toBe(
      "Updated documentation.\n",
    );
    expect(livePublicationFailure("Git publication failed (PRIVATE). PRIVATE")).toBeUndefined();
  });

  it.each([
    {
      name: "post-push failure with singular retained fields",
      fields: {
        preservedWorktree: "/var/tmp/df-retained-6915255/run-1",
        preservedBranch: "df-retained/update-6915255",
      },
      expected: [
        "Preserved worktree: /var/tmp/df-retained-6915255/run-1",
        "Preserved branch: df-retained/update-6915255",
      ],
    },
    {
      name: "failed persistence with active receipt and plural retained fields",
      fields: {
        failurePersistence: "failed",
        disposition: "active",
        preservedWorktree: "/var/tmp/df-retained-6915255/attempt-2",
        preservedWorktrees: [
          "/var/tmp/df-retained-6915255/attempt-2",
          "/var/tmp/df-retained-6915255/attempt-3",
        ],
      },
      expected: [
        "Preserved worktree: /var/tmp/df-retained-6915255/attempt-2",
        "Preserved worktree: /var/tmp/df-retained-6915255/attempt-3",
      ],
    },
  ])(
    "shows validated retention and deletion preview guidance on $name",
    async ({ fields, expected }) => {
      const f = await fixture();
      await f.delivery.persist(f.record);
      const command =
        "docsfab runs delete run-1 --state-dir /tmp/state --delivery-root /tmp/delivery --receipt-root /tmp/receipts";
      f.ship.mockImplementation(async (_input, options) => {
        options?.log?.(
          JSON.stringify({
            schemaVersion: 1,
            kind: "docsfab-local-user-gitlab-publication-result",
            status: "failed",
            runId: "run-1",
            planSha256: "a".repeat(64),
            ...fields,
            cleanupPreviewCommand: command,
          }),
        );
        throw new Error("private host diagnostic");
      });
      const refusal = await f.delivery
        .publicationTool()
        .execute("call-1", { runId: "run-1" }, undefined, undefined, {} as never)
        .then(
          () => "",
          (error: unknown) => (error instanceof Error ? error.message : String(error)),
        );
      for (const guidance of expected) {
        expect(refusal).toContain(guidance);
        expect(refusal.split(guidance)).toHaveLength(2);
      }
      expect(refusal).toContain(
        `To preview deletion of this run and its preserved delivery state, run: ${command}`,
      );
      expect(refusal).not.toContain("private host diagnostic");
    },
  );

  it("does not expose arbitrary logs or mismatched retention records", async () => {
    const f = await fixture();
    await f.delivery.persist(f.record);
    f.ship.mockImplementation(async (_input, options) => {
      options?.log?.("PRIVATE credential payload");
      options?.log?.(
        JSON.stringify({
          schemaVersion: 1,
          kind: "docsfab-local-user-gitlab-publication-result",
          status: "failed",
          runId: "another-run",
          planSha256: "a".repeat(64),
          preservedWorktree: "/private/path",
          cleanupPreviewCommand: "PRIVATE command",
        }),
      );
      throw new Error("PRIVATE raw error");
    });
    const refusal = await f.delivery
      .publicationTool()
      .execute("call-1", { runId: "run-1" }, undefined, undefined, {} as never)
      .then(
        () => "",
        (error: unknown) => (error instanceof Error ? error.message : String(error)),
      );
    expect(refusal).toBe(LIVE_DELIVERY_FAILURES.publish);
    expect(refusal).not.toContain("PRIVATE");
    expect(refusal).not.toContain("another-run");
  });

  it("tells the chat to push a run base GitLab does not have, not to ship again (#2120)", async () => {
    const f = await fixture();
    await f.delivery.persist(f.record);
    f.ship.mockRejectedValue(
      new LocalUserPublicationPreflightError("run-revision-unpushed", {
        runRevision: "a".repeat(40),
        gitlabTargetRevision: "b".repeat(40),
        gitlabTargetBranch: "main",
      }),
    );
    const refusal = await f.delivery
      .publicationTool()
      .execute("call-1", { runId: "run-1" }, undefined, undefined, {} as never)
      .then(
        () => undefined,
        (error: unknown) => (error instanceof Error ? error.message : String(error)),
      );
    expect(refusal).toBe(
      "Local-user GitLab publication preflight failed (run-revision-unpushed). GitLab does not have the run base commit; it was never pushed. Push that commit to the target branch, then republish a preserved write with `docsfab ship <run-id> --repo <path>`; or start a new run from a commit that is already on the target branch.",
    );
    expect(refusal).not.toContain("Republish a preserved write with");
    expect(await readFile(join(f.repositoryPath, "README.md"), "utf8")).toBe(
      "Updated documentation.\n",
    );
  });

  it("rejects malformed run IDs and branch names before prompting or publishing", async () => {
    const f = await fixture();
    for (const args of [null, { runId: "../../private" }, { runId: "run-1", branch: "--force" }]) {
      await expect(
        f.delivery.publicationTool().execute("call-1", args, undefined, undefined, {} as never),
      ).rejects.toThrow(LIVE_DELIVERY_FAILURES.patch);
    }
    expect(f.confirmPublication).not.toHaveBeenCalled();
    expect(f.ship).not.toHaveBeenCalled();
  });

  it.each([
    new DeliveryWorktreeError("patch-application-failed"),
    new DeliveryWorktreeError("source-state-changed"),
    new LocalUserGitLabPublisherError("push-failed"),
    new LocalUserGitLabPublisherError("merge-request-open-failed"),
    new LocalUserGitLabPublisherError("git-identity-drift"),
    new LocalUserGitLabPublisherError("git-configuration-refused"),
    // A refused Git setting keeps its content-free message in the live agent (#2363).
    new GitPublisherError("refused-configuration"),
  ])("preserves a typed delivery failure without private details: $code", async (failure) => {
    const f = await fixture();
    const safeMessage = failure.message;
    failure.message += " PRIVATE credential payload";
    f.ship.mockRejectedValue(failure);
    await expect(
      f.delivery
        .publicationTool()
        .execute("call-1", { runId: "run-1" }, undefined, undefined, {} as never),
    ).rejects.toThrow(safeMessage);
    expect(livePublicationFailure(failure)).toBe(safeMessage);
    expect(
      livePublicationFailure(new LocalUserGitLabPublisherError("private-value" as never)),
    ).toBeUndefined();
  });
});
