// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { dirname, resolve } from "node:path";

import { loadConfig } from "../../config/runtime-loader.js";
import {
  evaluateRuns,
  loadEvaluationFixture,
  loadRunRecord,
} from "../../quality-evaluation/structural.js";
import { ConfiguredEvaluationJudge } from "../../quality-evaluation/semantic.js";
import type { RunRecord } from "../../records/contracts.js";
import type { WorkflowOutcomeDecodeOptionsV1 } from "../../workflow-contracts/outcome.js";
import { loadSavedRunEditorialDecodeOptions } from "../run/editorial-replay.js";
import { option, options } from "../options.js";
import {
  projectEvaluationPresentation,
  renderAdvancedPresentation,
} from "../advanced-presentation.js";

export async function handleEvaluateCommand(args: string[]): Promise<void> {
  const fixturePath = option(args, "--fixture");
  const recordPaths = options(args, "--record");
  if (!fixturePath) throw new Error("evaluate requires --fixture <path>.");
  if (recordPaths.length === 0) {
    throw new Error("evaluate requires at least one --record <path>.");
  }
  const fixture = await loadEvaluationFixture(resolve(fixturePath));
  const decodeOptions = new WeakMap<RunRecord, WorkflowOutcomeDecodeOptionsV1 | undefined>();
  const records = await Promise.all(
    recordPaths.map(async (path) => {
      const absolutePath = resolve(path);
      const record = await loadRunRecord(absolutePath, {
        resolveWorkflowOutcomeDecodeOptions: async (candidate) => {
          const options = await loadSavedRunEditorialDecodeOptions(
            candidate,
            dirname(absolutePath),
          );
          decodeOptions.set(candidate, options);
          return options;
        },
      });
      return record;
    }),
  );
  let judge;
  if (args.includes("--judge")) {
    const judgeConfig = loadConfig().judge;
    if (!judgeConfig) {
      throw new Error("evaluate --judge requires JUDGE_ENABLED=true and JUDGE_* configuration.");
    }
    judge = new ConfiguredEvaluationJudge(judgeConfig);
  }
  const result = await evaluateRuns({
    fixture,
    records,
    workflowOutcomeDecodeOptions: (record) => decodeOptions.get(record),
    ...(judge ? { judge } : {}),
  });
  console.log(renderAdvancedPresentation(projectEvaluationPresentation(fixture.name, result)));
  if (!result.passed) process.exitCode = 1;
}
