// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Host-operation adapter for the read-only `foundation` workflow.
 *
 * Routes through the generic WorkflowRunner host-operation seam (no runner.ts
 * special case). Never invokes the model harness or write tools.
 */

import type { DurableArtifactStore } from "../artifacts/index.js";
import { persistFoundationCanon } from "../canon/index.js";
import type {
  HarnessStepInput,
  HarnessStepResult,
  HostOperationExecutor,
} from "../execution/contracts.js";
import type { RunRecord } from "../records/contracts.js";
import type {
  WorkflowOutcomeCandidateV1,
  WorkflowOutcomeProjector,
} from "../workflow-contracts/contracts.js";
import {
  defaultInconclusiveWorkflowOutcome,
  workflowOutcomeStepEvidence,
} from "../workflow-contracts/outcome.js";
import {
  incompleteFoundationInspectSeed,
  inspectFoundation,
  type FoundationInspectResultV1,
} from "./inspect.js";
import {
  foundationReadinessToProductDisposition,
  foundationReadinessToStepOutcome,
} from "./readiness.js";

export type FoundationHostOperationErrorCode = "invalid-step" | "inspect-failed";

/** Contract-style reject; CLI maps these through the operator error envelope. */
export class FoundationHostOperationContractError extends Error {
  public constructor(public readonly code: FoundationHostOperationErrorCode) {
    super(messageFor(code));
    this.name = "FoundationHostOperationContractError";
  }
}

/** @deprecated Alias retained for call-site clarity in this package. */
export const FoundationHostOperationError = FoundationHostOperationContractError;
export type FoundationHostOperationError = FoundationHostOperationContractError;

function messageFor(code: FoundationHostOperationErrorCode): string {
  switch (code) {
    case "invalid-step":
      return "Foundation host operation received an unexpected workflow step.";
    case "inspect-failed":
      return "Foundation inspection violated the read-only mutation guarantee.";
  }
}

export interface FoundationHostOperationOptions {
  /** Optional durable store for candidate canon records (outside the checkout). */
  artifactStore?: DurableArtifactStore;
  /**
   * Test / host-API seam for injecting an already-authorized inspect result
   * (for example after {@link completeFoundationOnboarding}). Production CLI
   * path uses the incomplete seed until decisions are supplied in-process.
   */
  inspectOverride?: (input: HarnessStepInput) => Promise<FoundationInspectResultV1>;
}

export interface FoundationHostOperationResult extends HarnessStepResult {
  foundationInspect: FoundationInspectResultV1;
}

/** Pi-independent host adapter for foundation inspection. */
export class FoundationHostOperation implements HostOperationExecutor {
  public constructor(private readonly options: FoundationHostOperationOptions = {}) {}

  public async runStep(input: HarnessStepInput): Promise<FoundationHostOperationResult> {
    assertFoundationStep(input);
    const inspected = this.options.inspectOverride
      ? await this.options.inspectOverride(input)
      : await inspectFoundation({
          repositoryPath: input.repositoryPath,
          repositoryRevision: input.evidenceIdentity?.repositoryRevision ?? failRevision(),
          ...incompleteFoundationInspectSeed(
            input.evidenceIdentity?.repositoryRevision ?? failRevision(),
          ),
        });

    if (inspected.guarantees.writeToolsGranted || inspected.guarantees.hostMutation) {
      throw new FoundationHostOperationContractError("inspect-failed");
    }

    if (this.options.artifactStore) {
      await persistFoundationCanon(this.options.artifactStore, inspected.canon, {
        contentIndexDigestSha256: null,
        ontologyArtifactDigestSha256: null,
      });
    }

    const outcome = foundationReadinessToStepOutcome(inspected.readiness);
    return {
      summary: summarize(inspected),
      outcome,
      foundationInspect: inspected,
    };
  }
}

export class FoundationWorkflowOutcomeProjector implements WorkflowOutcomeProjector {
  public async project(record: Readonly<RunRecord>): Promise<WorkflowOutcomeCandidateV1> {
    if (record.workflow !== "foundation") {
      throw new FoundationHostOperationContractError("invalid-step");
    }
    if (record.status === "failed" || record.status === "queued" || record.status === "running") {
      return defaultInconclusiveWorkflowOutcome(record as RunRecord);
    }

    const terminal = [...record.steps]
      .reverse()
      .find(
        (step) =>
          step.status === "needs-input" ||
          step.status === "succeeded" ||
          step.status === "needs-human-decision",
      );
    if (!terminal) return defaultInconclusiveWorkflowOutcome(record as RunRecord);
    const evidence = workflowOutcomeStepEvidence(record as RunRecord, terminal.id);
    const readiness =
      parseReadinessToken(terminal.summary) ??
      (terminal.status === "needs-input" ? "needs-input" : "invalid");
    const productDisposition = foundationReadinessToProductDisposition(readiness);

    const findingCode =
      productDisposition === "needs-input"
        ? "foundation-critical-gaps"
        : productDisposition === "blocked"
          ? "foundation-invalid"
          : "foundation-not-ready";

    if (productDisposition === "ready") {
      return {
        disposition: "ready",
        findings: [],
        evidence: [evidence],
        limitations: [],
        openDecisions: [],
        producedArtifacts: [],
      };
    }

    if (productDisposition === "blocked") {
      return {
        disposition: "blocked",
        findings: [
          {
            id: `finding:${findingCode}`,
            kind: "blocked-dependency",
            severity: "blocking",
            code: findingCode,
            evidenceIds: [evidence.id],
          },
        ],
        evidence: [evidence],
        limitations: [],
        openDecisions: [
          {
            id: "decision:foundation-invalid-canon",
            kind: "dependency",
            evidenceIds: [evidence.id],
          },
        ],
        producedArtifacts: [],
      };
    }

    if (productDisposition === "needs-input") {
      return {
        disposition: "needs-input",
        findings: [
          {
            id: `finding:${findingCode}`,
            kind: "missing-governed-input",
            severity: "blocking",
            code: findingCode,
            inputId: "foundation-registered-evidence-required",
            evidenceIds: [evidence.id],
          },
        ],
        evidence: [evidence],
        limitations: [],
        openDecisions: [
          {
            id: "decision:foundation-registered-evidence-required",
            kind: "governed-input",
            inputId: "foundation-registered-evidence-required",
            evidenceIds: [evidence.id],
          },
        ],
        producedArtifacts: [],
      };
    }

    return {
      disposition: "not-ready",
      findings: [
        {
          id: `finding:${findingCode}`,
          kind: "product-gap",
          severity: "blocking",
          code: findingCode,
          evidenceIds: [evidence.id],
        },
      ],
      evidence: [evidence],
      limitations: [],
      openDecisions: [],
      producedArtifacts: [],
    };
  }
}

function parseReadinessToken(
  summary: string | undefined,
): import("./readiness.js").FoundationInspectReadiness | undefined {
  if (!summary) return undefined;
  const match = /\breadiness=(ready|needs-input|conflict|stale|invalid)\b/u.exec(summary);
  return match?.[1] as import("./readiness.js").FoundationInspectReadiness | undefined;
}

function assertFoundationStep(input: HarnessStepInput): void {
  if (
    input.workflow.name !== "foundation" ||
    input.step.kind !== "host-operation" ||
    input.step.operation !== "foundation" ||
    input.step.mode !== "read-only"
  ) {
    throw new FoundationHostOperationContractError("invalid-step");
  }
}

function failRevision(): never {
  throw new FoundationHostOperationContractError("invalid-step");
}

function summarize(result: FoundationInspectResultV1): string {
  const questions = result.nextQuestions.length;
  return [
    `Foundation inspection readiness=${result.readiness}`,
    `disposition=${result.productDisposition}`,
    `claims=${result.summary.claimCount}`,
    `conflicts=${result.summary.conflictCount}`,
    `questions=${questions}`,
    `canon=${result.canon.canonSha256.slice(0, 12)}`,
  ].join(" ");
}
