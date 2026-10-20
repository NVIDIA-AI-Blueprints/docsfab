// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { isAbsolute, resolve } from "node:path";

import type { WorkflowName } from "../workflow-contracts/contracts.js";
import {
  isRunnableWorkflowName,
  isWorkflowName,
  parkedWorkflowError,
} from "../workflow-registry/catalog.js";

export function parseWorkflow(value: string | undefined): WorkflowName {
  if (!value || !isWorkflowName(value)) {
    throw new Error(`Unknown workflow "${value ?? ""}". Run "docsfab list".`);
  }
  if (!isRunnableWorkflowName(value)) {
    throw new Error(parkedWorkflowError(value));
  }
  return value;
}

export function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${name} requires a value.`);
  }
  return value;
}

export function options(args: string[], name: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== name) continue;
    const value = args[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${name} requires a value.`);
    values.push(value);
  }
  return values;
}

export function contextPath(value: string, optionName: string): string {
  if (
    value !== value.normalize("NFC") ||
    value.includes("\0") ||
    value.includes("\\") ||
    isAbsolute(value) ||
    /^[A-Za-z]:/u.test(value) ||
    value.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    throw new Error(`${optionName} requires a safe repository-relative path.`);
  }
  return value;
}

export function contextAnchor(value: string, optionName: string): string {
  if (!value.trim() || value !== value.normalize("NFC") || value.includes("\0")) {
    throw new Error(`${optionName} requires a non-empty normalized anchor.`);
  }
  return value;
}

export function strictCliOptions(
  args: string[],
  allowedFlags: Set<string>,
  allowedValues: Set<string>,
  repeatable: Set<string>,
): { flags: Set<string>; values: Map<string, string[]> } {
  const flags = new Set<string>();
  const values = new Map<string, string[]>();
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (allowedFlags.has(argument)) {
      if (flags.has(argument))
        throw new ProfileCliUsageError(`Option "${argument}" must not be duplicated.`);
      flags.add(argument);
      continue;
    }
    if (!allowedValues.has(argument))
      throw new ProfileCliUsageError("Unknown profile command option.");
    const value = args[index + 1];
    if (!value || value.startsWith("--"))
      throw new ProfileCliUsageError(`${argument} requires a value.`);
    index += 1;
    const current = values.get(argument) ?? [];
    if (current.length > 0 && !repeatable.has(argument)) {
      throw new ProfileCliUsageError(`Option "${argument}" must not be duplicated.`);
    }
    current.push(value);
    values.set(argument, current);
  }
  return { flags, values };
}

/** Profile parsers use a typed usage failure so profile text cannot misroute it. */
export class ProfileCliUsageError extends Error {
  readonly code = "cli-usage" as const;

  constructor(message: string) {
    super(message);
    this.name = "ProfileCliUsageError";
  }
}

export function decodeHostText(bytes: Uint8Array): string {
  try {
    const value = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (!value || value.includes("\0")) throw new Error();
    return value;
  } catch {
    throw new Error("Owner-only host input is not valid UTF-8 text.");
  }
}

export { resolve };
