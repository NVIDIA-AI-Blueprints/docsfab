// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createPrivateKey } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { lstat, mkdir, open, readdir, realpath, type FileHandle } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";

import {
  createArtifact,
  type Artifact,
  type ArtifactEnvelope,
  type ArtifactEvidence,
  type IaPlanArtifact,
  type IaUseCase,
  type PolicyBinding,
} from "../artifacts/index.js";
import {
  buildContentIndex,
  canonicalDigest,
  canonicalJson,
  type ContentIndexV1,
  type DocumentNode,
} from "../content-ir/index.js";
import { catalogCapacity } from "../config/catalog-capacity.js";
import type { IaPlanTaskInput } from "../workflow-contracts/contracts.js";
import { readOwnerHostFile } from "../model/profile-apply.js";
import { createSiteBootstrapApplicationBundle } from "../site-bootstrap/bundle.js";
import type { SiteBootstrapApplicationBundle } from "../site-bootstrap/contracts.js";
import { standardSiteBootstrapCheckPolicy } from "../site-bootstrap/policy.js";
import { listTemplates } from "../templates/catalog.js";
import type { TemplatePreviewTopic } from "../templates/contracts.js";
import { loadTemplateSet, TEMPLATE_CATALOG_POLICY } from "../templates/load.js";
import { TEMPLATE_SELECTION_POLICY, templateSelectionDigest } from "../templates/selection.js";
import {
  TPL_DESIGN_IA_SKILL,
  validateTplDesignIaResult,
  type TplDesignIaResultV1,
} from "../skills/tpl-design-ia/index.js";
import type {
  IaAnalysisOutputPublisher,
  IaAnalysisOutputPublisherInput,
} from "./analysis-harness.js";
import { DEFAULT_IA_DIAGNOSTIC_POLICY, IA_ONTOLOGY_KIND_TO_SIBLING_KIND } from "./contracts.js";
import { evaluateIaCandidate, type EvaluateIaCandidateInput } from "./evaluator.js";
import {
  IaPlanningInputProviderError,
  LocalIaPlanningInputProvider,
  DEFAULT_IA_NAVIGATION_TASKS,
  inspectIaInputPackage,
  localIaRepositoryIdentity,
  planningTaskKey,
  provisionIaAnalysisInputPackage,
  provisionIaPlanningInputPackage,
  type IaAnalysisNavigationTask,
  type IaInputPackageReceipt,
  type IaPlanningPackageInput,
  type ProvisionIaPlanningInputPackageOptions,
} from "./input-provider.js";
import {
  documentationUrlForSourcePath,
  type NavigationRankings,
  type VersionedNavigationSuite,
} from "./navigation.js";
import { loadIaPlanReviewerPolicyFile } from "./reviewer-policy-file.js";
import { prepareIaPlanReviewerAuthorization, reviewIaPlan } from "./plan-review.js";

const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const MAX_OUTPUT_BYTES = catalogCapacity("ia.analysisOutputMaxBytes");
export { MAX_OUTPUT_BYTES as IA_ANALYSIS_OUTPUT_MAXIMUM_BYTES };
const SHA256 = /^[a-f0-9]{64}$/u;
const SAFE_RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const DEFAULT_IA_CREATE_TEMPLATE_ID = "single-procedural-gfm";

export { DEFAULT_IA_NAVIGATION_TASKS } from "./input-provider.js";

export type IaInputPackageKind = "analysis-input" | "planning-input";
export type IaInputDisposition =
  | "ready"
  | "missing-package"
  | "invalid-package"
  | "stale-package"
  | "wrong-repository"
  | "wrong-revision"
  | "expired"
  | "needs-approval";

export interface IaInputInspection {
  schemaVersion: 1;
  kind: "docsfab-ia-input-inspection";
  packageKind: IaInputPackageKind;
  disposition: Exclude<IaInputDisposition, "needs-approval">;
  taskKey: string;
  repositoryIdentity: string;
  repositoryRevision: string;
  package?: Omit<IaInputPackageReceipt, "path" | "nextCommand">;
  nextCommand?: string;
}

export interface IaAnalysisOutputPackage {
  schemaVersion: 1;
  kind: "docsfab-ia-analysis-output";
  runId: string;
  taskKey: string;
  repositoryIdentity: string;
  repository: { revision: string; contentDigest: string; indexDigest: string };
  inputPackage: { digest: string; expiresAt: string; navigationTasksDigest: string };
  result: TplDesignIaResultV1;
  artifacts: {
    ontology: ArtifactEnvelope<"ontology">;
    candidates: ArtifactEnvelope<"ia-candidates">;
    navigationEvaluation: ArtifactEnvelope<"navigation-evaluation">;
  };
  digest: string;
}

export interface IaPlanningProvisionReceipt extends IaInputPackageReceipt {
  analysisRunId: string;
  analysisOutputDigest: string;
  planningOutcome: "plan-ready";
  nextCommand: string;
}

export interface IaApprovalHandoffReceipt {
  schemaVersion: 1;
  kind: "docsfab-ia-bootstrap-handoff";
  disposition: "approved";
  pendingPlanDigest: string;
  approvedPlanDigest: string;
  reviewDigest: string;
  applicationDigest: string;
  applicationPath: string;
  repositoryIdentity: string;
  repositoryRevision: string;
  expiresAt: string;
  writesAuthorized: false;
  nextCommand: string;
}

export class IaLifecycleError extends Error {
  public constructor(
    public readonly code:
      | "invalid-command"
      | "invalid-output"
      | "missing-output"
      | "stale-output"
      | "needs-approval"
      | "unsafe-state"
      | "already-exists",
    detail?: string,
  ) {
    super(`IA lifecycle rejected: ${code}${detail ? ` (${detail})` : ""}.`);
    this.name = "IaLifecycleError";
  }
}

/** Persist only a fully validated, content-bound analysis handoff. */
export class LocalIaAnalysisOutputPublisher implements IaAnalysisOutputPublisher {
  public constructor(
    private readonly outputRoot: string,
    private readonly repositoryIdentity: string,
  ) {
    if (!SHA256.test(repositoryIdentity)) throw new IaLifecycleError("unsafe-state");
  }

  public async publish(input: IaAnalysisOutputPublisherInput): Promise<void> {
    if (
      !SAFE_RUN_ID.test(input.runId) ||
      !input.inputPackage ||
      input.inputPackage.repositoryIdentity !== this.repositoryIdentity
    ) {
      throw new IaLifecycleError("invalid-output");
    }
    const artifactSet = exactAnalysisArtifacts(input.artifacts);
    if (canonicalDigest(input.navigationTasks) !== canonicalDigest(DEFAULT_IA_NAVIGATION_TASKS)) {
      throw new IaLifecycleError("invalid-output");
    }
    const result = validateTplDesignIaResult(input.result, {
      index: input.index,
      artifacts: {
        ontology: artifactSet.ontology,
        iaCandidates: artifactSet.candidates,
        navigationEvaluation: artifactSet.navigationEvaluation,
      },
    });
    const unsigned = {
      schemaVersion: 1 as const,
      kind: "docsfab-ia-analysis-output" as const,
      runId: input.runId,
      taskKey: planningTaskKey(input.task),
      repositoryIdentity: this.repositoryIdentity,
      repository: {
        ...input.index.repository,
        indexDigest: input.index.indexDigest,
      },
      inputPackage: {
        digest: input.inputPackage.digest,
        expiresAt: input.inputPackage.expiresAt,
        navigationTasksDigest: canonicalDigest(input.navigationTasks),
      },
      result,
      artifacts: artifactSet,
    };
    const output: IaAnalysisOutputPackage = { ...unsigned, digest: canonicalDigest(unsigned) };
    await ensurePrivateDirectory(this.outputRoot);
    await writeCanonicalNoClobber(resolve(this.outputRoot, `${input.runId}.json`), output);
  }
}

export async function provisionDefaultIaAnalysisInput(input: {
  packageRoot: string;
  repositoryPath: string;
  repositoryRevision: string;
  task: Readonly<IaPlanTaskInput>;
  expiresAt: string;
  repositoryIdentity?: string;
  commandRepositoryPath?: string;
  now?: Date;
}): Promise<IaInputPackageReceipt> {
  const repositoryIdentity =
    input.repositoryIdentity ?? (await localIaRepositoryIdentity(input.repositoryPath));
  const index = await buildContentIndex({
    repositoryPath: input.repositoryPath,
    repositoryRevision: input.repositoryRevision,
  });
  return provisionIaAnalysisInputPackage({
    packageRoot: input.packageRoot,
    repositoryPath: input.repositoryPath,
    repositoryIdentity,
    commandRepositoryPath: input.commandRepositoryPath,
    task: input.task,
    index,
    navigationTasks: [...DEFAULT_IA_NAVIGATION_TASKS],
    expiresAt: input.expiresAt,
    now: input.now,
  });
}

export async function inspectIaLifecycleInput(input: {
  packageKind: IaInputPackageKind;
  packageRoot: string;
  repositoryPath: string;
  repositoryRevision: string;
  task: Readonly<IaPlanTaskInput>;
  expiresAtForProvision?: string;
  repositoryIdentity?: string;
  commandRepositoryPath?: string;
  packageDigest?: string;
  now?: Date;
}): Promise<IaInputInspection> {
  const repositoryIdentity =
    input.repositoryIdentity ?? (await localIaRepositoryIdentity(input.repositoryPath));
  const base = {
    schemaVersion: 1 as const,
    kind: "docsfab-ia-input-inspection" as const,
    packageKind: input.packageKind,
    taskKey: planningTaskKey(input.task),
    repositoryIdentity,
    repositoryRevision: input.repositoryRevision,
  };
  try {
    const receipt = await inspectIaInputPackage({
      packageKind: input.packageKind,
      packageRoot: input.packageRoot,
      repositoryPath: input.repositoryPath,
      repositoryRevision: input.repositoryRevision,
      repositoryIdentity,
      commandRepositoryPath: input.commandRepositoryPath,
      packageDigest: input.packageDigest,
      task: input.task,
      now: input.now,
    });
    const { path: _path, nextCommand: _nextCommand, ...visible } = receipt;
    return {
      ...base,
      disposition: "ready",
      package: visible,
      nextCommand: receipt.nextCommand,
    };
  } catch (error) {
    const disposition = inputDisposition(error);
    return {
      ...base,
      disposition,
      ...(input.packageKind === "analysis-input"
        ? {
            nextCommand: provisionCommand(
              input.commandRepositoryPath ?? input.repositoryPath,
              input.repositoryRevision,
              input.task,
              input.expiresAtForProvision,
              validNow(input.now ?? new Date()),
            ),
          }
        : {}),
    };
  }
}

export type IaPlanningInputFromAnalysisOptions = (
  | {
      analysisOutputRoot: string;
      analysisOutput?: never;
    }
  | {
      /** Exact package loaded through authenticated project custody by the hosted adapter. */
      analysisOutput: unknown;
      analysisOutputRoot?: never;
    }
) & {
  planningInputRoot: string;
  repositoryPath: string;
  repositoryRevision: string;
  task: Readonly<IaPlanTaskInput>;
  analysisRunId: string;
  projectRoot: string;
  repositoryIdentity?: string;
  commandRepositoryPath?: string;
  now?: Date;
  maxPackageBytes?: number;
};

/** Prepare the real governed input before the hosted adapter selects its byte allowance. */
export async function prepareIaPlanningInputFromAnalysis(
  input: IaPlanningInputFromAnalysisOptions,
): Promise<{ options: ProvisionIaPlanningInputPackageOptions; analysisOutputDigest: string }> {
  const now = validNow(input.now ?? new Date());
  const repositoryIdentity =
    input.repositoryIdentity ?? (await localIaRepositoryIdentity(input.repositoryPath));
  const index = await buildContentIndex({
    repositoryPath: input.repositoryPath,
    repositoryRevision: input.repositoryRevision,
  });
  // Exactly one analysis source: `analysisOutputRoot` (local private file) or
  // `analysisOutput` (hosted bytes from authenticated custody). With both, which
  // one is authoritative is unknowable.
  if ((input.analysisOutputRoot === undefined) === (input.analysisOutput === undefined))
    throw new IaLifecycleError("invalid-command");
  const output =
    input.analysisOutputRoot === undefined
      ? validateIaAnalysisOutputPackage(input.analysisOutput, {
          runId: input.analysisRunId,
          index,
          task: input.task,
          repositoryIdentity,
          now,
        })
      : await loadAnalysisOutput(
          input.analysisOutputRoot,
          input.analysisRunId,
          index,
          input.task,
          repositoryIdentity,
          now,
        );
  // Bind the same complete governed catalog that bootstrap resolves later;
  // selecting one GFM template must not narrow and thereby change its digest.
  const bundle = await loadTemplateSet(input.projectRoot);
  const catalog = listTemplates({ bundle });
  const template = catalog.templates.find((entry) => entry.id === DEFAULT_IA_CREATE_TEMPLATE_ID);
  if (!template) throw new IaLifecycleError("invalid-output");
  const checkPolicy = standardSiteBootstrapCheckPolicy();
  const derived = derivePlanningInput(output, index, input.task, {
    templateId: template.id,
    templateCatalog: {
      ...TEMPLATE_CATALOG_POLICY,
      digest: catalog.digest,
    },
    repositoryChecks: {
      id: checkPolicy.id,
      version: checkPolicy.version,
      digest: checkPolicy.digest,
    },
  });
  return {
    analysisOutputDigest: output.digest,
    options: {
      packageRoot: input.planningInputRoot,
      repositoryPath: input.repositoryPath,
      repositoryIdentity,
      commandRepositoryPath: input.commandRepositoryPath,
      task: input.task,
      index,
      input: derived,
      expiresAt: output.inputPackage.expiresAt,
      now,
      ...(input.maxPackageBytes === undefined ? {} : { maxPackageBytes: input.maxPackageBytes }),
    },
  };
}

/** Convert one validated analysis run into the exact immutable planning input. */
export async function provisionIaPlanningInputFromAnalysis(
  input: IaPlanningInputFromAnalysisOptions,
): Promise<IaPlanningProvisionReceipt> {
  const prepared = await prepareIaPlanningInputFromAnalysis(input);
  const receipt = await provisionIaPlanningInputPackage(prepared.options);
  return {
    ...receipt,
    analysisRunId: input.analysisRunId,
    analysisOutputDigest: prepared.analysisOutputDigest,
    planningOutcome: "plan-ready",
    nextCommand: runCommand(
      "planning-input",
      input.commandRepositoryPath ?? input.repositoryPath,
      input.repositoryRevision,
      input.task,
      receipt.digest,
    ),
  };
}

/**
 * Resolve the one validated analysis output that can provision this exact
 * task and revision. The returned command is bound to the durable source
 * checkout; disposable workspace paths never cross the process boundary.
 */
export async function resolveIaPlanningProvisionNextCommand(input: {
  analysisOutputRoot: string;
  repositoryPath: string;
  repositoryRevision: string;
  task: Readonly<IaPlanTaskInput>;
  repositoryIdentity?: string;
  commandRepositoryPath: string;
  now?: Date;
}): Promise<string | undefined> {
  const now = validNow(input.now ?? new Date());
  const repositoryIdentity =
    input.repositoryIdentity ?? (await localIaRepositoryIdentity(input.repositoryPath));
  let commandRepositoryPath: string;
  try {
    commandRepositoryPath = await realpath(resolve(input.commandRepositoryPath));
    if ((await localIaRepositoryIdentity(commandRepositoryPath)) !== repositoryIdentity) {
      return undefined;
    }
  } catch {
    return undefined;
  }
  const index = await buildContentIndex({
    repositoryPath: input.repositoryPath,
    repositoryRevision: input.repositoryRevision,
  });
  const runIds = await privateAnalysisOutputRunIds(input.analysisOutputRoot);
  if (!runIds) return undefined;
  const validRunIds: string[] = [];
  for (const runId of runIds) {
    try {
      await loadAnalysisOutput(
        input.analysisOutputRoot,
        runId,
        index,
        input.task,
        repositoryIdentity,
        now,
      );
      validRunIds.push(runId);
    } catch {
      // Invalid, stale, expired, or unsafe siblings cannot become authority.
    }
  }
  if (validRunIds.length !== 1) return undefined;
  return `docsfab ia input provision planning --repo ${shellWord(commandRepositoryPath)} --revision ${input.repositoryRevision}${taskArguments(input.task)} --analysis-run ${shellWord(validRunIds[0]!)}`;
}

/** Approve one pending plan from a real planning run and seal bootstrap input. */
export async function approveIaPlanForBootstrap(input: {
  stateRoot: string;
  repositoryPath: string;
  repositoryRevision: string;
  task: Readonly<IaPlanTaskInput>;
  planningRunId: string;
  reviewerPolicyPath: string;
  reviewerId: string;
  privateKeyPath: string;
  repositoryIdentity?: string;
  commandRepositoryPath?: string;
  now?: Date;
}): Promise<IaApprovalHandoffReceipt> {
  const now = validNow(input.now ?? new Date());
  if (
    !SAFE_RUN_ID.test(input.planningRunId) ||
    input.task.scope !== "site" ||
    input.task.mode !== "create"
  )
    throw new IaLifecycleError("invalid-command");
  const repositoryIdentity =
    input.repositoryIdentity ?? (await localIaRepositoryIdentity(input.repositoryPath));
  const index = await buildContentIndex({
    repositoryPath: input.repositoryPath,
    repositoryRevision: input.repositoryRevision,
  });
  const planning = new LocalIaPlanningInputProvider({
    packageRoot: resolve(input.stateRoot, "ia-inputs", repositoryIdentity),
    repositoryRevision: input.repositoryRevision,
    repositoryIdentity,
    now: () => now,
  });
  const provided = await planning.provide({
    repositoryPath: input.repositoryPath,
    task: input.task,
  });
  if ("needsInput" in provided) throw new IaLifecycleError("missing-output");
  const run = await readPrivateJson(
    resolve(input.stateRoot, "runs", `${input.planningRunId}.json`),
  );
  const pendingDigest = pendingPlanDigest(run, input.planningRunId, input.repositoryRevision);
  const store = new (await import("../artifacts/store.js")).DurableArtifactStore(
    resolve(input.stateRoot, "artifacts"),
  );
  const pending = await store.get(pendingDigest, { index, planAcceptance: "any", now });
  if (pending.kind !== "ia-plan") throw new IaLifecycleError("invalid-output");
  const policy = await loadIaPlanReviewerPolicyFile(resolve(input.reviewerPolicyPath));
  const privateKey = createPrivateKey(
    Buffer.from(await readOwnerHostFile(resolve(input.privateKeyPath))),
  );
  const transition = reviewIaPlan({
    index,
    plan: pending,
    authorization: prepareIaPlanReviewerAuthorization({
      policy,
      reviewerId: input.reviewerId,
      privateKey,
      now: () => now,
    }),
    decision: "approved",
  });
  const topics = topicsFromPlan(transition.plan);
  const templateCatalogPolicy = requiredPolicy(transition.plan, TEMPLATE_CATALOG_POLICY.id);
  const repositoryCheckPolicy = requiredPolicy(
    transition.plan,
    standardSiteBootstrapCheckPolicy().id,
  );
  const application = createSiteBootstrapApplicationBundle(
    {
      schemaVersion: 1,
      kind: "site-bootstrap-application",
      repository: { ...index.repository, indexDigest: index.indexDigest },
      plan: transition.plan,
      review: transition.review,
      reviewerPolicy: { id: policy.id, version: policy.version, digest: policy.digest },
      evaluation: provided.evaluation as Extract<Artifact, { kind: "ia-evaluation" }>,
      evaluationInput: provided.evaluationInput,
      topics,
      templateCatalogPolicy,
      repositoryCheckPolicy,
    },
    { now, reviewerPolicy: policy },
  );
  const outputRoot = resolve(input.stateRoot, "ia-approvals", repositoryIdentity, pending.digest);
  await ensurePrivateDirectory(outputRoot);
  const applicationPath = resolve(outputRoot, "site-bootstrap-application.json");
  await writeCanonicalNoClobber(applicationPath, application);
  return {
    schemaVersion: 1,
    kind: "docsfab-ia-bootstrap-handoff",
    disposition: "approved",
    pendingPlanDigest: pending.digest,
    approvedPlanDigest: transition.plan.digest,
    reviewDigest: transition.review.digest,
    applicationDigest: application.digest,
    applicationPath,
    repositoryIdentity,
    repositoryRevision: input.repositoryRevision,
    expiresAt: transition.plan.payload.expiresAt,
    writesAuthorized: false,
    nextCommand: `docsfab run site-bootstrap --repo ${shellWord(input.commandRepositoryPath ?? input.repositoryPath)} --revision ${input.repositoryRevision} --plan ${shellWord(applicationPath)} --reviewer-policy ${shellWord(input.reviewerPolicyPath)} --allow-write`,
  };
}

function derivePlanningInput(
  output: IaAnalysisOutputPackage,
  index: ContentIndexV1,
  task: Readonly<IaPlanTaskInput>,
  policies: { templateId: string; templateCatalog: PolicyBinding; repositoryChecks: PolicyBinding },
): IaPlanningPackageInput {
  if (output.result.status !== "recommendation-ready" || !output.result.recommendation) {
    throw new IaLifecycleError("invalid-output");
  }
  const ontology = output.artifacts.ontology;
  const candidates = output.artifacts.candidates;
  const selected = candidates.payload.candidates.find(
    (candidate) => candidate.id === candidates.payload.recommendedCandidateId,
  );
  if (!selected || ontology.payload.entities.length === 0) {
    throw new IaLifecycleError("invalid-output");
  }
  const documents = selected.groups
    .flatMap((group) => group.members)
    .map((id) =>
      index.nodes.find((node): node is DocumentNode => node.id === id && node.kind === "document"),
    );
  if (documents.some((document) => !document)) throw new IaLifecycleError("invalid-output");
  const uniqueDocuments = [
    ...new Map(documents.map((document) => [document!.id, document!])).values(),
  ].sort((left, right) => compare(left.sourcePath, right.sourcePath));
  const evidenceFor = (document: DocumentNode): ArtifactEvidence[] => [
    { path: document.sourcePath, nodeId: document.id },
  ];
  const entityForGroup = (group: (typeof selected.groups)[number]) => {
    const memberIds = new Set(group.members);
    const entity = ontology.payload.entities.find((candidate) =>
      candidate.evidence.some((item) => memberIds.has(item.nodeId)),
    );
    if (!entity)
      throw new IaLifecycleError("invalid-output", `missing group ontology: ${group.id}`);
    return entity;
  };
  const entityForDocument = (document: DocumentNode) => {
    const group = selected.groups.find((candidate) => candidate.members.includes(document.id));
    if (!group) throw new IaLifecycleError("invalid-output");
    return entityForGroup(group);
  };
  const structure = {
    topicNodeIds: uniqueDocuments.map((document) => document.id),
    siblingSets: [...new Set(selected.groups.map((group) => group.axis))].map((axis) => ({
      id: `siblings:${canonicalDigest({ candidate: selected.id, axis }).slice(0, 16)}`,
      parentId: selected.id,
      groupIds: selected.groups.filter((group) => group.axis === axis).map((group) => group.id),
      declaredAxis: axis,
      evidence: selected.groups
        .filter((group) => group.axis === axis)
        .flatMap((group) => group.evidence),
    })),
    overviews: selected.groups.map((group) => ({
      groupId: group.id,
      nodeId: group.members[0]!,
      evidence: [...group.evidence],
    })),
    throughlines: selected.groups.map((group) => ({
      groupId: group.id,
      entityId: entityForGroup(group).id,
      evidence: uniqueEvidence([...group.evidence, ...entityForGroup(group).evidence]).filter(
        (item) => group.members.includes(item.nodeId),
      ),
    })),
    pageClassifications: uniqueDocuments.map((document) => ({
      nodeId: document.id,
      purpose: "single-purpose" as const,
      siblingKind: IA_ONTOLOGY_KIND_TO_SIBLING_KIND[entityForDocument(document).kind],
      evidence: evidenceFor(document),
    })),
    exceptions: [],
  };
  const placements = uniqueDocuments.map((document) => ({
    nodeId: document.id,
    proposedPath: document.sourcePath,
    evidence: evidenceFor(document),
  }));
  const navigationSuite = suiteFromNavigation(output.artifacts.navigationEvaluation, index);
  const rankings = rankingsFromNavigation(output.artifacts.navigationEvaluation, index);
  const evaluationInput: EvaluateIaCandidateInput = {
    index,
    ontology,
    candidates,
    semantics: uniqueDocuments.map((document) =>
      createArtifact(
        "context-packet",
        {
          targetNodeId: document.id,
          pageRole: {
            contentType: "how-to",
            readerJob: entityForDocument(document).id,
            organizingAxis: selected.primaryAxis,
          },
          ancestors: [],
          siblings: [],
          relatedCanonicalPages: [],
          placementRules: { belongsHere: [], belongsElsewhere: [] },
          activeDecisionIds: [],
          structuralPressure: "healthy",
          evidence: evidenceFor(document),
        },
        { index },
      ),
    ),
    candidateId: selected.id,
    structure,
    diagnosticPolicy: DEFAULT_IA_DIAGNOSTIC_POLICY,
    placements,
    navigationSuite,
    navigationRetrieval: {
      id: `${TPL_DESIGN_IA_SKILL}:navigation-retrieval`,
      version: "1",
      digest: canonicalDigest({ skill: TPL_DESIGN_IA_SKILL, version: "1" }),
    },
    currentRankings: rankings,
    proposedRankings: structuredClone(rankings),
  };
  const evaluated = evaluateIaCandidate(evaluationInput);
  if (!evaluated.artifact.payload.eligible) {
    throw new IaLifecycleError(
      "invalid-output",
      evaluated.scoring.eligibility.reasons.join(",") ||
        `diagnostics:${evaluated.diagnostics.diagnostics.map((item) => `${item.rule}:${item.severity}`).join(",")};navigation:${evaluated.navigation.deterministicPass}`,
    );
  }
  const plannedPages =
    task.mode === "create"
      ? plannedPagesFor(selected.groups, uniqueDocuments, policies.templateId, index)
      : [];
  const topics = plannedPages.map((page) => ({
    id: page.topicId,
    slug: page.slug,
    title: page.title,
    templateId: page.templateId,
    outputPath: page.outputPath,
    evidenceNodeIds: page.evidence.map((item) => item.nodeId),
  }));
  const policyBindings = uniquePolicies([
    ...evaluated.artifact.payload.policyBindings,
    { ...TEMPLATE_SELECTION_POLICY, digest: templateSelectionDigest(topics) },
    policies.templateCatalog,
    policies.repositoryChecks,
  ]);
  return {
    planId: `plan:${output.digest.slice(0, 24)}`,
    ontology,
    candidates,
    evaluation: evaluated.artifact,
    evaluationInput,
    navigationEvaluation: evaluated.navigationArtifact,
    useCases: structuredClone(output.result.useCases) as IaUseCase[],
    redirects: [],
    inboundLinkConsequences: [],
    policyBindings,
    requiredApproval: "maintainer",
    expiresAt: output.inputPackage.expiresAt,
    plannedPages,
    migrationDispositions:
      task.mode === "reevaluate"
        ? uniqueDocuments.map((document) => ({
            nodeId: document.id,
            disposition: "keep" as const,
            destinationPaths: [document.sourcePath],
            relatedNodeIds: [],
            evidence: evidenceFor(document),
          }))
        : [],
  };
}

function suiteFromNavigation(
  artifact: ArtifactEnvelope<"navigation-evaluation">,
  index: ContentIndexV1,
): VersionedNavigationSuite {
  const nodes = new Map(index.nodes.map((node) => [node.id, node]));
  const kindById = new Map(DEFAULT_IA_NAVIGATION_TASKS.map((task) => [task.id, task.id]));
  return {
    schemaVersion: 1,
    id: "docsfab:ia-operator-navigation",
    version: "1",
    cases: artifact.payload.tasks.map((task) => {
      const kind = kindById.get(task.id);
      if (!kind) throw new IaLifecycleError("invalid-output");
      const destination = (nodeId: string) => {
        const node = nodes.get(nodeId);
        if (!node) throw new IaLifecycleError("invalid-output");
        return {
          nodeId,
          url: documentationUrlForSourcePath(node.sourcePath),
          anchor: node.kind === "section" ? node.anchor : null,
        };
      };
      return {
        id: task.id,
        kind: kind as VersionedNavigationSuite["cases"][number]["kind"],
        query: task.query,
        expected: task.expectedNodeIds.map(destination),
        acceptableAlternatives: task.acceptableNodeIds.map(destination),
      };
    }),
  };
}

function rankingsFromNavigation(
  artifact: ArtifactEnvelope<"navigation-evaluation">,
  index: ContentIndexV1,
): NavigationRankings {
  const nodes = new Map(index.nodes.map((node) => [node.id, node]));
  return Object.fromEntries(
    artifact.payload.results.map((result) => [
      result.taskId,
      result.rankedNodeIds.map((nodeId, position) => {
        const node = nodes.get(nodeId);
        if (!node) throw new IaLifecycleError("invalid-output");
        return {
          nodeId,
          url: documentationUrlForSourcePath(node.sourcePath),
          anchor: node.kind === "section" ? node.anchor : null,
          score: result.rankedNodeIds.length - position,
        };
      }),
    ]),
  );
}

function plannedPagesFor(
  groups: ArtifactEnvelope<"ia-candidates">["payload"]["candidates"][number]["groups"],
  documents: DocumentNode[],
  templateId: string,
  index: ContentIndexV1,
): IaPlanningPackageInput["plannedPages"] {
  const occupied = new Set(index.nodes.map((node) => node.sourcePath));
  return groups.map((group) => {
    const evidence =
      group.evidence.length > 0
        ? group.evidence
        : [
            {
              nodeId: documents[0]!.id,
              path: documents[0]!.sourcePath,
            },
          ];
    const canonicalDirectory = group.canonicalPath
      .replace(/^docs\//u, "")
      .replace(/\.(?:md|mdx)$/u, "")
      .replace(/\/index$/u, "");
    const base = canonicalDirectory ? `${canonicalDirectory}/overview` : "overview";
    let slug = base;
    let suffix = 2;
    while (occupied.has(`docs/${slug}.md`) || occupied.has(`${slug}.md`)) {
      slug = `${base}-${suffix}`;
      suffix += 1;
    }
    const outputPath = slug.startsWith("docs/") ? `${slug}.md` : `docs/${slug}.md`;
    occupied.add(outputPath);
    return {
      topicId: `topic:${canonicalDigest({ group: group.id, outputPath }).slice(0, 20)}`,
      title: group.label,
      slug: slug.startsWith("docs/") ? slug.slice(5) : slug,
      templateId,
      format: "gfm" as const,
      outputPath,
      evidence: structuredClone(evidence),
    };
  });
}

async function loadAnalysisOutput(
  root: string,
  runId: string,
  index: ContentIndexV1,
  task: Readonly<IaPlanTaskInput>,
  repositoryIdentity: string,
  now: Date,
): Promise<IaAnalysisOutputPackage> {
  if (!SAFE_RUN_ID.test(runId)) throw new IaLifecycleError("invalid-command");
  const value = await readPrivateJson(resolve(root, `${runId}.json`));
  return validateIaAnalysisOutputPackage(value, { runId, index, task, repositoryIdentity, now });
}

/**
 * Reuse the canonical lifecycle checks for an exact host-selected package. A
 * hosted package arrives as bytes from another job, so shape checks a local
 * reader could take for granted run explicitly before any comparison.
 */
export function validateIaAnalysisOutputPackage(
  value: unknown,
  options: {
    runId: string;
    index: ContentIndexV1;
    task: Readonly<IaPlanTaskInput>;
    repositoryIdentity: string;
    now: Date;
  },
): IaAnalysisOutputPackage {
  const { runId, index, task, repositoryIdentity, now } = options;
  if (!SAFE_RUN_ID.test(runId)) throw new IaLifecycleError("invalid-command");
  validNow(now);
  if (!plain(value)) throw new IaLifecycleError("invalid-output");
  const output = value as unknown as IaAnalysisOutputPackage;
  if (
    !plain(output.repository) ||
    !plain(output.inputPackage) ||
    !plain(output.artifacts) ||
    !SHA256.test(output.inputPackage.digest) ||
    typeof output.inputPackage.expiresAt !== "string" ||
    !Number.isFinite(Date.parse(output.inputPackage.expiresAt)) ||
    new Date(output.inputPackage.expiresAt).toISOString() !== output.inputPackage.expiresAt
  )
    throw new IaLifecycleError("invalid-output");
  const { digest, ...unsigned } = output;
  if (
    output.schemaVersion !== 1 ||
    output.kind !== "docsfab-ia-analysis-output" ||
    output.runId !== runId ||
    output.taskKey !== planningTaskKey(task) ||
    output.repositoryIdentity !== repositoryIdentity ||
    !SHA256.test(digest) ||
    canonicalDigest(unsigned) !== digest
  )
    throw new IaLifecycleError("stale-output");
  if (output.repository.revision !== index.repository.revision) {
    throw new IaPlanningInputProviderError("wrong-revision", "$.repository.revision");
  }
  if (
    output.repository.contentDigest !== index.repository.contentDigest ||
    output.repository.indexDigest !== index.indexDigest
  )
    throw new IaLifecycleError("stale-output");
  if (Date.parse(output.inputPackage.expiresAt) <= now.valueOf()) {
    throw new IaPlanningInputProviderError("expired", "$.inputPackage.expiresAt");
  }
  if (output.inputPackage.navigationTasksDigest !== canonicalDigest(DEFAULT_IA_NAVIGATION_TASKS)) {
    throw new IaLifecycleError("stale-output");
  }
  const artifacts = exactAnalysisArtifacts(Object.values(output.artifacts));
  validateTplDesignIaResult(output.result, {
    index,
    artifacts: {
      ontology: artifacts.ontology,
      iaCandidates: artifacts.candidates,
      navigationEvaluation: artifacts.navigationEvaluation,
    },
  });
  return output;
}

function exactAnalysisArtifacts(artifacts: Artifact[]): IaAnalysisOutputPackage["artifacts"] {
  const ontology = artifacts.filter(
    (item): item is ArtifactEnvelope<"ontology"> => item.kind === "ontology",
  );
  const candidates = artifacts.filter(
    (item): item is ArtifactEnvelope<"ia-candidates"> => item.kind === "ia-candidates",
  );
  const navigation = artifacts.filter(
    (item): item is ArtifactEnvelope<"navigation-evaluation"> =>
      item.kind === "navigation-evaluation",
  );
  if (
    artifacts.length !== 3 ||
    ontology.length !== 1 ||
    candidates.length !== 1 ||
    navigation.length !== 1
  )
    throw new IaLifecycleError("invalid-output");
  return {
    ontology: ontology[0]!,
    candidates: candidates[0]!,
    navigationEvaluation: navigation[0]!,
  };
}

function topicsFromPlan(plan: IaPlanArtifact): TemplatePreviewTopic[] {
  if (!plan.payload.plannedPages?.length) throw new IaLifecycleError("invalid-output");
  return plan.payload.plannedPages.map((page) => ({
    id: page.topicId,
    slug: page.slug,
    title: page.title,
    templateId: page.templateId,
    outputPath: page.outputPath,
    evidenceNodeIds: page.evidence.map((item) => item.nodeId),
  }));
}

function requiredPolicy(plan: IaPlanArtifact, id: string): PolicyBinding {
  const found = plan.payload.policyBindings.find((item) => item.id === id);
  if (!found) throw new IaLifecycleError("invalid-output");
  return found;
}

function pendingPlanDigest(value: unknown, runId: string, revision: string): string {
  if (
    !plain(value) ||
    value.id !== runId ||
    value.workflow !== "ia-plan" ||
    !plain(value.repository) ||
    value.repository.revision !== revision ||
    !Array.isArray(value.artifacts)
  ) {
    throw new IaLifecycleError("invalid-output");
  }
  const plans = value.artifacts.filter(
    (entry): entry is Record<string, unknown> =>
      plain(entry) &&
      plain(entry.reference) &&
      entry.role === "output" &&
      entry.reference.kind === "ia-plan" &&
      SHA256.test(String(entry.reference.digest)),
  );
  if (plans.length !== 1) throw new IaLifecycleError("needs-approval");
  return (plans[0]!.reference as Record<string, unknown>).digest as string;
}

function inputDisposition(error: unknown): Exclude<IaInputDisposition, "ready" | "needs-approval"> {
  if (!(error instanceof IaPlanningInputProviderError)) return "invalid-package";
  if (error.code === "missing-package") return "missing-package";
  if (error.code === "stale-package") return "stale-package";
  if (error.code === "wrong-repository") return "wrong-repository";
  if (error.code === "wrong-revision") return "wrong-revision";
  if (error.code === "expired") return "expired";
  return "invalid-package";
}

function provisionCommand(
  repositoryPath: string,
  revision: string,
  task: Readonly<IaPlanTaskInput>,
  expiresAt?: string,
  now = new Date(),
): string {
  const expiry = expiresAt ?? new Date(now.valueOf() + 24 * 60 * 60 * 1_000).toISOString();
  return `docsfab ia input provision analysis --repo ${shellWord(repositoryPath)} --revision ${revision}${taskArguments(task)} --expires-at ${expiry}`;
}

function runCommand(
  kind: IaInputPackageKind,
  repositoryPath: string,
  revision: string,
  task: Readonly<IaPlanTaskInput>,
  digest: string,
): string {
  const workflow = kind === "analysis-input" ? "ia-analysis" : "ia-plan";
  return `docsfab run ${workflow} --repo ${shellWord(repositoryPath)} --revision ${revision}${taskArguments(task)} --input-digest ${digest}`;
}

function taskArguments(task: Readonly<IaPlanTaskInput>): string {
  if (task.scope === "site") return ` --scope site --mode ${task.mode}`;
  const fragment = task.target?.anchor ? `#${task.target.anchor}` : "";
  return ` --scope ${task.scope} --target ${shellWord(`${task.target!.sourcePath}${fragment}`)}`;
}

function uniquePolicies(values: PolicyBinding[]): PolicyBinding[] {
  const byId = new Map<string, PolicyBinding>();
  for (const value of values) {
    const existing = byId.get(value.id);
    if (existing && (existing.version !== value.version || existing.digest !== value.digest)) {
      throw new IaLifecycleError("invalid-output");
    }
    byId.set(value.id, value);
  }
  return [...byId.values()].sort((left, right) => compare(left.id, right.id));
}

function uniqueEvidence(values: ArtifactEvidence[]): ArtifactEvidence[] {
  return [...new Map(values.map((item) => [`${item.nodeId}\0${item.path}`, item])).values()].sort(
    (left, right) => compare(`${left.nodeId}\0${left.path}`, `${right.nodeId}\0${right.path}`),
  );
}

async function writeCanonicalNoClobber(path: string, value: unknown): Promise<boolean> {
  const bytes = Buffer.from(canonicalJson(value), "utf8");
  if (bytes.byteLength > MAX_OUTPUT_BYTES) throw new IaLifecycleError("invalid-output");
  await ensurePrivateDirectory(dirname(path));
  let handle: FileHandle | undefined;
  try {
    handle = await open(
      path,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        (typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0),
      PRIVATE_FILE_MODE,
    );
    await handle.writeFile(bytes);
    await handle.sync();
    return true;
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error;
    const existing = await readPrivateBytes(path);
    if (existing.equals(bytes)) return false;
    throw new IaLifecycleError("already-exists");
  } finally {
    await handle?.close();
  }
}

async function readPrivateJson(path: string): Promise<unknown> {
  const bytes = await readPrivateBytes(path);
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new IaLifecycleError("invalid-output");
  }
}

async function readPrivateBytes(path: string): Promise<Buffer> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(
      path,
      constants.O_RDONLY | (typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0),
    );
    const before = await handle.stat();
    assertPrivateFile(before);
    if (before.size < 1 || before.size > MAX_OUTPUT_BYTES)
      throw new IaLifecycleError("invalid-output");
    const bytes = await handle.readFile();
    const after = await handle.stat();
    const pathAfter = await lstat(path);
    assertPrivateFile(after);
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      bytes.byteLength !== after.size ||
      pathAfter.isSymbolicLink() ||
      pathAfter.dev !== after.dev ||
      pathAfter.ino !== after.ino
    ) {
      throw new IaLifecycleError("unsafe-state");
    }
    return bytes;
  } catch (error) {
    if (error instanceof IaLifecycleError) throw error;
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      throw new IaLifecycleError("missing-output");
    }
    throw new IaLifecycleError("unsafe-state");
  } finally {
    await handle?.close();
  }
}

async function privateAnalysisOutputRunIds(root: string): Promise<string[] | undefined> {
  const resolved = resolve(root);
  try {
    const before = await lstat(resolved);
    if (
      before.isSymbolicLink() ||
      !before.isDirectory() ||
      (before.mode & 0o777) !== PRIVATE_DIRECTORY_MODE ||
      (process.getuid?.() !== undefined && before.uid !== process.getuid?.()) ||
      (await realpath(resolved)) !== resolved
    )
      return undefined;
    const entries = await readdir(resolved, { withFileTypes: true });
    const after = await lstat(resolved);
    if (
      after.isSymbolicLink() ||
      !after.isDirectory() ||
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      (after.mode & 0o777) !== PRIVATE_DIRECTORY_MODE ||
      (process.getuid?.() !== undefined && after.uid !== process.getuid?.()) ||
      (await realpath(resolved)) !== resolved
    )
      return undefined;
    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => entry.name.slice(0, -".json".length))
      .filter((runId) => SAFE_RUN_ID.test(runId))
      .sort(compare);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    return undefined;
  }
}

async function ensurePrivateDirectory(path: string): Promise<void> {
  const resolved = resolve(path);
  let existing = resolved;
  const missing: string[] = [];
  while (true) {
    try {
      const physical = await realpath(existing);
      existing = physical;
      break;
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") {
        throw new IaLifecycleError("unsafe-state");
      }
      const parent = dirname(existing);
      if (parent === existing) throw new IaLifecycleError("unsafe-state");
      missing.unshift(basename(existing));
      existing = parent;
    }
  }
  let cursor = existing;
  for (const part of missing) {
    cursor = resolve(cursor, part);
    await mkdir(cursor, { mode: PRIVATE_DIRECTORY_MODE }).catch((error: unknown) => {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error;
    });
    const stat = await lstat(cursor);
    if (
      stat.isSymbolicLink() ||
      !stat.isDirectory() ||
      (stat.mode & 0o777) !== PRIVATE_DIRECTORY_MODE ||
      (process.getuid?.() !== undefined && stat.uid !== process.getuid?.())
    ) {
      throw new IaLifecycleError("unsafe-state");
    }
  }
  const finalPath = await realpath(resolved).catch(() => {
    throw new IaLifecycleError("unsafe-state");
  });
  const finalStat = await lstat(resolved).catch(() => {
    throw new IaLifecycleError("unsafe-state");
  });
  if (
    finalPath !== resolved ||
    finalStat.isSymbolicLink() ||
    !finalStat.isDirectory() ||
    (finalStat.mode & 0o777) !== PRIVATE_DIRECTORY_MODE ||
    (process.getuid?.() !== undefined && finalStat.uid !== process.getuid?.())
  ) {
    throw new IaLifecycleError("unsafe-state");
  }
}

function assertPrivateFile(stat: Stats): void {
  if (
    !stat.isFile() ||
    (stat.mode & 0o777) !== PRIVATE_FILE_MODE ||
    (process.getuid?.() !== undefined && stat.uid !== process.getuid?.())
  ) {
    throw new IaLifecycleError("unsafe-state");
  }
}

function validNow(value: Date): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.valueOf())) {
    throw new IaLifecycleError("invalid-command");
  }
  return value;
}

function plain(value: unknown): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function shellWord(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}
