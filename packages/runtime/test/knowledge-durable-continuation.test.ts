// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import {
  access,
  chmod,
  cp,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { describe, expect, it, vi } from "vitest";

import { nestedDeadlineMs, testTimeoutMs } from "./helpers/test-timeouts.js";
import { limit } from "../src/config/limits.js";

import { DurableArtifactStore } from "../src/artifacts/store.js";
import { FIRST_PASS_KNOWLEDGE_SNAPSHOT_PATH } from "../src/cli/first-pass.js";
import {
  continuationRequestedPageIntent,
  inspectRequestedPageSupport,
  ORIGINAL_TASK_PATH,
} from "../src/cli/knowledge-resume.js";
import {
  decodeKnowledgeContinuationPrivateTask,
  decodeKnowledgeContinuationReceipt,
  decodeKnowledgeContinuationRetainedBytes,
  decodeKnowledgeContinuationStoppedRun,
} from "../src/records/knowledge-continuation.js";
import {
  classifyRunResumability,
  projectRunContinuationCommand,
} from "../src/operator/run-resumability.js";
import { decodeSuccessfulPublicationRunRecord } from "../src/delivery/run-record.js";
import { reportKnowledgeContinuationStop } from "../src/cli/run/knowledge-continuation.js";
import { buildRunHumanNextCommand } from "../src/operator/run-summary.js";
import { canonicalDigest } from "../src/contract-kit/index.js";
import {
  decodeKnowledgeAcceptedSnapshot,
  type KnowledgeAcceptedSnapshotBodyV1,
  type KnowledgeAcceptedSnapshotV1,
} from "../src/canon/from-knowledge-snapshot.js";
import { temporaryRoots } from "./helpers/temp.js";
import { commitFixture, git, initFixtureRepo } from "./helpers/git.js";

const exec = promisify(execFile);
const runtimeRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const child = join(runtimeRoot, "test/fixtures/knowledge-continuation/journey-child.ts");
const knowledgePackageRoot = resolve(runtimeRoot, "../knowledge");
const knowledgeRoot = join(knowledgePackageRoot, "tests/fixtures/knowledge-continuation");
const knowledgeCli = join(knowledgePackageRoot, "src/cli.mjs");
const tsx = join(runtimeRoot, "node_modules/.bin/tsx");
const temporary = temporaryRoots();

describe("durable direct-CLI knowledge continuation", () => {
  vi.setConfig({ testTimeout: testTimeoutMs(120_000) });

  it.each(["create-documentation"] as const)(
    "survives disposable workspace loss and resumes the exact %s task in another process",
    async (workflow) => {
      const root = await temporary.create("docsfab-knowledge-continuation-");
      const repository = join(root, "repository");
      const stateDirectory = join(root, "state", "runs");
      const targetPath = "docs/behavior.md";
      await mkdir(join(repository, "docs"), { recursive: true });
      await writeFile(join(repository, "README.md"), "# Continuation fixture\n");
      await writeFile(
        join(repository, ".docsfab.json"),
        `${JSON.stringify(
          {
            schemaVersion: 1,
            gitlab: { remote: "origin", defaultBranch: "main" },
            provider: { configuration: "host" },
            storage: { scope: "user-private" },
          },
          null,
          2,
        )}\n`,
      );
      if (workflow === "update-documentation") {
        await writeFile(join(repository, targetPath), "# Old purpose\n");
      }
      await commitPrivateFixture(repository);

      const environment = {
        ...process.env,
        DOCSFAB_FIXTURE_REPOSITORY: repository,
        DOCSFAB_FIXTURE_STATE: stateDirectory,
        DOCSFAB_FIXTURE_WORKFLOW: workflow,
        DOCSFAB_FIXTURE_TARGET: targetPath,
        DOCSFAB_KNOWLEDGE_DIR: knowledgeRoot,
        DOCSFAB_OPERATOR_AUTHORITY_ID: "fixture-cli-operator",
        DOCSFAB_FIXTURE_DEFAULT_CONFIG: "1",
      };
      const stopped = JSON.parse(
        (await exec(tsx, [child, "stop"], { cwd: runtimeRoot, env: environment })).stdout,
      ) as Record<string, any>;
      expect(stopped).toMatchObject({
        workflow,
        status: "needs-input",
        error: "unresolved-claim",
        workspace: { disposable: true },
        steps: [],
      });
      expect(stopped.instruction).toBeUndefined();
      const stoppedPath = join(stateDirectory, `${stopped.id}.json`);
      const stoppedBytes = await readFile(stoppedPath, "utf8");
      const receipt = decodeKnowledgeContinuationReceipt(stopped.knowledgeContinuationReceipt);
      expect(() => decodeKnowledgeContinuationStoppedRun(stopped)).not.toThrow();
      expect(
        decodeKnowledgeContinuationStoppedRun({
          ...stopped,
          evidenceWarnings: ["first-pass-snapshot-superseded: fixture digest"],
        }).evidenceWarnings,
      ).toEqual(["first-pass-snapshot-superseded: fixture digest"]);
      for (const warnings of [[""], ["bad\nline"], ["same", "same"], [1]]) {
        expect(() =>
          decodeKnowledgeContinuationStoppedRun({ ...stopped, evidenceWarnings: warnings }),
        ).toThrow(/invalid-value/u);
      }
      expect(() => decodeKnowledgeContinuationStoppedRun({ ...stopped, unknown: true })).toThrow(
        /invalid-shape/u,
      );
      const { receiptSha256: _receiptSha256, ...receiptBody } = receipt;
      const reboundReceiptBody = {
        ...receiptBody,
        workflow:
          workflow === "create-documentation"
            ? ("update-documentation" as const)
            : ("create-documentation" as const),
      };
      expect(() =>
        decodeKnowledgeContinuationStoppedRun({
          ...stopped,
          knowledgeContinuationReceipt: {
            ...reboundReceiptBody,
            receiptSha256: canonicalDigest(reboundReceiptBody),
          },
        }),
      ).toThrow(/binding-mismatch/u);
      expect(() =>
        decodeKnowledgeContinuationStoppedRun({
          ...stopped,
          taskLineage: { ...stopped.taskLineage, repositoryRevision: "f".repeat(40) },
        }),
      ).toThrow(/digest-mismatch|binding-mismatch/u);
      const artifactStore = new DurableArtifactStore(join(root, "state", "artifacts"));
      const retainedTask = (await artifactStore.getRecord(
        receipt.originalTaskArtifactSha256,
      )) as Record<string, unknown>;
      expect(retainedTask.instruction).toContain("cafe\u0301");
      const originalOrigin = await artifactStore.getRecord(receipt.originArtifactSha256);
      const originalLineage = await artifactStore.getRecord(receipt.lineageArtifactSha256);
      const retained = decodeKnowledgeContinuationRetainedBytes(
        await artifactStore.getRecord(receipt.candidateArtifactSha256),
      );
      const prior = JSON.parse(retained.text) as {
        claims: Array<{ id: string; modelState: string }>;
      };
      expect(prior.claims.some((claim) => claim.modelState === "unresolved")).toBe(true);

      const answer = await applyKnowledgeAnswer(root, retained.text, {
        schemaVersion: 1,
        kind: "knowledge-attributed-answer",
        actor: "fixture-product-owner",
        authority: "product-decision-owner",
        token: prior.claims.find((claim) => claim.modelState === "unresolved")!.id,
        statement: "This fixture documents the product purpose for its readers.",
      });
      expect(answer.priorSnapshotSha256).toBe(receipt.candidateSnapshotSha256);
      const snapshotPath = answer.snapshotPath;

      const resumeEnvironment = {
        ...environment,
        DOCSFAB_FIXTURE_STOPPED_RUN: stopped.id,
        DOCSFAB_FIXTURE_SNAPSHOT: snapshotPath,
        ...(workflow === "create-documentation"
          ? {
              DOCSFAB_FIXTURE_INSTRUCTION:
                `Write \`${targetPath}\` using only these repository-observed behavior claims:\n` +
                "- The fixture publishes one verified café behavior page.",
            }
          : {}),
      };
      if (workflow === "create-documentation") {
        await expectExitOne(
          tsx,
          [child, "resume"],
          runtimeRoot,
          {
            ...resumeEnvironment,
            DOCSFAB_FIXTURE_INSTRUCTION: "Write `docs/other.md` using invented intent.",
          },
          /binding-mismatch/u,
        );
        await expectExitOne(
          tsx,
          [child, "resume"],
          runtimeRoot,
          {
            ...resumeEnvironment,
            DOCSFAB_FIXTURE_WORKFLOW: "update-documentation",
          },
          /binding-mismatch/u,
        );
        const otherRepository = join(root, "other-repository");
        await git(root, ["clone", "--quiet", repository, otherRepository]);
        await expectExitOne(
          tsx,
          [child, "resume"],
          runtimeRoot,
          {
            ...resumeEnvironment,
            DOCSFAB_FIXTURE_REPOSITORY: otherRepository,
          },
          /binding-mismatch/u,
        );

        await writeFile(join(repository, "README.md"), "# Newer source revision\n");
        await git(repository, ["add", "README.md"]);
        await git(repository, ["commit", "-q", "-m", "newer revision"]);
        await expectExitOne(
          tsx,
          [child, "resume"],
          runtimeRoot,
          {
            ...resumeEnvironment,
            DOCSFAB_FIXTURE_REVISION: "HEAD",
          },
          /binding-mismatch/u,
        );
        await expectExitOne(
          tsx,
          [child, "resume"],
          runtimeRoot,
          {
            ...resumeEnvironment,
            DOCSFAB_FIXTURE_SERIALIZED_LINEAGE: "1",
          },
          /lineage|authority|capability|rejected/u,
        );
        await expectExitOne(
          tsx,
          [child, "resume"],
          runtimeRoot,
          {
            ...resumeEnvironment,
            DOCSFAB_OPERATOR_AUTHORITY_ID: "substituted-cli-operator",
          },
          /binding-mismatch/u,
        );

        const artifactPath = join(
          root,
          "state",
          "artifacts",
          "objects",
          "sha256",
          `${receipt.originalTaskArtifactSha256}.json`,
        );
        const artifactBytes = await readFile(artifactPath, "utf8");
        await rm(artifactPath);
        await expectExitOne(
          tsx,
          [child, "resume"],
          runtimeRoot,
          resumeEnvironment,
          /artifact-missing/u,
        );
        await writeFile(artifactPath, artifactBytes, { mode: 0o600 });
        await chmod(artifactPath, 0o640);
        await expectExitOne(
          tsx,
          [child, "resume"],
          runtimeRoot,
          resumeEnvironment,
          /artifact-missing/u,
        );
        await chmod(artifactPath, 0o600);

        const originalStopped = JSON.parse(stoppedBytes) as Record<string, any>;
        await writeFile(
          stoppedPath,
          `${JSON.stringify({
            ...originalStopped,
            knowledgeContinuationReceipt: {
              ...originalStopped.knowledgeContinuationReceipt,
              candidateSnapshotSha256: "f".repeat(64),
            },
          })}\n`,
          { mode: 0o600 },
        );
        await expectExitOne(
          tsx,
          [child, "resume"],
          runtimeRoot,
          resumeEnvironment,
          /digest-mismatch/u,
        );
        await writeFile(stoppedPath, stoppedBytes, { mode: 0o600 });

        const artifact = JSON.parse(artifactBytes) as Record<string, any>;
        await writeFile(
          artifactPath,
          `${JSON.stringify({ ...artifact, instruction: `${artifact.instruction} substituted` })}\n`,
          { mode: 0o600 },
        );
        await expectExitOne(
          tsx,
          [child, "resume"],
          runtimeRoot,
          resumeEnvironment,
          /artifact-missing|binding-mismatch|digest-mismatch/u,
        );
        await writeFile(artifactPath, artifactBytes, { mode: 0o600 });
      }

      const resumed = JSON.parse(
        (
          await exec(tsx, [child, "resume"], {
            cwd: runtimeRoot,
            env: {
              ...resumeEnvironment,
            },
          })
        ).stdout,
      ) as Record<string, any>;
      expect(resumed).toMatchObject({
        workflow,
        status: "succeeded",
        repository: { revision: stopped.repository.revision },
        taskLineage: { projectionSha256: stopped.taskLineage.projectionSha256 },
        knowledgeContinuationReceipt: { receiptSha256: receipt.receiptSha256 },
        knowledgeContinuationRecoveryAuthorization: {
          kind: "docsfab-task-lineage-recovery-authorization",
        },
      });
      expect(resumed.id).not.toBe(stopped.id);
      decodeSuccessfulPublicationRunRecord(resumed);
      expect(resumed.knowledgeContinuationRecoveryAuthorization).toMatchObject({
        originalOriginSha256: (originalOrigin as Record<string, unknown>).originSha256,
        originalLineageSha256: (originalLineage as Record<string, unknown>).lineageSha256,
      });
      expect(await artifactStore.getRecord(receipt.originArtifactSha256)).toEqual(originalOrigin);
      expect(await artifactStore.getRecord(receipt.lineageArtifactSha256)).toEqual(originalLineage);
      expect(await readFile(stoppedPath, "utf8")).toBe(stoppedBytes);
      expect((await stat(stoppedPath)).mode & 0o777).toBe(0o600);
      expect(await git(repository, ["status", "--short"])).toBe("");
      const patch = await readFile(resumed.changes.patch.artifactPath, "utf8");
      expect(patch).toContain(targetPath);
      const historyNames = (await import("node:fs/promises")).readdir(
        join(root, "state", "knowledge-continuations"),
      );
      const settledHistory = await historyNames;
      expect(settledHistory.length).toBeGreaterThanOrEqual(3);

      const replay = JSON.parse(
        (
          await exec(tsx, [child, "resume"], {
            cwd: runtimeRoot,
            env: {
              ...environment,
              DOCSFAB_FIXTURE_STOPPED_RUN: stopped.id,
              DOCSFAB_FIXTURE_SNAPSHOT: snapshotPath,
              DOCSFAB_FIXTURE_OUTPUT: "json",
            },
          })
        ).stdout,
      ) as Record<string, any>;
      expect(replay).toMatchObject({
        kind: "docsfab-run-result",
        execution: { runId: resumed.id, status: "succeeded", exitCode: 0 },
      });
      expect(replay.nextSteps.join("\n")).toContain("already completed");
      expect(await historyNames).toEqual(settledHistory);
    },
    testTimeoutMs(120_000),
  );

  it("resumes a stopped task on a preset selected with --composition (R12)", {
    timeout: testTimeoutMs(120_000),
  }, async () => {
    const compositionId = "nvidia-inference-claude-sonnet-5-pi";
    const root = await temporary.create("docsfab-knowledge-continuation-preset-");
    const repository = join(root, "repository");
    const configurationRoot = join(root, "configuration");
    const targetPath = "docs/behavior.md";
    await mkdir(join(repository, "docs"), { recursive: true });
    await mkdir(configurationRoot, { recursive: true, mode: 0o700 });
    await writeFile(join(repository, "README.md"), "# Continuation fixture\n");
    await commitPrivateFixture(repository);
    const environment = {
      ...process.env,
      DOCSFAB_CONFIG_ROOT: configurationRoot,
      DOCSFAB_FIXTURE_REPOSITORY: repository,
      DOCSFAB_FIXTURE_STATE: join(root, "state", "runs"),
      DOCSFAB_FIXTURE_WORKFLOW: "create-documentation",
      DOCSFAB_FIXTURE_TARGET: targetPath,
      DOCSFAB_FIXTURE_COMPOSITION: compositionId,
      DOCSFAB_FIXTURE_SET: "maxOutputTokens=12000",
      DOCSFAB_KNOWLEDGE_DIR: knowledgeRoot,
      DOCSFAB_OPERATOR_AUTHORITY_ID: "fixture-cli-operator",
      DOCSFAB_FIXTURE_DEFAULT_CONFIG: "1",
    };
    const stopped = JSON.parse(
      (await exec(tsx, [child, "stop"], { cwd: runtimeRoot, env: environment })).stdout,
    ) as Record<string, any>;
    expect(stopped).toMatchObject({ status: "needs-input", error: "unresolved-claim" });
    // The resume commands repeat the preset and the --set pair, so a resume
    // binds what the stop bound.
    const flags = ` --composition ${compositionId} --set 'maxOutputTokens=12000' --resume-from `;
    expect(
      buildRunHumanNextCommand({
        record: stopped as never,
        recordPath: join(root, "state", "runs", `${stopped.id}.json`),
        repositoryPath: repository,
      })?.command,
    ).toContain(flags);
    const reported: string[] = [];
    reportKnowledgeContinuationStop(
      {
        config: { stateDirectory: join(root, "state", "runs") },
        request: { workflow: "create-documentation", repositoryPath: repository, compositionId },
        options: { json: true },
        output: { log: (line: string) => reported.push(line), error: () => undefined },
      } as never,
      stopped as never,
    );
    expect(JSON.parse(reported.join("\n")).nextSteps.join("\n")).toContain(flags);
    const receipt = decodeKnowledgeContinuationReceipt(stopped.knowledgeContinuationReceipt);
    const retained = decodeKnowledgeContinuationRetainedBytes(
      await new DurableArtifactStore(join(root, "state", "artifacts")).getRecord(
        receipt.candidateArtifactSha256,
      ),
    );
    const prior = JSON.parse(retained.text) as {
      claims: Array<{ id: string; modelState: string }>;
    };
    const answer = await applyKnowledgeAnswer(root, retained.text, {
      schemaVersion: 1,
      kind: "knowledge-attributed-answer",
      actor: "fixture-product-owner",
      authority: "product-decision-owner",
      token: prior.claims.find((claim) => claim.modelState === "unresolved")!.id,
      statement: "This fixture documents the product purpose for its readers.",
    });
    // `docsfab runs` projects the exact command, which the real parser reads
    // back with the same preset and setting.
    const projected = await projectRunContinuationCommand({
      record: stopped,
      resumability: await classifyRunResumability(stopped as never, join(root, "state", "runs")),
      stateDirectory: join(root, "state", "runs"),
      stateDirectoryExplicit: false,
      canonSnapshotPath: answer.snapshotPath,
      acceptCandidateSnapshot: true,
      authorityId: "fixture-product-owner",
    });
    expect(projected).toMatchObject({ disposition: "ready" });
    expect((projected as { rendered: { command: string } }).rendered.command).toContain(flags);

    const resumed = JSON.parse(
      (
        await exec(tsx, [child, "resume"], {
          cwd: runtimeRoot,
          env: {
            ...environment,
            DOCSFAB_FIXTURE_STOPPED_RUN: stopped.id,
            DOCSFAB_FIXTURE_SNAPSHOT: answer.snapshotPath,
            DOCSFAB_FIXTURE_INSTRUCTION:
              `Write \`${targetPath}\` using only these repository-observed behavior claims:\n` +
              "- The fixture publishes one verified café behavior page.",
          },
        })
      ).stdout,
    ) as Record<string, any>;

    // Before presets, a `--composition` resume stopped without loading the continuation.
    expect(resumed).toMatchObject({
      status: "succeeded",
      knowledgeContinuationReceipt: { receiptSha256: receipt.receiptSha256 },
      modelSettings: {
        writing: {
          presetId: compositionId,
          presetSource: "cli-flag",
          settings: { maxOutputTokens: { value: 12000, source: "cli-flag" } },
        },
      },
    });
    expect(resumed.id).not.toBe(stopped.id);
    const patch = await readFile(resumed.changes.patch.artifactPath, "utf8");
    expect(patch).toContain(targetPath);
  });

  it("resumes a multi-page V2 update after disposable workspace loss in another process", {
    timeout: testTimeoutMs(120_000),
  }, async () => {
    const root = await temporary.create("docsfab-knowledge-continuation-v2-");
    const repository = join(root, "repository");
    const stateDirectory = join(root, "state", "runs");
    const targetPaths = ["docs/guide.md", "docs/reference.md"] as const;
    const instruction =
      "Update exactly docs/guide.md and docs/reference.md using only current repository evidence. Preserve unrelated content and change no other path.";
    await mkdir(join(repository, "docs"), { recursive: true });
    await writeFile(join(repository, "README.md"), "# Continuation fixture\n");
    await writeFile(join(repository, targetPaths[0]), "# Old guide\n");
    await writeFile(join(repository, targetPaths[1]), "# Old reference\n");
    await writeFile(
      join(repository, ".docsfab.json"),
      `${JSON.stringify(
        {
          schemaVersion: 1,
          gitlab: { remote: "origin", defaultBranch: "main" },
          provider: { configuration: "host" },
          storage: { scope: "user-private" },
        },
        null,
        2,
      )}\n`,
    );
    await commitPrivateFixture(repository);
    const sourceBytes = await git(repository, ["rev-parse", "HEAD"]);
    const knowledgeDirectory = await ordinaryMultiPageKnowledgeDirectory();
    const environment = {
      ...process.env,
      DOCSFAB_FIXTURE_REPOSITORY: repository,
      DOCSFAB_FIXTURE_STATE: stateDirectory,
      DOCSFAB_FIXTURE_WORKFLOW: "update-documentation",
      DOCSFAB_FIXTURE_TARGET: targetPaths[0],
      DOCSFAB_FIXTURE_TARGETS: targetPaths.join(","),
      DOCSFAB_FIXTURE_INSTRUCTION: instruction,
      DOCSFAB_KNOWLEDGE_DIR: knowledgeDirectory,
      DOCSFAB_OPERATOR_AUTHORITY_ID: "fixture-cli-operator",
      DOCSFAB_FIXTURE_DEFAULT_CONFIG: "1",
    };
    const stopped = JSON.parse(
      (await exec(tsx, [child, "stop"], { cwd: runtimeRoot, env: environment })).stdout,
    ) as Record<string, any>;
    expect(stopped).toMatchObject({
      workflow: "update-documentation",
      status: "needs-input",
      error: "unresolved-claim",
      workspace: { disposable: true },
      steps: [],
    });
    expect(stopped.instruction).toBeUndefined();
    expect(await git(repository, ["status", "--short"])).toBe("");
    expect(await git(repository, ["rev-parse", "HEAD"])).toBe(sourceBytes);
    await expect(
      readFile(join(repository, FIRST_PASS_KNOWLEDGE_SNAPSHOT_PATH)),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(join(repository, ORIGINAL_TASK_PATH))).rejects.toMatchObject({
      code: "ENOENT",
    });
    const stoppedPath = join(stateDirectory, `${stopped.id}.json`);
    const stoppedBytes = await readFile(stoppedPath, "utf8");
    const receipt = decodeKnowledgeContinuationReceipt(stopped.knowledgeContinuationReceipt);
    expect(() => decodeKnowledgeContinuationStoppedRun(stopped)).not.toThrow();
    const artifactStore = new DurableArtifactStore(join(root, "state", "artifacts"));
    const retainedTask = (await artifactStore.getRecord(
      receipt.originalTaskArtifactSha256,
    )) as Record<string, unknown>;
    expect(retainedTask.instruction).toBe(instruction);
    expect(retainedTask.workflow).toBe("update-documentation");
    for (const path of targetPaths) expect(String(retainedTask.instruction)).toContain(path);
    const originalOrigin = await artifactStore.getRecord(receipt.originArtifactSha256);
    const originalLineage = await artifactStore.getRecord(receipt.lineageArtifactSha256);
    const retained = decodeKnowledgeContinuationRetainedBytes(
      await artifactStore.getRecord(receipt.candidateArtifactSha256),
    );
    const prior = JSON.parse(retained.text) as {
      claims: Array<{ id: string; modelState: string }>;
    };
    expect(prior.claims.some((claim) => claim.modelState === "unresolved")).toBe(true);

    const answer = await applyKnowledgeAnswer(root, retained.text, {
      schemaVersion: 1,
      kind: "knowledge-attributed-answer",
      actor: "fixture-product-owner",
      authority: "product-decision-owner",
      token: prior.claims.find((claim) => claim.modelState === "unresolved")!.id,
      statement: "This fixture documents the product purpose for its readers.",
    });
    expect(answer.priorSnapshotSha256).toBe(receipt.candidateSnapshotSha256);
    expect(inspectRequestedPageSupport(answer.snapshot, instruction)).toMatchObject({
      disposition: "continue",
    });
    const snapshotPath = answer.snapshotPath;
    const resumeEnvironment = {
      ...environment,
      DOCSFAB_FIXTURE_STOPPED_RUN: stopped.id,
      DOCSFAB_FIXTURE_SNAPSHOT: snapshotPath,
    };

    await expectExitOne(
      tsx,
      [child, "resume"],
      runtimeRoot,
      {
        ...resumeEnvironment,
        DOCSFAB_FIXTURE_INSTRUCTION:
          "Update exactly docs/other.md and docs/elsewhere.md using only current repository evidence.",
      },
      /binding-mismatch/u,
    );
    await expectExitOne(
      tsx,
      [child, "resume"],
      runtimeRoot,
      {
        ...resumeEnvironment,
        DOCSFAB_FIXTURE_WORKFLOW: "create-documentation",
      },
      /binding-mismatch/u,
    );
    const otherRepository = join(root, "other-repository");
    await git(root, ["clone", "--quiet", repository, otherRepository]);
    await expectExitOne(
      tsx,
      [child, "resume"],
      runtimeRoot,
      {
        ...resumeEnvironment,
        DOCSFAB_FIXTURE_REPOSITORY: otherRepository,
      },
      /binding-mismatch/u,
    );
    await expectExitOne(
      tsx,
      [child, "resume"],
      runtimeRoot,
      {
        ...resumeEnvironment,
        DOCSFAB_OPERATOR_AUTHORITY_ID: "substituted-cli-operator",
      },
      /binding-mismatch/u,
    );
    const originalStopped = JSON.parse(stoppedBytes) as Record<string, any>;
    await writeFile(
      stoppedPath,
      `${JSON.stringify({
        ...originalStopped,
        knowledgeContinuationReceipt: {
          ...originalStopped.knowledgeContinuationReceipt,
          candidateSnapshotSha256: "f".repeat(64),
        },
      })}\n`,
      { mode: 0o600 },
    );
    await expectExitOne(tsx, [child, "resume"], runtimeRoot, resumeEnvironment, /digest-mismatch/u);
    await writeFile(stoppedPath, stoppedBytes, { mode: 0o600 });

    const resumed = JSON.parse(
      (await exec(tsx, [child, "resume"], { cwd: runtimeRoot, env: resumeEnvironment })).stdout,
    ) as Record<string, any>;
    expect(resumed).toMatchObject({
      workflow: "update-documentation",
      status: "succeeded",
      repository: { revision: stopped.repository.revision },
      taskLineage: { projectionSha256: stopped.taskLineage.projectionSha256 },
      knowledgeContinuationReceipt: { receiptSha256: receipt.receiptSha256 },
      knowledgeContinuationRecoveryAuthorization: {
        kind: "docsfab-task-lineage-recovery-authorization",
      },
    });
    expect(resumed.id).not.toBe(stopped.id);
    expect(resumed.workflowBranchCoverage).toMatchObject({
      workflow: "update-documentation",
      selection: { branchId: "author" },
    });
    expect(resumed.knowledgeContinuationSnapshotSha256).toBe(answer.snapshot.snapshotSha256);
    expect(resumed.knowledgeContinuationRecoveryAuthorization).toMatchObject({
      originalOriginSha256: (originalOrigin as Record<string, unknown>).originSha256,
      originalLineageSha256: (originalLineage as Record<string, unknown>).lineageSha256,
    });
    expect(await artifactStore.getRecord(receipt.originArtifactSha256)).toEqual(originalOrigin);
    expect(await artifactStore.getRecord(receipt.lineageArtifactSha256)).toEqual(originalLineage);
    expect(await readFile(stoppedPath, "utf8")).toBe(stoppedBytes);
    expect((await stat(stoppedPath)).mode & 0o777).toBe(0o600);
    expect(await git(repository, ["status", "--short"])).toBe("");
    expect(await git(repository, ["rev-parse", "HEAD"])).toBe(sourceBytes);
    const patch = await readFile(resumed.changes.patch.artifactPath, "utf8");
    for (const path of targetPaths) expect(patch).toContain(path);
    expect(patch).not.toContain(".docsfab.json");
    await expect(
      readFile(join(repository, FIRST_PASS_KNOWLEDGE_SNAPSHOT_PATH)),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(join(repository, ORIGINAL_TASK_PATH))).rejects.toMatchObject({
      code: "ENOENT",
    });
    const continuationHistory = join(root, "state", "knowledge-continuations");
    const settledHistory = await readdir(continuationHistory);
    expect(settledHistory.length).toBeGreaterThanOrEqual(3);

    const replay = JSON.parse(
      (await exec(tsx, [child, "resume"], { cwd: runtimeRoot, env: resumeEnvironment })).stdout,
    ) as Record<string, any>;
    expect(replay.id).toBe(resumed.id);
    expect(replay.status).toBe("succeeded");
    expect(replay.changes.patch.sha256).toBe(resumed.changes.patch.sha256);
    expect(await readdir(continuationHistory)).toEqual(settledHistory);
    expect(await git(repository, ["status", "--short"])).toBe("");
    expect(await git(repository, ["rev-parse", "HEAD"])).toBe(sourceBytes);
  });

  // The continuation task stores the stopped run's admitted reading, so every
  // continuation read binds those pages, never the request words: the load,
  // the host canon import, and the `docsfab runs` continuation command.
  it("resumes a verb-free admitted update by its admitted pages, not its words (X1)", {
    timeout: testTimeoutMs(120_000),
  }, async () => {
    const root = await temporary.create("docsfab-knowledge-continuation-intent-");
    const repository = join(root, "repository");
    const stateDirectory = join(root, "state", "runs");
    const targetPaths = ["docs/guide.md", "docs/reference.md"] as const;
    const instruction =
      "Bring docs/guide.md and docs/reference.md up to date with the implementation.";
    await mkdir(join(repository, "docs"), { recursive: true });
    await writeFile(join(repository, "README.md"), "# Continuation fixture\n");
    await writeFile(join(repository, targetPaths[0]), "# Old guide\n");
    await writeFile(join(repository, targetPaths[1]), "# Old reference\n");
    await writeFile(
      join(repository, ".docsfab.json"),
      `${JSON.stringify({
        schemaVersion: 1,
        gitlab: { remote: "origin", defaultBranch: "main" },
        provider: { configuration: "host" },
        storage: { scope: "user-private" },
      })}\n`,
    );
    await commitPrivateFixture(repository);
    const environment = {
      ...process.env,
      DOCSFAB_FIXTURE_REPOSITORY: repository,
      DOCSFAB_FIXTURE_STATE: stateDirectory,
      DOCSFAB_FIXTURE_WORKFLOW: "update-documentation",
      DOCSFAB_FIXTURE_TARGET: targetPaths[0],
      DOCSFAB_FIXTURE_TARGETS: targetPaths.join(","),
      DOCSFAB_FIXTURE_INSTRUCTION: instruction,
      DOCSFAB_FIXTURE_INTENT_TARGETS: targetPaths.join(","),
      DOCSFAB_FIXTURE_INTENT_CALLS: join(root, "interpretation-calls.txt"),
      DOCSFAB_KNOWLEDGE_DIR: await ordinaryMultiPageKnowledgeDirectory(),
      DOCSFAB_OPERATOR_AUTHORITY_ID: "fixture-cli-operator",
      DOCSFAB_FIXTURE_DEFAULT_CONFIG: "1",
    };
    const stopped = JSON.parse(
      (await exec(tsx, [child, "stop"], { cwd: runtimeRoot, env: environment })).stdout,
    ) as Record<string, any>;
    // The interpretation ran once, and its two admitted pages took first pass,
    // which stopped on the snapshot's unresolved claim, not the request words.
    expect(await readFile(environment.DOCSFAB_FIXTURE_INTENT_CALLS, "utf8")).toBe("call\n");
    expect(stopped).toMatchObject({
      workflow: "update-documentation",
      status: "needs-input",
      error: "unresolved-claim",
    });
    const receipt = decodeKnowledgeContinuationReceipt(stopped.knowledgeContinuationReceipt);
    const artifactStore = new DurableArtifactStore(join(root, "state", "artifacts"));
    // The stored task, decoded from the artifact store, carries the admission.
    const privateTask = decodeKnowledgeContinuationPrivateTask(
      await artifactStore.getRecord(receipt.originalTaskArtifactSha256),
    );
    expect(privateTask).toMatchObject({
      schemaVersion: 2,
      targetConflictReceipt: null,
      continuationTargets: {
        source: "admitted-intent",
        requestIntent: { admission: { outcome: "admitted" } },
      },
    });
    expect(continuationRequestedPageIntent(privateTask)).toEqual({ writeTargets: targetPaths });
    const retained = decodeKnowledgeContinuationRetainedBytes(
      await artifactStore.getRecord(receipt.candidateArtifactSha256),
    );
    const prior = JSON.parse(retained.text) as {
      claims: Array<{ id: string; modelState: string }>;
    };
    const answer = await applyKnowledgeAnswer(root, retained.text, {
      schemaVersion: 1,
      kind: "knowledge-attributed-answer",
      actor: "fixture-product-owner",
      authority: "product-decision-owner",
      token: prior.claims.find((claim) => claim.modelState === "unresolved")!.id,
      statement: "This fixture documents the product purpose for its readers.",
    });
    // The answered snapshot covers the admitted pages, but not these words.
    expect(
      inspectRequestedPageSupport(answer.snapshot as KnowledgeAcceptedSnapshotV1, instruction, {
        writeTargets: targetPaths,
      }),
    ).toMatchObject({ disposition: "continue" });
    expect(
      inspectRequestedPageSupport(answer.snapshot as KnowledgeAcceptedSnapshotV1, instruction),
    ).toMatchObject({ disposition: "needs-input", stopReason: "insufficient-evidence" });

    // `docsfab runs`: the stored pages project the exact continuation command.
    const projected = await projectRunContinuationCommand({
      record: stopped,
      resumability: await classifyRunResumability(stopped as never, stateDirectory),
      stateDirectory,
      stateDirectoryExplicit: true,
      canonSnapshotPath: answer.snapshotPath,
      acceptCandidateSnapshot: true,
      authorityId: "fixture-product-owner",
    });
    expect(projected.disposition).toBe("ready");

    const resumed = JSON.parse(
      (
        await exec(tsx, [child, "resume"], {
          cwd: runtimeRoot,
          env: {
            ...environment,
            DOCSFAB_FIXTURE_STOPPED_RUN: stopped.id,
            DOCSFAB_FIXTURE_SNAPSHOT: answer.snapshotPath,
          },
        })
      ).stdout,
    ) as Record<string, any>;
    expect(resumed).toMatchObject({
      workflow: "update-documentation",
      status: "succeeded",
      knowledgeContinuationReceipt: { originalRunId: stopped.id },
      knowledgeContinuationSnapshotSha256: answer.snapshot.snapshotSha256,
      // The resumed run reads no request of its own: the continuation outcome.
      requestIntent: { admission: { outcome: "continuation" } },
    });
    expect(await readFile(environment.DOCSFAB_FIXTURE_INTENT_CALLS, "utf8")).toBe("call\n");
    // Two admitted pages select no single page, so neither the load nor the
    // host canon import mints a resume receipt: they agree on none, and the
    // run record carries the host import's (none).
    expect(resumed.knowledgeResumeReceipt).toBeUndefined();
    const patch = await readFile(resumed.changes.patch.artifactPath, "utf8");
    for (const path of targetPaths) expect(patch).toContain(`+++ b/${path}`);
  });

  // An advisory or offline stopped run admitted no pages, so its task stores
  // none and its continuation reads the request words as before.
  it("stores no pages for an advisory or offline stop and resumes it by its words (W)", {
    timeout: testTimeoutMs(120_000),
  }, async () => {
    const targetPaths = ["docs/guide.md", "docs/reference.md"] as const;
    const instruction =
      "Update exactly docs/guide.md and docs/reference.md using only current repository evidence. Preserve unrelated content and change no other path.";
    const knowledgeDirectory = await ordinaryMultiPageKnowledgeDirectory();
    async function stopRun(arm: "advisory" | "offline") {
      const root = await temporary.create(`docsfab-knowledge-continuation-${arm}-`);
      const repository = join(root, "repository");
      const stateDirectory = join(root, "state", "runs");
      await mkdir(join(repository, "docs"), { recursive: true });
      await writeFile(join(repository, "README.md"), "# Continuation fixture\n");
      await writeFile(join(repository, targetPaths[0]), "# Old guide\n");
      await writeFile(join(repository, targetPaths[1]), "# Old reference\n");
      await writeFile(
        join(repository, ".docsfab.json"),
        `${JSON.stringify({
          schemaVersion: 1,
          gitlab: { remote: "origin", defaultBranch: "main" },
          provider: { configuration: "host" },
          storage: { scope: "user-private" },
        })}\n`,
      );
      await commitPrivateFixture(repository);
      const environment = {
        ...process.env,
        DOCSFAB_FIXTURE_REPOSITORY: repository,
        DOCSFAB_FIXTURE_STATE: stateDirectory,
        DOCSFAB_FIXTURE_WORKFLOW: "update-documentation",
        DOCSFAB_FIXTURE_TARGET: targetPaths[0],
        DOCSFAB_FIXTURE_TARGETS: targetPaths.join(","),
        DOCSFAB_FIXTURE_INSTRUCTION: instruction,
        DOCSFAB_KNOWLEDGE_DIR: knowledgeDirectory,
        DOCSFAB_OPERATOR_AUTHORITY_ID: "fixture-cli-operator",
        DOCSFAB_FIXTURE_DEFAULT_CONFIG: "1",
        // The reading names another operation than the declared update: an
        // advisory, which binds nothing. Offline runs no interpretation.
        ...(arm === "advisory"
          ? {
              DOCSFAB_FIXTURE_INTENT_TARGETS: targetPaths.join(","),
              DOCSFAB_FIXTURE_INTENT_OPERATION: "create",
              DOCSFAB_FIXTURE_INTENT_CALLS: join(root, "interpretation-calls.txt"),
            }
          : {}),
      };
      const stopped = JSON.parse(
        (await exec(tsx, [child, "stop"], { cwd: runtimeRoot, env: environment })).stdout,
      ) as Record<string, any>;
      expect(stopped, arm).toMatchObject({ status: "needs-input", error: "unresolved-claim" });
      const receipt = decodeKnowledgeContinuationReceipt(stopped.knowledgeContinuationReceipt);
      const artifactStore = new DurableArtifactStore(join(root, "state", "artifacts"));
      const stored = await artifactStore.getRecord(receipt.originalTaskArtifactSha256);
      const privateTask = decodeKnowledgeContinuationPrivateTask(stored);
      expect(privateTask, arm).toMatchObject({ schemaVersion: 2, continuationTargets: null });
      expect(continuationRequestedPageIntent(privateTask), arm).toBeUndefined();
      return { root, environment, stopped, receipt, artifactStore };
    }

    await stopRun("offline");
    const advisory = await stopRun("advisory");
    // The reading ran and the run went on past it to first pass's stop.
    expect(await readFile(advisory.environment.DOCSFAB_FIXTURE_INTENT_CALLS!, "utf8")).toBe(
      "call\n",
    );
    const retained = decodeKnowledgeContinuationRetainedBytes(
      await advisory.artifactStore.getRecord(advisory.receipt.candidateArtifactSha256),
    );
    const prior = JSON.parse(retained.text) as {
      claims: Array<{ id: string; modelState: string }>;
    };
    const answer = await applyKnowledgeAnswer(advisory.root, retained.text, {
      schemaVersion: 1,
      kind: "knowledge-attributed-answer",
      actor: "fixture-product-owner",
      authority: "product-decision-owner",
      token: prior.claims.find((claim) => claim.modelState === "unresolved")!.id,
      statement: "This fixture documents the product purpose for its readers.",
    });
    const resumed = JSON.parse(
      (
        await exec(tsx, [child, "resume"], {
          cwd: runtimeRoot,
          env: {
            ...advisory.environment,
            DOCSFAB_FIXTURE_STOPPED_RUN: advisory.stopped.id,
            DOCSFAB_FIXTURE_SNAPSHOT: answer.snapshotPath,
          },
        })
      ).stdout,
    ) as Record<string, any>;
    expect(resumed).toMatchObject({ status: "succeeded" });
    const patch = await readFile(resumed.changes.patch.artifactPath, "utf8");
    for (const path of targetPaths) expect(patch).toContain(`+++ b/${path}`);
  });

  // A draft-MR continuation whose resumed run verifies that no change is needed
  // has nothing to publish. Delivery settles nothing, so the journal keeps the
  // writer-completed phase rather than recording a draft MR that was never
  // opened, and the resume exits 0 without reaching the publisher.
  it("settles no delivery for a draft-MR continuation that ends in verified no-change", {
    timeout: testTimeoutMs(120_000),
  }, async () => {
    const root = await temporary.create("docsfab-knowledge-continuation-no-change-");
    const repository = join(root, "repository");
    const stateDirectory = join(root, "state", "runs");
    const deliveryState = join(root, "delivery.json");
    const targetPaths = ["docs/guide.md", "docs/reference.md"] as const;
    const instruction =
      "Update exactly docs/guide.md and docs/reference.md using only current repository evidence. Preserve unrelated content and change no other path.";
    await mkdir(join(repository, "docs"), { recursive: true });
    await writeFile(join(repository, "README.md"), "# Continuation fixture\n");
    await writeFile(join(repository, targetPaths[0]), "# Guide\n");
    await writeFile(join(repository, targetPaths[1]), "# Reference\n");
    await writeFile(
      join(repository, ".docsfab.json"),
      `${JSON.stringify({
        schemaVersion: 1,
        gitlab: { remote: "origin", defaultBranch: "main" },
        provider: { configuration: "host" },
        storage: { scope: "user-private" },
      })}\n`,
    );
    await commitPrivateFixture(repository);
    const targetRevision = await git(repository, ["rev-parse", "HEAD"]);
    const environment = {
      ...process.env,
      DOCSFAB_FIXTURE_REPOSITORY: repository,
      DOCSFAB_FIXTURE_STATE: stateDirectory,
      DOCSFAB_FIXTURE_WORKFLOW: "update-documentation",
      DOCSFAB_FIXTURE_TARGET: targetPaths[0],
      DOCSFAB_FIXTURE_TARGETS: targetPaths.join(","),
      DOCSFAB_FIXTURE_INSTRUCTION: instruction,
      DOCSFAB_FIXTURE_CANDIDATE: "no-change",
      DOCSFAB_FIXTURE_DRAFT_MR: "1",
      DOCSFAB_FIXTURE_TARGET_BRANCH: "main",
      DOCSFAB_FIXTURE_TARGET_REVISION: targetRevision,
      DOCSFAB_FIXTURE_DELIVERY_STATE: deliveryState,
      DOCSFAB_FIXTURE_DELIVERY_ACTION: "no-publication",
      DOCSFAB_KNOWLEDGE_DIR: await ordinaryMultiPageKnowledgeDirectory(),
      DOCSFAB_OPERATOR_AUTHORITY_ID: "fixture-cli-operator",
      DOCSFAB_FIXTURE_DEFAULT_CONFIG: "1",
    };
    const stopped = JSON.parse(
      (await exec(tsx, [child, "stop"], { cwd: runtimeRoot, env: environment })).stdout,
    ) as Record<string, any>;
    expect(stopped).toMatchObject({ status: "needs-input", error: "unresolved-claim" });
    const receipt = decodeKnowledgeContinuationReceipt(stopped.knowledgeContinuationReceipt);
    const artifactStore = new DurableArtifactStore(join(root, "state", "artifacts"));
    const retained = decodeKnowledgeContinuationRetainedBytes(
      await artifactStore.getRecord(receipt.candidateArtifactSha256),
    );
    const prior = JSON.parse(retained.text) as {
      claims: Array<{ id: string; modelState: string }>;
    };
    const answer = await applyKnowledgeAnswer(root, retained.text, {
      schemaVersion: 1,
      kind: "knowledge-attributed-answer",
      actor: "fixture-product-owner",
      authority: "product-decision-owner",
      token: prior.claims.find((claim) => claim.modelState === "unresolved")!.id,
      statement: "This fixture documents the product purpose for its readers.",
    });

    // The first resume runs the workflow; it must exit 0.
    const resumedOutput = (
      await exec(tsx, [child, "resume"], {
        cwd: runtimeRoot,
        env: {
          ...environment,
          DOCSFAB_FIXTURE_STOPPED_RUN: stopped.id,
          DOCSFAB_FIXTURE_SNAPSHOT: answer.snapshotPath,
          DOCSFAB_FIXTURE_OUTPUT: "json",
        },
      })
    ).stdout;
    const result = JSON.parse(resumedOutput.slice(resumedOutput.indexOf("{"))) as Record<
      string,
      any
    >;
    expect(result).toMatchObject({
      execution: { status: "succeeded", exitCode: 0, patchPath: null },
      editorial: { outcome: "verified-no-change", decision: "no-change" },
    });
    // No publisher call, and no delivery settled: the journal stays at the
    // phase the writer step recorded.
    await expect(access(deliveryState)).rejects.toMatchObject({ code: "ENOENT" });
    const journal = await latestJournalEntry(
      join(root, "state", "knowledge-continuations"),
      stopped.id,
    );
    expect(journal).toMatchObject({ phase: "writer-completed", deliveryResult: null });
    expect(journal.childRunId).toBe(result.execution.runId);
    expect(await git(repository, ["status", "--short"])).toBe("");
  });

  it("rejects unknown receipt fields and digest substitution", () => {
    const body = {
      schemaVersion: 1,
      kind: "docsfab-knowledge-continuation-receipt",
      originalRunId: "run-1",
      repositoryIdentitySha256: "a".repeat(64),
      repositoryRevision: "b".repeat(40),
      workflow: "create-documentation",
      instructionSha256: "c".repeat(64),
      candidateSnapshotSha256: "d".repeat(64),
      candidateArtifactSha256: "e".repeat(64),
      candidateBytesSha256: "f".repeat(64),
      originalTaskArtifactSha256: "1".repeat(64),
      originalTaskBindingArtifactSha256: "2".repeat(64),
      originalTaskBindingBytesSha256: "3".repeat(64),
      originArtifactSha256: "4".repeat(64),
      lineageArtifactSha256: "5".repeat(64),
      taskLineageProjectionSha256: "6".repeat(64),
      targetConflictReceipt: null,
      targetConflictReceiptSha256: null,
      receiptSha256: "7".repeat(64),
    };
    expect(() => decodeKnowledgeContinuationReceipt(body)).toThrow(/digest-mismatch/u);
    expect(() => decodeKnowledgeContinuationReceipt({ ...body, unknown: true })).toThrow(
      /invalid-shape/u,
    );
  });

  it("retains advisory conflict scope through an insufficient-support stop and resume", {
    timeout: testTimeoutMs(120_000),
  }, async () => {
    const root = await temporary.create("docsfab-continuation-conflict-");
    const repository = join(root, "repository");
    const stateDirectory = join(root, "state", "runs");
    const targetPath = "docs/reference/cli.mdx";
    const requestedStatement = "The fixture publishes two independently verified behavior pages.";
    await mkdir(repository, { recursive: true });
    await writeFile(join(repository, "README.md"), "# Conflict continuation fixture\n");
    await writeFile(
      join(repository, ".docsfab.json"),
      `${JSON.stringify({
        schemaVersion: 1,
        gitlab: { remote: "origin", defaultBranch: "main" },
        provider: { configuration: "host" },
        storage: { scope: "user-private" },
      })}\n`,
    );
    await commitPrivateFixture(repository);
    const environment = {
      ...process.env,
      DOCSFAB_FIXTURE_REPOSITORY: repository,
      DOCSFAB_FIXTURE_STATE: stateDirectory,
      DOCSFAB_FIXTURE_WORKFLOW: "create-documentation",
      DOCSFAB_FIXTURE_TARGET: targetPath,
      DOCSFAB_FIXTURE_REQUESTED_STATEMENT: requestedStatement,
      DOCSFAB_FIXTURE_ADVISORY_CONFLICT: "1",
      DOCSFAB_KNOWLEDGE_DIR: knowledgeRoot,
      DOCSFAB_OPERATOR_AUTHORITY_ID: "fixture-cli-operator",
      DOCSFAB_FIXTURE_DEFAULT_CONFIG: "1",
    };
    const stopped = JSON.parse(
      (await exec(tsx, [child, "stop"], { cwd: runtimeRoot, env: environment })).stdout,
    ) as Record<string, any>;
    const receipt = decodeKnowledgeContinuationReceipt(stopped.knowledgeContinuationReceipt);
    expect(receipt.targetConflictReceipt).toMatchObject({
      snapshotSha256: receipt.candidateSnapshotSha256,
      selectedTargetPath: targetPath,
      advisoryConflicts: [
        {
          conflictId: "CF-PURPOSE",
          blockingDocumentationPaths: ["docs/about/product.md"],
        },
      ],
    });
    expect(receipt.targetConflictReceiptSha256).toBe(
      canonicalDigest(receipt.targetConflictReceipt),
    );

    const artifactStore = new DurableArtifactStore(join(root, "state", "artifacts"));
    const retained = decodeKnowledgeContinuationRetainedBytes(
      await artifactStore.getRecord(receipt.candidateArtifactSha256),
    );
    const prior = decodeKnowledgeAcceptedSnapshot(JSON.parse(retained.text));
    const priorSource = prior.sources[0];
    if (!priorSource) throw new Error("expected retained knowledge source evidence");
    const { snapshotSha256: _priorSha256, ...priorBody } = prior;
    const suppliedBody: KnowledgeAcceptedSnapshotBodyV1 & {
      schemaVersion: KnowledgeAcceptedSnapshotV1["schemaVersion"];
      kind: KnowledgeAcceptedSnapshotV1["kind"];
    } = {
      ...priorBody,
      streamVersion: prior.streamVersion + 1,
      modelVersionId: `${prior.modelVersionId}-accepted`,
      claims: [
        ...prior.claims,
        {
          id: "CL-ACCEPTED-SUPPORT",
          kind: "behavior",
          scope: "Continuation Fixture",
          statement: requestedStatement,
          modelState: "candidate",
          evidenceIds: [priorSource.id],
        },
      ],
    };
    const supplied: KnowledgeAcceptedSnapshotV1 = {
      ...suppliedBody,
      snapshotSha256: canonicalDigest(suppliedBody),
    };
    const snapshotPath = join(root, "accepted-conflict-snapshot.json");
    await writeFile(snapshotPath, `${JSON.stringify(supplied, null, 2)}\n`);
    const resumeEnvironment = {
      ...environment,
      DOCSFAB_FIXTURE_STOPPED_RUN: stopped.id,
      DOCSFAB_FIXTURE_SNAPSHOT: snapshotPath,
    };

    const { snapshotSha256: _suppliedSha256, ...changedSnapshotBody } = supplied;
    const changedConflictBody = {
      ...changedSnapshotBody,
      conflicts: supplied.conflicts.map((conflict) => {
        if (!conflict.classification)
          throw new Error("expected classified retained knowledge conflict");
        return {
          ...conflict,
          classification: {
            ...conflict.classification,
            blockingDocumentationPaths: [targetPath],
          },
        };
      }),
    };
    const changedConflict = {
      ...changedConflictBody,
      snapshotSha256: canonicalDigest(changedConflictBody),
    };
    const changedConflictPath = join(root, "changed-conflict-snapshot.json");
    await writeFile(changedConflictPath, `${JSON.stringify(changedConflict, null, 2)}\n`);
    await expectExitOne(
      tsx,
      [child, "resume"],
      runtimeRoot,
      {
        ...resumeEnvironment,
        DOCSFAB_FIXTURE_SNAPSHOT: changedConflictPath,
      },
      /binding-mismatch/u,
    );

    const planState = join(root, "plan-state");
    await cp(join(root, "state"), planState, { recursive: true });
    const refusedPlan = JSON.parse(
      (
        await exec(tsx, [child, "resume"], {
          cwd: runtimeRoot,
          env: {
            ...resumeEnvironment,
            DOCSFAB_FIXTURE_STATE: join(planState, "runs"),
            DOCSFAB_STATE_DIR: join(planState, "runs"),
            DOCSFAB_FIXTURE_PLAN_TARGET: "docs/reference/other.mdx",
          },
        })
      ).stdout,
    ) as Record<string, any>;
    expect(refusedPlan).toMatchObject({
      status: "failed",
      error: expect.stringMatching(/plan target does not match the knowledge resume receipt/u),
    });

    const resumed = JSON.parse(
      (await exec(tsx, [child, "resume"], { cwd: runtimeRoot, env: resumeEnvironment })).stdout,
    ) as Record<string, any>;
    expect(resumed.status).toBe("succeeded");
    expect(resumed.knowledgeResumeReceipt).toMatchObject({
      snapshotSha256: supplied.snapshotSha256,
      selectedTargetPath: targetPath,
      advisoryConflicts: receipt.targetConflictReceipt?.advisoryConflicts,
    });
    expect(resumed.knowledgeContinuationReceipt).toEqual(receipt);
  });

  it("reconciles one fixed child and stable publisher key after delivery crashes", {
    timeout: testTimeoutMs(180_000),
  }, async () => {
    const root = await temporary.create("docsfab-continuation-delivery-");
    const repository = join(root, "repository");
    const stateDirectory = join(root, "state", "runs");
    const targetPath = "docs/delivery.md";
    const deliveryState = join(root, "delivery.json");
    await mkdir(repository, { recursive: true });
    await writeFile(join(repository, "README.md"), "# Delivery continuation fixture\n");
    await writeFile(
      join(repository, ".docsfab.json"),
      `${JSON.stringify({
        schemaVersion: 1,
        gitlab: { remote: "origin", defaultBranch: "main" },
        provider: { configuration: "host" },
        storage: { scope: "user-private" },
      })}\n`,
    );
    await commitPrivateFixture(repository);
    const targetRevision = await git(repository, ["rev-parse", "HEAD"]);
    const environment = {
      ...process.env,
      DOCSFAB_FIXTURE_REPOSITORY: repository,
      DOCSFAB_FIXTURE_STATE: stateDirectory,
      DOCSFAB_FIXTURE_WORKFLOW: "create-documentation",
      DOCSFAB_FIXTURE_TARGET: targetPath,
      DOCSFAB_KNOWLEDGE_DIR: knowledgeRoot,
      DOCSFAB_OPERATOR_AUTHORITY_ID: "fixture-cli-operator",
      DOCSFAB_FIXTURE_DEFAULT_CONFIG: "1",
      DOCSFAB_FIXTURE_PARSED: "1",
      DOCSFAB_FIXTURE_TARGET_BRANCH: "main",
      DOCSFAB_FIXTURE_TARGET_REVISION: targetRevision,
      DOCSFAB_FIXTURE_DELIVERY_STATE: deliveryState,
    };
    const stopped = JSON.parse(
      (await exec(tsx, [child, "stop"], { cwd: runtimeRoot, env: environment })).stdout,
    ) as Record<string, any>;
    const receipt = decodeKnowledgeContinuationReceipt(stopped.knowledgeContinuationReceipt);
    const artifactStore = new DurableArtifactStore(join(root, "state", "artifacts"));
    const retained = decodeKnowledgeContinuationRetainedBytes(
      await artifactStore.getRecord(receipt.candidateArtifactSha256),
    );
    const prior = JSON.parse(retained.text) as {
      claims: Array<{ id: string; modelState: string }>;
    };
    const answer = await applyKnowledgeAnswer(root, retained.text, {
      schemaVersion: 1,
      kind: "knowledge-attributed-answer",
      actor: "fixture-product-owner",
      authority: "product-decision-owner",
      token: prior.claims.find((claim) => claim.modelState === "unresolved")!.id,
      statement: "The fixture publishes one verified café behavior page.",
    });
    const snapshotPath = answer.snapshotPath;
    const resumeEnvironment = {
      ...environment,
      DOCSFAB_FIXTURE_STOPPED_RUN: stopped.id,
      DOCSFAB_FIXTURE_SNAPSHOT: snapshotPath,
    };

    await expectExitOne(
      tsx,
      [child, "resume"],
      runtimeRoot,
      {
        ...resumeEnvironment,
        DOCSFAB_FIXTURE_TARGET_BRANCH: "changed-target",
      },
      /delivery-recovery-required/u,
    );
    await expect(access(deliveryState)).rejects.toMatchObject({ code: "ENOENT" });

    const beforeReady = join(root, "before-delivery.ready");
    await killAtBarrier(
      process.execPath,
      ["--import", "tsx", child, "resume"],
      runtimeRoot,
      {
        ...resumeEnvironment,
        DOCSFAB_FIXTURE_DELIVERY_ACTION: "crash-before-delivery",
        DOCSFAB_FIXTURE_DELIVERY_READY: beforeReady,
      },
      beforeReady,
    );
    await expect(access(deliveryState)).rejects.toMatchObject({ code: "ENOENT" });
    const journalRoot = join(root, "state", "knowledge-continuations");
    const writerEntry = await latestJournalEntry(journalRoot, stopped.id);
    expect(writerEntry.phase).toBe("writer-completed");
    const childPath = join(stateDirectory, `${writerEntry.childRunId}.json`);
    const childBytes = await readFile(childPath, "utf8");

    const duringReady = join(root, "during-delivery.ready");
    await killAtBarrier(
      process.execPath,
      ["--import", "tsx", child, "resume"],
      runtimeRoot,
      {
        ...resumeEnvironment,
        DOCSFAB_FIXTURE_DELIVERY_ACTION: "crash-during-delivery",
        DOCSFAB_FIXTURE_DELIVERY_READY: duringReady,
      },
      duringReady,
    );
    const uncertain = JSON.parse(await readFile(deliveryState, "utf8")) as {
      key: string;
      physicalCount: number;
    };
    expect(uncertain.key).toMatch(/^[a-f0-9]{64}$/u);
    expect(uncertain.physicalCount).toBe(1);
    expect(await readFile(childPath, "utf8")).toBe(childBytes);

    const journalBeforeByteSubstitution = await latestJournalEntry(journalRoot, stopped.id);
    const reformattedChildBytes = `${JSON.stringify(JSON.parse(childBytes))}\n`;
    expect(reformattedChildBytes).not.toBe(childBytes);
    await writeFile(childPath, reformattedChildBytes);
    await expectExitOne(
      tsx,
      [child, "resume"],
      runtimeRoot,
      {
        ...resumeEnvironment,
        DOCSFAB_FIXTURE_DELIVERY_ACTION: "fail-if-called",
      },
      /bounded operator recovery/u,
    );
    expect(await latestJournalEntry(journalRoot, stopped.id)).toEqual(
      journalBeforeByteSubstitution,
    );
    expect(
      (JSON.parse(await readFile(deliveryState, "utf8")) as { physicalCount: number })
        .physicalCount,
    ).toBe(1);
    await writeFile(childPath, childBytes);

    await expectExitOne(
      tsx,
      [child, "resume"],
      runtimeRoot,
      {
        ...resumeEnvironment,
        DOCSFAB_FIXTURE_DELIVERY_ACTION: "fail",
        DOCSFAB_FIXTURE_OUTPUT: "json",
      },
      /fixture publication failed/u,
    );
    expect((await latestJournalEntry(journalRoot, stopped.id)).phase).toBe("writer-completed");

    const reconciledOutput = (
      await exec(tsx, [child, "resume"], {
        cwd: runtimeRoot,
        env: { ...resumeEnvironment, DOCSFAB_FIXTURE_OUTPUT: "json" },
      })
    ).stdout;
    // JSON mode keeps preflight/status chatter on stderr; stdout is the result
    // document itself, without a human-status prefix.
    const reconciled = JSON.parse(reconciledOutput) as Record<string, any>;
    expect(reconciled.execution.runId).toBe(writerEntry.childRunId);
    const settled = await latestJournalEntry(journalRoot, stopped.id);
    expect(settled).toMatchObject({
      phase: "delivery-settled",
      childRunId: writerEntry.childRunId,
      deliveryResult: {
        status: "settled",
        publisherIdempotencyKey: uncertain.key,
        publisherResultArtifactSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
      },
    });
    const publisherArtifactSha256 = settled.deliveryResult.publisherResultArtifactSha256 as string;
    const publisherEvidence = (await artifactStore.getRecord(publisherArtifactSha256)) as Record<
      string,
      any
    >;
    expect(publisherEvidence).toMatchObject({
      idempotencyKey: uncertain.key,
      targetBranch: "main",
      mergeRequest: { url: "https://gitlab.fixture.test/docs/fixture/-/merge_requests/761" },
    });
    expect(canonicalDigest(publisherEvidence)).toBe(publisherArtifactSha256);
    expect(
      (JSON.parse(await readFile(deliveryState, "utf8")) as { physicalCount: number })
        .physicalCount,
    ).toBe(1);
    expect(await readFile(childPath, "utf8")).toBe(childBytes);

    const replay = await exec(tsx, [child, "resume"], {
      cwd: runtimeRoot,
      env: {
        ...resumeEnvironment,
        DOCSFAB_FIXTURE_DELIVERY_ACTION: "fail-if-called",
        DOCSFAB_FIXTURE_OUTPUT: "default",
      },
    });
    expect(replay.stdout).toMatch(/already-completed/u);
    expect(replay.stdout).toContain("Reused settled draft merge request");
    expect(await readFile(childPath, "utf8")).toBe(childBytes);

    const substitutedState = join(root, "substituted-state");
    await cp(join(root, "state"), substitutedState, { recursive: true });
    const substitutedJournalRoot = join(substitutedState, "knowledge-continuations");
    const journalNames = (await readdir(substitutedJournalRoot))
      .filter((name) => name.startsWith(`${stopped.id}.`) && name.endsWith(".json"))
      .sort();
    const journalPath = join(substitutedJournalRoot, journalNames.at(-1)!);
    const substituted = JSON.parse(await readFile(journalPath, "utf8")) as Record<string, any>;
    substituted.deliveryResult.publisherIdempotencyKey = "f".repeat(64);
    const { resultSha256: _oldResultSha256, ...resultBody } = substituted.deliveryResult;
    substituted.deliveryResult.resultSha256 = canonicalDigest(resultBody);
    const { journalSha256: _oldJournalSha256, ...journalBody } = substituted;
    substituted.journalSha256 = canonicalDigest(journalBody);
    await writeFile(journalPath, `${JSON.stringify(substituted)}\n`, { mode: 0o600 });
    await expectExitOne(
      tsx,
      [child, "resume"],
      runtimeRoot,
      {
        ...resumeEnvironment,
        DOCSFAB_FIXTURE_STATE: join(substitutedState, "runs"),
        DOCSFAB_STATE_DIR: join(substitutedState, "runs"),
      },
      /bounded operator recovery/u,
    );

    const missingState = join(root, "missing-evidence-state");
    await cp(join(root, "state"), missingState, { recursive: true });
    await rm(
      join(missingState, "artifacts", "objects", "sha256", `${publisherArtifactSha256}.json`),
    );
    await expectExitOne(
      tsx,
      [child, "resume"],
      runtimeRoot,
      {
        ...resumeEnvironment,
        DOCSFAB_FIXTURE_STATE: join(missingState, "runs"),
        DOCSFAB_STATE_DIR: join(missingState, "runs"),
      },
      /bounded operator recovery/u,
    );
  });

  it.each(["default", "quiet", "json", "silent"] as const)(
    "reports an actionable stopped run through the %s CLI output shape",
    async (outputMode) => {
      const root = await temporary.create("docsfab-continuation-output-");
      const repository = join(root, "repository");
      const stateDirectory = join(root, "state", "runs");
      await mkdir(repository, { recursive: true });
      await writeFile(join(repository, "README.md"), "# Continuation output fixture\n");
      await writeFile(
        join(repository, ".docsfab.json"),
        `${JSON.stringify({
          schemaVersion: 1,
          gitlab: { remote: "origin", defaultBranch: "main" },
          provider: { configuration: "host" },
          storage: { scope: "user-private" },
        })}\n`,
      );
      await commitPrivateFixture(repository);
      const environment = {
        ...process.env,
        DOCSFAB_FIXTURE_REPOSITORY: repository,
        DOCSFAB_FIXTURE_STATE: stateDirectory,
        DOCSFAB_FIXTURE_WORKFLOW: "create-documentation",
        DOCSFAB_FIXTURE_TARGET: "docs/behavior.md",
        DOCSFAB_KNOWLEDGE_DIR: knowledgeRoot,
        DOCSFAB_OPERATOR_AUTHORITY_ID: "fixture-cli-operator",
        DOCSFAB_FIXTURE_OUTPUT: outputMode,
      };
      const result = await expectExitTwo(tsx, [child, "stop"], runtimeRoot, environment);
      if (outputMode === "silent") {
        expect(result.stdout).toBe("");
        return;
      }
      if (outputMode === "json") {
        const json = JSON.parse(result.stdout) as Record<string, any>;
        expect(json).toMatchObject({
          kind: "docsfab-run-result",
          execution: { status: "needs-input", exitCode: 2 },
        });
        expect(json.nextSteps.join("\n")).toContain("--resume-from");
        expect(result.stdout).not.toContain("Write `docs/");
        return;
      }
      expect(result.stdout).toContain("VERDICT");
      expect(result.stdout).toContain("NEXT");
      expect(result.stdout).toContain("RECORD");
      expect(result.stdout).toContain("--resume-from");
      expect(result.stdout).not.toContain("Write `docs/");
    },
    testTimeoutMs(60_000),
  );
});

async function ordinaryMultiPageKnowledgeDirectory(): Promise<string> {
  const root = await temporary.create("docsfab-ordinary-multi-page-knowledge-");
  const sourceDirectory = join(root, "src");
  await mkdir(sourceDirectory, { recursive: true });
  await writeFile(
    join(sourceDirectory, "first-pass.mjs"),
    `export { gatherRepositoryFirstPass } from ${JSON.stringify(
      pathToFileURL(join(knowledgeRoot, "src", "first-pass.mjs")).href,
    )};\n`,
  );
  await writeFile(
    join(sourceDirectory, "first-pass-support.mjs"),
    `export { nonActionableNamedTargets, parseOrdinaryDocumentationRequest } from ${JSON.stringify(
      pathToFileURL(join(knowledgePackageRoot, "src", "first-pass-support.mjs")).href,
    )};\n`,
  );
  return root;
}

/** Initialize and commit an owner-only fixture checkout from the files already written into it. */
async function commitPrivateFixture(repository: string): Promise<string> {
  await chmod(repository, 0o700);
  await initFixtureRepo(repository);
  return await commitFixture(repository);
}

async function applyKnowledgeAnswer(
  root: string,
  priorSnapshotBytes: string,
  answer: object,
): Promise<{
  snapshot: Record<string, any>;
  snapshotPath: string;
  priorSnapshotSha256: string;
  answeredClaimId: string;
}> {
  const knowledgeJob = await mkdtemp(join(root, "knowledge-answer-"));
  const priorPath = join(knowledgeJob, "prior-snapshot.json");
  const answerPath = join(knowledgeJob, "attributed-answer.json");
  const snapshotPath = join(knowledgeJob, "attributed-snapshot.json");
  await writeFile(priorPath, priorSnapshotBytes);
  await writeFile(answerPath, `${JSON.stringify(answer, null, 2)}\n`);
  const completed = await exec(
    process.execPath,
    [
      knowledgeCli,
      "apply-answer",
      "--snapshot",
      priorPath,
      "--answer",
      answerPath,
      "--output",
      snapshotPath,
    ],
    { cwd: knowledgePackageRoot },
  );
  const result = JSON.parse(completed.stdout) as {
    priorSnapshotSha256: string;
    answeredClaimId: string;
  };
  return {
    snapshot: JSON.parse(await readFile(snapshotPath, "utf8")) as Record<string, any>,
    snapshotPath,
    priorSnapshotSha256: result.priorSnapshotSha256,
    answeredClaimId: result.answeredClaimId,
  };
}

async function expectExitTwo(
  executable: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<{ stdout: string; stderr: string }> {
  try {
    await exec(executable, args, { cwd, env });
  } catch (error) {
    const failed = error as { code?: number; stdout?: string; stderr?: string };
    expect(failed.code, JSON.stringify({ stdout: failed.stdout, stderr: failed.stderr })).toBe(2);
    return { stdout: failed.stdout ?? "", stderr: failed.stderr ?? "" };
  }
  throw new Error("Expected the stopped continuation process to exit 2.");
}

async function expectExitOne(
  executable: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  message: RegExp,
): Promise<void> {
  try {
    await exec(executable, args, { cwd, env });
  } catch (error) {
    const failed = error as { code?: number; stdout?: string; stderr?: string };
    expect(failed.code).toBe(1);
    expect(`${failed.stdout ?? ""}\n${failed.stderr ?? ""}`).toMatch(message);
    return;
  }
  throw new Error("Expected the invalid continuation process to exit 1.");
}

async function killAtBarrier(
  executable: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  readyPath: string,
): Promise<void> {
  const process = spawn(executable, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  process.stdout.on("data", (chunk) => {
    stdout += String(chunk);
  });
  process.stderr.on("data", (chunk) => {
    stderr += String(chunk);
  });
  const exited = once(process, "exit");
  const deadline =
    Date.now() +
    nestedDeadlineMs(
      limit("test.applicationExecutionTimeoutMs").value,
      limit("test.ciTimeoutMs").value,
    );
  while (true) {
    if (
      await access(readyPath)
        .then(() => true)
        .catch(() => false)
    )
      break;
    if (process.exitCode !== null || process.signalCode !== null) {
      await exited;
      throw new Error(
        `Continuation delivery child exited before its barrier: code=${process.exitCode} signal=${process.signalCode} stderr=${stderr} stdout=${stdout}`,
      );
    }
    if (Date.now() >= deadline) {
      process.kill("SIGKILL");
      await exited;
      throw new Error(
        `Timed out waiting for the continuation delivery crash barrier: code=${process.exitCode} signal=${process.signalCode} stderr=${stderr} stdout=${stdout}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  process.kill("SIGKILL");
  const [code, signal] = (await exited) as [number | null, NodeJS.Signals | null];
  expect(code).toBeNull();
  expect(signal).toBe("SIGKILL");
}

async function latestJournalEntry(
  root: string,
  originalRunId: string,
): Promise<Record<string, any>> {
  const names = (await readdir(root))
    .filter((name) => name.startsWith(`${originalRunId}.`) && name.endsWith(".json"))
    .sort();
  return JSON.parse(await readFile(join(root, names.at(-1)!), "utf8")) as Record<string, any>;
}
