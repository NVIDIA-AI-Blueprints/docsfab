// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** TypeScript compatibility entry; the native module is shared with host contract readers. */
import { redactConfiguredCredentials } from "./configured-credentials.js";
import { redactCredentialMaterial as redactCredentialShapes } from "./credential-material-core.js";

export {
  containsAssignedCredential,
  containsLegacyAssignedCredential,
  containsMetadataAssignedCredential,
  containsStrictAssignedCredential,
  containsStrictLegacyAssignedCredential,
  containsStrictMetadataAssignedCredential,
  inspectCredentialMetadata,
  isPlaceholderWordGrammar,
  PLACEHOLDER_WORD_GRAMMAR,
  containsCredentialMetadata,
  containsCatalogCredential,
  containsInferenceCredential,
  containsMetadataCredential,
  credentialMaterialSpans,
  containsRepositorySourceCredentialMaterial,
  isCompleteRepositoryCode,
  RepositorySourceParserUnavailableError,
  type CredentialMetadataInspection,
} from "./credential-material-core.js";

/**
 * Strict redaction for logs, errors, and operator output: DocsFab's own
 * configured credentials, matched exactly in any form or piece, and then
 * anything credential-shaped (#1807). Over-redaction is cosmetic; a missed
 * value leaks.
 */
export function redactCredentialMaterial(value: string): string {
  return redactCredentialShapes(redactConfiguredCredentials(value));
}
