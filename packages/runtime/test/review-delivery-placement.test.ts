// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { composeReviewPlacement } from "../src/review-delivery/placement.js";
import { createReviewDeliveryPlan } from "../src/review-delivery/plan.js";
import type { ReviewDeliveryRequestedActions } from "../src/review-delivery/contracts.js";
import { fixture, richFixture } from "./fixtures/review-delivery/presentation/synthetic.js";
import { decodeReviewResultV2 } from "../src/review/index.js";
import type {
  ReviewIssueV3,
  ReviewIssueV4,
  ReviewFindingV1,
  ReviewSourceContextV3,
} from "../src/review/contracts.js";

function repeatedActionFixture(
  provider: "gitlab" | "github",
  capabilities: { summary: boolean; inline: boolean },
  reverse = false,
  anchorCopy = false,
) {
  const seed = fixture(provider);
  const original = (seed.result as { issues: readonly ReviewIssueV3[] }).issues[0]!;
  const context = (seed.result as { sourceContexts: readonly ReviewSourceContextV3[] })
    .sourceContexts[0]!;
  const copy = {
    ...original,
    id: "issue:copy",
    originalId: "TECH-COPY",
    path: anchorCopy ? original.path : null,
    line: anchorCopy ? original.line : null,
    locationFidelity: anchorCopy ? ("exact" as const) : ("unresolved" as const),
  };
  const anchored = { ...original, id: "issue:anchored", originalId: "TECH-ANCHOR" };
  const independent = {
    ...original,
    id: "issue:independent",
    originalId: "TECH-INDEPENDENT",
    sourceContextId: "context:other",
  };
  const sharedFact = {
    ...context.dimensions[0]!.facts[0]!,
    issueIds: ["TECH-COPY", "TECH-ANCHOR"],
  };
  const sharedContext = {
    ...context,
    dimensions: [{ ...context.dimensions[0]!, facts: [sharedFact] }],
  };
  const otherContext = {
    ...context,
    id: "context:other",
    dimensions: [
      { ...context.dimensions[0]!, facts: [{ ...sharedFact, issueIds: ["TECH-INDEPENDENT"] }] },
    ],
  };
  const issues = reverse ? [independent, anchored, copy] : [copy, anchored, independent];
  return fixture(provider, "addition", {
    issues,
    contexts: [sharedContext, otherContext],
    findings: [],
    ...capabilities,
  });
}

describe("review presentation placement", () => {
  it.each(["gitlab", "github"] as const)(
    "preserves exact D1 intent, actions and inventory status for %s plans",
    (provider) => {
      const seed = fixture(provider);
      const legacy = (seed.result as { findings: readonly ReviewFindingV1[] }).findings[0]!;
      const { line: _line, ...unlocatedLegacy } = legacy;
      const cases = [
        {
          name: "empty",
          input: fixture(provider, "addition", { issues: [], contexts: [], findings: [] }),
        },
        { name: "inline", input: fixture(provider, "addition", { findings: [] }) },
        {
          name: "mixed",
          input: fixture(provider, "addition", {
            findings: [{ ...unlocatedLegacy, path: null }],
          }),
        },
      ] as const;
      for (const { name, input } of cases) {
        for (const requestedActions of [undefined, "overview", "summary-only"] as const) {
          const request = {
            ...input,
            ...(requestedActions === undefined ? {} : { requestedActions }),
          };
          const direct = createReviewDeliveryPlan(request);
          let selected = 0;
          const composition = composeReviewPlacement(request, {
            select: (_row, proposed) => {
              selected += 1;
              return proposed;
            },
          });
          const expectedKinds =
            name === "empty"
              ? requestedActions === undefined
                ? []
                : ["publish-summary"]
              : requestedActions === "summary-only"
                ? ["publish-summary"]
                : name === "mixed" || requestedActions === "overview"
                  ? ["publish-summary", "publish-inline"]
                  : ["publish-inline"];
          expect(composition.plan).toEqual(direct);
          expect(composition.plan.actions.map((action) => action.kind)).toEqual(expectedKinds);
          expect(selected).toBe(direct.findings.length);
          expect(composition.manifest.rows.map((row) => row.inventoryId)).toEqual(
            direct.findings.map((row) => row.inventoryId),
          );
          expect(composition.manifest.inventoryStatus).toBe(
            expectedKinds.includes("publish-summary") ? "summary-planned" : "inline-union-only",
          );
          expect(composition.manifest.publicationConfirmed).toBe(false);
          if (requestedActions === undefined)
            expect(composition.plan).not.toHaveProperty("requestedActions");
          else expect(composition.plan.requestedActions).toBe(requestedActions);
          for (const row of composition.manifest.rows) {
            const action = composition.plan.actions.find(
              (entry) => entry.id === row.plannedActionId,
            )!;
            expect(
              action.kind === "publish-inline" ? [action.findingId] : action.findingIds,
            ).toContain(row.inventoryId);
            expect(row.finalDisposition).toEqual(
              direct.findings.find((entry) => entry.inventoryId === row.inventoryId)!.disposition,
            );
          }
        }
      }
    },
  );

  it.each([undefined, "overview", "summary-only"] as const)(
    "accepts an unchanged primitive request across both input spreads: %s",
    (requestedActions) => {
      let reads = 0;
      const composition = composeReviewPlacement({
        ...fixture("gitlab", "addition", { findings: [] }),
        get requestedActions() {
          reads += 1;
          return requestedActions;
        },
      });
      expect(reads).toBe(2);
      expect(composition.plan.requestedActions).toBe(requestedActions);
      expect(composition.manifest.rows).toHaveLength(1);
    },
  );

  it.each([
    [undefined, "overview"],
    [undefined, "summary-only"],
    ["overview", undefined],
    ["overview", "summary-only"],
    ["summary-only", undefined],
    ["summary-only", "overview"],
  ] as const)("refuses request substitution between input spreads: %s to %s", (before, after) => {
    let reads = 0;
    const input = {
      ...fixture("gitlab", "addition", { issues: [], contexts: [], findings: [] }),
      get requestedActions(): ReviewDeliveryRequestedActions | undefined {
        reads += 1;
        return reads === 1 ? before : after;
      },
    };
    expect(() => composeReviewPlacement(input)).toThrow(
      "Review presentation refused because D1 requestedActions changed between plans.",
    );
    expect(reads).toBe(2);
  });

  it("groups only identical complete admitted edits and retains each original row", () => {
    const seed = richFixture("gitlab");
    const issue = (seed.result as { issues: readonly ReviewIssueV4[] }).issues[0]!;
    const context = (seed.result as { sourceContexts: readonly ReviewSourceContextV3[] })
      .sourceContexts[0]!;
    if (issue.rich.status !== "admitted") throw new Error("Expected admitted rich issue");
    const second = {
      ...issue,
      id: "issue:copy",
      originalId: "TECH-COPY",
      rich: { ...issue.rich, title: "Another title", readerConsequence: "Another consequence" },
    };
    const sharedContext = {
      ...context,
      dimensions: context.dimensions.map((dimension) => ({
        ...dimension,
        facts: dimension.facts.map((fact) => ({ ...fact, issueIds: ["TECH-1", "TECH-COPY"] })),
      })),
    };
    const make = (copy: ReviewIssueV4, reverse = false, summary = true) =>
      composeReviewPlacement(
        fixture("gitlab", "addition", {
          issues: reverse ? [copy, issue] : [issue, copy],
          contexts: [sharedContext],
          findings: [],
          summary,
        }),
      );
    const equal = make(second);
    expect(seed.result.schemaVersion).toBe(6);
    expect(equal.manifest.rows).toHaveLength(2);
    expect(equal.manifest.rows[0]?.groupKey).toBe(equal.manifest.rows[1]?.groupKey);
    expect(equal.manifest.rows[0]?.retainedRichSha256).not.toBe(
      equal.manifest.rows[1]?.retainedRichSha256,
    );
    expect(equal.manifest.rows.map((row) => row.producerOriginalId)).toEqual([
      "TECH-1",
      "TECH-COPY",
    ]);
    const reversed = make(second, true);
    expect(new Set(reversed.manifest.rows.map((row) => row.groupKey)).size).toBe(1);
    expect(reversed.manifest.rows[0]?.groupRepresentativeId).toBe(
      reversed.manifest.rows[1]?.groupRepresentativeId,
    );
    const inlineOnly = make(second, false, false);
    expect(
      inlineOnly.plan.actions.filter((action) => action.kind === "publish-inline"),
    ).toHaveLength(2);
    expect(inlineOnly.manifest.rows).toHaveLength(2);
    for (const rich of [
      { ...second.rich, proposedEdit: { kind: "advice" as const, text: "Different advice" } },
      {
        ...second.rich,
        proposedEdit: {
          kind: "replacement" as const,
          text: "Set the documented default explicitly.",
          path: "docs/other.md",
          originalText: "old",
          replacementText: "new",
        },
      },
      {
        ...second.rich,
        grounding: [
          { ...second.rich.grounding[0]!, rationale: "Different rationale" },
          second.rich.grounding[1]!,
        ],
      },
    ]) {
      const independent = make({ ...second, rich });
      expect(independent.manifest.rows[0]?.groupKey).not.toBe(
        independent.manifest.rows[1]?.groupKey,
      );
    }
  });

  it("keeps unavailable reasons, V3 and legacy fallback distinct and rejects malformed V6", () => {
    const seed = richFixture("github");
    const issue = (seed.result as { issues: readonly ReviewIssueV4[] }).issues[0]!;
    const context = (seed.result as { sourceContexts: readonly ReviewSourceContextV3[] })
      .sourceContexts[0]!;
    const unavailableKeys: string[] = [];
    for (const reason of [
      "candidate-absent",
      "link-changed",
      "contradicted",
      "unresolved",
      "source-unavailable",
      "qualification-unproven",
    ] as const) {
      const unavailable = { ...issue, rich: { status: "unavailable" as const, reason } };
      const plan = composeReviewPlacement(
        fixture("github", "addition", { issues: [unavailable], contexts: [context], findings: [] }),
      );
      expect(plan.plan.result.originalResultCanonicalJson).toContain('"schemaVersion":6');
      expect(plan.manifest.rows[0]?.retainedRichSha256).toMatch(/^[a-f0-9]{64}$/u);
      unavailableKeys.push(plan.manifest.rows[0]!.groupKey);
    }
    expect(new Set(unavailableKeys).size).toBe(unavailableKeys.length);
    const { rich: _removed, ...older } = issue;
    const legacy = composeReviewPlacement(
      fixture("github", "addition", { issues: [older], contexts: [context] }),
    );
    expect(legacy.manifest.rows[0]?.retainedRichSha256).toBeNull();
    expect(legacy.manifest.rows[1]?.retainedRichSha256).toBeNull();
    expect(unavailableKeys).not.toContain(legacy.manifest.rows[0]?.groupKey);
    const malformed = { ...seed.result, issues: [older] };
    expect(() => decodeReviewResultV2(malformed)).toThrow(/invalid-shape/u);
    if (issue.rich.status !== "admitted") throw new Error("Expected admitted rich issue");
    for (const ground of [
      { ...issue.rich.grounding[0]!, factId: "wrong" },
      { ...issue.rich.grounding[0]!, qualification: "wrong" },
      { ...issue.rich.grounding[0]!, sourceLocators: ["wrong"] },
    ])
      expect(() =>
        fixture("github", "addition", {
          issues: [
            { ...issue, rich: { ...issue.rich, grounding: [ground, issue.rich.grounding[1]!] } },
          ],
          contexts: [context],
        }),
      ).toThrow(/invalid-value/u);
    const missingReciprocal = {
      ...context,
      dimensions: context.dimensions.map((dimension) => ({
        ...dimension,
        facts: dimension.facts.map((fact) => ({ ...fact, issueIds: [] })),
      })),
    };
    expect(() =>
      fixture("github", "addition", { issues: [issue], contexts: [missingReciprocal] }),
    ).toThrow(/invalid-value/u);
  });
  it("does not collapse rich replacements that change only path or exact span bytes", () => {
    const seed = richFixture("github", {
      kind: "replacement",
      text: "Replace the default.",
      path: "docs/guide.md",
      originalText: "old\r\n",
      replacementText: "new\r\n",
    });
    const issue = seed.result.issues![0] as ReviewIssueV4;
    const context = seed.result.sourceContexts![0]!;
    if (issue.rich.status !== "admitted" || issue.rich.proposedEdit.kind !== "replacement")
      throw new Error("Expected rich replacement");
    const copy = { ...issue, id: "issue:copy", originalId: "TECH-COPY" };
    const sharedContext = {
      ...context,
      dimensions: context.dimensions.map((dimension) => ({
        ...dimension,
        facts: dimension.facts.map((fact) => ({ ...fact, issueIds: ["TECH-1", "TECH-COPY"] })),
      })),
    };
    const make = (edit: typeof issue.rich.proposedEdit) =>
      composeReviewPlacement(
        fixture("github", "addition", {
          issues: [issue, { ...copy, rich: { ...issue.rich, proposedEdit: edit } }],
          contexts: [sharedContext],
          findings: [],
        }),
      );
    const edit = issue.rich.proposedEdit;
    expect(make(edit).manifest.rows[0]?.groupKey).toBe(make(edit).manifest.rows[1]?.groupKey);
    for (const changed of [
      { ...edit, path: "docs/other.md" },
      { ...edit, originalText: "other old\r\n" },
      { ...edit, replacementText: "other new\r\n" },
      { ...edit, replacementText: "" },
    ]) {
      const rows = make(changed).manifest.rows;
      expect(rows[0]?.groupKey).not.toBe(rows[1]?.groupKey);
    }
  });
  it("preserves the whole inventory and an added-file anchor for GitLab and GitHub", () => {
    for (const provider of ["gitlab", "github"] as const) {
      const composition = composeReviewPlacement(fixture(provider));
      expect(composition.plan.actions.map((action) => action.kind)).toEqual([
        "publish-inline",
        "publish-inline",
      ]);
      expect(composition.manifest.rows).toHaveLength(2);
      expect(composition.manifest.rows[0]).toMatchObject({
        canonicalIssueId: "issue:1",
        producerOriginalId: "TECH-1",
        producerStepId: "review",
        producerSkill: "technical-review",
        reason: "proposed-action",
        causality: "unknown",
        verification: "unknown",
      });
      expect(composition.manifest.rows[0]?.factTuples).toEqual([["context:1", 0, 0, "fact:1"]]);
      expect(composition.manifest.rows[0]?.retained).toEqual({
        collection: "issues",
        index: 0,
        resultSha256: composition.plan.result.originalResultSha256,
      });
      expect(composition.manifest.inventoryStatus).toBe("inline-union-only");
      expect(composition.manifest.hostedReportUrlCandidate).toBeNull();
      expect(composition.manifest.publicationConfirmed).toBe(false);
      expect(Object.isFrozen(composition.manifest.rows[0]?.factTuples)).toBe(true);
    }
  });

  it("retains the same-path modified issue with its exact ambiguous-side reason", () => {
    const composition = composeReviewPlacement(fixture("gitlab", "replacement"));
    expect(composition.plan.actions.map((action) => action.kind)).toEqual(["publish-summary"]);
    expect(composition.manifest.rows.map((row) => row.reason)).toEqual([
      "ambiguous-side",
      "ambiguous-side",
    ]);
  });

  it("keeps a valid legacy recommendation inline without summary capability", () => {
    const composition = composeReviewPlacement(fixture("github", "addition", { summary: false }));
    expect(composition.manifest.rows[1]).toMatchObject({
      reason: "proposed-action",
      limitations: ["legacy-finding-lineage-unavailable"],
    });
    expect(composition.plan.actions).toHaveLength(2);
  });

  it("reports absent optional legacy action as unpublished with inline-only capability", () => {
    const seed = fixture("gitlab");
    const finding = (
      seed.result as {
        findings: readonly {
          id: string;
          severity: "warning";
          code: string;
          summary: string;
          path: string;
          line: number;
          evidence: string;
        }[];
      }
    ).findings[0]!;
    const composition = composeReviewPlacement(
      fixture("gitlab", "addition", {
        findings: [
          {
            id: finding.id,
            severity: finding.severity,
            code: finding.code,
            summary: finding.summary,
            path: finding.path,
            line: finding.line,
            evidence: finding.evidence,
          },
        ],
        summary: false,
      }),
    );
    expect(composition.manifest.rows[1]).toMatchObject({
      reason: "action-unavailable",
      plannedActionId: null,
    });
    expect(composition.manifest.inventoryStatus).toBe("retrieval-unavailable");
  });

  it("chooses the anchored representative after an unanchorable canonical member", () => {
    for (const reversed of [false, true]) {
      const composition = composeReviewPlacement(
        repeatedActionFixture("gitlab", { summary: true, inline: true }, reversed),
      );
      const rows = composition.manifest.rows;
      const copy = rows.find((row) => row.producerOriginalId === "TECH-COPY")!;
      const anchored = rows.find((row) => row.producerOriginalId === "TECH-ANCHOR")!;
      const independent = rows.find((row) => row.producerOriginalId === "TECH-INDEPENDENT")!;
      expect(copy.groupKey).toBe(anchored.groupKey);
      expect(copy.groupRepresentativeId).toBe(anchored.inventoryId);
      expect(anchored.finalDisposition.kind).toBe("inline-candidate");
      expect(independent.groupKey).not.toBe(copy.groupKey);
      expect(independent.finalDisposition.kind).toBe("inline-candidate");
      expect(rows.map((row) => row.causality)).toEqual(["unknown", "unknown", "unknown"]);
      expect(
        composeReviewPlacement(
          repeatedActionFixture("gitlab", { summary: true, inline: true }, reversed),
        ).manifest,
      ).toEqual(composition.manifest);
    }
  });

  it("keeps all anchored members with inline-only and routes every row for summary-only", () => {
    const inline = composeReviewPlacement(
      repeatedActionFixture("github", { summary: false, inline: true }, false, true),
    );
    expect(inline.plan.actions.filter((action) => action.kind === "publish-inline")).toHaveLength(
      3,
    );
    expect(inline.manifest.inventoryStatus).toBe("inline-union-only");
    const summary = composeReviewPlacement(
      repeatedActionFixture("github", { summary: true, inline: false }),
    );
    expect(summary.plan.actions).toHaveLength(1);
    expect(summary.plan.actions[0]?.kind).toBe("publish-summary");
    expect(summary.manifest.inventoryStatus).toBe("summary-planned");
    const neither = composeReviewPlacement(
      repeatedActionFixture("github", { summary: false, inline: false }),
    );
    expect(neither.plan.actions).toHaveLength(0);
    expect(neither.manifest.rows).toHaveLength(3);
    expect(neither.manifest.inventoryStatus).toBe("retrieval-unavailable");
  });

  it("keeps a valid issue inline with absent context and literal uncertainty", () => {
    const seed = fixture("gitlab");
    const issue = (seed.result as { issues: readonly ReviewIssueV3[] }).issues[0]!;
    const composition = composeReviewPlacement(
      fixture("gitlab", "addition", {
        issues: [
          {
            ...issue,
            sourceContextId: null,
            factRefs: [],
            limitations: ["The old wording may be intentional."],
          },
        ],
        findings: [],
      }),
    );
    expect(composition.manifest.rows[0]).toMatchObject({
      reason: "proposed-action",
      causality: "unknown",
      uncertainty: ["The old wording may be intentional."],
    });
    expect(composition.plan.actions[0]?.kind).toBe("publish-inline");
  });

  it("keeps unverified dimension and nonempty fact uncertainty visible", () => {
    const seed = fixture("github");
    const context = (seed.result as { sourceContexts: readonly ReviewSourceContextV3[] })
      .sourceContexts[0]!;
    const dimension = context.dimensions[0]!;
    const composition = composeReviewPlacement(
      fixture("github", "addition", {
        contexts: [
          {
            ...context,
            dimensions: [
              {
                ...dimension,
                status: "unverified",
                reason: "Source not available",
                facts: [
                  {
                    ...dimension.facts[0]!,
                    uncertainty: "Check the platform setting before applying.",
                  },
                ],
              },
            ],
          },
        ],
        findings: [],
      }),
    );
    expect(composition.manifest.rows[0]?.uncertainty).toContain(
      "unverified:technical:Source not available",
    );
    expect(composition.manifest.rows[0]?.uncertainty).toContain(
      "Check the platform setting before applying.",
    );
    expect(composition.plan.actions[0]?.kind).toBe("publish-inline");
  });

  it("lets the released decoder refuse malformed canonical and present legacy text", () => {
    const seed = fixture("gitlab");
    const issue = (seed.result as { issues: readonly ReviewIssueV3[] }).issues[0]!;
    for (const field of ["finding", "requiredChange"] as const)
      expect(() =>
        fixture("gitlab", "addition", { issues: [{ ...issue, [field]: " " }] }),
      ).toThrow();
    const { requiredChange: _missingChange, ...withoutChange } = issue;
    expect(() =>
      fixture("gitlab", "addition", { issues: [withoutChange as ReviewIssueV3] }),
    ).toThrow();
    expect(() =>
      fixture("gitlab", "addition", {
        issues: [{ ...issue, factRefs: [{ dimensionIndex: 9, factIndex: 9 }] }],
      }),
    ).toThrow();
    const finding = (
      seed.result as {
        findings: readonly {
          id: string;
          severity: "warning";
          code: string;
          summary: string;
          path: string;
          line: number;
          evidence: string;
          recommendation: string;
        }[];
      }
    ).findings[0]!;
    for (const field of ["summary", "recommendation"] as const)
      expect(() =>
        fixture("gitlab", "addition", { findings: [{ ...finding, [field]: " " }] }),
      ).toThrow();
  });

  it("does not infer causality or verification from release-copy and template prose", () => {
    const seed = fixture("github");
    const issue = (seed.result as { issues: readonly ReviewIssueV3[] }).issues[0]!;
    for (const scenario of [
      {
        category: "release_copy",
        finding: "Copied release command may be old",
        requiredChange: "Check the version before changing this command.",
      },
      {
        category: "generated_template",
        finding: "Template wording may be optional style",
        requiredChange: "If required by the owner, update the template wording.",
      },
    ]) {
      const composition = composeReviewPlacement(
        fixture("github", "addition", { issues: [{ ...issue, ...scenario }], findings: [] }),
      );
      expect(composition.manifest.rows[0]).toMatchObject({
        reason: "proposed-action",
        causality: "unknown",
        consequence: "unknown",
        verification: "unknown",
      });
    }
  });
});
