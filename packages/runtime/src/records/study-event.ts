// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * StudyEventV1 sibling log of payload-free, host-settled tool observations.
 * Deliberately not a RunRecord field.
 */
import { createContractKit, type ContractFail } from "../contract-kit/index.js";

export const STUDY_EVENT_KIND = "docsfab-study-event" as const;
export const STUDY_RUN_KIND = "docsfab-study-run" as const;

export const STUDY_OBSERVATION_MODES = [
  "corpus",
  "talk-tree",
  "talk-tree+required-probes",
] as const;
export type StudyObservationMode = (typeof STUDY_OBSERVATION_MODES)[number];

export const STUDY_PATH_CLASSES = [
  "instruction-file",
  "product-page",
  "api-ref",
  "working-note",
  "other",
] as const;
export type StudyPathClass = (typeof STUDY_PATH_CLASSES)[number];

export const STUDY_EVENT_DISPOSITIONS = ["succeeded", "failed"] as const;
export type StudyEventDisposition = (typeof STUDY_EVENT_DISPOSITIONS)[number];

export type StudyEventContractErrorCode =
  | "invalid-shape"
  | "invalid-value"
  | "digest-mismatch"
  | "credential-material"
  | "migration-required"
  | "schema-mismatch"
  | "payload-forbidden";

export class StudyEventContractError extends Error {
  public constructor(public readonly code: StudyEventContractErrorCode) {
    super(`Study event rejected (${code}).`);
    this.name = "StudyEventContractError";
  }
}

const fail = (code: StudyEventContractErrorCode): never => {
  throw new StudyEventContractError(code);
};

const kit = createContractKit<StudyEventContractErrorCode>({
  fail: fail as ContractFail<StudyEventContractErrorCode>,
  inertMode: "strict",
  codes: {
    invalidShape: "invalid-shape",
    invalidValue: "invalid-value",
    digestMismatch: "digest-mismatch",
    credentialMaterial: "credential-material",
    schemaMismatch: "migration-required",
  },
});

const STUDY_EVENT_KEYS = [
  "schemaVersion",
  "kind",
  "t",
  "runId",
  "workflow",
  "stepId",
  "probeId",
  "tool",
  "targetNodeId",
  "pathClass",
  "disposition",
  "durationMs",
  "scheduled",
] as const;

const STUDY_EVENT_OPTIONAL_KEYS = ["probeId", "targetNodeId", "pathClass"] as const;

const STUDY_RUN_KEYS = [
  "schemaVersion",
  "kind",
  "runId",
  "observationMode",
  "modelRef",
  "events",
] as const;

const MODEL_REF_KEYS = ["provider", "catalogId"] as const;

const OBSERVATION_RANK: Readonly<Record<StudyObservationMode, number>> = {
  corpus: 0,
  "talk-tree": 1,
  "talk-tree+required-probes": 2,
};

const PROMPT_LIKE = /(?:^|\n)\s*(?:you are (?:a|an)\b|system\s*:|assistant\s*:|human\s*:)/iu;

export interface StudyModelRefV1 {
  readonly provider: string;
  readonly catalogId: string;
}

export interface StudyEventV1 {
  readonly schemaVersion: 1;
  readonly kind: typeof STUDY_EVENT_KIND;
  readonly t: string;
  readonly runId: string;
  readonly workflow: string;
  readonly stepId: string;
  readonly probeId?: string;
  readonly tool: string;
  readonly targetNodeId?: string;
  readonly pathClass?: StudyPathClass;
  readonly disposition: StudyEventDisposition;
  readonly durationMs: number;
  readonly scheduled: boolean;
}

export interface StudyRunV1 {
  readonly schemaVersion: 1;
  readonly kind: typeof STUDY_RUN_KIND;
  readonly runId: string;
  readonly observationMode: StudyObservationMode;
  readonly modelRef: StudyModelRefV1;
  readonly events: readonly StudyEventV1[];
}

export interface CreateStudyEventInput {
  readonly t: string;
  readonly runId: string;
  readonly workflow: string;
  readonly stepId: string;
  readonly probeId?: string;
  readonly tool: string;
  readonly targetNodeId?: string;
  readonly pathClass?: StudyPathClass;
  readonly disposition: StudyEventDisposition;
  readonly durationMs: number;
  readonly scheduled: boolean;
}

export interface CreateStudyRunInput {
  readonly runId: string;
  readonly observationMode: StudyObservationMode;
  readonly modelRef: StudyModelRefV1;
  readonly events?: readonly StudyEventV1[];
}

export interface StudyRunSummary {
  readonly runId: string;
  readonly observationMode: StudyObservationMode;
  readonly modelRef: StudyModelRefV1;
  readonly scheduled: number;
  readonly extra: number;
}

/** Closed path-class rules. Never an LLM. Never persist the path. */
export function classifyStudyPathClass(path: string): StudyPathClass {
  const normalized = path.replaceAll("\\", "/").replace(/^\.\//u, "");
  const basename = normalized.split("/").pop() ?? normalized;
  const instructionTree = /(?:^|\/)(?:\.cursor\/rules|\.agents)(?:\/|$)/u.test(normalized);
  if (isInstructionBasename(basename) || instructionTree) {
    return "instruction-file";
  }
  if (
    /(?:^|\/)(?:notes|scratch|working-notes|wip)(?:\/|$)/iu.test(normalized) ||
    /(?:^|[-_])(?:todo|wip)(?:[-_.]|$)/iu.test(basename)
  ) {
    return "working-note";
  }
  if (
    /(?:^|\/)api(?:\/|\.md|\.mdx|$)/iu.test(normalized) ||
    /(?:^|[-_])(?:api-ref(?:erence)?|openapi|swagger)(?:[-_.]|$)/iu.test(basename) ||
    /(?:^|\/)(?:openapi|swagger)(?:\/|$)/iu.test(normalized)
  ) {
    return "api-ref";
  }
  if (
    /^(?:docs|fern|documentation)\//u.test(normalized) ||
    /\.(?:md|mdx|rst|mdoc)$/iu.test(basename)
  ) {
    return "product-page";
  }
  return "other";
}

export function strongerObservationMode(
  current: StudyObservationMode,
  incoming: StudyObservationMode,
): StudyObservationMode {
  return OBSERVATION_RANK[incoming] > OBSERVATION_RANK[current] ? incoming : current;
}

/**
 * Derive the XOR target from a confined tool call without retaining arguments,
 * paths, or tool JSON.
 */
export function studyTargetFromToolCall(toolCall: unknown): {
  targetNodeId?: string;
  pathClass?: StudyPathClass;
} {
  const args = toolCallArguments(toolCall);
  const headingId = typeof args.headingId === "string" ? args.headingId : undefined;
  if (headingId !== undefined && isStudyIdentifier(headingId)) {
    return { targetNodeId: headingId };
  }
  const path = typeof args.path === "string" ? args.path : undefined;
  if (path !== undefined && path.length > 0) {
    return { pathClass: classifyStudyPathClass(path) };
  }
  return { pathClass: "other" };
}

export function createStudyEvent(input: CreateStudyEventInput): StudyEventV1 {
  return parseStudyEvent({
    schemaVersion: 1,
    kind: STUDY_EVENT_KIND,
    t: input.t,
    runId: input.runId,
    workflow: input.workflow,
    stepId: input.stepId,
    ...(input.probeId !== undefined ? { probeId: input.probeId } : {}),
    tool: input.tool,
    ...(input.targetNodeId !== undefined ? { targetNodeId: input.targetNodeId } : {}),
    ...(input.pathClass !== undefined ? { pathClass: input.pathClass } : {}),
    disposition: input.disposition,
    durationMs: input.durationMs,
    scheduled: input.scheduled,
  });
}

export function createStudyRun(input: CreateStudyRunInput): StudyRunV1 {
  return parseStudyRun({
    schemaVersion: 1,
    kind: STUDY_RUN_KIND,
    runId: input.runId,
    observationMode: input.observationMode,
    modelRef: input.modelRef,
    events: [...(input.events ?? [])],
  });
}

export function parseStudyEvent(value: unknown): StudyEventV1 {
  kit.assertInert(value);
  kit.rejectCredentials(value);
  assertNoPayloadKeys(value);
  const root = kit.object(value);
  kit.exact(root, STUDY_EVENT_KEYS, STUDY_EVENT_OPTIONAL_KEYS);
  if (root.schemaVersion !== 1 || root.kind !== STUDY_EVENT_KIND) fail("schema-mismatch");
  const t = kit.timestamp(root.t);
  const runId = kit.identifier(root.runId);
  const workflow = kit.identifier(root.workflow);
  const stepId = kit.identifier(root.stepId);
  const tool = kit.identifier(root.tool);
  const disposition = kit.enumeration(root.disposition, STUDY_EVENT_DISPOSITIONS);
  const durationMs = nonNegativeInteger(root.durationMs);
  const scheduled = strictBoolean(root.scheduled);
  const probeId = root.probeId === undefined ? undefined : kit.identifier(root.probeId);
  const targetNodeId =
    root.targetNodeId === undefined ? undefined : kit.identifier(root.targetNodeId);
  const pathClass =
    root.pathClass === undefined ? undefined : kit.enumeration(root.pathClass, STUDY_PATH_CLASSES);
  if (
    (targetNodeId === undefined && pathClass === undefined) ||
    (targetNodeId !== undefined && pathClass !== undefined)
  ) {
    fail("invalid-shape");
  }
  const event: StudyEventV1 = {
    schemaVersion: 1,
    kind: STUDY_EVENT_KIND,
    t,
    runId,
    workflow,
    stepId,
    ...(probeId !== undefined ? { probeId } : {}),
    tool,
    ...(targetNodeId !== undefined ? { targetNodeId } : {}),
    ...(pathClass !== undefined ? { pathClass } : {}),
    disposition,
    durationMs,
    scheduled,
  };
  assertPayloadFreeStrings(event);
  return kit.deepFreeze(event);
}

export function parseStudyRun(value: unknown): StudyRunV1 {
  kit.assertInert(value);
  kit.rejectCredentials(value);
  assertNoPayloadKeys(value);
  const root = kit.object(value);
  kit.exact(root, STUDY_RUN_KEYS);
  if (root.schemaVersion !== 1 || root.kind !== STUDY_RUN_KIND) fail("schema-mismatch");
  const runId = kit.identifier(root.runId);
  const observationMode = kit.enumeration(root.observationMode, STUDY_OBSERVATION_MODES);
  const modelRef = parseModelRef(root.modelRef);
  const events = kit.array(root.events).map(parseStudyEvent);
  if (events.some((event) => event.runId !== runId)) fail("invalid-value");
  const run: StudyRunV1 = {
    schemaVersion: 1,
    kind: STUDY_RUN_KIND,
    runId,
    observationMode,
    modelRef,
    events,
  };
  assertPayloadFreeStrings(run);
  return kit.deepFreeze(run);
}

export function summarizeStudyRun(run: StudyRunV1): StudyRunSummary {
  let scheduled = 0;
  let extra = 0;
  for (const event of run.events) {
    if (event.scheduled) scheduled += 1;
    else extra += 1;
  }
  return {
    runId: run.runId,
    observationMode: run.observationMode,
    modelRef: run.modelRef,
    scheduled,
    extra,
  };
}

/** Human STUDY plane. `--json` still wins at the CLI. */
export function formatStudyPlane(summary: StudyRunSummary): string[] {
  return [
    `STUDY scheduled=${summary.scheduled} extra=${summary.extra}`,
    `NEXT docsfab study show ${summary.runId}`,
  ];
}

function parseModelRef(value: unknown): StudyModelRefV1 {
  const root = kit.object(value);
  kit.exact(root, MODEL_REF_KEYS);
  const provider = kit.identifier(root.provider);
  const catalogId = kit.identifier(root.catalogId);
  assertPayloadFreeString(provider);
  assertPayloadFreeString(catalogId);
  return { provider, catalogId };
}

function nonNegativeInteger(value: unknown): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    Object.is(value, -0) ||
    value < 0
  ) {
    return fail("invalid-value");
  }
  return value;
}

function strictBoolean(value: unknown): boolean {
  if (value !== true && value !== false) return fail("invalid-value");
  return value;
}

function isStudyIdentifier(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/u.test(value);
}

function isInstructionBasename(basename: string): boolean {
  return /^(?:AGENTS|CLAUDE|SKILL)(?:\.md)?$|^CODEOWNERS$/iu.test(basename);
}

function toolCallArguments(toolCall: unknown): Record<string, unknown> {
  if (!toolCall || typeof toolCall !== "object" || Array.isArray(toolCall)) return {};
  const record = toolCall as Record<string, unknown>;
  const fromArguments = decodeArgumentRecord(record.arguments);
  if (fromArguments) return fromArguments;
  const fn = record.function;
  if (fn && typeof fn === "object" && !Array.isArray(fn)) {
    return decodeArgumentRecord((fn as Record<string, unknown>).arguments) ?? {};
  }
  return {};
}

function decodeArgumentRecord(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value !== "string" || value.length === 0 || value.length > 65_536) return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function assertNoPayloadKeys(value: unknown): void {
  if (!value || typeof value !== "object") return;
  const stack: object[] = [value];
  const seen = new Set<object>();
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (seen.has(current)) fail("invalid-shape");
    seen.add(current);
    for (const key of Object.keys(current as Record<string, unknown>)) {
      if (isForbiddenPayloadKey(key)) fail("payload-forbidden");
      const child = (current as Record<string, unknown>)[key];
      if (child && typeof child === "object") stack.push(child);
    }
  }
}

function isForbiddenPayloadKey(key: string): boolean {
  return /^(?:prompt|prompts|content|arguments|result|results|bytes|path|paths|hostPath|toolJson|message|messages|text|body|credential|apiKey|patch)$/u.test(
    key,
  );
}

function assertPayloadFreeStrings(value: unknown): void {
  if (typeof value === "string") {
    assertPayloadFreeString(value);
    return;
  }
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const entry of value) assertPayloadFreeStrings(entry);
    return;
  }
  for (const child of Object.values(value as Record<string, unknown>)) {
    assertPayloadFreeStrings(child);
  }
}

function assertPayloadFreeString(value: string): void {
  if (PROMPT_LIKE.test(value) || value.includes("\0")) {
    fail("payload-forbidden");
  }
  const trimmed = value.trimStart();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) fail("payload-forbidden");
}
