// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { AutoCycleDeliveryMode, AutoCyclePathClass } from "../contracts.js";
import { fail, kitSeal, rejectCredentials } from "./codec-kit.js";

export const AUTO_CYCLE_PATH_CLASSES = ["repository-read-only", "documentation-write"] as const;
export const AUTO_CYCLE_DELIVERY_MODES = ["none", "local-patch", "local-user-gitlab"] as const;
export function seal<K extends string, D extends string, B extends object>(
  kind: K,
  digestKey: D,
  body: B,
): B & { schemaVersion: 1; kind: K } & Record<D, string> {
  rejectCredentials(body);
  return kitSeal(kind, digestKey, body);
}

export function assertModeCompatible(
  pathClass: AutoCyclePathClass,
  deliveryMode: AutoCycleDeliveryMode,
): void {
  if (
    (pathClass === "repository-read-only" && deliveryMode !== "none") ||
    (pathClass === "documentation-write" && deliveryMode === "none")
  )
    fail("invalid-value");
}

export function deliveryRank(value: AutoCycleDeliveryMode): number {
  return AUTO_CYCLE_DELIVERY_MODES.indexOf(value);
}
