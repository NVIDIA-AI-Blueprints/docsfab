// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { isAbsolute, resolve } from "node:path";

import type { ContextPreflightTarget } from "../context/contracts.js";
import type { IaPlanTaskInput } from "../workflow-contracts/contracts.js";

export type IaPlanningCliRequest = {
  workflow: "ia-plan";
  repositoryPath: string;
  revision: string;
  scope: "site" | "section" | "page";
  mode: "create" | "reevaluate";
  target?: string;
  allowWrite: false;
  inputDigest?: string;
};

export type IaAnalysisCliRequest = Omit<IaPlanningCliRequest, "workflow"> & {
  workflow: "ia-analysis";
  runId?: string;
  corpusExecutionAuthorizationPath?: string;
  corpusReviewerPolicyPath?: string;
  corpusCaseId?: string;
  corpusTestedRevision?: string;
};

export type SiteBootstrapCliRequest = {
  workflow: "site-bootstrap";
  repositoryPath: string;
  revision: string;
  planPath: string;
  reviewerPolicyPath?: string;
  allowWrite: true;
};

export type TwoPhaseIaCliRequest =
  | IaAnalysisCliRequest
  | IaPlanningCliRequest
  | SiteBootstrapCliRequest;

export interface IaPlanningCliTask {
  task: IaPlanTaskInput;
  contextTarget?: ContextPreflightTarget;
}

const VALUE_OPTIONS = new Set([
  "--repo",
  "--revision",
  "--scope",
  "--mode",
  "--target",
  "--plan",
  "--reviewer-policy",
  "--run-id",
  "--corpus-execution-authorization",
  "--corpus-reviewer-policy",
  "--corpus-case-id",
  "--corpus-tested-revision",
  "--input-digest",
]);
const FLAG_OPTIONS = new Set(["--allow-write"]);

/** Strict parser for the fixed two-phase IA command surface. */
export function parseTwoPhaseIaRunArguments(
  args: readonly string[],
  cwd = process.cwd(),
): TwoPhaseIaCliRequest {
  const workflow = args[0];
  if (workflow !== "ia-analysis" && workflow !== "ia-plan" && workflow !== "site-bootstrap") {
    throw new Error("Expected ia-analysis, ia-plan, or site-bootstrap workflow.");
  }
  const values = new Map<string, string>();
  const flags = new Set<string>();
  for (let index = 1; index < args.length; index += 1) {
    const token = args[index]!;
    if (FLAG_OPTIONS.has(token)) {
      if (flags.has(token)) throw new Error(`Duplicate option ${token}.`);
      flags.add(token);
      continue;
    }
    if (!VALUE_OPTIONS.has(token)) throw new Error(`Unknown ${workflow} option "${token}".`);
    if (values.has(token)) throw new Error(`Duplicate option ${token}.`);
    const value = args[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${token} requires a value.`);
    values.set(token, value);
    index += 1;
  }

  const repository = values.get("--repo");
  if (!repository) throw new Error(`${workflow} requires --repo <path>.`);
  const base = {
    repositoryPath: resolve(cwd, repository),
    revision: values.get("--revision") ?? "HEAD",
  };

  if (workflow === "site-bootstrap") {
    forbid(
      values,
      [
        "--scope",
        "--mode",
        "--target",
        "--run-id",
        "--corpus-execution-authorization",
        "--corpus-reviewer-policy",
        "--corpus-case-id",
        "--corpus-tested-revision",
        "--input-digest",
      ],
      workflow,
    );
    const plan = values.get("--plan");
    if (!plan) throw new Error("site-bootstrap requires --plan <artifact>.");
    if (!flags.has("--allow-write")) {
      throw new Error("site-bootstrap requires --allow-write after plan approval.");
    }
    return {
      workflow,
      ...base,
      planPath: resolve(cwd, plan),
      ...(values.get("--reviewer-policy")
        ? { reviewerPolicyPath: resolve(cwd, values.get("--reviewer-policy")!) }
        : {}),
      allowWrite: true,
    };
  }

  forbid(values, ["--plan", "--reviewer-policy"], workflow);
  const inputDigest = values.get("--input-digest");
  if (inputDigest !== undefined && !/^[a-f0-9]{64}$/u.test(inputDigest)) {
    throw new Error(`${workflow} requires --input-digest with one lowercase SHA-256.`);
  }
  const corpusExecution =
    workflow === "ia-analysis"
      ? corpusExecutionArguments(values, cwd, base.revision)
      : (() => {
          forbid(
            values,
            [
              "--run-id",
              "--corpus-execution-authorization",
              "--corpus-reviewer-policy",
              "--corpus-case-id",
              "--corpus-tested-revision",
            ],
            workflow,
          );
          return {};
        })();
  if (flags.has("--allow-write")) throw new Error(`${workflow} is always read-only.`);
  const scope = values.get("--scope");
  if (scope !== "site" && scope !== "section" && scope !== "page") {
    throw new Error(`${workflow} requires --scope site|section|page.`);
  }
  const target = values.get("--target");
  const requestedMode = values.get("--mode");
  if (scope === "site") {
    if (target) throw new Error("site planning does not accept --target.");
    if (requestedMode !== "create" && requestedMode !== "reevaluate") {
      throw new Error("site planning requires --mode create|reevaluate.");
    }
    return {
      workflow,
      ...base,
      scope,
      mode: requestedMode,
      allowWrite: false,
      ...(inputDigest ? { inputDigest } : {}),
      ...corpusExecution,
    };
  }
  if (requestedMode !== undefined) {
    throw new Error(`${scope} planning is reevaluate-only and does not accept --mode.`);
  }
  if (!target) throw new Error(`${scope} planning requires --target <path>.`);
  parseTarget(target, scope);
  return {
    workflow,
    ...base,
    scope,
    mode: "reevaluate",
    target,
    allowWrite: false,
    ...(inputDigest ? { inputDigest } : {}),
    ...corpusExecution,
  };
}

function corpusExecutionArguments(
  values: ReadonlyMap<string, string>,
  cwd: string,
  revision: string,
): Omit<IaAnalysisCliRequest, keyof IaPlanningCliRequest | "workflow"> {
  const names = [
    "--run-id",
    "--corpus-execution-authorization",
    "--corpus-reviewer-policy",
    "--corpus-case-id",
    "--corpus-tested-revision",
  ] as const;
  const requested = names.some((name) => values.has(name));
  if (!requested) return {};
  const missing = names.find((name) => !values.has(name));
  if (missing) {
    throw new Error(`ia-analysis live corpus execution requires ${missing}.`);
  }
  const runId = values.get("--run-id")!;
  const caseId = values.get("--corpus-case-id")!;
  const testedRevision = values.get("--corpus-tested-revision")!;
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(runId)) {
    throw new Error("--run-id requires a bounded content-free identifier.");
  }
  if (!/^[a-z0-9][a-z0-9._-]{0,127}$/u.test(caseId)) {
    throw new Error("--corpus-case-id requires a bounded content-free identifier.");
  }
  if (!/^[a-f0-9]{40,64}$/u.test(revision) || testedRevision !== revision) {
    throw new Error(
      "Live corpus execution requires matching full immutable --revision and --corpus-tested-revision values.",
    );
  }
  return {
    runId,
    corpusExecutionAuthorizationPath: resolve(cwd, values.get("--corpus-execution-authorization")!),
    corpusReviewerPolicyPath: resolve(cwd, values.get("--corpus-reviewer-policy")!),
    corpusCaseId: caseId,
    corpusTestedRevision: testedRevision,
  };
}

/** Convert the strict CLI surface to the closed runner task without prose inference. */
export function iaPlanningTaskFromCli(
  request: IaAnalysisCliRequest | IaPlanningCliRequest,
): IaPlanningCliTask {
  if (!request.target) {
    return {
      task: { kind: "ia-plan", scope: request.scope, mode: request.mode },
    };
  }
  const target = parseTarget(request.target, request.scope);
  return {
    task: {
      kind: "ia-plan",
      scope: request.scope,
      mode: request.mode,
      target,
    },
    contextTarget: target,
  };
}

function forbid(
  values: ReadonlyMap<string, string>,
  names: readonly string[],
  workflow: string,
): void {
  const found = names.find((name) => values.has(name));
  if (found) throw new Error(`${workflow} does not accept ${found}.`);
}

function safeTarget(value: string, option: string): string {
  if (
    value !== value.normalize("NFC") ||
    value.includes("\0") ||
    value.includes("\\") ||
    isAbsolute(value) ||
    /^[A-Za-z]:/u.test(value) ||
    value.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    throw new Error(`${option} requires a safe repository-relative path.`);
  }
  return value;
}

function parseTarget(value: string, scope: "section" | "page" | "site"): ContextPreflightTarget {
  const separator = value.lastIndexOf("#");
  const sourcePath = separator === -1 ? value : value.slice(0, separator);
  const anchor = separator === -1 ? undefined : value.slice(separator + 1);
  safeTarget(sourcePath, "--target");
  if (scope === "page" && anchor !== undefined) {
    throw new Error("page planning --target must identify a page without a fragment.");
  }
  if (scope === "section" && anchor === undefined) {
    throw new Error("section planning --target must include an exact #anchor fragment.");
  }
  if (
    anchor !== undefined &&
    (!anchor.trim() || anchor !== anchor.normalize("NFC") || anchor.includes("\0"))
  ) {
    throw new Error("section planning --target fragment must be a normalized non-empty anchor.");
  }
  return {
    sourcePath,
    ...(anchor !== undefined ? { anchor } : {}),
  };
}
