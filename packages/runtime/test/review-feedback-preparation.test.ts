// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { prepareReviewFeedback } from "../src/review-delivery/feedback-preparation.js";
import { fixture } from "./fixtures/review-delivery/presentation/synthetic.js";
import type { ReviewFindingV1, ReviewResultV3 } from "../src/review/contracts.js";

function editorialFixture() {
  const seed = fixture("gitlab");
  const result = seed.result as ReviewResultV3;
  const original = result.issues[0]!;
  const source = result.sourceContexts[0]!;
  const ids = ["ED-005", "ED-006", "ED-007", "PREF-008"];
  const issues = ids.map((id, index) => ({
    ...original,
    id: `issue:${id}`,
    originalId: id,
    category: "editorial",
    finding: `${id} editorial finding`,
    requiredChange: `${id} correction`,
    evidence: { sourceId: `style:${id}`, locator: "docs/guide.md:1" },
    factRefs: [{ dimensionIndex: 0, factIndex: index }],
  }));
  const context = {
    ...source,
    dimensions: [
      {
        ...source.dimensions[0]!,
        dimension: "style-guide",
        facts: ids.map((id) => ({
          ...source.dimensions[0]!.facts[0]!,
          id: `fact:${id}`,
          dimension: "style-guide",
          issueIds: [id],
        })),
      },
    ],
  };
  return fixture("gitlab", "addition", { issues, contexts: [context], findings: [] });
}

describe("scenario review feedback preparation", () => {
  it("uses the same preparation capability for a GitHub review", () => {
    const prepared = prepareReviewFeedback(fixture("github"), { scenario: "audit" });
    expect(prepared.rows).toHaveLength(2);
    expect(prepared.rows.every((row) => row.disposition.kind === "post")).toBe(true);
    expect(prepared.placement.plan.actions.map((action) => action.kind)).toEqual([
      "publish-summary",
    ]);
    expect(prepared.publicationConfirmed).toBe(false);
  });

  it("makes three distinct plans while accounting for every retained editorial issue", () => {
    const input = editorialFixture();
    const basisByInventoryId = Object.fromEntries(
      ["ED-005", "ED-006", "ED-007"].map((id, index) => [
        `issue:${index}:issue:${id}`,
        {
          kind: "mandatory-rule",
          reason: "Cited style-guide rule applies to this changed page.",
          sourceId: `style:${id}`,
          locator: "docs/guide.md:1",
        },
      ]),
    ) as Record<
      string,
      { kind: "mandatory-rule"; reason: string; sourceId: string; locator: string }
    >;
    const plans = (["pr-review", "editorial-coaching", "audit"] as const).map((scenario) =>
      prepareReviewFeedback(input, { scenario, basisByInventoryId }),
    );
    for (const prepared of plans) {
      expect(prepared.publicationConfirmed).toBe(false);
      expect(prepared.placement.manifest.publicationConfirmed).toBe(false);
      expect(prepared.rows).toHaveLength(4);
      expect(prepared.rows.map((row) => row.presentation.producerOriginalId)).toEqual([
        "ED-005",
        "ED-006",
        "ED-007",
        "PREF-008",
      ]);
      for (const row of prepared.rows) {
        expect(row.disposition.reason).not.toBe("");
        expect(row.finding.retained.resultSha256).toBe(
          (input.result as ReviewResultV3).resultSha256,
        );
        expect(row.presentation.evidence).toEqual(row.finding.evidence);
      }
      expect(prepared.rows.slice(0, 3).map((row) => row.basis.kind)).toEqual([
        "mandatory-rule",
        "mandatory-rule",
        "mandatory-rule",
      ]);
      expect(prepared.rows[3]?.basis.kind).toBe("unknown");
    }
    expect(plans[0]?.placement.plan.actions.map((action) => action.kind)).toEqual([
      "publish-inline",
      "publish-inline",
      "publish-inline",
      "publish-inline",
    ]);
    expect(plans[1]?.placement.plan.actions.map((action) => action.kind)).toEqual([
      "publish-summary",
      "publish-inline",
      "publish-inline",
      "publish-inline",
    ]);
    expect(plans[2]?.placement.plan.actions.map((action) => action.kind)).toEqual([
      "publish-summary",
    ]);
  });

  it("keeps every finding accounted for under summary-only and overview intent", () => {
    const input = editorialFixture();
    const summary = prepareReviewFeedback(
      { ...input, requestedActions: "summary-only" },
      { scenario: "pr-review" },
    );
    expect(summary.placement.plan.requestedActions).toBe("summary-only");
    expect(summary.placement.plan.actions).toHaveLength(1);
    expect(summary.placement.plan.actions[0]).toMatchObject({
      kind: "publish-summary",
      findingIds: summary.rows.map((row) => row.finding.inventoryId),
    });
    expect(summary.rows.map((row) => row.disposition.kind)).toEqual([
      "post",
      "post",
      "post",
      "post",
    ]);
    for (const row of summary.rows) expect(row.presentation.evidence).toEqual(row.finding.evidence);

    const overviewAudit = prepareReviewFeedback(
      { ...input, requestedActions: "overview" },
      { scenario: "audit" },
    );
    expect(overviewAudit.placement.plan.requestedActions).toBe("overview");
    expect(overviewAudit.placement.plan.actions.map((action) => action.kind)).toEqual([
      "publish-summary",
    ]);
    expect(overviewAudit.rows).toHaveLength(summary.rows.length);
    expect(overviewAudit.rows.every((row) => row.disposition.kind === "post")).toBe(true);
    expect(overviewAudit.publicationConfirmed).toBe(false);
  });

  it("records evidence-backed dismissal and explicit deferral without silent deletion", () => {
    const input = editorialFixture();
    const prepared = prepareReviewFeedback(input, {
      scenario: "pr-review",
      overrideByInventoryId: {
        "issue:0:issue:ED-005": {
          kind: "defer",
          reason: "Hold until the cited rule is checked against the target version.",
        },
        "issue:3:issue:PREF-008": {
          kind: "dismiss",
          reason: "The cited text is only an unsupported preference.",
          evidence: { sourceId: "style:PREF-008", locator: "docs/guide.md:1" },
        },
      },
    });
    expect(prepared.rows.map((row) => row.disposition.kind)).toEqual([
      "defer",
      "post",
      "post",
      "dismiss",
    ]);
    expect(prepared.placement.plan.actions).toHaveLength(2);
    expect(prepared.rows).toHaveLength(4);
    expect(() =>
      prepareReviewFeedback(input, {
        scenario: "pr-review",
        overrideByInventoryId: {
          "issue:3:issue:PREF-008": { kind: "dismiss", reason: "Just style." },
        },
      }),
    ).toThrow(/matching retained evidence/u);
    expect(() =>
      prepareReviewFeedback(input, {
        scenario: "pr-review",
        basisByInventoryId: {
          "issue:0:issue:ED-005": {
            kind: "mandatory-rule",
            reason: "Rule applies",
            sourceId: "invented",
            locator: "other",
          },
        },
      }),
    ).toThrow(/matching retained evidence/u);
  });

  it("groups with a final publishable peer sharing retained action and evidence", () => {
    const seed = fixture("gitlab");
    const result = seed.result as ReviewResultV3;
    const first = result.issues[0]!;
    const context = result.sourceContexts[0]!;
    const second = { ...first, id: "issue:peer", originalId: "TECH-PEER" };
    const third = { ...first, id: "issue:peer:third", originalId: "TECH-PEER-2" };
    const sharedContext = {
      ...context,
      dimensions: [
        {
          ...context.dimensions[0]!,
          facts: [
            {
              ...context.dimensions[0]!.facts[0]!,
              issueIds: [first.originalId, second.originalId, third.originalId],
            },
          ],
        },
      ],
    };
    const input = fixture("gitlab", "addition", {
      issues: [first, second, third],
      contexts: [sharedContext],
      findings: [],
    });
    const prepared = prepareReviewFeedback(input, {
      scenario: "pr-review",
      overrideByInventoryId: {
        "issue:1:issue:peer": {
          kind: "group",
          reason: "Same complete correction and retained evidence.",
        },
      },
    });
    expect(prepared.rows[1]?.disposition).toMatchObject({
      kind: "group",
      representativeId: prepared.rows[0]?.finding.inventoryId,
      actionId: prepared.rows[0]?.presentation.plannedActionId,
    });
    expect(prepared.rows[1]?.presentation.plannedActionId).not.toBe(
      prepared.rows[0]?.presentation.plannedActionId,
    );
    expect(prepared.rows[0]?.presentation.producerOriginalId).toBe(first.originalId);
    expect(prepared.rows[1]?.presentation.producerOriginalId).toBe(second.originalId);

    const withDeferredBaselineRepresentative = prepareReviewFeedback(input, {
      scenario: "pr-review",
      overrideByInventoryId: {
        "issue:0:issue:1": {
          kind: "defer",
          reason: "Hold this representative until its source is checked.",
        },
        "issue:1:issue:peer": {
          kind: "group",
          reason: "Same complete correction and retained evidence.",
        },
      },
    });
    expect(withDeferredBaselineRepresentative.rows[1]?.disposition).toMatchObject({
      kind: "group",
      representativeId: withDeferredBaselineRepresentative.rows[2]?.finding.inventoryId,
      actionId: withDeferredBaselineRepresentative.rows[2]?.presentation.plannedActionId,
    });
    expect(() =>
      prepareReviewFeedback(input, {
        scenario: "pr-review",
        overrideByInventoryId: {
          "issue:0:issue:1": { kind: "defer", reason: "Hold the first peer." },
          "issue:1:issue:peer": { kind: "group", reason: "Group the remaining finding." },
          "issue:2:issue:peer:third": { kind: "defer", reason: "Hold the third peer." },
        },
      }),
    ).toThrow(/publishable peer/u);
  });

  it("retains a large inventory without a selection cutoff", () => {
    const seed = editorialFixture();
    const result = seed.result as ReviewResultV3;
    const original = result.issues[0]!;
    const source = result.sourceContexts[0]!;
    const issues = Array.from({ length: 42 }, (_, index) => ({
      ...original,
      id: `issue:many:${index}`,
      originalId: `ED-${index}`,
      finding: `Finding ${index}`,
      requiredChange: `Correction ${index}`,
      factRefs: [{ dimensionIndex: 0, factIndex: index }],
    }));
    const context = {
      ...source,
      dimensions: [
        {
          ...source.dimensions[0]!,
          facts: issues.map((issue, index) => ({
            ...source.dimensions[0]!.facts[0]!,
            id: `fact:${index}`,
            issueIds: [issue.originalId],
          })),
        },
      ],
    };
    const prepared = prepareReviewFeedback(
      fixture("gitlab", "addition", { issues, contexts: [context], findings: [] }),
      { scenario: "audit" },
    );
    expect(prepared.rows).toHaveLength(42);
    expect(prepared.placement.plan.actions[0]?.kind).toBe("publish-summary");
    expect(prepared.rows.every((row) => row.disposition.kind === "post")).toBe(true);
  });

  it("keeps unverified rule applicability qualified", () => {
    const seed = editorialFixture();
    const result = seed.result as ReviewResultV3;
    const context = result.sourceContexts[0]!;
    const input = fixture("gitlab", "addition", {
      issues: result.issues,
      contexts: [
        {
          ...context,
          dimensions: [
            { ...context.dimensions[0]!, status: "unverified", reason: "Rule version unknown" },
          ],
        },
      ],
      findings: [],
    });
    const prepared = prepareReviewFeedback(input, { scenario: "editorial-coaching" });
    expect(prepared.rows[0]?.basis.kind).toBe("unknown");
    expect(prepared.rows[0]?.presentation.uncertainty).toContain(
      "unverified:style-guide:Rule version unknown",
    );
    expect(() =>
      prepareReviewFeedback(input, {
        scenario: "editorial-coaching",
        basisByInventoryId: {
          "issue:0:issue:ED-005": {
            kind: "mandatory-rule",
            reason: "Claimed applicable rule",
            sourceId: "style:ED-005",
            locator: "docs/guide.md:1",
          },
        },
      }),
    ).toThrow(/unverified applicability/u);
  });

  it("never promotes a retained-only placement into a scenario post", () => {
    const seed = fixture("gitlab");
    const original = (seed.result as ReviewResultV3).findings[0]!;
    const { recommendation: _unused, ...withoutAction } = original;
    const input = fixture("gitlab", "addition", {
      issues: [],
      contexts: [],
      findings: [withoutAction as ReviewFindingV1],
      summary: false,
    });
    for (const scenario of ["audit", "editorial-coaching"] as const) {
      const prepared = prepareReviewFeedback(input, { scenario });
      expect(prepared.rows).toHaveLength(1);
      expect(prepared.rows[0]?.disposition.kind).toBe("defer");
      expect(prepared.rows[0]?.presentation.reason).toBe("action-unavailable");
      expect(prepared.placement.plan.actions).toHaveLength(0);
    }
  });

  it("rejects mismatched retained evidence before any scenario action is planned", () => {
    const input = editorialFixture();
    const result = input.result as ReviewResultV3;
    const broken = {
      ...input,
      result: {
        ...result,
        issues: [{ ...result.issues[0]!, originalId: "ED-OTHER" }, ...result.issues.slice(1)],
      },
    };
    expect(() => prepareReviewFeedback(broken, { scenario: "audit" })).toThrow();
    expect(() => prepareReviewFeedback(broken, { scenario: "editorial-coaching" })).toThrow();
  });
});
