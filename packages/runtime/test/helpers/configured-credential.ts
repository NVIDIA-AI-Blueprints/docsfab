// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, onTestFinished } from "vitest";

import { refreshConfiguredCredentials } from "../../src/security/configured-credentials.js";

let next = 0;

/**
 * Make `value` one of DocsFab's own configured credentials until the current
 * test finishes, by setting a credential-named environment variable that the
 * configured-credential registry reads (#1807). Under the owner decision on
 * #1807, only a configured credential is refused; a credential shape alone is
 * a finding. Call it inside a test.
 */
export function configureCredential<T extends string>(value: T, name?: string): T {
  next += 1;
  const variable = name ?? `DOCSFAB_TEST_CONFIGURED_${String(next)}_TOKEN`;
  const previous = process.env[variable];
  process.env[variable] = value;
  refreshConfiguredCredentials();
  onTestFinished(() => {
    if (previous === undefined) delete process.env[variable];
    else process.env[variable] = previous;
    refreshConfiguredCredentials();
  });
  return value;
}

/**
 * Make every listed fixture value a configured credential for each test in
 * the calling file or `describe` block. For files whose tests plant
 * credential fixtures to prove a boundary refuses them (#1807).
 */
export function configureCredentialsForEachTest(...values: readonly string[]): void {
  const variables = values.map(() => {
    next += 1;
    return `DOCSFAB_TEST_FIXTURE_${String(next)}_TOKEN`;
  });
  beforeEach(() => {
    variables.forEach((variable, index) => {
      process.env[variable] = values[index];
    });
    refreshConfiguredCredentials();
  });
  afterEach(() => {
    for (const variable of variables) delete process.env[variable];
    refreshConfiguredCredentials();
  });
}
