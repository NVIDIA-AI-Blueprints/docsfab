#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { loadConfig, type DocsFabConfig } from "./config/runtime-loader.js";
import { diagnose, type DoctorResult } from "./doctor.js";
import {
  inspectDoctorReadiness,
  type DoctorReadinessArea,
  type DoctorReadinessResult,
} from "./doctor-readiness.js";
import { canonicalizeJsonEvidence, type JsonEvidenceValue } from "./json-evidence.js";
import { reportOperatorFailure, wantsJsonFailureOutput } from "./operator/error-envelope.js";
import { rejectSituation } from "./operator/situation-catalog.js";

const execute = promisify(execFile);
const REVISION = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
/** A readiness code or status as DocsFab spells it; anything else is not echoed. */
const VOCABULARY = /^[a-z][a-z0-9-]*$/u;
/**
 * The ordinary doctor's default verdict on the export: the local-review use,
 * whose checks leave out GitLab and private state, ready with no local blocker.
 */
const EXPECTED_USE = "local-review";
const EXPECTED_STATUS = "ready";
const EXPECTED_CHECKS = new Map<DoctorReadinessArea, "ready" | "blocked">([
  ["installation", "ready"],
  ["configuration", "ready"],
  ["repository", "ready"],
  ["provider", "ready"],
  ["validation", "ready"],
]);
const EXPECTED_AUTO_MODES: DoctorReadinessResult["autoModesReady"] = ["dry-run", "patch-only"];
const KNOWN_VALIDATION_COMMANDS: ReadonlySet<unknown> = new Set(["npm run check", "npm test"]);
const NOT_REQUESTED = "not-requested";

export interface AcceptanceExportDoctorInput {
  cwd: string;
  expectedRevision: string;
  expectedTree: string;
  live: boolean;
}

export interface AcceptanceExportDoctorDependencies {
  inspectReadiness?: (cwd: string) => Promise<DoctorReadinessResult>;
  readTree?: (cwd: string) => Promise<string>;
  loadConfiguration?: () => DocsFabConfig;
  diagnoseConfiguration?: (config: DocsFabConfig, live: boolean) => Promise<DoctorResult>;
}

export interface AcceptanceExportDoctorResult {
  schemaVersion: 2;
  kind: "docsfab-acceptance-export-doctor";
  testedRevision: string;
  testedTree: string;
  exportRevision: string;
  readiness: "local-review-ready";
  provider: "offline-ready" | "live-ready";
}

/**
 * Verify the exact tracked export and the ordinary doctor's default
 * local-review readiness before checking the provider. It claims no GitLab or
 * private-state readiness; the export has no GitLab remote, so readiness
 * probes no GitLab credential.
 */
export async function inspectAcceptanceExportDoctor(
  input: AcceptanceExportDoctorInput,
  dependencies: AcceptanceExportDoctorDependencies = {},
): Promise<AcceptanceExportDoctorResult> {
  if (!REVISION.test(input.expectedRevision) || !REVISION.test(input.expectedTree)) {
    throw new Error("Acceptance export doctor requires exact revision and tree identities.");
  }
  const readiness = await (
    dependencies.inspectReadiness ?? ((cwd) => inspectDoctorReadiness({ cwd, live: false }))
  )(input.cwd);
  const tree = await (dependencies.readTree ?? readCurrentTree)(input.cwd);
  assertExpectedReadiness(readiness, tree, input.expectedTree);

  let provider: AcceptanceExportDoctorResult["provider"] = "offline-ready";
  if (input.live) {
    const config = (dependencies.loadConfiguration ?? loadConfig)();
    const result = await (
      dependencies.diagnoseConfiguration ?? ((candidate, live) => diagnose(candidate, { live }))
    )(config, true);
    if (!result.live) {
      rejectSituation(
        "acceptance-export-live-diagnosis-incomplete",
        "Acceptance export live provider diagnosis did not complete.",
      );
    }
    provider = "live-ready";
  }

  return Object.freeze({
    schemaVersion: 2,
    kind: "docsfab-acceptance-export-doctor",
    testedRevision: input.expectedRevision,
    testedTree: input.expectedTree,
    exportRevision: readiness.repositoryRevision!,
    readiness: "local-review-ready",
    provider,
  });
}

/**
 * Refuse any readiness other than the expected export disposition, naming each
 * difference. The text is collected as CI evidence, so it carries only codes
 * and statuses, never diagnostic prose, paths, or environment values.
 */
function assertExpectedReadiness(
  readiness: DoctorReadinessResult,
  actualTree: string,
  expectedTree: string,
): void {
  const differences = readinessDifferences(readiness, actualTree, expectedTree);
  if (differences.length > 0) {
    rejectSituation(
      "acceptance-export-disposition-unexpected",
      [
        "Acceptance export doctor found an unexpected governed disposition.",
        "Differences from the expected readiness:",
        ...differences.map((difference) => `- ${difference}`),
      ].join("\n"),
    );
  }
}

function readinessDifferences(
  readiness: DoctorReadinessResult,
  actualTree: string,
  expectedTree: string,
): string[] {
  const differences: string[] = [];
  if (readiness.selectedUse !== EXPECTED_USE) {
    differences.push(
      `selected use: observed ${
        readiness.selectedUse === undefined ? "none" : term(readiness.selectedUse)
      }, expected ${EXPECTED_USE}`,
    );
  }
  if (readiness.status !== EXPECTED_STATUS) {
    differences.push(`status: observed ${term(readiness.status)}, expected ${EXPECTED_STATUS}`);
  }
  if (!readiness.repositoryRevision || !REVISION.test(readiness.repositoryRevision)) {
    differences.push(
      `repository revision: observed ${
        readiness.repositoryRevision ? "an invalid identity" : "none"
      }, expected an exact commit identity`,
    );
  }
  if (actualTree !== expectedTree) {
    differences.push("export tree: does not match the tested tree");
  }
  differences.push(...checkDifferences(readiness.checks));
  // The readiness reporter includes advice for other uses in diagnostics.
  // Only local-review blockers govern this authenticated export. Historical
  // results without per-use classification retain the strict old behavior.
  const diagnosticCodes =
    readiness.useReadiness?.[EXPECTED_USE]?.blockers ??
    readiness.diagnostics.map((diagnostic) => diagnostic.code);
  if (diagnosticCodes.length !== 0) {
    differences.push(`diagnostic codes: observed ${termList(diagnosticCodes)}, expected []`);
  }
  if (readiness.validationCommand !== null) {
    differences.push(
      `validation command: observed ${validationCommandText(
        readiness.validationCommand,
      )}, expected none`,
    );
  }
  if (
    readiness.autoModesReady.length !== EXPECTED_AUTO_MODES.length ||
    readiness.autoModesReady.some((mode, index) => mode !== EXPECTED_AUTO_MODES[index])
  ) {
    differences.push(
      `auto modes ready: observed ${readiness.autoModesReady.length} ${termList(
        readiness.autoModesReady,
      )}, expected ${EXPECTED_AUTO_MODES.length} ${termList(EXPECTED_AUTO_MODES)}`,
    );
  }
  const live = readiness.liveConnectivity;
  if (live.requested !== false) {
    differences.push(
      `live connectivity requested: observed ${
        live.requested === true ? "true" : "(unrecognized)"
      }, expected false`,
    );
  }
  if (live.provider !== NOT_REQUESTED) {
    differences.push(
      `live connectivity provider: observed ${term(live.provider)}, expected ${NOT_REQUESTED}`,
    );
  }
  if (live.gitlab !== NOT_REQUESTED) {
    differences.push(
      `live connectivity gitlab: observed ${term(live.gitlab)}, expected ${NOT_REQUESTED}`,
    );
  }
  return differences;
}

/** Each expected area must appear exactly once with its status, and no other area may appear. */
function checkDifferences(checks: DoctorReadinessResult["checks"]): string[] {
  const statusesOf = (area: unknown) =>
    checks.filter((check) => check.area === area).map((check) => check.status);
  const observedText = (statuses: readonly unknown[]) =>
    statuses.length === 1 ? term(statuses[0]) : termList(statuses);
  const differences: string[] = [];
  for (const [area, status] of EXPECTED_CHECKS) {
    const statuses = statusesOf(area);
    if (statuses.length === 0) {
      differences.push(`${area} check: observed absent, expected ${status}`);
    } else if (statuses.length !== 1 || statuses[0] !== status) {
      differences.push(`${area} check: observed ${observedText(statuses)}, expected ${status}`);
    }
  }
  const extraAreas = new Set(
    checks.map((check) => check.area).filter((area) => !EXPECTED_CHECKS.has(area)),
  );
  for (const area of extraAreas) {
    differences.push(
      `${term(area)} check: observed ${observedText(statusesOf(area))}, expected absent`,
    );
  }
  return differences;
}

function term(value: unknown): string {
  return typeof value === "string" && VOCABULARY.test(value) ? value : "(unrecognized)";
}

function termList(values: readonly unknown[]): string {
  return `[${values.map(term).join(", ")}]`;
}

/** Doctor selects no validation command, so any command it reports is a difference. */
function validationCommandText(command: unknown): string {
  return KNOWN_VALIDATION_COMMANDS.has(command) ? String(command) : "(unrecognized)";
}

async function readCurrentTree(cwd: string): Promise<string> {
  const result = await execute("git", ["rev-parse", "HEAD^{tree}"], {
    cwd,
    encoding: "utf8",
    timeout: 5_000,
    maxBuffer: 4 * 1024,
  });
  const tree = result.stdout.trim();
  if (!REVISION.test(tree)) {
    throw new Error("Acceptance export tree identity is invalid.");
  }
  return tree;
}

function option(args: string[], name: string): string {
  const indexes = args.flatMap((value, index) => (value === name ? [index] : []));
  if (indexes.length !== 1) throw new Error(`${name} is required exactly once.`);
  const value = args[indexes[0]! + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value.`);
  return value;
}

async function main(): Promise<void> {
  if (process.env.DOCSFAB_ACCEPTANCE_EXPORT_DOCTOR !== "true") {
    throw new Error("Acceptance export doctor is available only inside the acceptance harness.");
  }
  const args = process.argv.slice(2);
  // `--json` reports a failure as the JSON operator envelope; the result is JSON either way.
  const flags = new Set(["--live", "--json"]);
  const allowed = new Set(["--expected-revision", "--expected-tree", ...flags]);
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (!allowed.has(argument)) throw new Error("Unknown acceptance export doctor option.");
    if (!flags.has(argument)) index += 1;
  }
  const result = await inspectAcceptanceExportDoctor({
    cwd: process.cwd(),
    expectedRevision: option(args, "--expected-revision"),
    expectedTree: option(args, "--expected-tree"),
    live: args.includes("--live"),
  });
  console.log(canonicalizeJsonEvidence(result as unknown as JsonEvidenceValue));
}

if (
  process.argv[1]?.endsWith("acceptance-export-doctor.js") ||
  process.argv[1]?.endsWith("acceptance-export-doctor.ts")
) {
  main().catch((error: unknown) => {
    reportOperatorFailure(error, { json: wantsJsonFailureOutput() });
    process.exitCode = 1;
  });
}
