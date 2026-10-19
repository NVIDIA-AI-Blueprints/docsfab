// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Publication provenance projectors: a thin composition seam over the existing
 * lineage and inputs content-minimized projectors. It adds no provenance
 * dialect and renders no commit/MR narrative prose.
 */

import { createContractKit, type ContractFail } from "../contract-kit/index.js";
import {
  createHistoricalEmptyExternalInputManifest,
  projectExternalInputManifest,
  type ExternalInputManifestProjectionV1,
} from "../inputs/contracts.js";
import {
  projectExternalInputDisclosure,
  type ExternalInputDisclosureProjectionV1,
  type ExternalInputDisclosureSurface,
  type ExternalInputDisclosureLevel,
} from "../inputs/disclosure.js";
import {
  assertTaskLineageProjection,
  projectTaskLineage as projectTaskLineageWithWorkflowAccess,
  type TaskLineageProjectionV1,
} from "../lineage/contracts.js";
import * as workflowCatalog from "../workflow-registry/catalog.js";

export type PublicationProvenanceProjectorErrorCode =
  | "invalid-shape"
  | "invalid-value"
  | "digest-mismatch"
  | "credential-material"
  | "migration-required";

export class PublicationProvenanceProjectorError extends Error {
  public constructor(public readonly code: PublicationProvenanceProjectorErrorCode) {
    super(`Publication provenance projector rejected: ${code}.`);
    this.name = "PublicationProvenanceProjectorError";
  }
}

function fail(code: PublicationProvenanceProjectorErrorCode): never {
  throw new PublicationProvenanceProjectorError(code);
}

const { assertInert, rejectCredentials, seal, canonicalJson, compare } = createContractKit({
  fail: fail as ContractFail<PublicationProvenanceProjectorErrorCode>,
  codes: {
    invalidShape: "invalid-shape",
    invalidValue: "invalid-value",
    digestMismatch: "digest-mismatch",
    credentialMaterial: "credential-material",
    schemaMismatch: "migration-required",
  },
});

/**
 * Bundled, content-minimized provenance inputs for publication. Fields are the
 * existing lineage and inputs projections only.
 */
export interface PublicationProvenanceInputsV1 {
  schemaVersion: 1;
  kind: "docsfab-publication-provenance-inputs";
  lineage: TaskLineageProjectionV1;
  inputs: ExternalInputManifestProjectionV1;
  /** Canonical digest over lineage + inputs projection digests only. */
  provenanceInputsSha256: string;
}

/** Published compatibility facade over the dependency-injected lineage contract. */
export function projectTaskLineage(
  originValue: unknown,
  lineageValue: unknown,
): TaskLineageProjectionV1 {
  return projectTaskLineageWithWorkflowAccess(originValue, lineageValue, workflowCatalog);
}

/**
 * Documented import surface for publication implementers. Use it with the
 * `docsfab/lineage` and `docsfab/inputs` projectors; do not invent a parallel
 * provenance dialect in delivery.
 */
export const PUBLICATION_PROVENANCE_PROJECTOR_SURFACE = Object.freeze({
  schemaVersion: 1 as const,
  kind: "docsfab-publication-provenance-projector-surface" as const,
  packageExports: Object.freeze(["docsfab/publication", "docsfab/lineage", "docsfab/inputs"]),
  projectors: Object.freeze([
    "projectPublicationProvenanceInputs",
    "projectTaskLineage",
    "projectExternalInputManifest",
    "projectExternalInputDisclosure",
  ]),
  /** Validated evidence projection that commit and MR narratives render from. */
  evidenceProjectors: Object.freeze([
    "projectPublicationEvidence",
    "projectPublicationEvidenceFromInputs",
    "projectPublicationEvidenceFromRunLineage",
    "assertPublicationEvidenceProjection",
  ]),
  disclosureSurfaces: Object.freeze([
    "commit-message",
    "mr-description",
  ] as const satisfies readonly ExternalInputDisclosureSurface[]),
  nonGoals: Object.freeze([
    "commit-message-narrative-rendering",
    "merge-request-narrative-rendering",
    "third-provenance-dialect",
  ]),
});

/**
 * Project authenticated lineage and external-input evidence into publication
 * provenance inputs.
 *
 * Callers pass decoded or authenticated artifacts; this function re-decodes
 * through the domain projectors and never retains private bodies, titles,
 * approvals, recommendations, raw locators, or credentials.
 */
export function projectPublicationProvenanceInputs(input: {
  origin: unknown;
  lineage: unknown;
  manifest: unknown;
}): PublicationProvenanceInputsV1 {
  assertInert(input);
  rejectCredentials(input);
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    fail("invalid-shape");
  }
  const root = input as Record<string, unknown>;
  for (const key of Object.keys(root)) {
    if (key !== "origin" && key !== "lineage" && key !== "manifest") {
      fail("invalid-shape");
    }
  }
  if (!("origin" in root) || !("lineage" in root) || !("manifest" in root)) {
    fail("invalid-shape");
  }
  const lineage = projectTaskLineage(root.origin, root.lineage);
  const inputs = projectExternalInputManifest(root.manifest);
  return seal("docsfab-publication-provenance-inputs", "provenanceInputsSha256", {
    lineage,
    inputs,
  });
}

/**
 * Verify a sealed provenance-inputs bundle and return its digest for
 * idempotency / recovery bindings. Does not decode private artifacts.
 */
export function assertPublicationProvenanceInputs(value: unknown): PublicationProvenanceInputsV1 {
  assertInert(value);
  rejectCredentials(value);
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail("invalid-shape");
  }
  const root = value as PublicationProvenanceInputsV1;
  if (root.schemaVersion !== 1 || root.kind !== "docsfab-publication-provenance-inputs") {
    fail("migration-required");
  }
  if (
    typeof root.lineage?.projectionSha256 !== "string" ||
    typeof root.inputs?.projectionSha256 !== "string" ||
    typeof root.provenanceInputsSha256 !== "string"
  ) {
    fail("invalid-shape");
  }
  const resealed = seal("docsfab-publication-provenance-inputs", "provenanceInputsSha256", {
    lineage: root.lineage,
    inputs: root.inputs,
  });
  if (canonicalJson(root) !== canonicalJson(resealed)) fail("digest-mismatch");
  return resealed;
}

/**
 * Bounded, validated publication evidence projection: the content-minimized,
 * credential-free evidence that commit and merge-request rendering consumes.
 * It derives only from the authenticated lineage projection and the
 * authenticated external-input manifest projection, never accepts free-form
 * provenance, and renders no prose. Every field is an enum code or digest with
 * an explicit disclosure meaning, so a narrative can be reconstructed without
 * quoting private request text, titles, approvals, recommendations, raw
 * locators, or credentials.
 */
export const PUBLICATION_EVIDENCE_SCHEMA_VERSION = 1 as const;

/** Bounded input-use count. Extra inputs are truncated and flagged, never dropped silently. */
export const MAX_PUBLICATION_INPUT_USES = 64;

/**
 * Closed limitation vocabulary. Codes name what could not be verified or
 * disclosed so narratives state limitations without inferring unavailable
 * provenance.
 */
export const PUBLICATION_LIMITATION_CODES = Object.freeze([
  "advisory-model-influence",
  "historical-provenance-unavailable",
  "input-changed-after-use",
  "input-count-truncated",
  "input-excluded",
  "input-inaccessible",
  "input-revoked",
  "no-external-inputs",
  "restricted-disclosure-present",
  "unauthenticated-lineage",
] as const);
export type PublicationLimitationCode = (typeof PUBLICATION_LIMITATION_CODES)[number];

type PublicationInputProjectionEntry = ExternalInputManifestProjectionV1["entries"][number];

export interface PublicationInputUseV1 {
  inputIdSha256: string;
  sourceKind: PublicationInputProjectionEntry["sourceKind"];
  permissionClass: PublicationInputProjectionEntry["permissionClass"];
  visibility: PublicationInputProjectionEntry["visibility"];
  disclosurePolicy: PublicationInputProjectionEntry["disclosurePolicy"];
  intendedRoles: PublicationInputProjectionEntry["intendedRoles"];
  lifecycleState: PublicationInputProjectionEntry["lifecycleState"];
  contentDigestPresent: boolean;
  entrySha256: string;
}

export type PublicationResponsibilityV1 = TaskLineageProjectionV1["decisionResponsibility"][number];

export interface PublicationEvidenceProjectionV1 {
  schemaVersion: 1;
  kind: "docsfab-publication-evidence-projection";
  /** Task origin class distinguishing directed, recommended, autonomous, historical. */
  taskOrigin: TaskLineageProjectionV1["origin"];
  authorityStatus: TaskLineageProjectionV1["authorityStatus"];
  /** True only when host-authenticated non-historical lineage backs the narrative. */
  provenanceAvailable: boolean;
  requestKind: TaskLineageProjectionV1["requestKind"];
  requestPresent: boolean;
  selectedWorkflow: TaskLineageProjectionV1["selectedWorkflow"];
  selectedCandidateSha256: TaskLineageProjectionV1["selectedCandidateSha256"];
  responsibilities: PublicationResponsibilityV1[];
  inputUses: PublicationInputUseV1[];
  /** Total authenticated inputs before truncation to the bounded ceiling. */
  inputUseCount: number;
  inputUsesTruncated: boolean;
  /** Distinct, sorted disclosure ceilings present across the projected inputs. */
  disclosurePolicies: PublicationInputProjectionEntry["disclosurePolicy"][];
  limitations: PublicationLimitationCode[];
  repositoryIdentitySha256: string;
  repositoryRevision: string;
  lineageProjectionSha256: string;
  inputsManifestProjectionSha256: string;
  provenanceInputsSha256: string;
  evidenceProjectionSha256: string;
}

/**
 * Project a validated publication evidence summary from raw authenticated
 * artifacts. Inputs are re-decoded through the domain projectors, so tampered,
 * unauthenticated, or free-form provenance is rejected before any summary
 * exists. Historical or absent lineage yields an honest bounded fallback (no
 * inferred origin), never a fabricated provenance narrative.
 */
export function projectPublicationEvidence(input: {
  origin: unknown;
  lineage: unknown;
  manifest: unknown;
}): PublicationEvidenceProjectionV1 {
  return evidenceFromBundle(projectPublicationProvenanceInputs(input));
}

/** Project the evidence summary from an already-sealed provenance-inputs bundle. */
export function projectPublicationEvidenceFromInputs(
  value: unknown,
): PublicationEvidenceProjectionV1 {
  return evidenceFromBundle(assertPublicationProvenanceInputs(value));
}

/**
 * Project the evidence summary from the content-minimized task-lineage
 * projection on a run record. A completed `docsfab auto --publish` cycle
 * carries that sealed projection rather than re-minting lineage artifacts, so
 * the narrative uses it plus an explicit empty external-input manifest. The run
 * record captures no external inputs, so the projection reports
 * `no-external-inputs` rather than inferring input use.
 */
export function projectPublicationEvidenceFromRunLineage(
  lineageProjection: unknown,
): PublicationEvidenceProjectionV1 {
  const lineage = assertTaskLineageProjection(lineageProjection);
  const inputs = projectExternalInputManifest(
    createHistoricalEmptyExternalInputManifest({
      // The empty manifest's run binding is not read by the evidence summary; it
      // is bound to the same repository the lineage projection already attests.
      runIdSha256: lineage.lineageIdSha256,
      repository: {
        identitySha256: lineage.repositoryIdentitySha256,
        revision: lineage.repositoryRevision,
      },
    }),
  );
  const bundle: PublicationProvenanceInputsV1 = seal(
    "docsfab-publication-provenance-inputs",
    "provenanceInputsSha256",
    { lineage, inputs },
  );
  return evidenceFromBundle(bundle);
}

function evidenceFromBundle(
  bundle: PublicationProvenanceInputsV1,
): PublicationEvidenceProjectionV1 {
  const lineage = bundle.lineage;
  const inputs = bundle.inputs;
  const entries = inputs.entries;
  const inputUsesTruncated = entries.length > MAX_PUBLICATION_INPUT_USES;
  const kept = entries.slice(0, MAX_PUBLICATION_INPUT_USES);
  const inputUses: PublicationInputUseV1[] = kept.map((entry) => ({
    inputIdSha256: entry.inputIdSha256,
    sourceKind: entry.sourceKind,
    permissionClass: entry.permissionClass,
    visibility: entry.visibility,
    disclosurePolicy: entry.disclosurePolicy,
    intendedRoles: [...entry.intendedRoles],
    lifecycleState: entry.lifecycleState,
    contentDigestPresent: entry.contentDigestPresent,
    entrySha256: entry.entrySha256,
  }));
  const responsibilities: PublicationResponsibilityV1[] = [...lineage.decisionResponsibility]
    .map((entry) => ({ ...entry }))
    .sort(
      (left, right) =>
        compare(left.domain, right.domain) ||
        compare(left.actor, right.actor) ||
        compare(left.decisionSha256, right.decisionSha256),
    );
  const disclosurePolicies = [...new Set(entries.map((entry) => entry.disclosurePolicy))].sort(
    compare,
  );
  const provenanceAvailable =
    lineage.authorityStatus === "host-authenticated" && lineage.origin !== "historical-unknown";
  const limitations = deriveLimitations({
    lineage,
    entries,
    responsibilities,
    inputUsesTruncated,
    provenanceAvailable,
  });
  return seal("docsfab-publication-evidence-projection", "evidenceProjectionSha256", {
    taskOrigin: lineage.origin,
    authorityStatus: lineage.authorityStatus,
    provenanceAvailable,
    requestKind: lineage.requestKind,
    requestPresent: lineage.requestSha256 !== null,
    selectedWorkflow: lineage.selectedWorkflow,
    selectedCandidateSha256: lineage.selectedCandidateSha256,
    responsibilities,
    inputUses,
    inputUseCount: entries.length,
    inputUsesTruncated,
    disclosurePolicies,
    limitations,
    repositoryIdentitySha256: lineage.repositoryIdentitySha256,
    repositoryRevision: lineage.repositoryRevision,
    lineageProjectionSha256: lineage.projectionSha256,
    inputsManifestProjectionSha256: inputs.projectionSha256,
    provenanceInputsSha256: bundle.provenanceInputsSha256,
  });
}

function deriveLimitations(context: {
  lineage: TaskLineageProjectionV1;
  entries: readonly PublicationInputProjectionEntry[];
  responsibilities: readonly PublicationResponsibilityV1[];
  inputUsesTruncated: boolean;
  provenanceAvailable: boolean;
}): PublicationLimitationCode[] {
  const found = new Set<PublicationLimitationCode>();
  if (context.lineage.origin === "historical-unknown") {
    found.add("historical-provenance-unavailable");
  }
  if (context.lineage.authorityStatus !== "host-authenticated") {
    found.add("unauthenticated-lineage");
  }
  if (context.entries.length === 0) found.add("no-external-inputs");
  for (const entry of context.entries) {
    if (entry.permissionClass === "inaccessible" || entry.lifecycleState === "inaccessible") {
      found.add("input-inaccessible");
    }
    if (entry.lifecycleState === "changed") found.add("input-changed-after-use");
    if (entry.lifecycleState === "revoked") found.add("input-revoked");
    if (entry.lifecycleState === "excluded") found.add("input-excluded");
    if (
      entry.disclosurePolicy === "redacted" ||
      entry.disclosurePolicy === "forbidden" ||
      entry.visibility === "restricted" ||
      entry.visibility === "private"
    ) {
      found.add("restricted-disclosure-present");
    }
  }
  if (
    context.responsibilities.some((entry) => entry.actor === "model" || entry.effect === "advisory")
  ) {
    found.add("advisory-model-influence");
  }
  if (context.inputUsesTruncated) found.add("input-count-truncated");
  return PUBLICATION_LIMITATION_CODES.filter((code) => found.has(code));
}

/**
 * Verify a sealed publication evidence projection and return it for idempotency
 * and recovery bindings. Rejects free-form, tampered, or independently authored
 * provenance: only a byte-identical re-seal of the projected body is accepted.
 */
export function assertPublicationEvidenceProjection(
  value: unknown,
): PublicationEvidenceProjectionV1 {
  assertInert(value);
  rejectCredentials(value);
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail("invalid-shape");
  }
  const root = value as PublicationEvidenceProjectionV1;
  if (root.schemaVersion !== 1 || root.kind !== "docsfab-publication-evidence-projection") {
    fail("migration-required");
  }
  if (
    typeof root.evidenceProjectionSha256 !== "string" ||
    typeof root.provenanceInputsSha256 !== "string" ||
    typeof root.lineageProjectionSha256 !== "string" ||
    typeof root.inputsManifestProjectionSha256 !== "string" ||
    !Array.isArray(root.responsibilities) ||
    !Array.isArray(root.inputUses) ||
    !Array.isArray(root.limitations)
  ) {
    fail("invalid-shape");
  }
  const {
    schemaVersion: _schemaVersion,
    kind: _kind,
    evidenceProjectionSha256: _digest,
    ...body
  } = root;
  const resealed = seal(
    "docsfab-publication-evidence-projection",
    "evidenceProjectionSha256",
    body,
  );
  if (canonicalJson(root) !== canonicalJson(resealed)) fail("digest-mismatch");
  return resealed;
}

/**
 * Guard a resumed, retried, or adopted publication: the previously recorded and
 * freshly derived evidence projections must be byte-identical. Any drift in task
 * origin, inputs, validation authority, or limitations is rejected.
 */
export function assertPublicationEvidenceResumeEquivalent(
  previous: PublicationEvidenceProjectionV1 | undefined,
  next: PublicationEvidenceProjectionV1 | undefined,
): void {
  if (previous === undefined && next === undefined) return;
  if (previous === undefined || next === undefined) fail("digest-mismatch");
  if (previous.evidenceProjectionSha256 !== next.evidenceProjectionSha256) {
    fail("digest-mismatch");
  }
  if (canonicalJson(previous) !== canonicalJson(next)) fail("digest-mismatch");
}

/** Re-exported domain projectors give publication one import path without copying projection logic. */
export type { TaskLineageProjectionV1 } from "../lineage/contracts.js";
export {
  projectExternalInputManifest,
  type ExternalInputManifestProjectionV1,
} from "../inputs/contracts.js";
export {
  projectExternalInputDisclosure,
  type ExternalInputDisclosureProjectionV1,
  type ExternalInputDisclosureSurface,
  type ExternalInputDisclosureLevel,
} from "../inputs/disclosure.js";

/** Publication surfaces that may request per-input disclosure projections. */
export const PUBLICATION_DISCLOSURE_SURFACES = Object.freeze([
  "commit-message",
  "mr-description",
] as const satisfies readonly ExternalInputDisclosureSurface[]);

export type PublicationDisclosureSurface = (typeof PUBLICATION_DISCLOSURE_SURFACES)[number];

/**
 * Narrow helper: project one input for a publication disclosure surface.
 * Policy/surface/visibility ceilings remain those of the inputs package.
 */
export function projectPublicationInputDisclosure(
  ...args: Parameters<typeof projectExternalInputDisclosure>
): ExternalInputDisclosureProjectionV1 {
  const [, input] = args;
  if (input.surface !== "commit-message" && input.surface !== "mr-description") {
    fail("invalid-value");
  }
  return projectExternalInputDisclosure(...args);
}
