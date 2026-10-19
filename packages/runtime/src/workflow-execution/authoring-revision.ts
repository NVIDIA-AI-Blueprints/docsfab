// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createContractKit } from "../contract-kit/index.js";
import {
  OUTPUT_RULES,
  rejectOutput,
  rejectTerminal,
  type LocationOf,
  type OutputRuleRejection,
  type TerminalCodeOf,
} from "../contracts/model-output.generated.js";
import { renderResponseContract } from "../contracts/model-output-render.js";
import type { HarnessStepInput } from "../execution/contracts.js";
import { InferenceStepError } from "../execution/contracts.js";
import type { InferenceRejectionSubjectV1 } from "../execution/rejection-subject.js";
import {
  canonicalizeJsonEvidence,
  parseJsonEvidence,
  type JsonEvidenceValue,
} from "../json-evidence.js";
import { assertModelResponseCredentialFree } from "../security/credential-isolation.js";
import {
  AUTHORING_REVISION_ACCOUNTING_ERROR,
  authoringRevisionAccountingDiagnosticFromMessage,
  authoringRevisionAccountingDiagnosticMessage,
  REVISE_DOCUMENTATION_STEP_ID,
  REVISION_ACCOUNTING_REJECTION_PREFIX,
  revisionAccountingDiagnosticForRejectionCode,
  type AuthoringRevisionAccountingDiagnosticCode,
  type RevisionAccountingRejectionCode,
} from "../workflow-contracts/run-recovery-presentation.js";
import type { AuthoringRevisionInputV1 } from "./authoring-candidate.js";
import { normalizeRepositoryLocator } from "./review-response.js";

export {
  authoringRevisionAccountingDiagnosticFromMessage,
  REVISE_DOCUMENTATION_STEP_ID,
  type AuthoringRevisionAccountingDiagnosticCode,
};

export interface AuthoringRevisionIssueAccountingV1 {
  readonly issueId: string;
  readonly disposition: "applied" | "rejected";
  readonly reason: string;
  readonly sourceLocators: readonly string[];
}

export interface AuthoringRevisionUnresolvedFactV1 {
  readonly factId: string;
  readonly reason: string;
}

export interface AuthoringRevisionAccountingV1 {
  readonly issueAccounting: readonly AuthoringRevisionIssueAccountingV1[];
  readonly changedPaths: readonly string[];
  readonly unresolvedFacts: readonly AuthoringRevisionUnresolvedFactV1[];
}

const ISSUE_ID = /^[A-Z]+-[0-9]{3}$/u;
const FACT_ID = /^[A-Z][A-Z0-9_-]{0,63}$/u;
const MAX_ROWS = 256;
const MAX_TEXT = 4_096;

/**
 * The structured rejection a revision-accounting code records: the code and
 * the one contract location the catalog declares for it
 * (`config/model-output/rules/revision-accounting.yaml`).
 */
export function revisionAccountingRejection(
  code: RevisionAccountingRejectionCode,
): OutputRuleRejection<RevisionAccountingRejectionCode> {
  return rejectOutput(code, OUTPUT_RULES[code].locations[0]);
}

/**
 * The refusal for one revision-accounting code: the fixed diagnostic message,
 * the code and contract location as the attempt's `rejection`, and the
 * catalog's retry disposition. `evidence` is the refused attempt's own.
 */
export function authoringRevisionAccountingError(
  diagnostic: AuthoringRevisionAccountingDiagnosticCode,
  evidence?: InferenceStepError["evidence"],
  rejectionSubject?: InferenceRejectionSubjectV1,
): InferenceStepError {
  const code: RevisionAccountingRejectionCode = `${REVISION_ACCOUNTING_REJECTION_PREFIX}${diagnostic}`;
  return new InferenceStepError(
    authoringRevisionAccountingDiagnosticMessage(diagnostic),
    "malformed-response",
    OUTPUT_RULES[code].retry === "model-correctable",
    evidence,
    revisionAccountingRejection(code),
    rejectionSubject ? { rejectionSubject } : undefined,
  );
}

/**
 * The coded revision-accounting diagnostic an error carries in its structured
 * rejection, or `undefined`. Reads the rejection code, never the message.
 */
export function authoringRevisionAccountingDiagnosticOf(
  error: unknown,
): AuthoringRevisionAccountingDiagnosticCode | undefined {
  return error instanceof InferenceStepError
    ? revisionAccountingDiagnosticForRejectionCode(error.rejection?.code)
    : undefined;
}

/**
 * The structured rejection to retain on the failed revision step, rebuilt from
 * the catalog rather than copied from the error, or `undefined` when the
 * error is not a coded revision-accounting refusal.
 */
export function authoringRevisionRejectionOf(
  error: unknown,
): { code: string; location: string } | undefined {
  const diagnostic = authoringRevisionAccountingDiagnosticOf(error);
  return diagnostic
    ? { ...revisionAccountingRejection(`${REVISION_ACCOUNTING_REJECTION_PREFIX}${diagnostic}`) }
    : undefined;
}

/**
 * A security or authority refusal of this family. It raises only through the
 * catalog's terminal path, so the code cannot be a correctable one.
 */
function terminal<C extends TerminalCodeOf<"revision-accounting">>(
  code: C,
  location: LocationOf<C>,
): C {
  return rejectTerminal("revision-accounting", code, location).code;
}

function fail(code?: RevisionAccountingRejectionCode): never {
  if (code) {
    throw authoringRevisionAccountingError(
      code.slice(
        REVISION_ACCOUNTING_REJECTION_PREFIX.length,
      ) as AuthoringRevisionAccountingDiagnosticCode,
    );
  }
  // An uncoded inner refusal; `atBoundary` replaces it with its boundary code.
  throw new InferenceStepError(AUTHORING_REVISION_ACCOUNTING_ERROR, "malformed-response", false);
}

function atBoundary<T>(code: RevisionAccountingRejectionCode, action: () => T): T {
  try {
    return action();
  } catch (error) {
    if (authoringRevisionAccountingDiagnosticOf(error)) throw error;
    return fail(code);
  }
}

const kit = createContractKit({
  fail: () => fail(),
  inertMode: "strict",
  codes: {
    invalidShape: "invalid-authoring-revision-accounting",
    invalidValue: "invalid-authoring-revision-accounting",
    digestMismatch: "invalid-authoring-revision-accounting",
    credentialMaterial: "invalid-authoring-revision-accounting",
    schemaMismatch: "invalid-authoring-revision-accounting",
  },
});

export function isAuthoringRevisionWriter(
  input: Pick<HarnessStepInput, "workflow" | "step">,
): boolean {
  return (
    input.workflow.schemaVersion === 3 &&
    input.workflow.name === "create-documentation" &&
    input.step.id === REVISE_DOCUMENTATION_STEP_ID &&
    input.step.skill === "write-documentation" &&
    (input.step.kind ?? "inference") === "inference" &&
    input.step.mode === "write"
  );
}

/**
 * Append the host-owned revision accounting contract to the writer's prompt.
 * The text is rendered from the catalog contract
 * (`config/model-output/contracts/authoring-revision.yaml`): each rule's one
 * statement, which is also its retry hint, and the host blocks below, rendered
 * from the sealed revision input only.
 */
export function bindAuthoringRevisionResponseContract(input: HarnessStepInput): HarnessStepInput {
  if (!isAuthoringRevisionWriter(input) || !input.authoringRevisionInput) return input;
  const revision = input.authoringRevisionInput;
  const locatorChoices = issueSourceLocatorChoices(revision);
  const issueIds = locatorChoices.map((choice) => choice.issueId);
  const contract = renderResponseContract("authoring-revision", {
    "selected-issue-ids": JSON.stringify(issueIds),
    "admitted-source-locators": canonicalizeJsonEvidence(
      locatorChoices as unknown as JsonEvidenceValue,
    ).trimEnd(),
    "sealed-revision-input": canonicalizeJsonEvidence(
      revision as unknown as JsonEvidenceValue,
    ).trimEnd(),
  });
  return {
    ...input,
    step: { ...input.step, prompt: [input.step.prompt, "", contract].join("\n") },
  };
}

export function decodeAuthoringRevisionAccounting(
  response: string,
  revision: AuthoringRevisionInputV1,
): AuthoringRevisionAccountingV1 {
  try {
    const parsed = atBoundary("revision-accounting-invalid-json", () =>
      parseJsonEvidence(response),
    );
    atBoundary(terminal("revision-accounting-unsafe-disclosure", "$"), () => {
      assertModelResponseCredentialFree(parsed);
    });
    const root = atBoundary("revision-accounting-invalid-root-shape", () => {
      const value = kit.object(parsed);
      kit.exact(value, ["issueAccounting", "changedPaths", "unresolvedFacts"]);
      return value;
    });
    const rows = atBoundary("revision-accounting-invalid-issue-row", () => {
      const rawRows = kit.array(root.issueAccounting);
      if (rawRows.length > MAX_ROWS) fail();
      return rawRows.map((value) => {
        const row = kit.object(value);
        kit.exact(row, ["issueId", "disposition", "reason", "sourceLocators"]);
        const issueId = kit.string(row.issueId);
        if (!ISSUE_ID.test(issueId)) fail();
        const disposition = kit.enumeration(row.disposition, ["applied", "rejected"] as const);
        const reason = boundedText(row.reason);
        const rawLocators = kit.array(row.sourceLocators);
        if (rawLocators.length > 64) fail();
        const sourceLocators = rawLocators.map((locator) => {
          const locatorValue = kit.string(locator);
          const normalized = normalizeRepositoryLocator(locatorValue);
          if (!normalized.specific || normalized.malformed || !normalized.path) fail();
          return locatorValue;
        });
        if (sourceLocators.length === 0 || new Set(sourceLocators).size !== sourceLocators.length) {
          fail();
        }
        return { issueId, disposition, reason, sourceLocators };
      });
    });
    const locatorChoices = issueSourceLocatorChoices(revision);
    const expected = locatorChoices.map((choice) => choice.issueId);
    const actual = rows.map((row) => row.issueId).sort();
    if (actual.length !== expected.length || actual.some((id, index) => id !== expected[index])) {
      fail("revision-accounting-issue-coverage");
    }
    const admittedLocatorsByIssue = new Map(
      locatorChoices.map((choice) => [choice.issueId, new Set(choice.sourceLocators)]),
    );
    for (const row of rows) {
      const admittedLocators = admittedLocatorsByIssue.get(row.issueId)!;
      if (row.sourceLocators.some((locator) => !admittedLocators.has(locator))) {
        fail(
          terminal(
            "revision-accounting-source-locator-membership",
            "$.issueAccounting[].sourceLocators[]",
          ),
        );
      }
    }
    const changedPaths = atBoundary("revision-accounting-invalid-changed-paths", () => {
      const rawChangedPaths = kit.array(root.changedPaths);
      if (rawChangedPaths.length > 512) fail();
      const values = rawChangedPaths.map(safePath);
      if (
        new Set(values).size !== values.length ||
        values.some((path) => !revision.writePaths.includes(path))
      ) {
        fail();
      }
      return values;
    });
    const admittedFacts = new Set(revision.actionableFacts.map((fact) => fact.id));
    const unresolvedFacts = atBoundary("revision-accounting-invalid-unresolved-facts", () => {
      const rawUnresolvedFacts = kit.array(root.unresolvedFacts);
      if (rawUnresolvedFacts.length > MAX_ROWS) fail();
      const values = rawUnresolvedFacts.map((value) => {
        const item = kit.object(value);
        kit.exact(item, ["factId", "reason"]);
        const factId = kit.string(item.factId);
        if (!FACT_ID.test(factId) || !admittedFacts.has(factId)) fail();
        return { factId, reason: boundedText(item.reason) };
      });
      if (new Set(values.map((fact) => fact.factId)).size !== values.length) fail();
      return values;
    });
    return Object.freeze({ issueAccounting: rows, changedPaths, unresolvedFacts });
  } catch (error) {
    if (error instanceof InferenceStepError) throw error;
    return fail();
  }
}

/**
 * The mutation-stage code that accepted accounting earns against the writer's
 * actual mutation, or `undefined` when they agree. One predicate serves both
 * callers: the in-attempt check before candidate 1 is sealed, where
 * `unchanged` means no planned page differs from candidate 0, and the sealed
 * check below, where it means the two candidate patches are identical.
 */
export function authoringRevisionMutationDiagnostic(input: {
  accounting: AuthoringRevisionAccountingV1;
  actualChangedPaths: readonly string[];
  unchanged: boolean;
}):
  | Extract<
      AuthoringRevisionAccountingDiagnosticCode,
      "changed-path-mismatch" | "unchanged-applied"
    >
  | undefined {
  const actual = [...new Set(input.actualChangedPaths)].sort();
  const declared = [...input.accounting.changedPaths].sort();
  if (actual.length !== declared.length || actual.some((path, index) => path !== declared[index])) {
    return "changed-path-mismatch";
  }
  if (
    input.unchanged &&
    input.accounting.issueAccounting.some((row) => row.disposition === "applied")
  ) {
    return "unchanged-applied";
  }
  return undefined;
}

export function validateAuthoringRevisionMutation(input: {
  accounting: AuthoringRevisionAccountingV1;
  actualChangedPaths: readonly string[];
  candidate0PatchSha256: string;
  candidate1PatchSha256: string;
}): void {
  const diagnostic = authoringRevisionMutationDiagnostic({
    accounting: input.accounting,
    actualChangedPaths: input.actualChangedPaths,
    unchanged: input.candidate0PatchSha256 === input.candidate1PatchSha256,
  });
  if (diagnostic) fail(`${REVISION_ACCOUNTING_REJECTION_PREFIX}${diagnostic}`);
}

function issueSourceLocatorChoices(revision: AuthoringRevisionInputV1): Array<{
  issueId: string;
  sourceLocators: string[];
}> {
  const locatorsByIssue = new Map<string, Set<string>>();
  for (const fact of revision.actionableFacts) {
    for (const issueId of fact.issueIds) {
      const locators = locatorsByIssue.get(issueId) ?? new Set<string>();
      for (const locator of fact.sourceLocators) locators.add(locator);
      locatorsByIssue.set(issueId, locators);
    }
  }
  return [...locatorsByIssue]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([issueId, locators]) => ({ issueId, sourceLocators: [...locators].sort() }));
}

function boundedText(value: unknown): string {
  const text = kit.string(value);
  if (text !== text.trim() || text.length < 8 || text.length > MAX_TEXT) fail();
  return text;
}

function safePath(value: unknown): string {
  const path = kit.string(value);
  if (
    !path ||
    path !== path.normalize("NFC") ||
    path.startsWith("/") ||
    path.includes("\\") ||
    /[\0-\x1f\x7f]/u.test(path) ||
    path.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    fail();
  }
  return path;
}
