// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { resolve } from "node:path";

import { READER_CONTEXT_SOURCE_ROLES } from "../context/reader-context.js";
import {
  failChangeRequestSelector,
  parseChangeRequestSelector,
  type ChangeRequestSelectorV1,
} from "../inputs/change-request-selector.js";
import {
  failChangeSource,
  mergeRequestChangeSourceSelector,
  parseChangeSourceSelector,
  type ChangeSourceSelectorV1,
} from "../inputs/change-source.js";
import {
  githubChangeSourceSelectorArm,
  isGithubHttpsUrl,
  type GithubPullRequestSelectorV1,
} from "../inputs/change-source/github-url.js";
import { getWorkflow, parkedWorkflowError } from "../workflow-registry/catalog.js";
import { ReviewDeliveryCliOperatorError } from "./review-delivery-error.js";
import { isWorkflowManifestV2 } from "../workflow-contracts/contracts.js";
import { parseCommentMrTarget } from "./comment-existing-mr-target.js";
import {
  assertPublicationNotProhibited,
  DEFAULT_REPOSITORY_PATH,
  resolveInteractiveDeliveryGrants,
  resolvePublicationRemoteName,
} from "./delivery-grants.js";
import {
  ProfileCliUsageError,
  contextAnchor,
  contextPath,
  option,
  options,
  parseWorkflow,
} from "./options.js";
import { hasExplicitPublicationProhibition } from "./publication-prohibition.js";
import type { RunArguments } from "./types.js";
import { revisionPolicyForDraftMr, type PublicationRevisionPolicy } from "./run/request.js";
import type { ReaderComparisonRequestV1 } from "../search/change-impact.js";
import {
  assertMergedMrSelectorCompatibility,
  parseMergedMrUpdateInstruction,
} from "../inputs/merged-mr-instruction.js";
import { SOURCE_AWARE_WORKFLOWS } from "../inputs/source-aware-workflows.js";

export type RunCliArguments = RunArguments & {
  readonly draftMr: boolean;
  readonly revisionPolicy?: PublicationRevisionPolicy;
  readonly commentMr?: string;
  /** `--canon-sha256`, accepted only beside `--comment-mr`. */
  readonly commentMrCanonSha256?: string;
  /** Short human output with no progress wall; `--json` still wins. */
  readonly quiet: boolean;
  /** The host resolves workspace intent to its actual inventory SHA. */
  readonly comparisonRequest?: RunComparisonRequest;
};

export type RunComparisonRequest = ReaderComparisonRequestV1;

const CANON_SHA256_FLAG = /^[a-f0-9]{64}$/u;

/** Re-exported for the CLI's callers; the list lives in a leaf readers share. */
export { SOURCE_AWARE_WORKFLOWS };

/**
 * Two spellings of one merged-change selector. Both parse through the same
 * admission and grammar into the same record, so nothing downstream can tell
 * which was typed.
 */
export const CHANGE_REQUEST_SELECTOR_OPTIONS = ["--pr", "--mr"] as const;

export const CHANGE_REQUEST_SELECTOR_OPTION_NAMES = CHANGE_REQUEST_SELECTOR_OPTIONS.join(" or ");

/**
 * The refusal an unsupported workflow gets, rendered from the supported set so
 * the message cannot name a narrower set than the parser admits.
 */
export function unsupportedSourceWorkflowRefusal(
  supported: readonly string[] = SOURCE_AWARE_WORKFLOWS,
  optionName: "--source" | "--pr" = "--source",
): string {
  const names =
    supported.length === 1
      ? supported[0]!
      : `${supported.slice(0, -1).join(", ")} and ${supported[supported.length - 1]!}`;
  // `--pr` shares this set because it also mints the run's source binding.
  return optionName === "--pr"
    ? `${CHANGE_REQUEST_SELECTOR_OPTION_NAMES} is supported only for the ${names} ${supported.length === 1 ? "workflow" : "workflows"}. ` +
        `Re-run the merge request under one of those workflows, or drop ${CHANGE_REQUEST_SELECTOR_OPTION_NAMES} and run this workflow without bound sources.`
    : `--source is supported only for the ${names} ${supported.length === 1 ? "workflow" : "workflows"}. ` +
        "Re-run the selected files under one of those workflows, or drop --source and run this workflow without bound sources.";
}

/**
 * One operator source selection. `run`, `do`, and `live-agent` share one
 * execution assembly, so they admit `--source` and `--pr` identically or the
 * same words would bind different evidence.
 */
export interface CliSourceSelectionV1 {
  /** Repository-relative paths from `--source`, in operator order. */
  readonly sourcePaths: readonly string[];
  /** Parsed only; nothing is resolved or opened. */
  readonly changeRequestSelector?: ChangeRequestSelectorV1;
}

/**
 * Collect the merged-change selector's values in either spelling and either
 * attachment form. No other option on this CLI begins with `--mr`, so any
 * continuation other than `=` is a typo; `--pr` siblings all continue with a
 * letter, so only a non-letter continuation is a near miss there.
 */
function changeRequestSelectorValues(args: string[]): string[] {
  return admittedOptionValues(args, {
    names: CHANGE_REQUEST_SELECTOR_OPTIONS,
    strict: (name) => name === "--mr",
    missingValue: () => failCliSelectorOption("selector-option-value-missing"),
    unrecognizedForm: () => failChangeRequestSelector("selector-option-typo"),
  });
}

/** `--source` form stops, separate from the selector's so they never mention merge requests. */
export const SOURCE_OPTION_REFUSAL_CODES = [
  "source-option-value-missing",
  "source-option-form-unrecognized",
] as const;

export type SourceOptionRefusalCode = (typeof SOURCE_OPTION_REFUSAL_CODES)[number];

export const SOURCE_OPTION_REFUSALS: Readonly<Record<SourceOptionRefusalCode, string>> =
  Object.freeze({
    "source-option-value-missing":
      "The --source option was passed without a repository-relative path to bind. Write --source <path> or --source=<path> naming a tracked file, then run again.",
    "source-option-form-unrecognized":
      "An option starting with --source was passed in a form this command does not accept, so it would otherwise have been ignored and the run left without the evidence you named. Write --source <path> or --source=<path>, then run again.",
  });

export class CliSourceOptionError extends Error {
  public constructor(public readonly code: SourceOptionRefusalCode) {
    super(SOURCE_OPTION_REFUSALS[code]);
    this.name = "CliSourceOptionError";
  }
}

export function failCliSourceOption(code: SourceOptionRefusalCode): never {
  throw new CliSourceOptionError(code);
}

/**
 * Missing-value stop for `--pr` / `--mr`. Distinct from `empty-selector`,
 * which describes an empty parsed value and does not name the option.
 */
export const SELECTOR_OPTION_REFUSAL_CODES = ["selector-option-value-missing"] as const;

export type SelectorOptionRefusalCode = (typeof SELECTOR_OPTION_REFUSAL_CODES)[number];

export const SELECTOR_OPTION_REFUSALS: Readonly<Record<SelectorOptionRefusalCode, string>> =
  Object.freeze({
    "selector-option-value-missing":
      `The ${CHANGE_REQUEST_SELECTOR_OPTION_NAMES} option was passed without a merge-request reference to bind. ` +
      "Write --pr <reference>, --mr <reference>, --pr=<reference> or --mr=<reference>, then run again.",
  });

export class CliSelectorOptionError extends Error {
  public constructor(public readonly code: SelectorOptionRefusalCode) {
    super(SELECTOR_OPTION_REFUSALS[code]);
    this.name = "CliSelectorOptionError";
  }
}

export function failCliSelectorOption(code: SelectorOptionRefusalCode): never {
  throw new CliSelectorOptionError(code);
}

/**
 * Boolean `docsfab run` options. The unknown-option pass consumes exactly these
 * names, so a new flag must be added here or it is refused as unrecognized.
 */
export const RUN_FLAG_OPTIONS = [
  "--verbose",
  "--json",
  "--show-scan",
  "--quiet",
  "--study",
  "--dry-run",
  "--patch-only",
  "--release-gate",
  "--allow-write",
  "--draft-mr",
  "--comparison-workspace",
  "--accept-candidate-snapshot",
  "--experimental-answer-records",
] as const;

/**
 * Valued `docsfab run` options. Only `--source`, `--pr`, `--mr`, and `--change`
 * also accept the attached `=` form, so `--repo=/tmp/x` is an unknown token.
 */
export const RUN_VALUE_OPTIONS = [
  "--composition",
  "--repo",
  "--instruction",
  "--resume-from",
  "--comment-mr",
  "--canon-sha256",
  "--remote",
  "--revision",
  "--comparison-base",
  "--reader-source",
  "--source",
  "--pr",
  "--mr",
  "--change",
  "--context-path",
  "--review-target",
  "--review-delivery",
  "--review-delivery-target",
  "--rescope-from",
  "--context-anchor",
  "--context-parent-path",
  "--context-parent-anchor",
  "--doc-improvement-campaign",
  "--reviewer-policy",
  "--canon-snapshot",
  "--authority-id",
] as const;

/** Retired names still consumed so they keep their dedicated refusal. */
const RUN_RETIRED_VALUE_OPTIONS = ["--changed-path"] as const;

export const RUN_ACCEPTED_OPTIONS: readonly string[] = [...RUN_FLAG_OPTIONS, ...RUN_VALUE_OPTIONS];

function listedCliNames(names: readonly string[]): string {
  if (names.length === 1) return names[0]!;
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]!}`;
}

export const RUN_OPTION_REFUSAL_CODES = [
  "unknown-option",
  "review-target-workflow",
  "review-target-conflict",
  "rescope-from-repeated",
  "rescope-from-conflict",
  "rescope-from-incomplete",
  "rescope-from-preview",
  "rescope-from-revision",
] as const;

export type RunOptionRefusalCode = (typeof RUN_OPTION_REFUSAL_CODES)[number];

export const RUN_OPTION_REFUSALS: Readonly<Record<RunOptionRefusalCode, string>> = Object.freeze({
  "unknown-option":
    "An option starting with -- was passed in a form this command does not accept, so it would otherwise have been ignored and the run left without the setting you named. " +
    `docsfab run accepts ${listedCliNames(RUN_ACCEPTED_OPTIONS)}. ` +
    "Write one of those options, then run again.",
  "review-target-workflow":
    "The --review-target option selects pages only for a review-documentation run. Use review-documentation or remove --review-target, then run again.",
  "review-target-conflict":
    "The --review-target and --context-path options select competing review page sets. Use only one form of page selection, then run again.",
  "rescope-from-repeated":
    "The --rescope-from option named more than one saved review run. Name exactly one stopped run, then run again.",
  "rescope-from-conflict":
    "The --rescope-from option cannot be combined with --resume-from. Use one recovery action, then run again.",
  "rescope-from-incomplete":
    "The --rescope-from option needs review-documentation and at least one explicit --review-target page. Name the saved review and selected pages, then run again.",
  "rescope-from-preview":
    "The --rescope-from option cannot preview a batch before validating the saved run. Use a run without --dry-run to validate its scope.",
  "rescope-from-revision":
    "The --rescope-from option requires --revision with the saved review's full commit id. Use that exact commit id, then run again.",
});

/** The command that clears each stop; the operator envelope prints it as the next action. */
export const RUN_OPTION_NEXT_ACTIONS: Readonly<Record<RunOptionRefusalCode, string>> =
  Object.freeze({
    "unknown-option":
      "Run `docsfab run --help` to list the options docsfab run accepts, then correct or remove the unrecognized option and run the command again.",
    "review-target-workflow": "Use review-documentation or remove --review-target, then run again.",
    "review-target-conflict": "Use only one page-selection option, then run again.",
    "rescope-from-repeated": "Name exactly one stopped run with --rescope-from, then run again.",
    "rescope-from-conflict": "Remove either --rescope-from or --resume-from, then run again.",
    "rescope-from-incomplete":
      "Name the saved review and explicit --review-target pages, then run again.",
    "rescope-from-preview": "Remove --dry-run so the saved run can be validated, then run again.",
    "rescope-from-revision":
      "Use --revision with the saved review's exact commit id, then run again.",
  });

export class CliRunOptionError extends Error {
  public readonly nextAction: string;

  public constructor(public readonly code: RunOptionRefusalCode) {
    super(RUN_OPTION_REFUSALS[code]);
    this.name = "CliRunOptionError";
    this.nextAction = RUN_OPTION_NEXT_ACTIONS[code];
  }
}

export function failRunOption(code: RunOptionRefusalCode): never {
  throw new CliRunOptionError(code);
}

/**
 * True for the attached `=` form of `--source`, `--pr`, or `--mr`. The unknown
 * option pass must treat these as consumed, or a valid `--source=docs/a.md`
 * would be refused after admission bound it.
 */
export function isAttachedCliSourceOption(argument: string): boolean {
  return (
    argument.startsWith("--source=") ||
    CHANGE_REQUEST_SELECTOR_OPTIONS.some((option) => argument.startsWith(`${option}=`))
  );
}

/**
 * Refuse any leftover `--` token after every named `run` option is consumed. A
 * final pass, not a second parser; any `=VALUE` form other than the source and
 * selector options is refused.
 */
function assertNoUnknownRunOptions(args: string[]): void {
  const flags = new Set<string>(RUN_FLAG_OPTIONS);
  const values = new Set<string>([...RUN_VALUE_OPTIONS, ...RUN_RETIRED_VALUE_OPTIONS]);
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index] as string;
    if (!argument.startsWith("--")) continue;
    if (flags.has(argument)) continue;
    if (values.has(argument)) {
      index += 1;
      continue;
    }
    if (isAttachedCliSourceOption(argument)) continue;
    // Run-only: `--change` is not in the shared source admission, so
    // `live-agent` and `sources` keep refusing it instead of dropping it.
    if (argument.startsWith("--change=")) continue;
    failRunOption("unknown-option");
  }
}

/**
 * Collect one option's values in either attachment form, refusing a near miss
 * rather than ignoring it: an evidence selector that is silently dropped leaves
 * the run ungrounded with nothing for a later gate to catch.
 *
 * A token that extends the name is a typo when `strict` says the name has no
 * longer sibling on these entrypoints; otherwise only a non-letter continuation
 * is. A proper prefix of the name is a typo once it is long enough to be
 * unambiguous (`--sour`, not `--s`). Anything else, like `--prs`, is left to
 * the unknown-option pass on `docsfab run`.
 */
function admittedOptionValues(
  args: string[],
  spec: {
    readonly names: readonly string[];
    readonly strict: (name: string) => boolean;
    readonly missingValue: () => never;
    readonly unrecognizedForm: () => never;
  },
): string[] {
  const values: string[] = [];
  const prefixTypoFloor = 4;
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index] as string;
    if (!token.startsWith("--")) continue;
    const name = spec.names.find((option) => token.startsWith(option));
    if (name === undefined) {
      const typo = spec.names.some(
        (option) =>
          option.startsWith(token) &&
          token.length >= 2 + prefixTypoFloor &&
          token.length < option.length,
      );
      if (typo) spec.unrecognizedForm();
      continue;
    }
    const rest = token.slice(name.length);
    if (rest === "") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) spec.missingValue();
      values.push(value as string);
      index += 1;
      continue;
    }
    if (rest.startsWith("=")) {
      const value = rest.slice(1);
      if (value.length === 0) spec.missingValue();
      values.push(value);
      continue;
    }
    if (spec.strict(name) || !/^[A-Za-z]/u.test(rest)) spec.unrecognizedForm();
  }
  return values;
}

/**
 * Admit the `--source` / `--pr` selection for one invocation, shared by the
 * three source-aware entrypoints. It parses and validates; it opens nothing,
 * resolves no forge identity, and grants nothing, so `--route-only` and
 * `--dry-run` can run it in full.
 *
 * Omit `workflow` when the entrypoint has not chosen one yet (`do`,
 * `live-agent`); those callers apply {@link unsupportedSourceWorkflowRefusal}
 * once it is known. `resumeOption` carries the caller's own resume flag name.
 * `claimedChangeRequest` is set only by `run`, which took one GitHub `--pr`
 * value out of `args` itself; that value is still counted and gated here.
 */
export function admitCliSourceSelection(
  args: string[],
  input: {
    readonly workflow?: string;
    readonly resumeOption?: { readonly name: string; readonly present: boolean };
    readonly claimedChangeRequest?: boolean;
  } = {},
): CliSourceSelectionV1 {
  const resumeName = input.resumeOption?.name;
  const resuming = input.resumeOption?.present === true;
  const sourceValues = admittedOptionValues(args, {
    names: ["--source"],
    // `--source-branch` belongs to `docsfab ship`, which does not share this
    // admission, so nothing reachable here extends `--source`.
    strict: () => true,
    missingValue: () => failCliSourceOption("source-option-value-missing"),
    unrecognizedForm: () => failCliSourceOption("source-option-form-unrecognized"),
  });
  if (
    sourceValues.length > 0 &&
    input.workflow !== undefined &&
    !(SOURCE_AWARE_WORKFLOWS as readonly string[]).includes(input.workflow)
  ) {
    throw new Error(unsupportedSourceWorkflowRefusal());
  }
  if (sourceValues.length > 0 && resuming) {
    throw new Error(
      `--source cannot be combined with ${resumeName}; a durable knowledge stop is not source-aware yet. ` +
        `Run again without ${resumeName} to bind these sources on a fresh run, or resume the stopped run without --source.`,
    );
  }
  const sourcePaths = sourceValues.map((value) => contextPath(value, "--source"));
  if (new Set(sourcePaths).size !== sourcePaths.length) {
    throw new Error(
      "Every --source option must name a distinct repository-relative path for this run.",
    );
  }
  // `--pr` names one immutable merged change as the run's evidence basis. It
  // composes with `--source`: the host mints one binding carrying both.
  const prValues = changeRequestSelectorValues(args);
  const prCount = prValues.length + (input.claimedChangeRequest === true ? 1 : 0);
  if (prCount > 1) {
    // A count, not a value comparison, so `--pr X --mr X` refuses exactly like
    // `--pr X --pr X`.
    throw new Error(
      `Pass ${CHANGE_REQUEST_SELECTOR_OPTION_NAMES} at most once in total; they are two spellings of one option, and a run binds one merged change as its basis. ` +
        "Name the merge request you want this run grounded on once, and add --source for any further supporting files.",
    );
  }
  if (
    prCount > 0 &&
    input.workflow !== undefined &&
    !(SOURCE_AWARE_WORKFLOWS as readonly string[]).includes(input.workflow)
  ) {
    throw new Error(unsupportedSourceWorkflowRefusal(SOURCE_AWARE_WORKFLOWS, "--pr"));
  }
  if (prCount > 0 && resuming) {
    throw new Error(
      `${CHANGE_REQUEST_SELECTOR_OPTION_NAMES} cannot be combined with ${resumeName}; a durable knowledge stop is not source-aware yet. ` +
        `Run again without ${resumeName} to bind this merge request on a fresh run, or resume the stopped run without ${CHANGE_REQUEST_SELECTOR_OPTION_NAMES}.`,
    );
  }
  return {
    sourcePaths,
    ...(prValues.length > 0
      ? { changeRequestSelector: parseChangeRequestSelector(prValues[0]) }
      : {}),
  };
}

/**
 * Run-only: take one https github.com `--pr` / `--mr` value out of the args
 * before the shared admission, which reads GitLab merge requests only (so
 * `do`, `live-agent` and `sources` keep refusing other forges). Two or more
 * values, or any value not on https github.com, stay in place for the shared
 * admission to count and judge, so stripping never hides a second value; the
 * shared admission still counts and gates the one it took.
 */
function claimRunGithubChangeRequest(
  args: string[],
): { readonly args: string[]; readonly value: string } | undefined {
  const values = changeRequestSelectorValues(args);
  if (values.length !== 1 || !isGithubHttpsUrl(values[0]!)) return undefined;
  const index = args.findIndex((token) =>
    CHANGE_REQUEST_SELECTOR_OPTIONS.some((name) => token === name || token.startsWith(`${name}=`)),
  );
  // `--pr=<url>` is one token; `--pr <url>` is the option and its value.
  const width = args[index]!.includes("=") ? 1 : 2;
  return { args: [...args.slice(0, index), ...args.slice(index + width)], value: values[0]! };
}

/**
 * The claimed value as the run's change source: a pull request URL only. A
 * commit or compare URL names no pull request, so it refuses toward
 * `--change`; any other github.com form refuses with the URL grammar's code.
 */
function runGithubPullRequestChangeSource(value: string): GithubPullRequestSelectorV1 {
  const claimed = githubChangeSourceSelectorArm(failChangeSource)(value);
  if (claimed?.source !== "github-pull-request") {
    failChangeSource("change-source-github-pr-not-pull-request");
  }
  return Object.freeze(claimed);
}

/**
 * Admit `--change` for one invocation. Run-only (and `do` once it accepts
 * `--change`); it is deliberately not part of {@link admitCliSourceSelection},
 * whose other callers would consume and then drop it. It parses the selector
 * grammar only; nothing is resolved or read.
 */
export function admitCliChangeSourceSelection(
  args: string[],
  input: {
    readonly workflow?: string;
    readonly resumeOption?: { readonly name: string; readonly present: boolean };
  } = {},
): ChangeSourceSelectorV1 | undefined {
  const values = admittedOptionValues(args, {
    names: ["--change"],
    // `--changed-path` extends the name and keeps its own retired refusal.
    strict: () => false,
    missingValue: () => failChangeSource("change-source-option-value-missing"),
    unrecognizedForm: () => failChangeSource("change-source-option-form-unrecognized"),
  });
  if (values.length === 0) return undefined;
  if (values.length > 1) failChangeSource("change-source-selector-repeated");
  // A read-only review can cite an immutable --change record. --source and
  // --pr have separate admission and remain limited to their existing jobs.
  if (
    input.workflow !== undefined &&
    !(SOURCE_AWARE_WORKFLOWS as readonly string[]).includes(input.workflow) &&
    input.workflow !== "review-documentation"
  ) {
    failChangeSource("change-source-workflow-unsupported");
  }
  if (input.resumeOption?.present === true) failChangeSource("change-source-resume-unsupported");
  if (changeRequestSelectorValues(args).length > 0) {
    failChangeSource("change-source-selector-conflict");
  }
  return parseChangeSourceSelector(values[0]!);
}

/**
 * Refuse a source selection beside a date-scoped `update-documentation`
 * instruction. That instruction mints the run's one source binding from the
 * merge requests it discovers, so a second selection would force the host to
 * silently prefer one.
 *
 * `run`, `do`, and `live-agent` each call this once they hold both the
 * instruction and the selection. Omit `instruction` when the workflow is known
 * not to be `update-documentation`.
 */
export function assertSourceSelectionMatchesInstruction(input: {
  readonly instruction?: string;
  readonly sourcePaths: readonly string[];
  readonly changeRequestSelector?: ChangeRequestSelectorV1;
  readonly changeSource?: ChangeSourceSelectorV1;
}): void {
  if (
    input.sourcePaths.length === 0 &&
    input.changeRequestSelector === undefined &&
    input.changeSource === undefined
  ) {
    return;
  }
  if (!input.instruction) return;
  if (parseMergedMrUpdateInstruction(input.instruction).kind !== "date-window") return;
  if (input.changeSource !== undefined) failChangeSource("change-source-date-window-conflict");
  // `--source` is checked first so an argv carrying both gets a stable refusal.
  if (input.sourcePaths.length > 0) {
    throw new Error(
      "A date-scoped merged-MR update mints its source binding from the merge requests the instruction names. " +
        "Do not combine it with --source; drop --source, or restate the instruction without the merged-MR date window. " +
        "Merge-request evidence is due to arrive through its own source selector, which will not require this choice.",
    );
  }
  throw new Error(
    `A date-scoped merged-MR update already selects its merge requests from the instruction, so it cannot also take ${CHANGE_REQUEST_SELECTOR_OPTION_NAMES}. ` +
      `Drop ${CHANGE_REQUEST_SELECTOR_OPTION_NAMES} to keep the date window, or restate the instruction without the date window and name the merge request with ${CHANGE_REQUEST_SELECTOR_OPTION_NAMES}.`,
  );
}

/**
 * `--repo` is a local checkout path; `http(s):`, `git@`, and `ssh://` fail
 * closed. Do not clone from this flag.
 */
export function assertLocalRepositoryPath(value: string, flag = "--repo"): void {
  const candidate = value.trim();
  if (/^(?:https?:|ssh:\/\/)/iu.test(candidate) || candidate.startsWith("git@")) {
    throw new Error(
      `${flag} must be a local filesystem path, not a git URL. Checkout the repository and pass that path.`,
    );
  }
}

const SAFE_PUBLICATION_REMOTE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

export function parsePublicationRemoteName(value: string, flag = "--remote"): string {
  if (!SAFE_PUBLICATION_REMOTE.test(value)) {
    throw new Error(`${flag} option requires a valid Git remote name.`);
  }
  return value;
}

export function parseRunArguments(args: string[]): RunCliArguments {
  const verboseCount = args.filter((argument) => argument === "--verbose").length;
  const jsonCount = args.filter((argument) => argument === "--json").length;
  const showScanCount = args.filter((argument) => argument === "--show-scan").length;
  const quietCount = args.filter((argument) => argument === "--quiet").length;
  const studyCount = args.filter((argument) => argument === "--study").length;
  const experimentalAnswerRecordsCount = args.filter(
    (argument) => argument === "--experimental-answer-records",
  ).length;
  if (verboseCount > 1)
    throw new Error("The --verbose option must not be duplicated on docsfab run.");
  if (jsonCount > 1) throw new Error("The --json option must not be duplicated on docsfab run.");
  if (showScanCount > 1)
    throw new Error("The --show-scan option must not be duplicated on docsfab run.");
  if (quietCount > 1) throw new Error("The --quiet option must not be duplicated on docsfab run.");
  if (studyCount > 1) throw new Error("The --study option must not be duplicated on docsfab run.");
  if (experimentalAnswerRecordsCount > 1) {
    throw new ProfileCliUsageError(
      "The --experimental-answer-records option must not be duplicated on this command.",
    );
  }
  if (verboseCount === 1 && jsonCount === 1) {
    throw new Error("docsfab run --json cannot be combined with --verbose.");
  }
  if (quietCount === 1 && verboseCount === 1) {
    throw new Error("docsfab run --quiet cannot be combined with --verbose.");
  }
  const verbose = verboseCount === 1;
  const json = jsonCount === 1;
  const showScan = showScanCount === 1;
  // --json wins: --quiet is the short human shape and does not apply to the JSON object.
  const quiet = quietCount === 1;
  const study = studyCount === 1;
  const experimentalAnswerRecords = experimentalAnswerRecordsCount === 1;
  // Parked commands keep their own refusal below; --composition is not read for them.
  const parkedCommand = ["ia-analysis", "ia-plan", "site-bootstrap"].includes(args[0] ?? "");
  const compositionValues = parkedCommand ? [] : options(args, "--composition");
  if (compositionValues.length > 1) {
    throw new Error("The --composition option must not be duplicated on docsfab run.");
  }
  const compositionId = compositionValues[0];
  if (compositionId !== undefined && !/^[a-z0-9]+(?:[._/-][a-z0-9]+)*$/u.test(compositionId)) {
    throw new Error(
      "--composition must provide one valid installed DocsFab composition identifier.",
    );
  }
  const withoutOutputFlags = args.filter(
    (argument) =>
      argument !== "--verbose" &&
      argument !== "--json" &&
      argument !== "--show-scan" &&
      argument !== "--quiet" &&
      argument !== "--study" &&
      argument !== "--dry-run" &&
      argument !== "--patch-only",
  );
  const releaseGateCount = withoutOutputFlags.filter(
    (argument) => argument === "--release-gate",
  ).length;
  if (releaseGateCount > 1) throw new Error("--release-gate must not be duplicated.");
  const withoutReleaseGate = withoutOutputFlags.filter((argument) => argument !== "--release-gate");
  const releaseGate = releaseGateCount === 1;
  if (
    withoutReleaseGate[0] === "ia-analysis" ||
    withoutReleaseGate[0] === "ia-plan" ||
    withoutReleaseGate[0] === "site-bootstrap"
  ) {
    throw new Error(parkedWorkflowError(withoutReleaseGate[0]));
  }
  const workflow = parseWorkflow(withoutReleaseGate[0]);
  if (experimentalAnswerRecords && workflow !== "review-documentation") {
    throw new ProfileCliUsageError(
      "--experimental-answer-records is supported only for review-documentation workflows in this command.",
    );
  }
  if (experimentalAnswerRecords && compositionId === undefined) {
    throw new ProfileCliUsageError(
      "--experimental-answer-records requires an explicit --composition selection for this review run.",
    );
  }
  const repository = option(withoutOutputFlags, "--repo") ?? DEFAULT_REPOSITORY_PATH;
  assertLocalRepositoryPath(repository);
  const instructionValues = options(withoutOutputFlags, "--instruction");
  if (instructionValues.length > 1) {
    throw new Error("The --instruction option must not be duplicated on docsfab run.");
  }
  const instruction = instructionValues[0];
  const resumeFromValues = options(withoutOutputFlags, "--resume-from");
  if (resumeFromValues.length > 1) {
    throw new Error("The --resume-from option must not be duplicated on docsfab run.");
  }
  const resumeFrom = resumeFromValues[0];
  const answerRecordWorkflow = getWorkflow(workflow);
  const answerRecordResumeAllowed =
    workflow === "review-documentation" ||
    (workflow === "update-documentation" && isWorkflowManifestV2(answerRecordWorkflow));
  const knowledgeResumeWorkflow =
    workflow === "create-documentation" || workflow === "update-documentation";
  if (resumeFrom !== undefined) {
    if (!answerRecordResumeAllowed && !knowledgeResumeWorkflow) {
      // hygiene: envelope -- parser failures are rendered by reportCommandFailure.
      throw new Error(
        "--resume-from is supported only for review-documentation, V2 update-documentation, or an existing create/update knowledge continuation.",
      );
    }
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(resumeFrom)) {
      throw new Error("The --resume-from option requires one safe stopped run id.");
    }
  }
  const workflowRequiresAuthorizedWrite =
    workflow === "create-documentation" ||
    workflow === "update-documentation" ||
    workflow === "restructure-documentation";
  const docImprovementFlagsPresent =
    withoutOutputFlags.includes("--doc-improvement-campaign") ||
    withoutOutputFlags.includes("--reviewer-policy");
  if (
    workflowRequiresAuthorizedWrite &&
    !instruction &&
    !docImprovementFlagsPresent &&
    !resumeFrom
  ) {
    throw new Error(`The ${workflow} workflow requires a concrete --instruction <text> value.`);
  }
  const dryRunCount = args.filter((argument) => argument === "--dry-run").length;
  if (dryRunCount > 1) {
    throw new Error("The --dry-run option must not be duplicated on docsfab run.");
  }
  const patchOnlyCount = args.filter((argument) => argument === "--patch-only").length;
  if (patchOnlyCount > 1) {
    throw new Error("The --patch-only option must not be duplicated on docsfab run.");
  }
  const allowWriteFlag = withoutOutputFlags.includes("--allow-write");
  const draftMrCount = withoutOutputFlags.filter((argument) => argument === "--draft-mr").length;
  if (draftMrCount > 1) {
    throw new Error("The --draft-mr option must not be duplicated on docsfab run.");
  }
  const draftMrFlag = draftMrCount === 1;
  const commentMrValues = options(withoutOutputFlags, "--comment-mr");
  if (commentMrValues.length > 1) {
    throw new Error("The --comment-mr option must not be duplicated on docsfab run.");
  }
  const commentMr = commentMrValues[0];
  if (commentMr !== undefined) {
    parseCommentMrTarget(commentMr);
  }
  if (resumeFrom !== undefined && commentMr !== undefined) {
    throw new Error(
      "The --resume-from option does not support --comment-mr; retain the original patch-only or draft-MR delivery intent.",
    );
  }
  // The canon digest for the review summary's continue command. It only renders
  // the note, granting nothing and selecting no frozen input, so it requires
  // `--comment-mr`.
  const canonSha256Values = options(withoutOutputFlags, "--canon-sha256");
  if (canonSha256Values.length > 1) {
    throw new Error("The --canon-sha256 option must not be duplicated on docsfab run.");
  }
  const commentMrCanonSha256 = canonSha256Values[0];
  if (commentMrCanonSha256 !== undefined) {
    if (commentMr === undefined) {
      throw new Error(
        "--canon-sha256 requires --comment-mr; it only completes that note's continue command.",
      );
    }
    if (!CANON_SHA256_FLAG.test(commentMrCanonSha256)) {
      throw new Error(
        "--canon-sha256 must be exactly 64 lowercase hex characters, the project's registered canon digest.",
      );
    }
  }
  const grants = resolveInteractiveDeliveryGrants({
    workflow,
    dryRun: dryRunCount === 1,
    patchOnly: patchOnlyCount === 1,
    draftMrFlag,
    allowWriteFlag,
    commentMr: commentMr !== undefined,
    routeOnly: false,
    explicitComposition: compositionId !== undefined,
  });
  const remoteValues = options(withoutOutputFlags, "--remote");
  if (remoteValues.length > 1) {
    throw new Error("The --remote option must not be duplicated on docsfab run.");
  }
  const remoteName = resolvePublicationRemoteName(
    remoteValues[0] ? parsePublicationRemoteName(remoteValues[0]) : undefined,
    grants.draftMr,
  );
  const requestedRevision = option(withoutOutputFlags, "--revision");
  const revision = requestedRevision ?? "HEAD";
  const comparisonBaseValues = options(withoutOutputFlags, "--comparison-base");
  const comparisonWorkspaceCount = withoutOutputFlags.filter(
    (argument) => argument === "--comparison-workspace",
  ).length;
  if (comparisonBaseValues.length > 1 || comparisonWorkspaceCount > 1) {
    throw new Error("Comparison options must not be duplicated on docsfab run.");
  }
  if (comparisonBaseValues.length > 0 && comparisonWorkspaceCount > 0) {
    throw new Error(
      "--comparison-base and --comparison-workspace are mutually exclusive and cannot be combined.",
    );
  }
  if (
    (comparisonBaseValues.length > 0 || comparisonWorkspaceCount > 0) &&
    workflow !== "update-documentation"
  ) {
    throw new Error("Comparison options are valid only for the update-documentation workflow.");
  }
  const comparisonBase = comparisonBaseValues[0];
  if (
    comparisonBase !== undefined &&
    (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(comparisonBase) ||
      requestedRevision === undefined ||
      !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(requestedRevision))
  ) {
    throw new Error(
      "--comparison-base requires both it and --revision to be exact full Git object IDs.",
    );
  }
  const comparisonRequest: RunComparisonRequest | undefined = comparisonBase
    ? { kind: "base-head", baseRevision: comparisonBase, headRevision: requestedRevision! }
    : comparisonWorkspaceCount === 1
      ? { kind: "workspace" }
      : undefined;
  const readerSourceValues = options(withoutOutputFlags, "--reader-source");
  if (readerSourceValues.length > 0 && workflow !== "update-documentation") {
    throw new Error("--reader-source is valid only for the update-documentation workflow.");
  }
  const readerSources = readerSourceValues.map(parseReaderSource);
  if (
    new Set(readerSources.map(({ role, path }) => `${role}\0${path}`)).size !== readerSources.length
  ) {
    throw new Error("Every --reader-source role and path binding must be unique.");
  }
  const resumeOption = { name: "--resume-from", present: resumeFrom !== undefined };
  // `run --pr <github.com pull request URL>` is a change source: the shared
  // admission counts and gates it but never parses it as a merge request.
  const githubChangeRequest = claimRunGithubChangeRequest(withoutOutputFlags);
  const { sourcePaths, changeRequestSelector } = admitCliSourceSelection(
    githubChangeRequest?.args ?? withoutOutputFlags,
    { workflow, resumeOption, claimedChangeRequest: githubChangeRequest !== undefined },
  );
  // The original args, so `--change` beside a GitHub `--pr` still conflicts.
  const changeSource = admitCliChangeSourceSelection(withoutOutputFlags, {
    workflow,
    resumeOption,
  });
  const githubPullRequest = githubChangeRequest
    ? runGithubPullRequestChangeSource(githubChangeRequest.value)
    : undefined;
  // `run --mr` also binds the merge request's pinned diff, as `--change` would.
  const runChangeSource =
    changeSource ?? githubPullRequest ?? mergeRequestChangeSourceSelector(changeRequestSelector);
  const reviewDeliveryValues = options(withoutOutputFlags, "--review-delivery");
  const reviewDeliveryTargetValues = options(withoutOutputFlags, "--review-delivery-target");
  if (reviewDeliveryValues.length > 1 || reviewDeliveryTargetValues.length > 1) {
    throw new ReviewDeliveryCliOperatorError("duplicate-option");
  }
  const reviewDelivery = reviewDeliveryValues[0];
  const reviewDeliveryTarget = reviewDeliveryTargetValues[0];
  if ((reviewDelivery === undefined) !== (reviewDeliveryTarget === undefined)) {
    throw new ReviewDeliveryCliOperatorError("missing-pair");
  }
  if (reviewDelivery !== undefined) {
    if (workflow !== "review-documentation" || !runChangeSource) {
      throw new ReviewDeliveryCliOperatorError("explicit-source-required");
    }
    if (reviewDelivery !== "preview" && reviewDelivery !== "publish") {
      throw new ReviewDeliveryCliOperatorError("invalid-mode");
    }
    if (reviewDelivery === "publish") {
      throw new ReviewDeliveryCliOperatorError("publish-unsupported");
    }
    const target = parseCommentMrTarget(reviewDeliveryTarget!);
    if (target.kind !== "url") {
      throw new ReviewDeliveryCliOperatorError("target-url-required");
    }
    if (commentMr !== undefined || grants.draftMr || grants.allowWrite || dryRunCount === 1) {
      throw new ReviewDeliveryCliOperatorError("read-only-required");
    }
  }
  const targetPathValues = options(withoutOutputFlags, "--context-path");
  const reviewTargetValues = options(withoutOutputFlags, "--review-target");
  if (reviewTargetValues.length > 0 && workflow !== "review-documentation") {
    failRunOption("review-target-workflow");
  }
  if (reviewTargetValues.length > 0 && targetPathValues.length > 0) {
    failRunOption("review-target-conflict");
  }
  const reviewTargetPaths =
    reviewTargetValues.length > 0
      ? [...new Set(reviewTargetValues.map((path) => contextPath(path, "--review-target")))].sort()
      : undefined;
  const rescopeFromValues = options(withoutOutputFlags, "--rescope-from");
  if (rescopeFromValues.length > 1) {
    failRunOption("rescope-from-repeated");
  }
  const rescopeFrom = rescopeFromValues[0];
  if (rescopeFrom && resumeFrom !== undefined) {
    failRunOption("rescope-from-conflict");
  }
  if (rescopeFrom && (workflow !== "review-documentation" || !reviewTargetPaths)) {
    failRunOption("rescope-from-incomplete");
  }
  if (rescopeFrom && dryRunCount > 0) {
    failRunOption("rescope-from-preview");
  }
  if (rescopeFrom && !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(requestedRevision ?? "")) {
    failRunOption("rescope-from-revision");
  }
  const targetAnchorValues = options(withoutOutputFlags, "--context-anchor");
  const candidateParentPathValues = options(withoutOutputFlags, "--context-parent-path");
  const candidateParentAnchorValues = options(withoutOutputFlags, "--context-parent-anchor");
  if (
    targetPathValues.length > 1 ||
    targetAnchorValues.length > 1 ||
    candidateParentPathValues.length > 1 ||
    candidateParentAnchorValues.length > 1
  ) {
    throw new Error("Context override options must not be duplicated on docsfab run.");
  }
  const targetPath = targetPathValues[0];
  const targetAnchor = targetAnchorValues[0];
  const candidateParentPath = candidateParentPathValues[0];
  const candidateParentAnchor = candidateParentAnchorValues[0];
  if (targetAnchor && !targetPath) {
    throw new Error("--context-anchor requires --context-path.");
  }
  if (candidateParentPath && !targetPath) {
    throw new Error("--context-parent-path requires --context-path.");
  }
  if (candidateParentAnchor && !candidateParentPath) {
    throw new Error("--context-parent-anchor requires --context-parent-path.");
  }
  const contextTarget = targetPath
    ? {
        sourcePath: contextPath(targetPath, "--context-path"),
        ...(targetAnchor ? { anchor: contextAnchor(targetAnchor, "--context-anchor") } : {}),
        ...(candidateParentPath
          ? {
              candidateParentPath: contextPath(candidateParentPath, "--context-parent-path"),
            }
          : {}),
        ...(candidateParentAnchor
          ? {
              candidateParentAnchor: contextAnchor(
                candidateParentAnchor,
                "--context-parent-anchor",
              ),
            }
          : {}),
      }
    : undefined;
  const docImprovementCampaignValues = options(withoutOutputFlags, "--doc-improvement-campaign");
  const docImprovementReviewerPolicyValues = options(withoutOutputFlags, "--reviewer-policy");
  if (docImprovementCampaignValues.length > 1 || docImprovementReviewerPolicyValues.length > 1) {
    throw new Error("Bounded documentation improvement options must not be duplicated.");
  }
  const docImprovementCampaignPath = docImprovementCampaignValues[0];
  const docImprovementReviewerPolicyPath = docImprovementReviewerPolicyValues[0];
  const docImprovementRequested =
    docImprovementCampaignPath !== undefined || docImprovementReviewerPolicyPath !== undefined;
  if (docImprovementRequested && instruction) {
    throw new Error(
      "Bounded documentation improvement rejects --instruction; execution uses the exact signed proposal.",
    );
  }
  if (docImprovementRequested && contextTarget) {
    throw new Error(
      "Bounded documentation improvement rejects context overrides; execution uses the signed gap-evidence path.",
    );
  }
  if (
    docImprovementRequested &&
    (workflow !== "update-documentation" ||
      !withoutOutputFlags.includes("--allow-write") ||
      !docImprovementCampaignPath ||
      !docImprovementReviewerPolicyPath ||
      !/^[a-f0-9]{40,64}$/u.test(revision))
  ) {
    throw new Error(
      "Bounded documentation improvement requires update-documentation, --allow-write, a full --revision, --doc-improvement-campaign, and --reviewer-policy.",
    );
  }
  const canonSnapshotValues = options(withoutOutputFlags, "--canon-snapshot");
  if (canonSnapshotValues.length > 1) {
    throw new Error("The --canon-snapshot option must not be duplicated on docsfab run.");
  }
  const canonSnapshotPath = canonSnapshotValues[0];
  if (
    canonSnapshotPath &&
    workflow !== "create-documentation" &&
    workflow !== "update-documentation"
  ) {
    throw new Error(
      "The --canon-snapshot option is only valid with create-documentation or update-documentation.",
    );
  }
  if (resumeFrom && !canonSnapshotPath && !answerRecordResumeAllowed) {
    // hygiene: envelope -- parser failures are rendered by reportCommandFailure.
    throw new Error(
      workflow === "create-documentation"
        ? "Answer-record --resume-from does not support CREATE V3; knowledge continuation requires a --canon-snapshot <json> path."
        : "The --resume-from option requires a --canon-snapshot <json> path.",
    );
  }
  const acceptCandidateCount = withoutOutputFlags.filter(
    (argument) => argument === "--accept-candidate-snapshot",
  ).length;
  if (acceptCandidateCount > 1) {
    throw new Error(
      "The --accept-candidate-snapshot option must not be duplicated on docsfab run.",
    );
  }
  const acceptCandidateSnapshot = acceptCandidateCount === 1;
  const authorityIdValues = options(withoutOutputFlags, "--authority-id");
  if (authorityIdValues.length > 1) {
    throw new Error("The --authority-id option must not be duplicated on docsfab run.");
  }
  const canonSnapshotAuthorityId = authorityIdValues[0];
  if (
    acceptCandidateSnapshot &&
    workflow !== "create-documentation" &&
    workflow !== "update-documentation"
  ) {
    throw new Error(
      "The --accept-candidate-snapshot option is only valid with create-documentation or update-documentation.",
    );
  }
  if (acceptCandidateSnapshot && !canonSnapshotPath) {
    throw new Error(
      "The --accept-candidate-snapshot option requires a --canon-snapshot <json> path.",
    );
  }
  if (acceptCandidateSnapshot && !canonSnapshotAuthorityId) {
    throw new Error(
      "The --accept-candidate-snapshot option requires an --authority-id <id> operator identity.",
    );
  }
  if (canonSnapshotAuthorityId && !acceptCandidateSnapshot) {
    throw new Error(
      "The --authority-id option on docsfab run requires --accept-candidate-snapshot.",
    );
  }
  if (
    canonSnapshotAuthorityId &&
    !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/u.test(canonSnapshotAuthorityId)
  ) {
    throw new Error("The --authority-id value must be a DocsFab identifier.");
  }
  if (
    resumeFrom &&
    canonSnapshotPath &&
    (!grants.allowWrite || !acceptCandidateSnapshot || !canonSnapshotAuthorityId)
  ) {
    throw new Error(
      "The --resume-from option requires --allow-write, --accept-candidate-snapshot, and --authority-id <id>.",
    );
  }
  const changedPathValues = options(withoutOutputFlags, "--changed-path");
  if (changedPathValues.length > 0 || withoutOutputFlags.includes("--changed-path")) {
    throw new Error(
      "The --changed-path option is not supported. Use review-documentation for read-only review.",
    );
  }

  assertNoUnknownRunOptions(args);

  const mergedMrParsed =
    workflow === "update-documentation" && instruction
      ? parseMergedMrUpdateInstruction(instruction)
      : { kind: "not-applicable" as const };
  assertMergedMrSelectorCompatibility({
    parsed: mergedMrParsed,
    readerSources,
    comparisonRequest,
  });
  // A GitHub `--pr` is a change source here, so it meets a date window as `--change` does.
  const namedChangeSource = changeSource ?? githubPullRequest;
  assertSourceSelectionMatchesInstruction({
    instruction: workflow === "update-documentation" ? instruction : undefined,
    sourcePaths,
    ...(changeRequestSelector ? { changeRequestSelector } : {}),
    ...(namedChangeSource ? { changeSource: namedChangeSource } : {}),
  });
  const mergedMrSelection =
    mergedMrParsed.kind === "date-window" ? mergedMrParsed.request : undefined;
  // Last, so a mistyped flag is named first, and still before any GitLab read,
  // model call, or run record: the same check and refusal as `do`.
  assertPublicationNotProhibited(hasExplicitPublicationProhibition(instruction), {
    workflow,
    grants,
    commentMr: commentMr !== undefined,
    dryRun: dryRunCount === 1,
  });

  return {
    ...(compositionId ? { compositionId } : {}),
    ...(experimentalAnswerRecords ? { experimentalAnswerRecords: true as const } : {}),
    workflow,
    repositoryPath: resolve(repository),
    revision,
    ...(comparisonRequest ? { comparisonRequest } : {}),
    revisionExplicit: requestedRevision !== undefined,
    ...(readerSources.length > 0 ? { readerSources } : {}),
    ...(sourcePaths.length > 0 ? { sourcePaths } : {}),
    ...(changeRequestSelector ? { changeRequestSelector } : {}),
    ...(runChangeSource ? { changeSource: runChangeSource } : {}),
    ...(reviewDelivery ? { reviewDelivery, reviewDeliveryTarget } : {}),
    ...(grants.draftMr
      ? { revisionPolicy: revisionPolicyForDraftMr(revision, requestedRevision !== undefined) }
      : {}),
    ...(instruction ? { instruction } : {}),
    ...(mergedMrSelection ? { mergedMrSelection } : {}),
    ...(resumeFrom ? { resumeFrom } : {}),
    ...(contextTarget ? { contextTarget } : {}),
    ...(reviewTargetPaths ? { reviewTargetPaths } : {}),
    ...(rescopeFrom ? { rescopeFrom } : {}),
    allowWrite: grants.allowWrite,
    writeGrantExplicit: allowWriteFlag,
    retryDeliverySelection: commentMr
      ? "comment-mr"
      : grants.draftMr
        ? "draft-mr"
        : patchOnlyCount === 1 || (grants.allowWrite && !allowWriteFlag)
          ? "patch-only"
          : dryRunCount === 1
            ? "dry-run"
            : allowWriteFlag
              ? "write-only"
              : "read-only",
    draftMr: grants.draftMr,
    dryRun: dryRunCount === 1,
    ...(patchOnlyCount === 1 ? { patchOnly: true } : {}),
    ...(commentMr !== undefined ? { commentMr } : {}),
    ...(commentMrCanonSha256 !== undefined ? { commentMrCanonSha256 } : {}),
    ...(remoteName !== undefined ? { remoteName } : {}),
    releaseGate,
    verbose,
    json,
    showScan,
    quiet,
    study,
    ...(docImprovementCampaignPath
      ? {
          docImprovementCampaignPath: resolve(docImprovementCampaignPath),
          docImprovementReviewerPolicyPath: resolve(docImprovementReviewerPolicyPath!),
        }
      : {}),
    ...(canonSnapshotPath ? { canonSnapshotPath: resolve(canonSnapshotPath) } : {}),
    ...(acceptCandidateSnapshot ? { acceptCandidateSnapshot: true } : {}),
    ...(canonSnapshotAuthorityId ? { canonSnapshotAuthorityId } : {}),
  };
}

function parseReaderSource(value: string): NonNullable<RunArguments["readerSources"]>[number] {
  const separator = value.indexOf("=");
  const role = value.slice(0, separator);
  const path = value.slice(separator + 1);
  if (separator < 1 || !(READER_CONTEXT_SOURCE_ROLES as readonly string[]).includes(role)) {
    throw new Error(
      "--reader-source requires a supported role and repository-relative source path.",
    );
  }
  return {
    role: role as NonNullable<RunArguments["readerSources"]>[number]["role"],
    path: contextPath(path, "--reader-source"),
  };
}
