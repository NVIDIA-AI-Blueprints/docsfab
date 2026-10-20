// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { readFile, realpath } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { types as nodeUtilTypes } from "node:util";

import { canonicalDigest, createHostAuthorityFactory, deepFreeze } from "../contract-kit/index.js";
import { EXECUTABLE_ROUTE_BASE_URLS, type ExecutableRouteId } from "../config/execution-profile.js";
import {
  assertModelEndpointTransport,
  isAdmittedModelEndpoint,
} from "../model/endpoint-transport.js";
import {
  decodeAdapterRegistry,
  decodeCandidateProjectionRegistry,
  decodeCompositionRegistry,
  decodeInstalledManifest,
  decodeWorkflowCatalog,
  type DecodedInstalledAssets,
} from "./contracts.js";
import {
  ModelCompositionError,
  type BoundInstalledComposition,
  type BoundExecutableComposition,
  type InstalledCandidateProjection,
  type InstalledExecutionComposition,
  type InstalledModelCompositionAdapter,
  type InstalledModelCompositionAuthority,
  type InstalledModelCompositionSnapshot,
  type InstalledModelCompositionSummary,
  type InstalledWorkflowComposition,
  type InstalledAnswerSubmission,
  type MeasuredReasoningControl,
  type ModelCompositionAdapterKind,
  type ModelCompositionAdapterReference,
  type VerifiedInstalledDeploymentBinding,
} from "./types.js";
import { sha256 } from "../content-ir/canonical.js";
import { assertCompositionNotRetired } from "./retirement.js";
import { EXPECTED_INSTALLED_MANIFEST_FILE_SHA256 } from "./installed-manifest-pin.js";

export { assertCompositionNotRetired };

const EXPECTED_ASSET_PATHS = {
  "adapter-registry": "adapter-registry.json",
  "candidate-projections": "candidate-projections.json",
  "composition-registry": "composition-registry.json",
  "workflow-catalog": "workflow-catalog.json",
} as const;

interface InstalledAssetVerifier {
  readonly assets: DecodedInstalledAssets;
  verifyCurrent(): boolean;
}

const authorityFactory = createHostAuthorityFactory<
  "docsfab-installed-model-composition-authority",
  InstalledAssetVerifier
>({
  kind: "docsfab-installed-model-composition-authority",
  invalidMessage: "invalid-installed-model-composition-verifier",
});

function asJson(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(Buffer.from(bytes).toString("utf8"));
  } catch {
    throw new ModelCompositionError("asset-json-invalid");
  }
}

async function readBytes(path: string): Promise<Uint8Array> {
  try {
    return await readFile(path);
  } catch {
    throw new ModelCompositionError("asset-read-failed");
  }
}

function requireInside(root: string, path: string): void {
  if (path !== root && !path.startsWith(`${root}${sep}`)) {
    throw new ModelCompositionError("contract-invalid-value");
  }
}

function manifestContractDigest(assets: DecodedInstalledAssets, kind: string): string {
  if (kind === "adapter-registry") return assets.adapterRegistry.registrySha256;
  if (kind === "candidate-projections") return assets.candidateRegistry.registrySha256;
  if (kind === "composition-registry") return assets.compositionRegistry.registrySha256;
  if (kind === "workflow-catalog") return assets.workflowCatalog.catalogSha256;
  throw new ModelCompositionError("installed-manifest-file-set-mismatch");
}

function findAdapter(
  adapters: readonly InstalledModelCompositionAdapter[],
  kind: ModelCompositionAdapterKind,
  reference: ModelCompositionAdapterReference,
): InstalledModelCompositionAdapter {
  const matches = adapters.filter(
    (entry) =>
      entry.kind === kind && entry.id === reference.id && entry.version === reference.version,
  );
  if (matches.length !== 1) throw new ModelCompositionError("adapter-binding-mismatch");
  return matches[0]!;
}

function validateCandidateBinding(
  composition: InstalledExecutionComposition,
  candidate: InstalledCandidateProjection,
): void {
  if (
    candidate.compositionId !== composition.compositionId ||
    candidate.compositionSha256 !== composition.compositionSha256 ||
    candidate.modelId !== composition.model.resolvedId ||
    candidate.routeId !== composition.deployment.routeId ||
    candidate.deploymentIdentitySha256 !== composition.deployment.identitySha256 ||
    candidate.harnessId !== composition.harness.id ||
    candidate.providerConnectionAdapter.id !== composition.adapters.providerConnection.id ||
    candidate.providerConnectionAdapter.version !== composition.adapters.providerConnection.version
  ) {
    throw new ModelCompositionError("candidate-binding-mismatch");
  }
}

function validateAdapterBinding(
  composition: InstalledExecutionComposition,
  adapters: readonly InstalledModelCompositionAdapter[],
): void {
  const route = findAdapter(adapters, "route-evidence", composition.adapters.routeEvidence);
  const authentication = findAdapter(
    adapters,
    "authentication",
    composition.adapters.authentication,
  );
  const connection = findAdapter(
    adapters,
    "provider-connection",
    composition.adapters.providerConnection,
  );
  const harness = findAdapter(adapters, "harness", composition.adapters.harness);
  if (
    route.kind !== "route-evidence" ||
    route.routeId !== composition.deployment.routeId ||
    route.transport !== composition.deployment.transport ||
    route.deploymentIdentitySha256 !== composition.deployment.identitySha256 ||
    authentication.kind !== "authentication" ||
    authentication.routeId !== composition.deployment.routeId ||
    authentication.credentialFamily !== composition.authentication.credentialFamily ||
    authentication.mechanism !== composition.authentication.mechanism ||
    JSON.stringify(authentication.sourceNames) !==
      JSON.stringify(composition.authentication.sourceNames) ||
    connection.kind !== "provider-connection" ||
    connection.executionClass !== composition.executionClass ||
    connection.routeId !== composition.deployment.routeId ||
    connection.transport !== composition.deployment.transport ||
    connection.deploymentIdentitySha256 !== composition.deployment.identitySha256 ||
    harness.kind !== "harness" ||
    harness.executionClass !== composition.executionClass ||
    harness.harnessId !== composition.harness.id ||
    harness.harnessPolicySha256 !== composition.harness.policySha256
  ) {
    throw new ModelCompositionError("adapter-binding-mismatch");
  }
  const expectedStatus =
    composition.executionClass === "pi-provider" ? "implemented" : "preflight-only";
  if (
    route.status !== expectedStatus ||
    authentication.status !== expectedStatus ||
    connection.status !== expectedStatus ||
    harness.status !== expectedStatus
  ) {
    throw new ModelCompositionError("adapter-binding-mismatch");
  }
}

async function validateWorkflowSources(
  packageRoot: string,
  workflows: readonly InstalledWorkflowComposition[],
): Promise<void> {
  for (const workflow of workflows) {
    const path = resolve(packageRoot, workflow.sourcePath);
    requireInside(packageRoot, path);
    const bytes = await readBytes(path);
    if (sha256(bytes) !== workflow.sourceSha256) {
      throw new ModelCompositionError("workflow-source-digest-mismatch");
    }
  }
}

function validateCrossBindings(assets: DecodedInstalledAssets): void {
  const { compositions } = assets.compositionRegistry;
  const { candidates } = assets.candidateRegistry;
  const { adapters } = assets.adapterRegistry;
  for (const composition of compositions) {
    const matchingCandidates = candidates.filter(
      (candidate) => candidate.compositionId === composition.compositionId,
    );
    if (matchingCandidates.length !== 1) {
      throw new ModelCompositionError("candidate-binding-mismatch");
    }
    validateCandidateBinding(composition, matchingCandidates[0]!);
    validateAdapterBinding(composition, adapters);
  }
  if (candidates.length !== compositions.length) {
    throw new ModelCompositionError("candidate-binding-mismatch");
  }

  const referencedAdapters = new Set<string>();
  for (const composition of compositions) {
    referencedAdapters.add(
      `route-evidence:${composition.adapters.routeEvidence.id}@${composition.adapters.routeEvidence.version}`,
    );
    referencedAdapters.add(
      `authentication:${composition.adapters.authentication.id}@${composition.adapters.authentication.version}`,
    );
    referencedAdapters.add(
      `provider-connection:${composition.adapters.providerConnection.id}@${composition.adapters.providerConnection.version}`,
    );
    referencedAdapters.add(
      `harness:${composition.adapters.harness.id}@${composition.adapters.harness.version}`,
    );
  }
  for (const adapter of adapters) {
    if (!referencedAdapters.has(`${adapter.kind}:${adapter.id}@${adapter.version}`)) {
      throw new ModelCompositionError("adapter-binding-mismatch");
    }
  }
}

async function loadFromTrustedRoot(
  assetRoot: string,
  expectedManifestFileSha256: string,
): Promise<{
  authority: InstalledModelCompositionAuthority;
  snapshot: InstalledModelCompositionSnapshot;
}> {
  const canonicalAssetRoot = await realpath(assetRoot).catch(() => {
    throw new ModelCompositionError("asset-read-failed");
  });
  const packageRoot = dirname(canonicalAssetRoot);
  const manifestPath = resolve(canonicalAssetRoot, "installed-manifest.json");
  requireInside(canonicalAssetRoot, manifestPath);
  const manifestBytes = await readBytes(manifestPath);
  if (sha256(manifestBytes) !== expectedManifestFileSha256) {
    throw new ModelCompositionError("installed-manifest-digest-mismatch");
  }
  const manifest = decodeInstalledManifest(asJson(manifestBytes));
  const assetBytes = new Map<string, Uint8Array>();
  for (const record of manifest.assets) {
    if (record.path !== EXPECTED_ASSET_PATHS[record.kind]) {
      throw new ModelCompositionError("installed-manifest-file-set-mismatch");
    }
    const path = resolve(canonicalAssetRoot, record.path);
    requireInside(canonicalAssetRoot, path);
    const bytes = await readBytes(path);
    if (sha256(bytes) !== record.fileSha256) {
      throw new ModelCompositionError("asset-file-digest-mismatch");
    }
    assetBytes.set(record.kind, bytes);
  }

  const assets: DecodedInstalledAssets = {
    manifest,
    adapterRegistry: decodeAdapterRegistry(asJson(assetBytes.get("adapter-registry")!)),
    candidateRegistry: decodeCandidateProjectionRegistry(
      asJson(assetBytes.get("candidate-projections")!),
    ),
    compositionRegistry: decodeCompositionRegistry(asJson(assetBytes.get("composition-registry")!)),
    workflowCatalog: decodeWorkflowCatalog(asJson(assetBytes.get("workflow-catalog")!)),
  };
  for (const record of manifest.assets) {
    if (manifestContractDigest(assets, record.kind) !== record.contractSha256) {
      throw new ModelCompositionError("contract-digest-mismatch");
    }
  }
  validateCrossBindings(assets);
  await validateWorkflowSources(packageRoot, assets.workflowCatalog.workflows);

  const verifier: InstalledAssetVerifier = {
    assets: deepFreeze(assets),
    verifyCurrent: () => true,
  };
  const authority = authorityFactory.create(verifier) as InstalledModelCompositionAuthority;
  const compositionIds = assets.compositionRegistry.compositions
    .map((entry) => entry.compositionId)
    .sort();
  return {
    authority,
    snapshot: deepFreeze({
      installedManifestSha256: manifest.installedManifestSha256,
      compositionIds,
      executableCompositionIds: assets.compositionRegistry.compositions
        .filter((entry) => entry.status === "active" && entry.executionClass === "pi-provider")
        .map((entry) => entry.compositionId)
        .sort(),
      // Like the executable set, a retired preflight record is installed for
      // provenance but is no longer a selectable preflight.
      preflightCompositionIds: assets.compositionRegistry.compositions
        .filter((entry) => entry.status === "active" && entry.executionClass === "preflight-only")
        .map((entry) => entry.compositionId)
        .sort(),
      workflowIds: assets.workflowCatalog.workflows.map((entry) => entry.workflowId).sort(),
    }),
  };
}

export async function loadInstalledModelCompositionAuthority(): Promise<{
  authority: InstalledModelCompositionAuthority;
  snapshot: InstalledModelCompositionSnapshot;
}> {
  const assetRoot = fileURLToPath(new URL("../../model-compositions/", import.meta.url));
  return loadFromTrustedRoot(assetRoot, EXPECTED_INSTALLED_MANIFEST_FILE_SHA256);
}

/**
 * Test seam, absent from the package export surface.
 * `expectedManifestFileSha256` defaults to the compiled trust root's pinned
 * digest; a test that builds its own self-consistent asset tree (recomputed
 * registry and manifest digests throughout) may pass that tree's digest.
 */
export async function loadInstalledModelCompositionAuthorityFromTrustedRootForTest(
  assetRoot: string,
  expectedManifestFileSha256: string = EXPECTED_INSTALLED_MANIFEST_FILE_SHA256,
): Promise<{
  authority: InstalledModelCompositionAuthority;
  snapshot: InstalledModelCompositionSnapshot;
}> {
  return loadFromTrustedRoot(assetRoot, expectedManifestFileSha256);
}

function verifierFor(authority: InstalledModelCompositionAuthority): InstalledAssetVerifier {
  const verifier = authorityFactory.lookup(authority);
  if (!verifier || !verifier.verifyCurrent()) {
    throw new ModelCompositionError("authority-invalid");
  }
  return verifier;
}

function exactDataObject(input: unknown, keys: readonly string[]): Record<string, unknown> {
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    nodeUtilTypes.isProxy(input) ||
    Object.getPrototypeOf(input) !== Object.prototype
  ) {
    throw new ModelCompositionError("contract-invalid-shape");
  }
  const descriptors = Object.getOwnPropertyDescriptors(input);
  const actualKeys = Reflect.ownKeys(descriptors);
  if (
    actualKeys.some((key) => typeof key !== "string") ||
    actualKeys.map(String).sort().join(",") !== [...keys].sort().join(",")
  ) {
    throw new ModelCompositionError("contract-invalid-shape");
  }
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (
      !descriptor ||
      !descriptor.enumerable ||
      descriptor.get !== undefined ||
      descriptor.set !== undefined ||
      !("value" in descriptor)
    ) {
      throw new ModelCompositionError("contract-invalid-shape");
    }
    result[key] = descriptor.value;
  }
  return result;
}

function validateResolveInput(input: unknown): asserts input is {
  readonly authority: InstalledModelCompositionAuthority;
  readonly compositionId: string;
  readonly workflowId: string;
} {
  const values = exactDataObject(input, ["authority", "compositionId", "workflowId"]);
  if (typeof values.compositionId !== "string" || typeof values.workflowId !== "string") {
    throw new ModelCompositionError("contract-invalid-shape");
  }
}

export function listInstalledModelCompositions(
  authority: InstalledModelCompositionAuthority,
): readonly InstalledModelCompositionSummary[] {
  const { assets } = verifierFor(authority);
  return deepFreeze(
    assets.compositionRegistry.compositions
      .map((composition) => ({
        compositionId: composition.compositionId,
        status: composition.status,
        ...(composition.retirement ? { retirement: composition.retirement } : {}),
        executionClass: composition.executionClass,
        modelId: composition.model.resolvedId,
        provider: composition.deployment.provider,
        routeId: composition.deployment.routeId,
        transport: composition.deployment.transport,
        harnessId: composition.harness.id,
        technicalApproval: "not-established" as const,
        releaseEligible: false as const,
      }))
      .sort((left, right) => left.compositionId.localeCompare(right.compositionId)),
  );
}

/**
 * The reasoning control installed compositions measured for `modelId`, with
 * the compositions that measured it. Undefined when no current composition
 * carries a request policy for that model, or when they disagree.
 */
export function measuredReasoningControlForModel(
  authority: InstalledModelCompositionAuthority,
  modelId: string,
): MeasuredReasoningControl | undefined {
  const { assets } = verifierFor(authority);
  const measured = assets.compositionRegistry.compositions.filter(
    (composition) =>
      composition.retirement === undefined &&
      composition.requestPolicy !== undefined &&
      composition.requestPolicy.modelId === modelId,
  );
  const controls = new Set(
    measured.map((composition) => canonicalDigest(composition.requestPolicy!.reasoningControl)),
  );
  if (controls.size !== 1) return undefined;
  return deepFreeze({
    control: measured[0]!.requestPolicy!.reasoningControl,
    compositionIds: measured.map((composition) => composition.compositionId).sort(),
  });
}

/**
 * The answer submission an installed composition recorded for `modelId` on
 * the serving stack at `endpointOrigin`. An unmatched chat-completions
 * endpoint borrows it only when the model ID is exact and the endpoint's
 * origin equals the composition's proven recorded origin: argument fidelity
 * is a property of the serving stack's tool-call parser, so the same model
 * behind another origin stays unrecorded. The profile's reasoning setting
 * plays no part. Undefined when no current composition qualifies, or when the
 * qualifying ones disagree.
 */
export function recordedAnswerSubmissionForModel(
  authority: InstalledModelCompositionAuthority,
  input: {
    readonly modelId: string;
    readonly transport: string;
    readonly endpointOrigin: string;
  },
): InstalledAnswerSubmission | undefined {
  if (input.transport !== "openai-chat-completions") return undefined;
  const { assets } = verifierFor(authority);
  const recorded = assets.compositionRegistry.compositions.filter(
    (composition) =>
      composition.retirement === undefined &&
      composition.answerSubmission !== undefined &&
      composition.model.resolvedId === input.modelId &&
      composition.deployment.transport === "openai-chat-completions" &&
      provenRecordedOrigin(composition) === input.endpointOrigin,
  );
  const capabilities = new Set(
    recorded.map((composition) => canonicalDigest(composition.answerSubmission!)),
  );
  if (capabilities.size !== 1) return undefined;
  return deepFreeze({ ...recorded[0]!.answerSubmission! });
}

export function resolveInstalledComposition(input: {
  readonly authority: InstalledModelCompositionAuthority;
  readonly compositionId: string;
  readonly workflowId: string;
}): BoundInstalledComposition {
  validateResolveInput(input);
  const { assets } = verifierFor(input.authority);
  const compositions = assets.compositionRegistry.compositions.filter(
    (entry) => entry.compositionId === input.compositionId,
  );
  if (compositions.length !== 1) throw new ModelCompositionError("unknown-composition");
  const workflows = assets.workflowCatalog.workflows.filter(
    (entry) => entry.workflowId === input.workflowId,
  );
  if (workflows.length !== 1) throw new ModelCompositionError("unknown-workflow");
  const composition = compositions[0]!;
  const candidates = assets.candidateRegistry.candidates.filter(
    (entry) => entry.compositionId === composition.compositionId,
  );
  if (candidates.length !== 1) throw new ModelCompositionError("candidate-binding-mismatch");

  const routeEvidence = findAdapter(
    assets.adapterRegistry.adapters,
    "route-evidence",
    composition.adapters.routeEvidence,
  );
  const authentication = findAdapter(
    assets.adapterRegistry.adapters,
    "authentication",
    composition.adapters.authentication,
  );
  const providerConnection = findAdapter(
    assets.adapterRegistry.adapters,
    "provider-connection",
    composition.adapters.providerConnection,
  );
  const harness = findAdapter(
    assets.adapterRegistry.adapters,
    "harness",
    composition.adapters.harness,
  );
  if (
    routeEvidence.kind !== "route-evidence" ||
    authentication.kind !== "authentication" ||
    providerConnection.kind !== "provider-connection" ||
    harness.kind !== "harness"
  ) {
    throw new ModelCompositionError("adapter-binding-mismatch");
  }
  return deepFreeze({
    installedManifestSha256: assets.manifest.installedManifestSha256,
    compositionCeiling: assets.manifest.compositionCeiling,
    compositionCeilingSha256: assets.manifest.compositionCeilingSha256,
    composition,
    candidate: candidates[0]!,
    adapters: { routeEvidence, authentication, providerConnection, harness },
    workflow: workflows[0]!,
    technicalApproval: "not-established",
    releaseEligible: false,
  });
}

function providerRequestPath(
  transport: "openai-chat-completions" | "openai-responses" | "anthropic-messages",
): string {
  if (transport === "openai-chat-completions") return "/chat/completions";
  if (transport === "openai-responses") return "/responses";
  return "/messages";
}

function deploymentIdentityDigest(origin: string, route: string, provider: string): string {
  return canonicalDigest({ schemaVersion: 1, origin, route, provider });
}

/**
 * The deployment identity of an endpoint a preset runs against: the digest a
 * composition records, computed for any admitted base URL and transport.
 */
export function deploymentIdentityForEndpoint(input: {
  readonly baseUrl: string;
  readonly transport: "openai-chat-completions" | "openai-responses" | "anthropic-messages";
  readonly provider: string;
}): string {
  const parsed = new URL(input.baseUrl);
  const basePath = parsed.pathname.replace(/\/+$/u, "");
  return deploymentIdentityDigest(
    parsed.origin,
    `${basePath}${providerRequestPath(input.transport)}`,
    input.provider,
  );
}

/**
 * `EXECUTABLE_ROUTE_BASE_URLS` names the origin DocsFab currently installs for
 * a routeId. That is not proof of the origin a composition's `identitySha256`
 * was sealed over: an accepted external or historical composition can carry a
 * known routeId with a different sealed origin.
 *
 * Returns the candidate origin only when its canonical identity, recomputed
 * with the provider and request-route semantics `identitySha256` was sealed
 * with, equals the recorded digest. Otherwise the caller keeps the generic
 * refusal.
 */
function provenRecordedOrigin(composition: InstalledExecutionComposition): string | undefined {
  const routeId = composition.deployment.routeId;
  if (!Object.prototype.hasOwnProperty.call(EXECUTABLE_ROUTE_BASE_URLS, routeId)) return undefined;
  if (composition.deployment.transport === "opaque-cli-managed") return undefined;
  const baseUrl = EXECUTABLE_ROUTE_BASE_URLS[routeId as ExecutableRouteId];
  if (baseUrl === undefined) return undefined;
  const mapped = new URL(baseUrl);
  const mappedBasePath = mapped.pathname.replace(/\/+$/u, "");
  const mappedRequestPath = `${mappedBasePath}${providerRequestPath(composition.deployment.transport)}`;
  const mappedIdentitySha256 = deploymentIdentityDigest(
    mapped.origin,
    mappedRequestPath,
    composition.deployment.provider,
  );
  return mappedIdentitySha256 === composition.deployment.identitySha256 ? mapped.origin : undefined;
}

export function assertInstalledDeploymentBaseUrl(input: {
  readonly authority: InstalledModelCompositionAuthority;
  readonly compositionId: string;
  readonly baseUrl: string;
}): VerifiedInstalledDeploymentBinding {
  const values = exactDataObject(input, ["authority", "compositionId", "baseUrl"]);
  if (typeof values.compositionId !== "string" || typeof values.baseUrl !== "string") {
    throw new ModelCompositionError("contract-invalid-shape");
  }
  const { assets } = verifierFor(input.authority);
  const compositions = assets.compositionRegistry.compositions.filter(
    (entry) => entry.compositionId === input.compositionId,
  );
  if (compositions.length !== 1) throw new ModelCompositionError("unknown-composition");
  const composition = compositions[0]!;
  if (
    composition.executionClass !== "pi-provider" ||
    composition.deployment.transport === "opaque-cli-managed"
  ) {
    throw new ModelCompositionError("composition-not-executable");
  }

  let parsed: URL;
  try {
    parsed = new URL(input.baseUrl);
  } catch {
    throw new ModelCompositionError(
      "deployment-binding-mismatch",
      "The configured MODEL_BASE_URL could not be parsed as a URL.",
      "Set MODEL_BASE_URL to the composition's exact absolute HTTPS URL (see `docsfab composition list`), then retry.",
    );
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.search !== "" ||
    parsed.hash !== ""
  ) {
    throw new ModelCompositionError(
      "deployment-binding-mismatch",
      "The configured MODEL_BASE_URL is not an allowed deployment shape: it must be a plain HTTPS URL with no embedded username, password, query string, or fragment.",
      "Remove credentials, query parameters, and fragments from MODEL_BASE_URL and use a plain HTTPS origin and path, then retry.",
    );
  }
  const basePath = parsed.pathname.replace(/\/+$/u, "");
  const requestPath = `${basePath}${providerRequestPath(composition.deployment.transport)}`;
  const normalizedBaseUrl = `${parsed.origin}${basePath}`;
  const identitySha256 = deploymentIdentityDigest(
    parsed.origin,
    requestPath,
    composition.deployment.provider,
  );
  if (identitySha256 !== composition.deployment.identitySha256) {
    // The identity is a digest, not a reversible origin. Name a candidate
    // origin only once `provenRecordedOrigin` proves it; unproven, the refusal
    // stays generic.
    const recordedOrigin = provenRecordedOrigin(composition);
    throw new ModelCompositionError(
      "deployment-binding-mismatch",
      recordedOrigin
        ? `The configured MODEL_BASE_URL does not match the deployment identity DocsFab recorded for composition "${composition.compositionId}"; DocsFab recorded the origin "${recordedOrigin}" for this composition, and the configured URL resolves to a different origin.`
        : `The configured MODEL_BASE_URL does not match the deployment identity DocsFab recorded for composition "${composition.compositionId}".`,
      "Set MODEL_BASE_URL to the exact origin and path this composition installs (see `docsfab composition list`); a different provider's URL will not bind, even if it is otherwise a valid HTTPS URL.",
    );
  }
  return deepFreeze({
    compositionId: composition.compositionId,
    normalizedBaseUrl,
    requestPath,
    deploymentIdentitySha256: identitySha256,
  });
}

/** The endpoint a preset runs against, and whether it is the preset's own deployment. */
export interface InstalledDeploymentEndpoint extends VerifiedInstalledDeploymentBinding {
  /** True when the endpoint is the deployment identity the preset recorded. */
  readonly presetDeployment: boolean;
}

/**
 * Bind a preset to the endpoint the operator configured. Any HTTPS endpoint,
 * or plain HTTP to this machine, runs: a different one than the preset
 * recorded is an override the caller records, never a refusal. A URL that
 * cannot be parsed, carries a user name, password, query, or fragment, or uses
 * plain HTTP to another host still refuses.
 */
export function resolveInstalledDeploymentEndpoint(input: {
  readonly authority: InstalledModelCompositionAuthority;
  readonly compositionId: string;
  readonly baseUrl: string;
  /** The transport the run uses; defaults to the preset's. */
  readonly transport?: "openai-chat-completions" | "openai-responses" | "anthropic-messages";
}): InstalledDeploymentEndpoint {
  const { assets } = verifierFor(input.authority);
  const compositions = assets.compositionRegistry.compositions.filter(
    (entry) => entry.compositionId === input.compositionId,
  );
  if (compositions.length !== 1) {
    // hygiene: ok -- stable typed code; callers bind the composition before this, so it is defensive.
    throw new ModelCompositionError("unknown-composition");
  }
  const composition = compositions[0]!;
  if (
    composition.executionClass !== "pi-provider" ||
    composition.deployment.transport === "opaque-cli-managed"
  ) {
    // hygiene: ok -- stable typed code; callers bind the composition before this, so it is defensive.
    throw new ModelCompositionError("composition-not-executable");
  }
  let parsed: URL;
  try {
    parsed = new URL(input.baseUrl);
  } catch {
    // hygiene: ok -- the typed code accompanies a complete message and next action.
    throw new ModelCompositionError(
      "deployment-binding-mismatch",
      "The configured MODEL_BASE_URL could not be parsed as a URL.",
      "Set MODEL_BASE_URL, or the baseUrl setting, to an absolute HTTPS URL, then retry.",
    );
  }
  assertModelEndpointTransport(parsed, "MODEL_BASE_URL");
  if (
    !isAdmittedModelEndpoint(parsed) ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.search !== "" ||
    parsed.hash !== ""
  ) {
    // hygiene: ok -- the typed code accompanies a complete message and next action.
    throw new ModelCompositionError(
      "deployment-binding-mismatch",
      "The configured MODEL_BASE_URL is not an allowed endpoint shape: it must be a plain HTTPS URL, or plain HTTP to this machine, with no embedded username, password, query string, or fragment.",
      "Remove credentials, query parameters, and fragments from MODEL_BASE_URL or the baseUrl setting, then retry.",
    );
  }
  const transport = input.transport ?? composition.deployment.transport;
  const basePath = parsed.pathname.replace(/\/+$/u, "");
  const requestPath = `${basePath}${providerRequestPath(transport)}`;
  const identitySha256 = deploymentIdentityDigest(
    parsed.origin,
    requestPath,
    composition.deployment.provider,
  );
  return deepFreeze({
    compositionId: composition.compositionId,
    normalizedBaseUrl: `${parsed.origin}${basePath}`,
    requestPath,
    deploymentIdentitySha256: identitySha256,
    presetDeployment: identitySha256 === composition.deployment.identitySha256,
  });
}

export function resolveInstalledExecutableComposition(input: {
  readonly authority: InstalledModelCompositionAuthority;
  readonly compositionId: string;
  readonly workflowId: string;
}): BoundExecutableComposition {
  const bound = resolveInstalledComposition(input);
  assertCompositionNotRetired(bound.composition);
  if (bound.composition.status !== "active") {
    throw new ModelCompositionError("composition-not-active");
  }
  if (
    bound.composition.executionClass !== "pi-provider" ||
    bound.composition.deployment.transport === "opaque-cli-managed" ||
    bound.composition.deployment.bindingKind !== "exact-origin" ||
    bound.adapters.providerConnection.executionClass !== "pi-provider" ||
    bound.adapters.providerConnection.status !== "implemented" ||
    bound.adapters.harness.executionClass !== "pi-provider" ||
    bound.adapters.harness.status !== "implemented"
  ) {
    throw new ModelCompositionError("composition-not-executable");
  }
  return bound as BoundExecutableComposition;
}
