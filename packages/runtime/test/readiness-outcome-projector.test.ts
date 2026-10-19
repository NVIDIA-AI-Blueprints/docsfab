// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  decodeSourceReadinessAssessment,
  SOURCE_READINESS_ASSESSMENT_KIND,
} from "../src/readiness/assessment.js";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import type { RunRecord } from "../src/records/contracts.js";
import {
  assessReadinessCriteria,
  ReadinessWorkflowOutcomeError,
  ReadinessWorkflowOutcomeProjector,
} from "../src/readiness/outcome-projector.js";
import {
  createWorkflowOutcome,
  defaultInconclusiveWorkflowOutcome,
} from "../src/workflow-contracts/outcome.js";

import { sourceReadinessSearch } from "../src/readiness/workflow.js";
import {
  instantiateWorkflowSearchTargets,
  normalizeWorkflowSearchEvidence,
} from "../src/workflow-contracts/search.js";
import { searchEvidenceFixture } from "./helpers/search-evidence-fixture.js";
import type { SearchProbeOutcome } from "../src/search/index.js";

describe("ReadinessWorkflowOutcomeProjector", () => {
  const projector = new ReadinessWorkflowOutcomeProjector();
  it("marks observed artifact presence met and names only the actually unproved rubric criteria", async () => {
    const record = succeededReadinessRecord("found-only");
    record.steps[0]!.summary = "All documentation is ready.";
    expect(
      record.steps[0]!.searchEvidence!.searches.map(
        (search) => search.bounded.confidence.disposition,
      ),
    ).toEqual(["found", "found"]);
    expect(assessReadinessCriteria(record).map((item) => [item.id, item.status])).toEqual([
      ["source-documentation-artifacts", "met"],
      ["source-completeness", "unassessed"],
      ["source-usability", "unassessed"],
    ]);
    const outcome = createWorkflowOutcome(await projector.project(record), record);
    expect(outcome.disposition).toBe("inconclusive");
    expect(outcome.findings.map((finding) => finding.id)).toEqual([
      "finding:readiness:source-completeness",
      "finding:readiness:source-usability",
    ]);
    expect(outcome.findings.every((finding) => finding.kind === "evidence-limitation")).toBe(true);
    expect(outcome.limitations).toEqual([
      "readiness-source-completeness-unsupported-operation",
      "readiness-source-usability-unsupported-operation",
    ]);
    expect(record.steps[0]!.searchEvidence!.searches[0]!.bounded.finding.findingClass).toBe(
      "presence",
    );
    expect(outcome.evidence.map((item) => item.id)).toEqual(["step:assess-readiness"]);
  });
  it("returns ready when every declared presence and rubric criterion is proved without another approval gate", async () => {
    const record = succeededReadinessRecord("all-met");
    expect(assessReadinessCriteria(record).every((item) => item.status === "met")).toBe(true);
    const outcome = createWorkflowOutcome(await projector.project(record), record);
    expect(outcome.disposition).toBe("ready");
    expect(outcome.findings).toEqual([]);
    expect(outcome.limitations).toEqual([]);
    expect(outcome.openDecisions).toEqual([]);
    expect(outcome.evidence).toHaveLength(2);
  });
  it("reports a bounded missing artifact as a gap without relabeling met criteria", async () => {
    const record = succeededReadinessRecord("missing-artifact");
    const outcome = createWorkflowOutcome(await projector.project(record), record);
    expect(outcome.disposition).toBe("not-ready");
    expect(outcome.findings).toEqual([
      expect.objectContaining({
        id: "finding:readiness:source-documentation-artifacts",
        kind: "product-gap",
        severity: "blocking",
        code: "readiness-source-documentation-artifacts-artifact-not-found",
      }),
    ]);
  });
  it("requires every probe declared by a rubric criterion even when legacy ANY-probe search says found", async () => {
    const record = succeededReadinessRecord("partial-negative");
    expect(record.steps[0]!.searchEvidence!.searches[1]!.bounded.confidence.disposition).toBe(
      "found",
    );
    const outcome = createWorkflowOutcome(await projector.project(record), record);
    expect(outcome.disposition).toBe("not-ready");
    expect(outcome.findings).toEqual([
      expect.objectContaining({ id: "finding:readiness:source-completeness", kind: "product-gap" }),
    ]);
    expect(
      assessReadinessCriteria(record).find((item) => item.id === "source-usability")?.status,
    ).toBe("met");
  });
  it("preserves incomplete and denied observations as specific unproved or blocked criteria", async () => {
    for (const mode of ["incomplete", "blocked"] as const) {
      const record = succeededReadinessRecord(mode);
      const outcome = createWorkflowOutcome(await projector.project(record), record);
      expect(outcome.disposition).toBe(mode === "blocked" ? "blocked" : "inconclusive");
      expect(
        outcome.findings.every(
          (item) =>
            item.kind === (mode === "blocked" ? "blocked-dependency" : "evidence-limitation"),
        ),
      ).toBe(true);
    }
  });
  it("uses model judgment only for deferred semantic probes and preserves measured negatives and access failures", () => {
    for (const scenario of ["found-only", "partial-negative", "blocked"] as const) {
      const record = succeededReadinessRecord(scenario),
        step = record.steps[0]!;
      const binding = {
        runId: record.id,
        repositoryRevision: record.repository.revision,
        searchEvidenceSha256: step.searchEvidence!.evidenceSha256,
        contextPacketSha256: null,
      };
      const judgment = decodeSourceReadinessAssessment(
        JSON.stringify({
          schemaVersion: 1,
          kind: SOURCE_READINESS_ASSESSMENT_KIND,
          ...binding,
          summary:
            "Typed criterion-combination fixture; quotation verification has separate real workspace controls.",
          criteria: ["source-completeness", "source-usability"].map((criterionId) => ({
            criterionId,
            status: "met",
            reason: "Synthetic model judgment for combination control.",
            citations: [{ path: "README.md", startLine: 1, endLine: 1, quote: "fixture" }],
          })),
        }),
        binding,
      );
      const criteria = assessReadinessCriteria(record, judgment);
      expect(criteria.find((item) => item.id === "source-completeness")?.status).toBe(
        scenario === "found-only" ? "met" : scenario === "blocked" ? "blocked" : "unmet",
      );
    }
  });
  it("retains the explicit unavailable-evidence outcome when no structured search was supplied", async () => {
    const record = succeededReadinessRecord();
    expect(await projector.project(record)).toEqual(defaultInconclusiveWorkflowOutcome(record));
  });
  it("refuses substituted evidence or workflow instead of inventing a ready result", async () => {
    const record = succeededReadinessRecord("all-met");
    const changed = structuredClone(record);
    changed.steps[0]!.searchEvidence!.searches[0]!.bounded.probes[0]!.outcome = "no-match";
    await expect(projector.project(changed)).rejects.toEqual(
      new ReadinessWorkflowOutcomeError("invalid-record"),
    );
    record.workflow = "review-documentation";
    await expect(projector.project(record)).rejects.toEqual(
      new ReadinessWorkflowOutcomeError("invalid-workflow"),
    );
  });
  it("wires the projectors in the shared application dependencies", () => {
    const source = readFileSync(resolve("src/application/dependencies.ts"), "utf8");
    expect(source).toContain('request.workflow === "readiness"');
    expect(source).toContain("new ReadinessWorkflowOutcomeProjector(workspace)");
  });
});

function succeededReadinessRecord(
  scenario?:
    | "found-only"
    | "all-met"
    | "missing-artifact"
    | "partial-negative"
    | "incomplete"
    | "blocked",
): RunRecord {
  const record: RunRecord = {
    schemaVersion: 2,
    id: "run:readiness-outcome-fixture",
    workflow: "readiness",
    repository: {
      sourcePath: "/private/source",
      requestedRevision: "HEAD",
      revision: "a".repeat(40),
    },
    workspace: { strategy: "tracked-export", disposable: true },
    status: "succeeded",
    createdAt: "2026-08-05T00:00:00.000Z",
    startedAt: "2026-08-05T00:00:00.000Z",
    completedAt: "2026-08-05T00:00:01.000Z",
    durationMs: 1_000,
    models: [],
    skills: [],
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 0,
      turns: 0,
    },
    tools: { totalCalls: 0, failedCalls: 0, byTool: [] },
    steps: [
      {
        id: "assess-readiness",
        title: "Assess repository readiness",
        kind: "inference",
        skill: "assess-documentation-readiness",
        mode: "read-only",
        status: "succeeded",
        startedAt: "2026-08-05T00:00:00.000Z",
        completedAt: "2026-08-05T00:00:01.000Z",
        durationMs: 1_000,
        summary: "Typed product evidence fixture.",
      },
    ],
  };
  if (scenario) {
    const identity = "a".repeat(64);
    const targets = instantiateWorkflowSearchTargets(sourceReadinessSearch, {
      identitySha256: identity,
      revision: record.repository.revision,
    });
    const searches = targets.map((target) => {
      const outcomes: Record<string, SearchProbeOutcome> = Object.fromEntries(
        target.requiredProbes.map((probe) => [probe.id, "match"]),
      );
      if (scenario === "found-only" && target.targetType === "rubric-coverage") {
        outcomes["source-completeness-rubric"] = "blocked";
        outcomes["source-usability-rubric"] = "blocked";
      }
      if (scenario === "partial-negative" && target.targetType === "rubric-coverage")
        outcomes["source-coverage-inventory"] = "no-match";
      if (
        (scenario === "missing-artifact" && target.targetType === "artifact-existence") ||
        scenario === "incomplete" ||
        scenario === "blocked"
      )
        for (const probe of target.requiredProbes)
          outcomes[probe.id] =
            scenario === "incomplete"
              ? "inconclusive"
              : scenario === "blocked"
                ? "blocked"
                : "no-match";
      return searchEvidenceFixture(
        target,
        outcomes,
        scenario === "blocked" ? "access-denied" : "unsupported-operation",
      );
    });
    record.steps[0]!.searchEvidence = normalizeWorkflowSearchEvidence({
      plan: sourceReadinessSearch,
      repository: record.repository,
      repositoryIdentitySha256: identity,
      searches,
    });
  }
  return record;
}
