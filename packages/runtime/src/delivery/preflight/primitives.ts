// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  LocalUserPublicationPreflightError,
  type LocalUserPublicationFailureCode,
  type LocalUserPublicationPreflightDetails,
} from "../contracts.js";
import type { JsonEvidenceValue } from "../../json-evidence.js";

export const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

export function safeRepositoryPath(value: string): boolean {
  return (
    value.length > 0 &&
    value === value.normalize("NFC") &&
    !value.startsWith("/") &&
    !value.startsWith("~") &&
    !/^[A-Za-z]:[\\/]/u.test(value) &&
    !value.includes("\\") &&
    value.split("/").every((segment) => Boolean(segment) && segment !== "." && segment !== "..")
  );
}

export function object(
  value: JsonEvidenceValue | undefined,
): value is { [key: string]: JsonEvidenceValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function fail(
  code: LocalUserPublicationFailureCode,
  details?: LocalUserPublicationPreflightDetails,
): never {
  throw new LocalUserPublicationPreflightError(code, details);
}
