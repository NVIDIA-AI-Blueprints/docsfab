// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { approvedModelFixture, stageModelFixture } from "./helpers/hosted-approved-model.js";
import { runHostedWorkflow } from "../src/host-invoker/workflow-runner.js";
import { assembleHostedFoundationToPatch } from "../src/host-invoker/native-foundation-patch.js";
import { prepareNativeAuthoringRequest } from "../src/host-invoker/native-authoring.js";
import { createHostedNativeCandidate } from "../src/host-invoker/native-candidate.js";
import { inspectHostedFoundation } from "../src/foundation/hosted.js";
import { DurableArtifactStore, opaqueRecordDigest } from "../src/artifacts/store.js";
import { prepareRepositoryWorkspace } from "../src/repository/workspace/materialize.js";
import { inspectHostedWorkflowCatalog } from "../src/host-invoker/workflow-catalog.js";
import { HOST_RUNTIME_WRITE_FILE_MODE } from "../src/host-invoker/write-authority.js";
import { sealHostRuntimeNativeTask } from "../src/host-invoker/native-task.js";
import { sealHostRuntimeNativeCustody } from "../src/host-invoker/native-custody.js";
import {
  digest,
  parseHostRuntimeRequest,
  sealHostRuntimeComposition,
  sealHostRuntimeWriteAuthority,
  sealHostRuntimeTerminal,
  parseHostRuntimeTerminalWire,
} from "../src/host-invoker/contracts.js";
import { testTimeoutMs } from "./helpers/test-timeouts.js";
import {
  createHostedCreateFixture,
  controlledHostedCreateHarness,
  HOSTED_CREATE_TARGET as target,
  HOSTED_CREATE_PAGE as page,
} from "./helpers/hosted-create.js";

type CustodyInput = Parameters<typeof sealHostRuntimeNativeCustody>[0]["inputs"][number];

const REPOSITORY_IDENTITY = digest({ repository: "fixture-api" });
const fixtures: Awaited<ReturnType<typeof createHostedCreateFixture>>[] = [];
afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((f) => f.cleanup()));
});
async function fixture(
  options: {
    /**
     * Drops both the approved canon and the staged baseline: custody naming an
     * approved model without its canon is its own refusal (`foundation/hosted.ts`).
     */
    withoutApprovedInputs?: boolean;
    intendedPaths?: string[];
    allowWrite?: boolean;
    /**
     * Binds one admitted native input as the dispatcher would: the receipt
     * locator carries the deployment binding digest, and the custody row names
     * the artifact digest the task selects.
     */
    withAdmittedInput?: boolean;
    /** Outer grant ceiling; defaults to the fixture's exact single target. */
    pathCeiling?: string[];
    /**
     * Files the outer grant already measured. The dispatcher fills this with
     * every blob under the ceiling (`listCeilingTargets`); the default `[]`
     * leaves nothing to narrow, so the narrowing test supplies real entries.
     */
    targetPaths?: string[];
  } = {},
) {
  const f = await createHostedCreateFixture({
    sourceFiles: {
      "AGENTS.md": "# Repository instructions\nDocument only observed API behavior.\n",
    },
  });
  fixtures.push(f);
  const workflow = "foundation-to-patch",
    catalog = inspectHostedWorkflowCatalog(workflow);
  const { compositionSha256: _digest, ...body } = f.request.composition;
  const composition = sealHostRuntimeComposition({ ...body, declaredTools: catalog.declaredTools });
  const { canon, baseline } = approvedModelFixture();
  const projectId = baseline.projectId;
  const binding = {
    deploymentId: f.request.deploymentId,
    projectId,
    deploymentEpoch: f.request.deploymentEpoch,
  };
  const receiptSha256 = "1".repeat(64),
    contentSha256 = "2".repeat(64),
    receiptLocator = `cas:${digest(binding).slice(0, 32)}:${receiptSha256}`;
  const admittedInputs: readonly CustodyInput[] = options.withAdmittedInput
    ? [
        {
          recordKey: "3".repeat(64),
          contentSha256,
          bytes: 1,
          source: {
            requestKey: f.request.requestKey,
            runId: f.request.runId,
            principalId: f.request.origin.principalId,
            workflow,
            revision: f.request.revision,
            repositoryIdentitySha256: REPOSITORY_IDENTITY,
            receiptLocator,
            receiptSha256,
          },
        },
      ]
    : [];
  const task = sealHostRuntimeNativeTask({
    workflow,
    task: { kind: workflow, intendedPaths: options.intendedPaths ?? [target] },
    inputs: admittedInputs.map((input) => ({
      receiptLocator: input.source.receiptLocator,
      artifactSha256: input.contentSha256,
    })),
  });
  const approvedModel = options.withoutApprovedInputs
    ? undefined
    : await stageModelFixture(f.state, baseline);
  const toolPolicySha256 = digest({
    workflow,
    stepIds: catalog.stepIds,
    declaredTools: catalog.declaredTools,
  });
  const { authoritySha256: _grantDigest, ...grant } = f.request.writeAuthority!;
  const request = parseHostRuntimeRequest({
    ...f.request,
    projectId,
    workflow,
    stepIds: catalog.stepIds,
    composition,
    toolPolicySha256,
    ...(options.allowWrite === undefined ? {} : { allowWrite: options.allowWrite }),
    packet: {
      ...f.request.packet,
      canon: options.withoutApprovedInputs ? null : canon,
      nativeTask: task,
    },
    nativeCustody: sealHostRuntimeNativeCustody({
      task,
      binding: {
        deploymentId: f.request.deploymentId,
        projectId,
        deploymentEpoch: f.request.deploymentEpoch,
      },
      repositoryIdentitySha256: REPOSITORY_IDENTITY,
      approvedCanonSha256: canon.sha256,
      ...(approvedModel ? { approvedModel } : {}),
      inputs: admittedInputs,
    }),
    writeAuthority: sealHostRuntimeWriteAuthority({
      ...grant,
      ...(options.pathCeiling ? { pathCeiling: options.pathCeiling } : {}),
      ...(options.targetPaths
        ? {
            targets: options.targetPaths.map((path) => ({
              path,
              operations: ["add"] as const,
              preimageObjectId: null,
              fileMode: HOST_RUNTIME_WRITE_FILE_MODE,
            })),
          }
        : {}),
      projectId,
      workflow,
      writeStepIds: catalog.writeStepIds,
      compositionSha256: composition.compositionSha256,
      toolPolicySha256,
    }),
  });
  return { ...f, request };
}
/**
 * The nested CREATE run writes no content-addressed artifact of its own, so the
 * harness writes one into the child's private store while the child executes.
 * Only the runner's `retainNativeAuthoringArtifacts` call moves it into the
 * parent store before the attempt directory is removed.
 */
const CHILD_ARTIFACT = Object.freeze({
  schemaVersion: 1,
  kind: "docsfab-fixture-child-artifact",
  note: "written inside the nested authoring attempt",
});
const CHILD_ARTIFACT_DIGEST = opaqueRecordDigest(CHILD_ARTIFACT);

function harnessWritingOneChildArtifact(
  controlled: ReturnType<typeof controlledHostedCreateHarness>,
  outerState: string,
) {
  // `prepareNativeAuthoringRequest` names the child's private state
  // `<outer state>/authoring-state`.
  const childArtifacts = join(outerState, "authoring-state", "artifacts");
  return {
    inspectSkill: controlled.harness.inspectSkill?.bind(controlled.harness),
    async runStep(input: Parameters<typeof controlled.harness.runStep>[0]) {
      if (input.step.id !== "write-documentation") return controlled.harness.runStep(input);
      await new DurableArtifactStore(childArtifacts).putRecord(
        CHILD_ARTIFACT_DIGEST,
        CHILD_ARTIFACT,
      );
      // The child calls `write`, which the outer step does not grant; the sealed
      // terminal admits it only because the outer declaration unions the
      // child's declared tools.
      const answer = await controlled.harness.runStep(input);
      return {
        ...answer,
        tools: {
          totalCalls: 1,
          failedCalls: 0,
          byTool: [{ name: "write", calls: 1, failures: 0 }],
        },
      };
    },
  };
}

async function retained(state: string) {
  const root = join(state, "artifacts", "objects", "sha256");
  return Promise.all(
    (await readdir(root)).map(async (name) => JSON.parse(await readFile(join(root, name), "utf8"))),
  );
}

describe("hosted Foundation-to-patch composition", () => {
  it("inspects actual canon and executes real nested authoring, checks, review and scoped transfer", {
    timeout: testTimeoutMs(120_000),
  }, async () => {
    const f = await fixture(),
      controlled = controlledHostedCreateHarness(f.request);
    const result = await runHostedWorkflow({
      request: f.request,
      credential: null,
      emit() {},
      executionHarness: harnessWritingOneChildArtifact(controlled, f.state),
    });
    expect(result.record.status, result.record.error).toBe("succeeded");
    // The child's artifact survived its attempt directory.
    await expect(
      new DurableArtifactStore(join(f.state, "artifacts")).getRecord(CHILD_ARTIFACT_DIGEST),
    ).resolves.toEqual(CHILD_ARTIFACT);
    expect(result.patchEvidence?.changes.map((change) => change.path)).toEqual([target]);
    expect(await readFile(join(f.outer, target), "utf8")).toBe(page);
    expect((await f.git(["status", "--porcelain"])).stdout).toBe("");
    expect(controlled.calls.map((call) => call.step.id)).toContain("verify-technical-accuracy");
    expect(controlled.calls.every((call) => call.instruction?.includes(target))).toBe(true);
    const inherited = approvedModelFixture().baseline.snapshot.claims[0]!.record.statement;
    expect(f.request.packet.canon?.content).not.toContain(inherited);
    expect(await readFile(join(f.source, "src/api.ts"), "utf8")).not.toContain(inherited);
    expect(controlled.calls.every((call) => call.instruction?.includes(inherited))).toBe(true);
    expect(
      controlled.calls.every(
        (call) =>
          call.instruction?.includes('"intent_approval":"approved"') &&
          call.instruction.includes('"behavior_verification":"not-checked"'),
      ),
    ).toBe(true);
    expect(
      controlled.calls.every(
        (call) =>
          call.instruction?.includes("CLAIM-INHERITED") && call.instruction.includes("CLAIM-DELTA"),
      ),
    ).toBe(true);
    expect(result.record.models.length).toBeGreaterThan(0);
    expect(result.record.tools.byTool.map((entry) => entry.name)).toContain("write");
    // The outer declaration covers the child's tools; the outer step alone does
    // not grant `write`, `edit` or `get_section`.
    const outerTools = inspectHostedWorkflowCatalog("foundation-to-patch").declaredTools;
    for (const tool of inspectHostedWorkflowCatalog("create-documentation").declaredTools)
      expect(outerTools).toContain(tool);
    expect(outerTools).toContain("write");
    expect(result.record.workflowOutcome?.disposition).toBe("inconclusive");
    const records = await retained(f.state),
      nested = records.find((value) => value.kind === "docsfab-native-authoring-run"),
      checkpoint = records.find((value) => value.kind === "docsfab-foundation-to-patch-run");
    expect(nested?.record.status).toBe("succeeded");
    expect(nested?.record.authoringExecution.selectedCandidate.ordinal).toBe(0);
    expect(records.some((value) => value.kind === "docsfab-native-authoring-impact")).toBe(true);
    expect(records.some((value) => value.kind === "docsfab-native-authoring-patch")).toBe(true);
    const validation = checkpoint?.checkpoint?.validation;
    expect(validation?.status).toBe(process.platform === "linux" ? "passed" : "unavailable");
    // Positive control for the review-mapping seam below: with both child
    // verdicts `pass`, the composition's adversarial status is `pass`.
    expect(checkpoint?.checkpoint?.adversarial?.status).toBe("pass");
    const terminal = sealHostRuntimeTerminal({
      request: f.request,
      status: "succeeded",
      runtimeRecord: result.record,
      patch: result.patch,
      patchEvidence: result.patchEvidence,
      editorialOutcome: result.editorialOutcome,
    });
    expect(
      parseHostRuntimeTerminalWire(JSON.parse(JSON.stringify(terminal)), f.request).status,
    ).toBe("succeeded");
    // This composition's host-operation step invokes a real authoring pipeline,
    // so a succeeded run that recorded no model is a substitution and is
    // refused. Host operations with no nested pipeline (`foundation`,
    // `ia-plan`) are admitted with zero models.
    expect(() =>
      sealHostRuntimeTerminal({
        request: f.request,
        status: "succeeded",
        runtimeRecord: { ...result.record, models: [] },
        patch: result.patch,
        patchEvidence: result.patchEvidence,
        editorialOutcome: result.editorialOutcome,
      }),
    ).toThrow("terminal-model-substitution");
  });
  // Model content fails open: the child's technical review returns
  // `human-review`, which the composition maps to adversarial `inconclusive`,
  // and still transfers the patch, because a patch is not a publish.
  it("degrades a non-passing child review to inconclusive and still transfers the patch", {
    timeout: testTimeoutMs(120_000),
  }, async () => {
    const f = await fixture(),
      controlled = controlledHostedCreateHarness(f.request, { technicalHumanReview: true });
    const result = await runHostedWorkflow({
      request: f.request,
      credential: null,
      emit() {},
      executionHarness: controlled.harness,
    });
    expect(result.record.status, result.record.error).toBe("succeeded");
    expect(result.patchEvidence?.changes.map((change) => change.path)).toEqual([target]);
    expect(await readFile(join(f.outer, target), "utf8")).toBe(page);
    const checkpoint = (await retained(f.state)).find(
      (value) => value.kind === "docsfab-foundation-to-patch-run",
    );
    expect(checkpoint?.checkpoint?.adversarial?.status).toBe("inconclusive");
    expect(checkpoint?.productDisposition).toBe("inconclusive");
  });

  it("keeps real Foundation questions without invoking the child or creating a patch", {
    timeout: testTimeoutMs(60_000),
  }, async () => {
    const f = await fixture({ withoutApprovedInputs: true }),
      controlled = controlledHostedCreateHarness(f.request);
    const result = await runHostedWorkflow({
      request: f.request,
      credential: null,
      emit() {},
      executionHarness: controlled.harness,
    });
    expect(result.record.status, result.record.error).toBe("needs-input");
    expect(controlled.calls).toEqual([]);
    expect(result.patch).toBeNull();
    await expect(stat(join(f.outer, target))).rejects.toMatchObject({ code: "ENOENT" });
    expect(
      (await retained(f.state)).some((value) => value.kind === "docsfab-foundation-inspect-result"),
    ).toBe(true);
  });
  // Guard A (`native-foundation-patch.ts`) puts several runtime-state
  // conditions behind one message. These drive a grant that is present but not
  // exercisable, and a task with admitted inputs this composition does not
  // accept; both must reach guard A's message, not guard B's or the nested
  // authoring refusal.
  it("refuses a grant the job may not exercise at the entry point the wire cannot reach", {
    timeout: testTimeoutMs(60_000),
  }, async () => {
    const f = await fixture();
    // Guard A's `!allowWrite` disjunct is reachable only in process: the runner
    // refuses an ungranted request before assembly because this workflow
    // installs a write step, and `allowWrite: false` with a grant does not
    // decode.
    const controlled = controlledHostedCreateHarness(f.request);
    await expect(
      runHostedWorkflow({
        request: parseHostRuntimeRequest({
          ...f.request,
          allowWrite: false,
          writeAuthority: null,
        }),
        credential: null,
        emit() {},
        executionHarness: controlled.harness,
      }),
    ).rejects.toThrow("Hosted write workflows require a separate operation-specific write grant.");
    expect(controlled.calls).toEqual([]);
    const { authoritySha256: _ignored, ...grant } = f.request.writeAuthority!;
    expect(() =>
      parseHostRuntimeRequest({
        ...f.request,
        allowWrite: false,
        writeAuthority: sealHostRuntimeWriteAuthority(grant),
      }),
    ).toThrow("write-authority-required");
    const workspace = await prepareRepositoryWorkspace(f.request.workspacePath, f.request.revision);
    try {
      await expect(
        assembleHostedFoundationToPatch({
          request: { ...f.request, allowWrite: false },
          workspace,
          inspect: () => {
            throw new Error("must not inspect before the grant check");
          },
          runAuthoring: () => {
            throw new Error("must not invoke the child before the grant check");
          },
        }),
      ).rejects.toThrow(
        "Hosted Foundation-to-patch requires its bound task, current canon custody, and separate write grant.",
      );
      // The same call with the grant exercisable assembles, so the refusal
      // above is the grant check.
      await expect(
        assembleHostedFoundationToPatch({
          request: f.request,
          workspace,
          inspect: () => {
            throw new Error("must not inspect during assembly");
          },
          runAuthoring: () => {
            throw new Error("must not invoke the child during assembly");
          },
        }),
      ).resolves.toMatchObject({ task: { kind: "foundation-to-patch" } });
    } finally {
      await workspace.dispose();
    }
    await expect(stat(join(f.outer, target))).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("refuses a bound task that carries admitted inputs this composition never consumes", {
    timeout: testTimeoutMs(60_000),
  }, async () => {
    const f = await fixture({ withAdmittedInput: true }),
      controlled = controlledHostedCreateHarness(f.request);
    await expect(
      runHostedWorkflow({
        request: f.request,
        credential: null,
        emit() {},
        executionHarness: controlled.harness,
      }),
    ).rejects.toThrow(
      "Hosted Foundation-to-patch requires its bound task, current canon custody, and separate write grant.",
    );
    expect(controlled.calls).toEqual([]);
    await expect(stat(join(f.outer, target))).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("narrows the child grant to the task's own intended paths and drops native custody", {
    timeout: testTimeoutMs(60_000),
  }, async () => {
    // The outer grant admits a whole directory and names two measured files;
    // the task intends one page.
    const f = await fixture({
      pathCeiling: ["docs/"],
      targetPaths: [target, "docs/other.md"],
    });
    expect(f.request.writeAuthority?.pathCeiling).toEqual(["docs/"]);
    expect(f.request.writeAuthority?.targets.map((entry) => entry.path)).toEqual([
      target,
      "docs/other.md",
    ]);
    const workspace = await prepareRepositoryWorkspace(f.request.workspacePath, f.request.revision);
    let candidate: Awaited<ReturnType<typeof createHostedNativeCandidate>> | undefined;
    try {
      const inspect = await inspectHostedFoundation({ request: f.request, workspace });
      expect(inspect.readiness).toBe("ready");
      candidate = await createHostedNativeCandidate({
        sourcePath: f.request.workspacePath,
        stateDirectory: f.request.stateDirectory,
        revision: f.request.revision,
        treeObjectId: f.request.sourceTreeObjectId,
      });
      const child = await prepareNativeAuthoringRequest({
        request: f.request,
        candidate,
        inspect,
        intendedPaths: [target],
      });
      expect(child.request.writeAuthority?.pathCeiling).toEqual([target]);
      // The measured target list is narrowed to the intended paths too.
      expect(child.request.writeAuthority?.targets.map((entry) => entry.path)).toEqual([target]);
      expect(child.request.writeAuthority?.workflow).toBe("create-documentation");
      expect(child.request.writeAuthority?.writeStepIds).toEqual(
        inspectHostedWorkflowCatalog("create-documentation").writeStepIds,
      );
      expect(child.request.workflow).toBe("create-documentation");
      expect(child.request.workspacePath).toBe(candidate.workspacePath);
      // Native input custody stays on the outer job; the child is a private
      // invocation, not a separately accepted one.
      expect(child.request.nativeCustody).toBeUndefined();
      expect(child.request.packet.nativeTask).toBeUndefined();
      // A path the outer ceiling does not admit reaches the second-line refusal,
      // whose message differs from guard B's.
      await expect(
        prepareNativeAuthoringRequest({
          request: f.request,
          candidate,
          inspect,
          intendedPaths: ["outside/guide.md"],
        }),
      ).rejects.toThrow(
        "Native authoring requires the ready foundation and exact outer source/write scope.",
      );
    } finally {
      await candidate?.dispose();
      await workspace.dispose();
    }
  });
  it("rejects task paths outside the installed grant before invoking the child", {
    timeout: testTimeoutMs(60_000),
  }, async () => {
    const f = await fixture({ intendedPaths: ["outside/guide.md"] }),
      controlled = controlledHostedCreateHarness(f.request);
    await expect(
      runHostedWorkflow({
        request: f.request,
        credential: null,
        emit() {},
        executionHarness: controlled.harness,
      }),
    ).rejects.toThrow("installed workflow write scope");
    expect(controlled.calls).toEqual([]);
    expect((await f.git(["status", "--porcelain"])).stdout).toBe("");
  });
});
