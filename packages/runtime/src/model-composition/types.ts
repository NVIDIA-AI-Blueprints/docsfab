// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export const MODEL_COMPOSITION_ASSET_KINDS = [
  "adapter-registry",
  "candidate-projections",
  "composition-registry",
  "workflow-catalog",
] as const;

export type ModelCompositionAssetKind = (typeof MODEL_COMPOSITION_ASSET_KINDS)[number];

export const MODEL_COMPOSITION_ADAPTER_KINDS = [
  "route-evidence",
  "authentication",
  "provider-connection",
  "harness",
] as const;

export type ModelCompositionAdapterKind = (typeof MODEL_COMPOSITION_ADAPTER_KINDS)[number];
export type ModelCompositionExecutionClass = "pi-provider" | "preflight-only";
export type ModelCompositionTransport =
  | "openai-chat-completions"
  | "openai-responses"
  | "anthropic-messages"
  | "opaque-cli-managed";

/**
 * How a model is told to stop emitting a separate reasoning channel.
 *
 * No control is portable across the NVIDIA API Catalog's Nemotron SKUs, as
 * measured against the live route:
 *
 * | SKU                        | `/no_think` | `chat_template_kwargs` |
 * | -------------------------- | ----------- | ---------------------- |
 * | llama-3.3-nemotron-super-49b-v1.5 | suppresses | inert           |
 * | nemotron-3.5-lightning-30b-a3b    | inert      | suppresses      |
 * | nemotron-3-super-120b-a12b        | inert      | suppresses      |
 * | nemotron-3-ultra-550b-a55b        | inert      | suppresses      |
 *
 * `reasoning_effort` is accepted with HTTP 200 by every SKU above and
 * suppresses reasoning on none of them. The control is a closed union so an
 * unrecognized control cannot be configured and cannot fail quietly.
 */
export type InstalledReasoningControl =
  | { readonly kind: "system-directive"; readonly directive: "/no_think" }
  | { readonly kind: "chat-template-kwarg"; readonly thinking: false };

/**
 * Routes whose compositions carry an installed request policy.
 *
 * Closed for the same reason as the reasoning control. Adding a route means
 * adding its authentication expectations to POLICY_ROUTE_BINDINGS in
 * `contracts.ts`, the single place that knows what a route requires.
 */
export const INSTALLED_POLICY_ROUTE_IDS = ["nvidia-api-catalog", "nvidia-inference-api"] as const;

export type InstalledPolicyRouteId = (typeof INSTALLED_POLICY_ROUTE_IDS)[number];

export function isInstalledPolicyRoute(value: unknown): value is InstalledPolicyRouteId {
  return (
    typeof value === "string" && (INSTALLED_POLICY_ROUTE_IDS as readonly string[]).includes(value)
  );
}

export interface InstalledRequestPolicy {
  readonly schemaVersion: 1;
  readonly modelId: string;
  readonly routeId: InstalledPolicyRouteId;
  readonly deploymentIdentitySha256: string;
  readonly transport: "openai-chat-completions";
  readonly reasoningMode: "disabled";
  readonly reasoningControl: InstalledReasoningControl;
  readonly installedSystemInstructionSha256: string;
  readonly temperature: 0;
  readonly topP: 1;
  readonly policySha256: string;
}

/** A model's reasoning control, as installed compositions measured it. */
/**
 * How a route admits the final quality evaluator's answer through a host tool
 * call, recorded only after a qualification probe of that route.
 * `argumentShell` is the parameter shell the probe found the serving stack
 * forwards as strict JSON objects; `duplicateKeys` is `forwarded` only when
 * the probe saw a duplicate key reach the host, else `unobserved`;
 * `reportTurnToolChoice` is `none` when the route served a tool-free turn with
 * `tool_choice: "none"` after a tool-call history. `evidenceSha256` is the
 * canonical digest of the retained probe observation.
 */
export interface InstalledAnswerSubmission {
  readonly kind: "host-tool-call";
  readonly argumentShell: "untyped" | "typed";
  readonly duplicateKeys: "forwarded" | "unobserved";
  readonly reportTurnToolChoice: "none" | "auto";
  /**
   * How the probe's samples of the chosen shell delivered the members:
   * unencoded (`object`), as JSON strings (`stringified`), or some of each
   * (`mixed`). Evidence only; admission does not branch on it. Every
   * recorded capability carries it; the reseal and verify scripts refuse one
   * without it.
   */
  readonly objectMembers?: "object" | "stringified" | "mixed";
  readonly evidenceSha256: string;
}

/**
 * A measured records-path qualification, distinct from the transport-only
 * answerSubmission probe above.  Its evidence binds the route, deployment,
 * model, transport qualification, corpus, and canonical answer plan; the
 * composition decoder rejects a capability that no longer matches them.
 */
export interface InstalledAnswerSubmissionRecords {
  readonly schemaVersion: 1;
  readonly kind: "records";
  /** Largest raw outer record call admitted on the measured A rung. */
  readonly maxRecordBytes: number;
  /** A must admit the selected maximum rung on all three seeds. */
  readonly phaseAAdmittedSamples: 3;
  /** Largest phase-B planned message admitted by every required sample. */
  readonly phaseBMaxAdmittedMessageBytes: number;
  /** Smallest contiguous phase-B message rung admitted on all three seeds. */
  readonly minimumQualifiedMessageBytes: number;
  /** B must admit the selected maximum rung on all three seeds. */
  readonly phaseBAdmittedSamples: 3;
  /** C is admitted 3/3, or every refusal is size-only above maxRecordBytes. */
  readonly phaseCOutcome: "admitted" | "size-above-record-maximum";
  readonly phaseCSamples: 3;
  readonly phaseCMaxObservedRecordBytes: number;
  /** Byte budget selected after applying the sealed output allowance. */
  readonly maxMessageBytes: number;
  /** Per-group largest canonical outer argument envelope across corpus fixtures. */
  readonly groupEnvelopeBytes: readonly { readonly group: number; readonly maxBytes: number }[];
  /**
   * Canonical corpus-row weights, grouped by fixture. `key: null` retains an
   * anonymous row as a distinct occurrence; runtime progress must not invent
   * a key for it. `rawEnvelopeBytes` is a canonical-corpus projection for
   * answer-now planning, not a promise about provider serialization.
   */
  readonly fixtureRows: readonly {
    readonly fixture: string;
    readonly group: 1 | 2 | 3 | 4;
    readonly type: string;
    readonly key: string | null;
    readonly rawEnvelopeBytes: number;
  }[];
  /** Largest sum of canonical outer argument envelopes in any corpus fixture. */
  readonly fullPlanEnvelopeBytes: number;
  /** Largest canonical outer argument envelope in the committed corpus. */
  readonly largestRecordEnvelopeBytes: number;
  /**
   * Probe-derived p90 inclusive non-window/whole-call estimate: max(TTFT,
   * elapsed minus a usable argument window), or whole-call elapsed when the
   * streaming window is unavailable. Verified at reseal.
   */
  readonly lturnMs: number;
  /** p90 reading-turn count from exact retained step-8 attempts. */
  readonly readingTurnsP90: number;
  /** The argument shell must equal the separately qualified transport shell. */
  readonly argumentShell: "untyped" | "typed";
  /** Decode rate measured by the content-addressed probe, not a default. */
  readonly decodeTokensPerSecond: number;
  readonly decodeRateSource: "stream-window" | "end-to-end";
  readonly modelId: string;
  readonly routeId: string;
  readonly deploymentIdentitySha256: string;
  readonly answerSubmissionEvidenceSha256: string;
  readonly corpusSha256: string;
  /** Exact provider-free qualification plan whose retained observation is sealed. */
  readonly qualificationFingerprint?: string;
  /** Digest of the actual phase-A/B/C observation; counts are re-derived from it. */
  readonly evidenceSha256: string;
  /** Runtime turn evidence is separate from the copy-size probe observation. */
  readonly step8TurnEvidence: {
    readonly schemaVersion: 1;
    readonly kind: "retained-step8-turn-measurement";
    readonly evidenceSha256: string;
    readonly targetRevisionSha256: string;
    readonly samples: readonly {
      readonly runEvidenceSha256: string;
      /** Select one exact attempt; a run may contain several retries. */
      readonly stepId: string;
      readonly attempt: number;
      readonly compositionId: string;
      readonly modelId: string;
      readonly routeId: string;
      readonly deploymentIdentitySha256: string;
      readonly providerTurns: number;
      readonly readingTurns: number;
      readonly recordCalls: number;
      readonly turnLatencyMs: number;
      readonly d3ResidualFires: boolean | "unknown";
    }[];
    /** Accepted design projection input; never a response-size cap. */
    readonly projectedReportTokens: 2700;
  };
}

export interface MeasuredReasoningControl {
  readonly control: InstalledReasoningControl;
  readonly compositionIds: readonly string[];
}

export interface CompositionModelLimits {
  readonly contextWindow: number;
  readonly maxInputTokens: number;
  readonly maxOutputTokens: number;
  readonly maxProviderTurns: number;
  readonly timeoutMs: number;
  readonly maxResponseBytes: number;
}

export interface ModelCompositionAdapterReference {
  readonly id: string;
  readonly version: string;
}

/**
 * Lifecycle states of an installed composition record.
 *
 * `retired` keeps the record for provenance -- completed run records still
 * rebind to its exact digests -- while removing it from the executable set.
 * A retired record must carry a `retirement` block naming why and since when;
 * a live record must not carry one. The pair is enforced by the decoder so a
 * retirement cannot be half-applied.
 */
export const INSTALLED_COMPOSITION_STATUSES = ["active", "planned", "retired"] as const;

export type InstalledCompositionStatus = (typeof INSTALLED_COMPOSITION_STATUSES)[number];

/**
 * Why a record was retired. A closed set so the CLI can render each reason.
 *
 * - `provider-end-of-life`: the provider stopped (or announced it will stop)
 *   serving the model on this route; evidence is the provider's own notice.
 * - `superseded-by-operator-decision`: the provider still serves the route,
 *   but a named operator decision withdrew it; evidence is that decision
 *   record. Never use it to stand in for a provider notice, or the reverse.
 */
export const INSTALLED_COMPOSITION_RETIREMENT_REASONS = [
  "provider-end-of-life",
  "superseded-by-operator-decision",
] as const;

export type InstalledCompositionRetirementReason =
  (typeof INSTALLED_COMPOSITION_RETIREMENT_REASONS)[number];

/** A named, dated operator decision that retired a record the provider still serves. */
export interface InstalledCompositionRetirementDecision {
  /** The accountable person who made the decision. */
  readonly decidedBy: string;
  /** Canonical UTC instant of the decision. */
  readonly decidedAt: string;
  /** The decision as stated, bounded and single-line. */
  readonly statement: string;
  /** Where the decision is recorded, such as an issue URL. */
  readonly record: string;
}

interface InstalledCompositionRetirementBase {
  /**
   * Canonical UTC instant from which the record is withdrawn: when the
   * provider stops serving the model, or when the operator decision applies.
   */
  readonly effectiveAt: string;
  /** Installed composition that replaces this one, named in the refusal. */
  readonly successorCompositionId?: string;
}

export type InstalledCompositionRetirement =
  | (InstalledCompositionRetirementBase & {
      readonly reason: "provider-end-of-life";
      /** Bounded, credential-free provider statement retained as evidence. */
      readonly providerNotice: string;
    })
  | (InstalledCompositionRetirementBase & {
      readonly reason: "superseded-by-operator-decision";
      readonly decision: InstalledCompositionRetirementDecision;
    });

export interface InstalledExecutionComposition {
  readonly schemaVersion: 1;
  readonly compositionId: string;
  readonly status: InstalledCompositionStatus;
  readonly retirement?: InstalledCompositionRetirement;
  readonly executionClass: ModelCompositionExecutionClass;
  readonly model: {
    readonly vendor: string;
    readonly requestedId: string;
    readonly resolvedId: string;
  };
  readonly deployment: {
    readonly routeId: string;
    readonly provider: string;
    readonly transport: ModelCompositionTransport;
    readonly bindingKind: "exact-origin" | "opaque-cli-managed";
    readonly identitySha256: string;
    readonly region: string | null;
  };
  readonly authentication: {
    readonly route: string;
    readonly credentialFamily: string;
    readonly sourceNames: readonly string[];
    readonly mechanism: string;
  };
  readonly requestPolicy?: InstalledRequestPolicy;
  /** The answer submission a qualification probe recorded for this route. */
  readonly answerSubmission?: InstalledAnswerSubmission;
  /** Separate records measurements; never implied by transport support alone. */
  readonly answerSubmissionRecords?: InstalledAnswerSubmissionRecords;
  readonly harness: {
    readonly id: string;
    readonly policySha256: string;
  };
  readonly adapters: {
    readonly routeEvidence: ModelCompositionAdapterReference;
    readonly authentication: ModelCompositionAdapterReference;
    readonly providerConnection: ModelCompositionAdapterReference;
    readonly harness: ModelCompositionAdapterReference;
  };
  readonly compositionLimits: CompositionModelLimits;
  readonly limitations: readonly string[];
  readonly compositionSha256: string;
}

export interface InstalledCandidateProjection {
  readonly schemaVersion: 1;
  readonly candidateId: string;
  readonly compositionId: string;
  readonly compositionSha256: string;
  readonly modelId: string;
  readonly routeId: string;
  readonly deploymentIdentitySha256: string;
  readonly harnessId: string;
  readonly providerConnectionAdapter: ModelCompositionAdapterReference;
  readonly status: "candidate";
  readonly approvalStatus: "not-approved";
  readonly modelRequest: "blocked";
  readonly proposedLimits: CompositionModelLimits;
  readonly source: {
    readonly kind: "repository-candidate" | "composition-freeze";
    readonly locator: string;
    readonly sha256: string;
  };
  readonly candidateSha256: string;
}

interface ModelCompositionAdapterBase {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly version: string;
  readonly status: "implemented" | "preflight-only";
}

export interface RouteEvidenceAdapterRecord extends ModelCompositionAdapterBase {
  readonly kind: "route-evidence";
  readonly routeId: string;
  readonly transport: ModelCompositionTransport;
  readonly deploymentIdentitySha256: string;
}

export interface AuthenticationAdapterRecord extends ModelCompositionAdapterBase {
  readonly kind: "authentication";
  readonly routeId: string;
  readonly credentialFamily: string;
  readonly mechanism: string;
  readonly sourceNames: readonly string[];
  readonly executablePolicySha256: string;
  readonly environmentPolicySha256: string;
}

export interface ProviderConnectionAdapterRecord extends ModelCompositionAdapterBase {
  readonly kind: "provider-connection";
  readonly executionClass: ModelCompositionExecutionClass;
  readonly routeId: string;
  readonly transport: ModelCompositionTransport;
  readonly deploymentIdentitySha256: string;
}

export interface HarnessAdapterRecord extends ModelCompositionAdapterBase {
  readonly kind: "harness";
  readonly executionClass: ModelCompositionExecutionClass;
  readonly harnessId: string;
  readonly harnessPolicySha256: string;
}

export type InstalledModelCompositionAdapter =
  | RouteEvidenceAdapterRecord
  | AuthenticationAdapterRecord
  | ProviderConnectionAdapterRecord
  | HarnessAdapterRecord;

export interface InstalledWorkflowStep {
  readonly stepId: string;
  readonly stepMode: "read-only" | "write";
  readonly stepOrdinal: number;
  readonly skillId: string;
  readonly role: string;
}

export interface InstalledWorkflowComposition {
  readonly workflowId: string;
  readonly sourcePath: string;
  readonly sourceSha256: string;
  readonly steps: readonly InstalledWorkflowStep[];
}

export interface InstalledModelCompositionSnapshot {
  readonly installedManifestSha256: string;
  readonly compositionIds: readonly string[];
  readonly executableCompositionIds: readonly string[];
  readonly preflightCompositionIds: readonly string[];
  readonly workflowIds: readonly string[];
}

export interface InstalledModelCompositionAuthority {
  readonly kind: "docsfab-installed-model-composition-authority";
}

export interface BoundInstalledComposition {
  readonly installedManifestSha256: string;
  readonly compositionCeiling: CompositionModelLimits;
  readonly compositionCeilingSha256: string;
  readonly composition: InstalledExecutionComposition;
  readonly candidate: InstalledCandidateProjection;
  readonly adapters: {
    readonly routeEvidence: RouteEvidenceAdapterRecord;
    readonly authentication: AuthenticationAdapterRecord;
    readonly providerConnection: ProviderConnectionAdapterRecord;
    readonly harness: HarnessAdapterRecord;
  };
  readonly workflow: InstalledWorkflowComposition;
  readonly technicalApproval: "not-established";
  readonly releaseEligible: false;
}

export interface BoundExecutableComposition extends BoundInstalledComposition {
  readonly composition: InstalledExecutionComposition & {
    readonly status: "active";
    readonly executionClass: "pi-provider";
    readonly deployment: InstalledExecutionComposition["deployment"] & {
      readonly transport: Exclude<ModelCompositionTransport, "opaque-cli-managed">;
      readonly bindingKind: "exact-origin";
    };
  };
  readonly adapters: BoundInstalledComposition["adapters"] & {
    readonly providerConnection: ProviderConnectionAdapterRecord & {
      readonly executionClass: "pi-provider";
      readonly status: "implemented";
    };
    readonly harness: HarnessAdapterRecord & {
      readonly executionClass: "pi-provider";
      readonly status: "implemented";
    };
  };
}

export interface InstalledModelCompositionSummary {
  readonly compositionId: string;
  readonly status: InstalledCompositionStatus;
  readonly retirement?: InstalledCompositionRetirement;
  readonly executionClass: ModelCompositionExecutionClass;
  readonly modelId: string;
  readonly provider: string;
  readonly routeId: string;
  readonly transport: ModelCompositionTransport;
  readonly harnessId: string;
  readonly technicalApproval: "not-established";
  readonly releaseEligible: false;
}

export interface VerifiedInstalledDeploymentBinding {
  readonly compositionId: string;
  readonly normalizedBaseUrl: string;
  readonly requestPath: string;
  readonly deploymentIdentitySha256: string;
}

export type ModelCompositionErrorCode =
  | "adapter-binding-mismatch"
  | "asset-file-digest-mismatch"
  | "asset-json-invalid"
  | "asset-read-failed"
  | "authority-invalid"
  | "candidate-binding-mismatch"
  | "composition-not-executable"
  | "composition-not-active"
  | "composition-retired"
  | "contract-credential-material"
  | "contract-digest-mismatch"
  | "contract-invalid-shape"
  | "contract-invalid-value"
  | "contract-schema-mismatch"
  | "migration-required"
  | "deployment-binding-mismatch"
  | "installed-manifest-digest-mismatch"
  | "installed-manifest-file-set-mismatch"
  | "unknown-composition"
  | "timer-fit-predicted"
  | "unknown-workflow"
  | "workflow-source-digest-mismatch";

export class ModelCompositionError extends Error {
  public readonly code: ModelCompositionErrorCode;
  /**
   * Operator-facing remediation for this exact failure. Distinguishes
   * causes that share one `code` (for example the three
   * `deployment-binding-mismatch` throw sites). Read by
   * `operator/error-envelope.ts`; absent for codes with no distinguishing
   * remediation of their own.
   */
  public readonly nextAction?: string;

  public constructor(code: ModelCompositionErrorCode, message?: string, nextAction?: string) {
    super(message ?? code);
    this.name = "ModelCompositionError";
    this.code = code;
    if (nextAction !== undefined) this.nextAction = nextAction;
  }
}
