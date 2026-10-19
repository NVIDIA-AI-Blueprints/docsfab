// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { ProbeProvider } from "../../src/profile/probe-core.js";
import { releaseModelCredential } from "../../src/security/model-credential-release.js";

/** A probe provider whose key is released for `baseUrl`, as every shipped caller builds one. */
export function releasedProbeProvider(baseUrl: string, apiKey: string): ProbeProvider {
  return {
    baseUrl,
    credential: releaseModelCredential({ endpoint: baseUrl, apiKey }, "endpoint-probe"),
  };
}
