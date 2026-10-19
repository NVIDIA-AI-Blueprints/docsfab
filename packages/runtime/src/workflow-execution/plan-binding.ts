// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { canonicalDigest } from "../content-ir/canonical.js";
// The generated catalog table itself, a leaf: `model-output.ts` reads limits,
// which would pull this contract module into an import cycle.
import {
  rejectCorrectable,
  type OutputRuleRejection,
  type RuleCodeOf,
} from "../contracts/model-output.generated.js";
import {
  admitPlanSourceLocator,
  isPlanSourceLocatorRefusal,
  type PlanSourceLocatorRefusal,
} from "./repository-locator.js";

export const DOCUMENTATION_PLAN_BINDING_KIND = "docsfab-documentation-plan" as const;
export const DOCUMENTATION_PLAN_BINDING_SCHEMA_VERSION = 1 as const;

export type DocumentationPlanMode = "create" | "update" | "restructure";
export function documentationPlanModeForWorkflow(
  workflowName: string,
): DocumentationPlanMode | undefined {
  if (workflowName === "create-documentation") return "create";
  if (workflowName === "update-documentation") return "update";
  if (workflowName === "restructure-documentation") return "restructure";
  return undefined;
}

export type DocumentationPageDisposition =
  | "create"
  | "update"
  | "restructure"
  | "retain"
  | "move"
  | "merge"
  | "split"
  | "out-of-scope";

export interface DocumentationPlanPageV1 {
  path: string;
  disposition: DocumentationPageDisposition;
}

export interface DocumentationPlanSourceBindingV1 {
  pagePath: string;
  /**
   * Immutable whole-file source references at the validated revision
   * (`path@revision`). A line or section suffix is a claim-evidence coordinate,
   * not a read restriction; the host reads and verifies the complete file. A
   * planner must include the complete operation span a promised consequence
   * needs while preserving any explicit user restriction.
   *
   * CREATE and RESTRUCTURE sources follow `admitPlanSourceLocator`. UPDATE
   * sources are evidence text the host never resolves.
   */
  sources: readonly string[];
}

/**
 * Why the host converted a planned CREATE page into an UPDATE of it, a closed
 * set: the planner planned a CREATE of a page that exists
 * (`create-target-exists`), or proposed the plan as an UPDATE of a page that
 * exists (`planner-proposed-update`). Both pass the same admission.
 */
export const CREATE_CONVERSION_REASONS = [
  "create-target-exists",
  "planner-proposed-update",
] as const;
export type CreateConversionReason = (typeof CREATE_CONVERSION_REASONS)[number];
/** The conversion of a planned CREATE of a page the revision already holds. */
export const CREATE_CONVERSION_REASON =
  "create-target-exists" as const satisfies CreateConversionReason;

export function isCreateConversionReason(value: unknown): value is CreateConversionReason {
  return (CREATE_CONVERSION_REASONS as readonly unknown[]).includes(value);
}

/**
 * The host's conversion of one planned CREATE page into an UPDATE of the
 * page the run's revision already holds at that exact path. Only plan
 * admission writes it, never a model; the binding's digest covers it.
 */
export interface DocumentationPlanCreateConversionV1 {
  readonly reason: CreateConversionReason;
  /** The converted page. Its disposition in `pages` is `update`. */
  readonly path: string;
  /**
   * SHA-256 of the page's bytes at the run's revision (not a Git object ID):
   * the base the update starts from.
   */
  readonly baseSha256: string;
}

/**
 * The request-intent companion roles a plan binding can carry, the non-write
 * members of `REQUEST_INTENT_TARGET_ROLES`. Spelled here because the intent
 * contract sits in an import cycle a plan binding must not join.
 */
export const NAVIGATION_COMPANION_ROLES = ["companion-nav", "companion-index"] as const;
export type NavigationCompanionRole = (typeof NAVIGATION_COMPANION_ROLES)[number];

/**
 * An existing navigation or index file the host admitted beside the plan's
 * pages so the pages the plan creates or moves can be linked from it. Only
 * plan admission writes it, never a model; the binding's digest covers it.
 */
export interface DocumentationPlanNavigationCompanionV1 {
  readonly path: string;
  readonly role: NavigationCompanionRole;
  /** SHA-256 of the file's bytes at the run's revision: the base the edit keeps. */
  readonly baseSha256: string;
}

/**
 * Content-free execution ABI emitted by the planning step. Only page paths in
 * a mutating disposition, and the host's navigation companions, become write
 * targets.
 */
export interface DocumentationPlanBindingV1 {
  kind: typeof DOCUMENTATION_PLAN_BINDING_KIND;
  schemaVersion: typeof DOCUMENTATION_PLAN_BINDING_SCHEMA_VERSION;
  mode: DocumentationPlanMode;
  pages: readonly DocumentationPlanPageV1[];
  sourceBindings: readonly DocumentationPlanSourceBindingV1[];
  /** Present only on a CREATE plan the host converted at admission. */
  createConvertedToUpdate?: DocumentationPlanCreateConversionV1;
  /** Present only on a RESTRUCTURE plan the host gave companions at admission. */
  navigationCompanions?: readonly DocumentationPlanNavigationCompanionV1[];
  digest: string;
}

/**
 * Model-facing plan input. The host adds the ABI kind, schema version, and
 * canonical digest after validating this semantic page/source map. Providers
 * must not be asked to manufacture authority metadata.
 */
export type DocumentationPlanInputV1 = Pick<
  DocumentationPlanBindingV1,
  "mode" | "pages" | "sourceBindings"
>;

/**
 * A catalogued, model-correctable refusal of one plan source: its spelling,
 * or a source that names one of the plan's own write pages.
 */
export type PlanSourceLocatorRejection =
  | OutputRuleRejection<RuleCodeOf<"plan-source-locator">>
  | OutputRuleRejection<"documentation-plan-source-write-target">;

/**
 * Relative to the binding's own root; the planner's reply admission rebases it
 * under `$.planBinding`.
 */
export type DocumentationPlanBindingLocation =
  | "$"
  | "$.mode"
  | "$.pages"
  | "$.pages[]"
  | "$.pages[].path"
  | "$.pages[].disposition"
  | "$.sourceBindings"
  | "$.sourceBindings[]"
  | "$.sourceBindings[].pagePath"
  | "$.sourceBindings[].sources"
  | "$.sourceBindings[].sources[]"
  | "$.createConvertedToUpdate"
  | "$.navigationCompanions";

export class DocumentationPlanBindingError extends Error {
  public readonly code: DocumentationPlanBindingErrorCode;
  /**
   * The catalog rule a source locator refusal broke, and where. The planner's
   * reply admission records it on the refused attempt so the retry states it.
   */
  public readonly rejection?: PlanSourceLocatorRejection;
  /** Where the binding broke the rule, when the raising check names it. */
  public readonly location?: DocumentationPlanBindingLocation;
  public constructor(
    code: DocumentationPlanBindingErrorCode,
    rejection?: PlanSourceLocatorRejection,
    location?: DocumentationPlanBindingLocation,
  ) {
    super(`Documentation plan binding rejected (${code}).`);
    this.code = code;
    if (rejection) this.rejection = rejection;
    if (location) this.location = location;
    this.name = "DocumentationPlanBindingError";
  }
}

/**
 * The admitted plan does not address a page the request named (its first-pass
 * target control). An update plan addresses a named page by changing it or by
 * keeping it unchanged with disposition `retain`; a create or restructure plan
 * must write it. `out-of-scope` never addresses a named page. Named pages are
 * the least a plan addresses: it may add pages inside the write roots.
 */
export class OmittedFirstPassTargetError extends DocumentationPlanBindingError {
  public constructor(
    public readonly omitted: readonly string[],
    public readonly mode: DocumentationPlanMode,
  ) {
    super("omitted-mandatory-obligation");
    // Paths passed the first-pass target grammar, so they are safe to name.
    this.message =
      `omitted-mandatory-obligation: the ${mode} plan does not address ` +
      `${String(omitted.length)} page(s) the request named (${omitted.join(", ")}). ` +
      (mode === "update"
        ? "Plan each named page as update, or keep it unchanged with disposition retain " +
          "and give the reason; out-of-scope does not address a named page. "
        : `A ${mode} plan writes every named page. `) +
      `Remediation: rerun with an instruction that names only the pages to ${
        mode === "update" ? "check" : "write"
      }.`;
    this.name = "OmittedFirstPassTargetError";
  }
}

/**
 * Why a planned write is outside a run's write scope:
 * - `not-a-page`: not a Markdown or MDX page in the page-path alphabet;
 * - `protected`: a source, CI, hidden, third-party, or agent instruction file,
 *   which no documentation root admits;
 * - `outside-roots`: a page some documentation root could hold, outside the
 *   run's roots;
 * - `navigation-outside-roots`: a restructure's navigation file in a
 *   directory, such as `fern/docs.yml`, outside the run's roots; a root on
 *   that directory admits it.
 * - `not-named`: an agent instruction file or a hidden path inside the roots
 *   that the operator's request does not name.
 */
export type PlanWriteRefusal =
  | "not-a-page"
  | "protected"
  | "outside-roots"
  | "navigation-outside-roots"
  | "not-named";

/** A plan writes a page some root could hold, outside the run's roots. */
export const PLAN_OUTSIDE_WRITE_ROOTS_CODE = "plan-outside-write-roots" as const;
/** A plan writes a file no documentation root admits: not a page, or protected. */
export const PLAN_TARGET_NOT_WRITABLE_CODE = "plan-target-not-writable" as const;
/**
 * A plan writes an agent instruction file or a hidden path inside the roots
 * that the operator's request does not name; naming it in the request admits it.
 */
export const PLAN_TARGET_NOT_NAMED_CODE = "plan-target-not-named" as const;

/** Read only the host's exact not-named diagnostic, for its literal retry command. */
export function notNamedPlanWritePathsFromMessage(message: string): readonly string[] {
  const prefix = `${PLAN_TARGET_NOT_NAMED_CODE}: the plan writes `;
  const end = message.indexOf(". DocsFab writes", prefix.length);
  if (!message.startsWith(prefix) || end === -1) return [];
  const suffix = ` (${REFUSAL_TEXT["not-named"]})`;
  const list = message.slice(prefix.length, end);
  if (!list.endsWith(suffix)) return [];
  const paths = list.slice(0, -suffix.length).split(`${suffix}, `);
  return paths.every((path) => isDocumentationPlanPath(path)) ? paths : [];
}

const REFUSAL_TEXT: Readonly<Record<PlanWriteRefusal, string>> = {
  "not-a-page": "not a Markdown or MDX page",
  protected: "a source, CI, hidden, third-party, or agent instruction file",
  "outside-roots": "outside the documentation write roots",
  "navigation-outside-roots":
    "the repository's navigation file, outside the documentation write roots",
  "not-named": "an agent instruction file or hidden path the request does not name",
};

/** Refusals a `documentationRoots` entry fixes; any other path no root admits. */
const ROOT_FIXABLE_REFUSALS: ReadonlySet<PlanWriteRefusal> = new Set([
  "outside-roots",
  "navigation-outside-roots",
]);

/**
 * A local run's plan writes paths outside its write scope, each with the
 * reason. Plan admission refuses the plan by name before any write step. A
 * file no root admits takes `plan-target-not-writable`, since no root change
 * or naming helps; then a page outside the roots takes
 * `plan-outside-write-roots`, which a root fixes; otherwise the code is
 * `plan-target-not-named`, which naming the file in the request fixes.
 */
export class PlanWriteScopeError extends Error {
  public readonly code:
    | typeof PLAN_OUTSIDE_WRITE_ROOTS_CODE
    | typeof PLAN_TARGET_NOT_WRITABLE_CODE
    | typeof PLAN_TARGET_NOT_NAMED_CODE;

  public constructor(
    public readonly refused: readonly {
      readonly path: string;
      readonly refusal: PlanWriteRefusal;
    }[],
    public readonly roots: readonly string[],
  ) {
    const notWritable = refused.filter(
      (entry) => !ROOT_FIXABLE_REFUSALS.has(entry.refusal) && entry.refusal !== "not-named",
    );
    const notNamed = refused.filter((entry) => entry.refusal === "not-named");
    const code =
      notWritable.length > 0
        ? PLAN_TARGET_NOT_WRITABLE_CODE
        : refused.some((entry) => ROOT_FIXABLE_REFUSALS.has(entry.refusal))
          ? PLAN_OUTSIDE_WRITE_ROOTS_CODE
          : PLAN_TARGET_NOT_NAMED_CODE;
    // Paths passed the plan path grammar and roots the write-root grammar, so both are safe to name.
    const named = refused.map((entry) => `${entry.path} (${REFUSAL_TEXT[entry.refusal]})`);
    const remedies = [
      ...(notWritable.length > 0
        ? [
            "make the change to a file DocsFab does not write by hand, or ask for the Markdown page that documents it",
          ]
        : []),
      ...(refused.some((entry) => entry.refusal === "outside-roots")
        ? [
            "add each page outside the roots, or its directory, to documentationRoots in .docsfab.json and commit it, or ask only for pages inside the roots",
          ]
        : []),
      ...refused
        .filter((entry) => entry.refusal === "navigation-outside-roots")
        .map(
          (entry) =>
            `add the directory of ${entry.path}, ${entry.path.slice(0, Math.max(entry.path.lastIndexOf("/"), 0))}, to documentationRoots in .docsfab.json and commit it, or ask for a restructure that leaves the navigation unchanged`,
        ),
      ...(notNamed.length > 0
        ? [
            `name ${notNamed.map((entry) => entry.path).join(", ")} in the request by the exact path the repository uses, letter case included, if the change is meant, or ask for the change without ${notNamed.length === 1 ? "that file" : "those files"}`,
          ]
        : []),
    ];
    super(
      `${code}: the plan writes ${named.join(", ")}. DocsFab writes only Markdown and MDX ` +
        "pages under a directory root or exactly a file root" +
        (refused.some((entry) => entry.refusal === "navigation-outside-roots")
          ? ", and a restructure's navigation file under a root"
          : "") +
        ", never source, CI, or third-party files; an agent instruction file or a hidden path requires the request to name it; " +
        `the write roots are ${roots.length === 0 ? "none" : roots.join(", ")}. ` +
        `Nothing was written. Remediation: ${remedies.join("; ")}, then start a new run.`,
    );
    this.code = code;
    this.name = "PlanWriteScopeError";
  }
}

/**
 * The pages a plan addresses for its first-pass target control: an update plan
 * also addresses the pages it keeps unchanged; other modes address only
 * the pages they write.
 */
export function documentationPlanAddressedPaths(
  binding: DocumentationPlanBindingV1 | DocumentationPlanBindingV2,
): readonly string[] {
  return binding.mode === "update"
    ? documentationPlanVerificationPaths(binding)
    : documentationPlanWritePaths(binding);
}

/** How a planned CREATE target already exists in the run's repository revision. */
export type PlannedTargetCollisionKind = "file" | "directory" | "parent-file";

export interface PlannedTargetCollisionV1 {
  readonly path: string;
  readonly existing: PlannedTargetCollisionKind;
  /**
   * Present only when this exact path, letter case included, is a tracked
   * regular file at the run's revision: the page an UPDATE can start from.
   * Plan admission converts only such a collision.
   */
  readonly base?: { readonly sha256: string };
  /**
   * Present when the exact path is a tracked regular file but the run's write
   * grant does not cover modifying it, so no UPDATE can be delivered.
   */
  readonly updateRefused?: "write-grant";
}

function collisionWording(collision: PlannedTargetCollisionV1): string {
  if (collision.existing === "directory") return "is a directory";
  if (collision.existing === "parent-file") return "is under an existing file";
  if (collision.updateRefused === "write-grant") {
    return "exists, and the run's write grant does not cover modifying it";
  }
  return collision.base
    ? "exists"
    : "exists under another letter case or as a link, submodule, or excluded entry";
}

/** Where the host found the collision: before any page was written, or reconstructing one. */
export type CreateTargetExistsScope = "plan-admission" | "candidate-reconstruction";

/**
 * A CREATE plan targets a path the repository revision already holds in a
 * form no UPDATE can start from. The host refuses it by name. A tracked
 * regular file at the exact path is converted at plan admission instead.
 */
export class CreateTargetExistsError extends Error {
  public readonly code = "create-target-exists" as const;

  public constructor(
    public readonly collisions: readonly PlannedTargetCollisionV1[],
    public readonly scope: CreateTargetExistsScope,
  ) {
    // Paths passed the plan path grammar, so they are safe to name.
    const named = collisions
      .map((collision) => `${collision.path} ${collisionWording(collision)}`)
      .join("; ");
    const where =
      scope === "plan-admission"
        ? "Scope: CREATE plan admission, before any page was written."
        : "Scope: CREATE candidate reconstruction.";
    super(
      `create-target-exists: the CREATE plan targets ${String(collisions.length)} path(s) ` +
        `that already exist at the run's repository revision (${named}). ${where} ` +
        "Remediation: name a new path for the new page. To change an existing page, " +
        "name its exact tracked path or run update-documentation.",
    );
    this.name = "CreateTargetExistsError";
  }
}

/**
 * What CREATE plan admission does with the planned targets the run's revision
 * already holds, in this precedence:
 * - any collision no UPDATE can start from (a directory, a path under a file,
 *   a case variant, a link, a submodule, or an excluded entry) is refused;
 * - two or more existing pages leave the request's target ambiguous, so the
 *   run asks which page it means;
 * - exactly one existing page is converted into an UPDATE of it;
 * - no collision is a plain CREATE.
 */
export type CreateTargetAdmissionV1 =
  | { readonly kind: "create" }
  | { readonly kind: "refuse"; readonly collisions: readonly PlannedTargetCollisionV1[] }
  | { readonly kind: "ambiguous"; readonly paths: readonly string[] }
  | { readonly kind: "convert"; readonly path: string; readonly baseSha256: string };

export function admitCreateTargets(
  collisions: readonly PlannedTargetCollisionV1[],
): CreateTargetAdmissionV1 {
  if (collisions.length === 0) return { kind: "create" };
  if (collisions.some((collision) => collision.base === undefined)) {
    return { kind: "refuse", collisions };
  }
  // A CREATE request names one article; several existing ones cannot be
  // resolved to it without asking.
  if (collisions.length > 1) {
    return { kind: "ambiguous", paths: collisions.map((collision) => collision.path).sort() };
  }
  const [only] = collisions;
  return { kind: "convert", path: only!.path, baseSha256: only!.base!.sha256 };
}

/** The planner diagnostic code for a CREATE plan whose target is ambiguous. */
export const AMBIGUOUS_CREATE_TARGETS_CODE = "ambiguous-create-targets" as const;

/** The question the run asks when a CREATE plan's target is ambiguous. */
export function ambiguousCreateTargetsQuestion(paths: readonly string[]): string {
  // Paths passed the plan path grammar, so they are safe to name.
  return (
    `${AMBIGUOUS_CREATE_TARGETS_CODE}: the CREATE plan targets ${String(paths.length)} pages ` +
    `that already exist at the run's repository revision (${paths.join(", ")}). ` +
    "Which of them did the request mean? Rerun create-documentation with an instruction " +
    "that names the one existing page to update and new paths for any new pages, or run " +
    "update-documentation to change several existing pages."
  );
}

export type DocumentationPlanBindingErrorCode =
  | "invalid-shape"
  | "invalid-mode"
  | "empty-pages"
  | "invalid-path"
  | "duplicate-page"
  | "invalid-disposition"
  | "missing-source-binding"
  | "duplicate-source-binding"
  | "invalid-source"
  | "digest-mismatch"
  | "invalid-source-evidence"
  | "unknown-plan-variant"
  | "omitted-mandatory-obligation";

/** Fixed diagnostics only; never include the model's response or rejected values. */
export const DOCUMENTATION_PLAN_FAILURES = {
  "invalid-json":
    "Planner response was not valid JSON. Retry planning; this does not establish missing user input.",
  "invalid-envelope":
    "Planner response must contain summary and planBinding, or summary, outcome, and reason for a needs-input result.",
  "invalid-summary": "Planner response summary must be non-empty bounded text.",
  "invalid-shape": "Planner planBinding has missing, unexpected, or incorrectly typed fields.",
  "invalid-mode": "Planner planBinding mode does not match the requested documentation workflow.",
  "empty-pages": "Planner planBinding contains no documentation pages.",
  "invalid-path": "Planner planBinding contains an invalid documentation path.",
  "duplicate-page": "Planner planBinding lists the same documentation page more than once.",
  "invalid-disposition":
    "Planner planBinding contains a page action incompatible with the workflow.",
  "missing-source-binding":
    "Planner planBinding does not associate every changed page with its sources.",
  "duplicate-source-binding":
    "Planner planBinding associates sources with the same page more than once.",
  "invalid-source": "Planner planBinding contains empty, duplicate, or invalid source references.",
  "digest-mismatch":
    "Planner planBinding digest does not match its pages and sources. Retry planning; this is not an SCM authentication error.",
  "invalid-source-evidence":
    "Planner planBinding does not carry the complete admitted source-binding digest.",
  "unknown-plan-variant":
    "Planner planBinding uses an unrecognized plan schema version. No variant was assumed.",
  "omitted-mandatory-obligation":
    "Planner planBinding does not address a page the request named. An update plan changes each named page or keeps it unchanged (retain); a create or restructure plan writes it.",
  unknown:
    "Planner response could not be validated. Inspect the private run log; no cause has been established.",
} as const;

const MODES = new Set<DocumentationPlanMode>(["create", "update", "restructure"]);
const DISPOSITIONS = new Set<DocumentationPageDisposition>([
  "create",
  "update",
  "restructure",
  "retain",
  "move",
  "merge",
  "split",
  "out-of-scope",
]);
const SAFE_PATH = /^(?!\.)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9._/-]+$/u;
const SHA256 = /^[a-f0-9]{64}$/u;

export function throwDocumentationPlanBindingError(
  code: DocumentationPlanBindingErrorCode,
  rejection?: PlanSourceLocatorRejection,
): never {
  throw new DocumentationPlanBindingError(code, rejection);
}

function fail(
  code: DocumentationPlanBindingErrorCode,
  rejection?: PlanSourceLocatorRejection,
): never {
  return throwDocumentationPlanBindingError(code, rejection);
}

/** Refuse, naming the binding field the check read. */
function failAt(
  code: DocumentationPlanBindingErrorCode,
  location: DocumentationPlanBindingLocation,
  rejection?: PlanSourceLocatorRejection,
): never {
  throw new DocumentationPlanBindingError(code, rejection, location);
}

/** Whether `value` passes the plan's page path grammar, the one every recorded path passed. */
export function isDocumentationPlanPath(value: string): boolean {
  return SAFE_PATH.test(value) && !value.includes("\\");
}

function path(value: unknown, location: DocumentationPlanBindingLocation): string {
  if (typeof value !== "string" || !SAFE_PATH.test(value) || value.includes("\\")) {
    return failAt("invalid-path", location);
  }
  return value;
}

/**
 * Plan modes whose sources the host resolves to repository files: CREATE
 * derives source obligations from them and RESTRUCTURE reads its preservation
 * base from them. Their sources must satisfy the grammar that resolution uses.
 */
const RESOLVED_SOURCE_MODES: ReadonlySet<DocumentationPlanMode> = new Set([
  "create",
  "restructure",
]);

interface SourceAdmission {
  readonly mode: DocumentationPlanMode;
  /** Only for a fresh proposal, never a sealed binding. */
  readonly canonicalize: boolean;
  /** Present when the admitting step knows the run's revision. */
  readonly expectedRevision?: string;
}

function source(value: unknown, admission: SourceAdmission): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 4096 ||
    value.includes("\0")
  ) {
    return failAt("invalid-source", "$.sourceBindings[].sources[]");
  }
  if (!RESOLVED_SOURCE_MODES.has(admission.mode)) return value;
  // The grammar source-obligation derivation resolves with, so a plan this
  // admits cannot fail that step on its locators.
  const admitted = admitPlanSourceLocator(value, admission.expectedRevision);
  if (isPlanSourceLocatorRefusal(admitted)) {
    return failAt(
      "invalid-source",
      "$.sourceBindings[].sources[]",
      planSourceLocatorRejection(admitted.refusal),
    );
  }
  return admission.canonicalize ? admitted.canonical : value;
}

function planSourceLocatorRejection(refusal: PlanSourceLocatorRefusal): PlanSourceLocatorRejection {
  const location = "$.planBinding.sourceBindings[].sources[]";
  if (refusal === "revision-mismatch") {
    return rejectCorrectable(
      "plan-source-locator",
      "plan-source-locator-revision-mismatch",
      location,
    );
  }
  return rejectCorrectable("plan-source-locator", "plan-source-locator-grammar", location);
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function digestInput(
  mode: DocumentationPlanMode,
  pages: readonly DocumentationPlanPageV1[],
  sourceBindings: readonly DocumentationPlanSourceBindingV1[],
  createConvertedToUpdate: DocumentationPlanCreateConversionV1 | undefined,
  navigationCompanions: readonly DocumentationPlanNavigationCompanionV1[] | undefined,
): unknown {
  return {
    kind: DOCUMENTATION_PLAN_BINDING_KIND,
    schemaVersion: 1,
    mode,
    pages,
    sourceBindings,
    // Absent from the input when absent, so every unconverted digest is unchanged.
    ...(createConvertedToUpdate ? { createConvertedToUpdate } : {}),
    ...companionDigestInput(navigationCompanions),
  };
}

/**
 * Absent from a digest input when there is none, so every binding sealed
 * before companions existed keeps its digest; sorted by path otherwise.
 */
function companionDigestInput(
  companions: readonly DocumentationPlanNavigationCompanionV1[] | undefined,
): { navigationCompanions?: readonly DocumentationPlanNavigationCompanionV1[] } {
  if (!companions || companions.length === 0) return {};
  return {
    navigationCompanions: [...companions]
      .map((companion) => ({
        path: companion.path,
        role: companion.role,
        baseSha256: companion.baseSha256,
      }))
      .sort((left, right) => left.path.localeCompare(right.path)),
  };
}

export function documentationPlanBindingDigest(
  binding: Pick<DocumentationPlanBindingV1, "mode" | "pages" | "sourceBindings"> & {
    readonly createConvertedToUpdate?: DocumentationPlanCreateConversionV1;
    readonly navigationCompanions?: readonly DocumentationPlanNavigationCompanionV1[];
  },
): string {
  const pages = [...binding.pages].sort((left, right) => left.path.localeCompare(right.path));
  const sourceBindings = [...binding.sourceBindings]
    .map((entry) => ({
      pagePath: entry.pagePath,
      sources: [...entry.sources].sort((left, right) => left.localeCompare(right)),
    }))
    .sort((left, right) => left.pagePath.localeCompare(right.pagePath));
  return canonicalDigest(
    digestInput(
      binding.mode,
      pages,
      sourceBindings,
      binding.createConvertedToUpdate,
      binding.navigationCompanions,
    ),
  );
}

/**
 * What an admission checks beyond shape. When `expectedRevision` is given, a
 * CREATE or RESTRUCTURE source that names a revision must name this one, so a
 * wrong revision is a correctable planner refusal rather than a terminal
 * derivation failure.
 */
export interface DocumentationPlanAdmissionOptions {
  readonly expectedMode?: DocumentationPlanMode;
  readonly expectedRevision?: string;
}

/**
 * Whether a validation may rewrite source spellings: only a fresh proposal
 * the host is about to digest, never a sealed binding whose digest covers the
 * bytes it carries.
 */
const FRESH_PROPOSAL = true;

/** Seal a semantic planner response into the host-owned execution binding. */
export function createDocumentationPlanBinding(
  input: DocumentationPlanInputV1,
  options: DocumentationPlanAdmissionOptions = {},
): DocumentationPlanBindingV1 {
  // A fresh proposal: its sources are recorded canonically, then digested.
  const content = validateDocumentationPlanContent(
    {
      kind: DOCUMENTATION_PLAN_BINDING_KIND,
      schemaVersion: DOCUMENTATION_PLAN_BINDING_SCHEMA_VERSION,
      mode: input.mode,
      pages: input.pages,
      sourceBindings: input.sourceBindings,
    },
    options,
    FRESH_PROPOSAL,
  );
  return Object.freeze({ ...content, digest: documentationPlanBindingDigest(content) });
}

/** Accept either the legacy complete binding or the semantic model input. */
export function sealDocumentationPlanBinding(
  value: unknown,
  options: DocumentationPlanAdmissionOptions = {},
): DocumentationPlanBindingV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return failAt("invalid-shape", "$");
  }
  const item = value as Record<string, unknown>;
  if (Object.prototype.hasOwnProperty.call(item, "digest")) {
    return validateDocumentationPlanBinding(value, options);
  }
  if (
    !exactKeys(item, ["mode", "pages", "sourceBindings"]) ||
    !Array.isArray(item.pages) ||
    !Array.isArray(item.sourceBindings) ||
    typeof item.mode !== "string"
  ) {
    return failAt("invalid-shape", "$");
  }
  return createDocumentationPlanBinding(item as unknown as DocumentationPlanInputV1, options);
}

export function validateDocumentationPlanBinding(
  value: unknown,
  options: DocumentationPlanAdmissionOptions = {},
): DocumentationPlanBindingV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) return fail("invalid-shape");
  const digest = (value as Record<string, unknown>).digest;
  if (typeof digest !== "string") return fail("invalid-shape");
  const content = validateDocumentationPlanContent(value, options);
  if (!SHA256.test(digest) || digest !== documentationPlanBindingDigest(content)) {
    return fail("digest-mismatch");
  }
  return Object.freeze({ ...content, digest });
}

/**
 * Admit a fresh model proposal, not a persisted/approved binding. The host computes
 * its identity after structural validation; a model-supplied digest is not evidence.
 * This neither approves the proposed scope nor grants write/publication authority.
 */
export function bindDocumentationPlanProposal(
  value: unknown,
  options: DocumentationPlanAdmissionOptions = {},
): DocumentationPlanBindingV1 {
  // Planners emit semantic input, but a full proposal is still accepted.
  // Persisted bindings use strict digest validation.
  if (value && typeof value === "object" && !("kind" in value) && !("schemaVersion" in value)) {
    return sealDocumentationPlanBinding(value, options);
  }
  const content = validateDocumentationPlanContent(value, options, FRESH_PROPOSAL);
  return Object.freeze({ ...content, digest: documentationPlanBindingDigest(content) });
}

function validateDocumentationPlanContent(
  value: unknown,
  options: DocumentationPlanAdmissionOptions,
  canonicalize = false,
): Omit<DocumentationPlanBindingV1, "digest"> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return failAt("invalid-shape", "$");
  }
  const item = value as Record<string, unknown>;
  if (
    !exactKeys(item, [
      "kind",
      "schemaVersion",
      "mode",
      "pages",
      "sourceBindings",
      "digest",
      "createConvertedToUpdate",
      "navigationCompanions",
    ])
  ) {
    return failAt("invalid-shape", "$");
  }
  // Only the host converts, at plan admission; a fresh proposal never carries it.
  if (canonicalize && item.createConvertedToUpdate !== undefined) {
    return failAt("invalid-shape", "$.createConvertedToUpdate");
  }
  // Only the host adds companions, at plan admission; a fresh proposal never carries them.
  if (canonicalize && item.navigationCompanions !== undefined) {
    return failAt("invalid-shape", "$.navigationCompanions");
  }
  if (
    item.kind !== DOCUMENTATION_PLAN_BINDING_KIND ||
    item.schemaVersion !== DOCUMENTATION_PLAN_BINDING_SCHEMA_VERSION ||
    typeof item.mode !== "string" ||
    !Array.isArray(item.pages) ||
    !Array.isArray(item.sourceBindings) ||
    (item.digest !== undefined && typeof item.digest !== "string")
  ) {
    return failAt("invalid-shape", "$");
  }
  const mode = item.mode as DocumentationPlanMode;
  if (!MODES.has(mode)) return failAt("invalid-mode", "$.mode");
  if (options.expectedMode && mode !== options.expectedMode) {
    return failAt("invalid-mode", "$.mode");
  }
  if (item.pages.length === 0) return failAt("empty-pages", "$.pages");
  const conversion =
    item.createConvertedToUpdate === undefined
      ? undefined
      : createConversion(item.createConvertedToUpdate, mode);

  const pages = item.pages.map((raw) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      return failAt("invalid-shape", "$.pages[]");
    }
    const page = raw as Record<string, unknown>;
    if (!exactKeys(page, ["path", "disposition"])) return failAt("invalid-shape", "$.pages[]");
    const pagePath = path(page.path, "$.pages[].path");
    const disposition = page.disposition as DocumentationPageDisposition;
    if (!DISPOSITIONS.has(disposition)) {
      return failAt("invalid-disposition", "$.pages[].disposition");
    }
    if (
      (mode === "create" &&
        disposition !== "create" &&
        disposition !== "retain" &&
        disposition !== "out-of-scope" &&
        // The one page the host converted, and no other, is an UPDATE.
        !(disposition === "update" && pagePath === conversion?.path)) ||
      (mode === "update" &&
        disposition !== "update" &&
        disposition !== "retain" &&
        disposition !== "out-of-scope") ||
      (mode === "restructure" &&
        !["restructure", "move", "merge", "split", "retain", "out-of-scope"].includes(disposition))
    ) {
      return failAt("invalid-disposition", "$.pages[].disposition");
    }
    return { path: pagePath, disposition };
  });
  pages.sort((left, right) => left.path.localeCompare(right.path));
  if (new Set(pages.map((page) => page.path)).size !== pages.length) {
    return failAt("duplicate-page", "$.pages[].path");
  }

  const sourceBindings = item.sourceBindings.map((raw) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      return failAt("invalid-shape", "$.sourceBindings[]");
    }
    const binding = raw as Record<string, unknown>;
    if (!exactKeys(binding, ["pagePath", "sources"])) {
      return failAt("invalid-shape", "$.sourceBindings[]");
    }
    if (!Array.isArray(binding.sources)) {
      return failAt("invalid-shape", "$.sourceBindings[].sources");
    }
    const pagePath = path(binding.pagePath, "$.sourceBindings[].pagePath");
    const admission: SourceAdmission = {
      mode,
      canonicalize,
      ...(options.expectedRevision === undefined
        ? {}
        : { expectedRevision: options.expectedRevision }),
    };
    const sources = binding.sources
      .map((value) => source(value, admission))
      .sort((left, right) => left.localeCompare(right));
    if (sources.length === 0 || new Set(sources).size !== sources.length)
      return failAt("invalid-source", "$.sourceBindings[].sources");
    return { pagePath, sources };
  });
  sourceBindings.sort((left, right) => left.pagePath.localeCompare(right.pagePath));
  if (new Set(sourceBindings.map((binding) => binding.pagePath)).size !== sourceBindings.length) {
    return failAt("duplicate-source-binding", "$.sourceBindings[].pagePath");
  }
  const plannedPaths = new Set(
    pages
      .filter((page) => page.disposition !== "retain" && page.disposition !== "out-of-scope")
      .map((page) => page.path),
  );
  // A retained page may bind evidence for independent verification, but it
  // never becomes a write target. Out-of-scope pages cannot bind evidence.
  const evidencePagePaths = new Set(
    pages.filter((page) => page.disposition !== "out-of-scope").map((page) => page.path),
  );
  if (sourceBindings.some((binding) => !evidencePagePaths.has(binding.pagePath))) {
    return failAt("missing-source-binding", "$.sourceBindings[].pagePath");
  }
  for (const plannedPath of plannedPaths) {
    if (!sourceBindings.some((binding) => binding.pagePath === plannedPath))
      return failAt("missing-source-binding", "$.sourceBindings");
  }
  // A page the plan writes is never its own original source: its content at
  // the revision is the base an update keeps. Refused here, where the planner
  // can correct it; source-obligation derivation refuses it again for a
  // sealed binding, which this check does not re-read.
  if (canonicalize && mode === "create") {
    const writesItsOwnSource = sourceBindings.some((binding) =>
      binding.sources.some((value) => {
        const admitted = admitPlanSourceLocator(value, options.expectedRevision);
        return !isPlanSourceLocatorRefusal(admitted) && plannedPaths.has(admitted.path);
      }),
    );
    if (writesItsOwnSource) {
      return failAt(
        "invalid-source",
        "$.sourceBindings[].sources[]",
        rejectCorrectable(
          "documentation-plan",
          "documentation-plan-source-write-target",
          "$.planBinding.sourceBindings[].sources[]",
        ),
      );
    }
  }
  if (
    conversion &&
    !pages.some((page) => page.path === conversion.path && page.disposition === "update")
  ) {
    return failAt("invalid-disposition", "$.createConvertedToUpdate");
  }
  const companions =
    item.navigationCompanions === undefined
      ? undefined
      : navigationCompanions(item.navigationCompanions, mode, pages);
  return Object.freeze({
    kind: DOCUMENTATION_PLAN_BINDING_KIND,
    schemaVersion: 1,
    mode,
    pages: Object.freeze(pages),
    sourceBindings: Object.freeze(sourceBindings),
    ...(conversion ? { createConvertedToUpdate: conversion } : {}),
    ...(companions ? { navigationCompanions: companions } : {}),
  });
}

const NAVIGATION_COMPANION_KEYS = ["baseSha256", "path", "role"] as const;

/**
 * The companions' shape, admitted only in a RESTRUCTURE plan: a non-empty,
 * path-sorted, duplicate-free list whose paths are never also pages. An empty
 * list is refused because the field is absent when there is none, which keeps
 * the digest of every companion-free binding unchanged.
 */
function navigationCompanions(
  value: unknown,
  mode: DocumentationPlanMode,
  pages: readonly DocumentationPlanPageV1[],
): readonly DocumentationPlanNavigationCompanionV1[] {
  if (mode !== "restructure" || !Array.isArray(value) || value.length === 0) {
    return failAt("invalid-shape", "$.navigationCompanions");
  }
  const companions = value.map((raw) => {
    if (
      !raw ||
      typeof raw !== "object" ||
      Array.isArray(raw) ||
      Object.keys(raw).sort().join("\0") !== NAVIGATION_COMPANION_KEYS.join("\0")
    ) {
      return failAt("invalid-shape", "$.navigationCompanions");
    }
    const item = raw as Record<string, unknown>;
    if (
      !(NAVIGATION_COMPANION_ROLES as readonly unknown[]).includes(item.role) ||
      typeof item.baseSha256 !== "string" ||
      !SHA256.test(item.baseSha256)
    ) {
      return failAt("invalid-shape", "$.navigationCompanions");
    }
    return Object.freeze({
      path: path(item.path, "$.navigationCompanions"),
      role: item.role as NavigationCompanionRole,
      baseSha256: item.baseSha256,
    });
  });
  const paths = companions.map((companion) => companion.path);
  if (
    paths.some((candidate, index) => index > 0 && paths[index - 1]!.localeCompare(candidate) >= 0)
  ) {
    return failAt("invalid-shape", "$.navigationCompanions");
  }
  if (pages.some((page) => paths.includes(page.path))) {
    return failAt("duplicate-page", "$.navigationCompanions");
  }
  return Object.freeze(companions);
}

const CREATE_CONVERSION_KEYS = ["baseSha256", "path", "reason"] as const;

/** The conversion's shape, admitted only in a CREATE plan. */
function createConversion(
  value: unknown,
  mode: DocumentationPlanMode,
): DocumentationPlanCreateConversionV1 {
  if (
    mode !== "create" ||
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).sort().join("\0") !== CREATE_CONVERSION_KEYS.join("\0")
  ) {
    return failAt("invalid-shape", "$.createConvertedToUpdate");
  }
  const item = value as Record<string, unknown>;
  if (
    !isCreateConversionReason(item.reason) ||
    typeof item.baseSha256 !== "string" ||
    !SHA256.test(item.baseSha256)
  ) {
    return failAt("invalid-shape", "$.createConvertedToUpdate");
  }
  return Object.freeze({
    reason: item.reason,
    path: path(item.path, "$.createConvertedToUpdate"),
    baseSha256: item.baseSha256,
  });
}

/**
 * Every path the plan authorizes a writer to change: its mutating pages and
 * the host's navigation companions. Authority consumers read this.
 */
export function documentationPlanWritePaths(
  binding: DocumentationPlanBindingV1 | DocumentationPlanBindingV2,
): readonly string[] {
  return [
    ...documentationPlanPagePaths(binding),
    ...(binding.navigationCompanions ?? []).map((companion) => companion.path),
  ].sort((left, right) => left.localeCompare(right));
}

/**
 * The plan's mutating pages only, without navigation companions. Page-coverage
 * consumers read this: verification, source obligations, and candidate
 * evidence cover pages, never the index a companion links them from.
 */
export function documentationPlanPagePaths(
  binding: DocumentationPlanBindingV1 | DocumentationPlanBindingV2,
): readonly string[] {
  return binding.pages
    .filter((page) => page.disposition !== "retain" && page.disposition !== "out-of-scope")
    .map((page) => page.path)
    .sort((left, right) => left.localeCompare(right));
}

/** Pages whose claims an independent verifier must cover, including retained no-change pages. */
export function documentationPlanVerificationPaths(
  binding: DocumentationPlanBindingV1 | DocumentationPlanBindingV2,
): readonly string[] {
  return binding.pages
    .filter((page) => page.disposition !== "out-of-scope")
    .map((page) => page.path)
    .sort((left, right) => left.localeCompare(right));
}

const DOCUMENTATION_PLAN_CONSUMER_SKILLS = new Set([
  "write-documentation",
  "lint-documentation",
  "verify-technical-accuracy",
  "review-documentation",
]);

/** Write, verify, and review steps that must see the admitted planner page map. */
export function documentationPlanConsumerSkill(skill: string): boolean {
  return DOCUMENTATION_PLAN_CONSUMER_SKILLS.has(skill);
}

export const DOCUMENTATION_PLAN_BINDING_V2_SCHEMA_VERSION = 2 as const;

/**
 * Source-aware plan binding: the admitted plan plus the full source-binding
 * digest. Its digest input carries `schemaVersion: 2` and `sourceBindingSha256`
 * so it cannot collide with the V1 digest of the same pages and sources.
 * No-source runs emit V1.
 */
export interface DocumentationPlanBindingV2 {
  kind: typeof DOCUMENTATION_PLAN_BINDING_KIND;
  schemaVersion: typeof DOCUMENTATION_PLAN_BINDING_V2_SCHEMA_VERSION;
  mode: DocumentationPlanMode;
  pages: readonly DocumentationPlanPageV1[];
  sourceBindings: readonly DocumentationPlanSourceBindingV1[];
  /** The complete admitted `SourceBindingV1.bindingSha256`, never truncated. */
  sourceBindingSha256: string;
  /** Present only on a CREATE plan the host converted at admission. */
  createConvertedToUpdate?: DocumentationPlanCreateConversionV1;
  /** Present only on a RESTRUCTURE plan the host gave companions at admission. */
  navigationCompanions?: readonly DocumentationPlanNavigationCompanionV1[];
  digest: string;
}

export type AdmittedDocumentationPlanBinding =
  | DocumentationPlanBindingV1
  | DocumentationPlanBindingV2;

export function documentationPlanBindingV2Digest(
  binding: Pick<
    DocumentationPlanBindingV2,
    | "mode"
    | "pages"
    | "sourceBindings"
    | "sourceBindingSha256"
    | "createConvertedToUpdate"
    | "navigationCompanions"
  >,
): string {
  if (
    typeof binding.sourceBindingSha256 !== "string" ||
    !SHA256.test(binding.sourceBindingSha256)
  ) {
    return fail("invalid-source-evidence");
  }
  const pages = [...binding.pages].sort((left, right) => left.path.localeCompare(right.path));
  const sourceBindings = [...binding.sourceBindings]
    .map((entry) => ({
      pagePath: entry.pagePath,
      sources: [...entry.sources].sort((left, right) => left.localeCompare(right)),
    }))
    .sort((left, right) => left.pagePath.localeCompare(right.pagePath));
  return canonicalDigest({
    kind: DOCUMENTATION_PLAN_BINDING_KIND,
    schemaVersion: DOCUMENTATION_PLAN_BINDING_V2_SCHEMA_VERSION,
    mode: binding.mode,
    pages,
    sourceBindings,
    sourceBindingSha256: binding.sourceBindingSha256,
    // Absent from the input when absent, so every unconverted digest is unchanged.
    ...(binding.createConvertedToUpdate
      ? { createConvertedToUpdate: binding.createConvertedToUpdate }
      : {}),
    ...companionDigestInput(binding.navigationCompanions),
  });
}

/** Seal a validated planner proposal against the admitted source binding. */
export function createSourceAwareDocumentationPlanBinding(
  input: DocumentationPlanInputV1,
  sourceBindingSha256: string,
  options: DocumentationPlanAdmissionOptions = {},
): DocumentationPlanBindingV2 {
  const content = validateDocumentationPlanContent(
    {
      kind: DOCUMENTATION_PLAN_BINDING_KIND,
      schemaVersion: DOCUMENTATION_PLAN_BINDING_SCHEMA_VERSION,
      mode: input.mode,
      pages: input.pages,
      sourceBindings: input.sourceBindings,
    },
    options,
    FRESH_PROPOSAL,
  );
  const body = {
    kind: DOCUMENTATION_PLAN_BINDING_KIND,
    schemaVersion: DOCUMENTATION_PLAN_BINDING_V2_SCHEMA_VERSION,
    mode: content.mode,
    pages: content.pages,
    sourceBindings: content.sourceBindings,
    sourceBindingSha256,
  } as const;
  return Object.freeze({ ...body, digest: documentationPlanBindingV2Digest(body) });
}

export function validateSourceAwareDocumentationPlanBinding(
  value: unknown,
  options: DocumentationPlanAdmissionOptions = {},
): DocumentationPlanBindingV2 {
  if (!value || typeof value !== "object" || Array.isArray(value)) return fail("invalid-shape");
  const item = value as Record<string, unknown>;
  if (
    !exactKeys(item, [
      "kind",
      "schemaVersion",
      "mode",
      "pages",
      "sourceBindings",
      "sourceBindingSha256",
      "digest",
      "createConvertedToUpdate",
      "navigationCompanions",
    ]) ||
    item.schemaVersion !== DOCUMENTATION_PLAN_BINDING_V2_SCHEMA_VERSION
  ) {
    return fail("invalid-shape");
  }
  if (typeof item.sourceBindingSha256 !== "string" || !SHA256.test(item.sourceBindingSha256)) {
    return fail("invalid-source-evidence");
  }
  const content = validateDocumentationPlanContent(
    {
      kind: item.kind,
      schemaVersion: DOCUMENTATION_PLAN_BINDING_SCHEMA_VERSION,
      mode: item.mode,
      pages: item.pages,
      sourceBindings: item.sourceBindings,
      ...(item.createConvertedToUpdate === undefined
        ? {}
        : { createConvertedToUpdate: item.createConvertedToUpdate }),
      ...(item.navigationCompanions === undefined
        ? {}
        : { navigationCompanions: item.navigationCompanions }),
    },
    options,
  );
  const conversion = content.createConvertedToUpdate;
  const companions = content.navigationCompanions;
  const body = {
    kind: DOCUMENTATION_PLAN_BINDING_KIND,
    schemaVersion: DOCUMENTATION_PLAN_BINDING_V2_SCHEMA_VERSION,
    mode: content.mode,
    pages: content.pages,
    sourceBindings: content.sourceBindings,
    sourceBindingSha256: item.sourceBindingSha256,
    ...(conversion ? { createConvertedToUpdate: conversion } : {}),
    ...(companions ? { navigationCompanions: companions } : {}),
  } as const;
  const digest = documentationPlanBindingV2Digest(body);
  if (typeof item.digest !== "string" || item.digest !== digest) return fail("digest-mismatch");
  return Object.freeze({ ...body, digest });
}

export function isSourceAwareDocumentationPlanBinding(
  value: unknown,
): value is DocumentationPlanBindingV2 {
  return (
    !!value &&
    typeof value === "object" &&
    (value as Record<string, unknown>).schemaVersion ===
      DOCUMENTATION_PLAN_BINDING_V2_SCHEMA_VERSION &&
    (value as Record<string, unknown>).kind === DOCUMENTATION_PLAN_BINDING_KIND
  );
}

/**
 * Validate whichever admitted variant this is, by its explicit kind/version
 * pair. An unfamiliar variant is rejected visibly; it is never coerced into a
 * V1 projection, which would silently drop source identity.
 */
export function validateAdmittedDocumentationPlanBinding(
  value: unknown,
  options: DocumentationPlanAdmissionOptions = {},
): AdmittedDocumentationPlanBinding {
  if (!value || typeof value !== "object" || Array.isArray(value)) return fail("invalid-shape");
  const version = (value as Record<string, unknown>).schemaVersion;
  if (version === DOCUMENTATION_PLAN_BINDING_V2_SCHEMA_VERSION) {
    return validateSourceAwareDocumentationPlanBinding(value, options);
  }
  if (version === DOCUMENTATION_PLAN_BINDING_SCHEMA_VERSION) {
    return validateDocumentationPlanBinding(value, options);
  }
  return fail("unknown-plan-variant");
}

/**
 * The digest an editorial decision must bind. It is the admitted variant's own
 * digest, so a V2 plan can never be recorded under a V1 identity.
 */
export function admittedDocumentationPlanBindingSha256(
  binding: AdmittedDocumentationPlanBinding,
): string {
  if (isSourceAwareDocumentationPlanBinding(binding)) {
    return documentationPlanBindingV2Digest(binding);
  }
  if (binding.schemaVersion !== DOCUMENTATION_PLAN_BINDING_SCHEMA_VERSION) {
    return fail("unknown-plan-variant");
  }
  return documentationPlanBindingDigest(binding);
}

/**
 * Convert the one planned CREATE page the run's revision already holds, as a
 * tracked regular file at that exact path, into an UPDATE of that page.
 * Plan admission is the only caller. The result keeps the mode, the write
 * paths, and the sources, records the page's base digest, and re-admits
 * through the same validator every later reader uses.
 */
export function convertCreatePlanPageToUpdate(
  binding: AdmittedDocumentationPlanBinding,
  target: { readonly path: string; readonly baseSha256: string },
  reason: CreateConversionReason,
): AdmittedDocumentationPlanBinding {
  const page = binding.pages.find((candidate) => candidate.path === target.path);
  if (binding.mode !== "create" || binding.createConvertedToUpdate !== undefined) {
    return failAt("invalid-mode", "$.mode");
  }
  if (!page || page.disposition !== "create") {
    return failAt("invalid-disposition", "$.createConvertedToUpdate");
  }
  const createConvertedToUpdate: DocumentationPlanCreateConversionV1 = {
    reason,
    path: target.path,
    baseSha256: target.baseSha256,
  };
  const pages = binding.pages.map((candidate) =>
    candidate.path === target.path
      ? { path: candidate.path, disposition: "update" as const }
      : candidate,
  );
  const { digest: _planned, ...rest } = binding;
  const body = { ...rest, pages, createConvertedToUpdate };
  const digest = isSourceAwareDocumentationPlanBinding(binding)
    ? documentationPlanBindingV2Digest(body as Omit<DocumentationPlanBindingV2, "digest">)
    : documentationPlanBindingDigest(body);
  return validateAdmittedDocumentationPlanBinding({ ...body, digest }, { expectedMode: "create" });
}

/**
 * Attach the host's navigation companions to an admitted RESTRUCTURE plan.
 * Plan admission is the only caller, after its target checks have read the
 * plan's pages. The result keeps the pages and sources, binds the companions
 * into the digest, and re-admits through the same validator every later
 * reader uses, which refuses a companion that is also a page.
 */
export function attachNavigationCompanions(
  binding: AdmittedDocumentationPlanBinding,
  companions: readonly DocumentationPlanNavigationCompanionV1[],
): AdmittedDocumentationPlanBinding {
  if (binding.mode !== "restructure" || binding.navigationCompanions !== undefined) {
    return failAt("invalid-mode", "$.mode");
  }
  if (companions.length === 0) return binding;
  const navigationCompanions = [...companions].sort((left, right) =>
    left.path.localeCompare(right.path),
  );
  const { digest: _planned, ...rest } = binding;
  const body = { ...rest, navigationCompanions };
  const digest = isSourceAwareDocumentationPlanBinding(binding)
    ? documentationPlanBindingV2Digest(body as Omit<DocumentationPlanBindingV2, "digest">)
    : documentationPlanBindingDigest(body);
  return validateAdmittedDocumentationPlanBinding(
    { ...body, digest },
    { expectedMode: "restructure" },
  );
}

const PROPOSED_UPDATE_DISPOSITIONS: ReadonlySet<unknown> = new Set([
  "update",
  "retain",
  "out-of-scope",
]);

/**
 * A CREATE planner's semantic proposal that says `mode: "update"`, re-read as
 * the CREATE proposal of the same pages (`update` pages become `create`), or
 * `undefined` when the value is not that shape. It only re-reads: the result
 * still passes the CREATE validator, and plan admission converts the pages
 * back to UPDATE only when every one exists and passes the conversion's
 * eligibility. Any other shape keeps the mode refusal.
 */
export function createProposalFromProposedUpdate(
  value: unknown,
): DocumentationPlanInputV1 | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const item = value as Record<string, unknown>;
  if (
    Object.keys(item).sort().join("\0") !== ["mode", "pages", "sourceBindings"].join("\0") ||
    item.mode !== "update" ||
    !Array.isArray(item.pages) ||
    !Array.isArray(item.sourceBindings)
  ) {
    return undefined;
  }
  const pages = item.pages as unknown[];
  const shaped = pages.every(
    (page) =>
      !!page &&
      typeof page === "object" &&
      !Array.isArray(page) &&
      PROPOSED_UPDATE_DISPOSITIONS.has((page as Record<string, unknown>).disposition),
  );
  if (
    !shaped ||
    !pages.some((page) => (page as Record<string, unknown>).disposition === "update")
  ) {
    return undefined;
  }
  return {
    mode: "create",
    pages: pages.map((page) => {
      const entry = page as Record<string, unknown>;
      return (entry.disposition === "update"
        ? { ...entry, disposition: "create" }
        : entry) as unknown as DocumentationPlanPageV1;
    }),
    sourceBindings: item.sourceBindings as unknown as DocumentationPlanSourceBindingV1[],
  };
}
