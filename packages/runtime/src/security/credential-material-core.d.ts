// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export interface CredentialMetadataInspection {
  legacyAssignedCredential: boolean;
  metadataAssignedCredential: boolean;
  unsafeStructure: boolean;
}
export function containsAssignedCredential(value: string): boolean;
export function containsLegacyAssignedCredential(value: string): boolean;
export function containsMetadataAssignedCredential(value: string): boolean;
/** The assignment check under the strict value rule: references and placeholders count. */
export function containsStrictAssignedCredential(value: string): boolean;
export function containsStrictLegacyAssignedCredential(value: string): boolean;
export function containsStrictMetadataAssignedCredential(value: string): boolean;
/** Owner decision pending on #1807: whether word-spelled placeholders are exempt. */
export const PLACEHOLDER_WORD_GRAMMAR: boolean;
/** A phrase or run of documentation placeholder words, or base64 of a placeholder. */
export function isPlaceholderWordGrammar(value: string): boolean;
export function inspectCredentialMetadata(
  value: unknown,
  onString?: (value: string) => void,
): CredentialMetadataInspection;
export function containsCredentialMetadata(value: unknown): boolean;
export function containsCatalogCredential(value: string): boolean;
export function containsInferenceCredential(value: string): boolean;
export function containsMetadataCredential(value: string): boolean;
export function redactCredentialMaterial(value: string): string;
export function credentialMaterialSpans(value: string): Array<[number, number]>;
/** Refusal to screen: the source parser is not installed. Never a clean or complete verdict. */
export class RepositorySourceParserUnavailableError extends Error {
  readonly code: "repository-source-parser-unavailable";
  constructor(cause?: unknown);
}
/** Complete original repository source only; never a metadata exemption. */
export function containsRepositorySourceCredentialMaterial(source: string): boolean;
/** Bounded complete JavaScript/TypeScript parse; no filename or authority inference. */
export function isCompleteRepositoryCode(source: string): boolean;
