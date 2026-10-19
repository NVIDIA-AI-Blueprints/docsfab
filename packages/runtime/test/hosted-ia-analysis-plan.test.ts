// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { DurableArtifactStore } from "../src/artifacts/index.js";
import { catalogCapacity } from "../src/config/catalog-capacity.js";
import { buildContentIndex, canonicalDigest } from "../src/content-ir/index.js";
import type { HarnessStepInput } from "../src/execution/contracts.js";
import {
  sealHostRuntimeNativeTask,
  type HostRuntimeNativeInputReferenceV1,
  type HostRuntimeResolvedNativeInputV1,
} from "../src/host-invoker/native-task.js";
import {
  assembleHostedNativeOperations,
  decodeHostedNativeRetainedRecord,
} from "../src/host-invoker/native-operations.js";
import {
  assembleHostedIa,
  unwrapHostedIaPlanningInput,
  HOSTED_IA_ARTIFACT_STORE_OPTIONS,
  HOSTED_IA_PLANNING_PACKAGE_ALLOWANCE_BYTES,
  HOSTED_IA_PLANNING_RECORD_WRAPPER_BYTES,
  type HostedIaCustody,
} from "../src/ia/hosted.js";
import {
  IA_PACKAGE_ALLOWANCE_MAXIMUM_BYTES,
  IaPlanningInputProviderError,
  LocalIaPlanningInputProvider,
  provisionIaPlanningInputPackage,
} from "../src/ia/input-provider.js";
import { IA_ANALYSIS_OUTPUT_MAXIMUM_BYTES } from "../src/ia/lifecycle.js";
import { prepareRepositoryWorkspace } from "../src/repository/workspace/materialize.js";
import { modelSubmission } from "./helpers/ia-native-submission.js";
import { testTimeoutMs } from "./helpers/test-timeouts.js";
import { getWorkflow } from "../src/workflow-registry/catalog.js";
import { iaDiscoverySearch } from "../src/ia/discovery-search-plan.js";
import { documentationAuditSearch } from "../src/maturity/audit-search-plan.js";
import { documentationObservationSearch } from "../src/search/observation-search-plan.js";
import { sourceReadinessSearch } from "../src/readiness/workflow.js";
import { releaseDocumentationReadinessSearch } from "../src/readiness/release-workflow.js";
import { loadWorkflowManifestCatalog } from "../src/workflow-registry/manifest.js";
import { CatalogSkillCrateResolver } from "../src/skills/catalog-crate-resolver.js";
import { runHostedWorkflow } from "../src/host-invoker/workflow-runner.js";
import { inspectHostedWorkflowCatalog } from "../src/host-invoker/workflow-catalog.js";
import {
  describeHostRuntimeNativeInput,
  digest,
  parseHostRuntimeRequest,
  sealHostRuntimeComposition,
  sealHostRuntimeNativeCustody,
  sealHostRuntimeTerminal,
  type HostRuntimeNativeCustodyV1,
} from "../src/host-invoker/contracts.js";
import {
  canonicalDigest as custodyDigest,
  canonicalJson as custodyJson,
} from "../src/contract-kit/index.js";

const execFile = promisify(execFileCallback);
const roots: string[] = [];
const PROJECT_ROOT = resolve(import.meta.dirname, "..");
const NOW = new Date("2026-09-22T20:00:00.000Z");
const TASK = { kind: "ia-plan", scope: "site", mode: "create" } as const;
const IDENTITY = "1".repeat(64);
const ANALYSIS_RUN = "hosted-analysis";
/** Local budget for this suite; CI raises it through the catalogued default. */
const LOCAL_SUITE_TIMEOUT_MS = 120_000;
/** Every registered search plan except the one the IA manifests name. */
const SEARCH_PLANS_WITHOUT_IA = {
  "documentation-audit": documentationAuditSearch,
  "documentation-observation": documentationObservationSearch,
  "source-readiness": sourceReadinessSearch,
  "release-documentation-readiness": releaseDocumentationReadinessSearch,
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function nativeTask(
  workflow: "ia-analysis" | "ia-plan",
  inputs: readonly HostRuntimeNativeInputReferenceV1[] = [],
) {
  return sealHostRuntimeNativeTask({ workflow, task: TASK, inputs });
}

function stepInput(
  workflowName: "ia-analysis" | "ia-plan",
  repositoryPath: string,
): HarnessStepInput {
  const workflow = getWorkflow(workflowName);
  return {
    repositoryPath,
    workflow,
    step: workflow.steps[0]!,
    task: TASK,
    runId: workflowName === "ia-analysis" ? ANALYSIS_RUN : "hosted-planning",
  };
}

describe("hosted IA analysis and planning", {
  timeout: testTimeoutMs(LOCAL_SUITE_TIMEOUT_MS),
}, () => {
  it("registers the IA manifests against the governed discovery search plan", () => {
    // The default catalog resolves the manifest `searchPlan` string to the plan
    // object; the same manifests with this plan missing are refused by name
    // rather than producing a step with no search.
    expect(getWorkflow("ia-analysis").steps[0]!.search).toBe(iaDiscoverySearch);
    expect(getWorkflow("ia-plan").steps[0]!.search).toBe(iaDiscoverySearch);
    expect(getWorkflow("ia-analysis").steps[0]!.searchMode).toBe("observe");
    expect(() => loadWorkflowManifestCatalog({ searchPlans: SEARCH_PLANS_WITHOUT_IA })).toThrow(
      "searchPlan must name a registered runtime workflow search plan.",
    );
  });

  it("binds the retained analysis allowance to the catalogued limit at the limit and one over", async () => {
    // The refusal is driven by option injection so the boundary is exercised
    // without a 32 MiB fixture: at exactly the allowance the record is stored,
    // one byte over it is refused by its named code.
    expect(IA_ANALYSIS_OUTPUT_MAXIMUM_BYTES).toBe(catalogCapacity("ia.analysisOutputMaxBytes"));
    // One bounded store holds both the produced artifacts and the staged
    // records: the largest package the planning arm may write, plus the bytes
    // its retention wrapper adds, fits the catalogued store bound.
    expect(HOSTED_IA_PLANNING_RECORD_WRAPPER_BYTES).toBe(
      Buffer.byteLength(
        custodyJson({ schemaVersion: 1, kind: "docsfab-ia-planning-input", package: {} }),
        "utf8",
      ) - Buffer.byteLength(custodyJson({}), "utf8"),
    );
    expect(HOSTED_IA_PLANNING_PACKAGE_ALLOWANCE_BYTES).toBe(
      catalogCapacity("ia.packageAllowanceMaxBytes") - HOSTED_IA_PLANNING_RECORD_WRAPPER_BYTES,
    );
    expect(
      HOSTED_IA_PLANNING_PACKAGE_ALLOWANCE_BYTES + HOSTED_IA_PLANNING_RECORD_WRAPPER_BYTES,
    ).toBeLessThanOrEqual(catalogCapacity("ia.analysisOutputMaxBytes"));
    // It is larger than the default a caller gets by naming nothing.
    expect(HOSTED_IA_PLANNING_PACKAGE_ALLOWANCE_BYTES).toBeGreaterThan(
      catalogCapacity("ia.inputPackageMaxBytes"),
    );
    expect(HOSTED_IA_ARTIFACT_STORE_OPTIONS.maxArtifactBytes).toBe(
      catalogCapacity("ia.analysisOutputMaxBytes"),
    );
    // The retention decoder refuses bytes whose declared kind is not the kind
    // its producer named.
    expect(
      decodeHostedNativeRetainedRecord(
        "docsfab-ia-analysis-output",
        Buffer.from('{"kind":"docsfab-ia-analysis-output","runId":"r"}'),
      ),
    ).toEqual({ kind: "docsfab-ia-analysis-output", runId: "r" });
    for (const staged of ['{"kind":"docsfab-ia-planning-input"}', "{}", "[]", "null"])
      expect(
        () => decodeHostedNativeRetainedRecord("docsfab-ia-analysis-output", Buffer.from(staged)),
        staged,
      ).toThrow("Hosted native retention refused a record with a different declared package kind.");
    const root = await realpath(await mkdtemp(join(tmpdir(), "docsfab-ia-bounds-")));
    roots.push(root);
    const record = { kind: "docsfab-ia-analysis-output", runId: ANALYSIS_RUN };
    const size = Buffer.byteLength(JSON.stringify(record), "utf8");
    const key = createHash("sha256").update(ANALYSIS_RUN).digest("hex");
    await expect(
      new DurableArtifactStore(join(root, "under"), { maxArtifactBytes: size - 1 }).putRecord(
        key,
        record,
      ),
    ).rejects.toMatchObject({ code: "artifact-too-large" });
    const at = new DurableArtifactStore(join(root, "at"), { maxArtifactBytes: size });
    await at.putRecord(key, record);
    expect(await at.getRecord(key)).toEqual(record);
  });

  it("refuses a package allowance above the catalogued ceiling at the ceiling plus one", async () => {
    // The allowance is a catalogued bound, not a measured package size. One byte
    // over it is refused by name on the field that carried it, before any
    // package is written, so no multi-megabyte fixture is needed.
    expect(IA_PACKAGE_ALLOWANCE_MAXIMUM_BYTES).toBe(catalogCapacity("ia.packageAllowanceMaxBytes"));
    expect(IA_PACKAGE_ALLOWANCE_MAXIMUM_BYTES).toBeGreaterThan(
      catalogCapacity("ia.inputPackageMaxBytes"),
    );
    const fixture = await repositoryFixture();
    const packageRoot = await privateState(fixture.root, "allowance-packages");
    const reader = (maxPackageBytes: number) =>
      new LocalIaPlanningInputProvider({
        packageRoot,
        repositoryRevision: fixture.revision,
        repositoryIdentity: IDENTITY,
        maxPackageBytes,
        now: () => NOW,
      });
    for (const over of [
      IA_PACKAGE_ALLOWANCE_MAXIMUM_BYTES + 1,
      IA_PACKAGE_ALLOWANCE_MAXIMUM_BYTES * 4,
    ])
      expect(() => reader(over), String(over)).toThrow(
        new IaPlanningInputProviderError("package-too-large", "maxPackageBytes"),
      );
    // At the ceiling (the allowance the planning arm names) the same reader is
    // admitted; so is a smaller one.
    expect(reader(IA_PACKAGE_ALLOWANCE_MAXIMUM_BYTES)).toBeInstanceOf(LocalIaPlanningInputProvider);
    expect(reader(catalogCapacity("ia.inputPackageMaxBytes"))).toBeInstanceOf(
      LocalIaPlanningInputProvider,
    );
  });

  it("refuses a selected analysis over the catalogued analysis bound and admits it at the bound", async () => {
    // Over the bound the record is refused as `stale-output` before it is
    // parsed; at the bound it passes and is refused one gate later as
    // `invalid-output` for not being JSON, so the boundary sits at exactly the
    // catalogued value.
    const fixture = await repositoryFixture();
    const workspace = await prepareRepositoryWorkspace(fixture.repository, fixture.revision);
    try {
      for (const [size, expected] of [
        [IA_ANALYSIS_OUTPUT_MAXIMUM_BYTES + 1, "stale-output"],
        [IA_ANALYSIS_OUTPUT_MAXIMUM_BYTES, "invalid-output"],
      ] as const) {
        const bytes = Buffer.alloc(size, 0x20);
        const contentSha256 = createHash("sha256").update(bytes).digest("hex");
        const reference = {
          receiptLocator: `cas:${"a".repeat(32)}:${"b".repeat(64)}`,
          artifactSha256: contentSha256,
        };
        await expect(
          assembleHostedIa({
            nativeTask: nativeTask("ia-plan", [reference]),
            workspace,
            stateDirectory: await privateState(fixture.root, `bound-${size}`),
            projectRoot: PROJECT_ROOT,
            custody: {
              repositoryIdentitySha256: IDENTITY,
              artifactStore: new DurableArtifactStore(join(fixture.root, `store-${size}`)),
              async loadSelected() {
                return {
                  recordKey: "8".repeat(64),
                  bytes,
                  contentSha256,
                  source: {
                    requestKey: "analysis-request",
                    runId: ANALYSIS_RUN,
                    principalId: "fixture-member",
                    workflow: "ia-analysis",
                    revision: fixture.revision,
                    repositoryIdentitySha256: IDENTITY,
                    receiptLocator: reference.receiptLocator,
                    receiptSha256: "b".repeat(64),
                  },
                };
              },
              async retain() {
                throw new Error("nothing is retained for a refused selection");
              },
            },
            now: () => NOW,
          }),
          String(size),
        ).rejects.toThrow(expected);
      }
    } finally {
      await workspace.dispose();
    }
  });

  it("runs the real hosted analysis entry with typed task, governed search, and retained output", async () => {
    const fixture = await repositoryFixture();
    const stateDirectory = await privateState(fixture.root, "actual-hosted-analysis");
    const request = await requestForNative(fixture, "ia-analysis", stateDirectory);
    const resolver = new CatalogSkillCrateResolver(join(PROJECT_ROOT, "skill-crate"));
    const result = await runHostedWorkflow({
      request,
      credential: null,
      emit() {},
      executionHarness: {
        inspectSkill: (input) => resolver.resolveSkill(input),
        async runStep(input) {
          expect(input.task).toEqual(TASK);
          const index = await buildContentIndex({
            repositoryPath: input.repositoryPath,
            repositoryRevision: fixture.revision,
          });
          return { summary: JSON.stringify(modelSubmission(index)), outcome: "succeeded" };
        },
      },
    });
    expect(
      result.record.status,
      JSON.stringify({
        error: result.record.error,
        steps: result.record.steps.map((step) => ({
          id: step.id,
          error: step.error,
          status: step.status,
        })),
      }),
    ).toBe("succeeded");
    // The controlled inference fixture reports no provider/model usage. Its
    // domain output is valid, but it must not pass hosted inference terminal
    // admission by pretending to be a deterministic native operation.
    expect(() =>
      sealHostRuntimeTerminal({
        request,
        status: "succeeded",
        runtimeRecord: result.record,
        patch: null,
      }),
    ).toThrow("terminal-model-substitution");
    expect(result.patch).toBeNull();
    const objects = join(stateDirectory, "artifacts", "objects", "sha256");
    const values = await Promise.all(
      (await readdir(objects)).map(async (name) =>
        JSON.parse(await readFile(join(objects, name), "utf8")),
      ),
    );
    expect(values.find((value) => value.kind === "docsfab-ia-analysis-output")?.runId).toBe(
      ANALYSIS_RUN,
    );
    expect(
      (await execFile("git", ["-C", fixture.repository, "status", "--porcelain"])).stdout,
    ).toBe("");
  });

  it("seals a succeeded terminal for a real ia-plan job that makes no model call", async () => {
    // `ia-plan` is a host-operation job whose harness refuses inference, so a
    // successful run records zero models and the terminal policy must admit
    // that. The analysis output is staged the way the host stages an accepted
    // producer record, then the plan runs from that custody.
    const fixture = await repositoryFixture();
    const analysisState = await privateState(fixture.root, "e2e-analysis");
    const analysisRequest = await requestForNative(fixture, "ia-analysis", analysisState);
    const resolver = new CatalogSkillCrateResolver(join(PROJECT_ROOT, "skill-crate"));
    const analysis = await runHostedWorkflow({
      request: analysisRequest,
      credential: null,
      emit() {},
      executionHarness: {
        inspectSkill: (input) => resolver.resolveSkill(input),
        async runStep(input) {
          const index = await buildContentIndex({
            repositoryPath: input.repositoryPath,
            repositoryRevision: fixture.revision,
          });
          return { summary: JSON.stringify(modelSubmission(index)), outcome: "succeeded" };
        },
      },
    });
    expect(analysis.record.status, JSON.stringify(analysis.record.error ?? null)).toBe("succeeded");
    const analysisBytes = await retainedRecordBytes(analysisState, "docsfab-ia-analysis-output");
    const planState = await privateState(fixture.root, "e2e-plan");
    const staged = await stageNativeInput({
      stateDirectory: planState,
      bytes: analysisBytes,
      runId: ANALYSIS_RUN,
      workflow: "ia-analysis",
      revision: fixture.revision,
    });
    const planRequest = await requestForNative(fixture, "ia-plan", planState, {
      inputs: [staged.reference],
      custodyInputs: [staged.custodyInput],
      runId: "hosted-plan-run",
    });
    const plan = await runHostedWorkflow({
      request: planRequest,
      credential: null,
      emit() {},
      executionHarness: {
        inspectSkill: (input) => resolver.resolveSkill(input),
        async runStep() {
          throw new Error("unexpected model call");
        },
      },
    });
    expect(
      plan.record.status,
      JSON.stringify({
        error: plan.record.error,
        steps: plan.record.steps.map((step) => ({ id: step.id, error: step.error })),
      }),
    ).toBe("succeeded");
    expect(plan.record.models).toEqual([]);
    const kinds = (await retainedRecords(planState)).map((value) => value.kind);
    expect(kinds).toContain("ia-plan");
    expect(kinds).toContain("docsfab-ia-planning-input");
    const terminal = sealHostRuntimeTerminal({
      request: planRequest,
      status: "succeeded",
      runtimeRecord: plan.record,
      patch: null,
    });
    expect(terminal.status).toBe("succeeded");
    expect(terminal.runRecord.binding.nativeTaskSha256).toBe(
      planRequest.packet.nativeTask?.taskSha256,
    );
    expect(terminal.runRecord.binding.nativeCustodySha256).toBe(
      planRequest.nativeCustody?.custodySha256,
    );
    // The same zero-model record sealed against the `ia-analysis` request,
    // whose installed manifest declares an inference step, is refused.
    expect(() =>
      sealHostRuntimeTerminal({
        request: analysisRequest,
        status: "succeeded",
        runtimeRecord: { ...analysis.record, models: [] },
        patch: null,
      }),
    ).toThrow("terminal-model-substitution");
  });

  it("refuses an analysis that selects an input and a plan that selects two", async () => {
    // Analysis starts from canonical query-only inputs, so any selection is a
    // command error; planning selects at most one prior analysis.
    const fixture = await repositoryFixture();
    const state = await privateState(fixture.root, "cardinality");
    const first = await stageNativeInput({
      stateDirectory: state,
      bytes: Buffer.from('{"kind":"docsfab-ia-analysis-output"}'),
      runId: ANALYSIS_RUN,
      workflow: "ia-analysis",
      revision: fixture.revision,
    });
    const second = await stageNativeInput({
      stateDirectory: state,
      bytes: Buffer.from('{"kind":"docsfab-ia-analysis-output","other":true}'),
      runId: "second-analysis",
      workflow: "ia-analysis",
      revision: fixture.revision,
      receiptSha256: "c".repeat(64),
    });
    for (const [workflow, inputs, custodyInputs] of [
      ["ia-analysis", [first.reference], [first.custodyInput]],
      ["ia-plan", [first.reference, second.reference], [first.custodyInput, second.custodyInput]],
    ] as const) {
      const request = await requestForNative(fixture, workflow, state, { inputs, custodyInputs });
      await expect(
        runHostedWorkflow({
          request,
          credential: null,
          emit() {},
          executionHarness: {
            async runStep() {
              throw new Error("unexpected model call");
            },
          },
        }),
        workflow,
      ).rejects.toThrow("invalid-command");
    }
  });

  it("refuses to assemble the IA arm for a sealed task that names another native job", async () => {
    // Helper-level defense: `request.ts` refuses a sealed task naming a
    // different workflow, so only an in-process caller of the exported helper
    // reaches this.
    const fixture = await repositoryFixture();
    const workspace = await prepareRepositoryWorkspace(fixture.repository, fixture.revision);
    const custody: HostedIaCustody = {
      repositoryIdentitySha256: IDENTITY,
      artifactStore: new DurableArtifactStore(join(fixture.root, "foreign-artifacts")),
      async loadSelected() {
        throw new Error("no selection");
      },
      async retain() {
        throw new Error("no retention");
      },
    };
    try {
      for (const foreign of [
        sealHostRuntimeNativeTask({
          workflow: "foundation",
          task: { kind: "foundation" },
          inputs: [],
        }),
        sealHostRuntimeNativeTask({
          workflow: "site-bootstrap",
          task: {
            kind: "site-bootstrap",
            plan: {
              kind: "ia-plan",
              schemaVersion: 1,
              digest: "a".repeat(64),
              repositoryRevision: fixture.revision,
              repositoryContentDigest: "9".repeat(64),
            },
          },
          inputs: [],
        }),
      ])
        await expect(
          assembleHostedIa({
            nativeTask: foreign,
            workspace,
            stateDirectory: await privateState(fixture.root, `foreign-${foreign.workflow}`),
            projectRoot: PROJECT_ROOT,
            custody,
            now: () => NOW,
          }),
          foreign.workflow,
        ).rejects.toThrow("invalid-command");
      const assembled = await assembleHostedIa({
        nativeTask: nativeTask("ia-plan"),
        workspace,
        stateDirectory: await privateState(fixture.root, "foreign-adjacent"),
        projectRoot: PROJECT_ROOT,
        custody,
        now: () => NOW,
      });
      expect(assembled.hostOperations).toBeDefined();
    } finally {
      await workspace.dispose();
    }
  });

  it("refuses an IA request whose bound task and custody the host never resolved", async () => {
    // The request contract accepts an `ia-analysis` request with neither a
    // native task nor custody (the pair rule refuses only one without the
    // other), so the arm's own guard is what refuses an unbound IA run.
    const fixture = await repositoryFixture();
    const stateDirectory = await privateState(fixture.root, "unbound-ia");
    const request = await requestForNative(fixture, "ia-analysis", stateDirectory);
    const { nativeTask: _task, ...packet } = request.packet;
    const { nativeCustody: _custody, ...rest } = request;
    const unbound = parseHostRuntimeRequest({ ...rest, packet });
    expect(unbound.packet.nativeTask).toBeUndefined();
    expect(unbound.nativeCustody).toBeUndefined();
    await expect(
      runHostedWorkflow({
        request: unbound,
        credential: null,
        emit() {},
        executionHarness: {
          async runStep() {
            throw new Error("unexpected model call");
          },
        },
      }),
    ).rejects.toThrow(
      "Hosted IA requires a read-only task with verified project artifact custody.",
    );
  });

  it("refuses an IA request that asserts write intent at the entry point the wire cannot reach", async () => {
    // Reachable only in process: `allowWrite: true` with no grant does not
    // decode (`request.ts`), and a real grant cannot bind because neither IA job
    // installs a write step. So this drives the assembly the runner calls
    // directly.
    const fixture = await repositoryFixture();
    const stateDirectory = await privateState(fixture.root, "write-intent-ia");
    const request = await requestForNative(fixture, "ia-plan", stateDirectory);
    expect(() => parseHostRuntimeRequest({ ...request, allowWrite: true })).toThrow(
      "write-authority-required",
    );
    expect(getWorkflow("ia-plan").steps.filter((step) => step.mode === "write")).toEqual([]);
    const workspace = await prepareRepositoryWorkspace(fixture.repository, fixture.revision);
    try {
      await expect(
        assembleHostedNativeOperations({
          request: { ...request, allowWrite: true },
          workspace,
          workflow: getWorkflow("ia-plan"),
        }),
      ).rejects.toThrow(
        "Hosted IA requires a read-only task with verified project artifact custody.",
      );
      // The same call, read-only, assembles, so the refusal above is the write
      // check.
      const assembled = await assembleHostedNativeOperations({
        request,
        workspace,
        workflow: getWorkflow("ia-plan"),
      });
      expect(assembled.hostOperations).toBeDefined();
      expect(assembled.harness).toBeDefined();
    } finally {
      await workspace.dispose();
    }
  });

  it("retains actual analysis through cleanup and creates a canonical plan", async () => {
    const fixture = await repositoryFixture();
    const analysisWorkspace = await prepareRepositoryWorkspace(
      fixture.repository,
      fixture.revision,
    );
    const analysisState = await privateState(fixture.root, "analysis-state");
    const recordsRoot = await privateState(fixture.root, "custody");
    const artifactStore = new DurableArtifactStore(join(recordsRoot, "artifacts"));
    let selected: HostRuntimeResolvedNativeInputV1 | undefined;
    const custody: HostedIaCustody = {
      repositoryIdentitySha256: IDENTITY,
      artifactStore,
      async loadSelected() {
        if (!selected) throw new Error("no selected analysis");
        return selected;
      },
      async retain(record) {
        await writeFile(join(recordsRoot, `${record.recordKind}.json`), record.bytes, {
          mode: 0o600,
        });
      },
    };
    const analysis = await assembleHostedIa({
      nativeTask: nativeTask("ia-analysis"),
      workspace: analysisWorkspace,
      stateDirectory: analysisState,
      projectRoot: PROJECT_ROOT,
      custody,
      now: () => NOW,
    });
    const index = await buildContentIndex({
      repositoryPath: analysisWorkspace.path,
      repositoryRevision: fixture.revision,
    });
    const analyzed = await analysis.wrapHarness!({
      runStep: async (input) => {
        expect(input.instruction).toContain("docsfab-ia-analysis-submission");
        expect(input.instruction).not.toContain("expectedNodeIds");
        return { summary: JSON.stringify(modelSubmission(index)), outcome: "succeeded" };
      },
    }).runStep(stepInput("ia-analysis", analysisWorkspace.path));
    expect(analyzed.outcome).toBe("succeeded");
    expect(analyzed.artifacts).toHaveLength(3);
    await analysisWorkspace.dispose();
    await rm(analysisState, { recursive: true, force: true });
    const bytes = await readFile(join(recordsRoot, "docsfab-ia-analysis-output.json"));
    const contentSha256 = createHash("sha256").update(bytes).digest("hex");
    const reference = {
      receiptLocator: `cas:${"a".repeat(32)}:${"b".repeat(64)}`,
      artifactSha256: contentSha256,
    };
    // The real dispatcher custody join is tested by its owner. This port fixture
    // supplies that authenticated metadata while domain packages and stores stay real.
    selected = {
      recordKey: "8".repeat(64),
      bytes,
      contentSha256,
      source: {
        requestKey: "analysis-request",
        runId: ANALYSIS_RUN,
        principalId: "fixture-member",
        workflow: "ia-analysis",
        revision: fixture.revision,
        repositoryIdentitySha256: IDENTITY,
        receiptLocator: reference.receiptLocator,
        receiptSha256: "b".repeat(64),
      },
    };
    const planningWorkspace = await prepareRepositoryWorkspace(
      fixture.repository,
      fixture.revision,
    );
    const planningState = await privateState(fixture.root, "planning-state");
    const originalSelection = selected;
    const invalidState = await privateState(fixture.root, "invalid-input-state");
    for (const [name, changed] of [
      [
        "wrong repository",
        { ...selected, source: { ...selected.source, repositoryIdentitySha256: "2".repeat(64) } },
      ],
      ["wrong revision", { ...selected, source: { ...selected.source, revision: "3".repeat(40) } }],
      ["wrong producer", { ...selected, source: { ...selected.source, runId: "another-run" } }],
      ["wrong workflow", { ...selected, source: { ...selected.source, workflow: "foundation" } }],
      [
        "substituted receipt",
        {
          ...selected,
          source: { ...selected.source, receiptLocator: `cas:${"c".repeat(32)}:${"d".repeat(64)}` },
        },
      ],
      ["altered bytes", { ...selected, bytes: Buffer.from("{}") }],
    ] as const) {
      selected = changed;
      await expect(
        assembleHostedIa({
          nativeTask: nativeTask("ia-plan", [reference]),
          workspace: planningWorkspace,
          stateDirectory: invalidState,
          projectRoot: PROJECT_ROOT,
          custody,
          now: () => NOW,
        }),
        name,
      ).rejects.toThrow("stale-output");
    }
    selected = originalSelection;
    const wrongKindBody = JSON.parse(Buffer.from(selected.bytes).toString("utf8"));
    wrongKindBody.kind = "docsfab-unrelated-output";
    const { digest: _wrongKindDigest, ...wrongKindUnsigned } = wrongKindBody;
    wrongKindBody.digest = canonicalDigest(wrongKindUnsigned);
    const wrongKindBytes = Buffer.from(JSON.stringify(wrongKindBody));
    const wrongKindHash = createHash("sha256").update(wrongKindBytes).digest("hex");
    selected = { ...selected, bytes: wrongKindBytes, contentSha256: wrongKindHash };
    await expect(
      assembleHostedIa({
        nativeTask: nativeTask("ia-plan", [{ ...reference, artifactSha256: wrongKindHash }]),
        workspace: planningWorkspace,
        stateDirectory: invalidState,
        projectRoot: PROJECT_ROOT,
        custody,
        now: () => NOW,
      }),
    ).rejects.toThrow("stale-output");
    selected = originalSelection;
    await expect(
      assembleHostedIa({
        nativeTask: sealHostRuntimeNativeTask({
          workflow: "ia-plan",
          task: { ...TASK, mode: "reevaluate" },
          inputs: [reference],
        }),
        workspace: planningWorkspace,
        stateDirectory: invalidState,
        projectRoot: PROJECT_ROOT,
        custody,
        now: () => NOW,
      }),
    ).rejects.toThrow("stale-output");
    const expiredBody = JSON.parse(Buffer.from(selected.bytes).toString("utf8"));
    expiredBody.inputPackage.expiresAt = NOW.toISOString();
    const { digest: _expiredDigest, ...expiredUnsigned } = expiredBody;
    expiredBody.digest = canonicalDigest(expiredUnsigned);
    const expiredBytes = Buffer.from(JSON.stringify(expiredBody));
    const expiredHash = createHash("sha256").update(expiredBytes).digest("hex");
    selected = { ...selected, bytes: expiredBytes, contentSha256: expiredHash };
    await expect(
      assembleHostedIa({
        nativeTask: nativeTask("ia-plan", [{ ...reference, artifactSha256: expiredHash }]),
        workspace: planningWorkspace,
        stateDirectory: invalidState,
        projectRoot: PROJECT_ROOT,
        custody,
        now: () => NOW,
      }),
    ).rejects.toThrow("expired");
    selected = originalSelection;

    const planned = await assembleHostedIa({
      nativeTask: nativeTask("ia-plan", [reference]),
      workspace: planningWorkspace,
      stateDirectory: planningState,
      projectRoot: PROJECT_ROOT,
      custody,
      now: () => NOW,
    });
    const planResult = await planned.hostOperations!.runStep(
      stepInput("ia-plan", planningWorkspace.path),
    );
    expect(planResult.outcome).toBe("succeeded");
    const planReference = planResult.artifacts.find(
      (use) => use.role === "output" && use.reference.kind === "ia-plan",
    )!.reference;
    expect((await artifactStore.get(planReference.digest)).kind).toBe("ia-plan");
    await planningWorkspace.dispose();
    await rm(planningState, { recursive: true, force: true });

    const planningRecord = JSON.parse(
      await readFile(join(recordsRoot, "docsfab-ia-planning-input.json"), "utf8"),
    );
    const planningValidation = {
      task: TASK,
      index: await buildContentIndex({
        repositoryPath: fixture.repository,
        repositoryRevision: fixture.revision,
      }),
      repositoryIdentity: IDENTITY,
      now: NOW,
    };
    const planningPackage = unwrapHostedIaPlanningInput(planningRecord, planningValidation);
    expect(planningPackage).not.toHaveProperty("kind");
    expect(() =>
      unwrapHostedIaPlanningInput(planningRecord, {
        ...planningValidation,
        repositoryIdentity: "f".repeat(64),
      }),
    ).toThrow("wrong-repository");
    expect(() =>
      unwrapHostedIaPlanningInput(planningRecord, {
        ...planningValidation,
        now: new Date(Number.NaN),
      }),
    ).toThrow("invalid-package");
    expect(() =>
      unwrapHostedIaPlanningInput({ ...planningRecord, kind: "unrelated" }, planningValidation),
    ).toThrow("invalid-output");
    expect(() =>
      unwrapHostedIaPlanningInput(
        { ...planningRecord, package: { ...planningPackage, digest: "f".repeat(64) } },
        planningValidation,
      ),
    ).toThrow("integrity-mismatch");
    // The approval receiver hydrates the retained package through its canonical
    // provisioner; no private worker filename becomes a task input.
    const restoredInput = await provisionIaPlanningInputPackage({
      packageRoot: join(recordsRoot, "ia-inputs", IDENTITY),
      repositoryPath: fixture.repository,
      repositoryIdentity: IDENTITY,
      task: TASK,
      index: await buildContentIndex({
        repositoryPath: fixture.repository,
        repositoryRevision: fixture.revision,
      }),
      input: planningPackage.input,
      expiresAt: planningPackage.expiresAt,
      now: NOW,
    });
    expect(restoredInput.digest).toBe(planningPackage.digest);
    // An allowance above the catalogued ceiling is refused rather than
    // honoured; at the ceiling, which the hosted arm names, it is provisioned.
    const restoreOptions = {
      packageRoot: join(recordsRoot, "ia-inputs", "allowance"),
      repositoryPath: fixture.repository,
      repositoryIdentity: IDENTITY,
      task: TASK,
      index: planningValidation.index,
      input: planningPackage.input,
      expiresAt: planningPackage.expiresAt,
      now: NOW,
    };
    await expect(
      provisionIaPlanningInputPackage({
        ...restoreOptions,
        maxPackageBytes: IA_PACKAGE_ALLOWANCE_MAXIMUM_BYTES + 1,
      }),
    ).rejects.toEqual(new IaPlanningInputProviderError("package-too-large", "maxPackageBytes"));
    // The refusal above is the ceiling, not a blanket rejection of a large
    // allowance.
    expect(
      (
        await provisionIaPlanningInputPackage({
          ...restoreOptions,
          maxPackageBytes: HOSTED_IA_PLANNING_PACKAGE_ALLOWANCE_BYTES,
        })
      ).digest,
    ).toBe(planningPackage.digest);
  });

  it("refuses a re-signed hosted analysis package whose explicit shape is wrong", async () => {
    // The hosted lineage reads bytes another job produced, so its shape checks
    // are explicit. Each case re-signs the mutated record, so only the shape
    // block can refuse it.
    const fixture = await repositoryFixture();
    const analysisState = await privateState(fixture.root, "shape-analysis");
    const analysisRequest = await requestForNative(fixture, "ia-analysis", analysisState);
    const resolver = new CatalogSkillCrateResolver(join(PROJECT_ROOT, "skill-crate"));
    const analysis = await runHostedWorkflow({
      request: analysisRequest,
      credential: null,
      emit() {},
      executionHarness: {
        inspectSkill: (input) => resolver.resolveSkill(input),
        async runStep(input) {
          const index = await buildContentIndex({
            repositoryPath: input.repositoryPath,
            repositoryRevision: fixture.revision,
          });
          return { summary: JSON.stringify(modelSubmission(index)), outcome: "succeeded" };
        },
      },
    });
    expect(analysis.record.status).toBe("succeeded");
    const original = JSON.parse(
      (await retainedRecordBytes(analysisState, "docsfab-ia-analysis-output")).toString("utf8"),
    );
    const workspace = await prepareRepositoryWorkspace(fixture.repository, fixture.revision);
    try {
      for (const [name, mutate] of [
        [
          "unnormalized expiry",
          (value: Record<string, never>) => {
            const pkg = value.inputPackage as unknown as { expiresAt: string };
            pkg.expiresAt = pkg.expiresAt.replace(/Z$/u, "+00:00");
          },
        ],
        [
          "non-SHA-256 input digest",
          (value: Record<string, never>) => {
            (value.inputPackage as unknown as { digest: string }).digest = "not-a-digest";
          },
        ],
        [
          "absent input package",
          (value: Record<string, unknown>) => {
            value.inputPackage = null;
          },
        ],
        [
          "absent artifact map",
          (value: Record<string, unknown>) => {
            value.artifacts = null;
          },
        ],
      ] as const) {
        const body = JSON.parse(JSON.stringify(original)) as Record<string, unknown>;
        mutate(body as never);
        delete body.digest;
        body.digest = canonicalDigest(body);
        const bytes = Buffer.from(JSON.stringify(body));
        const contentSha256 = createHash("sha256").update(bytes).digest("hex");
        const reference = {
          receiptLocator: `cas:${"a".repeat(32)}:${"b".repeat(64)}`,
          artifactSha256: contentSha256,
        };
        await expect(
          assembleHostedIa({
            nativeTask: nativeTask("ia-plan", [reference]),
            workspace,
            stateDirectory: await privateState(fixture.root, `shape-${contentSha256.slice(0, 8)}`),
            projectRoot: PROJECT_ROOT,
            custody: {
              repositoryIdentitySha256: IDENTITY,
              artifactStore: new DurableArtifactStore(join(fixture.root, "shape-artifacts")),
              async loadSelected() {
                return {
                  recordKey: "8".repeat(64),
                  bytes,
                  contentSha256,
                  source: {
                    requestKey: "analysis-request",
                    runId: ANALYSIS_RUN,
                    principalId: "fixture-member",
                    workflow: "ia-analysis",
                    revision: fixture.revision,
                    repositoryIdentitySha256: IDENTITY,
                    receiptLocator: reference.receiptLocator,
                    receiptSha256: "b".repeat(64),
                  },
                };
              },
              async retain() {
                throw new Error("nothing is retained for a refused selection");
              },
            },
            now: () => NOW,
          }),
          name,
        ).rejects.toThrow("invalid-output");
      }
    } finally {
      await workspace.dispose();
    }
  });

  it("returns the canonical missing-package result without leaking a private recovery command", async () => {
    const fixture = await repositoryFixture();
    const workspace = await prepareRepositoryWorkspace(fixture.repository, fixture.revision);
    try {
      const assembled = await assembleHostedIa({
        nativeTask: nativeTask("ia-plan"),
        workspace,
        stateDirectory: await privateState(fixture.root, "missing-input"),
        projectRoot: PROJECT_ROOT,
        custody: {
          repositoryIdentitySha256: IDENTITY,
          artifactStore: new DurableArtifactStore(join(fixture.root, "artifacts")),
          async loadSelected() {
            throw new Error("no reference was submitted");
          },
          async retain() {
            throw new Error("planning has no analysis output");
          },
        },
      });
      const result = await assembled.hostOperations!.runStep(stepInput("ia-plan", workspace.path));
      expect(result.outcome).toBe("needs-input");
      expect(result.summary).not.toContain(fixture.root);
      expect(result.artifacts).toEqual([]);
    } finally {
      await workspace.dispose();
    }
  });
});

/** Every record either IA job retained into this run's private artifact store. */
async function retainedRecords(stateDirectory: string): Promise<Record<string, unknown>[]> {
  const objects = join(stateDirectory, "artifacts", "objects", "sha256");
  return Promise.all(
    (await readdir(objects)).map(
      async (name) =>
        JSON.parse(await readFile(join(objects, name), "utf8")) as Record<string, unknown>,
    ),
  );
}

async function retainedRecordBytes(stateDirectory: string, kind: string): Promise<Buffer> {
  const objects = join(stateDirectory, "artifacts", "objects", "sha256");
  for (const name of await readdir(objects)) {
    const bytes = await readFile(join(objects, name));
    if ((JSON.parse(bytes.toString("utf8")) as { kind?: string }).kind === kind) return bytes;
  }
  throw new Error(`no retained ${kind} record under ${stateDirectory}`);
}

async function privateState(root: string, name: string): Promise<string> {
  const path = join(root, name);
  await mkdir(path, { mode: 0o700 });
  return path;
}

async function repositoryFixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "docsfab-hosted-ia-")));
  roots.push(root);
  const repository = await privateState(root, "repository");
  await chmod(repository, 0o700);
  for (const [name, text] of Object.entries({
    "README.md": "# Operators\n\nOperators connect and publish services.\n",
    "connect.md": "# Connect\n\nConnect a cluster endpoint before publishing.\n",
    "publish.md": "# Publish\n\nPublish a connected service.\n",
  }))
    await writeFile(join(repository, name), text);
  await execFile("git", ["init", "-q", repository]);
  await execFile("git", ["-C", repository, "add", "."]);
  await execFile("git", [
    "-C",
    repository,
    "-c",
    "user.name=DocsFab Test",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "-qm",
    "fixture",
  ]);
  const revision = (await execFile("git", ["-C", repository, "rev-parse", "HEAD"])).stdout.trim();
  return { root, repository, revision };
}

const BINDING = {
  deploymentId: "native-test",
  projectId: "native-project",
  deploymentEpoch: "epoch-one",
};

/**
 * Stage one accepted producer output the way the host does before a job runs:
 * private `<state>/native-inputs/<contentSha256>.json`, 0700 directories, 0600
 * file, and a `cas:<binding32>:<receiptSha256>` locator bound to this
 * deployment. Returns the task reference and the custody row for it.
 */
async function stageNativeInput(input: {
  stateDirectory: string;
  bytes: Buffer;
  runId: string;
  workflow: string;
  revision: string;
  receiptSha256?: string;
}) {
  const contentSha256 = createHash("sha256").update(input.bytes).digest("hex");
  const directory = join(input.stateDirectory, "native-inputs");
  await mkdir(directory, { mode: 0o700, recursive: true });
  await chmod(directory, 0o700);
  await writeFile(join(directory, `${contentSha256}.json`), input.bytes, { mode: 0o600 });
  await chmod(join(directory, `${contentSha256}.json`), 0o600);
  const receiptSha256 = input.receiptSha256 ?? "b".repeat(64);
  const receiptLocator = `cas:${custodyDigest(BINDING).slice(0, 32)}:${receiptSha256}`;
  const resolved: HostRuntimeResolvedNativeInputV1 = {
    recordKey: createHash("sha256").update(`record:${contentSha256}`).digest("hex"),
    contentSha256,
    bytes: input.bytes,
    source: {
      requestKey: "analysis-request",
      runId: input.runId,
      principalId: "fixture-member",
      workflow: input.workflow,
      revision: input.revision,
      repositoryIdentitySha256: IDENTITY,
      receiptLocator,
      receiptSha256,
    },
  };
  return {
    reference: { receiptLocator, artifactSha256: contentSha256 },
    custodyInput: describeHostRuntimeNativeInput(resolved),
    resolved,
  };
}

async function requestForNative(
  fixture: Awaited<ReturnType<typeof repositoryFixture>>,
  workflow: "ia-analysis" | "ia-plan",
  stateDirectory: string,
  selection: {
    inputs?: readonly HostRuntimeNativeInputReferenceV1[];
    custodyInputs?: HostRuntimeNativeCustodyV1["inputs"];
    runId?: string;
  } = {},
) {
  const binding = BINDING;
  const task = nativeTask(workflow, selection.inputs ?? []);
  const catalog = inspectHostedWorkflowCatalog(workflow);
  const capsule = {
    receiptSha256: "a".repeat(64),
    expiresAt: "2099-01-01T00:00:00.000Z",
    selectedEvidence: [
      { evidenceId: "approved-model", content: "Operators connect and publish services." },
    ],
  };
  const content = "{}",
    contentSha256 = createHash("sha256").update(content).digest("hex");
  return parseHostRuntimeRequest({
    schemaVersion: 1,
    kind: "docsfab-host-runtime-request",
    ...binding,
    requestKey: "hosted-analysis-request",
    origin: { principalId: "fixture-member", requestId: "message-one" },
    runId: selection.runId ?? ANALYSIS_RUN,
    fence: 1,
    workflow,
    revision: fixture.revision,
    sourceTreeObjectId: (
      await execFile("git", ["-C", fixture.repository, "rev-parse", "HEAD^{tree}"])
    ).stdout.trim(),
    packet: {
      packetFingerprintSha256: "b".repeat(64),
      inputManifest: {
        kind: "input-manifest",
        sha256: contentSha256,
        sourcePathSha256: "c".repeat(64),
        gitObjectId: "d".repeat(40),
        content,
      },
      canon: null,
      reviewEvent: null,
      nativeTask: task,
    },
    nativeCustody: sealHostRuntimeNativeCustody({
      task,
      binding,
      repositoryIdentitySha256: IDENTITY,
      approvedCanonSha256: "e".repeat(64),
      inputs: selection.custodyInputs ?? [],
    }),
    stepIds: catalog.stepIds,
    composition: sealHostRuntimeComposition({
      compositionId: "native-test",
      route: "offline-fixture",
      credentialFamily: "none",
      executionProfile: null,
      declaredTools: catalog.declaredTools,
    }),
    toolPolicySha256: digest({
      workflow: catalog.workflow,
      stepIds: catalog.stepIds,
      declaredTools: catalog.declaredTools,
    }),
    workspacePath: fixture.repository,
    stateDirectory,
    capsule: { ...capsule, sha256: digest(capsule) },
    allowWrite: false,
  });
}
