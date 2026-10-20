// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { vi } from "vitest";

import { refreshConfiguredCredentials } from "../../src/security/configured-credentials.js";

/** The environment variable a test plants its configured credential in. */
export const PLANTED_CREDENTIAL_VARIABLE = "DOCSFAB_FIXTURE_PLANTED_TOKEN";

/**
 * A configured credential value that deliberately matches no credential
 * shape, assembled from words at run time so no source line holds one. A
 * screen that refuses it can only be matching DocsFab's configured
 * credentials exactly, never a shape.
 */
export function plainConfiguredCredential(seed = "orchard"): string {
  return ["fixture", seed, "lamp", "quietly", "hums"].join("-");
}

/**
 * Plant `value` as one of DocsFab's own configured credentials: the process
 * registry discovers it from the environment. Undo with `clearPlantedCredential()`.
 */
export function plantConfiguredCredential(value = plainConfiguredCredential()): string {
  vi.stubEnv(PLANTED_CREDENTIAL_VARIABLE, value);
  // The registry reads the environment at most once per event-loop turn.
  refreshConfiguredCredentials();
  return value;
}

/** Remove every stubbed variable, including a planted credential, and re-read the environment. */
export function clearPlantedCredential(): void {
  vi.unstubAllEnvs();
  // The registry reads the environment at most once per event-loop turn.
  refreshConfiguredCredentials();
}
