// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  MODEL_SETTING_KEYS,
  type ModelSettingEntry,
  type ModelSettingKey,
  type ModelSettingSource,
  type ModelSettingValue,
  type ModelSlotSettingsV1,
} from "../config/model-settings.js";
import { OPERATOR_ENDPOINT_SOURCES } from "../security/model-credential-release.js";

/**
 * The run's effective model settings per slot, each with its source and the
 * preset's own value. Private to the run record: the full endpoint lives only
 * here, and publication never copies it.
 */
export interface RunModelSettingsV1 {
  readonly schemaVersion: 1;
  readonly kind: "docsfab-run-model-settings";
  readonly writing?: ModelSlotSettingsV1;
  readonly judge?: ModelSlotSettingsV1;
}

export class RunModelSettingsError extends Error {
  readonly code = "invalid-run-model-settings";

  constructor(message: string) {
    super(message);
    this.name = "RunModelSettingsError";
  }
}

/** Assemble the record field from the slots a run bound; undefined when it bound none. */
export function runModelSettings(slots: {
  readonly writing?: ModelSlotSettingsV1 | undefined;
  readonly judge?: ModelSlotSettingsV1 | undefined;
}): RunModelSettingsV1 | undefined {
  if (!slots.writing && !slots.judge) return undefined;
  return {
    schemaVersion: 1,
    kind: "docsfab-run-model-settings",
    ...(slots.writing ? { writing: structuredClone(slots.writing) } : {}),
    ...(slots.judge ? { judge: structuredClone(slots.judge) } : {}),
  };
}

/** Closed decoder for a saved record's `modelSettings`. */
export function decodeRunModelSettings(value: unknown): RunModelSettingsV1 {
  const root = object(value, "modelSettings");
  exactKeys(root, ["schemaVersion", "kind"], ["writing", "judge"], "modelSettings");
  if (root.schemaVersion !== 1 || root.kind !== "docsfab-run-model-settings") {
    throw new RunModelSettingsError(
      "The run record field modelSettings has an unknown schema version or kind.",
    );
  }
  return {
    schemaVersion: 1,
    kind: "docsfab-run-model-settings",
    ...(root.writing !== undefined ? { writing: decodeSlot(root.writing, "writing") } : {}),
    ...(root.judge !== undefined ? { judge: decodeSlot(root.judge, "judge") } : {}),
  };
}

function decodeSlot(value: unknown, slot: "writing" | "judge"): ModelSlotSettingsV1 {
  const at = `modelSettings.${slot}`;
  const root = object(value, at);
  exactKeys(
    root,
    ["schemaVersion", "slot", "presetId", "presetSource", "settings", "notes"],
    [],
    at,
  );
  if (root.schemaVersion !== 1 || root.slot !== slot) {
    throw new RunModelSettingsError(
      `The run record field ${at} has the wrong schema version or slot name.`,
    );
  }
  const presetId = nullableText(root.presetId, `${at}.presetId`);
  const presetSource =
    root.presetSource === null ? null : source(root.presetSource, `${at}.presetSource`);
  const settingsRoot = object(root.settings, `${at}.settings`);
  exactKeys(settingsRoot, [...MODEL_SETTING_KEYS], [], `${at}.settings`);
  const settings = {} as Record<ModelSettingKey, ModelSettingEntry>;
  for (const key of MODEL_SETTING_KEYS) {
    settings[key] = decodeEntry(settingsRoot[key], `${at}.settings.${key}`);
  }
  if (!Array.isArray(root.notes)) {
    throw new RunModelSettingsError(`The run record field ${at}.notes is not a list.`);
  }
  const notes = root.notes.map((note, index) => {
    if (typeof note !== "string" || /[\u0000-\u001f\u007f]/u.test(note)) {
      throw new RunModelSettingsError(
        `The run record field ${at}.notes[${String(index)}] is not single-line text.`,
      );
    }
    return note;
  });
  return { schemaVersion: 1, slot, presetId, presetSource, settings, notes };
}

function decodeEntry(value: unknown, at: string): ModelSettingEntry {
  const root = object(value, at);
  exactKeys(root, ["value", "source", "origin"], ["presetValue"], at);
  return {
    value: settingValue(root.value, `${at}.value`),
    source: source(root.source, `${at}.source`),
    origin: text(root.origin, `${at}.origin`),
    ...(Object.hasOwn(root, "presetValue")
      ? { presetValue: settingValue(root.presetValue, `${at}.presetValue`) }
      : {}),
  };
}

function settingValue(value: unknown, at: string): ModelSettingValue | null {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isSafeInteger(value)) return value;
  if (typeof value === "string") return text(value, at);
  throw new RunModelSettingsError(`The run record field ${at} is not a setting value.`);
}

function source(value: unknown, at: string): ModelSettingSource {
  if (
    typeof value !== "string" ||
    !OPERATOR_ENDPOINT_SOURCES.includes(value as ModelSettingSource)
  ) {
    throw new RunModelSettingsError(`The run record field ${at} is not a known value source.`);
  }
  return value as ModelSettingSource;
}

function text(value: unknown, at: string): string {
  if (typeof value !== "string" || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new RunModelSettingsError(`The run record field ${at} is not single-line text.`);
  }
  return value;
}

function nullableText(value: unknown, at: string): string | null {
  return value === null ? null : text(value, at);
}

function object(value: unknown, at: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new RunModelSettingsError(`The run record field ${at} is not a JSON object.`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  root: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
  at: string,
): void {
  const keys = Object.keys(root);
  if (
    required.some((key) => !Object.hasOwn(root, key)) ||
    keys.some((key) => !required.includes(key) && !optional.includes(key))
  ) {
    throw new RunModelSettingsError(`The run record field ${at} has missing or unknown keys.`);
  }
}
