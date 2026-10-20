// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { deepFreeze } from "../contract-kit/freeze.js";
import type { DocsFabConfig } from "../config/runtime-loader.js";
import { isReviewOverdue, type ModelEndpointConfig } from "./configuration.js";
import type { ModelProfileEvidence } from "../records/contracts.js";
import {
  canonicalizeJsonEvidence,
  parseJsonEvidence,
  type JsonEvidenceValue,
} from "../json-evidence.js";
import {
  MODEL_CATALOG_FIELDS,
  decodeModelCatalogObservation,
  type ModelCatalogObservationV1,
  type ModelProfilePurpose,
} from "./catalog-contracts.js";
import {
  decodeModelCatalogObservationProvenance,
  type ModelCatalogObservationProvenanceV1,
} from "./catalog-provenance.js";
import { reconcileModelCatalog } from "./catalog-reconciliation.js";
import {
  INFERENCE_HUB_METADATA_LABEL_PARAMETERS,
  inspectInferenceHubMetadata,
  type InferenceHubMetadataLabelParameter,
  type InferenceHubMetadataMode,
} from "./inference-hub-metadata.js";
import { discoverNvidiaInferenceModelCatalog } from "./nvidia-inference-catalog.js";
import { discoverOpenaiApiModelCatalog } from "./openai-api-catalog.js";
import { discoverAnthropicApiModelCatalog } from "./anthropic-api-catalog.js";
import {
  ANTHROPIC_API_CATALOG_ADAPTER,
  ANTHROPIC_API_CATALOG_SOURCE_ID,
  OPENAI_API_CATALOG_ADAPTER,
  OPENAI_API_CATALOG_SOURCE_ID,
  resolveModelCatalogAdapterSet,
} from "./catalog-serving-route.js";
import { catalogRemediationText, rejectSituation } from "../operator/situation-catalog.js";
import type { ModelEvidence } from "../records/contracts.js";
import {
  createModelEvidence,
  modelEvidenceProjectionDefect,
  type ModelEvidenceProjectionDefect,
} from "./profile-evidence.js";
import { OutboundProxyRefusal } from "./outbound-http-policy.js";
import { CredentialEndpointUntrustedError } from "../security/model-credential-release.js";

import {
  assertCredentialFree,
  dataObject,
  digest,
  invalidReport,
  SAFE_SOURCE_CODES,
  validTimestamp,
} from "./profile-inspection/primitives.js";
import {
  artifactId,
  inspectionField,
  remediationFor,
  reportReasons,
} from "./profile-inspection/projection.js";
import { validateReport } from "./profile-inspection/report-codec.js";
import {
  MODEL_PROFILE_INSPECTION_SCHEMA_VERSION,
  type EvidenceCell,
  type InspectModelProfileOptions,
  type ModelProfileInspectionFieldV1,
  type ModelProfileInspectionPreflightV1,
  type ModelProfileInspectionSourceV1,
  type ModelProfileInspectionV1,
  type SafeValue,
} from "./profile-inspection/schema.js";
export { MODEL_PROFILE_INSPECTION_SCHEMA_VERSION } from "./profile-inspection/schema.js";
export type {
  InspectModelProfileOptions,
  ModelProfileInspectionFieldV1,
  ModelProfileInspectionPreflightV1,
  ModelProfileInspectionSourceV1,
  ModelProfileInspectionV1,
} from "./profile-inspection/schema.js";

export function unsupportedApiFormatInspection(
  purpose: ModelProfilePurpose,
  clock: () => Date = () => new Date(),
): ModelProfileInspectionPreflightV1 {
  const generatedAt = inspectionTimestamp(clock);
  const value = {
    schemaVersion: 1 as const,
    kind: "docsfab-model-profile-inspection-preflight" as const,
    purpose,
    generatedAt,
    disposition: "unsupported" as const,
    apiDisposition: "unsupported" as const,
    reason: "unsupported-api-format" as const,
    field: purpose === "judge" ? ("JUDGE_API_FORMAT" as const) : ("MODEL_API_FORMAT" as const),
    remediation:
      "Configure chat_completions and include it in the compatible API formats before inspection." as const,
  };
  const report = { ...value, sha256: digest(value) };
  assertCredentialFree(report);
  return deepFreeze(report);
}

export function serializeModelProfileInspectionPreflight(
  report: ModelProfileInspectionPreflightV1,
): string {
  dataObject(report, [
    "schemaVersion",
    "kind",
    "purpose",
    "generatedAt",
    "disposition",
    "apiDisposition",
    "reason",
    "field",
    "remediation",
    "sha256",
  ]);
  const expected = unsupportedApiFormatInspection(
    report.purpose,
    () => new Date(report.generatedAt),
  );
  if (
    canonicalizeJsonEvidence(report as unknown as JsonEvidenceValue) !==
    canonicalizeJsonEvidence(expected as unknown as JsonEvidenceValue)
  )
    invalidReport();
  return canonicalizeJsonEvidence(report as unknown as JsonEvidenceValue);
}

export function formatModelProfileInspectionPreflight(
  report: ModelProfileInspectionPreflightV1,
): string {
  serializeModelProfileInspectionPreflight(report);
  return [
    `DocsFab model profile inspection preflight v1 (${report.purpose})`,
    `API format: ${report.apiDisposition} (${report.reason})`,
    `Field: ${report.field}`,
    `Remediation: ${report.remediation}`,
    `Evidence SHA-256: ${report.sha256}`,
  ].join("\n");
}

type EvidenceSettingPrefix = "MODEL" | "JUDGE";

interface EvidenceDefectSource {
  readonly field: string;
  readonly rule?: string;
  /** `null`: DocsFab assembles the field itself; no MODEL_* / JUDGE_* setting repairs it. */
  readonly keys: ((prefix: EvidenceSettingPrefix) => readonly string[]) | null;
}

/** Which configured setting supplies each evidence field. */
const EVIDENCE_DEFECT_SOURCES: Readonly<
  Record<ModelEvidenceProjectionDefect, EvidenceDefectSource>
> = Object.freeze({
  provider: {
    field: "provider id",
    rule: "use lowercase letters, digits, dots, underscores, or hyphens",
    keys: (prefix) => [`${prefix}_PROVIDER`],
  },
  model: {
    field: "model id",
    rule: "use letters, digits, dots, underscores, or hyphens in slash-separated segments that are not empty, `.`, or `..`",
    keys: (prefix) => [prefix === "MODEL" ? "MODEL_ID" : "JUDGE_MODEL_ID"],
  },
  profile: { field: "profile projection", keys: null },
  shape: { field: "profile projection shape", keys: null },
  "context-window": { field: "context window", keys: (prefix) => [`${prefix}_CONTEXT_WINDOW`] },
  "max-input-tokens": {
    field: "maximum input tokens",
    keys: (prefix) => [`${prefix}_MAX_INPUT_TOKENS`, `${prefix}_CONTEXT_WINDOW`],
  },
  "max-output-tokens": {
    field: "maximum output tokens",
    keys: (prefix) => [`${prefix}_MAX_OUTPUT_TOKENS`, `${prefix}_CONTEXT_WINDOW`],
  },
  "limit-reason": {
    field: "profile review status",
    keys: (prefix) => [
      `${prefix}_PROFILE_APPROVED_SOURCE`,
      `${prefix}_PROFILE_EFFECTIVE_DATE`,
      `${prefix}_PROFILE_REVIEW_AFTER`,
    ],
  },
  "api-format": { field: "API format", keys: (prefix) => [`${prefix}_API_FORMAT`] },
  reasoning: { field: "reasoning capability", keys: (prefix) => [`${prefix}_REASONING`] },
  "input-types": { field: "input types", keys: (prefix) => [`${prefix}_INPUT_TYPES`] },
  compatibility: {
    field: "compatibility claims",
    keys: (prefix) => [
      `${prefix}_COMPATIBLE_API_FORMATS`,
      `${prefix}_SUPPORTS_DEVELOPER_ROLE`,
      `${prefix}_SUPPORTS_REASONING_EFFORT`,
    ],
  },
  "request-policy": {
    field: "request policy",
    keys: (prefix) => [`${prefix}_API_MIN_OUTPUT_TOKENS`, `${prefix}_CONTEXT_RESERVE_TOKENS`],
  },
  pricing: {
    field: "pricing",
    keys: (prefix) => [
      `${prefix}_INPUT_COST_PER_MILLION`,
      `${prefix}_OUTPUT_COST_PER_MILLION`,
      `${prefix}_CACHE_READ_COST_PER_MILLION`,
      `${prefix}_CACHE_WRITE_COST_PER_MILLION`,
    ],
  },
  "approved-source": {
    field: "approved source",
    keys: (prefix) => [`${prefix}_PROFILE_APPROVED_SOURCE`],
  },
  "effective-date": {
    field: "effective date",
    keys: (prefix) => [`${prefix}_PROFILE_EFFECTIVE_DATE`],
  },
  "review-after": { field: "review date", keys: (prefix) => [`${prefix}_PROFILE_REVIEW_AFTER`] },
  digest: { field: "profile digest", keys: null },
});

/**
 * Operator text for an evidence defect: names the field and the setting that
 * supplies it, never the configured value.
 */
export function modelEvidenceDefectMessage(
  defect: ModelEvidenceProjectionDefect,
  purpose: ModelProfilePurpose,
): string {
  const prefix: EvidenceSettingPrefix = purpose === "judge" ? "JUDGE" : "MODEL";
  const source = EVIDENCE_DEFECT_SOURCES[defect];
  if (!source.keys) {
    return `Configured model profile evidence is unavailable: DocsFab assembled an inconsistent ${source.field} from settings that loaded, and no ${prefix}_* setting supplies it.`;
  }
  const keys = source.keys(prefix);
  const rule = source.rule ? ` (${source.rule})` : "";
  const verb = keys.length === 1 ? "supplies" : "supply";
  return `Configured model profile evidence is unavailable: the configured ${source.field} cannot form evidence${rule}. ${keys.join(", ")} ${verb} it.`;
}

/**
 * The operator message for the configured endpoint's evidence defect, or
 * `undefined` when its evidence projection is complete. Shared by
 * `profile inspect` and doctor readiness so both apply one rule.
 */
export function configuredModelEvidenceDefectMessage(
  evidence: ModelEvidence,
  purpose: ModelProfilePurpose,
): string | undefined {
  const defect = modelEvidenceProjectionDefect(evidence);
  return defect === undefined ? undefined : modelEvidenceDefectMessage(defect, purpose);
}

/**
 * Handles exactly one condition: the configured endpoint's evidence projection
 * has a defect. A configuration that fails to load throws earlier, from the
 * loader, under its own code; valid evidence passes through untouched.
 */
export function assertConfiguredModelEvidence(
  evidence: ModelEvidence,
  purpose: ModelProfilePurpose,
): asserts evidence is ModelEvidence & { profile: ModelProfileEvidence } {
  const message = configuredModelEvidenceDefectMessage(evidence, purpose);
  if (message === undefined) return;
  rejectSituation("profile-evidence-invalid", message);
}

interface CollectedSource {
  summary: ModelProfileInspectionSourceV1;
  observation?: ModelCatalogObservationV1;
  provenance?: ModelCatalogObservationProvenanceV1;
}

/** Read-only inspection. Without `catalog: true`, this function performs no provider I/O. */
export async function inspectModelProfile(
  config: DocsFabConfig,
  options: InspectModelProfileOptions = {},
): Promise<ModelProfileInspectionV1> {
  const purpose = options.purpose ?? "policy";
  const configuredEndpoint = purpose === "judge" ? config.judge : config.model;
  if (!configuredEndpoint) {
    throw new Error(
      "profile inspect --judge requires JUDGE_ENABLED=true and JUDGE_* configuration.",
    );
  }
  return inspectModelEndpointProfile(configuredEndpoint, purpose, options);
}

export async function inspectModelEndpointProfile(
  configuredEndpoint: ModelEndpointConfig,
  purpose: ModelProfilePurpose,
  options: Omit<InspectModelProfileOptions, "purpose"> = {},
): Promise<ModelProfileInspectionV1> {
  const endpoint = snapshotEndpoint(configuredEndpoint);
  if (endpoint.apiFormat !== "chat_completions" && endpoint.apiFormat !== "messages") {
    throw new Error(
      "Technical profile inspection does not support the configured API format; use the provider-neutral executable composition path instead.",
    );
  }
  const clock = options.clock ?? (() => new Date());
  const evidence = createModelEvidence(endpoint);
  assertConfiguredModelEvidence(evidence, purpose);

  let collected: CollectedSource[] = [notRequested("inference"), notRequested("metadata")];
  if (options.catalog === true) {
    collected = await collectCatalog(endpoint, purpose, options, clock);
  }
  const generatedAt = inspectionTimestamp(clock);
  if (
    collected.some((item) => item.observation && item.observation.source.retrievedAt > generatedAt)
  ) {
    rejectSituation(
      "profile-inspection-clock-invalid",
      "Model profile inspection clock is invalid or non-monotonic.",
    );
  }
  const observed = collected.flatMap((item) => (item.observation ? [item.observation] : []));
  const provenance = collected.flatMap((item) => (item.provenance ? [item.provenance] : []));
  const reconciliationInput = {
    observationSetId: artifactId("inspection-observations", purpose, generatedAt, observed),
    observationSetCompletedAt: generatedAt,
    proposalId: artifactId("inspection-proposal", purpose, generatedAt, observed),
    proposalCreatedAt: generatedAt,
    decisionId: artifactId("inspection-decision", purpose, generatedAt, observed),
  };
  const reconciliation =
    observed.length === 0
      ? null
      : reconcileModelCatalog({
          purpose,
          ...reconciliationInput,
          observations: observed,
          observationProvenance: provenance,
        });
  const reasons = reportReasons(
    evidence.profile.effectiveLimitReason,
    options.catalog === true,
    collected.map((item) => item.summary),
    reconciliation?.decision,
  );
  const reportWithoutDigest = {
    schemaVersion: MODEL_PROFILE_INSPECTION_SCHEMA_VERSION,
    kind: "docsfab-model-profile-inspection" as const,
    purpose,
    generatedAt,
    subject: {
      provider: evidence.provider,
      model: evidence.model,
      apiFormat: endpoint.apiFormat,
      apiDisposition: "supported" as const,
    },
    runtime: {
      profileEvidence: evidence.profile,
      profileStatus: evidence.profile.status,
      effectiveLimitReason: evidence.profile.effectiveLimitReason,
      fallbackApplied: evidence.profile.effectiveLimitReason !== "none",
      configuredApprovalClaim: endpoint.profile.metadata.approvedSource
        ? ("present" as const)
        : ("absent" as const),
      configuredClaim: {
        freshness: evidence.profile.status,
        approvedSourceSha256: evidence.profile.approvedSourceSha256 ?? null,
        effectiveDate: evidence.profile.effectiveDate ?? null,
        reviewAfter: evidence.profile.reviewAfter ?? null,
        verification: "not-performed" as const,
      },
      verifiedApproval: "unknown" as const,
    },
    catalog: {
      requested: options.catalog === true,
      sources: collected.map((item) => item.summary),
      reconciliation: reconciliation
        ? {
            status: reconciliation.status,
            input: reconciliationInput,
            observationSet: reconciliation.observationSet,
            proposal: reconciliation.status === "proposed" ? reconciliation.proposal : null,
            proposalProvenance:
              reconciliation.status === "proposed" ? reconciliation.proposalProvenance : null,
            decision: reconciliation.decision,
          }
        : null,
    },
    fields: MODEL_CATALOG_FIELDS.map((field) =>
      inspectionField(
        field,
        { provider: evidence.provider, model: evidence.model },
        evidence.profile,
        collected.map((item) => item.summary),
        reconciliation?.status === "proposed" ? reconciliation.proposal.fields : [],
      ),
    ),
    reasons,
    remediation: remediationFor(
      evidence.profile.effectiveLimitReason,
      options.catalog === true,
      collected.map((item) => item.summary),
      reconciliation?.decision,
    ),
  };
  const report: ModelProfileInspectionV1 = {
    ...reportWithoutDigest,
    sha256: digest(reportWithoutDigest),
  };
  validateReport(report);
  assertCredentialFree(serializeModelProfileInspection(report));
  return deepFreeze(report);
}

export function serializeModelProfileInspection(report: ModelProfileInspectionV1): string {
  validateReport(report);
  return canonicalizeJsonEvidence(report as unknown as JsonEvidenceValue);
}

export function decodeModelProfileInspection(
  value: string | Uint8Array | unknown,
): ModelProfileInspectionV1 {
  const parsed =
    typeof value === "string" || value instanceof Uint8Array ? parseJsonEvidence(value) : value;
  validateReport(parsed as ModelProfileInspectionV1);
  return deepFreeze(parsed as ModelProfileInspectionV1);
}

export function formatModelProfileInspection(report: ModelProfileInspectionV1): string {
  validateReport(report);
  const limit = (name: "contextWindow" | "maxInputTokens" | "maxOutputTokens") =>
    report.fields.find((item) => item.field === name)!;
  const tokenLimit = (name: "contextWindow" | "maxInputTokens" | "maxOutputTokens") => {
    const cell = limit(name).effective;
    return cell.state === "known" && typeof cell.value === "number"
      ? new Intl.NumberFormat("en-US").format(cell.value)
      : cell.state;
  };
  const status =
    report.runtime.effectiveLimitReason === "none"
      ? "Ready"
      : report.runtime.effectiveLimitReason === "metadata-unknown"
        ? "Ready without a DocsFab host context ceiling"
        : "Needs attention";
  const profileExplanation =
    report.runtime.effectiveLimitReason === "none"
      ? "The profile metadata is current. DocsFab will use the configured token limits."
      : report.runtime.effectiveLimitReason === "metadata-unknown"
        ? "The model metadata is not attested. DocsFab does not invent a host context ceiling."
        : // Only a saved legacy report can carry `metadata-stale`.
          "The model metadata review date had passed when this report was generated, under the earlier expiry rule. Review dates are now advisory; re-inspect to see the current limits.";
  const reviewOverdue = reviewOverdueInspectionLines(report);
  const source = (name: "inference" | "metadata") =>
    report.catalog.sources.find((item) => item.source === name)!;
  const sourceStatus = (name: "inference" | "metadata"): string => {
    const selected = source(name);
    if (selected.status === "observed") return "available";
    if (selected.status === "not-requested") return "not requested";
    return `unavailable${selected.code ? ` (${selected.code})` : ""}`;
  };
  const providerCheck = !report.catalog.requested
    ? "Provider check: Not run. Only the local configuration was inspected."
    : source("metadata").code === "hub-metadata-not-applicable"
      ? `Provider check: Direct-provider catalog ${sourceStatus("inference")}. Inference Hub Metadata is not used on this serving route.`
      : source("inference").code === "adapter-not-implemented"
        ? "Provider check: Catalog adapter not implemented for this serving route."
        : `Provider check: Inference catalog ${sourceStatus("inference")}; metadata catalog ${sourceStatus("metadata")}.`;
  const reconciliation = report.catalog.reconciliation?.decision.disposition;
  const reconciliationLabel = reconciliation
    ? `${reconciliation[0]!.toUpperCase()}${reconciliation.slice(1).replaceAll("-", " ")}`
    : undefined;
  const nextStep =
    report.runtime.effectiveLimitReason === "metadata-stale"
      ? `Next step: ${catalogRemediationText("profile-review-lapsed")}`
      : reconciliation === "review-required" || reconciliation === "blocked"
        ? "Next step: Review the catalog differences with `docsfab profile inspect --catalog --verbose`."
        : report.runtime.effectiveLimitReason === "metadata-unknown"
          ? "Next step: No action is required for local testing. Verify or approve the metadata before treating it as governed evidence."
          : "Next step: No action is required for ordinary local use.";
  return [
    "DocsFab model profile",
    "",
    "This command shows which model DocsFab will use and the token limits currently in effect.",
    "It does not call the model.",
    "",
    `Status: ${status}`,
    `Model: ${report.subject.model}`,
    `Provider: ${report.subject.provider}`,
    `Use: ${report.purpose === "policy" ? "Documentation workflows" : "Quality judge"}`,
    `Token limits: ${tokenLimit("maxInputTokens")} input; ${tokenLimit("maxOutputTokens")} output; ${tokenLimit("contextWindow")} total context`,
    "",
    profileExplanation,
    ...reviewOverdue,
    providerCheck,
    ...(reconciliationLabel ? [`Catalog result: ${reconciliationLabel}.`] : []),
    nextStep,
    "",
    report.catalog.requested ? "More detail:" : "Optional checks:",
    ...(!report.catalog.requested
      ? ["  Compare with provider metadata: docsfab profile inspect --catalog"]
      : []),
    `  Show technical evidence: docsfab profile inspect${report.catalog.requested ? " --catalog" : ""} --verbose`,
    `  Print JSON evidence: docsfab profile inspect${report.catalog.requested ? " --catalog" : ""} --json`,
  ].join("\n");
}

/** Full field-level evidence view for audits and profile-approval workflows. */
/**
 * Read-time advisory from the report's own clock and claimed review date;
 * neither the report schema nor its digest carries it.
 */
function reviewOverdueInspectionLines(report: ModelProfileInspectionV1): string[] {
  return isReviewOverdue(report.runtime.configuredClaim.reviewAfter, new Date(report.generatedAt))
    ? [
        `Review overdue: the profile review date ${report.runtime.configuredClaim.reviewAfter} has passed. This is a reminder only; DocsFab still uses the configured limits, capabilities, and prices.`,
      ]
    : [];
}

export function formatModelProfileInspectionDetailed(report: ModelProfileInspectionV1): string {
  validateReport(report);
  const source = (name: "inference" | "metadata") =>
    report.catalog.sources.find((item) => item.source === name)!;
  const limit = (name: "contextWindow" | "maxInputTokens" | "maxOutputTokens") =>
    report.fields.find((item) => item.field === name)!;
  const showValue = (value: SafeValue): string =>
    typeof value === "object" ? (Array.isArray(value) ? value.join(",") : "known") : String(value);
  const show = (cell: EvidenceCell): string =>
    cell.state === "known"
      ? showValue(cell.value)
      : cell.state === "conflicting" && cell.selected !== undefined
        ? `conflicting(selected=${showValue(cell.selected)})`
        : cell.state;
  const drift = report.fields
    .filter((item) => item.drift.status !== "aligned")
    .map(
      (item) =>
        `  ${item.field}: configured=${show(item.configured)}, effective=${show(item.effective)}, observed=${item.observed.length === 0 ? "none" : item.observed.map((entry) => `${entry.source}:${show(entry.evidence)}`).join("|")}, proposed=${show(item.proposed)}, approved=${show(item.approved)} [${item.drift.reasons.join(",")}]`,
    );
  return [
    `DocsFab model profile inspection v${report.schemaVersion} (${report.purpose})`,
    `Subject: ${report.subject.provider}/${report.subject.model}`,
    `Runtime: ${report.runtime.profileStatus}; fallback=${report.runtime.fallbackApplied ? "active" : "inactive"}; verified-approval=unknown`,
    `Configured claim: freshness=${report.runtime.configuredClaim.freshness}; source-digest=${report.runtime.configuredClaim.approvedSourceSha256 ?? "unknown"}; verification=not-performed`,
    ...reviewOverdueInspectionLines(report),
    `Limits: context=${show(limit("contextWindow").effective)}, input=${show(limit("maxInputTokens").effective)}, output=${show(limit("maxOutputTokens").effective)}`,
    `Catalog: requested=${report.catalog.requested}; inference=${source("inference").status}${source("inference").code ? `(${source("inference").code})` : ""}; metadata=${source("metadata").status}${source("metadata").code ? `(${source("metadata").code})` : ""}`,
    `Reconciliation: ${report.catalog.reconciliation?.decision.disposition ?? "unavailable"}`,
    ...(report.catalog.reconciliation?.status === "proposed" &&
    report.catalog.reconciliation.proposal &&
    report.catalog.reconciliation.proposalProvenance
      ? [
          `Proposal evidence: proposal-sha256=${report.catalog.reconciliation.proposal.sha256}; proposal-provenance-sha256=${report.catalog.reconciliation.proposalProvenance.sha256}; decision-sha256=${report.catalog.reconciliation.decision.sha256}`,
        ]
      : []),
    "Drift:",
    ...(drift.length > 0 ? drift : ["  none"]),
    `Reasons: ${report.reasons.join(", ")}`,
    "Remediation:",
    ...report.remediation.map((item) => `  - ${item}`),
    `Evidence SHA-256: ${report.sha256}`,
  ].join("\n");
}

async function collectCatalog(
  endpoint: ModelEndpointConfig,
  purpose: ModelProfilePurpose,
  options: InspectModelProfileOptions,
  clock: () => Date,
): Promise<CollectedSource[]> {
  const adapterSet = resolveModelCatalogAdapterSet(endpoint);
  if (adapterSet === "nvidia-inference-api") {
    return collectNvidiaInferenceCatalog(endpoint, purpose, options, clock);
  }
  if (adapterSet === "openai-api" || adapterSet === "anthropic-api") {
    return collectDirectProviderCatalog(adapterSet, endpoint, purpose, options, clock);
  }
  return [
    unavailable("inference", "adapter-not-implemented"),
    unavailable("metadata", "adapter-not-implemented"),
  ];
}

async function collectDirectProviderCatalog(
  adapterSet: "openai-api" | "anthropic-api",
  endpoint: ModelEndpointConfig,
  purpose: ModelProfilePurpose,
  options: InspectModelProfileOptions,
  clock: () => Date,
): Promise<CollectedSource[]> {
  const discovery =
    adapterSet === "openai-api"
      ? discoverOpenaiApiModelCatalog({
          config: endpoint,
          purpose,
          fetch: options.fetch,
          clock,
        })
      : discoverAnthropicApiModelCatalog({
          config: endpoint,
          purpose,
          fetch: options.fetch,
          clock,
        });
  const settled = (await Promise.allSettled([discovery]))[0]!;
  rethrowProxyRefusal(settled);
  const inferenceCollected =
    settled.status === "fulfilled"
      ? observedSource("inference", settled.value.observation, settled.value.provenance)
      : unavailable("inference", safeErrorCode(settled.reason, "catalog-unavailable"));
  return [inferenceCollected, unavailable("metadata", "hub-metadata-not-applicable")];
}

async function collectNvidiaInferenceCatalog(
  endpoint: ModelEndpointConfig,
  purpose: ModelProfilePurpose,
  options: InspectModelProfileOptions,
  clock: () => Date,
): Promise<CollectedSource[]> {
  const environment = options.environment ?? process.env;
  const inference = discoverNvidiaInferenceModelCatalog({
    config: endpoint,
    purpose,
    fetch: options.fetch,
    clock,
  });
  const hostMetadata = readHostMetadataConfiguration(environment, purpose);
  const origin = hostMetadata.values.INFERENCE_HUB_METADATA_ORIGIN;
  const path = hostMetadata.values.INFERENCE_HUB_METADATA_PATH;
  const rawMode = hostMetadata.values.INFERENCE_HUB_METADATA_MODE;
  const label = hostMetadata.values.INFERENCE_HUB_METADATA_LABEL;
  const rawLabelParameter = hostMetadata.values.INFERENCE_HUB_METADATA_LABEL_PARAMETER;
  const mode: InferenceHubMetadataMode | undefined =
    rawMode === "browse" || rawMode === "search" || rawMode === "slim" ? rawMode : undefined;
  const labelParameter = (INFERENCE_HUB_METADATA_LABEL_PARAMETERS as readonly string[]).includes(
    rawLabelParameter ?? "",
  )
    ? (rawLabelParameter as InferenceHubMetadataLabelParameter)
    : undefined;
  const metadataConfigurationInvalid = Boolean(
    !hostMetadata.valid || (rawMode && !mode) || (rawLabelParameter && !labelParameter),
  );
  const metadata =
    !metadataConfigurationInvalid && origin && path && mode && label
      ? inspectInferenceHubMetadata({
          requested: true,
          authority: "authenticated",
          purpose,
          label,
          endpoint: { origin, path, mode, ...(labelParameter ? { labelParameter } : {}) },
          environment: hostMetadata.environment,
          fetch: options.fetch,
          clock,
        })
      : Promise.resolve({
          status: metadataConfigurationInvalid ? "configuration-invalid" : "configuration-missing",
        } as const);
  const [inferenceResult, metadataResult] = await Promise.allSettled([inference, metadata]);
  rethrowProxyRefusal(inferenceResult);
  rethrowProxyRefusal(metadataResult);
  const inferenceCollected =
    inferenceResult.status === "fulfilled"
      ? observedSource(
          "inference",
          inferenceResult.value.observation,
          inferenceResult.value.provenance,
        )
      : unavailable("inference", safeErrorCode(inferenceResult.reason, "catalog-unavailable"));
  let metadataCollected: CollectedSource;
  if (metadataResult.status === "rejected") {
    metadataCollected = unavailable(
      "metadata",
      safeErrorCode(metadataResult.reason, "catalog-unavailable"),
    );
  } else if (metadataResult.value.status === "observed") {
    metadataCollected = observedSource(
      "metadata",
      metadataResult.value.observation,
      metadataResult.value.provenance,
    );
  } else {
    metadataCollected = unavailable(
      "metadata",
      metadataResult.value.status === "optional-capability-unavailable"
        ? metadataResult.value.diagnostic.code
        : metadataResult.value.status === "configuration-invalid"
          ? "metadata-configuration-invalid"
          : "metadata-configuration-missing",
    );
  }
  return [inferenceCollected, metadataCollected];
}

const HOST_METADATA_KEYS = [
  "INFERENCE_HUB_METADATA_ORIGIN",
  "INFERENCE_HUB_METADATA_PATH",
  "INFERENCE_HUB_METADATA_MODE",
  "INFERENCE_HUB_METADATA_LABEL_PARAMETER",
] as const;

function readHostMetadataConfiguration(
  environment: NodeJS.ProcessEnv,
  purpose: ModelProfilePurpose,
): {
  valid: boolean;
  values: Partial<
    Record<(typeof HOST_METADATA_KEYS)[number] | "INFERENCE_HUB_METADATA_LABEL", string>
  >;
  environment: NodeJS.ProcessEnv;
} {
  const values: Partial<
    Record<(typeof HOST_METADATA_KEYS)[number] | "INFERENCE_HUB_METADATA_LABEL", string>
  > = {};
  try {
    const labelKey =
      purpose === "judge"
        ? "JUDGE_INFERENCE_HUB_METADATA_LABEL"
        : "MODEL_INFERENCE_HUB_METADATA_LABEL";
    for (const key of [
      ...HOST_METADATA_KEYS,
      labelKey,
      "INFERENCE_HUB_METADATA_API_KEY",
    ] as const) {
      const descriptor = Object.getOwnPropertyDescriptor(environment, key);
      if (!descriptor) continue;
      if (!("value" in descriptor) || typeof descriptor.value !== "string") {
        return { valid: false, values: {}, environment: Object.freeze({}) };
      }
      const value = descriptor.value.trim();
      if (value && key === labelKey) values.INFERENCE_HUB_METADATA_LABEL = value;
      else if (value && (HOST_METADATA_KEYS as readonly string[]).includes(key)) {
        values[key as (typeof HOST_METADATA_KEYS)[number]] = value;
      }
    }
    const credentialDescriptor = Object.getOwnPropertyDescriptor(
      environment,
      "INFERENCE_HUB_METADATA_API_KEY",
    );
    const credential =
      credentialDescriptor &&
      "value" in credentialDescriptor &&
      typeof credentialDescriptor.value === "string"
        ? credentialDescriptor.value.trim()
        : undefined;
    return {
      valid: true,
      values,
      environment: Object.freeze({
        ...(credential ? { INFERENCE_HUB_METADATA_API_KEY: credential } : {}),
      }),
    };
  } catch {
    return { valid: false, values: {}, environment: Object.freeze({}) };
  }
}

function notRequested(source: "inference" | "metadata"): CollectedSource {
  return { summary: { source, status: "not-requested", code: null, evidence: null } };
}

function unavailable(source: "inference" | "metadata", code: string): CollectedSource {
  return { summary: { source, status: "unavailable", code, evidence: null } };
}

function observedSource(
  source: "inference" | "metadata",
  observation: ModelCatalogObservationV1,
  provenance: ModelCatalogObservationProvenanceV1,
): CollectedSource {
  return {
    summary: {
      source,
      status: "observed",
      code: null,
      evidence: { observation, provenance },
    },
    observation,
    provenance,
  };
}

/**
 * A local proxy refusal, or a model key DocsFab kept back from an endpoint the
 * operator did not configure, sent nothing and is not an unavailable catalog;
 * it fails the inspection with its own code.
 */
function rethrowProxyRefusal(result: PromiseSettledResult<unknown>): void {
  if (
    result.status === "rejected" &&
    (result.reason instanceof OutboundProxyRefusal ||
      result.reason instanceof CredentialEndpointUntrustedError)
  ) {
    throw result.reason;
  }
}

function safeErrorCode(error: unknown, fallback: string): string {
  if (
    error &&
    typeof error === "object" &&
    "code" in error &&
    typeof (error as { code: unknown }).code === "string" &&
    SAFE_SOURCE_CODES.has((error as { code: string }).code)
  ) {
    return (error as { code: string }).code;
  }
  return fallback;
}

function snapshotEndpoint(endpoint: ModelEndpointConfig): ModelEndpointConfig {
  return Object.freeze({
    providerId: endpoint.providerId,
    baseUrl: endpoint.baseUrl,
    // The catalog lookups release the key by this label.
    ...(endpoint.endpointSource !== undefined ? { endpointSource: endpoint.endpointSource } : {}),
    modelId: endpoint.modelId,
    apiFormat: endpoint.apiFormat,
    api: endpoint.api,
    apiKey: endpoint.apiKey,
    requestPolicy: Object.freeze({ ...endpoint.requestPolicy }),
    profile: Object.freeze({
      configuredLimits: Object.freeze({ ...endpoint.profile.configuredLimits }),
      contextWindow: endpoint.profile.contextWindow,
      maxInputTokens: endpoint.profile.maxInputTokens,
      maxOutputTokens: endpoint.profile.maxOutputTokens,
      effectiveLimitReason: endpoint.profile.effectiveLimitReason,
      reasoning: endpoint.profile.reasoning,
      input: Object.freeze([
        ...endpoint.profile.input,
      ]) as unknown as ModelEndpointConfig["profile"]["input"],
      compatibility: Object.freeze({
        ...endpoint.profile.compatibility,
        apiFormats: Object.freeze([
          ...endpoint.profile.compatibility.apiFormats,
        ]) as unknown as ModelEndpointConfig["profile"]["compatibility"]["apiFormats"],
      }),
      costPerMillionTokens: Object.freeze({ ...endpoint.profile.costPerMillionTokens }),
      metadata: Object.freeze({ ...endpoint.profile.metadata }),
    }),
  });
}

function inspectionTimestamp(clock: () => Date): string {
  const instant = clock();
  if (!Number.isFinite(instant.valueOf())) {
    rejectSituation(
      "profile-inspection-clock-invalid",
      "Model profile inspection clock is invalid.",
    );
  }
  const timestamp = instant.toISOString();
  if (!validTimestamp(timestamp)) {
    rejectSituation(
      "profile-inspection-clock-invalid",
      "Model profile inspection clock is invalid.",
    );
  }
  return timestamp;
}
