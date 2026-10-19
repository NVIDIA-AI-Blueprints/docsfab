// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Seal and verify the host's RequestIntentV1 artifact through the contract
 * kit. Verification never trusts a self-declared field: it re-derives the
 * request digest and every quote from the instruction, then the seal.
 *
 * The seal is an unkeyed digest, so a re-sealed record can carry any body.
 * Verification therefore re-checks the path rules that need no repository
 * input: duplicate targets, excluded targets, and internal segments. Word
 * boundaries and named-target grounding are admission-only.
 */
import {
  REQUEST_INTENT_AUTHORITY_PREFERENCES,
  REQUEST_INTENT_CONSTRAINT_KINDS,
  REQUEST_INTENT_DIGEST_KEY,
  REQUEST_INTENT_KIND,
  REQUEST_INTENT_OPERATIONS,
  REQUEST_INTENT_SCHEMA_VERSION,
  REQUEST_INTENT_TARGET_ORIGINS,
  REQUEST_INTENT_TARGET_ROLES,
  type RequestIntentAuthority,
  type RequestIntentBody,
  type RequestIntentQuestion,
  type RequestIntentQuote,
  type RequestIntentV1,
} from "./contract.js";
import {
  internalSegment,
  isRepositoryRelativePath,
  pathCaseKey,
  requireInstruction,
} from "./decode.js";
import { RequestIntentContractError, sealedKit as kit } from "./kit.js";
import { requestInstructionSha256 } from "./quote.js";

const BODY_KEYS = [
  "instructionSha256",
  "operation",
  "targets",
  "sources",
  "preserve",
  "exclusions",
  "constraints",
  "authorityPreference",
  "question",
] as const satisfies readonly (keyof RequestIntentBody)[];

export function sealRequestIntent(body: RequestIntentBody): RequestIntentV1 {
  return kit.seal(
    REQUEST_INTENT_KIND,
    REQUEST_INTENT_DIGEST_KEY,
    body,
    REQUEST_INTENT_SCHEMA_VERSION,
  ) as RequestIntentV1;
}

/**
 * Decode a recorded RequestIntentV1 and prove it belongs to `instruction`.
 * Throws `RequestIntentContractError` when any field, the request digest, a
 * quote, or the seal does not verify.
 */
export function verifyRequestIntentDigest(value: unknown, instruction: string): RequestIntentV1 {
  requireInstruction(instruction);
  const text = instruction.normalize("NFC");
  const expectedSha256 = requestInstructionSha256(instruction);
  return kit.decodeSealed(
    value,
    REQUEST_INTENT_KIND,
    REQUEST_INTENT_DIGEST_KEY,
    [...BODY_KEYS],
    (root) => normalizeBody(root, text, expectedSha256),
    REQUEST_INTENT_SCHEMA_VERSION,
  ) as RequestIntentV1;
}

/**
 * Paths an admitted intent writes: every target, less anything an exclusion
 * names or contains, and never two paths one case-folding checkout opens as
 * the same file (the first spelling is kept).
 */
export function requestIntentWriteSet(
  intent: Pick<RequestIntentBody, "targets" | "exclusions">,
): string[] {
  const seen = new Set<string>();
  return intent.targets
    .map((target) => target.path)
    .filter((path) => !intent.exclusions.some((exclusion) => excludes(exclusion.path, path)))
    .filter((path) => {
      const key = pathCaseKey(path);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

/**
 * Segment-bounded: `docs/api` excludes `docs/api/x.md`, never `docs/api-v2.md`.
 * Letter case is folded as for duplicate targets: on a case-folding checkout
 * `Docs/API.md` is the same file, and over-excluding is the safe direction.
 */
export function excludes(exclusion: string, path: string): boolean {
  const excluded = pathCaseKey(exclusion);
  const candidate = pathCaseKey(path);
  return candidate === excluded || candidate.startsWith(`${excluded}/`);
}

function normalizeBody(
  root: Record<string, unknown>,
  text: string,
  expectedSha256: string,
): RequestIntentBody {
  const instructionSha256 = kit.hash(root.instructionSha256);
  if (instructionSha256 !== expectedSha256) {
    throw new RequestIntentContractError(
      "sealed-instruction-mismatch",
      "the sealed request digest does not match the instruction it is verified against.",
    );
  }
  const quote = (value: unknown): RequestIntentQuote => {
    const entry = closed(value, ["text", "start", "end"]);
    const start = offset(entry.start);
    const end = offset(entry.end);
    if (
      typeof entry.text !== "string" ||
      end <= start ||
      end > text.length ||
      text.slice(start, end) !== entry.text
    ) {
      throw new RequestIntentContractError(
        "sealed-quote-mismatch",
        "a sealed quote is not the instruction text at its recorded offsets.",
      );
    }
    return { text: entry.text, start, end };
  };
  const path = (value: unknown): string => {
    const result = kit.string(value);
    if (!isRepositoryRelativePath(result)) kit.fail("sealed-shape");
    return result;
  };
  const body: RequestIntentBody = {
    instructionSha256,
    operation: kit.enumeration(root.operation, REQUEST_INTENT_OPERATIONS),
    targets: kit.array(root.targets).map((value) => {
      const entry = closed(value, ["path", "role", "chosenFrom", "quote"]);
      return {
        path: path(entry.path),
        role: kit.enumeration(entry.role, REQUEST_INTENT_TARGET_ROLES),
        chosenFrom: kit.enumeration(entry.chosenFrom, REQUEST_INTENT_TARGET_ORIGINS),
        quote: quote(entry.quote),
      };
    }),
    sources: kit.array(root.sources).map((value) => {
      const entry = closed(value, ["path", "quote"]);
      return { path: path(entry.path), quote: quote(entry.quote) };
    }),
    preserve: kit.array(root.preserve).map((value) => ({
      quote: quote(closed(value, ["quote"]).quote),
    })),
    exclusions: kit.array(root.exclusions).map((value) => {
      const entry = closed(value, ["path", "quote"]);
      return { path: path(entry.path), quote: quote(entry.quote) };
    }),
    constraints: kit.array(root.constraints).map((value) => {
      const entry = closed(value, ["kind", "quote"]);
      return {
        kind: kit.enumeration(entry.kind, REQUEST_INTENT_CONSTRAINT_KINDS),
        quote: quote(entry.quote),
      };
    }),
    authorityPreference: authority(root.authorityPreference, quote),
    question: root.question === null ? null : question(root.question),
  };
  checkSealedPaths(body);
  return body;
}

/** The admission path rules a re-sealed record could otherwise skip. */
function checkSealedPaths(body: RequestIntentBody): void {
  for (const entry of [...body.targets, ...body.sources]) {
    if (internalSegment(entry.path) !== undefined) {
      throw new RequestIntentContractError(
        "sealed-internal-path",
        "a sealed target or source passes through a repository-internal segment.",
      );
    }
  }
  const seen = new Set<string>();
  for (const target of body.targets) {
    const key = pathCaseKey(target.path);
    if (seen.has(key)) {
      throw new RequestIntentContractError(
        "sealed-duplicate-target",
        "two sealed targets name one file once letter case is folded.",
      );
    }
    seen.add(key);
  }
  for (const exclusion of body.exclusions) {
    if (body.targets.some((target) => excludes(exclusion.path, target.path))) {
      throw new RequestIntentContractError(
        "sealed-excluded-target",
        "a sealed exclusion names or contains a sealed target.",
      );
    }
  }
}

function closed(value: unknown, keys: readonly string[]): Record<string, unknown> {
  const entry = kit.object(value);
  kit.exact(entry, keys);
  return entry;
}

function offset(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) kit.fail("sealed-shape");
  return value as number;
}

function authority(
  value: unknown,
  quote: (value: unknown) => RequestIntentQuote,
): RequestIntentAuthority {
  const entry = closed(value, ["preference", "quote"]);
  const preference = kit.enumeration(entry.preference, REQUEST_INTENT_AUTHORITY_PREFERENCES);
  if ((preference === "unspecified") !== (entry.quote === null)) kit.fail("sealed-shape");
  return {
    preference,
    quote: entry.quote === null ? null : quote(entry.quote),
  };
}

function question(value: unknown): RequestIntentQuestion {
  const entry = closed(value, ["question", "options", "recommendedDefault", "consequence"]);
  const options = kit.array(entry.options).map((option) => kit.string(option));
  const recommendedDefault = kit.string(entry.recommendedDefault);
  kit.unique(options);
  if (!options.includes(recommendedDefault)) kit.fail("sealed-shape");
  return {
    question: kit.string(entry.question),
    options,
    recommendedDefault,
    consequence: kit.string(entry.consequence),
  };
}
