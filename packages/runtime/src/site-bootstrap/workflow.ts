// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { getWorkflow } from "../workflow-registry/catalog.js";

/**
 * Canonical manifest-backed approved site operation, delegated to the
 * declarative catalog. Cycle-safe because nothing in `workflow-registry`
 * imports `site-bootstrap`.
 */
export const siteBootstrapWorkflow = getWorkflow("site-bootstrap");
