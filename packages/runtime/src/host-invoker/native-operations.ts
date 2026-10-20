// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** Shared operation assembly. Domain code owns artifact interpretation and authority. */
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DurableArtifactStore, opaqueRecordDigest } from "../artifacts/store.js";
import type { AgentHarness, HostOperationExecutor } from "../execution/contracts.js";
import type { HostRuntimeRequestV1 } from "./contracts.js";
import type { GitPatchEvidenceCollector } from "../repository/evidence.js";
import type { RepositoryWorkspace } from "../repository/workspace/contracts.js";
import { assembleHostedFoundationToPatch } from "./native-foundation-patch.js";
import type { NativeAuthoringExecutor } from "./native-authoring.js";
import { assembleHostedNativeSite } from "./native-site.js";
import type { ImpactPostflightService } from "../impact/contracts.js";
import type { RunRecord } from "../records/contracts.js";
import type {
  WorkflowDefinition,
  WorkflowOutcomeProjector,
  WorkflowTaskInput,
} from "../workflow-contracts/contracts.js";
import { withRepositoryWorkspace } from "../repository/workspace/materialize.js";
import { WorkflowChecksHostOperation } from "../workflow-execution/workflow-checks.js";
import { CatalogSkillCrateResolver } from "../skills/catalog-crate-resolver.js";
import { assembleHostedFoundation, inspectHostedFoundation } from "../foundation/hosted.js";
import { assembleHostedIa, HOSTED_IA_ARTIFACT_STORE_OPTIONS } from "../ia/hosted.js";
import { IA_ANALYSIS_OUTPUT_MAXIMUM_BYTES } from "../ia/lifecycle.js";
import { loadHostRuntimeNativeCustodyInput } from "./native-custody.js";

export interface HostedNativeOperationAssembly {
  readonly task?: WorkflowTaskInput;
  /** Host-selected private execution workspace; never a caller-supplied task path. */
  readonly workspacePath?: string;
  readonly repositoryEvidence?: GitPatchEvidenceCollector;
  /** Impact analysis for a native write step; when omitted the runner uses `authoring`'s. */
  readonly impactPostflight?: ImpactPostflightService;
  /**
   * Post-run verification and scoped transfer for a native arm that mutates
   * only a disposable workspace; the only place the outer checkout is touched.
   */
  readonly finalize?: (record: RunRecord) => Promise<void>;
  readonly hostOperations?: HostOperationExecutor;
  readonly outcomeProjector?: WorkflowOutcomeProjector;
  readonly harness?: AgentHarness;
  readonly wrapHarness?: (harness: AgentHarness) => AgentHarness;
}

export async function assembleHostedNativeOperations(input: {
  readonly request: HostRuntimeRequestV1;
  readonly workspace: RepositoryWorkspace;
  readonly workflow: WorkflowDefinition;
  /** Installed in-process executor for the ONE workflow that invokes a child. */
  readonly runAuthoring?: NativeAuthoringExecutor;
  readonly signal?: AbortSignal;
}): Promise<HostedNativeOperationAssembly> {
  const { request, workspace, workflow } = input;
  if (request.workflow === "foundation") {
    const resolver = new CatalogSkillCrateResolver(
      fileURLToPath(new URL("../../skill-crate", import.meta.url)),
    );
    return {
      ...assembleHostedFoundation({
        request,
        workspace,
        artifactStore: new DurableArtifactStore(resolve(request.stateDirectory, "artifacts")),
      }),
      harness: {
        inspectSkill: (step) => resolver.resolveSkill(step),
        async runStep() {
          throw new Error(
            "Hosted Foundation inspection cannot invoke inference through the native guidance harness.",
          );
        },
      },
    };
  }
  // The two IA jobs share one read-only arm that requires both the typed native
  // task and the host-resolved custody, and refuses any write intent.
  if (request.workflow === "ia-analysis" || request.workflow === "ia-plan") {
    const nativeTask = request.packet.nativeTask,
      nativeCustody = request.nativeCustody;
    if (!nativeTask || !nativeCustody || request.allowWrite || request.writeAuthority !== null)
      throw new Error(
        "Hosted IA requires a read-only task with verified project artifact custody.",
      );
    // One catalogued bound for both produced artifacts and staged records; the
    // planning arm sizes its package so its wrapper record still fits, so no
    // record's own size decides its allowance.
    const artifactStore = new DurableArtifactStore(
      resolve(request.stateDirectory, "artifacts"),
      HOSTED_IA_ARTIFACT_STORE_OPTIONS,
    );
    const assembly = await assembleHostedIa({
      nativeTask,
      workspace,
      stateDirectory: request.stateDirectory,
      projectRoot: fileURLToPath(new URL("../../", import.meta.url)),
      custody: {
        repositoryIdentitySha256: nativeCustody.repositoryIdentitySha256,
        artifactStore,
        loadSelected: (reference) =>
          loadHostRuntimeNativeCustodyInput(
            nativeCustody,
            nativeTask,
            reference,
            request.stateDirectory,
          ),
        async retain({ recordKind, bytes }) {
          // Domain validators admitted these bytes; the store bound above still
          // applies to them.
          const value = decodeHostedNativeRetainedRecord(recordKind, bytes);
          await artifactStore.putRecord(opaqueRecordDigest(value), value);
        },
      },
    });
    const resolver = new CatalogSkillCrateResolver(
      fileURLToPath(new URL("../../skill-crate", import.meta.url)),
    );
    // `ia-plan` has no inference step, so its harness refuses a model call.
    // `ia-analysis` has one and keeps the caller's execution harness.
    return {
      ...assembly,
      ...(request.workflow === "ia-plan"
        ? {
            harness: {
              inspectSkill: (step: Parameters<NonNullable<AgentHarness["inspectSkill"]>>[0]) =>
                resolver.resolveSkill(step),
              async runStep() {
                throw new Error(
                  "Hosted native planning cannot invoke inference through the native guidance harness.",
                );
              },
            },
          }
        : {}),
    };
  }
  // The only executor that calls back into the hosted runtime; missing
  // `runAuthoring` is a wiring defect and refuses.
  if (request.workflow === "foundation-to-patch") {
    if (!input.runAuthoring)
      throw new Error("Hosted Foundation composition requires the actual authoring executor.");
    return assembleHostedFoundationToPatch({
      request,
      workspace,
      runAuthoring: input.runAuthoring,
      ...(input.signal ? { signal: input.signal } : {}),
      inspect: () => inspectHostedFoundation({ request, workspace }),
    });
  }
  // Dispatch is on the workflow name alone, so the write arm re-checks task
  // kind, custody, write intent and grant itself.
  if (request.workflow === "site-bootstrap")
    return assembleHostedNativeSite({ request, workspace });
  // Wiring-defect guard: every `HOST_RUNTIME_NATIVE_WORKFLOWS` name has an arm
  // above, so this fails closed only if a name is added without one. A request
  // without `packet.nativeTask` is an ordinary authoring or review run.
  if (request.packet.nativeTask)
    throw new Error("The selected hosted native executor is not installed in this release.");
  // A workflow without the `lint-documentation` host-operation step leaves
  // `hostOperations` unconfigured, so its host-operation steps fail closed
  // inside the step loop.
  if (
    !workflow.steps.some(
      (step) => step.id === "lint-documentation" && step.kind === "host-operation",
    )
  )
    return {};
  return {
    hostOperations: {
      runStep: (step) =>
        withRepositoryWorkspace(request.workspacePath, request.revision, (candidate) =>
          new WorkflowChecksHostOperation(candidate).runStep({
            ...step,
            repositoryPath: candidate.path,
          }),
        ),
    },
  };
}

/**
 * Decode one staged record and confirm it declares the kind its producer named.
 * Domain validators already refuse a wrong `kind` before staging; this is the
 * retention closure's own boundary defence.
 */
export function decodeHostedNativeRetainedRecord(recordKind: string, bytes: Uint8Array): unknown {
  const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  if (!value || typeof value !== "object" || !("kind" in value) || value.kind !== recordKind)
    throw new Error(
      "Hosted native retention refused a record with a different declared package kind.",
    );
  return value;
}
