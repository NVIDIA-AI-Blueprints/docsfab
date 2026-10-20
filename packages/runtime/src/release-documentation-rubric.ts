// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { WorkflowSearchPlanV1 } from "./workflow-contracts/contracts.js";
import { canonicalDigest } from "./content-ir/canonical.js";
import { SEARCH_ALL_CRITERIA_RUBRIC_VERSION } from "./search/bounded-search-contracts.js";

export type ReleaseDocumentationReadinessCategory =
  | "audience"
  | "site-infrastructure"
  | "site-build"
  | "site-template"
  | "site-validation"
  | "information-architecture"
  | "journey"
  | "task-guide"
  | "reference"
  | "trust"
  | "release-policy"
  | "governance"
  | "scoped-guidance"
  | "human-decision";

export type ReleaseDocumentationPriority = "P0" | "P1" | "P2";

export type ReleaseDocumentationContentClass =
  | "launch-audiences"
  | "personas"
  | "user-jobs"
  | "site-templates"
  | "public-information-architecture"
  | "installation"
  | "quickstart"
  | "first-success"
  | "task-guides"
  | "cli-reference"
  | "configuration-reference"
  | "api-reference"
  | "troubleshooting"
  | "failure-modes"
  | "security"
  | "limitations"
  | "trust-boundaries"
  | "releases"
  | "compatibility"
  | "support"
  | "lifecycle"
  | "ownership"
  | "freshness"
  | "review-policy"
  | "human-decisions";

export type ReleaseDocumentationRubricQuestion =
  | {
      kind: "document-profile";
      contentClass: ReleaseDocumentationContentClass;
      minByteLength: number;
      minSectionCount: number;
      minSubstantiveSectionCount: number;
      minRelationshipCount: number;
      minProcedureStepCount: number;
      minCodeBlockCount: number;
    }
  | { kind: "decision-status"; topic: string; status: "approved" }
  | {
      kind: "metadata";
      field:
        | "site-generator"
        | "build-command"
        | "link-check-command"
        | "ci-validation"
        | "navigation-graph"
        | "instruction-scope";
    };

export interface ReleaseDocumentationRubricSpecification {
  targetId: string;
  category: ReleaseDocumentationReadinessCategory;
  priority: ReleaseDocumentationPriority;
  dependencies: readonly string[];
  requiredHumanInput: readonly string[];
  question: string;
  evidenceDomain: string;
  questions: readonly ReleaseDocumentationRubricQuestion[];
}

const profile = (
  contentClass: ReleaseDocumentationContentClass,
  overrides: Partial<
    Extract<ReleaseDocumentationRubricQuestion, { kind: "document-profile" }>
  > = {},
): Extract<ReleaseDocumentationRubricQuestion, { kind: "document-profile" }> => ({
  kind: "document-profile",
  contentClass,
  minByteLength: 240,
  minSectionCount: 2,
  minSubstantiveSectionCount: 2,
  minRelationshipCount: 1,
  minProcedureStepCount: 0,
  minCodeBlockCount: 0,
  ...overrides,
});

const decision = (topic: string): ReleaseDocumentationRubricQuestion => ({
  kind: "decision-status",
  topic,
  status: "approved",
});

const metadata = (
  field: Extract<ReleaseDocumentationRubricQuestion, { kind: "metadata" }>["field"],
): ReleaseDocumentationRubricQuestion => ({ kind: "metadata", field });

function spec(
  id: string,
  category: ReleaseDocumentationReadinessCategory,
  priority: ReleaseDocumentationPriority,
  dependencies: readonly string[],
  requiredHumanInput: readonly string[],
  question: string,
  questions: readonly ReleaseDocumentationRubricQuestion[],
): ReleaseDocumentationRubricSpecification {
  return Object.freeze({
    targetId: `release-${id}`,
    category,
    priority,
    dependencies: Object.freeze([...dependencies]),
    requiredHumanInput: Object.freeze([...requiredHumanInput]),
    question,
    evidenceDomain: id,
    questions: Object.freeze([...questions]),
  });
}

export const RELEASE_DOCUMENTATION_RUBRIC = Object.freeze([
  spec(
    "launch-audiences",
    "audience",
    "P0",
    [],
    [],
    "What substantive public documentation identifies launch audiences?",
    [profile("launch-audiences"), profile("launch-audiences")],
  ),
  spec(
    "personas",
    "audience",
    "P0",
    ["release-launch-audiences"],
    [],
    "What substantive public documentation identifies release personas?",
    [profile("personas"), profile("personas")],
  ),
  spec(
    "user-jobs",
    "audience",
    "P0",
    ["release-personas"],
    [],
    "What substantive documentation identifies the jobs each persona must complete?",
    [profile("user-jobs"), profile("user-jobs")],
  ),
  spec(
    "site-infrastructure",
    "site-infrastructure",
    "P0",
    [],
    [],
    "What governed evidence establishes public documentation site infrastructure?",
    [metadata("site-generator"), metadata("site-generator")],
  ),
  spec(
    "site-build",
    "site-build",
    "P0",
    ["release-site-infrastructure"],
    [],
    "What governed evidence establishes a reproducible documentation build?",
    [metadata("build-command"), metadata("build-command")],
  ),
  spec(
    "site-templates",
    "site-template",
    "P2",
    ["release-site-infrastructure"],
    [],
    "What substantive public authoring template or convention is available?",
    [profile("site-templates"), profile("site-templates")],
  ),
  spec(
    "site-validation",
    "site-validation",
    "P0",
    ["release-site-build"],
    [],
    "What governed evidence establishes documentation validation?",
    [metadata("ci-validation"), metadata("link-check-command")],
  ),
  spec(
    "public-information-architecture",
    "information-architecture",
    "P0",
    ["release-site-infrastructure"],
    [],
    "What substantive documentation declares the public information architecture?",
    [profile("public-information-architecture"), profile("public-information-architecture")],
  ),
  spec(
    "public-navigation",
    "information-architecture",
    "P0",
    ["release-public-information-architecture"],
    [],
    "What governed evidence establishes working public navigation?",
    [profile("public-information-architecture"), metadata("navigation-graph")],
  ),
  spec(
    "installation",
    "journey",
    "P0",
    ["release-user-jobs"],
    [],
    "What substantive public installation journey is available?",
    [
      profile("installation", { minProcedureStepCount: 3 }),
      profile("installation", { minProcedureStepCount: 3 }),
    ],
  ),
  spec(
    "quickstart",
    "journey",
    "P0",
    ["release-installation"],
    [],
    "What substantive public quickstart journey is available?",
    [
      profile("quickstart", { minProcedureStepCount: 3 }),
      profile("quickstart", { minProcedureStepCount: 3 }),
    ],
  ),
  spec(
    "first-success",
    "journey",
    "P0",
    ["release-quickstart"],
    [],
    "What documented journey establishes a verifiable first success?",
    [
      profile("first-success", { minProcedureStepCount: 2 }),
      profile("first-success", { minProcedureStepCount: 2 }),
    ],
  ),
  spec(
    "task-guides",
    "task-guide",
    "P1",
    ["release-user-jobs"],
    [],
    "What substantive task-oriented public guides are available?",
    [
      profile("task-guides", { minProcedureStepCount: 3 }),
      profile("task-guides", { minProcedureStepCount: 3 }),
    ],
  ),
  spec("cli-reference", "reference", "P1", [], [], "What substantive CLI reference is available?", [
    profile("cli-reference", { minCodeBlockCount: 1 }),
    profile("cli-reference", { minCodeBlockCount: 1 }),
  ]),
  spec(
    "configuration-reference",
    "reference",
    "P1",
    [],
    [],
    "What substantive configuration reference is available?",
    [
      profile("configuration-reference", { minCodeBlockCount: 1 }),
      profile("configuration-reference", { minCodeBlockCount: 1 }),
    ],
  ),
  spec("api-reference", "reference", "P1", [], [], "What substantive API reference is available?", [
    profile("api-reference", { minCodeBlockCount: 1 }),
    profile("api-reference", { minCodeBlockCount: 1 }),
  ]),
  spec(
    "troubleshooting",
    "trust",
    "P0",
    [],
    [],
    "What substantive public troubleshooting guidance is available?",
    [
      profile("troubleshooting", { minProcedureStepCount: 2 }),
      profile("troubleshooting", { minProcedureStepCount: 2 }),
    ],
  ),
  spec(
    "failure-modes",
    "trust",
    "P0",
    [],
    [],
    "What substantive public failure modes are documented?",
    [profile("failure-modes"), profile("failure-modes")],
  ),
  spec(
    "security",
    "trust",
    "P0",
    [],
    ["Confirm the approved public security statements."],
    "What approved public security statements are substantively documented?",
    [profile("security"), decision("release-security")],
  ),
  spec(
    "limitations",
    "trust",
    "P0",
    [],
    ["Confirm the public limitations that may be stated."],
    "What approved product and documentation limitations are declared?",
    [profile("limitations"), decision("release-limitations")],
  ),
  spec(
    "trust-boundaries",
    "trust",
    "P0",
    [],
    ["Confirm the approved public trust-boundary statements."],
    "What approved public trust boundaries are substantively documented?",
    [profile("trust-boundaries"), decision("release-trust-boundaries")],
  ),
  spec(
    "releases",
    "release-policy",
    "P0",
    [],
    [],
    "What substantive public release documentation is available?",
    [profile("releases"), profile("releases")],
  ),
  spec(
    "compatibility",
    "release-policy",
    "P0",
    [],
    ["Confirm compatibility policy before publication."],
    "What approved compatibility expectations are declared?",
    [profile("compatibility"), decision("release-compatibility")],
  ),
  spec(
    "support",
    "release-policy",
    "P0",
    [],
    ["Confirm support expectations before publication."],
    "What approved support expectations are declared?",
    [profile("support"), decision("release-support")],
  ),
  spec(
    "lifecycle",
    "release-policy",
    "P0",
    [],
    ["Confirm lifecycle policy before publication."],
    "What approved lifecycle expectations are declared?",
    [profile("lifecycle"), decision("release-lifecycle")],
  ),
  spec(
    "ownership",
    "governance",
    "P1",
    [],
    ["Name an accountable documentation owner."],
    "What approved documentation ownership is declared?",
    [profile("ownership"), decision("release-ownership")],
  ),
  spec(
    "freshness",
    "governance",
    "P1",
    [],
    [],
    "What substantive documentation freshness evidence is declared?",
    [profile("freshness"), profile("freshness")],
  ),
  spec(
    "review-policy",
    "governance",
    "P1",
    [],
    ["Approve the documentation review cadence."],
    "What approved documentation review policy is declared?",
    [profile("review-policy"), decision("release-review-policy")],
  ),
  spec(
    "scoped-agents-guidance",
    "scoped-guidance",
    "P1",
    [],
    [],
    "What scoped AGENTS.md guidance governs documentation work?",
    [metadata("instruction-scope"), metadata("instruction-scope")],
  ),
  spec(
    "explicit-human-decisions",
    "human-decision",
    "P0",
    [],
    ["Record unresolved release-documentation decisions and their approvers."],
    "Which release-documentation policy decisions are explicitly approved rather than inferred?",
    [profile("human-decisions"), decision("release-explicit-human-decisions")],
  ),
] satisfies readonly ReleaseDocumentationRubricSpecification[]);

export const RELEASE_DOCUMENTATION_CONTENT_CLASSES = Object.freeze(
  [
    ...new Set(
      RELEASE_DOCUMENTATION_RUBRIC.flatMap((item) =>
        item.questions.flatMap((question) =>
          question.kind === "document-profile" ? [question.contentClass] : [],
        ),
      ),
    ),
  ].sort(),
);

const byTarget = new Map(RELEASE_DOCUMENTATION_RUBRIC.map((item) => [item.targetId, item]));

export function releaseDocumentationSpecification(
  targetId: string,
): ReleaseDocumentationRubricSpecification | undefined {
  return byTarget.get(targetId);
}

export interface ReleaseDocumentationExpectedRepositoryV1 {
  sourcePath: string;
  requestedRevision: string;
  revision: string;
  defaultBranch: string;
}

export function releaseDocumentationRepositoryIdentity(
  repository: ReleaseDocumentationExpectedRepositoryV1,
): string {
  if (
    !repository.sourcePath ||
    !/^[A-Za-z0-9._/@+-]{1,255}$/u.test(repository.defaultBranch) ||
    !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(repository.revision)
  ) {
    throw new Error("Release documentation repository authority is invalid.");
  }
  return canonicalDigest({
    sourcePath: repository.sourcePath,
    revision: repository.revision,
    defaultBranch: repository.defaultBranch,
  });
}

export function releaseDocumentationRepositoryTargetSha256(
  repository: ReleaseDocumentationExpectedRepositoryV1,
): string {
  releaseDocumentationRepositoryIdentity(repository);
  return canonicalDigest(repository);
}

export function releaseDocumentationQuestion(
  targetKey: string,
  probeId: string,
): ReleaseDocumentationRubricQuestion | undefined {
  const item = byTarget.get(targetKey);
  if (!item) return undefined;
  const index = releaseProbeDeclarations(item).findIndex((probe) => probe.id === probeId);
  return index < 0 ? undefined : item.questions[index];
}

export function releaseDocumentationSearchPlan(): WorkflowSearchPlanV1 {
  return {
    schemaVersion: 1,
    id: "release-documentation-readiness-discovery",
    version: "2.0.0",
    targets: RELEASE_DOCUMENTATION_RUBRIC.map((item) => {
      const requiredProbes = releaseProbeDeclarations(item);
      const navigation = item.questions.some(
        (question) => question.kind === "metadata" && question.field === "navigation-graph",
      );
      const criteria = [
        {
          id: `${item.targetId}-criterion`,
          kind: navigation
            ? ("navigation" as const)
            : requiredProbes.length === 1
              ? ("usability" as const)
              : ("completeness" as const),
          requiredProbeIds: requiredProbes.map((probe) => probe.id),
        },
      ];
      return {
        id: item.targetId,
        targetKey: item.targetId,
        question: item.question,
        targetType: "rubric-coverage" as const,
        requiredProbes,
        rubric: {
          id: `docsfab-${item.targetId}-rubric`,
          version: SEARCH_ALL_CRITERIA_RUBRIC_VERSION,
          criteria,
        },
      };
    }),
  };
}

function releaseProbeDeclarations(item: ReleaseDocumentationRubricSpecification) {
  const navigation = item.questions.some(
    (question) => question.kind === "metadata" && question.field === "navigation-graph",
  );
  return item.questions.map((question, index) => ({
    id: `${item.targetId}-rubric-${index + 1}`,
    strategy: navigation
      ? index === 0
        ? ("rubric-assessment" as const)
        : ("navigation-graph" as const)
      : index === 0
        ? ("rubric-assessment" as const)
        : ("documentation-inventory" as const),
    location: navigation ? ("navigation" as const) : ("documentation-tree" as const),
  }));
}

export function releaseContentClassesForPath(path: string): ReleaseDocumentationContentClass[] {
  const normalized = path.toLowerCase();
  const aliases: ReadonlyArray<readonly [ReleaseDocumentationContentClass, readonly string[]]> = [
    ["launch-audiences", ["audience"]],
    ["personas", ["persona"]],
    ["user-jobs", ["user-job", "jobs"]],
    ["site-templates", ["template", "authoring"]],
    ["public-information-architecture", ["information-architecture", "docs-map", "/index."]],
    ["installation", ["install"]],
    ["quickstart", ["quickstart", "getting-started"]],
    ["first-success", ["first-success"]],
    ["task-guides", ["task-guide", "/guides/"]],
    ["cli-reference", ["cli-reference"]],
    ["configuration-reference", ["configuration-reference", "config-reference"]],
    ["api-reference", ["api-reference"]],
    ["troubleshooting", ["troubleshoot"]],
    ["failure-modes", ["failure-mode"]],
    ["security", ["security"]],
    ["limitations", ["limitation"]],
    ["trust-boundaries", ["trust-boundar"]],
    ["releases", ["release"]],
    ["compatibility", ["compatib"]],
    ["support", ["support"]],
    ["lifecycle", ["lifecycle"]],
    ["ownership", ["ownership"]],
    ["freshness", ["freshness"]],
    ["review-policy", ["review-policy"]],
    ["human-decisions", ["release-decision", "human-decision"]],
  ];
  return aliases
    .filter(([, hints]) => hints.some((hint) => normalized.includes(hint)))
    .map(([contentClass]) => contentClass);
}
