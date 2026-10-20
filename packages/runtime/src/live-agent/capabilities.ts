// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { withChildTaskActivity } from "../activity/observer.js";
import { lstat, readFile, realpath } from "node:fs/promises";
import { isAbsolute, resolve, sep } from "node:path";

import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

import {
  decodeRunRecordFirstPassContradiction,
  type FirstPassContradictionQuestionV1,
} from "../cli/run/first-pass-contradiction-stop.js";
import { assertConfinedToolResultCredentialFree } from "../security/credential-isolation.js";
import { isRecordableEvidenceWarning } from "../records/evidence-warnings.js";
import { decodeFirstPassContradictionAdmission } from "../records/first-pass-contradiction-admission.js";

import type { DocsFabConfig } from "../config/runtime-loader.js";
import {
  KnowledgeResumeError,
  knowledgeResumeNeedsInputMessage,
  type KnowledgeResumeStopReason,
} from "../cli/knowledge-resume.js";
import { KnowledgeContinuationError } from "../records/knowledge-continuation.js";
import {
  conservativeReaderContextInput,
  createReaderTaskContextSupplier,
  type ReaderTaskContextHandoffV1,
  type ReaderTaskContextInputOrigin,
  type ReaderTaskContextSupplier,
} from "../execution/task-context.js";
import { verifyQualityPackContext } from "../quality-pack/manifest.js";
import type { ProgressEvent, QualityPackEvidenceV1 } from "../records/contracts.js";
import { isWorkflowManifestV2, type WorkflowDefinition } from "../workflow-contracts/contracts.js";
import {
  readCatalogSkillCrateLock,
  verifyCatalogSkill,
  type CatalogSkillId,
  type LockedCatalogSkill,
} from "../skills/catalog-crate.js";
import { listWorkflows, type RunnableWorkflowName } from "../workflow-registry/catalog.js";
import type { LiveWorkflowRun } from "./workflow-delivery.js";
import type { DocumentationWorkCompletionV1 } from "./documentation-work-completion.js";
import { assertWorkflowActive } from "../execution/cancellation.js";
import {
  assertTaskResultChangeAdmitted,
  type TaskResultChangeFactsV1,
} from "../execution/task-reconciliation.js";
import { inspectQualityReportFromRun } from "../evaluation-report/index.js";
import type { ReaderContextInputV1, ReaderContextSourceRoleV1 } from "../context/reader-context.js";
import type { ReaderComparisonRequestV1 } from "../search/change-impact.js";
import { LIVE_SKILL_FAILURES, rethrowLiveReaderSnapshotMismatch } from "./skill-references.js";
import {
  InvocationContractError,
  type InvocationContractErrorCode,
} from "../execution/invocation-contracts.js";
import {
  INVOCATION_CONTRACT_SKILL_IDS,
  decodeSkillInvocationMetadata,
  loadVerifiedInvocationMetadata,
  type SkillInvocationMetadata,
} from "../skills/invocation-metadata.js";
import {
  availableAssessmentSkills,
  invocationBridgeError,
  liveInvocationGuidance,
  readerIntakeWorkflows,
  resolveLiveSkillInvocation,
  resolveLiveWorkflowInvocation,
  suppliedReaderFields,
  unadmittedWorkflowReaderFieldsNote,
} from "./invocation-bindings.js";
import { projectRunEditorialOutcome, type RunEditorialOutcomeV1 } from "../operator/run-result.js";
import { readRunFailure, readStepFailure } from "../operator/failure-classification.js";
import { editorialInputAskPresentationV1 } from "../artifacts/editorial-input-ask.js";
import { editorialInputAskSlots } from "../inputs/operator-input-fill.js";

type AnyToolDefinition = ToolDefinition<any, any, any>;

const READER_SOURCE_ROLES = [
  "public-contract",
  "changed-source",
  "current-documentation",
  "repository-instruction",
  "accepted-knowledge",
  "request",
] as const satisfies readonly ReaderContextSourceRoleV1[];

function readerContextInputToolSchema() {
  const text = { type: "string" as const, minLength: 1, maxLength: 4_096 };
  const list = (minimum: number) => ({
    type: "array" as const,
    minItems: minimum,
    maxItems: 64,
    uniqueItems: true,
    items: text,
  });
  return {
    type: "object" as const,
    description:
      "Optional bounded ReaderContextInputV1 request intent. It contains no impact basis, comparison evidence, or authority.",
    additionalProperties: false,
    required: [
      "schema_version",
      "target_audience",
      "reader_job",
      "change_scope",
      "source_priority",
      "required_content",
      "excluded_content",
      "unresolved_questions",
    ],
    properties: {
      schema_version: { type: "integer" as const, const: 1 },
      target_audience: { ...text, maxLength: 1_024 },
      reader_job: { ...text, maxLength: 1_024 },
      change_scope: {
        type: "array" as const,
        minItems: 1,
        maxItems: 32,
        uniqueItems: true,
        items: { ...text, maxLength: 1_024 },
      },
      source_priority: list(1),
      required_content: list(1),
      excluded_content: list(0),
      unresolved_questions: list(0),
      known_limitations: list(0),
    },
  };
}

function readerComparisonToolSchema() {
  const revision = { type: "string" as const, pattern: "^[a-fA-F0-9]{40,64}$" };
  return {
    oneOf: [
      {
        type: "object" as const,
        additionalProperties: false,
        required: ["kind", "baseRevision", "headRevision"],
        properties: {
          kind: { type: "string" as const, const: "base-head" },
          baseRevision: revision,
          headRevision: revision,
        },
      },
      {
        type: "object" as const,
        additionalProperties: false,
        required: ["kind"],
        properties: { kind: { type: "string" as const, const: "workspace" } },
      },
    ],
  };
}

export interface LiveAgentSkill {
  lock: LockedCatalogSkill;
  directory: string;
  invocation?: SkillInvocationMetadata;
}

export interface LiveAgentCapabilities {
  skills: readonly LiveAgentSkill[];
  qualityPack: QualityPackEvidenceV1;
  qualityGuidancePaths?: readonly string[];
  /** Present on verified installed hosts; omitted only by narrow legacy test fixtures. */
  readerTaskContextSupplier?: ReaderTaskContextSupplier;
  workflows: readonly { name: RunnableWorkflowName; title: string }[];
}

export interface LiveReaderTaskContextRequest {
  consumer: { kind: "skill"; id: string } | { kind: "workflow"; id: RunnableWorkflowName };
  readerContextInput: ReaderContextInputV1;
  inputOrigin: ReaderTaskContextInputOrigin;
  sourceHints: readonly LiveReaderSourceHint[];
  /** Exact workflow instruction retained by the host as virtual request evidence. */
  requestText?: string;
  comparisonRequest?: ReaderComparisonRequestV1;
}

export interface LiveReaderSourceHint {
  role: ReaderContextSourceRoleV1;
  path: string;
}

function readerSourceToolSchema() {
  return {
    type: "array" as const,
    description:
      "Repository files to hand off as evidence. Prior conversational reads and MR summaries are not automatically admitted. Include the affected docs as current-documentation and the implementation, schemas, tests, or authoritative contributor contracts establishing the requested behavior as public-contract; use changed-source for files identified in the retrieved change. A file can have multiple roles when the evidence establishes each role. Do not label all changed files current-documentation or omit the public docs being assessed. Supply paths only; the host reads committed bytes and computes digests.",
    maxItems: 64,
    uniqueItems: true,
    items: {
      type: "object" as const,
      additionalProperties: false,
      required: ["role", "path"],
      properties: {
        role: { type: "string" as const, enum: READER_SOURCE_ROLES },
        path: { type: "string" as const, minLength: 1, maxLength: 4_096 },
      },
    },
  };
}

function decodeReaderSourceHints(value: unknown): readonly LiveReaderSourceHint[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 64) {
    throw new Error("DocsFab reader sources require a bounded list of role and path entries.");
  }
  return Object.freeze(
    value.map((entry) => {
      if (
        typeof entry !== "object" ||
        entry === null ||
        Array.isArray(entry) ||
        Object.keys(entry).sort().join(",") !== "path,role"
      ) {
        throw new Error("DocsFab reader sources require exact role and path entries.");
      }
      const { role, path } = entry as { role?: unknown; path?: unknown };
      if (
        typeof role !== "string" ||
        !READER_SOURCE_ROLES.includes(role as ReaderContextSourceRoleV1) ||
        typeof path !== "string" ||
        path.length < 1 ||
        path.length > 4_096
      ) {
        throw new Error("DocsFab reader sources contain an invalid role or path.");
      }
      return Object.freeze({ role: role as ReaderContextSourceRoleV1, path });
    }),
  );
}

function decodeReaderComparison(value: unknown): ReaderComparisonRequestV1 | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("DocsFab reader comparison requires an exact base/head or workspace request.");
  }
  const root = value as Record<string, unknown>;
  if (root.kind === "workspace" && Object.keys(root).join(",") === "kind") {
    return Object.freeze({ kind: "workspace" });
  }
  const keys = Object.keys(root).sort().join(",");
  if (
    root.kind === "base-head" &&
    keys === "baseRevision,headRevision,kind" &&
    typeof root.baseRevision === "string" &&
    typeof root.headRevision === "string" &&
    /^[a-f0-9]{40,64}$/iu.test(root.baseRevision) &&
    /^[a-f0-9]{40,64}$/iu.test(root.headRevision)
  ) {
    return Object.freeze({
      kind: "base-head",
      baseRevision: root.baseRevision.toLowerCase(),
      headRevision: root.headRevision.toLowerCase(),
    });
  }
  throw new Error("DocsFab reader comparison requires an exact base/head or workspace request.");
}

export async function loadLiveAgentCapabilities(
  config: DocsFabConfig,
): Promise<LiveAgentCapabilities> {
  const lock = await readCatalogSkillCrateLock(config.skillCrateDirectory);
  const skills = await Promise.all(
    lock.skills.map(async (skill) => {
      const verified = await verifyCatalogSkill({
        skillCrateDirectory: config.skillCrateDirectory,
        skillId: skill.id,
        grantedTools: skill.toolPolicy.granted,
      });
      return {
        lock: skill,
        directory: verified.directory,
        ...((INVOCATION_CONTRACT_SKILL_IDS as readonly string[]).includes(skill.id)
          ? { invocation: await loadVerifiedInvocationMetadata(verified) }
          : {}),
      };
    }),
  );
  const qualityPack = await verifyQualityPackContext({
    qualityPackDirectory: config.qualityPackDirectory,
    qualityDirectory: config.qualityDirectory,
    skillCrateDirectory: config.skillCrateDirectory,
  });
  const readerTaskContextSupplier = await createReaderTaskContextSupplier(qualityPack);
  const workflows = listWorkflows().map((workflow) => ({
    name: workflow.name as RunnableWorkflowName,
    title: workflow.title,
  }));
  const qualityGuidancePaths = qualityPack.qualityLock.files
    .map((file) => file.path)
    .filter((path) => /^(?:profiles\/[^/]+\/profile\.json|rubrics\/[^/]+\.ya?ml)$/u.test(path))
    .map((path) => `.docsfab-governed-assets/quality/${path}`);
  return {
    skills,
    qualityPack: qualityPack.evidence,
    qualityGuidancePaths,
    readerTaskContextSupplier,
    workflows,
  };
}

/**
 * The closed knowledge-stop vocabulary this adapter forwards. An exhaustive
 * `Record`, so a new stop reason fails the typecheck here.
 */
const LIVE_KNOWLEDGE_STOP_REASONS: Readonly<Record<KnowledgeResumeStopReason, true>> =
  Object.freeze({
    conflict: true,
    "unresolved-claim": true,
    "intent-mismatch": true,
    "insufficient-evidence": true,
    "needs-authorization": true,
  });

export function isLiveKnowledgeStopReason(value: unknown): value is KnowledgeResumeStopReason {
  return typeof value === "string" && Object.hasOwn(LIVE_KNOWLEDGE_STOP_REASONS, value);
}

/**
 * Fixed host diagnostics for a knowledge stop that never reached a run record.
 *
 * Looked up by `error.code`; the error's own message is discarded because it
 * can carry provider text. The leading coded phrase carries the typed reason
 * across the tool boundary, which drops structured details.
 */
export const LIVE_KNOWLEDGE_STOP_DIAGNOSTICS: Readonly<Record<KnowledgeResumeStopReason, string>> =
  Object.freeze(
    Object.fromEntries(
      Object.keys(LIVE_KNOWLEDGE_STOP_REASONS).map((reason) => [
        reason,
        `DocsFab knowledge stop (${reason}). ${knowledgeResumeNeedsInputMessage(reason as KnowledgeResumeStopReason)}`,
      ]),
    ) as Record<KnowledgeResumeStopReason, string>,
  );

/**
 * The knowledge stop DocsFab could not retain.
 *
 * When persisting a resumable stop fails, a `KnowledgeContinuationError`
 * without a stop reason leaves the tool boundary, so the original category is
 * unknown here.
 */
export const LIVE_KNOWLEDGE_STOP_NOT_RETAINED_DETAIL =
  "This workflow stopped on the knowledge evidence it gathered, and DocsFab could not retain a resumable record of that stop.";

/** The wire form the adapter raises; the terminal projects it like the others. */
export const LIVE_KNOWLEDGE_STOP_NOT_RETAINED = `DocsFab knowledge stop (not-retained). ${LIVE_KNOWLEDGE_STOP_NOT_RETAINED_DETAIL}`;

/**
 * What the host observes of one projected workflow result. The host keeps only
 * closed codes, validated step ids, the run id, and a validated, screened
 * first-pass contradiction question from it.
 */
export interface LiveWorkflowResultObservationV1 {
  readonly runId: string;
  readonly workflow: string;
  readonly status: string;
  readonly steps: readonly { readonly id: string; readonly status: string }[];
  readonly error?: string;
  /** The first failed step's error. */
  readonly stepError?: string;
  readonly persistence?: string;
  /** Named InputAsk slot ids of an editorial `needs-input` stop. */
  readonly inputAskInputIds?: readonly string[];
  /** Strictly decoded saved question, screened before model and operator projection. */
  readonly firstPassContradictionQuestion?: FirstPassContradictionQuestionV1;
  readonly firstPassChoiceAvailable?: true;
}

/** The same safe evidence projection serves initial and successor terminal results. */
export function liveWorkflowEvidenceWarnings(value: unknown): readonly string[] {
  const lines = value ?? [];
  if (
    !Array.isArray(lines) ||
    lines.some((line) => typeof line !== "string" || !isRecordableEvidenceWarning(line))
  ) {
    throw new Error("The saved evidence warnings cannot be shown safely.");
  }
  assertConfinedToolResultCredentialFree(lines);
  return Object.freeze([...lines]);
}

/** Ordinary tools and host continuations report the same persistence and quality outcome. */
export function projectLiveWorkflowOutcome(
  record: LiveWorkflowRun,
  options: { signal?: AbortSignal; editorial?: RunEditorialOutcomeV1 } = {},
) {
  const editorial = options.editorial ?? projectRunEditorialOutcome(record);
  const report = inspectQualityReportFromRun(record, {
    qualityNotApplicable: editorial.outcome === "verified-no-change",
  });
  return {
    status: options.signal?.aborted
      ? "cancelled"
      : record.livePersistence?.status === "failed" || report.error
        ? "failed"
        : record.status,
    error: record.livePersistence?.error ?? record.error ?? report.error,
    quality: report.quality,
    ...(report.limitation ? { qualityLimitations: [report.limitation] } : {}),
    workflowStatus: record.status,
    persistence: record.livePersistence ?? { status: "not-applied" },
  };
}

/** The instruction to parse and the never-parsed context, after host binding. */
export interface LiveWorkflowBoundRequestV1 {
  readonly instruction: string;
  readonly context?: string;
  /** Characters of context cut at `liveAgent.workflowContextMaxChars`. */
  readonly contextOmittedChars?: number;
}

/** Host-recovered, saved-run binding; never a model tool parameter. */
export interface LiveWorkflowRetryBindingV1 {
  readonly revision: string;
  readonly reviewTargetPaths?: readonly string[];
  /** Reacquired PR evidence must match the saved review, including identity and diff. */
  readonly reviewChangeSourceSha256?: string;
}

export type LiveWorkflowRunner = (
  workflow: RunnableWorkflowName,
  instruction: string,
  onProgress?: (event: ProgressEvent, workflow: WorkflowDefinition) => void,
  signal?: AbortSignal,
  readerTaskContext?: ReaderTaskContextHandoffV1,
  /** Agent-added context beside the verbatim instruction; never parsed. */
  instructionContext?: string,
  retryBinding?: LiveWorkflowRetryBindingV1,
) => Promise<LiveWorkflowRun>;

/** Typed stop forwarded beside a run result. Carries no snapshot content. */
export interface LiveWorkflowKnowledgeStopV1 {
  readonly reason: KnowledgeResumeStopReason;
  /** Present only when a retained continuation binding names this exact run. */
  readonly resumeRunId?: string;
}

/**
 * Project a persisted knowledge stop from a completed run record.
 *
 * `resumeRunId` requires a continuation receipt bound to this exact run and
 * workflow; without one there is nothing to resume from.
 */
export function liveWorkflowKnowledgeStop(
  record: Pick<LiveWorkflowRun, "id" | "workflow" | "status" | "error"> & {
    knowledgeContinuationReceipt?: { originalRunId?: unknown; workflow?: unknown };
  },
): LiveWorkflowKnowledgeStopV1 | undefined {
  if (record.status !== "needs-input" || !isLiveKnowledgeStopReason(record.error)) return undefined;
  const receipt = record.knowledgeContinuationReceipt;
  const bound =
    receipt !== undefined &&
    receipt.originalRunId === record.id &&
    receipt.workflow === record.workflow;
  return Object.freeze({
    reason: record.error,
    ...(bound ? { resumeRunId: record.id } : {}),
  });
}

export function createLiveAgentToolDefinitions(input: {
  capabilities: LiveAgentCapabilities;
  runWorkflow: LiveWorkflowRunner;
  /** Host observation/admission callback. Model input supplies intent only. */
  prepareReaderTaskContext?: (
    request: LiveReaderTaskContextRequest,
  ) => Promise<ReaderTaskContextHandoffV1>;
  /** Direct reader-impact assessment is offered only when this is not true. */
  allowWrite?: boolean;
  /**
   * Inert labels for the evidence the host attached to this session, shown in
   * the tool description only. There is no tool parameter: a source binding is
   * a host grant, and the model must not choose its own evidence.
   */
  attachedSources?: readonly string[];
  /** Production supplies the shared strict retained-evidence projection. */
  projectEditorialOutcome?: (
    record: LiveWorkflowRun,
  ) => RunEditorialOutcomeV1 | Promise<RunEditorialOutcomeV1>;
  /** Host-projected objective completion; never inferred from model prose. */
  projectDocumentationWorkCompletion?: (
    record: LiveWorkflowRun,
  ) => DocumentationWorkCompletionV1 | undefined;
  /** Facts for the workflow result-change guard; ordinary dispatch is admitted when omitted. */
  resultChange?: TaskResultChangeFactsV1;
  /** Called once per run that returned a record, before the result reaches the model. */
  onWorkflowResult?: (result: LiveWorkflowResultObservationV1) => void;
  /**
   * Host binding of the model's request to the user's verbatim words. Returns
   * the instruction to parse and the never-parsed context, or throws a fixed
   * refusal. Omitted by read-only and delegated hosts.
   */
  bindWorkflowRequest?: (request: {
    readonly workflow: RunnableWorkflowName;
    readonly instruction: string;
    readonly context?: string;
  }) => LiveWorkflowBoundRequestV1;
  /**
   * After a refusal before any run record: a fixed prompt granting one verbatim
   * resubmission, or `undefined` to surface the refusal. The host never
   * supplies replacement text.
   */
  requestResubmission?: (
    error: unknown,
  ) => { readonly code: string; readonly text: string } | undefined;
  /**
   * Content-free record of a call refused at invocation admission or reader
   * handoff. The runner wrapper never sees these refusals, so the turn gate
   * records them only through this.
   */
  onInvocationRefused?: (refusal: {
    readonly workflow: string;
    readonly code?: InvocationContractErrorCode;
  }) => void;
  /** Host-owned objective admission before skill/workflow side effects. */
  documentationWork?: {
    selectSkill: (skillId: CatalogSkillId) => void;
    markSkillLoaded: (skillId: CatalogSkillId) => void;
    selectWorkflow: (workflowId: RunnableWorkflowName) => void;
  };
}): AnyToolDefinition[] {
  const skillIds = input.capabilities.skills.map((skill) => skill.lock.id);
  const workflowIds = input.capabilities.workflows.map((workflow) => workflow.name);
  const hostCapabilities = {
    crateVerified: true,
    allowWrite: input.allowWrite === true,
    observationSupplierAvailable: Boolean(
      input.capabilities.readerTaskContextSupplier && input.prepareReaderTaskContext,
    ),
  };
  const assessmentSkills = availableAssessmentSkills(input.capabilities.skills, hostCapabilities);
  const readerProperties = {
    readerContext: readerContextInputToolSchema(),
    readerComparison: readerComparisonToolSchema(),
    readerSources: readerSourceToolSchema(),
  };
  const guidance = liveInvocationGuidance(assessmentSkills, workflowIds);
  const readerIntake = readerIntakeWorkflows(workflowIds);
  return [
    {
      name: "docsfab_use_skill",
      label: "Use DocsFab skill",
      description: `Load a locked DocsFab skill or one of its packaged supporting references. ${guidance} Use this tool, not the repository read tool, for installed skill files. Loading instructions grants no additional permissions.`,
      promptSnippet: "Load one locked DocsFab skill for focused work",
      parameters: {
        type: "object" as const,
        // Keep resumed calls with incidental reader fields eligible for instruction-only loading.
        additionalProperties: true,
        required: ["skill"],
        properties: {
          skill: {
            type: "string" as const,
            enum: skillIds,
            description: "Exact installed DocsFab skill id.",
          },
          reference: {
            type: "string" as const,
            description:
              "Optional exact supporting-file path listed by the skill, such as references/review-methods.md. Omit to load SKILL.md.",
          },
          ...(assessmentSkills.length > 0 ? readerProperties : {}),
        },
      },
      async execute(_toolCallId, rawParameters) {
        const skillId = String((rawParameters as Record<string, unknown>).skill ?? "");
        const selected = input.capabilities.skills.find((skill) => skill.lock.id === skillId);
        if (!selected) {
          throw new Error(
            "DocsFab rejected the unknown live-agent skill selection; choose one installed skill.",
          );
        }
        input.documentationWork?.selectSkill(selected.lock.id);
        const reference = (rawParameters as Record<string, unknown>).reference;
        const path = reference === undefined ? "SKILL.md" : reference;
        // Resolve compatibility before reading instructions/references or observing evidence.
        let invocation: ReturnType<typeof resolveLiveSkillInvocation> | undefined;
        try {
          const metadata =
            selected.invocation ??
            (selected.lock.files.some((file) => file.path === "invocation.json")
              ? decodeSkillInvocationMetadata(
                  JSON.parse((await readLockedSkillFile(selected, "invocation.json")).content),
                )
              : undefined);
          if (metadata) {
            invocation = resolveLiveSkillInvocation({
              metadata,
              parameters: rawParameters as Record<string, unknown>,
              capabilities: hostCapabilities,
            });
          } else if (
            path !== "SKILL.md" &&
            suppliedReaderFields(rawParameters as Record<string, unknown>).length > 0
          ) {
            throw new InvocationContractError("unsupported-context", {
              fields: suppliedReaderFields(rawParameters as Record<string, unknown>),
              recovery: "retry-load-without-reader-fields",
            });
          }
        } catch (error) {
          invocationBridgeError(error);
        }
        const { content, sha256 } = await readLockedSkillFile(selected, path);
        if (path !== "SKILL.md") {
          const result = {
            content: [{ type: "text" as const, text: content }],
            details: {
              kind: "docsfab-live-skill-reference",
              skill: skillId,
              contentSha256: selected.lock.contentSha256,
              reference: path,
              sha256,
            },
          };
          // Supporting references do not load the main skill instructions.
          return result;
        }
        const readerContextValue = (rawParameters as Record<string, unknown>).readerContext;
        const acceptsReaderInput =
          invocation?.contract.operation === "load-reader-assessment-guidance";
        const readerSourceHints = acceptsReaderInput
          ? decodeReaderSourceHints((rawParameters as Record<string, unknown>).readerSources)
          : [];
        const readerComparison = acceptsReaderInput
          ? decodeReaderComparison((rawParameters as Record<string, unknown>).readerComparison)
          : undefined;
        let readerProjection: ReturnType<ReaderTaskContextSupplier["projectInput"]> | undefined;
        let readerHandoff: ReaderTaskContextHandoffV1 | undefined;
        const instructionOnlyInputs =
          !acceptsReaderInput &&
          suppliedReaderFields(rawParameters as Record<string, unknown>).length > 0;
        if (acceptsReaderInput && readerContextValue !== undefined) {
          const supplier = input.capabilities.readerTaskContextSupplier;
          if (!supplier || !input.prepareReaderTaskContext) {
            throw new Error(LIVE_SKILL_FAILURES.unavailable);
          }
          try {
            const validated = supplier.projectInput(readerContextValue, {
              inputOrigin: "explicit",
            });
            readerHandoff = supplier.validateHandoff(
              await input.prepareReaderTaskContext({
                consumer: { kind: "skill", id: skillId },
                readerContextInput: validated.readerContextInput,
                inputOrigin: "explicit",
                sourceHints: readerSourceHints,
                ...(readerComparison ? { comparisonRequest: readerComparison } : {}),
              }),
            );
            readerProjection = supplier.projectInput(validated.readerContextInput, {
              inputOrigin: "explicit",
              handoff: readerHandoff,
            });
          } catch (error) {
            rethrowLiveReaderSnapshotMismatch(error);
          }
        }
        const references = selected.lock.files
          .filter((file) => file.path !== "SKILL.md")
          .map((file) => file.path);
        const result = {
          content: [
            {
              type: "text" as const,
              text: `Apply the locked DocsFab skill ${skillId} to the current request.\nUse docsfab_use_skill with this skill and a reference path to read its packaged supporting files: ${references.join(", ") || "none"}. When judging documentation quality, consult the relevant verified profile or rubric through the read tool under .docsfab-governed-assets/quality. Available guidance files: ${input.capabilities.qualityGuidancePaths?.join(", ") || "use find within that directory"}. If editorial work reveals a technical claim that needs checking, load verify-technical-accuracy and apply it against the source before returning findings.\n\n${content}${readerProjection?.prompt ?? ""}${instructionOnlyInputs ? "\n\nThis call only loaded instructions. The optional reader context and source inputs were not admitted or verified. Use a bounded workflow when an admitted reader-evidence handoff is required." : ""}`,
            },
          ],
          details: {
            kind: "docsfab-live-skill",
            skill: skillId,
            contentSha256: selected.lock.contentSha256,
            ...(instructionOnlyInputs
              ? {
                  unadmittedReaderFields: suppliedReaderFields(
                    rawParameters as Record<string, unknown>,
                  ),
                }
              : {}),
            ...(readerHandoff
              ? {
                  readerTaskContextHandoffSha256: readerHandoff.handoffSha256,
                  noChangeAssessment: readerHandoff.noChangeAssessment,
                }
              : {}),
          },
        };
        input.documentationWork?.markSkillLoaded(selected.lock.id);
        return result;
      },
    },
    {
      name: "docsfab_run_workflow",
      label: "Run DocsFab workflow",
      description:
        (input.attachedSources && input.attachedSources.length > 0
          ? `This session has host-attached bound sources: ${input.attachedSources.join(", ")}. Every call binds exactly those; this tool has no parameter for selecting, adding, or dropping one. Do not restate their contents in instruction as if they were already read. `
          : "") +
        "Run one existing bounded DocsFab workflow for serious documentation work and return its result to this conversation. " +
        (readerIntake.length > 0
          ? `For ${readerIntake.join(", ")}, collect related repository evidence first and include it in readerSources, alongside the readerContext and requested readerComparison. Search existing reader-facing documentation for the changed concepts and include matching pages, even when the MR changed only contributor guidance. The changed-file list is not the documentation target list. Include the authoritative behavior or contributor contract as well as the documentation being assessed, using accurate source roles. The comparison defaults to the current workspace; it proves current content, not historical MR coverage. For an explicit base/head comparison, use verified revisions. MR summaries in context do not replace source-file bindings. Other workflows take no reader fields; omit them. `
          : "") +
        "If the workflow reports missing evidence available through repository or GitLab reads, retrieve it and retry with the completed handoff after confirming no changes were applied. Ask the user only for information those tools cannot establish.",
      promptSnippet: "Invoke one bounded DocsFab workflow",
      parameters: {
        type: "object" as const,
        additionalProperties: false,
        required: ["workflow", "instruction"],
        properties: {
          workflow: {
            type: "string" as const,
            enum: workflowIds,
            description: "Exact installed DocsFab workflow id.",
          },
          instruction: {
            type: "string" as const,
            description:
              "The user's documentation request in the user's own words, copied verbatim: the user's current message, or the user's consecutive messages ending at the current one joined by a blank line, with none skipped. Do not rephrase, restate, summarize, or add to it. DocsFab parses this text for targets, sources, and restrictions exactly as `docsfab run --instruction` does. Keep readerContext.reader_job short when supplied; do not copy this instruction into it.",
          },
          context: {
            type: "string" as const,
            description:
              "Optional. Everything you add: retrieved evidence, MR IDs, URLs, and diffs, evidence gaps, restatements, and summaries. DocsFab never parses this for targets, sources, or restrictions; the workflow sees it only as non-authoritative context. Do not add inferred prerequisites such as target-file absence.",
          },
          // Advertised only when an installed workflow takes them, and described
          // from the same declaration that admits them.
          ...(readerIntake.length > 0
            ? Object.fromEntries(
                Object.entries(readerProperties).map(([field, schema]) => [
                  field,
                  {
                    ...schema,
                    description: `Only for ${readerIntake.join(", ")}; other workflows start without it. ${"description" in schema ? schema.description : "Optional bounded reader request."}`,
                  },
                ]),
              )
            : {}),
        },
      },
      executionMode: "sequential" as const,
      async execute(_toolCallId, rawParameters, signal, onUpdate) {
        return withChildTaskActivity(
          String((rawParameters as Record<string, unknown>).workflow ?? ""),
          _toolCallId,
          async () => {
            assertWorkflowActive(signal);
            const parameters = rawParameters as Record<string, unknown>;
            const workflow = String(parameters.workflow ?? "");
            const requestedInstruction = String(parameters.instruction ?? "").trim();
            const requestedContext =
              typeof parameters.context === "string" && parameters.context.trim() !== ""
                ? parameters.context.trim()
                : undefined;
            if (!workflowIds.includes(workflow as RunnableWorkflowName)) {
              throw new Error(
                "DocsFab rejected the unknown live-agent workflow selection; choose one installed workflow.",
              );
            }
            if (!requestedInstruction) {
              throw new Error(
                "DocsFab live-agent workflows require a concrete documentation instruction before starting.",
              );
            }
            // The host binds the parsed instruction to the user's own words before
            // anything observes it; agent additions travel only as context. A
            // refusal the agent caused returns as a resubmission prompt.
            const resubmission = (error: unknown) => {
              const granted = input.requestResubmission?.(error);
              if (!granted) throw error;
              return {
                content: [{ type: "text" as const, text: granted.text }],
                details: { kind: "docsfab-live-workflow-resubmit", workflow, code: granted.code },
              };
            };
            let bound: LiveWorkflowBoundRequestV1;
            try {
              bound = input.bindWorkflowRequest
                ? input.bindWorkflowRequest({
                    workflow: workflow as RunnableWorkflowName,
                    instruction: requestedInstruction,
                    ...(requestedContext ? { context: requestedContext } : {}),
                  })
                : {
                    instruction: requestedInstruction,
                    ...(requestedContext ? { context: requestedContext } : {}),
                  };
            } catch (error) {
              return resubmission(error);
            }
            const instruction = bound.instruction;
            // A refusal between request binding and dispatch never reaches the
            // runner wrapper, so it is recorded on the host's turn record here.
            const recordRefusal = (error: unknown) =>
              input.onInvocationRefused?.({
                workflow,
                ...(error instanceof InvocationContractError ? { code: error.code } : {}),
              });
            try {
              input.documentationWork?.selectWorkflow(workflow as RunnableWorkflowName);
            } catch (error) {
              recordRefusal(error);
              return resubmission(error);
            }
            let invocation: ReturnType<typeof resolveLiveWorkflowInvocation>;
            try {
              invocation = resolveLiveWorkflowInvocation({
                planner: input.capabilities.skills.find(
                  (skill) => skill.lock.id === "plan-documentation",
                )?.invocation,
                workflow,
                parameters,
                capabilities: hostCapabilities,
              });
            } catch (error) {
              recordRefusal(error);
              invocationBridgeError(error);
            }
            let readerTaskContext: ReaderTaskContextHandoffV1 | undefined;
            const supplier = input.capabilities.readerTaskContextSupplier;
            // Reader fields a workflow does not take are never decoded, observed,
            // or handed to the run.
            if (invocation.readerIntake) {
              try {
                const rawReaderContext = parameters.readerContext;
                const readerSourceHints = decodeReaderSourceHints(parameters.readerSources);
                const readerComparison = decodeReaderComparison(parameters.readerComparison);
                if (supplier && input.prepareReaderTaskContext) {
                  const inputOrigin =
                    rawReaderContext === undefined ? "conservative-fallback" : "explicit";
                  const validated = supplier.projectInput(
                    rawReaderContext ?? conservativeReaderContextInput({ instruction }),
                    { inputOrigin },
                  );
                  readerTaskContext = supplier.validateHandoff(
                    await input.prepareReaderTaskContext({
                      consumer: { kind: "workflow", id: workflow as RunnableWorkflowName },
                      readerContextInput: validated.readerContextInput,
                      inputOrigin,
                      sourceHints: readerSourceHints,
                      requestText: instruction,
                      comparisonRequest: readerComparison ?? { kind: "workspace" },
                    }),
                  );
                  supplier.projectInput(readerTaskContext.readerContextInput, {
                    inputOrigin,
                    handoff: readerTaskContext,
                  });
                }
              } catch (error) {
                recordRefusal(error);
                rethrowLiveReaderSnapshotMismatch(error);
              }
            }
            assertTaskResultChangeAdmitted(
              { signal, ...input.resultChange },
              { kind: "dispatch-child-workflow" },
            );
            let record: LiveWorkflowRun;
            try {
              record = await runWorkflowWithTypedKnowledgeStop(
                input.runWorkflow,
                workflow as RunnableWorkflowName,
                instruction,
                (event, definition) => {
                  // Forward only stage identity/status, never provider text, summaries, or artifacts.
                  if (event.type !== "step-status" || definition.name !== workflow) return;
                  const index = definition.steps.findIndex((step) => step.id === event.stepId);
                  if (index < 0 || !/^[a-z0-9-]+$/u.test(event.stepId)) return;
                  const ordinal = isWorkflowManifestV2(definition)
                    ? {}
                    : { step: index + 1, total: definition.steps.length };
                  onUpdate?.({
                    content: [],
                    details: {
                      kind: "docsfab-live-workflow-progress",
                      workflow,
                      stepId: event.stepId,
                      ...ordinal,
                      status: event.status,
                    },
                  });
                },
                signal,
                readerTaskContext,
                bound.context,
              );
            } catch (error) {
              return resubmission(error);
            }
            let firstPassContradictionQuestion: FirstPassContradictionQuestionV1 | undefined;
            let firstPassChoiceAvailable: true | undefined;
            if (record.status === "needs-input" && record.firstPassContradiction !== undefined) {
              // Close direct changes before projection can refuse the saved question.
              // This initial observation contains no contradiction or question content.
              input.onWorkflowResult?.({
                runId: record.id,
                workflow: record.workflow,
                status: record.status,
                steps: record.steps.map((step) => ({ id: step.id, status: step.status })),
              });
              firstPassContradictionQuestion = decodeRunRecordFirstPassContradiction(
                record.firstPassContradiction,
              ).question;
              assertConfinedToolResultCredentialFree(firstPassContradictionQuestion);
              if (
                record.firstPassContradictionAdmission !== undefined &&
                decodeFirstPassContradictionAdmission(record.firstPassContradictionAdmission)
                  .outcome === "repository-only"
              ) {
                firstPassChoiceAvailable = true;
              }
            }
            const evidenceWarnings = liveWorkflowEvidenceWarnings(record.evidenceWarnings);
            const knowledgeStop = liveWorkflowKnowledgeStop(record);
            const inputAskSlots = editorialInputAskSlots(record).flatMap((slot) => {
              const presentation = editorialInputAskPresentationV1(slot.inputId);
              return presentation ? [{ inputId: slot.inputId, ...presentation }] : [];
            });
            const usedReaderTaskContext = readerTaskContext;
            const editorial = input.projectEditorialOutcome
              ? await input.projectEditorialOutcome(record)
              : projectRunEditorialOutcome(record);
            const runFailure = readRunFailure(record);
            const documentationWorkCompletion = input.projectDocumentationWorkCompletion?.(record);
            const result = {
              kind: "docsfab-live-workflow-result",
              runId: record.id,
              workflow: record.workflow,
              ...projectLiveWorkflowOutcome(record, { signal, editorial }),
              changes: record.changes,
              ...(usedReaderTaskContext
                ? {
                    readerTaskContextHandoffSha256: usedReaderTaskContext.handoffSha256,
                    noChangeAssessment: usedReaderTaskContext.noChangeAssessment,
                    evidenceLimitations:
                      usedReaderTaskContext.readerContextInput.known_limitations ?? [],
                  }
                : {}),
              ...(bound.contextOmittedChars
                ? { contextOmittedChars: bound.contextOmittedChars }
                : {}),
              ...(invocation.unadmittedFields.length > 0
                ? {
                    unadmittedReaderFields: invocation.unadmittedFields,
                    readerFieldsNote: unadmittedWorkflowReaderFieldsNote(readerIntake),
                  }
                : {}),
              ...(knowledgeStop ? { knowledgeStop } : {}),
              ...(documentationWorkCompletion ? { documentationWorkCompletion } : {}),
              ...(firstPassContradictionQuestion ? { firstPassContradictionQuestion } : {}),
              ...(firstPassChoiceAvailable ? { firstPassChoiceAvailable } : {}),
              ...(evidenceWarnings.length > 0 ? { evidenceWarnings } : {}),
              // Named inputs to relay to the user; catalog text only.
              ...(inputAskSlots.length > 0 ? { inputAskSlots } : {}),
              editorial,
              ...(runFailure ? { failure: runFailure } : {}),
              steps: record.steps.map((step) => {
                const failure = readStepFailure(step, record);
                return {
                  id: step.id,
                  status: step.status,
                  summary: step.summary,
                  error: step.error,
                  ...(failure ? { failure } : {}),
                };
              }),
            };
            const failedStep = result.steps.find((step) => step.status === "failed");
            input.onWorkflowResult?.({
              runId: result.runId,
              workflow: result.workflow,
              status: result.status,
              steps: result.steps.map((step) => ({ id: step.id, status: step.status })),
              ...(typeof result.error === "string" ? { error: result.error } : {}),
              ...(typeof failedStep?.error === "string" ? { stepError: failedStep.error } : {}),
              ...(typeof result.persistence.status === "string"
                ? { persistence: result.persistence.status }
                : {}),
              ...(firstPassContradictionQuestion ? { firstPassContradictionQuestion } : {}),
              ...(firstPassChoiceAvailable ? { firstPassChoiceAvailable } : {}),
              ...(inputAskSlots.length > 0
                ? { inputAskInputIds: inputAskSlots.map((slot) => slot.inputId) }
                : {}),
            });
            return {
              content: [{ type: "text" as const, text: JSON.stringify(result) }],
              details: result,
            };
          },
          signal,
        );
      },
    },
  ];
}

/**
 * Run the bounded workflow, relaying a pre-record knowledge stop as its type.
 *
 * The tool boundary keeps only a thrown error's message, so the coded
 * diagnostic is the one channel that carries the stop reason to the terminal.
 * Every other failure is re-raised untouched.
 */
async function runWorkflowWithTypedKnowledgeStop(
  run: LiveWorkflowRunner,
  ...parameters: Parameters<LiveWorkflowRunner>
): Promise<LiveWorkflowRun> {
  try {
    return await run(...parameters);
  } catch (error) {
    if (error instanceof KnowledgeResumeError && isLiveKnowledgeStopReason(error.code)) {
      throw new Error(LIVE_KNOWLEDGE_STOP_DIAGNOSTICS[error.code]);
    }
    if (error instanceof KnowledgeContinuationError) {
      // The stop is real; only its retention failed. The continuation code names
      // internal bookkeeping, not an operator category, so it is dropped.
      throw new Error(LIVE_KNOWLEDGE_STOP_NOT_RETAINED);
    }
    throw error;
  }
}

/** Read only an exact locked file and verify the returned bytes, including after startup. */
async function readLockedSkillFile(selected: LiveAgentSkill, path: unknown) {
  const locked = selected.lock.files.find((file) => file.path === path);
  if (
    !locked ||
    typeof path !== "string" ||
    isAbsolute(path) ||
    path.split(/[\\/]/u).includes("..")
  ) {
    throw new Error(
      "DocsFab rejected the skill file; choose an exact locked reference listed by docsfab_use_skill.",
    );
  }
  const root = selected.directory;
  const integrityError = new Error(
    "DocsFab skill integrity verification failed. Reinstall the package and start a new session.",
  );
  let target = root;
  try {
    if ((await realpath(root)) !== root)
      throw new Error("The locked skill directory must resolve to its original location.");
    for (const segment of path.split("/")) {
      target = resolve(target, segment);
      if (!target.startsWith(`${root}${sep}`) || (await lstat(target)).isSymbolicLink())
        throw new Error("The locked skill reference must remain inside its original directory.");
    }
    const content = await readFile(target);
    if (createHash("sha256").update(content).digest("hex") !== locked.sha256) {
      throw integrityError;
    }
    return { content: content.toString("utf8"), sha256: locked.sha256 };
  } catch (error) {
    if (error === integrityError) throw error;
    throw new Error(
      "DocsFab could not read the locked skill file safely. Reinstall the package and start a new session.",
    );
  }
}
