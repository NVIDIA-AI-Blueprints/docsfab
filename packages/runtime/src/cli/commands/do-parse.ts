// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { resolve } from "node:path";

import {
  DelegatedTaskResultError,
  delegatedTaskContractKit,
} from "../../delegated-task/result-contract.js";
import type { ChangeRequestSelectorV1 } from "../../inputs/change-request-selector.js";
import type { ChangeSourceSelectorV1 } from "../../inputs/change-source.js";
import {
  continuationBindingFlagConflict,
  type OperatorInputResumePlanV1,
} from "../../inputs/operator-input-fill.js";
import { parseCommentMrTarget } from "../comment-existing-mr-target.js";
import { DEFAULT_REPOSITORY_PATH, deliveryFlagConflict } from "../delivery-grants.js";
import { option, options } from "../options.js";
import {
  CHANGE_REQUEST_SELECTOR_OPTIONS,
  admitCliChangeSourceSelection,
  admitCliSourceSelection,
  assertLocalRepositoryPath,
  parsePublicationRemoteName,
} from "../run-arguments.js";
import type { RunArguments } from "../types.js";

const DELEGATED_ROUTE_ONLY_CONFLICT =
  "docsfab do --delegate cannot be combined with --route-only; classification is not delegated execution. Omit --delegate to classify, or omit --route-only to run the delegated pilot.";
const DELEGATED_DRY_RUN_CONFLICT =
  "docsfab do --delegate cannot be combined with --dry-run; dry-run keeps catalog no-agent/no-write behavior. Omit --delegate to keep --dry-run, or omit --dry-run to run the delegated pilot.";
const DELEGATED_REVISION_UNSUPPORTED =
  "Delegated do does not accept --revision. The task uses the current checkout committed HEAD. Omit --revision, or use catalog do / docsfab run when you must name a revision.";
const DELEGATED_PATCH_ONLY_UNSUPPORTED =
  "Delegated do does not accept --patch-only. Pass --allow-write for requested local documentation changes; remote publication remains unsupported. Catalog do still accepts --patch-only.";
const DELEGATED_DRAFT_MR_UNSUPPORTED =
  "Delegated do does not accept --draft-mr. Remote publication is unsupported on this pilot. Use catalog do or docsfab run when you need a draft merge request.";
const DELEGATED_COMMENT_MR_UNSUPPORTED =
  "Delegated do does not accept --comment-mr. Commenting on an existing merge request remains catalog do / docsfab run.";
const DELEGATED_REMOTE_UNSUPPORTED =
  "Delegated do does not accept --remote. This pilot does not publish. Omit --remote, or use catalog do / docsfab run.";
const DELEGATED_INSTRUCTION_UNSUPPORTED =
  "Delegated do does not accept --instruction. The quoted sentence is the work. Omit --instruction, or use catalog do / docsfab run.";
const DELEGATED_CONTINUE_UNSUPPORTED =
  "Delegated do does not accept --continue. Resume that exact delegated task with --resume <task-id> --answers <json-file>.";
const DELEGATED_ATTACH_UNSUPPORTED =
  "Delegated do does not accept --attach. Resume that exact delegated task with --resume <task-id> --answers <json-file>.";
const DELEGATED_STUDY_UNSUPPORTED =
  "Delegated do does not accept --study. Omit --study, or use catalog do.";
/**
 * Bound sources stay on the catalog workflow runner. Admitting `--source`,
 * `--pr` or `--change` in the delegated pilot would either mint a second
 * binding outside the runner or silently drop the operator's evidence, so it
 * refuses and names the surface that binds.
 */
const DELEGATED_SOURCE_UNSUPPORTED =
  "Delegated do does not accept --source, --pr or --change. Bound sources are acquired by the catalog workflow runner, which the delegated pilot does not use. Omit --delegate to bind them on catalog do, or use docsfab run.";
const DELEGATED_RESUME_REQUIRES_ANSWERS =
  "docsfab do --resume requires --answers <json-file> for that exact delegated task.";
const DELEGATED_ANSWERS_REQUIRES_RESUME = "docsfab do --answers requires --resume <task-id>.";
const DELEGATED_RESUME_NO_REQUEST =
  "docsfab do --resume does not accept a quoted outcome; record answers only with --answers <json-file>.";
const DELEGATED_RESUME_TASK_ID = "docsfab do --resume requires a delegated task id.";
const DELEGATED_CHECK_REQUIRES_DELEGATE =
  "docsfab do --check names a delegated check, so it needs --delegate or --resume <task-id>. Add --delegate, or omit --check on catalog do.";
const DELEGATED_CHECK_VALUE_MISSING =
  "docsfab do --check requires an npm script name from the repository package.json, for example --check test.";
const DELEGATED_CHECK_ID_PREFIX = "npm-run-";

export type DelegatedCheckRefusalReason =
  | "check-requires-delegate"
  | "check-value-missing"
  | "check-duplicated"
  | "invalid-check-id"
  | "manifest-missing"
  | "manifest-unreadable"
  | "manifest-invalid"
  | "undeclared-script"
  | "resume-check-not-resupplied";

/**
 * A `--check` refusal is operator input: it carries the catalogued CLI usage
 * code, and `reason` names which check rule refused.
 */
export class DelegatedCheckOperatorError extends Error {
  readonly code = "cli-usage";
  readonly missingChecks: readonly string[];

  constructor(
    readonly reason: DelegatedCheckRefusalReason,
    message: string,
    missingChecks: readonly string[] = [],
  ) {
    super(message);
    this.name = "DelegatedCheckOperatorError";
    this.missingChecks = missingChecks;
  }
}

/** The result-contract check id for `npm run <script>`. */
export function delegatedCheckId(script: string): string {
  return `${DELEGATED_CHECK_ID_PREFIX}${script}`;
}

/** The script a check id names, or `undefined` for an id this CLI never mints. */
export function delegatedCheckScript(checkId: string): string | undefined {
  return checkId.startsWith(DELEGATED_CHECK_ID_PREFIX)
    ? checkId.slice(DELEGATED_CHECK_ID_PREFIX.length)
    : undefined;
}

export type DoRunArguments = RunArguments & {
  readonly draftMr?: boolean;
  readonly commentMr?: string;
  readonly quiet?: boolean;
  readonly operatorInputResume?: OperatorInputResumePlanV1;
};

export interface DoArguments {
  readonly request: string;
  readonly repositoryPath: string;
  readonly revision: string;
  /** Whether the operator supplied `--revision`; distinguishes an explicit HEAD from the default. */
  readonly revisionExplicit: boolean;
  readonly json: boolean;
  /**
   * When true, report the route only; never invoke the workflow runner or the
   * admission model. `--patch-only` and `--draft-mr` stay routing input.
   */
  readonly routeOnly: boolean;
  /** Explicit `--allow-write`; write workflows already default to write after routing. */
  readonly allowWrite: boolean;
  /** Explicit `--draft-mr`; write workflows already default to a draft MR after routing. */
  readonly draftMr: boolean;
  /** Write without opening a merge request. */
  readonly patchOnly: boolean;
  /** Classify and stop before write or publication. */
  readonly dryRun: boolean;
  /** Existing-MR review-summary target, distinct from `--draft-mr`. Classification never mints it. */
  readonly commentMr?: string;
  /**
   * The quoted `do` sentence is the work; `--instruction` is an optional script
   * override, not a second operator prompt.
   */
  readonly instruction: string;
  /** No progress wall; `--json` still wins. */
  readonly quiet: boolean;
  /** Selects the sealed-composition path; omitted runs the model-profile path. */
  readonly compositionId?: string;
  /** Opt-in StudyEventV1 sibling log. */
  readonly study: boolean;
  /** Git remote for a draft merge request; omitted: `origin` after routing when the run publishes. */
  readonly remoteName?: string;
  /** Resume this exact open editorial needs-input run. */
  readonly continueFrom?: string;
  /** Operator file or tracked repository paths bound as InputAsk fills. */
  readonly attachPaths: readonly string[];
  /**
   * `--source` paths acquired into this run's source binding. Unlike
   * `attachPaths`, they do not answer an InputAsk slot on a stopped run.
   */
  readonly sourcePaths?: readonly string[];
  readonly changeRequestSelector?: ChangeRequestSelectorV1;
  /** `--change`, parsed only; the shared run path resolves it before any workflow model call. */
  readonly changeSource?: ChangeSourceSelectorV1;
  /** Named opt-in to the bounded delegated-task pilot. Bare do stays catalog routing. */
  readonly delegate: boolean;
  /** Delegated: never prompt; persist needs-input instead of a You: prompt. */
  readonly noInput: boolean;
  /** Resume this exact delegated task. Distinct from catalog --continue. */
  readonly resumeTaskId?: string;
  /** Answer file bound to --resume. */
  readonly answersPath?: string;
  /** Delegated: npm script names from `--check`, in order. Absent when none were named. */
  readonly checkScripts?: readonly string[];
}

export function parseDoArguments(args: string[]): DoArguments {
  const jsonCount = args.filter((argument) => argument === "--json").length;
  const routeOnlyCount = args.filter((argument) => argument === "--route-only").length;
  const allowWriteCount = args.filter((argument) => argument === "--allow-write").length;
  const draftMrCount = args.filter((argument) => argument === "--draft-mr").length;
  const patchOnlyCount = args.filter((argument) => argument === "--patch-only").length;
  const dryRunCount = args.filter((argument) => argument === "--dry-run").length;
  const quietCount = args.filter((argument) => argument === "--quiet").length;
  const studyCount = args.filter((argument) => argument === "--study").length;
  const delegateCount = args.filter((argument) => argument === "--delegate").length;
  const noInputCount = args.filter((argument) => argument === "--no-input").length;
  if (jsonCount > 1) throw new Error("The --json option must not be duplicated on docsfab do.");
  if (delegateCount > 1) {
    throw new Error("The --delegate option must not be duplicated on docsfab do.");
  }
  if (noInputCount > 1) {
    throw new Error("The --no-input option must not be duplicated on docsfab do.");
  }
  if (routeOnlyCount > 1) {
    throw new Error("The --route-only option must not be duplicated on docsfab do.");
  }
  if (allowWriteCount > 1) {
    throw new Error("The --allow-write option must not be duplicated on docsfab do.");
  }
  if (draftMrCount > 1) {
    throw new Error("The --draft-mr option must not be duplicated on docsfab do.");
  }
  if (patchOnlyCount > 1) {
    throw new Error("The --patch-only option must not be duplicated on docsfab do.");
  }
  if (dryRunCount > 1) {
    throw new Error("The --dry-run option must not be duplicated on docsfab do.");
  }
  if (quietCount > 1) {
    throw new Error("The --quiet option must not be duplicated on docsfab do.");
  }
  if (studyCount > 1) {
    throw new Error("The --study option must not be duplicated on docsfab do.");
  }
  const json = jsonCount === 1;
  const routeOnly = routeOnlyCount === 1;
  const delegate = delegateCount === 1;
  const delegatedRequested = delegate || args.includes("--resume") || args.includes("--answers");
  const noInput = delegatedRequested && noInputCount === 1;
  const checkScripts = parseDelegatedCheckScripts(args, delegatedRequested);
  const allowWrite = allowWriteCount === 1;
  const draftMr = draftMrCount === 1;
  const patchOnly = patchOnlyCount === 1;
  const dryRun = dryRunCount === 1;
  // --json wins: --quiet is the short human shape and does not apply to the JSON object.
  const quiet = quietCount === 1;
  const study = studyCount === 1;
  const compositionValues = options(args, "--composition");
  if (compositionValues.length > 1) {
    throw new Error("The --composition option must not be duplicated on docsfab do.");
  }
  const compositionId = compositionValues[0];
  if (compositionId !== undefined && !/^[a-z0-9]+(?:[._/-][a-z0-9]+)*$/u.test(compositionId)) {
    throw new Error("docsfab do --composition requires a DocsFab composition identifier.");
  }
  // Classify is not a grant (admission decision, #164): `--allow-write` stays
  // refused. `--patch-only` and `--draft-mr` are routing input, because they
  // narrow the admission offer; the preview still runs and grants nothing.
  if (routeOnly && allowWrite) {
    throw deliveryFlagConflict(
      "docsfab do --route-only cannot be combined with --allow-write; classification is not a grant.",
      "route-only/allow-write",
    );
  }
  if (dryRun && patchOnly) {
    throw deliveryFlagConflict(
      "docsfab do --dry-run cannot be combined with --patch-only.",
      "dry-run/patch-only",
    );
  }
  if (dryRun && draftMr) {
    throw deliveryFlagConflict(
      "docsfab do --dry-run cannot be combined with --draft-mr.",
      "dry-run/draft-mr",
    );
  }
  if (patchOnly && draftMr) {
    throw deliveryFlagConflict(
      "docsfab do --patch-only cannot be combined with --draft-mr.",
      "patch-only/draft-mr",
    );
  }
  if (dryRun && allowWrite) {
    throw deliveryFlagConflict(
      "docsfab do --dry-run cannot be combined with --allow-write.",
      "dry-run/allow-write",
    );
  }
  if (routeOnly && dryRun) {
    throw deliveryFlagConflict(
      "docsfab do --route-only cannot be combined with --dry-run; classification is not a grant.",
      "route-only/dry-run",
    );
  }
  const commentMrValues = options(args, "--comment-mr");
  if (commentMrValues.length > 1) {
    throw new Error("The --comment-mr option must not be duplicated on docsfab do.");
  }
  const commentMr = commentMrValues[0];
  if (commentMr !== undefined) {
    parseCommentMrTarget(commentMr);
  }
  if (routeOnly && commentMr !== undefined) {
    throw deliveryFlagConflict(
      "docsfab do --route-only cannot be combined with --comment-mr; classification is not a grant.",
      "route-only/comment-mr",
    );
  }
  if (draftMr && commentMr !== undefined) {
    throw deliveryFlagConflict(
      "docsfab do --comment-mr cannot be combined with --draft-mr; comment mode is not draft-MR creation.",
      "comment-mr/draft-mr",
    );
  }
  if (dryRun && commentMr !== undefined) {
    throw deliveryFlagConflict(
      "docsfab do --dry-run cannot be combined with --comment-mr.",
      "dry-run/comment-mr",
    );
  }
  const remoteValues = options(args, "--remote");
  if (remoteValues.length > 1) {
    throw new Error("The --remote option must not be duplicated on docsfab do.");
  }
  const remoteName = remoteValues[0] ? parsePublicationRemoteName(remoteValues[0]) : undefined;
  if (routeOnly && remoteName !== undefined) {
    throw deliveryFlagConflict(
      "docsfab do --route-only cannot be combined with --remote; classification is not a grant.",
      "route-only/remote",
    );
  }
  const withoutFlags = args.filter(
    (argument) =>
      argument !== "--json" &&
      argument !== "--route-only" &&
      argument !== "--allow-write" &&
      argument !== "--draft-mr" &&
      argument !== "--patch-only" &&
      argument !== "--dry-run" &&
      argument !== "--quiet" &&
      argument !== "--study" &&
      argument !== "--delegate" &&
      !(delegatedRequested && argument === "--no-input"),
  );

  const repository = option(withoutFlags, "--repo") ?? DEFAULT_REPOSITORY_PATH;
  assertLocalRepositoryPath(repository);
  const requestedRevision = option(withoutFlags, "--revision");
  const revision = requestedRevision ?? "HEAD";
  const instructionValues = withoutFlags
    .map((argument, index) => (argument === "--instruction" ? index : -1))
    .filter((index) => index >= 0);
  if (instructionValues.length > 1) {
    throw new Error("The --instruction option must not be duplicated on docsfab do.");
  }
  const instructionOverride = option(withoutFlags, "--instruction");
  if (
    options(withoutFlags, "--changed-path").length > 0 ||
    withoutFlags.includes("--changed-path")
  ) {
    throw new Error(
      "The --changed-path option is not supported. Use review-documentation for read-only review.",
    );
  }

  const continueValues = options(withoutFlags, "--continue");
  if (continueValues.length > 1) {
    throw new Error("The --continue option must not be duplicated on docsfab do.");
  }
  const continueFrom = continueValues[0];
  if (continueFrom !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(continueFrom)) {
    throw new Error("docsfab do --continue requires a saved run id.");
  }
  const attachPaths = options(withoutFlags, "--attach");
  // The workflow is not routed yet, so `do.ts` applies the source-aware
  // workflow refusal after routing.
  const { sourcePaths, changeRequestSelector } = admitCliSourceSelection(withoutFlags);
  // `--continue` and `--attach` each continue a stopped run, which binds only
  // that run's own evidence; an implicit reply is refused in `do.ts`, where
  // the open run is known.
  if (
    (sourcePaths.length > 0 || changeRequestSelector !== undefined) &&
    (continueFrom !== undefined || attachPaths.length > 0)
  ) {
    throw continuationBindingFlagConflict(
      continueFrom !== undefined ? "--continue names it" : "--attach fills it",
    );
  }
  // Raw argv, so a boolean flag never stands in for the range: `--change
  // --json X` refuses as a missing value instead of binding X. `--attach`
  // alone also continues a stopped run, which would drop the change.
  const changeSource = admitCliChangeSourceSelection(args, {
    resumeOption: {
      name: continueFrom !== undefined ? "--continue" : "--attach",
      present: continueFrom !== undefined || attachPaths.length > 0,
    },
  });
  if (continueFrom !== undefined && instructionOverride !== undefined) {
    throw new Error(
      "docsfab do --continue does not accept --instruction; the original instruction remains bound.",
    );
  }
  if (routeOnly && (continueFrom !== undefined || attachPaths.length > 0)) {
    throw new Error(
      "docsfab do --route-only cannot be combined with --continue or --attach; classification is not a grant.",
    );
  }

  const consumed = new Set<number>();
  for (let index = 0; index < withoutFlags.length; index += 1) {
    const argument = withoutFlags[index]!;
    if (
      argument === "--repo" ||
      argument === "--revision" ||
      argument === "--instruction" ||
      argument === "--comment-mr" ||
      argument === "--remote" ||
      argument === "--composition" ||
      argument === "--continue" ||
      argument === "--attach" ||
      argument === "--source" ||
      argument === "--change" ||
      (CHANGE_REQUEST_SELECTOR_OPTIONS as readonly string[]).includes(argument) ||
      (delegatedRequested && argument === "--resume") ||
      (delegatedRequested && argument === "--answers") ||
      (delegatedRequested && argument === "--check")
    ) {
      consumed.add(index);
      consumed.add(index + 1);
      continue;
    }
    if (
      argument.startsWith("--source=") ||
      argument.startsWith("--change=") ||
      CHANGE_REQUEST_SELECTOR_OPTIONS.some((option) => argument.startsWith(`${option}=`))
    ) {
      // One token, validated by the shared admission; consumed here only so the
      // unknown-option guard does not reject it.
      consumed.add(index);
      continue;
    }
    if (argument.startsWith("--")) {
      throw new Error(`Unknown do option "${argument}" is not supported.`);
    }
  }

  const positionals = withoutFlags.filter((_, index) => !consumed.has(index));
  const resumeValues = delegatedRequested ? options(withoutFlags, "--resume") : [];
  const answersValues = delegatedRequested ? options(withoutFlags, "--answers") : [];
  if (resumeValues.length > 1) {
    throw new Error("The --resume option must not be duplicated on docsfab do.");
  }
  if (answersValues.length > 1) {
    throw new Error("The --answers option must not be duplicated on docsfab do.");
  }
  const resumeTaskId = resumeValues[0];
  const answersPath = answersValues[0];
  if (delegatedRequested) {
    assertDelegatedDoArguments({
      delegate,
      routeOnly,
      dryRun,
      revisionExplicit: requestedRevision !== undefined,
      patchOnly,
      draftMr,
      commentMr,
      remoteName,
      instructionOverride,
      continueFrom,
      attachPaths,
      sourcePaths,
      changeRequestSelector,
      changeSource,
      study,
      noInputRequested: noInputCount === 1,
      resumeTaskId,
      answersPath,
      requestPresent: positionals.length > 0,
    });
  }
  const allowOmittedRequest =
    continueFrom !== undefined || attachPaths.length > 0 || resumeTaskId !== undefined;
  if (positionals.length === 0 && !allowOmittedRequest) {
    throw new Error('do requires a quoted outcome request, for example: docsfab do "…".');
  }
  if (positionals.length > 1) {
    throw new Error("do accepts exactly one outcome request string before options.");
  }
  const request = positionals[0] ?? "";
  if (!allowOmittedRequest && !request.trim()) {
    throw new Error("do requires a non-empty outcome request string from the operator.");
  }
  if (instructionOverride !== undefined && !instructionOverride.trim()) {
    throw new Error("do --instruction requires a non-empty instruction string from the operator.");
  }
  return {
    request,
    repositoryPath: resolve(repository),
    revision,
    revisionExplicit: requestedRevision !== undefined,
    json,
    routeOnly,
    allowWrite,
    draftMr,
    patchOnly,
    dryRun,
    quiet,
    study,
    attachPaths,
    ...(sourcePaths.length > 0 ? { sourcePaths } : {}),
    ...(changeRequestSelector ? { changeRequestSelector } : {}),
    ...(changeSource ? { changeSource } : {}),
    delegate: delegate || resumeTaskId !== undefined,
    noInput,
    ...(commentMr !== undefined ? { commentMr } : {}),
    ...(remoteName !== undefined ? { remoteName } : {}),
    ...(continueFrom !== undefined ? { continueFrom } : {}),
    ...(resumeTaskId !== undefined ? { resumeTaskId } : {}),
    ...(answersPath !== undefined ? { answersPath } : {}),
    ...(checkScripts.length > 0 ? { checkScripts } : {}),
    instruction: instructionOverride ?? request,
    ...(compositionId ? { compositionId } : {}),
  };
}

/**
 * The commands a delegated task may run are operator authority, so they come
 * only from `--check <npm-script>` flags, never from the request text.
 */
function parseDelegatedCheckScripts(
  args: readonly string[],
  delegatedRequested: boolean,
): string[] {
  const scripts: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== "--check") continue;
    if (!delegatedRequested) {
      throw new DelegatedCheckOperatorError(
        "check-requires-delegate",
        DELEGATED_CHECK_REQUIRES_DELEGATE,
      );
    }
    // Read the raw argv: boolean flags are stripped before other values are
    // read, so `--check --json test` would otherwise bind `test`.
    const script = args[index + 1];
    if (script === undefined || script.startsWith("--")) {
      throw new DelegatedCheckOperatorError("check-value-missing", DELEGATED_CHECK_VALUE_MISSING);
    }
    if (scripts.includes(script)) {
      throw new DelegatedCheckOperatorError(
        "check-duplicated",
        `docsfab do --check ${script} was given more than once; name each npm script exactly once.`,
      );
    }
    assertDelegatedCheckIdentifier(script);
    scripts.push(script);
  }
  return scripts;
}

/**
 * The script name and its `npm-run-<name>` id must both fit the result
 * contract's identifier grammar, so a name the projection would reject is
 * refused before anything spawns.
 */
function assertDelegatedCheckIdentifier(script: string): void {
  try {
    delegatedTaskContractKit.identifier(script);
    delegatedTaskContractKit.identifier(delegatedCheckId(script));
  } catch (error) {
    // Only the grammar refusal is operator input; any other failure is a defect.
    if (!(error instanceof DelegatedTaskResultError) || error.code !== "invalid-value") throw error;
    throw new DelegatedCheckOperatorError(
      "invalid-check-id",
      `docsfab do --check ${JSON.stringify(script)} cannot become a check id. Use a script name that starts with a letter or digit and uses only letters, digits, and . _ : / -.`,
    );
  }
}

function assertDelegatedDoArguments(input: {
  delegate: boolean;
  routeOnly: boolean;
  dryRun: boolean;
  revisionExplicit: boolean;
  patchOnly: boolean;
  draftMr: boolean;
  commentMr?: string;
  remoteName?: string;
  instructionOverride?: string;
  continueFrom?: string;
  attachPaths: readonly string[];
  sourcePaths: readonly string[];
  changeRequestSelector?: ChangeRequestSelectorV1;
  changeSource?: ChangeSourceSelectorV1;
  study: boolean;
  noInputRequested: boolean;
  resumeTaskId?: string;
  answersPath?: string;
  requestPresent: boolean;
}): void {
  if (input.routeOnly) throw new Error(DELEGATED_ROUTE_ONLY_CONFLICT);
  if (input.dryRun) throw new Error(DELEGATED_DRY_RUN_CONFLICT);
  if (input.revisionExplicit) throw new Error(DELEGATED_REVISION_UNSUPPORTED);
  if (input.patchOnly) throw new Error(DELEGATED_PATCH_ONLY_UNSUPPORTED);
  if (input.draftMr) throw new Error(DELEGATED_DRAFT_MR_UNSUPPORTED);
  if (input.commentMr !== undefined) throw new Error(DELEGATED_COMMENT_MR_UNSUPPORTED);
  if (input.remoteName !== undefined) throw new Error(DELEGATED_REMOTE_UNSUPPORTED);
  if (input.instructionOverride !== undefined) throw new Error(DELEGATED_INSTRUCTION_UNSUPPORTED);
  if (input.continueFrom !== undefined) throw new Error(DELEGATED_CONTINUE_UNSUPPORTED);
  if (input.attachPaths.length > 0) throw new Error(DELEGATED_ATTACH_UNSUPPORTED);
  if (
    input.sourcePaths.length > 0 ||
    input.changeRequestSelector !== undefined ||
    input.changeSource !== undefined
  ) {
    throw new Error(DELEGATED_SOURCE_UNSUPPORTED);
  }
  if (input.study) throw new Error(DELEGATED_STUDY_UNSUPPORTED);
  if (input.resumeTaskId !== undefined && input.answersPath === undefined) {
    throw new Error(DELEGATED_RESUME_REQUIRES_ANSWERS);
  }
  if (input.answersPath !== undefined && input.resumeTaskId === undefined) {
    throw new Error(DELEGATED_ANSWERS_REQUIRES_RESUME);
  }
  if (
    input.resumeTaskId !== undefined &&
    !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/u.test(input.resumeTaskId)
  ) {
    throw new Error(DELEGATED_RESUME_TASK_ID);
  }
  if (input.resumeTaskId !== undefined && input.requestPresent) {
    throw new Error(DELEGATED_RESUME_NO_REQUEST);
  }
  if (!input.delegate && input.resumeTaskId === undefined) {
    throw new Error(DELEGATED_ANSWERS_REQUIRES_RESUME);
  }
  void input.noInputRequested;
}
