// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { CliModelSettings } from "../config/cli-model-settings.js";
import {
  isModelSettingKey,
  MODEL_SETTING_KEYS,
  ModelSettingValueError,
  parseModelSettingValue,
  type ModelSettingKey,
  type ModelSettingValue,
} from "../config/model-settings.js";
import { ProfileCliUsageError } from "./options.js";

export const SET_OPTION = "--set";

/**
 * Read every `--set key=value` pair from raw argv. The pair is the token after
 * `--set`, and it sets the writing model; a `judge.<key>` pair refuses, since
 * run and do never call the judge. Only argv reaches here, so text inside the
 * quoted request never sets anything.
 */
export function parseSetOptions(args: readonly string[]): CliModelSettings {
  const writing: Partial<Record<ModelSettingKey, ModelSettingValue>> = {};
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (argument.startsWith(`${SET_OPTION}=`)) {
      throw new ProfileCliUsageError(
        "--set takes its key=value as the next argument, for example --set reasoningEffort=high.",
      );
    }
    if (argument !== SET_OPTION) continue;
    const pair = args[index + 1];
    if (pair === undefined || pair.startsWith("--")) {
      throw new ProfileCliUsageError(
        "--set requires a key=value pair after it, for example --set reasoningEffort=high.",
      );
    }
    const separator = pair.indexOf("=");
    const name = separator > 0 ? pair.slice(0, separator).trim() : "";
    if (name.startsWith("judge.")) {
      // run and do never call the judge model, so a judge setting here would
      // do nothing; it belongs in host.yaml or the JUDGE_* variables.
      throw new ProfileCliUsageError(
        `--set ${name} sets the judge model, which docsfab run and do never call. Set it under active.judge.settings in host.yaml or with the JUDGE_* variables.`,
      );
    }
    const key = name;
    if (!isModelSettingKey(key)) {
      throw new ProfileCliUsageError(
        `--set ${name || pair} names no model setting. Use key=value with one of: ${MODEL_SETTING_KEYS.join(", ")}.`,
      );
    }
    const target = writing;
    if (target[key] !== undefined) {
      throw new ProfileCliUsageError(
        `--set ${name} was given more than once; give each setting exactly once.`,
      );
    }
    try {
      target[key] = parseModelSettingValue(key, pair.slice(separator + 1), `--set ${name}`);
    } catch (error) {
      if (error instanceof ModelSettingValueError) throw new ProfileCliUsageError(error.message);
      throw error;
    }
  }
  return { writing, judge: {} };
}

/** Argv without the `--set` pairs, for the parsers that refuse unknown options. */
export function withoutSetOptions(args: readonly string[]): string[] {
  const kept: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === SET_OPTION) {
      index += 1;
      continue;
    }
    kept.push(args[index]!);
  }
  return kept;
}
