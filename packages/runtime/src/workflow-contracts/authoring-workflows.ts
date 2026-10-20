// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The authoring jobs: the workflows whose writer is bound to an approved
 * documentation plan and whose product outcome the authoring projector seals.
 * A leaf, so the projector and the contract leaves it reads share one list
 * without an import cycle.
 */
import type { WorkflowName } from "./contracts.js";

export const AUTHORING_QUALITY_OUTCOME_WORKFLOWS = [
  "create-documentation",
  "update-documentation",
  "restructure-documentation",
] as const satisfies readonly WorkflowName[];
