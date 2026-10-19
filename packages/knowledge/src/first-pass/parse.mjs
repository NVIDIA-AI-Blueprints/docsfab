// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * Ordinary documentation request grammar and credential rejection used before
 * first-pass model assessment.
 */
import { createHash } from "node:crypto";
import { posix } from "node:path";

import { FirstPassSupportError } from "./error.mjs";
import { FIRST_PASS_LIMIT_DEFAULTS } from "../first-pass-limits.generated.mjs";
import { hostStateAncestor } from "./scan.mjs";

// Repository-relative segments only, with no traversal or native path
// separators. The caller/runtime still owns exact write authorization.
export const SAFE_TARGET = /^(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+\.mdx?$/u;
const TARGET_TOKEN = /(?<![A-Za-z0-9_.-])((?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+\.mdx?)/gu;
const UPDATE_TARGET = /^(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+\.(?:mdx?|rst)$/u;
const UPDATE_TARGET_TOKEN = /(?<![A-Za-z0-9_.-])((?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+\.(?:mdx?|rst))/gu;
const SUSPICIOUS_TARGET = /(?:^|[\s`'"(])((?:\/|[A-Za-z0-9_.-]+\/)[^\s`'",;)]+)/gu;
const LITERAL_SINGLE_TARGET = /^Write `docs\/.+` using only these repository-observed behavior claims:/u;
// Positional anchor that separates outputs from read dependencies; the declared
// workflow, not this word list, decides whether a create request is admitted.
const ORDINARY_OPERATION = /\b(?:create|update|refresh|revise|write)\b/iu;
const LEADING_SCOPE_RESTRICTION = new RegExp(String.raw`^${ORDINARY_OPERATION.source}\s+(?:only|exactly)\b`, "iu");
const INTENT_BEARING_PAGE =
  /\b(about|purpose|vision|mission|audience|rationale|product\s+intent)\b/iu;
/**
 * Windows drive prefix, refused so a bound selection cannot leave the tree on a
 * host whose path grammar differs from the POSIX one used here.
 */
const BOUND_SOURCE_DRIVE_PREFIX = /^[A-Za-z]:/u;
const CREDENTIAL_PATTERNS = Object.freeze([
  /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/iu,
  /\b(?:A3T[A-Z0-9]|AKIA|ASIA)[A-Z0-9]{16}\b/u,
  /\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/u,
  /\b(?:glpat|gldt|glrt|glptt)-[A-Za-z0-9_-]{20,}\b/u,
  /\b(?:xox[baprs]-[A-Za-z0-9-]{20,}|xoxe(?:\.(?:xoxb|xoxp))?-[A-Za-z0-9-]{10,}|xapp-[A-Za-z0-9-]{10,})\b/u,
  /\bAIza[A-Za-z0-9_-]{35}\b/u,
  /\bya29\.[A-Za-z0-9_-]{20,}\b/u,
  /\b(?:nvapi-[A-Za-z0-9_-]{20,}|ihub_api_[A-Za-z0-9_-]{20,})\b/u,
  /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/u,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/u,
]);
const CREDENTIAL_KEY_SUFFIXES = Object.freeze([
  "apikey",
  "api_key",
  "api-key",
  "access_token",
  "access-token",
  "auth_token",
  "auth-token",
  "client_secret",
  "client-secret",
  "password",
  "secret",
  "authorization",
  "private_token",
  "private-token",
  "cookie",
]);
const CREDENTIAL_PLACEHOLDERS = new Set([
  "changeme",
  "example",
  "placeholder",
  "replace-me",
  "replace_me",
  "test",
  "todo",
  "your-api-key",
  "your_api_key",
  "your-key-here",
  "your-token-here",
]);

/**
 * Match the established knowledge/runtime credential families without retaining
 * values. Request parsing and evidence acquisition no longer stop on it (#1807);
 * the host injects its configured-credential match instead.
 */
export function containsFirstPassCredentialMaterial(value) {
  if (CREDENTIAL_PATTERNS.some((pattern) => pattern.test(value))) return true;
  for (const match of value.matchAll(
    /(^|[^A-Za-z0-9_-])(["']?)([A-Za-z0-9][A-Za-z0-9_-]{0,255})\2\s*[:=]\s*["']?(?:bearer\s+)?([^\s"'#;,]{12,4096})/gimu,
  )) {
    const key = match[3]?.toLowerCase() ?? "";
    const candidate = (match[4] ?? "")
      .replace(/^bearer\s+/iu, "")
      .replace(/^<|>$/gu, "")
      .toLowerCase();
    const credentialKey = CREDENTIAL_KEY_SUFFIXES.some(
      (suffix) => key === suffix || key.endsWith(`_${suffix}`) || key.endsWith(`-${suffix}`),
    );
    if (
      credentialKey &&
      candidate.length >= 12 &&
      !CREDENTIAL_PLACEHOLDERS.has(candidate) &&
      !candidate.startsWith("${")
    ) {
      return true;
    }
  }
  return false;
}

export function credentialMaterial(diagnostic = { phase: "request", rule: "credential-material", location: "$instruction" }) {
  throw new FirstPassSupportError(
    "credential-material",
    "First-pass support rejected credential material before model assessment.",
    [],
    diagnostic,
  );
}

/**
 * Where the request's write clause starts: its first ordinary write operation.
 * The no-intent parser and the non-actionable guard share it, so both read a
 * kept-unchanged clause from the same start.
 */
function ordinaryOperationOffset(instruction) {
  return ORDINARY_OPERATION.exec(instruction)?.index;
}

/** Parse documentation clauses; a revision inventory resolves basenames only for negative scope checks. */
export function parseOrdinaryDocumentationRequest(input) {
  const instruction = requireText(input.instruction, "instruction");
  const workflow = input.workflow;
  const allowRst = workflow === "update-documentation";
  const targetGrammar = allowRst ? UPDATE_TARGET : SAFE_TARGET;
  const negativeWriteScope = input.purpose === "negative-write-scope";
  if (workflow !== "create-documentation" && workflow !== "update-documentation") {
    return undefined;
  }
  const unsafeScopeResult = (originalTarget) => Object.freeze({
    workflow,
    instruction,
    instructionSha256: sha256(instruction.normalize("NFC")),
    repositoryRevision: requireRevision(input.revision),
    targetPaths: Object.freeze([]),
    dependencyPaths: Object.freeze([]),
    scopePurpose: "negative-write-scope",
    scopeRefusal: "unsafe-target",
    originalTarget,
  });
  if (LITERAL_SINGLE_TARGET.test(instruction)) return undefined;

  if (!negativeWriteScope) {
    for (const match of instruction.matchAll(SUSPICIOUS_TARGET)) {
      const token = match[1]?.replace(/[.!?:]+$/u, "") ?? "";
      if ((token.includes("..") || token.includes("\\")) && /\.(?:mdx?|rst)$/iu.test(token)) {
        throw new FirstPassSupportError(
          "unsafe-target",
          `The documentation request contains an unsafe target path: ${token}`,
        );
      }
    }
  }
  const matches = documentationPathMatches(instruction, negativeWriteScope, allowRst);
  let operationOffset = ordinaryOperationOffset(instruction);
  if (operationOffset === undefined) {
    // The declared create workflow and its write grant are the operation;
    // request wording only narrows it. An update keeps its planner route.
    if (workflow !== "create-documentation") return undefined;
    // Without an operation word, nothing separates output paths from read,
    // excluded, or questioned ones. Ask instead of guessing a target.
    if (matches.length > 0) {
      throw new FirstPassSupportError(
        "ambiguous-targets",
        "The documentation request names a path but no write operation, so DocsFab cannot tell which path is the output. Name the output after a write operation such as \"Create docs/guide.md\".",
      );
    }
    operationOffset = 0;
  }
  // A later prose use of "update" after one target is an assessment, while an
  // explicit create/update before that target remains a bounded ordinary write.
  // Path-less create/update is still an ordinary request: missing `.md` tokens
  // are not a reject. The unsafe-path scan above always runs before routing.
  if (matches.length < 2) {
    const targetOffset = matches[0]?.index;
    if (targetOffset !== undefined && targetOffset < operationOffset) {
      return undefined;
    }
    if (
      targetOffset === undefined &&
      /^\s*(?:assess|review|check)\b/iu.test(instruction)
    ) {
      return undefined;
    }
  }
  const suffix = instruction.slice(operationOffset);
  // Only a write clause can declare outputs. Paths in later source summaries
  // do not turn a request to assess/update affected guidance into a file list.
  const clauseEnd = /[.!?](?:\s|$)/u.exec(suffix)?.index;
  if (workflow === "update-documentation" &&
    matches.length > 0 && clauseEnd !== undefined && !matches.some((match) => match.index < operationOffset) &&
    !/\b(?:only|exactly)\b/iu.test(suffix.slice(0, clauseEnd)) &&
    documentationPathMatches(suffix.slice(0, clauseEnd), negativeWriteScope, allowRst).length === 0) {
    // Keep an explicit restriction on the established scope-validation path,
    // including a named list introduced after a semicolon.
    const explicitRestriction = /\b(?:(?:change|modify|edit|write|update)\s+(?:only|exactly)|only\s+(?:change|modify|edit|write|update))\s+(?:(?:the|these|following|listed|specified|named|target)\s+)*(?:files|pages|documents|targets)\b/iu.test(suffix);
    const laterWriteClause = explicitRestriction || suffix.slice(clauseEnd).split(/[;.!?](?:\s+|$)/u).some((clause) =>
      documentationPathMatches(clause, negativeWriteScope, allowRst).some((match) => {
        const prefix = clause.slice(0, match.index);
        const writeOperations = [...prefix.matchAll(/\b(?:create|update|refresh|revise|write|change|modify|edit)\b/giu)];
        return writeOperations.some((operation) =>
          !/\b(?:not|never|don't)\s+$/iu.test(prefix.slice(0, operation.index))) ||
          /^\s*(?:(?:[-*]|\d+[.)])\s+)?[`'"]?$/u.test(prefix);
      }));
    if (!laterWriteClause) return undefined;
  }
  const sourceMarkers = negativeWriteScope
    ? /\b(?:using|use|read|based on|with evidence from|consult|consulting|according to|source dependency)\b/giu
    : /\b(?:using|use|read|based on|with evidence from|consulting|according to|source dependency)\b/giu;
  const dependencyOffset = [...suffix.matchAll(sourceMarkers)].find((match) => {
    const marker = match[0].toLowerCase();
    const prefix = suffix.slice(0, match.index);
    if (["use", "read", "source dependency", "consult"].includes(marker)) {
      // Bare imperative markers require a separate clause. Descriptions such as
      // "read-only reference", "use cases", and path components are not sources.
      const hasOutput = matches.some((path) =>
        path.index > operationOffset && path.index < operationOffset + match.index);
      const operand = suffix.slice(match.index + match[0].length);
      const namesSource = /^(?::)?\s+(?:the\s+)?[`'"]?(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+\.[A-Za-z0-9]+(?:[\s,;:`'"]|$)/u.test(operand);
      const independentClause = /(?:[;.!?]\s+|\n\s*)$/u.test(prefix);
      const coordinatedClause = /(?:[,:]\s*|\b(?:and|then)\s+)$/iu.test(prefix) && hasOutput;
      if ((!independentClause && !coordinatedClause) || (!hasOutput && !namesSource) ||
          !/^(?:\s|:)/u.test(operand)) return false;
    }
    // "for developers using Sprout. The output is docs/reference.md" names
    // an audience, not a source boundary. Keep the later explicit output.
    const end = /[.!?](?:\s|$)/u.exec(suffix.slice(match.index))?.index;
    return !(match[0].toLowerCase() === "using" && end !== undefined &&
      /\bfor\s+[^.!?;]+\s+$/iu.test(suffix.slice(0, match.index)));
  })?.index;
  const writeBoundary =
    dependencyOffset === undefined ? instruction.length : operationOffset + dependencyOffset;
  const writeMatches = matches.filter(
    (match) => (match.index ?? 0) > operationOffset && (match.index ?? instruction.length) < writeBoundary,
  );
  if (writeMatches.length === 0 && dependencyOffset !== undefined) {
    const laterOutput = matches.some((match) => {
      if (match.index < writeBoundary) return false;
      const prefix = instruction.slice(writeBoundary, match.index).split(/[;.!?](?:\s+|$)/u).at(-1);
      const writes = [...prefix.matchAll(/\b(?:create|update|refresh|revise|write|author|produce)\b/giu)];
      return writes.some((write) => !/\b(?:not|never|don't)\s+$/iu.test(prefix.slice(0, write.index))) ||
        /\b(?:output|destination|target)(?:\s+(?:file|page|path))?\s*(?:is|must be|should be|:|=)\s*[`'"]?$/iu.test(prefix);
    });
    if (laterOutput && !negativeWriteScope) {
      throw new FirstPassSupportError("ambiguous-targets", "Name the explicit output before its source dependencies; a later output declaration cannot use an inferred destination.");
    }
  }
  const leadingDependencies = matches.filter((match) => (match.index ?? 0) < operationOffset);
  // An assessment can name several evidence files before asking whether an
  // update is needed. Without a following output path it is not an explicit
  // write list; leave target selection to the governed reader planner.
  if (leadingDependencies.length > 0 && writeMatches.length === 0 && /^\s*(?:assess|review|check)\b/iu.test(instruction)) {
    if (matches.some((match) => (match.index ?? 0) >= writeBoundary &&
      /\b(?:create|update|refresh|revise|write|change|only)\b/iu.test(instruction.slice(writeBoundary, match.index)))) {
      throw new FirstPassSupportError(
        "ambiguous-targets",
        "An assessment followed by a write restriction requires an explicit output list.",
      );
    }
    return undefined;
  }
  if (
    leadingDependencies.length > 0 &&
    !/\b(?:based on|use|using|consulting|with evidence from)\b/iu.test(
      instruction.slice(0, operationOffset),
    )
  ) {
    throw new FirstPassSupportError(
      "ambiguous-targets",
      "Documentation paths before the write operation must be explicit read dependencies.",
    );
  }
  const restrictionMatches = explicitScopeRestrictionMatches(
    instruction,
    matches.filter((match) => match.index > operationOffset),
    operationOffset,
    instruction.length,
  );
  const leadingScopeEnd = clauseEnd !== undefined &&
    documentationPathMatches(suffix.slice(0, clauseEnd), negativeWriteScope, allowRst).length > 0 &&
    LEADING_SCOPE_RESTRICTION.test(suffix)
    ? operationOffset + clauseEnd
    : undefined;
  const contextualMatches = writeMatches.filter((match) => {
    if (restrictionMatches.includes(match)) return false;
    return mentionIsPreserved(instruction, match, operationOffset) ||
      (leadingScopeEnd !== undefined && match.index >= leadingScopeEnd);
  });
  // A later affirmative write is a conflicting request, not read evidence.
  for (const match of contextualMatches) {
    const prefix = instruction.slice(leadingScopeEnd ?? operationOffset, match.index).split(/[;.!?](?:\s+|$)/u).at(-1);
    if (/\b(?:create|update|refresh|revise|write|change|modify|edit)\s+(?:(?:also|only|exactly)\s+)?[`'"]?$/iu.test(prefix) &&
        !/\b(?:not|never|don't)\s+(?:create|update|refresh|revise|write|change|modify|edit)\s+[`'"]?$/iu.test(prefix)) {
      throw new FirstPassSupportError("conflicting-targets", "A later write request conflicts with the initial only restriction.");
    }
  }
  const restrictionMatchSet = new Set(restrictionMatches);
  const dependencyMatches = matches.filter(
    (match) => !restrictionMatchSet.has(match) &&
      ((match.index ?? 0) < operationOffset || (match.index ?? 0) >= writeBoundary || contextualMatches.includes(match)),
  );
  const pathMatches = writeMatches.filter(
    (match) => !restrictionMatchSet.has(match) && !contextualMatches.includes(match),
  );
  const purposeDestinations = negativeWriteScope
    ? negativeWriteDestinationMatches(instruction, matches, operationOffset, allowRst, input.repositoryPaths)
    : [];
  const requestedDestinationMatches = negativeWriteScope
    ? purposeDestinations.filter((match) => !restrictionMatchSet.has(match))
    : pathMatches;
  const destinationMatchSet = new Set(purposeDestinations);
  const destinationPath = (match) => {
    const directory = negativeWriteScope
      ? listDirectoryForMention(instruction, match, matches, operationOffset)
      : undefined;
    return directory === undefined ? match[1] : `${directory}${match[1]}`;
  };
  // CREATE never acquires the UPDATE-only RST operand grammar.
  const unsupportedRst = negativeWriteScope && !allowRst && purposeDestinations.find((match) =>
    destinationPath(match).endsWith(".rst") && !mentionIsPreserved(instruction, match, operationOffset));
  if (unsupportedRst) return unsafeScopeResult(unsupportedRst[1]);
  // A negative probe retains every raw destination, including an unsafe one:
  // the host needs the whole set to give protected refusals precedence. These
  // operands cannot create a positive source or write binding. Read/context
  // mentions stay separate, and positive binding keeps its original grammar.
  const boundPathMatches = negativeWriteScope
    ? [...requestedDestinationMatches, ...restrictionMatches].filter((match) =>
      !mentionIsPreserved(instruction, match, operationOffset) && destinationMatchSet.has(match))
    : pathMatches;
  const boundDependencyMatches = negativeWriteScope
    ? dependencyMatches.filter((match) => !requestedDestinationMatches.includes(match) &&
      !unsafeDocumentationPath(match[1], allowRst))
    : dependencyMatches;
  const boundRestrictionMatches = negativeWriteScope
    ? restrictionMatches.filter((match) => !unsafeDocumentationPath(match[1], allowRst))
    : restrictionMatches;
  const paths = boundPathMatches.map(destinationPath);
  if (paths.length === 0) {
    if (/^\s*(?:assess|review|check)\b/iu.test(instruction)) return undefined;
    if (INTENT_BEARING_PAGE.test(instruction)) return undefined;
    return Object.freeze({
      workflow,
      instruction,
      instructionSha256: sha256(instruction.normalize("NFC")),
      repositoryRevision: requireRevision(input.revision),
      targetPaths: Object.freeze([]),
      dependencyPaths: Object.freeze(
        [...new Set(boundDependencyMatches.map((match) => match[1]))].sort(codePointCompare),
      ),
      ...(negativeWriteScope ? { scopePurpose: "negative-write-scope" } : {}),
    });
  }
  if (negativeWriteScope) {
    // This result is only a negative root probe. Legacy positive binding may
    // reject a path read as evidence and later named as an output; that later
    // write still needs the host's root check before model interpretation.
    return Object.freeze({
      workflow,
      instruction,
      instructionSha256: sha256(instruction.normalize("NFC")),
      repositoryRevision: requireRevision(input.revision),
      targetPaths: Object.freeze([...new Set(paths)].sort(codePointCompare)),
      dependencyPaths: Object.freeze(
        [...new Set(boundDependencyMatches.map((match) => match[1]))].sort(codePointCompare),
      ),
      scopePurpose: "negative-write-scope",
      ...(boundPathMatches.length === 1 ? { originalTarget: boundPathMatches[0][1] } : {}),
    });
  }
  // A page named as a target and again as a read or kept page is a repeated
  // page whose mentions do not all ask for a change. The refusal lists it so
  // the host can name it (owner decision, #1914 note 72956288).
  const readTargetPaths = [
    ...new Set(boundDependencyMatches.map((match) => match[1]).filter((path) => paths.includes(path))),
  ].sort(codePointCompare);
  if (readTargetPaths.length > 0) {
    throw new FirstPassSupportError(
      "conflicting-targets",
      "A documentation path cannot be both a write target and a read dependency.",
      readTargetPaths.map((targetPath) => ({ targetPath, condition: TARGET_AND_READ_CONDITION })),
    );
  }
  // Owner decision on #1914 (note 72956288): a page named more than once binds
  // once when every mention asks for a change to it. When a mention excludes
  // the page, or DocsFab cannot tell, the request is refused and the refusal
  // lists the page so the host can name it.
  const unclearRepeatedPaths = repeatedTargetPaths(paths).filter((path) =>
    boundPathMatches.some(
      (match) => destinationPath(match) === path && !mentionAsksForChange(instruction, match, matches, allowRst),
    ),
  );
  if (unclearRepeatedPaths.length > 0) {
    throw new FirstPassSupportError(
      "duplicate-targets",
      `The documentation request names a page more than once, and not every mention asks to change it; it repeats ${unclearRepeatedPaths.join(", ")}.`,
      unclearRepeatedPaths.map((targetPath) => ({ targetPath, condition: "named more than once" })),
    );
  }
  if (paths.some((path) => !targetGrammar.test(path) || posix.normalize(path) !== path)) {
    throw new FirstPassSupportError(
      "unsafe-target",
      "The documentation request contains an unsafe target path.",
    );
  }
  // Every mention of a repeated page asks for a change by now, so a repeated
  // page binds once.
  const targetPaths = Object.freeze([...new Set(paths)].sort(codePointCompare));
  if (targetPaths.some((path) => !targetGrammar.test(path) || posix.normalize(path) !== path)) {
    throw new FirstPassSupportError("unsafe-target", "The documentation request contains an unsafe target path.");
  }
  const restrictionPaths = boundRestrictionMatches.map((match) => match[1]);
  const repeatedRestrictionPaths = repeatedTargetPaths(restrictionPaths);
  if (repeatedRestrictionPaths.length > 0) {
    throw new FirstPassSupportError(
      "duplicate-targets",
      `The documentation scope restriction must name each target path exactly once; it repeats ${repeatedRestrictionPaths.join(", ")}.`,
      repeatedRestrictionPaths.map((targetPath) => ({ targetPath, condition: "named more than once" })),
    );
  }
  const normalizedRestrictionPaths = [...restrictionPaths].sort(codePointCompare);
  if (
    normalizedRestrictionPaths.length > 0 &&
    (normalizedRestrictionPaths.length !== targetPaths.length ||
      normalizedRestrictionPaths.some((path, index) => path !== targetPaths[index]))
  ) {
    throw new FirstPassSupportError(
      "conflicting-targets",
      "The documentation output list conflicts with the later change-only restriction.",
      [
        ...targetPaths.map((targetPath) => ({ targetPath, condition: "declared output" })),
        ...normalizedRestrictionPaths.map((targetPath) => ({
          targetPath,
          condition: "change-only restriction",
        })),
      ],
    );
  }
  // Every named target is negated, deferred, or asked about. Refuse
  // rather than filter: an empty target list would let first-pass support
  // propose a new destination the user never asked for.
  if (![...boundPathMatches, ...boundRestrictionMatches].some((match) => mentionIsActionable(instruction, match, allowRst))) {
    throw new FirstPassSupportError(
      "non-actionable-targets",
      "The documentation request names its target pages only in a question, a deferral, or a request not to change them. Rephrase it as a request to proceed.",
    );
  }
  return Object.freeze({
    workflow,
    instruction,
    instructionSha256: sha256(instruction.normalize("NFC")),
    repositoryRevision: requireRevision(input.revision),
    targetPaths,
    dependencyPaths: Object.freeze(
      [...new Set(boundDependencyMatches.map((match) => match[1]))].sort(codePointCompare),
    ),
    ...(negativeWriteScope ? { scopePurpose: "negative-write-scope" } : {}),
  });
}

/** Paths a target list names more than once, sorted. */
function repeatedTargetPaths(paths) {
  const seen = new Set();
  const repeated = new Set();
  for (const path of paths) {
    if (seen.has(path)) repeated.add(path);
    seen.add(path);
  }
  return [...repeated].sort(codePointCompare);
}

function explicitScopeRestrictionMatches(
  instruction,
  writeMatches,
  operationOffset,
  writeBoundary,
) {
  const markers = [
    ...instruction
      .slice(operationOffset, writeBoundary)
      .matchAll(
        /\b(?:(?:create|change|modify|edit|write|update|ensure)\s+only|only\s+(?:create|change|modify|edit|write|update)|(?:sole|only)\s+(?:(?:allowed|permitted)\s+)?(?:documentation\s+)?output(?:\s+or\s+modified\s+file|\s+and\s+sole\s+(?:(?:allowed|permitted)\s+)?changed\s+file)?\s+is)\b/giu,
      ),
  ];
  const selected = new Set();
  for (const marker of markers) {
    const markerStart = operationOffset + (marker.index ?? 0);
    const markerEnd = markerStart + marker[0].length;
    if (!writeMatches.some((match) => (match.index ?? 0) < markerStart)) continue;
    const remaining = instruction.slice(markerEnd, writeBoundary);
    const clauseEndOffset = /(?:;|\n|\.(?:\s|$))/u.exec(remaining)?.index;
    const clauseEnd = clauseEndOffset === undefined ? writeBoundary : markerEnd + clauseEndOffset;
    for (const match of writeMatches) {
      const index = match.index ?? 0;
      if (index >= markerEnd && index < clauseEnd) selected.add(match);
    }
  }
  return writeMatches.filter((match) => selected.has(match));
}

// Closed classification grammar. A target mention is read from its own
// clause. Clauses end at a sentence or semicolon end, as elsewhere in this
// parser, and at a line feed (CRLF included): the live-agent host joins a
// user's consecutive chat messages with a blank line, and an unpunctuated
// earlier message must not become the head of the next one's clause.
// Only these phrase classes make a mention non-actionable; anything else,
// including a polite "can/could/would/will you" request, stays actionable.
const CLAUSE_BOUNDARY = /[;.!?](?:\s|$)|\n/gu;
const WRITE_VERB =
  /\b(?:create|creating|update|updating|refresh|refreshing|revise|revising|write|writing|change|changing|modify|modifying|edit|editing|touch|touching)\b/giu;
// Negation must govern the write verb directly: "Don't forget to update" and
// "Why don't you update" are requests to act, not requests to refrain.
const NEGATED_VERB =
  /\b(?:(?:don't|do not)(?:\s+(?:need|have)\s+to)?|never|no need to)\s+(?:(?:ever|even|really|actually|yet)\s+)?(?:[a-z]+\s+(?:or|nor)\s+)?$/iu;
const INTERROGATIVE_CLAUSE =
  /^\s*(?:(?:and|but|so|also|then|or)\s+)?(?:(?:should|shall)\s+(?:I|we)|(?:do|does)\s+(?:I|we|it|this|that)\s+(?:really\s+)?need\s+to|is\s+it\s+worth|why\s+did)\b/iu;
const WHETHER_VERB = /\bwhether\s+(?:or\s+not\s+)?to\s+$/iu;
// A deferral governs the write only when nothing but the deferral sits beside
// the write: "Later, update docs/a.md", "Update docs/a.md and docs/b.md later",
// "Update docs/a.md, but not yet". Deferral words in content the user wants
// written ("say Windows support comes later", "the API is not yet stable",
// "users can opt in later") leave the request actionable.
//
// These patterns run on raw user text, so each one must be linear-time by
// construction: no two quantifiers may split the same characters between
// them. A whitespace run belongs to exactly one `\s` quantifier, and an
// optional comma owns the whitespace after it: `\s*(?:,\s*)?`, never
// `\s*,?\s*`, whose two `\s*` can divide one run in many ways and, inside a
// repeated group, multiply those divisions per repetition. Each further
// target needs a separator, and each repetition consumes a path or a deferral
// word, so a tail that fails at its end backtracks in time linear in its
// length.
const DEFERRAL = String.raw`(?:later|not\s+now|not\s+yet)`;
const OPTIONAL_COMMA = String.raw`\s*(?:,\s*)?`;
const DEFERRAL_LINK = String.raw`${OPTIONAL_COMMA}(?:(?:but|and)\s+)?`;
const TARGET_SEPARATOR = String.raw`(?:\s*,\s*(?:(?:and|or)\s+)?|\s*&\s*|\s+(?:(?:and|or)\s+)?)`;
const TARGET_PATH = String.raw`[\x60'"]?(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+\.mdx?[\x60'"]?`;
const UPDATE_TARGET_PATH = String.raw`[\x60'"]?(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+\.(?:mdx?|rst)[\x60'"]?`;
const DEFERRED_VERB = new RegExp(
  String.raw`^\s*(?:(?:and|but|so|then)\s+)?${DEFERRAL}${OPTIONAL_COMMA}(?:please\s+)?$`,
  "iu",
);
function deferredTail(targetPath) {
  return new RegExp(
    String.raw`^[\x60'"]?(?:${TARGET_SEPARATOR}${targetPath})*` +
    String.raw`(?:${DEFERRAL_LINK}${DEFERRAL})+(?:${OPTIONAL_COMMA}please)?\s*$`,
    "iu",
  );
}
const DEFERRED_TAIL = deferredTail(TARGET_PATH);
const UPDATE_DEFERRED_TAIL = deferredTail(UPDATE_TARGET_PATH);

/**
 * Whether one target mention asks for the write. Non-actionable means its own
 * clause negates the governing write verb, asks whether to write, or defers
 * the write. Apostrophe variants fold to ASCII here only; the returned request
 * keeps the caller's exact bytes. Each fold is one UTF-16 unit, so offsets hold.
 */
function mentionIsActionable(instruction, match, allowRst = false) {
  const text = instruction.replace(/[\u2018\u2019\u02BC]/gu, "'");
  const start = match.index ?? 0;
  const end = start + match[0].length;
  const clauseStart = [...text.slice(0, start).matchAll(CLAUSE_BOUNDARY)]
    .map((boundary) => boundary.index + boundary[0].length)
    .at(-1) ?? 0;
  const clauseEndOffset = new RegExp(CLAUSE_BOUNDARY.source, "u").exec(text.slice(end))?.index;
  const head = text.slice(clauseStart, start);
  const verb = [...head.matchAll(WRITE_VERB)].at(-1);
  if (INTERROGATIVE_CLAUSE.test(head)) return false;
  if (verb !== undefined) {
    const beforeVerb = head.slice(0, verb.index);
    if (NEGATED_VERB.test(beforeVerb) || WHETHER_VERB.test(beforeVerb) || DEFERRED_VERB.test(beforeVerb)) {
      return false;
    }
  }
  const clauseTail = text.slice(end, clauseEndOffset === undefined ? text.length : end + clauseEndOffset);
  return !(allowRst ? UPDATE_DEFERRED_TAIL : DEFERRED_TAIL).test(clauseTail);
}

/**
 * Whether one mention's sentence clause keeps the page as it is: "keep/leave
 * ... unchanged" or "do not / never / don't edit|change|modify|update". Both
 * request arms read it, so a kept page is never a write target on either; it
 * only removes targets. The clause starts no earlier than `from`.
 */
function mentionIsPreserved(instruction, match, from = 0) {
  const prefix = instruction.slice(from, match.index).split(/[;.!?](?:\s+|$)/u).at(-1);
  const clause = prefix + instruction.slice(match.index).split(/[;.!?](?:\s+|$)/u)[0];
  return /^\s*(?:(?:keep|leave)\s+.+\bunchanged\b|(?:do not|never|don't)\s+(?:edit|change|modify|update)\b)/iu.test(clause);
}

// Path-token grammar of request-intent named grounding, ported from the
// runtime's request-intent/quote.ts (`pathTokenText`, `spanNamesPath`) because
// neither package may import the other. A runtime parity table drives both, so
// every form admission grounds as naming a page is a mention here too. It
// reads characters only and decides nothing about what the request asks for.
const UNSPACED_SCRIPT = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}]/u;
const WIDE_OPENERS = [
  "（", "［", "｛", "＜", "＂", "＇",
  "〈", "《", "「", "『", "【", "〔",
];
const WIDE_CLOSERS = [
  "）", "］", "｝", "＞", "＂", "＇",
  "〉", "》", "」", "』", "】", "〕",
];
const TOKEN_OPENERS = new Set(["(", "[", "{", "<", '"', "'", "`", "“", "‘", ...WIDE_OPENERS]);
const TOKEN_CLOSERS = new Set([")", "]", "}", ">", '"', "'", "`", "”", "’", ...WIDE_CLOSERS]);
const SENTENCE_PUNCTUATION = new Set([".", ",", ":", ";", "!", "?"]);
const WIDE_PUNCTUATION = new Set([
  "、", "。", "！", "，", "．", "：", "；", "？",
]);
const FRAGMENT_MARK = "#";
const CURRENT_DIRECTORY = "./";
const PATH_SEPARATOR = "/";
const EXTENSION_MARK = ".";

function characterAt(text, index) {
  const code = text.codePointAt(index);
  return code === undefined ? undefined : String.fromCodePoint(code);
}

function characterBefore(text, index) {
  const before = /(?<=(.))/suy;
  before.lastIndex = index;
  return before.exec(text)?.[1];
}

function isSpace(character) {
  return character !== undefined && /\s/u.test(character);
}

function scriptEdge(inside, outside) {
  return (
    inside !== undefined &&
    outside !== undefined &&
    UNSPACED_SCRIPT.test(outside) &&
    !UNSPACED_SCRIPT.test(inside)
  );
}

function endsSentence(text, index) {
  const character = characterAt(text, index);
  if (character === undefined || !SENTENCE_PUNCTUATION.has(character)) return false;
  const next = characterAt(text, index + character.length);
  return next === undefined || isSpace(next) || TOKEN_CLOSERS.has(next);
}

function boundsStretch(character) {
  return (
    isSpace(character) ||
    TOKEN_OPENERS.has(character) ||
    TOKEN_CLOSERS.has(character) ||
    character === FRAGMENT_MARK ||
    WIDE_PUNCTUATION.has(character)
  );
}

function hasExtension(path) {
  const name = path.slice(path.lastIndexOf(PATH_SEPARATOR) + 1);
  return name.indexOf(EXTENSION_MARK, 1) > 0;
}

function marksPath(character) {
  return character === PATH_SEPARATOR || character === EXTENSION_MARK;
}

/** The NFC instruction with its run-on tables, as the runtime's `pathTokenText`. */
function pathTokenText(text) {
  const runsOnAfter = new Uint8Array(text.length + 1);
  for (let at = text.length - 1; at >= 0; at -= 1) {
    const character = characterAt(text, at);
    runsOnAfter[at] =
      boundsStretch(character) || endsSentence(text, at)
        ? 0
        : marksPath(character)
          ? 1
          : runsOnAfter[at + character.length];
  }
  const runsOnBefore = new Uint8Array(text.length + 1);
  for (let at = 1; at <= text.length; at += 1) {
    const character = characterBefore(text, at);
    runsOnBefore[at] = boundsStretch(character)
      ? 0
      : marksPath(character)
        ? 1
        : runsOnBefore[at - character.length];
  }
  return { text, runsOnAfter, runsOnBefore };
}

function opensToken({ text, runsOnBefore }, index) {
  const before = characterBefore(text, index);
  return (
    before === undefined ||
    isSpace(before) ||
    TOKEN_OPENERS.has(before) ||
    (scriptEdge(characterAt(text, index), before) && runsOnBefore[index] === 0)
  );
}

function pathTokenStarts(tokens, index) {
  if (opensToken(tokens, index)) return true;
  const prefix = index - CURRENT_DIRECTORY.length;
  return (
    prefix >= 0 && tokens.text.startsWith(CURRENT_DIRECTORY, prefix) && opensToken(tokens, prefix)
  );
}

function pathTokenEnds({ text, runsOnAfter }, index, extended) {
  const after = characterAt(text, index);
  return (
    after === undefined ||
    isSpace(after) ||
    TOKEN_CLOSERS.has(after) ||
    after === FRAGMENT_MARK ||
    WIDE_PUNCTUATION.has(after) ||
    (extended && scriptEdge(characterBefore(text, index), after) && runsOnAfter[index] === 0) ||
    endsSentence(text, index)
  );
}

/**
 * The narrowing case fold of request-intent admission (`pathCaseKey`): lower,
 * upper, lower again per segment, so every spelling a case-folding checkout
 * opens as one file compares equal. Folding more only refuses more.
 */
function pathCaseKey(path) {
  return path
    .split(PATH_SEPARATOR)
    .map((segment) => segment.toLowerCase().toUpperCase().toLowerCase().normalize("NFC"))
    .join(PATH_SEPARATOR);
}

/** Start offsets of every whole-token occurrence of `path`, letter case folded, as admission grounds one. */
function groundedOccurrences(tokens, path) {
  const key = pathCaseKey(path);
  const extended = hasExtension(path);
  const starts = [];
  for (let at = 0; at + path.length <= tokens.text.length; at += 1) {
    if (!pathTokenStarts(tokens, at)) continue;
    if (pathCaseKey(tokens.text.slice(at, at + path.length)) !== key) continue;
    if (pathTokenEnds(tokens, at + path.length, extended)) starts.push(at);
  }
  return starts;
}

/** ASCII spelling of each full-width or ideographic sentence mark, so the parser's clause rules read it. */
const WIDE_PUNCTUATION_ASCII = new Map([
  ["、", ","], ["。", "."], ["！", "!"], ["，", ","],
  ["．", "."], ["：", ":"], ["；", ";"], ["？", "?"],
]);
const LINK_LABEL_OPEN = "[";
const LINK_LABEL_CLOSE = "]";
const LINK_DESTINATION_OPEN = "(";
const LINK_DESTINATION_CLOSE = ")";
const ANGLE_OPEN = "<";
const ANGLE_CLOSE = ">";
const LINE_FEED = "\n";
const SPACE = " ";
const TAB = "\t";
const LINK_TITLE_CLOSERS = new Map([['"', '"'], ["'", "'"], ["(", ")"]]);

/** The offset after the spaces and tabs at `at`. */
function skipBlanks(text, at) {
  let next = at;
  while (text[next] === SPACE || text[next] === TAB) next += 1;
  return next;
}

/** Whether `character` may sit beside a path without becoming part of its name. */
function delimits(character) {
  return (
    character === undefined ||
    boundsStretch(character) ||
    SENTENCE_PUNCTUATION.has(character)
  );
}

/**
 * The Markdown link `[label](destination "title")` whose destination is the
 * token at `start`..`end`, or `undefined`. A label holding another named page
 * keeps that page's own mention, so the link is not taken whole.
 */
function markdownLinkExtent(text, start, end, labelHoldsPage) {
  const angled = text[start - 1] === ANGLE_OPEN && text[end] === ANGLE_CLOSE;
  const open = angled ? start - 1 : start;
  let close = angled ? end + 1 : end;
  if (text[open - 1] !== LINK_DESTINATION_OPEN || text[open - 2] !== LINK_LABEL_CLOSE) return undefined;
  let label = open - 3;
  while (label >= 0 && ![LINK_LABEL_OPEN, LINK_LABEL_CLOSE, LINE_FEED].includes(text[label])) label -= 1;
  if (text[label] !== LINK_LABEL_OPEN || labelHoldsPage(label, open - 2)) return undefined;
  if (text[close] !== LINK_DESTINATION_CLOSE) {
    // A title needs a blank before it, and stays on its line.
    let at = skipBlanks(text, close);
    const titleClose = LINK_TITLE_CLOSERS.get(text[at]);
    if (at === close || titleClose === undefined) return undefined;
    at += 1;
    while (at < text.length && text[at] !== titleClose && text[at] !== LINE_FEED) at += 1;
    if (text[at] !== titleClose) return undefined;
    at = skipBlanks(text, at + 1);
    if (text[at] !== LINK_DESTINATION_CLOSE) return undefined;
    close = at;
  }
  return { start: label, end: close + 1 };
}

/**
 * The source span one grounded mention covers: a `./` prefix, a `#fragment`,
 * a Markdown link around it, and the brackets and quotes against it, but not
 * a bracket or quote that joins a word outside, as in "docs/a.md's". It never
 * starts before `floor`, the end of the previous mention, whose normalized
 * text ends in `previous`.
 */
function mentionExtent(tokens, core, floor, previous, labelHoldsPage) {
  const { text } = tokens;
  let start = core.start;
  if (start - CURRENT_DIRECTORY.length >= floor && text.startsWith(CURRENT_DIRECTORY, start - CURRENT_DIRECTORY.length)) {
    start -= CURRENT_DIRECTORY.length;
  }
  let end = core.end;
  if (characterAt(text, end) === FRAGMENT_MARK) {
    end += FRAGMENT_MARK.length;
    for (let next = characterAt(text, end); next !== undefined && !isSpace(next) &&
      !TOKEN_CLOSERS.has(next) && !WIDE_PUNCTUATION.has(next) && !endsSentence(text, end); next = characterAt(text, end)) {
      end += next.length;
    }
  }
  const link = markdownLinkExtent(text, start, end, labelHoldsPage);
  if (link !== undefined && link.start >= floor) ({ start, end } = link);
  let left = start;
  for (let before = characterBefore(text, left); left > floor && TOKEN_OPENERS.has(before); before = characterBefore(text, left)) {
    left -= before.length;
  }
  if (delimits(left === floor ? previous : characterBefore(text, left))) start = left;
  let right = end;
  for (let after = characterAt(text, right); TOKEN_CLOSERS.has(after); after = characterAt(text, right)) {
    right += after.length;
  }
  if (delimits(characterAt(text, right))) end = right;
  return { start, end };
}

/**
 * The NFC request with every mention admission grounds as naming one of
 * `targetPaths` replaced by that bare path, and each mention's offsets in
 * both texts. A full-width or ideographic sentence mark right after a mention
 * becomes its ASCII spelling and a space. Text between mentions is unchanged,
 * so an offset there moves by the length the mentions before it changed.
 */
export function normalizeNamedPathMentions(instruction, targetPaths) {
  const source = requireText(instruction, "instruction").normalize("NFC");
  const tokens = pathTokenText(source);
  const keys = new Set();
  const cores = [];
  for (const path of targetPaths) {
    const key = pathCaseKey(path);
    if (keys.has(key)) continue;
    keys.add(key);
    for (const start of groundedOccurrences(tokens, path)) cores.push({ path, start, end: start + path.length });
  }
  cores.sort((left, right) => left.start - right.start);
  const labelHoldsPage = (from, to) => cores.some((core) => core.start > from && core.start < to);
  let text = "";
  let cursor = 0;
  const mentions = [];
  for (const core of cores) {
    if (core.start < cursor) continue;
    const extent = mentionExtent(tokens, core, cursor, characterBefore(text, text.length), labelHoldsPage);
    text += source.slice(cursor, extent.start);
    const index = text.length;
    text += core.path;
    let end = extent.end;
    const mark = WIDE_PUNCTUATION_ASCII.get(characterAt(source, end));
    if (mark !== undefined) {
      end += 1;
      const next = characterAt(source, end);
      text += next === undefined || isSpace(next) ? mark : mark + SPACE;
    }
    mentions.push(Object.freeze({
      path: core.path,
      index,
      normalized: Object.freeze({ start: index, end: text.length }),
      source: Object.freeze({ start: extent.start, end }),
    }));
    cursor = end;
  }
  text += source.slice(cursor);
  return Object.freeze({ text, mentions: Object.freeze(mentions) });
}

/**
 * The given write targets the request names only where the no-intent parser
 * would not write them: a mention it reads as negated, deferred, or asked
 * about, or a page its clause keeps unchanged. This is the guard for pages
 * that came from somewhere other than the words (an admitted intent), and it
 * only narrows; a page the request never names passes, and so does a page
 * with one actionable mention.
 *
 * It keeps no clause rules of its own. It normalizes every mention admission
 * grounds, in any path form, to the bare path, then asks the parser's own
 * `mentionIsActionable` and `mentionIsPreserved` about each mention the
 * parser reads in that text, with the parser's write-clause start. A mention
 * before the first write operation is read from its own sentence, since the
 * parser never makes such a page a target. Paths compare case-folded. Sorted.
 */
export function nonActionableNamedTargets(instruction, targetPaths, workflow = "create-documentation") {
  const { text, mentions } = normalizeNamedPathMentions(instruction, targetPaths);
  const grounded = new Set(mentions.map((mention) => mention.index));
  const named = [
    ...mentions.map((mention) => Object.assign([mention.path, mention.path], { index: mention.index })),
    ...documentationPathMatches(text).filter((match) => !grounded.has(match.index)),
  ];
  const operationOffset = ordinaryOperationOffset(text) ?? 0;
  const narrows = (match) =>
    !mentionIsActionable(text, match, workflow === "update-documentation") ||
    mentionIsPreserved(text, match, match.index > operationOffset ? operationOffset : 0);
  return [...new Set(targetPaths)]
    .filter((path) => {
      const key = pathCaseKey(path);
      const own = named.filter((match) => pathCaseKey(match[1]) === key);
      return own.length > 0 && own.every(narrows);
    })
    .sort(codePointCompare);
}

/** The `condition` a target-and-read conflict lists its page under. */
const TARGET_AND_READ_CONDITION = "named as a target and as a read or kept page";

// Owner decision on #1914 (note 72956288), tightened after the !1577 review: a
// page named more than once binds once only when every mention's clause is
// unambiguously a request to change it. These checks read one mention's
// clause after normalizing it:
// - every named documentation path becomes a mark, by position, so a word
//   written against a path stays a word; other slash-joined text, such as
//   "keep/leave" or src/a.mjs, stays text, so its words are read too;
// - Markdown emphasis, code, and quotation marks become spaces, so "_not_" or
//   "except`docs/a.md`" reads as "not" or "except";
// - apostrophe variants fold to ASCII, and whitespace runs to one space.
// Each pattern can only refuse a request, so the bound set is always the set
// of pages the request names. A page named once binds as it did before
// (#1935). Like the patterns above, each is linear-time by construction: no
// two quantifiers can split the same characters.

/** Private-use marks for paths in a normalized clause: the mention being read, and any other path. */
const MENTION_MARK = "\uE001";
const PATH_MARK = "\uE000";

/**
 * `words` as one regex alternation. Entries are lowercase words, phrases with
 * single spaces, or abbreviations such as "w/o"; none holds a regex
 * metacharacter.
 */
function alternation(words) {
  return words.join("|");
}

/**
 * Words that keep a mention of a repeated page from reading as a request to
 * change it, matched as whole words in any letter case: negation, exclusion,
 * preservation, restriction, removal or replacement, avoidance, condition, and
 * deferral. Any "n't" contraction counts too, and so do the slash
 * abbreviations "w/o", "w/out", "n/a", and "n/c". A clause holding one is
 * refused, never guessed. The tests pin every entry.
 */
export const UNCLEAR_CHANGE_WORDS = Object.freeze([
  // Negation.
  "aint", "arent", "cannot", "cant", "couldnt", "didnt", "doesnt", "dont", "hadnt", "hasnt",
  "havent", "isnt", "mustnt", "neednt", "neither", "never", "no", "nobody", "none", "nor", "not",
  "nothing", "nowhere", "shant", "shouldnt", "wasnt", "werent", "wont", "wouldnt", "zero",
  "n/a", "n/c",
  // Exclusion.
  "apart from", "aside from", "bar", "barring", "besides", "but", "except", "excepting",
  "exception", "exceptions", "exclude", "excluded", "excludes", "excluding", "exclusion",
  "exempt", "exempted", "exemption",
  "in lieu of", "in place of", "instead", "minus", "other than", "rather", "sans", "save",
  "spare", "spared", "sparing", "without", "w/o", "w/out",
  // Preservation.
  "alone", "as is", "as it is", "as-is", "freeze", "frozen", "intact", "keep", "keeping", "keeps", "kept",
  "leave", "leaves", "leaving", "preserve", "preserved", "preserves", "preserving", "remain",
  "readonly", "remains", "retain", "retained", "retaining", "retains", "status quo", "stay",
  "stays", "unaltered", "unchanged", "unedited", "unmodified", "untouched", "verbatim",
  // Restriction.
  "exactly", "just", "merely", "only", "sole", "solely",
  // Removal or replacement.
  "archive", "delete", "deleted", "deletes", "deleting", "deprecate", "drop", "dropped",
  "dropping", "drops", "move", "moved", "moves", "moving", "remove", "removed", "removes",
  "removing", "rename", "renamed", "renames", "renaming", "replace", "replaced", "replaces",
  "replacing", "revert", "reverted", "reverting", "reverts", "rollback", "undo",
  // Avoidance.
  "avoid", "avoiding", "avoids", "disregard", "forbid", "forbidden", "forget", "hands", "ignore",
  "ignored", "ignores", "ignoring", "off", "omit", "omits", "omitted", "omitting", "out of scope",
  "outside", "prohibit", "prohibited", "refrain", "skip", "skipped", "skipping", "skips",
  // Condition.
  "if", "maybe", "might", "optional", "optionally", "perhaps", "possibly", "unless", "whether",
  // Deferral.
  "cancel", "defer", "deferred", "eventually", "hold", "later", "pause", "postpone", "someday",
  "stop", "tomorrow", "wait", "yet",
]);
const UNCLEAR_CHANGE_WORD = new RegExp(
  String.raw`(?<![A-Za-z])(?:${alternation(UNCLEAR_CHANGE_WORDS)})(?![A-Za-z])|[A-Za-z]n't(?![A-Za-z])`,
  "iu",
);

const CHANGE_VERB = String.raw`(?:add|change|clarify|correct|create|describe|document|edit|expand|explain|extend|fix|improve|insert|modify|refresh|revise|rewrite|update|write)(?![A-Za-z])`;
const CLAUSE_CONNECTIVE = String.raw`(?:(?:also|and|please|so|then)(?: ?, ?| ))`;
const PAGE_LIST_SEPARATOR = String.raw`(?: ?, ?(?:and )?| ?& ?| and )`;
const AFTER_PAGE = String.raw`(?:(?: ?[,:-] ?| )(?:(?:about|adding|and|as|at|by|changing|clarifying|correcting|covering|describing|documenting|editing|expanding|explaining|extending|fixing|for|improving|in|including|inserting|mentioning|modifying|noting|on|refreshing|revising|rewriting|so|then|to|updating|with|writing)(?![A-Za-z])|${CHANGE_VERB}).*)?`;

/**
 * A normalized clause that is unambiguously a request to change the marked
 * mention, in one of three shapes:
 * - "In docs/a.md, also fix the link": the mention leads the clause;
 * - "Update docs/a.md and docs/b.md to ...": the mention is in the change
 *   verb's object list;
 * - "Fix the install command in docs/a.md": the mention follows the verb's
 *   object.
 * A list marker and connectives such as "also" may open the clause.
 */
const CHANGE_REQUEST_CLAUSE = new RegExp(
  String.raw`^(?:[-+] |\d+\) )?${CLAUSE_CONNECTIVE}*(?:` +
    String.raw`(?:for|in|inside|on|within) \uE001(?: ?[,:] ?| )${CLAUSE_CONNECTIVE}*${CHANGE_VERB}(?: .*)?` +
    String.raw`|${CHANGE_VERB} (?:(?:both|the|these) )?(?:(?:document|file|page)s? )?(?:\uE000${PAGE_LIST_SEPARATOR})*\uE001(?:${PAGE_LIST_SEPARATOR}\uE000)*${AFTER_PAGE}` +
    String.raw`|${CHANGE_VERB} [^\uE000\uE001]*?(?<![A-Za-z])(?:in|inside|into|on|to|within) \uE001${AFTER_PAGE}` +
    String.raw`)$`,
  "iu",
);

/**
 * One mention's clause, normalized as described above. Every documentation
 * path in the clause becomes a mark by its position: the mention itself
 * MENTION_MARK, any other PATH_MARK.
 */
function mentionClause(instruction, match, documentationMatches) {
  const start = match.index ?? 0;
  const end = start + match[0].length;
  const clauseStart = [...instruction.slice(0, start).matchAll(CLAUSE_BOUNDARY)]
    .map((boundary) => boundary.index + boundary[0].length)
    .at(-1) ?? 0;
  const boundary = new RegExp(CLAUSE_BOUNDARY.source, "u").exec(instruction.slice(end));
  const clauseEnd = boundary ? end + boundary.index : instruction.length;
  const paths = documentationMatches.filter(
    (path) => (path.index ?? 0) >= clauseStart && (path.index ?? 0) + path[0].length <= clauseEnd,
  );
  return markClausePaths(instruction.slice(clauseStart, clauseEnd), clauseStart, paths, match)
    .replace(/[\u2018\u2019\u02BC]/gu, "'")
    .replace(/[_*~`"\u201C\u201D]|'(?=[\uE000\uE001])|(?<=[\uE000\uE001])'/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

/** `text`, which starts at `offset` in the request, with each of `paths` replaced by its mark. */
function markClausePaths(text, offset, paths, match) {
  if (paths.length === 0) return text;
  const [path, ...rest] = paths;
  const start = (path.index ?? 0) - offset;
  const end = start + path[0].length;
  return (
    text.slice(0, start) +
    (path === match ? MENTION_MARK : PATH_MARK) +
    markClausePaths(text.slice(end), offset + end, rest, match)
  );
}

/** Whether a question mark ends the mention's clause. */
function mentionClauseIsQuestion(instruction, match) {
  const end = (match.index ?? 0) + match[0].length;
  const boundary = new RegExp(CLAUSE_BOUNDARY.source, "u").exec(instruction.slice(end));
  return boundary?.[0].trim() === "?";
}

/**
 * Whether one mention of a repeated page asks for a change to it: the mention
 * is actionable, its clause is neither a question nor written in a script or
 * with symbols DocsFab does not read, it holds no unclear word, and it has a
 * change-request shape.
 */
function mentionAsksForChange(instruction, match, documentationMatches, allowRst = false) {
  if (!mentionIsActionable(instruction, match, allowRst) || mentionClauseIsQuestion(instruction, match)) {
    return false;
  }
  const clause = mentionClause(instruction, match, documentationMatches);
  if (clause.includes("?") || /[^\x00-\x7F\uE000\uE001]/u.test(clause)) return false;
  return !UNCLEAR_CHANGE_WORD.test(clause) && CHANGE_REQUEST_CLAUSE.test(clause);
}

const PURPOSE_WRITE_CLAUSE = /^\s*(?:(?:please|also|then|and|now)\s+|(?:(?:can|could|would|will)\s+you\s+))*(create|update|refresh|revise|write|change|modify|edit)\b/iu;
const PURPOSE_QUOTED_COMMAND = /^\s*[`'"\u2018\u201C]\s*(?:create|update|refresh|revise|write|change|modify|edit)\b/iu;
const PURPOSE_NEXT_WRITE = /^\s*(?:(?:,|&|and|or)\s*)?(?:also\s+|then\s+)?(create|update|refresh|revise|write|change|modify|edit)\b/iu;
const PURPOSE_SOURCE_CUE = /\b(?:using|use|read|based on|with evidence from|consult|consulting|according to|source dependency)\b/iu;
const PURPOSE_SOURCE_OBJECT = /\b(?:summary|documentation|guide|page|article|note|overview|report)\s+(?:of|about|describing|summarizing)(?:\s+the)?\s*$/iu;

/** Remove Markdown filename adornments only after path spans have been separated. */
function purposeSyntax(text) {
  return text.replace(/[\u2018\u2019\u02BC]/gu, "'")
    .replace(/[_*~`"\u201C\u201D]|'(?=\s|$)/gu, " ")
    .replace(/\bunder\s+[^\s:]+\/\s*:/giu, "under DIRECTORY:")
    .replace(/\s+/gu, " ")
    .trim();
}

/** The latest source or connected write cue between named paths. */
function purposeSegmentState(segment, write) {
  const transitions = write
    ? [{ index: write.index, role: "write", verb: write[1].toLowerCase() }]
    : [];
  const afterWrite = write ? write.index + write[0].length : 0;
  if (!write) {
    const leading = PURPOSE_NEXT_WRITE.exec(segment);
    if (leading) transitions.push({
      index: leading[0].length - leading[1].length,
      role: "write",
      verb: leading[1].toLowerCase(),
    });
  }
  for (const cue of segment.matchAll(new RegExp(PURPOSE_SOURCE_CUE.source, "giu"))) {
    if (cue.index >= afterWrite) transitions.push({ index: cue.index, role: "source", verb: undefined });
  }
  // Connected writes can resume after either an initial or later source cue.
  for (const connector of segment.matchAll(/\b(?:and|or|then|also)\b|[,;&]/giu)) {
    if (connector.index < afterWrite) continue;
    const next = PURPOSE_NEXT_WRITE.exec(segment.slice(connector.index));
    if (next) transitions.push({
      index: connector.index + next[0].length - next[1].length,
      role: "write",
      verb: next[1].toLowerCase(),
    });
  }
  return transitions.sort((left, right) => left.index - right.index).at(-1);
}

/** Only affirmative write syntax outside path and qualifier spans can name a destination. */
function negativeWriteDestinationMatches(instruction, documentationMatches, operationOffset, allowRst = false, repositoryPaths = []) {
  const destinations = [];
  // A host-provided revision inventory can establish one root file without
  // guessing a basename's location. This is negative-probe evidence only;
  // it never grants a positive target or changes ordinary update binding.
  const paths = new Set(repositoryPaths);
  const basenameCounts = new Map();
  for (const path of paths) {
    const name = posix.basename(path).toLowerCase();
    basenameCounts.set(name, (basenameCounts.get(name) ?? 0) + 1);
  }
  let prior;
  let role = "unknown";
  let sourceObject = false;
  let writeVerb;
  for (const match of documentationMatches) {
    const clauseStart = [...instruction.slice(0, match.index).matchAll(CLAUSE_BOUNDARY)]
      .map((boundary) => boundary.index + boundary[0].length)
      .at(-1) ?? 0;
    if (prior && prior.index < clauseStart) {
      prior = undefined;
      role = "unknown";
      sourceObject = false;
      writeVerb = undefined;
    }
    const segmentStart = prior ? prior.index + prior[0].length : clauseStart;
    const rawSegment = instruction.slice(segmentStart, match.index);
    const segment = purposeSyntax(rawSegment);
    const lastQuote = [...rawSegment.matchAll(/[`'"\u2018\u201C\u201D]/gu)].at(-1);
    const quotedHistoricalCommand = lastQuote &&
      PURPOSE_QUOTED_COMMAND.test(rawSegment.slice(lastQuote.index));
    const active = mentionIsActionable(instruction, match, allowRst) &&
      !mentionIsPreserved(instruction, match, operationOffset);
    if (!active) {
      role = "unknown";
      sourceObject = false;
      writeVerb = undefined;
      prior = match;
      continue;
    }
    const transition = prior && !quotedHistoricalCommand ? purposeSegmentState(segment) : null;
    if (prior === undefined) {
      const operationInSegment = operationOffset >= clauseStart && operationOffset < match.index &&
        /^\s*(?:based on|use|using|read|consult)\b/iu.test(instruction.slice(clauseStart, operationOffset));
      const writeSegment = operationInSegment
        ? purposeSyntax(instruction.slice(operationOffset, match.index))
        : segment;
      const write = PURPOSE_WRITE_CLAUSE.exec(writeSegment);
      if (!PURPOSE_QUOTED_COMMAND.test(rawSegment) && !quotedHistoricalCommand && write) {
        const state = purposeSegmentState(writeSegment, write);
        sourceObject = state.role === "write" && PURPOSE_SOURCE_OBJECT.test(writeSegment);
        role = sourceObject ? "source" : state.role;
        writeVerb = sourceObject ? write[1].toLowerCase() : state.verb;
      } else {
        role = "unknown";
        sourceObject = false;
        writeVerb = undefined;
      }
    } else if (transition) {
      sourceObject = transition.role === "write" && PURPOSE_SOURCE_OBJECT.test(segment);
      role = sourceObject ? "source" : transition.role;
      writeVerb = transition.verb;
    } else if (role === "source" && sourceObject &&
      /^(?:(?:file|page|document)\s+)?(?:in|to|at)\s*$/iu.test(segment)) {
      role = "write";
      sourceObject = false;
    } else if (!/^(?:,|&|and|or)?\s*$/iu.test(segment)) {
      role = "unknown";
      sourceObject = false;
      writeVerb = undefined;
    }
    // A bare update basename may resolve to one of several tracked files.
    // Without an unambiguous host inventory, keep the ordinary model route.
    const directory = listDirectoryForMention(instruction, match, documentationMatches, operationOffset);
    const uniqueRootFile = paths.has(match[1]) && basenameCounts.get(match[1].toLowerCase()) === 1;
    if (role === "write" && (writeVerb === "create" ||
      match[1].includes("/") || directory !== undefined || uniqueRootFile)) destinations.push(match);
    prior = match;
  }
  return destinations;
}

/** The nearest explicit list qualifier governs only its own bare filenames. */
function listDirectoryForMention(instruction, match, documentationMatches, operationOffset) {
  if (match[1].includes("/")) return undefined;
  const qualifiers = [...instruction.slice(operationOffset, match.index).matchAll(/\bunder\s+([^\s:]+\/)\s*:\s*/giu)];
  for (const qualifier of qualifiers.reverse()) {
    const end = operationOffset + qualifier.index + qualifier[0].length;
    const paths = documentationMatches.filter((path) => path.index >= end &&
      path.index + path[0].length <= match.index);
    const intervening = markClausePaths(instruction.slice(end, match.index), end, paths);
    if (new RegExp(CLAUSE_BOUNDARY.source, "u").test(intervening) ||
      /\b(?:create|update|refresh|revise|write|change|modify|edit)\b/iu.test(intervening)) continue;
    return qualifier[1];
  }
  return undefined;
}

function unsafeDocumentationPath(path, allowRst = false) {
  return !(allowRst ? UPDATE_TARGET : SAFE_TARGET).test(path) || posix.normalize(path) !== path ||
    path.includes("\\") || path.split("/").some((segment) => segment === "." || segment === "..");
}

function documentationPathMatches(instruction, includeUnsafe = false, allowRst = false) {
  const unsafe = includeUnsafe
    ? [...instruction.matchAll(SUSPICIOUS_TARGET)].flatMap((match) => {
      const token = match[1]?.replace(/[.!?:]+$/u, "") ?? "";
      if (!/\.(?:mdx?|rst)$/iu.test(token) || !unsafeDocumentationPath(token, allowRst)) return [];
      const index = (match.index ?? 0) + match[0].indexOf(match[1]);
      return [Object.assign([token, token], { index })];
    })
    : [];
  const safe = [...instruction.matchAll(allowRst ? UPDATE_TARGET_TOKEN : TARGET_TOKEN)].filter((match) => {
    const end = (match.index ?? 0) + match[0].length;
    const suffix = instruction.slice(end);
    return (suffix === "" || /^[\s,;:!?`'"\])]/u.test(suffix) || /^\.(?:\s|$)/u.test(suffix)) &&
      !unsafe.some((candidate) => (match.index ?? 0) >= candidate.index &&
        (match.index ?? 0) < candidate.index + candidate[0].length);
  });
  return [...safe, ...unsafe].sort((a, b) => a.index - b.index);
}

/**
 * Revalidate and order the host's resolved `--source` paths. Admission is by
 * path string; the source binding is minted later, during acquisition.
 *
 * No globbing, no widening, and no extension filter. Nothing here reads bytes:
 * acquisition applies its regular-file, symlink, byte-budget, and credential
 * checks as for every candidate. The grammar mirrors the runtime's `--source`
 * grammar, so it does not refuse a path the CLI accepts (one with a space, say).
 * A selection under host state (`.git/`, `.docsfab/`) is refused. Any other
 * directory the scan skips, such as `vendor/` or `build/`, only keeps paths out
 * of the ranking: a selection there is read, as a path the request names is.
 * More distinct
 * selections than the source budget (`firstPass.maxSourceFiles`, the host's
 * value when it passes one) could not all be read, so they stop up front as
 * `budget-exhausted`, naming the bound.
 *
 * `readingPaths` are the sources an admitted request intent names. They join
 * the selections under the same checks and the same budget, and never
 * displace one; a refusal says which of the two named the path.
 */
export function normalizeBoundSourcePaths(
  value,
  maxSelections = FIRST_PASS_LIMIT_DEFAULTS.maxSourceFiles,
  readingPaths = [],
) {
  if ((value === undefined || value === null) && readingPaths.length === 0) {
    return Object.freeze([]);
  }
  const selections = value ?? [];
  if (!Array.isArray(selections)) {
    throw new FirstPassSupportError(
      "unsafe-target",
      "Bound first-pass source selections must be an array of repository-relative paths.",
    );
  }
  const paths = new Set();
  const selected = new Set();
  for (const [index, entry] of [...selections, ...readingPaths].entries()) {
    const fromReading = index >= selections.length;
    if (typeof entry !== "string" || entry.length === 0) {
      throw new FirstPassSupportError(
        "unsafe-target",
        "Every bound first-pass source selection must be a repository-relative path.",
      );
    }
    if (
      entry !== entry.normalize("NFC") ||
      entry.includes("\0") ||
      entry.includes("\\") ||
      entry.startsWith("/") ||
      BOUND_SOURCE_DRIVE_PREFIX.test(entry) ||
      posix.normalize(entry) !== entry ||
      entry.split("/").some((segment) => !segment || segment === "." || segment === "..")
    ) {
      throw new FirstPassSupportError(
        "unsafe-target",
        "A bound first-pass source selection is not a safe repository-relative path.",
      );
    }
    const hostState = hostStateAncestor(entry);
    if (hostState !== undefined) {
      throw new FirstPassSupportError(
        "bound-source-unavailable",
        fromReading
          ? `The request's reading names ${entry} as a source, but it is under ${hostState}/, host state that first-pass evidence never reads. Name a tracked product file outside that directory in the request, or pass one with --source.`
          : `The selected source ${entry} is under ${hostState}/, host state that first-pass evidence never reads. Select a tracked product file outside that directory.`,
      );
    }
    if (!fromReading) selected.add(entry);
    paths.add(entry);
  }
  if (paths.size > maxSelections) {
    const counts =
      paths.size > selected.size
        ? ` (${String(selected.size)} with --source and ${String(paths.size - selected.size)} more the request's reading names)`
        : "";
    throw new FirstPassSupportError(
      "budget-exhausted",
      `The request selects ${String(paths.size)} sources${counts}, over the first-pass source budget of ${String(maxSelections)} (firstPass.maxSourceFiles). Select fewer sources with --source, or raise DOCSFAB_FIRST_PASS_MAX_SOURCE_FILES.`,
      [],
      { phase: "request", rule: "budget-exhausted", location: "$instruction" },
    );
  }
  return Object.freeze([...paths].sort(codePointCompare));
}

/**
 * Host-authorized documentation write prefixes. Empty or missing means the
 * host has not authorized a write set, and a request that names no page asks
 * for that authorization first.
 */
export function normalizeAuthorizedWriteRoots(value) {
  if (value === undefined || value === null) return Object.freeze([]);
  if (!Array.isArray(value)) {
    throw new FirstPassSupportError(
      "needs-authorization",
      "Authorize a documentation write root such as docs/ or fern/ before DocsFab can bind a page.",
    );
  }
  const roots = [];
  for (const entry of value) {
    if (typeof entry !== "string" || entry.length === 0) continue;
    const withSlash = entry.endsWith("/") ? entry : `${entry}/`;
    // The host decides how far roots reach: `docs/` and `fern/` narrowed by
    // configuration, or, for a local run, configured documentation directories
    // (owner amendment to Decision 8, #1914 note 72942914). The provider still
    // refuses any root outside the shared local documentation-root grammar.
    if (isLocalDocumentationRoot(withSlash)) roots.push(withSlash);
  }
  return Object.freeze([...new Set(roots)].sort(codePointCompare));
}

/**
 * The one first-pass write-root check, identical to the runtime's
 * `isFirstPassWriteRoot`: `docs/`, `fern/`, or a directory under one of them,
 * in the page-path alphabet, with no empty, dot-prefixed, `node_modules`, or
 * `vendor` segment, so it stays inside the task-scope documentation class. Under
 * the narrow policy, project configuration can only narrow to such a root; a
 * local run widens through `isLocalDocumentationRoot` below. Both packages run
 * the same case table, `tests/fixtures/first-pass-write-roots.json`.
 */
const FIRST_PASS_WRITE_ROOT = /^(?:docs|fern)\/(?:(?!(?:node_modules|vendor)\/)[A-Za-z0-9_-][A-Za-z0-9_.-]*\/)*$/u;

export function isFirstPassWriteRoot(root) {
  return typeof root === "string" && FIRST_PASS_WRITE_ROOT.test(root);
}

/**
 * The one local documentation-root check, identical to the runtime's
 * `isLocalDocumentationRoot`: a directory a local run may write under when
 * `.docsfab.json` names it (owner amendment to Decision 8, #1914 note
 * 72942914). Segments use the page-path alphabet; it refuses `.` and `..`,
 * empty and dot-prefixed segments, `node_modules` and `vendor` segments, a bare
 * `packages/`, and the code directories at the top or under `packages/<name>/`,
 * all case-insensitively, and any non-ASCII character. Both packages run the
 * same case table, `tests/fixtures/local-documentation-roots.json`.
 */
const LOCAL_DOCUMENTATION_ROOT = /^(?!(?:app|bin|build|ci|cmd|config|deploy|dist|internal|lib|pkg|scripts|skills|spec|specs|src|test|tests|third_party)\/)(?!packages\/$)(?!packages\/[^/]+\/(?:app|bin|build|ci|cmd|config|deploy|dist|internal|lib|pkg|scripts|skills|spec|specs|src|test|tests|third_party)\/)(?:(?!(?:node_modules|vendor)\/)[A-Za-z0-9_-][A-Za-z0-9_.-]*\/)+$/iu;

/** ASCII only, checked without case folding, as the runtime checks it. */
const ASCII_ROOT = /^[\x00-\x7F]*$/u;

export function isLocalDocumentationRoot(root) {
  return typeof root === "string" && ASCII_ROOT.test(root) && LOCAL_DOCUMENTATION_ROOT.test(root);
}

export function isInsideAuthorizedWriteRoots(path, roots) {
  return roots.some((root) => path.startsWith(root));
}

export function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort(codePointCompare).map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function requireText(value, label) {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${label} is required`);
  return value;
}

export function requireRevision(value) {
  const revision = requireText(value, "revision");
  if (!/^[a-f0-9]{40,64}$/u.test(revision)) {
    throw new FirstPassSupportError(
      "invalid-revision",
      "Ordinary first-pass support requires the resolved lowercase repository revision.",
    );
  }
  return revision;
}

export function codePointCompare(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}
