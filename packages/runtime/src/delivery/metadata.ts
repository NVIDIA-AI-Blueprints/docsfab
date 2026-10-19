// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";

import type { WorkflowOutcomeEnvelopeV1, WorkflowName } from "../workflow-contracts/contracts.js";
import * as workflowCatalog from "../workflow-registry/catalog.js";
import {
  containsConfiguredCredentialText,
  deliveryCredentialRuleIds,
  type LocalUserPublicationPlan,
} from "./contracts.js";
import { canonicalizeJsonEvidence, type JsonEvidenceValue } from "../json-evidence.js";
import { scmDeliveryIdempotencyKey } from "./receipt.js";
import {
  assertPublicationEvidenceProjection,
  projectPublicationEvidenceFromRunLineage,
  type PublicationEvidenceProjectionV1,
} from "../publication/index.js";
import type { VerifiedPublicationRun } from "./preflight.js";
import { createBoundedInstructionRequestIdentity } from "../lineage/contracts.js";
import {
  outsideEgressPlaceholders,
  runtimeEgressRootSet,
  withoutEgressPlaceholders,
} from "../config/egress-roots.js";
import { egressText, type HostRootSet } from "../security/egress.js";
import { findConfiguredCredential } from "../security/configured-credentials.js";
import {
  type CredentialFinding,
  formatCredentialFindingNotes,
  sortCredentialFindings,
} from "../security/credential-findings.js";
import {
  AUTHORIZATION_HEADER_RULE_ID,
  URL_USERINFO_RULE_ID,
  credentialFindingsAt,
  isShowableCredentialFinding,
  PRIVATE_TOKEN_HEADER_RULE_ID,
  recordCredentialFindings,
} from "../security/credential-shape-findings.js";
import { REQUIRED_CHECK_NOT_RUN_LIMITATION } from "../workflow-execution/required-check-limitation.js";

const MAX_TITLE = 120;
const MAX_DESCRIPTION = 8_192;
const MAX_OUTCOME = 160;
const MAX_INSTRUCTION = 512;
const MAX_RAW_OUTCOME = 4_096;
const MAX_PATHS = 100;
const FALLBACK_OUTCOME = "Governed documentation update";
/** Leads every composition-path draft MR title, so its non-release evidence is visible in lists. */
export const COMPOSITION_TITLE_PREFIX = "COMPOSITION — ";
const COMPOSITION_MARKER_NAME = "docsfab-composition-execution";
const COMPOSITION_WARNING =
  "> [!WARNING]\n> Composition-path execution evidence only. Technical approval and role qualification are not established. This draft is not release eligible.";
const SAFE_PATH =
  /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[^\0\r\n`<>\u202a-\u202e\u2066-\u2069]{1,512}$/u;
const MARKDOWN_DECORATION = /[`*~\[\]]/gu;
/** Injection-class characters that are not Markdown decoration. */
const REMAINING_INJECTION = /[<>()`!#\\]/u;
/** Where the Notes block names credential-like content in a published field. */
const WORKFLOW_OUTCOME_LOCATION = "publication:workflowOutcome";
const CHANGED_PATHS_LOCATION = "publication:changedPaths";
const INSTRUCTION_LOCATION = "publication:instruction";
const REQUIRED_CHECK_LIMITATIONS_LOCATION = "publication:requiredCheckLimitations";

export interface DocsFabPublicationMetadataInput {
  plan: LocalUserPublicationPlan;
  workflowOutcome: string;
  changedPaths: readonly string[];
  /** Governed workflow id from the verified publication run record. */
  workflowId?: WorkflowName;
  /**
   * Ephemeral operator instruction from the verified run record. Projected into
   * the STAR Task section only for operator-directed runs.
   */
  instruction?: string;
  /**
   * Request digest from sealed task-lineage when present; binds projected
   * instruction text for bounded-instruction requests.
   */
  requestSha256?: string | null;
  /** Validated product outcome envelope from the run record when recorded. */
  productOutcome?: WorkflowOutcomeEnvelopeV1;
  /**
   * The verified run's "required check could not run" lines (#1918). The
   * description lists them under Notes so maintainers see which commands to
   * run, and adds `required-check-not-run` to the Situation limitations.
   */
  requiredCheckLimitations?: readonly string[];
  /**
   * Sealed evidence projection from this run's record, bound to the plan's
   * revision; free-form provenance is rejected. Absent means no provenance is inferred.
   */
  evidence?: PublicationEvidenceProjectionV1;
  /** Validated, content-minimized projection of the successful composition run aggregate. */
  compositionExecution?: CompositionPublicationBindingV1;
  /** This host's roots; the runtime root set of the current process when omitted. */
  hostRoots?: HostRootSet;
  /**
   * Content-free `credential-like-content` findings from the verified run
   * record (#1807). The draft MR's Notes block lists them for the maintainers,
   * with what this builder flags in the fields it publishes.
   */
  credentialFindings?: readonly CredentialFinding[];
}

export interface CompositionPublicationBindingV1 {
  readonly compositionId: string;
  readonly evidenceSha256: string;
  readonly aggregateSha256: string;
  readonly technicalApproval: "not-established";
  readonly roleQualification: "not-established";
  readonly releaseEligible: false;
}

export interface DocsFabPublicationMetadata {
  commitMessage: string;
  mergeRequestTitle: string;
  mergeRequestDescription: string;
  mergeRequestProvenanceMarker: string;
  /** Present only for composition publication; absence preserves the legacy metadata shape. */
  mergeRequestCompositionMarker?: string;
  /** Exact visible warning required beside a composition marker. */
  mergeRequestCompositionWarning?: string;
}

const MERGE_REQUEST_TITLE_PREFIX = "Draft: [DocsFab Run] ";
const COMPOSITION_MERGE_REQUEST_TITLE_PREFIX = "Draft: [DocsFab] ";
const PROVENANCE_MARKER_NAME = "docsfab-publication-provenance";

export function publicationMetadataInputDigests(
  workflowOutcome: string,
  changedPaths: readonly string[],
  compositionExecution?: CompositionPublicationBindingV1,
): {
  workflowOutcomeSha256: string;
  changedPathsSha256: string;
  selectedCompositionId?: string;
  compositionEvidenceSha256?: string;
  compositionAggregateSha256?: string;
  compositionMarkerSha256?: string;
} {
  const paths = [...changedPaths].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
  const execution =
    compositionExecution === undefined
      ? undefined
      : assertCompositionPublicationBinding(compositionExecution);
  const compositionMarker = execution
    ? buildDocsFabCompositionExecutionMarker(execution)
    : undefined;
  return Object.freeze({
    workflowOutcomeSha256: createHash("sha256").update(workflowOutcome).digest("hex"),
    changedPathsSha256: createHash("sha256")
      .update(canonicalizeJsonEvidence(paths as unknown as JsonEvidenceValue))
      .digest("hex"),
    ...(execution
      ? {
          selectedCompositionId: execution.compositionId,
          compositionEvidenceSha256: execution.evidenceSha256,
          compositionAggregateSha256: execution.aggregateSha256,
          compositionMarkerSha256: createHash("sha256")
            .update(compositionMarker!, "utf8")
            .digest("hex"),
        }
      : {}),
  });
}

export function compositionPublicationBindingFromMetadata(value: {
  readonly selectedCompositionId?: string;
  readonly compositionEvidenceSha256?: string;
  readonly compositionAggregateSha256?: string;
  readonly compositionMarkerSha256?: string;
}): CompositionPublicationBindingV1 | undefined {
  const fields = [
    value.selectedCompositionId,
    value.compositionEvidenceSha256,
    value.compositionAggregateSha256,
    value.compositionMarkerSha256,
  ];
  if (fields.every((field) => field === undefined)) return undefined;
  if (fields.some((field) => field === undefined)) fail();
  const result = createCompositionPublicationBinding({
    compositionId: value.selectedCompositionId!,
    evidenceSha256: value.compositionEvidenceSha256!,
    aggregateSha256: value.compositionAggregateSha256!,
  });
  const markerSha256 = createHash("sha256")
    .update(buildDocsFabCompositionExecutionMarker(result), "utf8")
    .digest("hex");
  if (markerSha256 !== value.compositionMarkerSha256) fail();
  return result;
}

export class DocsFabPublicationMetadataError extends Error {
  public readonly code = "invalid-publication-metadata" as const;

  public constructor() {
    super("DocsFab publication metadata rejected.");
    this.name = "DocsFabPublicationMetadataError";
  }
}

/** Freeze a safe publication projection after the sealed run aggregate was decoded. */
export function createCompositionPublicationBinding(input: {
  readonly compositionId: string;
  readonly evidenceSha256: string;
  readonly aggregateSha256: string;
}): CompositionPublicationBindingV1 {
  return assertCompositionPublicationBinding({
    compositionId: input.compositionId,
    evidenceSha256: input.evidenceSha256,
    aggregateSha256: input.aggregateSha256,
    technicalApproval: "not-established",
    roleQualification: "not-established",
    releaseEligible: false,
  });
}

export function assertCompositionPublicationBinding(
  value: CompositionPublicationBindingV1,
): CompositionPublicationBindingV1 {
  if (
    !value ||
    typeof value !== "object" ||
    Object.keys(value).sort().join("\0") !==
      [
        "aggregateSha256",
        "compositionId",
        "evidenceSha256",
        "releaseEligible",
        "roleQualification",
        "technicalApproval",
      ]
        .sort()
        .join("\0") ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value.compositionId) ||
    !/^[a-f0-9]{64}$/u.test(value.evidenceSha256) ||
    !/^[a-f0-9]{64}$/u.test(value.aggregateSha256) ||
    value.technicalApproval !== "not-established" ||
    value.roleQualification !== "not-established" ||
    value.releaseEligible !== false ||
    containsConfiguredCredentialText(JSON.stringify(value), "publication:compositionExecution")
  ) {
    fail();
  }
  return Object.freeze({ ...value });
}

/** Permanent content-minimized marker derived from the terminal run aggregate. */
export function buildDocsFabCompositionExecutionMarker(
  value: CompositionPublicationBindingV1,
): string {
  const execution = assertCompositionPublicationBinding(value);
  return `<!-- ${COMPOSITION_MARKER_NAME}:v1 composition=${execution.compositionId} evidence=${execution.evidenceSha256} aggregate=${execution.aggregateSha256} technical-approval=not-established role-qualification=not-established release-eligible=false -->`;
}

/** Build deterministic, content-minimized commit and draft-MR metadata. */
export function buildDocsFabPublicationMetadata(
  input: DocsFabPublicationMetadataInput,
): DocsFabPublicationMetadata {
  const roots = input.hostRoots ?? runtimeEgressRootSet();
  // What this builder flags in the fields it publishes; the record's own
  // findings join them in the Notes block.
  const fieldFindings: CredentialFinding[] = [];
  const catalogOutcome = boundedSummary(
    input.workflowOutcome,
    MAX_OUTCOME,
    input.plan.identity.gitlabUsername,
    roots,
    fieldFindings,
  );
  if (
    !Array.isArray(input.changedPaths) ||
    input.changedPaths.length === 0 ||
    input.changedPaths.length > MAX_PATHS ||
    input.changedPaths.length !== input.plan.patch.changedFileCount
  )
    fail();
  const paths = [...input.changedPaths];
  if (
    new Set(paths).size !== paths.length ||
    paths.some((path) => !SAFE_PATH.test(path) || configured(path))
  )
    fail();
  for (const path of paths) flagField(path, CHANGED_PATHS_LOCATION, fieldFindings);
  paths.sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
  if (input.instruction !== undefined && typeof input.instruction !== "string") fail();

  const evidence = validatedEvidence(input);
  const execution =
    input.compositionExecution === undefined
      ? undefined
      : assertCompositionPublicationBinding(input.compositionExecution);
  // Title and commit lead with the sealed disposition and codes when present;
  // catalog copy is never the sole Result claim.
  const titleSummary = projectResultTitleSummary(input.productOutcome, catalogOutcome);
  const commitTitle = truncateCodePoints(`DocsFab: ${titleSummary}`, MAX_TITLE);
  const visibleTitleSummary = `${execution ? COMPOSITION_TITLE_PREFIX : ""}${titleSummary}`;
  const titlePrefix = execution
    ? COMPOSITION_MERGE_REQUEST_TITLE_PREFIX
    : MERGE_REQUEST_TITLE_PREFIX;
  const title = `${titlePrefix}${truncateCodePoints(
    visibleTitleSummary,
    MAX_TITLE - codePointLength(titlePrefix),
  )}`;
  if (
    codePointLength(title) > MAX_TITLE ||
    countOccurrences(title, execution ? "[DocsFab]" : "[DocsFab Run]") !== 1
  )
    fail();
  const pathDigest = createHash("sha256").update(paths.join("\0")).digest("hex");
  const validationDigest = createHash("sha256").update(input.plan.validationCommand).digest("hex");
  const rawCommitMessage =
    [
      commitTitle,
      "",
      `DocsFab-Run: ${input.plan.run.id}`,
      `DocsFab-Source-Revision: ${input.plan.baseRevision}`,
      `DocsFab-Patch-SHA256: ${input.plan.patch.sha256}`,
      ...(execution
        ? [
            `DocsFab-Composition: ${execution.compositionId}`,
            `DocsFab-Composition-Evidence-SHA256: ${execution.evidenceSha256}`,
            `DocsFab-Composition-Aggregate-SHA256: ${execution.aggregateSha256}`,
            "DocsFab-Technical-Approval: not-established",
            "DocsFab-Role-Qualification: not-established",
            "DocsFab-Release-Eligible: false",
          ]
        : []),
      ...(evidence ? [`DocsFab-Evidence-SHA256: ${evidence.evidenceProjectionSha256}`] : []),
      ...(evidence && evidence.provenanceAvailable
        ? [`DocsFab-Task-Origin: ${evidence.taskOrigin}`]
        : []),
    ].join("\n") + "\n";
  const compositionMarker = execution
    ? buildDocsFabCompositionExecutionMarker(execution)
    : undefined;
  const provenanceMarker = buildDocsFabPublicationProvenanceMarker(input.plan, execution);
  const starSections = renderStarSections({
    catalogOutcome,
    paths,
    plan: input.plan,
    pathDigest,
    validationDigest,
    workflowId: input.workflowId,
    instruction: input.instruction,
    requestSha256: input.requestSha256,
    productOutcome: input.productOutcome,
    requiredCheckNotRun: (input.requiredCheckLimitations?.length ?? 0) > 0,
    evidence,
    operatorUsername: input.plan.identity.gitlabUsername,
    roots,
    findings: fieldFindings,
  });
  const machineFooter = renderMachineFooter({
    catalogOutcome,
    plan: input.plan,
    pathDigest,
    validationDigest,
    paths,
    evidence,
    compositionExecution: execution,
  });
  // One Notes block: the required checks that could not run (#1918), then the
  // credential-like content findings (#1807).
  const describe =
    (checkNotes: readonly string[]) =>
    (findingNotes: readonly string[]): string =>
      egress(
        [
          ...(execution ? [COMPOSITION_WARNING, ""] : []),
          ...starSections,
          ...notesBlock([...checkNotes, ...findingNotes]),
          "---",
          "",
          ...machineFooter,
          provenanceMarker,
          ...(compositionMarker ? [compositionMarker] : []),
        ].join("\n"),
        roots,
      );
  const commitMessage = egress(rawCommitMessage, roots);
  const checkNotes = fitRequiredCheckNotes(
    projectRequiredCheckLines(input.requiredCheckLimitations, roots),
    input.plan.run.id,
    (notes) => describe(notes)([]).length <= MAX_DESCRIPTION,
  );
  // Only a line the description shows is flagged.
  for (const line of checkNotes.shown) {
    flagField(line, REQUIRED_CHECK_LIMITATIONS_LOCATION, fieldFindings);
  }
  const description = describeWithNotes(
    sortCredentialFindings([...(input.credentialFindings ?? []), ...fieldFindings]),
    describe(checkNotes.notes),
  );
  if (
    commitMessage.length > 2_048 ||
    description.length > MAX_DESCRIPTION ||
    configured(commitMessage) ||
    configured(description)
  )
    fail();
  return Object.freeze({
    commitMessage,
    mergeRequestTitle: title,
    mergeRequestDescription: description,
    mergeRequestProvenanceMarker: provenanceMarker,
    ...(compositionMarker
      ? {
          mergeRequestCompositionMarker: compositionMarker,
          mergeRequestCompositionWarning: COMPOSITION_WARNING,
        }
      : {}),
  });
}

/**
 * The metadata a run's own publication carried, rebuilt from its plan and its
 * verified run record exactly as the publisher built it. An advance adopts the
 * parent's MR only while that MR still carries this root provenance (and, for a
 * composition draft, the exact title, composition marker, and warning).
 */
export function buildRunPublicationMetadata(
  plan: LocalUserPublicationPlan,
  run: VerifiedPublicationRun,
  hostRoots?: HostRootSet,
): DocsFabPublicationMetadata {
  return buildDocsFabPublicationMetadata({
    plan,
    workflowOutcome: run.workflowOutcome,
    changedPaths: run.changedFiles.map((file) => file.path),
    workflowId: run.workflow,
    ...(run.instruction !== undefined ? { instruction: run.instruction } : {}),
    ...(run.taskLineage ? { requestSha256: run.taskLineage.requestSha256 } : {}),
    ...(run.productOutcome ? { productOutcome: run.productOutcome } : {}),
    ...(run.requiredCheckLimitations
      ? { requiredCheckLimitations: run.requiredCheckLimitations }
      : {}),
    ...(run.taskLineage
      ? { evidence: projectPublicationEvidenceFromRunLineage(run.taskLineage) }
      : {}),
    ...(run.compositionExecution ? { compositionExecution: run.compositionExecution } : {}),
    ...(run.credentialFindings ? { credentialFindings: run.credentialFindings } : {}),
    ...(hostRoots ? { hostRoots } : {}),
  });
}

/** Versioned, content-minimized identity used to adopt an existing MR safely. */
export function buildDocsFabPublicationProvenanceMarker(
  plan: LocalUserPublicationPlan,
  compositionExecution?: CompositionPublicationBindingV1,
): string {
  const runIdentitySha256 = createHash("sha256")
    .update(canonicalizeJsonEvidence(plan.run as unknown as JsonEvidenceValue))
    .digest("hex");
  const execution =
    compositionExecution === undefined
      ? undefined
      : assertCompositionPublicationBinding(compositionExecution);
  return `<!-- ${PROVENANCE_MARKER_NAME}:v1 delivery=local-user plan=${plan.sha256} idempotency=${scmDeliveryIdempotencyKey(plan)} run=${runIdentitySha256} source=${plan.baseRevision} patch=${plan.patch.sha256}${execution ? ` execution=${execution.aggregateSha256}` : ""} -->`;
}

/**
 * The description's lines that open the named marker comment, in any case and
 * after any indentation. Only a line that starts with the comment counts, so a
 * file name that merely contains the marker name, in the changed paths or the
 * Notes block, is not a second marker.
 */
function markerLines(description: string, markerName: string): string[] {
  const opening = `<!-- ${markerName}`;
  return description
    .split("\n")
    .filter((line) => line.trimStart().toLocaleLowerCase("en-US").startsWith(opening));
}

/** Human prose may change, but the marker must occur exactly once and byte-for-byte. */
export function hasExactDocsFabPublicationProvenance(
  description: string | undefined,
  expectedMarker: string,
): boolean {
  if (typeof description !== "string") return false;
  const lines = markerLines(description, PROVENANCE_MARKER_NAME);
  return lines.length === 1 && lines[0]!.trim() === expectedMarker;
}

/**
 * Composition drafts retain an exact title, visible warning, provenance marker,
 * and permanent aggregate-derived marker. Legacy drafts retain the existing
 * provenance-only adoption policy.
 */
export function hasExactDocsFabPublicationMetadata(
  title: string | undefined,
  description: string | undefined,
  expected: DocsFabPublicationMetadata,
): boolean {
  if (!hasExactDocsFabPublicationProvenance(description, expected.mergeRequestProvenanceMarker)) {
    return false;
  }
  if (
    expected.mergeRequestCompositionMarker === undefined &&
    expected.mergeRequestCompositionWarning === undefined
  ) {
    return true;
  }
  if (
    expected.mergeRequestCompositionMarker === undefined ||
    expected.mergeRequestCompositionWarning === undefined ||
    title !== expected.mergeRequestTitle ||
    typeof description !== "string"
  ) {
    return false;
  }
  const lines = markerLines(description, COMPOSITION_MARKER_NAME);
  return (
    lines.length === 1 &&
    lines[0]!.trim() === expected.mergeRequestCompositionMarker &&
    countOccurrences(description, expected.mergeRequestCompositionWarning) === 1
  );
}

function renderStarSections(context: {
  catalogOutcome: string;
  paths: readonly string[];
  plan: LocalUserPublicationPlan;
  pathDigest: string;
  validationDigest: string;
  workflowId?: WorkflowName;
  instruction?: string;
  requestSha256?: string | null;
  productOutcome?: WorkflowOutcomeEnvelopeV1;
  requiredCheckNotRun: boolean;
  evidence?: PublicationEvidenceProjectionV1;
  operatorUsername: string;
  roots: HostRootSet;
  findings: CredentialFinding[];
}): string[] {
  const situation = renderSituationSection(
    context.evidence,
    context.productOutcome,
    context.requiredCheckNotRun,
  );
  const task = renderTaskSection({
    evidence: context.evidence,
    instruction: context.instruction,
    requestSha256: context.requestSha256,
    workflowId: context.workflowId,
    operatorUsername: context.operatorUsername,
    roots: context.roots,
    findings: context.findings,
  });
  const action = renderActionSection(
    context.evidence,
    context.workflowId,
    context.paths,
    context.plan.run.id,
  );
  const result = renderResultSection({
    catalogOutcome: context.catalogOutcome,
    validationCommand: context.plan.validationCommand,
    validationDigest: context.validationDigest,
    documentationValidation: context.plan.documentationValidation,
    productOutcome: context.productOutcome,
  });
  return [
    "## Situation",
    "",
    ...situation,
    "",
    "## Task",
    "",
    ...task,
    "",
    "## Action",
    "",
    ...action,
    "",
    "## Result",
    "",
    ...result,
    "",
  ];
}

function renderSituationSection(
  evidence: PublicationEvidenceProjectionV1 | undefined,
  productOutcome: WorkflowOutcomeEnvelopeV1 | undefined,
  requiredCheckNotRun: boolean,
): string[] {
  const lines: string[] = [];
  if (evidence?.provenanceAvailable) {
    lines.push(`- *${originNarrative(evidence.taskOrigin)}*`);
    lines.push(metadataField("Task origin", `\`${evidence.taskOrigin}\``));
  } else if (evidence !== undefined) {
    lines.push(
      "- *Provenance evidence is unavailable for this historical run; no task origin is inferred.*",
    );
    lines.push(metadataField("Task origin", "`unavailable`"));
  } else {
    lines.push("- *Task origin evidence was not captured on this run.*");
    lines.push(metadataField("Task origin", "`unavailable`"));
  }
  if (productOutcome !== undefined) {
    lines.push(metadataField("Product disposition", `\`${productOutcome.disposition}\``));
  } else {
    lines.push(metadataField("Product disposition", "`unavailable`"));
  }
  const limitationCodes = collectSituationLimitations(evidence, productOutcome);
  if (requiredCheckNotRun && !limitationCodes.includes(REQUIRED_CHECK_NOT_RUN_LIMITATION)) {
    limitationCodes.push(REQUIRED_CHECK_NOT_RUN_LIMITATION);
    limitationCodes.sort((left, right) => left.localeCompare(right));
  }
  lines.push(
    metadataField(
      "Limitations",
      limitationCodes.length > 0
        ? limitationCodes.map((code) => `\`${code}\``).join(", ")
        : "`none`",
    ),
  );
  return lines;
}

function collectSituationLimitations(
  evidence: PublicationEvidenceProjectionV1 | undefined,
  productOutcome: WorkflowOutcomeEnvelopeV1 | undefined,
): string[] {
  const found = new Set<string>();
  for (const code of evidence?.limitations ?? []) found.add(code);
  for (const code of productOutcome?.limitations ?? []) found.add(code);
  for (const finding of productOutcome?.findings ?? []) found.add(finding.code);
  return [...found].sort((left, right) => left.localeCompare(right));
}

/**
 * An issue reference GitLab could act on: `#` and a digit, which ends a local
 * or another project's issue reference; an issue or work item URL; or an
 * external tracker key such as `KEY-123`. GitLab reads a closing keyword beside
 * one even inside a code span, and closes the issue under the merging user's
 * authority when the merge request merges (#1918).
 */
const ISSUE_REFERENCE = /#\d|\/(?:issues|work_items)\/|[A-Z][A-Z0-9_]+-\d/u;

/**
 * The run's "required check could not run" lines that the description may
 * show, and the number it must not. A line is withheld when it carries
 * DocsFab's own configured credential, names a host path, breaks the line, or
 * holds an issue reference: its command, directory, and instruction path come
 * from the repository's instruction file, so a closing statement there would
 * close issues when the merge request merges. A withheld line never blocks the
 * publication. A line that only looks like a credential is shown (#1807).
 */
function projectRequiredCheckLines(
  lines: readonly string[] | undefined,
  roots: HostRootSet,
): { readonly showable: readonly string[]; readonly withheld: number } {
  const showable: string[] = [];
  let withheld = 0;
  for (const line of lines ?? []) {
    const projected = egressText(line, roots);
    if (
      projected.ok &&
      projected.text === line &&
      !configured(line) &&
      !/[\r\n]/u.test(line) &&
      !ISSUE_REFERENCE.test(line)
    ) {
      showable.push(line);
    } else {
      withheld += 1;
    }
  }
  return { showable, withheld };
}

/**
 * The Notes line that counts the required-check lines the description must not
 * show, as the Notes block counts findings in unsafe file names (#1807).
 */
function withheldRequiredChecksLine(count: number, runId: string): string {
  return count === 1
    ? `- 1 required check line is not shown here because it may hold a configured credential, a host path, a line break, or an issue reference; \`docsfab runs show ${runId}\` lists it.`
    : `- ${String(count)} required check lines are not shown here because they may hold a configured credential, a host path, a line break, or an issue reference; \`docsfab runs show ${runId}\` lists them.`;
}

/**
 * File paths containing a GitLab closing statement and issue reference are
 * withheld from the generated description. `docsfab runs show` retains the
 * complete original paths in the local run record.
 */
function pathCouldCloseIssue(path: string): boolean {
  const closingStatement =
    /\b(?:clos(?:e[sd]?|ing)|fix(?:es|ed|ing)?|resolv(?:e[sd]?|ing)|implement(?:s|ed|ing)?):?\s+/iu;
  const closingMatch = closingStatement.exec(path);
  return (
    closingMatch !== null &&
    ISSUE_REFERENCE.test(path.slice(closingMatch.index + closingMatch[0].length))
  );
}

function withheldChangedPathsLine(count: number, runId: string): string {
  return count === 1
    ? `- 1 changed path is not shown here because it could close a GitLab issue; \`docsfab runs show ${runId}\` lists the full path.`
    : `- ${String(count)} changed paths are not shown here because they could close GitLab issues; \`docsfab runs show ${runId}\` lists the full paths.`;
}

/**
 * The required-check Notes lines and the lines among them the description
 * shows: every showable line, or the first ones that fit and a count of the
 * rest, then a count of the withheld lines, each with the command that lists
 * every line. Showable lines are cut, from the end, only when the description
 * would pass its bound without any finding line. When not even the counts fit,
 * the block shows none, and the Situation's `required-check-not-run` code still
 * names the limitation.
 */
function fitRequiredCheckNotes(
  lines: { readonly showable: readonly string[]; readonly withheld: number },
  runId: string,
  fits: (notes: readonly string[]) => boolean,
): { readonly notes: readonly string[]; readonly shown: readonly string[] } {
  const { showable, withheld } = lines;
  if (showable.length === 0 && withheld === 0) return { notes: [], shown: [] };
  for (let shown = showable.length; shown >= 0; shown -= 1) {
    const omitted = showable.length - shown;
    const notes = [
      ...showable.slice(0, shown).map((line) => `- ${line}`),
      ...(omitted > 0
        ? [
            `- ${omitted} more required check line${omitted === 1 ? "" : "s"} did not fit this description; \`docsfab runs show ${runId}\` lists every one.`,
          ]
        : []),
      ...(withheld > 0 ? [withheldRequiredChecksLine(withheld, runId)] : []),
    ];
    if (fits(notes)) return { notes, shown: showable.slice(0, shown) };
  }
  return { notes: [], shown: [] };
}

/** The Notes block around its lines, or nothing when there are none. */
function notesBlock(lines: readonly string[]): readonly string[] {
  return lines.length === 0 ? [] : ["## Notes", "", ...lines, ""];
}

function renderTaskSection(context: {
  evidence?: PublicationEvidenceProjectionV1;
  instruction?: string;
  requestSha256?: string | null;
  workflowId?: WorkflowName;
  operatorUsername: string;
  roots: HostRootSet;
  findings: CredentialFinding[];
}): string[] {
  const lines: string[] = [];
  const origin = context.evidence?.taskOrigin;
  lines.push(metadataField("Task origin class", `\`${origin ?? "unavailable"}\``));
  if (origin === "operator-directed" && context.instruction !== undefined) {
    // Workflow instructions can contain a large evidence set. This is an
    // optional display projection, not a limit on an otherwise verified run.
    if (context.instruction.length > MAX_RAW_OUTCOME) {
      lines.push(metadataField("Instruction", "omitted (exceeds publication display limit)"));
      return lines;
    }
    const projection = projectInstruction(
      context.instruction,
      context.operatorUsername,
      context.roots,
    );
    // Only an instruction the description shows is flagged.
    const shown = (value: string): string => {
      flagField(value, INSTRUCTION_LOCATION, context.findings);
      return value;
    };
    const boundDigest = context.requestSha256 ?? null;
    const requestKind = context.evidence?.requestKind;
    if (projection === null) {
      lines.push(
        metadataField("Instruction", "omitted (unsafe content or a configured credential)"),
      );
    } else if (boundDigest !== null && requestKind === "bounded-instruction") {
      if (
        instructionDigestMatches(
          context.instruction,
          boundDigest,
          context.workflowId,
          context.evidence,
        )
      ) {
        lines.push(metadataField("Instruction", shown(projection)));
      } else {
        lines.push(metadataField("Instruction", "omitted (request digest mismatch)"));
      }
    } else if (requestKind === "structured-task") {
      lines.push(metadataField("Request kind", `\`${requestKind}\``));
    } else if (projection !== null) {
      lines.push(metadataField("Instruction", shown(projection)));
    }
  } else if (context.evidence?.requestPresent) {
    lines.push(metadataField("Request kind", `\`${context.evidence.requestKind}\``));
  } else {
    lines.push(metadataField("Human request", "not recorded"));
  }
  return lines;
}

function instructionDigestMatches(
  instruction: string,
  requestSha256: string,
  workflowId: WorkflowName | undefined,
  evidence: PublicationEvidenceProjectionV1 | undefined,
): boolean {
  if (workflowId === undefined || evidence === undefined) return false;
  try {
    const identity = createBoundedInstructionRequestIdentity(
      instruction,
      null,
      workflowId,
      {
        identitySha256: evidence.repositoryIdentitySha256,
        revision: evidence.repositoryRevision,
      },
      workflowCatalog,
    );
    return identity.requestSha256 === requestSha256;
  } catch {
    return false;
  }
}

function renderActionSection(
  evidence: PublicationEvidenceProjectionV1 | undefined,
  workflowId: WorkflowName | undefined,
  paths: readonly string[],
  runId: string,
): string[] {
  const workflow = workflowId ?? evidence?.selectedWorkflow ?? "unavailable";
  const shownPaths = paths.filter((path) => !pathCouldCloseIssue(path));
  const withheldPathCount = paths.length - shownPaths.length;
  const lines = [
    metadataField("Workflow", `\`${workflow}\``),
    "",
    `- **Changed paths (${paths.length}):**`,
    ...shownPaths.map((path) => `  - \`${path}\``),
    ...(withheldPathCount > 0 ? ["", withheldChangedPathsLine(withheldPathCount, runId)] : []),
  ];
  if (evidence?.provenanceAvailable) {
    const responsibilities =
      evidence.responsibilities.map((entry) => `${entry.domain}:${entry.actor}`).join(", ") ||
      "none";
    lines.push(
      "",
      metadataField(
        "Responsibility",
        responsibilities
          .split(", ")
          .map((entry) => `\`${entry}\``)
          .join(", "),
      ),
    );
  } else {
    lines.push("", metadataField("Responsibility", "`unavailable`"));
  }
  return lines;
}

function renderResultSection(context: {
  catalogOutcome: string;
  validationCommand: string;
  validationDigest: string;
  documentationValidation?: LocalUserPublicationPlan["documentationValidation"];
  productOutcome?: WorkflowOutcomeEnvelopeV1;
}): string[] {
  // Validation identity and sealed disposition come first; catalog workflow copy
  // is only a subtitle.
  const lines = [
    metadataField(
      "Validation",
      `\`${context.validationCommand}\` (SHA-256: \`${context.validationDigest}\`)`,
    ),
  ];
  if (context.documentationValidation) {
    const binding = context.documentationValidation;
    lines.push(
      metadataField(
        "Documentation validation profile",
        `\`${binding.profileId}\` v${binding.profileVersion}`,
      ),
      metadataField(
        "Documentation validation checks",
        binding.checkIds.map((id) => `\`${id}\``).join(", "),
      ),
      metadataField("Trusted validator", `\`${binding.validatorIdentity}\``),
      ...(binding.schemaVersion === 2
        ? [
            metadataField(
              "Documentation source applicability SHA-256",
              `\`${binding.applicabilitySha256}\``,
            ),
          ]
        : []),
    );
  }
  if (context.productOutcome !== undefined) {
    const { productOutcome } = context;
    lines.push(metadataField("Product disposition", `\`${productOutcome.disposition}\``));
    lines.push(
      metadataField(
        "Product findings",
        productOutcome.findings.map((finding) => `\`${finding.code}\``).join(", ") || "`none`",
      ),
    );
    lines.push(
      metadataField(
        "Product limitations",
        productOutcome.limitations.map((code) => `\`${code}\``).join(", ") || "`none`",
      ),
    );
    lines.push(metadataField("Product outcome digest", `\`${productOutcome.outcomeSha256}\``));
  } else {
    lines.push(metadataField("Product disposition", "`unavailable`"));
    lines.push(metadataField("Product findings", "`unavailable`"));
    lines.push(metadataField("Product limitations", "`unavailable`"));
  }
  lines.push(metadataField("Catalog outcome (subtitle)", `*${context.catalogOutcome}*`));
  return lines;
}

/**
 * Title summary from the sealed disposition and content-free codes. Catalog copy is
 * used only when no envelope exists, so it never overrides an inconclusive disposition.
 */
function projectResultTitleSummary(
  productOutcome: WorkflowOutcomeEnvelopeV1 | undefined,
  catalogOutcome: string,
): string {
  if (productOutcome === undefined) return catalogOutcome;
  const codes = collectProductCodes(productOutcome);
  return codes.length === 0
    ? productOutcome.disposition
    : `${productOutcome.disposition} — ${codes.join(", ")}`;
}

function collectProductCodes(productOutcome: WorkflowOutcomeEnvelopeV1): string[] {
  const found = new Set<string>();
  for (const code of productOutcome.limitations) found.add(code);
  for (const finding of productOutcome.findings) found.add(finding.code);
  return [...found].sort((left, right) => left.localeCompare(right));
}

function renderMachineFooter(context: {
  catalogOutcome: string;
  plan: LocalUserPublicationPlan;
  pathDigest: string;
  validationDigest: string;
  paths: readonly string[];
  evidence?: PublicationEvidenceProjectionV1;
  compositionExecution?: CompositionPublicationBindingV1;
}): string[] {
  return [
    "## Published by DocsFab",
    "",
    "- *This draft publication was prepared by DocsFab host automation.*",
    "",
    metadataField("Outcome", `*${context.catalogOutcome}*`),
    metadataField("Initiated by GitLab user", `@${context.plan.identity.gitlabUsername}`),
    metadataField("Source revision", `\`${context.plan.baseRevision}\``),
    metadataField("Run", `\`${context.plan.run.id}\``),
    metadataField("Patch SHA-256", `\`${context.plan.patch.sha256}\``),
    metadataField("Changed paths SHA-256", `\`${context.pathDigest}\``),
    metadataField("Validation command SHA-256", `\`${context.validationDigest}\``),
    ...(context.plan.documentationValidation
      ? [
          metadataField(
            "Documentation validation profile",
            `\`${context.plan.documentationValidation.profileId}\` v${context.plan.documentationValidation.profileVersion}`,
          ),
          metadataField(
            "Documentation validation check-set SHA-256",
            `\`${context.plan.documentationValidation.checkSetSha256}\``,
          ),
          metadataField(
            "Documentation validation selector SHA-256",
            `\`${context.plan.documentationValidation.selectorInputSha256}\``,
          ),
          metadataField(
            "Trusted validator",
            `\`${context.plan.documentationValidation.validatorIdentity}\``,
          ),
          ...(context.plan.documentationValidation.schemaVersion === 2
            ? [
                metadataField(
                  "Documentation source applicability SHA-256",
                  `\`${context.plan.documentationValidation.applicabilitySha256}\``,
                ),
              ]
            : []),
        ]
      : []),
    ...(context.compositionExecution
      ? [
          metadataField("Composition", `\`${context.compositionExecution.compositionId}\``),
          metadataField(
            "Composition evidence SHA-256",
            `\`${context.compositionExecution.evidenceSha256}\``,
          ),
          metadataField(
            "Composition aggregate SHA-256",
            `\`${context.compositionExecution.aggregateSha256}\``,
          ),
          metadataField("Technical approval", "`not-established`"),
          metadataField("Role qualification", "`not-established`"),
          metadataField("Release eligible", "`false`"),
        ]
      : []),
    "",
    ...renderEvidenceSection(context.evidence),
  ];
}

function projectInstruction(
  value: string,
  operatorUsername: string,
  roots: HostRootSet,
): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_RAW_OUTCOME)
    return null;
  const normalized = value.normalize("NFC");
  if (
    /[\0\r\n\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/u.test(normalized) ||
    configured(normalized)
  ) {
    return null;
  }
  const projected = egressText(normalized, roots);
  if (!projected.ok) return null;
  let result = projected.text.replace(/\p{White_Space}+/gu, " ").trim();
  if (result.length === 0) return null;
  // Strip Markdown decoration without paraphrasing. Underscores inside
  // identifiers (NODE_EXTRA_CA_CERTS) are not emphasis; a `~` root placeholder
  // is not strikethrough.
  result = outsideEgressPlaceholders(result, stripMarkdownDecoration)
    .replace(/\p{White_Space}+/gu, " ")
    .trim();
  if (result.length === 0) return null;
  const providerAttribution =
    /\b(?:codex|chatgpt|openai|gpt(?:-[a-z0-9.]+)?|claude|anthropic|gemini|copilot)\b/iu;
  const identityTokens = result.toLocaleLowerCase("en-US").split(/[^a-z0-9._-]+/u);
  if (
    REMAINING_INJECTION.test(withoutEgressPlaceholders(result)) ||
    configured(result) ||
    providerAttribution.test(result) ||
    identityTokens.includes(operatorUsername.toLocaleLowerCase("en-US"))
  ) {
    return null;
  }
  return truncateCodePoints(result, MAX_INSTRUCTION);
}

function boundedSummary(
  value: string,
  maximum: number,
  operatorUsername: string,
  roots: HostRootSet,
  findings: CredentialFinding[],
): string {
  if (typeof value !== "string" || value.length > MAX_RAW_OUTCOME) fail();
  const normalized = value.normalize("NFC");
  if (/[\0\r\n\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/u.test(normalized) || configured(normalized))
    fail();
  flagField(normalized, WORKFLOW_OUTCOME_LOCATION, findings);
  let result = egress(normalized, roots)
    .replace(/\p{White_Space}+/gu, " ")
    .trim();
  let previous: string;
  do {
    previous = result;
    result = result
      .replace(/^(?:(?:Draft|WIP)\s*:\s*|\[DocsFab Run\]\s*|DocsFab\s*:\s*)/iu, "")
      .trimStart();
  } while (result !== previous);
  if (result.length === 0) return FALLBACK_OUTCOME;
  const providerAttribution =
    /\b(?:codex|chatgpt|openai|gpt(?:-[a-z0-9.]+)?|claude|anthropic|gemini|copilot)\b/iu;
  const identityTokens = result.toLocaleLowerCase("en-US").split(/[^a-z0-9._-]+/u);
  if (
    /[<>\[\]()`!#*_~\\]/u.test(withoutEgressPlaceholders(result)) ||
    providerAttribution.test(result) ||
    identityTokens.includes(operatorUsername.toLocaleLowerCase("en-US"))
  )
    fail();
  return truncateCodePoints(result, maximum);
}

function truncateCodePoints(value: string, maximum: number): string {
  const points = [...value];
  return points.length <= maximum
    ? value
    : `${points
        .slice(0, maximum - 1)
        .join("")
        .trimEnd()}…`;
}

function codePointLength(value: string): number {
  return [...value].length;
}

function countOccurrences(value: string, needle: string): number {
  return value.split(needle).length - 1;
}

/** Whether a field carries DocsFab's own configured credential, which refuses publication. */
function configured(value: string): boolean {
  return findConfiguredCredential(value) !== null;
}

/**
 * Flag a published field that only looks like a credential (#1807): delivery's
 * rules, plus a URL with a user name and password in any case and the HTTP
 * credential header names. The field is published; the finding names its
 * location and rule only.
 */
function flagField(value: string, location: string, findings: CredentialFinding[]): void {
  const rules = new Set(deliveryCredentialRuleIds(value));
  if (/https?:\/\/[^\s/@]+:[^\s/@]+@/iu.test(value)) rules.add(URL_USERINFO_RULE_ID);
  if (/Authorization\s*:/iu.test(value)) rules.add(AUTHORIZATION_HEADER_RULE_ID);
  if (/PRIVATE[-_ ]?TOKEN/iu.test(value)) rules.add(PRIVATE_TOKEN_HEADER_RULE_ID);
  findings.push(...credentialFindingsAt(location, rules));
}

/**
 * The Notes line counting findings whose location a file name makes unsafe to
 * show: a backtick ends the code span, and a control character or line break
 * starts a new line that GitLab reads as Markdown or a quick action (#1807).
 */
function unshowableFindingsLine(count: number): string {
  const findings = count === 1 ? "1 more finding" : `${String(count)} more findings`;
  return `- ${findings} in file names that cannot be shown safely here; the run record lists ${count === 1 ? "it" : "them"}.`;
}

/** The Notes line that only counts every finding, for a description too full to list any. */
function countedFindingsLine(count: number): string {
  const findings =
    count === 1
      ? "1 credential-like content finding"
      : `${String(count)} credential-like content findings`;
  return `- ${findings}; the run record lists ${count === 1 ? "it" : "them"}.`;
}

/**
 * The description with Notes lines naming every credential-like content
 * finding for the maintainers, in the Notes block after the Result section and
 * after any required check that could not run. A finding whose location or
 * rule cannot be shown as written is counted on its own line, never shown.
 * When the whole list would push the description past its bound, the block
 * names as many as fit and counts the rest. When not even one fits, the
 * findings go to stderr, and the block keeps one line that counts every
 * finding; when even that line does not fit, the description names no finding.
 * No finding is silently lost.
 */
function describeWithNotes(
  findings: readonly CredentialFinding[],
  describe: (notes: readonly string[]) => string,
): string {
  const shown = findings.filter(isShowableCredentialFinding);
  const unshown = findings.length - shown.length;
  const notes = (listed: number): readonly string[] => {
    const line = formatCredentialFindingNotes(shown, listed);
    return [
      ...(line === undefined ? [] : [line]),
      ...(unshown === 0 ? [] : [unshowableFindingsLine(unshown)]),
    ];
  };
  const complete = describe(notes(shown.length));
  if (complete.length <= MAX_DESCRIPTION || findings.length === 0) return complete;
  let fits = -1;
  let low = 0;
  let high = shown.length - 1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    if (describe(notes(middle)).length <= MAX_DESCRIPTION) {
      fits = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  if (fits >= 0) return describe(notes(fits));
  const counted = describe([countedFindingsLine(findings.length)]);
  // The run record lacks the description builder's own field findings, so the
  // count line alone would leave them named nowhere: stderr names every one.
  recordCredentialFindings(findings);
  if (counted.length <= MAX_DESCRIPTION) return counted;
  return describe([]);
}

/** Replace this host's roots; credential material refuses the whole publication. */
function egress(value: string, roots: HostRootSet): string {
  const result = egressText(value, roots);
  if (!result.ok) fail();
  return result.text;
}

function stripMarkdownDecoration(value: string): string {
  let result = value.replace(MARKDOWN_DECORATION, "");
  let previous: string;
  do {
    previous = result;
    result = result
      .replace(/(^|[^A-Za-z0-9])__([^_]+)__(?![A-Za-z0-9])/gu, "$1$2")
      .replace(/(^|[^A-Za-z0-9])_([^_]+)_(?![A-Za-z0-9])/gu, "$1$2");
  } while (result !== previous);
  return result;
}

function validatedEvidence(
  input: DocsFabPublicationMetadataInput,
): PublicationEvidenceProjectionV1 | undefined {
  if (input.evidence === undefined) return undefined;
  let evidence: PublicationEvidenceProjectionV1;
  try {
    evidence = assertPublicationEvidenceProjection(input.evidence);
  } catch {
    fail();
  }
  if (evidence.repositoryRevision !== input.plan.baseRevision) fail();
  return evidence;
}

/** Render a deterministic, enum-and-digest-only provenance section for the MR body. */
function renderEvidenceSection(evidence: PublicationEvidenceProjectionV1 | undefined): string[] {
  if (evidence === undefined) return [];
  const limitations = evidence.limitations.length > 0 ? evidence.limitations.join(", ") : "none";
  if (!evidence.provenanceAvailable) {
    return [
      "### Provenance evidence",
      "",
      "- *Provenance evidence is unavailable for this historical run; no task origin is inferred.*",
      metadataField(
        "Limitations",
        limitations
          .split(", ")
          .map((code) => `\`${code}\``)
          .join(", "),
      ),
      metadataField("Evidence SHA-256", `\`${evidence.evidenceProjectionSha256}\``),
      "",
    ];
  }
  const responsibilities =
    evidence.responsibilities.map((entry) => `${entry.domain}:${entry.actor}`).join(", ") || "none";
  const disclosures = evidence.disclosurePolicies.join(", ") || "none";
  return [
    "### Provenance evidence",
    "",
    `- *${originNarrative(evidence.taskOrigin)}*`,
    "",
    metadataField("Task origin", `\`${evidence.taskOrigin}\``),
    metadataField(
      "Human request",
      `\`${evidence.requestPresent ? evidence.requestKind : "not recorded"}\``,
    ),
    metadataField(
      "Workflow selected by DocsFab",
      `\`${evidence.selectedWorkflow ?? "unavailable"}\``,
    ),
    metadataField("Authority", `\`${evidence.authorityStatus}\``),
    metadataField(
      "External inputs",
      `\`${evidence.inputUseCount}${
        evidence.inputUsesTruncated ? " (bounded projection truncated)" : ""
      }\``,
    ),
    metadataField(
      "Disclosure ceilings",
      disclosures
        .split(", ")
        .map((code) => `\`${code}\``)
        .join(", "),
    ),
    metadataField(
      "Responsibility",
      responsibilities
        .split(", ")
        .map((entry) => `\`${entry}\``)
        .join(", "),
    ),
    metadataField(
      "Limitations",
      limitations
        .split(", ")
        .map((code) => `\`${code}\``)
        .join(", "),
    ),
    metadataField("Evidence SHA-256", `\`${evidence.evidenceProjectionSha256}\``),
    metadataField("Provenance inputs SHA-256", `\`${evidence.provenanceInputsSha256}\``),
    "",
  ];
}

function metadataField(label: string, value: string): string {
  return `- **${label}:** ${value}`;
}

function originNarrative(origin: PublicationEvidenceProjectionV1["taskOrigin"]): string {
  switch (origin) {
    case "operator-directed":
      return "A maintainer directed this task; DocsFab then selected and ran the governed workflow under one operator confirmation.";
    case "docsfab-recommended-approved":
      return "DocsFab recommended this task and a maintainer approved it before DocsFab selected and ran the governed workflow.";
    case "docsfab-autonomous":
      return "DocsFab autonomously selected this task within its governed scope; no maintainer directed the specific selection.";
    case "historical-unknown":
      return "This run predates task-lineage capture, so the originating request and selection cannot be attributed here.";
  }
}

function fail(): never {
  throw new DocsFabPublicationMetadataError();
}
