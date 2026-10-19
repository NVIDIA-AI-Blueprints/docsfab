// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { deepFreeze } from "../contract-kit/index.js";
import type {
  OfflineHumanDispositionV1,
  OfflineRevisionStatusV1,
  OfflineTechnicalStatusV1,
} from "./reconcile.js";

/** Descriptive offline events; neither native ownership nor accepted-review authority. */
export interface OfflineReviewThreadEventV1 {
  readonly kind: "synthetic-thread-observation";
  readonly reviewRef: string;
  readonly lineageRef: string;
  readonly status: OfflineRevisionStatusV1;
  readonly technicalStatus: OfflineTechnicalStatusV1;
  readonly disposition: OfflineHumanDispositionV1 | null;
  readonly retainedRefs: readonly string[];
  readonly native: {
    readonly threadRef: string;
    readonly state: "resolved" | "unresolved" | "outdated" | "unknown";
    readonly ownership: "owned" | "foreign" | "unknown";
    readonly replies: readonly {
      readonly id: string;
      readonly actorRef: string;
      readonly body: string;
      readonly ownership: "human" | "reviewer";
    }[];
  };
}
interface OfflineThreadStateInputV1 {
  readonly events: readonly OfflineReviewThreadEventV1[];
  readonly view: { readonly kind: "synthetic-selected-review"; readonly reviewRef: string } | null;
}
export interface OfflineReviewThreadStateV1 {
  readonly kind: "offline-review-thread-state";
  readonly evidence: "synthetic-inputs-only";
  readonly dispatch: "unavailable";
  readonly view: OfflineThreadStateInputV1["view"];
  readonly history: readonly OfflineReviewThreadEventV1[];
  readonly current: readonly {
    readonly lineageRef: string;
    readonly status: OfflineRevisionStatusV1;
    readonly technicalStatus: OfflineTechnicalStatusV1;
    readonly disposition: OfflineHumanDispositionV1 | null;
    readonly nativeState: OfflineReviewThreadEventV1["native"]["state"];
    readonly retainedRefs: readonly string[];
    readonly reasons: readonly string[];
  }[];
  readonly limitations: readonly string[];
}

/** Projects an explicitly described selection, never arrival order or a durable CAS. */
export function projectReviewThreadStateV1(
  original: OfflineThreadStateInputV1,
): OfflineReviewThreadStateV1 {
  const input = structuredClone(original);
  const groups = new Map<string, OfflineReviewThreadEventV1[]>();
  const limitations = ["lifecycle-contract-unavailable"];
  if (!input.view) limitations.push("accepted-view-unavailable");
  for (const event of input.events) {
    if (!input.view || event.reviewRef !== input.view.reviewRef) continue;
    const group = groups.get(event.lineageRef) ?? [];
    group.push(event);
    groups.set(event.lineageRef, group);
  }
  if (input.view && groups.size === 0) limitations.push("selected-review-unavailable");
  const current = [...groups].map(([lineageRef, events]) => {
    const event = events[0]!;
    const ambiguous = events.length !== 1;
    const reasons = ["lifecycle-contract-unavailable"];
    if (ambiguous) reasons.push("thread-history-ambiguous");
    if (events.some((row) => row.native.ownership !== "owned")) reasons.push("foreign-or-unproven");
    return {
      lineageRef,
      status: ambiguous ? ("unverified" as const) : event.status,
      technicalStatus: ambiguous ? ("unverified" as const) : event.technicalStatus,
      disposition: ambiguous ? null : event.disposition,
      nativeState: ambiguous ? ("unknown" as const) : event.native.state,
      retainedRefs: events.flatMap((row) => row.retainedRefs),
      reasons,
    };
  });
  return deepFreeze({
    kind: "offline-review-thread-state",
    evidence: "synthetic-inputs-only",
    dispatch: "unavailable",
    view: input.view,
    history: input.events,
    current,
    limitations,
  });
}
