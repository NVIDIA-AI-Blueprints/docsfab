// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Derive a step-grain study *baseline* from sanitized RunRecord-shaped JSON.
 *
 * Frozen: this export is not StudyEventV1. It projects only
 * shareable structural fields already on RunRecord (step order, tools.byTool
 * counts, inference turn tool-call counts, consulted node ids, search
 * dispositions). It does not invent per-read target or the study `scheduled`
 * flag when those fields are absent.
 */

export const DERIVED_BASELINE_KIND = "docsfab-study-derived-baseline" as const;

const ALLOWED_EXPORT_KEYS = new Set([
  "schemaVersion",
  "kind",
  "notStudyEventV1",
  "fixtureId",
  "runId",
  "workflow",
  "steps",
  "presentToday",
  "gaps",
  "order",
  "stepId",
  "status",
  "stepKind",
  "toolsByTool",
  "inferenceTurnToolCalls",
  "consultedNodeIds",
  "searchDispositions",
  "name",
  "calls",
  "failures",
  "attempt",
  "turn",
  "toolCalls",
  "source",
  "disposition",
  "targetId",
  "field",
  "present",
  "note",
  "stepOrder",
  "stepToolsByTool",
  "inferenceTurnToolCallCounts",
]);

export interface ToolCount {
  name: string;
  calls: number;
  failures: number;
}

export interface InferenceTurnToolCallCount {
  attempt: number;
  turn: number;
  toolCalls: number;
}

export interface SearchDispositionRow {
  source: "searchFindings" | "searchEvidence";
  disposition: string;
  targetId?: string;
}

export interface DerivedStep {
  order: number;
  stepId: string;
  status: string;
  stepKind?: string;
  toolsByTool: ToolCount[] | null;
  inferenceTurnToolCalls: InferenceTurnToolCallCount[] | null;
  consultedNodeIds: string[] | null;
  searchDispositions: SearchDispositionRow[] | null;
}

export interface FieldGap {
  field: "per-read-target" | "scheduled";
  present: false;
  note: string;
}

export interface PresentToday {
  stepOrder: boolean;
  stepToolsByTool: boolean;
  inferenceTurnToolCallCounts: boolean;
  consultedNodeIds: boolean;
  searchDispositions: boolean;
}

export interface DerivedBaseline {
  schemaVersion: 1;
  kind: typeof DERIVED_BASELINE_KIND;
  notStudyEventV1: true;
  fixtureId: string;
  runId: string;
  workflow: string;
  steps: DerivedStep[];
  presentToday: PresentToday;
  gaps: FieldGap[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readToolCounts(value: unknown): ToolCount[] | null {
  if (!isRecord(value) || !Array.isArray(value.byTool)) {
    return null;
  }
  const counts: ToolCount[] = [];
  for (const entry of value.byTool) {
    if (!isRecord(entry)) continue;
    const name = asString(entry.name);
    const calls = asFiniteNumber(entry.calls);
    const failures = asFiniteNumber(entry.failures);
    if (name === undefined || calls === undefined || failures === undefined) continue;
    counts.push({ name, calls, failures });
  }
  return counts.length > 0 ? counts : null;
}

function readInferenceTurnToolCalls(value: unknown): InferenceTurnToolCallCount[] | null {
  if (!isRecord(value) || !Array.isArray(value.attempts)) {
    return null;
  }
  const rows: InferenceTurnToolCallCount[] = [];
  for (const attempt of value.attempts) {
    if (!isRecord(attempt) || !Array.isArray(attempt.turns)) continue;
    const attemptNumber = asFiniteNumber(attempt.attempt) ?? rows.length + 1;
    for (const turn of attempt.turns) {
      if (!isRecord(turn)) continue;
      const turnNumber = asFiniteNumber(turn.turn);
      const toolCalls = asFiniteNumber(turn.toolCalls);
      if (turnNumber === undefined || toolCalls === undefined) continue;
      rows.push({ attempt: attemptNumber, turn: turnNumber, toolCalls });
    }
  }
  return rows.length > 0 ? rows : null;
}

function readConsultedNodeIds(value: unknown): string[] | null {
  if (!isRecord(value) || !Array.isArray(value.consultedNodeIds)) {
    return null;
  }
  const ids = value.consultedNodeIds.filter(
    (id): id is string => typeof id === "string" && id.length > 0,
  );
  return ids.length > 0 ? [...ids] : null;
}

function pushDisposition(
  rows: SearchDispositionRow[],
  source: SearchDispositionRow["source"],
  disposition: unknown,
  targetId: unknown,
): void {
  const text = asString(disposition);
  if (text === undefined) return;
  const row: SearchDispositionRow = { source, disposition: text };
  const target = asString(targetId);
  if (target !== undefined) row.targetId = target;
  const key = `${source}:${row.targetId ?? ""}:${text}`;
  if (
    rows.some(
      (existing) => `${existing.source}:${existing.targetId ?? ""}:${existing.disposition}` === key,
    )
  ) {
    return;
  }
  rows.push(row);
}

function readSearchDispositions(step: Record<string, unknown>): SearchDispositionRow[] | null {
  const rows: SearchDispositionRow[] = [];
  if (Array.isArray(step.searchFindings)) {
    for (const finding of step.searchFindings) {
      if (!isRecord(finding)) continue;
      const target = isRecord(finding.target) ? finding.target.id : undefined;
      pushDisposition(rows, "searchFindings", finding.disposition, target);
    }
  }
  if (isRecord(step.searchEvidence) && Array.isArray(step.searchEvidence.searches)) {
    for (const search of step.searchEvidence.searches) {
      if (!isRecord(search)) continue;
      const bounded = isRecord(search.bounded) ? search.bounded : undefined;
      const finding = bounded && isRecord(bounded.finding) ? bounded.finding : undefined;
      const confidence = bounded && isRecord(bounded.confidence) ? bounded.confidence : undefined;
      pushDisposition(
        rows,
        "searchEvidence",
        finding?.disposition ?? confidence?.disposition,
        search.targetId,
      );
    }
  }
  return rows.length > 0 ? rows : null;
}

function studyGaps(): FieldGap[] {
  return [
    {
      field: "per-read-target",
      present: false,
      note: "RunRecord has no per-read targetNodeId or pathClass. contextPreflight.consultedNodeIds is a step-level set, not a per-read target.",
    },
    {
      field: "scheduled",
      present: false,
      note: "RunRecord has no study scheduled flag (catalog/required probe vs extra model-initiated read). inference.attempts[].retryScheduled is retry policy, not that flag.",
    },
  ];
}

function presentTodayFrom(steps: DerivedStep[]): PresentToday {
  return {
    stepOrder: steps.length > 0,
    stepToolsByTool: steps.some((step) => step.toolsByTool !== null),
    inferenceTurnToolCallCounts: steps.some((step) => step.inferenceTurnToolCalls !== null),
    consultedNodeIds: steps.some((step) => step.consultedNodeIds !== null),
    searchDispositions: steps.some((step) => step.searchDispositions !== null),
  };
}

function assertAllowlisted(value: unknown, path: string): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertAllowlisted(entry, `${path}[${index}]`));
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, child] of Object.entries(value)) {
    if (!ALLOWED_EXPORT_KEYS.has(key)) {
      throw new Error(`study-derived-baseline: forbidden export key ${path}.${key}`);
    }
    assertAllowlisted(child, `${path}.${key}`);
  }
}

export function serializeDerivedBaseline(baseline: DerivedBaseline): string {
  assertAllowlisted(baseline, "$");
  return `${JSON.stringify(baseline, null, 2)}\n`;
}

export function deriveStudyBaseline(input: unknown): DerivedBaseline {
  if (!isRecord(input)) {
    throw new Error("study-derived-baseline: expected a RunRecord-shaped object");
  }
  if (!Array.isArray(input.steps)) {
    throw new Error("study-derived-baseline: expected steps[]");
  }

  const steps: DerivedStep[] = [];
  input.steps.forEach((raw, index) => {
    if (!isRecord(raw)) {
      throw new Error(`study-derived-baseline: steps[${index}] is not an object`);
    }
    const stepId = asString(raw.id);
    if (stepId === undefined) {
      throw new Error(`study-derived-baseline: steps[${index}] is missing id`);
    }
    const derived: DerivedStep = {
      order: index + 1,
      stepId,
      status: asString(raw.status) ?? "unknown",
      toolsByTool: readToolCounts(raw.tools),
      inferenceTurnToolCalls: readInferenceTurnToolCalls(raw.inference),
      consultedNodeIds: readConsultedNodeIds(raw.contextPreflight),
      searchDispositions: readSearchDispositions(raw),
    };
    const stepKind = asString(raw.kind);
    if (stepKind !== undefined) derived.stepKind = stepKind;
    steps.push(derived);
  });

  const runId = asString(input.id) ?? "unknown";
  const baseline: DerivedBaseline = {
    schemaVersion: 1,
    kind: DERIVED_BASELINE_KIND,
    notStudyEventV1: true,
    fixtureId: asString(input.fixtureId) ?? runId,
    runId,
    workflow: asString(input.workflow) ?? "unknown",
    steps,
    presentToday: presentTodayFrom(steps),
    gaps: studyGaps(),
  };
  assertAllowlisted(baseline, "$");
  return baseline;
}
