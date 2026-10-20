// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { RstCapabilityRefusalCode } from "./capability-admission.js";
import { RST_CAPABILITY_NEXT_ACTIONS as catalogActions } from "../operator/situation-catalog.js";

/** Shared actionable guidance for CLI capability errors and the operator catalog. */
export const RST_CAPABILITY_NEXT_ACTIONS: Readonly<Record<RstCapabilityRefusalCode, string>> =
  catalogActions;
