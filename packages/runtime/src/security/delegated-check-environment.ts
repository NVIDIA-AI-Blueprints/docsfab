// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  createConfiguredCredentialRegistry,
  isConfiguredCredentialFileName,
  isConfiguredCredentialName,
  matchingDefaultsForHost,
} from "./configured-credentials.js";

/**
 * Variables that are credential locations without a credential-shaped name:
 * glab's configuration directory holds its tokens, and systemd's credentials
 * directory holds every credential file of the unit.
 */
const CREDENTIAL_LOCATION_VARIABLES: readonly string[] = [
  "GLAB_CONFIG_DIR",
  "CREDENTIALS_DIRECTORY",
];

/** References that name the variable holding a model key; the name is arbitrary. */
const CREDENTIAL_REFERENCE_VARIABLES: readonly string[] = [
  "MODEL_CREDENTIAL_ENV",
  "JUDGE_CREDENTIAL_ENV",
];

/**
 * The environment of a check script that `docsfab do --delegate --check` runs
 * in the operator's repository: the parent environment without DocsFab's keys
 * and tokens, with `CI=1`.
 *
 * It drops every variable the configured-credential registry names as a
 * credential or a credential file, the credential locations above, each
 * variable that the loaded configuration (`credentialEnvNames`) or a
 * `*_CREDENTIAL_ENV` reference names (any uppercase name, even one the
 * registry cannot recognize), and every variable whose value holds one of
 * DocsFab's configured credentials as the exact-match screen compares them,
 * which includes the credential in a proxy URL. Everything else passes, so the
 * check keeps its PATH, HOME, and tool settings.
 */
export function delegatedCheckEnvironment(
  source: NodeJS.ProcessEnv,
  credentialEnvNames: readonly string[] = [],
): NodeJS.ProcessEnv {
  const dropped = new Set([...CREDENTIAL_LOCATION_VARIABLES, ...credentialEnvNames]);
  for (const reference of CREDENTIAL_REFERENCE_VARIABLES) {
    const named = source[reference]?.trim();
    if (named) dropped.add(named);
  }
  // This environment's credentials, plus the values loaders registered in this
  // process, such as a model key read from a file.
  const registry = createConfiguredCredentialRegistry({
    environment: () => source,
    sharedRegistrations: true,
    matchingDefaults: matchingDefaultsForHost,
  });
  const environment: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(source)) {
    if (value === undefined) continue;
    if (
      dropped.has(name) ||
      isConfiguredCredentialName(name) ||
      isConfiguredCredentialFileName(name) ||
      registry.find(value) !== null
    ) {
      continue;
    }
    environment[name] = value;
  }
  return { ...environment, CI: "1" };
}
