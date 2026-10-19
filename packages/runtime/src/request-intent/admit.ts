// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Pure host admission of a decoded request-intent proposal.
 *
 * One deterministic order, first failure wins:
 * 1. decode: shape, path grammar, duplicate targets (full case fold), size;
 *    then the existence answers must cover exactly the asked paths (host);
 * 2. Correct, re-asking the model: word-bounded quote grounding, inventory
 *    origin (then the inventory/existence agreement, a host check), named
 *    target grounding, exclusions, companions in the navigation set, question
 *    count and shape;
 * 3. Refuse, terminal: disclosure, an internal path segment, an existing page
 *    outside the update grant, a create outside the documentation roots, a
 *    written path outside the write scope;
 * 4. Supply: a create run with no write target asks which page; otherwise no
 *    write target, then an operation mismatch, each an advisory the run goes
 *    on with; then one host question for the first write target's existence
 *    answer that blocks it;
 * 5. the model's own question, an advisory the run goes on with.
 *
 * Narrowing comparisons fold letter case fully; granting comparisons (the
 * inventory, the navigation set, roots and write scope) stay exact. No I/O,
 * no clock, no globals: the caller passes the instruction, the repository
 * answers, the run's grants, and resolved limits.
 */
import { refuseLimit } from "../config/limits.js";
import type {
  RequestIntentAdmissionResult,
  RequestIntentAdvisoryCode,
  RequestIntentAdvisoryOutcome,
  RequestIntentBody,
  RequestIntentDecoded,
  RequestIntentExistenceKind,
  RequestIntentLocation,
  RequestIntentOperation,
  RequestIntentProposal,
  RequestIntentQuote,
  RequestIntentSupplyEvidence,
  RequestIntentSupplyQuestionOutcome,
} from "./contract.js";
import type { RequestIntentAdmissionInput } from "./limits.js";
import {
  decodeProposal,
  internalSegment,
  proposalQuotes,
  requireInstruction,
  requireLimits,
} from "./decode.js";
import {
  type RequestIntentHostInputs,
  requireExistence,
  requireHostInputs,
  withinScope,
  writeTargetPaths,
} from "./host-input.js";
import { proposalKit as kit, refuse, reject, RequestIntentContractError } from "./kit.js";
import { faultOutcome } from "./outcome.js";
import { groundQuote, pathTokenText, requestInstructionSha256, spanNamesPath } from "./quote.js";
import { excludes, sealRequestIntent } from "./seal.js";
import {
  type RequestIntentSupplyDecision,
  targetAbsent,
  targetCaseAmbiguous,
  targetMissing,
  targetNotFile,
  targetPresent,
} from "./supply.js";

/**
 * Admit a decoded proposal against the operator's request, the repository,
 * and the run's grants. Model defects, refusals, questions and advisories
 * return a result arm; a malformed host input throws
 * `RequestIntentContractError`, and a host list over its bound throws through
 * `refuseLimit()`.
 */
export function admitRequestIntent(
  decoded: RequestIntentDecoded,
  input: RequestIntentAdmissionInput,
): RequestIntentAdmissionResult {
  requireInstruction(input?.instruction);
  const limits = requireLimits(input.limits);
  const inventory = requireInventory(input.inventory);
  if (inventory.length > limits.maxInventoryEntries.value) {
    refuseLimit(limits.maxInventoryEntries, inventory.length);
  }
  const host = requireHostInputs(input as unknown as Record<string, unknown>, limits);
  try {
    // Re-decoding is cheap and means admission never trusts its caller's decode.
    const proposal = decodeProposal(decoded?.proposal, limits);
    const existence = requireExistence(input.existence, writeTargetPaths(proposal));
    const [question] = proposal.questions;
    const body = {
      ...admitCorrect(proposal, input.instruction, new Set(inventory), host, existence),
      question: question ?? null,
    };
    // The kit's credential scan, on exactly what would be sealed and recorded.
    kit.rejectCredentials(body);
    refuseInternalPaths(body);
    refuseAuthority(proposal, host, existence);
    const supply = supplyStop(proposal, host, existence);
    if (supply) return supply(body);
    if (question) {
      // The model's question is model output: it is recorded, unanswered, and
      // the run goes on.
      return {
        outcome: "advisory",
        code: "request-intent-model-question",
        location: "$.questions[]",
        at: "$.questions[0]",
        evidence: {
          declaredOperation: host.declaredOperation,
          operation: proposal.operation,
          observed: null,
          existing: null,
        },
        intent: sealRequestIntent(body),
      };
    }
    return { outcome: "admitted", intent: sealRequestIntent(body) };
  } catch (error) {
    return faultOutcome(error);
  }
}

function admitCorrect(
  proposal: RequestIntentProposal,
  instruction: string,
  inventory: ReadonlySet<string>,
  host: RequestIntentHostInputs,
  existence: ReadonlyMap<string, RequestIntentExistenceKind>,
): RequestIntentBody {
  const text = instruction.normalize("NFC");
  const tokens = pathTokenText(text);
  // Quote grounding: every quote is the operator's own words. Targets come
  // first in proposalQuotes order, so target i's quote is entry i. A named
  // target prefers a span that names its path; failing that, any span grounds
  // the quote and the named check below rejects it.
  const grounded = proposalQuotes(proposal).map((entry, index) => {
    const target = proposal.targets[index];
    const span =
      (target?.chosenFrom === "named"
        ? groundQuote(text, entry.quote, (candidate) =>
            spanNamesPath(tokens, candidate, target.path),
          )
        : undefined) ?? groundQuote(text, entry.quote);
    if (!span) reject("request-intent-quote-ungrounded", entry.location, entry.at);
    return {
      text: text.slice(span.start, span.end),
      start: span.start,
      end: span.end,
    };
  });
  // Origin: an inventory target is an inventory path exactly, letter case
  // included; only a create may propose a new page.
  proposal.targets.forEach((target, index) => {
    if (target.chosenFrom === "inventory" && !inventory.has(target.path)) {
      reject("request-intent-inventory-unmatched", "$.targets[].path", `$.targets[${index}].path`);
    }
    if (target.chosenFrom === "proposed-new" && proposal.operation !== "create") {
      reject(
        "request-intent-proposed-new-operation",
        "$.targets[].chosenFrom",
        `$.targets[${index}].chosenFrom`,
      );
    }
  });
  // An inventory path is a tracked file, so the host's own existence answer
  // for it must be an existing file. Disagreement is the caller's defect,
  // never the model's: re-asking could not change either input.
  proposal.targets.forEach((target) => {
    if (
      target.role === "write" &&
      target.chosenFrom === "inventory" &&
      !EXISTING_FILE.has(existence.get(target.path)!)
    ) {
      throw new RequestIntentContractError(
        "host-input-invalid",
        "the existence answer for an inventory target says it is not an existing file.",
      );
    }
  });
  // A target the operator named rests on a quote that names it: the exact path
  // as a whole token, so "docs/cli.md" never grounds "docs/cli.mdx".
  proposal.targets.forEach((target, index) => {
    if (target.chosenFrom === "named" && !spanNamesPath(tokens, grounded[index]!, target.path)) {
      reject("request-intent-named-ungrounded", "$.targets[].path", `$.targets[${index}].path`);
    }
  });
  // Exclusions only remove: a target an exclusion names or contains, letter case
  // folded, contradicts it.
  proposal.exclusions.forEach((exclusion, index) => {
    if (proposal.targets.some((target) => excludes(exclusion.path, target.path))) {
      reject(
        "request-intent-excluded-target",
        "$.exclusions[].path",
        `$.exclusions[${index}].path`,
      );
    }
  });
  // A companion updates navigation or an index the repository already has;
  // membership grants it, so the comparison is exact.
  proposal.targets.forEach((target, index) => {
    if (target.role !== "write" && !host.navigationSet.has(target.path)) {
      reject(
        "request-intent-companion-not-navigation",
        "$.targets[].path",
        `$.targets[${index}].path`,
      );
    }
  });
  // The decision record allows at most one question per stop: a protocol rule, not a tunable bound.
  if (proposal.questions.length > 1) {
    reject("request-intent-question-count", "$.questions", "$.questions");
  }
  proposal.questions.forEach((question, index) => {
    const path = `$.questions[${index}]`;
    if (
      question.options.length === 0 ||
      new Set(question.options).size !== question.options.length
    ) {
      reject("request-intent-question-default", "$.questions[].options", `${path}.options`);
    }
    if (!question.options.includes(question.recommendedDefault)) {
      reject(
        "request-intent-question-default",
        "$.questions[].recommendedDefault",
        `${path}.recommendedDefault`,
      );
    }
  });
  return sealedBody(proposal, grounded, instruction);
}

/** Replace each model quote with the grounded operator slice, in proposalQuotes order. */
function sealedBody(
  proposal: RequestIntentProposal,
  grounded: readonly RequestIntentQuote[],
  instruction: string,
): RequestIntentBody {
  let next = 0;
  const take = (): RequestIntentQuote => grounded[next++]!;
  return {
    instructionSha256: requestInstructionSha256(instruction),
    operation: proposal.operation,
    targets: proposal.targets.map((target) => ({
      path: target.path,
      role: target.role,
      chosenFrom: target.chosenFrom,
      quote: take(),
    })),
    sources: proposal.sources.map((source) => ({
      path: source.path,
      quote: take(),
    })),
    preserve: proposal.preserve.map(() => ({ quote: take() })),
    exclusions: proposal.exclusions.map((exclusion) => ({
      path: exclusion.path,
      quote: take(),
    })),
    constraints: proposal.constraints.map((constraint) => ({
      kind: constraint.kind,
      quote: take(),
    })),
    authorityPreference: {
      preference: proposal.authorityPreference.preference,
      quote: proposal.authorityPreference.quote === null ? null : take(),
    },
    question: null,
  };
}

const INTERNAL_PATH_REMEDIATION =
  "Remove the path from the request; repository internals are never read or written.";

/**
 * Targets and sources may not pass through a repository-internal segment.
 * Exclusions may: they only narrow the work.
 */
function refuseInternalPaths(body: RequestIntentBody): void {
  const named = [
    ...body.targets.map((target, index) => ({
      path: target.path,
      location: "$.targets[].path" as const,
      at: `$.targets[${index}].path`,
    })),
    ...body.sources.map((source, index) => ({
      path: source.path,
      location: "$.sources[].path" as const,
      at: `$.sources[${index}].path`,
    })),
  ];
  for (const entry of named) {
    const segment = internalSegment(entry.path);
    if (segment !== undefined) {
      refuse("request-intent-internal-path", entry.location, entry.at, {
        kind: "internal-segment",
        segment,
        observed: entry.path,
        remediation: INTERNAL_PATH_REMEDIATION,
      });
    }
  }
}

/** Answers that mean an existing file, whatever the grant or the letter case. */
const EXISTING_FILE: ReadonlySet<RequestIntentExistenceKind | undefined> = new Set([
  "file",
  "case-fold",
  "file-not-granted",
]);

const WRITE_GRANT_REMEDIATION =
  "Have the host that grants this run's writes cover this page, or name a page the grant covers.";

function rootRemediation(roots: RequestIntentHostInputs["docsRoot"]): string {
  return roots.length === 0
    ? "This run declares no documentation root, so it cannot create a page; run a workflow that declares one."
    : `Name a new page under ${roots.map((root) => root.path).join(" or ")}.`;
}

function scopeRemediation(scope: RequestIntentHostInputs["grantedWriteScope"]): string {
  const listed =
    scope.length === 0
      ? "This run may write nothing"
      : `This run may write only ${scope.map((entry) => entry.path).join(", ")}`;
  return `${listed}; name only paths inside it. To write a Markdown or MDX page outside it, add the page, or its directory, to documentationRoots in .docsfab.json; source, CI, and agent instruction files stay read-only.`;
}

/**
 * Authority refusals, in order: an existing page outside the update grant, a
 * create target outside every documentation root, then any written path,
 * companions included, outside the write scope. They run before any advisory.
 * A run that declares review writes nothing, so none of them applies to it,
 * whatever the reading names. Any other run checks every reading, a review
 * reading included, against the write scope the host passes: the run's roots.
 */
function refuseAuthority(
  proposal: RequestIntentProposal,
  host: RequestIntentHostInputs,
  existence: ReadonlyMap<string, RequestIntentExistenceKind>,
): void {
  if (host.declaredOperation === "review") return;
  const at = (index: number) => `$.targets[${index}].path`;
  // A create over an existing page is a question (target present), not this refusal.
  if (proposal.operation !== "create") {
    proposal.targets.forEach((target, index) => {
      if (target.role === "write" && existence.get(target.path) === "file-not-granted") {
        refuse("request-intent-target-not-granted", "$.targets[].path", at(index), {
          kind: "write-grant",
          observed: target.path,
          remediation: WRITE_GRANT_REMEDIATION,
        });
      }
    });
  }
  // Only a new page needs a documentation root; companions are judged by the scope below.
  if (proposal.operation === "create") {
    proposal.targets.forEach((target, index) => {
      if (target.role === "write" && !withinScope(target.path, host.docsRoot)) {
        refuse("request-intent-outside-docs-root", "$.targets[].path", at(index), {
          kind: "docs-root",
          roots: host.docsRoot,
          observed: target.path,
          remediation: rootRemediation(host.docsRoot),
        });
      }
    });
  }
  proposal.targets.forEach((target, index) => {
    if (!withinScope(target.path, host.grantedWriteScope)) {
      refuse("request-intent-outside-write-scope", "$.targets[].path", at(index), {
        kind: "write-scope",
        grant: host.grantedWriteScope,
        observed: target.path,
        remediation: scopeRemediation(host.grantedWriteScope),
      });
    }
  });
}

/** A Supply finding, given the body it seals: a host question, or an advisory. */
type SupplyStop = (
  body: RequestIntentBody,
) => RequestIntentSupplyQuestionOutcome | RequestIntentAdvisoryOutcome;

function supplyAt(
  { code, question }: RequestIntentSupplyDecision,
  location: RequestIntentLocation,
  at: string,
  evidence: RequestIntentSupplyEvidence,
): SupplyStop {
  // The host's question replaces any the model asked: one question per stop,
  // and it is sealed so a record with a null question still means admitted.
  return (body) => ({
    outcome: "question",
    code,
    location,
    at,
    question,
    evidence,
    intent: sealRequestIntent({ ...body, question }),
  });
}

function advisoryAt(
  code: Exclude<RequestIntentAdvisoryCode, "request-intent-model-question">,
  location: "$.targets" | "$.operation",
  evidence: RequestIntentSupplyEvidence,
): SupplyStop {
  // One finding per reading: this one replaces any question the model asked,
  // and the reading is sealed with no question.
  return (body) => ({
    outcome: "advisory",
    code,
    location,
    at: location,
    evidence,
    intent: sealRequestIntent({ ...body, question: null }),
  });
}

/**
 * The first Supply finding, or `undefined`: a create run with no write target
 * asks which page; otherwise a write operation with no write target, then an
 * operation other than the declared one, each an advisory; then the first
 * write target, in proposal order, whose existence answer raises a question.
 */
function supplyStop(
  proposal: RequestIntentProposal,
  host: RequestIntentHostInputs,
  existence: ReadonlyMap<string, RequestIntentExistenceKind>,
): SupplyStop | undefined {
  const { operation } = proposal;
  const declaredOperation = host.declaredOperation;
  const evidence = (observed: string | null, existing: RequestIntentExistenceKind | null) => ({
    declaredOperation,
    operation,
    observed,
    existing,
  });
  const writes = proposal.targets.flatMap((target, index) =>
    target.role === "write" ? [{ path: target.path, index }] : [],
  );
  // A create writes a page whose path only the operator can name, so a create
  // run asks which page whatever operation the reading names.
  if (declaredOperation === "create" && writes.length === 0) {
    const noTarget = evidence(null, null);
    return supplyAt(targetMissing(declaredOperation), "$.targets", "$.targets", noTarget);
  }
  // A review may read the repository without naming a page; any other
  // operation that names none leaves the pages to the workflow.
  if (operation !== "review" && writes.length === 0) {
    return advisoryAt("request-intent-target-missing", "$.targets", evidence(null, null));
  }
  // Never rerouted: the operator's command chooses the workflow, and it runs.
  // Existence is judged for the operation the reading names, which this run
  // does not perform, so no existence question follows a mismatch.
  if (operation !== declaredOperation) {
    return advisoryAt("request-intent-operation-mismatch", "$.operation", evidence(null, null));
  }
  // A restructure may move content into pages it creates: an absent target
  // under a documentation root is a new destination once another target
  // exists as the page the content comes from.
  const hasSource =
    operation === "restructure" && writes.some(({ path }) => existence.get(path) === "file");
  for (const { path, index } of writes) {
    const existing = existence.get(path)!;
    if (hasSource && existing === "absent" && withinScope(path, host.docsRoot)) continue;
    const asked = existenceQuestion(operation, path, existing);
    if (asked) {
      return supplyAt(
        asked,
        "$.targets[].path",
        `$.targets[${index}].path`,
        evidence(path, existing),
      );
    }
  }
  return undefined;
}

/**
 * The question an existence answer raises for an operation, or `undefined`
 * when the target may proceed. A create needs the path free; every other
 * operation needs an existing file in the exact letter case. An existing page
 * outside the update grant was refused before this unless the operation is a
 * review, which writes nothing.
 */
function existenceQuestion(
  operation: RequestIntentOperation,
  path: string,
  existing: RequestIntentExistenceKind,
): RequestIntentSupplyDecision | undefined {
  if (operation === "create") {
    return existing === "absent" ? undefined : targetPresent(path, existing);
  }
  switch (existing) {
    case "file":
    case "file-not-granted":
      return undefined;
    case "case-fold":
      return targetCaseAmbiguous(operation, path);
    case "directory":
    case "parent-file":
      return targetNotFile(operation, path, existing);
    case "absent":
      return targetAbsent(operation, path);
  }
}

function requireInventory(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new RequestIntentContractError(
      "host-input-invalid",
      "the caller must pass the repository inventory as an array of path strings.",
    );
  }
  return value as readonly string[];
}
