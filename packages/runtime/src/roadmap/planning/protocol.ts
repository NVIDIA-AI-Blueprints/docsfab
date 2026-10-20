// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export class RoadmapPlanningError extends Error {
  public constructor(
    public readonly code:
      | "invalid-input"
      | "stale-repository"
      | "stale-tracker"
      | "unsafe-content"
      | "unaccounted-boundary",
    public readonly path: string,
  ) {
    super(`Roadmap planning failed (${code}) at ${path}.`);
    this.name = "RoadmapPlanningError";
  }
}

export function requireCondition(
  condition: unknown,
  code: RoadmapPlanningError["code"],
  path: string,
): asserts condition {
  if (!condition) throw new RoadmapPlanningError(code, path);
}
