// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { DELIVERY_INTENTS, DELIVERY_TRIGGERS } from "../src/delivery/delivery-authority.js";
import {
  canonicalGitlabMrReviewLocator,
  digestGitlabMrReviewLocator,
  ExternalInputContractError,
} from "../src/inputs/index.js";
import {
  REVIEW_DELIVERY_INTENT,
  REVIEW_TRIGGERS,
  ReviewTargetError,
  assertReviewResultMatchesTarget,
  assertReviewTargetHead,
  createReviewHeadAuthority,
  createReviewResult,
  createReviewTarget,
  decodeReviewResult,
  decodeReviewTarget,
  reviewTargetKey,
  type ReviewHeadObservationV1,
  type ReviewResultInputV1,
  type ReviewResultInputV2,
  type ReviewTargetInputV1,
} from "../src/review/index.js";
import { configureCredentialsForEachTest } from "./helpers/configured-credential.js";

// Configured for every test: only a configured credential is refused (#1807).
configureCredentialsForEachTest(["glpat", "0123456789abcdefghij"].join("-"));

const HASH = "a".repeat(64);
const HEAD = "d".repeat(40);
const OTHER_HEAD = "e".repeat(40);
const PATCH = "b".repeat(64);

function expectCode(run: () => unknown, code: string): void {
  try {
    run();
    throw new Error(`expected ${code}`);
  } catch (error) {
    expect(error).toBeInstanceOf(ReviewTargetError);
    expect((error as ReviewTargetError).code).toBe(code);
  }
}

function targetInput(overrides: Partial<ReviewTargetInputV1> = {}): ReviewTargetInputV1 {
  return {
    scmProvider: "gitlab",
    host: "gitlab.example.com",
    projectId: 437040,
    mergeRequestIid: 88,
    sourceBranch: "docsfab/topic",
    targetBranch: "main",
    headSha: HEAD,
    trigger: "webhook",
    requestIdentitySha256: HASH,
    workflow: "review-documentation",
    deliveryIntent: REVIEW_DELIVERY_INTENT,
    logicalRequestId: "request:review-1",
    ...overrides,
  };
}

function resultInput(overrides: Partial<ReviewResultInputV1> = {}): ReviewResultInputV1 {
  return {
    taskId: "task:review-1",
    runIdSha256: HASH,
    findings: [
      {
        id: "finding:docs-gap",
        severity: "warning",
        code: "docs.missing-example",
        summary: "Add a runnable example for the new contract.",
        path: "docs/reference/contracts/review-target.md",
      },
    ],
    checks: [{ id: "check:lint", name: "Contract dialect", status: "passed" }],
    unresolvedQuestions: [{ id: "question:scope", summary: "Does the host own note retries?" }],
    affectedPaths: ["docs/reference/contracts/review-target.md", "src/review/contracts.ts"],
    patchLocator: { kind: "artifact-digest", digestSha256: PATCH },
    locatorSha256: digestGitlabMrReviewLocator({
      host: "gitlab.example.com",
      projectId: 437040,
      mergeRequestIid: 88,
    }),
    ...overrides,
  };
}

function resultInputV2(overrides: Partial<ReviewResultInputV2> = {}): ReviewResultInputV2 {
  return {
    ...resultInput(),
    qualityReport: {
      schemaVersion: 1,
      kind: "docsfab-quality-report-projection",
      decision: "pass",
      confidence: 0.9,
      hardGateFailures: [],
      limitations: ["Audience evidence covers one scenario corpus."],
      rubric: {
        status: "available",
        id: "task-guide-v0.1",
        total: 84,
        threshold: 80,
        interpretationBand: "Green",
        decision: "pass",
        confidence: 0.9,
      },
      reportLocator: { kind: "artifact-digest", digestSha256: "c".repeat(64) },
      repositoryRevision: HEAD,
      patchSha256: null,
    },
    ...overrides,
  };
}

function resultInputV3(): Record<string, unknown> {
  return {
    ...resultInput({ findings: [] }),
    issues: [
      {
        id: "issue:technical:TECH-001",
        producerStepId: "verify-technical-accuracy",
        producerSkill: "verify-technical-accuracy",
        originalId: "TECH-001",
        severity: "error",
        originalSeverity: "critical",
        category: "technical_accuracy",
        finding: "The default is documented incorrectly.",
        location: "docs/guide.md:12",
        path: "docs/guide.md",
        line: 12,
        locationFidelity: "exact",
        evidence: { sourceId: "source:configuration", locator: "src/config.ts:42" },
        requiredChange:
          `State the observed default and its consequence. ${"Preserve this action. ".repeat(30)}`.trimEnd(),
        limitations: [],
        sourceContextId: "context:technical",
        factRefs: [
          { dimensionIndex: 0, factIndex: 0 },
          { dimensionIndex: 0, factIndex: 1 },
        ],
      },
    ],
    sourceContexts: [
      {
        id: "context:technical",
        completeness: "bounded-not-proven",
        limitations: ["One external source was unavailable."],
        dimensions: [
          {
            dimension: "defaults-and-overrides",
            status: "unverified",
            reason: "An external policy source was unavailable.",
            sourceLocators: ["src/config.ts:42"],
            facts: [
              {
                id: "FACT-001",
                dimension: "defaults-and-overrides",
                sourceLocators: ["src/config.ts:42"],
                statement: "The code defaults to strict mode.",
                documentationDisposition: "conflicting",
                uncertainty: "The policy owner has not confirmed the rollout.",
                issueIds: ["TECH-001"],
              },
              {
                id: "FACT-002",
                dimension: "defaults-and-overrides",
                sourceLocators: ["src/override.ts:9"],
                statement: "An override can disable strict mode.",
                documentationDisposition: "omitted",
                uncertainty: "The override scope is bounded to one project.",
                issueIds: ["TECH-001"],
              },
            ],
          },
        ],
      },
    ],
    qualityReport: null,
  };
}

function observation(overrides: Partial<ReviewHeadObservationV1> = {}): ReviewHeadObservationV1 {
  return {
    scmProvider: "gitlab",
    host: "gitlab.example.com",
    projectId: 437040,
    mergeRequestIid: 88,
    observedHeadSha: HEAD,
    sourceBranch: "docsfab/topic",
    targetBranch: "main",
    proofStatus: "current",
    ...overrides,
  };
}

function admit() {
  return createReviewHeadAuthority({
    verifyCurrent: () => ({ status: "admitted" }),
  });
}

describe("review target binding", () => {
  it("reuses the #212 comment-existing-mr intent and trigger axis", () => {
    expect(REVIEW_DELIVERY_INTENT).toBe("comment-existing-mr");
    expect(DELIVERY_INTENTS).toContain(REVIEW_DELIVERY_INTENT);
    expect(REVIEW_TRIGGERS).toEqual(DELIVERY_TRIGGERS);
  });

  it("seals a credential-free GitLab project/MR/head binding", () => {
    const target = createReviewTarget(targetInput());
    expect(target.kind).toBe("docsfab-review-target");
    expect(target.scmProvider).toBe("gitlab");
    expect(target.projectId).toBe(437040);
    expect(target.mergeRequestIid).toBe(88);
    expect(target.headSha).toBe(HEAD);
    expect(target.deliveryIntent).toBe("comment-existing-mr");
    expect(target.trigger).toBe("webhook");
    expect(target.workflow).toBe("review-documentation");
    expect(JSON.stringify(target)).not.toContain("glpat-");
    expect(JSON.stringify(target)).not.toContain("/Users/");
    expect(decodeReviewTarget(target)).toEqual(target);
  });

  it("keeps durable identity independent of head SHA", () => {
    const original = reviewTargetKey(createReviewTarget(targetInput()));
    const drifted = reviewTargetKey(createReviewTarget(targetInput({ headSha: OTHER_HEAD })));
    expect(original.keySha256).toBe(drifted.keySha256);
    expect(original.mergeRequestIid).toBe(88);
    expect(original.deliveryIntent).toBe("comment-existing-mr");
    const otherRequest = reviewTargetKey(
      createReviewTarget(targetInput({ logicalRequestId: "request:review-2" })),
    );
    expect(otherRequest.keySha256).not.toBe(original.keySha256);
  });

  it("rejects unsupported delivery intents and extra fields", () => {
    expectCode(
      () =>
        createReviewTarget(
          targetInput({ deliveryIntent: "update-existing-mr" as typeof REVIEW_DELIVERY_INTENT }),
        ),
      "unsupported-intent",
    );
    expectCode(
      () =>
        createReviewTarget(
          targetInput({ deliveryIntent: "create-draft-mr" as typeof REVIEW_DELIVERY_INTENT }),
        ),
      "unsupported-intent",
    );
    expectCode(
      () =>
        createReviewTarget({ ...targetInput(), endpoint: "https://gitlab.example.com" } as never),
      "invalid-shape",
    );
  });

  it("rejects credentials, tokenized hosts, and identical branches", () => {
    expectCode(
      () => createReviewTarget(targetInput({ logicalRequestId: "glpat-0123456789abcdefghij" })),
      "credential-material",
    );
    expectCode(
      () => createReviewTarget(targetInput({ host: "gitlab.example.com/group/project" })),
      "invalid-value",
    );
    expectCode(
      () => createReviewTarget(targetInput({ sourceBranch: "main", targetBranch: "main" })),
      "invalid-value",
    );
  });
});

describe("review result", () => {
  it("seals a complete V3 issue graph without a quality report and binds nested facts", () => {
    const target = createReviewTarget(targetInput());
    const result = createReviewResult(target, resultInputV3() as never);
    expect(result).toMatchObject({ schemaVersion: 3, qualityReport: null });
    const graph = result as unknown as {
      issues: Array<{ requiredChange: string }>;
      sourceContexts: Array<{ dimensions: Array<{ facts: Array<{ uncertainty: string }> }> }>;
    };
    expect(graph.issues[0]?.requiredChange.length).toBeGreaterThan(512);
    expect(graph.sourceContexts[0]?.dimensions[0]?.facts[1]?.uncertainty).toContain("bounded");
    expect(decodeReviewResult(result)).toEqual(result);
    const tampered = structuredClone(result) as unknown as {
      sourceContexts: Array<{ dimensions: Array<{ facts: Array<{ uncertainty: string }> }> }>;
    };
    tampered.sourceContexts[0]!.dimensions[0]!.facts[1]!.uncertainty = "silently changed";
    expectCode(() => decodeReviewResult(tampered), "digest-mismatch");
    expectCode(() => decodeReviewResult({ ...result, unexpected: "unbound" }), "invalid-shape");
    expectCode(
      () => decodeReviewResult({ ...result, reviewedHeadSha: OTHER_HEAD }),
      "digest-mismatch",
    );
  });

  it("rejects ambiguous V3 fact membership for duplicate original IDs within one source context", () => {
    const target = createReviewTarget(targetInput());
    const duplicate = resultInputV3();
    const issues = duplicate.issues as Array<Record<string, unknown>>;
    issues.push({ ...structuredClone(issues[0]!), id: "issue:technical:TECH-001-copy" });
    expectCode(() => createReviewResult(target, duplicate as never), "invalid-value");

    for (const issue of issues) {
      issue.sourceContextId = null;
      issue.factRefs = [];
    }
    expectCode(() => createReviewResult(target, duplicate as never), "invalid-value");

    const separate = resultInputV3();
    const separateIssues = separate.issues as Array<Record<string, unknown>>;
    separateIssues.push({
      ...structuredClone(separateIssues[0]!),
      id: "issue:technical:TECH-001-copy",
      sourceContextId: "context:another",
    });
    const contexts = separate.sourceContexts as Array<Record<string, unknown>>;
    contexts.push({ ...structuredClone(contexts[0]!), id: "context:another" });
    expect(createReviewResult(target, separate as never).schemaVersion).toBe(3);
  });

  it("binds findings, checks, questions, paths, task identity, and optional locators", () => {
    const target = createReviewTarget(targetInput());
    const result = createReviewResult(target, resultInput());
    expect(result.kind).toBe("docsfab-review-result");
    expect(result.taskId).toBe("task:review-1");
    expect(result.reviewedHeadSha).toBe(HEAD);
    expect(result.targetSha256).toBe(target.targetSha256);
    expect(result.findings).toHaveLength(1);
    expect(result.checks[0]?.status).toBe("passed");
    expect(result.unresolvedQuestions[0]?.id).toBe("question:scope");
    expect(result.affectedPaths).toContain("src/review/contracts.ts");
    expect(result.patchLocator?.kind).toBe("artifact-digest");
    expect(result.locatorSha256).toBe(
      digestGitlabMrReviewLocator({
        host: "gitlab.example.com",
        projectId: 437040,
        mergeRequestIid: 88,
      }),
    );
    expect(JSON.stringify(result)).not.toContain("glpat-");
    expect(JSON.stringify(result)).not.toContain("/home/");
    expect(decodeReviewResult(result)).toEqual(result);
    expect(assertReviewResultMatchesTarget(result, target)).toEqual(result);
  });

  it("accepts optional finding fields and omitted empty skippedPaths", () => {
    const target = createReviewTarget(targetInput());
    const withoutSkips = createReviewResult(target, resultInput({ skippedPaths: [] }));
    expect(withoutSkips).not.toHaveProperty("skippedPaths");
    expect(withoutSkips.resultSha256).toBe(createReviewResult(target, resultInput()).resultSha256);
    const result = createReviewResult(
      target,
      resultInput({
        findings: [
          {
            id: "finding:docs-gap",
            severity: "warning",
            code: "docs.missing-example",
            summary: "Add a runnable example for the new contract.",
            path: "docs/reference/contracts/review-target.md",
            origin: "deterministic",
            line: 12,
            evidence: "The heading has no sample command.",
            recommendation: "Add a fenced command the reader can copy.",
          },
        ],
        skippedPaths: [{ path: "docs/binary.png", reason: "unsupported-extension" }],
      }),
    );
    expect(result.findings[0]).toMatchObject({
      origin: "deterministic",
      line: 12,
      evidence: "The heading has no sample command.",
    });
    expect(result.skippedPaths).toEqual([
      { path: "docs/binary.png", reason: "unsupported-extension" },
    ]);
    expect(decodeReviewResult(result)).toEqual(result);
  });

  it("fails closed when an agent-origin finding omits evidence and recommendation", () => {
    const target = createReviewTarget(targetInput());
    expectCode(
      () =>
        createReviewResult(
          target,
          resultInput({
            findings: [
              {
                id: "finding:agent",
                severity: "warning",
                code: "docs.agent",
                summary: "The heading should name the workflow.",
                path: "docs/page.md",
                origin: "agent",
              },
            ],
          }),
        ),
      "invalid-value",
    );
  });

  it("copies reviewed head from the target and rejects a mismatched locator", () => {
    const target = createReviewTarget(targetInput());
    const result = createReviewResult(target, resultInput({ locatorSha256: null }));
    expect(result.reviewedHeadSha).toBe(target.headSha);
    expectCode(
      () => createReviewResult(target, resultInput({ locatorSha256: "c".repeat(64) })),
      "digest-mismatch",
    );
  });

  it("seals a v2 quality report to the reviewed head and rejects tampering", () => {
    const target = createReviewTarget(targetInput());
    const result = createReviewResult(target, resultInputV2());
    expect(result).toMatchObject({
      schemaVersion: 2,
      reviewedHeadSha: HEAD,
      qualityReport: {
        decision: "pass",
        rubric: { status: "available", total: 84, interpretationBand: "Green" },
      },
    });
    expect(decodeReviewResult(result)).toEqual(result);
    const tampered = structuredClone(result);
    if (tampered.schemaVersion !== 2) throw new Error("expected v2 review result");
    (tampered.qualityReport as { confidence: number }).confidence = 0.2;
    expectCode(() => decodeReviewResult(tampered), "digest-mismatch");
    expectCode(
      () =>
        createReviewResult(
          target,
          resultInputV2({
            qualityReport: {
              ...resultInputV2().qualityReport,
              repositoryRevision: OTHER_HEAD,
            },
          }),
        ),
      "mr-head-changed",
    );
  });

  it("seals an optional hosted report URL on schema v2 and rejects off-contract URLs", () => {
    const target = createReviewTarget(targetInput());
    const url = "http://127.0.0.1:8787/reports/run-quality/";
    const result = createReviewResult(target, resultInputV2({ hostedReportUrl: url }));
    expect(result).toMatchObject({ schemaVersion: 2, hostedReportUrl: url });
    expect(decodeReviewResult(result)).toEqual(result);
    expectCode(
      () =>
        createReviewResult(
          target,
          resultInputV2({ hostedReportUrl: "https://example.com/secret" }),
        ),
      "invalid-value",
    );
  });

  it("rejects a path outside the repository, credentials, and raw patch content", () => {
    const target = createReviewTarget(targetInput());
    expectCode(
      () =>
        createReviewResult(
          target,
          resultInput({ affectedPaths: ["/Users/example-user/docsfab/src/review/contracts.ts"] }),
        ),
      "invalid-value",
    );
    expectCode(
      () =>
        createReviewResult(
          target,
          resultInput({
            findings: [
              {
                id: "finding:secret",
                severity: "error",
                code: "leak",
                summary: "token glpat-0123456789abcdefghij leaked",
                path: null,
              },
            ],
          }),
        ),
      "credential-material",
    );
    expectCode(
      () =>
        createReviewResult(
          target,
          resultInput({
            unresolvedQuestions: [
              { id: "question:patch", summary: "diff --git a/secret b/secret" },
            ],
          }),
        ),
      "invalid-value",
    );
  });
});

describe("review head proof", () => {
  it("admits a matching current head through host authority", () => {
    const target = createReviewTarget(targetInput());
    expect(assertReviewTargetHead(target, observation(), admit())).toEqual(target);
  });

  it("fails closed on unknown, ambiguous, moving, and changed heads", () => {
    const target = createReviewTarget(targetInput());
    const authority = admit();
    expectCode(
      () => assertReviewTargetHead(target, observation({ proofStatus: "unknown" }), authority),
      "unknown-target",
    );
    expectCode(
      () => assertReviewTargetHead(target, observation({ proofStatus: "ambiguous" }), authority),
      "ambiguous-target",
    );
    expectCode(
      () => assertReviewTargetHead(target, observation({ proofStatus: "moving" }), authority),
      "moving-target",
    );
    expectCode(
      () => assertReviewTargetHead(target, observation({ observedHeadSha: OTHER_HEAD }), authority),
      "mr-head-changed",
    );
    expectCode(
      () =>
        assertReviewTargetHead(target, observation({ sourceBranch: "docsfab/other" }), authority),
      "moving-target",
    );
    expectCode(
      () => assertReviewTargetHead(target, observation({ mergeRequestIid: 99 }), authority),
      "unknown-target",
    );
    expectCode(
      () =>
        assertReviewTargetHead(
          target,
          observation({ observedHeadSha: null, proofStatus: "current" }),
          authority,
        ),
      "incomplete-proof",
    );
  });

  it("rejects lookalike authorities", () => {
    const target = createReviewTarget(targetInput());
    expectCode(
      () =>
        assertReviewTargetHead(target, observation(), {
          kind: "docsfab-review-head-authority",
        } as never),
      "authority-required",
    );
  });
});

describe("gitlab-mr review locator", () => {
  it("digests a credential-free numeric project locator", () => {
    const locator = canonicalGitlabMrReviewLocator({
      host: "gitlab.example.com",
      projectId: 437040,
      mergeRequestIid: 88,
    });
    expect(locator).toBe("gitlab-mr:v1:host=gitlab.example.com:project=437040:mr=88");
    expect(
      digestGitlabMrReviewLocator({
        host: "gitlab.example.com",
        projectId: 437040,
        mergeRequestIid: 88,
      }),
    ).toMatch(/^[a-f0-9]{64}$/u);
    expect(locator).not.toContain("token");
    expect(locator).not.toContain("/Users/");
  });

  it("rejects non-positive identity and extra fields", () => {
    expect(() =>
      canonicalGitlabMrReviewLocator({
        host: "gitlab.example.com",
        projectId: 0,
        mergeRequestIid: 1,
      }),
    ).toThrow(ExternalInputContractError);
    expect(() =>
      canonicalGitlabMrReviewLocator({
        host: "gitlab.example.com",
        projectId: 1,
        mergeRequestIid: 1,
        token: "secret",
      } as never),
    ).toThrow(ExternalInputContractError);
  });
});

// Imported here rather than at the top so the lines the secret-fixture
// registry pins above do not move.
describe("review result host roots", () => {
  const TMP_ROOT = "/scratch/docsfab-tmp";

  it("projects the workspace root to repository-relative paths and keeps documentation paths", async () => {
    const { hostRootSet } = await import("../src/security/egress.js");
    const workspace = "/Users/example-user/docsfab";
    const target = createReviewTarget(targetInput());
    const result = createReviewResult(
      target,
      resultInput({
        findings: [
          {
            id: "finding:shebang",
            severity: "warning",
            code: "docs.shebang",
            summary: "Keep `#!/usr/bin/env node` as the first line of the script.",
            path: `${workspace}/docs/cli/install.md`,
            origin: "agent",
            evidence: `${workspace}/docs/cli/install.md starts with /usr/bin/env node.`,
            recommendation: "Leave /etc/hosts out of the example.",
          },
        ],
        affectedPaths: [`${workspace}/src/review/contracts.ts`],
      }),
      { hostRoots: hostRootSet([{ kind: "workspace", path: workspace }], { platform: "linux" }) },
    );
    expect(result.affectedPaths).toEqual(["src/review/contracts.ts"]);
    expect(result.findings[0]).toMatchObject({
      path: "docs/cli/install.md",
      summary: "Keep `#!/usr/bin/env node` as the first line of the script.",
      evidence: "docs/cli/install.md starts with /usr/bin/env node.",
      recommendation: "Leave /etc/hosts out of the example.",
    });
    expect(JSON.stringify(result)).not.toContain(workspace);
    expect(decodeReviewResult(result)).toEqual(result);
  });

  it("replaces a tmpdir root and refuses a path left outside the repository", async () => {
    const { hostRootSet } = await import("../src/security/egress.js");
    const hostRoots = hostRootSet([{ kind: "tmp", path: TMP_ROOT }], { platform: "linux" });
    const target = createReviewTarget(targetInput());
    const result = createReviewResult(
      target,
      resultInput({
        unresolvedQuestions: [
          { id: "question:scratch", summary: `Is ${TMP_ROOT}/scratch/notes.md still needed?` },
        ],
      }),
      { hostRoots },
    );
    expect(result.unresolvedQuestions[0]?.summary).toBe(
      "Is $TMPDIR/scratch/notes.md still needed?",
    );
    expect(JSON.stringify(result)).not.toContain(TMP_ROOT);
    for (const path of [`${TMP_ROOT}/scratch/notes.md`, "/usr/bin/env", "~/notes.md"]) {
      expectCode(
        () => createReviewResult(target, resultInput({ affectedPaths: [path] }), { hostRoots }),
        "invalid-value",
      );
    }
  });

  it("replaces a tmpdir root in a candidate review result before sealing", async () => {
    const { hostRootSet } = await import("../src/security/egress.js");
    const { createCandidateReviewResult } = await import("../src/review/index.js");
    const { locatorSha256: _locator, ...common } = resultInputV2();
    const result = createCandidateReviewResult(
      { bindingSha256: HASH, reviewCommitObjectId: HEAD },
      {
        ...common,
        locatorSha256: null,
        unresolvedQuestions: [
          { id: "question:scratch", summary: `Is ${TMP_ROOT}/scratch/notes.md still needed?` },
        ],
      },
      { hostRoots: hostRootSet([{ kind: "tmp", path: TMP_ROOT }], { platform: "linux" }) },
    );
    expect(result.unresolvedQuestions[0]?.summary).toBe(
      "Is $TMPDIR/scratch/notes.md still needed?",
    );
    expect(JSON.stringify(result)).not.toContain(TMP_ROOT);
  });

  it("leaves a declared public HOME as written and replaces it when undeclared", () => {
    const summary = "Run it from /home/node/docs as the image does.";
    const seal = () =>
      createReviewResult(
        createReviewTarget(targetInput()),
        resultInput({ unresolvedQuestions: [{ id: "question:home", summary }] }),
      ).unresolvedQuestions[0]?.summary;
    vi.stubEnv("HOME", "/home/node");
    try {
      vi.stubEnv("DOCSFAB_PUBLIC_ROOTS", "/home/node");
      expect(seal()).toBe(summary);
      vi.stubEnv("DOCSFAB_PUBLIC_ROOTS", "");
      expect(seal()).toBe("Run it from ~/docs as the image does.");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("refuses a backslash or drive-letter path as not repository-relative", () => {
    const target = createReviewTarget(targetInput());
    for (const path of ["docs\\guide.md", "C:\\docs\\guide.md", "C:/docs/guide.md"]) {
      expectCode(
        () => createReviewResult(target, resultInput({ affectedPaths: [path] })),
        "invalid-value",
      );
    }
    expect(
      createReviewResult(target, resultInput({ affectedPaths: ["docs/guide.md"] })).affectedPaths,
    ).toEqual(["docs/guide.md"]);
  });

  it("keeps a finding that quotes documentation credential keys", async () => {
    const { assertReviewFindingDisclosure } = await import("../src/review/index.js");
    const finding = {
      id: "finding:config",
      severity: "info" as const,
      code: "docs.config",
      summary: 'The guide sets password: "changeme" and token = ${GITLAB_TOKEN}.',
      path: "docs/config.md",
    };
    expect(() => assertReviewFindingDisclosure(finding)).not.toThrow();
    const result = createReviewResult(
      createReviewTarget(targetInput()),
      resultInput({ findings: [finding] }),
    );
    expect(result.findings[0]?.summary).toBe(finding.summary);
  });
});

const { canonicalizeJsonEvidence } = await import("../src/json-evidence.js");
const { createChangeSource } = await import("../src/inputs/change-source.js");
const { gitlabProjectIdentity } = await import("../src/inputs/change-source/revision.js");
const { authoringReviewFindingsRecord } = await import("./helpers/authoring-review-record.js");
const { decodeReviewResultV2, createReviewTargetV2, reviewResultFromRun } = await import(
  "../src/review/index.js"
);
const { canonicalDigest, sha256 } = await import("../src/content-ir/canonical.js");
const { documentationAuditSearch } = await import("../src/maturity/audit-search-plan.js");
const {
  createAuthoringExecutionEvidenceV1,
  createAuthoringPhaseEvidenceV1,
  createAuthoringRevisionAdmissionBindingV1,
  authoringPhaseInvocationBindingV1,
  validateAuthoringRunRecordV1,
} = await import("../src/records/authoring-execution.js");
const { documentationObservationSearch } = await import("../src/search/observation-search-plan.js");
const { authoringSelectedPath } = await import("../src/workflow-contracts/authoring-schedule.js");
const { createAuthoringCandidate } = await import(
  "../src/workflow-execution/authoring-candidate.js"
);
const { bindTechnicalCorrectionResponse } = await import(
  "../src/workflow-execution/source-obligation.js"
);
const { parseWorkflowManifestSnapshot } = await import("../src/workflow-registry/manifest.js");
const { createRealAuthoringEvidenceFixture } = await import("./helpers/authoring-evidence.js");
const { authoringManifestV3 } = await import("./helpers/authoring-manifest.js");

describe("retained canonical review projection", () => {
  it("seals admitted V3 prose bytes while keeping location, patch, credential, and shape refusals", () => {
    const target = createReviewTarget(targetInput());
    const input = structuredClone(resultInputV3()) as unknown as {
      issues: Array<{
        finding: string;
        location: string;
        requiredChange: string;
        unexpected?: string;
      }>;
      sourceContexts: Array<{ dimensions: Array<{ facts: Array<{ statement: string }> }> }>;
    };
    input.issues[0]!.finding = "\n The bounded source contradicts the page. \n";
    input.issues[0]!.requiredChange = "\n Correct the page using the bounded source. \n";
    input.sourceContexts[0]!.dimensions[0]!.facts[0]!.statement =
      "\n The admitted fact remains exact. \n";
    const result = createReviewResult(target, input as never);
    if (result.schemaVersion !== 3) throw new Error("expected a sealed V3 graph");
    expect(result.issues[0]?.finding).toBe(input.issues[0]!.finding);
    expect(result.issues[0]?.requiredChange).toBe(input.issues[0]!.requiredChange);
    expect(result.sourceContexts[0]?.dimensions[0]?.facts[0]?.statement).toBe(
      input.sourceContexts[0]!.dimensions[0]!.facts[0]!.statement,
    );
    expect(decodeReviewResult(result)).toEqual(result);

    for (const field of ["finding", "requiredChange"] as const) {
      for (const blank of ["   ", "\n\t"] as const) {
        const invalidProse = structuredClone(input);
        invalidProse.issues[0]![field] = blank;
        expectCode(() => createReviewResult(target, invalidProse as never), "invalid-value");
      }
    }
    const invalidLocation = structuredClone(input);
    invalidLocation.issues[0]!.location = ` ${input.issues[0]!.location}`;
    expectCode(() => createReviewResult(target, invalidLocation as never), "invalid-value");
    const patch = structuredClone(input);
    patch.issues[0]!.requiredChange = "diff --git a/page b/page";
    expectCode(() => createReviewResult(target, patch as never), "invalid-value");
    const credential = structuredClone(input);
    credential.issues[0]!.requiredChange = "glpat-0123456789abcdefghij";
    expectCode(() => createReviewResult(target, credential as never), "credential-material");
    const extraKey = structuredClone(input);
    extraKey.issues[0]!.unexpected = "not in V3";
    expectCode(() => createReviewResult(target, extraKey as never), "invalid-shape");
    const legacy = createReviewResult(target, resultInput());
    expect(decodeReviewResult(legacy)).toEqual(legacy);
  });

  it("refuses retained canonical blank advice instead of sealing an apparently clean result", () => {
    const record = authoringReviewFindingsRecord();
    const step = record.steps.find((entry) => entry.id === "verify-technical-accuracy")!;
    const verification = JSON.parse(step.summary!) as {
      review: { issues: Array<{ required_change: string }> };
    };
    verification.review.issues[0]!.required_change = "\n\t";
    step.summary = canonicalizeJsonEvidence(verification as never);
    const target = createReviewTarget(
      targetInput({
        workflow: "create-documentation",
        headSha: record.repository.revision,
      }),
    );
    expectCode(() => reviewResultFromRun(record, { target }), "invalid-value");
  });

  it("projects one retained canonical technical action with every linked fact", () => {
    const record = authoringReviewFindingsRecord();
    const step = record.steps.find((entry) => entry.id === "verify-technical-accuracy")!;
    const verification = JSON.parse(step.summary!) as {
      review: { issues: Array<{ required_change: string; finding: string }> };
      factInventory: { dimensions: Array<{ facts: Array<Record<string, unknown>> }> };
    };
    const action = `Correct the admitted behavior. ${"Retain the middle and tail of this repair. ".repeat(22)}End of repair.`;
    verification.review.issues[0]!.required_change = action;
    verification.review.issues[0]!.finding =
      "The issue meaning is distinct from any single supporting fact.";
    verification.review.issues.push({
      ...structuredClone(verification.review.issues[0]!),
      id: "TECH-002",
      finding: "A separate issue shares one source fact.",
      required_change: "Correct the separate documented example.",
    } as never);
    verification.factInventory.dimensions[0]!.facts.push({
      id: "FACT-002",
      dimension: verification.factInventory.dimensions[0]!.facts[0]!.dimension,
      sourceLocators: ["src/other.ts:9"],
      statement: "A second source affects the same documented behavior.",
      documentationDisposition: "conflicting",
      uncertainty: "This qualifier must survive the projection.",
      issueIds: ["TECH-001", "TECH-002"],
    });
    step.summary = canonicalizeJsonEvidence(verification as never);
    const target = createReviewTarget(
      targetInput({
        workflow: "create-documentation",
        headSha: record.repository.revision,
      }),
    );
    const result = reviewResultFromRun(record, { target });
    expect(result.schemaVersion).toBe(3);
    if (result.schemaVersion !== 3)
      throw new Error("retained canonical issue was not projected as V3");
    expect(result.issues).toHaveLength(2);
    expect(result.issues[0]).toMatchObject({
      finding: verification.review.issues[0]!.finding,
      requiredChange: action,
      factRefs: [
        { dimensionIndex: 0, factIndex: 0 },
        { dimensionIndex: 0, factIndex: 1 },
      ],
    });
    expect(result.sourceContexts[0]?.dimensions[0]?.facts[1]).toMatchObject({
      uncertainty: "This qualifier must survive the projection.",
      issueIds: ["TECH-001", "TECH-002"],
    });
    expect(result.issues[1]?.factRefs).toEqual([{ dimensionIndex: 0, factIndex: 1 }]);
    expect(
      result.findings.some((finding) => finding.code === "TECH-001" || finding.code === "FACT-002"),
    ).toBe(false);
    expect(result.findings.some((finding) => finding.code === "TASK-001")).toBe(true);
    expect(decodeReviewResult(result)).toEqual(result);
  });

  it("keeps a legacy technical wrapper on its disclosed standalone route", () => {
    const record = authoringReviewFindingsRecord();
    const step = record.steps.find((entry) => entry.id === "verify-technical-accuracy")!;
    const verification = JSON.parse(step.summary!) as Record<string, unknown>;
    delete verification.factInventory;
    step.summary = canonicalizeJsonEvidence(verification as never);
    const target = createReviewTarget(
      targetInput({
        workflow: "create-documentation",
        headSha: record.repository.revision,
      }),
    );
    const result = reviewResultFromRun(record, { target });
    expect(result.schemaVersion).toBe(1);
    expect(result.findings.some((finding) => finding.code === "TECH-001")).toBe(true);
    expect(Object.hasOwn(result, "issues")).toBe(false);
  });

  it("refuses invalid admitted canonical facts instead of returning an apparently clean result", () => {
    const record = authoringReviewFindingsRecord();
    const step = record.steps.find((entry) => entry.id === "verify-technical-accuracy")!;
    const verification = JSON.parse(step.summary!) as {
      factInventory: { dimensions: Array<{ facts: Array<{ issueIds: string[] }> }> };
    };
    verification.factInventory.dimensions[0]!.facts[0]!.issueIds = ["TECH-999"];
    step.summary = canonicalizeJsonEvidence(verification as never);
    const target = createReviewTarget(
      targetInput({
        workflow: "create-documentation",
        headSha: record.repository.revision,
      }),
    );
    expect(() => reviewResultFromRun(record, { target })).toThrowError(
      "Review result canonical technical evidence is invalid or unavailable.",
    );
  });

  it("carries the admitted issue graph through the provider V2 to result V4 wrapper", () => {
    const record = authoringReviewFindingsRecord();
    const base = "b".repeat(40);
    const source = createChangeSource({
      source: {
        kind: "gitlab-merge-request",
        provenance: "forge-reported",
        host: "gitlab.example.com",
        projectPath: "team/docs",
        projectId: 437040,
        iid: 88,
        state: "opened",
        mergeMode: null,
        diffRefs: { base, start: base, head: record.repository.revision },
        mergeCommit: null,
        squashCommit: null,
        fork: false,
      },
      revision: {
        schemaVersion: 1,
        kind: "docsfab-pinned-repository-revision",
        repository: gitlabProjectIdentity({ host: "gitlab.example.com", projectId: 437040 }),
        base,
        head: record.repository.revision,
      },
      objectFormat: "sha1",
      rangeSemantics: "two-dot",
      mergeBase: null,
      diffFrom: base,
      baseTree: null,
      headTree: null,
      commits: [{ id: record.repository.revision, parents: [base], subject: "Change docs" }],
      files: [],
      labels: [],
      protocol: { provider: "gitlab" },
    });
    record.changeSources = [
      {
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
      },
    ];
    const target = createReviewTargetV2(
      {
        scmProvider: "gitlab",
        host: "gitlab.example.com",
        projectId: 437040,
        mergeRequestIid: 88,
        sourceFork: false,
        sourceBranch: "docsfab/topic",
        targetBranch: "main",
        baseSha: base,
        headSha: record.repository.revision,
        trigger: "api",
        requestIdentitySha256: HASH,
        workflow: "create-documentation",
        deliveryIntent: REVIEW_DELIVERY_INTENT,
        logicalRequestId: "request:provider-review",
        changeSourceSha256: source.changeSourceSha256,
      },
      source,
    );
    const result = reviewResultFromRun(record, { target, source });
    expect(result.schemaVersion).toBe(4);
    if (result.schemaVersion !== 4) throw new Error("provider V2 result did not use V4");
    expect(result.issues).toHaveLength(1);
    expect(result.sourceContexts[0]?.dimensions[0]?.facts[0]?.issueIds).toContain("TECH-001");
    expect(decodeReviewResultV2(result)).toEqual(result);
  });

  it("seals the selected revised candidate graph with reused IDs and excludes the stale producer", async () => {
    const workflow = parseWorkflowManifestSnapshot(authoringManifestV3(), "create-documentation", {
      "documentation-audit": documentationAuditSearch,
      "documentation-observation": documentationObservationSearch,
    });
    const fixture = await createRealAuthoringEvidenceFixture(workflow, { actionable: true });
    try {
      const record = selectedRevisedRun(workflow, fixture);
      const target = createReviewTarget(
        targetInput({ workflow: "create-documentation", headSha: fixture.revision }),
      );
      const result = reviewResultFromRun(record, { target });
      expect(result.schemaVersion).toBe(3);
      if (result.schemaVersion !== 3) throw new Error("selected review result was not V3");
      expect(record.authoringExecution?.selectedCandidate?.ordinal).toBe(1);
      expect(result.issues).toHaveLength(1);
      expect(result.issues[0]).toMatchObject({
        originalId: "TECH-001",
        producerStepId: "verify-revised-technical-accuracy",
        finding: "The selected revision still omits the bounded source behavior.",
        sourceContextId: "context:verify-revised-technical-accuracy",
      });
      expect(result.sourceContexts).toHaveLength(1);
      expect(result.sourceContexts[0]?.dimensions[0]?.facts[0]).toMatchObject({
        id: "FACT-001",
        statement: "The selected revision retains the current source fact.",
        issueIds: ["TECH-001"],
      });
      expect(JSON.stringify(result)).not.toContain(
        "The page omits the required source-backed behavior.",
      );
      expect(decodeReviewResult(result)).toEqual(result);
    } finally {
      await fixture.dispose();
    }
  });
});

type SelectionFixture = Awaited<ReturnType<typeof createRealAuthoringEvidenceFixture>>;
type SelectionWorkflow = ReturnType<typeof parseWorkflowManifestSnapshot>;
type SelectionStep = import("../src/records/contracts.js").StepRunRecord;
type SelectionRun = import("../src/records/contracts.js").RunRecord;

function selectedRevisedRun(workflow: SelectionWorkflow, fixture: SelectionFixture): SelectionRun {
  if (fixture.selection.kind !== "revise") throw new Error("Expected actionable first candidate.");
  const candidate0 = fixture.candidate0;
  const candidate1 = createAuthoringCandidate({
    runId: fixture.runId,
    ordinal: 1,
    originalRevision: fixture.revision,
    planDigest: fixture.plan.digest,
    writePaths: fixture.writePaths,
    patchDigestSha256: "3".repeat(64),
    patchBytes: 202,
    workspaceSnapshotDigest: "4".repeat(64),
  });
  const candidates = [candidate0, candidate1];
  const revisedTechnical = structuredClone(fixture.technicalResult);
  revisedTechnical.review.issues[0]!.finding =
    "The selected revision still omits the bounded source behavior.";
  revisedTechnical.factInventory.dimensions[0]!.facts[0]!.statement =
    "The selected revision retains the current source fact.";
  const revisedCorrection = bindTechnicalCorrectionResponse(
    { verificationResult: revisedTechnical, obligationAccounting: [] },
    fixture.ledger,
    (value) => value as typeof revisedTechnical,
  );
  const canonical = (value: unknown) => canonicalizeJsonEvidence(value as never).trimEnd();
  const summaries: Record<string, string> = {
    "plan-documentation": canonical(fixture.plan),
    "derive-source-obligations": fixture.ledgerSummary,
    "provisional-technical-verification": fixture.technicalSummary,
    "verify-technical-accuracy": fixture.technicalSummary,
    "review-documentation": fixture.editorialSummary,
    "provisional-revised-technical-verification": canonical(revisedTechnical),
    "verify-revised-technical-accuracy": canonical(revisedCorrection.verificationResult),
    "review-revised-documentation": fixture.editorialSummary,
  };
  const path = authoringSelectedPath(workflow, "revise");
  const accounting = selectedRevisionAccounting(fixture);
  const steps: SelectionStep[] = [];
  for (const definition of path.steps) {
    const status = definition.id === "test-audience-understanding" ? "failed" : "succeeded";
    const summary = summaries[definition.id] ?? `Completed ${definition.id}.`;
    const phase = path.phases.find((item) => item.stepId === definition.id);
    steps.push({
      id: definition.id,
      title: definition.title,
      kind: definition.kind,
      skill: definition.skill,
      mode: definition.mode,
      status,
      summary,
      ...(definition.id === "plan-documentation" ? { planBinding: fixture.plan } : {}),
      ...(definition.id === "derive-source-obligations"
        ? { searchEvidence: fixture.searchEvidence }
        : {}),
      ...(definition.id === "verify-technical-accuracy"
        ? { technicalCorrectionEvidence: fixture.correction }
        : {}),
      ...(definition.id === "verify-revised-technical-accuracy"
        ? { technicalCorrectionEvidence: revisedCorrection.evidence }
        : {}),
      ...(phase
        ? {
            authoringPhase: createAuthoringPhaseEvidenceV1({
              workflow,
              branchId: phase.ordinal <= 7 ? null : "revise",
              stepId: definition.id,
              candidates,
              outputAdmitted: status === "succeeded" && phase.role === "writer",
              summary,
            }),
          }
        : {}),
      ...(definition.id === "revise-documentation"
        ? { authoringRevisionAccounting: accounting }
        : {}),
    });
    if (status === "failed") break;
  }
  for (const step of steps) {
    const phase = path.phases.find((item) => item.stepId === step.id);
    if (!phase || (step.kind ?? "inference") === "host-operation") continue;
    const invocation = authoringPhaseInvocationBindingV1({
      workflow,
      branchId: phase.ordinal <= 7 ? null : "revise",
      stepId: step.id,
      candidates:
        phase.role === "writer"
          ? phase.stepId === "write-documentation"
            ? []
            : candidates.slice(0, 1)
          : candidates.slice(0, phase.candidateOrdinal + 1),
      revisionInputDigest:
        phase.stepId === "revise-documentation" ? fixture.selection.input.digest : null,
    });
    step.inference = {
      attempts: [
        {
          identity: {
            repositoryRevision: fixture.revision,
            authoringPhaseSha256: canonicalDigest(invocation),
          },
        },
      ],
    } as SelectionStep["inference"];
  }
  const execution = createAuthoringExecutionEvidenceV1(
    {
      runId: fixture.runId,
      repositoryRevision: fixture.revision,
      planDigest: fixture.plan.digest,
      writePaths: fixture.writePaths,
      sourceSearchSnapshotSha256: fixture.searchEvidence.workspaceSnapshotSha256,
      sourceObligationLedgerSha256: fixture.ledger.digest,
      technicalCorrectionEvidenceSha256: fixture.correction.digest,
      selection: {
        branchId: "revise",
        input: {
          candidate0Digest: candidate0.digest,
          candidate0WorkspaceSnapshotDigest: candidate0.workspaceSnapshotDigest,
          originalRevision: fixture.revision,
          planDigest: fixture.plan.digest,
          writePaths: fixture.writePaths,
          sourceSearchSnapshotSha256: fixture.searchEvidence.workspaceSnapshotSha256,
          sourceObligationLedgerSha256: fixture.ledger.digest,
          technicalCorrectionEvidenceSha256: fixture.correction.digest,
          technical: selectedProducer(
            candidate0,
            "verify-technical-accuracy",
            fixture.technicalSummary,
          ),
          editorial: selectedProducer(candidate0, "review-documentation", fixture.editorialSummary),
        },
        revisionInputDigest: fixture.selection.input.digest,
      },
      candidates: [
        { candidate: candidate0, revisionInputDigest: null },
        { candidate: candidate1, revisionInputDigest: fixture.selection.input.digest },
      ],
      revisionAdmission: createAuthoringRevisionAdmissionBindingV1({
        candidate0,
        candidate1,
        actualChangedPaths: accounting.changedPaths,
        accounting,
      }),
      partialCandidate1: null,
      selectedCandidateOrdinal: 1,
      selectedProducers: null,
      includeFinalPatch: true,
    },
    workflow,
  );
  const record: SelectionRun = {
    schemaVersion: 2,
    id: fixture.runId,
    workflow: "create-documentation",
    repository: fixture.repository,
    workspace: { strategy: "tracked-export", disposable: true },
    status: "failed",
    createdAt: "2026-09-15T00:00:00.000Z",
    models: [],
    skills: [],
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, turns: 0 },
    tools: { totalCalls: 0, failedCalls: 0, byTool: [] },
    steps,
    authoringExecution: execution,
    changes: {
      files: fixture.writePaths.map((path) => ({ path, status: "added" })),
      patch: {
        sha256: candidate1.patchDigestSha256,
        byteLength: candidate1.patchBytes,
        lineCount: 1,
        artifactPath: ".docsfab/authoring-run.patch",
        format: "git-diff",
      },
    },
  };
  validateAuthoringRunRecordV1(record, workflow);
  return record;
}

function selectedProducer(
  candidate: SelectionFixture["candidate0"],
  stepId: string,
  summary: string,
) {
  return {
    stepId,
    summarySha256: sha256(summary),
    candidateOrdinal: candidate.ordinal,
    candidateDigest: candidate.digest,
    workspaceSnapshotDigest: candidate.workspaceSnapshotDigest,
  };
}

function selectedRevisionAccounting(fixture: SelectionFixture) {
  if (fixture.selection.kind !== "revise") throw new Error("Expected revision input.");
  const issueIds = [
    ...new Set(fixture.selection.input.actionableFacts.flatMap((fact) => fact.issueIds)),
  ].sort();
  return {
    issueAccounting: issueIds.map((issueId) => {
      const fact = fixture.selection.input.actionableFacts.find((item) =>
        item.issueIds.includes(issueId),
      );
      if (!fact) throw new Error(`Missing admitted fact for ${issueId}.`);
      return {
        issueId,
        disposition: "applied",
        reason: "The admitted source evidence supports this bounded correction.",
        sourceLocators: [fact.sourceLocators[0]],
      };
    }),
    changedPaths: [...fixture.writePaths],
    unresolvedFacts: [],
  };
}
