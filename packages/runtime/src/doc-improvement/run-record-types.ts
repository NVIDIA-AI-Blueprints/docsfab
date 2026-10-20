// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { SkillEvidence } from "../records/contracts.js";

export interface RunEvidenceSummary {
  id: string;
  recordSha256: string;
  workflow: "review-documentation" | "update-documentation";
  status: "succeeded";
  createdAt: string;
  startedAt: string;
  completedAt: string;
  skills: Array<Pick<SkillEvidence, "id" | "contentSha256"> & { bundleSha256?: string }>;
  models: Array<{
    provider: string;
    model: string;
    profileStatus: "current" | "stale" | "unknown";
    profileSha256: string;
  }>;
}
