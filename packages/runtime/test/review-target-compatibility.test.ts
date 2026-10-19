// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { canonicalJson } from "../src/contract-kit/index.js";
import { activateContractDecodeLimits, limit } from "../src/config/limits.js";
import {
  ChangeSourceError,
  createChangeSource,
  type ChangeSourceBodyV1,
} from "../src/inputs/change-source.js";
import { digestGitlabMrReviewLocator } from "../src/inputs/gitlab-mr-locator.js";
import {
  githubRepositoryIdentity,
  gitlabProjectIdentity,
} from "../src/inputs/change-source/revision.js";
import {
  REVIEW_DELIVERY_INTENT,
  ReviewTargetError,
  createReviewResult,
  createReviewResultV5,
  createReviewResultV6,
  createReviewResultV2,
  createReviewTarget,
  createReviewTargetV2,
  decodeReviewResult,
  decodeReviewResultV2,
  decodeReviewTarget,
  decodeReviewTargetV2,
  migrateReviewTargetToV2,
  projectReviewResultV1,
  reviewTargetKey,
  reviewTargetKeyV2,
  type ReviewResultInputV1,
  type ReviewResultInputV4,
  type ReviewTargetInputV1,
  type ReviewTargetInputV2,
} from "../src/review/index.js";
import { reviewResultInputFromRun } from "../src/review/run-result.js";

const BASE = "a".repeat(40);
const HEAD = "b".repeat(40);
const HASH = "c".repeat(64);
const PATCH = "d".repeat(64);

function gitlabSource(overrides: Partial<ChangeSourceBodyV1> = {}) {
  return createChangeSource({
    source: {
      kind: "gitlab-merge-request",
      provenance: "forge-reported",
      host: "gitlab.example.com",
      projectPath: "team/docs",
      projectId: 42,
      iid: 7,
      state: "opened",
      mergeMode: null,
      diffRefs: { base: BASE, start: BASE, head: HEAD },
      mergeCommit: null,
      squashCommit: null,
      fork: false,
    },
    revision: {
      schemaVersion: 1,
      kind: "docsfab-pinned-repository-revision",
      repository: gitlabProjectIdentity({ host: "gitlab.example.com", projectId: 42 }),
      base: BASE,
      head: HEAD,
    },
    objectFormat: "sha1",
    rangeSemantics: "two-dot",
    mergeBase: null,
    diffFrom: BASE,
    baseTree: null,
    headTree: null,
    commits: [{ id: HEAD, parents: [BASE], subject: "Change docs" }],
    files: [],
    labels: [],
    protocol: { provider: "gitlab" },
    ...overrides,
  });
}

function githubSource(repositoryId = 100, headRepositoryId: number | null = 200) {
  return createChangeSource({
    source: {
      kind: "github-pull-request",
      provenance: "forge-reported",
      host: "github.com",
      repositoryId,
      fullName: "owner/docs",
      number: 7,
      state: "open",
      headRepositoryId,
    },
    revision: {
      schemaVersion: 1,
      kind: "docsfab-pinned-repository-revision",
      repository: githubRepositoryIdentity({ host: "github.com", repositoryId }),
      base: BASE,
      head: HEAD,
    },
    objectFormat: "sha1",
    rangeSemantics: "three-dot",
    mergeBase: BASE,
    diffFrom: BASE,
    baseTree: null,
    headTree: null,
    commits: [{ id: HEAD, parents: [BASE], subject: "Change docs" }],
    files: [],
    labels: [],
    protocol: { provider: "github" },
  });
}

function legacyTargetInput(overrides: Partial<ReviewTargetInputV1> = {}): ReviewTargetInputV1 {
  return {
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
    deliveryIntent: REVIEW_DELIVERY_INTENT,
    logicalRequestId: "request:7",
    ...overrides,
  };
}

function resultInput(overrides: Partial<ReviewResultInputV1> = {}): ReviewResultInputV1 {
  return {
    taskId: "task:7",
    runIdSha256: HASH,
    findings: [],
    checks: [{ id: "check:compat", name: "Compatibility", status: "passed" }],
    unresolvedQuestions: [],
    affectedPaths: ["docs/guide.md"],
    patchLocator: { kind: "artifact-digest", digestSha256: PATCH },
    locatorSha256: null,
    ...overrides,
  };
}

function expectRefusal(fn: () => unknown, code: string): void {
  try {
    fn();
    throw new Error(`expected ${code}`);
  } catch (error) {
    expect(error).toBeInstanceOf(ReviewTargetError);
    expect((error as ReviewTargetError).code).toBe(code);
  }
}

describe("versioned review target compatibility", () => {
  it("preserves fixed GitLab V1 target and result canonical digests", () => {
    const target = createReviewTarget(legacyTargetInput());
    const result = createReviewResult(
      target,
      resultInput({
        locatorSha256: null,
      }),
    );
    expect(canonicalJson(target)).toBe(
      `{"deliveryIntent":"comment-existing-mr","headSha":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","host":"gitlab.example.com","kind":"docsfab-review-target","logicalRequestId":"request:7","mergeRequestIid":7,"projectId":42,"requestIdentitySha256":"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc","schemaVersion":1,"scmProvider":"gitlab","sourceBranch":"topic","targetBranch":"main","targetSha256":"44c88e4ccd002f379d0e4b7c7543479121997126bbe78fd1763c73fca3054d74","trigger":"api","workflow":"review-documentation"}`,
    );
    expect(target.targetSha256).toBe(
      "44c88e4ccd002f379d0e4b7c7543479121997126bbe78fd1763c73fca3054d74",
    );
    expect(reviewTargetKey(target).keySha256).toBe(
      "bb8673bee4cd1743ed77c482dd4814b04b0a8441f0097eae3c701932776aac72",
    );
    expect(canonicalJson(result)).toBe(
      `{"affectedPaths":["docs/guide.md"],"checks":[{"id":"check:compat","name":"Compatibility","status":"passed"}],"findings":[],"kind":"docsfab-review-result","locatorSha256":null,"patchLocator":{"digestSha256":"dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd","kind":"artifact-digest"},"resultSha256":"774b1daa81214dd74b5f11ed6424adfdeb8f10fce33c57a2d8db4cde2a094d0c","reviewedHeadSha":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","runIdSha256":"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc","schemaVersion":1,"targetSha256":"44c88e4ccd002f379d0e4b7c7543479121997126bbe78fd1763c73fca3054d74","taskId":"task:7","unresolvedQuestions":[]}`,
    );
    expect(result.resultSha256).toBe(
      "774b1daa81214dd74b5f11ed6424adfdeb8f10fce33c57a2d8db4cde2a094d0c",
    );
    expect(decodeReviewTarget(JSON.parse(canonicalJson(target)))).toEqual(target);
    expect(decodeReviewResult(JSON.parse(canonicalJson(result)))).toEqual(result);
  });

  it("projects V1 results old-to-old and old-to-new without changing legacy identity", () => {
    const source = gitlabSource();
    const target = createReviewTarget(legacyTargetInput());
    const result = createReviewResult(target, resultInput());
    const migration = migrateReviewTargetToV2(target, source);
    const oldView = projectReviewResultV1(result, target);
    const projected = projectReviewResultV1(result, migration);
    expect(oldView.scmProvider).toBe("gitlab");
    expect(projected.targetProjection).toEqual(migration.targetProjection);
    expect(projected.resultTargetSha256).toBe(target.targetSha256);
    expect(projected.originalResultSha256).toBe(result.resultSha256);
    expect(projected.originalResultCanonicalJson).toBe(canonicalJson(result));
    expect(migration.legacyTargetSha256).toBe(target.targetSha256);
    expect(migration.legacyTargetCanonicalJson).toBe(canonicalJson(target));
    expect(migration.legacyDeliveryKey).toEqual(reviewTargetKey(target));
    expect(migration.targetProjection.baseSha).toBe(BASE);
    const migratedV4Input: ReviewResultInputV4 = {
      ...resultInput({
        locatorSha256: digestGitlabMrReviewLocator({
          host: migration.targetProjection.host,
          projectId: migration.targetProjection.projectId,
          mergeRequestIid: migration.targetProjection.mergeRequestIid,
        }),
      }),
      qualityReport: null,
    };
    const migratedV4 = createReviewResultV2(migration.targetProjection, source, migratedV4Input);
    expect(migratedV4.schemaVersion).toBe(4);
    expect(projectReviewResultV1(migratedV4, migration).originalSchemaVersion).toBe(4);
    const {
      schemaVersion: _schemaVersion,
      kind: _kind,
      targetSha256: _targetSha256,
      ...projectionInput
    } = migration.targetProjection;
    const foreignRequest = createReviewTargetV2(
      {
        ...projectionInput,
        logicalRequestId: "foreign-request",
        requestIdentitySha256: "f".repeat(64),
      },
      source,
    );
    expectRefusal(
      () =>
        projectReviewResultV1(result, {
          ...migration,
          targetProjection: foreignRequest,
        }),
      "unknown-target",
    );
  });

  it("round-trips a provider-bound GitHub V2 target and V4 result", () => {
    const source = githubSource();
    const target = createReviewTargetV2(
      {
        scmProvider: "github",
        host: "github.com",
        repositoryId: 100,
        headRepositoryId: 200,
        pullRequestNumber: 7,
        sourceBranch: "topic",
        targetBranch: "main",
        baseSha: BASE,
        headSha: HEAD,
        trigger: "api",
        requestIdentitySha256: HASH,
        workflow: "review-documentation",
        deliveryIntent: REVIEW_DELIVERY_INTENT,
        logicalRequestId: "request:7",
        changeSourceSha256: source.changeSourceSha256,
      },
      source,
    );
    const result = createReviewResultV2(target, source, resultInput());
    expect(decodeReviewTargetV2(JSON.parse(canonicalJson(target)))).toEqual(target);
    expect(decodeReviewResultV2(JSON.parse(canonicalJson(result)))).toEqual(result);
    expect(projectReviewResultV1(result, target).scmProvider).toBe("github");
    expect(() => decodeReviewResult(result)).toThrowError(
      expect.objectContaining({ code: "migration-required" }),
    );
    expect(reviewTargetKeyV2(target).keySha256).not.toBe(
      reviewTargetKeyV2(
        createReviewTargetV2(
          {
            scmProvider: "github",
            host: "github.com",
            repositoryId: 101,
            headRepositoryId: 200,
            pullRequestNumber: 7,
            sourceBranch: "topic",
            targetBranch: "main",
            baseSha: BASE,
            headSha: HEAD,
            trigger: "api",
            requestIdentitySha256: HASH,
            workflow: "review-documentation",
            deliveryIntent: REVIEW_DELIVERY_INTENT,
            logicalRequestId: "request:7",
            changeSourceSha256: githubSource(101).changeSourceSha256,
          },
          githubSource(101),
        ),
      ).keySha256,
    );
  });

  it("requires the run record to cite the exact V2 change source even when its head matches", () => {
    const source = githubSource();
    const target = createReviewTargetV2(
      {
        scmProvider: "github",
        host: "github.com",
        repositoryId: 100,
        headRepositoryId: 200,
        pullRequestNumber: 7,
        sourceBranch: "topic",
        targetBranch: "main",
        baseSha: BASE,
        headSha: HEAD,
        trigger: "api",
        requestIdentitySha256: HASH,
        workflow: "review-documentation",
        deliveryIntent: REVIEW_DELIVERY_INTENT,
        logicalRequestId: "request:7",
        changeSourceSha256: source.changeSourceSha256,
      },
      source,
    );
    const record = {
      workflow: "review-documentation",
      repository: { revision: HEAD },
      changeSources: [],
    };
    expect(() => reviewResultInputFromRun(record as never, { target, source })).toThrowError(
      expect.objectContaining({ code: "change-source-record-unbound" }),
    );
    const citedSource = {
      schemaVersion: 1,
      kind: "docsfab-run-change-source",
      sourceKind: source.source.kind,
      provenance: source.source.provenance,
      repository: source.revision.repository,
      objectFormat: source.objectFormat,
      rangeSemantics: source.rangeSemantics,
      base: source.revision.base,
      head: source.revision.head,
      mergeBase: source.mergeBase,
      diffFrom: source.diffFrom,
      labels: [],
      fileCount: 0,
      commitCount: 1,
      changeSourceSha256: source.changeSourceSha256,
      observations: [],
    };
    const projected = reviewResultInputFromRun(
      {
        ...record,
        id: "run:bound-source",
        steps: [],
        changeSources: [citedSource],
      } as never,
      { target, source },
      undefined,
      undefined,
      undefined,
      { unprovenQualityReport: "label" },
    );
    expect(projected.taskId).toBe("task:run:bound-source");
    expect(projected.checks).toContainEqual(
      expect.objectContaining({ id: "check:quality-report-unavailable", status: "skipped" }),
    );
    expect(() =>
      reviewResultInputFromRun(
        {
          ...record,
          changeSources: [
            {
              ...citedSource,
              repository: { ...source.revision.repository, identitySha256: "f".repeat(64) },
            },
          ],
        } as never,
        { target, source },
      ),
    ).toThrowError(expect.objectContaining({ code: "change-source-record-unbound" }));
    expect(() =>
      reviewResultInputFromRun(
        {
          ...record,
          changeSources: [
            {
              changeSourceSha256: "e".repeat(64),
              sourceKind: "github-pull-request",
              head: HEAD,
            },
          ],
        } as never,
        { target, source },
      ),
    ).toThrowError(expect.objectContaining({ code: "change-source-record-unbound" }));
  });

  it("requires GitLab V4 results to carry the matching locator digest for create/decode parity", () => {
    const source = gitlabSource();
    const target = createReviewTargetV2(
      {
        scmProvider: "gitlab",
        host: "gitlab.example.com",
        projectId: 42,
        mergeRequestIid: 7,
        sourceFork: false,
        sourceBranch: "topic",
        targetBranch: "main",
        baseSha: BASE,
        headSha: HEAD,
        trigger: "api",
        requestIdentitySha256: HASH,
        workflow: "review-documentation",
        deliveryIntent: REVIEW_DELIVERY_INTENT,
        logicalRequestId: "request:7",
        changeSourceSha256: source.changeSourceSha256,
      },
      source,
    );
    expect(() => createReviewResultV2(target, source, resultInput())).toThrowError(
      expect.objectContaining({ code: "digest-mismatch" }),
    );
    const result = createReviewResultV2(
      target,
      source,
      resultInput({
        locatorSha256: digestGitlabMrReviewLocator({
          host: target.host,
          projectId: target.projectId,
          mergeRequestIid: target.mergeRequestIid,
        }),
      }),
    );
    expect(decodeReviewResultV2(JSON.parse(canonicalJson(result)))).toEqual(result);
  });

  it("preserves V3 and V4 issue-graph absence separately from explicit empty graphs", () => {
    const legacy = createReviewTarget(legacyTargetInput());
    const legacyNoGraph = projectReviewResultV1(createReviewResult(legacy, resultInput()), legacy);
    expect(Object.hasOwn(legacyNoGraph, "issues")).toBe(false);
    const legacyEmptyGraphResult = createReviewResult(legacy, {
      ...resultInput(),
      qualityReport: null,
      issues: [],
      sourceContexts: [],
    } as never);
    const legacyEmptyGraph = projectReviewResultV1(legacyEmptyGraphResult, legacy);
    expect(legacyEmptyGraph.originalSchemaVersion).toBe(3);
    expect(legacyEmptyGraph.issues).toEqual([]);
    expect(legacyEmptyGraph.sourceContexts).toEqual([]);

    const source = githubSource();
    const target = createReviewTargetV2(
      {
        scmProvider: "github",
        host: "github.com",
        repositoryId: 100,
        headRepositoryId: 200,
        pullRequestNumber: 7,
        sourceBranch: "topic",
        targetBranch: "main",
        baseSha: BASE,
        headSha: HEAD,
        trigger: "api",
        requestIdentitySha256: HASH,
        workflow: "review-documentation",
        deliveryIntent: REVIEW_DELIVERY_INTENT,
        logicalRequestId: "request:7",
        changeSourceSha256: source.changeSourceSha256,
      },
      source,
    );
    const noGraph = projectReviewResultV1(
      createReviewResultV2(target, source, resultInput()),
      target,
    );
    expect(Object.hasOwn(noGraph, "issues")).toBe(false);
    const emptyGraphInput: ReviewResultInputV4 = {
      ...resultInput(),
      issues: [],
      sourceContexts: [],
    };
    const emptyGraph = projectReviewResultV1(
      createReviewResultV2(target, source, emptyGraphInput),
      target,
    );
    expect(emptyGraph.issues).toEqual([]);
    expect(emptyGraph.sourceContexts).toEqual([]);
    expect(() =>
      createReviewResultV2(target, source, { ...resultInput(), issues: [] } as never),
    ).toThrowError(expect.objectContaining({ code: "invalid-shape" }));
    expect(() =>
      createReviewResultV2(target, source, { ...resultInput(), sourceContexts: [] } as never),
    ).toThrowError(expect.objectContaining({ code: "invalid-shape" }));
  });

  it("binds GitLab fork, provider and locator identity and allows equal fork branch names", () => {
    const source = gitlabSource({
      source: {
        kind: "gitlab-merge-request",
        provenance: "forge-reported",
        host: "gitlab.example.com",
        projectPath: "team/docs",
        projectId: 42,
        iid: 7,
        state: "opened",
        mergeMode: null,
        diffRefs: { base: BASE, start: BASE, head: HEAD },
        mergeCommit: null,
        squashCommit: null,
        fork: true,
      },
    });
    const target = createReviewTargetV2(
      {
        scmProvider: "gitlab",
        host: "gitlab.example.com",
        projectId: 42,
        mergeRequestIid: 7,
        sourceFork: true,
        sourceBranch: "same-name",
        targetBranch: "same-name",
        baseSha: BASE,
        headSha: HEAD,
        trigger: "api",
        requestIdentitySha256: HASH,
        workflow: "review-documentation",
        deliveryIntent: REVIEW_DELIVERY_INTENT,
        logicalRequestId: "request:7",
        changeSourceSha256: source.changeSourceSha256,
      },
      source,
    );
    expect(target.sourceBranch).toBe(target.targetBranch);
    const result = createReviewResultV2(
      target,
      source,
      resultInput({
        locatorSha256: digestGitlabMrReviewLocator({
          host: target.host,
          projectId: target.projectId,
          mergeRequestIid: target.mergeRequestIid,
        }),
      }),
    );
    expect(projectReviewResultV1(result, target).scmProvider).toBe("gitlab");
    expect(reviewTargetKeyV2(target).projectId).toBe(42);
    const {
      schemaVersion: _schemaVersion,
      kind: _kind,
      targetSha256: _targetSha256,
      ...input
    } = target;
    expectRefusal(
      () => createReviewTargetV2({ ...input, sourceFork: false }, source),
      "unknown-target",
    );
    expectRefusal(
      () => createReviewTargetV2({ ...input, scmProvider: "unknown" } as never, source),
      "invalid-value",
    );
  });

  it("refuses provider, host, repository, revision and malformed-source substitutions", () => {
    const source = githubSource();
    const input: ReviewTargetInputV2 = {
      scmProvider: "github",
      host: "github.com",
      repositoryId: 100,
      headRepositoryId: 200,
      pullRequestNumber: 7,
      sourceBranch: "topic",
      targetBranch: "main",
      baseSha: BASE,
      headSha: HEAD,
      trigger: "api",
      requestIdentitySha256: HASH,
      workflow: "review-documentation",
      deliveryIntent: REVIEW_DELIVERY_INTENT,
      logicalRequestId: "request:7",
      changeSourceSha256: source.changeSourceSha256,
    };
    expectRefusal(
      () => createReviewTargetV2({ ...input, repositoryId: 101 }, source),
      "unknown-target",
    );
    expectRefusal(
      () => createReviewTargetV2({ ...input, host: "evil.example" } as never, source),
      "invalid-value",
    );
    expectRefusal(
      () => createReviewTargetV2({ ...input, headSha: "e".repeat(40) }, source),
      "unknown-target",
    );
    expectRefusal(
      () => decodeReviewTargetV2({ ...createReviewTargetV2(input, source), extra: true }),
      "invalid-shape",
    );
    expectRefusal(() => createReviewTargetV2(input, githubSource(100, 201)), "digest-mismatch");
  });
});

describe("rich result compatibility", () => {
  const contexts = [
    {
      id: "context:technical",
      completeness: "bounded-not-proven",
      limitations: [],
      dimensions: [
        {
          dimension: "defaults",
          status: "applicable",
          reason: "Both source facts were read.",
          sourceLocators: ["src/config.ts:1"],
          facts: [
            {
              id: "FACT-1",
              dimension: "defaults",
              sourceLocators: ["src/config.ts:1"],
              statement: "Default is strict.",
              documentationDisposition: "conflicting",
              uncertainty: "Applies to new projects.",
              issueIds: ["TECH-1"],
            },
            {
              id: "FACT-2",
              dimension: "defaults",
              sourceLocators: ["src/override.ts:2"],
              statement: "The override disables strict mode.",
              documentationDisposition: "omitted",
              uncertainty: "Only within one project.",
              issueIds: ["TECH-1"],
            },
          ],
        },
      ],
    },
  ];
  const exactOriginal = "  default: loose\r\n";
  const exactReplacement = "  default: strict\r\n";
  const issue = {
    id: "issue:technical:TECH-1",
    producerStepId: "verify-technical-accuracy",
    producerSkill: "verify-technical-accuracy",
    originalId: "TECH-1",
    severity: "error",
    originalSeverity: "critical",
    category: "technical_accuracy",
    finding: "The default is documented incorrectly.",
    location: "docs/guide.md:1",
    path: "docs/guide.md",
    line: 1,
    locationFidelity: "exact",
    evidence: { sourceId: "source:config", locator: "src/config.ts:1" },
    requiredChange: "State the strict default and project override.",
    limitations: [],
    sourceContextId: "context:technical",
    factRefs: [
      { dimensionIndex: 0, factIndex: 0 },
      { dimensionIndex: 0, factIndex: 1 },
    ],
    rich: {
      status: "admitted",
      candidateSha256: HASH,
      title: "Correct the strict default",
      readerConsequence: "Readers may choose the wrong setting for new projects.",
      proposedEdit: {
        kind: "replacement",
        text: "Replace the default while preserving the scoped override.",
        path: "docs/guide.md",
        originalText: exactOriginal,
        replacementText: exactReplacement,
      },
      grounding: [
        {
          factId: "FACT-1",
          qualification: "Applies to new projects.",
          status: "supported",
          rationale: "The source establishes the default.",
          sourceLocators: ["src/config.ts:1"],
        },
        {
          factId: "FACT-2",
          qualification: "Only within one project.",
          status: "supported",
          rationale: "The override remains scoped.",
          sourceLocators: ["src/override.ts:2"],
        },
      ],
    },
  };

  it("retains exact replacement bytes through V5 and provider V6 without changing old empty-graph results", () => {
    const legacy = createReviewTarget(legacyTargetInput());
    const legacyEmpty = createReviewResult(legacy, {
      ...resultInput(),
      qualityReport: null,
      issues: [],
      sourceContexts: [],
    } as never);
    expect(legacyEmpty.schemaVersion).toBe(3);
    const input = {
      ...resultInput(),
      qualityReport: null,
      issues: [issue],
      sourceContexts: contexts,
    };
    const v5 = createReviewResultV5(legacy, input as never);
    expect(v5.schemaVersion).toBe(5);
    expect(createReviewResult(legacy, input as never)).toEqual(v5);
    expect(decodeReviewResult(JSON.parse(canonicalJson(v5)))).toEqual(v5);
    expect(projectReviewResultV1(v5, legacy).originalResultCanonicalJson).toBe(canonicalJson(v5));
    expect(v5.issues[0]!.rich.status).toBe("admitted");
    if (v5.issues[0]!.rich.status === "admitted") {
      expect(v5.issues[0]!.rich.proposedEdit).toMatchObject({
        originalText: exactOriginal,
        replacementText: exactReplacement,
      });
    }
    const source = githubSource();
    const provider = createReviewTargetV2(
      {
        scmProvider: "github",
        host: "github.com",
        repositoryId: 100,
        headRepositoryId: 200,
        pullRequestNumber: 7,
        sourceBranch: "topic",
        targetBranch: "main",
        baseSha: BASE,
        headSha: HEAD,
        trigger: "api",
        requestIdentitySha256: HASH,
        workflow: "review-documentation",
        deliveryIntent: REVIEW_DELIVERY_INTENT,
        logicalRequestId: "request:7",
        changeSourceSha256: source.changeSourceSha256,
      },
      source,
    );
    const v6 = createReviewResultV6(provider, source, input as never);
    expect(v6.schemaVersion).toBe(6);
    expect(createReviewResultV2(provider, source, input as never)).toEqual(v6);
    expect(decodeReviewResultV2(JSON.parse(canonicalJson(v6)))).toEqual(v6);
    expect(projectReviewResultV1(v6, provider).issues).toEqual(v6.issues);
    expectRefusal(() => decodeReviewResult(v6), "migration-required");
    expectRefusal(() => projectReviewResultV1(v6, legacy), "migration-required");
    expectRefusal(() => decodeReviewResult({ ...v5, resultSha256: PATCH }), "digest-mismatch");
    expectRefusal(() => decodeReviewResult({ ...v5, extra: true }), "invalid-shape");
    expectRefusal(() => decodeReviewResultV2({ ...v6, issues: undefined }), "invalid-shape");
  });

  it("refuses malformed default issue elements without native errors or changing empty graphs", () => {
    const legacy = createReviewTarget(legacyTargetInput());
    const source = githubSource();
    const provider = createReviewTargetV2(
      {
        scmProvider: "github",
        host: "github.com",
        repositoryId: 100,
        headRepositoryId: 200,
        pullRequestNumber: 7,
        sourceBranch: "topic",
        targetBranch: "main",
        baseSha: BASE,
        headSha: HEAD,
        trigger: "api",
        requestIdentitySha256: HASH,
        workflow: "review-documentation",
        deliveryIntent: REVIEW_DELIVERY_INTENT,
        logicalRequestId: "request:7",
        changeSourceSha256: source.changeSourceSha256,
      },
      source,
    );
    const base = { ...resultInput(), qualityReport: null, sourceContexts: [] };
    for (const malformed of [null, 7, "malformed", false]) {
      const input = { ...base, issues: [malformed] };
      expectRefusal(() => createReviewResult(legacy, input as never), "invalid-shape");
      expectRefusal(() => createReviewResultV2(provider, source, input as never), "invalid-shape");
      const mixed = { ...base, issues: [malformed, issue], sourceContexts: contexts };
      expectRefusal(() => createReviewResult(legacy, mixed as never), "invalid-value");
      expectRefusal(() => createReviewResultV2(provider, source, mixed as never), "invalid-value");
    }
    const empty = { ...base, issues: [] };
    expect(createReviewResult(legacy, empty as never).schemaVersion).toBe(3);
    expect(createReviewResultV2(provider, source, empty as never).schemaVersion).toBe(4);
    expect(createReviewResultV5(legacy, empty as never).schemaVersion).toBe(5);
    expect(createReviewResultV6(provider, source, empty as never).schemaVersion).toBe(6);
    const rich = { ...base, issues: [issue], sourceContexts: contexts };
    expect(createReviewResult(legacy, rich as never).schemaVersion).toBe(5);
    expect(createReviewResultV2(provider, source, rich as never).schemaVersion).toBe(6);
  });

  it("refuses malformed rich unions, broken fact links and invalid edit Unicode", () => {
    const target = createReviewTarget(legacyTargetInput());
    const make = (changed: unknown) =>
      createReviewResultV5(target, {
        ...resultInput(),
        qualityReport: null,
        sourceContexts: contexts,
        issues: [{ ...issue, rich: changed }],
      } as never);
    expectRefusal(() => make({ ...issue.rich, extra: true }), "invalid-shape");
    expectRefusal(() => make({ status: "unavailable", reason: "invented" }), "invalid-value");
    expectRefusal(
      () => make({ ...issue.rich, grounding: issue.rich.grounding.slice(0, 1) }),
      "invalid-value",
    );
    expectRefusal(
      () => make({ ...issue.rich, proposedEdit: { ...issue.rich.proposedEdit, originalText: "" } }),
      "invalid-value",
    );
    expectRefusal(() => make({ ...issue.rich, title: "  " }), "invalid-value");
    expectRefusal(
      () => make({ ...issue.rich, proposedEdit: { ...issue.rich.proposedEdit, text: "\r\n" } }),
      "invalid-value",
    );
    expectRefusal(
      () =>
        make({
          ...issue.rich,
          proposedEdit: { ...issue.rich.proposedEdit, replacementText: "\uD800" },
        }),
      "invalid-value",
    );
    expectRefusal(
      () =>
        make({
          ...issue.rich,
          proposedEdit: { ...issue.rich.proposedEdit, originalText: "\uD800" },
        }),
      "invalid-value",
    );
    expectRefusal(
      () =>
        createReviewResultV5(target, {
          ...resultInput(),
          qualityReport: null,
          sourceContexts: contexts,
          issues: [{ ...issue, factRefs: [{ dimensionIndex: 0, factIndex: 0 }] }],
        } as never),
      "invalid-value",
    );
    const deletion = make({
      ...issue.rich,
      proposedEdit: { ...issue.rich.proposedEdit, replacementText: "" },
    });
    expect(decodeReviewResult(JSON.parse(canonicalJson(deletion)))).toEqual(deletion);
    const whitespaceOriginal = make({
      ...issue.rich,
      proposedEdit: { ...issue.rich.proposedEdit, originalText: "  \r\n" },
    });
    expect(decodeReviewResult(JSON.parse(canonicalJson(whitespaceOriginal)))).toEqual(
      whitespaceOriginal,
    );
    const decomposed = "Cafe\u0301\r\n";
    const unicode = make({
      ...issue.rich,
      proposedEdit: {
        ...issue.rich.proposedEdit,
        replacementText: decomposed,
      },
    });
    const decoded = decodeReviewResult(JSON.parse(canonicalJson(unicode)));
    expect(decoded.schemaVersion).toBe(5);
    if (
      decoded.schemaVersion === 5 &&
      decoded.issues[0]!.rich.status === "admitted" &&
      decoded.issues[0]!.rich.proposedEdit.kind === "replacement"
    )
      expect(decoded.issues[0]!.rich.proposedEdit.replacementText).toBe(decomposed);
    const unavailable = make({ status: "unavailable", reason: "contradicted" });
    expect(unavailable.issues[0]!.requiredChange).toBe(issue.requiredChange);
  });

  it("retains one fact shared by distinct issues and refuses a missing reciprocal link", () => {
    const target = createReviewTarget(legacyTargetInput());
    const sharedContexts = structuredClone(contexts);
    sharedContexts[0]!.dimensions[0]!.facts[0]!.issueIds.push("TECH-2");
    const second = {
      ...issue,
      id: "issue:technical:TECH-2",
      originalId: "TECH-2",
      finding: "A second page repeats the wrong default.",
      requiredChange: "Correct that page too.",
      factRefs: [{ dimensionIndex: 0, factIndex: 0 }],
      rich: { status: "unavailable", reason: "candidate-absent" },
    };
    const input = {
      ...resultInput(),
      qualityReport: null,
      sourceContexts: sharedContexts,
      issues: [issue, second],
    };
    const shared = createReviewResultV5(target, input as never);
    expect(decodeReviewResult(JSON.parse(canonicalJson(shared)))).toEqual(shared);
    expect(shared.issues[0]!.factRefs).toHaveLength(2);
    expect(shared.issues[1]!.factRefs).toHaveLength(1);
    const broken = structuredClone(sharedContexts);
    broken[0]!.dimensions[0]!.facts[0]!.issueIds.pop();
    expectRefusal(
      () => createReviewResultV5(target, { ...input, sourceContexts: broken } as never),
      "invalid-value",
    );
    const ghost = structuredClone(sharedContexts);
    ghost[0]!.dimensions[0]!.facts[0]!.issueIds.push("TECH-GHOST");
    expectRefusal(
      () => createReviewResultV5(target, { ...input, sourceContexts: ghost } as never),
      "invalid-value",
    );
    const duplicated = structuredClone(sharedContexts);
    duplicated[0]!.dimensions[0]!.facts[0]!.issueIds.push("TECH-1");
    expectRefusal(
      () => createReviewResultV5(target, { ...input, sourceContexts: duplicated } as never),
      "invalid-value",
    );
  });

  it("charges a complete replacement span against the effective scalar bound", () => {
    const target = createReviewTarget(legacyTargetInput());
    const make = (originalText: string) =>
      createReviewResultV5(target, {
        ...resultInput(),
        qualityReport: null,
        sourceContexts: contexts,
        issues: [
          {
            ...issue,
            rich: {
              ...issue.rich,
              proposedEdit: { ...issue.rich.proposedEdit, originalText },
            },
          },
        ],
      } as never);
    const bound = limit("runtime.contract.maxStringChars").value;
    const atLimit = make("x".repeat(bound));
    expect(decodeReviewResult(JSON.parse(canonicalJson(atLimit)))).toEqual(atLimit);
    expect(() => make("x".repeat(bound + 1))).toThrow(/runtime\.contract\.maxStringChars/u);
  });

  it("honors a validated scalar shrink for complete replacement bytes", () => {
    const target = createReviewTarget(legacyTargetInput());
    const make = (originalText: string) =>
      createReviewResultV5(target, {
        ...resultInput(),
        qualityReport: null,
        sourceContexts: contexts,
        issues: [
          {
            ...issue,
            rich: {
              ...issue.rich,
              proposedEdit: { ...issue.rich.proposedEdit, originalText },
            },
          },
        ],
      } as never);
    const effective = 512;
    try {
      activateContractDecodeLimits({
        environment: { DOCSFAB_RUNTIME_CONTRACT_MAX_STRING_CHARS: String(effective) },
        hostFile: null,
        projectFile: null,
      });
      const admitted = make("x".repeat(effective));
      expect(decodeReviewResult(JSON.parse(canonicalJson(admitted)))).toEqual(admitted);
      expect(() => make("x".repeat(effective + 1))).toThrow(/runtime\.contract\.maxStringChars/u);
    } finally {
      activateContractDecodeLimits({ environment: {}, hostFile: null, projectFile: null });
    }
  });

  it("honors validated field and prose shrinks and restores catalog defaults", () => {
    const target = createReviewTarget(legacyTargetInput());
    const make = (rich: unknown) =>
      createReviewResultV5(target, {
        ...resultInput(),
        qualityReport: null,
        sourceContexts: contexts,
        issues: [{ ...issue, rich }],
      } as never);
    const effective = 64;
    const atLimit = "x".repeat(effective);
    const tooLong = `${atLimit}x`;
    const withGrounding = (rationale: string) => ({
      ...issue.rich,
      grounding: [{ ...issue.rich.grounding[0], rationale }, issue.rich.grounding[1]],
    });
    const sealedLongTitle = make({ ...issue.rich, title: tooLong });
    const sealedLongConsequence = make({ ...issue.rich, readerConsequence: tooLong });
    try {
      activateContractDecodeLimits({
        environment: {
          DOCSFAB_TECHNICAL_CORRECTION_FIELD_MAX_CHARS: String(effective),
          DOCSFAB_TECHNICAL_CORRECTION_PROSE_MAX_CHARS: String(effective),
        },
        hostFile: null,
        projectFile: null,
      });
      expect(decodeReviewResult(make({ ...issue.rich, title: atLimit })).schemaVersion).toBe(5);
      expect(
        decodeReviewResult(make({ ...issue.rich, readerConsequence: atLimit })).schemaVersion,
      ).toBe(5);
      expect(decodeReviewResult(make(withGrounding(atLimit))).schemaVersion).toBe(5);
      expect(() => make({ ...issue.rich, title: tooLong })).toThrow(
        /technicalCorrection\.fieldMaxChars/u,
      );
      expect(() => make({ ...issue.rich, readerConsequence: tooLong })).toThrow(
        /technicalCorrection\.proseMaxChars/u,
      );
      expect(() => decodeReviewResult(sealedLongTitle)).toThrow(
        /technicalCorrection\.fieldMaxChars/u,
      );
      expect(() => decodeReviewResult(sealedLongConsequence)).toThrow(
        /technicalCorrection\.proseMaxChars/u,
      );
      expect(() => make(withGrounding(tooLong))).toThrow(/technicalCorrection\.proseMaxChars/u);
      expect(() =>
        activateContractDecodeLimits({
          environment: {
            DOCSFAB_TECHNICAL_CORRECTION_FIELD_MAX_CHARS: "100",
            DOCSFAB_TECHNICAL_CORRECTION_PROSE_MAX_CHARS: "0",
          },
          hostFile: null,
          projectFile: null,
        }),
      ).toThrow(/DOCSFAB_TECHNICAL_CORRECTION_PROSE_MAX_CHARS/u);
      expect(() => make({ ...issue.rich, title: tooLong })).toThrow(
        /technicalCorrection\.fieldMaxChars/u,
      );
    } finally {
      activateContractDecodeLimits({ environment: {}, hostFile: null, projectFile: null });
    }
    expect(decodeReviewResult(make({ ...issue.rich, title: tooLong })).schemaVersion).toBe(5);
    expect(
      decodeReviewResult(make({ ...issue.rich, readerConsequence: tooLong })).schemaVersion,
    ).toBe(5);
  });
});
