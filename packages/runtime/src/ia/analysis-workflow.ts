// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { getWorkflow } from "../workflow-registry/catalog.js";
export { iaDiscoverySearch } from "./discovery-search-plan.js";

/**
 * The hosted IA analysis job, owned by `workflows/ia-analysis.json`. The search
 * plan lives in `discovery-search-plan.ts` so `declarative.ts` can register it
 * without importing this module, which would cycle the catalog through the
 * domain.
 */
export const iaAnalysisWorkflow = getWorkflow("ia-analysis");
