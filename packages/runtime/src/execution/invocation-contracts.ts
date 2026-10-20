// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Pure invocation compatibility resolver. Host mode and authority stay in
 * bindings; metadata is neither an evidence seal nor a grant.
 */
import { createContractKit, type ContractFail } from "../contract-kit/index.js";
import {
  decodeSkillInvocationProfile,
  type InvocationApplicationResultKind,
  type InvocationCallerField,
  type InvocationContextPhase,
  type InvocationImmediateToolResultKind,
  type InvocationOperation,
  type InvocationParticipantContext,
  type InvocationSchemaReference,
  type SkillInvocationProfile,
} from "../skills/invocation-metadata.js";

export type InvocationContractErrorCode =
  | "unsupported-context"
  | "unsupported-operation"
  | "missing-host-capability"
  | "required-context"
  | "phase-mismatch"
  | "incompatible-binding";
export type InvocationRecoveryAction =
  | "retry-load-without-reader-fields"
  | "use-supported-assessment-path"
  | "retry-in-read-only-session"
  | "retry-when-supplier-available"
  | "supply-required-reader-context"
  | "none";
export type InvocationHostRequirement =
  | "verified-crate"
  | "exact-locked-reference"
  | "read-only-session"
  | "observation-supplier"
  | "validated-reader-input"
  | "completed-reader-context";
export type InvocationBindingKind = "live-skill" | "live-workflow" | "workflow-step";

const BINDING_KINDS = [
  "live-skill",
  "live-workflow",
  "workflow-step",
] as const satisfies readonly InvocationBindingKind[];
const OPERATIONS = [
  "load-guidance",
  "load-supporting-reference",
  "load-reader-assessment-guidance",
  "execute-workflow-step",
] as const satisfies readonly InvocationOperation[];
const CALLER_FIELDS = [
  "readerContext",
  "readerSources",
  "readerComparison",
] as const satisfies readonly InvocationCallerField[];
const CONTEXT_PHASES = [
  "absent",
  "reader-input",
  "completed-reader-context",
] as const satisfies readonly InvocationContextPhase[];

const ERROR_MESSAGES: Readonly<Record<InvocationContractErrorCode, string>> = {
  "unsupported-context":
    "This invocation does not admit the supplied reader-context caller fields.",
  "unsupported-operation": "The selected invocation profile does not support that operation.",
  "missing-host-capability":
    "The current host is missing a capability required by this invocation.",
  "required-context": "This invocation requires explicit reader-context caller fields.",
  "phase-mismatch": "The selected binding requested a different reader-context phase.",
  "incompatible-binding": "The runtime binding is incompatible with the selected invocation.",
};

export class InvocationContractError extends Error {
  public readonly code: InvocationContractErrorCode;
  public readonly fields: readonly InvocationCallerField[];
  public readonly recovery: InvocationRecoveryAction;

  public constructor(
    code: InvocationContractErrorCode,
    options: {
      fields?: readonly InvocationCallerField[];
      recovery?: InvocationRecoveryAction;
      message?: string;
    } = {},
  ) {
    super(options.message ?? ERROR_MESSAGES[code]);
    this.name = "InvocationContractError";
    this.code = code;
    this.fields = Object.freeze([...(options.fields ?? [])]);
    this.recovery = options.recovery ?? "none";
  }
}

export interface InvocationHostCapabilities {
  crateVerified: boolean;
  allowWrite: boolean;
  observationSupplierAvailable: boolean;
}

export interface InvocationRuntimeBinding {
  kind: InvocationBindingKind;
  profileId: string;
  skillId?: string;
  workflowId?: string;
  stepId?: string;
  expectedContextPhase?: InvocationContextPhase;
  restrictions?: {
    requireReadOnly?: boolean;
    requireObservationSupplier?: boolean;
  };
}

export interface InvocationResolveRequest {
  operation: InvocationOperation;
  profile: SkillInvocationProfile;
  binding?: InvocationRuntimeBinding;
  capabilities: InvocationHostCapabilities;
  callerFields?: readonly InvocationCallerField[];
}

export interface InvocationContract {
  operation: InvocationOperation;
  profileId: string;
  skillId: string | null;
  workflowId: string | null;
  stepId: string | null;
  contextPhase: InvocationContextPhase;
  acceptedCallerFields: readonly InvocationCallerField[];
  requiredCallerFields: readonly InvocationCallerField[];
  schemaReferences: readonly InvocationSchemaReference[];
  immediateToolResultKind: InvocationImmediateToolResultKind;
  applicationResultKind: InvocationApplicationResultKind;
  participantContext: InvocationParticipantContext;
  hostRequirements: readonly InvocationHostRequirement[];
  metadataIsGrant: false;
}

function failShape(): never {
  // hygiene: envelope
  throw new InvocationContractError("incompatible-binding", {
    message: "The invocation resolver input failed closed schema validation.",
  });
}

const kit = createContractKit<InvocationContractErrorCode>({
  fail: failShape as ContractFail<InvocationContractErrorCode>,
  inertMode: "strict",
  codes: {
    invalidShape: "incompatible-binding",
    invalidValue: "incompatible-binding",
    digestMismatch: "incompatible-binding",
    credentialMaterial: "incompatible-binding",
    schemaMismatch: "incompatible-binding",
  },
});

function booleanValue(value: unknown): boolean {
  if (typeof value !== "boolean") failShape();
  return value;
}

function reject(
  code: InvocationContractErrorCode,
  options: ConstructorParameters<typeof InvocationContractError>[1] = {},
): never {
  throw new InvocationContractError(code, options);
}

function decodeCallerFields(value: unknown): InvocationCallerField[] {
  if (value === undefined) return [];
  const fields = kit.array(value).map((item) => kit.enumeration(item, CALLER_FIELDS));
  kit.unique(fields);
  return fields;
}

function decodeCapabilities(value: unknown): InvocationHostCapabilities {
  kit.assertInert(value);
  const root = kit.object(value);
  kit.exact(root, ["crateVerified", "allowWrite", "observationSupplierAvailable"]);
  return kit.deepFreeze({
    crateVerified: booleanValue(root.crateVerified),
    allowWrite: booleanValue(root.allowWrite),
    observationSupplierAvailable: booleanValue(root.observationSupplierAvailable),
  });
}

function decodeRestrictions(value: unknown): InvocationRuntimeBinding["restrictions"] {
  if (value === undefined) return undefined;
  const root = kit.object(value);
  kit.exact(
    root,
    ["requireReadOnly", "requireObservationSupplier"],
    ["requireReadOnly", "requireObservationSupplier"],
  );
  return kit.deepFreeze({
    ...(root.requireReadOnly === undefined
      ? {}
      : { requireReadOnly: booleanValue(root.requireReadOnly) }),
    ...(root.requireObservationSupplier === undefined
      ? {}
      : { requireObservationSupplier: booleanValue(root.requireObservationSupplier) }),
  });
}

function decodeBinding(value: unknown): InvocationRuntimeBinding | undefined {
  if (value === undefined) return undefined;
  kit.assertInert(value);
  const root = kit.object(value);
  kit.exact(
    root,
    [
      "kind",
      "profileId",
      "skillId",
      "workflowId",
      "stepId",
      "expectedContextPhase",
      "restrictions",
    ],
    ["skillId", "workflowId", "stepId", "expectedContextPhase", "restrictions"],
  );
  return kit.deepFreeze({
    kind: kit.enumeration(root.kind, BINDING_KINDS),
    profileId: kit.identifier(root.profileId),
    ...(root.skillId === undefined ? {} : { skillId: kit.identifier(root.skillId) }),
    ...(root.workflowId === undefined ? {} : { workflowId: kit.identifier(root.workflowId) }),
    ...(root.stepId === undefined ? {} : { stepId: kit.identifier(root.stepId) }),
    ...(root.expectedContextPhase === undefined
      ? {}
      : { expectedContextPhase: kit.enumeration(root.expectedContextPhase, CONTEXT_PHASES) }),
    ...(root.restrictions === undefined
      ? {}
      : { restrictions: decodeRestrictions(root.restrictions) }),
  });
}

function hostRequirements(
  profile: SkillInvocationProfile,
  binding: InvocationRuntimeBinding | undefined,
): InvocationHostRequirement[] {
  const requirements: InvocationHostRequirement[] = ["verified-crate"];
  if (profile.operation === "load-supporting-reference")
    requirements.push("exact-locked-reference");
  if (binding?.restrictions?.requireReadOnly) requirements.push("read-only-session");
  if (binding?.restrictions?.requireObservationSupplier) {
    requirements.push("observation-supplier");
  }
  if (profile.contextPhase === "reader-input" && profile.operation === "execute-workflow-step") {
    requirements.push("validated-reader-input");
  }
  if (profile.contextPhase === "completed-reader-context") {
    requirements.push("completed-reader-context");
  }
  return requirements;
}

function recoveryFor(
  code: InvocationContractErrorCode,
  operation: InvocationOperation,
): InvocationRecoveryAction {
  if (code === "unsupported-context" && operation !== "load-reader-assessment-guidance") {
    return "retry-load-without-reader-fields";
  }
  if (code === "unsupported-context") return "use-supported-assessment-path";
  if (code === "required-context") return "supply-required-reader-context";
  if (code === "missing-host-capability") {
    return operation === "load-reader-assessment-guidance"
      ? "retry-when-supplier-available"
      : "retry-in-read-only-session";
  }
  return "none";
}

export function resolveInvocationContract(request: InvocationResolveRequest): InvocationContract {
  kit.assertInert(request);
  const root = kit.object(request);
  kit.exact(
    root,
    ["operation", "profile", "binding", "capabilities", "callerFields"],
    ["binding", "callerFields"],
  );
  const operation = kit.enumeration(root.operation, OPERATIONS);
  const profile = decodeSkillInvocationProfile(root.profile);
  const binding = decodeBinding(root.binding);
  const capabilities = decodeCapabilities(root.capabilities);
  const callerFields = decodeCallerFields(root.callerFields);
  const extraFields = callerFields.filter((field) => !profile.acceptedCallerFields.includes(field));
  const missingFields = profile.requiredCallerFields.filter(
    (field) => !callerFields.includes(field),
  );

  if (profile.operation !== operation) {
    reject("unsupported-operation", { recovery: recoveryFor("unsupported-operation", operation) });
  }
  if (binding && binding.profileId !== profile.id) {
    reject("incompatible-binding", { recovery: "none" });
  }
  if (binding?.expectedContextPhase && binding.expectedContextPhase !== profile.contextPhase) {
    reject("phase-mismatch", { recovery: "none" });
  }
  if (!capabilities.crateVerified) {
    reject("missing-host-capability", {
      recovery: recoveryFor("missing-host-capability", operation),
    });
  }
  if (binding?.restrictions?.requireReadOnly === true && capabilities.allowWrite) {
    reject("incompatible-binding", {
      recovery: "retry-in-read-only-session",
      message: "Direct reader-impact assessment requires a read-only live-agent session.",
    });
  }
  if (
    binding?.restrictions?.requireObservationSupplier === true &&
    !capabilities.observationSupplierAvailable
  ) {
    reject("missing-host-capability", {
      recovery: "retry-when-supplier-available",
      message: "Direct reader-impact observation is unavailable in this live-agent session.",
    });
  }
  if (extraFields.length > 0) {
    reject("unsupported-context", {
      fields: extraFields,
      recovery: recoveryFor("unsupported-context", operation),
    });
  }
  if (missingFields.length > 0) {
    reject("required-context", {
      fields: missingFields,
      recovery: recoveryFor("required-context", operation),
    });
  }

  return kit.deepFreeze({
    operation,
    profileId: profile.id,
    skillId: binding?.skillId ?? null,
    workflowId: binding?.workflowId ?? null,
    stepId: binding?.stepId ?? null,
    contextPhase: profile.contextPhase,
    acceptedCallerFields: profile.acceptedCallerFields,
    requiredCallerFields: profile.requiredCallerFields,
    schemaReferences: profile.schemaReferences,
    immediateToolResultKind: profile.immediateToolResultKind,
    applicationResultKind: profile.applicationResultKind,
    participantContext: profile.participantContext,
    hostRequirements: hostRequirements(profile, binding),
    metadataIsGrant: false,
  });
}

export function invocationHostCapabilitiesFixture(
  overrides: Partial<InvocationHostCapabilities> = {},
): InvocationHostCapabilities {
  return {
    crateVerified: true,
    allowWrite: false,
    observationSupplierAvailable: true,
    ...overrides,
  };
}

export function invocationRuntimeBindingFixture(
  overrides: Partial<InvocationRuntimeBinding> = {},
): InvocationRuntimeBinding {
  return {
    kind: "live-skill",
    profileId: "plain-guidance",
    ...overrides,
  };
}

export function invocationResolveRequestFixture(
  profile: SkillInvocationProfile,
  overrides: Partial<InvocationResolveRequest> = {},
): InvocationResolveRequest {
  return {
    operation: profile.operation,
    profile,
    capabilities: invocationHostCapabilitiesFixture(),
    callerFields: [],
    ...overrides,
  };
}

/** Independent expected compatibility cases. Do not derive these from generated descriptors. */
export const INVOCATION_COMPATIBILITY_CASES = [
  {
    id: "write-plain-guidance",
    skillId: "write-documentation",
    operation: "load-guidance" as const,
    profileId: "plain-guidance",
    callerFields: [] as const,
    expected: {
      contextPhase: "absent" as const,
      immediateToolResultKind: "instructions-loaded" as const,
      applicationResultKind: "none" as const,
    },
  },
  {
    id: "write-reference-load",
    skillId: "write-documentation",
    operation: "load-supporting-reference" as const,
    profileId: "supporting-reference",
    callerFields: [] as const,
    expected: {
      contextPhase: "absent" as const,
      immediateToolResultKind: "reference-loaded" as const,
      applicationResultKind: "none" as const,
    },
  },
  {
    id: "plan-reader-assessment",
    skillId: "plan-documentation",
    operation: "load-reader-assessment-guidance" as const,
    profileId: "direct-reader-assessment",
    callerFields: ["readerContext"] as const,
    binding: {
      kind: "live-skill" as const,
      profileId: "direct-reader-assessment",
      restrictions: { requireReadOnly: true, requireObservationSupplier: true },
    },
    expected: {
      contextPhase: "reader-input" as const,
      immediateToolResultKind: "instructions-plus-input-projection" as const,
      applicationResultKind: "none" as const,
    },
  },
  {
    id: "write-completed-workflow-step",
    skillId: "write-documentation",
    operation: "execute-workflow-step" as const,
    profileId: "workflow-step-completed-reader-context",
    callerFields: [] as const,
    binding: {
      kind: "workflow-step" as const,
      profileId: "workflow-step-completed-reader-context",
      expectedContextPhase: "completed-reader-context" as const,
    },
    expected: {
      contextPhase: "completed-reader-context" as const,
      immediateToolResultKind: "workflow-step-result" as const,
      applicationResultKind: "authoring-result" as const,
    },
  },
] as const;
