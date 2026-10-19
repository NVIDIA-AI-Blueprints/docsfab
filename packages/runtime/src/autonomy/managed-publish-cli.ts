// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * `docsfab auto --publish` command wiring. Reuses the read-only assessment for
 * the bound request and decision, then drives `runManagedCyclePublishOnce` with
 * production host authorities; `--confirm-cycle` is the only write authorization.
 */

import { createHash } from "node:crypto";

import type { RunRecord } from "../records/contracts.js";
import {
  projectAutoGatePresentation,
  projectAutoPublishPresentation,
  renderAdvancedPresentation,
} from "../cli/advanced-presentation.js";
import { canonicalizeJsonEvidence, type JsonEvidenceValue } from "../json-evidence.js";
import type { RunArguments } from "../cli.js";
import { assessAutoDryRunHost } from "./dry-run-host.js";
import type { AutoDryRunCliArguments, AutoDryRunHostAssessmentV1 } from "./dry-run-cli.js";
import {
  createHostAuthorityCycleMint,
  createHostAuthorityLineageMint,
  type AutoCycleOnceConfirmationV1,
  type AutoCycleOnceExecuteInputV1,
  type AutoCycleOnceRecordV1,
} from "./once.js";
import {
  runManagedCyclePublishOnce,
  type ManagedCyclePublishHost,
  type ManagedCyclePublishOutcomeV1,
} from "./managed-publish.js";
import {
  createProductionManagedPublish,
  defaultLoadPublishRecord,
  defaultReadCandidates,
  defaultSaveLink,
  defaultSaveOnceRecord,
  defaultSavePublishRecord,
  validateRun,
  type ManagedCandidateManifestV1,
} from "./managed-publish-host.js";
import type { ManagedCycleLinkV1, ManagedIssueCycleOnceInputV1 } from "./managed-cycle.js";
import {
  parseAutoPublishCliArguments,
  type AutoPublishCliArguments,
} from "./managed-publish-args.js";

export interface AutoPublishCliDependencies {
  cwd: string;
  stateDirectory: string;
  log(message: string): void;
  now?(): Date;
  assess?(args: AutoDryRunCliArguments): Promise<AutoDryRunHostAssessmentV1>;
  runWorkflow?(request: RunArguments): Promise<RunRecord | undefined>;
  readCandidates?(path: string): Promise<ManagedCandidateManifestV1>;
  publish?: ManagedCyclePublishHost["publish"];
  saveOnceRecord?(record: AutoCycleOnceRecordV1): Promise<void>;
  saveLink?(link: ManagedCycleLinkV1): Promise<void>;
  loadPublishRecord?: ManagedCyclePublishHost["loadPublishRecord"];
  savePublishRecord?: ManagedCyclePublishHost["savePublishRecord"];
}

export async function runAutoPublishCli(
  args: readonly string[],
  dependencies: AutoPublishCliDependencies,
): Promise<void> {
  const arguments_ = parseAutoPublishCliArguments(args, dependencies.cwd);
  const assess = dependencies.assess ?? assessAutoDryRunHost;
  const runWorkflow = dependencies.runWorkflow;
  if (!runWorkflow) {
    throw new Error(
      "The auto --publish command requires an authorized workflow executor dependency to run.",
    );
  }
  const now = dependencies.now ?? (() => new Date());
  const readCandidates = dependencies.readCandidates ?? defaultReadCandidates;
  const manifest = await readCandidates(arguments_.candidatesPath);
  const assessment = await assess({
    mode: "dry-run",
    repositoryPath: arguments_.repositoryPath,
    revision: arguments_.revision,
    ...(arguments_.targetBranch === undefined ? {} : { targetBranch: arguments_.targetBranch }),
    json: arguments_.json,
  });
  try {
    if (assessment.status === "needs-input") {
      dependencies.log(
        arguments_.json
          ? `auto --publish needs input: ${assessment.input.reasonCode}; no write performed.`
          : renderAdvancedPresentation(projectAutoGatePresentation("publish", assessment)),
      );
      if (arguments_.json) {
        for (const id of assessment.input.openInputIds) dependencies.log(`  open-input: ${id}`);
      }
      return;
    }
    const source = assessment.source;
    if (!arguments_.confirmCycle) {
      dependencies.log(
        arguments_.json
          ? `auto --publish proposal: ${source.decision.disposition}; ` +
              "re-run with --confirm-cycle to authorize one bounded documentation publish cycle."
          : renderAdvancedPresentation(projectAutoGatePresentation("publish", assessment)),
      );
      return;
    }
    const confirmation: AutoCycleOnceConfirmationV1 = {
      authorityId: arguments_.authorityId,
      operatorIdentitySha256: createHash("sha256").update(arguments_.authorityId).digest("hex"),
      affirmed: true,
    };
    const repository = {
      identitySha256: source.request.repository.identitySha256,
      revision: source.request.repository.revision,
    };
    const publish =
      dependencies.publish ??
      createProductionManagedPublish({
        cwd: dependencies.cwd,
        repositoryPath: arguments_.repositoryPath,
        stateDirectory: dependencies.stateDirectory,
        ...(arguments_.targetBranch ? { targetBranch: arguments_.targetBranch } : {}),
      });
    const host: ManagedCyclePublishHost = {
      now,
      confirmation,
      mintCycle: createHostAuthorityCycleMint(now),
      mintLineage: createHostAuthorityLineageMint(now),
      execute: (input: AutoCycleOnceExecuteInputV1) =>
        executeOne(input, arguments_, repository.revision, runWorkflow),
      validate: async (record, ids) => validateRun(record, ids),
      save: dependencies.saveOnceRecord ?? defaultSaveOnceRecord,
      saveLink: dependencies.saveLink ?? defaultSaveLink,
      log: (message) => dependencies.log(message),
      publish,
      loadPublishRecord: dependencies.loadPublishRecord ?? defaultLoadPublishRecord,
      savePublishRecord: dependencies.savePublishRecord ?? defaultSavePublishRecord,
    };
    const input: ManagedIssueCycleOnceInputV1 = {
      selection: {
        cycleId: source.request.cycleId,
        repository,
        trackerObservationSha256: manifest.trackerObservationSha256,
        candidates: manifest.candidates,
      },
      assigneeIdentitySha256: createHash("sha256")
        .update(`assignee:${arguments_.authorityId}`)
        .digest("hex"),
      chain: {
        request: source.request,
        assessment: source.assessment,
        decision: source.decision,
        repository,
      },
    };
    if (arguments_.resume) {
      dependencies.log(
        "auto --publish resume requested: adopting any prior draft-MR publication receipt for this cycle.",
      );
    }
    const outcome = await runManagedCyclePublishOnce(input, host);
    dependencies.log(
      arguments_.json
        ? canonicalizeJsonEvidence(serializeOutcome(outcome))
        : renderAdvancedPresentation(projectAutoPublishPresentation(outcome)),
    );
  } finally {
    await assessment.dispose();
  }
}

function serializeOutcome(outcome: ManagedCyclePublishOutcomeV1): JsonEvidenceValue {
  return {
    schemaVersion: 1,
    kind: "docsfab-auto-publish-cli-outcome",
    published: outcome.publish !== null,
    record: outcome.publish,
  } as unknown as JsonEvidenceValue;
}

async function executeOne(
  input: AutoCycleOnceExecuteInputV1,
  arguments_: AutoPublishCliArguments,
  revision: string,
  runWorkflow: NonNullable<AutoPublishCliDependencies["runWorkflow"]>,
): Promise<RunRecord> {
  const record = await runWorkflow({
    workflow: input.workflow,
    repositoryPath: arguments_.repositoryPath,
    revision,
    allowWrite: input.allowWrite,
    releaseGate: false,
    verbose: false,
    json: false,
    showScan: false,
    taskLineage: input.taskLineage,
  });
  if (!record) {
    throw new Error("The auto --publish workflow execution produced no run record to publish.");
  }
  return record;
}
