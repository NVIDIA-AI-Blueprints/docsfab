// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Evidence projection for WorkflowRunner: context preflight, search, impact
 * postflight, repository change capture, security scan, and workflow outcome.
 */
import { deepFreeze } from "../contract-kit/index.js";
import { BoundedSearchContractError } from "../search/bounded-search-contracts.js";
import { SearchProgressContractError } from "../search/progress-contracts.js";
import {
  isContextPreflightCauseReason,
  type ContextPacket,
  type ContextPreflightCause,
  type ContextPreflightEvidence,
  type ContextPreflightLimitEvidence,
  type ContextPreflightResult,
  type ContextPreflightService,
} from "../context/contracts.js";
import {
  CONTEXT_PREFLIGHT_CAUSE_CODE,
  CONTEXT_PREFLIGHT_CAUSE_MESSAGE_CHARACTERS,
  LONE_SURROGATE,
  UNDISPLAYABLE_CAUSE_TEXT,
} from "../context/diagnostic.js";
import type { ImpactPostflightResult } from "../impact/contracts.js";
import {
  RepositoryEvidenceProvenanceError,
  type RepositoryEvidenceCollector,
} from "../repository/contracts.js";
import type { RepositorySecurityScanner, SecurityScanReport } from "../security/contracts.js";
import type { RunRecord } from "../records/contracts.js";
import { isRecordableEvidenceWarning } from "../records/evidence-warnings.js";
import type { RunRequest } from "../execution/contracts.js";
import type {
  StepMode,
  WorkflowContextStepPolicy,
  WorkflowSearchCoordinator,
  WorkflowSearchStepEvidenceV1,
  WorkflowOutcomeProjector,
} from "../workflow-contracts/contracts.js";
import {
  validateRepositoryBatchReplayAuthority,
  type RepositoryBatchReplayAuthorityV1,
  type RepositoryBatchProbeRequestV1,
  type RepositoryDiscoveryInventoryV1,
} from "../repository/inventory.js";
import {
  releaseDocumentationQuestion,
  type ReleaseDocumentationExpectedRepositoryV1,
} from "../release-documentation-rubric.js";
import {
  createReleaseDocumentationReadinessResult,
  ReleaseDocumentationReadinessError,
} from "../release-documentation-readiness.js";
import { repositoryRelativePath } from "../scorecard-record-parse.js";
import { getWorkflow } from "../workflow-registry/catalog.js";
import {
  normalizeWorkflowSearchEvidence,
  instantiateWorkflowSearchTargets,
  snapshotWorkflowSearchCoordinatorResult,
  snapshotWorkflowSearchPlan,
} from "../workflow-contracts/search.js";
import {
  createWorkflowOutcome,
  defaultInconclusiveWorkflowOutcome,
  recordNotReadyToolMisses,
  type WorkflowOutcomeDecodeOptionsV1,
} from "../workflow-contracts/outcome.js";
import { workflowOutcomePersistenceError } from "./runner-schedule.js";
import {
  operatorCodeFailureClass,
  readFailureClassification,
  workflowOutcomeRejectionFailure,
} from "../operator/failure-classification.js";
import { isFailureCode } from "../operator/failure-class.js";
import { workflowOutcomeRejection, type WorkflowOutcomePhase } from "./outcome-rejection.js";
import { isPlainRecord } from "../shared/primitives.js";
import { contractBoundExceededOf } from "../contract-kit/index.js";
import { LIMIT_DEFINITIONS, LIMIT_DEFINITION_BY_NAME } from "../config/limits.generated.js";
import {
  OperationalLimitError,
  formatLimitExceeded,
  formatLimitObservation,
  limit,
} from "../config/limits.js";
import { containsConfiguredCredential } from "../security/configured-credentials.js";
import { detectCredentialRuleIdsInValue } from "../security/repository-scanner.js";
import {
  WORKFLOW_SEARCH_CONTRACT_FAILURE_CODE,
  workflowSearchFailureCode,
  type WorkflowSearchPhase,
} from "./search-failure-codes.js";

export const deepFreezeSnapshot = <T>(value: T): Readonly<T> => deepFreeze(value);

export function boundedDocImprovementChangesMatch(record: RunRecord, request: RunRequest): boolean {
  if (request.task?.kind !== "bounded-doc-improvement") return true;
  const actual = [
    ...new Set(
      (record.changes?.files ?? []).flatMap((entry) => [
        ...(entry.previousPath ? [entry.previousPath] : []),
        entry.path,
      ]),
    ),
  ].sort();
  const intended = [...request.task.intendedPaths].sort();
  if (actual.length !== intended.length || actual.some((path, index) => path !== intended[index]))
    return false;
  return (
    record.impactPostflight?.status === "completed" &&
    record.impactPostflight.changedPaths.length === intended.length &&
    [...record.impactPostflight.changedPaths]
      .sort()
      .every((path, index) => path === intended[index])
  );
}

export function normalizeImpactPostflight(result: ImpactPostflightResult): ImpactPostflightResult {
  if (!isPlainRecord(result) || result.schemaVersion !== 1) {
    throw new Error("Impact postflight returned invalid evidence.");
  }
  if (result.status === "no-change") {
    if (Object.keys(result).sort().join(",") !== "schemaVersion,status") {
      throw new Error("Impact postflight returned non-content-free evidence.");
    }
    return { schemaVersion: 1, status: "no-change" };
  }
  if (
    result.status !== "completed" ||
    Object.keys(result).sort().join(",") !== "analysisDigest,changedPaths,schemaVersion,status" ||
    !Array.isArray(result.changedPaths) ||
    result.changedPaths.length === 0
  ) {
    throw new Error("Impact postflight returned invalid evidence.");
  }
  assertSha256(result.analysisDigest, "impact analysis digest");
  const changedPaths = [...result.changedPaths];
  if (
    changedPaths.some((path) => !safeRelativePath(path)) ||
    new Set(changedPaths).size !== changedPaths.length
  ) {
    throw new Error("Impact postflight returned invalid changed paths.");
  }
  changedPaths.sort();
  return {
    schemaVersion: 1,
    status: "completed",
    analysisDigest: result.analysisDigest,
    changedPaths,
  };
}

export const failedContextPreflight: ContextPreflightEvidence = Object.freeze({
  status: "failed",
  reason: "preflight-internal-failure",
});

const contextStatuses = new Set(["ready", "degraded", "unnecessary", "failed"]);
const contextReasons = new Set([
  "context-service-not-configured",
  "security-scan-not-authorized",
  "workflow-stopped-before-step",
  "policy-marked-unnecessary",
  "semantic-state-unavailable",
  "target-not-applicable",
  "preflight-internal-failure",
  "preflight-budget-exceeded",
  "navigation-coverage-incomplete",
  "navigation-alias-refused",
  "scope-target-partially-unresolved",
  "content-index-refused",
  "content-index-unreadable",
  "context-compile-failed",
]);
const cacheDispositions = new Set(["disabled", "hit", "miss", "rejected"]);
const sha256Pattern = /^[a-f0-9]{64}$/u;

/**
 * Whether a preflight bound can be recorded: it states its name, unit (`ms`
 * for the hosted compile wait, `tokens` for a packet budget), and both
 * values, and its observed value does not sit under the bound it claims to
 * have breached. `host-invoker/context-preflight.ts` calls this before
 * handing evidence over, so a malformed bound becomes a coded
 * `preflight-internal-failure` instead of a normalizer throw.
 */
export function isRecordableContextPreflightLimit(
  limit: unknown,
): limit is ContextPreflightLimitEvidence {
  if (typeof limit !== "object" || limit === null) return false;
  const { name, unit, configured, observed } = limit as Partial<ContextPreflightLimitEvidence>;
  return (
    isIdentifier(name) &&
    (unit === "ms" || unit === "tokens") &&
    typeof configured === "number" &&
    Number.isFinite(configured) &&
    configured >= 0 &&
    typeof observed === "number" &&
    Number.isFinite(observed) &&
    observed >= configured
  );
}

/**
 * Whether a preflight cause can be recorded: a code in the cause-code form
 * and a non-empty message the record decoder admits, with no raw control,
 * format, or separator code point (`UNDISPLAYABLE_CAUSE_TEXT`).
 * `host-invoker/context-preflight.ts` calls this before carrying a compiler's
 * cause into its capsule fallback.
 */
export function isRecordableContextPreflightCause(cause: unknown): cause is ContextPreflightCause {
  if (typeof cause !== "object" || cause === null) return false;
  const { code, message } = cause as Partial<ContextPreflightCause>;
  return (
    typeof code === "string" &&
    CONTEXT_PREFLIGHT_CAUSE_CODE.test(code) &&
    typeof message === "string" &&
    message.length > 0 &&
    message.length <= CONTEXT_PREFLIGHT_CAUSE_MESSAGE_CHARACTERS &&
    !UNDISPLAYABLE_CAUSE_TEXT.test(message) &&
    message.replace(LONE_SURROGATE, "") === message
  );
}

export function normalizeContextPreflight(
  result: ContextPreflightResult,
): ContextPreflightEvidence {
  if (!contextStatuses.has(result.status)) {
    throw new Error("Context preflight returned an invalid status.");
  }
  const evidence: ContextPreflightEvidence = { status: result.status };

  if (result.packetDigest !== undefined) {
    assertSha256(result.packetDigest, "packet digest");
    evidence.packetDigest = result.packetDigest;
  }
  if (result.consultedNodeIds !== undefined) {
    evidence.consultedNodeIds = normalizeIdentifiers(result.consultedNodeIds, "consulted node IDs");
  }
  if (result.ontologyVersion !== undefined) {
    if (!isIdentifier(result.ontologyVersion)) {
      throw new Error("Context preflight returned an invalid ontology version.");
    }
    evidence.ontologyVersion = result.ontologyVersion;
  }
  if (result.effectiveDecisionIds !== undefined) {
    evidence.effectiveDecisionIds = normalizeIdentifiers(
      result.effectiveDecisionIds,
      "effective decision IDs",
    );
  }
  if (result.measurements !== undefined) {
    const { byteLength, estimatedTokens, latencyMs, nodeCount, edgeCount, pathCount } =
      result.measurements;
    if (
      !Number.isSafeInteger(byteLength) ||
      byteLength < 0 ||
      !Number.isSafeInteger(estimatedTokens) ||
      estimatedTokens < 0 ||
      !Number.isFinite(latencyMs) ||
      latencyMs < 0
    ) {
      throw new Error("Context preflight returned invalid measurements.");
    }
    for (const count of [nodeCount, edgeCount, pathCount]) {
      if (count !== undefined && (!Number.isSafeInteger(count) || count < 0)) {
        throw new Error("Context preflight returned invalid measurements.");
      }
    }
    evidence.measurements = {
      byteLength,
      estimatedTokens,
      latencyMs,
      ...(nodeCount !== undefined ? { nodeCount } : {}),
      ...(edgeCount !== undefined ? { edgeCount } : {}),
      ...(pathCount !== undefined ? { pathCount } : {}),
    };
  }
  if (result.cache !== undefined) {
    if (
      !cacheDispositions.has(result.cache.disposition) ||
      typeof result.cache.rebuildAttempted !== "boolean"
    ) {
      throw new Error("Context preflight returned invalid cache evidence.");
    }
    if (result.cache.keyDigest !== undefined) {
      assertSha256(result.cache.keyDigest, "cache key digest");
    }
    evidence.cache = {
      disposition: result.cache.disposition,
      rebuildAttempted: result.cache.rebuildAttempted,
      ...(result.cache.keyDigest ? { keyDigest: result.cache.keyDigest } : {}),
    };
  }
  if (result.reason !== undefined) {
    if (!contextReasons.has(result.reason)) {
      throw new Error("Context preflight returned an invalid reason.");
    }
    evidence.reason = result.reason;
  }
  if (result.limit !== undefined) {
    if (!isRecordableContextPreflightLimit(result.limit)) {
      throw new Error(
        "Context preflight returned an invalid limit record; a recorded bound must name itself and carry both of its values.",
      );
    }
    const { name, unit, configured, observed } = result.limit;
    evidence.limit = { name, unit, configured, observed };
  }
  // The bound and its cause travel together in both directions, so neither a
  // value with no cause nor a ceiling that cannot state its value can be
  // written. The canonical decoder enforces the same pairing on read.
  if ((evidence.limit !== undefined) !== (evidence.reason === "preflight-budget-exceeded")) {
    throw new Error(
      "Context preflight returned a limit and a reason that do not name each other; a recorded bound and its cause travel together.",
    );
  }
  if (result.unboundTargets !== undefined || result.unboundTargetsOmitted !== undefined) {
    const { named, omitted } =
      result.unboundTargets === undefined
        ? { named: [], omitted: 0 }
        : normalizeUnboundTargets(result.unboundTargets, evidence.status);
    const counted = result.unboundTargetsOmitted ?? 0;
    if (evidence.status !== "degraded" || !Number.isSafeInteger(counted) || counted < 0) {
      throw new Error(
        "Context preflight returned an invalid count of unbound targets; only a degraded step counts the requested paths its packet does not bind.",
      );
    }
    if (named.length > 0) evidence.unboundTargets = named;
    if (omitted + counted > 0) evidence.unboundTargetsOmitted = omitted + counted;
  }
  if (result.cause !== undefined) {
    if (!isRecordableContextPreflightCause(result.cause)) {
      throw new Error(
        "Context preflight returned an invalid cause; a recorded cause names its code and one sentence with every control, format, and separator code point escaped.",
      );
    }
    evidence.cause = { code: result.cause.code, message: result.cause.message };
  }
  // A cause travels with its reason on a degraded step, in both directions,
  // so a reason that leaves a step without a packet always says why.
  if (
    (evidence.cause !== undefined) !==
    (evidence.status === "degraded" && isContextPreflightCauseReason(evidence.reason))
  ) {
    throw new Error(
      "Context preflight returned a cause and a reason that do not name each other; a degraded step with a cause reason records its cause.",
    );
  }

  if (evidence.status === "ready") {
    if (
      !evidence.packetDigest ||
      !evidence.consultedNodeIds ||
      !evidence.ontologyVersion ||
      !evidence.effectiveDecisionIds ||
      !evidence.measurements ||
      !evidence.cache
    ) {
      throw new Error("Ready context preflight evidence is incomplete.");
    }
  } else if (!evidence.measurements && !evidence.reason) {
    throw new Error("Non-ready context preflight evidence requires measurements or a reason.");
  }

  return evidence;
}

export function contextPreflightAllowsExecution(
  mode: StepMode,
  policy: WorkflowContextStepPolicy,
  evidence: ContextPreflightEvidence,
): boolean {
  if (evidence.status === "ready" || evidence.status === "unnecessary") {
    return true;
  }
  return (
    evidence.status === "degraded" &&
    ((mode === "read-only" && policy.allowReadOnlyDegraded) ||
      (mode === "write" && evidence.packetDigest !== undefined))
  );
}

/**
 * Requested targets a degraded packet does not bind, as the run record holds
 * them: NFC, repository-relative, each optionally with `#anchor`, unique, in
 * code-unit order so the record decoder reads the same bytes back.
 *
 * The list only informs, so a target's own name never fails the step: one the
 * record cannot hold (a control character in its path, say) is counted in
 * `omitted` instead of named. Only a field that is not a list of names, or one
 * on a step that is not degraded, is refused.
 */
function normalizeUnboundTargets(
  values: unknown,
  status: ContextPreflightEvidence["status"],
): { named: string[]; omitted: number } {
  if (
    status !== "degraded" ||
    !Array.isArray(values) ||
    values.length === 0 ||
    values.some((value) => typeof value !== "string" || value.length === 0)
  ) {
    throw new Error(
      "Context preflight returned invalid unbound targets; only a degraded step names the requested paths its packet does not bind.",
    );
  }
  const named = new Set<string>();
  const omitted = new Set<string>();
  for (const value of values as string[]) {
    const label = value.normalize("NFC");
    (isRecordableUnboundTarget(label) ? named : omitted).add(label);
  }
  return { named: [...named].sort(), omitted: omitted.size };
}

/**
 * Whether the run record's decoder admits `label` as an unbound target: the
 * same `repositoryRelativePath` rule `decodeContextPreflight` applies, so
 * every name written here reads back. It admits a backslash inside a name.
 */
function isRecordableUnboundTarget(label: string): boolean {
  try {
    repositoryRelativePath(label);
    return true;
  } catch {
    return false;
  }
}

function normalizeIdentifiers(values: string[], field: string): string[] {
  if (!Array.isArray(values) || values.some((value) => !isIdentifier(value))) {
    throw new Error(`Context preflight returned invalid ${field}.`);
  }
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function isIdentifier(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 512;
}

function assertSha256(value: string, field: string): void {
  if (!sha256Pattern.test(value)) {
    throw new Error(`Context preflight returned an invalid ${field}.`);
  }
}

function safeRelativePath(value: unknown): value is string {
  return (
    safeText(value) &&
    !value.includes("\\") &&
    !value.startsWith("/") &&
    !/^[A-Za-z]:/u.test(value) &&
    value.split("/").every((part) => part.length > 0 && part !== "." && part !== "..")
  );
}

function safeText(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value === value.normalize("NFC") &&
    !value.includes("\0")
  );
}

export async function applyWorkflowOutcome(input: {
  outcomeProjector?: WorkflowOutcomeProjector;
  record: RunRecord;
  expectedRepository?: ReleaseDocumentationExpectedRepositoryV1;
  trustedInventory?: RepositoryDiscoveryInventoryV1;
  decodeOptions?: WorkflowOutcomeDecodeOptionsV1;
}): Promise<void> {
  const { outcomeProjector, record, expectedRepository, trustedInventory, decodeOptions } = input;
  if (record.status === "failed" || record.status === "queued" || record.status === "running") {
    return;
  }
  // The phase running when a refusal is thrown names the producer in the
  // recorded inner reason.
  let phase: WorkflowOutcomePhase = "release-readiness";
  try {
    const releaseReadiness =
      record.workflow === "release-documentation-readiness" && record.status === "succeeded"
        ? createReleaseDocumentationReadinessResult(record, expectedRepository, trustedInventory)
        : undefined;
    if (releaseReadiness) record.releaseDocumentationReadiness = releaseReadiness.artifact;
    phase = "projection";
    const candidate = releaseReadiness
      ? releaseReadiness.outcome
      : outcomeProjector
        ? await outcomeProjector.project(deepFreezeSnapshot(structuredClone(record)), decodeOptions)
        : record.status === "succeeded"
          ? defaultInconclusiveWorkflowOutcome(record)
          : undefined;
    phase = "admission";
    // The run's model tool misses become a limitation on a `not-ready` result
    // rather than discarding the work it produced. `createWorkflowOutcome` adds
    // the host's `source-citation-gaps` label on every path.
    if (candidate) {
      record.workflowOutcome = createWorkflowOutcome(
        recordNotReadyToolMisses(candidate, record),
        record,
        decodeOptions,
      );
    }
    if (releaseReadiness) {
      record.workUnitMachineContracts = releaseReadiness.machineContracts;
    }
  } catch (error) {
    delete record.releaseDocumentationReadiness;
    delete record.workflowOutcome;
    delete record.workUnitMachineContracts;
    record.status = "failed";
    record.error = persistFailureMessage(error);
    const rejection = workflowOutcomeRejection(phase, error);
    if (!readFailureClassification(record.failure)) {
      record.workflowOutcomeRejection = rejection;
      record.failure = workflowOutcomeRejectionFailure(rejection);
    }
  }
}

function persistFailureMessage(error: unknown): string {
  if (error instanceof ReleaseDocumentationReadinessError) {
    return error.message;
  }
  return workflowOutcomePersistenceError;
}

export async function workflowSearch(input: {
  workflowSearch?: WorkflowSearchCoordinator;
  runId: string;
  repositoryPath: string;
  repository: RunRecord["repository"];
  workflow: ReturnType<typeof getWorkflow>;
  step: ReturnType<typeof getWorkflow>["steps"][number];
  repositoryDefaultBranch?: string;
  authorizedWritePaths?: readonly string[];
}): Promise<
  | {
      evidence: WorkflowSearchStepEvidenceV1;
      repositoryBatchAuthority?: RepositoryBatchReplayAuthorityV1;
      trustedInventory?: RepositoryDiscoveryInventoryV1;
      /** Warnings the coordinator reported for the run record. */
      evidenceWarnings?: readonly string[];
    }
  | undefined
> {
  if (!input.step.search || !input.workflowSearch) return undefined;
  let phase: WorkflowSearchPhase = "plan";
  try {
    const plan = snapshotWorkflowSearchPlan(input.step.search);
    const step = deepFreezeSnapshot({ ...input.step, search: plan });
    const workflow = deepFreezeSnapshot({
      ...input.workflow,
      contextPolicy: input.workflow.contextPolicy,
      steps: input.workflow.steps.map((candidate) => (candidate.id === step.id ? step : candidate)),
    });
    const coordinatorInput = deepFreezeSnapshot({
      runId: input.runId,
      repositoryPath: input.repositoryPath,
      repository: input.repository,
      ...(input.repositoryDefaultBranch
        ? { repositoryDefaultBranch: input.repositoryDefaultBranch }
        : {}),
      ...(input.authorizedWritePaths ? { authorizedWritePaths: input.authorizedWritePaths } : {}),
      workflow,
      step,
      plan,
    });
    phase = "coordinator";
    const searched = await input.workflowSearch.search(coordinatorInput);
    phase = "evidence";
    const result = snapshotWorkflowSearchCoordinatorResult(searched);
    const evidence = normalizeWorkflowSearchEvidence({
      plan,
      repository: input.repository,
      repositoryIdentitySha256: result.repositoryIdentitySha256,
      searches: result.searches,
      ...(result.workspaceSnapshotSha256
        ? { workspaceSnapshotSha256: result.workspaceSnapshotSha256 }
        : {}),
    });
    const warnings = result.evidenceWarnings ? { evidenceWarnings: result.evidenceWarnings } : {};
    if (input.workflow.name !== "release-documentation-readiness") return { evidence, ...warnings };
    phase = "release-authority";
    if (!result.repositoryBatchAuthority) {
      throw new Error("Release documentation search batch authority is missing.");
    }
    if (!result.trustedRepositoryInventory) {
      throw new Error("Release documentation trusted inventory is missing.");
    }
    const targets = instantiateWorkflowSearchTargets(plan, {
      identitySha256: result.repositoryIdentitySha256,
      revision: input.repository.revision,
    });
    const repositoryBatchAuthority = validateRepositoryBatchReplayAuthority(
      result.repositoryBatchAuthority,
      {
        repositoryIdentitySha256: result.repositoryIdentitySha256,
        repositoryRevision: input.repository.revision,
        repositoryWorkspace: input.repository,
        trustedInventory: result.trustedRepositoryInventory,
        targets,
        requestsForTarget: (target) =>
          target.requiredProbes.map((probe) => {
            const question = releaseDocumentationQuestion(target.targetKey, probe.id);
            if (!question) throw new Error("Release rubric question is missing.");
            return { id: probe.id, question } as RepositoryBatchProbeRequestV1;
          }),
      },
    );
    return {
      evidence,
      repositoryBatchAuthority,
      trustedInventory: result.trustedRepositoryInventory,
      ...warnings,
    };
  } catch (error) {
    throw workflowSearchFailure(phase, error);
  }
}

export {
  WORKFLOW_SEARCH_FAILURE_CODES,
  WORKFLOW_SEARCH_PHASES,
  type WorkflowSearchFailureCode,
  type WorkflowSearchPhase,
} from "./search-failure-codes.js";

const WORKFLOW_SEARCH_STOPPED = "Governed workflow search could not be completed";

/**
 * A governed workflow search stop that keeps its cause (#1927). `code` is
 * always catalogued: a decode bound's or limit's own catalog refusal, a trusted
 * search contract code, the inner error's code when a failure table names it,
 * or `workflow-search-<phase>-failed`. The message is composed from closed facts
 * only: the phase, the codes, the inner error's class name, a bound's values,
 * and a repository-relative path. It never copies the inner error's text, so
 * a coordinator's provider or host detail cannot reach the run record. The
 * inner error stays on `cause` for in-process callers.
 */
export class WorkflowSearchError extends Error {
  public readonly code: string;
  public readonly phase: WorkflowSearchPhase;

  public constructor(input: {
    phase: WorkflowSearchPhase;
    code: string;
    message: string;
    cause: unknown;
  }) {
    // `name` stays "Error": operator text that renders the error keeps its shape.
    super(input.message, { cause: input.cause });
    this.code = input.code;
    this.phase = input.phase;
  }
}

/**
 * The coded stop for an error raised in one search phase. Never throws: a
 * diagnostic must not be able to replace the stop it describes.
 */
export function workflowSearchFailure(
  phase: WorkflowSearchPhase,
  error: unknown,
): WorkflowSearchError {
  let code: string = workflowSearchFailureCode(phase);
  try {
    const cause = searchFailureCause(phase, error);
    code = cause.code;
    // Credentials stay fail-closed: a cause that would carry DocsFab's own
    // configured credential, matched exactly (#1807), or text that looks like
    // a credential, is withheld from the record.
    if (
      !containsConfiguredCredential(cause.message) &&
      detectCredentialRuleIdsInValue(cause.message).length === 0
    ) {
      return new WorkflowSearchError({ phase, code, message: cause.message, cause: error });
    }
  } catch {
    // Fall through to the phase-only stop below.
  }
  return new WorkflowSearchError({
    phase,
    code,
    message: `${WORKFLOW_SEARCH_STOPPED} (${code}): its ${phase} phase stopped.`,
    cause: error,
  });
}

function searchFailureCause(
  phase: WorkflowSearchPhase,
  error: unknown,
): { code: string; message: string } {
  // A contract-kit decode bound names its catalog axis and both values.
  const bound = contractBoundExceededOf(error);
  const boundDefinition = bound ? LIMIT_DEFINITION_BY_NAME[bound.axis] : undefined;
  if (bound && boundDefinition && isFailureCode(boundDefinition.refusal)) {
    return {
      code: boundDefinition.refusal,
      message: `${WORKFLOW_SEARCH_STOPPED}: its ${phase} phase stopped at a limit. ${formatLimitObservation(
        { ...boundDefinition, value: bound.limit },
        bound.observed,
      )}`,
    };
  }
  const contract = trustedSearchContractError(error);
  if (contract) {
    return {
      code: WORKFLOW_SEARCH_CONTRACT_FAILURE_CODE,
      message: `${WORKFLOW_SEARCH_STOPPED} (${WORKFLOW_SEARCH_CONTRACT_FAILURE_CODE}): its ${phase} phase refused ${contract.kind} host search evidence${contract.code ? ` (inner code ${contract.code})` : ""}.`,
    };
  }
  const name = errorClassName(error);
  const path = repositoryPathOf(error);
  const at = path === undefined ? "" : ` at ${path}`;
  const innerCode = errorCodeOf(error);
  const innerClass = innerCode === undefined ? undefined : operatorCodeFailureClass(innerCode);
  if (innerCode !== undefined && innerClass !== undefined && innerClass !== "unknown") {
    const limitLine = limitRefusalLine(error, innerCode);
    return {
      code: innerCode,
      message: limitLine
        ? `${WORKFLOW_SEARCH_STOPPED}: its ${phase} phase stopped at a limit. ${limitLine}`
        : `${WORKFLOW_SEARCH_STOPPED} (${innerCode}): its ${phase} phase raised ${name} with that code${at}.`,
    };
  }
  const code = workflowSearchFailureCode(phase);
  // A code no table classifies, or one whose class is `unknown`, names no cause.
  const raised =
    innerCode === undefined
      ? `${name} with no code`
      : `${name} with unclassified code ${innerCode}`;
  return {
    code,
    message: `${WORKFLOW_SEARCH_STOPPED} (${code}): its ${phase} phase raised ${raised}${at}.`,
  };
}

const BOUNDED_SEARCH_CONTRACT_CODES: ReadonlySet<BoundedSearchContractError["code"]> = new Set([
  "invalid-target",
  "invalid-probe",
  "invalid-limitation",
  "invalid-coverage",
  "invalid-confidence",
  "invalid-finding",
  "invalid-evidence",
  "unsupported-schema",
]);
const SEARCH_PROGRESS_CONTRACT_CODES: ReadonlySet<SearchProgressContractError["code"]> = new Set([
  "invalid-policy",
  "invalid-event",
  "invalid-observation",
  "invalid-rationale",
  "invalid-recommendation",
  "invalid-execution-authority",
  "invalid-evidence",
  "unsupported-schema",
]);

/** Inspect only the own closed code of an actual contract exception. */
function trustedSearchContractError(
  error: unknown,
): { kind: "bounded" | "progress"; code: string | undefined } | undefined {
  if (error instanceof BoundedSearchContractError) {
    const code = Object.getOwnPropertyDescriptor(error, "code")?.value;
    return { kind: "bounded", code: BOUNDED_SEARCH_CONTRACT_CODES.has(code) ? code : undefined };
  }
  if (error instanceof SearchProgressContractError) {
    const code = Object.getOwnPropertyDescriptor(error, "code")?.value;
    return { kind: "progress", code: SEARCH_PROGRESS_CONTRACT_CODES.has(code) ? code : undefined };
  }
  return undefined;
}

/** The operator line for a catalogued limit refusal, built from catalog data only. */
function limitRefusalLine(error: unknown, code: string): string | undefined {
  if (error instanceof OperationalLimitError) {
    const definition = LIMIT_DEFINITION_BY_NAME[error.limitName];
    if (definition && definition.refusal === code && Number.isFinite(error.observed)) {
      return formatLimitObservation({ ...definition, value: error.configured }, error.observed);
    }
  }
  const definition = LIMIT_DEFINITIONS.find((candidate) => candidate.refusal === code);
  if (!definition) return undefined;
  try {
    return formatLimitExceeded(limit(definition.name));
  } catch {
    // An override that no longer resolves keeps the code; the line is optional.
    return undefined;
  }
}

/** A kebab-case code on an error, the same shape the failure classifier reads. */
function errorCodeOf(error: unknown): string | undefined {
  if (!(error instanceof Error) || !("code" in error)) return undefined;
  const code = (error as { code: unknown }).code;
  return isFailureCode(code) ? code : undefined;
}

/** An identifier-shaped error class name; anything else reads as `Error`. */
function errorClassName(error: unknown): string {
  if (!(error instanceof Error)) return "a non-error value";
  const name = error.name;
  return typeof name === "string" && /^[A-Za-z][A-Za-z0-9]{0,63}$/u.test(name) ? name : "Error";
}

/** A repository-relative `path` the error carries; a host path never qualifies. */
function repositoryPathOf(error: unknown): string | undefined {
  if (!(error instanceof Error) || !("path" in error)) return undefined;
  const path = (error as { path: unknown }).path;
  return safeRelativePath(path) && !/[\u0000-\u001f\u007f]/u.test(path) ? path : undefined;
}

export async function preflightContext(
  input: {
    contextPreflight?: ContextPreflightService;
  } & Parameters<ContextPreflightService["preflight"]>[0],
): Promise<{
  evidence: ContextPreflightEvidence;
  packet?: ContextPacket;
  /** Run warnings for repository content the preflight left out; the runner records each once. */
  limitations?: readonly string[];
}> {
  if (!input.policy.required) {
    return {
      evidence: {
        status: "unnecessary",
        reason: "policy-marked-unnecessary",
      },
    };
  }
  if (!input.contextPreflight) {
    return {
      evidence: failedContextPreflight,
    };
  }

  try {
    const { contextPreflight, ...preflightInput } = input;
    const result = await contextPreflight.preflight(preflightInput);
    const evidence = normalizeContextPreflight(result);
    if (evidence.status === "ready" && !result.packet) {
      throw new Error("Ready context preflight did not return a packet.");
    }
    if (
      result.packet &&
      (evidence.status === "unnecessary" ||
        evidence.status === "failed" ||
        !evidence.packetDigest ||
        result.packet.digest !== evidence.packetDigest)
    ) {
      throw new Error("Context packet does not match preflight evidence.");
    }
    const limitations = Array.isArray(result.limitations)
      ? result.limitations.filter((line): line is string => typeof line === "string")
      : [];
    return {
      evidence,
      ...(result.packet ? { packet: result.packet } : {}),
      ...(limitations.length > 0 ? { limitations } : {}),
    };
  } catch {
    return { evidence: failedContextPreflight };
  }
}

export async function scanRepository(
  scanner: RepositorySecurityScanner,
  workspacePath: string,
): Promise<SecurityScanReport> {
  try {
    return await scanner.scan(workspacePath);
  } catch {
    return {
      ruleSet: "scanner-unavailable",
      status: "failed",
      scannedFiles: 0,
      binaryFiles: 0,
      findings: [{ path: ".", ruleId: "scanner.internal-failure" }],
    };
  }
}

/**
 * Appends warnings to the run record, each once. One the record decoders
 * cannot keep (empty, over 1,024 characters, or holding a control character)
 * is replaced by a fixed placeholder, never dropped.
 */
export function appendEvidenceWarnings(record: RunRecord, warnings: readonly string[]): void {
  const kept = new Set(record.evidenceWarnings ?? []);
  const added: string[] = [];
  for (const warning of warnings) {
    const text = isRecordableEvidenceWarning(warning)
      ? warning
      : "A run warning was too long or held a control character, so the run record keeps this placeholder instead.";
    if (kept.has(text)) continue;
    kept.add(text);
    added.push(text);
  }
  if (added.length > 0) record.evidenceWarnings = [...(record.evidenceWarnings ?? []), ...added];
}

export async function captureChanges(input: {
  repositoryEvidence?: RepositoryEvidenceCollector;
  record: RunRecord;
  workspacePath: string;
  persistPatch: boolean;
}): Promise<{ captured: boolean; provenanceRejected: boolean }> {
  const { repositoryEvidence, record, workspacePath, persistPatch } = input;
  if (!repositoryEvidence) return { captured: !persistPatch, provenanceRejected: false };
  try {
    record.changes = await repositoryEvidence.capture({
      runId: record.id,
      repository: record.repository,
      workspacePath,
      persistPatch,
    });
    if (persistPatch && !record.changes.patch) {
      throw new Error("Evidence collector did not return a patch artifact.");
    }
    return { captured: true, provenanceRejected: false };
  } catch (error) {
    if (error instanceof RepositoryEvidenceProvenanceError) {
      if (persistPatch && !error.evidence.patch) {
        throw new Error(
          "Repository provenance rejection did not include a partial patch artifact.",
        );
      }
      record.changes = error.evidence;
      record.evidenceWarnings = [
        ...(record.evidenceWarnings ?? []),
        "Repository change evidence retained a valid partial source delta but rejected an unrepresentable runtime bookkeeping change.",
      ];
      return { captured: false, provenanceRejected: true };
    }
    const reason = persistPatch
      ? "Repository changes could not be preserved as a patch artifact."
      : "Repository change evidence could not be captured.";
    // A limit the evidence git command crossed names itself, the value it
    // observed, and how to raise it, so the record says what stopped the capture.
    record.evidenceWarnings = [
      ...(record.evidenceWarnings ?? []),
      error instanceof OperationalLimitError ? `${reason} ${error.message}` : reason,
    ];
    return { captured: false, provenanceRejected: false };
  }
}
