// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { releaseDocumentationSearchPlan } from "../release-documentation-rubric.js";
import { deepFreeze } from "../contract-kit/freeze.js";

/** Governed host search plan; the runnable step is declared by its Pin-A manifest. */
export const releaseDocumentationReadinessSearch = deepFreeze(releaseDocumentationSearchPlan());
