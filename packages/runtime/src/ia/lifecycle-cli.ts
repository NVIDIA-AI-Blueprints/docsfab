// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { resolve } from "node:path";

import type { IaPlanTaskInput } from "../workflow-contracts/contracts.js";
import { iaPlanningTaskFromCli, parseTwoPhaseIaRunArguments } from "./cli.js";

export type IaLifecycleCliRequest =
  | {
      command: "input";
      operation: "provision" | "inspect" | "validate";
      packageKind: "analysis-input" | "planning-input";
      repositoryPath: string;
      revision: string;
      task: IaPlanTaskInput;
      expiresAt?: string;
      analysisRunId?: string;
      inputDigest?: string;
      json: boolean;
    }
  | {
      command: "approve";
      repositoryPath: string;
      revision: string;
      task: IaPlanTaskInput;
      planningRunId: string;
      reviewerPolicyPath: string;
      reviewerId: string;
      privateKeyPath: string;
      json: boolean;
    }
  | {
      command: "cycle";
      repositoryPath: string;
      revision: string;
      task: IaPlanTaskInput;
      expiresAt: string;
      reviewerPolicyPath: string;
      reviewerId: string;
      privateKeyPath: string;
      json: boolean;
    };

const REVISION = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

/** Strict operator parser; lifecycle-only inputs never enter workflow prompts. */
export function parseIaLifecycleArguments(
  args: readonly string[],
  cwd = process.cwd(),
): IaLifecycleCliRequest {
  if (args[0] === "input") return parseInput(args.slice(1), cwd);
  if (args[0] === "approve") return parseApprove(args.slice(1), cwd);
  if (args[0] === "cycle") return parseCycle(args.slice(1), cwd);
  throw new Error('ia requires the "input", "approve", or "cycle" subcommand.');
}

function parseInput(args: readonly string[], cwd: string): IaLifecycleCliRequest {
  const operation = args[0] === "create" ? "provision" : args[0];
  if (operation !== "provision" && operation !== "inspect" && operation !== "validate") {
    throw new Error("ia input requires provision|create|inspect|validate.");
  }
  const phase = args[1];
  if (phase !== "analysis" && phase !== "planning") {
    throw new Error("ia input requires analysis|planning.");
  }
  const parsed = parseValues(
    args.slice(2),
    new Set([
      "--repo",
      "--revision",
      "--scope",
      "--mode",
      "--target",
      "--expires-at",
      "--analysis-run",
      "--input-digest",
    ]),
    new Set(["--json"]),
  );
  const task = iaTask(parsed.values, phase === "analysis" ? "ia-analysis" : "ia-plan", cwd);
  const expiresAt = parsed.values.get("--expires-at");
  const analysisRunId = parsed.values.get("--analysis-run");
  const inputDigest = parsed.values.get("--input-digest");
  if (operation === "provision" && phase === "analysis") {
    if (!expiresAt || !canonicalFutureTimestamp(expiresAt)) {
      throw new Error(
        "analysis input provisioning requires future --expires-at <canonical UTC timestamp>.",
      );
    }
    if (analysisRunId)
      throw new Error("analysis input provisioning does not accept --analysis-run.");
    if (inputDigest) throw new Error("input provisioning does not accept --input-digest.");
  } else if (operation === "provision") {
    if (!analysisRunId || !RUN_ID.test(analysisRunId)) {
      throw new Error("planning input provisioning requires --analysis-run <run-id>.");
    }
    if (expiresAt)
      throw new Error("planning input inherits analysis expiry and rejects --expires-at.");
    if (inputDigest) throw new Error("input provisioning does not accept --input-digest.");
  } else if (expiresAt || analysisRunId) {
    throw new Error("input inspection and validation do not accept provisioning options.");
  } else if (inputDigest !== undefined && !/^[a-f0-9]{64}$/u.test(inputDigest)) {
    throw new Error("input inspection requires --input-digest with one lowercase SHA-256.");
  }
  return {
    command: "input",
    operation,
    packageKind: phase === "analysis" ? "analysis-input" : "planning-input",
    repositoryPath: task.repositoryPath,
    revision: task.revision,
    task: task.task,
    ...(expiresAt ? { expiresAt } : {}),
    ...(analysisRunId ? { analysisRunId } : {}),
    ...(inputDigest ? { inputDigest } : {}),
    json: parsed.flags.has("--json"),
  };
}

function parseApprove(args: readonly string[], cwd: string): IaLifecycleCliRequest {
  const parsed = parseValues(
    args,
    new Set([
      "--repo",
      "--revision",
      "--scope",
      "--mode",
      "--target",
      "--run-id",
      "--reviewer-policy",
      "--reviewer-id",
      "--private-key",
    ]),
    new Set(["--json"]),
  );
  const request = iaTask(parsed.values, "ia-plan", cwd);
  const planningRunId = required(parsed.values, "--run-id");
  const reviewerId = required(parsed.values, "--reviewer-id");
  if (!RUN_ID.test(planningRunId) || !/^[A-Za-z0-9][A-Za-z0-9:._-]{0,199}$/u.test(reviewerId)) {
    throw new Error("ia approve received an invalid run or reviewer identifier.");
  }
  return {
    command: "approve",
    repositoryPath: request.repositoryPath,
    revision: request.revision,
    task: request.task,
    planningRunId,
    reviewerPolicyPath: resolve(cwd, required(parsed.values, "--reviewer-policy")),
    reviewerId,
    privateKeyPath: resolve(cwd, required(parsed.values, "--private-key")),
    json: parsed.flags.has("--json"),
  };
}

function parseCycle(args: readonly string[], cwd: string): IaLifecycleCliRequest {
  const parsed = parseValues(
    args,
    new Set([
      "--repo",
      "--revision",
      "--expires-at",
      "--reviewer-policy",
      "--reviewer-id",
      "--private-key",
    ]),
    new Set(["--json"]),
  );
  const repositoryPath = required(parsed.values, "--repo");
  const revision = required(parsed.values, "--revision");
  if (!REVISION.test(revision)) {
    throw new Error("IA lifecycle commands require --revision with one full immutable commit ID.");
  }
  const expiresAt = required(parsed.values, "--expires-at");
  if (!canonicalFutureTimestamp(expiresAt)) {
    throw new Error("ia cycle requires future --expires-at <canonical UTC timestamp>.");
  }
  const reviewerId = required(parsed.values, "--reviewer-id");
  if (!/^[A-Za-z0-9][A-Za-z0-9:._-]{0,199}$/u.test(reviewerId)) {
    throw new Error("ia cycle received an invalid reviewer identifier argument value.");
  }
  return {
    command: "cycle",
    repositoryPath: resolve(cwd, repositoryPath),
    revision,
    task: { kind: "ia-plan", scope: "site", mode: "create" },
    expiresAt,
    reviewerPolicyPath: resolve(cwd, required(parsed.values, "--reviewer-policy")),
    reviewerId,
    privateKeyPath: resolve(cwd, required(parsed.values, "--private-key")),
    json: parsed.flags.has("--json"),
  };
}

function iaTask(
  values: ReadonlyMap<string, string>,
  workflow: "ia-analysis" | "ia-plan",
  cwd: string,
): { repositoryPath: string; revision: string; task: IaPlanTaskInput } {
  const repositoryPath = required(values, "--repo");
  const revision = required(values, "--revision");
  if (!REVISION.test(revision)) {
    throw new Error("IA lifecycle commands require --revision with one full immutable commit ID.");
  }
  const forwarded = [workflow, "--repo", repositoryPath, "--revision", revision];
  for (const name of ["--scope", "--mode", "--target"] as const) {
    const value = values.get(name);
    if (value) forwarded.push(name, value);
  }
  const parsed = parseTwoPhaseIaRunArguments(forwarded, cwd);
  if (parsed.workflow === "site-bootstrap") throw new Error("Invalid IA lifecycle workflow.");
  return {
    repositoryPath: parsed.repositoryPath,
    revision: parsed.revision,
    task: iaPlanningTaskFromCli(parsed).task,
  };
}

function parseValues(
  args: readonly string[],
  valueOptions: ReadonlySet<string>,
  flagOptions: ReadonlySet<string>,
): { values: Map<string, string>; flags: Set<string> } {
  const values = new Map<string, string>();
  const flags = new Set<string>();
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index]!;
    if (flagOptions.has(token)) {
      if (flags.has(token)) throw new Error(`Duplicate option ${token}.`);
      flags.add(token);
      continue;
    }
    if (!valueOptions.has(token)) throw new Error(`Unknown IA lifecycle option "${token}".`);
    if (values.has(token)) throw new Error(`Duplicate option ${token}.`);
    const value = args[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${token} requires a value.`);
    values.set(token, value);
    index += 1;
  }
  return { values, flags };
}

function required(values: ReadonlyMap<string, string>, name: string): string {
  const value = values.get(name);
  if (!value) throw new Error(`ia lifecycle requires ${name} <value>.`);
  return value;
}

function canonicalFutureTimestamp(value: string): boolean {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(value).toISOString() === value && parsed > Date.now();
}
