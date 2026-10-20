// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { getWorkflow } from "../workflow-registry/catalog.js";

/**
 * The hosted native Foundation-to-patch composition, read from its manifest
 * (`workflows/foundation-to-patch.json`). `catalog.ts` does not import this
 * module, which keeps it from cycling.
 */
export const foundationToPatchWorkflow = getWorkflow("foundation-to-patch");
