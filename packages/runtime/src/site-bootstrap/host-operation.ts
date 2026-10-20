// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type {
  ArtifactReference,
  ArtifactUse,
  IaEvaluationArtifact,
  IaPlanArtifact,
} from "../artifacts/index.js";
import type {
  HarnessStepInput,
  HarnessStepResult,
  HostOperationExecutor,
} from "../execution/contracts.js";
import type { SiteBootstrapRunRecord } from "./contracts.js";
import type { SiteBootstrapRunInput } from "./runner.js";
import { SiteBootstrapRunnerError } from "./runner-error.js";

export interface SiteBootstrapOperationRunner {
  run(input: SiteBootstrapRunInput): Promise<SiteBootstrapRunRecord>;
}

/**
 * Adapts the deterministic site-bootstrap runner to the Pi-independent fixed
 * workflow contract. Authority remains closed over by the host and never
 * enters the generic request, prompt, or run record.
 */
export class SiteBootstrapHostOperation implements HostOperationExecutor {
  public constructor(
    private readonly runner: SiteBootstrapOperationRunner,
    private readonly operationInput: SiteBootstrapRunInput,
  ) {}

  public async runStep(input: HarnessStepInput): Promise<HarnessStepResult> {
    if (
      input.step.kind !== "host-operation" ||
      input.step.operation !== "site-bootstrap" ||
      input.task?.kind !== "site-bootstrap" ||
      input.repositoryPath !== this.operationInput.workspace.path ||
      !sameReference(input.task.plan, referenceFor(this.operationInput.bundle.plan))
    ) {
      throw new SiteBootstrapRunnerError("invalid-bundle");
    }
    const record = await this.runner.run(this.operationInput);
    if (record.status !== "succeeded") {
      throw new SiteBootstrapRunnerError(record.error ?? "scaffold-failed");
    }
    const artifacts: ArtifactUse[] = [
      {
        role: "input",
        reference: referenceFor(this.operationInput.bundle.plan),
      },
      {
        role: "input",
        reference: referenceFor(this.operationInput.bundle.evaluation),
      },
    ];
    return {
      summary: `Applied approved site plan to ${record.scaffold?.outputs.length ?? 0} output(s).`,
      outcome: "succeeded",
      artifacts,
    };
  }
}

function referenceFor(
  artifact: IaPlanArtifact | IaEvaluationArtifact,
): ArtifactReference<"ia-plan"> | ArtifactReference<"ia-evaluation"> {
  return {
    kind: artifact.kind,
    schemaVersion: artifact.schemaVersion,
    digest: artifact.digest,
    repositoryRevision: artifact.repository.revision,
    repositoryContentDigest: artifact.repository.contentDigest,
  };
}

function sameReference(left: ArtifactReference, right: ArtifactReference): boolean {
  return (
    left.kind === right.kind &&
    left.schemaVersion === right.schemaVersion &&
    left.digest === right.digest &&
    left.repositoryRevision === right.repositoryRevision &&
    left.repositoryContentDigest === right.repositoryContentDigest
  );
}
