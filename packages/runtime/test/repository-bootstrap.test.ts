// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createConfinedToolSet } from "../src/harness/confined-tools.js";
import { createRepositoryBootstrapAdapter } from "../src/onboarding/bootstrap-adapter.js";
import { sha256 } from "../src/content-ir/canonical.js";
import { isRepositoryBootstrapGuidancePath } from "../src/onboarding/bootstrap-result.js";
import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createLocalWorkflowApplicationServices } from "../src/application/dependencies.js";
import { executeWorkflowApplication } from "../src/application/execute-workflow.js";
import type { AgentHarness, RunRequest } from "../src/execution/contracts.js";
import type { RunRecord } from "../src/records/contracts.js";
import { FileRunStore } from "../src/records/file-store.js";
import { GitPatchEvidenceCollector } from "../src/repository/evidence.js";
import { prepareRepositoryWorkspace } from "../src/repository/workspace/materialize.js";
import { verifyCatalogSkill } from "../src/skills/catalog-crate.js";
import { getWorkflow } from "../src/workflow-registry/catalog.js";
import {
  parseRepositoryBootstrapArtifact,
  REPOSITORY_BOOTSTRAP_RESULT_KIND,
  REPOSITORY_BOOTSTRAP_STEP,
} from "../src/onboarding/bootstrap-result.js";
import { runtimeConfig, hostedReadinessRequest } from "./support/execution-convergence.js";
import { withLocalWorkflowRun } from "../src/cli/run/local-workflow.js";
import { runHostedWorkflow } from "../src/host-invoker/workflow-runner.js";
import {
  digest,
  parseHostRuntimeRequest,
  sealHostRuntimeComposition,
  sealHostRuntimeWriteAuthority,
  sealHostRuntimeTerminal,
  parseHostRuntimeTerminalWire,
} from "../src/host-invoker/contracts.js";
import {
  HOST_RUNTIME_WRITE_MAXIMUM_TARGETS,
  HOST_RUNTIME_WRITE_MAXIMUM_PATCH_BYTES,
} from "../src/host-invoker/write-authority.js";
import { grantedTools } from "../src/harness/pi-tool-confine.js";
import { workflowOutcomePersistenceError } from "../src/workflow-contracts/run-recovery-presentation.js";
import { emptyWriteResultError } from "../src/workflow-execution/runner-schedule.js";
import { testTimeoutMs } from "./helpers/test-timeouts.js";
const exec = promisify(execFile),
  roots: string[] = [];
// Local wall-clock budget for one bootstrap case. Execution plumbing, not a
// product limit: every case initialises a real Git repository, materialises
// a workspace, applies a patch, and drives the evidence collector, so a case
// routinely exceeds the shared local default. Declared through testTimeoutMs
// so CI still floors it at config/limits.yaml test.ciTimeoutMs.
const BOOTSTRAP_CASE_MS = 60_000;
const fixtureRoot = fileURLToPath(
  new URL("./fixtures/runtime-evaluation/bootstrap-onboarding/", import.meta.url),
);
const contract = JSON.parse(await readFile(join(fixtureRoot, "contract.json"), "utf8")) as {
  cases: {
    id: string;
    repository: string;
    initialFiles: string[];
    evidenceSources: string[];
    decision: "patch" | "needs-input";
    expectedPatch: string | null;
    requiredPathsAfter: string[];
    requiredChanges: string[];
    preserveExactly: string[];
  }[];
};
const gitEnv = {
  PATH: process.env.PATH,
  HOME: "/dev/null",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_TERMINAL_PROMPT: "0",
};
async function git(repository: string, ...args: string[]) {
  return (
    await exec(
      "/usr/bin/git",
      ["-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", "-C", repository, ...args],
      { env: gitEnv },
    )
  ).stdout.trim();
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(
  id: string,
  options: {
    noChange?: boolean;
    allowWrite?: boolean;
    mutateResponse?: (value: any) => void;
    extraChange?: boolean;
    onCall?: () => void;
    hosted?: boolean;
    pathCeiling?: string[];
    noGrant?: boolean;
    cli?: boolean;
    emptyGuidance?: boolean;
    invalidUtf8Guidance?: boolean;
    /** The model cites without a read showing any line. */
    unread?: boolean;
    /** The confined tools refused this many out-of-scope edits. */
    mutationBoundaryDenials?: number;
    /** The model's whole reply, replacing the JSON result. */
    reply?: string;
  } = {},
) {
  const scenario = contract.cases.find((row) => row.id === id)!;
  const root = await realpath(await mkdtemp(join(tmpdir(), "docsfab-bootstrap-")));
  roots.push(root);
  const repository = join(root, "repository");
  await cp(join(fixtureRoot, scenario.repository), repository, { recursive: true });
  if (options.noChange) {
    await git(repository, "apply", join(fixtureRoot, scenario.expectedPatch!));
    await writeFile(
      join(repository, "README.md"),
      (await readFile(join(repository, "README.md"), "utf8")) +
        "\nPermission example: allowWrite=true is not an authorization. cafe\u0301.\n",
    );
  }
  if (options.cli)
    await writeFile(
      join(repository, ".docsfab.json"),
      JSON.stringify({
        schemaVersion: 1,
        gitlab: { remote: "origin", defaultBranch: "main" },
        provider: { configuration: "host" },
        storage: { scope: "user-private" },
      }),
    );
  await git(repository, "init", "-q");
  await git(repository, "config", "user.name", "Bootstrap fixture");
  await git(repository, "config", "user.email", "fixture@example.invalid");
  await git(repository, "add", ".");
  await git(repository, "commit", "-qm", "tracked guidance evidence");
  const revision = await git(repository, "rev-parse", "HEAD"),
    workspace = await prepareRepositoryWorkspace(repository, revision);
  const executionPath = options.hosted ? join(root, "hosted-scratch") : workspace.path;
  if (options.hosted)
    await git(repository, "clone", "--quiet", "--no-hardlinks", "--", repository, executionPath);
  const stateDirectory = join(root, "state", "runs"),
    config = runtimeConfig(stateDirectory);
  await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
  const collector = await GitPatchEvidenceCollector.create(executionPath, join(root, "patches"));
  const before = new Map(
    await Promise.all(
      [
        ...new Set([
          ...scenario.initialFiles,
          ...(options.noChange ? ["README.md", "AGENTS.md"] : []),
        ]),
      ].map(async (path) => [path, await readFile(join(executionPath, path), "utf8")] as const),
    ),
  );
  let calls = 0;
  let fixtureModel = { provider: "fixture", model: "controlled-bootstrap-author" };
  const harness: AgentHarness = {
    async inspectSkill(input) {
      return (
        await verifyCatalogSkill({
          skillCrateDirectory: config.skillCrateDirectory,
          skillId: input.step.skill,
          grantedTools: ["read", "grep", "find", "ls", "edit", "write"],
        })
      ).evidence;
    },
    async runStep(input) {
      calls++;
      options.onCall?.();
      const protocol = JSON.parse(input.instruction!.split("\n").at(-1)!);
      const evidencePaths = options.noChange ? [...before.keys()] : scenario.evidenceSources;
      // Cite each evidence file whole, from its first line to its last, as a
      // model that read it would; the host mints the exact text.
      const evidence = await Promise.all(
        evidencePaths.map(async (path) => {
          const text = await readFile(join(input.repositoryPath, path), "utf8");
          return { path, startLine: 1, endLine: text.replace(/\n$/u, "").split("\n").length };
        }),
      );
      const observedSourceLines = options.unread
        ? {}
        : Object.fromEntries(
            evidence.map((row) => [row.path, [[row.startLine, row.endLine] as const]]),
          );
      if (!options.noChange && scenario.expectedPatch)
        await git(input.repositoryPath, "apply", join(fixtureRoot, scenario.expectedPatch));
      if (options.invalidUtf8Guidance)
        await writeFile(join(input.repositoryPath, "README.md"), Buffer.from([0xff]));
      if (options.emptyGuidance) await writeFile(join(input.repositoryPath, "README.md"), "");
      if (options.extraChange)
        await writeFile(join(input.repositoryPath, "unrelated.txt"), "Unrequested mutation.\n");
      const response = {
        schemaVersion: 1,
        kind: REPOSITORY_BOOTSTRAP_RESULT_KIND,
        binding: protocol.binding,
        decision: options.noChange ? "no-change" : scenario.decision,
        summary: "Tracked evidence supports this guidance judgment.",
        changedPaths: options.noChange ? [] : scenario.requiredChanges,
        evidence,
        assumptions: [],
        missingEvidence:
          scenario.decision === "needs-input"
            ? ["A resolution of the conflicting parent and nested instructions."]
            : [],
        questions:
          scenario.decision === "needs-input"
            ? ["Should generated or hand-maintained guidance govern this directory?"]
            : [],
      };
      options.mutateResponse?.(response);
      return {
        summary: options.reply ?? JSON.stringify(response),
        model: fixtureModel,
        usage: { input: 11, output: 7, cacheRead: 0, cacheWrite: 0, total: 18, turns: 2 },
        tools: { totalCalls: 3, failedCalls: 0, byTool: [{ name: "read", calls: 3, failures: 0 }] },
        observedSourceLines,
        ...(options.mutationBoundaryDenials
          ? { mutationBoundaryDenials: options.mutationBoundaryDenials }
          : {}),
      };
    },
  };
  const request: RunRequest = {
    runId: `bootstrap-${id}`,
    workflow: "bootstrap",
    workspacePath: workspace.path,
    repository: { sourcePath: repository, requestedRevision: revision, revision },
    allowWrite: options.allowWrite ?? true,
    instruction: "Prepare only the minimum supported repository guidance.",
  };
  try {
    let hosted: Awaited<ReturnType<typeof runHostedWorkflow>> | undefined;
    let result, cliFiles: Map<string, string> | undefined;
    if (options.cli) {
      result = await withLocalWorkflowRun(
        {
          workflow: "bootstrap",
          instruction: request.instruction,
          repositoryPath: repository,
          revision,
          allowWrite: true,
          releaseGate: false,
          verbose: false,
          json: false,
          showScan: false,
        },
        config,
        { executionHarness: harness, silent: true, output: { log() {}, error() {} } },
        async (context) => {
          cliFiles = new Map(
            await Promise.all(
              [...new Set([...before.keys(), ...scenario.requiredPathsAfter])].map(
                async (path) =>
                  [path, await readFile(join(context.workspace.path, path), "utf8")] as const,
              ),
            ),
          );
          return { value: context.execution.record };
        },
      );
    } else if (options.hosted) {
      const tree = await git(executionPath, "rev-parse", "HEAD^{tree}");
      const base = hostedReadinessRequest({
        repository: executionPath,
        stateDirectory,
        revision,
        tree,
      });
      const workflow = getWorkflow("bootstrap"),
        stepIds = workflow.steps.map((step) => step.id);
      const declaredTools = [
        ...new Set(
          workflow.steps.flatMap((step) => grantedTools(step.mode, step.kind, step.search)),
        ),
      ].sort();
      const composition = sealHostRuntimeComposition({
        compositionId: "offline-bootstrap-fixture",
        route: "offline-fixture",
        credentialFamily: "none",
        executionProfile: null,
        declaredTools,
      });
      fixtureModel = {
        provider: "offline-fixture",
        model: composition.compositionSha256.slice(0, 16),
      };
      const toolPolicySha256 = digest({ workflow: "bootstrap", stepIds, declaredTools });
      const pathCeiling = options.pathCeiling ?? ["README.md", "AGENTS.md", "docs/AGENTS.md"];
      const targets = await Promise.all(
        [...before.keys()]
          .filter((path) => pathCeiling.includes(path))
          .map(async (path) => ({
            path,
            operations: ["modify", "delete"] as const,
            preimageObjectId: await git(executionPath, "rev-parse", `${revision}:${path}`),
            fileMode: "100644" as const,
          })),
      );
      const authority = options.noGrant
        ? null
        : sealHostRuntimeWriteAuthority({
            schemaVersion: 2,
            kind: "docsfab-host-runtime-write-authority",
            deploymentId: base.deploymentId,
            projectId: base.projectId,
            deploymentEpoch: base.deploymentEpoch,
            requestKey: base.requestKey,
            runId: base.runId,
            fence: base.fence,
            workflow: "bootstrap",
            sourceRevision: revision,
            sourceTreeObjectId: tree,
            pathCeiling,
            targets,
            writeStepIds: stepIds,
            capsuleSha256: base.capsule.sha256,
            compositionSha256: composition.compositionSha256,
            toolPolicySha256,
            expiresAt: base.capsule.expiresAt,
            limits: {
              maximumChangedPaths: HOST_RUNTIME_WRITE_MAXIMUM_TARGETS,
              maximumPatchBytes: HOST_RUNTIME_WRITE_MAXIMUM_PATCH_BYTES,
            },
          });
      const bound = parseHostRuntimeRequest({
        ...base,
        workflow: "bootstrap",
        stepIds,
        composition,
        toolPolicySha256,
        allowWrite: authority !== null,
        writeAuthority: authority,
      });
      hosted = await runHostedWorkflow({
        request: bound,
        credential: null,
        executionHarness: harness,
        emit() {},
      });
      result = hosted.record;
      const status = result.status;
      if (
        status !== "succeeded" &&
        status !== "failed" &&
        status !== "needs-input" &&
        status !== "needs-human-decision"
      ) {
        throw new Error("Hosted bootstrap did not return a terminal execution status.");
      }
      const terminal = sealHostRuntimeTerminal({
        request: bound,
        status,
        runtimeRecord: result,
        patch: hosted.patch,
        patchEvidence: hosted.patchEvidence,
        editorialOutcome: hosted.editorialOutcome,
      });
      const decoded = parseHostRuntimeTerminalWire(JSON.parse(JSON.stringify(terminal)), bound);
      expect(decoded.runRecord.binding.workflow).toBe("bootstrap");
      expect(decoded.runRecord.binding.revision).toBe(revision);
      expect(decoded.runRecord.runtimeRecord).toEqual(JSON.parse(JSON.stringify(result)));
      expect(decoded.patchEvidence).toEqual(hosted.patchEvidence);
    } else {
      const assembly = await createLocalWorkflowApplicationServices({
        config,
        request,
        workflow: getWorkflow("bootstrap"),
        workspace,
        repositoryEvidence: collector,
        baseHarness: harness,
      });
      result = await executeWorkflowApplication({ services: assembly.services, request });
    }
    if (!result) throw new Error("Bootstrap fixture did not return its execution record.");
    const retained = await new FileRunStore(stateDirectory).get(result.id);
    return {
      result,
      retained,
      calls,
      before,
      hosted,
      files:
        cliFiles ??
        new Map(
          await Promise.all(
            [
              ...new Set([
                ...before.keys(),
                ...(options.allowWrite === false ? [] : scenario.requiredPathsAfter),
              ]),
            ].map(
              async (path) => [path, await readFile(join(executionPath, path), "utf8")] as const,
            ),
          ),
        ),
      originalStatus: await git(repository, "status", "--porcelain"),
      patch: result.changes?.patch
        ? await readFile(result.changes.patch.artifactPath, "utf8")
        : null,
    };
  } finally {
    await collector.dispose();
    await workspace.dispose();
  }
}

/**
 * Drives the adapter's guidance re-read directly, because the workflow runner
 * replaces every bootstrap refusal code with one generic
 * `workflowOutcomePersistenceError` string on the outcome-projector path, so
 * only this seam can name the exact code. `null` removes the guidance file
 * instead of rewriting it, so the re-read raises a file system error rather
 * than a bootstrap refusal.
 */
async function guidanceDecodeProbe(
  readmeBytes: Uint8Array | string | null,
  mutateRecord: (record: any) => void = () => {},
) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "docsfab-bootstrap-decode-")));
  roots.push(root);
  const repository = join(root, "repository");
  await mkdir(repository, { recursive: true });
  await writeFile(join(repository, "README.md"), "Tracked guidance prose.\n");
  await writeFile(join(repository, "AGENTS.md"), "Tracked agent prose.\n");
  await git(repository, "init", "-q");
  await git(repository, "config", "user.name", "Bootstrap fixture");
  await git(repository, "config", "user.email", "fixture@example.invalid");
  await git(repository, "add", ".");
  await git(repository, "commit", "-qm", "tracked guidance evidence");
  const revision = await git(repository, "rev-parse", "HEAD"),
    workspace = await prepareRepositoryWorkspace(repository, revision);
  try {
    const workflow = getWorkflow("bootstrap"),
      step = workflow.steps.find((row) => row.id === REPOSITORY_BOOTSTRAP_STEP)!;
    const adapter = createRepositoryBootstrapAdapter({
      workspace,
      harness: {
        async runStep(input) {
          const protocol = JSON.parse(input.instruction!.split("\n").at(-1)!);
          return {
            summary: JSON.stringify({
              schemaVersion: 1,
              kind: REPOSITORY_BOOTSTRAP_RESULT_KIND,
              binding: protocol.binding,
              decision: "no-change",
              summary: "Tracked evidence supports this guidance judgment.",
              changedPaths: [],
              evidence: [
                { path: "README.md", startLine: 1, endLine: 1 },
                { path: "AGENTS.md", startLine: 1, endLine: 1 },
              ],
              assumptions: [],
              missingEvidence: [],
              questions: [],
            }),
            model: { provider: "fixture", model: "controlled-bootstrap-author" },
            observedSourceLines: { "README.md": [[1, 1]], "AGENTS.md": [[1, 1]] },
          };
        },
      },
    });
    const produced = await adapter.harness.runStep({
      runId: "bootstrap-decode",
      repositoryPath: workspace.path,
      workflow,
      step,
    });
    // Replace the guidance bytes only after admission, so the probe isolates
    // the post-execution re-read and nothing earlier in the journey.
    if (readmeBytes === null) await rm(join(workspace.path, "README.md"));
    else await writeFile(join(workspace.path, "README.md"), readmeBytes);
    const record = {
      id: "bootstrap-decode",
      workflow: "bootstrap",
      repository: { revision },
      steps: [
        {
          id: REPOSITORY_BOOTSTRAP_STEP,
          status: "succeeded",
          skill: "repo-bootstrap",
          mode: "write",
          summary: produced.summary,
        },
      ],
      changes: { files: [], patch: { byteLength: 0, sha256: sha256("") } },
    } as unknown as RunRecord;
    mutateRecord(record);
    return await adapter.emptyWriteResultAdmission.admit(record);
  } finally {
    await workspace.dispose();
  }
}

describe("repository bootstrap execution", () => {
  vi.setConfig({ testTimeout: testTimeoutMs(BOOTSTRAP_CASE_MS) });
  it("the actual mutation tools admit guidance and deny unrelated files before changing them", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "docsfab-bootstrap-tools-")));
    roots.push(root);
    await writeFile(join(root, "package.json"), "{}\n");
    const toolSet = await createConfinedToolSet({
      workspacePath: root,
      allowWrite: true,
      isWritePathAllowed: isRepositoryBootstrapGuidancePath,
    });
    const write = toolSet.definitions.find((tool) => tool.name === "write")!;
    const call = (path: string, content: string) =>
      write.execute("bootstrap-write", { path, content }, undefined, undefined, undefined as never);
    await call("README.md", "# Supported guidance\n");
    expect(await readFile(join(root, "README.md"), "utf8")).toBe("# Supported guidance\n");
    await expect(call("package.json", "changed")).rejects.toThrow("DocsFab denied");
    expect(await readFile(join(root, "package.json"), "utf8")).toBe("{}\n");
  });
  it("the installed bootstrap skill has the canonical write tools and refuses a read-only substitution", async () => {
    const config = runtimeConfig("unused");
    const skill = await verifyCatalogSkill({
      skillCrateDirectory: config.skillCrateDirectory,
      skillId: "repo-bootstrap",
      grantedTools: ["read", "grep", "find", "ls", "edit", "write"],
    });
    expect(skill.skill.toolPolicy.declared).toContain("write");
    await expect(
      verifyCatalogSkill({
        skillCrateDirectory: config.skillCrateDirectory,
        skillId: "repo-bootstrap",
        grantedTools: ["read", "grep", "find", "ls"],
      }),
    ).rejects.toThrow();
  });

  it.each(contract.cases)(
    "runs the real local application for $id and retains its evidence-bound outcome",
    async (scenario) => {
      const actual = await fixture(scenario.id);
      expect(actual.result.status, actual.result.error).toBe("succeeded");
      expect(actual.result.workflowOutcome?.disposition).toBe(
        scenario.decision === "needs-input" ? "needs-input" : "ready",
      );
      expect(actual.result.changes!.files.map((file) => file.path).sort()).toEqual(
        [...scenario.requiredChanges].sort(),
      );
      expect(actual.calls).toBe(1);
      expect(actual.retained).toEqual(actual.result);
      expect(actual.originalStatus).toBe("");
      for (const path of scenario.preserveExactly)
        expect(actual.files.get(path)).toBe(actual.before.get(path));
      for (const path of scenario.requiredPathsAfter)
        expect(actual.files.get(path)?.trim()).toBeTruthy();
      const retainedResult = parseRepositoryBootstrapArtifact(
        JSON.parse(actual.result.steps[0]!.summary!),
      );
      expect(retainedResult.binding.repositoryRevision).toBe(actual.result.repository.revision);
      expect(retainedResult.evidence.map((row) => row.path)).toEqual(scenario.evidenceSources);
      // Each retained quote is minted from the tracked original, not the edit.
      for (const row of retainedResult.evidence) {
        const original = actual.before.get(row.path);
        if (original !== undefined) expect(row.quote).toBe(original.replace(/\n$/u, ""));
      }
      expect(actual.patch?.length).toBe(
        scenario.decision === "needs-input" ? 0 : actual.result.changes!.patch!.byteLength,
      );
    },
  );
  it.each(contract.cases)(
    "runs hosted $id with actual Git preimages, scoped patch proof and retained result",
    async (scenario) => {
      const actual = await fixture(scenario.id, { hosted: true });
      expect(actual.result.status, actual.result.error).toBe("succeeded");
      expect(actual.result.workflowOutcome?.disposition).toBe(
        scenario.decision === "needs-input" ? "needs-input" : "ready",
      );
      expect(actual.hosted!.patchEvidence!.changes.map((row) => row.path).sort()).toEqual(
        [...scenario.requiredChanges].sort(),
      );
      // The collector uses full-index headers; the hosted proof abbreviates
      // display headers and separately retains complete pre/postimage objects.
      const body = (patch: string | null) => (patch ?? "").replace(/^index [^\n]+\n/gmu, "");
      expect(body(actual.hosted!.patch)).toBe(body(actual.patch));
      expect(actual.retained).toEqual(actual.result);
      expect(actual.originalStatus).toBe("");
      for (const path of scenario.preserveExactly)
        expect(actual.files.get(path)).toBe(actual.before.get(path));
    },
  );
  it("refuses hosted execution without its separate exact workflow grant", async () => {
    let calls = 0;
    await expect(
      fixture("absent", {
        hosted: true,
        noGrant: true,
        onCall: () => {
          calls++;
        },
      }),
    ).rejects.toThrow("write grant");
    expect(calls).toBe(0);
  });
  it("refuses a hosted candidate outside the protected exact guidance paths", async () => {
    await expect(fixture("absent", { hosted: true, pathCeiling: ["README.md"] })).rejects.toThrow();
  });
  it("keeps a hosted no-change result empty through Git patch recomputation", async () => {
    const actual = await fixture("absent", { hosted: true, noChange: true });
    expect(actual.result.status, actual.result.error).toBe("succeeded");
    expect(actual.hosted!.patch).toBeNull();
    expect(actual.hosted!.patchEvidence!.changes).toEqual([]);
    expect(actual.result.workflowOutcome?.disposition).toBe("ready");
  });
  it("runs the real local CLI admission adapter and retains a private guidance patch", async () => {
    const actual = await fixture("absent", { cli: true });
    expect(actual.result.status, actual.result.error).toBe("succeeded");
    expect(actual.result.workflowOutcome?.disposition).toBe("ready");
    expect(actual.result.changes!.files.map((file) => file.path).sort()).toEqual([
      "AGENTS.md",
      "README.md",
    ]);
    expect(actual.retained).toEqual(actual.result);
    expect(actual.originalStatus).toBe("");
  });
  it("refuses a fabricated no-change judgment without the required existing guidance", async () => {
    const actual = await fixture("absent", {
      mutateResponse(value) {
        value.decision = "no-change";
        value.changedPaths = [];
      },
    });
    expect(actual.result.status).toBe("failed");
    expect(actual.result.workflowOutcome?.disposition).not.toBe("ready");
  });
  it("refuses questions accompanied by actual repository edits", async () => {
    const actual = await fixture("absent", {
      mutateResponse(value) {
        value.decision = "needs-input";
        value.changedPaths = [];
        value.questions = ["Which policy should apply?"];
      },
    });
    expect(actual.result.status).toBe("failed");
    expect(actual.result.workflowOutcome).toBeUndefined();
  });
  it("refuses empty guidance files even when their changed paths match the declared patch", async () => {
    const actual = await fixture("absent", { emptyGuidance: true });
    expect(actual.result.status).toBe("failed");
    expect(actual.result.workflowOutcome).toBeUndefined();
  });
  it.each([false, true])(
    "refuses malformed UTF-8 guidance before retaining ready (hosted=%s)",
    async (hosted) => {
      const actual = await fixture("absent", { hosted, invalidUtf8Guidance: true });
      expect(actual.result.status).toBe("failed");
      // The runner replaces every bootstrap refusal code with this one public
      // string; `guidanceDecodeProbe` below names the exact code.
      expect(actual.result.error).toBe(workflowOutcomePersistenceError);
      expect(actual.result.workflowOutcome?.disposition).not.toBe("ready");
      expect(actual.originalStatus).toBe("");
    },
  );
  it("names non-text-guidance when the retained guidance bytes are not UTF-8", async () => {
    // 0xff never begins a UTF-8 sequence. Buffer.toString("utf8") would yield
    // a non-empty U+FFFD and admit the run. The port reports the refusal as a
    // value; the message it would have thrown is
    // "Repository bootstrap result refused: non-text-guidance."
    await expect(guidanceDecodeProbe(Uint8Array.from([0xff]))).resolves.toEqual({
      admitted: false,
      code: "repository-bootstrap-non-text-guidance",
    });
  });
  it("admits multi-byte UTF-8 guidance the fatal decoder must still accept", async () => {
    // Positive control for the same guarded path: decomposed non-ASCII bytes
    // are valid UTF-8, so the decode must not refuse them.
    await expect(guidanceDecodeProbe("Cafe\u0301 guidance \u2014 retained.\n")).resolves.toEqual({
      admitted: true,
    });
  });
  it("still names empty-or-changing-guidance for the adjacent empty-bytes condition", async () => {
    // Adjacent condition the decode branch must not handle: zero bytes decode
    // cleanly, so emptiness stays the earlier refusal.
    await expect(guidanceDecodeProbe(Uint8Array.from([]))).resolves.toEqual({
      admitted: false,
      code: "repository-bootstrap-empty-or-changing-guidance",
    });
  });
  it("propagates a file system fault from the guidance re-read instead of reporting a refusal", async () => {
    // Adjacent condition of the port's catch: an ENOENT from lstat is not a
    // bootstrap refusal, so it keeps propagating rather than becoming an
    // `admitted: false` report that names a cause the adapter never decided.
    await expect(guidanceDecodeProbe(null)).rejects.toThrow("ENOENT");
  });
  it("names unadmitted-result when the record revision leaves the admitted binding", async () => {
    // Guards the revision re-check inside admitted(): the step summary still
    // binds, and only the record's revision moved.
    await expect(
      guidanceDecodeProbe("Tracked guidance prose.\n", (record) => {
        record.repository.revision = "a".repeat(40);
      }),
    ).resolves.toEqual({ admitted: false, code: "repository-bootstrap-unadmitted-result" });
  });
  it("accepts no-change only with actual complete guidance, exact Unicode quotes and an empty patch", async () => {
    const actual = await fixture("absent", { noChange: true });
    expect(actual.result.status, actual.result.error).toBe("succeeded");
    expect(actual.result.workflowOutcome?.disposition).toBe("ready");
    expect(actual.patch).toBe("");
    expect(actual.result.steps[0]!.summary).toContain("allowWrite=true");
    expect(actual.result.steps[0]!.summary).toContain("cafe\u0301");
  });
  it("preserves the local absent-write-grant refusal before invoking the model", async () => {
    let calls = 0;
    await expect(
      fixture("absent", {
        allowWrite: false,
        onCall: () => {
          calls++;
        },
      }),
    ).rejects.toThrow("--allow-write");
    expect(calls).toBe(0);
  });
  it.each([
    [
      "foreign revision",
      (value: any) => {
        value.binding.repositoryRevision = "a".repeat(40);
      },
    ],
    [
      "untracked citation",
      (value: any) => {
        value.evidence[0].path = "foreign.json";
      },
    ],
    [
      "invented quote",
      (value: any) => {
        value.evidence[0].quote = "This claim has no tracked source.";
      },
    ],
  ] as const)("refuses %s instead of retaining ready", async (_name, mutateResponse) => {
    const actual = await fixture("absent", { mutateResponse });
    expect(actual.result.status).toBe("failed");
    expect(actual.result.workflowOutcome?.disposition).not.toBe("ready");
    expect(actual.originalStatus).toBe("");
  });
  it.each([
    [
      "a quoted, paraphrased citation",
      {
        mutateResponse: (value: any) => (value.evidence[0] = { path: "README.md", quote: "Guide" }),
      },
      "source-citation-locator-shape",
      "contract-shape",
    ],
    [
      "a line past the end of the file",
      { mutateResponse: (value: any) => (value.evidence[0].endLine += 2) },
      "source-citation-line-range",
      "model-content",
    ],
    ["a citation no read showed", { unread: true }, "source-citation-unobserved", "model-content"],
  ] as const)(
    "records %s as the coded citation rule with its attempt evidence (#1741)",
    async (_name, options, code, failureClass) => {
      const actual = await fixture("absent", { noChange: true, ...options });
      expect(actual.result.status).toBe("failed");
      expect(actual.result.failure?.code).toBe(code);
      // The class comes from the catalog rule, not the bootstrap family row.
      expect(actual.result.failure?.class).toBe(failureClass);
      const attempt = actual.result.steps[0]!.inference!.attempts.at(-1)!;
      expect(attempt).toMatchObject({
        outcome: "malformed-response",
        retryDecision: "declined",
      });
      expect(attempt.model).toBeDefined();
      expect(actual.result.workflowOutcome?.disposition).not.toBe("ready");
      expect(actual.originalStatus).toBe("");
    },
  );
  it.each([
    ["an out-of-scope edit the tools refused", { mutationBoundaryDenials: 1 }, "mutation-refused"],
    ["a reply that is not the JSON result", { reply: "I updated the guidance." }, "response-json"],
    [
      "no-change without evidence for every guidance file",
      { mutateResponse: (value: any) => (value.evidence = value.evidence.slice(0, 1)) },
      "unevidenced-no-change",
    ],
  ] as const)(
    "records %s on its attempt with the attempt's evidence and code (#1741, #1750)",
    async (_name, options, reason) => {
      const actual = await fixture("absent", { noChange: true, ...options });
      const code = `repository-bootstrap-${reason}`;
      expect(actual.result.status).toBe("failed");
      expect(actual.result.failure).toMatchObject({ code, class: "contract-shape" });
      const attempt = actual.result.steps[0]!.inference!.attempts.at(-1)!;
      // A refused model result, not a provider stop or a request never sent.
      expect(attempt).toMatchObject({
        outcome: "malformed-response",
        retryDecision: "declined",
        rejection: { code, location: "$" },
        usage: { input: 11, output: 7 },
        tools: { totalCalls: 3 },
      });
      expect(attempt.model).toBeDefined();
      expect(actual.originalStatus).toBe("");
    },
  );
  it("refuses changed-file disagreement even when the model declares a valid guidance patch", async () => {
    const actual = await fixture("absent", { extraChange: true });
    expect(actual.result.status).toBe("failed");
    expect(actual.result.workflowOutcome).toBeUndefined();
  });
  it.each([false, true])(
    "records a classified failure when the model declares a patch it never made (hosted=%s)",
    async (hosted) => {
      // Adjacent condition of the runner's admission branch: zero changed files
      // and a declared result that is not admissible. The branch must record it,
      // not raise it; the positive control for the same branch is the no-change
      // case above, which the port admits and the run succeeds.
      const actual = await fixture("absent", {
        hosted,
        noChange: true,
        mutateResponse(value) {
          value.decision = "patch";
          value.changedPaths = ["README.md"];
        },
      });
      expect(actual.result.status).toBe("failed");
      expect(actual.result.error).toBe(emptyWriteResultError);
      expect(actual.result.failure?.code).toBe("repository-bootstrap-changed-file-agreement");
      expect(actual.result.failure?.class).toBe("contract-shape");
      expect(actual.result.failure?.class).not.toBe("unknown");
      expect(actual.result.workflowOutcome).toBeUndefined();
      expect(actual.result.changes?.files ?? []).toEqual([]);
      expect(actual.originalStatus).toBe("");
    },
  );
  it("returns the declared-patch refusal through the local CLI adapter without rejecting", async () => {
    const actual = await fixture("absent", {
      cli: true,
      noChange: true,
      mutateResponse(value) {
        value.decision = "patch";
        value.changedPaths = ["README.md"];
      },
    });
    expect(actual.result.status).toBe("failed");
    expect(actual.result.error).toBe(emptyWriteResultError);
    expect(actual.result.failure?.code).toBe("repository-bootstrap-changed-file-agreement");
    expect(actual.result.failure?.class).toBe("contract-shape");
    expect(actual.retained).toEqual(actual.result);
    expect(actual.originalStatus).toBe("");
  });
});
