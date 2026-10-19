// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
  projectReviewThreadStateV1,
  type OfflineReviewThreadEventV1,
} from "../src/review-delivery/thread-state.js";

function event(reviewRef = "new"): OfflineReviewThreadEventV1 {
  return {
    kind: "synthetic-thread-observation",
    reviewRef,
    lineageRef: "existing-lineage-reference",
    status: "unverified",
    technicalStatus: "unverified",
    disposition: null,
    retainedRefs: ["retained-finding", "complete-advice", "qualifier"],
    native: {
      threadRef: "thread",
      state: "outdated",
      ownership: "owned",
      replies: [
        {
          id: "human-reply",
          actorRef: "author",
          body: "Keep this qualification.",
          ownership: "human",
        },
      ],
    },
  };
}
const view = { kind: "synthetic-selected-review", reviewRef: "new" } as const;

describe("offline review thread state", () => {
  it("retains full history and human replies while selecting the described review rather than last arrival", () => {
    const current = event();
    const old = { ...event("old"), status: "fixed", technicalStatus: "fixed" } as const;
    const result = projectReviewThreadStateV1({ events: [current, old], view });
    expect(result.current[0]).toMatchObject({ status: "unverified", nativeState: "outdated" });
    expect(result.history).toEqual([current, old]);
    expect(result.history[0]?.native.replies[0]?.body).toBe("Keep this qualification.");
    expect(result.evidence).toBe("synthetic-inputs-only");
    expect(result.dispatch).toBe("unavailable");
    expect(Object.isFrozen(result.history[0]?.native.replies)).toBe(true);
    expect(Object.isFrozen(current)).toBe(false);
  });

  it.each(["resolved", "unresolved", "outdated", "unknown"] as const)(
    "does not interpret native %s as verified repair",
    (state) => {
      const result = projectReviewThreadStateV1({
        events: [{ ...event(), native: { ...event().native, state } }],
        view,
      });
      expect(result.current[0]?.technicalStatus).toBe("unverified");
      expect(result.current[0]?.nativeState).toBe(state);
      expect(result.current[0]?.retainedRefs).toEqual(event().retainedRefs);
    },
  );

  it("keeps a human dismissal distinct from a synthetic technical repair", () => {
    const result = projectReviewThreadStateV1({
      events: [
        {
          ...event(),
          status: "author-dismissed",
          technicalStatus: "fixed",
          disposition: {
            kind: "author-dismissed",
            reason: "Intentional.",
            actorRef: "author",
            scopeRef: "issue",
          },
        },
      ],
      view,
    });
    expect(result.current[0]).toMatchObject({
      status: "author-dismissed",
      technicalStatus: "fixed",
      disposition: { reason: "Intentional." },
    });
  });

  it("does not adopt foreign or unproven native ownership or turn unsupported state into resolved", () => {
    for (const ownership of ["foreign", "unknown"] as const) {
      const result = projectReviewThreadStateV1({
        events: [{ ...event(), native: { ...event().native, ownership } }],
        view,
      });
      expect(result.current[0]?.reasons).toContain("foreign-or-unproven");
      expect(result.current[0]?.nativeState).toBe("outdated");
      expect(result.history[0]?.native.replies).toEqual(event().native.replies);
    }
    expect(projectReviewThreadStateV1({ events: [event()], view }).current[0]?.reasons).toContain(
      "lifecycle-contract-unavailable",
    );
  });

  it("retains conflicting current events without last-write-wins or dropping an event", () => {
    const conflicting = { ...event(), status: "fixed", technicalStatus: "fixed" } as const;
    const result = projectReviewThreadStateV1({ events: [event(), conflicting], view });
    expect(result.current[0]).toMatchObject({
      status: "unverified",
      technicalStatus: "unverified",
      nativeState: "unknown",
    });
    expect(result.current[0]?.reasons).toContain("thread-history-ambiguous");
    expect(result.history).toHaveLength(2);
    expect(result.current[0]?.retainedRefs).toEqual([
      ...event().retainedRefs,
      ...conflicting.retainedRefs,
    ]);
  });

  it("projects every selected lineage and retains unrelated older history", () => {
    const other = { ...event(), lineageRef: "second-lineage" };
    const old = event("old");
    const result = projectReviewThreadStateV1({ events: [event(), old, other], view });
    expect(result.current.map((row) => row.lineageRef)).toEqual([
      "existing-lineage-reference",
      "second-lineage",
    ]);
    expect(result.history).toEqual([event(), old, other]);
  });

  it("does not manufacture an accepted review when the descriptive selection is missing or unmatched", () => {
    const missing = projectReviewThreadStateV1({ events: [event()], view: null });
    expect(missing.current).toEqual([]);
    expect(missing.limitations).toContain("accepted-view-unavailable");
    const absent = projectReviewThreadStateV1({ events: [event("old")], view });
    expect(absent.current).toEqual([]);
    expect(absent.limitations).toContain("selected-review-unavailable");
    expect(absent.history).toHaveLength(1);
  });
});
