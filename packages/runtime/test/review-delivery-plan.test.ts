// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { sha256 } from "../src/content-ir/canonical.js";
import { LIMIT_DEFINITION_BY_NAME } from "../src/config/limits.generated.js";
import {
  createChangeSource,
  CHANGE_SOURCE_DIFF_PROTOCOL,
  type ChangeSourceSourceV1,
  type ChangeSourceV1,
} from "../src/inputs/change-source.js";
import {
  gitlabProjectIdentity,
  githubRepositoryIdentity,
} from "../src/inputs/change-source/revision.js";
import { digestGitlabMrReviewLocator } from "../src/inputs/gitlab-mr-locator.js";
import {
  createReviewResult,
  createReviewResultV2,
  createReviewTarget,
  createReviewTargetV2,
  migrateReviewTargetToV2,
} from "../src/review/index.js";
import {
  admitReviewDeliveryAction,
  createReviewDeliveryGrant,
  createReviewDeliveryPlan,
  compileReviewSuggestion,
  discoverReviewDeliveryExtensions,
  reviewDeliverySnapshotDigest,
  type ReviewDeliveryPlanInput,
  type ReviewDeliveryExtensions,
} from "../src/review-delivery/index.js";
import type {
  ReviewReplyActionV2,
  ReviewReplyAuthorizationDecisionV2,
  ReviewReplyAuthorizationV2,
  ReviewReplyFeedbackDispositionV2,
  ReviewReplyFeedbackScopeV2,
  ReviewReplyGrantV2,
  ReviewReplyIngressV2,
  ReviewReplyIntentV2,
  ReviewScopedFeedbackReadResultV2,
  ReviewScopedFeedbackRecordResultV2,
  ScopedFeedbackPortV2,
} from "../src/review-delivery/index.js";

type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends <Value>() => Value extends Right ? 1 : 2
    ? true
    : false;
type Assert<Condition extends true> = Condition;

type _ReplyActionV2HasClosedIntentSet = Assert<
  Equal<ReviewReplyActionV2["intent"], ReviewReplyIntentV2>
>;
type _ReplyActionV2HasSchemaVersion = Assert<Equal<ReviewReplyActionV2["schemaVersion"], 2>>;
type _ReplyActionPayloadTagsMatchIntents = Assert<
  Equal<ReviewReplyActionV2["payload"]["kind"], ReviewReplyIntentV2>
>;
type _ReplyFeedbackHasAllDispositions = Assert<
  Equal<
    ReviewReplyFeedbackDispositionV2,
    "useful" | "incorrect" | "irrelevant" | "already-covered" | "intentional" | "deferred"
  >
>;
type _ReplyFeedbackHasAllScopes = Assert<
  Equal<ReviewReplyFeedbackScopeV2, "observation" | "proven-issue-lineage" | "selected-review">
>;
type _ReplyIngressHasProviderAndLocalArms = Assert<
  Equal<ReviewReplyIngressV2["kind"], "provider-reply" | "local-invocation">
>;
type _ReplyFeedbackPayloadKeepsFields = Assert<
  Equal<
    Extract<ReviewReplyActionV2, { readonly intent: "record-feedback" }>["payload"]["kind"],
    "record-feedback"
  >
>;
type _ReplyAuthorizationKeepsBothOutcomes = Assert<
  Equal<ReviewReplyAuthorizationDecisionV2["kind"], "admitted" | "denied">
>;
type _ReplyAuthorizationPortReturnsDecision = Assert<
  Equal<ReturnType<ReviewReplyAuthorizationV2["verifyCurrent"]>, ReviewReplyAuthorizationDecisionV2>
>;
type _ReplyAuthorizationAdmittedGrantType = Assert<
  Equal<
    Extract<ReviewReplyAuthorizationDecisionV2, { readonly kind: "admitted" }>["opaqueGrant"],
    ReviewReplyGrantV2
  >
>;
type _ScopedFeedbackRecordOutcomes = Assert<
  Equal<
    ReviewScopedFeedbackRecordResultV2["kind"],
    "recorded" | "duplicate" | "conflict" | "unsupported"
  >
>;
type _ScopedFeedbackReadOutcomes = Assert<
  Equal<ReviewScopedFeedbackReadResultV2["kind"], "found" | "unavailable">
>;
type _ScopedFeedbackPortUsesReplyAction = Assert<
  Equal<Parameters<ScopedFeedbackPortV2["record"]>[0]["action"]["intent"], "record-feedback">
>;

const BASE = "a".repeat(40);
const START = "c".repeat(40);
const HEAD = "b".repeat(40);
const HASH = "d".repeat(64);
const REPLACED_BEFORE = new TextEncoder().encode("before\n");
const AFTER = new TextEncoder().encode("after\n");
const HOSTILE = "@maintainer /approve https://evil.example/attack";

function gitBlobId(bytes: Uint8Array): string {
  return createHash("sha1")
    .update(new TextEncoder().encode(`blob ${bytes.length}\0`))
    .update(bytes)
    .digest("hex");
}

interface MixedGitlink {
  readonly state: "absent" | "truncated" | "complete";
  readonly oldMode?: string;
  readonly newMode?: string;
  readonly documentMode?: "100644" | "120000";
}

function fixture(
  provider: "gitlab" | "github",
  change: "addition" | "replacement" = "addition",
  inventory: "paired" | "empty" = "paired",
  mixedGitlink?: MixedGitlink,
): ReviewDeliveryPlanInput<ChangeSourceV1> {
  const file = {
    status:
      mixedGitlink === undefined
        ? change === "addition"
          ? ("A" as const)
          : ("M" as const)
        : ("R" as const),
    similarity:
      mixedGitlink === undefined ? null : CHANGE_SOURCE_DIFF_PROTOCOL.renameSimilarityPercent,
    oldPath:
      mixedGitlink === undefined
        ? change === "addition"
          ? null
          : "docs/guide.md"
        : "docs/old-guide.md",
    newPath: "docs/guide.md",
    oldMode: mixedGitlink === undefined ? null : "100644",
    newMode: mixedGitlink === undefined ? null : (mixedGitlink.documentMode ?? "100644"),
    oldBlob: mixedGitlink === undefined ? null : gitBlobId(REPLACED_BEFORE),
    newBlob: mixedGitlink === undefined ? null : gitBlobId(AFTER),
    binary: false,
    added: 1,
    removed: mixedGitlink !== undefined || change === "replacement" ? 1 : 0,
  };
  const source = createChangeSource({
    source: (provider === "gitlab"
      ? {
          kind: "gitlab-merge-request" as const,
          provenance:
            mixedGitlink === undefined ? ("forge-reported" as const) : ("local-verified" as const),
          host: "gitlab.example.com",
          projectPath: "team/docs",
          projectId: 42,
          iid: 7,
          state: "opened" as const,
          mergeMode: null,
          diffRefs: { base: BASE, start: START, head: HEAD },
          mergeCommit: null,
          squashCommit: null,
          fork: true,
        }
      : {
          kind: "github-pull-request" as const,
          provenance: "forge-reported" as const,
          host: "github.com",
          repositoryId: 100,
          fullName: "team/docs",
          number: 7,
          state: "open" as const,
          headRepositoryId: 200,
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
    baseTree: mixedGitlink === undefined ? null : "e".repeat(40),
    headTree: mixedGitlink === undefined ? null : "f".repeat(40),
    commits: [{ id: HEAD, parents: [BASE], subject: "Change docs" }],
    files:
      mixedGitlink === undefined
        ? [file]
        : [
            file,
            {
              status: "M" as const,
              similarity: null,
              oldPath: "vendor/sdk",
              newPath: "vendor/sdk",
              oldMode: mixedGitlink.oldMode ?? "160000",
              newMode: mixedGitlink.newMode ?? "160000",
              oldBlob: "1".repeat(40),
              newBlob: "2".repeat(40),
              binary: true,
              added: null,
              removed: null,
            },
          ],
    labels: [],
    protocol:
      mixedGitlink === undefined || provider === "github"
        ? { provider }
        : CHANGE_SOURCE_DIFF_PROTOCOL,
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
          sourceFork: true,
        }
      : {
          ...common,
          scmProvider: "github",
          host: "github.com",
          repositoryId: 100,
          headRepositoryId: 200,
          pullRequestNumber: 7,
        },
    source,
  );
  const result = createReviewResultV2(target, source, {
    taskId: "task:7",
    runIdSha256: HASH,
    findings:
      inventory === "empty"
        ? []
        : [
            {
              id: "finding:1",
              severity: "warning",
              code: "docs-gap",
              summary: HOSTILE,
              path: "docs/guide.md",
              line: 1,
              evidence: "Full retained evidence",
              recommendation: "Explain the new value.",
            },
            ...(mixedGitlink === undefined
              ? []
              : [
                  {
                    id: "finding:gitlink",
                    severity: "warning" as const,
                    code: "dependency-review",
                    summary: "The changed dependency needs review.",
                    path: "vendor/sdk",
                    line: 1,
                    evidence: "The gitlink changed revisions.",
                    recommendation: "Inspect the dependency revision.",
                  },
                ]),
          ],
    issues:
      inventory === "empty"
        ? []
        : [
            {
              id: "issue:1",
              producerStepId: "review",
              producerSkill: "technical-review",
              originalId: "TECH-1",
              severity: "warning",
              originalSeverity: "major",
              category: "technical_accuracy",
              finding: "The new value needs an explanation.",
              location: "docs/guide.md:1",
              path: "docs/guide.md",
              line: 1,
              locationFidelity: "exact",
              evidence: { sourceId: "source:1", locator: "docs/guide.md:1" },
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
            sourceLocators: ["docs/guide.md:1"],
            facts: [
              {
                id: "fact:1",
                dimension: "technical",
                sourceLocators: ["docs/guide.md:1"],
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
    affectedPaths: mixedGitlink === undefined ? ["docs/guide.md"] : ["docs/guide.md", "vendor/sdk"],
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
        changedPathCount: mixedGitlink === undefined ? 1 : 2,
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
  });
  return {
    target,
    source,
    result,
    snapshot: {
      changeSourceSha256: source.changeSourceSha256,
      files: [
        {
          oldPath:
            mixedGitlink === undefined
              ? change === "addition"
                ? null
                : "docs/guide.md"
              : "docs/old-guide.md",
          newPath: "docs/guide.md",
          beforeBytes:
            mixedGitlink !== undefined || change === "replacement" ? REPLACED_BEFORE : null,
          afterBytes: AFTER,
          beforeSha256:
            mixedGitlink !== undefined || change === "replacement" ? sha256(REPLACED_BEFORE) : null,
          afterSha256: sha256(AFTER),
          state: "complete",
          hunks: [
            {
              lines: [
                ...(mixedGitlink !== undefined || change === "replacement"
                  ? [{ kind: "removed" as const, text: "before", beforeLine: 1, afterLine: null }]
                  : []),
                { kind: "added", text: "after", beforeLine: null, afterLine: 1 },
              ],
            },
          ],
        },
        ...(mixedGitlink === undefined
          ? []
          : [
              {
                oldPath: "vendor/sdk",
                newPath: "vendor/sdk",
                beforeBytes: null,
                afterBytes: null,
                beforeSha256: null,
                afterSha256: null,
                state: mixedGitlink.state,
                hunks: [],
              },
            ]),
      ],
    },
    artifact: {
      kind: "retained-review-result",
      id: "artifact:7",
      resultSha256: result.resultSha256,
    },
    actor: { host: target.host, id: "user:42" },
    capabilities: { scmProvider: provider, host: target.host, summary: true, inline: true },
  };
}

describe("retained review delivery plan", () => {
  it("preserves released default and explicit-action canonical identities", () => {
    const input = fixture("gitlab");
    const baseline = createReviewDeliveryPlan(input);
    const overview = createReviewDeliveryPlan({ ...input, requestedActions: "overview" });
    const summaryOnly = createReviewDeliveryPlan({ ...input, requestedActions: "summary-only" });
    expect({
      snapshot: baseline.snapshotSha256,
      inline: baseline.actions.map((action) => action.id),
      overview: overview.actions.map((action) => action.id),
      summaryOnly: summaryOnly.actions.map((action) => action.id),
    }).toEqual({
      snapshot: "56d97f3dc76cb6e5fdd3acf4fffd6db303103045c608071fc9388955b3ac9f65",
      inline: [
        "f735b33b7a5bf2184d70006d5d3b4d2e75df0d9b020a20e87a51bcb78a4fdc72",
        "89c867b38dbeff380609c545a7f8db0c536cf9920d75466fcbbc01fccdcf37e4",
      ],
      overview: [
        "f29fb80c95e6d662375187bae3c6ddd32d10222576d542400a4e9bb8956e34bf",
        "f735b33b7a5bf2184d70006d5d3b4d2e75df0d9b020a20e87a51bcb78a4fdc72",
        "89c867b38dbeff380609c545a7f8db0c536cf9920d75466fcbbc01fccdcf37e4",
      ],
      summaryOnly: ["058e21e42da96535f80e87ef0c81a86504bf1e635d02793843ab5264b56480f4"],
    });
    expect(baseline.actions).toHaveLength(2);
    expect(overview.actions).toHaveLength(3);
    expect(summaryOnly.actions).toHaveLength(1);
  });

  it.each(["gitlab", "github"] as const)(
    "creates an exact empty overview for an authentic zero-finding %s result",
    (provider) => {
      const input = fixture(provider, "addition", "empty");
      const baseline = createReviewDeliveryPlan(input);
      expect(baseline.findings).toEqual([]);
      expect(baseline.actions).toEqual([]);
      expect("requestedActions" in baseline).toBe(false);
      expect(createReviewDeliveryPlan({ ...input, requestedActions: undefined })).toEqual(baseline);

      const overview = createReviewDeliveryPlan({ ...input, requestedActions: "overview" });
      expect(overview.requestedActions).toBe("overview");
      expect(overview.findings).toEqual([]);
      expect(overview.actions).toMatchObject([{ kind: "publish-summary", findingIds: [] }]);
      expect(overview.actions).toHaveLength(1);
      expect(overview.actions[0]!.binding.startSha).toBe(provider === "gitlab" ? START : null);

      const summaryOnly = createReviewDeliveryPlan({
        ...input,
        requestedActions: "summary-only",
      });
      expect(summaryOnly.requestedActions).toBe("summary-only");
      expect(summaryOnly.actions).toEqual(overview.actions);
    },
  );

  it.each(["gitlab", "github"] as const)(
    "adds an overview to all-inline %s results and converts only eligible findings for summary-only",
    (provider) => {
      const input = fixture(provider);
      const baseline = createReviewDeliveryPlan(input);
      expect(baseline.actions).toHaveLength(baseline.findings.length);
      expect(baseline.actions.every((action) => action.kind === "publish-inline")).toBe(true);
      const overview = createReviewDeliveryPlan({ ...input, requestedActions: "overview" });
      expect(overview.actions[0]).toMatchObject({ kind: "publish-summary", findingIds: [] });
      expect(overview.actions.slice(1)).toEqual(baseline.actions);
      expect(overview.findings).toEqual(baseline.findings);

      const summaryOnly = createReviewDeliveryPlan({
        ...input,
        requestedActions: "summary-only",
      });
      expect(summaryOnly.actions).toMatchObject([
        { kind: "publish-summary", findingIds: baseline.findings.map((item) => item.inventoryId) },
      ]);
      expect(summaryOnly.actions).toHaveLength(1);
      expect(summaryOnly.findings.map((finding) => finding.disposition)).toEqual(
        baseline.findings.map(() => ({ kind: "summary-candidate", reason: "delivery-intent" })),
      );
      expect(summaryOnly.findings.map(({ disposition: _disposition, ...rest }) => rest)).toEqual(
        baseline.findings.map(({ disposition: _disposition, ...rest }) => rest),
      );
    },
  );

  it("preserves presentation-retained and pre-existing summary dispositions in summary-only", () => {
    const input = fixture("github", "replacement");
    const replacement = createReviewDeliveryPlan({ ...input, requestedActions: "summary-only" });
    expect(replacement.findings.map((finding) => finding.disposition)).toEqual([
      { kind: "summary-candidate", reason: "ambiguous-side" },
      { kind: "summary-candidate", reason: "ambiguous-side" },
    ]);
    expect(replacement.actions).toMatchObject([
      { kind: "publish-summary", findingIds: replacement.findings.map((item) => item.inventoryId) },
    ]);

    const retained = createReviewDeliveryPlan({
      ...fixture("github"),
      requestedActions: "summary-only",
      extensions: {
        presentation: { select: (finding) => (finding.source === "issue" ? "retained" : "inline") },
      },
    });
    expect(retained.findings[0]?.disposition).toEqual({
      kind: "unsupported",
      reason: "presentation-unsupported",
    });
    expect(retained.findings[1]?.disposition).toEqual({
      kind: "summary-candidate",
      reason: "delivery-intent",
    });
    expect(retained.actions).toMatchObject([
      { kind: "publish-summary", findingIds: [retained.findings[1]!.inventoryId] },
    ]);
  });

  it("rejects invalid explicit mode or missing summary capability without changing the default", () => {
    const input = fixture("github");
    expect(() =>
      createReviewDeliveryPlan({ ...input, requestedActions: "invalid" as never }),
    ).toThrowError("invalid-requested-actions");
    const noSummary = {
      ...input,
      capabilities: { ...input.capabilities, summary: false },
    };
    expect(
      createReviewDeliveryPlan(noSummary).actions.every(
        (action) => action.kind === "publish-inline",
      ),
    ).toBe(true);
    for (const requestedActions of ["overview", "summary-only"] as const) {
      expect(() => createReviewDeliveryPlan({ ...noSummary, requestedActions })).toThrowError(
        "summary-unavailable",
      );
    }
  });

  it("captures summary-only intent before a presentation callback mutates its caller", () => {
    const input = { ...fixture("github"), requestedActions: "summary-only" as const };
    Reflect.set(input, "extensions", {
      presentation: {
        select: () => {
          Reflect.set(input, "requestedActions", "overview");
          return "inline";
        },
      },
    });
    const plan = createReviewDeliveryPlan(input);
    expect(plan.requestedActions).toBe("summary-only");
    expect(plan.actions.map((action) => action.kind)).toEqual(["publish-summary"]);
  });

  it("retains a canonical same-path replacement when the result has no side evidence", () => {
    const admitted = fixture("github", "replacement");
    const plan = createReviewDeliveryPlan(admitted);
    expect(plan.result.reviewedHeadSha).toBe(HEAD);
    expect(plan.findings.map((finding) => finding.disposition)).toEqual([
      { kind: "summary-candidate", reason: "ambiguous-side" },
      { kind: "summary-candidate", reason: "ambiguous-side" },
    ]);
    expect(plan.actions.map((action) => action.kind)).toEqual(["publish-summary"]);
  });

  it("projects paired canonical providers into equivalent issue/coverage/action inventory", () => {
    const gitlab = createReviewDeliveryPlan(fixture("gitlab"));
    const github = createReviewDeliveryPlan(fixture("github"));
    expect(gitlab.findings.map((finding) => [finding.source, finding.disposition.kind])).toEqual(
      github.findings.map((finding) => [finding.source, finding.disposition.kind]),
    );
    expect(gitlab.findings).toHaveLength(2);
    expect(gitlab.findings[0]).toMatchObject({
      retained: {
        collection: "issues",
        index: 0,
        resultSha256: gitlab.result.originalResultSha256,
      },
      groupIds: ["path:docs/guide.md", "context:context:1"],
      relatedLocations: ["docs/guide.md:1"],
    });
    expect(gitlab.sourceContexts).toHaveLength(1);
    expect(gitlab.actions.map((action) => action.kind)).toEqual([
      "publish-inline",
      "publish-inline",
    ]);
    expect(gitlab.actions.map((action) => action.kind)).toEqual(
      github.actions.map((action) => action.kind),
    );
    expect(gitlab.actions[0]?.binding.startSha).toBe(START);
    expect(github.actions[0]?.binding.startSha).toBeNull();
    expect(gitlab.target.scmProvider).toBe("gitlab");
    expect(github.target.scmProvider).toBe("github");
    expect(github.target).toMatchObject({ repositoryId: 100, headRepositoryId: 200 });
    expect(gitlab.result.originalResultCanonicalJson).toContain(HOSTILE);
    expect(JSON.stringify(gitlab.actions)).not.toContain(HOSTILE);
    expect(gitlab.checks).toHaveLength(1);
    expect(gitlab.unresolvedQuestions).toHaveLength(1);
    expect(gitlab.reviewScope).toEqual(github.reviewScope);
    expect(gitlab.reviewScope?.deferredPaths).toEqual(["docs/later.md"]);
  });

  it("keeps absent diff and legacy omissions in the retained summary", () => {
    const base = fixture("gitlab");
    const absent = createReviewDeliveryPlan({
      ...base,
      snapshot: {
        ...base.snapshot,
        files: base.snapshot.files.map((file) => ({
          ...file,
          state: "absent" as const,
          hunks: [],
        })),
      },
    });
    expect(
      absent.findings.every((finding) => finding.disposition.kind === "summary-candidate"),
    ).toBe(true);
    expect(absent.actions).toHaveLength(1);
    expect(absent.actions[0]).toMatchObject({
      kind: "publish-summary",
      findingIds: expect.arrayContaining(absent.findings.map((f) => f.inventoryId)),
    });

    const source = base.source;
    const oldTarget = createReviewTarget({
      scmProvider: "gitlab",
      host: "gitlab.example.com",
      projectId: 42,
      mergeRequestIid: 7,
      sourceBranch: "topic",
      targetBranch: "main",
      headSha: HEAD,
      trigger: "api",
      requestIdentitySha256: HASH,
      workflow: "review-documentation",
      deliveryIntent: "comment-existing-mr",
      logicalRequestId: "request:7",
    });
    const oldResult = createReviewResult(oldTarget, {
      taskId: "task:legacy",
      runIdSha256: HASH,
      findings: [
        {
          id: "finding:1",
          severity: "warning",
          code: "docs-gap",
          summary: HOSTILE,
          path: "docs/guide.md",
        },
      ],
      checks: [],
      unresolvedQuestions: [],
      affectedPaths: ["docs/guide.md"],
      patchLocator: null,
      locatorSha256: digestGitlabMrReviewLocator({
        host: "gitlab.example.com",
        projectId: 42,
        mergeRequestIid: 7,
      }),
    });
    const migration = migrateReviewTargetToV2(oldTarget, source);
    const legacy = createReviewDeliveryPlan({
      ...base,
      target: migration,
      result: oldResult,
      artifact: { ...base.artifact, resultSha256: oldResult.resultSha256 },
    });
    expect(legacy.result.originalSchemaVersion).toBe(1);
    expect(Object.hasOwn(legacy.result, "issues")).toBe(false);
    expect(legacy.findings[0]?.disposition.kind).toBe("summary-candidate");
    expect(legacy.findings[0]?.logicalIssueId).toContain(oldResult.resultSha256);
    const oldInput = {
      taskId: "task:legacy",
      runIdSha256: HASH,
      findings: [
        {
          id: "finding:1",
          severity: "warning" as const,
          code: "docs-gap",
          summary: HOSTILE,
          path: "docs/guide.md",
        },
      ],
      checks: [],
      unresolvedQuestions: [],
      affectedPaths: ["docs/guide.md"],
      patchLocator: null,
      locatorSha256: digestGitlabMrReviewLocator({
        host: "gitlab.example.com",
        projectId: 42,
        mergeRequestIid: 7,
      }),
    };
    const second = createReviewResult(oldTarget, {
      ...oldInput,
      qualityReport: {
        schemaVersion: 1,
        kind: "docsfab-quality-report-projection",
        decision: "pass",
        confidence: 0.9,
        hardGateFailures: [],
        limitations: [],
        rubric: {
          status: "available",
          id: "task-guide-v0.1",
          total: 84,
          threshold: 80,
          interpretationBand: "Green",
          decision: "pass",
          confidence: 0.9,
        },
        reportLocator: { kind: "artifact-digest", digestSha256: HASH },
        repositoryRevision: HEAD,
        patchSha256: null,
      },
    } as never);
    const projectedSecond = createReviewDeliveryPlan({
      ...base,
      target: migration,
      result: second,
      artifact: { ...base.artifact, resultSha256: second.resultSha256 },
    });
    expect(projectedSecond.result.originalSchemaVersion).toBe(2);
    expect(Object.hasOwn(projectedSecond.result, "issues")).toBe(false);
    expect(projectedSecond.findings[0]?.logicalIssueId).not.toBe(
      legacy.findings[0]?.logicalIssueId,
    );
    const third = createReviewResult(oldTarget, {
      ...oldInput,
      issues: [],
      sourceContexts: [],
      qualityReport: null,
    } as never);
    const projectedThird = createReviewDeliveryPlan({
      ...base,
      target: migration,
      result: third,
      artifact: { ...base.artifact, resultSha256: third.resultSha256 },
    });
    expect(projectedThird.result.originalSchemaVersion).toBe(3);
    expect(projectedThird.result.issues).toEqual([]);
  });

  it("retains every finding when a purported complete diff omits a source edit", () => {
    const base = fixture("github", "replacement");
    const omittedRemoval = createReviewDeliveryPlan({
      ...base,
      snapshot: {
        ...base.snapshot,
        files: base.snapshot.files.map((file) => ({
          ...file,
          hunks: file.hunks.map((hunk) => ({
            lines: hunk.lines.filter((line) => line.kind !== "removed"),
          })),
        })),
      },
    });
    expect(omittedRemoval.findings.map((item) => item.disposition)).toEqual([
      { kind: "summary-candidate", reason: "diff-invalid" },
      { kind: "summary-candidate", reason: "diff-invalid" },
    ]);
    expect(omittedRemoval.actions.map((action) => action.kind)).toEqual(["publish-summary"]);
  });

  it("keeps authoritative inventory and anchors outside mutable presentation views", () => {
    const input = fixture("github");
    const control = createReviewDeliveryPlan(input);
    const rejectedWrites: boolean[] = [];
    const planned = createReviewDeliveryPlan({
      ...input,
      extensions: {
        presentation: {
          select(draft) {
            rejectedWrites.push(Reflect.set(draft, "inventoryId", "replaced"));
            if (draft.disposition.kind === "inline-candidate")
              rejectedWrites.push(Reflect.set(draft.disposition.anchor, "startLine", 999));
            return "inline";
          },
        },
      },
    });
    expect(rejectedWrites).toEqual([false, false, false, false]);
    expect(planned.findings).toEqual(control.findings);
    expect(planned.actions).toEqual(control.actions);
    expect(new Set(planned.findings.map((finding) => finding.inventoryId)).size).toBe(2);
    expect(
      planned.actions.every(
        (action) => action.kind !== "publish-inline" || action.anchor.startLine === 1,
      ),
    ).toBe(true);
  });

  it("plans all anchors from one private snapshot before callbacks can change caller input", () => {
    const input = fixture("github");
    const control = createReviewDeliveryPlan(input);
    let selections = 0;
    const planned = createReviewDeliveryPlan({
      ...input,
      extensions: {
        presentation: {
          select() {
            selections++;
            if (selections === 1) {
              const changed = new TextEncoder().encode("mutated\n");
              Reflect.set(input.snapshot.files[0]!, "afterBytes", changed);
              Reflect.set(input.snapshot.files[0]!, "afterSha256", sha256(changed));
              Reflect.set(input.snapshot.files[0]!, "hunks", [
                {
                  lines: [{ kind: "added", text: "mutated", beforeLine: null, afterLine: 1 }],
                },
              ]);
            }
            return "inline";
          },
        },
      },
    });
    expect(selections).toBe(2);
    expect(planned.snapshotSha256).toBe(control.snapshotSha256);
    expect(planned.findings).toEqual(control.findings);
    expect(planned.actions).toEqual(control.actions);
  });

  it.each(["gitlab", "github"] as const)(
    "keeps an independent %s document inline beside an unavailable gitlink side",
    (provider) => {
      for (const state of ["absent", "truncated"] as const) {
        const input = fixture(provider, "addition", "paired", { state });
        const plan = createReviewDeliveryPlan(input);
        expect(plan.source.files.map((file) => file.newPath)).toEqual([
          "docs/guide.md",
          "vendor/sdk",
        ]);
        expect(plan.source.files[1]).toMatchObject({
          oldMode: "160000",
          newMode: "160000",
        });
        expect(plan.findings.filter((finding) => finding.path === "docs/guide.md")).toHaveLength(2);
        expect(
          plan.findings
            .filter((finding) => finding.path === "docs/guide.md")
            .map((finding) => finding.disposition.kind),
        ).toEqual(["inline-candidate", "inline-candidate"]);
        expect(plan.findings.find((finding) => finding.path === "vendor/sdk")?.disposition).toEqual(
          {
            kind: "summary-candidate",
            reason: state === "absent" ? "diff-absent" : "diff-truncated",
          },
        );
        expect(plan.actions.map((action) => action.kind)).toEqual([
          "publish-summary",
          "publish-inline",
          "publish-inline",
        ]);
        expect(reviewDeliverySnapshotDigest(input.snapshot, input.source)).toBe(
          plan.snapshotSha256,
        );
      }
    },
  );

  it("allows missing bytes only for the exact unavailable gitlink side and bound row", () => {
    for (const mode of ["100644", "120000"]) {
      expect(() =>
        createReviewDeliveryPlan(
          fixture("gitlab", "addition", "paired", { state: "absent", oldMode: mode }),
        ),
      ).toThrowError("snapshot-mismatch");
      expect(() =>
        createReviewDeliveryPlan(
          fixture("gitlab", "addition", "paired", { state: "truncated", newMode: mode }),
        ),
      ).toThrowError("snapshot-mismatch");
    }
    expect(() =>
      createReviewDeliveryPlan(fixture("gitlab", "addition", "paired", { state: "complete" })),
    ).toThrowError("snapshot-mismatch");

    const input = fixture("gitlab", "addition", "paired", { state: "absent" });
    expect(() =>
      createReviewDeliveryPlan({
        ...input,
        snapshot: { ...input.snapshot, files: [...input.snapshot.files].reverse() },
      }),
    ).toThrowError("snapshot-mismatch");
    expect(() =>
      createReviewDeliveryPlan({
        ...input,
        snapshot: {
          ...input.snapshot,
          files: [
            input.snapshot.files[0]!,
            { ...input.snapshot.files[1]!, newPath: "vendor/other" },
          ],
        },
      }),
    ).toThrowError("snapshot-mismatch");
    const foreign = fixture("github", "addition", "paired", { state: "absent" });
    expect(() => createReviewDeliveryPlan({ ...input, source: foreign.source })).toThrowError(
      "digest-mismatch",
    );
  });

  it.each(["100644", "120000"] as const)(
    "still verifies %s document bytes and preserves per-finding fallback",
    (documentMode) => {
      const input = fixture("gitlab", "addition", "paired", {
        state: "absent",
        documentMode,
      });
      const document = input.snapshot.files[0]!;
      const changed = new TextEncoder().encode("tampered\n");
      expect(() =>
        createReviewDeliveryPlan({
          ...input,
          snapshot: {
            ...input.snapshot,
            files: [
              { ...document, afterBytes: changed, afterSha256: sha256(changed) },
              input.snapshot.files[1]!,
            ],
          },
        }),
      ).toThrowError("snapshot-mismatch");

      const statedHashMismatch = createReviewDeliveryPlan({
        ...input,
        snapshot: {
          ...input.snapshot,
          files: [{ ...document, afterSha256: HASH }, input.snapshot.files[1]!],
        },
      });
      expect(statedHashMismatch.findings.map((finding) => finding.disposition)).toEqual([
        { kind: "summary-candidate", reason: "source-digest-mismatch" },
        { kind: "summary-candidate", reason: "source-digest-mismatch" },
        { kind: "summary-candidate", reason: "diff-absent" },
      ]);
      const invalidHunk = createReviewDeliveryPlan({
        ...input,
        snapshot: {
          ...input.snapshot,
          files: [{ ...document, hunks: [] }, input.snapshot.files[1]!],
        },
      });
      expect(invalidHunk.findings.map((finding) => finding.disposition)).toEqual([
        { kind: "summary-candidate", reason: "diff-invalid" },
        { kind: "summary-candidate", reason: "diff-invalid" },
        { kind: "summary-candidate", reason: "diff-absent" },
      ]);
    },
  );

  it("copies one detached buffer per input identity through the real planner", () => {
    const input = fixture("github", "replacement");
    const shared = new TextEncoder().encode("unchanged\n");
    const file = input.snapshot.files[0]!;
    const snapshot = {
      ...input.snapshot,
      files: [
        {
          ...file,
          beforeBytes: shared,
          afterBytes: shared,
          beforeSha256: sha256(shared),
          afterSha256: sha256(shared),
          hunks: [],
        },
      ],
    };
    const control = createReviewDeliveryPlan({ ...input, snapshot });
    const copies = vi.spyOn(Uint8Array, "from");
    let planned: ReturnType<typeof createReviewDeliveryPlan>;
    let selectedCopies: Uint8Array[] = [];
    try {
      planned = createReviewDeliveryPlan({ ...input, snapshot });
      selectedCopies = copies.mock.calls.flatMap((call, index) =>
        call[0] === shared ? [copies.mock.results[index]?.value as Uint8Array] : [],
      );
    } finally {
      copies.mockRestore();
    }
    expect(selectedCopies).toHaveLength(1);
    expect(selectedCopies[0]).not.toBe(shared);
    expect(planned.snapshotSha256).toBe(control.snapshotSha256);
    expect(planned.actions).toEqual(control.actions);

    const equalButDistinct = new TextEncoder().encode("unchanged\n");
    const distinctSnapshot = {
      ...snapshot,
      files: [{ ...snapshot.files[0]!, beforeBytes: equalButDistinct }],
    };
    const distinctCopies = vi.spyOn(Uint8Array, "from");
    try {
      createReviewDeliveryPlan({ ...input, snapshot: distinctSnapshot });
      expect(distinctCopies.mock.calls.filter((call) => call[0] === shared)).toHaveLength(1);
      expect(distinctCopies.mock.calls.filter((call) => call[0] === equalButDistinct)).toHaveLength(
        1,
      );
    } finally {
      distinctCopies.mockRestore();
    }
    shared.fill(0);
    expect(planned.snapshotSha256).toBe(control.snapshotSha256);
  });

  it("binds snapshot, artifact, actor and exact action grants without write or model calls", () => {
    const input = fixture("github");
    const foreign = fixture("gitlab");
    expect(() =>
      createReviewDeliveryPlan({ ...input, source: foreign.source, snapshot: foreign.snapshot }),
    ).toThrowError("digest-mismatch");
    const gitlab = fixture("gitlab");
    expect(() =>
      createReviewDeliveryPlan({
        ...gitlab,
        target: { ...gitlab.target, sourceFork: false } as typeof gitlab.target,
      }),
    ).toThrowError("unknown-target");
    expect(() =>
      createReviewDeliveryPlan({
        ...input,
        artifact: { ...input.artifact, id: "other", resultSha256: HASH },
      }),
    ).toThrowError("artifact-mismatch");
    expect(() =>
      createReviewDeliveryPlan({ ...input, actor: { ...input.actor, host: "foreign.example" } }),
    ).toThrowError("actor-mismatch");
    expect(() =>
      createReviewDeliveryPlan({
        ...input,
        capabilities: { ...input.capabilities, host: "foreign.example" },
      }),
    ).toThrowError("capability-mismatch");
    expect(() =>
      createReviewDeliveryPlan({
        ...input,
        snapshot: { ...input.snapshot, changeSourceSha256: HASH },
      }),
    ).toThrowError("snapshot-mismatch");
    const missingBytes = createReviewDeliveryPlan({
      ...input,
      snapshot: {
        ...input.snapshot,
        files: input.snapshot.files.map((file) => ({
          ...file,
          afterBytes: null,
          afterSha256: null,
        })),
      },
    });
    expect(
      missingBytes.findings.every((finding) => finding.disposition.kind === "summary-candidate"),
    ).toBe(true);
    const plan = createReviewDeliveryPlan(input);
    const inline = plan.actions.find((action) => action.kind === "publish-inline")!;
    const summaryOnly = createReviewDeliveryGrant({
      verifyCurrent: (action) => ({
        status: "admitted",
        actionId: action.id,
        kind: "publish-summary",
      }),
    });
    expect(admitReviewDeliveryAction(plan, inline, summaryOnly)).toEqual({
      status: "blocked",
      reason: "grant-mismatch",
    });
    const exact = createReviewDeliveryGrant({
      verifyCurrent: (action) => ({
        status: "admitted",
        actionId: action.id,
        kind: action.kind,
      }),
    });
    expect(admitReviewDeliveryAction(plan, inline, exact)).toEqual({ status: "admitted" });
    expect(admitReviewDeliveryAction(plan, inline, JSON.parse(JSON.stringify(exact)))).toEqual({
      status: "blocked",
      reason: "authority-required",
    });
    expect(
      admitReviewDeliveryAction(
        plan,
        {
          ...inline,
          binding: { ...inline.binding, actor: { ...inline.binding.actor, id: "other" } },
        },
        exact,
      ),
    ).toEqual({ status: "blocked", reason: "action-mismatch" });
    const substitutions = [
      { ...inline, binding: { ...inline.binding, sourceSha256: HASH } },
      { ...inline, binding: { ...inline.binding, snapshotSha256: HASH } },
      {
        ...inline,
        binding: { ...inline.binding, artifact: { ...inline.binding.artifact, id: "other" } },
      },
      {
        ...inline,
        binding: {
          ...inline.binding,
          target: { ...inline.binding.target, host: "foreign.example" },
        },
      },
      {
        ...inline,
        binding: { ...inline.binding, target: { ...inline.binding.target, repositoryId: 999 } },
      },
      { ...inline, logicalIssueId: "issue:foreign" },
    ];
    for (const substituted of substitutions) {
      expect(admitReviewDeliveryAction(plan, substituted as typeof inline, exact)).toEqual({
        status: "blocked",
        reason: "action-mismatch",
      });
    }
  });

  it("discovers injected typed extensions and reports every missing port unsupported", async () => {
    const plan = createReviewDeliveryPlan(fixture("github"));
    const inline = plan.actions.find((action) => action.kind === "publish-inline")!;
    const grant = createReviewDeliveryGrant({
      verifyCurrent: (action) => ({ status: "admitted", actionId: action.id, kind: action.kind }),
    });
    expect(discoverReviewDeliveryExtensions()).toEqual({
      presentation: false,
      suggestions: false,
      revisions: false,
      replies: false,
      feedback: false,
    });
    expect(compileReviewSuggestion(undefined, plan, inline, grant)).toEqual({
      kind: "unsupported",
      reason: "not-registered",
    });
    const suggestion = vi.fn(() => ({ kind: "suggestion" as const, replacement: "after" }));
    const extensions: ReviewDeliveryExtensions = {
      presentation: { select: vi.fn(() => "summary" as const) },
      suggestions: { compile: suggestion },
      revisions: {
        reconcile: vi.fn(() => [
          { earlierLogicalIssueId: "a", laterLogicalIssueId: "b", status: "candidate" as const },
        ]),
      },
      replies: { handle: vi.fn(async () => ({ kind: "handled" as const })) },
      feedback: { record: vi.fn(async () => ({ kind: "recorded" as const })) },
    };
    expect(discoverReviewDeliveryExtensions(extensions)).toEqual({
      presentation: true,
      suggestions: true,
      revisions: true,
      replies: true,
      feedback: true,
    });
    const withPolicy = createReviewDeliveryPlan({ ...fixture("github"), extensions });
    expect(
      withPolicy.findings.every((finding) => finding.disposition.kind === "summary-candidate"),
    ).toBe(true);
    expect(compileReviewSuggestion(extensions, plan, inline, grant)).toEqual({
      kind: "suggestion",
      replacement: "after",
    });
    expect(
      compileReviewSuggestion(extensions, plan, inline, JSON.parse(JSON.stringify(grant))),
    ).toEqual({ kind: "unsupported", reason: "not-admitted" });
    expect(suggestion).toHaveBeenCalledOnce();
    expect(extensions.revisions!.reconcile({ before: plan, after: withPolicy })).toHaveLength(1);
    expect(
      await extensions.replies!.handle({
        action: {
          kind: "reply",
          actor: plan.actor,
          actionBinding: plan.actions[0]!.binding,
          logicalIssueId: plan.findings[0]!.logicalIssueId,
          text: "Acknowledged",
        },
        authorization: { verifyCurrent: () => ({ status: "admitted" }) },
      }),
    ).toEqual({ kind: "handled" });
    expect(
      await extensions.feedback!.record({
        actor: plan.actor,
        target: plan.target,
        observationId: plan.findings[0]!.observationId,
        logicalIssueId: plan.findings[0]!.logicalIssueId,
        verdict: "useful",
      }),
    ).toEqual({ kind: "recorded" });
  });
});
