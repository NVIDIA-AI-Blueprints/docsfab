// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { canonicalDigest, canonicalJson, sha256 } from "../src/content-ir/canonical.js";
import type {
  ReviewSuggestionCompilationV1,
  ReviewSuggestionProfileV1,
} from "../src/review-delivery/suggestions.js";
import { suggestionFixture, profile } from "./fixtures/review-delivery/suggestions/synthetic.js";
import { compileGitLabSuggestionV1 } from "../src/review-delivery/providers/gitlab-suggestions.js";
import { compileGitHubSuggestionV1 } from "../src/review-delivery/providers/github-suggestions.js";

type Fixture = ReturnType<typeof suggestionFixture>;
function proposal(result: ReviewSuggestionCompilationV1) {
  expect(result.kind).toBe("offline-candidate");
  if (result.kind !== "offline-candidate") throw new Error(result.reason);
  return result.proposal;
}
function render(
  f: Fixture,
  p = proposal(f.compile()),
  technical = profile(p.binding.target.scmProvider),
) {
  return f.position.new_line !== undefined
    ? compileGitLabSuggestionV1(p, f.position, technical)
    : compileGitHubSuggestionV1(p, f.position, technical);
}
function refusal(result: ReviewSuggestionCompilationV1, reason: string, f: Fixture) {
  expect(result.kind).toBe("unsupported");
  if (result.kind !== "unsupported") throw new Error("Expected refusal");
  expect(result.reason).toBe(reason);
  expect(result.retained.result).toEqual(f.input.plan.result.originalResult);
  expect(result.retained.artifact).toEqual(f.input.plan.artifact);
  expect(result.proposedActionRef).toBeTruthy();
  return result;
}

for (const provider of ["gitlab", "github"] as const) {
  describe(`${provider} offline native suggestion compiler`, () => {
    it("compiles retained qualification, literal and full fallback through the actual codec without effect ports", () => {
      const f = suggestionFixture(provider);
      const p = proposal(f.compile());
      const output = render(f, p);
      expect(output.kind).toBe("offline-fragment");
      if (output.kind !== "offline-fragment") throw new Error(output.reason);
      expect(output.body).toBe(
        `\`\`\`suggestion${provider === "gitlab" ? ":-0+0" : ""}\nOnly in one project: run \`docs check\`.\n\`\`\``,
      );
      expect(new TextEncoder().encode(output.body)).toEqual(
        new TextEncoder().encode(
          `\`\`\`suggestion${provider === "gitlab" ? ":-0+0" : ""}\nOnly in one project: run \`docs check\`.\n\`\`\``,
        ),
      );
      expect(output.bodySha256).toBe(sha256(output.body));
      expect(p.expectedBlobSha256).toBe(sha256("Only in one project: run `docs check`.\n"));
      expect(p.retained.result).toEqual(f.input.plan.result.originalResult);
      expect(p.issue).toEqual(f.issue);
      expect(p.facts).toHaveLength(2);
      expect(p.retained.reference).toEqual(f.input.plan.findings[0]!.retained);
      expect(p.profile.evidence).toBe("offline-fixture");
      expect(p.proof).toBe("offline-synthetic-range");
      expect(Object.isFrozen(p.issue.rich)).toBe(true);
      expect(Object.isFrozen(output.coordinates)).toBe(true);
      expect(Object.keys(f.ports).sort()).toEqual([
        "admission",
        "codec",
        "generated",
        "retained",
        "source",
      ]);
      if ("new_line" in output.coordinates) expect(output.coordinates.new_line).toBe(1);
      else
        expect(output.coordinates).toEqual({
          commit_id: f.input.plan.target.headSha,
          path: p.path,
          line: 1,
          side: "RIGHT",
        });
    });

    it.each([
      {
        text: "e\u0301 old\n",
        original: "e\u0301 old",
        replacement: "e\u0301 new",
        expected: "e\u0301 new\n",
      },
      {
        text: "old\nsecond\n",
        original: "old\nsecond",
        replacement: "new\nnext",
        end: 2,
        expected: "new\nnext\n",
      },
      {
        text: "\t café 😀 e\u0301 old\n",
        original: "old",
        replacement: "NEW",
        expected: "\t café 😀 e\u0301 NEW\n",
      },
      {
        text: "\ufeffold\r\nlast",
        original: "old",
        replacement: "NEW",
        expected: "\ufeffNEW\r\nlast",
      },
      {
        text: "old\r\nlast\n",
        original: "old\r\nlast",
        replacement: "new\r\nend",
        end: 2,
        expected: "new\r\nend\n",
      },
      {
        text: "first\nlast",
        original: "last",
        replacement: "END",
        start: 2,
        expected: "first\nEND",
      },
      { text: "old\nlast\n", original: "old\n", replacement: "", expected: "last\n" },
      { text: "old", original: "old", replacement: "", expected: "" },
    ])("preserves exact offline byte semantics for $text", (cell) => {
      const f = suggestionFixture(provider, { ...cell, path: "docs/café.md" });
      const p = proposal(f.compile());
      expect(p.expectedBlobSha256).toBe(sha256(cell.expected));
      expect(p.path).toBe("docs/café.md");
      if (cell.text.includes("😀"))
        expect(p.byteStart).toBe(new TextEncoder().encode("\t café 😀 e\u0301 ").length);
      const output = render(f, p);
      expect(output.kind).toBe("offline-fragment");
      if (output.kind === "offline-fragment") {
        expect(output.payloadSha256).toBe(sha256(p.payload));
        expect(output.body).toContain(p.payload);
        if ((cell.end ?? cell.start ?? 1) > (cell.start ?? 1)) {
          if ("new_line" in output.coordinates) expect(output.body).toContain("suggestion:-1+0");
          else
            expect(output.coordinates).toMatchObject({
              line: 2,
              start_line: 1,
              side: "RIGHT",
              start_side: "RIGHT",
            });
        }
      }
    });

    it.each([
      { text: "``` X\n", original: " X", replacement: "", payload: "```\n" },
      { text: "X ```\n", original: "X ", replacement: "", payload: "```\n" },
      { text: "prefix X suffix\n", original: "X", replacement: "Y", payload: "prefix Y suffix\n" },
    ])("scans the assembled payload, including retained prefix/suffix: $text", (cell) => {
      const f = suggestionFixture(provider, cell);
      const p = proposal(f.compile());
      const output = render(f, p);
      expect(output.kind).toBe("offline-fragment");
      if (output.kind !== "offline-fragment") throw new Error(output.reason);
      const fence = cell.payload.includes("```") ? "````" : "```";
      expect(p.payload).toBe(cell.payload);
      expect(output.body).toBe(
        `${fence}suggestion${provider === "gitlab" ? ":-0+0" : ""}\n${cell.payload}${fence}`,
      );
      const limited = { ...profile(provider), fence: "triple-only" as const };
      const limitedP = proposal(f.compile({}, { codec: { profile: () => limited } }));
      const limitedResult = render(f, limitedP, limited);
      expect(limitedResult.kind).toBe(
        cell.payload.includes("```") ? "unsupported" : "offline-fragment",
      );
      if (limitedResult.kind === "unsupported") {
        expect(limitedResult.reason).toBe("fence-unqualified");
        expect(limitedResult.retained.result).toEqual(p.retained.result);
      }
    });

    it("keeps adjacent and unrelated replacements, and refuses summary/same-line conflicts including aliases", () => {
      const adjacent = suggestionFixture(provider, {
        text: "left\nright\n",
        original: "left",
        replacement: "LEFT",
        competitor: { original: "right", replacement: "RIGHT", line: 2 },
      });
      expect(proposal(adjacent.compile()).conflictIds).toEqual([]);
      const unrelated = suggestionFixture(provider, {
        competitor: { path: "docs/other.md", original: "missing", replacement: "x", line: 1 },
      });
      expect(proposal(unrelated.compile()).inventorySha256).not.toBe(
        proposal(suggestionFixture(provider).compile()).inventorySha256,
      );
      const sameLine = suggestionFixture(provider, {
        text: "left right\n",
        original: "left",
        replacement: "LEFT",
        competitor: { original: "right", replacement: "RIGHT", line: 1, summary: true },
      });
      const blocked = refusal(sameLine.compile(), "overlapping-edits", sameLine);
      expect(blocked.conflictIds).toEqual(
        sameLine.input.plan.findings.map((f) => f.inventoryId).sort(),
      );
      const alias = suggestionFixture(provider, {
        competitor: { original: "after", replacement: "same", line: 1 },
      });
      refusal(alias.compile(), "overlapping-edits", alias);
      const unresolved = suggestionFixture(provider, {
        competitor: { original: "unlocated", replacement: "x", line: 1, summary: true },
      });
      refusal(unresolved.compile(), "conflict-unresolved", unresolved);
      const removed = {
        ...sameLine.input.plan,
        findings: sameLine.input.plan.findings.slice(0, 1),
      };
      refusal(sameLine.compile({ plan: removed }), "inventory-incomplete", sameLine);
    });

    it("compares complete trusted producer admission; hashes/status alone cannot admit commands or qualifiers", () => {
      const f = suggestionFixture(provider);
      refusal(f.compile({}, { admission: undefined }), "producer-admission-unavailable", f);
      refusal(
        f.compile({}, { admission: { verify: () => ({ kind: "unavailable" }) } }),
        "producer-admission-unavailable",
        f,
      );
      refusal(
        f.compile({}, { admission: { verify: () => ({ kind: "rejected" }) } }),
        "producer-admission-rejected",
        f,
      );
      for (const replacementText of [
        "run `docs check`.",
        "Only in one project: run `docs skip`.",
      ]) {
        const changed = structuredClone(f.issue);
        if (changed.rich.status !== "admitted" || changed.rich.proposedEdit.kind !== "replacement")
          throw new Error("fixture");
        const rewritten = {
          ...changed,
          rich: {
            ...changed.rich,
            proposedEdit: { ...changed.rich.proposedEdit, replacementText },
          },
        };
        refusal(
          f.compile(
            {},
            {
              admission: {
                verify: (q) => ({
                  kind: "admitted",
                  assessmentRef: "copied-assessment",
                  issue: rewritten,
                  facts: q.facts,
                  sourceBinding: q.sourceBinding,
                }),
              },
            },
          ),
          "producer-admission-rejected",
          f,
        );
      }
      refusal(
        f.compile(
          {},
          {
            admission: {
              verify: () =>
                ({
                  kind: "admitted",
                  assessmentRef: "copied-hash-only",
                  candidateSha256: "d".repeat(64),
                }) as never,
            },
          },
        ),
        "producer-admission-rejected",
        f,
      );
      const substitutedChecks = {
        ...f.input.plan,
        result: {
          ...f.input.plan.result,
          checks: [{ id: "substituted-check", name: "Untrusted check", status: "passed" as const }],
        },
      };
      refusal(f.compile({ plan: substitutedChecks }), "retained-association-mismatch", f);
      const forgedPlan = {
        ...f.input.plan,
        result: {
          ...f.input.plan.result,
          issues: [{ ...f.issue, finding: "Substituted untrusted text" }],
        },
      };
      const mismatch = refusal(f.compile({ plan: forgedPlan }), "retained-association-mismatch", f);
      expect(mismatch.retained.finding).toBeNull();
      expect(canonicalJson(mismatch.retained)).not.toContain("Substituted untrusted text");
    });

    it("refuses original mismatch/ambiguity/empty insertion while retaining exact rich advice", () => {
      for (const [options, reason] of [
        [{ original: "missing" }, "original-mismatch"],
        [{ text: "after after\n" }, "original-ambiguous"],
      ] as const) {
        const f = suggestionFixture(provider, options);
        refusal(f.compile(), reason, f);
      }
      const scoped = suggestionFixture(provider, { text: "after\nafter\n" });
      expect(proposal(scoped.compile()).anchor.endLine).toBe(1);
    });

    it("requires exact source, observation, head, range, inventory and action bindings", () => {
      const f = suggestionFixture(provider);
      const source = f.ports.source.readBoundSnapshot(f.input.action.binding)!;
      refusal(
        f.compile(
          {},
          {
            source: {
              readBoundSnapshot: () => ({
                ...source,
                binding: { ...source.binding, reviewedHeadSha: "stale" },
              }),
            },
          },
        ),
        "source-drift",
        f,
      );
      refusal(
        f.compile({}, { source: { readBoundSnapshot: () => ({ ...source, ranges: [] }) } }),
        "range-unprovable",
        f,
      );
      const unobserved = source.ranges.map((r) => ({ ...r, observedLines: ["invented\n"] }));
      refusal(
        f.compile({}, { source: { readBoundSnapshot: () => ({ ...source, ranges: unobserved }) } }),
        "range-unprovable",
        f,
      );
      const before = source.ranges.map((r) => ({
        ...r,
        anchor: { ...r.anchor, side: "before" as const },
      }));
      refusal(
        f.compile({}, { source: { readBoundSnapshot: () => ({ ...source, ranges: before }) } }),
        "after-location-unavailable",
        f,
      );
      const stale = source.ranges.map((r) => ({
        ...r,
        anchor: { ...r.anchor, sourceSha256: "stale" },
      }));
      refusal(
        f.compile({}, { source: { readBoundSnapshot: () => ({ ...source, ranges: stale }) } }),
        "source-drift",
        f,
      );
      refusal(
        f.compile({ action: { ...f.input.action, id: "copied-action" } }),
        "native-contract-unavailable",
        f,
      );
      const changedBlob = {
        ...f.snapshot,
        files: f.snapshot.files.map((file) => ({
          ...file,
          afterBytes: new TextEncoder().encode("different\n"),
        })),
      };
      refusal(f.compile({ snapshot: changedBlob }), "source-drift", f);
      const multil = suggestionFixture(provider, {
        text: "one\ntwo\n",
        original: "one\ntwo",
        end: 2,
      });
      const observedOne = multil.ports.source.readBoundSnapshot(multil.input.action.binding)!;
      refusal(
        multil.compile(
          {},
          {
            source: {
              readBoundSnapshot: () => ({
                ...observedOne,
                ranges: observedOne.ranges.map((r) => ({ ...r, observedLines: ["one\n"] })),
              }),
            },
          },
        ),
        "range-unprovable",
        multil,
      );
    });

    it("refuses generated/unknown provenance and accepts only the exact authored revision", () => {
      const f = suggestionFixture(provider);
      for (const classification of ["generated", "unknown"] as const) {
        refusal(
          f.compile(
            {},
            {
              generated: {
                classify: (q) => ({ ...q, classification, sourcePaths: ["src/canonical.ts"] }),
              },
            },
          ),
          classification === "unknown" ? "generated-source-unknown" : "generated-source-mismatch",
          f,
        );
      }
      refusal(
        f.compile(
          {},
          {
            generated: {
              classify: (q) => ({
                ...q,
                headBlobSha256: "stale",
                classification: "authored",
                sourcePaths: [],
              }),
            },
          },
        ),
        "generated-source-mismatch",
        f,
      );
      expect(proposal(f.compile()).path).toBe("docs/guide.md");
    });

    it("refuses unknown capability/bytes/fence and preserves the entire fallback", () => {
      const f = suggestionFixture(provider, { text: "after\r\n" });
      for (const [patch, reason] of [
        [{ grammar: "unknown" }, "provider-capability-unqualified"],
        [{ bytes: "unknown" }, "byte-semantics-unproven"],
        [{ bytes: "lf-only-v1" }, "byte-semantics-unsupported"],
        [{ fence: "unknown" }, "fence-unqualified"],
      ] as const) {
        const technical: ReviewSuggestionProfileV1 = { ...profile(provider), ...patch };
        const p = proposal(f.compile({}, { codec: { profile: () => technical } }));
        const result = render(f, p, technical);
        expect(result.kind).toBe("unsupported");
        if (result.kind !== "unsupported") throw new Error("Expected codec refusal");
        expect(result.reason).toBe(reason);
        expect(result.retained).toEqual(p.retained);
      }
      const lf = suggestionFixture(provider);
      const technical = { ...profile(provider), bytes: "lf-only-v1" as const };
      expect(
        render(lf, proposal(lf.compile({}, { codec: { profile: () => technical } })), technical)
          .kind,
      ).toBe("offline-fragment");
    });

    it("rejects rewritten/duplicate payloads, mismatched profiles and before/LEFT coordinates", () => {
      const f = suggestionFixture(provider);
      const p = proposal(f.compile());
      const changed = {
        ...p,
        payload: p.payload + p.payload,
        payloadSha256: sha256(p.payload + p.payload),
      };
      expect(render(f, changed)).toMatchObject({
        kind: "unsupported",
        reason: "byte-semantics-unsupported",
      });
      const rewritten = {
        ...p,
        replacementText: "tampered",
        replacementSha256: sha256("tampered"),
      };
      expect(render(f, rewritten)).toMatchObject({
        kind: "unsupported",
        reason: "byte-semantics-unsupported",
      });
      expect(render(f, p, { ...profile(provider), version: "changed" })).toMatchObject({
        kind: "unsupported",
        reason: "provider-capability-unqualified",
      });
      expect(render(f, { ...p, anchor: { ...p.anchor, side: "before" } })).toMatchObject({
        kind: "unsupported",
        reason: "after-location-unavailable",
      });
      if (f.position.new_line !== undefined) {
        expect(
          compileGitLabSuggestionV1(p, { ...f.position, head_sha: "stale" }, profile(provider)),
        ).toMatchObject({ kind: "unsupported", reason: "after-location-unavailable" });
      } else {
        expect(
          compileGitHubSuggestionV1(
            p,
            { ...f.position, side: "LEFT" as "RIGHT" },
            profile(provider),
          ),
        ).toMatchObject({ kind: "unsupported", reason: "after-location-unavailable" });
      }
      expect(p.inventorySha256).toMatch(/^[a-f\d]+$/u);
      expect(p.profileSha256).toBe(canonicalDigest(p.profile));
    });
  });
}

describe("retained generation and encoding boundaries", () => {
  it("consumes a real retained V5 projection through GitLab codec without resealing it", () => {
    const f = suggestionFixture("gitlab", { legacyV5: true });
    expect(f.input.plan.result.originalSchemaVersion).toBe(5);
    const p = proposal(f.compile());
    expect(p.retained.result).toEqual(f.input.plan.result.originalResult);
    expect(render(f, p).kind).toBe("offline-fragment");
  });

  it("preserves rich advice as an explicit replacement-unavailable fallback", () => {
    for (const provider of ["gitlab", "github"] as const) {
      const f = suggestionFixture(provider, { advice: true });
      const result = refusal(f.compile(), "replacement-unavailable", f);
      expect(result.retained.result).toEqual(f.input.plan.result.originalResult);
      const legacy = suggestionFixture(provider, { legacyAdvice: true });
      expect(legacy.input.plan.result.originalSchemaVersion).toBe(4);
      refusal(legacy.compile(), "replacement-unavailable", legacy);
    }
  });

  it("executes the existing canonical rejection of NFD paths and empty original text without normalization", () => {
    // The retained rich-edit validator currently rejects decomposed path forms.
    for (const provider of ["gitlab", "github"] as const) {
      expect(() => suggestionFixture(provider, { path: "docs/cafe\u0301.md" })).toThrow(
        /invalid-value/u,
      );
      expect(() => suggestionFixture(provider, { original: "" })).toThrow(/invalid-value/u);
      const nfd = suggestionFixture(provider, {
        text: "e\u0301 old\n",
        original: "e\u0301 old",
        replacement: "e\u0301 new",
      });
      const p = proposal(nfd.compile());
      expect(p.originalText).toBe("e\u0301 old");
      expect(p.replacementText).toBe("e\u0301 new");
      expect(p.expectedBlobSha256).toBe(sha256("e\u0301 new\n"));
      expect(render(nfd, p).kind).toBe("offline-fragment");
    }
  });

  it("refuses invalid retained UTF-8 and invalid source UTF-8 with accessible artifact references", () => {
    const f = suggestionFixture("gitlab");
    const retained = f.compile(
      {},
      {
        retained: { load: () => ({ artifact: f.input.plan.artifact, bytes: Uint8Array.of(0xff) }) },
      },
    );
    expect(retained.kind).toBe("unsupported");
    if (retained.kind !== "unsupported") throw new Error("Expected retained refusal");
    expect(retained.reason).toBe("retained-association-mismatch");
    expect(retained.retained.result).toBeNull();
    expect(retained.retained.artifact.id).toBe(f.input.plan.artifact.id);
    const invalid = suggestionFixture("gitlab", { bytes: Uint8Array.of(0xff, 0x0a) });
    refusal(invalid.compile(), "source-invalid-encoding", invalid);
  });

  it("uses host-observed GitLab offset capability exactly at and outside its boundary", () => {
    const f = suggestionFixture("gitlab", {
      text: "one\ntwo\n",
      original: "one\ntwo",
      replacement: "changed",
      end: 2,
    });
    const p = proposal(f.compile());
    expect(render(f, p).kind).toBe("offline-fragment");
    const limited = { ...profile("gitlab"), gitlabOffsets: { before: 0, after: 0 } };
    const other = proposal(f.compile({}, { codec: { profile: () => limited } }));
    expect(render(f, other, limited)).toMatchObject({
      kind: "unsupported",
      reason: "provider-capability-unqualified",
    });
    const single = suggestionFixture("gitlab");
    expect(
      render(single, proposal(single.compile({}, { codec: { profile: () => limited } })), limited)
        .kind,
    ).toBe("offline-fragment");
  });

  it("does not enlarge a sub-line match to other observed lines in the synthetic range", () => {
    const f = suggestionFixture("gitlab", {
      text: "one\ntwo\n",
      original: "one",
      replacement: "ONE",
      end: 2,
    });
    const p = proposal(f.compile());
    expect(p.anchor).toMatchObject({ startLine: 1, endLine: 1 });
    expect(p.payload).toBe("ONE\n");
    expect(p.expectedBlobSha256).toBe(sha256("ONE\ntwo\n"));
  });
});

it("compiles renamed head paths using the actual bound source and both codecs", () => {
  for (const provider of ["gitlab", "github"] as const) {
    const f = suggestionFixture(provider, { renamedFrom: "docs/old.md" });
    const p = proposal(f.compile());
    expect(p.anchor).toMatchObject({
      oldPath: "docs/old.md",
      newPath: "docs/guide.md",
      side: "after",
    });
    expect(p.binding.sourceSha256).toBe(f.input.plan.source.changeSourceSha256);
    expect(render(f, p).kind).toBe("offline-fragment");
  }
});

it.each(["gitlab", "github"] as const)(
  "rejects relabeled inventory associations before an unrelated row can hide a conflicting repair (%s)",
  (provider) => {
    const f = suggestionFixture(provider, {
      text: "left right\n",
      original: "left",
      replacement: "LEFT",
      thirdUnrelated: true,
      competitor: { original: "right", replacement: "RIGHT", line: 1, summary: true },
    });
    refusal(f.compile(), "overlapping-edits", f);
    const findings = f.input.plan.findings.map((row, index) =>
      index === 1 ? { ...f.input.plan.findings[2]!, inventoryId: row.inventoryId } : row,
    );
    const hidden = refusal(
      f.compile({ plan: { ...f.input.plan, findings } }),
      "retained-association-mismatch",
      f,
    );
    expect(hidden.retained.finding).toBeNull();
    expect(hidden.retained.result).toEqual(f.input.plan.result.originalResult);
    const adjacent = suggestionFixture(provider, {
      text: "left\nright\n",
      original: "left",
      replacement: "LEFT",
      thirdUnrelated: true,
      competitor: { original: "right", replacement: "RIGHT", line: 2 },
    });
    const p = proposal(adjacent.compile());
    expect(p.conflictIds).toEqual([]);
    expect(p.expectedBlobSha256).toBe(sha256("LEFT\nright\n"));
    expect(render(adjacent, p).kind).toBe("offline-fragment");
  },
);
