// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";

import type { EditorialDecisionProposalV1 } from "../../artifacts/contracts.js";
import {
  EditorialDecisionValidationError,
  hostFillEditorialDecisionProposalFromJudgmentV1,
  type EditorialDecisionValidationErrorCode,
} from "../../artifacts/editorial-decision.js";
import { catalogCapacity } from "../../config/catalog-capacity.js";
import {
  ReaderContextValidationError,
  type ReaderContextValidationErrorCode,
} from "../../context/reader-context.js";
// The generated catalog table itself, a leaf, as plan-binding.ts imports it.
import { rejectCorrectable } from "../../contracts/model-output.generated.js";
import {
  InferenceStepError,
  type HarnessStepInput,
  type HarnessStepResult,
  type InferenceRejectionReasonV1,
} from "../../execution/contracts.js";
import { isAmbiguousJsonEnvelope, jsonEnvelopeBody } from "../../execution/json-envelope.js";
import {
  EDITORIAL_PLANNER_COMPLETED_RESPONSE_KEYS,
  PLANNER_COMPLETED_RESPONSE_KEYS,
  PLANNER_NEEDS_INPUT_RESPONSE_KEYS,
} from "../../execution/response-contract-keys.js";
import {
  assertModelResponseCredentialFree,
  CredentialBoundaryError,
} from "../../security/credential-isolation.js";
import { CONTRACT_PLACEHOLDER_REJECTION_CODE } from "../../workflow-execution/contract-placeholders.js";
import {
  bindDocumentationPlanProposal,
  createProposalFromProposedUpdate,
  documentationPlanModeForWorkflow,
  documentationPlanWritePaths,
  DocumentationPlanBindingError,
  DOCUMENTATION_PLAN_FAILURES,
} from "../../workflow-execution/plan-binding.js";
import type { SourceObligationRejectionCode } from "../../workflow-execution/source-obligation.js";
import { plannerNeedsInputReasonCode } from "../../workflow-contracts/planner-diagnostic.js";
import { isEditorialPlanner } from "../editorial-response-contract.js";
import type { ReplyAdmissionContext } from "./context.js";

/**
 * Admitted length of one planner response summary, in UTF-16 units. The
 * whole-response byte check is a separate bound, not interchangeable with this.
 */
const PLANNER_SUMMARY_MAXIMUM_CHARS = catalogCapacity("runtime.planner.summaryMaxChars");

/**
 * A documentation planner's admitted reply. A needs-input reply ends the step:
 * the harness returns it with the attempt's evidence. A completed reply
 * carries its bound plan into the rest of the admission chain.
 */
export type PlannerReplyAdmission =
  | {
      outcome: "needs-input";
      summary: string;
      planDiagnostic: NonNullable<HarnessStepResult["planDiagnostic"]>;
    }
  | {
      outcome: "completed";
      summary: string;
      planBinding: HarnessStepResult["planBinding"];
      editorialDecisionProposal: HarnessStepResult["editorialDecisionProposal"];
      /** Digest of the decoded reply, for a host stop plan admission may raise on it. */
      planResponseSha256: string;
      /**
       * Set when the planner proposed the plan as an UPDATE: these are its write
       * paths, which {@link confirmProposedUpdatePlan} must find existing before
       * the reply is admitted.
       */
      proposedUpdatePaths?: readonly string[];
    };

/**
 * Admit the reply of a `plan-documentation` step in a workflow with a
 * documentation plan mode. Any other step returns `undefined`, untouched.
 */
export function admitPlannerReply(
  input: HarnessStepInput,
  summary: string,
  { decodedResponse, collectAttemptEvidence, refuseContractPlaceholder }: ReplyAdmissionContext,
): PlannerReplyAdmission | undefined {
  let planBinding: HarnessStepResult["planBinding"];
  let editorialDecisionProposal: HarnessStepResult["editorialDecisionProposal"];
  let proposedUpdatePaths: readonly string[] | undefined;
  const documentationPlanMode = documentationPlanModeForWorkflow(input.workflow.name);
  if (input.step.skill === "plan-documentation" && documentationPlanMode) {
    let validationPhase: "invalid-json" | "invalid-envelope" | "invalid-summary" | "unknown" =
      "invalid-json";
    // Which part of the reply the admission was reading, so a refusal no finer
    // rule names still records where it happened.
    let part: "$" | "$.editorialDecisionProposal" = "$";
    const responseSha256 = createHash("sha256").update(decodedResponse, "utf8").digest("hex");
    try {
      const parsed: unknown = parsePlannerReply(summary);
      validationPhase = "invalid-envelope";
      if (
        !parsed ||
        typeof parsed !== "object" ||
        Array.isArray(parsed) ||
        ![
          sortedKeys(
            isEditorialPlanner(input)
              ? EDITORIAL_PLANNER_COMPLETED_RESPONSE_KEYS
              : PLANNER_COMPLETED_RESPONSE_KEYS,
          ),
          sortedKeys(PLANNER_NEEDS_INPUT_RESPONSE_KEYS),
        ].includes(Object.keys(parsed).sort().join(","))
      )
        throw new PlannerReplyRuleError(
          "Planner response must be one exact JSON object envelope.",
          sharedRejection("invalid-shape", "$"),
        );
      validationPhase = "invalid-summary";
      const envelope = parsed as {
        summary?: unknown;
        planBinding?: unknown;
        outcome?: unknown;
        reason?: unknown;
        editorialDecisionProposal?: unknown;
      };
      if (
        typeof envelope.summary !== "string" ||
        envelope.summary.length === 0 ||
        envelope.summary.length > PLANNER_SUMMARY_MAXIMUM_CHARS
      )
        throw new PlannerReplyRuleError(
          "Planner response summary must be non-empty bounded text.",
          sharedRejection("invalid-value", "$.summary"),
        );
      validationPhase = "unknown";
      if (envelope.outcome !== undefined) {
        if (envelope.outcome !== "needs-input" || typeof envelope.reason !== "string") {
          throw new PlannerReplyRuleError(
            "Planner needs-input outcome must include a string reason.",
            sharedRejection(
              "invalid-value",
              envelope.outcome !== "needs-input" ? "$.outcome" : "$.reason",
            ),
          );
        }
        const reasonCode = plannerNeedsInputReasonCode(envelope.reason);
        refuseContractPlaceholder(decodedResponse);
        const planDiagnostic: NonNullable<HarnessStepResult["planDiagnostic"]> = {
          schemaVersion: 1,
          kind: "docsfab-documentation-plan-diagnostic",
          code: reasonCode,
          responseSha256,
          responseShape: "json-object",
        };
        return {
          outcome: "needs-input",
          summary: admittedPlannerNeedsInputSummary(envelope.summary, reasonCode),
          planDiagnostic,
        };
      }
      // Screen every field of a completed plan reply for credentials before any
      // of it is admitted. A needs-input reply keeps its own credential-safe summary.
      validationPhase = "invalid-envelope";
      assertModelResponseCredentialFree(envelope);
      validationPhase = "unknown";
      // A CREATE plan proposed as an UPDATE is read as the CREATE of the same
      // pages, only where the host can tell which pages exist.
      const proposedUpdate =
        documentationPlanMode === "create" && input.planTargetExistence
          ? createProposalFromProposedUpdate(envelope.planBinding)
          : undefined;
      planBinding = bindDocumentationPlanProposal(proposedUpdate ?? envelope.planBinding, {
        expectedMode: documentationPlanMode,
        // Refuse a source at another revision here, where the planner can
        // correct it, not at source-obligation derivation.
        ...(input.evidenceIdentity?.repositoryRevision
          ? { expectedRevision: input.evidenceIdentity.repositoryRevision }
          : {}),
      });
      if (proposedUpdate) proposedUpdatePaths = documentationPlanWritePaths(planBinding);
      if (isEditorialPlanner(input)) {
        part = "$.editorialDecisionProposal";
        const proposal = envelope.editorialDecisionProposal;
        if (!proposal || typeof proposal !== "object" || Array.isArray(proposal)) {
          throw new PlannerReplyRuleError(
            "Planner editorial decision proposal must be one JSON object.",
            sharedRejection("invalid-shape", part),
          );
        }
        editorialDecisionProposal = admitEditorialPlannerProposalV1(
          envelope.editorialDecisionProposal,
          input,
        );
      }
      summary = envelope.summary;
    } catch (error) {
      // Keep the placeholder refusal's code and location.
      if (
        error instanceof InferenceStepError &&
        error.rejection?.code === CONTRACT_PLACEHOLDER_REJECTION_CODE
      ) {
        throw error;
      }
      throw plannerRefusal(error, validationPhase, part, collectAttemptEvidence);
    }
    return {
      outcome: "completed",
      summary,
      planBinding,
      editorialDecisionProposal,
      planResponseSha256: responseSha256,
      ...(proposedUpdatePaths ? { proposedUpdatePaths } : {}),
    };
  }
  return undefined;
}

/** The one refusal every planner admission check raises, so each records alike. */
function plannerRefusal(
  error: unknown,
  validationPhase: "invalid-json" | "invalid-envelope" | "invalid-summary" | "unknown",
  part: "$" | "$.editorialDecisionProposal",
  collectAttemptEvidence: ReplyAdmissionContext["collectAttemptEvidence"],
): InferenceStepError {
  const code =
    error instanceof DocumentationPlanBindingError
      ? error.code
      : error instanceof EditorialDecisionValidationError
        ? editorialPlannerDiagnosticCode(error.code)
        : validationPhase;
  return new InferenceStepError(
    DOCUMENTATION_PLAN_FAILURES[code],
    "malformed-response",
    // Credential material is a disclosure rejection and is never re-asked.
    !isPlannerCredentialRefusal(error),
    collectAttemptEvidence(),
    // Every refusal names the rule it broke and where, so the retry and the
    // attempt record can state it.
    plannerRejection(error, part),
  );
}

/**
 * Admit a plan the CREATE planner proposed as an UPDATE only when the run's
 * revision holds every page it would write. Otherwise the reply is refused
 * exactly as a `mode: "update"` CREATE plan always was. Whether each existing
 * page can become an UPDATE is plan admission's decision, as for a conversion.
 * A failure of the host's own existence oracle is a host fault, not a refusal.
 */
export async function confirmProposedUpdatePlan(
  input: HarnessStepInput,
  admission: Extract<PlannerReplyAdmission, { outcome: "completed" }>,
  { collectAttemptEvidence }: Pick<ReplyAdmissionContext, "collectAttemptEvidence">,
): Promise<"update" | undefined> {
  const paths = admission.proposedUpdatePaths;
  if (!paths) return undefined;
  if (!input.planTargetExistence) {
    throw new Error("A proposed UPDATE plan was read without the host's existence oracle."); // hygiene: ok -- host integrity refusal; admission reads the proposal only when the oracle is present.
  }
  const existing = new Set(await input.planTargetExistence(paths));
  if (paths.some((path) => !existing.has(path))) {
    throw plannerRefusal(
      new DocumentationPlanBindingError("invalid-mode", undefined, "$.mode"),
      "unknown",
      "$",
      collectAttemptEvidence,
    );
  }
  return "update";
}

/** A planner refusal the admission raises itself, with the rule it names. */
class PlannerReplyRuleError extends Error {
  public constructor(
    message: string,
    public readonly rejection: InferenceRejectionReasonV1,
  ) {
    super(message);
    this.name = "PlannerReplyRuleError";
  }
}

/**
 * A shared rejection code at a planner location. The type limits it to codes the
 * shared class and retry-hint tables already state, in wording that holds for
 * every decoder raising it.
 */
function sharedRejection(
  code: SourceObligationRejectionCode,
  location: string,
): InferenceRejectionReasonV1 {
  return Object.freeze({ code, location });
}

function sortedKeys(keys: readonly string[]): string {
  return [...keys].sort().join(",");
}

/**
 * Parse the planner reply through the shared extraction policy, so a plan in a
 * Markdown fence or beside prose is still the plan. A reply that is still not
 * JSON names the rule it broke: two fenced documents (ambiguous) or none.
 */
function parsePlannerReply(summary: string): unknown {
  try {
    return JSON.parse(jsonEnvelopeBody(summary));
  } catch {
    throw new PlannerReplyRuleError(
      "The planner response was not one valid JSON document.",
      isAmbiguousJsonEnvelope(summary)
        ? rejectCorrectable("reply-json", "reply-json-wrapped", "$")
        : sharedRejection("invalid-json", "$"),
    );
  }
}

/** The rule a planner refusal broke, and where, for every refusal path. */
function plannerRejection(
  error: unknown,
  part: "$" | "$.editorialDecisionProposal",
): InferenceRejectionReasonV1 {
  if (error instanceof PlannerReplyRuleError) return error.rejection;
  if (error instanceof DocumentationPlanBindingError) return planBindingRejection(error);
  if (error instanceof CredentialBoundaryError) return sharedRejection("credential-material", part);
  if (error instanceof EditorialDecisionValidationError) {
    return editorialDecisionRejection(error.code);
  }
  if (error instanceof ReaderContextValidationError) {
    return readerContextRejection(error.code);
  }
  // A host fault, not a rule the reply broke: no finer rule is established.
  return sharedRejection("unknown", part);
}

/** A plan binding refusal at its binding location, rebased under `$.planBinding`. */
function planBindingRejection(error: DocumentationPlanBindingError): InferenceRejectionReasonV1 {
  // A source locator refusal already names its catalog rule.
  if (error.rejection) return error.rejection;
  const location = `$.planBinding${(error.location ?? "$").slice(1)}`;
  switch (error.code) {
    case "invalid-shape":
      return sharedRejection("invalid-shape", location);
    case "invalid-mode":
    case "invalid-path":
    case "invalid-disposition":
    case "invalid-source":
      return sharedRejection("invalid-value", location);
    case "empty-pages":
      return sharedRejection("empty-required-field", location);
    case "duplicate-page":
    case "duplicate-source-binding":
      return sharedRejection("duplicate-entry", location);
    case "missing-source-binding":
      return rejectCorrectable(
        "documentation-plan",
        "documentation-plan-source-binding-coverage",
        error.location === "$.sourceBindings[].pagePath"
          ? "$.planBinding.sourceBindings[].pagePath"
          : "$.planBinding.sourceBindings",
      );
    case "digest-mismatch":
      return sharedRejection("digest-mismatch", location);
    // Sealed-binding and runner checks a fresh proposal never reaches.
    case "invalid-source-evidence":
    case "unknown-plan-variant":
    case "omitted-mandatory-obligation":
      return sharedRejection("unknown", location);
  }
}

/** An editorial decision judgment refusal, at the judgment the planner returned. */
function editorialDecisionRejection(
  code: EditorialDecisionValidationErrorCode,
): InferenceRejectionReasonV1 {
  const location = "$.editorialDecisionProposal";
  switch (code) {
    case "invalid-shape":
    case "invalid-value":
    case "credential-material":
    case "digest-mismatch":
      return sharedRejection(code, location);
    // Host-filled identity the judgment does not author: no rule it broke.
    case "evidence-unavailable":
    case "producer-mismatch":
    case "identity-mismatch":
    case "independent-rejection":
      return sharedRejection("unknown", location);
  }
}

/** The reader-context check the host-filled decision runs over the judgment's rationale. */
function readerContextRejection(
  code: ReaderContextValidationErrorCode,
): InferenceRejectionReasonV1 {
  const location = "$.editorialDecisionProposal";
  switch (code) {
    case "invalid-shape":
    case "invalid-value":
    case "credential-material":
      return sharedRejection(code, location);
    case "size-exceeded":
      return sharedRejection("bounds-exceeded", location);
    case "evidence-unavailable":
    case "identity-mismatch":
      return sharedRejection("unknown", location);
  }
}

const EDITORIAL_PLANNER_DIAGNOSTIC_CODES = new Set(["invalid-shape", "digest-mismatch"]);

function editorialPlannerDiagnosticCode(code: string): keyof typeof DOCUMENTATION_PLAN_FAILURES {
  return EDITORIAL_PLANNER_DIAGNOSTIC_CODES.has(code)
    ? (code as keyof typeof DOCUMENTATION_PLAN_FAILURES)
    : "invalid-envelope";
}

/**
 * Credential material anywhere in a completed planner reply, or in its editorial
 * decision judgment, is a disclosure refusal and stops the step.
 */
function isPlannerCredentialRefusal(error: unknown): boolean {
  return (
    error instanceof CredentialBoundaryError ||
    (error instanceof EditorialDecisionValidationError && error.code === "credential-material")
  );
}

/** Host-fill judgment and decode with validateEditorialDecisionProposalV1. */
export function admitEditorialPlannerProposalV1(
  proposal: unknown,
  input: HarnessStepInput,
): EditorialDecisionProposalV1 {
  if (!proposal || typeof proposal !== "object" || Array.isArray(proposal)) {
    throw new Error("Planner editorial decision proposal must be one JSON object.");
  }
  if (!input.readerContextInput) {
    throw new Error("Update-documentation V2 requires an admitted reader task context projection.");
  }
  const artifacts = [...(input.editorialEvidenceRefs ?? [])];
  const sources = (input.readerContextProvenance?.sources ?? []).map((source) => ({
    uri: source.uri,
    sha256: source.sha256,
  }));
  return hostFillEditorialDecisionProposalFromJudgmentV1(proposal, {
    readerContextInput: input.readerContextInput,
    admittedReaderEvidence: sources,
    admittedEvidenceRefs: artifacts,
    ...(input.readerContextProvenance?.comparison
      ? { comparison: input.readerContextProvenance.comparison }
      : {}),
  });
}

/** Blocked envelope skips the decoder; completed judgment must host-decode. */
export function admitEditorialPlannerEnvelopeV1(
  envelope: {
    outcome?: unknown;
    reason?: unknown;
    editorialDecisionProposal?: unknown;
  },
  input: HarnessStepInput,
):
  | { status: "blocked"; reasonCode: string }
  | { status: "completed"; proposal: EditorialDecisionProposalV1 } {
  if (envelope.outcome !== undefined) {
    if (envelope.outcome !== "needs-input" || typeof envelope.reason !== "string") {
      throw new Error("Planner needs-input outcome must include a string reason.");
    }
    const reasonCode = plannerNeedsInputReasonCode(envelope.reason);
    return { status: "blocked", reasonCode };
  }
  return {
    status: "completed",
    proposal: admitEditorialPlannerProposalV1(envelope.editorialDecisionProposal, input),
  };
}

function admittedPlannerNeedsInputSummary(summary: string, reasonCode: string): string {
  const fallback = `Planner needs input (${reasonCode}).`;
  try {
    assertModelResponseCredentialFree(summary);
  } catch {
    return fallback;
  }
  const withoutWebUrls = summary.replace(/\bhttps?:\/\/[^\s]+/giu, "");
  return /(?:^|[\s"'`(=:])(?:\/[^\s]|[A-Za-z]:[\\/]|~[\\/]|\\\\[^\s]|file:\/\/)/u.test(
    withoutWebUrls,
  )
    ? fallback
    : summary;
}
