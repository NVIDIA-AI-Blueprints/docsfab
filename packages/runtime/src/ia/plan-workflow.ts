// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { getWorkflow } from "../workflow-registry/catalog.js";

/** The hosted IA planning job, read from `workflows/ia-plan.json`. */
export const iaPlanWorkflow = getWorkflow("ia-plan");
