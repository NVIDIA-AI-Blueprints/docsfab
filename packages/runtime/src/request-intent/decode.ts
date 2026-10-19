// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Closed decode of a model's request-intent proposal.
 *
 * Order is fixed so the same proposal always fails the same way: the closed
 * shape, then path grammar, then duplicate targets, then the size bounds.
 * Every check is built from the contract kit; nothing here re-implements an
 * inert, exact, or seal primitive.
 */
import { limitDefinition, type ResolvedLimit } from "../config/limits.js";
import {
  REQUEST_INTENT_AUTHORITY_PREFERENCES,
  REQUEST_INTENT_CONSTRAINT_KINDS,
  REQUEST_INTENT_OPERATIONS,
  REQUEST_INTENT_TARGET_ORIGINS,
  REQUEST_INTENT_TARGET_ROLES,
  type RequestIntentDecodeResult,
  type RequestIntentLocation,
  type RequestIntentProposal,
  type RequestIntentProposalAuthority,
  type RequestIntentProposalConstraint,
  type RequestIntentProposalPathQuote,
  type RequestIntentProposalQuote,
  type RequestIntentProposalTarget,
  type RequestIntentQuestion,
} from "./contract.js";
import {
  REQUEST_INTENT_LIMIT_NAMES,
  type RequestIntentDecodeInput,
  type RequestIntentLimits,
} from "./limits.js";
import { at, proposalKit as kit, reject, RequestIntentContractError } from "./kit.js";
import { rejectedOutcome } from "./outcome.js";

const REQUIRED_KEYS = ["operation", "targets", "authorityPreference"] as const;
const OPTIONAL_KEYS = ["sources", "preserve", "exclusions", "constraints", "questions"] as const;
const PROPOSAL_KEYS = [...REQUIRED_KEYS, ...OPTIONAL_KEYS];
/** Fields only the host stamps; a proposal carrying one is told to drop it. */
const HOST_KEYS = ["instructionSha256", "kind", "schemaVersion", "digest"] as const;

/**
 * Decode a model proposal into its closed shape, or reject it with the first
 * Correct-class code it fails. Throws only for a malformed host input.
 */
export function decodeRequestIntentProposal(
  proposal: unknown,
  input: RequestIntentDecodeInput,
): RequestIntentDecodeResult {
  requireInstruction(input?.instruction);
  const limits = requireLimits(input.limits);
  try {
    return { outcome: "decoded", proposal: decodeProposal(proposal, limits) };
  } catch (error) {
    // Decode raises only Correct-class codes; anything else propagates.
    return rejectedOutcome(error);
  }
}

/** The decode the admission step repeats, so admission never trusts its caller. */
export function decodeProposal(value: unknown, limits: RequestIntentLimits): RequestIntentProposal {
  // The strict walk enforces the shared runtime.contract.* bounds first.
  kit.assertInert(value);
  const root = at("$", "$", () => kit.object(value));
  for (const key of HOST_KEYS) {
    if (Object.hasOwn(root, key)) reject("request-intent-host-field", "$", "$");
  }
  at("$", "$", () => kit.exact(root, PROPOSAL_KEYS, OPTIONAL_KEYS));
  const proposal = kit.deepFreeze({
    operation: at("$.operation", "$.operation", () =>
      kit.enumeration(root.operation, REQUEST_INTENT_OPERATIONS),
    ),
    targets: list(root.targets, "$.targets", "$.targets[]", decodeTarget),
    sources: optionalList(root.sources, "$.sources", "$.sources[]", (entry, path) =>
      decodePathQuote(entry, path, "$.sources[].path", "$.sources[].quote"),
    ),
    preserve: optionalList(root.preserve, "$.preserve", "$.preserve[]", decodePreserve),
    exclusions: optionalList(root.exclusions, "$.exclusions", "$.exclusions[]", (entry, path) =>
      decodePathQuote(entry, path, "$.exclusions[].path", "$.exclusions[].quote"),
    ),
    constraints: optionalList(
      root.constraints,
      "$.constraints",
      "$.constraints[]",
      decodeConstraint,
    ),
    authorityPreference: decodeAuthority(root.authorityPreference),
    questions: optionalList(root.questions, "$.questions", "$.questions[]", decodeQuestion),
  }) satisfies RequestIntentProposal;
  checkPathGrammar(proposal);
  checkDuplicateTargets(proposal);
  checkSizes(proposal, limits);
  return proposal;
}

type ShapeLocation = Parameters<typeof at>[0];

function list<T>(
  value: unknown,
  location: ShapeLocation,
  entryLocation: ShapeLocation,
  decode: (entry: unknown, path: string) => T,
): T[] {
  const entries = at(location, location, () => kit.array(value));
  return entries.map((entry, index) => {
    const path = `${location}[${index}]`;
    at(entryLocation, path, () => kit.object(entry));
    return decode(entry, path);
  });
}

function optionalList<T>(
  value: unknown,
  location: ShapeLocation,
  entryLocation: ShapeLocation,
  decode: (entry: unknown, path: string) => T,
): T[] {
  return value === undefined ? [] : list(value, location, entryLocation, decode);
}

function closed(
  entry: unknown,
  keys: readonly string[],
  location: ShapeLocation,
  path: string,
): Record<string, unknown> {
  return at(location, path, () => {
    const object = kit.object(entry);
    kit.exact(object, keys);
    return object;
  });
}

/** Any string; quotes are matched after NFC normalization, so NFD text is fine. */
function quoteText(value: unknown, location: ShapeLocation, path: string): string {
  return typeof value === "string" ? value : reject("request-intent-shape", location, path);
}

/** Paths are checked by the path grammar after the whole shape decodes. */
function pathText(value: unknown, location: ShapeLocation, path: string): string {
  return typeof value === "string" ? value : reject("request-intent-shape", location, path);
}

function decodeTarget(entry: unknown, path: string): RequestIntentProposalTarget {
  const root = closed(entry, ["path", "role", "chosenFrom", "quote"], "$.targets[]", path);
  return {
    path: pathText(root.path, "$.targets[].path", `${path}.path`),
    role: at("$.targets[].role", `${path}.role`, () =>
      kit.enumeration(root.role, REQUEST_INTENT_TARGET_ROLES),
    ),
    chosenFrom: at("$.targets[].chosenFrom", `${path}.chosenFrom`, () =>
      kit.enumeration(root.chosenFrom, REQUEST_INTENT_TARGET_ORIGINS),
    ),
    quote: quoteText(root.quote, "$.targets[].quote", `${path}.quote`),
  };
}

function decodePathQuote(
  entry: unknown,
  path: string,
  pathLocation: "$.sources[].path" | "$.exclusions[].path",
  quoteLocation: "$.sources[].quote" | "$.exclusions[].quote",
): RequestIntentProposalPathQuote {
  const entryLocation = pathLocation === "$.sources[].path" ? "$.sources[]" : "$.exclusions[]";
  const root = closed(entry, ["path", "quote"], entryLocation, path);
  return {
    path: pathText(root.path, pathLocation, `${path}.path`),
    quote: quoteText(root.quote, quoteLocation, `${path}.quote`),
  };
}

function decodePreserve(entry: unknown, path: string): RequestIntentProposalQuote {
  const root = closed(entry, ["quote"], "$.preserve[]", path);
  return {
    quote: quoteText(root.quote, "$.preserve[].quote", `${path}.quote`),
  };
}

function decodeConstraint(entry: unknown, path: string): RequestIntentProposalConstraint {
  const root = closed(entry, ["kind", "quote"], "$.constraints[]", path);
  return {
    kind: at("$.constraints[].kind", `${path}.kind`, () =>
      kit.enumeration(root.kind, REQUEST_INTENT_CONSTRAINT_KINDS),
    ),
    quote: quoteText(root.quote, "$.constraints[].quote", `${path}.quote`),
  };
}

function decodeAuthority(value: unknown): RequestIntentProposalAuthority {
  const root = closed(
    value,
    ["preference", "quote"],
    "$.authorityPreference",
    "$.authorityPreference",
  );
  const preference = at(
    "$.authorityPreference.preference",
    "$.authorityPreference.preference",
    () => kit.enumeration(root.preference, REQUEST_INTENT_AUTHORITY_PREFERENCES),
  );
  // A stated preference rests on the operator's words; an unstated one has none.
  if (preference === "unspecified") {
    if (root.quote !== null) {
      reject("request-intent-shape", "$.authorityPreference.quote", "$.authorityPreference.quote");
    }
    return { preference, quote: null };
  }
  return {
    preference,
    quote: quoteText(root.quote, "$.authorityPreference.quote", "$.authorityPreference.quote"),
  };
}

function decodeQuestion(entry: unknown, path: string): RequestIntentQuestion {
  const root = closed(
    entry,
    ["question", "options", "recommendedDefault", "consequence"],
    "$.questions[]",
    path,
  );
  const options = at("$.questions[].options", `${path}.options`, () => kit.array(root.options));
  return {
    question: at("$.questions[].question", `${path}.question`, () => kit.string(root.question)),
    options: options.map((option, index) =>
      at("$.questions[].options[]", `${path}.options[${index}]`, () => kit.string(option)),
    ),
    recommendedDefault: at("$.questions[].recommendedDefault", `${path}.recommendedDefault`, () =>
      kit.string(root.recommendedDefault),
    ),
    consequence: at("$.questions[].consequence", `${path}.consequence`, () =>
      kit.string(root.consequence),
    ),
  };
}

/**
 * The structural predicate of a repository-relative path the authoring
 * workspace accepts: NFC, relative, no backslash, no control character, and
 * no empty, `.` or `..` segment. No character whitelist.
 */
export function isRepositoryRelativePath(path: string): boolean {
  return (
    path.length > 0 &&
    path === path.normalize("NFC") &&
    !path.startsWith("/") &&
    !path.includes("\\") &&
    !/[\0-\x1f\x7f]/u.test(path) &&
    path.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..")
  );
}

function checkPathGrammar(proposal: RequestIntentProposal): void {
  proposal.targets.forEach((target, index) => {
    if (!isRepositoryRelativePath(target.path)) {
      reject("request-intent-path-grammar", "$.targets[].path", `$.targets[${index}].path`);
    }
  });
  proposal.sources.forEach((source, index) => {
    if (!isRepositoryRelativePath(source.path)) {
      reject("request-intent-path-grammar", "$.sources[].path", `$.sources[${index}].path`);
    }
  });
  proposal.exclusions.forEach((exclusion, index) => {
    if (!isRepositoryRelativePath(exclusion.path)) {
      reject("request-intent-path-grammar", "$.exclusions[].path", `$.exclusions[${index}].path`);
    }
  });
}

/**
 * Paths that differ only in letter case name one file on a case-folding
 * checkout, so every narrowing comparison (exclusions, duplicate targets, the
 * write set) uses this key. Granting comparisons, such as inventory
 * membership, stay exact case.
 *
 * `toLowerCase` alone misses the full case fold a case-insensitive file
 * system applies (`ſ` is `s`, `ß` is `SS`, final `ς` is `σ`). Lower, then
 * upper, then lower again maps every spelling that shares an upper case to
 * one key; the first lowering also carries `ẞ` to `ß` and so on to `ss`. The
 * key may join letters a file system keeps apart (`ı` and `i`), which for a
 * narrowing check refuses more, never less. Folding per segment keeps `/`
 * boundaries exactly where the path has them.
 */
export function pathCaseKey(path: string): string {
  return path
    .split("/")
    .map((segment) => segment.toLowerCase().toUpperCase().toLowerCase().normalize("NFC"))
    .join("/");
}

/**
 * Repository internals no request may read or write. The set follows the
 * semantic document projection's excluded segments; a broader protected set
 * would also refuse ordinary sources such as `.github/workflows/ci.yml`.
 */
const INTERNAL_SEGMENTS: readonly string[] = [".git"];

/** HFS+ ignores these code points when it compares names, as the command sandbox's `.git` check does. */
const HFS_IGNORABLE = /[\u200c-\u200f\u202a-\u202e\u206a-\u206f\ufeff]/gu;
/** NTFS drops trailing dots and spaces from a name; Git refuses `.git.` and `.git ` for that reason. */
const NTFS_TRAILING = /[. ]+$/u;

/**
 * The internal segment `path` passes through, or `undefined`. A segment is
 * compared the way a file system may open it: letter case folded (`.GIT`),
 * HFS+ ignorable code points removed, and trailing dots and spaces dropped
 * (`.git.`, `.git `). Kept apart from `isRepositoryRelativePath`, which
 * mirrors the workspace's own path check and has no internal-segment test.
 */
export function internalSegment(path: string): string | undefined {
  for (const segment of path.split("/")) {
    const key = pathCaseKey(segment.replace(HFS_IGNORABLE, "").replace(NTFS_TRAILING, ""));
    const internal = INTERNAL_SEGMENTS.find((candidate) => candidate === key);
    if (internal !== undefined) return internal;
  }
  return undefined;
}

function checkDuplicateTargets(proposal: RequestIntentProposal): void {
  const seen = new Set<string>();
  proposal.targets.forEach((target, index) => {
    const key = pathCaseKey(target.path);
    if (seen.has(key)) {
      reject("request-intent-duplicate-target", "$.targets[].path", `$.targets[${index}].path`);
    }
    seen.add(key);
  });
}

function overBound(
  limit: ResolvedLimit,
  observed: number,
): { name: string; limit: number; observed: number; scope: string } | undefined {
  if (observed <= limit.value) return undefined;
  return {
    name: limit.name,
    limit: limit.value,
    observed,
    scope: limitDefinition(limit.name).scope,
  };
}

function bounded(
  limit: ResolvedLimit,
  observed: number,
  location: Parameters<typeof reject<"request-intent-size">>[1],
  path: string,
): void {
  const bound = overBound(limit, observed);
  if (bound) reject("request-intent-size", location, path, bound);
}

/** Every quote a proposal carries, in field order, with its location. */
export function proposalQuotes(
  proposal: RequestIntentProposal,
): { quote: string; location: RequestIntentQuoteLocation; at: string }[] {
  const quotes: {
    quote: string;
    location: RequestIntentQuoteLocation;
    at: string;
  }[] = [];
  proposal.targets.forEach((entry, index) =>
    quotes.push({
      quote: entry.quote,
      location: "$.targets[].quote",
      at: `$.targets[${index}].quote`,
    }),
  );
  proposal.sources.forEach((entry, index) =>
    quotes.push({
      quote: entry.quote,
      location: "$.sources[].quote",
      at: `$.sources[${index}].quote`,
    }),
  );
  proposal.preserve.forEach((entry, index) =>
    quotes.push({
      quote: entry.quote,
      location: "$.preserve[].quote",
      at: `$.preserve[${index}].quote`,
    }),
  );
  proposal.exclusions.forEach((entry, index) =>
    quotes.push({
      quote: entry.quote,
      location: "$.exclusions[].quote",
      at: `$.exclusions[${index}].quote`,
    }),
  );
  proposal.constraints.forEach((entry, index) =>
    quotes.push({
      quote: entry.quote,
      location: "$.constraints[].quote",
      at: `$.constraints[${index}].quote`,
    }),
  );
  if (proposal.authorityPreference.quote !== null) {
    quotes.push({
      quote: proposal.authorityPreference.quote,
      location: "$.authorityPreference.quote",
      at: "$.authorityPreference.quote",
    });
  }
  return quotes;
}

export type RequestIntentQuoteLocation = Extract<
  RequestIntentLocation,
  | "$.targets[].quote"
  | "$.sources[].quote"
  | "$.preserve[].quote"
  | "$.exclusions[].quote"
  | "$.constraints[].quote"
  | "$.authorityPreference.quote"
>;

function checkSizes(proposal: RequestIntentProposal, limits: RequestIntentLimits): void {
  bounded(limits.maxTargets, proposal.targets.length, "$.targets", "$.targets");
  const quotes = proposalQuotes(proposal);
  bounded(limits.maxQuotes, quotes.length, "$", "$");
  for (const quote of quotes) {
    bounded(limits.maxQuoteChars, quote.quote.length, quote.location, quote.at);
  }
  proposal.questions.forEach((question, index) => {
    const path = `$.questions[${index}]`;
    bounded(
      limits.maxQuestionChars,
      question.question.length,
      "$.questions[].question",
      `${path}.question`,
    );
    bounded(
      limits.maxQuestionChars,
      question.consequence.length,
      "$.questions[].consequence",
      `${path}.consequence`,
    );
    bounded(
      limits.maxQuestionOptions,
      question.options.length,
      "$.questions[].options",
      `${path}.options`,
    );
    question.options.forEach((option, optionIndex) =>
      bounded(
        limits.maxOptionChars,
        option.length,
        "$.questions[].options[]",
        `${path}.options[${optionIndex}]`,
      ),
    );
  });
}

export function requireInstruction(instruction: unknown): asserts instruction is string {
  if (typeof instruction !== "string") {
    throw new RequestIntentContractError(
      "host-input-invalid",
      "the run must pass the operator instruction as a string.",
    );
  }
}

/** Each bound must be the resolved catalog entry it names; a stand-in is a host fault. */
export function requireLimits(value: unknown): RequestIntentLimits {
  if (!value || typeof value !== "object") {
    throw new RequestIntentContractError(
      "host-input-invalid",
      "the caller must pass every requestIntent limit resolved through limit().",
    );
  }
  const limits = value as Record<string, unknown>;
  for (const [key, name] of Object.entries(REQUEST_INTENT_LIMIT_NAMES)) {
    const entry = limits[key] as Partial<ResolvedLimit> | undefined;
    if (
      !entry ||
      typeof entry !== "object" ||
      entry.name !== name ||
      !Number.isSafeInteger(entry.value) ||
      (entry.value as number) < 1
    ) {
      throw new RequestIntentContractError(
        "host-input-invalid",
        `the caller must pass ${name} resolved through limit() as a positive integer.`,
      );
    }
  }
  return limits as unknown as RequestIntentLimits;
}
