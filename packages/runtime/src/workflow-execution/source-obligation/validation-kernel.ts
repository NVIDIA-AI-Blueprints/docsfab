// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { type SourceObligationSourceReferenceCode } from ".././source-obligation/types.js";
import {
  SOURCE_OBLIGATION_CATALOG_CODES,
  type SourceObligationCatalogCode,
} from ".././source-obligation/response-contract.js";
import { createContractKit } from "../../contract-kit/index.js";
import {
  InferenceStepError,
  type SourceObligationDimensionReasonCorrection,
} from "../../execution/contracts.js";
import { OUTPUT_RULES, type OutputRuleRejection } from "../../contracts/model-output.generated.js";
import { JsonEvidenceError, type JsonEvidenceErrorCode } from "../../json-evidence.js";
import { type TechnicalFactDimension, type TechnicalSourceFact } from ".././review-response.js";
import {
  sourcePathRejectionSubject,
  type InferenceRejectionSubjectV1,
} from "../../execution/rejection-subject.js";
import {
  isModelCorrectableSourceObligationRejection,
  type ClassifiedSourceObligationRejectionCode,
} from ".././source-obligation-rejection-retryability.js";

export const SUPPORTED_WORKFLOWS = new Set(["create-documentation", "review-documentation"]);
export const OBLIGATION_ID = /^OBL-[A-Z0-9][A-Z0-9_-]{0,58}$/u;
export const FACT_ID = /^[A-Z][A-Z0-9_-]{0,63}$/u;
export const SHA256 = /^[a-f0-9]{64}$/u;
export const MAX_OBLIGATIONS_LIMIT = "sourceObligation.maxObligations";
export const MAX_PER_DIMENSION_LIMIT = "sourceObligation.maxPerDimension";
export const MAX_LOCATORS_LIMIT = "sourceObligation.maxLocators";

export const DOCUMENTATION_DISPOSITIONS = [
  "documented",
  "omitted",
  "conflicting",
  "unverified-policy",
  "product-defect",
] as const satisfies readonly TechnicalSourceFact["documentationDisposition"][];

export class SourceObligationSourceReferenceError extends Error {
  public readonly code: SourceObligationSourceReferenceCode;

  public constructor(input: {
    code: SourceObligationSourceReferenceCode;
    message: string;
  }) {
    super(input.message);
    this.code = input.code;
    this.name = "SourceObligationSourceReferenceError";
  }
}

export function failSourceReference(code: SourceObligationSourceReferenceCode): never {
  const message =
    code === "revision-mismatch"
      ? "Source-obligation derivation rejected a source reference for another repository revision."
      : code === "source-write-intersection"
        ? "A documentation plan cannot use an authorized write target as original source evidence."
        : code === "source-untracked"
          ? "source-untracked: the documentation plan names a page source the host cannot admit as a regular tracked file at this revision: it is untracked, or a link, submodule, or other entry the host does not seal as original source. " +
            "Bound source evidence, such as a --change diff or manifest, is read and cited with docsfab_read_source " +
            "and docsfab_cite_source, never named as a page source. Start a new run; if its plan names an untracked " +
            "source again, report the run id as a planner defect."
          : "Source-obligation derivation rejected an invalid repository source reference.";
  throw new SourceObligationSourceReferenceError({ code, message });
}

/**
 * Closed host-owned messages shared with the live activity projection. Model
 * text never becomes a displayable failure reason.
 *
 * The contract raises coded messages ({@link sourceObligationRejectionMessage});
 * only the locator and bounded-text helpers below still raise from this map,
 * on the technical-correction path. The rest stays because this set also
 * recognizes `step.error` on older records; dropping an entry would make an old
 * record's reason undisplayable.
 */
export const SOURCE_OBLIGATION_FAILURES = {
  contract: "Source-obligation response did not satisfy the host-owned contract.",
  shape: "Source-obligation evidence did not satisfy the host-owned contract.",
  hostPath: "Source-obligation evidence disclosed a host path.",
  completeness: "Source-obligation completeness must remain bounded-not-proven.",
  dimensions: "Source-obligation evidence must assess every technical dimension exactly once.",
  dimensionIdentity: "Source-obligation evidence contains an invalid or duplicate dimension.",
  dimensionStatus: "Source-obligation evidence contains an invalid dimension status.",
  dimensionSize: "Source-obligation evidence exceeds its bounded dimension size.",
  applicable: "An applicable source-obligation dimension requires atomic obligations.",
  applicableLocators:
    "An applicable source-obligation dimension must keep sourceLocators empty and cite sources on each obligation.",
  nonApplicable: "Only applicable source-obligation dimensions may contain obligations.",
  notApplicable: "A not-applicable source-obligation dimension requires source evidence.",
  unverified: "An unverified source-obligation reason must remain in limitations.",
  obligationId: "Source-obligation evidence contains an invalid or duplicate obligation ID.",
  obligationDimension: "Source-obligation evidence exceeds its bound or crosses dimensions.",
  evidenceClass: "Source-obligation evidence contains an invalid evidence class.",
  sourceLocator: "Source-obligation evidence requires a specific source locator.",
  revisionSuffix: "Source-obligation proposal locators must omit repository revision suffixes.",
  nonspecificLocator: "Source-obligation evidence contains a nonspecific source locator.",
  sourceAuthority: "Source-obligation evidence cites a path outside the original source authority.",
  itemBound: "Source-obligation evidence exceeds its item bound.",
  duplicateText: "Source-obligation evidence contains duplicate text values.",
  boundedText: "Source-obligation evidence contains invalid bounded text.",
  noSources: "Source-obligation evidence contains no readable source path to observe.",
  sourceIdentitySet: "Source-obligation evidence requires a bounded source identity set.",
} as const;
export const sourceObligationFailureMessages = new Set<string>(
  Object.values(SOURCE_OBLIGATION_FAILURES),
);

/**
 * Whether a retained step message is a host-owned source-obligation refusal,
 * and therefore safe to display: a coded message, a message from the closed
 * map above, or an older strict-JSON refusal. Anything else may be model text
 * and is refused.
 */
export function sourceObligationFailureReason(message: string): string | undefined {
  if (sourceObligationRejectionFromMessage(message) !== undefined) return message;
  if (sourceObligationFailureMessages.has(message)) return message;
  if (
    /^Source-obligation response rejected: (?:invalid-utf8|malformed-json|duplicate-key|unsafe-number|noncanonical-json)\.$/u.test(
      message,
    )
  )
    return message;
  return undefined;
}

/**
 * Closed vocabulary naming which host-owned validation refused a
 * source-obligation response. Codes name the kind of defect, not the
 * individual assertion, except the strict-JSON group, which mirrors the
 * parser's `JsonEvidenceErrorCode` union ({@link JSON_REJECTION_CODES}).
 *
 * `unknown` means "this rejection recorded no reason", never a diagnosis.
 * Append only: a recorded code keeps its meaning for the life of its records.
 */
export const SOURCE_OBLIGATION_REJECTION_CODES = [
  /** The response was not strict JSON evidence, for a reason the parser did not name. */
  "invalid-json",
  /** The response bytes were not valid UTF-8. */
  "invalid-utf8",
  /** The response was not syntactically JSON at all. */
  "malformed-json",
  /** An object repeated a key, so the response has no single well-defined value. */
  "duplicate-key",
  /** A number was outside the safe-integer range, so its value cannot be trusted. */
  "unsafe-number",
  /** The response parsed but was not the canonical encoding the contract requires. */
  "noncanonical-json",
  /** A value was not the object or array the contract requires. */
  "invalid-shape",
  /** An object carried keys the contract does not define, or omitted required ones. */
  "unexpected-key-set",
  /** A scalar was the wrong type, or outside its enumerated or formatted set. */
  "invalid-value",
  /** A required field was present but empty or blank. */
  "empty-required-field",
  /** A count, length, depth, or byte bound was exceeded. */
  "bounds-exceeded",
  /** A set the contract requires in full came back short (not `bounds-exceeded`). */
  "incomplete-required-set",
  /** An identifier or text value repeated where the contract requires distinct entries. */
  "duplicate-entry",
  /**
   * A dimension's status disagrees with the obligations or locators it
   * carries. Recorded only by older hosts; each pairing is now its own
   * catalog rule (`SOURCE_OBLIGATION_CATALOG_CODES`).
   */
  "inconsistent-status",
  /** A source locator was nonspecific, or carried a repository revision suffix. */
  "invalid-locator",
  /** A CREATE citation outside its bound plan was not declared for host admission. */
  "source-proposal-required",
  /** The host refused a declared CREATE source proposal. */
  "source-proposal-refused",
  /** The response cited a path outside the admitted original source authority. */
  "unauthorized-source",
  /** Retained evidence did not match its own canonical digest. */
  "digest-mismatch",
  /** Retained evidence was bound to another revision or scope. */
  "stale-evidence",
  /** The response declared a kind or schemaVersion this host does not accept. */
  "unsupported-identity",
  /** The response carried credential-shaped content. */
  "credential-material",
  /** Raised only by older hosts; kept so their records still classify. */
  "host-path-disclosure",
  /** A rejection was raised without a coded reason. */
  "unknown",
] as const;

export type SourceObligationRejectionCode = (typeof SOURCE_OBLIGATION_REJECTION_CODES)[number];

/**
 * Fails to typecheck unless `source-obligation-rejection-retryability.ts`
 * classifies exactly the closed code set.
 */
export const SOURCE_OBLIGATION_REJECTION_RETRYABILITY_COVERAGE: [
  SourceObligationRejectionCode,
] extends [ClassifiedSourceObligationRejectionCode]
  ? [ClassifiedSourceObligationRejectionCode] extends [SourceObligationRejectionCode]
    ? true
    : never
  : never = true;

/**
 * Closed vocabulary of contract positions a rejection may name. They are
 * authored here, never derived from the response, so no model-supplied string
 * reaches a record through a location; collection members use `[]`, because
 * an index would leak how much the response contained.
 */
export const SOURCE_OBLIGATION_REJECTION_LOCATIONS = [
  /** The response as a whole, before any structure was admitted. */
  "$response",
  "$",
  "$.completeness",
  "$.dimensions",
  "$.dimensions[]",
  "$.dimensions[].dimension",
  "$.dimensions[].status",
  "$.dimensions[].reason",
  "$.dimensions[].sourceLocators",
  "$.dimensions[].sourceLocators[]",
  "$.dimensions[].obligations",
  "$.dimensions[].obligations[]",
  "$.dimensions[].obligations[].id",
  "$.dimensions[].obligations[].dimension",
  "$.dimensions[].obligations[].statement",
  "$.dimensions[].obligations[].evidenceClass",
  "$.dimensions[].obligations[].uncertainty",
  "$.dimensions[].obligations[].sourceLocators",
  "$.dimensions[].obligations[].sourceLocators[]",
  "$.limitations",
  "$.limitations[]",
  "$.sourceProposals",
  "$.sourceProposals[]",
  "$.sourceProposals[].path",
  "$.sourceProposals[].reason",
  "$.identity",
  "$.digest",
] as const;

export type SourceObligationRejectionLocation =
  (typeof SOURCE_OBLIGATION_REJECTION_LOCATIONS)[number];

/** A code a source-obligation rejection records: the legacy vocabulary or the catalog family. */
export type SourceObligationRecordedCode =
  | SourceObligationRejectionCode
  | SourceObligationCatalogCode;

export function isSourceObligationCatalogCode(code: unknown): code is SourceObligationCatalogCode {
  return (SOURCE_OBLIGATION_CATALOG_CODES as readonly unknown[]).includes(code);
}

/** Whether `location` is one the catalog declares for `code`. */
export function catalogLocationOf(
  code: SourceObligationCatalogCode,
  location: unknown,
): location is SourceObligationRejectionLocation {
  return (OUTPUT_RULES[code].locations as readonly unknown[]).includes(location);
}

/** Host-owned stem every source-obligation rejection message keeps. */
export const SOURCE_OBLIGATION_REJECTION_ERROR =
  "Source-obligation response did not satisfy the host-owned contract.";

/**
 * Build the operator-visible sentence for a rejection, derived from the coded
 * pair so prose and fields cannot drift. The stem stays stable for matchers;
 * the reason is appended without a colon so the result never looks like a
 * credential assignment.
 */
export function sourceObligationRejectionMessage(
  code: SourceObligationRecordedCode,
  location: SourceObligationRejectionLocation,
): string {
  // Match the full stop rather than counting characters, so a reworded stem
  // without one still round-trips through sourceObligationRejectionFromMessage.
  const stem = SOURCE_OBLIGATION_REJECTION_ERROR.replace(/\.$/u, "");
  return `${stem} under rule ${code} at ${location}.`;
}

/**
 * Recover the coded pair from a retained message. A bare stem (an older
 * record) reads as `historical-generic`; anything else unrecognized reads as
 * `undefined` rather than a guess.
 */
export function sourceObligationRejectionFromMessage(
  message: unknown,
):
  | { code: SourceObligationRecordedCode; location: SourceObligationRejectionLocation }
  | "historical-generic"
  | undefined {
  if (message === SOURCE_OBLIGATION_REJECTION_ERROR) return "historical-generic";
  for (const code of SOURCE_OBLIGATION_REJECTION_CODES) {
    for (const location of SOURCE_OBLIGATION_REJECTION_LOCATIONS) {
      if (message === sourceObligationRejectionMessage(code, location)) return { code, location };
    }
  }
  for (const code of SOURCE_OBLIGATION_CATALOG_CODES) {
    for (const location of OUTPUT_RULES[code].locations) {
      if (message === sourceObligationRejectionMessage(code, location)) return { code, location };
    }
  }
  return undefined;
}

/**
 * Read the coded reason off a rejection, revalidating it against both closed
 * vocabularies so a reason forged onto an `InferenceStepError` elsewhere
 * cannot reach a record wearing this module's vocabulary.
 */
export function projectSourceObligationRejection(
  error: unknown,
): { code: SourceObligationRecordedCode; location: SourceObligationRejectionLocation } | undefined {
  if (!(error instanceof InferenceStepError) || !error.rejection) return undefined;
  const { code, location } = error.rejection;
  if (isSourceObligationCatalogCode(code)) {
    return catalogLocationOf(code, location) ? { code, location } : undefined;
  }
  const knownCode = SOURCE_OBLIGATION_REJECTION_CODES.find((entry) => entry === code);
  const knownLocation = SOURCE_OBLIGATION_REJECTION_LOCATIONS.find((entry) => entry === location);
  if (!knownCode || !knownLocation) return undefined;
  return { code: knownCode, location: knownLocation };
}

export const refusedReasonDimensions = new WeakMap<InferenceStepError, TechnicalFactDimension>();

/** Only a decoder-validated dimension and its matching reason refusal may enter retry feedback. */
export function sourceObligationReasonCorrection(
  error: unknown,
): SourceObligationDimensionReasonCorrection | undefined {
  if (!(error instanceof InferenceStepError)) return undefined;
  const dimension = refusedReasonDimensions.get(error);
  const rejection = projectSourceObligationRejection(error);
  if (
    dimension === undefined ||
    rejection?.location !== "$.dimensions[].reason" ||
    (rejection.code !== "invalid-value" && rejection.code !== "empty-required-field")
  ) {
    return undefined;
  }
  return Object.freeze({ kind: "source-obligation-dimension-reason", dimension });
}

/**
 * Rebuild a source-obligation rejection with this attempt's evidence attached,
 * keeping the coded reason. Mirrors `wrapTechnicalReviewFailure` on the
 * correction path.
 */
export function wrapSourceObligationFailure(
  error: InferenceStepError,
  evidence?: InferenceStepError["evidence"],
): InferenceStepError {
  const wrapped = new InferenceStepError(
    error.message,
    error.category,
    error.retryable,
    evidence,
    error.rejection,
    error.rejectionSubject ? { rejectionSubject: error.rejectionSubject } : undefined,
  );
  const dimension = refusedReasonDimensions.get(error);
  if (dimension !== undefined) refusedReasonDimensions.set(wrapped, dimension);
  return wrapped;
}

/**
 * Raise a coded rejection. Message, category, coded pair, and retryability
 * all derive from the same two arguments, so a caller cannot record one reason
 * and report another, or retry a code the family's table stops on.
 */
export function reject(
  code: SourceObligationRecordedCode,
  location: SourceObligationRejectionLocation,
  rejectionSubject?: InferenceRejectionSubjectV1,
): never {
  throw sourceObligationRejectionError(code, location, rejectionSubject);
}

export function sourceObligationRejectionError(
  code: SourceObligationRecordedCode,
  location: SourceObligationRejectionLocation,
  rejectionSubject?: InferenceRejectionSubjectV1,
): InferenceStepError {
  return new InferenceStepError(
    sourceObligationRejectionMessage(code, location),
    "malformed-response",
    isSourceObligationCatalogCode(code)
      ? OUTPUT_RULES[code].retry === "model-correctable"
      : isModelCorrectableSourceObligationRejection(code),
    undefined,
    Object.freeze({ code, location }),
    rejectionSubject ? { rejectionSubject } : undefined,
  );
}

export function sourceProposalRefusalError(path: string): InferenceStepError {
  return sourceObligationRejectionError(
    "source-proposal-refused",
    "$.sourceProposals[].path",
    sourcePathRejectionSubject(path, (candidate) => candidate === path),
  );
}

/**
 * Raise a catalog rule of this family. `rejectCorrectable` types the code and
 * its declared location at the call site; every catalog location is also in
 * {@link SOURCE_OBLIGATION_REJECTION_LOCATIONS} (a test holds that).
 */
export function rejectRule(
  rejection: OutputRuleRejection<SourceObligationCatalogCode>,
  rejectionSubject?: InferenceRejectionSubjectV1,
): never {
  return reject(
    rejection.code,
    rejection.location as SourceObligationRejectionLocation,
    rejectionSubject,
  );
}

export function fail(message: string, retryable = true): never {
  throw new InferenceStepError(message, "malformed-response", retryable);
}

/**
 * Map the strict-JSON parser's own refusal onto this module's vocabulary. The
 * `satisfies` clause makes a new parser code fail to typecheck until mapped;
 * codes are identical on both sides so a record and the parser name the same
 * fact.
 */
export const JSON_REJECTION_CODES = {
  "invalid-utf8": "invalid-utf8",
  "malformed-json": "malformed-json",
  "duplicate-key": "duplicate-key",
  "unsafe-number": "unsafe-number",
  "noncanonical-json": "noncanonical-json",
} as const satisfies Record<JsonEvidenceErrorCode, SourceObligationRejectionCode>;

/**
 * The rejection code for a refused parse; `invalid-json` for anything that is
 * not the host parser's own coded refusal.
 */
export function jsonRejectionCode(error: unknown): SourceObligationRejectionCode {
  return error instanceof JsonEvidenceError ? JSON_REJECTION_CODES[error.code] : "invalid-json";
}

/**
 * Map a contract-kit refusal onto this module's vocabulary. The kit knows the
 * axis, not the contract location, so callers bind the location with
 * {@link at}. The kit's bound annotation takes precedence over the axis code,
 * because a bound refusal is reported through `invalidShape` or
 * `invalidValue` when `boundExceeded` is unset.
 */
export const SOURCE_OBLIGATION_KIT_REJECTION_CODES = {
  "kit-invalid-shape": "invalid-shape",
  "kit-invalid-value": "invalid-value",
  "kit-digest-mismatch": "digest-mismatch",
  "kit-credential-material": "credential-material",
  "kit-schema-mismatch": "unsupported-identity",
  "kit-bounds-exceeded": "bounds-exceeded",
} as const satisfies Record<string, SourceObligationRejectionCode>;

export type SourceObligationKitRejectionCode = keyof typeof SOURCE_OBLIGATION_KIT_REJECTION_CODES;

/**
 * Kit rejections whose contract location is still unbound; {@link at} binds
 * it on the way out. Tracked per error object so nothing leaks between
 * interleaved calls and the innermost `at` wins.
 */
export const unboundKitRejections = new WeakSet<InferenceStepError>();

/**
 * The kit's `fail`. A kit rejection takes its retryability from the same
 * table as {@link reject}, so `credential-material` and
 * `digest-mismatch` stop the step on this path exactly as on the decoder's
 * own. Exported for the table's drift test.
 */
export function rejectSourceObligationKit(code: SourceObligationKitRejectionCode): never {
  const rejectionCode = SOURCE_OBLIGATION_KIT_REJECTION_CODES[code];
  const error = new InferenceStepError(
    sourceObligationRejectionMessage(rejectionCode, "$"),
    "malformed-response",
    isModelCorrectableSourceObligationRejection(rejectionCode),
    undefined,
    Object.freeze({ code: rejectionCode, location: "$" as const }),
  );
  unboundKitRejections.add(error);
  throw error;
}

/**
 * Run contract work, binding `location` onto any kit rejection it raises that
 * does not already name one; other errors pass through untouched.
 *
 * The rebuilt message comes from the coded pair alone, dropping the kit's
 * `axis/limit/observed` fragment, so the message stays recoverable by
 * {@link sourceObligationRejectionFromMessage} and no measurement of the
 * response reaches a retained reason.
 */
export function at<T>(location: SourceObligationRejectionLocation, run: () => T): T {
  try {
    return run();
  } catch (error) {
    if (!(error instanceof InferenceStepError) || !unboundKitRejections.has(error)) throw error;
    const code = (error.rejection?.code ?? "unknown") as SourceObligationRejectionCode;
    return reject(code, location);
  }
}

/**
 * Assert a closed key set. The kit reports a wrong key set through its shape
 * axis; this records it by name instead, with the kit's acceptance unchanged.
 * A missing required key is `ledger-key-missing` at that key's own path when
 * the catalog declares it there, so the retry names the key; an undeclared
 * key, or a missing one the catalog does not name, stays `unexpected-key-set`
 * at the object.
 */
export function exactKeys(
  location: SourceObligationRejectionLocation,
  root: Record<string, unknown>,
  keys: readonly string[],
  optional: readonly string[] = [],
): void {
  try {
    kit.exact(root, keys, optional);
  } catch (error) {
    if (!(error instanceof InferenceStepError) || !unboundKitRejections.has(error)) throw error;
    const missing = keys.find((key) => !optional.includes(key) && !Object.hasOwn(root, key));
    const keyLocation = missing === undefined ? undefined : `${location}.${missing}`;
    if (keyLocation !== undefined && catalogLocationOf("ledger-key-missing", keyLocation)) {
      reject("ledger-key-missing", keyLocation);
    }
    reject("unexpected-key-set", location);
  }
}

export const kit = createContractKit({
  fail: (code: SourceObligationKitRejectionCode) => rejectSourceObligationKit(code),
  inertMode: "strict",
  codes: {
    invalidShape: "kit-invalid-shape",
    invalidValue: "kit-invalid-value",
    digestMismatch: "kit-digest-mismatch",
    credentialMaterial: "kit-credential-material",
    schemaMismatch: "kit-schema-mismatch",
    boundExceeded: "kit-bounds-exceeded",
  },
});

export function compareCodePoints(left: string, right: string): number {
  const leftScalars = left[Symbol.iterator]();
  const rightScalars = right[Symbol.iterator]();
  while (true) {
    const leftScalar = leftScalars.next();
    const rightScalar = rightScalars.next();
    if (leftScalar.done || rightScalar.done) {
      return leftScalar.done ? (rightScalar.done ? 0 : -1) : 1;
    }
    const leftCodePoint = leftScalar.value.codePointAt(0)!;
    const rightCodePoint = rightScalar.value.codePointAt(0)!;
    if (leftCodePoint !== rightCodePoint) return leftCodePoint < rightCodePoint ? -1 : 1;
  }
}
