// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** Types for the dependency-free credential-shape module; see text-credential-shapes.js. */
export const CREDENTIAL_TOKEN_SHAPES: Readonly<{
  gitlab: RegExp;
  github: RegExp;
  slack: RegExp;
  slackRefresh: RegExp;
  slackApp: RegExp;
  nvidia: RegExp;
  openai: RegExp;
  googleOauth: RegExp;
  googleApiKey: RegExp;
  aws: RegExp;
  jwt: RegExp;
}>;
export const DOCUMENT_CREDENTIAL_SHAPES: readonly RegExp[];
export const TEXT_CREDENTIAL_SHAPES: readonly RegExp[];
export function containsTextCredentialShape(text: string): boolean;
