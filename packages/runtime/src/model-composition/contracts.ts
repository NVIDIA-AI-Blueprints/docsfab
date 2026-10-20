// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  canonicalDigest,
  canonicalJson,
  createContractKit,
  deepFreeze,
} from "../contract-kit/index.js";
import {
  INSTALLED_COMPOSITION_RETIREMENT_REASONS,
  INSTALLED_COMPOSITION_STATUSES,
  MODEL_COMPOSITION_ADAPTER_KINDS,
  MODEL_COMPOSITION_ASSET_KINDS,
  ModelCompositionError,
  type AuthenticationAdapterRecord,
  type HarnessAdapterRecord,
  type InstalledAnswerSubmission,
  type InstalledAnswerSubmissionRecords,
  type InstalledCandidateProjection,
  type InstalledCompositionRetirement,
  type InstalledExecutionComposition,
  type InstalledModelCompositionAdapter,
  type InstalledWorkflowComposition,
  type ModelCompositionAdapterReference,
  type ModelCompositionAssetKind,
  type ModelCompositionErrorCode,
  type ModelCompositionExecutionClass,
  type ModelCompositionTransport,
  isInstalledPolicyRoute,
  type InstalledPolicyRouteId,
  type InstalledReasoningControl,
  type InstalledRequestPolicy,
  type ProviderConnectionAdapterRecord,
  type CompositionModelLimits,
  type RouteEvidenceAdapterRecord,
} from "./types.js";

const CONTRACT_KINDS = {
  adapterRegistry: "docsfab-model-composition-adapter-registry/v1",
  candidateProjections: "docsfab-model-candidate-projections/v1",
  compositionRegistry: "docsfab-model-composition-registry/v1",
  installedManifest: "docsfab-installed-model-composition-manifest/v1",
  workflowCatalog: "docsfab-model-composition-workflow-catalog/v1",
} as const;

const kit = createContractKit<ModelCompositionErrorCode>({
  fail: (code) => {
    throw new ModelCompositionError(code);
  },
  codes: {
    invalidShape: "contract-invalid-shape",
    invalidValue: "contract-invalid-value",
    digestMismatch: "contract-digest-mismatch",
    credentialMaterial: "contract-credential-material",
    schemaMismatch: "migration-required",
  },
  inertMode: "strict",
});

const COMPOSITION_TRANSPORTS = [
  "openai-chat-completions",
  "openai-responses",
  "anthropic-messages",
  "opaque-cli-managed",
] as const;
const EXECUTION_CLASSES = ["pi-provider", "preflight-only"] as const;

interface CompositionRegistry {
  readonly schemaVersion: 1;
  readonly kind: typeof CONTRACT_KINDS.compositionRegistry;
  readonly compositions: readonly InstalledExecutionComposition[];
  readonly registrySha256: string;
}

interface CandidateProjectionRegistry {
  readonly schemaVersion: 1;
  readonly kind: typeof CONTRACT_KINDS.candidateProjections;
  readonly candidates: readonly InstalledCandidateProjection[];
  readonly registrySha256: string;
}

interface AdapterRegistry {
  readonly schemaVersion: 1;
  readonly kind: typeof CONTRACT_KINDS.adapterRegistry;
  readonly adapters: readonly InstalledModelCompositionAdapter[];
  readonly registrySha256: string;
}

interface WorkflowCatalog {
  readonly schemaVersion: 1;
  readonly kind: typeof CONTRACT_KINDS.workflowCatalog;
  readonly workflows: readonly InstalledWorkflowComposition[];
  readonly catalogSha256: string;
}

export interface InstalledManifestAssetRecord {
  readonly kind: ModelCompositionAssetKind;
  readonly path: string;
  readonly fileSha256: string;
  readonly contractSha256: string;
}

export interface InstalledModelCompositionManifest {
  readonly schemaVersion: 1;
  readonly kind: typeof CONTRACT_KINDS.installedManifest;
  readonly assets: readonly InstalledManifestAssetRecord[];
  readonly compositionCeiling: CompositionModelLimits;
  readonly compositionCeilingSha256: string;
  readonly installedManifestSha256: string;
}

function positiveInteger(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new ModelCompositionError("contract-invalid-value");
  }
  return value as number;
}

function nonnegativeInteger(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    // hygiene: envelope
    throw new ModelCompositionError(
      "contract-invalid-value",
      "Expected a nonnegative whole-number contract field value here.",
    ); // hygiene: envelope
  }
  return value as number;
}

function positiveFinite(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    // hygiene: envelope
    throw new ModelCompositionError(
      "contract-invalid-value",
      "Expected a positive finite numeric value for this contract field.",
    ); // hygiene: envelope
  }
  return value;
}

function nonemptyIdentifiers(value: unknown): string[] {
  const values = kit.array(value).map((entry) => kit.identifier(entry));
  if (values.length === 0 || new Set(values).size !== values.length) {
    throw new ModelCompositionError("contract-invalid-value");
  }
  return values;
}

function semanticVersion(value: unknown): string {
  const version = kit.identifier(value);
  if (!/^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/u.test(version)) {
    throw new ModelCompositionError("contract-invalid-value");
  }
  return version;
}

function limits(value: unknown): CompositionModelLimits {
  const root = kit.object(value);
  kit.exact(root, [
    "contextWindow",
    "maxInputTokens",
    "maxOutputTokens",
    "maxProviderTurns",
    "timeoutMs",
    "maxResponseBytes",
  ]);
  const normalized = {
    contextWindow: positiveInteger(root.contextWindow),
    maxInputTokens: positiveInteger(root.maxInputTokens),
    maxOutputTokens: positiveInteger(root.maxOutputTokens),
    maxProviderTurns: positiveInteger(root.maxProviderTurns),
    timeoutMs: positiveInteger(root.timeoutMs),
    maxResponseBytes: positiveInteger(root.maxResponseBytes),
  };
  if (
    normalized.maxInputTokens > normalized.contextWindow ||
    normalized.maxOutputTokens > normalized.contextWindow
  ) {
    throw new ModelCompositionError("contract-invalid-value");
  }
  return normalized;
}

function adapterReference(value: unknown): ModelCompositionAdapterReference {
  const root = kit.object(value);
  kit.exact(root, ["id", "version"]);
  return {
    id: kit.identifier(root.id),
    version: semanticVersion(root.version),
  };
}

function decodeReasoningControl(value: unknown): InstalledReasoningControl {
  const root = kit.object(value);
  // A closed union, decoded by discriminant. An unrecognized control must be
  // unconfigurable rather than pass through: `reasoning_effort` is accepted
  // with HTTP 200 by every Nemotron SKU measured and suppresses reasoning on
  // none of them, so a permissive decoder here buys a policy that validates
  // clean and does nothing.
  if (root.kind === "system-directive") {
    kit.exact(root, ["kind", "directive"]);
    if (root.directive !== "/no_think") throw new ModelCompositionError("contract-invalid-value");
    return { kind: "system-directive", directive: "/no_think" };
  }
  if (root.kind === "chat-template-kwarg") {
    kit.exact(root, ["kind", "thinking"]);
    if (root.thinking !== false) throw new ModelCompositionError("contract-invalid-value");
    return { kind: "chat-template-kwarg", thinking: false };
  }
  throw new ModelCompositionError("contract-invalid-value");
}

/**
 * Authentication each policy-carrying route requires of its compositions.
 *
 * This is the single place that knows what a route demands. Adding a governed
 * route is an entry here plus its id in `InstalledPolicyRouteId` — not another
 * branch in the composition check below, which reads this table.
 */
const POLICY_ROUTE_BINDINGS: Readonly<
  Record<
    InstalledPolicyRouteId,
    {
      provider: string;
      credentialFamily: string;
      sourceName: string;
      /**
       * Whether every composition on the route must carry an installed request
       * policy. The catalog route exists only to serve reasoning-split Nemotron
       * SKUs, so a policyless record there is a defect. The Inference Hub route
       * also fronts models that are not reasoning-split, for which the Nemotron
       * controls do not apply and the provider refuses the policy's fixed
       * sampling; those records declare no policy and are driven by the
       * provider-neutral finalizer (see `createProviderConnectionFactory`).
       */
      policy: "required" | "optional";
    }
  >
> = Object.freeze({
  "nvidia-api-catalog": {
    provider: "nvidia",
    credentialFamily: "nvidia-api-catalog",
    sourceName: "DOCSFAB_NVIDIA_API_KEY",
    policy: "required",
  },
  "nvidia-inference-api": {
    provider: "nvidia",
    credentialFamily: "nvidia-inference-api",
    sourceName: "MODEL_API_KEY",
    policy: "optional",
  },
});

function decodeInstalledRequestPolicy(value: unknown): InstalledRequestPolicy {
  kit.assertInert(value);
  kit.rejectCredentials(value);
  const root = kit.object(value);
  kit.exact(root, [
    "schemaVersion",
    "modelId",
    "routeId",
    "deploymentIdentitySha256",
    "transport",
    "reasoningMode",
    "reasoningControl",
    "installedSystemInstructionSha256",
    "temperature",
    "topP",
    "policySha256",
  ]);
  if (
    root.schemaVersion !== 1 ||
    !isInstalledPolicyRoute(root.routeId) ||
    root.transport !== "openai-chat-completions" ||
    root.reasoningMode !== "disabled" ||
    root.temperature !== 0 ||
    root.topP !== 1
  ) {
    throw new ModelCompositionError("contract-invalid-value");
  }
  const body = {
    schemaVersion: 1 as const,
    modelId: kit.identifier(root.modelId),
    // Preserved, not restated: a hardcoded route would silently rewrite a
    // policy declared for another route into a catalog one.
    routeId: root.routeId,
    deploymentIdentitySha256: kit.hash(root.deploymentIdentitySha256),
    transport: "openai-chat-completions" as const,
    reasoningMode: "disabled" as const,
    reasoningControl: decodeReasoningControl(root.reasoningControl),
    installedSystemInstructionSha256: kit.hash(root.installedSystemInstructionSha256),
    temperature: 0 as const,
    topP: 1 as const,
  };
  return requireSelfDigest(root, "policySha256", body) as unknown as InstalledRequestPolicy;
}

/** The recorded answer-submission capability: closed values and the probe digest. */
function decodeAnswerSubmission(value: unknown): InstalledAnswerSubmission {
  kit.assertInert(value);
  kit.rejectCredentials(value);
  const root = kit.object(value);
  // `objectMembers` is optional here only so that a recorded capability
  // without it is refused by the reseal and verify scripts
  // (`recordedAnswerSubmissionGaps`), not silently accepted.
  kit.exact(
    root,
    [
      "kind",
      "argumentShell",
      "duplicateKeys",
      "reportTurnToolChoice",
      "objectMembers",
      "evidenceSha256",
    ],
    ["objectMembers"],
  );
  if (root.kind !== "host-tool-call") {
    throw new ModelCompositionError("contract-invalid-value"); // hygiene: envelope
  }
  return {
    kind: "host-tool-call",
    argumentShell: kit.enumeration(root.argumentShell, ["untyped", "typed"] as const),
    duplicateKeys: kit.enumeration(root.duplicateKeys, ["forwarded", "unobserved"] as const),
    reportTurnToolChoice: kit.enumeration(root.reportTurnToolChoice, ["none", "auto"] as const),
    ...(root.objectMembers === undefined
      ? {}
      : {
          objectMembers: kit.enumeration(root.objectMembers, [
            "object",
            "stringified",
            "mixed",
          ] as const),
        }),
    evidenceSha256: kit.hash(root.evidenceSha256),
  };
}

export function decodeAnswerSubmissionRecords(value: unknown): InstalledAnswerSubmissionRecords {
  kit.assertInert(value);
  kit.rejectCredentials(value);
  const root = kit.object(value);
  kit.exact(
    root,
    [
      "schemaVersion",
      "kind",
      "maxRecordBytes",
      "phaseAAdmittedSamples",
      "phaseBMaxAdmittedMessageBytes",
      "minimumQualifiedMessageBytes",
      "phaseBAdmittedSamples",
      "phaseCOutcome",
      "phaseCSamples",
      "phaseCMaxObservedRecordBytes",
      "maxMessageBytes",
      "groupEnvelopeBytes",
      "fixtureRows",
      "fullPlanEnvelopeBytes",
      "largestRecordEnvelopeBytes",
      "lturnMs",
      "readingTurnsP90",
      "argumentShell",
      "decodeTokensPerSecond",
      "decodeRateSource",
      "modelId",
      "routeId",
      "deploymentIdentitySha256",
      "answerSubmissionEvidenceSha256",
      "corpusSha256",
      "evidenceSha256",
      "step8TurnEvidence",
      "qualificationFingerprint",
    ],
    ["qualificationFingerprint"],
  );
  if (root.schemaVersion !== 1 || root.kind !== "records") {
    // hygiene: envelope
    throw new ModelCompositionError(
      "contract-schema-mismatch",
      "The retained step-8 evidence schema or projection is unsupported.",
    );
  }
  const phaseAAdmittedSamples = positiveInteger(root.phaseAAdmittedSamples);
  const phaseBAdmittedSamples = positiveInteger(root.phaseBAdmittedSamples);
  const phaseCSamples = positiveInteger(root.phaseCSamples);
  if (phaseAAdmittedSamples !== 3 || phaseBAdmittedSamples !== 3 || phaseCSamples !== 3) {
    // hygiene: envelope
    throw new ModelCompositionError("contract-invalid-value");
  }
  const maxRecordBytes = positiveInteger(root.maxRecordBytes);
  const phaseCMaxObservedRecordBytes = positiveInteger(root.phaseCMaxObservedRecordBytes);
  const phaseCOutcome = kit.enumeration(root.phaseCOutcome, [
    "admitted",
    "size-above-record-maximum",
  ] as const);
  if (
    phaseCOutcome === "size-above-record-maximum" &&
    phaseCMaxObservedRecordBytes <= maxRecordBytes
  ) {
    // hygiene: envelope
    throw new ModelCompositionError("contract-invalid-value");
  }
  const phaseBMaxAdmittedMessageBytes = positiveInteger(root.phaseBMaxAdmittedMessageBytes);
  const minimumQualifiedMessageBytes = positiveInteger(root.minimumQualifiedMessageBytes);
  const maxMessageBytes = positiveInteger(root.maxMessageBytes);
  if (
    minimumQualifiedMessageBytes > phaseBMaxAdmittedMessageBytes ||
    maxMessageBytes < minimumQualifiedMessageBytes ||
    maxMessageBytes > phaseBMaxAdmittedMessageBytes
  ) {
    // hygiene: envelope
    throw new ModelCompositionError("contract-invalid-value");
  }
  const groupEnvelopeBytes = kit.array(root.groupEnvelopeBytes).map((value) => {
    const group = kit.object(value);
    kit.exact(group, ["group", "maxBytes"]);
    return {
      group: positiveInteger(group.group),
      maxBytes: positiveInteger(group.maxBytes),
    };
  });
  if (
    groupEnvelopeBytes.length === 0 ||
    groupEnvelopeBytes.some(
      (entry, index) => index > 0 && entry.group <= groupEnvelopeBytes[index - 1]!.group,
    )
  ) {
    // hygiene: envelope
    throw new ModelCompositionError("contract-invalid-value");
  }
  const fixtureRows = kit.array(root.fixtureRows).map((value) => {
    const row = kit.object(value);
    kit.exact(row, ["fixture", "group", "type", "key", "rawEnvelopeBytes"]);
    const key = row.key === null ? null : kit.identifier(row.key);
    const group = positiveInteger(row.group);
    if (group < 1 || group > 4) {
      // hygiene: envelope -- contract codes are mapped at the composition boundary.
      throw new ModelCompositionError("contract-invalid-value");
    }
    return {
      fixture: kit.identifier(row.fixture),
      group: group as 1 | 2 | 3 | 4,
      type: kit.identifier(row.type),
      key,
      rawEnvelopeBytes: positiveInteger(row.rawEnvelopeBytes),
    };
  });
  if (fixtureRows.length === 0) {
    // A qualified capability without corpus-row weights cannot drive a
    // records answer-now reserve; fail closed rather than inventing weights.
    // hygiene: envelope -- contract codes are mapped at the composition boundary.
    throw new ModelCompositionError("contract-invalid-value");
  }
  const fullPlanEnvelopeBytes = positiveInteger(root.fullPlanEnvelopeBytes);
  const largestRecordEnvelopeBytes = positiveInteger(root.largestRecordEnvelopeBytes);
  if (largestRecordEnvelopeBytes > fullPlanEnvelopeBytes) {
    // hygiene: envelope
    throw new ModelCompositionError("contract-invalid-value");
  }
  const turnEvidence = kit.object(root.step8TurnEvidence);
  kit.exact(turnEvidence, [
    "schemaVersion",
    "kind",
    "evidenceSha256",
    "targetRevisionSha256",
    "samples",
    "projectedReportTokens",
  ]);
  if (
    turnEvidence.schemaVersion !== 1 ||
    turnEvidence.kind !== "retained-step8-turn-measurement" ||
    turnEvidence.projectedReportTokens !== 2700
  ) {
    // hygiene: envelope
    throw new ModelCompositionError("contract-schema-mismatch"); // hygiene: envelope
  }
  const step8Samples = kit.array(turnEvidence.samples).map((value) => {
    const sample = kit.object(value);
    kit.exact(sample, [
      "runEvidenceSha256",
      "stepId",
      "attempt",
      "compositionId",
      "modelId",
      "routeId",
      "deploymentIdentitySha256",
      "providerTurns",
      "readingTurns",
      "recordCalls",
      "turnLatencyMs",
      "d3ResidualFires",
    ]);
    if (
      sample.d3ResidualFires !== true &&
      sample.d3ResidualFires !== false &&
      sample.d3ResidualFires !== "unknown"
    ) {
      // hygiene: envelope
      throw new ModelCompositionError(
        "contract-invalid-value",
        "The retained step-8 evidence field has an invalid contract value.",
      ); // hygiene: envelope
    }
    const providerTurns = positiveInteger(sample.providerTurns);
    const readingTurns = nonnegativeInteger(sample.readingTurns);
    if (readingTurns > providerTurns) {
      // hygiene: envelope
      throw new ModelCompositionError(
        "contract-invalid-value",
        "Reading turns cannot exceed provider turns in retained evidence.",
      ); // hygiene: envelope
    }
    return {
      runEvidenceSha256: kit.hash(sample.runEvidenceSha256),
      stepId: kit.identifier(sample.stepId),
      attempt: positiveInteger(sample.attempt),
      compositionId: kit.identifier(sample.compositionId),
      modelId: kit.identifier(sample.modelId),
      routeId: kit.identifier(sample.routeId),
      deploymentIdentitySha256: kit.hash(sample.deploymentIdentitySha256),
      providerTurns,
      readingTurns,
      recordCalls: nonnegativeInteger(sample.recordCalls),
      turnLatencyMs: positiveFinite(sample.turnLatencyMs),
      d3ResidualFires: sample.d3ResidualFires,
    };
  });
  if (step8Samples.length === 0) {
    // hygiene: envelope
    throw new ModelCompositionError(
      "contract-invalid-value",
      "Retained step-8 evidence must include at least one selected sample.",
    ); // hygiene: envelope
  }
  const selectedAttempts = new Set<string>();
  for (const sample of step8Samples) {
    const selector = `${sample.runEvidenceSha256}\0${sample.stepId}\0${sample.attempt}`;
    if (selectedAttempts.has(selector)) {
      // hygiene: envelope
      throw new ModelCompositionError(
        "contract-invalid-value",
        "Retained step-8 evidence must not repeat a run, step, and attempt selector.",
      );
    }
    selectedAttempts.add(selector);
  }
  const sortedReadingTurns = step8Samples
    .map((sample) => sample.readingTurns)
    .sort((a, b) => a - b);
  const derivedReadingTurnsP90 = sortedReadingTurns[Math.ceil(sortedReadingTurns.length * 0.9) - 1];
  const readingTurnsP90 = nonnegativeInteger(root.readingTurnsP90);
  if (readingTurnsP90 !== derivedReadingTurnsP90) {
    // hygiene: envelope
    throw new ModelCompositionError(
      "contract-invalid-value",
      "The reading-turn percentile must match selected retained samples.",
    ); // hygiene: envelope
  }
  const targetRevisionSha256 = kit.hash(turnEvidence.targetRevisionSha256);
  const step8Body = {
    schemaVersion: 1 as const,
    kind: "retained-step8-turn-measurement" as const,
    targetRevisionSha256,
    samples: step8Samples,
    projectedReportTokens: 2700 as const,
  };
  const step8TurnEvidence = requireSelfDigest(
    turnEvidence,
    "evidenceSha256",
    step8Body,
  ) as unknown as InstalledAnswerSubmissionRecords["step8TurnEvidence"];
  return {
    schemaVersion: 1,
    kind: "records",
    maxRecordBytes,
    phaseAAdmittedSamples: 3,
    phaseBMaxAdmittedMessageBytes,
    minimumQualifiedMessageBytes,
    phaseBAdmittedSamples: 3,
    phaseCOutcome,
    phaseCSamples: 3,
    phaseCMaxObservedRecordBytes,
    maxMessageBytes,
    groupEnvelopeBytes,
    fixtureRows,
    fullPlanEnvelopeBytes,
    largestRecordEnvelopeBytes,
    lturnMs: positiveFinite(root.lturnMs),
    readingTurnsP90,
    argumentShell: kit.enumeration(root.argumentShell, ["untyped", "typed"] as const),
    decodeTokensPerSecond: positiveFinite(root.decodeTokensPerSecond),
    decodeRateSource: kit.enumeration(root.decodeRateSource, [
      "stream-window",
      "end-to-end",
    ] as const),
    modelId: kit.identifier(root.modelId),
    routeId: kit.identifier(root.routeId),
    deploymentIdentitySha256: kit.hash(root.deploymentIdentitySha256),
    answerSubmissionEvidenceSha256: kit.hash(root.answerSubmissionEvidenceSha256),
    corpusSha256: kit.hash(root.corpusSha256),
    ...(root.qualificationFingerprint === undefined
      ? {}
      : { qualificationFingerprint: kit.hash(root.qualificationFingerprint) }),
    evidenceSha256: kit.hash(root.evidenceSha256),
    step8TurnEvidence,
  };
}

function requireSelfDigest<T extends Record<string, unknown>>(
  root: Record<string, unknown>,
  digestKey: string,
  body: T,
): T & Record<string, string> {
  const normalized = { ...body, [digestKey]: canonicalDigest(body) };
  if (canonicalJson(root) !== canonicalJson(normalized)) {
    throw new ModelCompositionError("contract-digest-mismatch");
  }
  return deepFreeze(normalized);
}

function decodeComposition(value: unknown): InstalledExecutionComposition {
  kit.assertInert(value);
  kit.rejectCredentials(value);
  const root = kit.object(value);
  kit.exact(
    root,
    [
      "schemaVersion",
      "compositionId",
      "status",
      "executionClass",
      "model",
      "deployment",
      "authentication",
      "requestPolicy",
      "answerSubmission",
      "answerSubmissionRecords",
      "retirement",
      "harness",
      "adapters",
      "compositionLimits",
      "limitations",
      "compositionSha256",
    ],
    ["requestPolicy", "answerSubmission", "answerSubmissionRecords", "retirement"],
  );
  if (root.schemaVersion !== 1) throw new ModelCompositionError("contract-schema-mismatch");

  const model = kit.object(root.model);
  kit.exact(model, ["vendor", "requestedId", "resolvedId"]);
  const deployment = kit.object(root.deployment);
  kit.exact(deployment, [
    "routeId",
    "provider",
    "transport",
    "bindingKind",
    "identitySha256",
    "region",
  ]);
  const authentication = kit.object(root.authentication);
  kit.exact(authentication, ["route", "credentialFamily", "sourceNames", "mechanism"]);
  const harness = kit.object(root.harness);
  kit.exact(harness, ["id", "policySha256"]);
  const adapters = kit.object(root.adapters);
  kit.exact(adapters, ["routeEvidence", "authentication", "providerConnection", "harness"]);

  const executionClass = kit.enumeration(
    root.executionClass,
    EXECUTION_CLASSES,
  ) as ModelCompositionExecutionClass;
  const transport = kit.enumeration(
    deployment.transport,
    COMPOSITION_TRANSPORTS,
  ) as ModelCompositionTransport;
  const status = kit.enumeration(root.status, INSTALLED_COMPOSITION_STATUSES);
  const region = deployment.region === null ? null : kit.identifier(deployment.region);
  const requestPolicy =
    root.requestPolicy === undefined ? undefined : decodeInstalledRequestPolicy(root.requestPolicy);
  const answerSubmission =
    root.answerSubmission === undefined ? undefined : decodeAnswerSubmission(root.answerSubmission);
  const answerSubmissionRecords =
    root.answerSubmissionRecords === undefined
      ? undefined
      : decodeAnswerSubmissionRecords(root.answerSubmissionRecords);
  const retirement =
    root.retirement === undefined ? undefined : decodeCompositionRetirement(root.retirement);
  // A retirement is all-or-nothing: `status: retired` without the evidence
  // block would hide why execution is refused, and a retirement block on a live
  // record would let a record look retired to a reader while still executing.
  if ((status === "retired") !== (retirement !== undefined)) {
    throw new ModelCompositionError("contract-invalid-value"); // hygiene: envelope
  }
  const body = {
    schemaVersion: 1 as const,
    compositionId: kit.identifier(root.compositionId),
    status,
    ...(retirement ? { retirement } : {}),
    executionClass,
    model: {
      vendor: kit.identifier(model.vendor),
      requestedId: kit.identifier(model.requestedId),
      resolvedId: kit.identifier(model.resolvedId),
    },
    deployment: {
      routeId: kit.identifier(deployment.routeId),
      provider: kit.identifier(deployment.provider),
      transport,
      bindingKind: kit.enumeration(deployment.bindingKind, [
        "exact-origin",
        "opaque-cli-managed",
      ] as const),
      identitySha256: kit.hash(deployment.identitySha256),
      region,
    },
    authentication: {
      route: kit.identifier(authentication.route),
      credentialFamily: kit.identifier(authentication.credentialFamily),
      sourceNames: nonemptyIdentifiers(authentication.sourceNames),
      mechanism: kit.identifier(authentication.mechanism),
    },
    ...(requestPolicy ? { requestPolicy } : {}),
    ...(answerSubmission ? { answerSubmission } : {}),
    ...(answerSubmissionRecords ? { answerSubmissionRecords } : {}),
    harness: {
      id: kit.identifier(harness.id),
      policySha256: kit.hash(harness.policySha256),
    },
    adapters: {
      routeEvidence: adapterReference(adapters.routeEvidence),
      authentication: adapterReference(adapters.authentication),
      providerConnection: adapterReference(adapters.providerConnection),
      harness: adapterReference(adapters.harness),
    },
    compositionLimits: limits(root.compositionLimits),
    limitations: nonemptyIdentifiers(root.limitations),
  };

  if (
    (executionClass === "pi-provider" &&
      (body.harness.id !== "pi" ||
        body.deployment.bindingKind !== "exact-origin" ||
        transport === "opaque-cli-managed")) ||
    (executionClass === "preflight-only" &&
      (!new Set(["codex", "claude-code"]).has(body.harness.id) ||
        body.deployment.bindingKind !== "opaque-cli-managed" ||
        transport !== "opaque-cli-managed"))
  ) {
    throw new ModelCompositionError("contract-invalid-value");
  }
  // The capability is a property of a chat-completions serving stack that a
  // Pi harness drives; nothing else can be probed for it or execute it.
  if (
    answerSubmission !== undefined &&
    (executionClass !== "pi-provider" || transport !== "openai-chat-completions")
  ) {
    throw new ModelCompositionError("contract-invalid-value"); // hygiene: envelope
  }
  if (
    answerSubmissionRecords !== undefined &&
    (executionClass !== "pi-provider" ||
      transport !== "openai-chat-completions" ||
      answerSubmission === undefined ||
      answerSubmission.objectMembers === undefined ||
      answerSubmissionRecords.modelId !== body.model.resolvedId ||
      answerSubmissionRecords.routeId !== body.deployment.routeId ||
      answerSubmissionRecords.deploymentIdentitySha256 !== body.deployment.identitySha256 ||
      answerSubmissionRecords.argumentShell !== answerSubmission.argumentShell ||
      answerSubmissionRecords.answerSubmissionEvidenceSha256 !== answerSubmission.evidenceSha256 ||
      answerSubmissionRecords.step8TurnEvidence.samples.some(
        (sample) =>
          sample.compositionId !== body.compositionId ||
          sample.modelId !== body.model.resolvedId ||
          sample.routeId !== body.deployment.routeId ||
          sample.deploymentIdentitySha256 !== body.deployment.identitySha256,
      ))
  ) {
    throw new ModelCompositionError("contract-invalid-value"); // hygiene: envelope
  }
  // A policy-carrying route must satisfy its binding AND declare a policy that
  // agrees with the composition. Any other route must declare no policy at all,
  // so a control cannot be attached where nothing would emit it.
  const routeBinding = isInstalledPolicyRoute(body.deployment.routeId)
    ? POLICY_ROUTE_BINDINGS[body.deployment.routeId]
    : undefined;
  if (
    routeBinding
      ? body.deployment.provider !== routeBinding.provider ||
        body.deployment.transport !== "openai-chat-completions" ||
        body.authentication.route !== body.deployment.routeId ||
        body.authentication.credentialFamily !== routeBinding.credentialFamily ||
        body.authentication.mechanism !== "host-secret-handle" ||
        body.authentication.sourceNames.length !== 1 ||
        body.authentication.sourceNames[0] !== routeBinding.sourceName ||
        (requestPolicy === undefined
          ? routeBinding.policy === "required"
          : requestPolicy.routeId !== body.deployment.routeId ||
            requestPolicy.modelId !== body.model.resolvedId ||
            requestPolicy.deploymentIdentitySha256 !== body.deployment.identitySha256)
      : requestPolicy !== undefined
  ) {
    throw new ModelCompositionError("contract-invalid-value");
  }

  return requireSelfDigest(
    root,
    "compositionSha256",
    body,
  ) as unknown as InstalledExecutionComposition;
}

const MAX_RETIREMENT_NOTICE_CHARS = 512;

/** A bounded, non-empty, single-line evidence string. */
function retirementEvidenceLine(value: unknown): string {
  const text = kit.string(value);
  if (
    text.trim().length === 0 ||
    text.length > MAX_RETIREMENT_NOTICE_CHARS ||
    /[\r\n]/u.test(text)
  ) {
    throw new ModelCompositionError("contract-invalid-value"); // hygiene: envelope
  }
  return text;
}

/**
 * Each reason carries exactly its own evidence: a provider notice for
 * `provider-end-of-life`, a named decision record for
 * `superseded-by-operator-decision`. Neither can borrow the other's shape.
 */
function decodeCompositionRetirement(value: unknown): InstalledCompositionRetirement {
  const root = kit.object(value);
  const reason = kit.enumeration(root.reason, INSTALLED_COMPOSITION_RETIREMENT_REASONS);
  const optional = ["successorCompositionId"];
  const successor =
    root.successorCompositionId === undefined
      ? {}
      : { successorCompositionId: kit.identifier(root.successorCompositionId) };
  const effectiveAt = kit.timestamp(root.effectiveAt);
  if (reason === "provider-end-of-life") {
    kit.exact(root, ["reason", "effectiveAt", "providerNotice", ...optional], optional);
    return {
      reason,
      effectiveAt,
      providerNotice: retirementEvidenceLine(root.providerNotice),
      ...successor,
    };
  }
  kit.exact(root, ["reason", "effectiveAt", "decision", ...optional], optional);
  const decision = kit.object(root.decision);
  kit.exact(decision, ["decidedBy", "decidedAt", "statement", "record"]);
  return {
    reason,
    effectiveAt,
    decision: {
      decidedBy: retirementEvidenceLine(decision.decidedBy),
      decidedAt: kit.timestamp(decision.decidedAt),
      statement: retirementEvidenceLine(decision.statement),
      record: retirementEvidenceLine(decision.record),
    },
    ...successor,
  };
}

function decodeCandidate(value: unknown): InstalledCandidateProjection {
  kit.assertInert(value);
  kit.rejectCredentials(value);
  const root = kit.object(value);
  kit.exact(root, [
    "schemaVersion",
    "candidateId",
    "compositionId",
    "compositionSha256",
    "modelId",
    "routeId",
    "deploymentIdentitySha256",
    "harnessId",
    "providerConnectionAdapter",
    "status",
    "approvalStatus",
    "modelRequest",
    "proposedLimits",
    "source",
    "candidateSha256",
  ]);
  if (root.schemaVersion !== 1) throw new ModelCompositionError("contract-schema-mismatch");
  const source = kit.object(root.source);
  kit.exact(source, ["kind", "locator", "sha256"]);
  const body = {
    schemaVersion: 1 as const,
    candidateId: kit.identifier(root.candidateId),
    compositionId: kit.identifier(root.compositionId),
    compositionSha256: kit.hash(root.compositionSha256),
    modelId: kit.identifier(root.modelId),
    routeId: kit.identifier(root.routeId),
    deploymentIdentitySha256: kit.hash(root.deploymentIdentitySha256),
    harnessId: kit.identifier(root.harnessId),
    providerConnectionAdapter: adapterReference(root.providerConnectionAdapter),
    status: kit.enumeration(root.status, ["candidate"] as const),
    approvalStatus: kit.enumeration(root.approvalStatus, ["not-approved"] as const),
    modelRequest: kit.enumeration(root.modelRequest, ["blocked"] as const),
    proposedLimits: limits(root.proposedLimits),
    source: {
      kind: kit.enumeration(source.kind, ["repository-candidate", "composition-freeze"] as const),
      locator: kit.identifier(source.locator),
      sha256: kit.hash(source.sha256),
    },
  };
  return requireSelfDigest(
    root,
    "candidateSha256",
    body,
  ) as unknown as InstalledCandidateProjection;
}

function decodeAdapter(value: unknown): InstalledModelCompositionAdapter {
  kit.assertInert(value);
  kit.rejectCredentials(value);
  const base = kit.object(value);
  const kind = kit.enumeration(base.kind, MODEL_COMPOSITION_ADAPTER_KINDS);
  const commonKeys = ["schemaVersion", "kind", "id", "version", "status"];
  const keys =
    kind === "route-evidence"
      ? [...commonKeys, "routeId", "transport", "deploymentIdentitySha256"]
      : kind === "authentication"
        ? [
            ...commonKeys,
            "routeId",
            "credentialFamily",
            "mechanism",
            "sourceNames",
            "executablePolicySha256",
            "environmentPolicySha256",
          ]
        : kind === "provider-connection"
          ? [...commonKeys, "executionClass", "routeId", "transport", "deploymentIdentitySha256"]
          : [...commonKeys, "executionClass", "harnessId", "harnessPolicySha256"];
  kit.exact(base, keys);
  if (base.schemaVersion !== 1) throw new ModelCompositionError("contract-schema-mismatch");
  const common = {
    schemaVersion: 1 as const,
    kind,
    id: kit.identifier(base.id),
    version: semanticVersion(base.version),
    status: kit.enumeration(base.status, ["implemented", "preflight-only"] as const),
  };
  if (kind === "route-evidence") {
    return deepFreeze({
      ...common,
      kind,
      routeId: kit.identifier(base.routeId),
      transport: kit.enumeration(base.transport, COMPOSITION_TRANSPORTS),
      deploymentIdentitySha256: kit.hash(base.deploymentIdentitySha256),
    }) as RouteEvidenceAdapterRecord;
  }
  if (kind === "authentication") {
    return deepFreeze({
      ...common,
      kind,
      routeId: kit.identifier(base.routeId),
      credentialFamily: kit.identifier(base.credentialFamily),
      mechanism: kit.identifier(base.mechanism),
      sourceNames: nonemptyIdentifiers(base.sourceNames),
      executablePolicySha256: kit.hash(base.executablePolicySha256),
      environmentPolicySha256: kit.hash(base.environmentPolicySha256),
    }) as AuthenticationAdapterRecord;
  }
  if (kind === "provider-connection") {
    return deepFreeze({
      ...common,
      kind,
      executionClass: kit.enumeration(base.executionClass, EXECUTION_CLASSES),
      routeId: kit.identifier(base.routeId),
      transport: kit.enumeration(base.transport, COMPOSITION_TRANSPORTS),
      deploymentIdentitySha256: kit.hash(base.deploymentIdentitySha256),
    }) as ProviderConnectionAdapterRecord;
  }
  return deepFreeze({
    ...common,
    kind,
    executionClass: kit.enumeration(base.executionClass, EXECUTION_CLASSES),
    harnessId: kit.identifier(base.harnessId),
    harnessPolicySha256: kit.hash(base.harnessPolicySha256),
  }) as HarnessAdapterRecord;
}

function decodeWorkflow(value: unknown): InstalledWorkflowComposition {
  kit.assertInert(value);
  kit.rejectCredentials(value);
  const root = kit.object(value);
  kit.exact(root, ["workflowId", "sourcePath", "sourceSha256", "steps"]);
  const steps = kit.array(root.steps).map((entry, index) => {
    const step = kit.object(entry);
    kit.exact(step, ["stepId", "stepMode", "stepOrdinal", "skillId", "role"]);
    const ordinal = positiveInteger(step.stepOrdinal);
    if (ordinal !== index + 1) throw new ModelCompositionError("contract-invalid-value");
    return {
      stepId: kit.identifier(step.stepId),
      stepMode: kit.enumeration(step.stepMode, ["read-only", "write"] as const),
      stepOrdinal: ordinal,
      skillId: kit.identifier(step.skillId),
      role: kit.identifier(step.role),
    };
  });
  if (steps.length === 0 || new Set(steps.map((step) => step.stepId)).size !== steps.length) {
    throw new ModelCompositionError("contract-invalid-value");
  }
  return deepFreeze({
    workflowId: kit.identifier(root.workflowId),
    sourcePath: kit.identifier(root.sourcePath),
    sourceSha256: kit.hash(root.sourceSha256),
    steps,
  });
}

export function decodeCompositionRegistry(value: unknown): CompositionRegistry {
  return kit.decodeSealed(
    value,
    CONTRACT_KINDS.compositionRegistry,
    "registrySha256",
    ["compositions"],
    (root) => {
      const compositions = kit.array(root.compositions).map(decodeComposition);
      if (
        compositions.length === 0 ||
        new Set(compositions.map((entry) => entry.compositionId)).size !== compositions.length
      ) {
        throw new ModelCompositionError("contract-invalid-value");
      }
      return { compositions };
    },
  );
}

export function decodeCandidateProjectionRegistry(value: unknown): CandidateProjectionRegistry {
  return kit.decodeSealed(
    value,
    CONTRACT_KINDS.candidateProjections,
    "registrySha256",
    ["candidates"],
    (root) => {
      const candidates = kit.array(root.candidates).map(decodeCandidate);
      if (
        candidates.length === 0 ||
        new Set(candidates.map((entry) => entry.candidateId)).size !== candidates.length ||
        new Set(candidates.map((entry) => entry.compositionId)).size !== candidates.length
      ) {
        throw new ModelCompositionError("contract-invalid-value");
      }
      return { candidates };
    },
  );
}

export function decodeAdapterRegistry(value: unknown): AdapterRegistry {
  return kit.decodeSealed(
    value,
    CONTRACT_KINDS.adapterRegistry,
    "registrySha256",
    ["adapters"],
    (root) => {
      const adapters = kit.array(root.adapters).map(decodeAdapter);
      const identities = adapters.map((entry) => `${entry.kind}:${entry.id}@${entry.version}`);
      if (adapters.length === 0 || new Set(identities).size !== identities.length) {
        throw new ModelCompositionError("contract-invalid-value");
      }
      return { adapters };
    },
  );
}

export function decodeWorkflowCatalog(value: unknown): WorkflowCatalog {
  return kit.decodeSealed(
    value,
    CONTRACT_KINDS.workflowCatalog,
    "catalogSha256",
    ["workflows"],
    (root) => {
      const workflows = kit.array(root.workflows).map(decodeWorkflow);
      if (
        workflows.length === 0 ||
        new Set(workflows.map((entry) => entry.workflowId)).size !== workflows.length
      ) {
        throw new ModelCompositionError("contract-invalid-value");
      }
      return { workflows };
    },
  );
}

export function decodeInstalledManifest(value: unknown): InstalledModelCompositionManifest {
  return kit.decodeSealed(
    value,
    CONTRACT_KINDS.installedManifest,
    "installedManifestSha256",
    ["assets", "compositionCeiling", "compositionCeilingSha256"],
    (root) => {
      const assets = kit.array(root.assets).map((entry) => {
        const asset = kit.object(entry);
        kit.exact(asset, ["kind", "path", "fileSha256", "contractSha256"]);
        return {
          kind: kit.enumeration(asset.kind, MODEL_COMPOSITION_ASSET_KINDS),
          path: kit.identifier(asset.path),
          fileSha256: kit.hash(asset.fileSha256),
          contractSha256: kit.hash(asset.contractSha256),
        };
      });
      const expectedKinds = [...MODEL_COMPOSITION_ASSET_KINDS].sort();
      const actualKinds = assets.map((entry) => entry.kind).sort();
      if (
        canonicalJson(expectedKinds) !== canonicalJson(actualKinds) ||
        new Set(assets.map((entry) => entry.path)).size !== assets.length
      ) {
        throw new ModelCompositionError("installed-manifest-file-set-mismatch");
      }
      const compositionCeiling = limits(root.compositionCeiling);
      if (kit.hash(root.compositionCeilingSha256) !== canonicalDigest(compositionCeiling)) {
        throw new ModelCompositionError("contract-digest-mismatch");
      }
      return {
        assets,
        compositionCeiling,
        compositionCeilingSha256: canonicalDigest(compositionCeiling),
      };
    },
  );
}

export interface DecodedInstalledAssets {
  readonly manifest: InstalledModelCompositionManifest;
  readonly compositionRegistry: CompositionRegistry;
  readonly candidateRegistry: CandidateProjectionRegistry;
  readonly adapterRegistry: AdapterRegistry;
  readonly workflowCatalog: WorkflowCatalog;
}
