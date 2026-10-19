// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** Typed model judgment over the declared source rubric; never a write or release grant. */
import { constants as bufferConstants } from "node:buffer";
import { isAbsolute } from "node:path";
import { createContractKit, canonicalJson, deepFreeze } from "../contract-kit/index.js";
import { jsonEnvelopeBody } from "../execution/json-envelope.js";
import { parseJsonEvidence } from "../json-evidence.js";
import {
  InferenceStepError,
  type AgentHarness,
  type HarnessStepInput,
  type HarnessStepResult,
} from "../execution/contracts.js";
import type { RepositoryWorkspace } from "../repository/workspace/contracts.js";
import {
  readTrackedRepositoryFile,
  verifyActiveRepositoryWorkspace,
} from "../repository/workspace/tracked-read.js";
import { RepositoryWorkspaceReadError } from "../repository/workspace/contracts.js";
import {
  SOURCE_CITATION_LOCATOR_KEYS,
  SourceCitationRefusal,
  decodeSourceCitationLocator,
  mintSourceCitations,
  mintedSourceCitationHolds,
  sourceCitationContractText,
  sourceCitationPaths,
  sourceCitationStepError,
  type MintedSourceCitationV1,
  type ObservedSourceLinesV1,
  type SourceCitationLocatorV1,
  type SourceCitationLocations,
  type SourceCitationSource,
} from "../repository/source-citation.js";
import { sourceReadinessSearch } from "./workflow.js";

export const SOURCE_READINESS_ASSESSMENT_KIND = "docsfab-source-readiness-assessment";
export type SourceReadinessAssessmentErrorCode =
  | "invalid-assessment"
  | "binding-mismatch"
  | "citation-mismatch"
  | "unassessed-available-sources"
  | "credential-material";
export class SourceReadinessAssessmentError extends Error {
  constructor(readonly code: SourceReadinessAssessmentErrorCode) {
    super(
      code === "unassessed-available-sources"
        ? "All readiness criteria were left unassessed. Review the admitted source brief, read the available source evidence, and assess each criterion; preserve unassessed only when a required input is unavailable."
        : `Source readiness assessment rejected: ${code}.`,
    );
    this.name = "SourceReadinessAssessmentError";
  }
}
function fail(code: SourceReadinessAssessmentErrorCode): never {
  throw new SourceReadinessAssessmentError(code);
} // hygiene: ok
const kit = createContractKit({
  fail,
  inertMode: "strict",
  codes: {
    invalidShape: "invalid-assessment",
    invalidValue: "invalid-assessment",
    digestMismatch: "binding-mismatch",
    credentialMaterial: "credential-material",
    schemaMismatch: "invalid-assessment",
  },
});
export interface SourceReadinessBinding {
  readonly runId: string;
  readonly repositoryRevision: string;
  readonly searchEvidenceSha256: string;
  readonly contextPacketSha256: string | null;
}
export interface SourceReadinessAssessment extends SourceReadinessBinding {
  readonly schemaVersion: 1;
  readonly kind: typeof SOURCE_READINESS_ASSESSMENT_KIND;
  readonly summary: string;
  readonly criteria: readonly {
    readonly criterionId: string;
    readonly status: "met" | "unmet" | "unassessed";
    readonly reason: string;
    readonly citations: readonly MintedSourceCitationV1[];
  }[];
}
/**
 * The model's reply: the same judgment, with each citation a locator only. The
 * host mints the quote ({@link admitSourceReadinessReply}).
 */
export interface SourceReadinessReply extends SourceReadinessBinding {
  readonly summary: string;
  readonly criteria: readonly {
    readonly criterionId: string;
    readonly status: "met" | "unmet" | "unassessed";
    readonly reason: string;
    readonly citations: readonly SourceCitationLocatorV1[];
  }[];
}
const CITATIONS_AT: SourceCitationLocations = {
  item: "$.criteria[].citations[]",
  total: "$.criteria",
};
const criterionIds = sourceReadinessSearch.targets.flatMap((target) =>
  target.targetType === "rubric-coverage"
    ? target.rubric.criteria.map((criterion) => criterion.id)
    : [],
);
function prose(value: unknown): string {
  // Preserve exact Unicode prose and quotations, including valid decomposed text.
  if (typeof value !== "string" || !value.trim() || value.includes("\0"))
    fail("invalid-assessment");
  return value;
}
/**
 * The one step whose reply this module decodes: every step of the `readiness`
 * workflow. The harness reads it too, so the reply it hands this decoder is
 * the final settled assistant message rather than text joined across turns.
 */
export function isSourceReadinessStep(input: Pick<HarnessStepInput, "workflow">): boolean {
  return input.workflow.name === "readiness";
}
export function sourceReadinessBinding(input: HarnessStepInput): SourceReadinessBinding {
  if (!input.runId || !input.evidenceIdentity || !input.searchEvidence) fail("binding-mismatch");
  return {
    runId: input.runId,
    repositoryRevision: input.evidenceIdentity.repositoryRevision,
    searchEvidenceSha256: input.searchEvidence.evidenceSha256,
    contextPacketSha256: input.evidenceIdentity.contextPacketDigest ?? null,
  };
}
/**
 * Decode one assessment document, the model's reply or the host's admitted
 * artifact. Only the citation item differs: a reply cites by locator alone,
 * and an artifact also carries the quote the host minted.
 */
function decodeAssessmentDocument<C>(
  text: string,
  expected: SourceReadinessBinding,
  citation: (value: unknown) => C,
) {
  let value: unknown;
  try {
    // The shared extraction policy picks the candidate span, and the strict
    // parser still judges it. The harness hands this decoder only the final
    // settled assistant message of the attempt, so the span cannot be an
    // earlier turn's document.
    value = parseJsonEvidence(jsonEnvelopeBody(text));
  } catch {
    fail("invalid-assessment");
  }
  kit.assertInert(value);
  kit.rejectCredentials(value);
  const body = kit.object(value);
  kit.exact(body, [
    "schemaVersion",
    "kind",
    "runId",
    "repositoryRevision",
    "searchEvidenceSha256",
    "contextPacketSha256",
    "summary",
    "criteria",
  ]);
  if (body.schemaVersion !== 1 || body.kind !== SOURCE_READINESS_ASSESSMENT_KIND)
    fail("invalid-assessment");
  if (Object.entries(expected).some(([key, value]) => body[key] !== value))
    fail("binding-mismatch");
  kit.identifier(body.runId);
  kit.hash(body.searchEvidenceSha256);
  kit.nullableHash(body.contextPacketSha256);
  if (
    typeof body.repositoryRevision !== "string" ||
    !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(body.repositoryRevision)
  )
    fail("invalid-assessment");
  const criteria = kit.array(body.criteria).map((value) => {
    const row = kit.object(value);
    kit.exact(row, ["criterionId", "status", "reason", "citations"]);
    const criterionId = kit.identifier(row.criterionId),
      status = kit.enumeration(row.status, ["met", "unmet", "unassessed"] as const);
    const citations = kit.array(row.citations).map(citation);
    if (status !== "unassessed" && citations.length === 0) fail("invalid-assessment");
    return { criterionId, status, reason: prose(row.reason), citations };
  });
  if (
    canonicalJson(criteria.map((item) => item.criterionId).sort()) !==
    canonicalJson([...criterionIds].sort())
  )
    fail("invalid-assessment");
  return { summary: prose(body.summary), criteria };
}
/**
 * Decode the model's reply. A citation that is not exactly a locator, such as
 * one carrying quoted text, is the catalog rule `source-citation-locator-shape`.
 */
export function decodeSourceReadinessReply(
  text: string,
  expected: SourceReadinessBinding,
): SourceReadinessReply {
  const reply = decodeAssessmentDocument(text, expected, (value) =>
    decodeSourceCitationLocator(value, CITATIONS_AT),
  );
  return deepFreeze({ ...expected, ...reply });
}
/** Every distinct path the reply cites, for the caller's tracked reader. */
export function sourceReadinessCitedPaths(reply: SourceReadinessReply): string[] {
  return sourceCitationPaths(reply.criteria.flatMap((criterion) => criterion.citations));
}

function hasAvailableReadinessSources(input: HarnessStepInput): boolean {
  return (
    input.searchEvidence?.searches.some((search) =>
      search.bounded.probes.some(
        (probe) =>
          probe.strategy === "documentation-inventory" &&
          probe.outcome === "match" &&
          probe.matchCount > 0,
      ),
    ) ?? false
  );
}

function rejectedAllUnassessed(
  reply: SourceReadinessReply,
  input: HarnessStepInput,
  observed: ObservedSourceLinesV1 | undefined,
): boolean {
  if (!reply.criteria.every((criterion) => criterion.status === "unassessed")) return false;
  const madeReads = Boolean(observed && Object.keys(observed).length > 0);
  return hasAvailableReadinessSources(input) || !madeReads;
}
/**
 * Admit a decoded reply: mint each citation's exact quote from the cited bytes
 * and the lines the model was shown this attempt, then screen the minted
 * artifact for credential material, as the model's own text is screened.
 */
export function admitSourceReadinessReply(
  reply: SourceReadinessReply,
  sources: ReadonlyMap<string, SourceCitationSource>,
  observed: ObservedSourceLinesV1 | undefined,
): SourceReadinessAssessment {
  const minted = mintSourceCitations(
    reply.criteria.flatMap((criterion) => criterion.citations),
    sources,
    observed,
    CITATIONS_AT,
  );
  let next = 0;
  const assessment = {
    schemaVersion: 1 as const,
    kind: SOURCE_READINESS_ASSESSMENT_KIND as typeof SOURCE_READINESS_ASSESSMENT_KIND,
    runId: reply.runId,
    repositoryRevision: reply.repositoryRevision,
    searchEvidenceSha256: reply.searchEvidenceSha256,
    contextPacketSha256: reply.contextPacketSha256,
    summary: reply.summary,
    criteria: reply.criteria.map((criterion) => ({
      ...criterion,
      citations: criterion.citations.map(() => minted[next++]!),
    })),
  };
  kit.rejectCredentials(assessment);
  return deepFreeze(assessment);
}
/** Decode the host's admitted artifact, the canonical step summary. */
export function decodeSourceReadinessAssessment(
  text: string,
  expected: SourceReadinessBinding,
): SourceReadinessAssessment {
  const assessment = decodeAssessmentDocument(text, expected, (value) => {
    const citation = kit.object(value);
    kit.exact(citation, [...SOURCE_CITATION_LOCATOR_KEYS, "quote"]);
    let locator: SourceCitationLocatorV1;
    try {
      locator = decodeSourceCitationLocator(
        {
          path: citation.path,
          startLine: citation.startLine,
          endLine: citation.endLine,
        },
        CITATIONS_AT,
      );
    } catch {
      fail("invalid-assessment");
    }
    return { ...locator, quote: prose(citation.quote) };
  });
  return deepFreeze({
    ...expected,
    schemaVersion: 1,
    kind: SOURCE_READINESS_ASSESSMENT_KIND,
    ...assessment,
  });
}
/**
 * Read every cited path through the tracked-file capability. A path that is
 * not a tracked regular file, or is over the decoder's ceiling, is reported as
 * such for the citation rules; any other read fault is the host's.
 */
export async function readSourceReadinessCitations(
  workspace: RepositoryWorkspace,
  paths: readonly string[],
): Promise<Map<string, SourceCitationSource>> {
  try {
    await verifyActiveRepositoryWorkspace(workspace);
  } catch {
    fail("citation-mismatch");
  }
  const sources = new Map<string, SourceCitationSource>();
  for (const path of paths) {
    try {
      // A representation boundary for the exact UTF-8 file decoder, not a job
      // allowance. The existing capability checks its tracked bytes and inode.
      sources.set(
        path,
        await readTrackedRepositoryFile(workspace, path, bufferConstants.MAX_STRING_LENGTH),
      );
    } catch (error) {
      // Condition: the capability's own verdict on the path. Any other fault,
      // such as a workspace that changed under the read, is not a citation
      // the model can correct.
      if (!(error instanceof RepositoryWorkspaceReadError)) throw error;
      if (error.code === "not-tracked" || error.code === "unsafe-kind")
        sources.set(path, "untracked");
      else if (error.code === "oversize") sources.set(path, "unreadable");
      else fail("citation-mismatch");
    }
  }
  return sources;
}
/**
 * Re-mint every admitted citation from the workspace; a quote that is no
 * longer exactly its cited lines is `citation-mismatch`. An integrity check of
 * the host artifact, never a model rule.
 */
export async function verifySourceReadinessCitations(
  assessment: SourceReadinessAssessment,
  workspace: RepositoryWorkspace,
): Promise<void> {
  if (assessment.repositoryRevision !== workspace.revision) fail("binding-mismatch");
  const citations = assessment.criteria.flatMap((criterion) => criterion.citations);
  const sources = await readSourceReadinessCitations(workspace, sourceCitationPaths(citations));
  for (const citation of citations)
    if (!mintedSourceCitationHolds(citation, sources.get(citation.path) ?? "untracked"))
      fail("citation-mismatch");
}
export function sourceReadinessResponseContract(input: HarnessStepInput): string {
  if (!isSourceReadinessStep(input)) return "";
  const binding = sourceReadinessBinding(input);
  return [
    "",
    "Source-readiness response contract (host-owned):",
    `Return one JSON object with no Markdown fences: ${JSON.stringify({
      schemaVersion: 1,
      kind: SOURCE_READINESS_ASSESSMENT_KIND,
      ...binding,
      summary: "Complete readable assessment and recommendations",
      criteria: criterionIds.map((criterionId) => ({
        criterionId,
        status: "met|unmet|unassessed",
        reason: "Evidence-backed judgment or specific missing input",
        citations: [{ path: "repository-relative-file", startLine: 1, endLine: 1 }],
      })),
    })}`,
    "Copy the supplied run, revision, search and context bindings exactly; do not calculate a hash. Follow the skill's rubric. Met or unmet judgments require at least one citation of the tracked lines that support them; unassessed criteria may have no citations. Preserve uncertainty instead of inventing evidence. If every criterion would be unassessed, review this source brief and read available source evidence before answering. Leave a criterion unassessed only when a required input is unavailable. This is model assessment, not release approval.",
    sourceCitationContractText(),
  ].join("\n");
}
export function unassessedSourceReadinessFixture(input: HarnessStepInput): string {
  return canonicalJson({
    schemaVersion: 1,
    kind: SOURCE_READINESS_ASSESSMENT_KIND,
    ...sourceReadinessBinding(input),
    summary: "The offline fixture does not perform semantic source assessment.",
    criteria: criterionIds.map((criterionId) => ({
      criterionId,
      status: "unassessed",
      reason: "No semantic model judgment was made by this offline fixture.",
      citations: [],
    })),
  });
}
type SourceReadinessStepEvidence = Pick<
  HarnessStepResult,
  "model" | "usage" | "tools" | "turns" | "executionLease"
>;
/**
 * The step error for a refused readiness reply. A citation refusal carries its
 * catalog rule and location, so a bounded retry re-asks with that rule's
 * sentence. The all-unassessed refusal has one host-owned correction; other
 * assessment refusals remain generic, and only credential material is terminal.
 */
export function sourceReadinessStepError(
  error: SourceReadinessAssessmentError | SourceCitationRefusal,
  evidence?: SourceReadinessStepEvidence,
): InferenceStepError {
  if (error instanceof SourceCitationRefusal)
    return sourceCitationStepError(error, "Source readiness assessment rejected:", evidence);
  const rejection =
    error.code === "unassessed-available-sources"
      ? { code: "source-readiness-unassessed-available-sources", location: "$.criteria" }
      : undefined;
  return new InferenceStepError(
    error.message,
    "malformed-response",
    error.code !== "credential-material",
    evidence,
    rejection,
  );
}
/** Validation stays inside the runner's existing retry and attempt-retention boundary. */
export function wrapSourceReadinessHarness(
  base: AgentHarness,
  workspace: RepositoryWorkspace,
  mode: "model" | "internal-offline-fixture" = "model",
): AgentHarness {
  return {
    ...(base.inspectSkill
      ? {
          inspectSkill: (input: HarnessStepInput) => base.inspectSkill!.call(base, input),
        }
      : {}),
    async runStep(input) {
      const result = await base.runStep.call(base, input);
      if (!isSourceReadinessStep(input)) return result;
      try {
        const reply = decodeSourceReadinessReply(result.summary, sourceReadinessBinding(input));
        if (reply.repositoryRevision !== workspace.revision) fail("binding-mismatch");
        if (mode === "model" && rejectedAllUnassessed(reply, input, result.observedSourceLines)) {
          fail("unassessed-available-sources");
        }
        const sources = await readSourceReadinessCitations(
          workspace,
          sourceReadinessCitedPaths(reply),
        );
        const assessment = admitSourceReadinessReply(reply, sources, result.observedSourceLines);
        // The ledger is attempt-internal evidence for this admission only.
        const { observedSourceLines: _observed, ...admitted } = result;
        return { ...admitted, summary: canonicalJson(assessment) };
      } catch (error) {
        // Condition: a refusal this admission raised. Anything else, such as a
        // workspace fault while reading cited files, is not a reply defect.
        if (
          !(error instanceof SourceReadinessAssessmentError) &&
          !(error instanceof SourceCitationRefusal)
        )
          throw error;
        throw sourceReadinessStepError(error, {
          ...(result.model ? { model: result.model } : {}),
          ...(result.usage ? { usage: result.usage } : {}),
          ...(result.tools ? { tools: result.tools } : {}),
          ...(result.turns ? { turns: result.turns } : {}),
          ...(result.executionLease ? { executionLease: result.executionLease } : {}),
        });
      }
    },
  };
}
