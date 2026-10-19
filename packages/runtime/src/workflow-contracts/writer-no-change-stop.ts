// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The coded no-change stop of an authoring writer: a planned write step that
 * changed no file while the host supplied repository instructions stops
 * `needs-input`, with the writer's reply as the operator's question, instead
 * of running every later step to an empty write. One leaf owns the recorded
 * shape, its producer, and its strict admission, so the step loop that writes
 * it, the authoring outcome projector that seals it, and the operator surfaces
 * that present it share one rule. Reads no model text.
 */

import type { RunRecord } from "../records/contracts.js";
import {
  documentationPlanWritePaths,
  validateAdmittedDocumentationPlanBinding,
  type AdmittedDocumentationPlanBinding,
} from "../workflow-execution/plan-binding.js";
import { AUTHORING_QUALITY_OUTCOME_WORKFLOWS } from "./authoring-workflows.js";

export const WRITER_NO_CHANGE_STOP_KIND = "docsfab-documentation-writer-no-change-stop";

/** Closed stop codes. Each names the governed input the stop asks for. */
export const WRITER_NO_CHANGE_STOP_CODES = ["writer-made-no-change"] as const;

export type WriterNoChangeStopCodeV1 = (typeof WRITER_NO_CHANGE_STOP_CODES)[number];

/** The planned writer the stop applies to; the CREATE reviser keeps its accounting contract. */
export const WRITER_NO_CHANGE_STOP_STEP_ID = "write-documentation";

export interface DocumentationWriterNoChangeStopV1 {
  readonly schemaVersion: 1;
  readonly kind: typeof WRITER_NO_CHANGE_STOP_KIND;
  readonly code: WriterNoChangeStopCodeV1;
  /**
   * The repository-relative paths of the instruction files the host supplied
   * to the writer, as the harness resolved them: through a symbolic link, and
   * in the file's own spelling on a case-insensitive file system.
   */
  readonly repositoryInstructions: readonly string[];
}

export interface AdmittedWriterNoChangeStopV1 {
  readonly stepId: string;
  readonly code: WriterNoChangeStopCodeV1;
  readonly repositoryInstructions: readonly string[];
}

/** The governed input a no-change stop asks for, in the planner's `documentation-plan:` namespace. */
export function writerNoChangeStopInputId(code: WriterNoChangeStopCodeV1): string {
  return `documentation-plan:${code}`;
}

/** Operator NEXT reason for an admitted stop; names the code and instruction files, never model text. */
export function writerNoChangeStopNextReason(stop: AdmittedWriterNoChangeStopV1): string {
  return (
    `The writer changed no file and replied instead (${stop.code}; repository instructions: ` +
    `${stop.repositoryInstructions.join(", ")}). Its reply is under PRODUCT. ` +
    "DocsFab runs the repository's checks itself, and repository instructions never need your acknowledgement. " +
    "Run this template against the original target checkout after adding the answer the writer asked for " +
    "to the instruction, or after amending the repository instruction it stopped on."
  );
}

const AUTHORING_WORKFLOWS: readonly string[] = AUTHORING_QUALITY_OUTCOME_WORKFLOWS;
const STOP_KEYS = ["code", "kind", "repositoryInstructions", "schemaVersion"] as const;
const CODE_SET: ReadonlySet<string> = new Set(WRITER_NO_CHANGE_STOP_CODES);
const MUTATION_TOOLS: ReadonlySet<string> = new Set(["edit", "write"]);

/**
 * Whether recorded tool evidence shows a step that was offered `edit` or
 * `write` and completed no call to either. Those are the only tools that
 * change a file, so the step changed no file.
 */
export function writerChangedNoFile(tools: unknown): boolean {
  if (!isObject(tools) || !Array.isArray(tools.presented) || !Array.isArray(tools.byTool)) {
    return false;
  }
  if (
    !tools.presented.some((name: unknown) => typeof name === "string" && MUTATION_TOOLS.has(name))
  )
    return false;
  for (const entry of tools.byTool as unknown[]) {
    if (!isObject(entry) || typeof entry.name !== "string") return false;
    if (!MUTATION_TOOLS.has(entry.name)) continue;
    if (typeof entry.calls !== "number" || typeof entry.failures !== "number") return false;
    if (entry.calls !== entry.failures) return false;
  }
  return true;
}

/**
 * The stop the step loop records for a succeeded write step, or `undefined`:
 * the planned writer, bound to a plan with at least one page to write, that
 * held repository instructions and changed no file. A plan that retains every
 * page leaves a writer that changes nothing to the run's own no-change outcome.
 */
export function writerNoChangeStopFor(input: {
  readonly stepId: string;
  readonly planBinding: AdmittedDocumentationPlanBinding | undefined;
  readonly repositoryInstructions: readonly string[] | undefined;
  readonly tools: unknown;
}): DocumentationWriterNoChangeStopV1 | undefined {
  if (
    input.stepId !== WRITER_NO_CHANGE_STOP_STEP_ID ||
    input.planBinding === undefined ||
    documentationPlanWritePaths(input.planBinding).length === 0 ||
    !validInstructionFiles(input.repositoryInstructions) ||
    !writerChangedNoFile(input.tools)
  ) {
    return undefined;
  }
  return Object.freeze({
    schemaVersion: 1,
    kind: WRITER_NO_CHANGE_STOP_KIND,
    code: "writer-made-no-change",
    repositoryInstructions: Object.freeze([...input.repositoryInstructions]),
  });
}

/**
 * The one admitted no-change stop on a `needs-input` or `failed` authoring
 * record, or `undefined`. Exactly one step carries the field, and it must be
 * the only `needs-input` step: the planned writer, bound to the planner's exact
 * plan digest with at least one page to write, whose last inference attempt
 * succeeded and whose recorded tool evidence shows that it completed no edit
 * or write call.
 */
export function admitWriterNoChangeStop(
  record: Readonly<RunRecord>,
): AdmittedWriterNoChangeStopV1 | undefined {
  if (
    !AUTHORING_WORKFLOWS.includes(record.workflow) ||
    !["failed", "needs-input"].includes(record.status) ||
    !Array.isArray(record.steps)
  ) {
    return undefined;
  }
  const steps: Record<string, unknown>[] = [];
  for (const step of record.steps as unknown[]) {
    if (!isObject(step)) return undefined;
    steps.push(step);
  }
  const holders = steps.filter((step) => step.writerNoChangeStop !== undefined);
  if (holders.length !== 1) return undefined;
  const step = holders[0]!;
  const stopped = steps.filter((candidate) => candidate.status === "needs-input");
  if (stopped.length !== 1 || stopped[0] !== step) return undefined;
  const stop = step.writerNoChangeStop;
  if (
    step.id !== WRITER_NO_CHANGE_STOP_STEP_ID ||
    step.skill !== "write-documentation" ||
    step.kind !== "inference" ||
    step.mode !== "write" ||
    step.planScopeStop !== undefined ||
    !isObject(stop) ||
    Object.keys(stop).sort().join("\0") !== [...STOP_KEYS].join("\0") ||
    stop.schemaVersion !== 1 ||
    stop.kind !== WRITER_NO_CHANGE_STOP_KIND ||
    typeof stop.code !== "string" ||
    !CODE_SET.has(stop.code) ||
    !validInstructionFiles(stop.repositoryInstructions) ||
    !lastAttemptSucceeded(step.inference) ||
    !writerChangedNoFile(step.tools) ||
    !plansAPageToWrite(step.planBinding)
  ) {
    return undefined;
  }
  const planner = steps.find((candidate) => candidate.id === "plan-documentation");
  const plannerDigest = planDigest(planner?.planBinding);
  if (
    planner?.status !== "succeeded" ||
    plannerDigest === undefined ||
    planDigest(step.planBinding) !== plannerDigest
  ) {
    return undefined;
  }
  return Object.freeze({
    stepId: step.id,
    code: stop.code as WriterNoChangeStopCodeV1,
    repositoryInstructions: Object.freeze([...(stop.repositoryInstructions as string[])]),
  });
}

/**
 * Non-empty, distinct repository-relative paths in the workspace's path
 * grammar: NFC, relative, no backslash or control character, and no empty,
 * `.` or `..` segment. The grammar keeps each path on one operator line.
 */
function validInstructionFiles(value: unknown): value is readonly string[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every(
      (path) =>
        typeof path === "string" &&
        path.length > 0 &&
        path === path.normalize("NFC") &&
        !path.startsWith("/") &&
        !path.includes("\\") &&
        !/[\0-\x1f\x7f\u0085\u2028\u2029]/u.test(path) &&
        path.split("/").every((segment) => segment !== "" && segment !== "." && segment !== ".."),
    ) &&
    new Set(value).size === value.length
  );
}

function plansAPageToWrite(value: unknown): boolean {
  try {
    return documentationPlanWritePaths(validateAdmittedDocumentationPlanBinding(value)).length > 0;
  } catch {
    return false;
  }
}

function planDigest(value: unknown): string | undefined {
  return isObject(value) && typeof value.digest === "string" && /^[a-f0-9]{64}$/u.test(value.digest)
    ? value.digest
    : undefined;
}

function lastAttemptSucceeded(value: unknown): boolean {
  if (!isObject(value) || !Array.isArray(value.attempts) || value.attempts.length === 0) {
    return false;
  }
  const terminal: unknown = value.attempts.at(-1);
  return isObject(terminal) && terminal.outcome === "succeeded";
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
