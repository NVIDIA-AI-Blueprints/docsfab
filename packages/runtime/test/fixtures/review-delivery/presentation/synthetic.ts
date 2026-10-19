// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { sha256 } from "../../../../src/content-ir/canonical.js";
import { LIMIT_DEFINITION_BY_NAME } from "../../../../src/config/limits.generated.js";
import {
  createChangeSource,
  type ChangeSourceSourceV1,
  type ChangeSourceV1,
} from "../../../../src/inputs/change-source.js";
import {
  gitlabProjectIdentity,
  githubRepositoryIdentity,
} from "../../../../src/inputs/change-source/revision.js";
import { digestGitlabMrReviewLocator } from "../../../../src/inputs/gitlab-mr-locator.js";
import {
  createReviewResult,
  createReviewResultV2,
  createReviewTarget,
  createReviewTargetV2,
  migrateReviewTargetToV2,
} from "../../../../src/review/index.js";
import type {
  ReviewIssueV3,
  ReviewIssueV4,
  ReviewProposedEditV4,
  ReviewSourceContextV3,
  ReviewFindingV1,
} from "../../../../src/review/contracts.js";
import {
  admitReviewDeliveryAction,
  createReviewDeliveryGrant,
  createReviewDeliveryPlan,
  compileReviewSuggestion,
  discoverReviewDeliveryExtensions,
  type ReviewDeliveryPlanInput,
  type ReviewDeliveryExtensions,
} from "../../../../src/review-delivery/index.js";

const BASE = "a".repeat(40);
const START = "c".repeat(40);
const HEAD = "b".repeat(40);
const HASH = "d".repeat(64);
const REPLACED_BEFORE = new TextEncoder().encode("before\n");
const AFTER = new TextEncoder().encode("after\n");
const HOSTILE = "@maintainer /approve https://evil.example/attack";

export function fixture(
  provider: "gitlab" | "github",
  change: "addition" | "replacement" = "addition",
  options: {
    issues?: readonly (ReviewIssueV3 | ReviewIssueV4)[];
    contexts?: readonly ReviewSourceContextV3[];
    findings?: readonly ReviewFindingV1[];
    summary?: boolean;
    inline?: boolean;
    hostedReportUrl?: string;
    sameRepository?: boolean;
    filePath?: string;
  } = {},
): ReviewDeliveryPlanInput<ChangeSourceV1> {
  const filePath = options.filePath ?? "docs/guide.md";
  const file = {
    status: change === "addition" ? ("A" as const) : ("M" as const),
    similarity: null,
    oldPath: change === "addition" ? null : filePath,
    newPath: filePath,
    oldMode: null,
    newMode: null,
    oldBlob: null,
    newBlob: null,
    binary: false,
    added: 1,
    removed: change === "replacement" ? 1 : 0,
  };
  const source = createChangeSource({
    source: (provider === "gitlab"
      ? {
          kind: "gitlab-merge-request" as const,
          provenance: "forge-reported" as const,
          host: "gitlab.example.com",
          projectPath: "team/docs",
          projectId: 42,
          iid: 7,
          state: "opened" as const,
          mergeMode: null,
          diffRefs: { base: BASE, start: START, head: HEAD },
          mergeCommit: null,
          squashCommit: null,
          fork: !(options.sameRepository ?? false),
        }
      : {
          kind: "github-pull-request" as const,
          provenance: "forge-reported" as const,
          host: "github.com",
          repositoryId: 100,
          fullName: "team/docs",
          number: 7,
          state: "open" as const,
          headRepositoryId: options.sameRepository ? 100 : 200,
        }) as ChangeSourceSourceV1,
    revision: {
      schemaVersion: 1,
      kind: "docsfab-pinned-repository-revision",
      repository:
        provider === "gitlab"
          ? gitlabProjectIdentity({ host: "gitlab.example.com", projectId: 42 })
          : githubRepositoryIdentity({ host: "github.com", repositoryId: 100 }),
      base: BASE,
      head: HEAD,
    },
    objectFormat: "sha1",
    rangeSemantics: provider === "gitlab" ? "two-dot" : "three-dot",
    mergeBase: provider === "gitlab" ? null : BASE,
    diffFrom: BASE,
    baseTree: null,
    headTree: null,
    commits: [{ id: HEAD, parents: [BASE], subject: "Change docs" }],
    files: [file],
    labels: [],
    protocol: { provider },
  });
  const common = {
    sourceBranch: "topic",
    targetBranch: "main",
    baseSha: BASE,
    headSha: HEAD,
    trigger: "api" as const,
    requestIdentitySha256: HASH,
    workflow: "review-documentation",
    deliveryIntent: "comment-existing-mr" as const,
    logicalRequestId: "request:7",
    changeSourceSha256: source.changeSourceSha256,
  };
  const target = createReviewTargetV2(
    provider === "gitlab"
      ? {
          ...common,
          scmProvider: "gitlab",
          host: "gitlab.example.com",
          projectId: 42,
          mergeRequestIid: 7,
          sourceFork: !(options.sameRepository ?? false),
        }
      : {
          ...common,
          scmProvider: "github",
          host: "github.com",
          repositoryId: 100,
          headRepositoryId: options.sameRepository ? 100 : 200,
          pullRequestNumber: 7,
        },
    source,
  );
  const resultInput = {
    taskId: "task:7",
    runIdSha256: HASH,
    findings: [
      {
        id: "finding:1",
        severity: "warning",
        code: "docs-gap",
        summary: HOSTILE,
        path: filePath,
        line: 1,
        evidence: "Full retained evidence",
        recommendation: "Explain the new value.",
      },
    ],
    issues: [
      {
        id: "issue:1",
        producerStepId: "review",
        producerSkill: "technical-review",
        originalId: "TECH-1",
        severity: "warning",
        originalSeverity: "major",
        category: "technical_accuracy",
        finding: "The new value needs an explanation.",
        location: `${filePath}:1`,
        path: filePath,
        line: 1,
        locationFidelity: "exact",
        evidence: { sourceId: "source:1", locator: `${filePath}:1` },
        requiredChange: "Use the new value.",
        limitations: [],
        sourceContextId: "context:1",
        factRefs: [{ dimensionIndex: 0, factIndex: 0 }],
      },
    ],
    sourceContexts: [
      {
        id: "context:1",
        completeness: "bounded-not-proven",
        limitations: ["One source was reviewed."],
        dimensions: [
          {
            dimension: "technical",
            status: "applicable",
            reason: "Changed documentation",
            sourceLocators: [`${filePath}:1`],
            facts: [
              {
                id: "fact:1",
                dimension: "technical",
                sourceLocators: [`${filePath}:1`],
                statement: "The source uses the new value.",
                documentationDisposition: "conflicting",
                uncertainty: "none",
                issueIds: ["TECH-1"],
              },
            ],
          },
        ],
      },
    ],
    checks: [{ id: "check:1", name: "Source check", status: "passed" }],
    unresolvedQuestions: [{ id: "question:1", summary: "Is the example current?" }],
    affectedPaths: [filePath],
    reviewScope: {
      scope: "focused-set",
      reviewedCount: 1,
      corpusFileCount: 2,
      deferredPaths: ["docs/later.md"],
      anchorPaths: [],
      scopeSha256: HASH,
      reviewRevision: HEAD,
      accounting: {
        radiusSha256: HASH,
        radiusPageCount: 2,
        listedPageCount: 2,
        unlistedPageCount: 0,
        unreviewableNeighbourCount: 0,
        changedPathCount: 1,
        continuationCharacterLimit:
          LIMIT_DEFINITION_BY_NAME["reviewFindings.coverageContinuationMinChars"]!.value,
      },
      canonSha256: HASH,
    },
    patchLocator: { kind: "artifact-digest", digestSha256: HASH },
    locatorSha256:
      provider === "gitlab"
        ? digestGitlabMrReviewLocator({
            host: "gitlab.example.com",
            projectId: 42,
            mergeRequestIid: 7,
          })
        : null,
  };
  const result = createReviewResultV2(target, source, {
    ...resultInput,
    findings: options.findings ?? resultInput.findings,
    issues: options.issues ?? resultInput.issues,
    sourceContexts: options.contexts ?? resultInput.sourceContexts,
    ...(options.hostedReportUrl === undefined ? {} : { hostedReportUrl: options.hostedReportUrl }),
  });
  return {
    target,
    source,
    result,
    snapshot: {
      changeSourceSha256: source.changeSourceSha256,
      files: [
        {
          oldPath: change === "addition" ? null : filePath,
          newPath: filePath,
          beforeBytes: change === "replacement" ? REPLACED_BEFORE : null,
          afterBytes: AFTER,
          beforeSha256: change === "replacement" ? sha256(REPLACED_BEFORE) : null,
          afterSha256: sha256(AFTER),
          state: "complete",
          hunks: [
            {
              lines: [
                ...(change === "replacement"
                  ? [{ kind: "removed" as const, text: "before", beforeLine: 1, afterLine: null }]
                  : []),
                { kind: "added", text: "after", beforeLine: null, afterLine: 1 },
              ],
            },
          ],
        },
      ],
    },
    artifact: {
      kind: "retained-review-result",
      id: "artifact:7",
      resultSha256: result.resultSha256,
    },
    actor: { host: target.host, id: "user:42" },
    capabilities: {
      scmProvider: provider,
      host: target.host,
      summary: options.summary ?? true,
      inline: options.inline ?? true,
    },
  };
}

export function richFixture(
  provider: "gitlab" | "github",
  edit: ReviewProposedEditV4 = { kind: "advice", text: "Set the documented default explicitly." },
  change: "addition" | "replacement" = "addition",
) {
  const seed = fixture(provider, change);
  const issue = (seed.result as { issues: readonly ReviewIssueV3[] }).issues[0]!;
  const context = (seed.result as { sourceContexts: readonly ReviewSourceContextV3[] })
    .sourceContexts[0]!;
  const first = context.dimensions[0]!.facts[0]!;
  const second = {
    ...first,
    id: "fact:override",
    sourceLocators: ["src/override.ts:2"],
    statement: "The override applies only to this project.",
    uncertainty: "Only in one project.",
  };
  const rich: ReviewIssueV4 = {
    ...issue,
    finding: "Legacy finding\rwith a second line.",
    requiredChange: "Legacy action shared by independent edits.\r\nKeep the scoped override.",
    limitations: ["The source may have changed."],
    factRefs: [
      { dimensionIndex: 0, factIndex: 0 },
      { dimensionIndex: 0, factIndex: 1 },
    ],
    rich: {
      status: "admitted",
      candidateSha256: HASH,
      title: "Correct the default\rwith all title lines",
      readerConsequence: "Readers may choose an incorrect setting.",
      proposedEdit: edit,
      grounding: [
        {
          factId: first.id,
          qualification: first.uncertainty,
          status: "supported",
          rationale: "The source states the default.",
          sourceLocators: first.sourceLocators,
        },
        {
          factId: second.id,
          qualification: second.uncertainty,
          status: "supported",
          rationale: "The override is scoped.",
          sourceLocators: second.sourceLocators,
        },
      ],
    },
  };
  return fixture(provider, change, {
    issues: [rich],
    contexts: [
      {
        ...context,
        limitations: ["Only sampled sources were checked."],
        dimensions: [
          {
            ...context.dimensions[0]!,
            status: "unverified",
            reason: "Independent qualification is pending.",
            facts: [first, second],
          },
        ],
      },
    ],
  });
}
