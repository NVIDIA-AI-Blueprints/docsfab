// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Built-in documentation-validation profiles. Selection consumes only the
 * verified run's sealed workflow, exact changed paths, and trusted host policy.
 * Repository config, patch/model text, scripts, and serialized plans cannot
 * choose a profile, check set, validator, or backend.
 */
import { createContractKit, type ContractFail } from "../contract-kit/index.js";
import {
  DOCUMENTATION_SOURCE_MARKUP_EXTENSIONS,
  isCanonicalDocumentationSourcePath,
  isDocumentationSourceConfigurationPath,
} from "../repository/documentation-source-support.js";
import type { WorkflowName } from "../workflow-contracts/contracts.js";
import { isWorkflowName } from "../workflow-registry/catalog.js";

export const DOCUMENTATION_VALIDATION_BINDING_KIND =
  "docsfab-documentation-validation-binding" as const;
export const DOCUMENTATION_VALIDATION_PROFILE_VERSION = "1" as const;
export const DOCUMENTATION_VALIDATION_PROFILE_VERSION_V2 = "2" as const;
export const DOCUMENTATION_VALIDATION_ENTRYPOINT_COMMAND = "test -d ." as const;

export const DOCUMENTATION_VALIDATION_PROFILE_IDS = [
  "docsfab-documentation-validation",
  "docsfab-publication-validation",
] as const;
export type DocumentationValidationProfileId =
  (typeof DOCUMENTATION_VALIDATION_PROFILE_IDS)[number];

export const DOCUMENTATION_VALIDATOR_IDENTITIES = [
  "docsfab-documentation-validator",
  "docsfab-publication-validator",
] as const;
export type DocumentationValidatorIdentity = (typeof DOCUMENTATION_VALIDATOR_IDENTITIES)[number];

const DOCUMENTATION_CHECK_IDS = [
  "candidate-input-tree",
  "documentation-paths-readable",
  "documentation-relative-links",
  "fern-navigation-targets",
  "isolation-boundary",
] as const;
const PUBLICATION_CHECK_IDS = [
  "candidate-input-tree",
  "isolation-boundary",
  "non-package-script-gate",
] as const;
const DOCUMENTATION_CHECK_IDS_V2 = [
  "candidate-input-tree",
  "documentation-source-applicability",
  "documentation-paths-readable",
  "documentation-relative-links",
  "documentation-navigation-targets",
  "isolation-boundary",
] as const;
const PUBLICATION_CHECK_IDS_V2 = PUBLICATION_CHECK_IDS;

export type DocumentationValidationErrorCode =
  | "invalid-shape"
  | "invalid-value"
  | "digest-mismatch"
  | "credential-material"
  | "migration-required"
  | "schema-mismatch"
  | "untrusted-profile"
  | "policy-mismatch"
  | "selector-mismatch";

export class DocumentationValidationError extends Error {
  public constructor(public readonly code: DocumentationValidationErrorCode) {
    super(`The documentation validation profile contract rejected this value (${code}).`);
    this.name = "DocumentationValidationError";
  }
}

export function failDocumentationValidation(code: DocumentationValidationErrorCode): never {
  throw new DocumentationValidationError(code);
}

export const documentationValidationKit = createContractKit({
  fail: failDocumentationValidation as ContractFail<DocumentationValidationErrorCode>,
  inertMode: "strict",
  codes: {
    invalidShape: "invalid-shape",
    invalidValue: "invalid-value",
    digestMismatch: "digest-mismatch",
    credentialMaterial: "credential-material",
    schemaMismatch: "migration-required",
  },
});

const kit = documentationValidationKit;

/**
 * No adapter reads AsciiDoc. Classing it as markup selects documentation
 * validation, whose applicability check reports it instead of passing it.
 */
const MARKUP_EXTENSIONS = [...DOCUMENTATION_SOURCE_MARKUP_EXTENSIONS, ".adoc"];

const PATH_CLASS_RULES = kit.deepFreeze([
  {
    class: "documentation-configuration" as const,
    match: (path: string): boolean =>
      isCanonicalDocumentationSourcePath(path) && isDocumentationSourceConfigurationPath(path),
  },
  {
    class: "documentation-set" as const,
    match: (path: string): boolean => path === "docs" || path.startsWith("docs/"),
  },
  {
    class: "markup" as const,
    match: (path: string): boolean =>
      MARKUP_EXTENSIONS.some((extension) => path.endsWith(extension)),
  },
  {
    class: "other" as const,
    match: (_path: string): boolean => true,
  },
]);

type PathClass = (typeof PATH_CLASS_RULES)[number]["class"];

const PROFILE_SELECTION_RULES = kit.deepFreeze([
  {
    profileId: "docsfab-documentation-validation" as const,
    match: (classes: readonly PathClass[]): boolean =>
      classes.some(
        (value) =>
          value === "documentation-set" ||
          value === "documentation-configuration" ||
          value === "markup",
      ),
  },
  {
    profileId: "docsfab-publication-validation" as const,
    match: (_classes: readonly PathClass[]): boolean => true,
  },
]);

const HOST_DOCUMENTATION_VALIDATOR_CATALOG = kit.deepFreeze({
  "docsfab-documentation-validation": {
    version: DOCUMENTATION_VALIDATION_PROFILE_VERSION,
    validatorIdentity: "docsfab-documentation-validator",
    entrypointCommand: DOCUMENTATION_VALIDATION_ENTRYPOINT_COMMAND,
    checkIds: DOCUMENTATION_CHECK_IDS,
  },
  "docsfab-publication-validation": {
    version: DOCUMENTATION_VALIDATION_PROFILE_VERSION,
    validatorIdentity: "docsfab-publication-validator",
    entrypointCommand: DOCUMENTATION_VALIDATION_ENTRYPOINT_COMMAND,
    checkIds: PUBLICATION_CHECK_IDS,
  },
} as const);

const HOST_DOCUMENTATION_VALIDATOR_CATALOG_V2 = kit.deepFreeze({
  "docsfab-documentation-validation": {
    version: DOCUMENTATION_VALIDATION_PROFILE_VERSION_V2,
    validatorIdentity: "docsfab-documentation-validator",
    entrypointCommand: DOCUMENTATION_VALIDATION_ENTRYPOINT_COMMAND,
    checkIds: DOCUMENTATION_CHECK_IDS_V2,
  },
  "docsfab-publication-validation": {
    version: DOCUMENTATION_VALIDATION_PROFILE_VERSION_V2,
    validatorIdentity: "docsfab-publication-validator",
    entrypointCommand: DOCUMENTATION_VALIDATION_ENTRYPOINT_COMMAND,
    checkIds: PUBLICATION_CHECK_IDS_V2,
  },
} as const);

export type DocumentationValidationSerializedAttempt = {
  readonly plan?: unknown;
  readonly config?: unknown;
  readonly environment?: NodeJS.ProcessEnv;
  readonly modelOutput?: unknown;
  readonly repositoryConfig?: unknown;
  readonly patchText?: unknown;
  readonly scriptPresence?: unknown;
};

export interface DocumentationValidationSelectorInput {
  readonly workflow: WorkflowName;
  readonly changedPaths: readonly string[];
  readonly hostPolicySha256: string;
  /** Required for source-aware selection; omitting it builds a v1 binding. */
  readonly applicabilitySha256?: string;
}

export interface DocumentationValidationBindingV2 {
  readonly schemaVersion: 2;
  readonly kind: typeof DOCUMENTATION_VALIDATION_BINDING_KIND;
  readonly profileId: DocumentationValidationProfileId;
  readonly profileVersion: typeof DOCUMENTATION_VALIDATION_PROFILE_VERSION_V2;
  readonly checkIds: readonly string[];
  readonly selectorInputSha256: string;
  readonly validatorIdentity: DocumentationValidatorIdentity;
  readonly checkSetSha256: string;
  readonly applicabilitySha256: string;
}

export type DocumentationValidationBinding =
  | DocumentationValidationBindingV1
  | DocumentationValidationBindingV2;

export interface DocumentationValidationBindingV1 {
  readonly schemaVersion: 1;
  readonly kind: typeof DOCUMENTATION_VALIDATION_BINDING_KIND;
  readonly profileId: DocumentationValidationProfileId;
  readonly profileVersion: typeof DOCUMENTATION_VALIDATION_PROFILE_VERSION;
  readonly checkIds: readonly string[];
  readonly selectorInputSha256: string;
  readonly validatorIdentity: DocumentationValidatorIdentity;
  readonly checkSetSha256: string;
}

export interface HostDocumentationValidatorResolution {
  readonly profileId: DocumentationValidationProfileId;
  readonly profileVersion:
    | typeof DOCUMENTATION_VALIDATION_PROFILE_VERSION
    | typeof DOCUMENTATION_VALIDATION_PROFILE_VERSION_V2;
  readonly validatorIdentity: DocumentationValidatorIdentity;
  readonly entrypointCommand: typeof DOCUMENTATION_VALIDATION_ENTRYPOINT_COMMAND;
  readonly checkIds: readonly string[];
  readonly checkSetSha256: string;
}

export interface DocumentationValidationSelectionV1 {
  readonly binding: DocumentationValidationBindingV1;
  readonly entrypointCommand: typeof DOCUMENTATION_VALIDATION_ENTRYPOINT_COMMAND;
}

export interface DocumentationValidationSelectionV2 {
  readonly binding: DocumentationValidationBindingV2;
  readonly entrypointCommand: typeof DOCUMENTATION_VALIDATION_ENTRYPOINT_COMMAND;
}

const BINDING_BODY_KEYS = [
  "profileId",
  "profileVersion",
  "checkIds",
  "selectorInputSha256",
  "validatorIdentity",
  "checkSetSha256",
] as const;

export function documentationValidationCheckSetSha256(
  resolution: Omit<HostDocumentationValidatorResolution, "checkSetSha256">,
): string {
  return kit.canonicalDigest({
    profileId: resolution.profileId,
    profileVersion: resolution.profileVersion,
    validatorIdentity: resolution.validatorIdentity,
    entrypointCommand: resolution.entrypointCommand,
    checkIds: [...resolution.checkIds],
  });
}

export function documentationValidationSelectorInputSha256(
  input: DocumentationValidationSelectorInput,
): string {
  const base = {
    workflow: input.workflow,
    changedPaths: canonicalChangedPaths(input.changedPaths),
    hostPolicySha256: input.hostPolicySha256,
  };
  return kit.canonicalDigest(
    input.applicabilitySha256 === undefined
      ? base
      : { ...base, applicabilitySha256: kit.hash(input.applicabilitySha256) },
  );
}

/**
 * Host catalog resolution. Serialized plan/config/model/script fields are
 * accepted so tests can prove they cannot name a validator or check set.
 */
export function resolveHostDocumentationValidator(
  profileId: DocumentationValidationProfileId,
  profileVersion:
    | typeof DOCUMENTATION_VALIDATION_PROFILE_VERSION
    | typeof DOCUMENTATION_VALIDATION_PROFILE_VERSION_V2 = DOCUMENTATION_VALIDATION_PROFILE_VERSION,
  _serialized?: DocumentationValidationSerializedAttempt,
): HostDocumentationValidatorResolution {
  void _serialized;
  const catalog =
    profileVersion === DOCUMENTATION_VALIDATION_PROFILE_VERSION
      ? HOST_DOCUMENTATION_VALIDATOR_CATALOG
      : HOST_DOCUMENTATION_VALIDATOR_CATALOG_V2;
  const entry = catalog[profileId];
  if (!entry || entry.version !== profileVersion) failDocumentationValidation("untrusted-profile");
  const resolution = {
    profileId,
    profileVersion,
    validatorIdentity: entry.validatorIdentity,
    entrypointCommand: entry.entrypointCommand,
    checkIds: [...entry.checkIds],
  };
  return kit.deepFreeze({
    ...resolution,
    checkSetSha256: documentationValidationCheckSetSha256(resolution),
  });
}

export function selectDocumentationValidationProfile(
  input: DocumentationValidationSelectorInput & { readonly applicabilitySha256: string },
  _serialized?: DocumentationValidationSerializedAttempt,
): DocumentationValidationSelectionV2;
export function selectDocumentationValidationProfile(
  input: DocumentationValidationSelectorInput & { readonly applicabilitySha256?: undefined },
  _serialized?: DocumentationValidationSerializedAttempt,
): DocumentationValidationSelectionV1;
export function selectDocumentationValidationProfile(
  input: DocumentationValidationSelectorInput,
  _serialized?: DocumentationValidationSerializedAttempt,
): DocumentationValidationSelectionV1 | DocumentationValidationSelectionV2 {
  void _serialized;
  if (!isWorkflowName(input.workflow)) failDocumentationValidation("selector-mismatch");
  const hostPolicySha256 = kit.hash(input.hostPolicySha256);
  const changedPaths = canonicalChangedPaths(input.changedPaths);
  if (changedPaths.length === 0) failDocumentationValidation("selector-mismatch");
  const pathClasses = changedPaths.map(classifyChangedPath);
  const profileId = PROFILE_SELECTION_RULES.find((rule) => rule.match(pathClasses))?.profileId;
  if (profileId === undefined) failDocumentationValidation("selector-mismatch");
  if (input.applicabilitySha256 === undefined) {
    const resolved = resolveHostDocumentationValidator(
      profileId,
      DOCUMENTATION_VALIDATION_PROFILE_VERSION,
    );
    const binding: DocumentationValidationBindingV1 = kit.deepFreeze({
      schemaVersion: 1,
      kind: DOCUMENTATION_VALIDATION_BINDING_KIND,
      profileId: resolved.profileId,
      profileVersion: DOCUMENTATION_VALIDATION_PROFILE_VERSION,
      checkIds: [...resolved.checkIds],
      selectorInputSha256: documentationValidationSelectorInputSha256({
        workflow: input.workflow,
        changedPaths,
        hostPolicySha256,
      }),
      validatorIdentity: resolved.validatorIdentity,
      checkSetSha256: resolved.checkSetSha256,
    });
    kit.assertInert(binding);
    kit.rejectCredentials(binding);
    return kit.deepFreeze({ binding, entrypointCommand: resolved.entrypointCommand });
  }
  const applicabilitySha256 = kit.hash(input.applicabilitySha256);
  const resolved = resolveHostDocumentationValidator(
    profileId,
    DOCUMENTATION_VALIDATION_PROFILE_VERSION_V2,
  );
  const binding: DocumentationValidationBindingV2 = kit.deepFreeze({
    schemaVersion: 2,
    kind: DOCUMENTATION_VALIDATION_BINDING_KIND,
    profileId: resolved.profileId,
    profileVersion: DOCUMENTATION_VALIDATION_PROFILE_VERSION_V2,
    checkIds: [...resolved.checkIds],
    selectorInputSha256: documentationValidationSelectorInputSha256({
      workflow: input.workflow,
      changedPaths,
      hostPolicySha256,
      applicabilitySha256,
    }),
    validatorIdentity: resolved.validatorIdentity,
    checkSetSha256: resolved.checkSetSha256,
    applicabilitySha256,
  });
  kit.assertInert(binding);
  kit.rejectCredentials(binding);
  return kit.deepFreeze({ binding, entrypointCommand: resolved.entrypointCommand });
}

export function assertDocumentationValidationBinding(
  value: unknown,
): asserts value is DocumentationValidationBinding {
  const root = kit.object(value);
  if (root.schemaVersion === 1) kit.exact(root, ["schemaVersion", "kind", ...BINDING_BODY_KEYS]);
  else if (root.schemaVersion === 2)
    kit.exact(root, ["schemaVersion", "kind", ...BINDING_BODY_KEYS, "applicabilitySha256"]);
  else failDocumentationValidation("schema-mismatch");
  if (root.kind !== DOCUMENTATION_VALIDATION_BINDING_KIND) {
    failDocumentationValidation("schema-mismatch");
  }
  const profileId = kit.enumeration(root.profileId, DOCUMENTATION_VALIDATION_PROFILE_IDS);
  const profileVersion =
    root.schemaVersion === 1
      ? kit.enumeration(root.profileVersion, [DOCUMENTATION_VALIDATION_PROFILE_VERSION] as const)
      : kit.enumeration(root.profileVersion, [
          DOCUMENTATION_VALIDATION_PROFILE_VERSION_V2,
        ] as const);
  const resolved = resolveHostDocumentationValidator(profileId, profileVersion);
  const checkIds = kit.array(root.checkIds).map((item) => kit.identifier(item));
  if (
    checkIds.length !== resolved.checkIds.length ||
    checkIds.some((id, index) => id !== resolved.checkIds[index])
  ) {
    failDocumentationValidation("untrusted-profile");
  }
  if (root.validatorIdentity !== resolved.validatorIdentity) {
    failDocumentationValidation("untrusted-profile");
  }
  if (kit.hash(root.checkSetSha256) !== resolved.checkSetSha256) {
    failDocumentationValidation("digest-mismatch");
  }
  kit.hash(root.selectorInputSha256);
  if (root.schemaVersion === 2) kit.hash(root.applicabilitySha256);
  kit.assertInert(value);
  kit.rejectCredentials(value);
}

export function isDocumentationValidationBinding(
  value: unknown,
): value is DocumentationValidationBinding {
  try {
    assertDocumentationValidationBinding(value);
    return true;
  } catch (error) {
    if (error instanceof DocumentationValidationError) return false;
    throw error;
  }
}

function canonicalChangedPaths(paths: readonly string[]): string[] {
  if (!Array.isArray(paths) || paths.length === 0) failDocumentationValidation("selector-mismatch");
  const unique = new Set<string>();
  for (const path of paths) {
    const value = kit.string(path);
    if (
      !value ||
      value.startsWith("/") ||
      value.includes("\\") ||
      value.split("/").includes("..")
    ) {
      failDocumentationValidation("invalid-value");
    }
    unique.add(value);
  }
  return [...unique].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
}

function classifyChangedPath(path: string): PathClass {
  const rule = PATH_CLASS_RULES.find((candidate) => candidate.match(path));
  if (rule === undefined) failDocumentationValidation("selector-mismatch");
  return rule.class;
}
