// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** Local tool bindings for the verified, portable skill invocation contract. */
import {
  InvocationContractError,
  resolveInvocationContract,
  type InvocationContract,
  type InvocationHostCapabilities,
} from "../execution/invocation-contracts.js";
import {
  selectSkillInvocationProfile,
  type InvocationCallerField,
  type SkillInvocationMetadata,
} from "../skills/invocation-metadata.js";

const READER_FIELDS = ["readerContext", "readerSources", "readerComparison"] as const;

export function suppliedReaderFields(parameters: Record<string, unknown>): InvocationCallerField[] {
  return READER_FIELDS.filter((field) => parameters[field] !== undefined);
}

export function directAssessmentContract(
  metadata: SkillInvocationMetadata,
  capabilities: InvocationHostCapabilities,
) {
  const profile = metadata.profiles.find(
    (entry) => entry.operation === "load-reader-assessment-guidance",
  );
  if (!profile) return undefined;
  return resolveInvocationContract({
    operation: profile.operation,
    profile,
    binding: {
      kind: "live-skill",
      skillId: metadata.skillId,
      profileId: profile.id,
      restrictions: { requireReadOnly: true, requireObservationSupplier: true },
    },
    capabilities,
    callerFields: profile.requiredCallerFields,
  });
}

export function availableAssessmentSkills(
  skills: readonly { invocation?: SkillInvocationMetadata }[],
  capabilities: InvocationHostCapabilities,
): string[] {
  if (capabilities.allowWrite || !capabilities.observationSupplierAvailable) return [];
  return skills.flatMap(({ invocation }) => {
    if (!invocation) return [];
    return directAssessmentContract(invocation, capabilities) ? [invocation.skillId] : [];
  });
}

export function resolveLiveSkillInvocation(input: {
  metadata: SkillInvocationMetadata;
  parameters: Record<string, unknown>;
  capabilities: InvocationHostCapabilities;
}) {
  const fields = suppliedReaderFields(input.parameters);
  const reference =
    input.parameters.reference !== undefined && input.parameters.reference !== "SKILL.md";
  const assessment =
    !reference &&
    fields.length > 0 &&
    !input.capabilities.allowWrite &&
    input.metadata.profiles.some(
      (profile) => profile.operation === "load-reader-assessment-guidance",
    );
  const operation = reference
    ? "load-supporting-reference"
    : assessment
      ? "load-reader-assessment-guidance"
      : "load-guidance";
  const profile = selectSkillInvocationProfile(input.metadata, { operation });
  // Plain loads tolerate reader fields but never admit or observe them as evidence.
  const unadmittedFields = operation === "load-guidance" ? fields : [];
  const contract = resolveInvocationContract({
    operation,
    profile,
    binding: {
      kind: "live-skill",
      skillId: input.metadata.skillId,
      profileId: profile.id,
      ...(assessment
        ? { restrictions: { requireReadOnly: true, requireObservationSupplier: true } }
        : {}),
    },
    capabilities: input.capabilities,
    callerFields: operation === "load-guidance" ? [] : fields,
  });
  return { contract, unadmittedFields };
}

/**
 * The one live declaration of which workflows take reader fields.
 *
 * Admission, tool field descriptions, prompt guidance, and reader-task-context
 * observation derive from this list. Adding a workflow needs matching step
 * bindings, not only a list edit.
 */
export const LIVE_READER_INTAKE_WORKFLOWS = ["update-documentation"] as const;

export function workflowTakesReaderFields(workflow: string): boolean {
  return (LIVE_READER_INTAKE_WORKFLOWS as readonly string[]).includes(workflow);
}

export function readerIntakeWorkflows(installed: readonly string[]): string[] {
  return LIVE_READER_INTAKE_WORKFLOWS.filter((workflow) => installed.includes(workflow));
}

/** Fixed model-facing note for a workflow that started without the reader fields it was sent. */
export function unadmittedWorkflowReaderFieldsNote(intake: readonly string[]): string {
  const owners =
    intake.length > 0 ? `only ${intake.join(", ")} takes them` : "no installed workflow takes them";
  return `DocsFab started this workflow without the reader fields you supplied; ${owners}. They were not admitted, observed, or used as evidence. The workflow reads its own sources from the instruction.`;
}

/**
 * Bind intake to the planner's declared input profile; the supplier still validates evidence.
 *
 * A workflow that does not take reader fields still starts, so the agent keeps
 * the governed workflow. The host reports the fields as unadmitted and never
 * decodes, observes, or passes them to the run.
 */
export function resolveLiveWorkflowInvocation(input: {
  planner?: SkillInvocationMetadata;
  workflow: string;
  parameters: Record<string, unknown>;
  capabilities: InvocationHostCapabilities;
}): {
  readonly readerIntake: boolean;
  readonly unadmittedFields: readonly InvocationCallerField[];
  readonly contract?: InvocationContract;
} {
  const fields = suppliedReaderFields(input.parameters);
  const readerIntake = workflowTakesReaderFields(input.workflow);
  const unadmittedFields = readerIntake ? [] : fields;
  // Narrow legacy tool fixtures have no catalog. Installed hosts supply verified metadata.
  if (!input.planner) return { readerIntake, unadmittedFields };
  const operation = readerIntake ? "load-reader-assessment-guidance" : "load-guidance";
  const profile = selectSkillInvocationProfile(input.planner, { operation });
  const contract = resolveInvocationContract({
    operation,
    profile,
    binding: {
      kind: "live-workflow",
      workflowId: input.workflow,
      skillId: input.planner.skillId,
      profileId: profile.id,
      ...(readerIntake ? { restrictions: { requireObservationSupplier: true } } : {}),
    },
    capabilities: input.capabilities,
    // The host supplies conservative input when the caller does not supply explicit intent.
    callerFields: readerIntake ? [...new Set([...profile.requiredCallerFields, ...fields])] : [],
  });
  return { readerIntake, unadmittedFields, contract };
}

// Pi preserves thrown error text and marks the result failed, but discards custom Error fields.
// Keep that bridge payload closed and content-free; never serialize the original message.
const DIAGNOSTICS = {
  "unsupported-context":
    "This call does not accept reader fields. Load the supporting reference without them; keep an explicit reader assessment in its supported assessment path.",
  "unsupported-operation":
    "This skill does not support the requested operation. Choose an operation advertised by the installed tools.",
  "missing-host-capability":
    "Reader assessment is unavailable in this session. Preserve the assessment request; ordinary instruction loading remains available.",
  "required-context":
    "Reader assessment requires explicit reader context. Supply the bounded request intent before requesting observation.",
  "phase-mismatch":
    "The requested context does not match this invocation. Use the inputs advertised by the selected tool.",
  "incompatible-binding":
    "This invocation is unavailable in the current host mode. Preserve the assessment request and use a supported session.",
} as const;
const RECOVERIES = [
  "retry-load-without-reader-fields",
  "use-supported-assessment-path",
  "retry-in-read-only-session",
  "retry-when-supplier-available",
  "supply-required-reader-context",
  "none",
] as const;

export function invocationBridgeError(error: unknown): never {
  if (!(error instanceof InvocationContractError)) throw error;
  throw new Error(
    JSON.stringify({
      kind: "docsfab-invocation-error",
      code: error.code,
      fields: error.fields.filter((field) => READER_FIELDS.includes(field)),
      recovery: error.recovery,
    }),
  );
}

export function invocationFailureReason(message: string): string | undefined {
  if (!message.startsWith('{"kind":"docsfab-invocation-error",')) return undefined;
  try {
    const value = JSON.parse(message);
    if (
      Object.keys(value).sort().join(",") !== "code,fields,kind,recovery" ||
      value.kind !== "docsfab-invocation-error" ||
      !Object.hasOwn(DIAGNOSTICS, value.code) ||
      !Array.isArray(value.fields) ||
      value.fields.length > READER_FIELDS.length ||
      !value.fields.every((field: unknown) =>
        READER_FIELDS.includes(field as InvocationCallerField),
      ) ||
      !RECOVERIES.includes(value.recovery)
    )
      return undefined;
    return DIAGNOSTICS[value.code as keyof typeof DIAGNOSTICS];
  } catch {
    return undefined;
  }
}

export function liveInvocationGuidance(
  assessmentSkills: readonly string[],
  installedWorkflows: readonly string[],
): string {
  const assessment =
    assessmentSkills.length > 0
      ? `Direct reader assessment accepts readerContext, readerSources, and readerComparison only with ${assessmentSkills.join(", ")} in this read-only session.`
      : "Direct reader assessment is unavailable in this session; ordinary skill loading remains available.";
  const intake = readerIntakeWorkflows(installedWorkflows);
  const workflows =
    intake.length > 0
      ? `Workflow reader fields belong only to ${intake.join(", ")}, which also accepts an ordinary instruction with conservative fallback. Other workflows start without them.`
      : "No installed workflow takes reader fields.";
  return `Normally load skills with skill and an optional reference only. Loading instructions does not assess reader evidence. ${assessment} ${workflows} The host verifies comparison, snapshot, and source identity; never invent those identities from conversation memory.`;
}
