// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { ModelSettingValues } from "./model-settings.js";

/**
 * `--set` values from this invocation's command line, the highest-precedence
 * model settings. Only the CLI argument parsers write them: request, task,
 * and model text never reach this registry.
 */
export interface CliModelSettings {
  readonly writing: ModelSettingValues;
  readonly judge: ModelSettingValues;
}

let current: CliModelSettings | undefined;

/** Record this invocation's `--set` values; every later configuration load applies them. */
export function setCliModelSettings(settings: CliModelSettings | undefined): void {
  current =
    settings && (Object.keys(settings.writing).length > 0 || Object.keys(settings.judge).length > 0)
      ? Object.freeze({
          writing: Object.freeze({ ...settings.writing }),
          judge: Object.freeze({ ...settings.judge }),
        })
      : undefined;
}

export function currentCliModelSettings(): CliModelSettings | undefined {
  return current;
}
