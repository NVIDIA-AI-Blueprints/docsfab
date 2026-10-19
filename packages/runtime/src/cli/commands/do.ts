// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { resolveDocsFabStateDirectory } from "../../config/host-paths.js";
import { resolveConfiguredRuntimeAssetPaths } from "../../config/runtime-loader.js";
import {
  canonicalRepositoryPath,
  continuationBindingFlagConflict,
  continuationEvidenceRequest,
  listOpenEditorialRuns,
  operatorInputResumeInstructionContext,
  planOperatorInputResume,
  recordOperatorInputSupersession,
  type OperatorInputResumePlanV1,
} from "../../inputs/operator-input-fill.js";
import { canonicalizeJsonEvidence, type JsonEvidenceValue } from "../../json-evidence.js";
import { isInteractiveStdout } from "../../operator/cli-format.js";
import type { DelegatedTaskResultV1 } from "../../delegated-task/result-contract.js";
import { FULL_ADMISSION_OFFER, type AdmissionOffer } from "../admission-parse.js";
import {
  assertPublicationNotProhibited,
  deliveryPlanPublishes,
  isInteractiveWriteWorkflow,
  supportsLocalPatchDelivery,
  publicationProhibitionConflict,
  requestsWriteDelivery,
  resolveInteractiveDeliveryGrants,
  resolvePublicationRemoteName,
  type WriteDeliveryFlags,
} from "../delivery-grants.js";
import { workflowDeliveryCapabilities } from "../../workflow-contracts/delivery.js";
import {
  nextInvocationArguments,
  needsInputPreviewFacts,
  printCliPreview,
  workflowPreviewFacts,
} from "../preview-presentation.js";
import {
  applyAdmissionModelSelection,
  buildOutcomeRouteEnvelope,
  formatOutcomeRouteAdmission,
  formatOutcomeRouteDecision,
  isAdmissionModelEligible,
  NO_OUTCOME_AUTHORITY_GRANTS,
  reviewUnderWriteDeliveryRoute,
  routeOutcomeRequest,
  type OutcomeRouteDecision,
} from "../outcome-router.js";
import { failChangeSource } from "../../inputs/change-source.js";
import { hasExplicitPublicationProhibition } from "../publication-prohibition.js";
import { executeRunRequest } from "../run-request.js";
import { admitQualityPack } from "../run/pre-model-admission.js";
import { revisionPolicyForDraftMr } from "../run/request.js";
import {
  assertSourceSelectionMatchesInstruction,
  CHANGE_REQUEST_SELECTOR_OPTION_NAMES,
  SOURCE_AWARE_WORKFLOWS,
  unsupportedSourceWorkflowRefusal,
} from "../run-arguments.js";
import { doHelp } from "../usage.js";
import {
  RUNNABLE_WORKFLOW_NAMES,
  getWorkflow,
  type RunnableWorkflowName,
} from "../../workflow-registry/catalog.js";
import {
  handleDelegatedDoCommand,
  type AdmitCatalogWorkflow,
  type DoCommandOptions,
  type DoRunWorkflow,
} from "./do-delegated.js";
import { parseDoArguments, type DoArguments, type DoRunArguments } from "./do-parse.js";
import { setCliModelSettings } from "../../config/cli-model-settings.js";
import { parseSetOptions, withoutSetOptions } from "../model-setting-options.js";

export { parseDoArguments, type DoArguments, type DoRunArguments } from "./do-parse.js";
export {
  DELEGATED_DO_OWNER_ID,
  DELEGATED_DO_LIMITS,
  type AdmitCatalogWorkflow,
  type DelegatedDoRunner,
  type DelegatedRequestedCheck,
  type DelegatedRequestedCheckEvidence,
  type DelegatedRequestedCheckRunInput,
  type DoCommandOptions,
  type DoRunWorkflow,
} from "./do-delegated.js";

/** Coded refusal: `--source` or `--pr` on a `do` route that cannot bind it. */
export const DO_SOURCE_ROUTE_REFUSAL_CODES = ["source-route-unsupported"] as const;

export class DoSourceRouteOperatorError extends Error {
  public readonly code = DO_SOURCE_ROUTE_REFUSAL_CODES[0];

  public constructor(
    message: string,
    public readonly nextAction: string,
  ) {
    super(message);
    this.name = "DoSourceRouteOperatorError";
  }
}

const DO_OPTIONS_WITH_VALUES = [
  "--repo",
  "--revision",
  "--instruction",
  "--remote",
  "--comment-mr",
  "--continue",
  "--attach",
  "--source",
  "--pr",
  "--mr",
  "--change",
  "--composition",
  "--resume",
  "--answers",
  "--check",
] as const;

function hasDoPublicationProhibition(parsed: DoArguments): boolean {
  return (
    hasExplicitPublicationProhibition(parsed.request) ||
    hasExplicitPublicationProhibition(parsed.instruction)
  );
}

function unresolvedRouteCouldPublish(parsed: DoArguments): boolean {
  if (parsed.draftMr || parsed.commentMr !== undefined || parsed.dryRun) return true;
  return !parsed.patchOnly && parsed.compositionId === undefined;
}

/**
 * The admission offer: every runnable workflow, or, under `--patch-only` or
 * `--draft-mr`, only the workflows that deliver them. `--allow-write` alone
 * keeps the full offer; it is the operator's write grant, not a route input.
 */
export function admissionOfferFor(flags: WriteDeliveryFlags): AdmissionOffer {
  if (!requestsWriteDelivery(flags)) return FULL_ADMISSION_OFFER;
  const supportsRequestedDelivery = flags.patchOnly
    ? supportsLocalPatchDelivery
    : isInteractiveWriteWorkflow;
  return Object.freeze({
    workflows: Object.freeze(
      RUNNABLE_WORKFLOW_NAMES.filter((workflow) => supportsRequestedDelivery(workflow)),
    ),
    writeIntent: true,
  });
}

export interface DoRoutePlan {
  /** The route before any model call: what `--route-only` reports. */
  readonly decision: OutcomeRouteDecision;
  /** Present when the table leaves the choice to the admission model: the run's offer. */
  readonly admission?: AdmissionOffer;
}

/**
 * The deterministic half of `do` routing, shared by `--route-only` and the run
 * so the preview names the run's route (#1920):
 * - the fixed table classifies first;
 * - under `--patch-only` or `--draft-mr`, a review the table picked runs as
 *   update-documentation, because a review cannot take either flag;
 * - an eligible table miss leaves the choice to the admission model, offered
 *   every runnable workflow, or only the workflows that deliver `--patch-only`
 *   and `--draft-mr` when either is passed.
 *
 * Every other table result stands, and the delivery checks then refuse a flag
 * the selected workflow cannot take. `--allow-write` alone changes nothing here.
 */
export function planDoRoute(
  request: string,
  flags: WriteDeliveryFlags,
  tableDecision: OutcomeRouteDecision = routeOutcomeRequest(request),
): DoRoutePlan {
  if (
    requestsWriteDelivery(flags) &&
    tableDecision.status === "selected" &&
    tableDecision.workflow === "review-documentation"
  ) {
    return { decision: reviewUnderWriteDeliveryRoute() };
  }
  if (isAdmissionModelEligible(request, tableDecision)) {
    return { decision: tableDecision, admission: admissionOfferFor(flags) };
  }
  return { decision: tableDecision };
}

/** A thrown or offline admission model, or a pick outside the offer, is a miss. */
async function admitWithinOffer(
  admitCatalogWorkflow: AdmitCatalogWorkflow | undefined,
  request: string,
  offer: AdmissionOffer,
): Promise<RunnableWorkflowName | undefined> {
  if (!admitCatalogWorkflow) return undefined;
  let admitted: string | undefined;
  try {
    admitted = await admitCatalogWorkflow(request, offer);
  } catch {
    return undefined;
  }
  return offer.workflows.find((workflow) => workflow === admitted);
}

/**
 * The run's routing: the shared plan, then at most one tool-free admission call
 * within the plan's offer. An abstain, a pick outside the offer, an error, or
 * no configured model keeps the table's `needs-input` stop (#164).
 */
async function admitPlannedRoute(
  request: string,
  plan: DoRoutePlan,
  admitCatalogWorkflow: AdmitCatalogWorkflow | undefined,
): Promise<OutcomeRouteDecision> {
  if (plan.admission === undefined) return plan.decision;
  const admitted = await admitWithinOffer(admitCatalogWorkflow, request, plan.admission);
  return admitted === undefined
    ? plan.decision
    : applyAdmissionModelSelection(request, plan.decision, admitted);
}

export async function handleDoCommand(
  args: string[],
  options: DoCommandOptions = {},
): Promise<OutcomeRouteDecision | DelegatedTaskResultV1 | undefined> {
  if (args.includes("--help") || args.includes("-h")) {
    console.log(doHelp());
    return undefined;
  }
  // `--set key=value` pairs are this invocation's highest-precedence model
  // settings; every configuration load below applies them.
  setCliModelSettings(parseSetOptions(args));
  const commandArgs = withoutSetOptions(args);
  const parsed = parseDoArguments(commandArgs);
  if (parsed.delegate || parsed.resumeTaskId !== undefined) {
    return handleDelegatedDoCommand(parsed, options);
  }
  const continuation = await maybeContinueEditorialRun(parsed, options, commandArgs);
  if (continuation) return continuation;

  const tableDecision = routeOutcomeRequest(parsed.request);
  const publicationProhibited = hasDoPublicationProhibition(parsed);
  // Ahead of the admission call and of the `--route-only` return: the preview
  // refuses what the run refuses.
  if (
    publicationProhibited &&
    tableDecision.status === "needs-input" &&
    unresolvedRouteCouldPublish(parsed)
  ) {
    throw publicationProhibitionConflict();
  }
  const plan = planDoRoute(parsed.request, parsed, tableDecision);
  // A table miss asks the admission model before the run's own checks, so the
  // pack the run would load is checked first. The previews check it too, so
  // they refuse what the run would.
  if (plan.admission !== undefined) await admitQualityPack(resolveConfiguredRuntimeAssetPaths());
  // `--route-only` stays table-only (admission decision, #164): it names the
  // admission offer instead of asking the model.
  const decision = parsed.routeOnly
    ? plan.decision
    : await admitPlannedRoute(parsed.request, plan, options.admitCatalogWorkflow);
  const envelope = buildOutcomeRouteEnvelope(
    parsed.request,
    decision,
    parsed.routeOnly ? plan.admission?.workflows : undefined,
  );

  const routeFormat = { tty: isInteractiveStdout() };

  if (decision.status === "needs-input") {
    if (parsed.json) {
      console.log(canonicalizeJsonEvidence(envelope as unknown as JsonEvidenceValue));
    } else {
      printCliPreview(
        needsInputPreviewFacts({
          request: parsed.request,
          reason: decision.reason,
          message: decision.message,
          nextAction: decision.nextAction,
          choices: decision.choices,
          ...(envelope.admission === undefined
            ? {}
            : { admissionOffer: formatOutcomeRouteAdmission(envelope.admission.workflows) }),
        }),
        parsed.quiet ? "quiet" : "normal",
      );
    }
    process.exitCode = 2;
    return decision;
  }

  // Deliberately ahead of the `--route-only` return: the preview must refuse a
  // selection the real run would refuse, including a write flag the selected
  // workflow cannot take and a publication the request prohibits. These checks
  // open no source body and make no forge read. They use the run's grants; the
  // preview returns before any grant applies.
  assertRoutedWorkflowAdmitsSources(parsed, decision.workflow);
  const grants = resolveInteractiveDeliveryGrants({
    workflow: decision.workflow,
    dryRun: parsed.dryRun,
    patchOnly: parsed.patchOnly,
    draftMrFlag: parsed.draftMr,
    allowWriteFlag: parsed.allowWrite,
    commentMr: parsed.commentMr !== undefined,
    routeOnly: false,
    explicitComposition: parsed.compositionId !== undefined,
  });
  assertPublicationNotProhibited(publicationProhibited, {
    workflow: decision.workflow,
    grants,
    commentMr: parsed.commentMr !== undefined,
    dryRun: parsed.dryRun,
  });

  if (parsed.routeOnly) {
    if (parsed.json) {
      console.log(canonicalizeJsonEvidence(envelope as unknown as JsonEvidenceValue));
    } else {
      console.log(formatOutcomeRouteDecision(decision, { format: routeFormat }).join("\n"));
    }
    return decision;
  }

  const remoteName = resolvePublicationRemoteName(parsed.remoteName, grants.draftMr);

  // ROUTE is a supporting section, suppressed under --quiet like PROGRESS.
  // Needs-input and --route-only above print it unconditionally.
  if (!parsed.json && !parsed.quiet) {
    console.log(formatOutcomeRouteDecision(decision, { format: routeFormat }).join("\n"));
    console.log("");
  }

  if (parsed.dryRun) {
    const nextGrants = resolveInteractiveDeliveryGrants({
      workflow: decision.workflow,
      dryRun: false,
      patchOnly: parsed.patchOnly,
      draftMrFlag: parsed.draftMr,
      allowWriteFlag: parsed.allowWrite,
      commentMr: parsed.commentMr !== undefined,
      routeOnly: false,
      explicitComposition: parsed.compositionId !== undefined,
    });
    const wouldWrite =
      nextGrants.allowWrite &&
      workflowDeliveryCapabilities(getWorkflow(decision.workflow)).patchOnly;
    const wouldPublish = deliveryPlanPublishes({
      workflow: decision.workflow,
      grants: nextGrants,
      commentMr: parsed.commentMr !== undefined,
      dryRun: false,
    });
    if (parsed.json) {
      console.log(
        canonicalizeJsonEvidence({
          schemaVersion: 1,
          kind: "docsfab-dry-run",
          workflow: decision.workflow,
          wouldWrite,
          wouldPublish,
        } as unknown as JsonEvidenceValue),
      );
    } else {
      printCliPreview(
        workflowPreviewFacts({
          workflow: decision.workflow,
          repositoryPath: parsed.repositoryPath,
          wouldWrite,
          wouldPublish,
          title: `Dry run: ${decision.workflow}`,
          nextActionLabel: "Run this selection",
          nextArguments: [
            "do",
            ...nextInvocationArguments(args, ["--dry-run"], DO_OPTIONS_WITH_VALUES),
          ],
        }),
        parsed.quiet ? "quiet" : "normal",
      );
    }
    return decision;
  }

  const runWorkflow = options.runWorkflow ?? ((request) => executeRunRequest(request));
  await runWorkflow({
    ...(parsed.compositionId ? { compositionId: parsed.compositionId } : {}),
    workflow: decision.workflow,
    repositoryPath: parsed.repositoryPath,
    revision: parsed.revision,
    instruction: parsed.instruction,
    allowWrite: grants.allowWrite,
    ...(parsed.patchOnly ? { patchOnly: true } : {}),
    ...(grants.draftMr ? { draftMr: true } : {}),
    ...(grants.draftMr
      ? { revisionPolicy: revisionPolicyForDraftMr(parsed.revision, parsed.revisionExplicit) }
      : {}),
    ...(parsed.commentMr !== undefined ? { commentMr: parsed.commentMr } : {}),
    ...(remoteName !== undefined ? { remoteName } : {}),
    ...(parsed.quiet ? { quiet: true } : {}),
    // `do` mints no binding of its own; the shared execution assembly acquires
    // these, so the same words bind the same evidence as `docsfab run`.
    ...(parsed.sourcePaths?.length ? { sourcePaths: parsed.sourcePaths } : {}),
    ...(parsed.changeRequestSelector
      ? { changeRequestSelector: parsed.changeRequestSelector }
      : {}),
    ...(parsed.changeSource ? { changeSource: parsed.changeSource } : {}),
    releaseGate: false,
    verbose: false,
    json: parsed.json,
    showScan: false,
    ...(parsed.study ? { study: true } : {}),
  });
  return decision;
}

/**
 * Refuse a source selection the routed workflow cannot bind, naming it. `run`
 * raises the same refusals while parsing; `do` learns the workflow only from
 * routing.
 */
function assertRoutedWorkflowAdmitsSources(parsed: DoArguments, workflow: string): void {
  const sourcePaths = parsed.sourcePaths ?? [];
  if (
    sourcePaths.length === 0 &&
    parsed.changeRequestSelector === undefined &&
    parsed.changeSource === undefined
  ) {
    return;
  }
  if (!(SOURCE_AWARE_WORKFLOWS as readonly string[]).includes(workflow)) {
    const routes = SOURCE_AWARE_WORKFLOWS.join(" or ");
    if (parsed.changeRequestSelector !== undefined) {
      throw new DoSourceRouteOperatorError(
        `${unsupportedSourceWorkflowRefusal(SOURCE_AWARE_WORKFLOWS, "--pr")} This quoted request routed to ${workflow} instead, so nothing was read and the workflow did not start.`,
        `Describe a change that routes to ${routes}, or drop ${CHANGE_REQUEST_SELECTOR_OPTION_NAMES}.`,
      );
    }
    // `--source` first, in the order `docsfab run` admits the two options.
    if (sourcePaths.length > 0) {
      throw new DoSourceRouteOperatorError(
        `${unsupportedSourceWorkflowRefusal()} This quoted request routed to ${workflow} instead, so nothing was read and the workflow did not start.`,
        `Describe a change that routes to ${routes}, or drop --source.`,
      );
    }
    // Only `--change` is left. The workflow id comes from the catalog route,
    // never from the request text.
    failChangeSource(
      "change-source-workflow-unsupported",
      `the quoted request routed to ${workflow}; nothing was read`,
    );
  }
  // The routed run must not reason over a discovered merged-MR set while
  // binding only the selected one.
  assertSourceSelectionMatchesInstruction({
    instruction: workflow === "update-documentation" ? parsed.instruction : undefined,
    sourcePaths,
    ...(parsed.changeRequestSelector
      ? { changeRequestSelector: parsed.changeRequestSelector }
      : {}),
    ...(parsed.changeSource ? { changeSource: parsed.changeSource } : {}),
  });
}

async function maybeContinueEditorialRun(
  parsed: DoArguments,
  options: {
    runWorkflow?: DoRunWorkflow;
    stateDirectory?: string;
    currentWorkspaceSnapshotSha256?: string;
    now?: () => Date;
  },
  rawArgs: readonly string[],
): Promise<OutcomeRouteDecision | undefined> {
  const stateDirectory = options.stateDirectory ?? resolveDocsFabStateDirectory();
  const explicit = parsed.continueFrom !== undefined || parsed.attachPaths.length > 0;
  if (!explicit) {
    const repositoryPath = canonicalRepositoryPath(parsed.repositoryPath);
    const open = (await listOpenEditorialRuns(stateDirectory)).filter(
      (item) => canonicalRepositoryPath(item.repositoryPath) === repositoryPath,
    );
    if (open.length === 0 || !parsed.request.trim()) return undefined;
    // An open run here would take the sentence as its reply, and a
    // continuation binds only the stopped run's own evidence. `--continue` and
    // `--attach` with `--change`, `--source` or `--pr` already refused while
    // parsing.
    if (parsed.changeSource !== undefined) {
      failChangeSource(
        "change-source-resume-unsupported",
        "an editorial needs-input run is open for this repository, so do would continue it with this sentence as its reply; reply without --change, or start a fresh run with docsfab run <workflow> --change",
      );
    }
    if ((parsed.sourcePaths?.length ?? 0) > 0 || parsed.changeRequestSelector !== undefined) {
      throw continuationBindingFlagConflict(
        "an editorial needs-input run is open for this repository, so the sentence is its reply",
      );
    }
  }
  if (parsed.routeOnly) {
    throw new Error(
      "docsfab do --route-only cannot continue an editorial needs-input run; classification is not a grant.",
    );
  }
  const plan = await planOperatorInputResume({
    stateDirectory,
    repositoryPath: parsed.repositoryPath,
    ...(rawArgs.indexOf("--repo") >= 0
      ? { repositoryArgument: rawArgs[rawArgs.indexOf("--repo") + 1] }
      : {}),
    revision: parsed.revision,
    revisionExplicit: parsed.revisionExplicit,
    attachPaths: parsed.attachPaths,
    ...(parsed.continueFrom !== undefined ? { continueFrom: parsed.continueFrom } : {}),
    ...(parsed.request.trim() ? { replyText: parsed.request } : {}),
    ...(options.currentWorkspaceSnapshotSha256
      ? { currentWorkspaceSnapshotSha256: options.currentWorkspaceSnapshotSha256 }
      : {}),
    ...(options.now ? { now: options.now } : {}),
  });
  return executeContinuedEditorialRun(parsed, plan, { ...options, stateDirectory });
}

async function executeContinuedEditorialRun(
  parsed: DoArguments,
  plan: OperatorInputResumePlanV1,
  options: { runWorkflow?: DoRunWorkflow; stateDirectory: string; now?: () => Date },
): Promise<OutcomeRouteDecision> {
  const workflow = plan.workflow;
  const decision: OutcomeRouteDecision = {
    status: "selected",
    workflow,
    rationale: "Continue the original editorial run after named InputAsk fills.",
    readWriteScope: "read-only",
    expectedValidations: Object.freeze(["fixed catalog workflow gates only"]),
    authorizationBoundary:
      "Continuation never grants tools, writes, external-input access, or publication authority beyond the original run gates.",
    classifiedBy: "fixed-table",
    grants: NO_OUTCOME_AUTHORITY_GRANTS,
  };
  // The reply joins the original instruction, so either can forbid publishing.
  const publicationProhibited =
    hasDoPublicationProhibition(parsed) || hasExplicitPublicationProhibition(plan.instruction);
  const grants = resolveInteractiveDeliveryGrants({
    workflow: plan.workflow,
    dryRun: parsed.dryRun,
    patchOnly: parsed.patchOnly,
    draftMrFlag: parsed.draftMr,
    allowWriteFlag: parsed.allowWrite,
    commentMr: parsed.commentMr !== undefined,
    routeOnly: false,
    explicitComposition: parsed.compositionId !== undefined,
  });
  assertPublicationNotProhibited(publicationProhibited, {
    workflow: plan.workflow,
    grants,
    commentMr: parsed.commentMr !== undefined,
    dryRun: parsed.dryRun,
  });
  const remoteName = resolvePublicationRemoteName(parsed.remoteName, grants.draftMr);
  const routeFormat = { tty: isInteractiveStdout() };
  if (!parsed.json && !parsed.quiet) {
    console.log(formatOutcomeRouteDecision(decision, { format: routeFormat }).join("\n"));
    console.log("");
    if (isInteractiveStdout()) {
      console.log(`InputAsk fills: ${plan.fills.map((fill) => fill.inputId).join(", ") || "none"}`);
      console.log(
        plan.skipPlanner
          ? "Resume: snapshot and planBinding match; planner and search observe are skipped."
          : "Resume: snapshot or planBinding changed; planner and search observe revalidate.",
      );
    }
  }
  if (parsed.dryRun) {
    if (parsed.json) {
      console.log(
        canonicalizeJsonEvidence({
          schemaVersion: 1,
          kind: "docsfab-dry-run",
          workflow: plan.workflow,
          wouldWrite: isInteractiveWriteWorkflow(plan.workflow),
          wouldPublish: isInteractiveWriteWorkflow(plan.workflow),
          continueFrom: plan.originalRunId,
        } as unknown as JsonEvidenceValue),
      );
    } else {
      console.log(
        `Dry run: would continue ${plan.originalRunId} with ${String(plan.fills.length)} InputAsk fill(s).`,
      );
    }
    return decision;
  }
  const continuedContext = operatorInputResumeInstructionContext(plan);
  const retainedEvidenceRequest = continuationEvidenceRequest(plan);
  // The stopped run is superseded by this continuation's run id, so a
  // continuation that stops again leaves exactly one open run in the chain.
  // The claim is released when the continuation ends without a saved record.
  const claim = await recordOperatorInputSupersession({
    stateDirectory: options.stateDirectory,
    plan,
    ...(options.now ? { now: options.now } : {}),
  });
  const runWorkflow = options.runWorkflow ?? ((request) => executeRunRequest(request));
  // A retained base-head comparison pins the revision even when --revision was omitted.
  const revisionExplicit = parsed.revisionExplicit || plan.revision !== parsed.revision;
  const request: DoRunArguments = {
    ...(parsed.compositionId ? { compositionId: parsed.compositionId } : {}),
    ...(plan.continuationRunId ? { runId: plan.continuationRunId } : {}),
    workflow: plan.workflow,
    repositoryPath: parsed.repositoryPath,
    revision: plan.revision,
    instruction: plan.instruction,
    allowWrite: grants.allowWrite,
    ...(parsed.patchOnly ? { patchOnly: true } : {}),
    ...(grants.draftMr ? { draftMr: true } : {}),
    ...(grants.draftMr
      ? { revisionPolicy: revisionPolicyForDraftMr(plan.revision, revisionExplicit) }
      : {}),
    ...(parsed.commentMr !== undefined ? { commentMr: parsed.commentMr } : {}),
    ...(remoteName !== undefined ? { remoteName } : {}),
    ...(parsed.quiet ? { quiet: true } : {}),
    // The original run's comparison and nominations, so the continuation
    // re-admits its evidence instead of asking for a comparison.
    ...(plan.comparisonRequest ? { comparisonRequest: plan.comparisonRequest } : {}),
    ...(plan.readerSources.length > 0 ? { readerSources: plan.readerSources } : {}),
    // The original run's `--source` files and `--change` commits; the shared
    // assembly refuses if they moved since the stop.
    ...retainedEvidenceRequest,
    // A filled source-support slot reaches the planner as an approved source.
    ...(continuedContext ? { instructionContext: continuedContext } : {}),
    operatorInputResume: plan,
    releaseGate: false,
    verbose: false,
    json: parsed.json,
    showScan: false,
    ...(parsed.study ? { study: true } : {}),
  };
  try {
    await runWorkflow(request);
  } finally {
    await claim.release();
  }
  return decision;
}
