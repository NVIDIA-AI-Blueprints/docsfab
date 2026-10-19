// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Load portable skill invocation metadata from a verified catalog crate.
 * Sidecars are ordinary locked files; missing, unknown-version, and tampered
 * bytes fail closed. This is not an evidence seal or a grant.
 */
import { createContractKit, type ContractFail } from "../contract-kit/index.js";
import { parseJsonEvidence } from "../json-evidence.js";
import {
  CatalogSkillCrateError,
  readVerifiedCatalogFile,
  type VerifiedCatalogSkill,
} from "./catalog-crate.js";

export const INVOCATION_METADATA_FILE = "invocation.json" as const;
export const INVOCATION_CONTRACT_SKILL_IDS = [
  "assess-documentation-readiness",
  "audit-documentation",
  "doc-context-analyzer",
  "evaluate-document-quality",
  "lint-documentation",
  "plan-documentation",
  "repo-bootstrap",
  "review-documentation",
  "template-scaffold-site",
  "test-audience-understanding",
  "tpl-design-ia",
  "verify-technical-accuracy",
  "write-documentation",
] as const;

export type InvocationContractSkillId = (typeof INVOCATION_CONTRACT_SKILL_IDS)[number];
export type InvocationOperation =
  | "load-guidance"
  | "load-supporting-reference"
  | "load-reader-assessment-guidance"
  | "execute-workflow-step";
export type InvocationContextPhase = "absent" | "reader-input" | "completed-reader-context";
export type InvocationCallerField = "readerContext" | "readerSources" | "readerComparison";
export type InvocationSchemaReference =
  | "reader-context.schema.json#/$defs/readerContextInputV1"
  | "reader-context.schema.json#/$defs/readerContextV1";
export type InvocationImmediateToolResultKind =
  | "instructions-loaded"
  | "reference-loaded"
  | "instructions-plus-input-projection"
  | "workflow-step-result";
export type InvocationApplicationResultKind =
  | "none"
  | "plan-proposal"
  | "authoring-result"
  | "lint-result"
  | "technical-verification-result"
  | "review-result"
  | "audience-assessment-result"
  | "quality-evaluation-result"
  | "audit-result"
  | "readiness-assessment";
export type InvocationParticipantContext = "not-applicable" | "audience-isolated";
export type InvocationMetadataErrorCode =
  | "missing-file"
  | "unknown-version"
  | "tampered"
  | "invalid-metadata";

const OPERATIONS = [
  "load-guidance",
  "load-supporting-reference",
  "load-reader-assessment-guidance",
  "execute-workflow-step",
] as const satisfies readonly InvocationOperation[];
const CONTEXT_PHASES = [
  "absent",
  "reader-input",
  "completed-reader-context",
] as const satisfies readonly InvocationContextPhase[];
const CALLER_FIELDS = [
  "readerContext",
  "readerSources",
  "readerComparison",
] as const satisfies readonly InvocationCallerField[];
const SCHEMA_REFERENCES = [
  "reader-context.schema.json#/$defs/readerContextInputV1",
  "reader-context.schema.json#/$defs/readerContextV1",
] as const satisfies readonly InvocationSchemaReference[];
const IMMEDIATE_RESULTS = [
  "instructions-loaded",
  "reference-loaded",
  "instructions-plus-input-projection",
  "workflow-step-result",
] as const satisfies readonly InvocationImmediateToolResultKind[];
const APPLICATION_RESULTS = [
  "none",
  "plan-proposal",
  "authoring-result",
  "lint-result",
  "technical-verification-result",
  "review-result",
  "audience-assessment-result",
  "quality-evaluation-result",
  "audit-result",
  "readiness-assessment",
] as const satisfies readonly InvocationApplicationResultKind[];
const PARTICIPANT_CONTEXTS = [
  "not-applicable",
  "audience-isolated",
] as const satisfies readonly InvocationParticipantContext[];
const PROFILE_KEYS = [
  "id",
  "operation",
  "contextPhase",
  "acceptedCallerFields",
  "requiredCallerFields",
  "schemaReferences",
  "immediateToolResultKind",
  "applicationResultKind",
  "participantContext",
] as const;

const ERROR_MESSAGES: Readonly<Record<InvocationMetadataErrorCode, string>> = {
  "missing-file": "Verified catalog skill is missing locked invocation metadata.",
  "unknown-version": "Catalog skill invocation metadata uses an unsupported schema version.",
  tampered: "Catalog skill invocation metadata failed closed integrity verification.",
  "invalid-metadata": "Catalog skill invocation metadata failed closed schema validation.",
};

export class InvocationMetadataError extends Error {
  public readonly code: InvocationMetadataErrorCode;

  public constructor(code: InvocationMetadataErrorCode, message?: string) {
    super(message ?? ERROR_MESSAGES[code]);
    this.name = "InvocationMetadataError";
    this.code = code;
  }
}

export interface SkillInvocationProfile {
  id: string;
  operation: InvocationOperation;
  contextPhase: InvocationContextPhase;
  acceptedCallerFields: readonly InvocationCallerField[];
  requiredCallerFields: readonly InvocationCallerField[];
  schemaReferences: readonly InvocationSchemaReference[];
  immediateToolResultKind: InvocationImmediateToolResultKind;
  applicationResultKind: InvocationApplicationResultKind;
  participantContext: InvocationParticipantContext;
}

export interface SkillInvocationMetadata {
  schemaVersion: 1;
  skillId: string;
  profiles: readonly SkillInvocationProfile[];
}

function fail(code: InvocationMetadataErrorCode): never {
  throw new InvocationMetadataError(code);
}

const kit = createContractKit<InvocationMetadataErrorCode>({
  fail: fail as ContractFail<InvocationMetadataErrorCode>,
  inertMode: "strict",
  codes: {
    invalidShape: "invalid-metadata",
    invalidValue: "invalid-metadata",
    digestMismatch: "invalid-metadata",
    credentialMaterial: "invalid-metadata",
    schemaMismatch: "unknown-version",
  },
});

function kebabId(value: unknown): string {
  const id = kit.string(value);
  if (!/^[a-z][a-z0-9-]{0,127}$/u.test(id)) fail("invalid-metadata");
  return id;
}

function decodeFieldList(value: unknown): InvocationCallerField[] {
  const fields = kit.array(value).map((item) => kit.enumeration(item, CALLER_FIELDS));
  kit.unique(fields);
  return fields;
}

function decodeSchemaReferences(value: unknown): InvocationSchemaReference[] {
  const refs = kit.array(value).map((item) => kit.enumeration(item, SCHEMA_REFERENCES));
  kit.unique(refs);
  return refs;
}

export function decodeSkillInvocationProfile(value: unknown): SkillInvocationProfile {
  kit.assertInert(value);
  kit.rejectCredentials(value);
  const root = kit.object(value);
  kit.exact(root, PROFILE_KEYS);
  const acceptedCallerFields = decodeFieldList(root.acceptedCallerFields);
  const requiredCallerFields = decodeFieldList(root.requiredCallerFields);
  if (requiredCallerFields.some((field) => !acceptedCallerFields.includes(field))) {
    fail("invalid-metadata");
  }
  return kit.deepFreeze({
    id: kebabId(root.id),
    operation: kit.enumeration(root.operation, OPERATIONS),
    contextPhase: kit.enumeration(root.contextPhase, CONTEXT_PHASES),
    acceptedCallerFields,
    requiredCallerFields,
    schemaReferences: decodeSchemaReferences(root.schemaReferences),
    immediateToolResultKind: kit.enumeration(root.immediateToolResultKind, IMMEDIATE_RESULTS),
    applicationResultKind: kit.enumeration(root.applicationResultKind, APPLICATION_RESULTS),
    participantContext: kit.enumeration(root.participantContext, PARTICIPANT_CONTEXTS),
  });
}

export function decodeSkillInvocationMetadata(value: unknown): SkillInvocationMetadata {
  kit.assertInert(value);
  kit.rejectCredentials(value);
  const root = kit.object(value);
  if (!Object.hasOwn(root, "schemaVersion")) fail("invalid-metadata");
  if (root.schemaVersion !== 1) fail("unknown-version");
  kit.exact(root, ["schemaVersion", "skillId", "profiles"]);
  const profiles = kit.array(root.profiles).map(decodeSkillInvocationProfile);
  if (profiles.length === 0 || profiles.length > 16) fail("invalid-metadata");
  kit.unique(profiles.map((profile) => profile.id));
  return kit.deepFreeze({
    schemaVersion: 1,
    skillId: kebabId(root.skillId),
    profiles,
  });
}

export function selectSkillInvocationProfile(
  metadata: SkillInvocationMetadata,
  options: { operation: InvocationOperation; profileId?: string },
): SkillInvocationProfile {
  if (options.profileId !== undefined) {
    const selected = metadata.profiles.find((profile) => profile.id === options.profileId);
    if (!selected) {
      // hygiene: envelope
      throw new InvocationMetadataError(
        "invalid-metadata",
        `Catalog skill "${metadata.skillId}" has no invocation profile "${options.profileId}".`,
      );
    }
    return selected;
  }
  const matches = metadata.profiles.filter((profile) => profile.operation === options.operation);
  if (matches.length !== 1) {
    // hygiene: envelope
    throw new InvocationMetadataError(
      "invalid-metadata",
      `Catalog skill "${metadata.skillId}" needs an explicit profile for ${options.operation}.`,
    );
  }
  const [profile] = matches;
  if (!profile) {
    // hygiene: envelope
    throw new InvocationMetadataError(
      "invalid-metadata",
      `Catalog skill "${metadata.skillId}" has no invocation profile for ${options.operation}.`,
    );
  }
  return profile;
}

export async function loadVerifiedInvocationMetadata(
  verified: VerifiedCatalogSkill,
): Promise<SkillInvocationMetadata> {
  let bytes: Buffer;
  try {
    bytes = await readVerifiedCatalogFile(verified, INVOCATION_METADATA_FILE);
  } catch (error) {
    if (error instanceof CatalogSkillCrateError && error.code === "file-set-mismatch") {
      fail("missing-file");
    }
    if (error instanceof CatalogSkillCrateError && error.code === "checksum-mismatch") {
      fail("tampered");
    }
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = parseJsonEvidence(bytes.toString("utf8"));
  } catch {
    fail("invalid-metadata");
  }
  const metadata = decodeSkillInvocationMetadata(parsed);
  if (metadata.skillId !== verified.skill.id) fail("invalid-metadata");
  return metadata;
}
