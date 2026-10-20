// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * First-pass prelude for stranger repositories: hydrate is handled by project
 * config bootstrap; this binds a knowledge snapshot before create/update.
 * Knowledge remains the provider; the runtime only imports the sealed snapshot
 * and resumes the original Task. Restructure stays out of this prelude.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, posix, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  decodeKnowledgeAcceptedSnapshot,
  type KnowledgeResumeReceiptV1,
} from "../canon/from-knowledge-snapshot.js";
import type { DocsFabConfig } from "../config/runtime-loader.js";
import {
  createFirstRunProposalScopeBinding,
  rejectDocumentationTargets,
  rejectFirstRunProposalScope,
  rejectRepeatedDocumentationTargets,
  type FirstRunProposalScopeBinding,
  type RefusedDocumentationTarget,
} from "../init/first-run-bootstrap.js";
import { DOCSFAB_PROJECT_CONFIG_FILE } from "../init/types.js";
import {
  assertResumeMatchesOriginal,
  firstPassIntentWriteTargets,
  inspectSnapshotValue,
  inspectKnowledgeSnapshotResume,
  instructionSha256,
  isDocumentationResumeWorkflow,
  KnowledgeResumeError,
  knowledgeResumeNeedsInputMessage,
  ORIGINAL_TASK_PATH,
  readOriginalTaskBinding,
  writeOriginalTaskBinding,
} from "./knowledge-resume.js";
import {
  createFirstPassSupportModelBridge,
  firstPassOperatorBinding,
  firstPassHostLimits,
  firstPassModelBudget,
  firstPassModelDeadlineMs,
  firstPassEvidenceGapLines,
  firstPassLimitationStatus,
  documentationFileRootRule,
  documentationRstUpdatePathRule,
  documentationPageShapeRule,
  documentationWriteTargetRule,
  type DocumentationRootPolicy,
  FirstPassSupportValidationError,
  type FirstPassHostLimits,
  type FirstPassModelBudget,
  type DocumentationPartialProjection,
  type FirstPassEvidenceFrameParser,
  type FirstPassSupportModelCallEvidence,
  type FirstPassSupportModelBridge,
  validateFirstPassSupport,
} from "./first-pass-support.js";
import { DurableArtifactStore, opaqueRecordDigest } from "../artifacts/store.js";
import { assertBoundSourcesTracked } from "./run/source-acquisition.js";
import { FirstPassChoiceContinuationError } from "./run/first-pass-choice-continuation.js";
import { createFirstPassReplay, type FirstPassReplayV1 } from "../records/first-pass-replay.js";
import { bindReadingSources, boundDirectoryStatus } from "./first-pass-reading-sources.js";
import type { TrackedSourceReaderV1 } from "../inputs/source-acquisition.js";
import type { RunRequestWithPublishProjection } from "./run/request.js";
import type { CompositionRunRuntime } from "./run/composition-runtime.js";
import type { FirstPassDocumentationTargetControl } from "../workflow-execution/runner.js";
import { requiresOperatorNaming } from "../repository/agent-instruction-files.js";
import { containsConfiguredCredential } from "../security/configured-credentials.js";
import {
  sanitizeDisplayText,
  toOperatorErrorEnvelope,
  type OperatorErrorEnvelope,
} from "../operator/error-envelope.js";
import {
  FIRST_PASS_FAILURE_LOCATION,
  FIRST_PASS_FAILURE_PHASES,
  FIRST_PASS_FAILURE_RULES,
  type FirstPassFailureRule,
} from "../operator/pre-record-failure.js";
import { compareText } from "../shared/primitives.js";
import {
  ensurePrivateStateDirectory,
  PrivateStateError,
  readPrivateStateFile,
} from "../shared/private-state.js";
import {
  REQUEST_INTENT_CONSTRAINT_KINDS,
  type RequestIntentV1,
} from "../request-intent/contract.js";
import { limit, OperationalLimitError } from "../config/limits.js";
import { declaredRequestIntentOperation } from "../request-intent/interpret.js";
import { decodeRunRecordRequestIntent } from "../request-intent/interpret-record.js";
import { RequestIntentContractError } from "../request-intent/kit.js";
import { assertWorkflowActive, WorkflowCancelledError } from "../execution/cancellation.js";
import {
  DocumentationRootsOutsideWriteRootsError,
  DEFAULT_DOCUMENTATION_WRITE_ROOTS,
  documentationPlanWriteScope,
  droppedDocumentationRootsStatus,
  firstPassDocumentationWriteRoots,
  rstWriteScopeAllows,
} from "./first-pass/documentation-write-scope.js";
export {
  DocumentationRootsOutsideWriteRootsError,
  DEFAULT_DOCUMENTATION_WRITE_ROOTS,
  documentationPlanWriteScope,
  droppedDocumentationRootsStatus,
  firstPassDocumentationWriteRoots,
} from "./first-pass/documentation-write-scope.js";

export const FIRST_PASS_KNOWLEDGE_SNAPSHOT_PATH =
  ".docsfab/reference-model/knowledge-accepted-snapshot.json";
export const FIRST_PASS_SUPPORT_FAILURE_KIND = "docsfab-first-pass-support-failure" as const;
const FIRST_PASS_FAILURE_CODES = new Set([
  "assessment-invalid",
  "bound-source-unavailable",
  "budget-exhausted",
  "credential-material",
  "decomposition-omission",
  "insufficient-evidence",
  "model-unavailable",
  "first-pass-model-boundary",
  "unsafe-target",
]);

/**
 * Knowledge codes that identity-pass onto the operator envelope at this
 * adapter. Do not recode knowledge internals or invent a rename.
 */
const FIRST_PASS_ENVELOPE_IDENTITY_CODES = new Set([
  "invalid-revision",
  "unsafe-target",
  "bound-source-unavailable",
]);

export interface FirstPassSupportFailureEvidenceV1 {
  readonly schemaVersion: 1;
  readonly kind: typeof FIRST_PASS_SUPPORT_FAILURE_KIND;
  readonly phase: string;
  readonly rule: string;
  readonly location: string;
  readonly instructionSha256: string;
  readonly repositoryRevision: string;
  readonly modelCalls: {
    readonly started: number | null;
    readonly completed: number | null;
  };
  /**
   * Hinted correction rounds the stopping phase spent; `null` when the
   * knowledge provider reported none, as for a stop outside a model answer.
   */
  readonly corrections: number | null;
  readonly lastPromptSha256: string | null;
  readonly lastResponseSha256: string | null;
  readonly lastIdentitySha256: string | null;
  readonly evidenceSha256: string;
}

export class FirstPassSupportPreflightError extends Error {
  public readonly name = "FirstPassSupportPreflightError";
  public readonly code = "first-pass-support-invalid";
  public readonly retryable = false;

  public constructor(public readonly evidence: FirstPassSupportFailureEvidenceV1) {
    super(
      `First-pass support stopped in ${evidence.phase} at ${evidence.location} under rule ${evidence.rule}.`,
    );
  }
}

const OBLIGATION_CONDITION_LIMIT = "firstPass.maxObligationConditionChars";
const CONSTRAINT_KINDS: ReadonlySet<string> = new Set(REQUEST_INTENT_CONSTRAINT_KINDS);

/**
 * An admitted constraint longer, as written, than one first-pass obligation
 * condition, which first pass records whole. The code is the bound's catalog
 * refusal, so the stop is classified `bound` and names the bound, the
 * observed length, and the remediation; the scope names the constraint.
 */
export class FirstPassConstraintLimitError extends OperationalLimitError {
  public constructor(
    observed: number,
    public readonly constraint: {
      readonly kind: string;
      readonly start: number;
      readonly end: number;
    },
  ) {
    super(limit(OBLIGATION_CONDITION_LIMIT), observed);
    this.message = `${this.message} Scope: the request's ${constraint.kind} constraint, characters ${String(constraint.start)} to ${String(constraint.end)} of the request as written. No model call was made.`;
  }
}

/**
 * The knowledge provider's stop for a constraint over the obligation
 * condition bound, as that bound's refusal. Every other error, including a
 * `budget-exhausted` stop at the source budget, returns `undefined`.
 */
export function constraintConditionLimitError(
  error: unknown,
): FirstPassConstraintLimitError | undefined {
  if (!(error instanceof Error) || error.name !== "FirstPassSupportError") return undefined;
  const carried = error as Error & { readonly limit?: unknown; readonly constraint?: unknown };
  if (!isRecord(carried.limit) || !isRecord(carried.constraint)) return undefined;
  const { name, observed } = carried.limit;
  const { kind, start, end } = carried.constraint;
  if (
    name !== OBLIGATION_CONDITION_LIMIT ||
    typeof kind !== "string" ||
    !CONSTRAINT_KINDS.has(kind) ||
    !Number.isSafeInteger(observed) ||
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    (end as number) - (start as number) !== observed
  ) {
    return undefined;
  }
  return new FirstPassConstraintLimitError(observed as number, {
    kind,
    start: start as number,
    end: end as number,
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Knowledge reducer / evidence failures that cross this adapter once.
 * Already-projected first-pass and resume errors pass through unchanged.
 */
export class KnowledgeAdapterOperatorError extends Error {
  public readonly name = "KnowledgeAdapterOperatorError";
  public readonly code: string;
  public readonly envelope: OperatorErrorEnvelope;

  public constructor(cause: unknown) {
    const envelope =
      cause instanceof KnowledgeAdapterOperatorError
        ? cause.envelope
        : toOperatorErrorEnvelope(cause);
    super(envelope.message);
    this.code = envelope.code;
    this.envelope = envelope;
  }
}

/** Wrap a knowledge-provider throw once for the runtime operator envelope. */
export function wrapKnowledgeAdapterFailure(error: unknown): Error {
  if (error instanceof FirstPassSupportPreflightError) return error;
  if (error instanceof KnowledgeResumeError) return error;
  if (error instanceof KnowledgeAdapterOperatorError) return error;
  return new KnowledgeAdapterOperatorError(error);
}

export type FirstPassStatus = (message: string) => void;

export interface FirstPassKnowledgeBinding {
  readonly completed: true;
  readonly canonSnapshotPath?: string;
  readonly acceptCandidateSnapshot?: boolean;
  readonly canonSnapshotAuthorityId?: string;
  readonly knowledgeResumeReceipt?: KnowledgeResumeReceiptV1;
  readonly firstPassTargetControl?: FirstPassDocumentationTargetControl;
  /** Host-only identity of the exact snapshot bytes first pass wrote. */
  readonly gatheredSnapshot?: {
    readonly sha256: string;
    readonly replacedTracked: boolean;
  };
  /**
   * The limitation lines of a first pass that continued with evidence gaps
   * (#2113). The run records them with first pass's other notices in
   * `RunRecord.evidenceWarnings`.
   */
  readonly firstPassEvidenceWarnings?: readonly string[];
}

interface OrdinaryDocumentationRequest {
  readonly workflow: "create-documentation" | "update-documentation";
  readonly instruction: string;
  readonly instructionSha256: string;
  readonly repositoryRevision: string;
  readonly targetPaths: readonly string[];
  readonly dependencyPaths?: readonly string[];
  /** Present only when the provider actually used destination-sensitive parsing. */
  readonly scopePurpose?: "negative-write-scope";
  /** Optional destination-only refusal from a provider that understands the probe purpose. */
  readonly scopeRefusal?: "unsafe-target";
  /** Exact witnessed spelling for display only; never a target or filesystem operand. */
  readonly originalTarget?: string;
}

/** The negative probe's outside-root and unsafe-path refusal. */
export class ExplicitDocumentationWriteScopeError extends Error {
  public readonly code = "request-intent-outside-write-scope" as const;
  public readonly nextAction: string;

  public constructor(targets: readonly string[], roots: readonly string[]) {
    const quote = (path: string) => JSON.stringify(sanitizeDisplayText(path));
    const display = targets.map(quote).join(", ");
    const granted = roots.map(quote).join(", ") || "none";
    const directories = roots
      .filter((root) => root.endsWith("/"))
      .map(quote)
      .join(", ");
    const files = roots
      .filter((root) => !root.endsWith("/"))
      .map(quote)
      .join(", ");
    const locationAction =
      roots.length === 0
        ? "Choose a permitted page or documentation directory."
        : !directories
          ? `Name an exact permitted file: ${files}.`
          : !files
            ? `Name a page inside ${directories}.`
            : `Name an exact permitted file (${files}) or a page inside ${directories}.`;
    const nextAction = `${locationAction} To change the scope for a permitted page or documentation directory, update documentationRoots in .docsfab.json, commit the change, and start a new request.`;
    super(
      `DocsFab cannot write ${display || "the explicitly named destination"}: it is outside this run's documentation write scope. Granted documentation roots: ${granted}. ${nextAction}`,
    );
    this.name = "ExplicitDocumentationWriteScopeError";
    this.nextAction = nextAction;
  }
}

type OrdinaryDocumentationRequestParser = (input: {
  readonly workflow: string;
  readonly instruction: string;
  readonly revision: string;
  readonly purpose?: "negative-write-scope";
  /** Visible regular files of the exact revision, for negative-only basename resolution. */
  readonly repositoryPaths?: readonly string[];
}) => OrdinaryDocumentationRequest | undefined;

/** Protocol constants of the plain intent projection the knowledge provider decodes. */
export const FIRST_PASS_REQUEST_INTENT_KIND = "docsfab-first-pass-request-intent" as const;
export const FIRST_PASS_REQUEST_INTENT_SCHEMA_VERSION = 1 as const;

/**
 * The admitted reading first pass binds from, as plain JSON, because the
 * knowledge provider may not import the runtime. Quote offsets index the NFC
 * instruction, as in the sealed intent.
 */
export interface FirstPassRequestIntentProjection {
  readonly schemaVersion: typeof FIRST_PASS_REQUEST_INTENT_SCHEMA_VERSION;
  readonly kind: typeof FIRST_PASS_REQUEST_INTENT_KIND;
  readonly instructionSha256: string;
  readonly operation: RequestIntentV1["operation"];
  /** Role `write` only, less exclusions, one spelling per case-folded path, in `compareText` order. */
  readonly writeTargets: readonly string[];
  readonly sources: RequestIntentV1["sources"];
  readonly preserve: RequestIntentV1["preserve"];
  readonly exclusions: RequestIntentV1["exclusions"];
  readonly constraints: RequestIntentV1["constraints"];
  readonly authorityPreference: RequestIntentV1["authorityPreference"];
}

/**
 * The one gate first pass reads the recorded interpretation through. It
 * verifies the record against the instruction before reading any field, and
 * returns the projection only for an `admitted` outcome. `undefined` is the
 * no-intent arm: no record, a run the interpretation did not read (`offline`,
 * `not-applicable`, `continuation`), or a reading the run went on past as an
 * `advisory`. An advisory reading is model output no admission granted, so it
 * binds nothing, and first pass reads the request as it does without one: a
 * create whose words name no page still stops with `ambiguous-targets`. A
 * record that does not verify, or an outcome that stopped the run, refuses
 * with `proposal-scope-binding-mismatch`: neither may fall back to the
 * request wording.
 */
export function admittedFirstPassRequestIntent(
  request: Pick<RunRequestWithPublishProjection, "requestIntent" | "instruction" | "workflow">,
  revision?: string,
): FirstPassRequestIntentProjection | undefined {
  if (request.requestIntent === undefined) return undefined;
  const refusal = {
    instructionSha256: instructionSha256(request.instruction),
    ...(revision ? { repositoryRevision: revision } : {}),
  };
  let recorded: ReturnType<typeof decodeRunRecordRequestIntent>;
  try {
    recorded = decodeRunRecordRequestIntent(request.requestIntent, request.instruction);
  } catch (error) {
    // Only a contract fault: a record or sealed intent that does not verify
    // against this instruction. Anything else is not a binding answer.
    if (error instanceof RequestIntentContractError) {
      rejectFirstRunProposalScope("proposal-scope-binding-mismatch", refusal);
    }
    throw error;
  }
  const outcome = recorded.admission.outcome;
  if (
    outcome === "offline" ||
    outcome === "not-applicable" ||
    outcome === "continuation" ||
    outcome === "advisory"
  ) {
    return undefined;
  }
  // A question carries a sealed intent too; only admission grants a binding.
  if (outcome !== "admitted" || recorded.intent === null) {
    rejectFirstRunProposalScope("proposal-scope-binding-mismatch", refusal);
  }
  const intent = recorded.intent;
  if (intent.operation !== declaredRequestIntentOperation(request.workflow)) {
    rejectFirstRunProposalScope("proposal-scope-binding-mismatch", refusal);
  }
  return Object.freeze({
    schemaVersion: FIRST_PASS_REQUEST_INTENT_SCHEMA_VERSION,
    kind: FIRST_PASS_REQUEST_INTENT_KIND,
    instructionSha256: intent.instructionSha256,
    operation: intent.operation,
    writeTargets: Object.freeze(firstPassIntentWriteTargets(intent)),
    sources: intent.sources,
    preserve: intent.preserve,
    exclusions: intent.exclusions,
    constraints: intent.constraints,
    authorityPreference: intent.authorityPreference,
  });
}

export { firstPassIntentWriteTargets };

export async function bindFirstRunProposalScope(input: {
  readonly request: RunRequestWithPublishProjection;
  readonly config: DocsFabConfig;
  readonly revision: string;
  /**
   * The tracked `.docsfab.json` `documentationRoots`: the write roots a named
   * page must lie in, as far as `documentationRootPolicy` lets them reach.
   */
  readonly documentationRoots?: readonly string[];
  /** Omitted, configured roots only narrow `docs/` and `fern/`. Local runs pass `local-widen`. */
  readonly documentationRootPolicy?: DocumentationRootPolicy;
  /** The configured roots the revision tracks as regular files, each a file root. */
  readonly documentationRootFiles?: readonly string[];
  readonly rstUpdatePaths?: readonly string[];
  /** Installed-provider test seam. Production loads the same provider used by first-pass gather. */
  readonly ordinaryRequestParser?: OrdinaryDocumentationRequestParser;
}): Promise<FirstRunProposalScopeBinding | undefined> {
  const workflow = input.request.workflow;
  const instruction = input.request.instruction;
  if (
    !input.request.allowWrite ||
    !isDocumentationResumeWorkflow(workflow) ||
    instruction === undefined
  )
    return undefined;
  const refusal = {
    instructionSha256: instructionSha256(instruction),
    repositoryRevision: input.revision,
  };
  // An admitted intent names the pages; the request words are not read again.
  const intent = admittedFirstPassRequestIntent(input.request, input.revision);
  const requestedTargets = intent
    ? await actionableIntentTargets(input.config, intent, instruction, workflow, refusal)
    : await parsedRequestTargets(input, workflow, instruction, refusal);
  if (requestedTargets === undefined || requestedTargets.length === 0) return undefined;
  if (
    requestedTargets.some((path) => path.endsWith(".rst")) &&
    (workflow !== "update-documentation" ||
      input.request.patchOnly !== true ||
      requestedTargets.length !== 1 ||
      !input.rstUpdatePaths?.includes(requestedTargets[0]!))
  ) {
    rejectFirstRunProposalScope("proposal-scope-input-invalid", refusal);
  }
  if (requestedTargets.includes(DOCSFAB_PROJECT_CONFIG_FILE)) {
    rejectFirstRunProposalScope("proposal-scope-input-invalid", refusal);
  }
  validateNamedDocumentationTargets(input, requestedTargets, refusal);
  const configTarget = explicitProjectConfigTarget(instruction, requestedTargets);
  if (configTarget === "ambiguous") {
    rejectFirstRunProposalScope("proposal-scope-ambiguous-targets", refusal);
  }
  const targetPaths = [
    ...requestedTargets,
    ...(configTarget === "included" ? [DOCSFAB_PROJECT_CONFIG_FILE] : []),
  ].sort(compareText);
  return createFirstRunProposalScopeBinding({
    workflow,
    instructionSha256: instructionSha256(instruction),
    repositoryRevision: input.revision,
    targetPaths,
  });
}

/**
 * Check explicit output scope before request interpretation can ask about a
 * model-omitted target. A successful parse grants nothing: its paths are only
 * checked against the same roots as first-pass binding, then discarded.
 */
export async function preflightExplicitDocumentationWriteScope(
  input: Parameters<typeof bindFirstRunProposalScope>[0] & {
    readonly repositoryPaths?: readonly string[];
  },
): Promise<void> {
  const workflow = input.request.workflow;
  const instruction = input.request.instruction;
  if (
    !input.request.allowWrite ||
    !isDocumentationResumeWorkflow(workflow) ||
    instruction === undefined
  )
    return;
  const refusal = {
    instructionSha256: instructionSha256(instruction),
    repositoryRevision: input.revision,
  };
  const parser =
    input.ordinaryRequestParser ?? (await loadOrdinaryDocumentationRequestParser(input.config));
  let parsed: OrdinaryDocumentationRequest | undefined;
  try {
    parsed = parser({
      workflow,
      instruction,
      revision: input.revision,
      purpose: "negative-write-scope",
      ...(input.repositoryPaths ? { repositoryPaths: input.repositoryPaths } : {}),
    });
  } catch (error) {
    // Older providers scan unsafe source mentions globally. Only their known
    // ordinary-grammar refusals are inconclusive here; the normal route owns
    // their interpretation. Unrelated provider faults must remain visible.
    if (
      error instanceof Error &&
      error.name === "FirstPassSupportError" &&
      "code" in error &&
      [
        "unsafe-target",
        "ambiguous-targets",
        "conflicting-targets",
        "duplicate-targets",
        "non-actionable-targets",
      ].includes(String(error.code))
    )
      return;
    throw error;
  }
  if (parsed === undefined) return;
  if (
    parsed === null ||
    typeof parsed !== "object" ||
    Array.isArray(parsed) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(parsed))
  ) {
    throw new KnowledgeProviderOperatorError(
      "The knowledge request parser returned a malformed scope result.",
    );
  }
  // Main's legacy parser ignores purpose, and its positive paths can include
  // read-only context. An unmarked result cannot make an early scope decision.
  if (parsed.scopePurpose === undefined) return;
  if (parsed.scopePurpose !== "negative-write-scope") {
    throw new KnowledgeProviderOperatorError(
      "The knowledge request parser returned an unknown scope purpose.",
    );
  }
  if (
    parsed.workflow !== workflow ||
    parsed.instruction !== instruction ||
    parsed.instructionSha256 !== refusal.instructionSha256 ||
    parsed.repositoryRevision !== input.revision
  )
    rejectFirstRunProposalScope("proposal-scope-binding-mismatch", refusal);
  if (
    !Array.isArray(parsed.targetPaths) ||
    !parsed.targetPaths.every((path) => typeof path === "string") ||
    !Array.isArray(parsed.dependencyPaths) ||
    !parsed.dependencyPaths.every((path) => typeof path === "string")
  )
    throw new KnowledgeProviderOperatorError(
      "The knowledge request parser returned malformed scope paths.",
    );
  // Inspect only an own data field. Legacy providers omit it; accessors and
  // unrelated text cannot inject diagnostics or become filesystem authority.
  const diagnostic = Object.getOwnPropertyDescriptor(parsed, "originalTarget");
  if (
    diagnostic &&
    (!("value" in diagnostic) ||
      typeof diagnostic.value !== "string" ||
      !/\.(?:mdx?|rst)$/iu.test(diagnostic.value) ||
      /[\s\u0000-\u001f\u007f-\u009f]/u.test(diagnostic.value) ||
      !instruction.includes(diagnostic.value))
  ) {
    throw new KnowledgeProviderOperatorError(
      "The knowledge request parser returned malformed scope diagnostics.",
    );
  }
  const originalTarget = diagnostic?.value as string | undefined;
  const outsideScope = (targets: readonly string[], roots?: readonly string[]): never => {
    const effectiveRoots =
      roots ??
      firstPassDocumentationWriteRoots(
        input.documentationRoots,
        input.documentationRootPolicy ?? "narrow",
        input.documentationRootFiles ?? [],
        input.rstUpdatePaths,
      ).roots;
    throw new ExplicitDocumentationWriteScopeError(
      originalTarget ? [originalTarget] : targets,
      effectiveRoots,
    );
  };
  if (parsed.scopeRefusal !== undefined) {
    if (
      parsed.scopeRefusal !== "unsafe-target" ||
      parsed.targetPaths.length !== 0 ||
      parsed.dependencyPaths.length !== 0
    )
      throw new KnowledgeProviderOperatorError(
        "The knowledge request parser returned a malformed scope refusal.",
      );
    outsideScope([]);
  }
  if (parsed.targetPaths.length === 0) return;
  if (parsed.targetPaths.includes(DOCSFAB_PROJECT_CONFIG_FILE)) {
    rejectFirstRunProposalScope("proposal-scope-input-invalid", refusal);
  }
  const pageShapeRule = (path: string) =>
    workflow === "update-documentation" && path.endsWith(".rst")
      ? documentationRstUpdatePathRule(path, input.documentationRootPolicy ?? "narrow")
      : documentationPageShapeRule(path);
  const negativeTargets = parsed.targetPaths.map((path) =>
    path.startsWith("./") ? path.slice(2) : path,
  );
  const rejectUnsafePrivateSpellings = () => {
    for (const path of parsed.targetPaths) {
      if (!posix.isAbsolute(path) && pageShapeRule(path) === "page-path") {
        // This comparison chooses only a refusal. It is never a write/source
        // target, filesystem operand, or operator-name grant. Keep unsafe special
        // spellings and malformed names on the existing private refusal path.
        // Absolute operands are outside the repository regardless of host ancestors.
        const refusalPath = posix.resolve("/", path).slice(1);
        if (requiresOperatorNaming(refusalPath) || pageShapeRule(refusalPath) === "page-path")
          rejectFirstRunProposalScope("proposal-scope-unsafe-target", refusal);
      }
    }
  };
  validateNamedDocumentationTargets(input, negativeTargets, refusal, (refused, roots) => {
    // Canonical input eligibility, including UPDATE-only RST, runs first.
    rejectUnsafePrivateSpellings();
    // Protected pages retain the owner's specific rule, code, and remediation.
    // Preserve every refused path when protected and outside pages are mixed.
    if (
      refused.some(
        (target) =>
          target.rule === "protected-path" ||
          (target.rule !== "page-path" && requiresOperatorNaming(target.path)),
      )
    ) {
      rejectDocumentationTargets(
        refused,
        roots,
        refusal,
        input.documentationRootPolicy ?? "narrow",
      );
    }
    return outsideScope(
      parsed.targetPaths.filter((_, index) =>
        refused.some((target) => target.path === negativeTargets[index]),
      ),
      roots,
    );
  });
  rejectUnsafePrivateSpellings();
}

/** One root/write rule for normal binding and the early negative probe. */
function validateNamedDocumentationTargets(
  input: Parameters<typeof bindFirstRunProposalScope>[0],
  requestedTargets: readonly string[],
  refusal: { readonly instructionSha256: string; readonly repositoryRevision: string },
  onRefused?: (refused: readonly RefusedDocumentationTarget[], roots: readonly string[]) => never,
): void {
  if (
    requestedTargets.some((path) => path.endsWith(".rst")) &&
    (input.request.workflow !== "update-documentation" ||
      input.request.patchOnly !== true ||
      requestedTargets.length !== 1 ||
      !input.rstUpdatePaths?.includes(requestedTargets[0]!))
  ) {
    rejectFirstRunProposalScope("proposal-scope-input-invalid", refusal);
  }
  // The one documentation write rule, narrowed by the project's configured
  // roots. Roots narrowed to none are the configuration refusal a path-less
  // first pass gives too. Every refused page is named; none is dropped silently.
  const policy = input.documentationRootPolicy ?? "narrow";
  const trackedFiles = input.documentationRootFiles ?? [];
  const { roots, dropped } = firstPassDocumentationWriteRoots(
    input.documentationRoots,
    policy,
    trackedFiles,
    input.rstUpdatePaths,
  );
  if (roots.length === 0 && dropped.length > 0) {
    throw new DocumentationRootsOutsideWriteRootsError(dropped, policy, { trackedFiles });
  }
  const refused: RefusedDocumentationTarget[] = requestedTargets.flatMap((path) => {
    const rule = input.rstUpdatePaths?.includes(path)
      ? rstWriteScopeAllows(path, roots, policy)
        ? undefined
        : (documentationRstUpdatePathRule(path, policy) ?? "configured-roots")
      : documentationWriteTargetRule(path, roots, policy);
    return rule === undefined ? [] : [{ path, rule }];
  });
  if (refused.length > 0) {
    if (onRefused) onRefused(refused, roots);
    rejectDocumentationTargets(refused, roots, refusal, policy);
  }
}

/**
 * The admitted write targets, still narrowed by the request's own words: a
 * page whose every mention, in any path form admission grounds, is negated,
 * deferred, asked about, or kept unchanged refuses with
 * `proposal-scope-non-actionable-targets`. The provider's guard applies the
 * no-intent parser's own rules to those mentions. The installed provider owns
 * that guard; one without it refuses rather than binding unguarded.
 */
async function actionableIntentTargets(
  config: DocsFabConfig,
  intent: FirstPassRequestIntentProjection,
  instruction: string,
  workflow: "create-documentation" | "update-documentation",
  refusal: { readonly instructionSha256: string; readonly repositoryRevision: string },
): Promise<readonly string[]> {
  const guard = await loadNonActionableTargetGuard(config);
  const nonActionable: unknown = guard(instruction, intent.writeTargets, workflow);
  if (!Array.isArray(nonActionable)) {
    throw new KnowledgeProviderOperatorError(
      "The knowledge first-pass support module returned no page list from nonActionableNamedTargets.",
    );
  }
  // Only a page the request names and never asks to change; an inventory or
  // proposed-new page the words do not name is outside this guard.
  if (nonActionable.length > 0) {
    rejectFirstRunProposalScope("proposal-scope-non-actionable-targets", refusal);
  }
  return intent.writeTargets;
}

/**
 * The no-intent arm: the installed provider's request parser, unchanged, with
 * its refusals mapped onto proposal-scope codes. `undefined` when it binds no
 * named page.
 */
async function parsedRequestTargets(
  input: Parameters<typeof bindFirstRunProposalScope>[0],
  workflow: "create-documentation" | "update-documentation",
  instruction: string,
  refusal: { readonly instructionSha256: string; readonly repositoryRevision: string },
): Promise<readonly string[] | undefined> {
  const parser =
    input.ordinaryRequestParser ?? (await loadOrdinaryDocumentationRequestParser(input.config));
  let parsed: OrdinaryDocumentationRequest | undefined;
  try {
    parsed = parser({ workflow, instruction, revision: input.revision });
  } catch (error) {
    if (error && typeof error === "object" && "code" in error) {
      // Owner decision on #1914 (note 72956288): the provider binds a repeated
      // page once when every mention asks for a change to it. It refuses one
      // that a mention excludes, reads, or leaves unclear, and either refusal
      // names the page.
      if (error.code === "duplicate-targets") {
        rejectRepeatedDocumentationTargets(namedDetailTargets(error), refusal);
      }
      const readTargets = namedDetailTargets(error, TARGET_AND_READ_CONDITION);
      if (error.code === "conflicting-targets" && readTargets.length > 0) {
        rejectRepeatedDocumentationTargets(readTargets, refusal);
      }
      const code =
        error.code === "unsafe-target"
          ? "proposal-scope-unsafe-target"
          : error.code === "conflicting-targets"
            ? "proposal-scope-conflicting-targets"
            : error.code === "ambiguous-targets"
              ? "proposal-scope-ambiguous-targets"
              : // Every named page is negated, deferred, or asked about.
                error.code === "non-actionable-targets"
                ? "proposal-scope-non-actionable-targets"
                : undefined;
      if (code) rejectFirstRunProposalScope(code, refusal);
      if (firstPassEnvelopeIdentityError(error)) throw error;
    }
    throw error;
  }
  if (!parsed) return undefined;
  if (parsed.targetPaths.length === 0) return undefined;
  if (
    parsed.workflow !== workflow ||
    parsed.instruction !== instruction ||
    parsed.instructionSha256 !== instructionSha256(instruction) ||
    parsed.repositoryRevision !== input.revision
  ) {
    rejectFirstRunProposalScope("proposal-scope-binding-mismatch", refusal);
  }
  return parsed.targetPaths;
}

export function firstRunProposalTargetControl(
  proposalScope: FirstRunProposalScopeBinding,
): FirstPassDocumentationTargetControl {
  const targetPaths = proposalScope.targetPaths.filter(
    (targetPath) => targetPath !== DOCSFAB_PROJECT_CONFIG_FILE,
  );
  if (targetPaths.length === 0) rejectFirstRunProposalScope("proposal-scope-input-invalid");
  const body = {
    workflow: proposalScope.workflow,
    instructionSha256: proposalScope.instructionSha256,
    repositoryRevision: proposalScope.repositoryRevision,
    targetPaths,
  };
  return Object.freeze({
    ...body,
    targetPaths: Object.freeze([...targetPaths]),
    bodySha256: createHash("sha256").update(JSON.stringify(body), "utf8").digest("hex"),
  });
}

export function needsFirstPassKnowledge(
  request: Pick<RunRequestWithPublishProjection, "workflow" | "allowWrite" | "canonSnapshotPath">,
): boolean {
  return (
    request.allowWrite &&
    isDocumentationResumeWorkflow(request.workflow) &&
    request.canonSnapshotPath === undefined
  );
}

/**
 * Route the installed V2 update workflow through first-pass knowledge when the
 * host admitted a bounded multi-page proposal scope, or when an ordinary update
 * names its pages but has no proposalScope yet. The admitted intent's write
 * targets answer that; without one, the provider's request parser does, so
 * source-led assessments keep their planner route. An update that
 * names no page also keeps it: the planner chooses the existing pages, and
 * first pass has no target to bind. An explicit canon snapshot continues to
 * suppress acquisition through `needsFirstPassKnowledge`.
 */
export async function needsFirstPassKnowledgeForExecution(
  request: Pick<
    RunRequestWithPublishProjection,
    "workflow" | "allowWrite" | "canonSnapshotPath" | "instruction" | "requestIntent"
  >,
  workflow: { readonly schemaVersion?: 1 | 2 | 3 },
  proposalScope: FirstRunProposalScopeBinding | undefined,
  input: { readonly config: DocsFabConfig; readonly revision: string },
): Promise<boolean> {
  if (!needsFirstPassKnowledge(request)) return false;
  if (request.workflow !== "update-documentation" || workflow.schemaVersion !== 2) {
    return true;
  }
  const documentationTargets =
    proposalScope?.targetPaths.filter((path) => path !== DOCSFAB_PROJECT_CONFIG_FILE).length ?? 0;
  if (documentationTargets > 1) return true;
  if (proposalScope !== undefined) return false;
  if (!request.instruction) return false;
  // An admitted intent already answered which pages it names.
  const intent = admittedFirstPassRequestIntent(request, input.revision);
  if (intent) return intent.writeTargets.length > 0;
  const parser = await loadOrdinaryDocumentationRequestParser(input.config);
  const parsed = parser({
    workflow: request.workflow,
    instruction: request.instruction,
    revision: input.revision,
  });
  return parsed !== undefined && parsed.targetPaths.length > 0;
}

export async function bindFirstPassKnowledge(input: {
  readonly request: RunRequestWithPublishProjection;
  readonly config: DocsFabConfig;
  readonly workspacePath: string;
  readonly revision: string;
  readonly firstPassChoices?: readonly import("./run/first-pass-choice-continuation.js").BoundFirstPassChoiceV1[];
  readonly firstPassReplay?: FirstPassReplayV1;
  readonly status: FirstPassStatus;
  readonly signal?: AbortSignal;
  readonly compositionRuntime?: CompositionRunRuntime;
  /** Provider-bound test seam. Production constructs the governed bridge above. */
  readonly supportModelBridge?: FirstPassSupportModelBridge;
  /**
   * Host-authorized documentation write prefixes. Omit to derive them from
   * `documentationRoots`, or the default docs/fern set without them.
   */
  readonly authorizedWriteRoots?: readonly string[];
  /** The project's `.docsfab.json` `documentationRoots`, when it declares them. */
  readonly documentationRoots?: readonly string[];
  /** Omitted, configured roots only narrow `docs/` and `fern/`. Local runs pass `local-widen`. */
  readonly documentationRootPolicy?: DocumentationRootPolicy;
  /** The configured roots the revision tracks as regular files, each a file root. */
  readonly documentationRootFiles?: readonly string[];
  readonly rstUpdatePaths?: readonly string[];
  /**
   * Tracked-set reader for `--source` selections, required whenever the request
   * carries any. Production passes the same reader source acquisition uses.
   */
  readonly trackedSourceReader?: TrackedSourceReaderV1;
  /**
   * Receives each coded notice for a source the admitted reading names that
   * first pass does not bind, as it is decided and before any first-pass
   * model call, so the run record keeps it whatever happens next.
   */
  readonly notice?: (line: string) => void;
}): Promise<FirstPassKnowledgeBinding | undefined> {
  if (!needsFirstPassKnowledge(input.request)) return undefined;
  const workflow = input.request.workflow;
  if (!isDocumentationResumeWorkflow(workflow)) return undefined;
  const intent = admittedFirstPassRequestIntent(input.request, input.revision);
  const documentationRootPolicy = input.documentationRootPolicy ?? "narrow";
  const rootFiles = input.documentationRootFiles ?? [];
  const configuredRoots =
    input.authorizedWriteRoots === undefined
      ? firstPassDocumentationWriteRoots(
          input.documentationRoots,
          documentationRootPolicy,
          rootFiles,
          input.rstUpdatePaths,
        )
      : undefined;
  // The provider reads its roots as directories: a file root grants a named
  // page only, which the binding above already checked, never a new page. An
  // embedder's own roots pass through as it wrote them.
  const authorizedWriteRoots = Object.freeze(
    configuredRoots
      ? configuredRoots.roots.filter((root) => root.endsWith("/"))
      : [...(input.authorizedWriteRoots ?? [])],
  );
  const fileRoots = configuredRoots?.roots.filter((root) => !root.endsWith("/")) ?? [];
  const dropped = configuredRoots?.dropped ?? [];
  // Configuration left no write root: a configuration refusal, not an
  // InputAsk, because no operator answer can grant one. Refuse before gather
  // and before a tracked snapshot, so the refusal never depends on the
  // provider raising its own authorization stop. A create needs a directory.
  if (
    authorizedWriteRoots.length === 0 &&
    (fileRoots.length > 0 ? workflow === "create-documentation" : dropped.length > 0)
  ) {
    throw new DocumentationRootsOutsideWriteRootsError(dropped, documentationRootPolicy, {
      trackedFiles: rootFiles,
      fileRoots,
    });
  }

  const boundSourcePaths = input.request.sourcePaths ?? [];
  if (boundSourcePaths.length > 0) {
    // Fail closed rather than silently skipping the check: an embedder that
    // forgets the reader must not get weaker admission than the CLI.
    if (!input.trackedSourceReader) {
      throw new Error(
        "First-pass knowledge binding requires a tracked-source reader when the request selects sources.",
      );
    }
    await assertBoundSourcesTracked({
      reader: input.trackedSourceReader,
      sourcePaths: boundSourcePaths,
    });
  }

  const existing = join(input.workspacePath, FIRST_PASS_KNOWLEDGE_SNAPSHOT_PATH);
  const existingSnapshot = await readSnapshotFile(existing);
  if (input.firstPassChoices?.length && existingSnapshot !== undefined) {
    throw new FirstPassChoiceContinuationError("ineligible"); // hygiene: ok -- stable typed code; the constructor supplies the operator-safe message.
  }
  if (existingSnapshot !== undefined) {
    const inspection = inspectSnapshotValue(existingSnapshot, input.request.instruction, intent);
    if (
      intent &&
      inspection.snapshot.status === "candidate" &&
      inspection.disposition === "needs-input" &&
      inspection.stopReason === "insufficient-evidence"
    ) {
      const notice =
        `first-pass-snapshot-superseded: candidate snapshot ${inspection.snapshot.snapshotSha256} ` +
        "does not support the admitted request; gathering fresh repository support";
      input.notice?.(notice);
      input.status(sanitizeDisplayText(notice));
    } else {
      input.status("using tracked knowledge snapshot already in this revision");
      await rememberOriginalTask(input.workspacePath, workflow, input.request.instruction);
      return bindingFromSnapshot({
        value: existingSnapshot,
        snapshotPath: existing,
        instruction: input.request.instruction,
        ...(intent ? { intent } : {}),
      });
    }
  }

  // Sources the admitted reading names beyond the operator's selections. Only
  // a gathering first pass binds them, so a tracked snapshot above never
  // reads them; the binding keys on the intent, not on any `--source`.
  const readingSources = intent ? readingOnlySources(intent, boundSourcePaths) : [];
  const readingReader = input.trackedSourceReader;
  if (readingSources.length > 0 && !readingReader) {
    // hygiene: ok -- embedder wiring fault; the CLI always passes the reader, as for --source above.
    throw new Error(
      "First-pass knowledge binding requires a tracked-source reader when the admitted request intent names sources.",
    );
  }

  // Sized before gathering starts; a configuration without the resolved retry
  // policy is refused with a coded error.
  const modelBudget = firstPassModelBudget(input.config);
  // The firstPass.* acquisition bounds and deadlines, with host overrides, and
  // evidence bytes sized to the admitted window of the model first pass is
  // bound to: the composition's, or the operator binding the bridge connects
  // through. A binding that fails sizes nothing; the bridge reports it.
  const operatorBinding =
    input.compositionRuntime || input.supportModelBridge
      ? undefined
      : firstPassOperatorBinding(input.config);
  const hostLimits = firstPassHostLimits({
    budget: modelBudget,
    model:
      input.compositionRuntime?.executionProfile ??
      (await operatorBinding?.then(
        (binding) => binding.profile,
        () => undefined,
      )),
    modelDeadlineMs: firstPassModelDeadlineMs(input.compositionRuntime),
  });
  // The selected revision's tracked files: acquisition lists these instead of
  // walking the exported tree, so a named or relevant source anywhere is reachable.
  const trackedFiles = await input.trackedSourceReader?.listTrackedRegularFiles?.();
  const replacedTrackedSnapshot =
    existingSnapshot !== undefined &&
    trackedFiles?.includes(FIRST_PASS_KNOWLEDGE_SNAPSHOT_PATH) === true;
  // The reading is model output, so no source it names stops the run: a
  // tracked file or directory binds within the source budget the provider
  // counts (`firstPassHostLimits` reads the same limit), and anything else is
  // a coded notice. Deciding reads the tracked set only, never a file's bytes.
  const reading =
    intent && readingReader && readingSources.length > 0
      ? await bindReadingSources({
          reader: readingReader,
          trackedFiles,
          sources: readingSources,
          selected: boundSourcePaths,
          writeTargets: intent.writeTargets,
          sourceBudget: limit("firstPass.maxSourceFiles"),
        })
      : undefined;
  for (const notice of reading?.notices ?? []) {
    input.notice?.(notice.line);
    input.status(sanitizeDisplayText(notice.line));
  }
  for (const directory of reading?.directories ?? []) {
    input.status(sanitizeDisplayText(boundDirectoryStatus(directory)));
  }
  const finish = async (result: {
    readonly snapshot: unknown;
    readonly support?: unknown;
    readonly assessmentIdentitySha256?: string;
    readonly assessmentBindingSha256?: string;
    readonly sourceCount?: number;
    readonly modelVersionId?: string;
    readonly authorizationStop?: KnowledgeGatherResult["authorizationStop"];
    readonly replay?: FirstPassReplayV1;
  }): Promise<FirstPassKnowledgeBinding> => {
    const snapshotBytes = `${JSON.stringify(result.snapshot, null, 2)}\n`;
    await mkdir(dirname(existing), { recursive: true });
    await writeFile(existing, snapshotBytes);
    const gatheredSnapshot = {
      sha256: createHash("sha256").update(snapshotBytes).digest("hex"),
      replacedTracked: replacedTrackedSnapshot,
    } as const;
    if (result.sourceCount !== undefined && result.modelVersionId !== undefined)
      input.status(
        `registered ${String(result.sourceCount)} source${result.sourceCount === 1 ? "" : "s"}; candidate model ${result.modelVersionId}`,
      );
    await rememberOriginalTask(input.workspacePath, workflow, input.request.instruction);
    if (result.authorizationStop?.code === "needs-authorization") {
      const authorizationReason = "needs-authorization" as const;
      throw new KnowledgeResumeError(
        authorizationReason,
        knowledgeResumeNeedsInputMessage(authorizationReason),
      );
    }
    const binding = await bindingFromSnapshot({
      value: result.snapshot,
      snapshotPath: existing,
      instruction: input.request.instruction,
      workspacePath: input.workspacePath,
      workflow,
      revision: input.revision,
      support: result.support,
      ...(input.firstPassChoices?.length ? { firstPassChoices: input.firstPassChoices } : {}),
      ...(result.replay ? { replay: result.replay } : {}),
      intent,
      instructionTargetPaths:
        result.support === undefined || input.request.instruction === undefined
          ? undefined
          : intent
            ? intent.writeTargets
            : (await loadOrdinaryDocumentationRequestParser(input.config))({
                workflow,
                instruction: input.request.instruction,
                revision: input.revision,
              })?.targetPaths,
      expectedAssessmentIdentitySha256: result.assessmentIdentitySha256,
      expectedAssessmentBindingSha256: result.assessmentBindingSha256,
      modelBudget,
      hostLimits,
      classifyPartial: (support) =>
        classifyAndStoreDocumentationPartial({
          config: input.config,
          support,
          instruction: input.request.instruction ?? "",
          repositoryPath: input.workspacePath,
          authorizedWriteRoots,
        }),
    });
    const gapLines = [
      ...new Set(
        (binding.firstPassEvidenceWarnings ?? [])
          .map((line) => sanitizeDisplayText(line))
          .filter((line) => line.length > 0),
      ),
    ];
    for (const line of gapLines) input.status(line);
    if (gapLines.length > 0) {
      return {
        ...binding,
        gatheredSnapshot,
        firstPassEvidenceWarnings: Object.freeze(gapLines),
      };
    }
    const limitationStatus = firstPassLimitationStatus(result.support);
    if (limitationStatus !== undefined) input.status(sanitizeDisplayText(limitationStatus));
    return { ...binding, gatheredSnapshot };
  };
  if (input.firstPassReplay) {
    if (!input.firstPassChoices?.length) throw new FirstPassChoiceContinuationError("ineligible"); // hygiene: ok -- stable typed code; the constructor supplies the operator-safe message.
    input.status("rechecking the saved first-pass assessment against repository evidence");
    return finish({
      snapshot: input.firstPassReplay.snapshot,
      support: input.firstPassReplay.support,
      assessmentIdentitySha256: input.firstPassReplay.assessmentIdentitySha256,
      assessmentBindingSha256: input.firstPassReplay.assessmentBindingSha256,
      replay: input.firstPassReplay,
    });
  }
  input.status("gathering product evidence from the repository");
  const dataDirectory = resolve(
    dirname(input.config.stateDirectory),
    "knowledge",
    "first-pass",
    input.revision.replace(/[^A-Za-z0-9._-]/gu, "_").slice(0, 64) || "HEAD",
  );
  await ensurePrivateStateDirectory(
    dataDirectory,
    resolve(dirname(input.config.stateDirectory), "knowledge"),
  );
  const modelBridge =
    input.supportModelBridge ??
    createFirstPassSupportModelBridge({
      config: input.config,
      repositoryRevision: input.revision,
      loadEvidenceFrameParser: () => loadEvidenceFrameParser(input.config),
      ...(input.signal ? { signal: input.signal } : {}),
      ...(input.compositionRuntime ? { compositionRuntime: input.compositionRuntime } : {}),
      ...(operatorBinding ? { operatorBinding } : {}),
    });
  const gather = await loadKnowledgeGatherer(input.config);
  let result: KnowledgeGatherResult;
  try {
    result = await gather({
      repositoryPath: input.workspacePath,
      dataDirectory,
      revision: input.revision,
      workflow,
      modelCall: modelBridge.call,
      // Only DocsFab's own configured credentials stop the first pass (#1807);
      // credential-like repository content is read and reported as a finding.
      containsCredentialMaterial: containsConfiguredCredential,
      // The host sizes this budget and the model bridge counts the same one.
      modelBudget: {
        maxCorrections: modelBudget.maxCorrections,
        evidenceExpansionModelTurns: modelBudget.evidenceExpansionModelTurns,
        inputTokensPerTurn: modelBudget.inputTokensPerTurn,
        outputTokensPerTurn: modelBudget.outputTokensPerTurn,
      },
      firstPassLimits: { ...hostLimits },
      ...(trackedFiles ? { trackedFiles: [...trackedFiles] } : {}),
      authorizedWriteRoots,
      ...(input.request.instruction ? { instruction: input.request.instruction } : {}),
      // The provider binds these pages instead of reading the request for them,
      // and of the reading's sources only the files bound above.
      ...(intent ? { requestIntent: { ...intent, sources: reading?.sources ?? [] } } : {}),
      // The gate runs before source acquisition; without this it would not see
      // `--source` selections, and one the scan allowlist omits would be dropped.
      ...(boundSourcePaths.length > 0 ? { boundSourcePaths: [...boundSourcePaths] } : {}),
    });
    assertWorkflowActive(input.signal);
  } catch (error) {
    if (error instanceof WorkflowCancelledError) {
      try {
        await persistFirstPassCancellation(dataDirectory, {
          schemaVersion: 1,
          kind: "docsfab-first-pass-cancellation",
          code: error.code,
          instructionSha256: instructionSha256(input.request.instruction),
          repositoryRevision: input.revision,
          modelCallEvidence: safeCancellationModelCallEvidence(modelBridge),
        });
      } catch (persistenceError) {
        throw new WorkflowCancelledError({ cause: persistenceError });
      }
      throw error;
    }
    const authorization = knowledgeResumeFromAuthorizationError(error);
    if (authorization) throw authorization;
    if (firstPassEnvelopeIdentityError(error)) throw error;
    const constraintLimit = constraintConditionLimitError(error);
    if (constraintLimit) throw constraintLimit;
    const diagnostic = projectFirstPassSupportFailure(error, {
      instructionSha256: instructionSha256(input.request.instruction),
      repositoryRevision: input.revision,
      modelCallEvidence: modelBridge.failureEvidence?.(),
    });
    if (!diagnostic) throw wrapKnowledgeAdapterFailure(error);
    await persistFirstPassSupportFailure(dataDirectory, diagnostic);
    throw new FirstPassSupportPreflightError(diagnostic);
  }
  return finish({
    ...result,
    assessmentIdentitySha256: modelBridge.lastAssessmentIdentitySha256(),
    assessmentBindingSha256: modelBridge.lastAssessmentBindingSha256(),
  });
}

/**
 * The intent's sources the operator did not also select, once each. A source
 * that is one of the intent's write targets is that target, not a read source.
 */
function readingOnlySources(
  intent: FirstPassRequestIntentProjection,
  selected: readonly string[],
): readonly FirstPassRequestIntentProjection["sources"][number][] {
  const skip = new Set([...selected, ...intent.writeTargets]);
  const sources: FirstPassRequestIntentProjection["sources"][number][] = [];
  for (const source of intent.sources) {
    if (skip.has(source.path)) continue;
    skip.add(source.path);
    sources.push(source);
  }
  return sources;
}

async function rememberOriginalTask(
  workspacePath: string,
  workflow: "create-documentation" | "update-documentation",
  instruction: string | undefined,
): Promise<void> {
  const original = await readOriginalTaskBinding(workspacePath);
  const next = {
    schemaVersion: 1 as const,
    kind: "docsfab-original-task" as const,
    workflow,
    instructionSha256: instructionSha256(instruction),
  };
  if (original) {
    assertResumeMatchesOriginal({ workflow, instruction, original });
    return;
  }
  await mkdir(dirname(join(workspacePath, ORIGINAL_TASK_PATH)), {
    recursive: true,
  });
  await writeOriginalTaskBinding(workspacePath, next);
}

async function readSnapshotFile(snapshotPath: string): Promise<unknown | undefined> {
  let text: string;
  try {
    text = await readFile(snapshotPath, "utf8");
  } catch {
    return undefined;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error(
      `Existing ${FIRST_PASS_KNOWLEDGE_SNAPSHOT_PATH} is not a valid knowledge snapshot.`,
    );
  }
}

async function bindingFromSnapshot(input: {
  value: unknown;
  snapshotPath: string;
  instruction: string | undefined;
  workspacePath?: string;
  workflow?: "create-documentation" | "update-documentation";
  revision?: string;
  support?: unknown;
  firstPassChoices?: readonly import("./run/first-pass-choice-continuation.js").BoundFirstPassChoiceV1[];
  replay?: FirstPassReplayV1;
  instructionTargetPaths?: readonly string[];
  expectedAssessmentIdentitySha256?: string;
  expectedAssessmentBindingSha256?: string;
  modelBudget?: FirstPassModelBudget;
  hostLimits?: FirstPassHostLimits;
  classifyPartial?: (support: unknown) => Promise<DocumentationPartialProjection | undefined>;
  /** The admitted intent, which picks the page a snapshot without support is inspected for. */
  intent?: FirstPassRequestIntentProjection;
}): Promise<FirstPassKnowledgeBinding> {
  if (
    input.support !== undefined &&
    input.workspacePath !== undefined &&
    input.workflow !== undefined &&
    input.revision !== undefined &&
    input.instruction !== undefined
  ) {
    const snapshot = decodeKnowledgeAcceptedSnapshot(input.value);
    const resume = inspectKnowledgeSnapshotResume(snapshot);
    if (resume.disposition === "needs-input" && resume.stopReason) {
      throw new KnowledgeResumeError(
        resume.stopReason,
        knowledgeResumeNeedsInputMessage(resume.stopReason),
        resume.receipt,
      );
    }
    let resolvedIds: ReadonlySet<string> = new Set();
    let discrepancyLines: readonly string[] = [];
    if (
      input.replay &&
      JSON.stringify(input.replay.targetPaths) !== JSON.stringify(input.instructionTargetPaths)
    )
      throw new FirstPassChoiceContinuationError("stale"); // hygiene: ok -- stable typed code; the constructor supplies the operator-safe message.
    let firstPassTargetControl: FirstPassDocumentationTargetControl;
    try {
      firstPassTargetControl = await validateFirstPassSupport({
        support: input.support,
        ...(input.firstPassChoices?.length ? { firstPassChoices: input.firstPassChoices } : {}),
        authorityPreference: input.intent?.authorityPreference,
        onResolvedContradictions: (ids, lines) => {
          resolvedIds = ids;
          discrepancyLines = lines;
        },
        workspacePath: input.workspacePath,
        workflow: input.workflow,
        instruction: input.instruction,
        instructionTargetPaths: input.instructionTargetPaths ?? [],
        revision: input.revision,
        snapshotSha256: snapshot.snapshotSha256,
        ...(input.expectedAssessmentIdentitySha256
          ? { expectedAssessmentIdentitySha256: input.expectedAssessmentIdentitySha256 }
          : {}),
        ...(input.expectedAssessmentBindingSha256
          ? { expectedAssessmentBindingSha256: input.expectedAssessmentBindingSha256 }
          : {}),
        ...(input.modelBudget ? { modelBudget: input.modelBudget } : {}),
        ...(input.hostLimits ? { hostLimits: input.hostLimits } : {}),
        ...(input.classifyPartial ? { classifyPartial: input.classifyPartial } : {}),
      });
    } catch (error) {
      if (
        error instanceof FirstPassSupportValidationError &&
        error.code === "contradicted" &&
        input.expectedAssessmentIdentitySha256 &&
        input.expectedAssessmentBindingSha256 &&
        input.instructionTargetPaths
      ) {
        error.replay =
          input.replay ??
          createFirstPassReplay({
            snapshot: input.value,
            support: input.support,
            targetPaths: input.instructionTargetPaths,
            assessmentIdentitySha256: input.expectedAssessmentIdentitySha256,
            assessmentBindingSha256: input.expectedAssessmentBindingSha256,
          });
      }
      throw error;
    }
    const warnings = [
      ...discrepancyLines,
      ...firstPassEvidenceGapLines(input.support, resolvedIds),
    ];
    return {
      completed: true,
      firstPassTargetControl,
      ...(warnings.length > 0 ? { firstPassEvidenceWarnings: Object.freeze(warnings) } : {}),
    };
  }
  const inspection = inspectSnapshotValue(input.value, input.instruction, input.intent);
  if (inspection.disposition === "needs-input" && inspection.stopReason) {
    throw new KnowledgeResumeError(
      inspection.stopReason,
      knowledgeResumeNeedsInputMessage(inspection.stopReason),
      inspection.receipt,
    );
  }
  return {
    completed: true,
    ...(inspection.snapshot.status === "candidate"
      ? {}
      : { canonSnapshotPath: input.snapshotPath }),
    ...(inspection.receipt ? { knowledgeResumeReceipt: inspection.receipt } : {}),
  };
}

interface KnowledgeGatherResult {
  readonly snapshot: unknown;
  readonly projectId: string;
  readonly modelVersionId: string;
  readonly sourceCount: number;
  readonly support?: unknown;
  readonly authorizationStop?: {
    readonly code: "needs-authorization";
    readonly message: string;
  };
}

function knowledgeResumeFromAuthorizationError(error: unknown): KnowledgeResumeError | undefined {
  if (error instanceof KnowledgeResumeError && error.code === "needs-authorization") {
    return error;
  }
  if (
    error instanceof Error &&
    error.name === "FirstPassSupportError" &&
    "code" in error &&
    (error as { code?: unknown }).code === "needs-authorization"
  ) {
    return new KnowledgeResumeError("needs-authorization", error.message);
  }
  return undefined;
}

/**
 * The `condition` under which the knowledge provider lists a page the request
 * names both as a target and as a read or kept page. Its refusal is a repeated
 * page the request does not ask to change in every mention.
 */
const TARGET_AND_READ_CONDITION = "named as a target and as a read or kept page";

/**
 * The target paths a knowledge refusal lists in its structured `details`,
 * optionally only those under one `condition`. An older provider lists none,
 * and the refusal keeps its fixed message.
 */
function namedDetailTargets(error: object, condition?: string): readonly string[] {
  const details = (error as { readonly details?: unknown }).details;
  if (!Array.isArray(details)) return [];
  return details.flatMap((item: unknown) => {
    if (!item || typeof item !== "object") return [];
    const { targetPath, condition: listedCondition } = item as {
      readonly targetPath?: unknown;
      readonly condition?: unknown;
    };
    if (condition !== undefined && listedCondition !== condition) return [];
    return typeof targetPath === "string" ? [targetPath] : [];
  });
}

function firstPassEnvelopeIdentityError(
  error: unknown,
): error is Error & { readonly code: string } {
  if (!(error instanceof Error) || !("code" in error)) return false;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && FIRST_PASS_ENVELOPE_IDENTITY_CODES.has(code);
}

function projectFirstPassSupportFailure(
  error: unknown,
  binding: {
    instructionSha256: string;
    repositoryRevision: string;
    modelCallEvidence?: FirstPassSupportModelCallEvidence;
  },
): FirstPassSupportFailureEvidenceV1 | undefined {
  if (
    !(error instanceof Error) ||
    !["FirstPassSupportError", "FirstPassSupportModelCallError"].includes(error.name)
  ) {
    return undefined;
  }
  const candidate = error as Error & {
    code?: unknown;
    phase?: unknown;
    rule?: unknown;
    location?: unknown;
    corrections?: unknown;
  };
  if (typeof candidate.code !== "string" || !FIRST_PASS_FAILURE_CODES.has(candidate.code)) {
    return undefined;
  }
  const fallback = fallbackFirstPassDiagnostic(candidate.code);
  const phase =
    typeof candidate.phase === "string" && FIRST_PASS_FAILURE_PHASES.has(candidate.phase)
      ? candidate.phase
      : fallback?.phase;
  const rule =
    typeof candidate.rule === "string" && FIRST_PASS_FAILURE_RULES.has(candidate.rule)
      ? candidate.rule
      : fallback?.rule;
  const location =
    typeof candidate.location === "string" && FIRST_PASS_FAILURE_LOCATION.test(candidate.location)
      ? candidate.location
      : fallback?.location;
  if (
    !phase ||
    !rule ||
    !location ||
    !/^[a-f0-9]{64}$/u.test(binding.instructionSha256) ||
    !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(binding.repositoryRevision)
  ) {
    return undefined;
  }
  const calls = binding.modelCallEvidence;
  const body = {
    schemaVersion: 1 as const,
    kind: FIRST_PASS_SUPPORT_FAILURE_KIND,
    phase,
    rule,
    location,
    instructionSha256: binding.instructionSha256,
    repositoryRevision: binding.repositoryRevision,
    modelCalls: {
      started: calls?.modelCallsStarted ?? null,
      completed: calls?.modelCallsCompleted ?? null,
    },
    corrections:
      Number.isSafeInteger(candidate.corrections) && Number(candidate.corrections) >= 0
        ? Number(candidate.corrections)
        : null,
    lastPromptSha256: safeOptionalSha256(calls?.lastPromptSha256),
    lastResponseSha256: safeOptionalSha256(calls?.lastResponseSha256),
    lastIdentitySha256: safeOptionalSha256(calls?.lastIdentitySha256),
  };
  return Object.freeze({
    ...body,
    modelCalls: Object.freeze(body.modelCalls),
    evidenceSha256: createHash("sha256").update(JSON.stringify(body), "utf8").digest("hex"),
  });
}

function fallbackFirstPassDiagnostic(
  code: unknown,
): { phase: string; rule: FirstPassFailureRule; location: string } | undefined {
  switch (code) {
    case "credential-material":
      return { phase: "request", rule: "credential-material", location: "$instruction" };
    case "unsafe-target":
      return { phase: "request", rule: "unsafe-target", location: "$instruction" };
    case "model-unavailable":
      return { phase: "request", rule: "model-unavailable", location: "$response" };
    case "insufficient-evidence":
      return {
        phase: "evidence-acquisition",
        rule: "insufficient-evidence",
        location: "$repository",
      };
    case "bound-source-unavailable":
      return {
        phase: "evidence-acquisition",
        rule: "bound-source-unavailable",
        location: "$repository",
      };
    case "budget-exhausted":
      return { phase: "assessment", rule: "budget-exhausted", location: "$response" };
    case "decomposition-omission":
      return { phase: "assessment", rule: "decomposition-omission", location: "$response" };
    case "assessment-invalid":
      return { phase: "assessment", rule: "assessment-invalid", location: "$response" };
    default:
      return undefined;
  }
}

function safeOptionalSha256(value: string | null | undefined): string | null {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value) ? value : null;
}

interface FirstPassCancellationModelCallEvidenceV1 {
  readonly modelCallsStarted: number | null;
  readonly modelCallsCompleted: number | null;
  readonly lastPromptSha256: string | null;
  readonly lastResponseSha256: string | null;
  readonly lastIdentitySha256: string | null;
}

function safeCancellationModelCallEvidence(
  bridge: FirstPassSupportModelBridge,
): FirstPassCancellationModelCallEvidenceV1 | null {
  try {
    const evidence = bridge.failureEvidence?.();
    if (!evidence) return null;
    const counter = (value: number) => (Number.isSafeInteger(value) && value >= 0 ? value : null);
    return {
      modelCallsStarted: counter(evidence.modelCallsStarted),
      modelCallsCompleted: counter(evidence.modelCallsCompleted),
      lastPromptSha256: safeOptionalSha256(evidence.lastPromptSha256),
      lastResponseSha256: safeOptionalSha256(evidence.lastResponseSha256),
      lastIdentitySha256: safeOptionalSha256(evidence.lastIdentitySha256),
    };
  } catch {
    return null;
  }
}

async function persistFirstPassSupportFailure(
  dataDirectory: string,
  evidence: FirstPassSupportFailureEvidenceV1,
): Promise<void> {
  const directory = join(dataDirectory, "failures");
  await ensurePrivateStateDirectory(directory, dataDirectory);
  const destination = join(directory, `${evidence.evidenceSha256}.json`);
  const body = `${JSON.stringify(evidence, null, 2)}\n`;
  await writeFile(destination, body, { mode: 0o600, flag: "wx" }).catch(async (error: unknown) => {
    if (error && typeof error === "object" && "code" in error && error.code === "EEXIST") {
      const existing = await readPrivateStateFile(destination);
      if (existing.equals(Buffer.from(body, "utf8"))) return;
      throw new PrivateStateError(destination);
    }
    throw error;
  });
}

async function persistFirstPassCancellation(
  dataDirectory: string,
  body: {
    readonly schemaVersion: 1;
    readonly kind: "docsfab-first-pass-cancellation";
    readonly code: "workflow-cancelled";
    readonly instructionSha256: string;
    readonly repositoryRevision: string;
    readonly modelCallEvidence: FirstPassCancellationModelCallEvidenceV1 | null;
  },
): Promise<void> {
  const evidence = {
    ...body,
    evidenceSha256: createHash("sha256").update(JSON.stringify(body), "utf8").digest("hex"),
  };
  const directory = join(dataDirectory, "cancellations");
  await ensurePrivateStateDirectory(directory, dataDirectory);
  const destination = join(directory, `${evidence.evidenceSha256}.json`);
  const bytes = `${JSON.stringify(evidence, null, 2)}\n`;
  await writeFile(destination, bytes, { mode: 0o600, flag: "wx" }).catch(async (error: unknown) => {
    if (error && typeof error === "object" && "code" in error && error.code === "EEXIST") {
      if ((await readPrivateStateFile(destination)).equals(Buffer.from(bytes, "utf8"))) return;
      throw new PrivateStateError(destination);
    }
    throw error;
  });
}

type KnowledgeGatherer = (input: {
  readonly repositoryPath: string;
  readonly dataDirectory: string;
  readonly revision?: string;
  readonly instruction?: string;
  readonly workflow?: "create-documentation" | "update-documentation";
  readonly modelCall?: (
    input: import("./first-pass-support.js").FirstPassSupportModelRequest,
  ) => Promise<import("./first-pass-support.js").FirstPassSupportModelResult>;
  /** The host's configured-credential match; without one, nothing stops for credentials. */
  readonly containsCredentialMaterial?: (value: string) => boolean;
  /** Host-sized; the knowledge first pass derives its turn and token caps from it. */
  readonly modelBudget?: {
    readonly maxCorrections: number;
    readonly evidenceExpansionModelTurns: number;
    readonly inputTokensPerTurn: number;
    readonly outputTokensPerTurn: number;
  };
  /** Host-resolved firstPass.* acquisition bounds and deadlines. */
  readonly firstPassLimits?: FirstPassHostLimits;
  /** The selected revision's tracked regular files, listed instead of a tree walk. */
  readonly trackedFiles?: readonly string[];
  /**
   * Repository-relative `--source` selections already resolved by the CLI.
   * The knowledge gate admits these by binding identity, not by extension.
   */
  readonly boundSourcePaths?: readonly string[];
  /** Host-authorized documentation write prefixes. Empty asks instead of inventing a page. */
  readonly authorizedWriteRoots?: readonly string[];
  /** The admitted intent; with it, the provider binds its write targets and parses no request. */
  readonly requestIntent?: FirstPassRequestIntentProjection;
}) => Promise<KnowledgeGatherResult>;

/**
 * The installed knowledge provider could not be loaded, or lacks an export
 * this runtime binds. A Recover stop: the operator reinstalls or re-points the
 * provider (`knowledge-provider-unavailable` in the situation catalog).
 */
export class KnowledgeProviderOperatorError extends Error {
  public readonly name = "KnowledgeProviderOperatorError";
  public readonly code = "knowledge-provider-unavailable";
}

/** Load one function export from the installed knowledge provider. */
async function loadKnowledgeProviderExport(
  config: DocsFabConfig,
  file: { readonly name: string; readonly label: string },
  exportName: string,
  purpose: string,
): Promise<unknown> {
  const modulePath = knowledgeProviderModulePath(config, file.name);
  let loaded: Record<string, unknown>;
  try {
    loaded = (await import(pathToFileURL(modulePath).href)) as Record<string, unknown>;
  } catch (error) {
    const detail = error instanceof Error ? error.message.replace(/[.?]$/u, "") : "unknown error";
    throw new KnowledgeProviderOperatorError(
      `DocsFab could not load the knowledge ${purpose} at ${modulePath} because ${detail}.`,
    );
  }
  if (typeof loaded[exportName] !== "function") {
    throw new KnowledgeProviderOperatorError(
      `The knowledge ${file.label} is missing a ${exportName} export.`,
    );
  }
  return loaded[exportName];
}

const FIRST_PASS_MODULE = { name: "first-pass.mjs", label: "first-pass module" } as const;
const FIRST_PASS_SUPPORT_MODULE = {
  name: "first-pass-support.mjs",
  label: "first-pass support module",
} as const;

async function loadKnowledgeGatherer(config: DocsFabConfig): Promise<KnowledgeGatherer> {
  return (await loadKnowledgeProviderExport(
    config,
    FIRST_PASS_MODULE,
    "gatherRepositoryFirstPass",
    "first-pass gatherer",
  )) as KnowledgeGatherer;
}

async function loadOrdinaryDocumentationRequestParser(
  config: DocsFabConfig,
): Promise<OrdinaryDocumentationRequestParser> {
  return (await loadKnowledgeProviderExport(
    config,
    FIRST_PASS_SUPPORT_MODULE,
    "parseOrdinaryDocumentationRequest",
    "first-pass request parser",
  )) as OrdinaryDocumentationRequestParser;
}

type NonActionableTargetGuard = (
  instruction: string,
  targetPaths: readonly string[],
  workflow: "create-documentation" | "update-documentation",
) => unknown;

async function loadNonActionableTargetGuard(
  config: DocsFabConfig,
): Promise<NonActionableTargetGuard> {
  return (await loadKnowledgeProviderExport(
    config,
    FIRST_PASS_SUPPORT_MODULE,
    "nonActionableNamedTargets",
    "first-pass request narrowing guard",
  )) as NonActionableTargetGuard;
}

/** The provider that frames assessment evidence also reads the frames back. */
export async function loadEvidenceFrameParser(
  config: DocsFabConfig,
): Promise<FirstPassEvidenceFrameParser> {
  return (await loadKnowledgeProviderExport(
    config,
    FIRST_PASS_SUPPORT_MODULE,
    "parseEvidenceFrames",
    "evidence frame parser",
  )) as FirstPassEvidenceFrameParser;
}

function knowledgeProviderModulePath(config: DocsFabConfig, filename: string): string {
  const configuredRoot = process.env.DOCSFAB_KNOWLEDGE_DIR;
  if (configuredRoot) return resolve(configuredRoot, "src", filename);

  const currentModulePath = fileURLToPath(import.meta.url);
  const sourceModulePath = resolve(config.projectRoot, "src", "cli", "first-pass.ts");
  const providerRoot =
    currentModulePath === sourceModulePath
      ? resolve(config.projectRoot, "..", "knowledge")
      : resolve(config.projectRoot, "dist", "knowledge-provider");
  return resolve(providerRoot, "src", filename);
}

async function classifyAndStoreDocumentationPartial(input: {
  readonly config: DocsFabConfig;
  readonly support: unknown;
  readonly instruction: string;
  readonly repositoryPath: string;
  readonly authorizedWriteRoots: readonly string[];
}): Promise<DocumentationPartialProjection | undefined> {
  const modulePath = knowledgeProviderModulePath(input.config, "first-pass-support.mjs");
  let classify: (value: {
    support: unknown;
    instruction: string;
    repositoryPath: string;
    authorizedWriteRoots?: readonly string[];
  }) => {
    envelope: Record<string, unknown>;
    markdown: string;
    originalRequestCompletion: "complete" | "incomplete";
  };
  try {
    const loaded = (await import(pathToFileURL(modulePath).href)) as {
      classifyDocumentationPartialFallback?: (value: {
        support: unknown;
        instruction: string;
        repositoryPath: string;
        authorizedWriteRoots?: readonly string[];
      }) => {
        envelope: Record<string, unknown>;
        markdown: string;
        originalRequestCompletion: "complete" | "incomplete";
      };
    };
    if (typeof loaded.classifyDocumentationPartialFallback !== "function") return undefined;
    classify = loaded.classifyDocumentationPartialFallback;
  } catch {
    return undefined;
  }
  const classified = classify({
    support: input.support,
    instruction: input.instruction,
    repositoryPath: input.repositoryPath,
    authorizedWriteRoots: input.authorizedWriteRoots,
  });
  const envelope = classified.envelope;
  const applicability = envelope.applicability;
  if (
    applicability !== "useful-partial" &&
    applicability !== "scaffold-only" &&
    applicability !== "no-useful-deliverable" &&
    applicability !== "cancellation" &&
    applicability !== "execution-failure"
  ) {
    return undefined;
  }
  const questions = Array.isArray(envelope.unresolvedQuestions)
    ? envelope.unresolvedQuestions.filter(
        (
          item,
        ): item is {
          obligationId: string;
          readerTask: string;
          neededSourceOrDecision: string;
        } =>
          Boolean(item) &&
          typeof item === "object" &&
          typeof (item as { obligationId?: unknown }).obligationId === "string" &&
          typeof (item as { readerTask?: unknown }).readerTask === "string" &&
          typeof (item as { neededSourceOrDecision?: unknown }).neededSourceOrDecision === "string",
      )
    : [];
  let locator: string | undefined;
  try {
    locator = await persistDocumentationPartialRecord(input.config, classified);
  } catch {
    locator =
      envelope.draft &&
      typeof envelope.draft === "object" &&
      typeof (envelope.draft as { locator?: unknown }).locator === "string"
        ? (envelope.draft as { locator: string }).locator
        : undefined;
  }
  return Object.freeze({
    originalRequestCompletion: classified.originalRequestCompletion,
    draftApplicability: applicability,
    ...(locator ? { locator } : {}),
    envelope,
    unresolvedQuestions: questions,
  });
}

async function persistDocumentationPartialRecord(
  config: DocsFabConfig,
  classified: {
    envelope: Record<string, unknown>;
    markdown: string;
  },
): Promise<string> {
  const store = new DurableArtifactStore(resolve(dirname(config.stateDirectory), "artifacts"));
  const body = {
    schemaVersion: 1,
    kind: "docsfab-documentation-partial-store",
    envelope: classified.envelope,
    markdown: classified.markdown,
  };
  const digest = opaqueRecordDigest(body);
  await store.putRecord(digest, body);
  return `record:sha256:${digest}`;
}

function explicitProjectConfigTarget(
  instruction: string,
  documentationTargets: readonly string[],
): "absent" | "included" | "ambiguous" {
  const matches = [...instruction.matchAll(/(?<![A-Za-z0-9_./-])\.docsfab\.json/gu)].filter(
    (match) => {
      const end = (match.index ?? 0) + match[0].length;
      const suffix = instruction.slice(end);
      return suffix === "" || /^[\s,;:!?`'"\])]/u.test(suffix) || /^\.(?:\s|$)/u.test(suffix);
    },
  );
  if (matches.length === 0) return "absent";
  if (matches.length > 1) return "ambiguous";
  const operation = /\b(?:create|update|refresh|revise|write)\b/iu.exec(instruction);
  if (!operation || operation.index === undefined) return "absent";
  const operationOffset = operation.index;
  const dependencyOffset = /\b(?:using|based on|with evidence from|consulting)\b/iu.exec(
    instruction.slice(operationOffset),
  )?.index;
  const boundary =
    dependencyOffset === undefined ? instruction.length : operationOffset + dependencyOffset;
  const index = matches[0]?.index ?? -1;
  if (index <= operationOffset || index >= boundary) return "absent";

  const matchEnd = index + (matches[0]?.[0].length ?? 0);
  const precedingClause = instruction
    .slice(operationOffset, index)
    .split(/[.;:\n]/u)
    .at(-1);
  const followingClause = instruction.slice(matchEnd, boundary).split(/[.;:\n]/u)[0];
  if (
    (precedingClause && proposalScopeExclusion.test(precedingClause)) ||
    (followingClause && proposalScopeExclusion.test(followingClause))
  ) {
    return "absent";
  }

  const previousTargetEnd = documentationTargets.reduce((latest, targetPath) => {
    const offset = instruction.lastIndexOf(targetPath, index);
    return offset >= operationOffset ? Math.max(latest, offset + targetPath.length) : latest;
  }, -1);
  if (previousTargetEnd >= 0) {
    const connector = instruction.slice(previousTargetEnd, index);
    return /^\s*(?:[`'"\])]+\s*)?(?:,\s*)?(?:(?:and|plus)\s+)?(?:(?:also\s+)?(?:include|add)\s+)?(?:exactly\s+)?$/iu.test(
      connector,
    )
      ? "included"
      : "ambiguous";
  }

  const nextTargetStart = documentationTargets.reduce((earliest, targetPath) => {
    const offset = instruction.indexOf(targetPath, matchEnd);
    return offset >= 0 && offset < boundary ? Math.min(earliest, offset) : earliest;
  }, Number.POSITIVE_INFINITY);
  const operationToConfig = instruction.slice(operationOffset + operation[0].length, index);
  const configToNextTarget = instruction.slice(matchEnd, nextTargetStart);
  return /^\s*(?:exactly\s+)?(?:[`'"]+\s*)?$/iu.test(operationToConfig) &&
    /^\s*(?:[`'"\])]+\s*)?(?:(?:,\s*(?:(?:and|plus)\s+)?)|(?:(?:and|plus)\s+))$/iu.test(
      configToNextTarget,
    )
    ? "included"
    : "absent";
}

const proposalScopeExclusion =
  /\b(?:do\s+not|don't|must\s+not|never|without|exclud(?:e|es|ed|ing)|except|preserv(?:e|es|ed|ing)|retain(?:s|ed|ing)?|leave|leaves|left|keep|keeps|kept|read[ -]?only|remain(?:s|ed|ing)?\s+unchanged|unchanged)\b/iu;
