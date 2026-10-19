// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { AsyncLocalStorage } from "node:async_hooks";

import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

import {
  FoundationCanonContractError,
  FoundationCanonInvalidationError,
  FoundationCanonProjectionError,
  FoundationCanonQueryError,
  assertFoundationCanonCurrent,
  createFoundationCanon,
  createFoundationCanonClaim,
  decodeFoundationCanon,
  projectFoundationCanonSurfaces,
  queryFoundationCanonAffectedDocuments,
  queryFoundationCanonClaims,
  queryFoundationCanonConflicts,
  queryFoundationCanonGaps,
  type FoundationCanonBodyV1,
  type FoundationCanonClaimV1,
  type FoundationCanonEvidenceSnapshotV1,
  type FoundationCanonV1,
} from "../canon/index.js";
import type { ToolFailureCategory } from "../records/contracts.js";
import { isRecord } from "../shared/primitives.js";

/** Host-granted read-only canon / structured-artifact tool ids. */
export const CANON_TOOL_NAMES = [
  "canon_query",
  "canon_conflict_gap",
  "canon_affected_docs",
  "canon_validate_citations",
  "canon_propose_claim",
  "canon_submit_artifact",
] as const;

export type CanonToolName = (typeof CANON_TOOL_NAMES)[number];

/** Payload ceiling; oversized inputs fail closed. */
export const CANON_TOOL_MAX_JSON_BYTES = 256 * 1024;

const CANON_JSON = {
  type: "string" as const,
  description: "JSON string of a sealed FoundationCanonV1. Not an object.",
};
const EVIDENCE_JSON = {
  type: "string" as const,
  description: "Optional JSON string of FoundationCanonEvidenceSnapshotV1.",
};

/** Model-facing canon tool schema copy: short contracts, no JSON repair turn. */
export const CANON_TOOL_SCHEMA_COPY = Object.freeze({
  canon_query: {
    description: "Query sealed FoundationCanonV1 claims. Closed string filters only.",
    promptSnippet: "Query foundation-canon claims by closed filters",
    parameters: {
      type: "object" as const,
      additionalProperties: false,
      required: ["canonJson"],
      properties: {
        canonJson: CANON_JSON,
        verificationStatus: {
          type: "string" as const,
          description: "unverified | verified | accepted-assumption",
        },
        conflictGroupId: {
          type: "string" as const,
          description: "conflictGroupId; empty string for null",
        },
        applicabilitySha256: { type: "string" as const, description: "Applicability digest" },
        evidenceSnapshotJson: EVIDENCE_JSON,
      },
    },
  },
  canon_conflict_gap: {
    description: "Report sealed-canon conflicts and gaps.",
    promptSnippet: "Report foundation-canon conflicts and gaps",
    parameters: {
      type: "object" as const,
      additionalProperties: false,
      required: ["canonJson"],
      properties: {
        canonJson: CANON_JSON,
        evidenceSnapshotJson: EVIDENCE_JSON,
      },
    },
  },
  canon_affected_docs: {
    description: "List sealed-canon affected-document index entries.",
    promptSnippet: "Look up foundation-canon affected documents",
    parameters: {
      type: "object" as const,
      additionalProperties: false,
      required: ["canonJson"],
      properties: {
        canonJson: CANON_JSON,
        evidenceSnapshotJson: EVIDENCE_JSON,
      },
    },
  },
  canon_validate_citations: {
    description: "Validate claim citations inside a sealed canon. Does not grant authority.",
    promptSnippet: "Validate foundation-canon claim citations",
    parameters: {
      type: "object" as const,
      additionalProperties: false,
      required: ["canonJson"],
      properties: {
        canonJson: CANON_JSON,
        claimJson: {
          type: "string" as const,
          description: "Optional JSON string of FoundationCanonClaimV1",
        },
        evidenceSnapshotJson: EVIDENCE_JSON,
      },
    },
  },
  canon_propose_claim: {
    description: "Seal a FoundationCanonClaimV1 proposal from closed hash fields. No authority.",
    promptSnippet: "Propose a sealed foundation-canon claim",
    parameters: {
      type: "object" as const,
      additionalProperties: false,
      required: [
        "id",
        "subjectSha256",
        "assertionSha256",
        "confidence",
        "verificationStatus",
        "applicabilitySha256",
        "statementSha256",
        "evidenceIdsJson",
        "assumptionIdsJson",
        "dependencyIdsJson",
        "affectedArtifactIdsJson",
      ],
      properties: {
        id: { type: "string" as const },
        subjectSha256: { type: "string" as const },
        assertionSha256: { type: "string" as const },
        confidence: { type: "string" as const, description: "low | medium | high" },
        verificationStatus: {
          type: "string" as const,
          description: "unverified | verified | accepted-assumption",
        },
        applicabilitySha256: { type: "string" as const },
        ownerAuthorityId: {
          type: "string" as const,
          description: "Optional; omit or empty for null",
        },
        statementSha256: { type: "string" as const },
        evidenceIdsJson: { type: "string" as const, description: "JSON array of evidence ids" },
        assumptionIdsJson: { type: "string" as const, description: "JSON array of assumption ids" },
        dependencyIdsJson: { type: "string" as const, description: "JSON array of dependency ids" },
        affectedArtifactIdsJson: {
          type: "string" as const,
          description: "JSON array of affected artifact ids",
        },
        conflictGroupId: {
          type: "string" as const,
          description: "Optional; omit or empty for null",
        },
        supersededByClaimId: {
          type: "string" as const,
          description: "Optional; omit or empty for null",
        },
      },
    },
  },
  canon_submit_artifact: {
    description: "Decode or seal a FoundationCanonV1. Does not persist or publish.",
    promptSnippet: "Submit a sealed foundation-canon structured artifact",
    parameters: {
      type: "object" as const,
      additionalProperties: false,
      required: ["canonJson"],
      properties: {
        canonJson: {
          type: "string" as const,
          description: "JSON string of FoundationCanonV1 or create body",
        },
        evidenceSnapshotJson: EVIDENCE_JSON,
      },
    },
  },
});

type CanonSchemaCopyName = keyof typeof CANON_TOOL_SCHEMA_COPY;

type AnyToolDefinition = ToolDefinition<any, any, any>;

export interface CanonToolOptions {
  recordFailure: (category: ToolFailureCategory) => void;
  /** Host-held canon identity; model-supplied canonJson that disagrees fails closed. */
  boundCanonSha256?: string;
}

const hostBoundCanon = new AsyncLocalStorage<string>();

/** Bind a run pin so confined canon tools reject a different digest. */
export function runWithHostBoundCanon<T>(canonSha256: string, run: () => Promise<T>): Promise<T> {
  return hostBoundCanon.run(canonSha256, run);
}

/**
 * Thin Pi tools over public `src/canon/` APIs. Closed-schema I/O only; never
 * mints acceptance authority, widens filesystem grants, or persists durable
 * artifacts (host owns write / publication).
 */
export function createCanonToolDefinitions(options: CanonToolOptions): AnyToolDefinition[] {
  const wrap = <T extends AnyToolDefinition>(definition: T): T =>
    wrapCanonExecute(definition, options.recordFailure);
  const boundCanonSha256 = options.boundCanonSha256;

  return [
    wrap(canonQueryTool(boundCanonSha256)),
    wrap(canonConflictGapTool(boundCanonSha256)),
    wrap(canonAffectedDocsTool(boundCanonSha256)),
    wrap(canonValidateCitationsTool(boundCanonSha256)),
    wrap(canonProposeClaimTool()),
    wrap(canonSubmitArtifactTool(boundCanonSha256)),
  ];
}

function canonQueryTool(boundCanonSha256?: string): AnyToolDefinition {
  const copy = CANON_TOOL_SCHEMA_COPY.canon_query;
  return {
    name: "canon_query",
    label: "Canon query",
    description: copy.description,
    promptSnippet: copy.promptSnippet,
    parameters: copy.parameters,
    async execute(_id, rawParams) {
      const params = rawParams as Record<string, unknown>;
      const canon = loadCanon(params.canonJson, boundCanonSha256);
      enforceFreshness(canon, params.evidenceSnapshotJson);
      const filter: {
        verificationStatus?: FoundationCanonClaimV1["verificationStatus"];
        conflictGroupId?: string | null;
        applicabilitySha256?: string;
      } = {};
      if (params.verificationStatus !== undefined) {
        filter.verificationStatus = enumeration(params.verificationStatus, [
          "unverified",
          "verified",
          "accepted-assumption",
        ] as const);
      }
      if (params.conflictGroupId !== undefined) {
        filter.conflictGroupId =
          params.conflictGroupId === "" ? null : String(params.conflictGroupId);
      }
      if (params.applicabilitySha256 !== undefined) {
        filter.applicabilitySha256 = String(params.applicabilitySha256);
      }
      const claims = queryFoundationCanonClaims(canon, filter);
      return textResult({
        kind: "docsfab-canon-query-result",
        canonId: canon.canonId,
        version: canon.version,
        canonSha256: canon.canonSha256,
        claimCount: claims.length,
        claims,
      });
    },
  };
}

function canonConflictGapTool(boundCanonSha256?: string): AnyToolDefinition {
  const copy = CANON_TOOL_SCHEMA_COPY.canon_conflict_gap;
  return {
    name: "canon_conflict_gap",
    label: "Canon conflicts and gaps",
    description: copy.description,
    promptSnippet: copy.promptSnippet,
    parameters: copy.parameters,
    async execute(_id, rawParams) {
      const params = rawParams as Record<string, unknown>;
      const canon = loadCanon(params.canonJson, boundCanonSha256);
      enforceFreshness(canon, params.evidenceSnapshotJson);
      return textResult({
        kind: "docsfab-canon-conflict-gap-result",
        canonId: canon.canonId,
        version: canon.version,
        canonSha256: canon.canonSha256,
        conflicts: queryFoundationCanonConflicts(canon),
        gaps: queryFoundationCanonGaps(canon),
      });
    },
  };
}

function canonAffectedDocsTool(boundCanonSha256?: string): AnyToolDefinition {
  const copy = CANON_TOOL_SCHEMA_COPY.canon_affected_docs;
  return {
    name: "canon_affected_docs",
    label: "Canon affected documents",
    description: copy.description,
    promptSnippet: copy.promptSnippet,
    parameters: copy.parameters,
    async execute(_id, rawParams) {
      const params = rawParams as Record<string, unknown>;
      const canon = loadCanon(params.canonJson, boundCanonSha256);
      enforceFreshness(canon, params.evidenceSnapshotJson);
      const documents = queryFoundationCanonAffectedDocuments(canon);
      return textResult({
        kind: "docsfab-canon-affected-docs-result",
        canonId: canon.canonId,
        version: canon.version,
        canonSha256: canon.canonSha256,
        documentCount: documents.length,
        documents,
      });
    },
  };
}

function canonValidateCitationsTool(boundCanonSha256?: string): AnyToolDefinition {
  const copy = CANON_TOOL_SCHEMA_COPY.canon_validate_citations;
  return {
    name: "canon_validate_citations",
    label: "Canon citation validate",
    description: copy.description,
    promptSnippet: copy.promptSnippet,
    parameters: copy.parameters,
    async execute(_id, rawParams) {
      const params = rawParams as Record<string, unknown>;
      const canon = loadCanon(params.canonJson, boundCanonSha256);
      enforceFreshness(canon, params.evidenceSnapshotJson);
      const evidenceIds = new Set(canon.evidence.map((item) => item.id));
      const artifactIds = new Set(canon.affectedArtifacts.map((item) => item.id));
      const claims: FoundationCanonClaimV1[] =
        params.claimJson === undefined ? [...canon.claims] : [decodeClaim(params.claimJson)];
      const failures: Array<{ claimId: string; code: string; ref: string }> = [];
      for (const claim of claims) {
        for (const evidenceId of claim.evidenceIds) {
          if (!evidenceIds.has(evidenceId)) {
            failures.push({
              claimId: claim.id,
              code: "invented-evidence",
              ref: evidenceId,
            });
          }
        }
        for (const artifactId of claim.affectedArtifactIds) {
          if (!artifactIds.has(artifactId)) {
            failures.push({
              claimId: claim.id,
              code: "invented-affected-artifact",
              ref: artifactId,
            });
          }
        }
      }
      return textResult({
        kind: "docsfab-canon-citation-validation-result",
        canonId: canon.canonId,
        version: canon.version,
        canonSha256: canon.canonSha256,
        valid: failures.length === 0,
        failureCount: failures.length,
        failures,
      });
    },
  };
}

function canonProposeClaimTool(): AnyToolDefinition {
  const copy = CANON_TOOL_SCHEMA_COPY.canon_propose_claim;
  return {
    name: "canon_propose_claim",
    label: "Canon propose claim",
    description: copy.description,
    promptSnippet: copy.promptSnippet,
    parameters: copy.parameters,
    async execute(_id, rawParams) {
      const params = rawParams as Record<string, unknown>;
      const claim = createFoundationCanonClaim({
        id: String(params.id),
        subjectSha256: String(params.subjectSha256),
        assertionSha256: String(params.assertionSha256),
        confidence: enumeration(params.confidence, ["low", "medium", "high"] as const),
        verificationStatus: enumeration(params.verificationStatus, [
          "unverified",
          "verified",
          "accepted-assumption",
        ] as const),
        applicabilitySha256: String(params.applicabilitySha256),
        ownerAuthorityId: optionalId(params.ownerAuthorityId),
        statementSha256: String(params.statementSha256),
        evidenceIds: parseIdArray(params.evidenceIdsJson, "evidenceIdsJson"),
        assumptionIds: parseIdArray(params.assumptionIdsJson, "assumptionIdsJson"),
        dependencyIds: parseIdArray(params.dependencyIdsJson, "dependencyIdsJson"),
        affectedArtifactIds: parseIdArray(
          params.affectedArtifactIdsJson,
          "affectedArtifactIdsJson",
        ),
        conflictGroupId: optionalId(params.conflictGroupId),
        supersededByClaimId: optionalId(params.supersededByClaimId),
      });
      return textResult({
        kind: "docsfab-canon-claim-proposal-result",
        claimId: claim.id,
        claimSha256: claim.claimSha256,
        verificationStatus: claim.verificationStatus,
        claim,
      });
    },
  };
}

function canonSubmitArtifactTool(boundCanonSha256?: string): AnyToolDefinition {
  const copy = CANON_TOOL_SCHEMA_COPY.canon_submit_artifact;
  return {
    name: "canon_submit_artifact",
    label: "Canon submit structured artifact",
    description: copy.description,
    promptSnippet: copy.promptSnippet,
    parameters: copy.parameters,
    async execute(_id, rawParams) {
      const params = rawParams as Record<string, unknown>;
      const canon = loadOrCreateCanon(params.canonJson, boundCanonSha256);
      enforceFreshness(canon, params.evidenceSnapshotJson);
      const { machine, report } = projectFoundationCanonSurfaces(canon);
      return textResult({
        kind: "docsfab-canon-submit-artifact-result",
        canonId: canon.canonId,
        version: canon.version,
        state: canon.state,
        canonSha256: canon.canonSha256,
        projectionSha256: machine.projectionSha256,
        reportSha256: report.reportSha256,
        report,
      });
    },
  };
}

function wrapCanonExecute<T extends AnyToolDefinition>(
  definition: T,
  recordFailure: (category: ToolFailureCategory) => void,
): T {
  const execute = definition.execute.bind(definition) as (...arguments_: any[]) => Promise<any>;
  const copy =
    definition.name in CANON_TOOL_SCHEMA_COPY
      ? CANON_TOOL_SCHEMA_COPY[definition.name as CanonSchemaCopyName]
      : undefined;
  return {
    ...definition,
    ...(copy
      ? {
          description: copy.description,
          promptSnippet: copy.promptSnippet,
          parameters: copy.parameters,
        }
      : {}),
    // Malformed args must be a denied call that still preflights, so remaining
    // authorized calls continue. Do not coerce JSON types.
    prepareArguments(raw: unknown) {
      return canonArgumentsAreWellFormed(definition.name, raw)
        ? raw
        : malformedCanonDenySentinel(definition.name);
    },
    async execute(...arguments_: any[]) {
      try {
        if (!canonArgumentsAreWellFormed(definition.name, arguments_[1])) {
          rejectClosedInput();
        }
        return await execute(...arguments_);
      } catch (error) {
        const category = failureCategory(error);
        recordFailure(category);
        throw new Error(safeFailureMessage(category));
      }
    },
  };
}

function canonArgumentsAreWellFormed(name: string, raw: unknown): boolean {
  const copy =
    name in CANON_TOOL_SCHEMA_COPY
      ? CANON_TOOL_SCHEMA_COPY[name as CanonSchemaCopyName]
      : undefined;
  if (!copy || !isRecord(raw)) return false;
  const allowed = Object.keys(copy.parameters.properties);
  if (Object.keys(raw).some((key) => !allowed.includes(key))) return false;
  for (const key of copy.parameters.required) {
    if (typeof raw[key] !== "string") return false;
  }
  for (const key of allowed) {
    if (raw[key] !== undefined && typeof raw[key] !== "string") return false;
  }
  return true;
}

function malformedCanonDenySentinel(name: string): Record<string, unknown> {
  const copy =
    name in CANON_TOOL_SCHEMA_COPY
      ? CANON_TOOL_SCHEMA_COPY[name as CanonSchemaCopyName]
      : undefined;
  const sentinel: Record<string, unknown> = {};
  for (const key of copy?.parameters.required ?? ["canonJson"]) {
    sentinel[key] = "";
  }
  return sentinel;
}

class CanonToolError extends Error {
  public constructor(public readonly category: ToolFailureCategory) {
    // hygiene: ok — public execute() remaps to safeFailureMessage; category is internal.
    super(category);
  }
}

function failureCategory(error: unknown): ToolFailureCategory {
  if (error instanceof CanonToolError) return error.category;
  if (
    error instanceof FoundationCanonContractError ||
    error instanceof FoundationCanonQueryError ||
    error instanceof FoundationCanonProjectionError
  ) {
    return "unsupported-pattern";
  }
  if (error instanceof FoundationCanonInvalidationError) {
    return error.code === "stale-evidence" ? "denied-path" : "unsupported-pattern";
  }
  return "tool-defect";
}

function safeFailureMessage(category: ToolFailureCategory): string {
  switch (category) {
    case "expected-missing-probe":
      return "DocsFab tool target is unavailable.";
    case "denied-path":
      return "DocsFab denied the requested tool path.";
    case "malformed-arguments":
    case "malformed-arguments-corrected":
      // No canon tool records it (canon arguments are decoded, not
      // path-confined); the case keeps the switch exhaustive.
      return "DocsFab could not run the tool: its arguments do not match the tool's declared parameters.";
    case "unsupported-pattern":
      return "DocsFab does not support the requested tool pattern.";
    case "citation-refused":
      // No canon tool refuses a citation; the case exists so the switch stays
      // exhaustive and a future one cannot fall through to a blank message.
      return "DocsFab refused the requested source citation.";
    case "recoverable-miss":
      // No canon tool records it; the case keeps the switch exhaustive.
      return "DocsFab could not run the tool: its target does not match the call. Check the path and text, then call it again.";
    case "tool-defect":
      return "DocsFab tool failed internally.";
  }
}

function loadCanon(raw: unknown, boundCanonSha256?: string): FoundationCanonV1 {
  const canon = decodeFoundationCanon(parseJson(raw, "canonJson"));
  assertHostBoundCanon(canon, boundCanonSha256);
  return canon;
}

function decodeClaim(raw: unknown): FoundationCanonClaimV1 {
  const value = parseJson(raw, "claimJson");
  // Re-seal through the public constructor so digests and closed fields are enforced.
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    rejectClosedInput();
  }
  const record = value as Record<string, unknown>;
  const { claimSha256: _ignored, ...body } = record;
  return createFoundationCanonClaim(body as Omit<FoundationCanonClaimV1, "claimSha256">);
}

function loadOrCreateCanon(raw: unknown, boundCanonSha256?: string): FoundationCanonV1 {
  const value = parseJson(raw, "canonJson");
  if (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    (value as { kind?: unknown }).kind === "docsfab-foundation-canon" &&
    typeof (value as { canonSha256?: unknown }).canonSha256 === "string"
  ) {
    const canon = decodeFoundationCanon(value);
    assertHostBoundCanon(canon, boundCanonSha256);
    return canon;
  }
  const canon = createFoundationCanon(value as FoundationCanonBodyV1);
  assertHostBoundCanon(canon, boundCanonSha256);
  return canon;
}

function assertHostBoundCanon(canon: FoundationCanonV1, boundCanonSha256?: string): void {
  const pin = boundCanonSha256 ?? hostBoundCanon.getStore();
  if (pin !== undefined && canon.canonSha256 !== pin) {
    throw new CanonToolError("denied-path"); // hygiene: ok
  }
}

function enforceFreshness(canon: FoundationCanonV1, evidenceRaw: unknown): void {
  if (evidenceRaw === undefined) return;
  const evidence = parseJson(
    evidenceRaw,
    "evidenceSnapshotJson",
  ) as FoundationCanonEvidenceSnapshotV1;
  assertFoundationCanonCurrent(canon, evidence);
}

function parseJson(raw: unknown, _label: string): unknown {
  if (typeof raw !== "string") rejectClosedInput();
  if (Buffer.byteLength(raw, "utf8") > CANON_TOOL_MAX_JSON_BYTES) {
    rejectClosedInput();
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    rejectClosedInput();
  }
}

function parseIdArray(raw: unknown, label: string): string[] {
  const value = parseJson(raw, label);
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    rejectClosedInput();
  }
  return value as string[];
}

function optionalId(raw: unknown): string | null {
  if (raw === undefined || raw === null || raw === "") return null;
  if (typeof raw !== "string") rejectClosedInput();
  return raw;
}

function enumeration<T extends string>(value: unknown, allowed: readonly T[]): T {
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) {
    rejectClosedInput();
  }
  return value as T;
}

/** Internal closed-schema reject; execute() remaps to the public safe message. */
function rejectClosedInput(): never {
  throw new CanonToolError("unsupported-pattern"); // hygiene: ok
}

function textResult(payload: unknown): {
  content: Array<{ type: "text"; text: string }>;
  details: unknown;
} {
  return {
    content: [{ type: "text", text: JSON.stringify(payload) }],
    details: payload,
  };
}
