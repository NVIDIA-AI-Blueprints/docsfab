// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import type { ReviewDeliveryFinding } from "../src/review-delivery/contracts.js";
import {
  planReviewRevisionsV1,
  type OfflineRevisionInputV1,
} from "../src/review-delivery/reconcile.js";

function finding(
  id: string,
  text = "Keep the qualifier when repairing the command.",
): ReviewDeliveryFinding {
  return {
    inventoryId: id,
    logicalIssueId: "issue:TECH-1",
    observationId: `observation:${id}`,
    source: "issue",
    sourceIndex: 0,
    retained: { resultSha256: "retained-result", collection: "issues", index: 0 },
    originalId: "TECH-1",
    severity: "warning",
    text,
    path: "docs/guide.md",
    relatedLocations: [],
    groupIds: [],
    limitations: ["partial scope is retained"],
    sourceContextId: "source-context",
    evidence: { sourceId: "source", locator: "guide:command" },
    disposition: { kind: "summary-candidate", reason: "no-location" },
  };
}

function input(): OfflineRevisionInputV1 {
  return {
    before: {
      reviewRef: "old",
      targetRef: "target",
      sourceRef: "old-source",
      findings: [finding("old-item")],
    },
    after: {
      reviewRef: "new",
      targetRef: "target",
      sourceRef: "new-source",
      findings: [finding("new-item")],
    },
    links: [
      {
        kind: "synthetic-continuity",
        beforeReviewRef: "old",
        afterReviewRef: "new",
        earlierInventoryId: "old-item",
        laterInventoryId: "new-item",
        relation: "rename",
      },
    ],
    rechecks: [
      {
        kind: "synthetic-recheck",
        beforeReviewRef: "old",
        afterReviewRef: "new",
        earlierInventoryId: "old-item",
        outcome: "persists",
        coverage: "complete",
        source: "available",
        check: "succeeded",
      },
    ],
    dispositions: [],
    changeState: "open",
  };
}

describe("offline revision planning", () => {
  it("associates an explicitly synthetic rename and retains complete inventory without effects", () => {
    const original = input();
    const result = planReviewRevisionsV1(original);
    expect(result.decisions[0]).toMatchObject({
      status: "persists",
      technicalStatus: "persists",
      laterInventoryIds: ["new-item"],
    });
    expect(result.current[0]).toMatchObject({ inventoryId: "new-item", disposition: "associated" });
    expect(result.before).toEqual(original.before);
    expect(result.after).toEqual(original.after);
    expect(result.evidence).toBe("synthetic-inputs-only");
    expect(result.dispatch).toBe("unavailable");
    expect(Object.isFrozen(result.decisions)).toBe(true);
    expect(Object.isFrozen(original)).toBe(false);
    expect(Object.isFrozen(original.before.findings)).toBe(false);
    expect(result.links).toEqual(original.links);
    expect(result.rechecks).toEqual(original.rechecks);
    expect(result.dispositions).toEqual(original.dispositions);
  });

  it.each(["same-location", "move"] as const)(
    "accepts an explicit synthetic %s relation despite different producer labels",
    (relation) => {
      const original = input();
      const result = planReviewRevisionsV1({
        ...original,
        after: {
          ...original.after,
          findings: [
            { ...finding("new-item"), logicalIssueId: "different-producer-id" },
            finding("unrelated"),
          ],
        },
        links: [{ ...original.links[0]!, relation }],
      });
      expect(result.decisions[0]?.technicalStatus).toBe("persists");
      expect(result.current.map((row) => row.disposition)).toEqual(["associated", "new"]);
      expect(result.after.findings).toHaveLength(2);
    },
  );

  it("never treats equal canonical IDs or repeated prose as continuity", () => {
    const original = input();
    const result = planReviewRevisionsV1({ ...original, links: [], rechecks: [] });
    expect(result.decisions[0]).toMatchObject({ status: "unverified", laterInventoryIds: [] });
    expect(result.decisions[0]?.reasons).toContain("source-relation-unavailable");
    expect(result.current[0]?.disposition).toBe("new");
    expect(result.after.findings[0]?.logicalIssueId).toBe(
      result.before.findings[0]?.logicalIssueId,
    );
  });

  it("retains competing and explicitly ambiguous mappings instead of selecting one", () => {
    const original = input();
    const second = finding("copy", "The identical defect appears again.");
    const result = planReviewRevisionsV1({
      ...original,
      after: { ...original.after, findings: [...original.after.findings, second] },
      links: [...original.links, { ...original.links[0]!, laterInventoryId: "copy" }],
    });
    expect(result.decisions[0]?.status).toBe("unverified");
    expect(result.decisions[0]?.reasons).toContain("lineage-ambiguous");
    expect(result.current.map((row) => row.disposition)).toEqual(["ambiguous", "ambiguous"]);
    expect(result.decisions[0]?.candidateInventoryIds).toEqual(["new-item", "copy"]);
    const ambiguous = planReviewRevisionsV1({
      ...original,
      links: [{ ...original.links[0]!, relation: "ambiguous" }],
    });
    expect(ambiguous.decisions[0]?.reasons).toContain("lineage-ambiguous");
  });

  it("rejects a many-to-one association and a link bound to another review", () => {
    const original = input();
    const result = planReviewRevisionsV1({
      ...original,
      before: { ...original.before, findings: [...original.before.findings, finding("other-old")] },
      links: [...original.links, { ...original.links[0]!, earlierInventoryId: "other-old" }],
    });
    expect(result.decisions.every((row) => row.reasons.includes("lineage-ambiguous"))).toBe(true);
    const changed = planReviewRevisionsV1({
      ...original,
      links: [{ ...original.links[0]!, afterReviewRef: "foreign-review" }],
    });
    expect(changed.decisions[0]?.reasons).toContain("binding-mismatch");
    expect(changed.decisions[0]?.laterInventoryIds).toEqual([]);
  });

  it.each(["partial", "unknown"] as const)(
    "does not infer a fix from absence under %s coverage",
    (coverage) => {
      const original = input();
      const result = planReviewRevisionsV1({
        ...original,
        after: { ...original.after, findings: [] },
        links: [],
        rechecks: [{ ...original.rechecks[0]!, outcome: "repair", coverage }],
      });
      expect(result.decisions[0]?.status).toBe("unverified");
      expect(result.decisions[0]?.reasons).toContain("coverage-incomplete");
    },
  );

  it("distinguishes a synthetic successful old-obligation recheck from mere absence", () => {
    const original = input();
    const absent = { ...original, after: { ...original.after, findings: [] }, links: [] };
    expect(planReviewRevisionsV1({ ...absent, rechecks: [] }).decisions[0]?.status).toBe(
      "unverified",
    );
    for (const [outcome, status] of [
      ["repair", "fixed"],
      ["obsolete", "obsolete"],
    ] as const) {
      expect(
        planReviewRevisionsV1({ ...absent, rechecks: [{ ...original.rechecks[0]!, outcome }] })
          .decisions[0]?.status,
      ).toBe(status);
    }
  });

  it.each([
    ["stale-before", "repair", "fixed"],
    ["stale-before", "obsolete", "obsolete"],
    ["stale-after", "repair", "fixed"],
    ["stale-after", "obsolete", "obsolete"],
    ["missing-current", "repair", "fixed"],
    ["missing-current", "obsolete", "obsolete"],
  ] as const)(
    "retains a %s continuity row while an independently bound %s recheck projects %s",
    (invalid, outcome, technicalStatus) => {
      const original = input();
      const link = {
        ...original.links[0]!,
        ...(invalid === "stale-before"
          ? { beforeReviewRef: "stale" }
          : invalid === "stale-after"
            ? { afterReviewRef: "stale" }
            : { laterInventoryId: "missing" }),
      };
      const result = planReviewRevisionsV1({
        ...original,
        links: [link],
        rechecks: [{ ...original.rechecks[0]!, outcome }],
      });
      expect(result.decisions[0]).toMatchObject({
        technicalStatus,
        status: technicalStatus,
        laterInventoryIds: [],
      });
      expect(result.decisions[0]?.reasons).toContain("binding-mismatch");
      expect(result.decisions[0]?.reasons).not.toContain("recheck-conflict");
      expect(result.links).toEqual([link]);
      expect(result.before).toEqual(original.before);
      expect(result.after).toEqual(original.after);
      expect(result.dispatch).toBe("unavailable");
    },
  );

  it.each(["repair", "obsolete"] as const)(
    "retains a real current continuity conflict with a %s recheck",
    (outcome) => {
      const original = input();
      const result = planReviewRevisionsV1({
        ...original,
        rechecks: [{ ...original.rechecks[0]!, outcome }],
      });
      expect(result.decisions[0]?.technicalStatus).toBe("unverified");
      expect(result.decisions[0]?.reasons).toContain("recheck-conflict");
      expect(result.decisions[0]?.laterInventoryIds).toEqual(["new-item"]);
    },
  );

  it.each(["stale", "partial", "unavailable"] as const)(
    "keeps a %s recheck unverified alongside an invalid continuity row",
    (invalid) => {
      const original = input();
      for (const outcome of ["repair", "obsolete"] as const) {
        const recheck = {
          ...original.rechecks[0]!,
          outcome,
          ...(invalid === "stale"
            ? { afterReviewRef: "stale" }
            : invalid === "partial"
              ? { coverage: "partial" as const }
              : { check: "unavailable" as const }),
        };
        const result = planReviewRevisionsV1({
          ...original,
          links: [{ ...original.links[0]!, laterInventoryId: "missing" }],
          rechecks: [recheck],
        });
        expect(result.decisions[0]?.technicalStatus).toBe("unverified");
        expect(result.decisions[0]?.reasons).toContain(
          invalid === "stale"
            ? "binding-mismatch"
            : invalid === "partial"
              ? "coverage-incomplete"
              : "recheck-unavailable",
        );
      }
    },
  );

  it.each(["failed", "unavailable"] as const)(
    "retains unavailable conclusions after a %s check",
    (check) => {
      const original = input();
      const result = planReviewRevisionsV1({
        ...original,
        rechecks: [{ ...original.rechecks[0]!, outcome: "repair", check }],
      });
      expect(result.decisions[0]?.status).toBe("unverified");
      expect(result.decisions[0]?.reasons).toContain("recheck-unavailable");
    },
  );

  it("retains inaccessible sources, contradictory rechecks and duplicate recheck evidence", () => {
    const original = input();
    expect(
      planReviewRevisionsV1({
        ...original,
        rechecks: [{ ...original.rechecks[0]!, source: "inaccessible" }],
      }).decisions[0]?.reasons,
    ).toContain("recheck-unavailable");
    expect(
      planReviewRevisionsV1({
        ...original,
        rechecks: [{ ...original.rechecks[0]!, outcome: "repair" }],
      }).decisions[0]?.reasons,
    ).toContain("recheck-conflict");
    expect(
      planReviewRevisionsV1({
        ...original,
        rechecks: [...original.rechecks, original.rechecks[0]!],
      }).decisions[0]?.reasons,
    ).toContain("recheck-ambiguous");
  });

  it("retains unavailable source relations and rechecks bound to another review", () => {
    const original = input();
    const unavailable = planReviewRevisionsV1({
      ...original,
      links: [{ ...original.links[0]!, relation: "unavailable" }],
    });
    expect(unavailable.decisions[0]).toMatchObject({ status: "unverified", laterInventoryIds: [] });
    expect(unavailable.decisions[0]?.reasons).toContain("source-relation-unavailable");
    const stale = planReviewRevisionsV1({
      ...original,
      rechecks: [{ ...original.rechecks[0]!, afterReviewRef: "foreign" }],
    });
    expect(stale.decisions[0]?.technicalStatus).toBe("unverified");
    expect(stale.decisions[0]?.reasons).toContain("binding-mismatch");
    expect(stale.rechecks[0]?.afterReviewRef).toBe("foreign");
  });

  it.each(["deferred", "author-dismissed"] as const)(
    "keeps %s separate from technical persistence and retains the exact reason",
    (disposition) => {
      const original = input();
      const result = planReviewRevisionsV1({
        ...original,
        dispositions: [
          {
            kind: "synthetic-disposition",
            beforeReviewRef: "old",
            afterReviewRef: "new",
            earlierInventoryId: "old-item",
            disposition,
            reason: "Intentional for this release only.",
            actorRef: "author",
            scopeRef: "this-issue-only",
          },
        ],
      });
      expect(result.decisions[0]).toMatchObject({
        status: disposition,
        technicalStatus: "persists",
        disposition: { reason: "Intentional for this release only.", scopeRef: "this-issue-only" },
      });
    },
  );

  it("retains stale, ambiguous and incomplete human decisions without inventing dismissal", () => {
    const original = input();
    const disposition = {
      kind: "synthetic-disposition",
      beforeReviewRef: "old",
      afterReviewRef: "new",
      earlierInventoryId: "old-item",
      disposition: "deferred",
      reason: "release",
      actorRef: "author",
      scopeRef: "issue",
    } as const;
    expect(
      planReviewRevisionsV1({ ...original, dispositions: [disposition, disposition] }).decisions[0]
        ?.reasons,
    ).toContain("disposition-ambiguous");
    expect(
      planReviewRevisionsV1({ ...original, dispositions: [{ ...disposition, reason: " " }] })
        .decisions[0]?.reasons,
    ).toContain("disposition-unavailable");
    expect(
      planReviewRevisionsV1({
        ...original,
        dispositions: [{ ...disposition, afterReviewRef: "older" }],
      }).decisions[0]?.reasons,
    ).toContain("binding-mismatch");
  });

  it.each(["closed", "merged", "unknown"] as const)(
    "keeps the %s change read-only without changing technical history",
    (changeState) => {
      const original = input();
      const result = planReviewRevisionsV1({ ...original, changeState });
      expect(result.decisions[0]?.technicalStatus).toBe("persists");
      expect(result.limitations).toContain("change-terminal");
      expect(result.dispatch).toBe("unavailable");
    },
  );

  it("retains foreign-target inputs and duplicate inventory IDs with explicit limitations", () => {
    const original = input();
    const changed = planReviewRevisionsV1({
      ...original,
      after: { ...original.after, targetRef: "foreign" },
    });
    expect(changed.decisions[0]?.status).toBe("unverified");
    expect(changed.limitations).toContain("binding-mismatch");
    const duplicate = planReviewRevisionsV1({
      ...original,
      after: { ...original.after, findings: [finding("new-item"), finding("new-item")] },
    });
    expect(duplicate.limitations).toContain("inventory-ambiguous");
    expect(duplicate.after.findings).toHaveLength(2);
    const duplicateOld = planReviewRevisionsV1({
      ...original,
      before: { ...original.before, findings: [finding("old-item"), finding("old-item")] },
    });
    expect(duplicateOld.decisions).toHaveLength(2);
    expect(duplicateOld.decisions.every((row) => row.status === "unverified")).toBe(true);
  });
});
