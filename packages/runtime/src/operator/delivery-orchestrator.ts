// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { resolve } from "node:path";

import {
  mintHostJobEnvelope,
  submitAfterSucceededRun,
  type SubmitAfterSucceededRunContext,
} from "../autonomy/managed-publish-host.js";
import {
  ExecFileReadOnlyCommandRunner,
  loadVerifiedPublicationRun,
  preflightLocalUserGitLabPublication,
} from "../delivery/preflight.js";
import type { LocalUserPublicationPlan } from "../delivery/contracts.js";
import type { WorkflowOutcomeDecodeOptionsV1 } from "../workflow-contracts/outcome.js";
import {
  decodeLocalUserGitLabPublicationResult,
  PublicationResultContractError,
} from "../delivery/publication-result.js";

export interface ShipSucceededWriteInput {
  readonly runId: string;
  readonly repositoryPath: string;
  readonly stateDirectory: string;
  readonly cwd: string;
  readonly dryRun: boolean;
  readonly remoteName?: string;
  readonly targetBranch?: string;
  readonly proposedSourceBranch?: string;
  readonly validationCommand?: string;
}

export interface ShipSucceededWriteDependencies {
  readonly log: (message: string) => void;
  readonly loadRun?: typeof loadVerifiedPublicationRun;
  readonly preflight?: typeof preflightLocalUserGitLabPublication;
  readonly submit?: typeof submitAfterSucceededRun;
  readonly execute?: SubmitAfterSucceededRunContext["execute"];
  readonly commands?: SubmitAfterSucceededRunContext["commands"];
  readonly executeDependencies?: SubmitAfterSucceededRunContext["executeDependencies"];
  /**
   * What the saved run's own record needs to decode (#2366): the options
   * `docsfab runs show` derives, for example an update-documentation run's
   * editorial evidence.
   */
  readonly editorialDecodeOptions?: WorkflowOutcomeDecodeOptionsV1;
}

/**
 * Host-owned L0 delivery for a previously succeeded documentation write.
 * The host reads and verifies the durable run before minting the narrow
 * write-plus-draft-MR envelope; command argv never supplies that authority.
 */
export async function shipSucceededWrite(
  input: ShipSucceededWriteInput,
  dependencies: ShipSucceededWriteDependencies,
): Promise<Awaited<ReturnType<typeof submitAfterSucceededRun>> | undefined> {
  const runRecordPath = resolve(input.stateDirectory, `${input.runId}.json`);
  const decodeOptions = dependencies.editorialDecodeOptions;
  const verified = await (dependencies.loadRun ?? loadVerifiedPublicationRun)(
    runRecordPath,
    input.runId,
    ...(decodeOptions ? [decodeOptions] : []),
  );
  const context: SubmitAfterSucceededRunContext = {
    cwd: input.cwd,
    repositoryPath: input.repositoryPath,
    stateDirectory: input.stateDirectory,
    ...(input.remoteName ? { remoteName: input.remoteName } : {}),
    ...(input.targetBranch ? { targetBranch: input.targetBranch } : {}),
    ...(input.proposedSourceBranch ? { proposedSourceBranch: input.proposedSourceBranch } : {}),
    ...(input.validationCommand ? { validationCommand: input.validationCommand } : {}),
    ...(dependencies.commands ? { commands: dependencies.commands } : {}),
    ...(dependencies.preflight ? { preflight: dependencies.preflight } : {}),
    ...(dependencies.executeDependencies
      ? { executeDependencies: dependencies.executeDependencies }
      : {}),
    ...(dependencies.execute ? { execute: dependencies.execute } : {}),
    ...(decodeOptions ? { editorialDecodeOptions: decodeOptions } : {}),
    log: dependencies.log,
  };

  if (input.dryRun) {
    const plan = await (dependencies.preflight ?? preflightLocalUserGitLabPublication)(
      {
        runId: verified.id,
        runRecordPath,
        repositoryPath: input.repositoryPath,
        remoteName: "origin",
        draftMergeRequest: true,
      },
      dependencies.commands ?? new ExecFileReadOnlyCommandRunner(),
      decodeOptions ?? {},
    );
    dependencies.log(formatShipDryRunSummary(verified.id, verified.changedFileCount, plan));
    return;
  }

  const result = await (dependencies.submit ?? submitAfterSucceededRun)(
    {
      id: verified.id,
      status: "succeeded",
      changes: { files: verified.changedFiles, patch: verified.patch },
    },
    mintHostJobEnvelope(verified.id, { source: "cli-argv", allowWrite: true, draftMr: true }),
    context,
  );
  const mergeRequest = result?.mergeRequest;
  if (mergeRequest?.url === undefined)
    throw new Error("Draft merge request publication completed without a URL.");
  const url = mergeRequest.url;
  const publicationResult = result?.publicationResult;
  if (publicationResult !== undefined) {
    let published;
    try {
      published = decodeLocalUserGitLabPublicationResult(publicationResult);
    } catch {
      throw new PublicationResultContractError();
    }
    if (
      published.mergeRequest.url !== url ||
      published.mergeRequest.iid !== mergeRequest.iid ||
      published.mergeRequest.headRevision !== mergeRequest.headRevision ||
      (input.targetBranch !== undefined && published.targetBranch !== input.targetBranch)
    ) {
      throw new PublicationResultContractError();
    }
  }
  dependencies.log(`Draft merge request: ${url}`);
  return result;
}

function formatShipDryRunSummary(
  runId: string,
  changedFileCount: number,
  plan: LocalUserPublicationPlan,
): string {
  return `Ship dry run: succeeded write ${runId} has ${changedFileCount} publishable documentation file${changedFileCount === 1 ? "" : "s"}; would open a draft merge request to ${plan.targetBranch.name}.`;
}
