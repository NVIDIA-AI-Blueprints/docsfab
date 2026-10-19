// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { composeReviewPlacement } from "../src/review-delivery/placement.js";
import {
  renderInlinePresentation,
  renderSummaryPresentation,
} from "../src/review-delivery/inline-presentation.js";
import { fixture, richFixture } from "./fixtures/review-delivery/presentation/synthetic.js";
import type { ReviewIssueV3, ReviewIssueV4 } from "../src/review/contracts.js";
import type { ReviewDeliveryTransport } from "../src/review-delivery/contracts.js";

describe("exact-action review Markdown", () => {
  it("renders decoded V6 rich advice in both exact provider callback shapes", async () => {
    for (const provider of ["gitlab", "github"] as const) {
      const input = richFixture(provider);
      expect(input.result.schemaVersion).toBe(6);
      const composition = composeReviewPlacement(input);
      expect(composition.plan.result.issues?.[0]?.rich?.status).toBe("admitted");
      expect(composition.manifest.rows[0]?.retainedRichSha256).toMatch(/^[a-f0-9]{64}$/u);
      const action = composition.plan.actions.find((member) => member.kind === "publish-inline")!;
      if (action.kind !== "publish-inline") throw new Error("Expected rich inline action");
      let callbackBody: string | null = null;
      const transport: ReviewDeliveryTransport = {
        async publishInline({ plan, action: exact }) {
          expect(plan).toBe(composition.plan);
          const rendered = renderInlinePresentation(composition, exact);
          expect(rendered).toMatchObject({ diagnostic: null, publicationConfirmed: false });
          callbackBody = rendered.body;
          return { kind: "uncertain", providerReference: null };
        },
        async publishSummary() {
          throw new Error("No summary action was planned");
        },
      };
      await transport.publishInline({
        plan: composition.plan,
        action,
        grant: { kind: "docsfab-review-delivery-grant" },
      });
      const body = callbackBody!;
      expect(body).toContain("Correct the default");
      expect(body).toContain("with all title lines");
      expect(body).toContain("Readers may choose an incorrect setting.");
      expect(body).toContain("Proposed edit:");
      expect(body).toContain("Set the documented default explicitly.");
      expect(body).toContain("Supplied grounding:");
      expect(body).toContain("The override is scoped.");
      expect(body).toContain("Only in one project.");
      expect(body).toContain("Qualification:\n~~~text\nOnly in one project.\n~~~");
      expect(body).toContain("src/override.ts:2");
      expect(body).toContain("Only sampled sources were checked.");
      expect(body).toContain("Independent qualification is pending.");
      expect(body).toContain("Legacy finding");
      expect(body).toContain("Keep the scoped override.");
      expect(body).toContain(
        "Consequence: unknown · change relationship: unknown · verification: unknown",
      );
      expect(body).not.toContain("verification: supported");
    }
  });

  it("keeps exact replacement spans, deletion, and hostile bytes literal", () => {
    const originalText = "  old `~~~` <b>@person</b>\r\n  e\u0301\r\n";
    const replacementText = "  new ~~~~ https://evil.example\r\n/approve\r\n";
    for (const [original, replacement] of [
      [originalText, replacementText],
      ["  \r\n", ""],
    ] as const) {
      const input = richFixture("github", {
        kind: "replacement",
        text: "Replace only this span.",
        path: "docs/proposed.md",
        originalText: original,
        replacementText: replacement,
      });
      const composition = composeReviewPlacement(input);
      const action = composition.plan.actions[0]!;
      if (action.kind !== "publish-inline") throw new Error("Expected replacement inline action");
      const body = renderInlinePresentation(composition, action).body!;
      expect(body).toContain("Replace only this span.");
      expect(body).toContain("docs/proposed.md");
      expect(body).toContain(original);
      if (replacement) {
        expect(body).toContain(replacementText);
        expect(body).not.toContain(`${replacementText}\n~~~~~`);
        expect(body).toContain("~~~~~text");
      } else expect(body).toContain("Deletion: proposed replacement is empty.");
      expect(body).not.toContain("<b>@person</b>\n</details>");
    }
  });

  it("rejects every rich payload substitution against the retained row and keeps summary neighbors", () => {
    const composition = composeReviewPlacement(richFixture("gitlab", undefined, "replacement"));
    const action = composition.plan.actions[0]!;
    if (action.kind !== "publish-summary") throw new Error("Expected summary action");
    const issue = composition.plan.result.issues![0] as ReviewIssueV4;
    if (issue.rich.status !== "admitted") throw new Error("Expected admitted rich issue");
    const mutations = [
      { ...issue.rich, title: "Substituted title" },
      { ...issue.rich, readerConsequence: "Substituted consequence" },
      { ...issue.rich, candidateSha256: "e".repeat(64) },
      { ...issue.rich, proposedEdit: { kind: "advice" as const, text: "Substituted edit" } },
      {
        ...issue.rich,
        grounding: [
          { ...issue.rich.grounding[0]!, rationale: "Substituted rationale" },
          issue.rich.grounding[1]!,
        ],
      },
    ];
    for (const rich of mutations) {
      const changed = {
        ...composition,
        plan: {
          ...composition.plan,
          result: { ...composition.plan.result, issues: [{ ...issue, rich }] },
        },
      };
      const rendered = renderSummaryPresentation(changed, action);
      expect(rendered.diagnostic).toBe("retained-association-mismatch");
      expect(rendered.body).toContain("### Review item unavailable");
      expect(rendered.body).toContain("finding:1");
      expect(rendered.body).not.toContain("Substituted");
    }
    const changedRow = {
      ...composition,
      manifest: {
        ...composition.manifest,
        rows: composition.manifest.rows.map((row) =>
          row.canonicalIssueId === issue.id ? { ...row, retainedRichSha256: "e".repeat(64) } : row,
        ),
      },
    };
    expect(renderSummaryPresentation(changedRow, action).diagnostic).toBe(
      "retained-association-mismatch",
    );
  });

  it("renders unavailable reasons with legacy action and rejects altered status or reason", () => {
    const seed = richFixture("github");
    const issue = seed.result.issues![0] as ReviewIssueV4;
    const context = seed.result.sourceContexts![0]!;
    const input = fixture("github", "addition", {
      issues: [{ ...issue, rich: { status: "unavailable", reason: "source-unavailable" } }],
      contexts: [context],
      findings: [],
    });
    expect(input.result.schemaVersion).toBe(6);
    const composition = composeReviewPlacement(input);
    const action = composition.plan.actions[0]!;
    if (action.kind !== "publish-inline") throw new Error("Expected unavailable inline action");
    const body = renderInlinePresentation(composition, action).body!;
    expect(body).toContain("Legacy action shared by independent edits.");
    expect(body).toContain("Rich proposal unavailable: source-unavailable");
    const row = composition.manifest.rows[0]!;
    expect(row.retainedRichSha256).toMatch(/^[a-f0-9]{64}$/u);
    for (const rich of [
      { status: "unavailable" as const, reason: "contradicted" as const },
      issue.rich,
    ]) {
      const changed = {
        ...composition,
        plan: {
          ...composition.plan,
          result: { ...composition.plan.result, issues: [{ ...issue, rich }] },
        },
      };
      expect(renderInlinePresentation(changed, action)).toMatchObject({
        body: null,
        diagnostic: "retained-association-mismatch",
      });
    }
  });

  it("delivers complete rich replacement summaries through both exact provider callbacks", async () => {
    for (const provider of ["gitlab", "github"] as const) {
      const originalText = "  loose\r\n";
      const replacementText = "  strict\r\n";
      const input = richFixture(
        provider,
        {
          kind: "replacement",
          text: "Change the default while retaining the override.",
          path: "docs/guide.md",
          originalText,
          replacementText,
        },
        "replacement",
      );
      expect(input.result.schemaVersion).toBe(6);
      const composition = composeReviewPlacement(input);
      const summary = composition.plan.actions.find((member) => member.kind === "publish-summary")!;
      if (summary.kind !== "publish-summary") throw new Error("Expected rich summary action");
      let body: string | null = null;
      const transport: ReviewDeliveryTransport = {
        async publishInline() {
          throw new Error("No inline action was planned");
        },
        async publishSummary({ plan, action }) {
          expect(plan).toBe(composition.plan);
          const rendered = renderSummaryPresentation(composition, action);
          expect(rendered).toMatchObject({ diagnostic: null, publicationConfirmed: false });
          body = rendered.body;
          return { kind: "uncertain", providerReference: null };
        },
      };
      await transport.publishSummary({
        plan: composition.plan,
        action: summary,
        grant: { kind: "docsfab-review-delivery-grant" },
      });
      expect(body).toContain("Change the default while retaining the override.");
      expect(body).toContain(originalText);
      expect(body).toContain(replacementText);
      expect(body).toContain("Supplied grounding:");
      expect(body).toContain("finding:1");
      expect(body).toContain("Coverage:");
      expect(body).toContain(
        "Consequence: unknown · change relationship: unknown · verification: unknown",
      );
    }
  });

  it("refuses independent replacement kind, path and span substitutions", () => {
    const composition = composeReviewPlacement(
      richFixture("gitlab", {
        kind: "replacement",
        text: "Replace the default.",
        path: "docs/guide.md",
        originalText: "old\r\n",
        replacementText: "new\r\n",
      }),
    );
    const action = composition.plan.actions[0]!;
    if (action.kind !== "publish-inline") throw new Error("Expected replacement inline action");
    const issue = composition.plan.result.issues![0] as ReviewIssueV4;
    if (issue.rich.status !== "admitted" || issue.rich.proposedEdit.kind !== "replacement")
      throw new Error("Expected replacement issue");
    const edit = issue.rich.proposedEdit;
    expect(renderInlinePresentation(composition, action).diagnostic).toBeNull();
    for (const proposedEdit of [
      { kind: "advice" as const, text: edit.text },
      { ...edit, text: "Altered explanation" },
      { ...edit, path: "docs/other.md" },
      { ...edit, originalText: "other old\r\n" },
      { ...edit, replacementText: "other new\r\n" },
      { ...edit, replacementText: "" },
    ]) {
      const changed = {
        ...composition,
        plan: {
          ...composition.plan,
          result: {
            ...composition.plan.result,
            issues: [{ ...issue, rich: { ...issue.rich, proposedEdit } }],
          },
        },
      };
      expect(renderInlinePresentation(changed, action)).toMatchObject({
        body: null,
        diagnostic: "retained-association-mismatch",
      });
    }
  });

  it("keeps full retained identity and fact tuples bound at the rich inline seam", () => {
    const composition = composeReviewPlacement(richFixture("gitlab"));
    const action = composition.plan.actions[0]!;
    if (action.kind !== "publish-inline") throw new Error("Expected rich inline action");
    const finding = composition.plan.findings.find(
      (item) => item.inventoryId === action.findingId,
    )!;
    const issue = composition.plan.result.issues![0] as ReviewIssueV4;
    const context = composition.plan.result.sourceContexts![0]!;
    const row = composition.manifest.rows.find((item) => item.inventoryId === action.findingId)!;
    expect(renderInlinePresentation(composition, action).diagnostic).toBeNull();
    const wrongDigest = {
      ...composition,
      manifest: { ...composition.manifest, resultSha256: "e".repeat(64) },
    };
    expect(renderInlinePresentation(wrongDigest, action)).toMatchObject({
      body: null,
      diagnostic: "action-mismatch",
    });
    for (const retained of [
      { ...finding.retained, resultSha256: "e".repeat(64) },
      { ...finding.retained, collection: "findings" as const },
      { ...finding.retained, index: finding.retained.index + 1 },
    ]) {
      const changed = {
        ...composition,
        plan: {
          ...composition.plan,
          findings: composition.plan.findings.map((item) =>
            item.inventoryId === finding.inventoryId ? { ...item, retained } : item,
          ),
        },
      };
      expect(renderInlinePresentation(changed, action)).toMatchObject({
        body: null,
        diagnostic: "retained-association-mismatch",
      });
    }
    for (const altered of [
      { ...issue, id: "issue:substituted" },
      { ...issue, originalId: "TECH-SUBSTITUTED" },
      { ...issue, producerStepId: "other-step" },
      { ...issue, producerSkill: "other-skill" },
      { ...issue, factRefs: [{ dimensionIndex: 0, factIndex: 0 }] },
    ]) {
      const changed = {
        ...composition,
        plan: {
          ...composition.plan,
          result: { ...composition.plan.result, issues: [altered] },
        },
      };
      expect(renderInlinePresentation(changed, action)).toMatchObject({
        body: null,
        diagnostic: "retained-association-mismatch",
      });
    }
    const substitutedFact = {
      ...context,
      dimensions: context.dimensions.map((dimension) => ({
        ...dimension,
        facts: dimension.facts.map((fact, index) =>
          index === 0 ? { ...fact, id: "fact:substituted" } : fact,
        ),
      })),
    };
    const changedFact = {
      ...composition,
      plan: {
        ...composition.plan,
        result: { ...composition.plan.result, sourceContexts: [substitutedFact] },
      },
    };
    expect(renderInlinePresentation(changedFact, action)).toMatchObject({
      body: null,
      diagnostic: "retained-association-mismatch",
    });
    const changedTuple = {
      ...composition,
      manifest: {
        ...composition.manifest,
        rows: composition.manifest.rows.map((item) =>
          item.inventoryId === row.inventoryId ? { ...item, factTuples: [] } : item,
        ),
      },
    };
    expect(renderInlinePresentation(changedTuple, action)).toMatchObject({
      body: null,
      diagnostic: "retained-association-mismatch",
    });
  });
  it("renders for GitLab and GitHub inside the transport callback shape without an effect", () => {
    for (const provider of ["gitlab", "github"] as const) {
      const composition = composeReviewPlacement(fixture(provider, "replacement"));
      const action = composition.plan.actions[0]!;
      expect(action.kind).toBe("publish-summary");
      if (action.kind !== "publish-summary") return;
      const rendered = renderSummaryPresentation(composition, action);
      expect(rendered.body).toContain("issue:1");
      expect(rendered.body).toContain("finding:1");
      expect(rendered.body).toContain("ambiguous-side");
      expect(rendered.body).toContain("docs/later.md");
      expect(rendered.publicationConfirmed).toBe(false);
    }
  });

  it("keeps hostile producer text inert and rejects same-ID altered action", () => {
    const composition = composeReviewPlacement(fixture("gitlab"));
    const action = composition.plan.actions.find((item) => item.kind === "publish-inline");
    expect(action?.kind).toBe("publish-inline");
    if (action?.kind !== "publish-inline") return;
    const rendered = renderInlinePresentation(composition, action);
    expect(rendered.body).toContain("Proposed action");
    expect(rendered.body).toContain("Use the new value.");
    expect(rendered.body).toContain("Consequence: unknown");
    expect(rendered.body).not.toContain("[https://evil.example");
    const body = rendered.body!;
    expect(body.indexOf("### The new value needs an explanation.")).toBeLessThan(
      body.indexOf("Proposed action:"),
    );
    expect(body.indexOf("Proposed action:")).toBeLessThan(body.indexOf("<details>"));
    expect(body.indexOf("Inventory:")).toBeGreaterThan(body.indexOf("<details>"));
    expect(body).toContain("<summary>Review evidence and limitations</summary>");
    expect(body).not.toContain("Finding:\n~~~text\nThe new value needs an explanation.");
    expect(body).toContain("Qualification:\n~~~text\nOne source was reviewed.\n~~~");
    const altered = { ...action, anchor: { ...action.anchor, path: "docs/other.md" } };
    expect(renderInlinePresentation(composition, altered)).toMatchObject({
      body: null,
      diagnostic: "action-mismatch",
    });
    const alteredBinding = {
      ...action,
      binding: { ...action.binding, reviewedHeadSha: "e".repeat(40) },
    };
    expect(renderInlinePresentation(composition, alteredBinding)).toMatchObject({
      body: null,
      diagnostic: "action-mismatch",
    });
    const alteredManifest = {
      ...composition,
      manifest: {
        ...composition.manifest,
        rows: composition.manifest.rows.map((row) =>
          row.inventoryId === action.findingId
            ? { ...row, producerOriginalId: "swapped-producer" }
            : row,
        ),
      },
    };
    expect(renderInlinePresentation(alteredManifest, action)).toMatchObject({
      body: null,
      diagnostic: "retained-association-mismatch",
    });
  });

  it("keeps multiline commands, nested backticks, URLs, HTML and quick actions literal", () => {
    const seed = fixture("github");
    const issue = (seed.result as { issues: readonly ReviewIssueV3[] }).issues[0]!;
    const command =
      "If the target is enabled:\nrun `tool --arg=\\value` with ~~nested~~\nhttps://example.org/?x=1&y=2\n@maintainer <script>alert(1)</script>\n/approve";
    const composition = composeReviewPlacement(
      fixture("github", "addition", {
        issues: [
          {
            ...issue,
            finding: "<b>@maintainer</b> release copy",
            requiredChange: command,
            limitations: ["Only if the target is enabled."],
          },
        ],
        findings: [],
      }),
    );
    const action = composition.plan.actions[0]!;
    expect(action.kind).toBe("publish-inline");
    if (action.kind !== "publish-inline") return;
    const body = renderInlinePresentation(composition, action).body!;
    expect(body).toContain("### &lt;b&gt;&#64;&#8203;maintainer&lt;/b&gt; release copy");
    expect(body).toContain(`~~~text\n${command}\n~~~`);
    expect(body).toContain("Only if the target is enabled.");
    expect(body).not.toContain("[https://example.org");
    expect(body.indexOf("Proposed action:")).toBeLessThan(body.indexOf("Qualification:"));
    expect(body.indexOf("Qualification:")).toBeLessThan(body.indexOf("<details>"));
  });

  it("breaks GFM producer autolinks in visible headings and evidence while retaining trusted links", () => {
    const seed = fixture("github", "addition", { sameRepository: true });
    const issue = (seed.result as { issues: readonly ReviewIssueV3[] }).issues[0]!;
    const composition = composeReviewPlacement(
      fixture("github", "addition", {
        sameRepository: true,
        issues: [
          {
            ...issue,
            finding:
              "Check https://evil.example/attack, http://evil.example, www.evil.example and person@evil.example",
            evidence: {
              sourceId: "person@evil.example",
              locator: "https://evil.example/attack or www.evil.example",
            },
          },
        ],
      }),
    );
    const action = composition.plan.actions.find((entry) => entry.kind === "publish-inline")!;
    if (action.kind !== "publish-inline") return;
    const target = composition.plan.target;
    const body = renderInlinePresentation(composition, action, {
      scmProvider: "github",
      host: target.host,
      httpsOrigin: `https://${target.host}`,
      repositoryId: target.scmProvider === "github" ? target.repositoryId : -1,
      baseSha: target.baseSha,
      headSha: target.headSha,
    }).body!;
    expect(body).toContain("### Check https&#58;//evil.example/attack");
    expect(body).toContain("http&#58;//evil.example");
    expect(body).toContain("www&#46;evil.example");
    expect(body).toContain("person&#64;&#8203;evil.example");
    expect(body).toContain(
      "Evidence: person&#64;&#8203;evil.example · https&#58;//evil.example/attack or www&#46;evil.example",
    );
    expect(body).not.toContain("https://evil.example");
    expect(body).not.toContain("http://evil.example");
    expect(body).not.toContain("www.evil.example");
    expect(body).not.toContain("person@evil.example");
    expect(body).toContain("Source: [docs/guide.md](https://github.com/");
  });

  it("refuses a summary with omitted, duplicated or replaced manifest inventory", () => {
    const composition = composeReviewPlacement(fixture("gitlab", "replacement"));
    const action = composition.plan.actions[0]!;
    if (action.kind !== "publish-summary") return;
    expect(renderSummaryPresentation(composition, action)).toMatchObject({
      diagnostic: null,
      publicationConfirmed: false,
    });
    const [first, second] = composition.manifest.rows;
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    for (const rows of [
      [],
      [first!, first!],
      [first!, { ...second!, inventoryId: "replacement" }],
    ]) {
      expect(
        renderSummaryPresentation(
          { ...composition, manifest: { ...composition.manifest, rows } },
          action,
        ),
      ).toMatchObject({ body: null, diagnostic: "manifest-mismatch" });
    }
  });

  it("refuses altered resolved fact tuples and uncertainty at the inline association", () => {
    const composition = composeReviewPlacement(fixture("github"));
    const action = composition.plan.actions.find((entry) => entry.kind === "publish-inline")!;
    if (action.kind !== "publish-inline") return;
    const row = composition.manifest.rows.find((entry) => entry.inventoryId === action.findingId)!;
    expect(renderInlinePresentation(composition, action).diagnostic).toBeNull();
    for (const altered of [
      { ...row, factTuples: [] },
      { ...row, uncertainty: [] },
    ]) {
      const changed = {
        ...composition,
        manifest: {
          ...composition.manifest,
          rows: composition.manifest.rows.map((entry) =>
            entry.inventoryId === row.inventoryId ? altered : entry,
          ),
        },
      };
      expect(renderInlinePresentation(changed, action)).toMatchObject({
        body: null,
        diagnostic: "retained-association-mismatch",
      });
    }
  });

  it("binds retained canonical and legacy action bytes in inline and summary rendering", () => {
    const inline = composeReviewPlacement(fixture("github"));
    const inlineAction = inline.plan.actions.find((entry) => entry.kind === "publish-inline")!;
    if (inlineAction.kind !== "publish-inline") throw new Error("Expected canonical inline action");
    const issue = inline.plan.result.issues![0]!;
    expect(renderInlinePresentation(inline, inlineAction).body).toContain("Use the new value.");
    const editedInline = {
      ...inline,
      plan: {
        ...inline.plan,
        result: {
          ...inline.plan.result,
          issues: [{ ...issue, requiredChange: "MUTATED CANONICAL ACTION" }],
        },
      },
    };
    expect(renderInlinePresentation(editedInline, inlineAction)).toMatchObject({
      body: null,
      diagnostic: "retained-association-mismatch",
    });
    const inlineLegacyAction = inline.plan.actions.find(
      (entry) =>
        entry.kind === "publish-inline" &&
        inline.plan.findings.find((finding) => finding.inventoryId === entry.findingId)?.source ===
          "finding",
    );
    const inlineLegacy = inline.plan.result.findings[0]!;
    if (inlineLegacyAction?.kind !== "publish-inline")
      throw new Error("Expected legacy inline action");
    expect(renderInlinePresentation(inline, inlineLegacyAction).body).toContain(
      "Explain the new value.",
    );
    expect(
      renderInlinePresentation(
        {
          ...inline,
          plan: {
            ...inline.plan,
            result: {
              ...inline.plan.result,
              findings: [{ ...inlineLegacy, recommendation: "MUTATED LEGACY ACTION" }],
            },
          },
        },
        inlineLegacyAction,
      ),
    ).toMatchObject({ body: null, diagnostic: "retained-association-mismatch" });

    const summary = composeReviewPlacement(fixture("gitlab", "replacement"));
    const summaryAction = summary.plan.actions.find((entry) => entry.kind === "publish-summary")!;
    if (summaryAction.kind !== "publish-summary") throw new Error("Expected summary action");
    const canonical = summary.plan.result.issues![0]!;
    const legacy = summary.plan.result.findings[0]!;
    const unchanged = renderSummaryPresentation(summary, summaryAction);
    expect(unchanged.diagnostic).toBeNull();
    expect(unchanged.body).toContain("Use the new value.");
    expect(unchanged.body).toContain("Explain the new value.");
    for (const result of [
      {
        ...summary.plan.result,
        issues: [{ ...canonical, requiredChange: "MUTATED CANONICAL ACTION" }],
      },
      {
        ...summary.plan.result,
        findings: [{ ...legacy, recommendation: "MUTATED LEGACY ACTION" }],
      },
      { ...summary.plan.result, findings: [{ ...legacy, recommendation: undefined }] },
    ]) {
      const rendered = renderSummaryPresentation(
        { ...summary, plan: { ...summary.plan, result } },
        summaryAction,
      );
      expect(rendered.diagnostic).toBe("retained-association-mismatch");
      expect(rendered.body).toContain("### Review item unavailable");
      expect(rendered.body).not.toContain("MUTATED CANONICAL ACTION");
      expect(rendered.body).not.toContain("MUTATED LEGACY ACTION");
    }

    const { recommendation: _omitted, ...withoutRecommendation } = legacy;
    const absent = composeReviewPlacement(
      fixture("gitlab", "replacement", { findings: [withoutRecommendation] }),
    );
    const absentAction = absent.plan.actions.find((entry) => entry.kind === "publish-summary")!;
    if (absentAction.kind !== "publish-summary") throw new Error("Expected absent-action summary");
    expect(
      absent.manifest.rows.find((row) => row.canonicalIssueId === null)?.retainedActionSha256,
    ).toBeNull();
    const absentBody = renderSummaryPresentation(absent, absentAction);
    expect(absentBody.diagnostic).toBeNull();
    expect(absentBody.body).toContain("Proposed action unavailable");
    const addedRecommendation = renderSummaryPresentation(
      {
        ...absent,
        plan: {
          ...absent.plan,
          result: {
            ...absent.plan.result,
            findings: [{ ...withoutRecommendation, recommendation: "MUTATED LEGACY ACTION" }],
          },
        },
      },
      absentAction,
    );
    expect(addedRecommendation.diagnostic).toBe("retained-association-mismatch");
    expect(addedRecommendation.body).not.toContain("MUTATED LEGACY ACTION");
  });

  it("creates a source link only for matching trusted host, repository and revision", () => {
    for (const provider of ["gitlab", "github"] as const) {
      const composition = composeReviewPlacement(
        fixture(provider, "addition", { sameRepository: true }),
      );
      const action = composition.plan.actions.find((item) => item.kind === "publish-inline")!;
      if (action.kind !== "publish-inline") continue;
      const target = composition.plan.target;
      const context = {
        scmProvider: provider,
        host: target.host,
        httpsOrigin: `https://${target.host}`,
        repositoryId: target.scmProvider === "gitlab" ? target.projectId : target.repositoryId,
        baseSha: target.baseSha,
        headSha: target.headSha,
      };
      expect(renderInlinePresentation(composition, action, context).body).toContain(
        "Source: [docs/guide.md](https://",
      );
      expect(
        renderInlinePresentation(composition, action, { ...context, headSha: "e".repeat(40) }).body,
      ).not.toContain("Source: [");
      expect(
        renderInlinePresentation(composition, action, { ...context, repositoryId: 999 }).body,
      ).not.toContain("Source: [");
      const fork = composeReviewPlacement(fixture(provider));
      const forkAction = fork.plan.actions.find((item) => item.kind === "publish-inline")!;
      if (forkAction.kind === "publish-inline")
        expect(renderInlinePresentation(fork, forkAction, context).body).not.toContain("Source: [");
    }
  });

  it("keeps parenthesized GitLab and GitHub source paths and line anchors inside one link", () => {
    for (const provider of ["gitlab", "github"] as const) {
      for (const [filePath, encodedPath] of [
        ["docs/guide).md", "docs/guide%29.md"],
        ["docs/(guide.md", "docs/%28guide.md"],
        ["docs/(guide).md", "docs/%28guide%29.md"],
      ]) {
        const composition = composeReviewPlacement(
          fixture(provider, "addition", { sameRepository: true, filePath }),
        );
        const action = composition.plan.actions.find((entry) => entry.kind === "publish-inline")!;
        if (action.kind !== "publish-inline") continue;
        const target = composition.plan.target;
        const context = {
          scmProvider: provider,
          host: target.host,
          httpsOrigin: `https://${target.host}`,
          repositoryId: target.scmProvider === "gitlab" ? target.projectId : target.repositoryId,
          baseSha: target.baseSha,
          headSha: target.headSha,
        };
        const body = renderInlinePresentation(composition, action, context).body!;
        const repository = provider === "gitlab" ? "team/docs/-/blob" : "team/docs/blob";
        const expected = `https://${target.host}/${repository}/${target.headSha}/${encodedPath}#L1`;
        const source = body.split("\n").find((line) => line.startsWith("Source: "));
        expect(source).toContain(`](${expected})`);
        expect(source).not.toContain(`/${filePath}#L1`);
        expect(body).toContain("Proposed action:\n~~~text\nUse the new value.\n~~~");
        expect(
          renderInlinePresentation(composition, action, { ...context, headSha: "e".repeat(40) })
            .body,
        ).not.toContain("Source: [");
      }
    }
  });

  it("renders at the exact fake transport seam with complete summary and no remote call", async () => {
    for (const provider of ["gitlab", "github"] as const) {
      const inlineComposition = composeReviewPlacement(fixture(provider));
      const summaryComposition = composeReviewPlacement(
        fixture(provider, "replacement", {
          hostedReportUrl: "https://reports.example.org/reports/run-7/",
        }),
      );
      let inlineBody: string | null = null;
      let summaryBody: string | null = null;
      const transport: ReviewDeliveryTransport = {
        async publishSummary({ plan, action }) {
          expect(plan).toBe(summaryComposition.plan);
          summaryBody = renderSummaryPresentation(summaryComposition, action).body;
          return { kind: "uncertain", providerReference: null };
        },
        async publishInline({ plan, action }) {
          expect(plan).toBe(inlineComposition.plan);
          inlineBody = renderInlinePresentation(inlineComposition, action).body;
          return { kind: "uncertain", providerReference: null };
        },
      };
      const inlineAction = inlineComposition.plan.actions.find(
        (action) => action.kind === "publish-inline",
      )!;
      if (inlineAction.kind !== "publish-inline") continue;
      await transport.publishInline({
        plan: inlineComposition.plan,
        action: inlineAction,
        grant: { kind: "docsfab-review-delivery-grant" },
      });
      expect(inlineBody).toContain("Proposed action");
      expect(inlineBody).toContain("Use the new value.");
      const action = summaryComposition.plan.actions[0]!;
      if (action.kind !== "publish-summary") continue;
      await transport.publishSummary({
        plan: summaryComposition.plan,
        action,
        grant: { kind: "docsfab-review-delivery-grant" },
      });
      expect(summaryBody).toContain("issue:1");
      expect(summaryBody).toContain("finding:1");
      expect(summaryBody).toContain("docs/later.md");
      expect(summaryBody).toContain("reports.example.org");
      expect(summaryBody!.indexOf("Coverage:")).toBeLessThan(summaryBody!.indexOf("###"));
      expect(summaryBody!.indexOf("###")).toBeLessThan(summaryBody!.indexOf("Inventory:"));
      expect(summaryComposition.manifest.hostedReportUrlCandidate).toBe(
        "https://reports.example.org/reports/run-7/",
      );
      expect(summaryComposition.manifest.publicationConfirmed).toBe(false);
    }
  });

  it("puts inline, summary and coverage rows in the one planned summary", () => {
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
      }),
    );
    const summary = composition.plan.actions.find((action) => action.kind === "publish-summary")!;
    if (summary.kind !== "publish-summary") return;
    const result = renderSummaryPresentation(composition, summary);
    expect(result.body).toContain("issue:1");
    expect(result.body).toContain("finding:1");
    expect(result.body).toContain("action-unavailable");
    expect(result.body).toContain("docs/later.md");
    expect(composition.manifest.rows[0]?.finalDisposition.kind).toBe("inline-candidate");
    expect(composition.manifest.rows[1]?.finalDisposition.kind).toBe("summary-candidate");
    const inline = composition.plan.actions.find((action) => action.kind === "publish-inline")!;
    if (inline.kind === "publish-inline")
      expect(renderInlinePresentation(composition, inline).body).toContain(
        "More findings and coverage are planned in the review summary; posting has not been confirmed.",
      );
  });
});
