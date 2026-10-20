// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { parseSourceSupportInputIdV1 } from "../../artifacts/editorial-input-ask.js";
import { enforceLimit, limit, refuseLimit } from "../../config/limits.js";
import { INSTRUCTION_CONTEXT_MAX_CHARS_LIMIT } from "../../records/instruction-context.js";
import {
  decodeRunRecordReaderEvidenceRequest,
  type RunRecordReaderEvidenceRequestV1,
} from "../../records/reader-evidence-request.js";
import {
  decodeRetainedEvidenceBindings,
  movedSourcePaths,
  retainedSourcePaths,
  type RetainedEvidenceBindingsV1,
} from "../../records/retained-evidence-bindings.js";
import {
  decodeRunChangeSources,
  type RunChangeSourcesV1,
  type RunChangeSourceV1,
} from "../../records/change-sources.js";
import {
  READER_SOURCE_NOMINATIONS_LIMIT,
  type ReaderSourceHintV1,
} from "../../execution/reader-task-admission.js";
import { parseChangeSourceSelector, type LocalRangeSelectorV1 } from "../change-source.js";
import type { ChangeRequestSelectorV1 } from "../change-request-selector.js";
import type { OpenEditorialRunV1, OperatorInputResumePlanV1 } from "../operator-input-fill.js";
import { OperatorInputFillError } from "./errors.js";

export function retainedReaderEvidence(
  selected: OpenEditorialRunV1,
): RunRecordReaderEvidenceRequestV1 | undefined {
  if (selected.readerEvidenceRequest === undefined) return undefined;
  try {
    return decodeRunRecordReaderEvidenceRequest(selected.readerEvidenceRequest, selected.workflow);
  } catch {
    throw new OperatorInputFillError(
      `Run ${selected.runId} saved a comparison or reader-source request this host cannot read, so continuing it would drop that evidence. Start a new run with \`docsfab run update-documentation\` and its --comparison-workspace or --comparison-base and --reader-source options.`,
      "retained-reader-input-malformed",
    );
  }
}

/**
 * The original run's `--source`, `--pr` and `--change` bindings, decoded here
 * so a malformed value refuses by name instead of hiding the run. A binding a
 * continuation cannot carry yet refuses before the stop is claimed, so the
 * run stays open instead of continuing without its evidence.
 */
export function retainedBindings(selected: OpenEditorialRunV1): {
  readonly retainedEvidenceBindings?: RetainedEvidenceBindingsV1;
  readonly changeSources?: RunChangeSourcesV1;
} {
  const savedRecord = selected.record;
  const hasReleaseCitation =
    savedRecord !== null &&
    typeof savedRecord === "object" &&
    !Array.isArray(savedRecord) &&
    Object.prototype.hasOwnProperty.call(savedRecord, "changeSourceRelease");
  const hasReleaseChange =
    Array.isArray(selected.changeSources) &&
    selected.changeSources.some(
      (entry) =>
        entry !== null &&
        typeof entry === "object" &&
        !Array.isArray(entry) &&
        (entry as { sourceKind?: unknown }).sourceKind === "release-range",
    );
  if (hasReleaseCitation || hasReleaseChange) {
    throw new OperatorInputFillError(
      `Run ${selected.runId} is bound to a release range, which a continuation cannot replay yet. Nothing was read or saved for a continuation, and the run stays open. Start a new run with \`docsfab run ${selected.workflow} --change release:<base>..<head>\`.`,
      "continue-release-unsupported",
    );
  }
  let retainedEvidenceBindings: RetainedEvidenceBindingsV1 | undefined;
  let changeSources: readonly RunChangeSourceV1[] | undefined;
  try {
    retainedEvidenceBindings =
      selected.retainedEvidenceBindings === undefined
        ? undefined
        : decodeRetainedEvidenceBindings(selected.retainedEvidenceBindings, selected.workflow);
    changeSources =
      selected.changeSources === undefined
        ? undefined
        : decodeRunChangeSources(selected.changeSources, selected.workflow);
  } catch {
    throw new OperatorInputFillError(
      `Run ${selected.runId} saved --source, --pr or --change bindings this host cannot read, so continuing it would drop that evidence. The run stays open. Start a new run with \`docsfab run ${selected.workflow}\` and its --source, --change or --pr options.`,
      "retained-evidence-bindings-malformed",
    );
  }
  // Only a local commit range re-binds from its own pins; a forge-read change
  // or merge request text would need its forge read again.
  const forge =
    retainedEvidenceBindings?.changeRequest !== undefined ||
    (changeSources ?? []).some((entry) => entry.sourceKind !== "local-range");
  if (forge) {
    throw new OperatorInputFillError(
      `Run ${selected.runId} bound a merge request, pull request or forge commit, which a continuation cannot bind again yet, so continuing it would drop that evidence. Nothing was read and the run stays open. Start a new run with \`docsfab run ${selected.workflow} --pr <merge-request>\` or \`--change <selector>\` naming the same change.`,
      "continue-binding-forge-unsupported",
    );
  }
  return {
    ...(retainedEvidenceBindings ? { retainedEvidenceBindings } : {}),
    ...(changeSources && changeSources.length > 0
      ? { changeSources: changeSources as unknown as RunChangeSourcesV1 }
      : {}),
  };
}

/**
 * The request fields that bind a continuation to the original run's evidence:
 * its `--source` paths, and its `--change` range named by the full commit ids
 * it bound. Shared by `do` and the live agent, so both bind the same evidence.
 */
export function continuationEvidenceRequest(
  plan: Pick<OperatorInputResumePlanV1, "retainedEvidenceBindings" | "changeSources">,
): { readonly sourcePaths?: readonly string[]; readonly changeSource?: LocalRangeSelectorV1 } {
  const sourcePaths = retainedSourcePaths(plan.retainedEvidenceBindings);
  const change = plan.changeSources?.[0];
  return {
    ...(sourcePaths.length > 0 ? { sourcePaths } : {}),
    ...(change ? { changeSource: localRangeSelectorFromPins(change) } : {}),
  };
}

/**
 * The selector that names exactly the commits a local range bound. A typed
 * `HEAD~1..HEAD` would name other commits once the branch moves.
 */
function localRangeSelectorFromPins(entry: RunChangeSourceV1): LocalRangeSelectorV1 {
  const value =
    entry.rangeSemantics === "first-parent-commit"
      ? entry.head
      : entry.base === null
        ? undefined
        : `${entry.base}${entry.rangeSemantics === "three-dot" ? "..." : ".."}${entry.head}`;
  const selector = value === undefined ? undefined : parseChangeSourceSelector(value);
  if (selector?.source !== "local-range") {
    throw new OperatorInputFillError(
      `The saved --change range of this run names no base for a ${entry.rangeSemantics} range, so it cannot be bound again. The run stays open. Start a new run with \`docsfab run <workflow> --change <base>..<head>\`.`,
      "retained-evidence-bindings-malformed",
    );
  }
  return selector;
}

/** What a continuation's own acquisition observed, compared with what the plan carried. */
export interface ContinuedEvidenceObservationV1 {
  readonly retainedEvidenceBindings?: RetainedEvidenceBindingsV1;
  readonly changeSources?: readonly RunChangeSourceV1[];
}

/**
 * Refuse a continuation whose acquired evidence is not the original run's:
 * a binding only one of them carries is a conflict, and a `--source` file
 * whose content changed, or a range that resolved to other commits, moved.
 * Compares immutable pins only; labels such as a head no longer under the
 * workspace, and the digest that seals them, may differ.
 */
export function assertContinuedEvidenceMatches(
  plan: Pick<
    OperatorInputResumePlanV1,
    "originalRunId" | "workflow" | "retainedEvidenceBindings" | "changeSources"
  >,
  observed: ContinuedEvidenceObservationV1,
): void {
  const original = plan.retainedEvidenceBindings;
  const continued = observed.retainedEvidenceBindings;
  const originalChange = plan.changeSources ?? [];
  const continuedChange = observed.changeSources ?? [];
  const sourcesBound = (value: RetainedEvidenceBindingsV1 | undefined) =>
    (value?.sources?.length ?? 0) > 0;
  if (
    sourcesBound(original) !== sourcesBound(continued) ||
    (original?.changeRequest === undefined) !== (continued?.changeRequest === undefined) ||
    originalChange.length !== continuedChange.length
  ) {
    throw new OperatorInputFillError(
      `The continuation of run ${plan.originalRunId} did not bind the --source, --pr or --change evidence the stopped run bound, so it would read different evidence. Nothing was saved for it and the run stays open. Continue it again, or start a new run with \`docsfab run ${plan.workflow}\` and the options you need.`,
      "continue-binding-conflict",
    );
  }
  const moved = movedSourcePaths(original?.sources ?? [], continued?.sources ?? []);
  if (moved.length > 0) {
    throw new OperatorInputFillError(
      `Run ${plan.originalRunId} bound ${moved.join(", ")} with --source, and the content at the continued revision differs from what it read, so the continuation would read different evidence. Nothing was saved for it and the run stays open. Restore the file, or start a new run with \`docsfab run ${plan.workflow} --source <path>\` to bind the current content.`,
      "continue-binding-moved",
    );
  }
  if (originalChange.some((entry, index) => !sameChangePins(entry, continuedChange[index]!))) {
    throw new OperatorInputFillError(
      `Run ${plan.originalRunId} bound a --change range that resolved to other commits for the continuation, so it would read a different change. Nothing was saved for it and the run stays open. Start a new run with \`docsfab run ${plan.workflow} --change <base>..<head>\` to bind the change you mean.`,
      "continue-binding-moved",
    );
  }
}

/** The fields that fix which commits a change names, and never a label or the sealing digest. */
function sameChangePins(left: RunChangeSourceV1, right: RunChangeSourceV1): boolean {
  return (
    left.sourceKind === right.sourceKind &&
    left.repository.kind === right.repository.kind &&
    left.repository.identitySha256 === right.repository.identitySha256 &&
    left.objectFormat === right.objectFormat &&
    left.rangeSemantics === right.rangeSemantics &&
    left.base === right.base &&
    left.head === right.head &&
    left.mergeBase === right.mergeBase &&
    left.diffFrom === right.diffFrom
  );
}

/**
 * Refuse a continuation command that names its own `--source` or `--pr`: a
 * continuation binds exactly what the stopped run bound. `reason` says what
 * made this command a continuation.
 */
export function continuationBindingFlagConflict(reason: string): OperatorInputFillError {
  return new OperatorInputFillError(
    `This docsfab do command continues a stopped run (${reason}), and a continuation binds exactly the --source files and --change or --pr evidence that run bound, so it cannot also take --source or --pr. Continue without them, or start a new run with \`docsfab run <workflow> --source <path>\` or \`--pr <merge-request>\` to bind other evidence.`,
    "continue-binding-conflict",
  );
}

/**
 * Refuse a live-agent answer whose conversation attached sources other than
 * the ones the stopped run bound. A conversation with nothing attached
 * continues on the stopped run's own evidence.
 */
export function assertLiveSelectionMatchesContinuation(
  plan: Pick<OperatorInputResumePlanV1, "originalRunId" | "workflow" | "retainedEvidenceBindings">,
  selection: {
    readonly sourcePaths?: readonly string[];
    readonly changeRequestSelector?: ChangeRequestSelectorV1;
  },
): void {
  const paths = [...(selection.sourcePaths ?? [])].sort();
  const selector = selection.changeRequestSelector;
  if (paths.length === 0 && selector === undefined) return;
  const retainedPaths = [...retainedSourcePaths(plan.retainedEvidenceBindings)].sort();
  const retainedSelector = plan.retainedEvidenceBindings?.changeRequest?.selector;
  const samePaths =
    paths.length === retainedPaths.length && paths.every((path, i) => path === retainedPaths[i]);
  const sameSelector =
    selector === undefined
      ? retainedSelector === undefined
      : retainedSelector !== undefined &&
        selector.provider === retainedSelector.provider &&
        selector.number === retainedSelector.number &&
        (selector.host === null || selector.host === retainedSelector.host) &&
        (selector.projectPath === null || selector.projectPath === retainedSelector.projectPath);
  if (samePaths && sameSelector) return;
  throw new OperatorInputFillError(
    `This conversation attached sources that differ from the --source files and merge request run ${plan.originalRunId} bound, and a continuation binds exactly the stopped run's evidence. Detach them with /sources to continue the run, or start a new run with \`docsfab run ${plan.workflow} --source <path>\` to bind them.`,
    "continue-binding-conflict",
  );
}

/**
 * A retained base-head comparison is admitted only at its head revision, so
 * the continuation runs there unless the operator named a revision; a
 * different named revision refuses instead of failing admission later.
 */
export function continuedRevision(
  runId: string,
  retained: RunRecordReaderEvidenceRequestV1 | undefined,
  input: { readonly revision: string; readonly revisionExplicit?: boolean },
): string {
  const comparison = retained?.comparisonRequest;
  if (comparison?.kind !== "base-head") return input.revision;
  if (!input.revisionExplicit) return comparison.headRevision;
  if (input.revision === comparison.headRevision) return input.revision;
  throw new OperatorInputFillError(
    `Run ${runId} compares ${comparison.baseRevision} to ${comparison.headRevision}, so it continues only at ${comparison.headRevision}, not --revision ${input.revision}. Omit --revision, or pass --revision ${comparison.headRevision}.`,
    "continue-revision-mismatch",
  );
}

/** Original nominations first, then fills, each role and path once; never cut. */
export function unionReaderSources(
  retained: readonly ReaderSourceHintV1[],
  filled: readonly ReaderSourceHintV1[],
): ReaderSourceHintV1[] {
  const union = new Map<string, ReaderSourceHintV1>();
  for (const source of [...retained, ...filled]) {
    const key = `${source.role}\0${source.path}`;
    if (!union.has(key)) union.set(key, { role: source.role, path: source.path });
  }
  // The continued run's admission counts this union, so it refuses here, by
  // the catalog code, before the stop is claimed; the original record stays open.
  const bound = limit(READER_SOURCE_NOMINATIONS_LIMIT);
  if (union.size > bound.value) refuseLimit(bound, union.size);
  return [...union.values()];
}

/**
 * The continued run's instruction context.
 *
 * CREATE approves sources through plan source bindings, so each filled
 * source-support slot reaches the planner as one host-authored line ahead of
 * the original context. Nothing here marks a claim verified. Context over the
 * limit refuses the continue; it is never cut.
 */
export function operatorInputResumeInstructionContext(
  plan: Pick<OperatorInputResumePlanV1, "fills" | "instructionContext">,
): string | undefined {
  const nominations = plan.fills.flatMap((fill) => {
    if (fill.role !== "approved-source") return [];
    const slot = parseSourceSupportInputIdV1(fill.inputId);
    if (!slot) return [];
    const subject = slot.dimension.replaceAll("-", " ");
    return [
      `InputAsk fill ${fill.inputId}: the operator supplied the tracked repository file ${fill.locator} as an approved source for ${subject} on ${slot.pagePath}. Bind it to that page and verify the page against it.`,
    ];
  });
  const context = [...nominations, ...(plan.instructionContext ? [plan.instructionContext] : [])]
    .join("\n\n")
    .trim();
  if (!context) return undefined;
  enforceLimit(limit(INSTRUCTION_CONTEXT_MAX_CHARS_LIMIT), context.length);
  return context;
}
