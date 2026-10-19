// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { CliVerdictPlanes } from "../cli-format.js";
import type { RunRecord } from "../../records/contracts.js";
import {
  projectRunProduct,
  type RunProductProjectionV1,
  type RunResultPublicationV1,
} from "../run-result.js";
import { buildRunHumanNextCommand, type RunHumanNextCommand } from "../run-next-action.js";
import { runVerdictPlanes } from "./footer.js";
import type {
  RunHistoryNextCommandContext,
  RunSummaryContext,
  RunSummaryPublicationOutcome,
} from "./contracts.js";

/** Admitted run facts for terminal, saved-run, and hosted presenters. */
export interface RunPresentationView {
  readonly identity: {
    readonly runId: string;
    readonly workflow: string;
    readonly repositoryPath: string;
    readonly revision: string;
  };
  readonly verdict: CliVerdictPlanes;
  readonly executionStatus: RunRecord["status"];
  readonly exitCode: 0 | 1 | 2;
  readonly product: RunProductProjectionV1;
  readonly publication: RunSummaryPublicationOutcome;
  /** Saved delivery evidence never changes a run's verdict or next action. */
  readonly deliveryLookup: RunResultPublicationV1 | undefined;
  readonly history: RunHistoryNextCommandContext | undefined;
  readonly next: RunHumanNextCommand | undefined;
  readonly evidence: {
    readonly recordPath: string;
    readonly patchPath: string | undefined;
    readonly patchSha256: string | undefined;
    readonly changedPaths: readonly string[];
  };
}

/** Resolve outcome and recovery once, before destination-specific formatting. */
export function projectRunPresentationView(context: RunSummaryContext): RunPresentationView {
  const { record } = context;
  return {
    identity: {
      runId: record.id,
      workflow: record.workflow,
      repositoryPath: context.repositoryPath,
      revision: record.repository.revision,
    },
    verdict: runVerdictPlanes(context),
    executionStatus: record.status,
    exitCode: context.exitCode,
    product: projectRunProduct(record, context.editorialDecodeOptions),
    publication: context.publication ?? { status: "not-requested" },
    deliveryLookup: context.deliveryLookup,
    history: context.history,
    next: buildRunHumanNextCommand(context),
    evidence: {
      recordPath: context.recordPath,
      patchPath: record.changes?.patch?.artifactPath,
      patchSha256: record.changes?.patch?.sha256,
      changedPaths: record.changes?.files.map((file) => file.path) ?? [],
    },
  };
}
