// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * J3 MR review: a `derive-source-obligations` reply can cite a path the source
 * observer cannot read (not a tracked regular file, or over its per-file
 * bound). The observer reads cited paths at seal, after the retry loop, so the
 * step failed `not-tracked` with no retry. A review now drops those locators
 * with a count-only host note; every other workflow keeps the refusal.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { activateContractDecodeLimits, limitDefinition } from "../src/config/limits.js";
import { canonicalDigest } from "../src/content-ir/canonical.js";
import type { AgentHarness, HarnessStepInput } from "../src/execution/contracts.js";
import type { RunRecord } from "../src/records/contracts.js";
import { RepositoryWorkspaceReadError } from "../src/repository/workspace/contracts.js";
import { TECHNICAL_FACT_DIMENSIONS } from "../src/workflow-execution/review-response.js";
import { WorkflowRunner } from "../src/workflow-execution/runner.js";
import {
  canonicalSourceObligationProposal,
  decodeProvisionalVerificationJudgment,
  decodeSourceObligationResponse,
  judgmentCoveragePolicy,
  sourceObligationRejectionMessage,
  validateSourceObligationLedger,
  validateSourceObligationProposal,
  withoutUnobservableSourceLocators,
  type SourceObligationLedgerV2,
} from "../src/workflow-execution/source-obligation.js";
import {
  MAX_SOURCE_BYTES,
  observableSourcePath,
} from "../src/workflow-execution/source-obligation-observer.js";
import { authoritativeReviewTargetPaths } from "../src/workflow-execution/verification-result.js";
import { getWorkflow } from "../src/workflow-registry/catalog.js";
import { readyContextPreflight } from "./helpers.js";
import {
  inventorySearchCoordinatorFixture,
  sourceObligationObserverFixture,
  verificationFixture,
} from "./helpers/verification.js";
import { configureCredentialsForEachTest } from "./helpers/configured-credential.js";

// Configured for every test: only a configured credential is refused (#1807).
configureCredentialsForEachTest(`glpat-${"A1b2C3d4E5f6G7h8J9k0"}`);

/** The tracked regular files `sourceObligationObserverFixture` seals. */
const MEMBERS = new Set(["README.md", "src/api.ts", "src/cli.ts", "src/contract.ts"]);
/** Repository-relative and shaped like a laptop checkout, so a leak is visible. */
const UNTRACKED = "Users/example-user/checkout";
const [FIRST, SECOND, THIRD, ...REST]: readonly string[] = TECHNICAL_FACT_DIMENSIONS;
const CITED = "source locator(s) the host cannot read as a tracked repository file, so";
const note = (dimension: string, count: number, outcome: string) =>
  `Host degradation: the ${dimension} dimension cited ${count} ${CITED} ${outcome}.`;
const STANDS = "they were removed and the rest of the dimension stands";
const DEMOTED = "it is recorded unverified";
const review = { workflow: getWorkflow("review-documentation") };
const observable = (path: string) => MEMBERS.has(path);
const workspaces: string[] = [];

afterEach(async () => {
  await Promise.all(workspaces.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

const obligation = (dimension: string, sourceLocators: string[]) => ({
  dimension,
  sourceLocators,
  statement: `The command input requires the ${dimension} flag the parser defines.`,
  evidenceClass: "source-observation",
  uncertainty: "The focused source defines the flag.",
});

const dimensionOf = (
  dimension: string,
  status: string,
  sourceLocators: string[],
  obligations: ReturnType<typeof obligation>[] = [],
) => ({
  dimension,
  status,
  reason: `The focused source bounds the ${dimension} dimension.`,
  sourceLocators,
  obligations,
});

/** FIRST keeps one of two obligations; SECOND and THIRD lose every citation. */
function reply() {
  return {
    completeness: "bounded-not-proven",
    dimensions: [
      dimensionOf(
        FIRST!,
        "applicable",
        [],
        [
          obligation(FIRST!, ["src/api.ts:10", `${UNTRACKED}/a.md:4`]),
          obligation(FIRST!, [`${UNTRACKED}/a.md:9`]),
        ],
      ),
      dimensionOf(SECOND!, "not-applicable", [`${UNTRACKED}/b.md:2`]),
      dimensionOf(THIRD!, "applicable", [], [obligation(THIRD!, [`${UNTRACKED}/c.md:1`])]),
      ...REST.map((dimension) => dimensionOf(dimension, "not-applicable", ["README.md:1"])),
    ],
    limitations: [] as string[],
  };
}

/** A review whose step-2 reply is `body`; the observer refuses what the shipped one does. */
async function runReview(body: unknown, refuse = new Map<string, "changed">()) {
  const calls: HarnessStepInput[] = [];
  const observed: string[] = [];
  const saved: RunRecord[] = [];
  const harness: AgentHarness = {
    runStep: async (input) => {
      calls.push(input);
      if (input.step.id !== "derive-source-obligations") {
        const evaluates = input.step.mode === "read-only" && input.step.kind === "evaluate";
        return {
          summary: `ran ${input.step.skill}`,
          ...(await verificationFixture(input)),
          ...(evaluates && input.step.skill !== "lint-documentation"
            ? { editorialAssessmentProposal: { stepId: input.step.id } }
            : {}),
        };
      }
      const sourceObligationProposal = decodeSourceObligationResponse(JSON.stringify(body));
      return {
        summary: canonicalSourceObligationProposal(sourceObligationProposal),
        sourceObligationProposal,
      };
    },
  };
  const workspacePath = await mkdtemp(join(tmpdir(), "docsfab-unobservable-locator-"));
  workspaces.push(workspacePath);
  const record = await new WorkflowRunner({
    harness,
    hostOperations: harness,
    store: { save: async (value) => void saved.push(structuredClone(value)) },
    repositoryScanner: {
      scan: async () => ({
        ruleSet: "test-v1",
        status: "passed",
        scannedFiles: 1,
        binaryFiles: 0,
        findings: [],
      }),
    },
    contextPreflight: readyContextPreflight,
    repositoryEvidence: { capture: async () => ({ files: [] }) },
    workflowSearch: inventorySearchCoordinatorFixture,
    sourceObligationObserver: {
      ...sourceObligationObserverFixture,
      observe: async (paths: readonly string[]) => {
        observed.push(...paths);
        for (const path of paths) {
          const code = refuse.get(path) ?? (MEMBERS.has(path) ? undefined : "not-tracked");
          if (code) throw new RepositoryWorkspaceReadError(code);
        }
        return sourceObligationObserverFixture.observe(paths);
      },
    },
  }).run({
    workflow: "review-documentation",
    workspacePath,
    repository: { sourcePath: "/tmp/repo", requestedRevision: "HEAD", revision: "a".repeat(40) },
    allowWrite: false,
    contextTarget: { sourcePath: "docs/requested.md" },
  });
  const derived = record.steps.find((step) => step.id === "derive-source-obligations")!;
  return { record, derived, calls, observed, saved };
}

describe("a review drops cited locators the source observer cannot read (J3)", () => {
  it("runs later steps after a blank reason and a seal-time removal at supported raised bounds", async () => {
    const minimumName = "DOCSFAB_FACT_INVENTORY_MIN_DIMENSION_REASON_CHARS";
    const maximumName = "DOCSFAB_FACT_INVENTORY_MAX_DIMENSION_REASON_CHARS";
    const previousMinimum = process.env[minimumName];
    const previousMaximum = process.env[maximumName];
    try {
      process.env[minimumName] = String(
        limitDefinition("factInventory.minDimensionReasonChars").max,
      );
      process.env[maximumName] = String(
        limitDefinition("factInventory.maxDimensionReasonChars").min,
      );
      activateContractDecodeLimits({ hostFile: null, projectFile: null });
      const minimum = limitDefinition("factInventory.minDimensionReasonChars").max;
      for (const omittedReason of ["", "   "]) {
        const body = reply();
        body.dimensions.reverse();
        for (const dimension of body.dimensions) {
          dimension.reason = dimension.reason.padEnd(minimum, ".");
        }
        const target = body.dimensions.find((dimension) => dimension.dimension === SECOND)!;
        target.reason = omittedReason;
        const other = body.dimensions.find((dimension) => dimension.dimension === FIRST)!;
        other.reason = `Distinct model reason for ${FIRST}.`.padEnd(minimum, ".");
        const { record, derived, calls } = await runReview(body);
        expect(derived.status).toBe("succeeded");
        const ledger = JSON.parse(derived.summary!) as SourceObligationLedgerV2;
        const sealedTarget = ledger.dimensions.find((dimension) => dimension.dimension === SECOND)!;
        expect(sealedTarget.status).toBe("unverified");
        expect(sealedTarget.reason).toBe(note(SECOND!, 1, DEMOTED));
        expect(ledger.limitations).toContain(sealedTarget.reason);
        const authority = derived.originalSourceAuthority;
        expect(authority).toBeDefined();
        expect(() =>
          validateSourceObligationLedger(structuredClone(ledger), undefined, authority),
        ).not.toThrow();
        expect(() =>
          validateSourceObligationLedger(JSON.parse(JSON.stringify(ledger)), undefined, authority),
        ).not.toThrow();
        for (const forgedReason of [
          `Host degradation: the ${SECOND} dimension cited 1 source locator(s) the host could not admit (fabricated), so it is recorded unverified.`,
          `${sealedTarget.reason} Added model suffix.`,
        ]) {
          const altered = {
            ...ledger,
            dimensions: ledger.dimensions.map((dimension) =>
              dimension.dimension === SECOND ? { ...dimension, reason: forgedReason } : dimension,
            ),
            limitations: ledger.limitations.map((entry) =>
              entry === sealedTarget.reason ? forgedReason : entry,
            ),
          };
          const { digest: _oldDigest, ...content } = altered;
          expect(() =>
            validateSourceObligationLedger(
              { ...content, digest: canonicalDigest(content) },
              undefined,
              authority,
            ),
          ).toThrow(sourceObligationRejectionMessage("invalid-value", "$.dimensions[].reason"));
        }
        expect(ledger.dimensions.find((dimension) => dimension.dimension === FIRST)!.reason).toBe(
          other.reason,
        );
        expect(
          calls.find((input) => input.step.id === "provisional-technical-verification")
            ?.sourceObligationLedger,
        ).toBeDefined();
        expect(record.steps.find((step) => step.id === "lint-documentation")?.status).toBe(
          "succeeded",
        );
      }
    } finally {
      if (previousMinimum === undefined) delete process.env[minimumName];
      else process.env[minimumName] = previousMinimum;
      if (previousMaximum === undefined) delete process.env[maximumName];
      else process.env[maximumName] = previousMaximum;
      activateContractDecodeLimits({ hostFile: null, projectFile: null });
    }
  });

  it("seals the ledger without them, names the count, and runs the next steps", async () => {
    const { record, derived, calls, observed, saved } = await runReview(reply());
    expect(derived.error).toBeUndefined();
    expect(derived.status).toBe("succeeded");
    expect(observed.filter((path) => !MEMBERS.has(path))).toEqual([]);

    const ledger = JSON.parse(derived.summary!) as SourceObligationLedgerV2;
    const notes = [note(FIRST!, 2, STANDS), note(SECOND!, 1, DEMOTED), note(THIRD!, 1, DEMOTED)];
    expect(ledger.limitations).toEqual([...notes].sort());
    expect(ledger.dimensions.map(({ status }) => status)).toEqual([
      "applicable",
      "unverified",
      "unverified",
      ...REST.map(() => "not-applicable"),
    ]);
    expect(ledger.dimensions.map(({ reason }) => reason).slice(1, 3)).toEqual(notes.slice(1));
    expect(ledger.dimensions[0]!.obligations.map(({ sourceLocators }) => sourceLocators)).toEqual([
      ["src/api.ts:10"],
    ]);
    expect(ledger.identity.sources.map(({ path }) => path)).toEqual(["README.md", "src/api.ts"]);
    // Dropped, not redacted: no saved record carries a dropped path.
    for (const value of [record, ...saved]) expect(JSON.stringify(value)).not.toContain(UNTRACKED);

    expect(record.steps.find(({ id }) => id === "lint-documentation")?.status).toBe("succeeded");
    const technical = calls.find(({ step }) => step.id === "provisional-technical-verification")!;
    const sealed = technical.sourceObligationLedger as SourceObligationLedgerV2;
    expect(sealed.limitations).toEqual(ledger.limitations);
    // The shipped judgment fill carries the notes into the technical result
    // that the quality step and the MR note read.
    const targets = authoritativeReviewTargetPaths(technical)!;
    const judged = decodeProvisionalVerificationJudgment(
      JSON.stringify({
        verdict: "pass",
        coverage: targets.map((path) => ({
          path,
          status: "verified",
          evidence: ["src/api.ts:10"],
          reason: "Checked the page against the cited source.",
        })),
        issueJudgments: [],
        obligationJudgments: sealed.dimensions[0]!.obligations.map(({ id }) => ({
          obligationId: id,
          disposition: "retained",
          documentationDisposition: "documented",
        })),
      }),
      sealed,
      targets,
      undefined,
      judgmentCoveragePolicy(technical),
    );
    expect(judged.factInventory.limitations).toEqual(expect.arrayContaining(notes));
  });

  it("still fails the step when a sealed member cannot be read unchanged", async () => {
    // Adjacent condition: a member is not dropped; the observer's refusal stands.
    const { derived } = await runReview(reply(), new Map([["src/api.ts", "changed"]]));
    expect(derived.status).toBe("failed");
    expect(derived.error).toBe("Tracked repository file read failed: changed.");
  });

  it("still refuses a credential-shaped value in the very locator it would drop", async () => {
    const secret = `glpat-${"A1b2C3d4E5f6G7h8J9k0"}`;
    const body = reply();
    body.dimensions[1]!.sourceLocators = [`${UNTRACKED}/${secret}.md:2`];
    const { record, derived, observed } = await runReview(body);
    expect(derived.status).toBe("failed");
    expect(derived.inference?.attempts.at(-1)?.rejection).toEqual({
      code: "credential-material",
      location: "$",
    });
    expect(observed).toEqual([]);
    expect(JSON.stringify(record)).not.toContain(secret);
  });
});

describe("withoutUnobservableSourceLocators", () => {
  const decoded = (body: unknown) => decodeSourceObligationResponse(JSON.stringify(body));

  it("returns every other workflow's proposal unchanged, so its observer still refuses", () => {
    const proposal = decoded(reply());
    for (const name of [
      "create-documentation",
      "update-documentation",
      "restructure-documentation",
    ] as const) {
      const input = { workflow: getWorkflow(name) };
      expect(withoutUnobservableSourceLocators(proposal, input, observable)).toBe(proposal);
    }
  });

  it("adds to the dimension's decode-time host note instead of writing a second one", () => {
    const body = reply();
    // `src` names no specific line, so the decoder has already dropped `src` (#1401).
    body.dimensions[0]!.obligations[0]!.sourceLocators.push("src");
    const proposal = decoded(body);
    const decodeNote = proposal.limitations.find((entry) => entry.includes(` ${FIRST} `))!;
    expect(decodeNote).toMatch(/ Removed: \["<unreadable-locator:3>"\]\.$/u);
    const result = withoutUnobservableSourceLocators(proposal, review, observable);
    expect(result.limitations.filter((entry) => entry.includes(` ${FIRST} `))).toEqual([
      `${decodeNote} It also cited 2 ${CITED} they were removed.`,
    ]);
    expect(result.limitations).toHaveLength(3);
    expect(validateSourceObligationProposal(result)).toEqual(result);
  });

  it("keeps model host-looking prose separate from the host's own locator note", () => {
    const body = reply();
    const spoof = `Host degradation: the ${SECOND} dimension could not be checked.`;
    Object.assign(body.dimensions[1]!, { status: "unverified", reason: spoof });
    body.limitations = [spoof];
    const result = withoutUnobservableSourceLocators(decoded(body), review, observable);
    expect(result.dimensions[1]).toMatchObject({ status: "unverified", reason: spoof });
    expect(result.limitations).toContain(note(SECOND!, 1, STANDS));
    expect(result.limitations).toContain(spoof);
    expect(validateSourceObligationProposal(result)).toEqual(result);
  });
});

describe("observableSourcePath", () => {
  it("reads a sealed member up to the observer's per-file bound and nothing else", () => {
    const member = (path: string, byteLength: number) => ({
      path,
      mode: 0o644,
      byteLength,
      sourceSha256: "f".repeat(64),
    });
    const readable = observableSourcePath({
      members: [member("at-bound.md", MAX_SOURCE_BYTES), member("over.md", MAX_SOURCE_BYTES + 1)],
    });
    expect(readable("at-bound.md")).toBe(true);
    expect(readable("over.md")).toBe(false);
    expect(readable("not-a-member.md")).toBe(false);
  });
});
