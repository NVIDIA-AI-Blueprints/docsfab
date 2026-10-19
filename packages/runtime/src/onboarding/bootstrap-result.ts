// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** Model judgments for repository guidance; this data never grants a write. */
import { createContractKit, deepFreeze } from "../contract-kit/index.js";
import type { HarnessStepInput } from "../execution/contracts.js";
import { jsonEnvelopeBody } from "../execution/json-envelope.js";
import { parseJsonEvidence } from "../json-evidence.js";
import {
  SOURCE_CITATION_LOCATOR_KEYS,
  decodeSourceCitationLocator,
  mintSourceCitations,
  type MintedSourceCitationV1,
  type ObservedSourceLinesV1,
  type SourceCitationLocatorV1,
  type SourceCitationLocations,
  type SourceCitationSource,
} from "../repository/source-citation.js";

export const REPOSITORY_BOOTSTRAP_RESULT_KIND = "docsfab-repository-bootstrap-result" as const;
export const REPOSITORY_BOOTSTRAP_STEP = "bootstrap-guidance" as const;
/**
 * The one step whose reply the repository bootstrap adapter decodes. The
 * harness reads it too, so the reply the adapter decodes is the final settled
 * assistant message rather than text joined across turns.
 */
export function isRepositoryBootstrapStep(
  input: Pick<HarnessStepInput, "workflow" | "step">,
): boolean {
  return (
    input.workflow.name === "bootstrap" &&
    input.step.id === REPOSITORY_BOOTSTRAP_STEP &&
    input.step.skill === "repo-bootstrap" &&
    input.step.mode === "write" &&
    (input.step.kind ?? "inference") === "inference"
  );
}
export interface RepositoryBootstrapBindingV1 {
  readonly runId: string;
  readonly repositoryRevision: string;
  readonly contextSha256: string;
}
/**
 * The model's reply. Each evidence row is a locator only; the host mints its
 * quote ({@link admitRepositoryBootstrapReply}).
 */
export interface RepositoryBootstrapReplyV1 {
  readonly schemaVersion: 1;
  readonly kind: typeof REPOSITORY_BOOTSTRAP_RESULT_KIND;
  readonly binding: RepositoryBootstrapBindingV1;
  readonly decision: "patch" | "no-change" | "needs-input";
  readonly summary: string;
  readonly changedPaths: readonly string[];
  readonly evidence: readonly SourceCitationLocatorV1[];
  readonly assumptions: readonly string[];
  readonly missingEvidence: readonly string[];
  readonly questions: readonly string[];
}
/** The admitted result: the reply with each evidence row's host-minted quote. */
export interface RepositoryBootstrapResultV1 extends Omit<RepositoryBootstrapReplyV1, "evidence"> {
  readonly evidence: readonly MintedSourceCitationV1[];
}
const EVIDENCE_AT: SourceCitationLocations = {
  item: "$.evidence[]",
  total: "$.evidence",
};
/**
 * Operator code family for every repository bootstrap refusal. The bare reasons
 * (`path`, `schema`, `workflow`, `value`) are not globally unique operator
 * codes, so the code an operator sees carries this prefix and the whole family
 * is classified in one place (`OPERATOR_CODE_FAMILY_FAILURE_CLASSES`). The
 * message keeps the bare reason so it reads as prose.
 */
export const REPOSITORY_BOOTSTRAP_REFUSAL_FAMILY = "repository-bootstrap-";
export class RepositoryBootstrapResultError extends Error {
  /** Bare refusal reason, exactly as the message names it. */
  readonly reason: string;
  /** Family-prefixed operator code, catalogued by family, never a bare reason. */
  readonly code: string;
  constructor(reason: string) {
    super(`Repository bootstrap result refused: ${reason}.`);
    this.name = "RepositoryBootstrapResultError";
    this.reason = reason;
    this.code = `${REPOSITORY_BOOTSTRAP_REFUSAL_FAMILY}${reason}`;
  }
}
export function refuseBootstrapResult(reason: string): never {
  throw new RepositoryBootstrapResultError(reason);
}
const kit = createContractKit({
  fail: refuseBootstrapResult,
  inertMode: "strict",
  codes: {
    invalidShape: "shape",
    invalidValue: "value",
    digestMismatch: "digest",
    credentialMaterial: "credential-material",
    schemaMismatch: "schema",
    boundExceeded: "bound-exceeded",
  },
});
function text(value: unknown): string {
  // Exact source quotations may use decomposed Unicode. The strict inert
  // walk already bounds strings; normalization here would change their bytes.
  if (typeof value !== "string" || value.includes("\0") || !value.trim())
    refuseBootstrapResult("empty-text");
  return value;
}
export function bootstrapRepositoryPath(value: unknown): string {
  const path = text(value);
  if (
    path.startsWith("/") ||
    path.startsWith("~") ||
    /[\\:\x00-\x1f\x7f]/u.test(path) ||
    path.normalize("NFC") !== path ||
    path.split("/").some((part) => !part || part === "." || part === ".." || part === ".git")
  )
    refuseBootstrapResult("path");
  return path;
}
/** Operation-specific local tool boundary. Hosted write authority narrows it further. */
export function isRepositoryBootstrapGuidancePath(value: string): boolean {
  try {
    return /^(?:[^/]+\/)*(?:README|AGENTS)\.md$/u.test(bootstrapRepositoryPath(value));
  } catch {
    return false;
  }
}
/**
 * Decode the bootstrap step's model reply: the shared extraction policy picks
 * the candidate span, the strict JSON evidence parser reads it, and
 * {@link parseRepositoryBootstrapResult} judges the value. A span that is not
 * one strict JSON document is `response-json`. The harness hands this decoder
 * only the final settled assistant message of the attempt.
 */
export function decodeRepositoryBootstrapResponse(response: string): RepositoryBootstrapReplyV1 {
  let raw: unknown;
  try {
    raw = parseJsonEvidence(jsonEnvelopeBody(response));
  } catch {
    refuseBootstrapResult("response-json");
  }
  return parseRepositoryBootstrapResult(raw);
}
/**
 * Judge the model's reply. An evidence row that is not exactly a locator, such
 * as one carrying quoted text, is the catalog rule `source-citation-locator-shape`.
 */
export function parseRepositoryBootstrapResult(input: unknown): RepositoryBootstrapReplyV1 {
  return parseBootstrapDocument(input, (value) => decodeSourceCitationLocator(value, EVIDENCE_AT));
}
/** Judge an admitted result, the canonical step summary with minted quotes. */
export function parseRepositoryBootstrapArtifact(input: unknown): RepositoryBootstrapResultV1 {
  return parseBootstrapDocument(input, (value) => {
    const row = kit.object(value);
    kit.exact(row, [...SOURCE_CITATION_LOCATOR_KEYS, "quote"]);
    let locator: SourceCitationLocatorV1;
    try {
      locator = decodeSourceCitationLocator(
        { path: row.path, startLine: row.startLine, endLine: row.endLine },
        EVIDENCE_AT,
      );
    } catch {
      refuseBootstrapResult("value");
    }
    return { ...locator, quote: text(row.quote) };
  });
}
/**
 * Admit a judged reply: mint each evidence row's exact quote from the cited
 * bytes at the exact revision and the lines the model was shown before it
 * edited that file, then screen the minted result for credential material.
 */
export function admitRepositoryBootstrapReply(
  reply: RepositoryBootstrapReplyV1,
  sources: ReadonlyMap<string, SourceCitationSource>,
  observed: ObservedSourceLinesV1 | undefined,
): RepositoryBootstrapResultV1 {
  const result = {
    ...reply,
    evidence: mintSourceCitations(reply.evidence, sources, observed, EVIDENCE_AT),
  };
  kit.rejectCredentials(result);
  return deepFreeze(result);
}
function parseBootstrapDocument<E>(input: unknown, evidenceRow: (value: unknown) => E) {
  kit.assertInert(input);
  kit.rejectCredentials(input);
  const root = kit.object(input);
  kit.exact(root, [
    "schemaVersion",
    "kind",
    "binding",
    "decision",
    "summary",
    "changedPaths",
    "evidence",
    "assumptions",
    "missingEvidence",
    "questions",
  ]);
  if (root.schemaVersion !== 1 || root.kind !== REPOSITORY_BOOTSTRAP_RESULT_KIND)
    refuseBootstrapResult("schema");
  const binding = kit.object(root.binding);
  kit.exact(binding, ["runId", "repositoryRevision", "contextSha256"]);
  const parsedBinding = {
    runId: kit.identifier(binding.runId),
    repositoryRevision: kit.revision(binding.repositoryRevision),
    contextSha256: kit.hash(binding.contextSha256),
  };
  const decision = kit.enumeration(root.decision, ["patch", "no-change", "needs-input"] as const);
  const changedPaths = kit.array(root.changedPaths).map(bootstrapRepositoryPath);
  if (
    new Set(changedPaths).size !== changedPaths.length ||
    changedPaths.some((path) => !isRepositoryBootstrapGuidancePath(path))
  )
    refuseBootstrapResult("changed-paths");
  const evidence = kit.array(root.evidence).map(evidenceRow);
  const assumptions = kit.array(root.assumptions).map(text),
    missingEvidence = kit.array(root.missingEvidence).map(text),
    questions = kit.array(root.questions).map(text);
  if (
    decision === "patch" &&
    (!changedPaths.length || !evidence.length || missingEvidence.length || questions.length)
  )
    refuseBootstrapResult("patch-decision");
  if (decision !== "patch" && changedPaths.length) refuseBootstrapResult("empty-decision");
  if (
    decision === "no-change" &&
    (!evidence.length || assumptions.length || missingEvidence.length || questions.length)
  )
    refuseBootstrapResult("no-change-decision");
  if (decision === "needs-input" && !questions.length) refuseBootstrapResult("missing-question");
  return deepFreeze({
    schemaVersion: 1 as const,
    kind: REPOSITORY_BOOTSTRAP_RESULT_KIND,
    binding: parsedBinding,
    decision,
    summary: text(root.summary),
    changedPaths,
    evidence,
    assumptions,
    missingEvidence,
    questions,
  });
}
