// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export const THREAT_MODEL_REQUIRED_STAGES = [
  "credential-configuration",
  "repository-export",
  "context-selection",
  "prompt-construction",
  "authorization",
  "provider-adapter",
  "catalog-metadata",
  "tool-call-and-result",
  "logs-and-diagnostics",
  "run-records",
  "patch-capture",
  "isolated-validation",
  "git",
  "gitlab",
] as const;

export const THREAT_MODEL_ID = "docsfab-credential-data-boundary-v1" as const;

const MODES = ["hosted-inference", "local-inference", "local-user-gitlab"] as const;
const ZONE_TRUST = [
  "trusted-local-capability",
  "untrusted-content-operator-selected",
  "confined-derived-content",
  "external-operator-approved",
  "owner-private-content-bearing",
  "external-organizational-control",
  "operator-visible-potentially-forwarded",
  "trusted-bounded-orchestration",
  "external-purpose-bound",
  "untrusted-repository-code-os-confined",
  "trusted-fixed-purpose-capability",
] as const;
const CONTROL_STATUS = [
  "retained-and-hardened",
  "retained",
  "required-by-issue-111",
  "retained-from-issue-52-and-hardened",
  "retained-from-issue-37-and-hardened",
  "external-organizational-control",
  "retained-and-documented",
  "retained-from-issue-37",
] as const;

export class ThreatModelContractError extends Error {
  readonly code = "invalid-threat-model-contract" as const;

  constructor() {
    super("Threat model is invalid or incompatible.");
    this.name = "ThreatModelContractError";
  }
}

/** Strict closed parser for the committed canonical threat-model schema. */
export function decodeThreatModelV1(input: string | Uint8Array | unknown): Record<string, unknown> {
  const root = closed(parsed(input), [
    "schemaVersion",
    "modelId",
    "status",
    "scope",
    "requiredStages",
    "invariants",
    "zones",
    "flows",
    "threats",
    "controls",
    "decisions",
    "acceptedRisks",
    "removedControls",
    "outOfScope",
    "reviewGate",
  ]);
  if (
    root.schemaVersion !== 1 ||
    root.modelId !== THREAT_MODEL_ID ||
    root.status !== "review-controlled"
  )
    invalid();
  text(root.scope, 512);
  exactStrings(root.requiredStages, THREAT_MODEL_REQUIRED_STAGES);
  stringArray(root.invariants, 1, 64, 1_024);

  const zones = structuredArray(root.zones, 1, 64, (value) => {
    const zone = closed(value, ["id", "name", "trust", "description"]);
    identifier(zone.id, "Z");
    text(zone.name, 128);
    enumValue(zone.trust, ZONE_TRUST);
    text(zone.description, 1_024);
    return zone;
  });
  unique(zones.map(({ id }) => id));

  const flows = structuredArray(root.flows, 1, 128, (value) => {
    const flow = closed(value, [
      "id",
      "stage",
      "name",
      "sources",
      "destinations",
      "data",
      "sensitive",
      "modes",
      "threats",
      "controls",
    ]);
    identifier(flow.id, "F");
    enumValue(flow.stage, THREAT_MODEL_REQUIRED_STAGES);
    text(flow.name, 256);
    idArray(flow.sources, "Z");
    idArray(flow.destinations, "Z");
    stringArray(flow.data, 1, 32, 256);
    if (typeof flow.sensitive !== "boolean") invalid();
    enumArray(flow.modes, MODES);
    idArray(flow.threats, "T");
    idArray(flow.controls, "C");
    return flow;
  });
  unique(flows.map(({ id }) => id));

  const threats = structuredArray(root.threats, 1, 128, (value) => {
    const threat = closed(value, ["id", "scenario", "impact", "disposition", "flows", "controls"]);
    identifier(threat.id, "T");
    text(threat.scenario, 2_048);
    text(threat.impact, 1_024);
    text(threat.disposition, 256);
    idArray(threat.flows, "F");
    idArray(threat.controls, "C");
    return threat;
  });
  unique(threats.map(({ id }) => id));

  const controls = structuredArray(root.controls, 1, 128, (value) => {
    const control = closed(value, [
      "id",
      "name",
      "status",
      "owner",
      "flows",
      "threats",
      "requirement",
      "verification",
    ]);
    identifier(control.id, "C");
    text(control.name, 256);
    enumValue(control.status, CONTROL_STATUS);
    text(control.owner, 256);
    idArray(control.flows, "F");
    idArray(control.threats, "T");
    text(control.requirement, 2_048);
    text(control.verification, 2_048);
    return control;
  });
  unique(controls.map(({ id }) => id));

  validateGraphSemantics(zones, flows, threats, controls);
  validateGitLabIssueSemantics(zones, flows, threats, controls);

  const decisions = structuredArray(root.decisions, 1, 64, (value) => {
    const decision = closed(value, [
      "id",
      "question",
      "decision",
      "rationale",
      "implementationIssues",
    ]);
    identifier(decision.id, "D");
    text(decision.question, 1_024);
    text(decision.decision, 2_048);
    text(decision.rationale, 2_048);
    positiveIntegerArray(decision.implementationIssues);
    return decision;
  });
  unique(decisions.map(({ id }) => id));
  const lifecycleDecision = decisions.find(({ id }) => id === "D-12");
  if (!lifecycleDecision || !positiveIntegers(lifecycleDecision.implementationIssues).includes(47))
    invalid();
  const cascadeDecision = decisions.find(({ id }) => id === "D-13");
  if (!cascadeDecision || !positiveIntegers(cascadeDecision.implementationIssues).includes(103))
    invalid();

  const risks = structuredArray(root.acceptedRisks, 1, 64, (value) => {
    const risk = closed(value, ["id", "risk", "reason"]);
    identifier(risk.id, "R");
    text(risk.risk, 2_048);
    text(risk.reason, 2_048);
    return risk;
  });
  unique(risks.map(({ id }) => id));

  const removed = structuredArray(root.removedControls, 1, 64, (value) => {
    const control = closed(value, ["id", "control", "reason"]);
    identifier(control.id, "X");
    text(control.control, 1_024);
    text(control.reason, 2_048);
    return control;
  });
  unique(removed.map(({ id }) => id));
  stringArray(root.outOfScope, 1, 64, 1_024);

  const reviewGate = closed(root.reviewGate, [
    "requiredRoles",
    "decision",
    "evidenceKind",
    "approvalRuleNames",
    "binding",
    "verification",
  ]);
  exactStrings(reviewGate.requiredRoles, ["security", "product"]);
  if (
    reviewGate.decision !== "approved" ||
    reviewGate.evidenceKind !== "gitlab-external-approval-verification"
  )
    invalid();
  const ruleNames = closed(reviewGate.approvalRuleNames, ["security", "product"]);
  text(ruleNames.security, 128);
  text(ruleNames.product, 128);
  if (ruleNames.security === ruleNames.product) invalid();
  text(reviewGate.binding, 4_096);
  text(reviewGate.verification, 4_096);

  return root;
}

const GITLAB_ISSUE_FLOWS: ReadonlyArray<
  readonly [string, readonly string[], readonly string[], readonly string[], readonly string[]]
> = [
  ["F-27", ["Z-05", "Z-09"], ["Z-13"], ["T-16", "T-18", "T-19"], ["C-18", "C-19", "C-20", "C-23"]],
  [
    "F-28",
    ["Z-13"],
    ["Z-07"],
    ["T-15", "T-16", "T-18", "T-21"],
    ["C-18", "C-19", "C-22", "C-23", "C-24"],
  ],
  ["F-29", ["Z-07"], ["Z-13"], ["T-21"], ["C-18", "C-22", "C-23", "C-24"]],
  ["F-30", ["Z-13"], ["Z-05", "Z-09", "Z-08"], ["T-18", "T-21"], ["C-18", "C-22", "C-24"]],
  [
    "F-31",
    ["Z-13"],
    ["Z-07"],
    ["T-15", "T-16", "T-17", "T-18", "T-21"],
    ["C-18", "C-19", "C-21", "C-22", "C-23"],
  ],
  [
    "F-32",
    ["Z-13"],
    ["Z-07"],
    ["T-15", "T-16", "T-17", "T-18", "T-21"],
    ["C-18", "C-19", "C-21", "C-22", "C-23"],
  ],
  [
    "F-33",
    ["Z-13"],
    ["Z-07"],
    ["T-15", "T-17", "T-18", "T-21"],
    ["C-18", "C-19", "C-21", "C-22", "C-23"],
  ],
  [
    "F-34",
    ["Z-13"],
    ["Z-07"],
    ["T-15", "T-17", "T-18", "T-21"],
    ["C-18", "C-19", "C-21", "C-22", "C-23"],
  ],
  [
    "F-35",
    ["Z-13"],
    ["Z-07"],
    ["T-15", "T-17", "T-18", "T-21"],
    ["C-18", "C-19", "C-21", "C-22", "C-23"],
  ],
  [
    "F-36",
    ["Z-13"],
    ["Z-07"],
    ["T-15", "T-16", "T-17", "T-18", "T-21"],
    ["C-18", "C-19", "C-21", "C-22", "C-23"],
  ],
  [
    "F-37",
    ["Z-13"],
    ["Z-07"],
    ["T-15", "T-17", "T-18", "T-21"],
    ["C-18", "C-19", "C-21", "C-22", "C-23"],
  ],
  ["F-38", ["Z-07"], ["Z-13"], ["T-17", "T-21"], ["C-18", "C-21", "C-22", "C-23"]],
  [
    "F-39",
    ["Z-13"],
    ["Z-07"],
    ["T-15", "T-16", "T-17", "T-18", "T-21"],
    ["C-18", "C-19", "C-21", "C-22", "C-23"],
  ],
  [
    "F-40",
    ["Z-13"],
    ["Z-05", "Z-08"],
    ["T-17", "T-19", "T-20", "T-21"],
    ["C-18", "C-20", "C-21", "C-22"],
  ],
] as const;

function validateGitLabIssueSemantics(
  zones: Record<string, unknown>[],
  flows: Record<string, unknown>[],
  threats: Record<string, unknown>[],
  controls: Record<string, unknown>[],
): void {
  const adapter = zones.find(({ id }) => id === "Z-13");
  if (
    !adapter ||
    adapter.name !== "host-gitlab-issue-adapters" ||
    adapter.trust !== "trusted-fixed-purpose-capability"
  )
    invalid();
  const flowById = new Map(flows.map((flow) => [flow.id as string, flow]));
  const threatIds = new Set(threats.map(({ id }) => id));
  const controlIds = new Set(controls.map(({ id }) => id));
  for (const [id, sources, destinations, requiredThreats, requiredControls] of GITLAB_ISSUE_FLOWS) {
    const flow = flowById.get(id);
    if (
      !flow ||
      flow.stage !== "gitlab" ||
      canonicalStrings(flow.sources) !== canonicalStrings(sources) ||
      canonicalStrings(flow.destinations) !== canonicalStrings(destinations) ||
      !requiredThreats.every((threat) => ids(flow.threats).includes(threat)) ||
      !requiredControls.every((control) => ids(flow.controls).includes(control))
    )
      invalid();
  }
  for (const id of ["T-15", "T-16", "T-17", "T-18", "T-19", "T-20", "T-21"]) {
    if (!threatIds.has(id)) invalid();
  }
  for (const id of ["C-18", "C-19", "C-20", "C-21", "C-22", "C-23", "C-24"]) {
    if (!controlIds.has(id)) invalid();
  }
}

function canonicalStrings(value: unknown): string {
  return JSON.stringify(value);
}

function positiveIntegers(value: unknown): number[] {
  return value as number[];
}

function validateGraphSemantics(
  zones: Record<string, unknown>[],
  flows: Record<string, unknown>[],
  threats: Record<string, unknown>[],
  controls: Record<string, unknown>[],
): void {
  const zoneIds = new Set(zones.map(({ id }) => id as string));
  const flowById = new Map(flows.map((flow) => [flow.id as string, flow]));
  const threatById = new Map(threats.map((threat) => [threat.id as string, threat]));
  const controlById = new Map(controls.map((control) => [control.id as string, control]));
  const representedStages = new Set(flows.map(({ stage }) => stage as string));
  if (THREAT_MODEL_REQUIRED_STAGES.some((stage) => !representedStages.has(stage))) invalid();

  for (const flow of flows) {
    const flowId = flow.id as string;
    for (const zoneId of [...ids(flow.sources), ...ids(flow.destinations)]) {
      if (!zoneIds.has(zoneId)) invalid();
    }
    for (const threatId of ids(flow.threats)) {
      const threat = threatById.get(threatId);
      if (!threat || !ids(threat.flows).includes(flowId)) invalid();
    }
    for (const controlId of ids(flow.controls)) {
      const control = controlById.get(controlId);
      if (!control || !ids(control.flows).includes(flowId)) invalid();
    }
  }

  for (const threat of threats) {
    const threatId = threat.id as string;
    for (const flowId of ids(threat.flows)) {
      const flow = flowById.get(flowId);
      if (!flow || !ids(flow.threats).includes(threatId)) invalid();
    }
    for (const controlId of ids(threat.controls)) {
      const control = controlById.get(controlId);
      if (!control || !ids(control.threats).includes(threatId)) invalid();
    }
  }

  for (const control of controls) {
    const controlId = control.id as string;
    for (const flowId of ids(control.flows)) {
      const flow = flowById.get(flowId);
      if (!flow || !ids(flow.controls).includes(controlId)) invalid();
    }
    for (const threatId of ids(control.threats)) {
      const threat = threatById.get(threatId);
      if (!threat || !ids(threat.controls).includes(controlId)) invalid();
    }
  }
}

function ids(value: unknown): string[] {
  return value as string[];
}

function parsed(value: string | Uint8Array | unknown): unknown {
  if (typeof value !== "string" && !(value instanceof Uint8Array)) return value;
  try {
    return JSON.parse(typeof value === "string" ? value : Buffer.from(value).toString("utf8"));
  } catch {
    invalid();
  }
}

function closed(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    invalid();
  const root = value as Record<string, unknown>;
  if (Object.keys(root).length !== keys.length || keys.some((key) => !Object.hasOwn(root, key)))
    invalid();
  return root;
}

function structuredArray(
  value: unknown,
  minimum: number,
  maximum: number,
  parse: (entry: unknown) => Record<string, unknown>,
): Record<string, unknown>[] {
  return denseArray(value, minimum, maximum).map(parse);
}

function denseArray(value: unknown, minimum: number, maximum: number): unknown[] {
  if (
    !Array.isArray(value) ||
    value.length < minimum ||
    value.length > maximum ||
    Object.keys(value).length !== value.length
  )
    invalid();
  return value;
}

function stringArray(
  value: unknown,
  minimum: number,
  maximum: number,
  textMaximum: number,
): string[] {
  const result = denseArray(value, minimum, maximum);
  for (const entry of result) text(entry, textMaximum);
  unique(result);
  return result as string[];
}

function idArray(value: unknown, prefix: string): string[] {
  const result = denseArray(value, 1, 128);
  for (const entry of result) identifier(entry, prefix);
  unique(result);
  return result as string[];
}

function enumArray<T extends string>(value: unknown, allowed: readonly T[]): T[] {
  const result = denseArray(value, 1, allowed.length);
  for (const entry of result) enumValue(entry, allowed);
  unique(result);
  return result as T[];
}

function positiveIntegerArray(value: unknown): number[] {
  const result = denseArray(value, 1, 64);
  for (const entry of result) {
    if (!Number.isSafeInteger(entry) || (entry as number) <= 0) invalid();
  }
  unique(result);
  return result as number[];
}

function exactStrings(value: unknown, expected: readonly string[]): void {
  const actual = stringArray(value, expected.length, expected.length, 256);
  if (actual.some((entry, index) => entry !== expected[index])) invalid();
}

function identifier(value: unknown, prefix: string): asserts value is string {
  if (typeof value !== "string" || !new RegExp(`^${prefix}-\\d{2}$`, "u").test(value)) invalid();
}

function enumValue<T extends string>(value: unknown, allowed: readonly T[]): asserts value is T {
  if (typeof value !== "string" || !allowed.includes(value as T)) invalid();
}

function text(value: unknown, maximum: number): asserts value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximum ||
    value.trim() !== value ||
    /[\u0000-\u001f\u007f]/u.test(value)
  )
    invalid();
}

function unique(values: readonly unknown[]): void {
  if (new Set(values).size !== values.length) invalid();
}

function invalid(): never {
  throw new ThreatModelContractError();
}
