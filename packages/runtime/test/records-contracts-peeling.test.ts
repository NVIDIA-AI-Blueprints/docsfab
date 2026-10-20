// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
  EXECUTED_TOOL_FAILURE_CATEGORIES,
  PATH_REFUSAL_REASONS,
} from "../src/records/contracts/tool-activity.js";
import {
  isProviderResponseEvidenceV1,
  LEGACY_HOST_PATH_MATCH_ROOTS,
} from "../src/records/contracts/inference.js";
import { RUN_STATUS_KEYS } from "../src/records/contracts/run-records.js";
import {
  EXECUTED_TOOL_FAILURE_CATEGORIES as facadeToolFailures,
  isProviderResponseEvidenceV1 as facadeProviderResponseCheck,
  LEGACY_HOST_PATH_MATCH_ROOTS as facadePathRoots,
  PATH_REFUSAL_REASONS as facadePathRefusals,
  RUN_STATUS_KEYS as facadeRunStatuses,
} from "../src/records/contracts.js";

describe("record contract compatibility facade", () => {
  it("reexports the domain-owned values by identity", () => {
    expect(facadeToolFailures).toBe(EXECUTED_TOOL_FAILURE_CATEGORIES);
    expect(facadePathRefusals).toBe(PATH_REFUSAL_REASONS);
    expect(facadePathRoots).toBe(LEGACY_HOST_PATH_MATCH_ROOTS);
    expect(facadeRunStatuses).toBe(RUN_STATUS_KEYS);
    expect(facadeProviderResponseCheck).toBe(isProviderResponseEvidenceV1);
  });
});
