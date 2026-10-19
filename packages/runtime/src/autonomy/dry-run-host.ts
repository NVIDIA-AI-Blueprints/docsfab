// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import type { WorkflowName, WorkflowTaskInput } from "../workflow-contracts/contracts.js";
import { canonicalDigest } from "../content-ir/canonical.js";
import { deepFreeze } from "../contract-kit/freeze.js";
import { buildContentIndexV2 } from "../content-ir/indexer.js";
import type { RepositoryIdentity } from "../content-ir/contracts.js";
import {
  assertDocsFabProjectConfig,
  DOCSFAB_PROJECT_CONFIG_FILE,
  type DocsFabProjectConfigV1,
} from "../init.js";
import {
  inspectProjectConfigCheckout,
  PROJECT_CONFIG_UNTRACKED_CODE,
} from "../project-config-preflight.js";
import {
  assessDocumentationMaturityCascade,
  observeDocumentationMaturityCascadeTrackerFromHostSnapshot,
  selectDocumentationMaturityWorkUnit,
  type DocumentationMaturityCascadeAssessmentV1,
  type DocumentationMaturityCascadeSelectionV1,
  type DocumentationMaturityCascadeTrackerObservationV1,
} from "../maturity/cascade.js";
import type { DocumentationMaturityFindingV1 } from "../maturity/contracts.js";
import { mapRepositoryInventoryToG0 } from "../maturity/evaluators.js";
import { buildRepositoryDiscoveryInventory } from "../repository/inventory.js";
import { prepareRepositoryWorkspace } from "../repository/workspace/materialize.js";
import type { RepositoryWorkspace } from "../repository/workspace/contracts.js";
import * as workflowCatalog from "../workflow-registry/catalog.js";
import { bindableCycleWorkflow, getWorkflow } from "../workflow-registry/catalog.js";
import {
  GitLabRoadmapReader,
  createManagedIssueStateLookupV1,
  managedIssueTrackerObservationStateV1,
  type ManagedIssueTrackerObservationV1,
  type ManagedIssueStateLookupV1,
  type RoadmapProjectIdentity,
} from "../roadmap/index.js";
import {
  createAutoAssessment,
  createAutoCycleRequest,
  createAutoWorkflowTaskBinding,
  createWorkflowDecision,
  type AutoAssessmentV1,
  type AutoCycleRequestV1,
  type AutoMaturityFindingReferenceV1,
  type AutoWorkflowPrerequisiteV1,
  type WorkflowCandidateInputV1,
  type WorkflowDecisionV1,
} from "./contracts.js";
import type { AutoDryRunCliArguments, AutoDryRunHostAssessmentV1 } from "./dry-run-cli.js";
import type { AutoDryRunSourceV1 } from "./dry-run.js";
import type { AutoDryRunNeedsInputV1 } from "./dry-run.js";
import { runAutoRoadmapDryRunV1 } from "./roadmap-entry.js";
import type { AutoDryRunRoadmapPlanner } from "./dry-run.js";
import { isDnsHostname } from "../shared/dns-hostname.js";
import { outboundFetch } from "../model/outbound-http-policy.js";

interface AutoDryRunHostState {
  workspace: RepositoryWorkspace;
  repository: RepositoryIdentity;
  project: RoadmapProjectIdentity;
  managedTrackerObservation: ManagedIssueTrackerObservationV1;
}

const hostStates = new WeakMap<object, AutoDryRunHostState>();
const execute = promisify(execFile);
const PRODUCTION_OPERATION_CAP = 10;

export interface AutoDryRunHostReadDependencies {
  trustedGitLabHost(): string | null;
  tokenForHost(host: string): Promise<string>;
  fetch: typeof globalThis.fetch;
  managedStateLookup(project: RoadmapProjectIdentity): {
    authority: "restored-receipt-evidence" | "unavailable";
    lookup: ManagedIssueStateLookupV1;
  };
}

const productionHostReads: AutoDryRunHostReadDependencies = Object.freeze({
  trustedGitLabHost: () => trustedGitLabHost(process.env.DOCSFAB_ROADMAP_GITLAB_HOST),
  tokenForHost: gitLabToken,
  fetch: outboundFetch(),
  managedStateLookup: () => ({
    authority: "unavailable" as const,
    lookup: createManagedIssueStateLookupV1([]),
  }),
});

/**
 * Read-only production assessment boundary. It exports one immutable revision
 * into a disposable workspace, inventories it, runs the maturity cascade, and
 * observes GitLab through the cascade's GET-only host edge.
 */
export async function assessAutoDryRunHost(
  arguments_: AutoDryRunCliArguments,
): Promise<AutoDryRunHostAssessmentV1> {
  return assessAutoDryRunHostWithDependencies(arguments_, productionHostReads);
}

/** @internal Read-only host seam used for authentic provider integration tests. */
export async function assessAutoDryRunHostWithDependencies(
  arguments_: AutoDryRunCliArguments,
  reads: AutoDryRunHostReadDependencies,
): Promise<AutoDryRunHostAssessmentV1> {
  const workspace = await prepareRepositoryWorkspace(
    arguments_.repositoryPath,
    arguments_.revision,
  );
  let retained = false;
  try {
    const inventory = await buildRepositoryDiscoveryInventory({ workspace });
    const repository = {
      sourcePath: workspace.sourcePath,
      requestedRevision: workspace.requestedRevision,
      revision: workspace.revision,
    };
    const target = await resolveDefaultTarget(workspace.path, arguments_.targetBranch);
    const baseNeedsInput = {
      repositoryPath: workspace.sourcePath,
      repository: {
        identitySha256: createHash("sha256").update(workspace.sourcePath).digest("hex"),
        revision: workspace.revision,
      },
      inventory,
      targetBranch: target?.defaultBranch ?? null,
      draftMergeRequestDestination: null,
    };
    if (!target) {
      retained = true;
      return disposableNeedsInput(workspace, {
        ...baseNeedsInput,
        reasonCode: await projectConfigUnavailableReason(workspace.sourcePath),
        openInputIds: ["gitlab-default-target"],
      });
    }

    let maturityAssessment: DocumentationMaturityCascadeAssessmentV1;
    try {
      const mapping = mapRepositoryInventoryToG0({ inventory, repository });
      const gateInputs = (["G0", "G1", "G2", "G3", "G4", "G5"] as const).map((gateId) => ({
        gateId,
        repository,
        policyWorkspace: gateId === "G0" ? null : workspace,
        mappings: gateId === "G0" ? [mapping] : [],
      }));
      maturityAssessment = await assessDocumentationMaturityCascade({ gateInputs });
    } catch {
      retained = true;
      return disposableNeedsInput(workspace, {
        ...baseNeedsInput,
        targetBranch: target.defaultBranch,
        reasonCode: "documentation-product-policy-required",
        openInputIds: ["documentation-product-policy"],
      });
    }

    let tracker: DocumentationMaturityCascadeTrackerObservationV1;
    let maturitySelection: DocumentationMaturityCascadeSelectionV1;
    let project: RoadmapProjectIdentity;
    let managedTrackerObservation: ManagedIssueTrackerObservationV1;
    let repositoryIdentity: RepositoryIdentity;
    try {
      const resolved = await resolveGitLabProject(
        workspace.sourcePath,
        target.remote,
        target.configuredDefaultBranch,
        target.defaultBranch,
        workspace.revision,
        reads,
      );
      project = resolved.project;
      const managedState = reads.managedStateLookup(project);
      const snapshot = await new GitLabRoadmapReader({
        project,
        token: resolved.token,
        fetch: reads.fetch,
      }).observeAutoSnapshot(project, managedState.lookup);
      tracker = await observeDocumentationMaturityCascadeTrackerFromHostSnapshot({
        assessment: maturityAssessment,
        workspace,
        source: snapshot.maturitySource,
      });
      managedTrackerObservation = snapshot.managed;
      if (
        canonicalDigest(project) !== tracker.projectSha256 ||
        managedTrackerObservation.observedAt !== tracker.observedAt ||
        managedTrackerObservation.issues.length !== tracker.issues.length ||
        managedTrackerObservation.issues.some(
          (issue, index) =>
            issue.iid !== tracker.issues[index]?.iid ||
            issue.identityDigest !== tracker.issues[index]?.identityDigest,
        )
      ) {
        throw new Error("GitLab tracker projections do not share one exact snapshot.");
      }
      const reconciliationState = managedIssueTrackerObservationStateV1(managedTrackerObservation);
      const missingRestoredState = managedTrackerObservation.issues.some(
        (issue) =>
          issue.marker !== null &&
          !reconciliationState.reconcilerIssues.some(
            (candidate) => candidate.iid === issue.iid && candidate.stateBinding !== undefined,
          ),
      );
      if (
        missingRestoredState ||
        (managedState.authority !== "restored-receipt-evidence" &&
          managedTrackerObservation.issues.some((issue) => issue.marker !== null))
      ) {
        retained = true;
        return disposableNeedsInput(workspace, {
          ...baseNeedsInput,
          targetBranch: target.defaultBranch,
          reasonCode: "managed-state-receipts-required",
          openInputIds: ["gitlab-managed-state-receipts"],
        });
      }
      maturitySelection = await selectDocumentationMaturityWorkUnit({
        assessment: maturityAssessment,
        trackerObservation: tracker,
        policyWorkspace: workspace,
      });
      repositoryIdentity = (await buildContentIndexV2({ workspace })).repository;
    } catch {
      retained = true;
      return disposableNeedsInput(workspace, {
        ...baseNeedsInput,
        targetBranch: target.defaultBranch,
        reasonCode: "managed-tracker-observation-required",
        openInputIds: ["gitlab-managed-tracker-read-access"],
      });
    }

    const cycle = buildCycleArtifacts({
      maturityAssessment,
      maturitySelection,
      tracker,
      targetBranch: target.defaultBranch,
    });
    const source: AutoDryRunSourceV1 = deepFreeze({
      repositoryPath: workspace.sourcePath,
      targetBranch: target.defaultBranch,
      draftMergeRequestDestination: {
        provider: "gitlab" as const,
        projectIdentitySha256: tracker.projectSha256,
        targetBranch: target.defaultBranch,
      },
      inventory,
      request: cycle.request,
      assessment: cycle.assessment,
      decision: cycle.decision,
      maturityAssessment,
      maturityTrackerObservation: tracker,
      maturitySelection,
      managedTrackerObservationSha256: managedTrackerObservation.digest,
      repositoryContentDigest: repositoryIdentity.contentDigest,
    });
    hostStates.set(source, {
      workspace,
      repository: repositoryIdentity,
      project,
      managedTrackerObservation,
    });
    retained = true;
    return {
      status: "ready",
      source,
      dispose: async () => {
        hostStates.delete(source);
        await workspace.dispose();
      },
    };
  } finally {
    if (!retained) {
      await workspace.dispose().catch(() => undefined);
    }
  }
}

/** Read-only production planner; accepts no apply adapter or authority. */
export const productionAutoDryRunRoadmapPlanner: AutoDryRunRoadmapPlanner = Object.freeze({
  async plan(source: AutoDryRunSourceV1) {
    const state = hostStates.get(source as object);
    if (!state) throw new Error("Auto dry-run host context is no longer active.");
    return runAutoRoadmapDryRunV1({
      mode: "dry-run",
      planningInput: {
        request: source.request,
        assessment: source.assessment,
        decision: source.decision,
        maturityAssessment: source.maturityAssessment,
        maturityTrackerObservation: source.maturityTrackerObservation,
        maturitySelection: source.maturitySelection,
        policyWorkspace: state.workspace,
        repository: state.repository,
        project: state.project,
        managedTrackerObservation: state.managedTrackerObservation,
        operationCap: PRODUCTION_OPERATION_CAP,
      },
    });
  },
});

/** Used only by the production planner adapter. */
export function autoDryRunHostWorkspace(source: AutoDryRunSourceV1): RepositoryWorkspace {
  const state = hostStates.get(source as object);
  if (!state) throw new Error("Auto dry-run host workspace is no longer active.");
  return state.workspace;
}

function buildCycleArtifacts(input: {
  maturityAssessment: DocumentationMaturityCascadeAssessmentV1;
  maturitySelection: DocumentationMaturityCascadeSelectionV1;
  tracker: DocumentationMaturityCascadeTrackerObservationV1;
  targetBranch: string;
}): { request: AutoCycleRequestV1; assessment: AutoAssessmentV1; decision: WorkflowDecisionV1 } {
  const references = input.maturityAssessment.gates
    .flatMap((gate) => gate.findings)
    .map(maturityReference)
    .sort((left, right) => left.fingerprint.localeCompare(right.fingerprint));
  const selected =
    input.maturitySelection.outcome.state === "selected"
      ? input.maturitySelection.outcome.workUnit
      : null;
  const cycleName = selected
    ? bindableCycleWorkflow(selected.workflow.name)
    : "review-documentation";
  const missingStructuredTask = selected !== null && requiresStructuredTask(cycleName);
  const selectedRunnable = selected !== null && !missingStructuredTask ? selected : null;
  const workflow = selectedRunnable ? cycleName : "review-documentation";
  const definition = getWorkflow(workflow);
  const writes = definition.steps.some((step) => step.mode === "write");
  const task: WorkflowTaskInput | null = null;
  const taskBinding = createAutoWorkflowTaskBinding(
    workflow,
    task,
    input.maturityAssessment.repository,
    workflowCatalog,
  );
  const validationIds = selectedRunnable
    ? selectedRunnable.verification.map((item) => item.id).sort(compare)
    : ["auto-dry-run"];
  const prerequisiteIds = selectedRunnable
    ? prerequisitesFor(selectedRunnable)
        .map((item) => item.id)
        .sort(compare)
    : [];
  const pathPrefixes =
    writes && selectedRunnable ? [...selectedRunnable.affectedPaths].sort(compare) : ["."];
  const request = createAutoCycleRequest(
    {
      cycleId: `cycle:${canonicalDigest({
        repository: input.maturityAssessment.repository,
        maturityAssessmentSha256: input.maturityAssessment.assessmentSha256,
        trackerObservationSha256: input.tracker.observationSha256,
      }).slice(0, 32)}`,
      repository: input.maturityAssessment.repository,
      tracker: {
        projectIdentitySha256: input.tracker.projectSha256,
        observationSha256: input.tracker.observationSha256,
        observedAt: input.tracker.observedAt,
        authority: "observe-only",
      },
      maturityFindingSha256s: references.map((item) => item.findingSha256),
      bounds: {
        workflowNames: [workflow],
        pathClass: writes ? "documentation-write" : "repository-read-only",
        pathPrefixes,
        targetBranch: input.targetBranch,
        deliveryMode: writes ? "local-patch" : "none",
        requiredValidationIds: validationIds,
        workflowPrerequisites: [{ workflow, prerequisiteIds }],
        workflowTasks: [taskBinding],
      },
    },
    workflowCatalog,
  );

  const prerequisites = selectedRunnable ? prerequisitesFor(selectedRunnable) : [];
  const canExecute =
    selectedRunnable !== null &&
    prerequisites.every((item) => item.state === "satisfied") &&
    selectedRunnable.confidence !== "inconclusive" &&
    (selectedRunnable.disposition === "observed-absence" ||
      selectedRunnable.disposition === "bounded-not-found");
  const openInputIds = missingStructuredTask
    ? [`workflow-task:${selected!.workflow.name}`]
    : input.maturitySelection.outcome.state === "needs-input"
      ? [...input.maturitySelection.outcome.missingInputIds].sort(compare)
      : input.maturitySelection.outcome.state === "investigation"
        ? ["maturity-investigation"]
        : prerequisites
            .filter((item) => item.state !== "satisfied")
            .map((item) => item.id)
            .sort(compare);
  const candidate: WorkflowCandidateInputV1 | null = selectedRunnable
    ? {
        id: `candidate:${selectedRunnable.workUnitFingerprint.slice(0, 32)}`,
        taskSha256: taskBinding.taskSha256,
        workflow,
        stepIds: definition.steps.map((step) => step.id),
        prerequisites,
        maturityFindingFingerprints: [selectedRunnable.findingFingerprint],
        pathClass: writes ? "documentation-write" : "repository-read-only",
        pathPrefixes,
        deliveryMode: writes ? "local-patch" : "none",
        validationIds,
      }
    : null;
  const hasBlocked =
    references.some((item) => item.disposition === "blocked") ||
    prerequisites.some((item) => item.state === "blocked");
  const evidenceState = hasBlocked
    ? ("blocked" as const)
    : canExecute || input.maturitySelection.outcome.state === "no-action"
      ? ("sufficient" as const)
      : ("low-confidence" as const);
  const assessment = createAutoAssessment(
    {
      requestSha256: request.requestSha256,
      repository: request.repository,
      trackerObservationSha256: request.tracker.observationSha256,
      evidenceState,
      maturityFindings: references,
      candidates: candidate ? [candidate] : [],
      openInputIds,
    },
    request,
    workflowCatalog,
  );
  const selectedCandidate = candidate ? assessment.candidates[0] : undefined;
  const decision =
    canExecute && selectedCandidate
      ? createWorkflowDecision(
          {
            disposition: "execute",
            candidateSha256: selectedCandidate.candidateSha256,
            reasonCode: "eligible-candidate-selected",
          },
          request,
          assessment,
          workflowCatalog,
        )
      : input.maturitySelection.outcome.state === "no-action" && !hasBlocked
        ? createWorkflowDecision(
            { disposition: "no-action", reasonCode: "maturity-satisfied" },
            request,
            assessment,
            workflowCatalog,
          )
        : hasBlocked
          ? createWorkflowDecision(
              { disposition: "blocked", reasonCode: "evidence-blocked" },
              request,
              assessment,
              workflowCatalog,
            )
          : createWorkflowDecision(
              {
                disposition: "needs-input",
                reasonCode: missingStructuredTask
                  ? "workflow-task-input-required"
                  : "maturity-input-required",
                openInputIds,
              },
              request,
              assessment,
              workflowCatalog,
            );
  return { request, assessment, decision };
}

function prerequisitesFor(
  unit: NonNullable<DocumentationMaturityCascadeSelectionV1["outcome"]["workUnit"]>,
): AutoWorkflowPrerequisiteV1[] {
  const prerequisites: AutoWorkflowPrerequisiteV1[] = [
    {
      id: "maturity-selection-current",
      state: "satisfied",
      evidenceSha256s: [unit.workUnitSha256],
    },
  ];
  for (const item of unit.requiredWorkflowInputs)
    prerequisites.push({
      id: `workflow-input:${item.id}`,
      state: item.status === "available" ? "satisfied" : "missing",
      evidenceSha256s: item.status === "available" ? [item.sha256] : [],
    });
  for (const item of unit.requiredHumanInput)
    prerequisites.push({
      id: `human-input:${item.id}`,
      state: item.status === "provided" ? "satisfied" : "missing",
      evidenceSha256s: item.status === "provided" ? [item.valueSha256] : [],
    });
  return prerequisites.sort((left, right) => left.id.localeCompare(right.id));
}

function maturityReference(
  finding: DocumentationMaturityFindingV1,
): AutoMaturityFindingReferenceV1 {
  return {
    fingerprint: finding.fingerprint,
    findingSha256: finding.findingSha256,
    confidence: finding.confidence,
    disposition: finding.disposition,
  };
}

function requiresStructuredTask(workflow: WorkflowName): boolean {
  return (
    workflow === "update-documentation" ||
    workflow === "ia-analysis" ||
    workflow === "ia-plan" ||
    workflow === "site-bootstrap"
  );
}

async function projectConfigUnavailableReason(sourcePath: string): Promise<string> {
  const inspection = await inspectProjectConfigCheckout(sourcePath).catch(() => null);
  if (inspection?.codes.includes(PROJECT_CONFIG_UNTRACKED_CODE)) {
    return PROJECT_CONFIG_UNTRACKED_CODE;
  }
  return "default-target-unavailable";
}

async function resolveDefaultTarget(
  repositoryPath: string,
  requested: string | undefined,
): Promise<{ remote: string; configuredDefaultBranch: string; defaultBranch: string } | null> {
  const config = await readProjectConfig(repositoryPath);
  return config
    ? {
        remote: config.gitlab.remote,
        configuredDefaultBranch: config.gitlab.defaultBranch,
        defaultBranch: requested ?? config.gitlab.defaultBranch,
      }
    : null;
}

async function resolveGitLabProject(
  repositoryPath: string,
  remote: string,
  configuredDefaultBranch: string,
  targetBranch: string,
  revision: string,
  reads: AutoDryRunHostReadDependencies,
): Promise<{ project: RoadmapProjectIdentity; token: string }> {
  const urls = await Promise.all([
    git(repositoryPath, ["remote", "get-url", "--all", remote]),
    git(repositoryPath, ["remote", "get-url", "--push", "--all", remote]),
  ]);
  const fetchUrls = urls[0].split(/\r?\n/u).filter(Boolean);
  const pushUrls = urls[1].split(/\r?\n/u).filter(Boolean);
  if (fetchUrls.length !== 1 || pushUrls.length !== 1) {
    throw new Error("Configured GitLab remote is ambiguous.");
  }
  const fetchRemote = parseGitLabRemote(fetchUrls[0]!);
  const pushRemote = parseGitLabRemote(pushUrls[0]!);
  if (fetchRemote.host !== pushRemote.host || fetchRemote.fullPath !== pushRemote.fullPath) {
    throw new Error("Configured GitLab fetch and push destinations differ.");
  }
  if (reads.trustedGitLabHost() !== fetchRemote.host) {
    throw new Error("Configured GitLab remote is not a host-trusted credential destination.");
  }
  const token = await reads.tokenForHost(fetchRemote.host);
  const url = new URL(
    `/api/v4/projects/${encodeURIComponent(fetchRemote.fullPath)}`,
    `https://${fetchRemote.host}`,
  );
  const response = await reads.fetch(url, {
    method: "GET",
    redirect: "error",
    headers: { "PRIVATE-TOKEN": token },
  });
  if (!response.ok) throw new Error(`GitLab project observation failed (${response.status}).`);
  const raw: unknown = await response.json();
  if (
    !raw ||
    typeof raw !== "object" ||
    Array.isArray(raw) ||
    Object.getPrototypeOf(raw) !== Object.prototype
  )
    throw new Error("GitLab project response is invalid.");
  const project = raw as Record<string, unknown>;
  if (
    !Number.isSafeInteger(project.id) ||
    (project.id as number) < 1 ||
    project.path_with_namespace !== fetchRemote.fullPath ||
    typeof project.default_branch !== "string" ||
    !safeBranch(project.default_branch) ||
    project.default_branch !== configuredDefaultBranch ||
    !safeBranch(targetBranch)
  ) {
    throw new Error("GitLab project response is invalid.");
  }
  const commitUrl = new URL(
    `/api/v4/projects/${project.id as number}/repository/commits/${encodeURIComponent(revision)}`,
    `https://${fetchRemote.host}`,
  );
  const commitResponse = await reads.fetch(commitUrl, {
    method: "GET",
    redirect: "error",
    headers: { "PRIVATE-TOKEN": token },
  });
  if (!commitResponse.ok) {
    throw new Error(`GitLab revision observation failed (${commitResponse.status}).`);
  }
  const commitRaw: unknown = await commitResponse.json();
  if (
    !commitRaw ||
    typeof commitRaw !== "object" ||
    Array.isArray(commitRaw) ||
    Object.getPrototypeOf(commitRaw) !== Object.prototype ||
    (commitRaw as Record<string, unknown>).id !== revision
  ) {
    throw new Error("GitLab revision response is invalid.");
  }
  return {
    project: {
      provider: "gitlab",
      host: fetchRemote.host,
      fullPath: fetchRemote.fullPath,
      projectId: project.id as number,
    },
    token,
  };
}

async function git(repositoryPath: string, args: string[]): Promise<string> {
  const result = await execute(
    "/usr/bin/git",
    [
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "core.fsmonitor=false",
      "-c",
      "credential.helper=",
      ...args,
    ],
    {
      cwd: repositoryPath,
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        HOME: "/dev/null",
        XDG_CONFIG_HOME: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_TERMINAL_PROMPT: "0",
      },
    },
  );
  return result.stdout.trim();
}

function parseGitLabRemote(value: string): { host: string; fullPath: string } {
  if (!value || value.includes("\0") || /[\r\n]/u.test(value)) {
    throw new Error("Configured GitLab remote is invalid.");
  }
  let host: string;
  let path: string;
  if (/^https:\/\//u.test(value) || /^ssh:\/\//u.test(value)) {
    const parsed = new URL(value);
    if (
      (parsed.protocol !== "https:" && parsed.protocol !== "ssh:") ||
      parsed.password ||
      parsed.search ||
      parsed.hash ||
      (parsed.protocol === "https:" && parsed.username) ||
      (parsed.protocol === "ssh:" && parsed.username !== "git")
    ) {
      throw new Error("Configured GitLab remote is invalid.");
    }
    host = parsed.hostname;
    path = parsed.pathname.replace(/^\//u, "");
  } else {
    const match = /^git@([^:]+):(.+)$/u.exec(value);
    if (!match) throw new Error("Configured GitLab remote is invalid.");
    host = match[1]!;
    path = match[2]!;
  }
  const fullPath = path.replace(/\.git$/u, "");
  if (!isDnsHostname(host) || !/^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)+$/u.test(fullPath)) {
    throw new Error("Configured GitLab remote is invalid.");
  }
  return { host, fullPath };
}

async function gitLabToken(host: string): Promise<string> {
  const result = await execute("glab", ["config", "get", "token", "-h", host], {
    encoding: "utf8",
    maxBuffer: 64 * 1024,
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: process.env.HOME,
      XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
      GLAB_CONFIG_DIR: process.env.GLAB_CONFIG_DIR,
      GITLAB_TOKEN: undefined,
      GITLAB_PRIVATE_TOKEN: undefined,
      GITLAB_ACCESS_TOKEN: undefined,
      PRIVATE_TOKEN: undefined,
    },
  });
  const token = result.stdout.trim();
  if (!safeToken(token)) throw new Error("GitLab token is unavailable.");
  return token;
}

function safeToken(value: string): boolean {
  return value.length >= 8 && value.length <= 8_192 && !/[\0\r\n]/u.test(value);
}

function trustedGitLabHost(value: unknown): string | null {
  return isDnsHostname(value) ? value : null;
}

function safeBranch(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^(?![-/.])(?!.*(?:\.\.|@\{|\/\/))[^\0-\x20\x7f~^:?*[\\]{1,200}$/u.test(value)
  );
}

async function readProjectConfig(repositoryPath: string): Promise<DocsFabProjectConfigV1 | null> {
  const path = join(repositoryPath, DOCSFAB_PROJECT_CONFIG_FILE);
  let handle;
  try {
    handle = await open(
      path,
      fsConstants.O_RDONLY |
        (typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0),
    );
    const before = await handle.stat();
    if (
      !before.isFile() ||
      before.isSymbolicLink() ||
      before.size < 2 ||
      before.size > 8_192 ||
      before.nlink !== 1 ||
      (before.mode & 0o022) !== 0 ||
      (typeof process.getuid === "function" && before.uid !== process.getuid())
    )
      return null;
    const bytes = await handle.readFile();
    const after = await handle.stat();
    const pathAfter = await lstat(path);
    if (
      !after.isFile() ||
      !pathAfter.isFile() ||
      pathAfter.isSymbolicLink() ||
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      after.dev !== pathAfter.dev ||
      after.ino !== pathAfter.ino ||
      bytes.byteLength !== after.size
    )
      return null;
    const parsed: unknown = JSON.parse(bytes.toString("utf8"));
    assertDocsFabProjectConfig(parsed);
    return parsed;
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function disposableNeedsInput(
  workspace: RepositoryWorkspace,
  input: AutoDryRunNeedsInputV1,
): AutoDryRunHostAssessmentV1 {
  return { status: "needs-input", input, dispose: () => workspace.dispose() };
}

function compare(left: string, right: string): number {
  return left.localeCompare(right);
}
