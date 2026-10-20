// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFile } from "node:child_process";
import { chmod, copyFile, lstat, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  createKnowledgeAcceptedSnapshot,
  importFoundationCanonFromKnowledgeSnapshot,
  type KnowledgeAcceptedSnapshotBodyV1,
} from "../src/canon/from-knowledge-snapshot.js";
import type { DocsFabConfig } from "../src/config/runtime-loader.js";
import {
  bindFirstPassKnowledge,
  FIRST_PASS_KNOWLEDGE_SNAPSHOT_PATH,
} from "../src/cli/first-pass.js";
import {
  documentationPartialAnswerIsStale,
  instructionSha256,
  originalRequestCompletionAfterPartialAnswer,
  ORIGINAL_TASK_PATH,
  type OriginalTaskBindingV1,
} from "../src/cli/knowledge-resume.js";
import { assembleHostOperations } from "../src/cli/run/host-operations.js";
import type { CliRunInvocation, RunRequestWithPublishProjection } from "../src/cli/run/request.js";
import type { RepositoryEvidenceCollector } from "../src/repository/contracts.js";
import type { RepositoryWorkspace } from "../src/repository/workspace/contracts.js";
import { getWorkflow } from "../src/workflow-registry/catalog.js";
import { temporaryRoots } from "./helpers/temp.js";

const executeFile = promisify(execFile);
const runtimeRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(runtimeRoot, "../..");
const fixtureRoot = join(runtimeRoot, "test", "fixtures", "knowledge-resume-loop");
const knowledgeCli = join(repositoryRoot, "packages", "knowledge", "src", "cli.mjs");
const revision = "f".repeat(40);
const authorityId = "operator-test";
const behaviorStatement = "The widget --version command prints the installed version.";
const instruction = [
  "Write `docs/get-started.md` using only these repository-observed behavior claims:",
  `- ${behaviorStatement}`,
].join("\n");
const temporary = temporaryRoots();

describe("retained knowledge resume loop", () => {
  it.each(["create-documentation", "update-documentation"] as const)(
    "continues the original %s Task through attributed candidate import",
    async (workflow) => {
      const setup = await createRetainedWorkspace(workflow, unresolvedSnapshot(), false);
      const priorPath = join(setup.workspacePath, FIRST_PASS_KNOWLEDGE_SNAPSHOT_PATH);
      await writeFile(priorPath, await readFile(setup.snapshotPath));
      const priorBytes = await readFile(priorPath, "utf8");

      await expect(
        bindFirstPassKnowledge({
          request: request({ workflow }),
          config: setup.config,
          workspacePath: setup.workspacePath,
          revision,
          status: () => undefined,
        }),
      ).rejects.toMatchObject({ name: "KnowledgeResumeError", code: "conflict" });

      const originalPath = join(setup.workspacePath, ORIGINAL_TASK_PATH);
      const originalBytes = await readFile(originalPath, "utf8");
      const answeredPath = join(setup.root, "answered-snapshot.json");
      await executeFile(process.execPath, [
        knowledgeCli,
        "apply-answer",
        "--snapshot",
        priorPath,
        "--answer",
        join(fixtureRoot, "attributed-answer.json"),
        "--output",
        answeredPath,
      ]);

      const answeredBytes = await readFile(answeredPath, "utf8");
      const answered = JSON.parse(answeredBytes) as { status: string; snapshotSha256: string };
      expect(answered.status).toBe("candidate");
      const expectedCanon = importFoundationCanonFromKnowledgeSnapshot(answered, {
        authorityId,
      }).canonSha256;
      const assembly = await assemble(setup, {
        workflow,
        canonSnapshotPath: answeredPath,
        acceptCandidateSnapshot: true,
        canonSnapshotAuthorityId: authorityId,
      });

      expect(assembly.task).toEqual({ kind: workflow, canonSha256: expectedCanon });
      expect(answered.snapshotSha256).not.toBe(
        (JSON.parse(priorBytes) as { snapshotSha256: string }).snapshotSha256,
      );
      expect(await readFile(priorPath, "utf8")).toBe(priorBytes);
      expect(await readFile(originalPath, "utf8")).toBe(originalBytes);
      expect(JSON.parse(originalBytes)).toEqual(originalBinding(workflow));
    },
  );

  it.each([
    {
      name: "stored workflow",
      binding: originalBinding("update-documentation"),
      expectedMessage: "original update-documentation Task",
    },
    {
      name: "stored instruction",
      binding: { ...originalBinding("create-documentation"), instructionSha256: "a".repeat(64) },
      expectedMessage: "original instruction",
    },
    {
      name: "malformed JSON",
      bytes: "{not-json\n",
      expectedMessage: "contains malformed JSON data",
    },
    {
      name: "wrong schema",
      bytes: JSON.stringify({ ...originalBinding("create-documentation"), schemaVersion: 2 }),
      expectedMessage: "binding is not v1",
    },
    {
      name: "invalid digest",
      bytes: JSON.stringify({
        ...originalBinding("create-documentation"),
        instructionSha256: "bad",
      }),
      expectedMessage: "instruction digest is invalid",
    },
  ])("rejects a present $name binding through real host assembly", async (testCase) => {
    const setup = await createRetainedWorkspace("create-documentation", supportedSnapshot());
    const originalPath = join(setup.workspacePath, ORIGINAL_TASK_PATH);
    const bytes = testCase.bytes ?? `${JSON.stringify(testCase.binding, null, 2)}\n`;
    await writeFile(originalPath, bytes);

    await expect(assemble(setup)).rejects.toMatchObject({
      name: "KnowledgeResumeError",
      code: "intent-mismatch",
      message: expect.stringContaining(testCase.expectedMessage),
    });
    expect(await readFile(originalPath, "utf8")).toBe(bytes);
  });

  it.each(["dangling binding", "external binding", "symlinked reference parent"])(
    "rejects a %s without reading or overwriting its target",
    async (variant) => {
      const setup = await createRetainedWorkspace("create-documentation", supportedSnapshot());
      const originalPath = join(setup.workspacePath, ORIGINAL_TASK_PATH);
      const outside = join(setup.root, "outside-original-task.json");
      const secret = "outside-private-content-must-not-appear";
      await writeFile(outside, secret);
      await rm(originalPath);
      if (variant === "dangling binding") {
        await symlink(join(setup.root, "missing-binding.json"), originalPath);
      } else if (variant === "external binding") {
        await symlink(outside, originalPath);
      } else {
        const referenceDirectory = dirname(originalPath);
        await rm(referenceDirectory, { recursive: true });
        const outsideDirectory = join(setup.root, "outside-reference-model");
        await mkdir(outsideDirectory);
        await writeFile(join(outsideDirectory, "original-task.json"), secret);
        await symlink(outsideDirectory, referenceDirectory);
      }

      let thrown: unknown;
      try {
        await assemble(setup);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toMatchObject({ name: "KnowledgeResumeError", code: "intent-mismatch" });
      expect(String((thrown as Error).message)).not.toContain(secret);
      expect(await readFile(outside, "utf8")).toBe(secret);
      expect((await lstat(originalPath)).isSymbolicLink()).toBe(
        variant !== "symlinked reference parent",
      );
    },
  );

  it("rejects a symlinked .docsfab parent before following an external binding", async () => {
    const setup = await createRetainedWorkspace("create-documentation", supportedSnapshot());
    const docsfabPath = join(setup.workspacePath, ".docsfab");
    const outside = join(setup.root, "outside-docsfab");
    const secret = "external-parent-private-content";
    await rm(docsfabPath, { recursive: true });
    await mkdir(join(outside, "reference-model"), { recursive: true });
    await writeFile(join(outside, "reference-model", "original-task.json"), secret);
    await symlink(outside, docsfabPath);

    await expect(assemble(setup)).rejects.toMatchObject({
      name: "KnowledgeResumeError",
      code: "intent-mismatch",
      message: expect.not.stringContaining(secret),
    });
    expect(await readFile(join(outside, "reference-model", "original-task.json"), "utf8")).toBe(
      secret,
    );
  });

  it.each(["directory", "unreadable"])(
    "rejects a present %s binding instead of treating it as absent",
    async (variant) => {
      const setup = await createRetainedWorkspace("create-documentation", supportedSnapshot());
      const originalPath = join(setup.workspacePath, ORIGINAL_TASK_PATH);
      if (variant === "directory") {
        await rm(originalPath);
        await mkdir(originalPath);
      } else {
        await chmod(originalPath, 0o000);
      }
      await expect(assemble(setup)).rejects.toMatchObject({
        name: "KnowledgeResumeError",
        code: "intent-mismatch",
      });
      if (variant === "unreadable") await chmod(originalPath, 0o600);
    },
  );

  it.each(["approved", "canonical", "candidate"] as const)(
    "preserves a fresh explicit %s snapshot import when no original binding exists",
    async (status) => {
      const snapshot = createKnowledgeAcceptedSnapshot({ ...supportedSnapshotBody(), status });
      const setup = await createRetainedWorkspace("create-documentation", snapshot, false);
      const assembly = await assemble(setup, {
        ...(status === "candidate"
          ? { acceptCandidateSnapshot: true, canonSnapshotAuthorityId: authorityId }
          : {}),
      });
      expect(assembly.task?.kind).toBe("create-documentation");
      await expect(lstat(join(setup.workspacePath, ORIGINAL_TASK_PATH))).rejects.toMatchObject({
        code: "ENOENT",
      });
    },
  );

  it("stale-answer invalidates affected evidence and preserves still-valid content", () => {
    const current = {
      assessmentIdentitySha256: "a".repeat(64),
      repositoryRevision: revision,
      snapshotSha256: "b".repeat(64),
    };
    expect(
      documentationPartialAnswerIsStale(current, {
        ...current,
        snapshotSha256: "c".repeat(64),
      }),
    ).toBe(true);
    expect(documentationPartialAnswerIsStale(current, current)).toBe(false);
    expect(originalRequestCompletionAfterPartialAnswer(["decomposed-macos"])).toBe("incomplete");
  });

  it("current-answer resolves only relevant gaps and completes only when every original obligation is supported", () => {
    expect(
      documentationPartialAnswerIsStale(
        {
          assessmentIdentitySha256: "a".repeat(64),
          repositoryRevision: revision,
          planBindingSha256: "d".repeat(64),
        },
        {
          assessmentIdentitySha256: "a".repeat(64),
          repositoryRevision: revision,
          planBindingSha256: "d".repeat(64),
        },
      ),
    ).toBe(false);
    expect(originalRequestCompletionAfterPartialAnswer([])).toBe("complete");
    expect(originalRequestCompletionAfterPartialAnswer(["host-page-support"])).toBe("incomplete");
  });
});

interface Setup {
  root: string;
  workspacePath: string;
  snapshotPath: string;
  config: DocsFabConfig;
}

async function createRetainedWorkspace(
  workflow: "create-documentation" | "update-documentation",
  snapshot: ReturnType<typeof createKnowledgeAcceptedSnapshot>,
  retainOriginal = true,
): Promise<Setup> {
  const root = await temporary.create("docsfab-knowledge-resume-loop-");
  const workspacePath = join(root, "workspace");
  const snapshotPath = join(root, "explicit-candidate.json");
  const stateDirectory = join(root, "state", "runs");
  await mkdir(join(workspacePath, ".docsfab", "reference-model"), { recursive: true });
  await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
  await copyFile(join(fixtureRoot, "repository", "README.md"), join(workspacePath, "README.md"));
  await writeFile(snapshotPath, `${JSON.stringify(snapshot, null, 2)}\n`);
  if (retainOriginal) {
    await writeFile(
      join(workspacePath, ORIGINAL_TASK_PATH),
      `${JSON.stringify(originalBinding(workflow), null, 2)}\n`,
    );
  }
  return { root, workspacePath, snapshotPath, config: stubConfig(stateDirectory) };
}

async function assemble(setup: Setup, overrides: Partial<RunRequestWithPublishProjection> = {}) {
  const nextRequest = request({ canonSnapshotPath: setup.snapshotPath, ...overrides });
  const workspace: RepositoryWorkspace = {
    path: setup.workspacePath,
    sourcePath: setup.workspacePath,
    requestedRevision: "HEAD",
    revision,
    dispose: async () => undefined,
  };
  const invocation: CliRunInvocation = {
    request: nextRequest,
    config: setup.config,
    options: {},
    output: { log: () => undefined, error: () => undefined },
  };
  return assembleHostOperations(invocation, workspace, {} as RepositoryEvidenceCollector, {
    workflow: getWorkflow(nextRequest.workflow),
  });
}

function request(
  overrides: Partial<RunRequestWithPublishProjection> = {},
): RunRequestWithPublishProjection {
  return {
    workflow: "create-documentation",
    repositoryPath: "/tmp/repo",
    revision: "HEAD",
    instruction,
    allowWrite: true,
    releaseGate: false,
    verbose: false,
    json: false,
    showScan: false,
    ...overrides,
  };
}

function originalBinding(
  workflow: "create-documentation" | "update-documentation",
): OriginalTaskBindingV1 {
  return {
    schemaVersion: 1,
    kind: "docsfab-original-task",
    workflow,
    instructionSha256: instructionSha256(instruction),
  };
}

function unresolvedSnapshot() {
  return createKnowledgeAcceptedSnapshot({
    ...supportedSnapshotBody(),
    claims: [
      ...supportedSnapshotBody().claims,
      {
        id: "CL-INTENT-1",
        kind: "intent",
        scope: "Widget audience",
        statement: "The widget is built for operators.",
        modelState: "disputed",
        evidenceIds: ["SRC-README"],
      },
      {
        id: "CL-INTENT-2",
        kind: "intent",
        scope: "Widget audience",
        statement: "The widget is built for developers.",
        modelState: "disputed",
        evidenceIds: ["SRC-README"],
      },
    ],
    conflicts: [{ id: "CF-INTENT", claimIds: ["CL-INTENT-1", "CL-INTENT-2"] }],
  });
}

function supportedSnapshot() {
  return createKnowledgeAcceptedSnapshot(supportedSnapshotBody());
}

function supportedSnapshotBody(): KnowledgeAcceptedSnapshotBodyV1 {
  return {
    projectId: "PRJ-001",
    modelVersionId: "MODEL-001",
    streamVersion: 4,
    status: "candidate",
    claims: [
      {
        id: "CL-BEHAVIOR",
        kind: "behavior",
        scope: "Widget CLI",
        statement: behaviorStatement,
        modelState: "candidate",
        evidenceIds: ["SRC-README"],
      },
    ],
    sources: [{ id: "SRC-README", locator: "readme:README.md" }],
    conflicts: [],
  };
}

function stubConfig(stateDirectory: string): DocsFabConfig {
  return {
    projectRoot: runtimeRoot,
    skillCrateDirectory: join(runtimeRoot, "skill-crate"),
    qualityDirectory: join(runtimeRoot, "..", "quality"),
    qualityPackDirectory: join(runtimeRoot, "quality-pack"),
    stateDirectory,
    retryPolicy: {
      maxRetries: 0,
      baseDelayMs: 0,
      maxDelayMs: 0,
      retryableCategories: [],
    },
    model: { provider: "none", model: "none" },
  } as unknown as DocsFabConfig;
}
