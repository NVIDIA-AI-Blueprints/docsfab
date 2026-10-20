// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { HarnessStepInput } from "../src/execution/contracts.js";
import { InferenceStepError } from "../src/execution/contracts.js";
import { canonicalizeJsonEvidence, type JsonEvidenceValue } from "../src/json-evidence.js";
import { documentationAuditSearch } from "../src/maturity/audit-search-plan.js";
import { documentationObservationSearch } from "../src/search/observation-search-plan.js";
import { parseWorkflowManifestSnapshot } from "../src/workflow-registry/manifest.js";
import {
  bindAuthoringRevisionResponseContract,
  decodeAuthoringRevisionAccounting,
  validateAuthoringRevisionMutation,
} from "../src/workflow-execution/authoring-revision.js";
import type { AuthoringRevisionInputV1 } from "../src/workflow-execution/authoring-candidate.js";
import { OUTPUT_REPLAY_MODES, OUTPUT_RULES } from "../src/contracts/model-output.js";
import type { RevisionAccountingRejectionCode } from "../src/workflow-contracts/run-recovery-presentation.js";
import { buildDocsFabStepPrompt } from "../src/harness/pi-session.js";
import { authoringManifestV3 } from "./helpers/authoring-manifest.js";
import {
  createRealAuthoringEvidenceFixture,
  type RealAuthoringEvidenceFixture,
} from "./helpers/authoring-evidence.js";
import { configureCredentialsForEachTest } from "./helpers/configured-credential.js";

const workflow = parseWorkflowManifestSnapshot(authoringManifestV3(), "create-documentation", {
  "documentation-audit": documentationAuditSearch,
  "documentation-observation": documentationObservationSearch,
});

let fixture: RealAuthoringEvidenceFixture;

beforeAll(async () => {
  fixture = await createRealAuthoringEvidenceFixture(workflow, { actionable: true });
});
afterAll(async () => fixture?.dispose());

// The disclosure fixtures below quote this value. It is one of DocsFab's own
// configured credentials for each test, so the decoder refuses it; a
// credential shape alone is admitted (#1807).
const DISCLOSED_KEY = ["AKIA", "1234567890ABCDEF"].join("");

describe("CREATE revision writer accounting", () => {
  configureCredentialsForEachTest(DISCLOSED_KEY);

  it("renders the exact sorted per-issue locator choices that the decoder admits", () => {
    const revision = multiIssueRevisionInput();
    const bound = bindAuthoringRevisionResponseContract(revisionWriterInput(revision));
    const choices = [
      {
        issueId: "TECH-001",
        sourceLocators: ["src/contract.ts:1-3", "src/contract.ts:7-9", "src/shared.ts:4-6"],
      },
      {
        issueId: "TECH-002",
        sourceLocators: ["src/service.ts:12-14", "src/shared.ts:4-6"],
      },
    ];
    const renderedChoices = canonicalizeJsonEvidence(
      choices as unknown as JsonEvidenceValue,
    ).trimEnd();

    expect(bound.step.prompt).toContain(renderedChoices);
    expect(bound.step.prompt).toContain(
      "copy one or more sourceLocators verbatim from that same issue's allowed list",
    );
    const accounting = decodeAuthoringRevisionAccounting(
      JSON.stringify({
        issueAccounting: choices.map((choice) => ({
          issueId: choice.issueId,
          disposition: "applied",
          reason: "The admitted source establishes this bounded correction.",
          sourceLocators: choice.sourceLocators,
        })),
        changedPaths: [...revision.writePaths],
        unresolvedFacts: [],
      }),
      revision,
    );
    expect(accounting.issueAccounting).toEqual(
      choices.map((choice) => expect.objectContaining(choice)),
    );
  });

  it.each([
    ["cross-issue locator", "TECH-001", ["src/service.ts:12-14"]],
    ["changed locator range", "TECH-001", ["src/contract.ts:1-4"]],
  ] as const)(
    "rejects a %s with the existing membership diagnostic",
    (_name, issueId, locators) => {
      const revision = multiIssueRevisionInput();
      const otherIssueId = issueId === "TECH-001" ? "TECH-002" : "TECH-001";
      expectAccountingDiagnostic(
        () =>
          decodeAuthoringRevisionAccounting(
            JSON.stringify({
              issueAccounting: [
                {
                  issueId,
                  disposition: "applied",
                  reason: "The admitted source establishes this bounded correction.",
                  sourceLocators: locators,
                },
                {
                  issueId: otherIssueId,
                  disposition: "rejected",
                  reason: "The admitted source does not support this bounded correction.",
                  sourceLocators: ["src/shared.ts:4-6"],
                },
              ],
              changedPaths: [...revision.writePaths],
              unresolvedFacts: [],
            }),
            revision,
          ),
        "revision-accounting-source-locator-membership",
      );
    },
  );

  it("leaves a non-CREATE binder input unchanged", () => {
    const input = revisionWriterInput(multiIssueRevisionInput());
    const nonCreate = {
      ...input,
      workflow: { ...input.workflow, name: "update-documentation" as const },
    };

    expect(bindAuthoringRevisionResponseContract(nonCreate)).toBe(nonCreate);
  });

  it("admits complete issue accounting inside the frozen source and write scope", () => {
    if (fixture.selection.kind !== "revise") throw new Error("fixture must select revision");
    const issueId = fixture.selection.input.actionableFacts[0]!.issueIds[0]!;
    const locator = fixture.selection.input.actionableFacts[0]!.sourceLocators[0]!;
    const accounting = decodeAuthoringRevisionAccounting(
      JSON.stringify({
        issueAccounting: [
          {
            issueId,
            disposition: "applied",
            reason: "The admitted source establishes the bounded correction.",
            sourceLocators: [locator],
          },
        ],
        changedPaths: [fixture.writePaths[0]],
        unresolvedFacts: [],
      }),
      fixture.selection.input,
    );

    expect(accounting.issueAccounting).toHaveLength(1);
    expect(() =>
      validateAuthoringRevisionMutation({
        accounting,
        actualChangedPaths: fixture.writePaths,
        candidate0PatchSha256: "1".repeat(64),
        candidate1PatchSha256: "2".repeat(64),
      }),
    ).not.toThrow();
  });

  it.each([
    [
      "missing issue",
      { issueAccounting: [], changedPaths: ["docs/guide.md"], unresolvedFacts: [] },
    ],
    [
      "outside locator",
      {
        issueAccounting: [
          {
            issueId: "TECH-001",
            disposition: "applied",
            reason: "The unsupported source is outside the admitted evidence.",
            sourceLocators: ["src/unrelated.ts:9"],
          },
        ],
        changedPaths: ["docs/guide.md"],
        unresolvedFacts: [],
      },
    ],
    [
      "outside write path",
      {
        issueAccounting: [
          {
            issueId: "TECH-001",
            disposition: "rejected",
            reason: "The admitted evidence does not support this correction.",
            sourceLocators: ["src/contract.ts:1-3"],
          },
        ],
        changedPaths: ["docs/unplanned.md"],
        unresolvedFacts: [],
      },
    ],
  ])("rejects %s without widening authority", (_name, response) => {
    if (fixture.selection.kind !== "revise") throw new Error("fixture must select revision");
    expect(() =>
      decodeAuthoringRevisionAccounting(JSON.stringify(response), fixture.selection.input),
    ).toThrow("host-owned contract");
  });

  it.each([
    ["invalid JSON", "{", "revision-accounting-invalid-json"],
    [
      "unsafe disclosure",
      () => responseFixture({ reason: `The correction quotes ${DISCLOSED_KEY}.` }),
      "revision-accounting-unsafe-disclosure",
    ],
    [
      "root shape",
      () => ({ ...responseFixture(), unexpected: true }),
      "revision-accounting-invalid-root-shape",
    ],
    [
      "issue row",
      () => responseFixture({ disposition: "unknown" }),
      "revision-accounting-invalid-issue-row",
    ],
    [
      "selected issue coverage",
      () => ({ ...responseFixture(), issueAccounting: [] }),
      "revision-accounting-issue-coverage",
    ],
    [
      "source locator membership",
      () => responseFixture({ sourceLocators: ["src/unrelated.ts:9"] }),
      "revision-accounting-source-locator-membership",
    ],
    [
      "changed paths",
      () => ({ ...responseFixture(), changedPaths: ["docs/unplanned.md"] }),
      "revision-accounting-invalid-changed-paths",
    ],
    [
      "unresolved facts",
      () => ({
        ...responseFixture(),
        unresolvedFacts: [
          { factId: "UNKNOWN_FACT", reason: "The fact remains unresolved after revision." },
        ],
      }),
      "revision-accounting-invalid-unresolved-facts",
    ],
  ] as const)("retains the static diagnostic for %s", (_name, value, code) => {
    if (fixture.selection.kind !== "revise") throw new Error("fixture must select revision");
    const response = typeof value === "function" ? JSON.stringify(value()) : value;
    expectAccountingDiagnostic(
      () => decodeAuthoringRevisionAccounting(response, fixture.selection.input),
      code,
    );
  });

  it("keeps concurrent decoder diagnostics bound to their own rejected boundary", async () => {
    if (fixture.selection.kind !== "revise") throw new Error("fixture must select revision");
    const messages = await Promise.all([
      Promise.resolve().then(
        () =>
          expectAccountingDiagnostic(
            () => decodeAuthoringRevisionAccounting("{", fixture.selection.input),
            "revision-accounting-invalid-json",
          ).message,
      ),
      Promise.resolve().then(
        () =>
          expectAccountingDiagnostic(
            () =>
              decodeAuthoringRevisionAccounting(
                JSON.stringify(responseFixture({ sourceLocators: ["src/unrelated.ts:9"] })),
                fixture.selection.input,
              ),
            "revision-accounting-source-locator-membership",
          ).message,
      ),
    ]);

    expect(messages[0]).toContain("revision-accounting-invalid-json");
    expect(messages[1]).toContain("revision-accounting-source-locator-membership");
    expect(messages[0]).not.toContain("source-locator-membership");
    expect(messages[1]).not.toContain("invalid-json");
  });

  it("admits a reason that cites paths in prose", () => {
    if (fixture.selection.kind !== "revise") throw new Error("fixture must select revision");
    const reason = "Runs under /usr/bin/env as /home/node, logs file:42, and writes /tmp/x.";
    expect(
      decodeAuthoringRevisionAccounting(
        JSON.stringify(responseFixture({ reason })),
        fixture.selection.input,
      ).issueAccounting[0]?.reason,
    ).toBe(reason);
  });

  it("admits a reason that quotes a credential shape that is not configured (#1807)", () => {
    if (fixture.selection.kind !== "revise") throw new Error("fixture must select revision");
    const reason = `The correction quotes ${["AKIA", "Z9Y8X7W6V5U4T3S2"].join("")}.`;
    expect(
      decodeAuthoringRevisionAccounting(
        JSON.stringify(responseFixture({ reason })),
        fixture.selection.input,
      ).issueAccounting[0]?.reason,
    ).toBe(reason);
  });

  it.each([DISCLOSED_KEY])(
    "does not retain rejected disclosure text in the diagnostic: %s",
    (disclosure) => {
      if (fixture.selection.kind !== "revise") throw new Error("fixture must select revision");
      try {
        decodeAuthoringRevisionAccounting(
          JSON.stringify(responseFixture({ reason: `Rejected disclosure ${disclosure}` })),
          fixture.selection.input,
        );
        throw new Error("fixture disclosure was unexpectedly admitted");
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toBe(
          "Authoring revision accounting did not satisfy the host-owned contract: revision-accounting-unsafe-disclosure.",
        );
        expect((error as Error).message).not.toContain(disclosure);
      }
    },
  );

  it("states the coded rule on the revision writer's retry, and on no other write step (#1266)", () => {
    const input = revisionWriterInput(multiIssueRevisionInput());
    const correction = {
      rejection: { code: "revision-accounting-changed-path-mismatch", location: "$.changedPaths" },
    };
    const retry = buildDocsFabStepPrompt({
      ...input,
      inferenceAttempt: 2,
      responseCorrection: correction,
    });
    expect(retry).toContain(
      "The previous response failed host rule revision-accounting-changed-path-mismatch at $.changedPaths.",
    );
    expect(retry).toContain(OUTPUT_REPLAY_MODES["reset-write-step"].statement);
    expect(
      buildDocsFabStepPrompt({ ...input, inferenceAttempt: 1, responseCorrection: correction }),
    ).not.toContain("Host validation feedback");
    const writer = workflow.authoringSchedule!.prefix.steps.find(
      (candidate) => candidate.id === "write-documentation",
    )!;
    expect(
      buildDocsFabStepPrompt({
        ...input,
        step: writer,
        inferenceAttempt: 2,
        responseCorrection: correction,
      }),
    ).not.toContain("Host validation feedback");
  });

  it("distinguishes mutation path mismatch from unchanged applied accounting", () => {
    if (fixture.selection.kind !== "revise") throw new Error("fixture must select revision");
    const accounting = decodeAuthoringRevisionAccounting(
      JSON.stringify(responseFixture()),
      fixture.selection.input,
    );
    expectAccountingDiagnostic(
      () =>
        validateAuthoringRevisionMutation({
          accounting,
          actualChangedPaths: [],
          candidate0PatchSha256: "1".repeat(64),
          candidate1PatchSha256: "2".repeat(64),
        }),
      "revision-accounting-changed-path-mismatch",
    );
    expectAccountingDiagnostic(
      () =>
        validateAuthoringRevisionMutation({
          accounting,
          actualChangedPaths: fixture.writePaths,
          candidate0PatchSha256: "1".repeat(64),
          candidate1PatchSha256: "1".repeat(64),
        }),
      "revision-accounting-unchanged-applied",
    );
  });

  it("rejects an applied disposition when the complete candidate patch is unchanged", () => {
    if (fixture.selection.kind !== "revise") throw new Error("fixture must select revision");
    const issueId = fixture.selection.input.actionableFacts[0]!.issueIds[0]!;
    const locator = fixture.selection.input.actionableFacts[0]!.sourceLocators[0]!;
    const accounting = decodeAuthoringRevisionAccounting(
      JSON.stringify({
        issueAccounting: [
          {
            issueId,
            disposition: "applied",
            reason: "The admitted source establishes the bounded correction.",
            sourceLocators: [locator],
          },
        ],
        changedPaths: [fixture.writePaths[0]],
        unresolvedFacts: [],
      }),
      fixture.selection.input,
    );
    expect(() =>
      validateAuthoringRevisionMutation({
        accounting,
        actualChangedPaths: fixture.writePaths,
        candidate0PatchSha256: "1".repeat(64),
        candidate1PatchSha256: "1".repeat(64),
      }),
    ).toThrow("host-owned contract");
  });
});

function responseFixture(rowOverrides: Record<string, unknown> = {}): Record<string, unknown> {
  if (fixture.selection.kind !== "revise") throw new Error("fixture must select revision");
  const fact = fixture.selection.input.actionableFacts[0]!;
  return {
    issueAccounting: [
      {
        issueId: fact.issueIds[0]!,
        disposition: "applied",
        reason: "The admitted source establishes the bounded correction.",
        sourceLocators: [fact.sourceLocators[0]!],
        ...rowOverrides,
      },
    ],
    changedPaths: [fixture.writePaths[0]!],
    unresolvedFacts: [],
  };
}

function multiIssueRevisionInput(): AuthoringRevisionInputV1 {
  if (fixture.selection.kind !== "revise") throw new Error("fixture must select revision");
  const baseFact = fixture.selection.input.actionableFacts[0]!;
  return {
    ...fixture.selection.input,
    actionableFacts: [
      {
        ...baseFact,
        id: "FACT_SHARED",
        issueIds: ["TECH-002", "TECH-001"],
        sourceLocators: ["src/shared.ts:4-6"],
      },
      {
        ...baseFact,
        id: "FACT_BETA",
        issueIds: ["TECH-002"],
        sourceLocators: ["src/service.ts:12-14", "src/shared.ts:4-6"],
      },
      {
        ...baseFact,
        id: "FACT_ALPHA",
        issueIds: ["TECH-001"],
        sourceLocators: ["src/contract.ts:7-9", "src/contract.ts:1-3"],
      },
    ],
  };
}

function revisionWriterInput(revision: AuthoringRevisionInputV1): HarnessStepInput {
  const step = workflow
    .authoringSchedule!.branches.find((branch) => branch.id === "revise")!
    .steps.find((candidate) => candidate.id === "revise-documentation")!;
  return {
    runId: fixture.runId,
    repositoryPath: fixture.root,
    workflow,
    step,
    evidenceIdentity: { repositoryRevision: fixture.revision },
    authoringRevisionInput: revision,
  };
}

function expectAccountingDiagnostic(
  action: () => unknown,
  code: RevisionAccountingRejectionCode,
): InferenceStepError {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(InferenceStepError);
    const inferenceError = error as InferenceStepError;
    expect(inferenceError.message).toBe(
      `Authoring revision accounting did not satisfy the host-owned contract: ${code}.`,
    );
    expect(inferenceError.category).toBe("malformed-response");
    // The code and location are structural, and the catalog decides whether a
    // bounded, host-reset retry may repair it.
    const entry = OUTPUT_RULES[code];
    expect(inferenceError.rejection).toEqual({ code, location: entry.locations[0] });
    expect(inferenceError.retryable).toBe(entry.retry === "model-correctable");
    return inferenceError;
  }
  throw new Error(`Expected ${code}.`);
}
