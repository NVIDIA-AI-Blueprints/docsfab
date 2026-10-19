// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { DocsFabConfig } from "../../config/runtime-loader.js";
import { createStyleTaskContext, type StyleTaskContextV1 } from "../../execution/task-context.js";
import {
  verifyQualityPackContext,
  type VerifiedQualityPackContext,
} from "../../quality-pack/manifest.js";
import type { RepositoryWorkspace } from "../../repository/workspace/contracts.js";
import {
  assertBoundSourcesTracked,
  createWorkspaceTrackedSourceReader,
} from "./source-acquisition.js";
import type { TrackedSourceReaderV1 } from "../../inputs/source-acquisition.js";

/** What a run admitted without a model, for the workflow execution that follows. */
export interface PreModelAdmission {
  readonly qualityPack: VerifiedQualityPackContext;
  readonly styleContext: StyleTaskContextV1;
}

type QualityPackDirectories = Pick<
  DocsFabConfig,
  "skillCrateDirectory" | "qualityDirectory" | "qualityPackDirectory"
>;

/** The installed quality pack, then its bound style profile, each refusing with its own code. */
export async function admitQualityPack(config: QualityPackDirectories): Promise<PreModelAdmission> {
  const qualityPack = await verifyQualityPackContext({
    skillCrateDirectory: config.skillCrateDirectory,
    qualityDirectory: config.qualityDirectory,
    qualityPackDirectory: config.qualityPackDirectory,
  });
  const styleContext = await createStyleTaskContext(qualityPack);
  return { qualityPack, styleContext };
}

/**
 * The run's refusals that read neither the request's pages nor a model reply,
 * in a fixed order: the installed quality pack, its bound style profile, then
 * each `--source` path. Each refusal keeps its own code. A local run settles
 * this once, before the request interpretation's model call.
 */
export async function admitRunBeforeModel(input: {
  readonly config: QualityPackDirectories;
  readonly workspace: RepositoryWorkspace;
  /** Each must be a tracked regular file at the workspace revision. */
  readonly sourcePaths?: readonly string[];
  readonly hostTrackedSourceReader?: TrackedSourceReaderV1;
}): Promise<PreModelAdmission> {
  const admission = await admitQualityPack(input.config);
  const sourcePaths = input.sourcePaths ?? [];
  if (sourcePaths.length > 0) {
    await assertBoundSourcesTracked({
      reader: input.hostTrackedSourceReader ?? createWorkspaceTrackedSourceReader(input.workspace),
      sourcePaths,
    });
  }
  return admission;
}
