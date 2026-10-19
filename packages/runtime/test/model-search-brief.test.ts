// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The model reads a budgeted projection of a step's search evidence, never the
 * sealed record object. Evidence comes from the production coordinator over
 * real git fixtures; the 30-target shape is a clone of one of them.
 */
import { readFile } from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { ResolvedLimit } from "../src/config/limits.js";
import { buildDocsFabStepPrompt } from "../src/harness/pi-session.js";
import { estimateModelRequestTokens } from "../src/model/context-budget.js";
import { DOCSFAB_SYSTEM_PROMPT } from "../src/model/request-policy.js";
import {
  collectRunLimitOverflowEvidence,
  mergeRunLimitOverflowEvidence,
  projectRunLimitOverflowLines,
} from "../src/operator/run-limit-overflow.js";
import type { RunRecord } from "../src/records/contracts.js";
import { prepareRepositoryWorkspace } from "../src/repository/workspace/materialize.js";
import { LocalWorkflowSearchCoordinator } from "../src/search/local-workflow-coordinator.js";
import { createSearchLimitation } from "../src/search/bounded-search-contracts.js";
import {
  projectModelSearchBrief,
  renderModelSearchBrief,
  resolveSearchBriefLimit,
  SearchBriefInputError,
  searchBriefOmissionWarning,
} from "../src/search/model-search-brief.js";
import type {
  WorkflowName,
  WorkflowSearchResultV1,
  WorkflowSearchStepEvidenceV1,
} from "../src/workflow-contracts/contracts.js";
import {
  instantiateWorkflowSearchTargets,
  normalizeWorkflowSearchEvidence,
} from "../src/workflow-contracts/search.js";
import { getWorkflow, listCatalogWorkflows } from "../src/workflow-registry/catalog.js";
import { initFixtureRepo } from "./helpers/git.js";

const temporary: string[] = [];
const disposers: Array<() => Promise<void>> = [];
let small: WorkflowSearchStepEvidenceV1;
let large: WorkflowSearchStepEvidenceV1;
let release: WorkflowSearchStepEvidenceV1;
const DIGEST = /[a-f0-9]{64}/u;
/** A long but ordinary documentation directory, so cited paths cost real budget. */
const DEEP = "docs/reference/command-line-interface/configuration-and-environment-variables";
/** The standard composition context window lane D ran at. */
const STANDARD_WINDOW_TOKENS = 131_072;

beforeAll(async () => {
  [small, large, release] = await Promise.all([
    searchEvidence("review-documentation", 3),
    searchEvidence("review-documentation", 80),
    searchEvidence("release-documentation-readiness", 17),
  ]);
}, 180_000);

afterAll(async () => {
  await Promise.all(disposers.splice(0).map((dispose) => dispose()));
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("model search brief", () => {
  it("keeps every outcome and qualification the step needs, and no digest", () => {
    const { brief, accounting } = projectModelSearchBrief(small);
    const search = small.searches[0]!;
    const target = brief.targets[0]!;
    expect(target).toMatchObject({
      targetId: search.targetId,
      targetType: search.bounded.target.targetType,
      findingId: search.bounded.finding.stableFindingId,
      disposition: search.bounded.finding.disposition,
      findingClass: search.bounded.finding.findingClass,
      confidence: search.bounded.confidence.level,
      saturation: search.bounded.confidence.saturation.status,
      coverage: {
        sufficient: search.bounded.coverage.sufficient,
        incompleteProbeIds: search.bounded.coverage.incompleteProbeIds,
        blockerDisclosure: search.bounded.coverage.blockerDisclosure,
      },
      remainingWork: {
        category: search.progress.rationale.category,
        count: search.progress.rationale.remainingWorkCount,
        requiredProbeIds: search.progress.rationale.remainingRequiredProbeIds,
      },
      recommendation: {
        recommendation: search.progress.recommendation.recommendation,
        reasonCategories: search.progress.recommendation.reasonCategories,
      },
      omittedCitedPathCount: 0,
    });
    expect(target.probes.map((probe) => [probe.id, probe.outcome, probe.matchCount])).toEqual(
      search.bounded.probes.map((probe) => [probe.id, probe.outcome, probe.matchCount]),
    );
    const limitationIds = new Set(
      [...search.bounded.limitations, ...search.progress.limitations].map((item) => item.id),
    );
    expect(target.limitations.map((item) => item.id)).toEqual([...limitationIds]);
    // Each cited path once, sorted, though several probes cite it.
    expect(target.citedPaths).toEqual([...new Set(target.citedPaths)].sort());
    expect(target.citedPaths).toHaveLength(citedPathCount(search));
    expect(JSON.stringify(brief)).not.toMatch(DIGEST);
    expect(accounting).toMatchObject({ omittedCitedPathCount: 0, targetsWithOmittedPaths: [] });
    // The budget covers the whole prompt section, framing included.
    expect(accounting.renderedChars).toBe(renderModelSearchBrief(small).length);
    expect(accounting.renderedChars).toBeGreaterThan(JSON.stringify(brief).length);
    expect(searchBriefOmissionWarning("audit-documentation", small)).toBeUndefined();
  });

  it("refuses malformed evidence by code, naming what is missing", () => {
    const refusal = (evidence: unknown) => {
      try {
        projectModelSearchBrief(evidence as WorkflowSearchStepEvidenceV1);
      } catch (error) {
        return error instanceof SearchBriefInputError
          ? `${error.code} @ ${error.location}`
          : String(error);
      }
      return "accepted";
    };
    expect(refusal(small)).toBe("accepted");
    const { searches: _searches, ...noSearches } = small;
    expect(refusal(noSearches)).toBe("search-brief-evidence-malformed @ searches");
    const noProgress = structuredClone(small) as unknown as { searches: Record<string, unknown>[] };
    delete noProgress.searches[0]!.progress;
    expect(refusal(noProgress)).toBe("search-brief-evidence-malformed @ searches[0].progress");
    expect(refusal(null)).toBe("search-brief-evidence-malformed @ evidence");
    // Scalars the brief projects are checked too, not dropped or passed through.
    const noDisposition = structuredClone(small) as unknown as {
      searches: { bounded: { finding: Record<string, unknown> } }[];
    };
    delete noDisposition.searches[0]!.bounded.finding.disposition;
    expect(refusal(noDisposition)).toBe(
      "search-brief-evidence-malformed @ searches[0].bounded.finding.disposition",
    );
    const numericPath = structuredClone(small) as unknown as {
      searches: { bounded: { probes: { citations: unknown[] }[] } }[];
    };
    numericPath.searches[0]!.bounded.probes[0]!.citations = [{ path: 42, anchorSha256: null }];
    expect(refusal(numericPath)).toBe(
      "search-brief-evidence-malformed @ searches[0].bounded.probes[0].citations[0].path",
    );
    const noRubric = structuredClone(small) as unknown as {
      searches: { bounded: { target: Record<string, unknown> } }[];
    };
    expect(noRubric.searches[0]!.bounded.target.targetType).toBe("rubric-coverage");
    delete noRubric.searches[0]!.bounded.target.rubric;
    expect(refusal(noRubric)).toBe(
      "search-brief-evidence-malformed @ searches[0].bounded.target.rubric",
    );
  });

  it("puts the brief, not the sealed evidence, in the step prompt", () => {
    const workflow = getWorkflow("review-documentation");
    const step = workflow.steps.find((candidate) => candidate.search)!;
    const prompt = buildDocsFabStepPrompt({
      repositoryPath: "/tmp/repository",
      workflow,
      step,
      searchEvidence: small,
    });
    expect(prompt).toContain(JSON.stringify(projectModelSearchBrief(small).brief));
    for (const sealed of ['"probeSha256"', '"observations"', '"execution"', small.evidenceSha256]) {
      expect(prompt).not.toContain(sealed);
    }
    expect(prompt).not.toContain("this brief lists");
  });

  it("fits the whole release-readiness prompt in the standard window it overflowed", async () => {
    const workflow = getWorkflow("release-documentation-readiness");
    const step = workflow.steps[0]!;
    const skill = await readFile(
      new URL(`../../skills/${step.skill}/SKILL.md`, import.meta.url),
      "utf8",
    );
    const estimate = (prompt: string) =>
      estimateModelRequestTokens({
        systemPrompt: DOCSFAB_SYSTEM_PROMPT,
        messages: [{ role: "user", content: `${skill}\n${prompt}` }],
      });
    const prompt = buildDocsFabStepPrompt({
      repositoryPath: "/tmp/repository",
      workflow,
      step,
      searchEvidence: release,
    });
    expect(release.searches).toHaveLength(30);
    // The governor adds a 5/4 margin to content the provider has not billed.
    const admitted = Math.ceil((estimate(prompt) * 5) / 4);
    expect(admitted).toBeLessThan(STANDARD_WINDOW_TOKENS / 4);
    // The record-grade evidence the prompt used to carry did not fit at all.
    const raw = prompt.replace(
      JSON.stringify(projectModelSearchBrief(release).brief),
      JSON.stringify(release),
    );
    expect(Math.ceil((estimate(raw) * 5) / 4)).toBeGreaterThan(STANDARD_WINDOW_TOKENS);
  });

  it("shares the budget smallest demand first, counts every omission, and stays within it", () => {
    const budget = resolveSearchBriefLimit();
    // 29 copies of a target citing many long paths, and one small target: 30
    // targets, as the release plan has, on a repository with deep paths.
    const many = cloneTargets(large, 29, small.searches[0]!);
    const { brief, accounting } = projectModelSearchBrief(many, budget);
    expect(brief.targets).toHaveLength(30);
    expect(accounting.uncutChars).toBeGreaterThan(budget.value);
    expect(accounting.renderedChars).toBeLessThanOrEqual(budget.value);
    const smallTarget = brief.targets.at(-1)!;
    expect(smallTarget.omittedCitedPathCount).toBe(0);
    expect(smallTarget.citedPaths).toHaveLength(citedPathCount(small.searches[0]!));
    const kept = brief.targets.slice(0, 29).map((target) => target.citedPaths.length);
    expect(Math.max(...kept) - Math.min(...kept)).toBeLessThanOrEqual(1);
    const all = citedPathCount(large.searches[0]!);
    for (const target of brief.targets.slice(0, 29)) {
      expect(target.omittedCitedPathCount).toBe(all - target.citedPaths.length);
      expect(target.omittedCitedPathCount).toBeGreaterThan(0);
    }
    expect(brief.omittedCitedPathCount).toBe(
      brief.targets.reduce((total, target) => total + target.omittedCitedPathCount, 0),
    );
    expect(accounting.omittedCitedPathCount).toBe(brief.omittedCitedPathCount);
    expect(renderModelSearchBrief(many, budget)).toContain(
      `To fit its budget, this brief lists ${accounting.citedPathCount - accounting.omittedCitedPathCount} of ${accounting.citedPathCount} cited paths;`,
    );
    const warning = searchBriefOmissionWarning("assess-release-documentation-readiness", many);
    expect(warning).toBe(
      `search-brief-cited-paths-omitted: step assess-release-documentation-readiness listed ${accounting.citedPathCount - accounting.omittedCitedPathCount} of ${accounting.citedPathCount} cited paths in the model's search brief (29 of 30 targets cut); the run record keeps every path. search-brief-total-max-chars-bound: ${accounting.uncutChars} exceeds searchBrief.totalMaxChars = ${budget.value} characters. ${budget.remediation} Follow the named remediation.`,
    );
    expect(warning!.length).toBeLessThanOrEqual(1_024);
  });

  it("passes the unused share of small targets on to larger ones", () => {
    const budget = resolveSearchBriefLimit();
    // Large targets first in plan order, then small ones: an allocation that
    // shared in plan order would leave each small target's unused share idle.
    const base = large.searches[0]!;
    const mixed: WorkflowSearchStepEvidenceV1 = {
      ...large,
      searches: [
        ...Array.from({ length: 15 }, (_, index) => ({
          ...structuredClone(base),
          targetId: `${base.targetId}-large-${index}`,
        })),
        ...Array.from({ length: 15 }, (_, index) => ({
          ...structuredClone(small.searches[0]!),
          targetId: `${base.targetId}-small-${index}`,
        })),
      ],
    };
    const { brief, accounting } = projectModelSearchBrief(mixed, budget);
    expect(accounting.omittedCitedPathCount).toBeGreaterThan(0);
    for (const target of brief.targets.slice(15)) expect(target.omittedCitedPathCount).toBe(0);
    // What stays unspent is less than one more path for each cut target.
    const longestPath = Math.max(...brief.targets[0]!.citedPaths.map((path) => path.length + 3));
    expect(budget.value - accounting.renderedChars).toBeLessThan(15 * longestPath);
  });

  it("names a progress-only limitation alongside the bounded ones", () => {
    const evidence = structuredClone(small);
    const search = evidence.searches[0]!;
    const progressOnly = createSearchLimitation(
      {
        id: "progress-only-scope-excluded",
        category: "scope-excluded",
        impact: "non-blocking",
        probeIds: [search.bounded.probes[0]!.id],
        detailSha256: search.bounded.finding.findingSha256,
      },
      search.bounded.target,
      search.bounded.probes,
    );
    search.progress.limitations = [...search.progress.limitations, progressOnly];
    const ids = projectModelSearchBrief(evidence).brief.targets[0]!.limitations.map(
      (item) => item.id,
    );
    expect(ids).toContain("progress-only-scope-excluded");
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("never renders past the budget, at every budget from fixed content to uncut", () => {
    // Thirty targets with many long paths, swept one character at a time near
    // both ends, so a dropped separator or comma cost shows as an overrun.
    const many = cloneTargets(large, 29, small.searches[0]!);
    const { accounting } = projectModelSearchBrief(many, withValue(10_000_000));
    const budgets = [
      ...Array.from({ length: 400 }, (_, step) => accounting.fixedChars + step),
      ...Array.from({ length: 400 }, (_, step) => accounting.uncutChars - step),
    ];
    for (const value of budgets) {
      const rendered = renderModelSearchBrief(many, withValue(value));
      const projected = projectModelSearchBrief(many, withValue(value)).accounting;
      expect(rendered.length, `budget ${value}`).toBeLessThanOrEqual(value);
      expect(projected.renderedChars, `budget ${value}`).toBe(rendered.length);
    }
    // At the uncut size every path fits and nothing is cut.
    expect(
      projectModelSearchBrief(many, withValue(accounting.uncutChars)).accounting
        .omittedCitedPathCount,
    ).toBe(0);
  });

  it("refuses fixed content over the budget by the limit's name, at the boundary", () => {
    const { accounting } = projectModelSearchBrief(large);
    const exact = projectModelSearchBrief(large, withValue(accounting.fixedChars));
    // Exactly the fixed content fits: every cited path is counted as omitted.
    expect(exact.brief.targets[0]!.citedPaths).toEqual([]);
    expect(exact.accounting.omittedCitedPathCount).toBe(citedPathCount(large.searches[0]!));
    expect(exact.accounting.renderedChars).toBeLessThanOrEqual(accounting.fixedChars);
    expect(() => projectModelSearchBrief(large, withValue(accounting.fixedChars - 1))).toThrow(
      `search-brief-total-max-chars-bound: ${accounting.fixedChars} exceeds searchBrief.totalMaxChars = ${accounting.fixedChars - 1} characters.`,
    );
  });

  it("fits every shipped search plan's worst-case fixed content in the default budget", () => {
    const budget = resolveSearchBriefLimit();
    const plans = new Map<string, WorkflowSearchStepEvidenceV1>();
    for (const workflow of listCatalogWorkflows()) {
      for (const step of workflow.steps) {
        if (step.search && !plans.has(step.search.id)) {
          plans.set(step.search.id, worstCaseEvidence(step.search, small));
        }
      }
    }
    expect([...plans.keys()]).toContain("release-documentation-readiness-discovery");
    for (const [planId, evidence] of plans) {
      const { accounting } = projectModelSearchBrief(evidence, budget);
      expect(accounting.fixedChars, planId).toBeLessThanOrEqual(budget.value);
    }
  });

  it("reports the run-time omission in the operator limitations footer, and only that", () => {
    const warning = searchBriefOmissionWarning(
      "assess-release-documentation-readiness",
      cloneTargets(large, 29, small.searches[0]!),
    )!;
    const record = (evidenceWarnings?: string[]) =>
      ({ steps: [], ...(evidenceWarnings ? { evidenceWarnings } : {}) }) as unknown as RunRecord;
    expect(
      projectRunLimitOverflowLines(
        collectRunLimitOverflowEvidence(
          record([warning, "Repository change evidence could not be captured."]),
        ),
      ),
    ).toEqual([warning]);
    expect(projectRunLimitOverflowLines(collectRunLimitOverflowEvidence(record()))).toEqual([]);
    // The CLI paths (`runs show`, delivery, execution) merge the record's
    // evidence with sidecar evidence before projecting the footer.
    const merged = mergeRunLimitOverflowEvidence(
      collectRunLimitOverflowEvidence(record([warning])),
      { toolResultArchives: [] },
      undefined,
    );
    expect(projectRunLimitOverflowLines(merged)).toEqual([warning]);
    expect(
      projectRunLimitOverflowLines(
        mergeRunLimitOverflowEvidence(
          undefined,
          collectRunLimitOverflowEvidence(record([warning])),
        ),
      ),
    ).toEqual([warning]);
  });
});

async function searchEvidence(
  workflowName: WorkflowName,
  pageCount: number,
): Promise<WorkflowSearchStepEvidenceV1> {
  const root = await mkdtemp(join(tmpdir(), "docsfab-search-brief-"));
  temporary.push(root);
  const files: Record<string, string> = {
    "README.md": "# Fixture\n\nSee the [guide](docs/guide.md).\n",
    "docs/guide.md": "# Guide\n\nUse the tool.\n",
  };
  for (let index = 0; index < pageCount; index += 1) {
    files[`${DEEP}/page-${String(index).padStart(4, "0")}.md`] =
      `# Page ${index}\n\nReference entry ${index}.\n`;
  }
  const revision = await initFixtureRepo(root, files, { branch: "main" });
  const workflow = getWorkflow(workflowName);
  const step = workflow.steps.find((candidate) => candidate.search)!;
  const workspace = await prepareRepositoryWorkspace(root, "HEAD");
  disposers.push(() => workspace.dispose());
  const repository = {
    sourcePath: workspace.sourcePath,
    requestedRevision: workspace.requestedRevision,
    revision: workspace.revision,
  };
  expect(repository.revision).toBe(revision);
  const result = await new LocalWorkflowSearchCoordinator({ workspace }).search({
    runId: `run-search-brief-${workflowName}-${pageCount}`,
    repositoryPath: workspace.path,
    repository,
    workflow,
    step,
    plan: step.search!,
    repositoryDefaultBranch: "main",
  });
  return normalizeWorkflowSearchEvidence({
    plan: step.search!,
    repository,
    repositoryIdentitySha256: result.repositoryIdentitySha256,
    searches: result.searches,
    ...(result.workspaceSnapshotSha256
      ? { workspaceSnapshotSha256: result.workspaceSnapshotSha256 }
      : {}),
  });
}

function citedPathCount(search: WorkflowSearchResultV1): number {
  const paths = new Set<string>();
  for (const probe of search.bounded.probes) {
    for (const citation of probe.citations) paths.add(citation.path);
  }
  for (const citation of search.bounded.finding.citations) paths.add(citation.path);
  return paths.size;
}

function withValue(value: number): ResolvedLimit {
  return { ...resolveSearchBriefLimit(), value };
}

function cloneTargets(
  evidence: WorkflowSearchStepEvidenceV1,
  copies: number,
  last: WorkflowSearchResultV1,
): WorkflowSearchStepEvidenceV1 {
  const base = evidence.searches[0]!;
  return {
    ...evidence,
    searches: [
      ...Array.from({ length: copies }, (_, index) => ({
        ...structuredClone(base),
        targetId: `${base.targetId}-${index}`,
      })),
      structuredClone(last),
    ],
  };
}

/**
 * A plan's real targets with every required probe blocked, one blocking
 * limitation per probe, and every probe still remaining: the most fixed
 * content each target can carry.
 */
function worstCaseEvidence(
  plan: NonNullable<ReturnType<typeof getWorkflow>["steps"][number]["search"]>,
  shape: WorkflowSearchStepEvidenceV1,
): WorkflowSearchStepEvidenceV1 {
  const template = shape.searches[0]!;
  const targets = instantiateWorkflowSearchTargets(plan, {
    identitySha256: "a".repeat(64),
    revision: template.bounded.finding.repositoryRevision,
  });
  const searches = targets.map((declared) => {
    const search = structuredClone(template);
    const probes = declared.requiredProbes;
    const probeIds = probes.map((probe) => probe.id);
    search.targetId = declared.id;
    search.bounded.target = declared;
    search.bounded.probes = probes.map((probe) => ({
      ...structuredClone(template.bounded.probes[0]!),
      id: probe.id,
      strategy: probe.strategy,
      location: probe.location,
      outcome: "blocked" as const,
      matchCount: 0,
      citations: [],
    }));
    const limitations = probes.map((probe) => ({
      ...structuredClone(template.bounded.limitations[0] ?? template.progress.limitations[0]!),
      id: `${probe.id}-unsupported-operation`,
      category: "unsupported-operation" as const,
      impact: "blocking" as const,
      probeIds,
    }));
    search.bounded.limitations = limitations;
    search.progress.limitations = limitations;
    search.bounded.coverage = {
      ...search.bounded.coverage,
      incompleteProbeIds: probeIds,
      rubricCriteria: (declared.targetType === "rubric-coverage"
        ? declared.rubric.criteria
        : []
      ).map((criterion) => ({ criterionId: criterion.id, probeIds, status: "blocked" as const })),
      blockerDisclosure: { status: "incomplete", undisclosedBlockerCount: probeIds.length },
    };
    search.progress.rationale = {
      ...search.progress.rationale,
      remainingRequiredProbeIds: probeIds,
      remainingWorkCount: probeIds.length,
    };
    return search;
  });
  return { ...shape, planId: plan.id, searches };
}
