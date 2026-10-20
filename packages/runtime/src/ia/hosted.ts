// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** Hosted IA adapters reuse canonical query provisioning, analysis, and planning. */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { DurableArtifactStore } from "../artifacts/index.js";
import { buildContentIndex, canonicalJson, type ContentIndexV1 } from "../content-ir/index.js";
import { createContractKit, deepFreeze } from "../contract-kit/index.js";
import type { AgentHarness } from "../execution/contracts.js";
import { parseHostRuntimeNativeTask } from "../host-invoker/native-task.js";
import type {
  HostRuntimeNativeInputReferenceV1,
  HostRuntimeNativeTaskV1,
  HostRuntimeResolvedNativeInputV1,
} from "../host-invoker/native-task.js";
import type { RepositoryWorkspace } from "../repository/workspace/contracts.js";
import type { IaPlanTaskInput } from "../workflow-contracts/contracts.js";
import { IaAnalysisHarness } from "./analysis-harness.js";
import {
  DEFAULT_IA_NAVIGATION_TASKS,
  IA_PACKAGE_ALLOWANCE_MAXIMUM_BYTES,
  LocalIaAnalysisInputProvider,
  LocalIaPlanningInputProvider,
  planningTaskKey,
  provisionIaAnalysisInputPackage,
  provisionIaPlanningInputPackage,
  validateIaPlanningInputPackage,
  type PlanningInputPackage,
} from "./input-provider.js";
import {
  IA_ANALYSIS_OUTPUT_MAXIMUM_BYTES,
  IaLifecycleError,
  LocalIaAnalysisOutputPublisher,
  prepareIaPlanningInputFromAnalysis,
  validateIaAnalysisOutputPackage,
} from "./lifecycle.js";
import { IaPlanningHostOperation, IaPlanningWorkflowOutcomeProjector } from "./operation.js";

export type HostedIaRetainedRecordKind = "docsfab-ia-analysis-output" | "docsfab-ia-planning-input";

/**
 * Canonical bytes the retention wrapper adds around one planning package.
 * Measured from the envelope, not a second catalogued limit, so it moves with
 * the envelope shape.
 */
const PLANNING_RECORD_WRAPPER_BYTES =
  Buffer.byteLength(
    canonicalJson({ schemaVersion: 1, kind: "docsfab-ia-planning-input", package: {} }),
    "utf8",
  ) - Buffer.byteLength(canonicalJson({}), "utf8");

/**
 * The hosted planning package allowance: the catalogued ceiling minus the
 * wrapper bytes, so the retained record still fits the artifact store's bound.
 * Derived from the catalogue, never from the package itself;
 * `provisionIaPlanningInputPackage` refuses any allowance above the ceiling.
 */
export const HOSTED_IA_PLANNING_PACKAGE_ALLOWANCE_BYTES =
  IA_PACKAGE_ALLOWANCE_MAXIMUM_BYTES - PLANNING_RECORD_WRAPPER_BYTES;

export { PLANNING_RECORD_WRAPPER_BYTES as HOSTED_IA_PLANNING_RECORD_WRAPPER_BYTES };

/**
 * The store option both hosted IA jobs run under, so everything they put into
 * private custody is bounded by the catalogued `ia.analysisOutputMaxBytes`.
 */
export const HOSTED_IA_ARTIFACT_STORE_OPTIONS: Readonly<{ maxArtifactBytes: number }> =
  Object.freeze({ maxArtifactBytes: IA_ANALYSIS_OUTPUT_MAXIMUM_BYTES });

/** Host-owned port. A task cannot supply its identity, paths, data, or implementation. */
export interface HostedIaCustody {
  readonly repositoryIdentitySha256: string;
  readonly artifactStore: DurableArtifactStore;
  loadSelected(
    reference: HostRuntimeNativeInputReferenceV1,
  ): Promise<HostRuntimeResolvedNativeInputV1>;
  /** Stage this job's output; the host authenticates/retains it before private cleanup. */
  retain(record: { recordKind: HostedIaRetainedRecordKind; bytes: Uint8Array }): Promise<void>;
}

export interface HostedIaAssembly {
  readonly task: IaPlanTaskInput;
  readonly wrapHarness?: (delegate: AgentHarness) => AgentHarness;
  readonly hostOperations?: IaPlanningHostOperation;
  readonly outcomeProjector?: IaPlanningWorkflowOutcomeProjector;
}

export async function assembleHostedIa(input: {
  nativeTask: HostRuntimeNativeTaskV1;
  workspace: RepositoryWorkspace;
  /** The host's private per-attempt writable output area, outside the checkout. */
  stateDirectory: string;
  /** Immutable installed runtime assets, never selected by task data. */
  projectRoot: string;
  custody: HostedIaCustody;
  now?: () => Date;
}): Promise<HostedIaAssembly> {
  const { workspace, custody } = input;
  const nativeTask = parseHostRuntimeNativeTask(input.nativeTask);
  // The helper's own defense for in-process callers; the shipped wire path
  // already refuses a mismatched workflow. Another native workflow's task would
  // otherwise reach the IA provisioners with a payload shape they never validate.
  if (nativeTask.workflow !== "ia-analysis" && nativeTask.workflow !== "ia-plan")
    throw new IaLifecycleError("invalid-command");
  // `native-task.ts` binds the payload kind to the workflow name, and
  // `parseHostRuntimeNativeTask` re-verified `taskSha256`, so this cast is sound.
  const task = deepFreeze(structuredClone(nativeTask.task as IaPlanTaskInput));
  planningTaskKey(task); // Canonical scope/target/shape validation, not a second task grammar.
  const now = input.now ?? (() => new Date());
  const packageRoot = resolve(input.stateDirectory, "ia-inputs");
  if (nativeTask.workflow === "ia-analysis") {
    // Analysis starts with canonical query-only inputs for the actual checkout.
    // It never consumes model answers or another job's proposed ontology as facts.
    if (nativeTask.inputs.length !== 0) throw new IaLifecycleError("invalid-command");
    const index = await buildContentIndex({
      repositoryPath: workspace.path,
      repositoryRevision: workspace.revision,
    });
    const receipt = await provisionIaAnalysisInputPackage({
      packageRoot,
      repositoryPath: workspace.path,
      repositoryIdentity: custody.repositoryIdentitySha256,
      index,
      task,
      navigationTasks: [...DEFAULT_IA_NAVIGATION_TASKS],
      now: now(),
    });
    const provider = new LocalIaAnalysisInputProvider({
      packageRoot,
      repositoryRevision: workspace.revision,
      repositoryIdentity: custody.repositoryIdentitySha256,
      packageDigest: receipt.digest,
      now,
    });
    const outputRoot = resolve(input.stateDirectory, "ia-analysis-outputs");
    const publisher = new LocalIaAnalysisOutputPublisher(
      outputRoot,
      custody.repositoryIdentitySha256,
    );
    return {
      task,
      wrapHarness: (delegate) =>
        new IaAnalysisHarness(delegate, {
          artifactStore: custody.artifactStore,
          inputProvider: provider,
          outputPublisher: {
            async publish(output) {
              await publisher.publish(output);
              const bytes = await readFile(resolve(outputRoot, `${output.runId}.json`));
              validateIaAnalysisOutputPackage(JSON.parse(bytes.toString("utf8")), {
                runId: output.runId,
                index: output.index,
                task,
                repositoryIdentity: custody.repositoryIdentitySha256,
                now: now(),
              });
              // Publication into selectable project custody remains the host's
              // terminal/currentness transaction. This callback stages its bytes.
              await custody.retain({ recordKind: "docsfab-ia-analysis-output", bytes });
            },
          },
        }),
    };
  }

  let packageDigest: string | undefined;
  let maxPackageBytes: number | undefined;
  if (nativeTask.inputs.length > 1) throw new IaLifecycleError("invalid-command");
  const reference = nativeTask.inputs[0];
  // No selection is not an error: it falls through to the provider and becomes
  // the canonical missing-package result.
  if (reference) {
    const selected = await custody.loadSelected(reference);
    // A record that is not this exact reference from an `ia-analysis` run over
    // this repository and revision, with matching digest and within the
    // analysis bound, is stale and refused before it is parsed.
    if (
      selected.source.workflow !== "ia-analysis" ||
      selected.source.receiptLocator !== reference.receiptLocator ||
      selected.contentSha256 !== reference.artifactSha256 ||
      selected.source.repositoryIdentitySha256 !== custody.repositoryIdentitySha256 ||
      selected.source.revision !== workspace.revision ||
      selected.bytes.byteLength > IA_ANALYSIS_OUTPUT_MAXIMUM_BYTES ||
      createHash("sha256").update(selected.bytes).digest("hex") !== selected.contentSha256
    )
      throw new IaLifecycleError("stale-output");
    let analysisOutput: unknown;
    try {
      analysisOutput = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(selected.bytes));
    } catch {
      throw new IaLifecycleError("invalid-output");
    }
    const index = await buildContentIndex({
      repositoryPath: workspace.path,
      repositoryRevision: workspace.revision,
    });
    validateIaAnalysisOutputPackage(analysisOutput, {
      runId: selected.source.runId,
      index,
      task,
      repositoryIdentity: custody.repositoryIdentitySha256,
      now: now(),
    });
    const prepared = await prepareIaPlanningInputFromAnalysis({
      analysisOutput,
      analysisRunId: selected.source.runId,
      planningInputRoot: packageRoot,
      repositoryPath: workspace.path,
      repositoryRevision: workspace.revision,
      repositoryIdentity: custody.repositoryIdentitySha256,
      task,
      projectRoot: input.projectRoot,
      now: now(),
    });
    // Trusted output derived from an admitted analysis, so it gets the hosted
    // allowance rather than the smaller local `ia.inputPackageMaxBytes`. A
    // package over it is refused as `package-too-large`, and the same value
    // bounds the reader below.
    maxPackageBytes = HOSTED_IA_PLANNING_PACKAGE_ALLOWANCE_BYTES;
    const receipt = await provisionIaPlanningInputPackage({ ...prepared.options, maxPackageBytes });
    packageDigest = receipt.digest;
    // Review/application preparation needs this exact governed evaluation input
    // after planner cleanup, in addition to the produced plan artifacts.
    const planningPackage = JSON.parse(await readFile(receipt.path, "utf8"));
    const record = {
      schemaVersion: 1,
      kind: "docsfab-ia-planning-input" as const,
      package: planningPackage,
    };
    unwrapHostedIaPlanningInput(record, {
      task,
      index,
      repositoryIdentity: custody.repositoryIdentitySha256,
      now: now(),
    });
    await custody.retain({
      recordKind: record.kind,
      bytes: Buffer.from(canonicalJson(record), "utf8"),
    });
  }
  return {
    task,
    hostOperations: new IaPlanningHostOperation({
      artifactStore: custody.artifactStore,
      inputProvider: new LocalIaPlanningInputProvider({
        packageRoot,
        repositoryRevision: workspace.revision,
        repositoryIdentity: custody.repositoryIdentitySha256,
        ...(packageDigest ? { packageDigest } : {}),
        ...(maxPackageBytes === undefined ? {} : { maxPackageBytes }),
        now,
        // Do not publish a local CLI recovery command containing private paths.
      }),
    }),
    outcomeProjector: new IaPlanningWorkflowOutcomeProjector(),
  };
}

/**
 * Retention supplies a discriminator without changing the historical package or
 * its digest. The trusted approval receiver calls this after its custody join.
 */
export function unwrapHostedIaPlanningInput(
  record: unknown,
  input: { task: IaPlanTaskInput; index: ContentIndexV1; repositoryIdentity: string; now: Date },
): PlanningInputPackage {
  const kit = createContractKit({
    codes: {
      invalidShape: "invalid-output",
      invalidValue: "invalid-output",
      digestMismatch: "invalid-output",
      credentialMaterial: "invalid-output",
      schemaMismatch: "invalid-output",
    },
    fail: () => {
      throw new IaLifecycleError("invalid-output");
    },
  });
  kit.assertInert(record);
  const root = kit.object(record);
  kit.exact(root, ["schemaVersion", "kind", "package"]);
  if (root.schemaVersion !== 1 || root.kind !== "docsfab-ia-planning-input")
    throw new IaLifecycleError("invalid-output");
  validateIaPlanningInputPackage(
    root.package,
    input.task,
    input.index,
    input.repositoryIdentity,
    input.now,
  );
  return deepFreeze(structuredClone(root.package as PlanningInputPackage));
}
