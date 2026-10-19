// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export type ReaderTransportParseCodeV1 =
  | "invalid-shape"
  | "invalid-value"
  | "credential-material"
  | "size-exceeded";
/** Existing strict wire string ceiling, measured in UTF-16 code units. */
export const INERT_TRANSPORT_MAX_STRING_CHARS: number;
export interface ReaderContextInputTransportV1 {
  schema_version: 1;
  target_audience: string;
  reader_job: string;
  change_scope: string[];
  source_priority: string[];
  required_content: string[];
  excluded_content: string[];
  unresolved_questions: string[];
  known_limitations?: string[];
}
export type ReaderSourceRoleTransportV1 =
  | "public-contract"
  | "changed-source"
  | "current-documentation"
  | "repository-instruction"
  | "accepted-knowledge"
  | "request";
export interface ReaderSourceHintTransportV1 {
  role: ReaderSourceRoleTransportV1;
  path: string;
}
export function normalizeReaderContextInputTransportV1(
  value: unknown,
  hooks: { fail(code: ReaderTransportParseCodeV1): never; rejectCredentials(value: unknown): void },
): ReaderContextInputTransportV1;
export function normalizeReaderSourceHintTransportV1(
  value: unknown,
  hooks: {
    fail: (code: "invalid-shape" | "invalid-value" | "credential-material") => never;
    rejectCredentials(value: unknown): void;
  },
): ReaderSourceHintTransportV1;

/** Shared inert transport guard; no source or operation authority is granted. */
export function assertInertTransportData(
  value: unknown,
  fail: (code: "invalid-shape" | "invalid-value") => never,
): void;

/** Capture inert own data, then apply the existing terminal JSON wire projection. */
export function projectInertTransportRecord(
  value: unknown,
  fail: (code: "invalid-shape" | "invalid-value" | "terminal-record-shape") => never,
): Record<string, unknown>;

export function conservativeReaderContextInputTransport(input: {
  instruction: string;
  changeScope?: readonly string[];
}): ReaderContextInputTransportV1;
