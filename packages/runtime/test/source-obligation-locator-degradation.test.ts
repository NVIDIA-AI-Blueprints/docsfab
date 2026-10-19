// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * `derive-source-obligations` must not fail a review on a model-content
 * locator rejection such as `invalid-locator` at
 * `$.dimensions[].obligations[].sourceLocators[]`. The current rule is that
 * only credentials and write or publish authority refuse; model content
 * degrades and the run continues. These tests pin that: the replies below
 * seal, and the ledger says what was removed.
 */

import { readFileSync } from "node:fs";
import { rm } from "node:fs/promises";

import { afterEach, describe, expect, it, vi } from "vitest";

import { activateContractDecodeLimits, limit, limitDefinition } from "../src/config/limits.js";
import { diagnoseRun } from "../src/diagnosis/engine.js";
import { formatRunDiagnosisLines } from "../src/diagnosis/render.js";
import { canonicalizeJsonEvidence, type JsonEvidenceValue } from "../src/json-evidence.js";
import {
  decodeRunIndexRow,
  projectRunIndexRows,
  type RunIndexRowV1,
} from "../src/records/run-index.js";
import { queryRunIndex, type RunIndexQuery } from "../src/records/run-index-query.js";
import { canonicalDigest } from "../src/content-ir/canonical.js";
import { admittedReplySpan } from "../src/harness/reply-admission/judgment.js";
import {
  hostDegradationLimitation,
  isHostLocatorDegradationNote,
} from "../src/workflow-execution/source-obligation/locator-degradation.js";
import {
  bindSourceObligationLedgerV2,
  decodeSourceObligationResponse,
  projectSourceObligationRejection,
  sourceObligationLocatorPaths,
  sourceObligationRejectionMessage,
  sourceObligationScopeSha256,
  validateSourceObligationLedger,
  validateSourceObligationProposal,
} from "../src/workflow-execution/source-obligation.js";
import { TECHNICAL_FACT_DIMENSIONS } from "../src/workflow-execution/review-response.js";
import type { SourceObligationLedgerProposalV1 } from "../src/workflow-execution/source-obligation.js";
import {
  captureInferenceFailure,
  createAuditHarness,
  createRepository,
  reviewSourcePhaseInput,
  scriptedProvider,
  sealOriginalSourceAuthority,
  stepInput,
  temporaryDirectories,
  testTimeoutMs,
  textTurn,
} from "./support/pi-harness-session-fixtures.js";

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

/**
 * The bytes `derive-source-obligations` seals for the clean reply below,
 * captured from a decoder without the degradation so the control has an oracle
 * the implementation does not derive. The degradation must not move a byte.
 */
const CLEAN_REPLY_CANONICAL_SUMMARY = readFileSync(
  new URL("./fixtures/source-obligation/clean-reply-canonical-summary.txt", import.meta.url),
  "utf8",
  // A canonical summary never ends in whitespace, so only the fixture file's
  // own final newline is trimmed. The extension keeps the formatter from
  // reflowing the bytes the control is about.
).trimEnd();

const RUN_REVISION = "a".repeat(40);
const FOREIGN_REVISION = "b".repeat(40);
const HOST_STEM = "Host degradation:";
const READ_SOURCE = "README.md:1";
/** The final attempt: no retry follows, so a span-less locator is removed and labeled. */
const FINAL = { finalAttempt: true } as const;

/**
 * One applicable dimension carrying `obligationLocators`, the rest
 * not-applicable and citing a locator the host can read: a real ledger with
 * one unreadable citation in it.
 */
function proposalWith(
  obligationLocators: readonly string[],
  dimensionLocators: readonly string[] = [READ_SOURCE],
): SourceObligationLedgerProposalV1 {
  return {
    completeness: "bounded-not-proven",
    dimensions: TECHNICAL_FACT_DIMENSIONS.map((dimension, index) =>
      index === 0
        ? {
            dimension,
            status: "applicable" as const,
            reason: `The focused source establishes one ${dimension} obligation.`,
            sourceLocators: [],
            obligations: [
              {
                dimension,
                sourceLocators: [...obligationLocators],
                statement: "The command input requires a flag defined by the option parser.",
                evidenceClass: "source-observation" as const,
                uncertainty: "The focused source fixture defines the required flag.",
              },
            ],
          }
        : {
            dimension,
            status: "not-applicable" as const,
            reason: `The focused source establishes no ${dimension} obligation.`,
            sourceLocators: [...dimensionLocators],
            obligations: [],
          },
    ),
    limitations: [],
  } as SourceObligationLedgerProposalV1;
}

/** One distinct nonspecific locator of exactly `length` characters. */
function locatorOfLength(length: number, index: number): string {
  const suffix = `-${String(index).padStart(2, "0")}.ts`;
  return `src/${"a".repeat(length - "src/".length - suffix.length)}${suffix}`;
}

/** `count` distinct nonspecific locators, every one exactly `length` characters. */
function equalLengthLocators(count: number, length: number): string[] {
  return Array.from({ length: count }, (_value, index) => locatorOfLength(length, index));
}

/** Every dimension not-applicable, citing `locators`. */
function flatProposal(locators: readonly string[]): SourceObligationLedgerProposalV1 {
  return {
    completeness: "bounded-not-proven",
    dimensions: TECHNICAL_FACT_DIMENSIONS.map((dimension) => ({
      dimension,
      status: "not-applicable" as const,
      reason: `The focused source establishes no ${dimension} obligation.`,
      sourceLocators: [...locators],
      obligations: [],
    })),
    limitations: [],
  } as SourceObligationLedgerProposalV1;
}

describe("source-obligation locator degradation (#1401)", () => {
  it(
    "seals the step through the real Pi transport when a locator names this run's revision",
    async () => {
      const repositoryPath = await createRepository();
      const deriveInput = reviewSourcePhaseInput(repositoryPath, "derive-source-obligations");
      expect(deriveInput.evidenceIdentity?.repositoryRevision).toBe(RUN_REVISION);
      const reply = proposalWith([`${READ_SOURCE}@${RUN_REVISION}`]);
      vi.stubGlobal("fetch", scriptedProvider([textTurn(JSON.stringify(reply))]));

      // The shipped entry point: PiHarness.runStep on the workflow's own
      // `derive-source-obligations` step.
      const derived = await (await createAuditHarness()).runStep(deriveInput);

      expect(
        derived.sourceObligationProposal?.dimensions[0]?.obligations[0]?.sourceLocators,
      ).toEqual([READ_SOURCE]);
      // The suffix is identity, not evidence: the sealed proposal is the one a
      // reply without the suffix would have produced, byte for byte.
      expect(derived.sourceObligationProposal).toEqual(
        decodeSourceObligationResponse(JSON.stringify(proposalWith([READ_SOURCE]))),
      );
      expect(derived.summary).not.toContain("@");
      expect(derived.sourceObligationProposal?.limitations).toEqual([]);
    },
    testTimeoutMs(20_000),
  );

  // A reply can cite a readable, tracked file with no line span. The model
  // read it and can cite its lines, so it is re-asked; only the final attempt
  // removes it, and the note never says the host could not read it.
  it(
    "re-asks a span-less locator with a named rule while a retry remains",
    async () => {
      const repositoryPath = await createRepository();
      const deriveInput = reviewSourcePhaseInput(repositoryPath, "derive-source-obligations");
      vi.stubGlobal(
        "fetch",
        scriptedProvider([textTurn(JSON.stringify(proposalWith(["README.md"])))]),
      );

      const error = await captureInferenceFailure(await createAuditHarness(), {
        ...deriveInput,
        finalInferenceAttempt: false,
      });

      expect(error.rejection).toEqual({
        code: "source-locator-span-missing",
        location: "$.dimensions[].obligations[].sourceLocators[]",
      });
      expect(error.retryable).toBe(true);
      expect(error.category).toBe("malformed-response");
    },
    testTimeoutMs(20_000),
  );

  it(
    "on the final attempt removes a span-less locator and says why, never that it could not read it",
    async () => {
      const repositoryPath = await createRepository();
      const deriveInput = reviewSourcePhaseInput(repositoryPath, "derive-source-obligations");
      vi.stubGlobal(
        "fetch",
        scriptedProvider([textTurn(JSON.stringify(proposalWith(["README.md"])))]),
      );

      const derived = await (await createAuditHarness()).runStep({
        ...deriveInput,
        finalInferenceAttempt: true,
      });

      const degraded = derived.sourceObligationProposal!.dimensions[0]!;
      expect(degraded.status).toBe("unverified");
      expect(degraded.obligations).toEqual([]);
      expect(degraded.sourceLocators).toEqual([]);
      // The validator requires an unverified reason to be repeated verbatim in
      // limitations; the host's own note satisfies its own rule.
      expect(derived.sourceObligationProposal!.limitations).toContain(degraded.reason);
      expect(degraded.reason).toBe(
        `${HOST_STEM} the input-representations dimension cited 1 source locator(s) the host could not admit (1 named a path but no line span), so it is recorded unverified. Removed: ["README.md"].`,
      );
      expect(degraded.reason).not.toContain("could not read");
      // Nothing else degraded.
      expect(
        derived.sourceObligationProposal!.dimensions.slice(1).map(({ status }) => status),
      ).toEqual(TECHNICAL_FACT_DIMENSIONS.slice(1).map(() => "not-applicable"));
    },
    testTimeoutMs(20_000),
  );

  it(
    "positive control: a clean reply seals byte-identically and adds no limitation",
    async () => {
      const repositoryPath = await createRepository();
      const deriveInput = reviewSourcePhaseInput(repositoryPath, "derive-source-obligations");
      const clean = proposalWith([READ_SOURCE]);
      vi.stubGlobal("fetch", scriptedProvider([textTurn(JSON.stringify(clean))]));

      const derived = await (await createAuditHarness()).runStep(deriveInput);

      // The exact bytes this step seals without the degradation, written out
      // so the control has an oracle the implementation does not derive.
      expect(derived.summary).toBe(CLEAN_REPLY_CANONICAL_SUMMARY);
      expect(derived.sourceObligationProposal!.limitations).toEqual([]);
      expect(JSON.stringify(derived.sourceObligationProposal)).not.toContain(HOST_STEM);
    },
    testTimeoutMs(20_000),
  );

  it("never repairs a revision the run is not bound to, and never echoes the hex", () => {
    const proposal = decodeSourceObligationResponse(
      JSON.stringify(proposalWith([`${READ_SOURCE}@${FOREIGN_REVISION}`])),
      RUN_REVISION,
    );
    expect(proposal.dimensions[0]!.status).toBe("unverified");
    expect(proposal.dimensions[0]!.reason).toContain(`${READ_SOURCE}@<foreign-revision>`);
    expect(JSON.stringify(proposal)).not.toContain(FOREIGN_REVISION);
  });

  it("round-trips a comma-bearing section locator with a foreign revision through decode and sealed readback", () => {
    const definition = limitDefinition("factInventory.minDimensionReasonChars");
    const name = definition.override!;
    const previous = process.env[name];
    try {
      process.env[name] = String(definition.max);
      activateContractDecodeLimits({ hostFile: null, projectFile: null });
      const input = reviewSourcePhaseInput("/workspace", "derive-source-obligations");
      const locator = "README.md: Setup, verification";
      const proposal = flatProposal([`${locator}@${FOREIGN_REVISION}`]);
      for (const dimension of proposal.dimensions) {
        dimension.reason = dimension.reason.padEnd(definition.max, ".");
      }
      const decoded = decodeSourceObligationResponse(JSON.stringify(proposal), RUN_REVISION, {
        input,
      });
      const reason = decoded.dimensions[0]!.reason;
      expect(reason).toContain(`Removed: ${JSON.stringify([`${locator}@<foreign-revision>`])}.`);
      expect(isHostLocatorDegradationNote(decoded.dimensions[0]!.dimension, reason)).toBe(true);
      expect(JSON.stringify(decoded)).not.toContain(FOREIGN_REVISION);
      expect(() => validateSourceObligationProposal(decoded, input)).not.toThrow();

      const ledger = sealedLedger(decoded, input, []);
      expect(() =>
        validateSourceObligationLedger(ledger, input, authorityEvidenceFor(input)),
      ).not.toThrow();
    } finally {
      if (previous === undefined) delete process.env[name];
      else process.env[name] = previous;
      activateContractDecodeLimits({ hostFile: null, projectFile: null });
    }
  });

  it("keeps legacy notes readable and rejects forged or noncanonical removed lists", () => {
    const dimension = TECHNICAL_FACT_DIMENSIONS[0]!;
    const prefix = `${HOST_STEM} the ${dimension} dimension cited 1 source locator(s) the host could not admit (1 named a path but no line span), so it is recorded unverified. Removed: `;
    expect(isHostLocatorDegradationNote(dimension, `${prefix}README.md.`)).toBe(true);
    expect(isHostLocatorDegradationNote(dimension, `${prefix}["README.md"].`)).toBe(true);
    const two = prefix
      .replace("cited 1 source", "cited 2 source")
      .replace("(1 named a path", "(2 named a path");
    expect(isHostLocatorDegradationNote(dimension, `${two}["README.md","other.md"].`)).toBe(true);
    expect(isHostLocatorDegradationNote(dimension, `${two}["README.md", "other.md"].`)).toBe(false);
    for (const removed of ['["README.md", "other.md"]', '[""]', '["README.md",]']) {
      expect(isHostLocatorDegradationNote(dimension, `${prefix}${removed}.`)).toBe(false);
    }
    const overBudget = JSON.stringify([
      "x".repeat(limit("factInventory.maxDegradedLocatorChars").value),
    ]);
    expect(isHostLocatorDegradationNote(dimension, `${prefix}${overBudget}.`)).toBe(false);
  });

  it("re-asks a span-less locator that carries this run's revision, and removes it on the final attempt", () => {
    const reply = JSON.stringify(proposalWith([`README.md@${RUN_REVISION}`]));
    let refused: unknown;
    try {
      decodeSourceObligationResponse(reply, RUN_REVISION);
    } catch (error) {
      refused = error;
    }
    expect(projectSourceObligationRejection(refused)).toEqual({
      code: "source-locator-span-missing",
      location: "$.dimensions[].obligations[].sourceLocators[]",
    });
    const final = decodeSourceObligationResponse(reply, RUN_REVISION, FINAL);
    expect(final.dimensions[0]!.reason).toContain("(1 named a path but no line span)");
    expect(final.dimensions[0]!.reason).toContain('Removed: ["README.md"].');
  });

  it("names each removal reason in the limitation, never that the host could not read", () => {
    const proposal = decodeSourceObligationResponse(
      JSON.stringify(
        proposalWith([
          `${READ_SOURCE}@${FOREIGN_REVISION}`,
          "src/**/*.ts",
          "README.md",
          "README.md:2",
        ]),
      ),
      RUN_REVISION,
      FINAL,
    );
    const reason = proposal.dimensions[0]!.obligations.length
      ? proposal.limitations.find((entry) => entry.startsWith(HOST_STEM))!
      : proposal.dimensions[0]!.reason;
    expect(reason).toBe(
      `${HOST_STEM} the input-representations dimension cited 3 source locator(s) the host could not admit (1 named a path but no line span; 1 named a repository revision this run is not bound to; 1 were not repository locators), so they were removed and the rest of the dimension stands. Removed: ${JSON.stringify([`${READ_SOURCE}@<foreign-revision>`, "<unreadable-locator:11>", "README.md"])}.`,
    );
    expect(reason).not.toContain("could not read");
  });

  it("records a closed class word and a length for text that is no locator at all", () => {
    const glob = "src/**/*.ts";
    const proposal = decodeSourceObligationResponse(
      JSON.stringify(proposalWith([glob])),
      RUN_REVISION,
    );
    expect(proposal.dimensions[0]!.reason).toContain(`<unreadable-locator:${glob.length}>`);
    expect(proposal.dimensions[0]!.reason).not.toContain(glob);
  });

  it("keeps the refusal for the ADJACENT condition: a status whose locators the model omitted", () => {
    // The host removed nothing here. A dimension that simply never cited the
    // sources its own status requires is a missing answer, not an unreadable
    // one, and keeps its own reason.
    let thrown: unknown;
    try {
      decodeSourceObligationResponse(JSON.stringify(flatProposal([])), RUN_REVISION);
    } catch (error) {
      thrown = error;
    }
    expect((thrown as Error).message).toBe(
      sourceObligationRejectionMessage(
        "dimension-not-applicable-unsourced",
        "$.dimensions[].sourceLocators",
      ),
    );
    expect(projectSourceObligationRejection(thrown)).toEqual({
      code: "dimension-not-applicable-unsourced",
      location: "$.dimensions[].sourceLocators",
    });
  });

  it("keeps the refusal for the ADJACENT condition: an obligation that cites nothing", () => {
    let thrown: unknown;
    try {
      decodeSourceObligationResponse(JSON.stringify(proposalWith([])), RUN_REVISION);
    } catch (error) {
      thrown = error;
    }
    expect((thrown as Error).message).toBe(
      sourceObligationRejectionMessage(
        "empty-required-field",
        "$.dimensions[].obligations[].sourceLocators",
      ),
    );
  });

  it("does not degrade a SEALED ledger: a consumer step still refuses an unreadable locator", () => {
    const repositoryPath = "/workspace";
    const input = reviewSourcePhaseInput(repositoryPath, "derive-source-obligations");
    const ledger = sealedLedger(flatProposal([READ_SOURCE]), input, [
      { path: "README.md", sha256: "f".repeat(64) },
    ]);
    const tampered = structuredClone(ledger) as unknown as {
      dimensions: Array<{ sourceLocators: string[] }>;
    };
    tampered.dimensions[0]!.sourceLocators = ["README.md"];
    expect(() =>
      validateSourceObligationLedger(tampered, input, authorityEvidenceFor(input)),
    ).toThrow(
      sourceObligationRejectionMessage("invalid-locator", "$.dimensions[].sourceLocators[]"),
    );
  });

  it("seals an all-unverified inventory with no source, and refuses an empty set beside content", () => {
    const input = reviewSourcePhaseInput("/workspace", "derive-source-obligations");
    const allUnverified = decodeSourceObligationResponse(
      JSON.stringify(flatProposal(["docs"])),
      RUN_REVISION,
    );
    expect(allUnverified.dimensions.map(({ status }) => status)).toEqual(
      TECHNICAL_FACT_DIMENSIONS.map(() => "unverified"),
    );
    expect(sourceObligationLocatorPaths(allUnverified)).toEqual([]);

    const ledger = sealedLedger(allUnverified, input, []);
    expect(ledger.identity.sources).toEqual([]);
    // Steps 4 and 5 re-validate the sealed ledger through this same function.
    expect(() =>
      validateSourceObligationLedger(ledger, input, authorityEvidenceFor(input)),
    ).not.toThrow();

    // Adjacent: content that does cite a path still requires the host's own
    // observation of it.
    expect(() => sealedLedger(flatProposal([READ_SOURCE]), input, [])).toThrow(
      "requires a bounded source identity set",
    );
  });

  it("bounds the model's own limitations and the host's headroom separately", () => {
    const input = reviewSourcePhaseInput("/workspace", "derive-source-obligations");
    const modelBound = limit("factInventory.maxLimitations").value;
    const hostBound = limit("factInventory.maxHostLimitations").value;
    const filler = (count: number) =>
      Array.from({ length: count }, (_value, index) => `A recorded limitation number ${index}.`);

    // At the model bound: admitted.
    const atBound = flatProposal([READ_SOURCE]);
    atBound.limitations = filler(modelBound);
    expect(() => validateSourceObligationProposal(atBound, input)).not.toThrow();

    // Bound plus one: refused, by name.
    const overBound = flatProposal([READ_SOURCE]);
    overBound.limitations = filler(modelBound + 1);
    expect(() => validateSourceObligationProposal(overBound, input)).toThrow(
      sourceObligationRejectionMessage("bounds-exceeded", "$.limitations"),
    );

    // The host's notes sit above the model bound: a model that filled its own
    // bound does not make the host's degradation note fail the step it was
    // added to keep alive.
    const full = flatProposal(["docs"]);
    full.limitations = filler(modelBound);
    const degraded = validateSourceObligationProposal(full, input);
    expect(degraded.limitations).toHaveLength(modelBound + TECHNICAL_FACT_DIMENSIONS.length);
    expect(TECHNICAL_FACT_DIMENSIONS.length).toBe(hostBound);

    // The host half has a bound of its own: forging its stem does not buy room.
    const forged = flatProposal([READ_SOURCE]);
    forged.limitations = [
      ...filler(modelBound),
      ...Array.from({ length: hostBound + 1 }, (_value, index) => `${HOST_STEM} forged ${index}.`),
    ];
    expect(() => validateSourceObligationProposal(forged, input)).toThrow(
      sourceObligationRejectionMessage("bounds-exceeded", "$.limitations"),
    );
  });

  it("quotes removed locators within their character budget and counts the rest", () => {
    const input = reviewSourcePhaseInput("/workspace", "derive-source-obligations");
    const budget = limit("factInventory.maxDegradedLocatorChars").value;
    const long = `src/${"a".repeat(200)}`;
    const many = Array.from({ length: 16 }, (_value, index) => `${long}${index}`);
    // Span-less paths are removed, not refused, only on the final attempt.
    const proposal = validateSourceObligationProposal(flatProposal(many), input, undefined, FINAL);
    const reason = proposal.dimensions[0]!.reason;
    expect(reason).toContain("further removed locator(s) are not listed.");
    // The quoted list alone stays inside the budget, and the whole note inside
    // the dimension reason bound the ledger already enforces.
    const quoted = /Removed: (.*)\. \d+ further/u.exec(reason)?.[1] ?? "";
    expect(quoted.length).toBeLessThanOrEqual(budget);
    expect(reason.length).toBeLessThanOrEqual(limit("factInventory.maxDimensionReasonChars").value);
    expect(() => validateSourceObligationProposal(proposal, input)).not.toThrow();
  });

  it("reads a listed locator followed by the withheld clause from the host writer", () => {
    const dimension = TECHNICAL_FACT_DIMENSIONS[0]!;
    const budget = limit("factInventory.maxDegradedLocatorChars").value;
    const tokenLength = Math.floor(budget / 2);
    const listed = "x".repeat(tokenLength);
    const withheld = "y".repeat(tokenLength);
    const note = hostDegradationLimitation(
      dimension,
      [
        { token: listed, reason: "span-missing" },
        { token: withheld, reason: "foreign-revision" },
      ],
      false,
    );

    expect(note).toContain(
      `Removed: ${JSON.stringify([listed])}. 1 further removed locator(s) are not listed.`,
    );
    expect(isHostLocatorDegradationNote(dimension, note)).toBe(true);
    expect(
      isHostLocatorDegradationNote(
        dimension,
        note.replace("1 further removed", "2 further removed"),
      ),
    ).toBe(false);
    expect(
      isHostLocatorDegradationNote(dimension, note.replace("cited 2 source", "cited 3 source")),
    ).toBe(false);
  });

  it("admits a dimension reason at its bound and refuses the character past it", () => {
    const input = reviewSourcePhaseInput("/workspace", "derive-source-obligations");
    const bound = limit("factInventory.maxDimensionReasonChars").value;
    const reasonOf = (length: number) => `${"r".repeat(length - 1)}.`;

    const atBound = flatProposal([READ_SOURCE]);
    atBound.dimensions[0]!.reason = reasonOf(bound);
    expect(validateSourceObligationProposal(atBound, input).dimensions[0]!.reason).toHaveLength(
      bound,
    );

    const overBound = flatProposal([READ_SOURCE]);
    overBound.dimensions[0]!.reason = reasonOf(bound + 1);
    expect(() => validateSourceObligationProposal(overBound, input)).toThrow(
      sourceObligationRejectionMessage("invalid-value", "$.dimensions[].reason"),
    );
  });

  it("quotes a serialized list exactly at the budget, and stops at the character past it", () => {
    const input = reviewSourcePhaseInput("/workspace", "derive-source-obligations");
    const budget = limit("factInventory.maxDegradedLocatorChars").value;
    const serializedOverhead = JSON.stringify(["", ""]).length;
    // Two tokens whose serialized length is the budget itself, to the character:
    // the only input that separates `next.length > budget` (this list fits)
    // from `next.length >= budget` (it would not).
    const first = Math.floor((budget - serializedOverhead) / 2);
    const second = budget - serializedOverhead - first;
    expect(JSON.stringify([locatorOfLength(first, 0), locatorOfLength(second, 1)])).toHaveLength(
      budget,
    );

    const atBudget = validateSourceObligationProposal(
      flatProposal([locatorOfLength(first, 0), locatorOfLength(second, 1)]),
      input,
      undefined,
      FINAL,
    ).dimensions[0]!.reason;
    expect(atBudget).not.toContain("further removed locator(s)");
    expect(/Removed: (.*)\.$/u.exec(atBudget)?.[1] ?? "").toHaveLength(budget);

    // One character more than the budget: the second token is counted, not
    // quoted, and the quoted list is exactly the first token.
    const overBudget = validateSourceObligationProposal(
      flatProposal([locatorOfLength(first, 0), locatorOfLength(second + 1, 1)]),
      input,
      undefined,
      FINAL,
    ).dimensions[0]!.reason;
    expect(overBudget).toContain("1 further removed locator(s) are not listed.");
    expect(/Removed: (.*)\. \d+ further/u.exec(overBudget)?.[1] ?? "").toHaveLength(
      first + JSON.stringify([""]).length,
    );
    expect(overBudget.length).toBeLessThanOrEqual(
      limit("factInventory.maxDimensionReasonChars").value,
    );
  });

  it("records a removal that did NOT demote: an applicable dimension that lost one obligation", () => {
    const input = reviewSourcePhaseInput("/workspace", "derive-source-obligations");
    const proposal = proposalWith([READ_SOURCE]);
    const applicable = proposal.dimensions[0]!;
    const modelReason = applicable.reason;
    applicable.obligations = [
      ...applicable.obligations,
      {
        dimension: applicable.dimension,
        sourceLocators: ["docs"],
        statement: "The command input rejects an unknown flag named by the option parser.",
        evidenceClass: "source-observation" as const,
        uncertainty: "The focused source fixture defines the rejected flag.",
      },
    ] as (typeof applicable)["obligations"];

    const decoded = validateSourceObligationProposal(proposal, input);

    const kept = decoded.dimensions[0]!;
    // The dimension keeps the status and the reason the model gave it: only
    // the obligation whose sole citation the host could not read is gone.
    expect(kept.status).toBe("applicable");
    expect(kept.reason).toBe(modelReason);
    expect(kept.obligations).toHaveLength(1);
    expect(kept.obligations[0]!.sourceLocators).toEqual([READ_SOURCE]);
    // The kept content is byte-for-byte what a reply without the unreadable
    // citation would have produced.
    expect(decoded.dimensions).toEqual(
      validateSourceObligationProposal(proposalWith([READ_SOURCE]), input).dimensions,
    );
    // ...and the removal is recorded even though nothing demoted.
    const note = decoded.limitations.find((entry) => entry.startsWith(HOST_STEM));
    expect(note).toContain(`${TECHNICAL_FACT_DIMENSIONS[0]} dimension cited 1 source locator(s)`);
    // `docs` is no locator at all, so it is recorded as the closed class word
    // and its length rather than echoed, exactly as a demotion records it.
    expect(note).toContain('Removed: ["<unreadable-locator:4>"].');
    expect(note).toContain("the rest of the dimension stands");
    expect(note).not.toContain("recorded unverified");
    expect(() => validateSourceObligationProposal(decoded, input)).not.toThrow();
  });

  it("records a removal that did NOT demote: a not-applicable dimension that kept a locator", () => {
    const input = reviewSourcePhaseInput("/workspace", "derive-source-obligations");
    const decoded = validateSourceObligationProposal(flatProposal(["docs", READ_SOURCE]), input);

    const kept = decoded.dimensions[0]!;
    expect(kept.status).toBe("not-applicable");
    expect(kept.sourceLocators).toEqual([READ_SOURCE]);
    expect(kept.reason).toBe(`The focused source establishes no ${kept.dimension} obligation.`);
    // One note per dimension that lost a locator, and nothing else.
    const notes = decoded.limitations.filter((entry) => entry.startsWith(HOST_STEM));
    expect(notes).toHaveLength(TECHNICAL_FACT_DIMENSIONS.length);
    expect(notes).toHaveLength(limit("factInventory.maxHostLimitations").value);
    expect(notes.every((entry) => entry.includes('Removed: ["<unreadable-locator:4>"].'))).toBe(
      true,
    );
    expect(notes.every((entry) => entry.includes("the rest of the dimension stands"))).toBe(true);
  });

  it("records a removal on an unverified dimension, which has no status left to lose", () => {
    const input = reviewSourcePhaseInput("/workspace", "derive-source-obligations");
    const modelReason = "The reply could not establish this dimension from the focused source.";
    const proposal = flatProposal([READ_SOURCE]);
    proposal.limitations = [modelReason];
    proposal.dimensions[0] = {
      dimension: TECHNICAL_FACT_DIMENSIONS[0]!,
      status: "unverified",
      reason: modelReason,
      sourceLocators: ["docs"],
      obligations: [],
    } as (typeof proposal.dimensions)[number];

    const decoded = validateSourceObligationProposal(proposal, input);

    const kept = decoded.dimensions[0]!;
    expect(kept.status).toBe("unverified");
    expect(kept.reason).toBe(modelReason);
    expect(kept.sourceLocators).toEqual([]);
    const note = decoded.limitations.find((entry) => entry.startsWith(HOST_STEM));
    expect(note).toContain(`${TECHNICAL_FACT_DIMENSIONS[0]} dimension cited 1 source locator(s)`);
    expect(note).toContain('Removed: ["<unreadable-locator:4>"].');
    expect(note).toContain("the rest of the dimension stands");
    expect(decoded.limitations).toContain(modelReason);
    expect(() => validateSourceObligationProposal(decoded, input)).not.toThrow();
  });

  it("admits a dimension reason at its minimum and refuses the character below it", () => {
    const input = reviewSourcePhaseInput("/workspace", "derive-source-obligations");
    const minimum = limit("factInventory.minDimensionReasonChars").value;
    const reasonOf = (length: number) => `${"r".repeat(length - 1)}.`;

    const atBound = flatProposal([READ_SOURCE]);
    atBound.dimensions[0]!.reason = reasonOf(minimum);
    expect(validateSourceObligationProposal(atBound, input).dimensions[0]!.reason).toHaveLength(
      minimum,
    );

    const underBound = flatProposal([READ_SOURCE]);
    underBound.dimensions[0]!.reason = reasonOf(minimum - 1);
    expect(() => validateSourceObligationProposal(underBound, input)).toThrow(
      sourceObligationRejectionMessage("invalid-value", "$.dimensions[].reason"),
    );

    // The adjacent condition: an empty model reason gets a visibly host-written
    // basis, while a short non-empty answer still follows invalid-value.
    const empty = flatProposal([READ_SOURCE]);
    empty.dimensions[0]!.reason = "";
    const filled = validateSourceObligationProposal(empty, input);
    expect(filled.dimensions[0]!.reason).toContain("Host degradation:");
    expect(filled.dimensions[0]!.reason).toContain(empty.dimensions[0]!.dimension);
    expect(filled.dimensions[0]!.reason).toContain("not-applicable");
    expect(filled.dimensions[1]!.reason).toBe(empty.dimensions[1]!.reason);
  });

  it("fills an empty applicable reason and seals the reordered proposal for later steps", () => {
    const input = reviewSourcePhaseInput("/workspace", "derive-source-obligations");
    const proposal = proposalWith([READ_SOURCE]);
    proposal.dimensions.reverse();
    const applicable = proposal.dimensions.find((entry) => entry.status === "applicable")!;
    applicable.reason = "";
    const other = proposal.dimensions.find((entry) => entry.status === "not-applicable")!;
    other.reason = `Distinct model reason for ${other.dimension}.`;

    const decoded = decodeSourceObligationResponse(JSON.stringify(proposal), undefined, { input });
    const filled = decoded.dimensions.find((entry) => entry.dimension === applicable.dimension)!;
    expect(filled.reason).toContain("Host degradation:");
    expect(filled.reason).toContain(applicable.dimension);
    expect(filled.reason).toContain("applicable");
    expect(filled.reason).toContain("1 obligation");
    expect(decoded.dimensions.find((entry) => entry.dimension === other.dimension)!.reason).toBe(
      other.reason,
    );
    const ledger = sealedLedger(decoded, input, [{ path: "README.md", sha256: "f".repeat(64) }]);
    expect(() =>
      validateSourceObligationLedger(ledger, input, authorityEvidenceFor(input)),
    ).not.toThrow();
  });

  it("lists a host-filled unverified reason while preserving the one-note limit", () => {
    const proposal = flatProposal([READ_SOURCE]);
    const missing = proposal.dimensions[2]!;
    missing.status = "unverified";
    missing.reason = "";
    missing.sourceLocators = [];
    const decoded = decodeSourceObligationResponse(JSON.stringify(proposal));
    const filled = decoded.dimensions.find((entry) => entry.dimension === missing.dimension)!;
    expect(filled.reason).toContain("Host degradation:");
    expect(decoded.limitations).toContain(filled.reason);
    expect(decoded.limitations).toHaveLength(1);
    expect(() => validateSourceObligationProposal(decoded)).not.toThrow();
  });

  it.each([false, true])(
    "revalidates and seals a host-filled reason at the supported raised minimum (sourceProposals=%s)",
    (includeSourceProposals) => {
      const name = "DOCSFAB_FACT_INVENTORY_MIN_DIMENSION_REASON_CHARS";
      const previous = process.env[name];
      const maxName = "DOCSFAB_FACT_INVENTORY_MAX_DIMENSION_REASON_CHARS";
      const previousMax = process.env[maxName];
      try {
        process.env[name] = String(limitDefinition("factInventory.minDimensionReasonChars").max);
        process.env[maxName] = String(limitDefinition("factInventory.maxDimensionReasonChars").min);
        activateContractDecodeLimits({ hostFile: null, projectFile: null });
        const minimum = limit("factInventory.minDimensionReasonChars").value;
        expect(minimum).toBe(limitDefinition("factInventory.minDimensionReasonChars").max);
        expect(limit("factInventory.maxDimensionReasonChars").value).toBe(
          limitDefinition("factInventory.maxDimensionReasonChars").min,
        );
        const input = reviewSourcePhaseInput("/workspace", "derive-source-obligations");
        const proposal = proposalWith([READ_SOURCE]);
        proposal.dimensions.reverse();
        for (const entry of proposal.dimensions) entry.reason = entry.reason.padEnd(minimum, ".");
        const target = proposal.dimensions.find((entry) => entry.status === "applicable")!;
        target.reason = "";

        const response = includeSourceProposals
          ? {
              ...proposal,
              sourceProposals: [
                {
                  path: "src/extra.ts",
                  reason: "The proposal names an additional source file.".padEnd(minimum, "."),
                },
              ],
            }
          : proposal;
        const decoded = decodeSourceObligationResponse(JSON.stringify(response), undefined, {
          input,
        });
        expect(decoded.sourceProposals).toEqual(
          includeSourceProposals
            ? [
                {
                  path: "src/extra.ts",
                  reason: "The proposal names an additional source file.".padEnd(minimum, "."),
                },
              ]
            : undefined,
        );
        const filled = decoded.dimensions.find((entry) => entry.dimension === target.dimension)!;
        expect(filled.reason).toContain("Host degradation:");
        expect(() => validateSourceObligationProposal(decoded, input)).not.toThrow();
        expect(() => validateSourceObligationProposal(structuredClone(decoded), input)).toThrow(
          sourceObligationRejectionMessage("invalid-value", "$.dimensions[].reason"),
        );
        const ledger = sealedLedger(decoded, input, [
          { path: "README.md", sha256: "f".repeat(64) },
        ]);
        expect(() =>
          validateSourceObligationLedger(ledger, input, authorityEvidenceFor(input)),
        ).not.toThrow();
        const shortModel = structuredClone(decoded);
        shortModel.dimensions.find((entry) => entry.dimension === target.dimension)!.reason =
          "A short model reason.";
        expect(() => validateSourceObligationProposal(shortModel, input)).toThrow(
          sourceObligationRejectionMessage("invalid-value", "$.dimensions[].reason"),
        );
        const copiedHostReason = structuredClone(proposal);
        copiedHostReason.dimensions.find((entry) => entry.dimension === target.dimension)!.reason =
          filled.reason;
        expect(() =>
          decodeSourceObligationResponse(JSON.stringify(copiedHostReason), undefined, {
            input,
          }),
        ).toThrow(sourceObligationRejectionMessage("invalid-value", "$.dimensions[].reason"));

        const unverified = flatProposal([READ_SOURCE]);
        for (const entry of unverified.dimensions) entry.reason = entry.reason.padEnd(minimum, ".");
        const missingUnverified = unverified.dimensions[3]!;
        missingUnverified.status = "unverified";
        missingUnverified.reason = "";
        missingUnverified.sourceLocators = ["docs"];
        const degraded = decodeSourceObligationResponse(JSON.stringify(unverified), undefined, {
          input,
        });
        const degradedReason = degraded.dimensions.find(
          (entry) => entry.dimension === missingUnverified.dimension,
        )!.reason;
        expect(degradedReason).toContain("Host degradation:");
        expect(degraded.limitations).toContain(degradedReason);
        expect(() => validateSourceObligationProposal(degraded, input)).not.toThrow();
        expect(() => validateSourceObligationProposal(structuredClone(degraded), input)).toThrow(
          sourceObligationRejectionMessage("invalid-value", "$.dimensions[].reason"),
        );
        const degradedLedger = sealedLedger(degraded, input, [
          { path: "README.md", sha256: "f".repeat(64) },
        ]);
        expect(() =>
          validateSourceObligationLedger(degradedLedger, input, authorityEvidenceFor(input)),
        ).not.toThrow();
        const forged = structuredClone(degraded);
        const forgedReason = `Host degradation: the ${missingUnverified.dimension} dimension gave no basis.`;
        forged.dimensions.find((entry) => entry.dimension === missingUnverified.dimension)!.reason =
          forgedReason;
        forged.limitations = [forgedReason];
        expect(() => validateSourceObligationProposal(forged, input)).toThrow(
          sourceObligationRejectionMessage("invalid-value", "$.dimensions[].reason"),
        );
        for (const modelReason of [
          degradedReason,
          `Host degradation: the ${missingUnverified.dimension} dimension cited 1 source locator(s) the host could not admit (fabricated), so it is recorded unverified.`,
          `Host degradation: the ${missingUnverified.dimension} dimension cited 1 source locator(s) the host could not admit (1 made-up cause), so it is recorded unverified.`,
          `Host degradation: the ${missingUnverified.dimension} dimension cited 1 source locator(s) the host could not admit (1 named a path but no line span), so it is recorded unverified. Added model suffix.`,
          `Host degradation: the ${missingUnverified.dimension} dimension cited 1 source locator(s) the host cannot read as a tracked repository file, so it is recorded unverified.`,
        ]) {
          const spoofed = structuredClone(unverified);
          const row = spoofed.dimensions.find(
            (entry) => entry.dimension === missingUnverified.dimension,
          )!;
          row.sourceLocators = [];
          row.reason = modelReason;
          spoofed.limitations = [modelReason];
          expect(() =>
            decodeSourceObligationResponse(JSON.stringify(spoofed), undefined, { input }),
          ).toThrow(sourceObligationRejectionMessage("invalid-value", "$.dimensions[].reason"));
        }
      } finally {
        if (previous === undefined) delete process.env[name];
        else process.env[name] = previous;
        if (previousMax === undefined) delete process.env[maxName];
        else process.env[maxName] = previousMax;
        activateContractDecodeLimits({ hostFile: null, projectFile: null });
      }
    },
  );

  it("re-screens the sealed ledger's own source identity set where every consumer reads it", () => {
    const input = reviewSourcePhaseInput("/workspace", "derive-source-obligations");
    const ledger = sealedLedger(flatProposal([READ_SOURCE]), input, [
      { path: "README.md", sha256: "f".repeat(64) },
    ]);
    // Positive control: the clean sealed ledger clears this whole path.
    expect(() =>
      validateSourceObligationLedger(ledger, input, authorityEvidenceFor(input)),
    ).not.toThrow();

    // `validateSourceIdentities` admits an empty set everywhere; the coverage
    // screen still refuses one beside content that cites a path, and steps 4
    // and 5 reach it only here. The tampered ledger is re-digested over its own
    // emptied identity, so without the screen the digest, the path tokens and
    // `assertObservedSourcesAuthorized` all pass and a ledger citing
    // README.md:1 with no observed source would be admitted.
    const { digest: _sealedDigest, ...sealedContent } = structuredClone(ledger) as Record<
      string,
      unknown
    > & { digest: string; identity: { sources: unknown[] } };
    const tamperedContent = {
      ...sealedContent,
      identity: { ...(sealedContent.identity as object), sources: [] },
    };
    const tampered = { ...tamperedContent, digest: canonicalDigest(tamperedContent) };
    expect(() =>
      validateSourceObligationLedger(tampered, input, authorityEvidenceFor(input)),
    ).toThrow("Source-obligation evidence requires a bounded source identity set.");
  });

  it("refuses a forged host stem that pushes the host half past its bound at seal", () => {
    const input = reviewSourcePhaseInput("/workspace", "derive-source-obligations");
    // The model forges one entry with the host's stem; the host then authors
    // its own note for each of the six demoted dimensions. Neither half is
    // over its bound when the model's array is first read, so only the final
    // check, after the host's own notes joined it, can refuse this.
    const forged = flatProposal(["docs"]);
    forged.limitations = [`${HOST_STEM} a limitation the model wrote itself.`];
    expect(() => validateSourceObligationProposal(forged, input)).toThrow(
      sourceObligationRejectionMessage("bounds-exceeded", "$.limitations"),
    );

    // The adjacent condition: the same six host notes with no forged entry
    // beside them are exactly at the bound and seal.
    const clean = flatProposal(["docs"]);
    expect(
      validateSourceObligationProposal(clean, input).limitations.filter((entry) =>
        entry.startsWith(HOST_STEM),
      ),
    ).toHaveLength(limit("factInventory.maxHostLimitations").value);
  });

  it("removes a revision-suffixed locator when the run bound none, and never echoes the hex", () => {
    // The adjacent condition to the repair: the same reply, decoded with no
    // run revision to compare against. Nothing may be stripped on trust.
    const proposal = decodeSourceObligationResponse(
      JSON.stringify(proposalWith([`${READ_SOURCE}@${RUN_REVISION}`])),
      undefined,
    );
    expect(proposal.dimensions[0]!.status).toBe("unverified");
    expect(proposal.dimensions[0]!.reason).toContain(`${READ_SOURCE}@<foreign-revision>`);
    expect(JSON.stringify(proposal)).not.toContain(RUN_REVISION);
  });

  it("re-validates its own degraded proposal unchanged, as the runner does at seal", () => {
    const input = reviewSourcePhaseInput("/workspace", "derive-source-obligations");
    const once = validateSourceObligationProposal(flatProposal(["docs", READ_SOURCE]), input);
    const twice = validateSourceObligationProposal(once, input);
    expect(twice).toEqual(once);
  });
});

/**
 * A review whose sealed ledger the host degraded to no source evidence can
 * still succeed; the run row and `docsfab why` say how much source evidence
 * the ledger kept, so it never reads as a clean run.
 */
describe("source evidence on the run index and in docsfab why", () => {
  const input = reviewSourcePhaseInput("/workspace", "derive-source-obligations");

  function reviewRecord(ledger: unknown, authority: unknown = authorityEvidenceFor(input)) {
    return {
      schemaVersion: 2,
      id: "run-source-evidence",
      workflow: "review-documentation",
      status: "succeeded",
      createdAt: "2026-10-01T12:00:00.000Z",
      repository: { sourcePath: "/fixture/repository", revision: RUN_REVISION },
      qualityPack: { manifestSha256: "c".repeat(64) },
      steps: [
        {
          id: "derive-source-obligations",
          skill: "verify-technical-accuracy",
          status: "succeeded",
          summary:
            typeof ledger === "string"
              ? ledger
              : canonicalizeJsonEvidence(ledger as JsonEvidenceValue).trimEnd(),
          originalSourceAuthority: authority,
        },
      ],
    };
  }

  function runRowOf(record: unknown): RunIndexRowV1 {
    const projection = projectRunIndexRows(record, {
      origin: "import",
      snapshotId: "snapshot-source-evidence",
      indexedAt: "2026-10-01T12:00:00.000Z",
      recordSha256: "a".repeat(64),
      fieldMaxChars: 512,
    });
    if (!projection.ok) throw new Error(`fixture record refused: ${projection.reason}`);
    return projection.rows.find((row) => row.rowKind === "run")!;
  }

  function whyLines(row: RunIndexRowV1): string[] {
    const diagnosis = diagnoseRun([row], {
      location: { indexArgs: "", showArgs: "" },
      source: "record",
      population: null,
      lookbackRuns: 20,
    });
    return formatRunDiagnosisLines(diagnosis, { location: { indexArgs: "", showArgs: "" } });
  }

  it("reads a ledger the host degraded entirely as no source evidence, in the index and in why", () => {
    // Every dimension cited text that is no repository locator, so the host
    // removed each one and recorded the dimension unverified.
    const degraded = decodeSourceObligationResponse(
      JSON.stringify(flatProposal(["src/**/*.ts"])),
      RUN_REVISION,
    );
    const row = runRowOf(reviewRecord(sealedLedger(degraded, input, [])));
    expect(row).toMatchObject({ sourceEvidence: "none", unverifiedDimensions: 6 });
    // The stored row reads the same fields back, as runs query and why read them.
    const stored = decodeRunIndexRow(JSON.parse(JSON.stringify(row)));
    expect(stored).toMatchObject({ sourceEvidence: "none", unverifiedDimensions: 6 });
    // Adjacent: a value outside the closed set, or on a non-run row, reads as absent.
    expect(
      decodeRunIndexRow(JSON.parse(JSON.stringify({ ...row, sourceEvidence: "most" }))),
    ).toMatchObject({ sourceEvidence: null, unverifiedDimensions: null });
    expect(
      decodeRunIndexRow(JSON.parse(JSON.stringify({ ...row, rowKind: "step" }))),
    ).toMatchObject({ sourceEvidence: null, unverifiedDimensions: null });
    expect(row.omittedFields).not.toContain("sourceEvidence");

    const lines = whyLines(row);
    expect(lines[0]).toBe(
      "Run run-source-evidence succeeded; it recorded no failed attempt. Its source evidence is degraded: every technical dimension is unverified, so no step verified a claim against admitted source.",
    );
    expect(lines).toContain(
      "Source evidence: 6 technical dimension(s) of the source-obligation ledger are unverified, every one of them; docsfab runs show names each dimension's reason, including any locator the host removed.",
    );
    const result = queryRunIndex([{ ...row, snapshotRows: 1 } as RunIndexRowV1], {
      where: new Map([
        ["rowKind", ["run"]],
        ["sourceEvidence", ["none"]],
      ]) as RunIndexQuery["where"],
      groupBy: ["sourceEvidence", "unverifiedDimensions"],
    });
    expect(result.groups.map((group) => group.key)).toEqual([
      { sourceEvidence: "none", unverifiedDimensions: 6 },
    ]);
  });

  it("positive control: a ledger that cites its source reads as cited and adds no why line", () => {
    const clean = decodeSourceObligationResponse(
      JSON.stringify(proposalWith([READ_SOURCE])),
      RUN_REVISION,
    );
    const row = runRowOf(
      reviewRecord(sealedLedger(clean, input, [{ path: "README.md", sha256: "f".repeat(64) }])),
    );
    expect(row).toMatchObject({ sourceEvidence: "cited", unverifiedDimensions: 0 });
    const lines = whyLines(row);
    expect(lines[0]).toBe("Run run-source-evidence succeeded; it recorded no failed attempt.");
    expect(lines.some((line) => line.startsWith("Source evidence:"))).toBe(false);
  });

  it("reads a dimension the model left unverified as partial", () => {
    const reason = "The source does not establish this dimension.";
    const proposal = proposalWith([READ_SOURCE]);
    proposal.dimensions[1] = {
      ...proposal.dimensions[1]!,
      status: "unverified",
      reason,
      sourceLocators: [],
    };
    proposal.limitations = [reason];
    const row = runRowOf(
      reviewRecord(
        sealedLedger(
          decodeSourceObligationResponse(JSON.stringify(proposal), RUN_REVISION),
          input,
          [{ path: "README.md", sha256: "f".repeat(64) }],
        ),
      ),
    );
    expect(row).toMatchObject({ sourceEvidence: "partial", unverifiedDimensions: 1 });
    expect(whyLines(row)).toContain(
      "Source evidence: 1 technical dimension(s) of the source-obligation ledger are unverified; docsfab runs show names each dimension's reason, including any locator the host removed.",
    );
  });

  it("reads a ledger it cannot validate as unknown and names the refused field, never as clean", () => {
    const degraded = decodeSourceObligationResponse(
      JSON.stringify(flatProposal(["src/**/*.ts"])),
      RUN_REVISION,
    );
    const ledger = sealedLedger(degraded, input, []);
    // The ledger's own digest no longer matches its content.
    const tampered = { ...ledger, limitations: [] };
    const row = runRowOf(reviewRecord(tampered));
    expect(row).toMatchObject({ sourceEvidence: null, unverifiedDimensions: null });
    expect(row.omittedFields).toContain("sourceEvidence");
    // Adjacent: no source-obligation step at all is absence, not a refusal.
    const without = runRowOf({ ...reviewRecord(ledger), steps: [] });
    expect(without).toMatchObject({ sourceEvidence: null, unverifiedDimensions: null });
    expect(without.omittedFields).not.toContain("sourceEvidence");
  });
});

describe("rejected-reply fingerprint span (#1401)", () => {
  it(
    "fingerprints the document the decoder parsed, not the fence around it",
    async () => {
      const repositoryPath = await createRepository();
      const rejected = { ...proposalWith([READ_SOURCE]), confidence: "high" };
      const fenced = `Here is the ledger:\n\n\`\`\`json\n${JSON.stringify(rejected)}\n\`\`\`\n`;
      vi.stubGlobal("fetch", scriptedProvider([textTurn(fenced)]));

      const error = await captureInferenceFailure(
        await createAuditHarness(),
        reviewSourcePhaseInput(repositoryPath, "derive-source-obligations"),
      );

      // The record must not say `malformed-json` at offset 0 with no paths
      // beside a rejection raised against the extracted document: that record
      // would contradict itself.
      expect(projectSourceObligationRejection(error)).toEqual({
        code: "unexpected-key-set",
        location: "$",
      });
      expect(error.rejectedReplyShape?.parse).toMatchObject({ status: "parsed" });
      expect(error.rejectedReplyShape?.topLevelKeys).toContain("dimensions");
    },
    testTimeoutMs(20_000),
  );

  it(
    "positive control: an unfenced reply's fingerprint is unchanged",
    async () => {
      const repositoryPath = await createRepository();
      const rejected = { ...proposalWith([READ_SOURCE]), confidence: "high" };
      vi.stubGlobal("fetch", scriptedProvider([textTurn(JSON.stringify(rejected))]));

      const error = await captureInferenceFailure(
        await createAuditHarness(),
        reviewSourcePhaseInput(repositoryPath, "derive-source-obligations"),
      );

      expect(error.rejectedReplyShape?.parse).toMatchObject({ status: "parsed" });
      expect(error.rejectedReplyShape?.topLevelKeys).toContain("dimensions");
    },
    testTimeoutMs(20_000),
  );

  it(
    "positive control: braceless prose is still malformed-json",
    async () => {
      const repositoryPath = await createRepository();
      vi.stubGlobal("fetch", scriptedProvider([textTurn("The sources did not support one.")]));

      const error = await captureInferenceFailure(
        await createAuditHarness(),
        reviewSourcePhaseInput(repositoryPath, "derive-source-obligations"),
      );

      expect(projectSourceObligationRejection(error)).toEqual({
        code: "malformed-json",
        location: "$response",
      });
      expect(error.rejectedReplyShape?.parse).toMatchObject({
        status: "failed",
        code: "malformed-json",
      });
    },
    testTimeoutMs(20_000),
  );

  it("fingerprints the span the one shared extraction policy chose, except for the raw decoder", () => {
    const fenced = '```json\n{"a":1}\n```';
    // A judgment step unwraps.
    expect(
      admittedReplySpan(reviewSourcePhaseInput("/workspace", "derive-source-obligations"), fenced),
    ).toBe('{"a":1}');
    // So does the audit step, whose reply the placeholder scan reads
    // through the same shared policy.
    expect(admittedReplySpan(stepInput("/workspace"), fenced)).toBe('{"a":1}');
    // An ambiguous reply is handed back untouched, as its decoder read it.
    const twice = `${fenced}\n${fenced}`;
    expect(admittedReplySpan(stepInput("/workspace"), twice)).toBe(twice);
    // The authoring revision writer's decoder parses the raw reply, so the
    // fingerprint must describe the raw reply or it would claim "parsed"
    // beside a refusal for unparseable bytes.
    const writer = {
      workflow: { name: "create-documentation", schemaVersion: 3 },
      step: {
        id: "revise-documentation",
        skill: "write-documentation",
        kind: "inference",
        mode: "write",
      },
    } as unknown as Parameters<typeof admittedReplySpan>[0];
    expect(admittedReplySpan(writer, fenced)).toBe(fenced);
    expect(admittedReplySpan(stepInput("/workspace"), undefined)).toBeUndefined();
  });
});

/** The authority evidence a run captures for the workspace it reviews. */
function authorityEvidenceFor(
  input: ReturnType<typeof reviewSourcePhaseInput>,
  members: ReadonlyArray<{ path: string; sha256: string }> = [
    { path: "README.md", sha256: "f".repeat(64) },
  ],
) {
  return sealOriginalSourceAuthority({
    runId: input.runId!,
    scope: "review-tracked-workspace",
    repositoryRevision: input.evidenceIdentity!.repositoryRevision,
    scopeSha256: sourceObligationScopeSha256(input),
    workspaceSnapshotSha256: input.searchEvidence!.workspaceSnapshotSha256,
    members: members.map(({ path, sha256 }) => ({
      path,
      mode: 0o644,
      byteLength: 10,
      sourceSha256: sha256,
    })),
  }).evidence;
}

/**
 * Seal a proposal the way the runner does, with V2 authority evidence.
 *
 * `sources` is what the host observed -- empty for an all-unverified inventory.
 * The workspace authority the run captured is unrelated to it and always has
 * members, so it is sealed from `authorityMembers`.
 */
function sealedLedger(
  proposal: SourceObligationLedgerProposalV1,
  input: ReturnType<typeof reviewSourcePhaseInput>,
  sources: ReadonlyArray<{ path: string; sha256: string }>,
  authorityMembers: ReadonlyArray<{ path: string; sha256: string }> = [
    { path: "README.md", sha256: "f".repeat(64) },
  ],
) {
  return bindSourceObligationLedgerV2(
    proposal,
    input,
    sources,
    authorityEvidenceFor(input, authorityMembers),
  );
}
