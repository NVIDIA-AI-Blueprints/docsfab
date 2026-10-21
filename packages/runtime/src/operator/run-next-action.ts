// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * NEXT-action selection for the run summary footer and the sealed
 * `RunResultV1.nextSteps`. Types come from `run-summary.ts` by `import type`
 * only, so there is no value edge back to it.
 */
import {
  admitPlanScopeStop,
  planScopeStopNextReason,
} from "../workflow-contracts/plan-scope-stop.js";
import {
  admitWriterNoChangeStop,
  writerNoChangeStopNextReason,
} from "../workflow-contracts/writer-no-change-stop.js";
import { dirname } from "node:path";
import {
  isNoChangeBasisLimitation,
  NO_CHANGE_ASSESSMENT_LOCATION,
  noChangeBasisPhrase,
} from "../artifacts/editorial-decision.js";
import { editorialInputAskPresentationV1 } from "../artifacts/editorial-input-ask.js";
import { commandLineSettings } from "../config/model-settings.js";
import { REQUIRED_SOURCE_UNREAD_CODE } from "../inputs/source-evidence-artifacts.js";
import {
  classifyAuthoringQualityNonWallCode,
  isAuthoringQualityOutcomeWorkflow,
} from "../evaluation-report/authoring-outcome-projector.js";
import {
  decodeRetainedAuthoringWorkflowV1,
  validateAuthoringRunRecordV1,
} from "../records/authoring-execution.js";
import { STEP_EXECUTION_CEILING_CODES } from "../config/execution-limit-stops.js";
import type { OutboundProxyRefusalKind } from "../model/outbound-http-policy.js";
import type { RunRecord } from "../records/contracts.js";
import { retainedTemplateAuditReport, TEMPLATE_AUDIT_WORKFLOW } from "../templates/audit.js";
import {
  classifyInferenceAttempt,
  readRunFailure,
  readStepFailure,
  RUN_FAILURE_CODE_CLASSES,
} from "./failure-classification.js";
import { LIMIT_DEFINITION_BY_NAME, type LimitDefinition } from "../config/limits.generated.js";
import { isEditorialInputAskRecord } from "./run-resumability.js";
import type { WorkflowOutcomeFindingV1 } from "../workflow-contracts/contracts.js";
import {
  notReadyMaterialToolFailures,
  type NotReadyMaterialToolFailure,
  SOURCE_CITATION_GAPS_LIMITATION,
  workflowOutcomeState,
  type WorkflowOutcomeDecodeOptionsV1,
} from "../workflow-contracts/outcome.js";
import {
  authoringRevisionAccountingDiagnosticFromMessage,
  revisionAccountingDiagnosticForRejectionCode,
  REVISE_DOCUMENTATION_STEP_ID,
  workflowOutcomePersistenceError,
} from "../workflow-contracts/run-recovery-presentation.js";
import { technicalResponseDiagnosticFromMessage } from "../workflow-execution/review-response.js";
import { TECHNICAL_CORRECTION_BYTE_BOUNDS } from "../workflow-execution/technical-rejection-retryability.js";
import { sourceObligationFailureReason } from "../workflow-execution/source-obligation.js";
import {
  PLAN_OUTSIDE_WRITE_ROOTS_CODE,
  PLAN_TARGET_NOT_NAMED_CODE,
  PLAN_TARGET_NOT_WRITABLE_CODE,
  notNamedPlanWritePathsFromMessage,
} from "../workflow-execution/plan-binding.js";
import {
  EDITORIAL_FINALIZATION_CONFLICTING_ASSESSMENT_CODE,
  readEditorialFinalizationRejection,
  type EditorialFinalizationRejectionV1,
} from "../workflow-execution/editorial-finalization-rejection.js";
import {
  formatDeclinedRetryVisibilitySuffix,
  readTerminalRetryDisposition,
} from "./retry-disposition.js";
import { projectRunEditorialOutcome, projectRunProduct } from "./run-result.js";
import { admittedKeptUnchangedPages } from "../workflow-contracts/kept-pages.js";
import { situationRowsForId } from "./situation-catalog.js";
import { OUTPUT_RULES } from "../contracts/model-output.generated.js";
import {
  decodeRunRecordRequestIntent,
  describeRequestIntentBoundary,
  REQUEST_INTENT_CONTINUING_OUTCOMES,
  type RunRecordRequestIntentV1,
} from "../request-intent/interpret-record.js";
import { RequestIntentContractError } from "../request-intent/kit.js";
import {
  decodeRunRecordFirstPassContradiction,
  RunRecordFirstPassContradictionError,
  type RunRecordFirstPassContradictionV1,
} from "../cli/run/first-pass-contradiction-stop.js";
import { decodeFirstPassContradictionAdmission } from "../records/first-pass-contradiction-admission.js";
import type {
  RunFooterProjectionContext,
  RunPublicationPhase,
  RunSummaryContext,
} from "./run-summary.js";
import {
  buildGovernedInputRetryTemplate,
  buildProviderRetryCommand,
  buildRunRetryCommand,
  retryRecoveryReason,
  shellArgument,
} from "./run-retry-commands.js";
import { retainedOperatorReviewTargets } from "./recovery-scope.js";

export interface RunHumanNextCommand {
  readonly command: string;
  readonly reason: string;
  readonly recoveryAction?: "retrySame" | "rescope" | "resume";
}

/** Shared selector for the human NEXT action and sealed `RunResultV1.nextSteps`. */
export function buildRunHumanNextCommand(
  context: RunFooterProjectionContext,
): RunHumanNextCommand | undefined {
  const action = selectRunNextCommand(context);
  if (!context.history) return action;
  // Saved-run replay: prefer the parser-validated continuation command. Drop a
  // retry template whose `'<...>'` placeholder operand a replay cannot resolve.
  if (context.history.readyCommand) return context.history.readyCommand;
  return action && !action.command.includes("'<") ? action : undefined;
}

/**
 * Phase-specific recovery for a run base GitLab cannot publish from.
 *
 * - Pre-write (the `--draft-mr` freshness prelude): nothing was written, so the
 *   recovery is `docsfab doctor`. A pinned run base passes only when it equals
 *   GitLab's target-branch head exactly (`delivery/freshness.ts`), so the
 *   reason says to pin that head.
 * - Post-write: the write is preserved. Ship republishes it once the target
 *   branch contains the run base, so the reason names that prerequisite first
 *   (#2120): push a base GitLab does not have (`run-revision-unpushed`), or
 *   merge one that is not an ancestor of the target (`stale-revision`); or
 *   start a new run from a commit on the target branch. DocsFab never pushes
 *   the base itself.
 *
 * `docsfab ship` requires `--repo`, so without a repository path this keeps the
 * inspect-the-record action.
 */
export function staleRevisionRecovery(input: {
  readonly phase: RunPublicationPhase;
  readonly runId?: string;
  readonly repositoryPath?: string;
  readonly code?: "stale-revision" | "run-revision-unpushed";
}): RunHumanNextCommand {
  const repoArg =
    input.repositoryPath !== undefined && input.repositoryPath.length > 0
      ? ` --repo ${shellArgument(input.repositoryPath)}`
      : "";
  if (input.phase === "pre-write") {
    return {
      command: `docsfab doctor${repoArg}`,
      reason:
        "GitLab's target branch moved before the write started; no run was created. Check this workspace with doctor, then retry, or fetch the merge-request target branch and pass --revision with its new head commit.",
    };
  }
  const unpushed = input.code === "run-revision-unpushed";
  const cause = unpushed
    ? "GitLab does not have the run base commit; it was never pushed."
    : "The run base is not an ancestor of GitLab's target branch.";
  if (input.runId === undefined || repoArg === "") {
    return {
      command: `docsfab runs show ${shellArgument(input.runId ?? "<run-id>")}`,
      reason: `${cause} Inspect the record, ${unpushed ? "push its base commit to" : "merge its base into"} the target branch, then republish it with docsfab ship from the run's repository checkout; or start a new run from a commit on the target branch.`,
    };
  }
  return {
    command: `docsfab ship ${shellArgument(input.runId)}${repoArg}`,
    reason: `${cause} ${unpushed ? "Push it to" : "Merge it into"} the target branch, then run this to republish the preserved write without re-running the workflow; or start a new run from a commit on the target branch.`,
  };
}

function selectRunNextCommand(
  context: RunFooterProjectionContext,
): RunHumanNextCommand | undefined {
  const { record, repositoryPath, publication, recordPath, reportServeCommand, htmlReportPath } =
    context;
  const repoArg =
    repositoryPath !== undefined && repositoryPath.length > 0
      ? ` --repo ${shellArgument(repositoryPath)}`
      : "";
  const stateDirArg =
    recordPath !== undefined && recordPath.length > 0
      ? ` --state-dir ${shellArgument(dirname(recordPath))}`
      : "";
  if (publication?.status === "failed") {
    if (publication.failureCode === "comment-publication-failed") {
      return {
        command: `docsfab runs show ${shellArgument(record.id)}${stateDirArg}`,
        reason:
          "The run is saved, but its MR comment was not confirmed. Check the MR discussion for a matching review summary before another delivery attempt; do not re-run the workflow just to retry the comment.",
      };
    }
    if (publication.failureCode === "publication-not-attempted") {
      return {
        command: `docsfab runs show ${shellArgument(record.id)}`,
        reason: "Publication was not attempted; the patch did not change documentation files.",
      };
    }
    if (
      publication.failureCode === "stale-revision" ||
      publication.failureCode === "run-revision-unpushed"
    ) {
      return staleRevisionRecovery({
        phase: publication.phase ?? "post-write",
        runId: record.id,
        code: publication.failureCode,
        ...(repositoryPath !== undefined && repositoryPath.length > 0 ? { repositoryPath } : {}),
      });
    }
    if (publication.failureCode === "tracked-source-dirty") {
      return {
        command: `docsfab publish ${shellArgument(record.id)}${repoArg}${stateDirArg}`,
        reason:
          "Commit, stash, or discard tracked and staged changes first. Untracked files are allowed.",
      };
    }
    if (publication.failureCode === "ambiguous-remote") {
      return {
        command: `docsfab publish ${shellArgument(record.id)}${repoArg}${stateDirArg}`,
        reason:
          "This checkout has more than one Git remote and none is named origin. Pass --remote <name>.",
      };
    }
    if (publication.failureCode === "not-repository-root") {
      return {
        command: `docsfab runs show ${shellArgument(record.id)}`,
        reason: "Pass --repo at the Git repository root, then retry publish.",
      };
    }
    if (publication.failureCode === "not-a-git-repository") {
      return {
        command: `docsfab runs show ${shellArgument(record.id)}`,
        reason: "Pass --repo at a local Git checkout, then retry publish.",
      };
    }
    if (publication.failureCode === "unsafe-git-configuration") {
      return {
        command: `docsfab runs show ${shellArgument(record.id)}`,
        reason:
          "Retry from a checkout without local Git hooks, fsmonitor, includes, or content filters.",
      };
    }
    if (publication.failureCode === "repository-mismatch") {
      return {
        command: `docsfab runs show ${shellArgument(record.id)}`,
        reason: "Retry publish against the same --repo path the run recorded.",
      };
    }
    if (publication.failureCode === "git-identity-drift") {
      return {
        command: `docsfab publish ${shellArgument(record.id)}${repoArg}${stateDirArg}`,
        reason:
          "Git user.name or user.email changed after this publication was planned. Set them back to the identity you published with, then run this; the write is preserved. To publish as the new identity, start a new run.",
      };
    }
    if (publication.failureCode === "git-configuration-refused") {
      return {
        command: `docsfab publish ${shellArgument(record.id)}${repoArg}${stateDirArg}`,
        reason:
          "DocsFab refused a Git setting that can run a command, change how it pushes, or turn signing on. Remove it from the file that sets it; `git config --show-origin --list` shows each setting's file. Then run this; the write is preserved. core.sshCommand and core.askPass can move to your global Git config instead, when HOME is an absolute path outside the checkout.",
      };
    }
    if (publication.failureCode === "git-checkout-unverified") {
      return {
        command: `docsfab publish ${shellArgument(record.id)}${repoArg}${stateDirArg}`,
        reason:
          "DocsFab could not verify the checkout's Git setup. Check `git --version` (2.9.5 or newer), `git remote get-url --push --all <remote>` (the one project URL the plan names), `git config --show-origin --list` (no error, a value for every setting), and that `git config --includes --show-origin --null --list | wc -c` is no larger than delivery.gitConfigurationListingMaxBytes, then run this; the write is preserved.",
      };
    }
    return {
      command: `docsfab publish ${shellArgument(record.id)}${repoArg}${stateDirArg}`,
      reason: "Retry publication of this run; do not re-run the workflow.",
    };
  }
  if (publication?.status === "succeeded") {
    return { command: publication.mergeRequestUrl, reason: "Draft MR is up." };
  }
  if (
    record.status === "failed" ||
    record.status === "needs-input" ||
    record.status === "needs-human-decision"
  ) {
    const prohibition = projectPublicationProhibitionNext(record);
    if (prohibition) return prohibition;
    const intentStop = projectRequestIntentStopNext(record, stateDirArg);
    if (intentStop) return intentStop;
    const contradictionStop = projectFirstPassContradictionNext(record, stateDirArg);
    if (contradictionStop) return contradictionStop;
    const product = projectRunProduct(record, context.editorialDecodeOptions);
    if (product.plannerDiagnostic?.category === "invalid-model-output") {
      return {
        command: buildRunRetryCommand(record),
        reason: `Run this template against the original target checkout; planner output did not satisfy the ${product.plannerDiagnostic.code} contract, and no missing user input was established.`,
      };
    }
    const editorialAsk = projectEditorialInputAskNext(record, context);
    if (editorialAsk) return editorialAsk;
    if (product.plannerDiagnostic?.category === "missing-governed-input") {
      return {
        command: buildGovernedInputRetryTemplate(record),
        reason: `Run this template against the original target checkout after adding the required governed input (${product.plannerDiagnostic.code}) to the instruction.`,
      };
    }
    const planScopeStop = record.status === "needs-input" ? admitPlanScopeStop(record) : undefined;
    if (planScopeStop) {
      return {
        command: buildGovernedInputRetryTemplate(record),
        reason: planScopeStopNextReason(planScopeStop),
      };
    }
    const writerNoChangeStop =
      record.status === "needs-input" ? admitWriterNoChangeStop(record) : undefined;
    if (writerNoChangeStop) {
      return {
        command: buildGovernedInputRetryTemplate(record),
        reason: writerNoChangeStopNextReason(writerNoChangeStop),
      };
    }
    const scopeBound = buildScopeBoundRecoveryAction(record, stateDirArg);
    if (scopeBound) return scopeBound;
    const outcomeRecovery = buildOutcomePersistenceRecoveryAction(record, stateDirArg);
    if (outcomeRecovery) return outcomeRecovery;
    const editorialRecovery = buildEditorialFinalizationRecoveryAction(record, stateDirArg);
    if (editorialRecovery) return editorialRecovery;
    const revisionAccountingRecovery = buildAuthoringRevisionAccountingRecoveryAction(
      record,
      stateDirArg,
    );
    if (revisionAccountingRecovery) return revisionAccountingRecovery;
    const technicalRecovery = buildTechnicalResponseRecoveryAction(record, stateDirArg);
    if (technicalRecovery) return technicalRecovery;
    const declinedRetry = buildDeclinedRetryRecoveryAction(record, stateDirArg);
    if (declinedRetry) return declinedRetry;
    const requiredSourceStop = buildRequiredSourceUnreadAction(record, stateDirArg);
    if (requiredSourceStop) return requiredSourceStop;
    const planWriteScope = buildPlanWriteScopeAction(record);
    if (planWriteScope) return planWriteScope;
    if (readRunFailure(record)?.code === "review-result-retention-failed") {
      return {
        command: `docsfab runs show ${shellArgument(record.id)}${stateDirArg} --json`,
        reason:
          "The original review result or its source binding was not retained and verified before success. Inspect the saved run and private artifact store, repair the host evidence producer or store, then start a new review. Do not publish or repeat unchanged inference from this failed run.",
      };
    }
    const failureRecovery = buildFailureRecoveryAction(record, stateDirArg, repoArg);
    if (failureRecovery) return failureRecovery;
    const knowledgeResumeNext = projectKnowledgeResumeNext(record, stateDirArg);
    if (knowledgeResumeNext) return knowledgeResumeNext;
    const humanDecision = projectHumanDecisionNext(
      record,
      stateDirArg,
      context.editorialDecodeOptions,
    );
    if (humanDecision) return humanDecision;
    const wall = projectCapabilityWallNext(record, stateDirArg, context.editorialDecodeOptions);
    if (wall) return wall;
    if (record.status === "failed") {
      return {
        command: `docsfab runs show ${shellArgument(record.id)}${stateDirArg} --json`,
        reason:
          "Inspect the saved run for the failing step and coded rejection. Do not retry unchanged inference from this output.",
      };
    }
    return {
      command: "docsfab doctor --repo '<original target checkout>' --live",
      reason:
        "Against the original target checkout, verify runtime and provider readiness, then rerun the original workflow; structured failure evidence is unavailable.",
    };
  }
  // Review evidence-limitation and blocked-dependency walls must beat ordinary
  // retained-findings copy. Review product-gap findings are the review's
  // product, so they stay on the report path below.
  if (record.status === "succeeded") {
    const noChange = projectVerifiedNoChangeNext(
      record,
      stateDirArg,
      context.editorialDecodeOptions,
    );
    if (noChange) return noChange;
    const wall = projectCapabilityWallNext(record, stateDirArg, context.editorialDecodeOptions);
    if (wall) return wall;
  }
  const templateAudit = templateAuditNext(record, stateDirArg);
  if (templateAudit) return templateAudit;
  const reviewRecovery = buildReviewRecoveryAction(context);
  if (reviewRecovery) return reviewRecovery;
  if (record.workflow === "review-documentation" && reportServeCommand) {
    return {
      command: reportServeCommand,
      reason: htmlReportPath
        ? `Open the retained review report at ${htmlReportPath}.`
        : "Open the retained review report.",
    };
  }
  const authoringNext = projectAuthoringOutcomeNext(
    record,
    stateDirArg,
    context.editorialDecodeOptions,
  );
  if (authoringNext) return authoringNext;
  if (record.status === "succeeded" && record.changes?.patch) {
    return {
      command: `docsfab runs show ${shellArgument(record.id)}${stateDirArg} --json`,
      reason:
        "Inspect the saved product evidence and review the local patch before deciding whether to publish.",
    };
  }
  return undefined;
}

const SCOPE_BOUND_LIMITS: ReadonlyMap<string, LimitDefinition> = new Map(
  Object.values(TECHNICAL_CORRECTION_BYTE_BOUNDS).map(({ code, limit }) => [
    code,
    LIMIT_DEFINITION_BY_NAME[limit]!,
  ]),
);

/**
 * A review stopped at a technical-correction byte bound, at run start or at a
 * step: the scope is too large, so the remedy is a narrower scope, never a
 * rerun or a readiness check.
 */
function buildScopeBoundRecoveryAction(
  record: RunRecord,
  stateDirArg: string,
): RunHumanNextCommand | undefined {
  if (record.status !== "failed") return undefined;
  const terminalStep = [...record.steps].reverse().find((step) => step.status === "failed");
  const code =
    terminalStep?.inference?.attempts.at(-1)?.rejection?.code ?? readRunFailure(record)?.code;
  const definition = code === undefined ? undefined : SCOPE_BOUND_LIMITS.get(code);
  if (!definition) return undefined;
  const targets = record.reviewScope ? retainedOperatorReviewTargets(record) : undefined;
  const basis = targets
    ? `Saved targets: ${targets.join(", ")}.`
    : "The saved review covered the documentation set; inspect its exact inventory before choosing a batch.";
  return {
    command: `docsfab runs show ${shellArgument(record.id)}${stateDirArg}`,
    recoveryAction: "rescope",
    reason:
      `Rescope: the review stopped at ${definition.name} (${definition.refusal}). ${basis} ` +
      `Select an explicit smaller batch with --rescope-from ${shellArgument(record.id)}, --revision ${shellArgument(record.repository.revision)}, and --review-target for each selected page. ` +
      `The original run and remaining pages stay retained. ${definition.remediation}`,
  };
}

/**
 * A declined retry that still had budget is inspect-class, not doctor or a
 * rerun. NEXT names the saved run so the operator can read the remaining
 * budget and the eligibility disagreement.
 */
function buildDeclinedRetryRecoveryAction(
  record: RunRecord,
  stateDirArg: string,
): RunHumanNextCommand | undefined {
  if (record.status !== "failed") return undefined;
  const step = [...record.steps].reverse().find((candidate) => candidate.status === "failed");
  if (!step) return undefined;
  const reading = readTerminalRetryDisposition(step);
  if (!reading || reading.retryDecision !== "declined") return undefined;
  if (typeof reading.retriesRemaining !== "number" || reading.retriesRemaining < 1) {
    return undefined;
  }
  const suffix = formatDeclinedRetryVisibilitySuffix(reading) ?? "";
  return {
    command: `docsfab runs show ${shellArgument(record.id)}${stateDirArg} --json`,
    reason:
      `Inspect the saved run's retry decision and remaining budget.${suffix}` +
      " Do not retry the same inference unchanged.",
  };
}

/**
 * A write step that could not read a required source whole. The saved run names
 * each source, its bytes, and the budget; the reason is the catalog's
 * change-the-request action.
 */
function buildRequiredSourceUnreadAction(
  record: RunRecord,
  stateDirArg: string,
): RunHumanNextCommand | undefined {
  if (record.status !== "failed") return undefined;
  const step = [...record.steps].reverse().find((candidate) => candidate.status === "failed");
  if (!step || readStepFailure(step)?.code !== REQUIRED_SOURCE_UNREAD_CODE) return undefined;
  const reason = situationRowsForId(REQUIRED_SOURCE_UNREAD_CODE).find(
    (row) => row.family === "operator",
  )?.nextAction;
  if (reason === undefined) return undefined;
  return { command: `docsfab runs show ${shellArgument(record.id)}${stateDirArg}`, reason };
}

/**
 * A plan refused at plan admission for a write outside the run's scope, with
 * the remedy that can work for its code: a root for a page outside the roots,
 * or for the directory of a restructure's navigation file outside them, never
 * a root for a file no root admits. An older record names either refusal
 * `advisory-plan-outside-write-roots`.
 */
const PLAN_WRITE_SCOPE_REASONS: Readonly<Record<string, string>> = {
  [PLAN_OUTSIDE_WRITE_ROOTS_CODE]:
    "The plan wrote outside the documentation write roots, so nothing was written. Add each page the failure names, or its directory, to documentationRoots in .docsfab.json and commit the file; for a restructure's navigation file, such as fern/docs.yml, add its directory, such as fern. Or ask only for pages inside the roots. Then start a new run.",
  [PLAN_TARGET_NOT_WRITABLE_CODE]:
    "The plan wrote a file DocsFab never writes: only Markdown and MDX documentation pages, never source, CI, hidden, third-party, or agent instruction files. No page was written. Make that change by hand, or ask for the Markdown page that documents it, then start a new run.",
  "advisory-plan-outside-write-roots":
    "The plan wrote a path outside the documentation write roots or a file DocsFab never writes, so no page was written. Ask only for Markdown or MDX pages inside the roots, or add a page's directory to documentationRoots in .docsfab.json, then start a new run.",
  [PLAN_TARGET_NOT_NAMED_CODE]:
    "The plan wrote an agent instruction file or a hidden path that the request does not name, so nothing was written. DocsFab writes such a file inside the documentation write roots only when the request names it. If the change is meant, name each file the failure lists in the request by its exact repository path, letter case included, such as docs/AGENTS.md rather than ./docs/AGENTS.md; otherwise ask for the change without it. Then start a new run.",
};

function buildPlanWriteScopeAction(record: RunRecord): RunHumanNextCommand | undefined {
  if (record.status !== "failed") return undefined;
  const step = [...record.steps].reverse().find((candidate) => candidate.status === "failed");
  const code = step ? readStepFailure(step)?.code : undefined;
  const reason =
    code !== undefined && Object.hasOwn(PLAN_WRITE_SCOPE_REASONS, code)
      ? PLAN_WRITE_SCOPE_REASONS[code]
      : undefined;
  if (reason === undefined) return undefined;
  if (code === PLAN_TARGET_NOT_NAMED_CODE) {
    const instruction = planTargetNamingRecoveryInstruction(record);
    if (instruction !== undefined) {
      const comparison = record.readerEvidenceRequest?.comparisonRequest;
      const comparisonArguments =
        comparison?.kind === "base-head"
          ? ` --comparison-base ${shellArgument(comparison.baseRevision)}`
          : comparison?.kind === "workspace"
            ? " --comparison-workspace"
            : "";
      const sources = (record.readerEvidenceRequest?.readerSources ?? [])
        .map(({ role, path }) => ` --reader-source ${shellArgument(`${role}=${path}`)}`)
        .join("");
      return {
        command:
          `docsfab run ${record.workflow} --repo ${shellArgument(record.repository.sourcePath)}` +
          ` --revision ${shellArgument(record.repository.revision)} --instruction ${shellArgument(instruction)}` +
          `${comparisonArguments}${sources} --patch-only`,
        reason,
      };
    }
  }
  const request =
    code === PLAN_TARGET_NOT_NAMED_CODE
      ? "the request, naming each file the failure lists by its exact path"
      : "the request, asking only for pages DocsFab may write";
  return {
    command: `docsfab run ${record.workflow} --repo '<original target checkout>' --instruction '<${request}>' --patch-only`,
    reason,
  };
}

/** Operator review and execution of NEXT makes its exact listed paths explicit input. */
export function planTargetNamingRecoveryInstruction(record: RunRecord): string | undefined {
  const step = [...record.steps].reverse().find((candidate) => candidate.status === "failed");
  if (!step || readStepFailure(step)?.code !== PLAN_TARGET_NOT_NAMED_CODE) return undefined;
  const refused = notNamedPlanWritePathsFromMessage(step.error ?? "");
  if (refused.length === 0) return undefined;
  const paths = [...new Set([...(record.operatorTargetPaths ?? []), ...refused])];
  return `${record.instruction ?? "Update the documentation."}\n\nThe intended documentation targets include ${paths.map((path) => `\`${path}\``).join(" and ")}.`;
}

/** What the saved run keeps of the rejected reply, read from its terminal attempt's excerpt. */
function rejectedBodyRetention(
  record: RunRecord,
  step: RunRecord["steps"][number] | undefined,
  stateDirArg: string,
): string {
  const excerpt = step ? readTerminalRetryDisposition(step)?.rejectedReplyExcerpt : undefined;
  if (!excerpt) return "The rejected body was not retained.";
  if (excerpt.segments.some((segment) => segment.withheld === undefined)) {
    return `A bounded, redacted excerpt of the rejected body is in the saved run (\`docsfab runs show ${shellArgument(record.id)}${stateDirArg}\`).`;
  }
  if (excerpt.segments.length > 0) {
    return "The rejected body's excerpt was withheld because the credential screen matched it.";
  }
  return excerpt.replyChars === 0
    ? "The rejected body was empty."
    : `The rejected body was not retained (${excerpt.limit} = ${excerpt.bound}).`;
}

function buildTechnicalResponseRecoveryAction(
  record: RunRecord,
  stateDirArg: string,
): RunHumanNextCommand | undefined {
  if (record.status !== "failed") return undefined;
  const step = [...record.steps].reverse().find((candidate) => candidate.status === "failed");
  const inventoryDiagnosis = sourceObligationFailureReason(step?.error ?? "");
  if (
    step?.id === "derive-source-obligations" &&
    inventoryDiagnosis &&
    inventoryDiagnosis === sourceObligationFailureReason(record.error ?? "")
  ) {
    return {
      command: `docsfab runs show ${shellArgument(record.id)}${stateDirArg} --json`,
      reason: `${inventoryDiagnosis} The source inventory was not admitted as evidence. ${rejectedBodyRetention(record, step, stateDirArg)} Correct the inventory producer or response contract before starting a new run; do not retry the same inference unchanged.`,
    };
  }
  const diagnosis = technicalResponseDiagnosticFromMessage(step?.error);
  if (!diagnosis || diagnosis !== technicalResponseDiagnosticFromMessage(record.error))
    return undefined;
  const attempt = step?.inference?.attempts.at(-1);
  // A terminal refusal, or a prose reply whose correctable retries ran out:
  // either way the last reply was never admitted and no retry follows.
  if (
    attempt?.outcome !== "malformed-response" ||
    attempt.retryScheduled ||
    (attempt.retryable && attempt.condition !== "unframed-reply") ||
    diagnosis.includes("rejected: unknown.")
  )
    return undefined;
  const declinedRetry = step
    ? formatDeclinedRetryVisibilitySuffix(readTerminalRetryDisposition(step))
    : undefined;
  return {
    command: `docsfab runs show ${shellArgument(record.id)}${stateDirArg} --json`,
    reason: `${diagnosis} The model reply was not admitted as evidence.${declinedRetry ?? ""} ${rejectedBodyRetention(record, step, stateDirArg)} This is not a provider-outage diagnosis, and this diagnosis does not establish a provider root cause. Inspect the saved run; do not retry the same inference unchanged.`,
  };
}

function buildOutcomePersistenceRecoveryAction(
  record: RunRecord,
  stateDirArg = "",
): RunHumanNextCommand | undefined {
  if (record.error !== workflowOutcomePersistenceError) return undefined;
  return {
    command: `docsfab runs show ${shellArgument(record.id)}${stateDirArg} --json`,
    reason:
      notReadyToolFailureReason(record) ??
      "Inspect the retained product-outcome and tool-accounting evidence. Preserve the failed run unchanged, correct the outcome projector or tool-accounting producer, then start a new run; do not retry unchanged inference.",
  };
}

/**
 * The reason for a `not-ready` outcome refused for a step's tool evidence,
 * `execution-product-mismatch` at `$.findings`, which only that rule raises:
 * each such step with its categories and the tools whose calls failed, and
 * the retained patch. `undefined` when the record names no such step.
 */
function notReadyToolFailureReason(record: RunRecord): string | undefined {
  const rejection = record.workflowOutcomeRejection;
  if (
    rejection?.code !== "workflow-outcome-admission-execution-product-mismatch" ||
    rejection.location !== "$.findings"
  ) {
    return undefined;
  }
  let failures: NotReadyMaterialToolFailure[];
  try {
    failures = notReadyMaterialToolFailures(record);
  } catch {
    // Condition: saved tool evidence the runner did not write; the generic reason applies.
    return undefined;
  }
  if (failures.length === 0) return undefined;
  const steps = failures.map(({ stepId, categories }) => {
    const failed = (record.steps.find((step) => step.id === stepId)?.tools?.byTool ?? [])
      .filter((entry) => entry.failures > 0)
      .map((entry) => `${entry.name} ${entry.failures}`);
    return `${stepId} recorded ${categories.join(", ")}${failed.length > 0 ? ` (failed calls: ${failed.join(", ")})` : ""}`;
  });
  const patch = record.changes?.patch;
  return [
    `DocsFab refused the not-ready result because a step recorded a tool failure that result cannot carry: ${steps.join("; ")}.`,
    patch
      ? `Review the retained patch at ${patch.artifactPath} before you use it.`
      : "This run retained no patch.",
    "Correct the cause of that failure, then start a new run; do not retry unchanged inference.",
  ].join(" ");
}

/**
 * A run whose final editorial evidence was refused after every step succeeded:
 * NEXT names the recorded inner code and location. A refusal of model replies
 * is inspected in the saved run; any other code is a DocsFab defect to report.
 * Neither is retried unchanged.
 */
function buildEditorialFinalizationRecoveryAction(
  record: RunRecord,
  stateDirArg = "",
): RunHumanNextCommand | undefined {
  if (record.status !== "failed") return undefined;
  const rejection = readEditorialFinalizationRejection(record.editorialFinalizationRejection);
  if (!rejection) return undefined;
  const refused = `Final editorial evidence was refused by ${rejection.code} at ${rejection.location}`;
  const failureClass = RUN_FAILURE_CODE_CLASSES[rejection.code];
  const reason =
    failureClass === "model-content"
      ? `${refused}: ${editorialModelContentRefusal(rejection)} Inspect each assessment step in the saved run; do not retry unchanged inference.`
      : failureClass === "unknown"
        ? `${refused}: the refusal carried no closed code. Report the saved run as a DocsFab defect; do not retry unchanged inference.`
        : `${refused}: a DocsFab check of evidence the host bound failed after every step succeeded. Report the saved run as a DocsFab defect; do not retry unchanged inference.`;
  return {
    command: `docsfab runs show ${shellArgument(record.id)}${stateDirArg} --json`,
    reason,
  };
}

/** What a model-content finalization refusal found in the assessments. */
function editorialModelContentRefusal(rejection: EditorialFinalizationRejectionV1): string {
  if (rejection.code === EDITORIAL_FINALIZATION_CONFLICTING_ASSESSMENT_CODE) {
    return "the evaluator's rationale repeats the planner's, so it is not independent evidence.";
  }
  return rejection.location === NO_CHANGE_ASSESSMENT_LOCATION
    ? "the independent assessments do not confirm the no-change. A no-change needs verify-technical-accuracy and review-documentation to answer accepted, and evaluate-document-quality to answer accepted or not-applicable."
    : "the independent assessments do not support the final editorial decision.";
}

function buildAuthoringRevisionAccountingRecoveryAction(
  record: RunRecord,
  stateDirArg = "",
): RunHumanNextCommand | undefined {
  if (record.workflow !== "create-documentation" || record.status !== "failed") return undefined;
  const terminalFailedStep = [...record.steps].reverse().find((step) => step.status === "failed");
  if (terminalFailedStep?.id !== REVISE_DOCUMENTATION_STEP_ID) return undefined;
  const stepDiagnostic = authoringRevisionAccountingDiagnosticFromMessage(terminalFailedStep.error);
  const runDiagnostic = authoringRevisionAccountingDiagnosticFromMessage(record.error);
  if (!stepDiagnostic || stepDiagnostic !== runDiagnostic) return undefined;
  const terminalAttempt = terminalFailedStep.inference?.attempts.at(-1);
  if (!terminalAttempt) return undefined;
  // An in-attempt refusal records its code on the attempt, and a
  // model-correctable one is retryable, so the recorded code must match.
  const attemptCoded =
    terminalAttempt.outcome === "malformed-response" &&
    revisionAccountingDiagnosticForRejectionCode(terminalAttempt.rejection?.code) ===
      stepDiagnostic;
  const decoderStageFailure =
    (terminalAttempt.outcome === "malformed-response" && !terminalAttempt.retryable) ||
    attemptCoded;
  const mutationStageFailure = terminalAttempt.outcome === "succeeded" || attemptCoded;
  const stageMatchesDiagnostic =
    stepDiagnostic === "historical-generic"
      ? decoderStageFailure || mutationStageFailure
      : stepDiagnostic === "changed-path-mismatch" || stepDiagnostic === "unchanged-applied"
        ? mutationStageFailure
        : decoderStageFailure;
  if (!stageMatchesDiagnostic) return undefined;
  const diagnosticName =
    stepDiagnostic === "historical-generic"
      ? "the historical revision-accounting rejection"
      : `revision-accounting-${stepDiagnostic}`;
  const diagnosticLimitation =
    stepDiagnostic === "historical-generic" ? " The exact rejected predicate is unavailable." : "";
  const candidateState = authoringRevisionCandidateState(record);
  return {
    command: `docsfab runs show ${shellArgument(record.id)}${stateDirArg} --json`,
    reason: `Inspect the saved run and ${diagnosticName}.${diagnosticLimitation} The revision producer and host accounting contract disagreed. ${candidateState} Correct the producer or contract before starting a new run; do not replay or retry the unchanged inference or write step.`,
  };
}

function authoringRevisionCandidateState(record: RunRecord): string {
  if (record.authoringExecution !== undefined) {
    try {
      const retainedWorkflow = decodeRetainedAuthoringWorkflowV1(record.authoringExecution);
      const execution = validateAuthoringRunRecordV1(record, retainedWorkflow);
      if (
        execution.selectedCandidate?.ordinal === 0 &&
        execution.finalPatch?.candidateOrdinal === 0
      ) {
        return "Candidate 0 remains selected; any retained candidate-1 failed partial is non-deliverable.";
      }
    } catch {
      // Candidate state remains unavailable when canonical retained evidence is invalid.
    }
  }
  return "Candidate selection and failed-partial status could not be verified.";
}

/**
 * NEXT for a run stopped before its first step because the request
 * interpretation read it as forbidding publication while its delivery would
 * publish: the next action the request-text refusal names.
 */
function projectPublicationProhibitionNext(record: RunRecord): RunHumanNextCommand | undefined {
  if (record.status !== "failed") return undefined;
  if (readRunFailure(record)?.code !== "publication-prohibition-conflict") return undefined;
  return {
    command: buildRunRetryCommand(record),
    reason:
      "The request interpretation read the request as forbidding publication, but this delivery would publish, so no step ran. Pass --patch-only to retain a local patch without publishing.",
  };
}

/**
 * NEXT for a run the request interpretation stopped before its first step.
 * Handles only a record whose recorded interpretation outcome is a stop; a
 * run that went on past its interpretation, or predates it, gets undefined
 * so the step and failure branches below decide.
 */
function projectRequestIntentStopNext(
  record: RunRecord,
  stateDirArg: string,
): RunHumanNextCommand | undefined {
  if (record.requestIntent === undefined) return undefined;
  const inspect = `docsfab runs show ${shellArgument(record.id)}${stateDirArg} --json`;
  let decoded: RunRecordRequestIntentV1;
  try {
    decoded = decodeRunRecordRequestIntent(record.requestIntent, record.instruction);
  } catch (error) {
    if (!(error instanceof RequestIntentContractError)) throw error;
    const claimed = (record.requestIntent as { admission?: { outcome?: unknown } }).admission
      ?.outcome;
    if ((REQUEST_INTENT_CONTINUING_OUTCOMES as readonly unknown[]).includes(claimed)) {
      return undefined;
    }
    return {
      command: inspect,
      reason: `The recorded request interpretation does not verify against the run's instruction (${error.code}); inspect the record, then start a new run.`,
    };
  }
  const { admission, intent } = decoded;
  const restate = `docsfab run ${record.workflow} --repo '<original target checkout>' --instruction '<the request restated>' --patch-only`;
  const catalogNext = (code: string | null): string =>
    code !== null && Object.hasOwn(OUTPUT_RULES, code)
      ? OUTPUT_RULES[code as keyof typeof OUTPUT_RULES].operator.next
      : "";
  switch (admission.outcome) {
    case "question": {
      const question = intent?.question;
      if (!question) return undefined;
      return {
        command: restate,
        reason:
          `The request interpretation needs one answer before any step runs. Question: ${question.question} Options: ${question.options.join(" | ")}. Recommended: ${question.recommendedDefault}. If you take it: ${question.consequence} ${catalogNext(admission.code)}`.trimEnd(),
      };
    }
    case "refused": {
      const boundary = admission.boundary
        ? ` The request names ${admission.boundary.observed}, ${describeRequestIntentBoundary(admission.boundary)}. ${admission.boundary.remediation}`
        : "";
      return {
        command: restate,
        reason:
          `The request interpretation refused the request (${admission.code}).${boundary} ${catalogNext(admission.code)}`.trimEnd(),
      };
    }
    case "rejected":
      return {
        command: inspect,
        reason: `The request interpretation's model reply still broke ${admission.code} after every re-ask. Inspect the interpretation attempts; do not retry unchanged.`,
      };
    case "unavailable":
      return admission.code === "request-intent-model-deadline"
        ? {
            command: inspect,
            reason:
              "The request interpretation passed its deadline before the model answered; no step ran. Retry once the provider responds, or lower the request size.",
          }
        : {
            command: "docsfab doctor --repo '<original target checkout>' --live",
            reason:
              "The request interpretation could not reach the bound model; no step ran. Check provider readiness, then start the run again.",
          };
    default:
      return undefined;
  }
}

/**
 * NEXT for a run first pass stopped before its first step because repository
 * sources disagree. Handles only a record carrying `firstPassContradiction`;
 * every other needs-input or failed run gets undefined so the branches below
 * decide.
 */
function projectFirstPassContradictionNext(
  record: RunRecord,
  stateDirArg: string,
): RunHumanNextCommand | undefined {
  if (record.firstPassContradiction === undefined) return undefined;
  let question: RunRecordFirstPassContradictionV1["question"];
  try {
    question = decodeRunRecordFirstPassContradiction(record.firstPassContradiction).question;
  } catch (error) {
    if (!(error instanceof RunRecordFirstPassContradictionError)) throw error;
    return {
      command: `docsfab runs show ${shellArgument(record.id)}${stateDirArg} --json`,
      reason:
        "The recorded first-pass question does not have the shape DocsFab writes; inspect the record, then start a new run.",
    };
  }
  let liveReply = "";
  if (record.firstPassContradictionAdmission !== undefined) {
    try {
      const admission = decodeFirstPassContradictionAdmission(
        record.firstPassContradictionAdmission,
      );
      if (admission.outcome === "repository-only") {
        liveReply =
          " In the current live-agent session, reply with one exact offered source option. A unique verified executable implementation side also accepts 'Use the implementation'. The answer is attributed and remains unverified.";
      }
    } catch {
      // A malformed marker grants no continuation; the saved-run decoder names it.
    }
  }
  return {
    command: `docsfab run ${record.workflow} --repo '<original target checkout>' --instruction '<the request restated>' --patch-only`,
    reason: `First pass found repository sources that disagree and needs one answer before any step runs. Question: ${question.question} Options: ${question.options.join(" | ")}. Recommended: ${question.recommendedDefault}. If you take it: ${question.consequence}${liveReply} To start fresh, correct the source that is wrong in the checkout, or restate the request without the disputed value, then run it again.`,
  };
}

function projectEditorialInputAskNext(
  record: RunRecord,
  context: RunFooterProjectionContext,
): RunHumanNextCommand | undefined {
  if (!isEditorialInputAskRecord(record)) return undefined;
  const state = workflowOutcomeState(record, context.editorialDecodeOptions);
  if (state.state !== "current" || state.outcome.disposition !== "needs-input") return undefined;
  const slots = state.outcome.findings.flatMap((finding) => {
    if (finding.kind !== "missing-governed-input" || finding.inputId === undefined) return [];
    const presentation = editorialInputAskPresentationV1(finding.inputId);
    return presentation ? [{ inputId: finding.inputId, ...presentation }] : [];
  });
  if (slots.length === 0) return undefined;
  return {
    command: `docsfab do --continue ${shellArgument(record.id)}`,
    reason: `Continue the original job after supplying the named InputAsk fills: ${slots
      .map((slot) => `${slot.label} (${slot.fillKind})`)
      .join(", ")}.`,
  };
}

function projectHumanDecisionNext(
  record: RunRecord,
  stateDirArg: string,
  editorialDecodeOptions?: WorkflowOutcomeDecodeOptionsV1,
): RunHumanNextCommand | undefined {
  if (record.status !== "needs-human-decision") return undefined;
  const state = workflowOutcomeState(record, editorialDecodeOptions);
  if (state.state !== "current") return undefined;
  const decisions = state.outcome.openDecisions.filter(
    (decision) => decision.kind === "human-decision",
  );
  if (decisions.length === 0) return undefined;
  const ids = decisions.map((decision) => decision.id).join(", ");
  return {
    command: `docsfab runs show ${shellArgument(record.id)}${stateDirArg} --json`,
    reason: `Supply the open human decision ${ids}. This stop stays needs-human-decision; knowledge --resume-from is refused.`,
  };
}

/**
 * Capability or policy wall finding kinds, each with the wall in English. The
 * handling is Redirect: change the request, wait for the capability, or accept
 * an incomplete outcome.
 */
const CAPABILITY_WALL_FINDING_KINDS: Readonly<
  Partial<Record<WorkflowOutcomeFindingV1["kind"], string>>
> = Object.freeze({
  "evidence-limitation": "the admitted evidence cannot support a complete result",
  "blocked-dependency": "a required dependency or approval is outside this run",
  "roadmap-gap": "the requested capability is on the roadmap and not shipped",
  "product-gap": "the product does not provide what the request needs",
});

/** Non-retryable inference categories that are provider capability walls. */
const CAPABILITY_WALL_INFERENCE_CATEGORIES: Readonly<Record<string, string>> = Object.freeze({
  "invalid-request":
    "the model provider rejected this request deterministically; the FAILURE lines carry the provider status",
  "provider-terminal": "the model provider ended this request with a non-retryable failure",
});

/**
 * A review job delivers gap findings about the reviewed documentation; those
 * are its product, not a wall on the review request. Review keeps its own
 * findings/report NEXT, and only these kinds redirect a review request.
 */
const REVIEW_CAPABILITY_WALL_FINDING_KINDS: ReadonlySet<WorkflowOutcomeFindingV1["kind"]> = new Set(
  ["evidence-limitation", "blocked-dependency"],
);

const CAPABILITY_WALL_REDIRECT =
  "This is a capability or policy wall, not missing input. Change the request instead: narrow or retarget it, wait for the capability, or accept the outcome as incomplete. Do not retry the unchanged request.";

/**
 * Redirect NEXT for a structured product-outcome wall, or `undefined` when no
 * wall exists or a `missing-governed-input` finding makes supply the owning
 * door. A wall never yields an InputAsk slot, a continue command, or a retry.
 */
function projectCapabilityWallNext(
  record: RunRecord,
  stateDirArg: string,
  editorialDecodeOptions?: WorkflowOutcomeDecodeOptionsV1,
): RunHumanNextCommand | undefined {
  let state: ReturnType<typeof workflowOutcomeState>;
  try {
    state = workflowOutcomeState(record, editorialDecodeOptions);
  } catch {
    // The PRODUCT plane owns reporting an undecodable outcome; NEXT projects
    // a wall only from admitted evidence.
    return undefined;
  }
  if (state.state !== "current") return undefined;
  // Failed, unmapped, and unenumerated pages are what a template audit
  // reports, with counts; none of them is a wall on the audit request.
  if (record.workflow === TEMPLATE_AUDIT_WORKFLOW) return undefined;
  const { findings } = state.outcome;
  if (findings.some((finding) => finding.kind === "missing-governed-input")) return undefined;
  const codesByKind = new Map<WorkflowOutcomeFindingV1["kind"], string[]>();
  for (const finding of findings) {
    if (CAPABILITY_WALL_FINDING_KINDS[finding.kind] === undefined) continue;
    if (isAuthoringNonWallFinding(record, finding)) continue;
    // Uncited sentences label the retained patch; they are not a wall on the request.
    if (finding.code === SOURCE_CITATION_GAPS_LIMITATION) continue;
    // A no-change basis code discloses how the run verified that no change was
    // needed; it is never a wall on the request.
    if (isNoChangeBasisLimitation(finding.code)) continue;
    if (
      record.workflow === "review-documentation" &&
      !REVIEW_CAPABILITY_WALL_FINDING_KINDS.has(finding.kind)
    ) {
      continue;
    }
    const codes = codesByKind.get(finding.kind) ?? [];
    if (!codes.includes(finding.code)) codes.push(finding.code);
    codesByKind.set(finding.kind, codes);
  }
  if (codesByKind.size === 0) return undefined;
  const walls = [...codesByKind]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([kind, codes]) => `${kind} ${codes.join(", ")} (${CAPABILITY_WALL_FINDING_KINDS[kind]})`);
  const patch = record.changes?.patch
    ? " The retained local patch does not resolve the wall; review it before any publish."
    : "";
  return {
    command: `docsfab runs show ${shellArgument(record.id)}${stateDirArg} --json`,
    reason: `Product ${state.outcome.disposition} at a wall: ${walls.join("; ")}. ${CAPABILITY_WALL_REDIRECT}${patch}`,
  };
}

/** NEXT for a succeeded template audit: read the per-page report, fix, and rerun. */
function templateAuditNext(
  record: RunRecord,
  stateDirArg: string,
): RunHumanNextCommand | undefined {
  if (record.workflow !== TEMPLATE_AUDIT_WORKFLOW || record.status !== "succeeded")
    return undefined;
  const report = retainedTemplateAuditReport(record);
  if (!report) return undefined;
  const { coverage } = report;
  const actions = [
    ...(coverage.failed > 0 ? [`fix the ${coverage.failed} failed pages`] : []),
    ...(coverage.refused > 0
      ? [`resolve the ${coverage.refused} refused pages as their PRODUCT lines say`]
      : []),
    ...(coverage.unmapped > 0
      ? [`declare a \`template:\` frontmatter key on the unmapped pages you want audited`]
      : []),
  ];
  const result =
    coverage.failed > 0
      ? `${coverage.failed} of ${coverage.checked} checked pages failed their template.`
      : `No checked page failed; ${coverage.checked} of ${coverage.enumerated} pages were checked.`;
  return {
    command: `docsfab runs show ${shellArgument(record.id)}${stateDirArg} --json`,
    reason:
      actions.length > 0
        ? `Read every per-page finding: ${result} Then ${actions.join(", ")}, and run the audit again; the audit itself writes nothing.`
        : `All ${coverage.checked} pages passed their templates. Read the JSON for warnings, such as section order and leftover placeholders.`,
  };
}

/**
 * NEXT for a succeeded run whose editorial outcome is `verified-no-change`:
 * the run answered the request, so NEXT never redirects it. It names
 * the pages the plan kept, for review if the operator disagrees, then the
 * basis, and lists the decision's other limitations as recorded. `undefined`
 * for any other run.
 */
function projectVerifiedNoChangeNext(
  record: RunRecord,
  stateDirArg: string,
  editorialDecodeOptions?: WorkflowOutcomeDecodeOptionsV1,
): RunHumanNextCommand | undefined {
  if (record.status !== "succeeded") return undefined;
  let editorial: ReturnType<typeof projectRunEditorialOutcome>;
  try {
    editorial = projectRunEditorialOutcome(record, editorialDecodeOptions);
  } catch {
    // The EDITORIAL plane owns reporting undecodable editorial evidence.
    return undefined;
  }
  if (editorial.outcome !== "verified-no-change") return undefined;
  const kept = admittedKeptUnchangedPages(record);
  const recorded = editorial.limitations.filter((code) => !isNoChangeBasisLimitation(code));
  const sentences = [
    kept.length > 0
      ? `No documentation change needed; review the kept pages if you disagree: ${kept.join(", ")}.`
      : "No documentation change needed; review the saved evidence if you disagree.",
    `Basis: ${noChangeBasisPhrase(editorial.limitations) ?? "base and head commit comparison"}.`,
  ];
  if (recorded.length > 0) sentences.push(`Recorded limitations: ${recorded.join(", ")}.`);
  return {
    command: `docsfab runs show ${shellArgument(record.id)}${stateDirArg} --json`,
    reason: sentences.join(" "),
  };
}

/**
 * An authoring `evidence-limitation` finding derived from the evaluate or
 * audience step. The request did not cause it, so it is not a wall.
 */
function isAuthoringNonWallFinding(record: RunRecord, finding: WorkflowOutcomeFindingV1): boolean {
  return (
    isAuthoringQualityOutcomeWorkflow(record.workflow) &&
    finding.kind === "evidence-limitation" &&
    classifyAuthoringQualityNonWallCode(finding.code) !== undefined
  );
}

/**
 * NEXT for a succeeded authoring job with no wall (the wall check runs first)
 * and at least one standing or advisory finding: review the retained patch,
 * else inspect the saved run. The reason presents the evaluator's decision and
 * hard gates as model-authored advisory evidence.
 */
function projectAuthoringOutcomeNext(
  record: RunRecord,
  stateDirArg: string,
  editorialDecodeOptions?: WorkflowOutcomeDecodeOptionsV1,
): RunHumanNextCommand | undefined {
  if (record.status !== "succeeded" || !isAuthoringQualityOutcomeWorkflow(record.workflow)) {
    return undefined;
  }
  let state: ReturnType<typeof workflowOutcomeState>;
  try {
    state = workflowOutcomeState(record, editorialDecodeOptions);
  } catch {
    // Same rule as the wall: the PRODUCT plane reports an undecodable outcome.
    return undefined;
  }
  if (state.state !== "current") return undefined;
  const standing: string[] = [];
  const advisory: string[] = [];
  const citationGaps = state.outcome.findings.some(
    (finding) => finding.code === SOURCE_CITATION_GAPS_LIMITATION,
  );
  for (const finding of state.outcome.findings) {
    if (!isAuthoringNonWallFinding(record, finding)) continue;
    const codes =
      classifyAuthoringQualityNonWallCode(finding.code) === "standing" ? standing : advisory;
    if (!codes.includes(finding.code)) codes.push(finding.code);
  }
  if (standing.length === 0 && advisory.length === 0 && !citationGaps) return undefined;
  const patch = record.changes?.patch;
  const sentences = [
    patch
      ? `Review the retained patch at ${patch.artifactPath} before deciding whether to publish.`
      : "Inspect the saved product evidence; this run retained no patch.",
    standing.length > 0
      ? `Product ${state.outcome.disposition}; standing limitations of this workflow's evaluation, not a wall on this request: ${standing.join(", ")}.`
      : `Product ${state.outcome.disposition}.`,
  ];
  if (citationGaps) {
    sentences.push(
      `Some sentences the writer added have no verified source citation (${SOURCE_CITATION_GAPS_LIMITATION}); check each page and line that PRODUCT lists against the bound sources before you publish.`,
    );
  }
  if (advisory.length > 0) {
    sentences.push(
      `Quality evaluation (model-authored, advisory; not a product verdict): ${advisory.join(", ")}.`,
    );
  }
  return {
    command: `docsfab runs show ${shellArgument(record.id)}${stateDirArg} --json`,
    reason: sentences.join(" "),
  };
}

function capabilityWallInferenceNext(
  record: RunRecord,
  category: string,
  stateDirArg: string,
): RunHumanNextCommand | undefined {
  const wall = CAPABILITY_WALL_INFERENCE_CATEGORIES[category];
  if (wall === undefined) return undefined;
  return {
    command: `docsfab runs show ${shellArgument(record.id)}${stateDirArg} --json`,
    reason: `Inference stopped at a wall: ${category} (${wall}). ${CAPABILITY_WALL_REDIRECT}`,
  };
}

function projectKnowledgeResumeNext(
  record: RunRecord,
  stateDirArg: string,
): RunHumanNextCommand | undefined {
  if (
    record.status !== "needs-input" ||
    (record.workflow !== "create-documentation" && record.workflow !== "update-documentation")
  )
    return undefined;
  if (!record.knowledgeContinuationReceipt) {
    return {
      command: `docsfab runs show ${shellArgument(record.id)}${stateDirArg} --json`,
      reason:
        "This knowledge stop has no retained continuation receipt, so --resume-from cannot bind it. Inspect the saved input request, then start a new run with that input.",
    };
  }
  const authorization = record.error === "needs-authorization";
  // The resume binds the same preset and command-line settings as the stop.
  const settings = commandLineSettings(record.modelSettings?.writing);
  const compositionId = settings.compositionId ?? record.compositionExecution?.compositionId;
  return {
    command:
      `docsfab run ${record.workflow} --repo '<original target checkout>'` +
      (compositionId ? ` --composition ${shellArgument(compositionId)}` : "") +
      settings.sets.map((pair) => ` --set ${shellArgument(pair)}`).join("") +
      ` --resume-from ${shellArgument(record.id)}` +
      " --canon-snapshot '<attributed-snapshot.json>' --accept-candidate-snapshot" +
      " --authority-id '<accountable-authority-id>' --allow-write --patch-only",
    reason: authorization
      ? "Authorize a documentation write root such as docs/ or fern/ (InputAsk), then resume this retained task."
      : "Supply attributed knowledge and resume this retained task.",
    recoveryAction: "resume",
  };
}

/**
 * The readiness check per proxy refusal a governed step records: doctor reads
 * a refused setting offline, and a proxy's 403 or 407 only on a live request.
 * An unreachable proxy is never recorded on a step, so it has no entry.
 */
const PROXY_REFUSAL_DOCTOR_FLAGS: Readonly<
  Record<`outbound-proxy-${Exclude<OutboundProxyRefusalKind, "unreachable">}`, string>
> = {
  "outbound-proxy-invalid": "",
  "outbound-proxy-not-enabled": "",
  "outbound-proxy-denied": " --live",
  "outbound-proxy-auth-required": " --live",
};

/**
 * Handles only a terminal step whose persisted failure code is one of the
 * proxy refusals above; the reason is that code's operator catalog row, so a
 * different code of the same class, or the same attempt outcome, never reads
 * as a proxy fault.
 */
function buildProxyRefusalRecoveryAction(
  step: RunRecord["steps"][number],
  repoArg: string,
): RunHumanNextCommand | undefined {
  const code = readStepFailure(step)?.code;
  if (code === undefined || !Object.hasOwn(PROXY_REFUSAL_DOCTOR_FLAGS, code)) return undefined;
  const reason = situationRowsForId(code).find((row) => row.family === "operator")?.nextAction;
  if (reason === undefined) return undefined;
  const live = PROXY_REFUSAL_DOCTOR_FLAGS[code as keyof typeof PROXY_REFUSAL_DOCTOR_FLAGS];
  return { command: `docsfab doctor${repoArg}${live}`, reason };
}

function buildFailureRecoveryAction(
  record: RunRecord,
  stateDirArg = "",
  repoArg = "",
): RunHumanNextCommand | undefined {
  const terminalStep = [...record.steps]
    .reverse()
    .find((step) => step.status === "failed" || step.status === "needs-input");
  const terminalAttempt = terminalStep?.inference?.attempts.at(-1);
  if (!terminalAttempt || terminalAttempt.outcome === "succeeded") return undefined;
  const proxyRefusal = terminalStep && buildProxyRefusalRecoveryAction(terminalStep, repoArg);
  if (proxyRefusal) return proxyRefusal;
  // A request that never connected is about the configured endpoint, not the
  // provider's capacity or this request, so neither waiting nor rewording helps.
  if (terminalAttempt.modelTelemetry?.providerError?.class === "unreachable") {
    return {
      command: `docsfab doctor${repoArg} --live`,
      reason:
        "DocsFab could not connect to the model endpoint: the connection was refused, the host name did not resolve, or no route reached it. Check the endpoint URL shown by docsfab setup and the network, then confirm the endpoint answers with docsfab doctor --live before rerunning.",
    };
  }
  if (terminalAttempt.outcome === "host-runtime-failure") {
    return {
      command: `docsfab runs show ${shellArgument(record.id)}${stateDirArg} --json`,
      reason:
        "The host execution-lease coordinator rejected a checkpoint transition. Preserve the saved attempt evidence and repair the host runtime before retrying; this result does not identify a provider failure.",
    };
  }
  if (["timeout", "throttled", "provider-transient"].includes(terminalAttempt.outcome)) {
    const command = buildProviderRetryCommand(record, stateDirArg);
    return {
      command,
      ...(command.startsWith("docsfab run ") ? { recoveryAction: "retrySame" as const } : {}),
      reason: retryRecoveryReason(
        record,
        "The recorded bounded provider retries ended on a transient failure. Retry the approved request only after the provider condition clears.",
      ),
    };
  }
  if (terminalAttempt.outcome === "malformed-response") {
    return terminalAttempt.retryable
      ? {
          command: `docsfab runs show ${shellArgument(record.id)}${stateDirArg} --json`,
          reason:
            "The bounded malformed-response correction policy ended. Inspect admitted attempt evidence and correct the stage producer or response contract before starting a new run.",
        }
      : {
          command: "docsfab doctor --repo '<original target checkout>' --live",
          reason:
            "The response schema or decoder capability was unavailable or rejected deterministically. Restore that host capability before starting a new run; do not repeat unchanged inference.",
        };
  }
  const inferenceWall = capabilityWallInferenceNext(record, terminalAttempt.outcome, stateDirArg);
  if (inferenceWall) return inferenceWall;
  // A governor ceiling stop records `context-exhausted` and a lease ceiling stop
  // `no-progress`; no readiness check clears either: the model used the step's
  // whole allowance before answering.
  const failureCode = classifyInferenceAttempt(terminalAttempt)?.code;
  if (failureCode !== undefined && STEP_EXECUTION_CEILING_CODES.has(failureCode)) {
    return {
      command: `docsfab runs show ${shellArgument(record.id)}${stateDirArg}`,
      reason:
        "The step used its whole execution ceiling before the model answered. Narrow the request, for example to fewer pages or sources, or use another model for the step; the saved run names the ceiling.",
    };
  }
  if (["blank-response", "context-exhausted"].includes(terminalAttempt.outcome)) {
    return {
      command: "docsfab doctor --repo '<original target checkout>' --live",
      reason:
        "Inspect the recorded output and context limits, then correct the runtime or model configuration before starting a new run.",
    };
  }
  return undefined;
}

function buildReviewRecoveryAction(
  context: RunFooterProjectionContext,
): RunHumanNextCommand | undefined {
  const { record, reviewFindingsProjection: projection } = context;
  if (record.workflow !== "review-documentation" || !projection) return undefined;
  if (
    projection.availability === "unavailable" &&
    projection.artifactLocator === null &&
    projection.limitations.length === 0
  )
    return undefined;
  const stateDirArg =
    context.recordPath !== undefined && context.recordPath.length > 0
      ? ` --state-dir ${shellArgument(dirname(context.recordPath))}`
      : "";
  const command =
    context.reportServeCommand ??
    `docsfab runs show ${shellArgument(record.id)}${stateDirArg} --json`;
  if (projection.availability === "complete" || projection.availability === "partial") {
    if (projection.findings.length > 0) {
      return {
        command,
        reason:
          "Inspect the admitted findings and coverage limitations. Repairing target documentation requires a separate write grant; do not rerun the unchanged review.",
      };
    }
    return {
      command,
      reason:
        projection.availability === "complete"
          ? "The supported findings projection is empty. Inspect the recorded package-check and audience-evidence status before treating the review as fully qualified."
          : "The findings projection is partial. Inspect its named source limitations; an empty count does not establish zero defects.",
    };
  }
  const limitations = projection.limitations.join("\n");
  if (limitations.includes("artifact-unavailable:evaluate-document-quality:schema")) {
    return {
      command,
      reason:
        "Restore the installed runtime evaluation schema, then replay locally. Preserve the retained run and artifact bytes; do not rerun inference.",
    };
  }
  if (limitations.includes("artifact-unavailable:evaluate-document-quality:artifact-absent")) {
    return {
      command,
      reason:
        "Restore the matching known-good retained record and artifact set, then replay locally. Preserve their integrity bindings; do not rerun inference.",
    };
  }
  if (projection.availability === "invalid") {
    return {
      command,
      reason:
        "The retained evaluation or its binding is invalid. Recover a matching known-good record and artifact set or correct the producer; do not edit sealed evidence or rerun unchanged inference.",
    };
  }
  return {
    command,
    reason:
      "No admitted evaluation artifact was recorded. Inspect the readable report and run limitations; the evaluation producer owner must supply validated evidence before findings can be projected. Do not restore or rerun an artifact that never existed.",
  };
}

function collectRunNextSteps(context: RunSummaryContext): string[] {
  const { record } = context;
  const steps: string[] = [];
  const stateDirArg =
    context.recordPath !== undefined && context.recordPath.length > 0
      ? ` --state-dir ${shellArgument(dirname(context.recordPath))}`
      : "";
  if (context.iaContinuation?.length) {
    for (const line of context.iaContinuation) {
      if (line.startsWith("Action:") || line.startsWith("Disposition:")) steps.push(line);
    }
  }
  if (record.status === "succeeded" && record.changes?.patch) {
    const patchAction = buildRunHumanNextCommand(context);
    if (patchAction) steps.push(patchAction.command, patchAction.reason);
  }
  if (
    ["failed", "needs-input", "needs-human-decision"].includes(record.status) &&
    steps.length === 0
  ) {
    const recovery = buildRunHumanNextCommand(context);
    if (recovery) steps.push(recovery.command, recovery.reason);
    return steps;
  }
  if (steps.length === 0 && record.status === "succeeded") {
    const next =
      projectVerifiedNoChangeNext(record, stateDirArg, context.editorialDecodeOptions) ??
      projectCapabilityWallNext(record, stateDirArg, context.editorialDecodeOptions);
    if (next) {
      steps.push(next.command, next.reason);
      return steps;
    }
  }
  if (steps.length === 0) {
    const reviewRecovery = buildReviewRecoveryAction(context);
    if (reviewRecovery) {
      steps.push(reviewRecovery.command, reviewRecovery.reason);
      return steps;
    }
  }
  if (
    steps.length === 0 &&
    record.workflow === "review-documentation" &&
    context.reportServeCommand
  ) {
    if (context.htmlReportPath) {
      steps.push(`Review the retained HTML report at ${context.htmlReportPath}.`);
    }
    if (context.markdownReportAvailable && context.markdownReportPath) {
      steps.push(`Read the retained evaluator report at ${context.markdownReportPath}.`);
    } else if (context.markdownReportAvailable === false) {
      steps.push(
        `The retained evaluator Markdown artifact is unavailable (${context.markdownReportUnavailableReason ?? "unknown"}).`,
      );
    }
    const reportAction = buildRunHumanNextCommand(context);
    if (reportAction) steps.push(reportAction.command, reportAction.reason);
  }
  if (steps.length === 0 && record.status === "succeeded") {
    // A succeeded run whose outcome names a capability wall still owes its
    // redirect; empty `nextSteps` there is a dead end.
    const wall = buildRunHumanNextCommand(context);
    if (wall) steps.push(wall.command, wall.reason);
  }
  return steps;
}

/** Next-step lines for the canonical JSON run envelope. */
export function collectRunResultNextSteps(context: RunSummaryContext): string[] {
  return collectRunNextSteps(context);
}
