// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { mkdtemp, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { parse as parseYaml } from "yaml";
import { describe, expect, it } from "vitest";

import { DurableArtifactStore } from "../src/artifacts/store.js";
import { limit } from "../src/config/limits.js";
import { canonicalJson } from "../src/content-ir/canonical.js";
import { deriveWithRuntimeRules } from "../src/contracts/derivations/index.js";
import {
  OUTPUT_RECORD_CONTRACTS,
  type AnswerRecordContractDeclaration,
} from "../src/contracts/model-output.js";
import {
  admitAnswerRecordCall,
  answerRecordReceiptForWire,
  assembleAnswerRecords,
  createAnswerRecordLedger,
  planAnswerRecords,
  remainingAnswerRecordKeys,
  type AnswerRecordDerivation,
  type AnswerRecordDraft,
  type AnswerRecordLedger,
  type AnswerRecordPlan,
} from "../src/harness/answer-records.js";
import { createSourceObligationAnswerRecordSession } from "../src/harness/source-obligation-answer-records.js";
import { createSourceObligationAnswerRecordTool } from "../src/harness/source-obligation-answer-record-tool.js";
import { readCatalogSources, validateCatalog } from "../scripts/check-model-output.mjs";
import { internalOnly } from "./helpers/internal-path.js";
import { QualityValidatorHost } from "../src/evaluation-report/quality-validator-host.js";
import type { SelectedDocumentationQualityProfile } from "../src/evaluation-report/quality-profile-selection.js";
import { verifyQualityPackContext } from "../src/quality-pack/manifest.js";

const repositoryRoot = resolve(import.meta.dirname, "../../..");
const read = (path: string) => readFileSync(resolve(repositoryRoot, path), "utf8");

const STEP8 = OUTPUT_RECORD_CONTRACTS["quality-evaluation"] as AnswerRecordContractDeclaration;
const profile = JSON.parse(
  read("packages/quality/profiles/docsfab-documentation-quality/profile.json"),
) as {
  applicability: { documentation_set: { required_dimensions_by_layer: Record<string, string[]> } };
  constraints: { required: string[]; conditional: string[] };
};
const byLayer = profile.applicability.documentation_set.required_dimensions_by_layer;
const constraintKeys = [...profile.constraints.required, ...profile.constraints.conditional];
const member = (key: string) => key.replaceAll("-", "_");

/** The step 8 skeleton from the profile, as the quality owner's host input would resolve it. */
const STEP8_INPUT = {
  declaration: STEP8,
  skeletons: {
    dimensions: Object.entries(byLayer).flatMap(([layer, keys]) =>
      keys.map((key) => ({ key, slot: layer })),
    ),
    constraints: constraintKeys.map((key) => ({ key, slot: member(key) })),
    layers: Object.keys(byLayer).map((layer) => ({ key: layer, slot: layer })),
  },
  selectors: { required: profile.constraints.required.map(member) },
};

const call = (type: string, record: unknown, key?: string) =>
  JSON.stringify(key === undefined ? { type, record } : { type, key, record });

function admitAll(ledger: AnswerRecordLedger, calls: readonly string[]) {
  let current = ledger;
  const receipts = [];
  for (const raw of calls) {
    const result = admitAnswerRecordCall(current, raw);
    current = result.ledger;
    receipts.push(result.receipt);
  }
  return { ledger: current, receipts };
}

const finding = (description: string, extra: Record<string, unknown> = {}) => ({
  severity: "major",
  dimension_id: "factual-accuracy",
  description,
  evidence: [
    {
      evidence_class: "grounded-judgment",
      strength: "direct",
      locator: "docs/install.md:12",
      description: "The page runs the install command.",
    },
  ],
  acceptance_condition: "The install command uses flags the CLI accepts.",
  ...extra,
});

describe("answer-record plan (design §4.4)", () => {
  it("counts the step 8 keys and derives the record-call ceiling from its limits", () => {
    const plan = planAnswerRecords(STEP8_INPUT);
    const dimensions = Object.values(byLayer).flat().length;
    // Every planned dimension, every constraint, and the three singletons.
    expect(plan.requiredKeys).toBe(dimensions + constraintKeys.length + 3);
    expect(plan.requiredKeys).toBe(36);
    expect(plan.optionalKeys).toBe(Object.keys(byLayer).length);
    expect(plan.openSets).toBe(1);
    const open = limit("answerRecords.maxOpenRecordsPerSet").value;
    const refusals = limit("answerRecords.maxRefusalsPerKey").value;
    expect(plan.maxOpenRecordsPerSet).toBe(open);
    expect(plan.maxRefusalsPerKey).toBe(refusals);
    expect(plan.maxRecordBytes).toBe(limit("sealed.answerSubmission.maxRecordBytes").value);
    expect(plan.recordCallCeiling).toBe((36 + 3 + open) * (1 + refusals));
  });

  it("derives the ceiling from the skeleton and limits, never a fixed number (M10)", () => {
    const small = planAnswerRecords({
      ...STEP8_INPUT,
      skeletons: {
        ...STEP8_INPUT.skeletons,
        dimensions: STEP8_INPUT.skeletons.dimensions.slice(0, 2),
      },
      limitValue: (name) => (name === "answerRecords.maxOpenRecordsPerSet" ? 5 : limit(name).value),
    });
    const refusals = limit("answerRecords.maxRefusalsPerKey").value;
    expect(small.requiredKeys).toBe(2 + constraintKeys.length + 3);
    expect(small.recordCallCeiling).toBe((small.requiredKeys + 3 + 5) * (1 + refusals));
  });
});

describe("answer-record ledger (design §3.1, §3.3)", () => {
  const plan = planAnswerRecords(STEP8_INPUT);

  it("admits, replaces, keeps unchanged, issues open-set keys, and withdraws", () => {
    const first = finding("The first finding.");
    const { ledger, receipts } = admitAll(createAnswerRecordLedger(plan), [
      call("dimension", { assessment: "met" }, "factual-accuracy"),
      call("dimension", { assessment: "partially-met" }, "factual-accuracy"),
      call("dimension", { assessment: "partially-met" }, "factual-accuracy"),
      call("finding", first),
      call("finding", finding("The second finding.")),
      call("finding", null, "F-1"),
      call("finding", null, "F-1"),
      call("finding", first, "F-1"),
      // The record argument may arrive as one JSON string.
      call("quality-score", "null"),
    ]);
    expect(receipts.map((receipt) => [receipt.status, receipt.key])).toEqual([
      ["admitted", "factual-accuracy"],
      ["replaced", "factual-accuracy"],
      ["unchanged", "factual-accuracy"],
      ["admitted", "F-1"],
      ["admitted", "F-2"],
      ["withdrawn", "F-1"],
      ["unchanged", "F-1"],
      ["admitted", "F-1"],
      ["admitted", "singleton"],
    ]);
    expect([...ledger.rows.values()].map((row) => `${row.type}:${row.key}`)).toEqual([
      "dimension:factual-accuracy",
      "finding:F-2",
      "finding:F-1",
      "quality-score:singleton",
    ]);
  });

  it("refuses a duplicate open-set record, a full open set, and an unissued key, keeping admitted rows", () => {
    const tight = planAnswerRecords({
      ...STEP8_INPUT,
      limitValue: (name) => (name === "answerRecords.maxOpenRecordsPerSet" ? 2 : limit(name).value),
    });
    const { ledger, receipts } = admitAll(createAnswerRecordLedger(tight), [
      call("finding", finding("One.")),
      call("finding", finding("One.")),
      call("finding", finding("Two.")),
      call("finding", finding("Three.")),
      call("finding", finding("Three."), "F-3"),
      call("finding", finding("Two."), "F-1"),
    ]);
    expect(receipts.map((receipt) => [receipt.status, receipt.code ?? receipt.key])).toEqual([
      ["admitted", "F-1"],
      ["refused", "answer-record-duplicate"],
      ["admitted", "F-2"],
      ["refused", "answer-record-open-set-bound"],
      ["refused", "answer-record-key"],
      ["refused", "answer-record-duplicate"],
    ]);
    expect(ledger.rows.size).toBe(2);
  });

  it("bounds every row an open set adds, a withdrawn key sent again included", () => {
    const tight = planAnswerRecords({
      ...STEP8_INPUT,
      limitValue: (name) => (name === "answerRecords.maxOpenRecordsPerSet" ? 2 : limit(name).value),
    });
    const { ledger, receipts } = admitAll(createAnswerRecordLedger(tight), [
      call("finding", finding("One.")),
      call("finding", finding("Two.")),
      call("finding", null, "F-1"),
      call("finding", finding("Three.")),
      call("finding", finding("One again."), "F-1"),
      // Replacing an admitted row adds none, so a full set still accepts it.
      call("finding", finding("Three, revised."), "F-3"),
    ]);
    expect(receipts.map((receipt) => [receipt.status, receipt.key, receipt.code])).toEqual([
      ["admitted", "F-1", undefined],
      ["admitted", "F-2", undefined],
      ["withdrawn", "F-1", undefined],
      ["admitted", "F-3", undefined],
      ["refused", "F-1", "answer-record-open-set-bound"],
      ["replaced", "F-3", undefined],
    ]);
    expect([...ledger.rows.values()].map((row) => row.key)).toEqual(["F-2", "F-3"]);
  });

  it("does not let nullable open records allocate null rows outside the generated ceiling", () => {
    const sources = readCatalogSources();
    const source = sources.contracts.find(
      (candidate) => candidate.path === "config/model-output/contracts/quality-evaluation.yaml",
    );
    expect(source).toBeDefined();
    const open = source!.document.records.find(
      (record: { open?: boolean }) => record.open === true,
    );
    expect(open).toBeDefined();
    open!.nullable = true;

    // This is a generator-accepted contract shape; run the generated plan and
    // the shipped admission core rather than a hand-built declaration.
    const generated = validateCatalog(sources).catalog.contracts.find(
      (candidate: { id: string }) => candidate.id === "quality-evaluation",
    );
    expect(generated).toBeDefined();
    const declaration = {
      ...generated,
      ...generated!.records,
      records: generated!.records.records,
    } as unknown as AnswerRecordContractDeclaration;
    const tight = planAnswerRecords({
      ...STEP8_INPUT,
      declaration,
      limitValue: (name) => (name === "answerRecords.maxOpenRecordsPerSet" ? 2 : limit(name).value),
    });
    const refusals = tight.maxRefusalsPerKey;
    expect(tight.recordCallCeiling).toBe(
      (tight.requiredKeys + tight.optionalKeys + 2 * tight.openSets) * (1 + refusals),
    );

    const nullAttempts = admitAll(
      createAnswerRecordLedger(tight),
      Array.from({ length: 3 }, () => call(open!.type, null)),
    );
    expect(nullAttempts.receipts.map((receipt) => [receipt.status, receipt.code])).toEqual([
      ["refused", "answer-record-shape"],
      ["refused", "answer-record-shape"],
      ["refused", "answer-record-shape"],
    ]);
    expect(nullAttempts.ledger.rows.size).toBe(0);

    const first = finding("One.");
    const second = finding("Two.");
    const third = finding("Three.");
    const { ledger, receipts } = admitAll(createAnswerRecordLedger(tight), [
      call(open!.type, first),
      call(open!.type, second),
      call(open!.type, third),
      call(open!.type, null, "F-1"),
      call(open!.type, third),
      call(open!.type, first, "F-1"),
      call(open!.type, finding("Two revised."), "F-2"),
    ]);
    expect(receipts.map((receipt) => [receipt.status, receipt.key, receipt.code])).toEqual([
      ["admitted", "F-1", undefined],
      ["admitted", "F-2", undefined],
      ["refused", null, "answer-record-open-set-bound"],
      ["withdrawn", "F-1", undefined],
      ["admitted", "F-3", undefined],
      ["refused", "F-1", "answer-record-open-set-bound"],
      ["replaced", "F-2", undefined],
    ]);
    expect(ledger.rows.size).toBe(tight.maxOpenRecordsPerSet);

    const nullableSingleton = admitAnswerRecordCall(
      createAnswerRecordLedger(tight),
      call("quality-score", null),
    );
    expect(nullableSingleton.receipt).toMatchObject({ status: "admitted", key: "singleton" });
  });

  it("charges refusals per key and ends the step at the refusal after the limit", () => {
    const refusals = plan.maxRefusalsPerKey;
    const bad = call("dimension", ["not", "an", "object"], "factual-accuracy");
    const good = call("dimension", { assessment: "met" }, "audience-fit");
    const { receipts } = admitAll(createAnswerRecordLedger(plan), [
      ...Array.from({ length: refusals }, () => bad),
      // Another key's record is unaffected by the first key's refusals.
      good,
      bad,
      good,
    ]);
    expect(
      receipts.slice(0, refusals).every((receipt) => receipt.code === "answer-record-shape"),
    ).toBe(true);
    expect(receipts[refusals]!.status).toBe("admitted");
    expect(receipts[refusals + 1]).toMatchObject({
      status: "refused",
      code: "answer-record-exhausted",
      retry: "terminal",
      type: "dimension",
      key: "factual-accuracy",
    });
    // Once a key is exhausted the step stops: every later call is refused.
    expect(receipts[refusals + 2]).toMatchObject({ code: "answer-record-exhausted" });
  });

  it("returns content-free receipts: no record text, undeclared type, or unplanned key (M9)", () => {
    const secret = "zz-model-authored-sentence-qq";
    const { receipts } = admitAll(createAnswerRecordLedger(plan), [
      call("finding", finding(secret)),
      call("finding", finding(secret)),
      call(`type-${secret}`, { x: secret }),
      call("dimension", { assessment: secret }, `key-${secret}`),
      call("dimension", { assessment: secret }, "factual-accuracy"),
      `${call("evaluation-note", { limitations: [secret] })} ${secret}`,
    ]);
    expect(receipts.map((receipt) => receipt.status)).toEqual([
      "admitted",
      "refused",
      "refused",
      "refused",
      "admitted",
      "refused",
    ]);
    for (const receipt of receipts) expect(JSON.stringify(receipt)).not.toContain(secret);
    expect(receipts[2]).toMatchObject({
      code: "answer-record-key",
      location: "$.type",
      type: null,
    });
    expect(receipts[3]).toMatchObject({ code: "answer-record-key", location: "$.key", key: null });
    expect(receipts[1]!.feedback).toBeTypeOf("string");
  });

  it("returns key-specific guidance for planned keys and open-set receipts", () => {
    const { receipt } = admitAnswerRecordCall(
      createAnswerRecordLedger(plan),
      call("finding", finding("A finding with source references."), "FACT-1"),
    );

    expect(receipt).toMatchObject({
      status: "refused",
      code: "answer-record-key",
      location: "$.key",
    });
    expect(receipt.feedback).toContain(
      "Match key to the record-plan type: for a singleton, omit key or use null; for a fixed-key record, use a key listed by the plan.",
    );
    expect(receipt.feedback).toContain(
      "For a new open-set record, including a finding, set the top-level key to null or omit it.",
    );
    expect(receipt.feedback).toContain(
      "Keep FACT/TECH fact and issue references inside a finding's record payload.",
    );
    expect(receipt.feedback).toContain(
      "To replace or withdraw an existing open-set row, use only a key previously issued by a receipt.",
    );
  });

  it("projects only declared singleton receipt keys to the wire null form", () => {
    const singleton = {
      status: "admitted" as const,
      type: "quality-score",
      key: "singleton",
      remaining: [],
      complete: true,
    };
    expect(answerRecordReceiptForWire(singleton, STEP8)).toMatchObject({ key: null });

    const fixedKey = { ...singleton, type: "dimension", key: "singleton" };
    expect(answerRecordReceiptForWire(fixedKey, STEP8).key).toBe("singleton");

    const openKey = { ...singleton, type: "finding", key: "F-1" };
    expect(answerRecordReceiptForWire(openKey, STEP8).key).toBe("F-1");
  });

  it("projects a source-obligation singleton receipt on its model-facing tool", async () => {
    const session = createSourceObligationAnswerRecordSession({ validateRecord: () => {} });
    await session.capability.prepareBatch({
      batchId: "source-singleton-wire",
      toolCalls: [
        {
          toolCallId: "source-singleton-wire-call",
          rawArguments: JSON.stringify({
            type: "proposal-note",
            key: null,
            record: { limitations: [], closed: true },
          }),
        },
      ],
      authorizedToolCallIds: ["source-singleton-wire-call"],
    });
    expect(session.capability.receipt("source-singleton-wire-call").key).toBe("singleton");

    const tool = createSourceObligationAnswerRecordTool(session.capability, session.promptGuidance);
    const result = await tool.execute(
      "source-singleton-wire-call",
      {},
      undefined,
      undefined,
      undefined as never,
    );
    expect(JSON.parse((result.content[0] as { text: string }).text)).toMatchObject({
      status: "admitted",
      type: "proposal-note",
      key: null,
    });
  });

  it("lists the remaining keys until every planned key and the open set's closing flag arrive", () => {
    const empty = createAnswerRecordLedger(plan);
    const remaining = remainingAnswerRecordKeys(empty);
    expect(remaining).toHaveLength(36);
    expect(remaining).toContain("dimension:global-and-localization-readiness");
    expect(remaining).toContain("evaluation-note");
    expect(remaining.some((key) => key.startsWith("layer-note"))).toBe(false);
    const { receipts } = admitAll(empty, [call("evaluation-note", { limitations: [] })]);
    // The note arrived without findings_complete, so the findings set stays open.
    expect(receipts[0]!.remaining).toContain("evaluation-note");
  });
});

const CORPUS_FILE =
  "packages/runtime/docs/internal/evidence/answer-record-corpus-2026-10/corpus.json";
const corpusFile = internalOnly(
  CORPUS_FILE,
  "the step 8 assembly proof reads the committed record corpus, which is not exported",
);

/** Fixture a's records from the committed answer-record corpus, as calls. */
function corpusCalls(fixture: string): string[] {
  const corpus = JSON.parse(read(CORPUS_FILE)) as {
    records: { fixture: string; type: string; key?: string; record: unknown }[];
  };
  return corpus.records
    .filter((entry) => entry.fixture === fixture)
    .map((entry) => call(entry.type, entry.record, entry.key));
}

// Skips only in the exported tree, where the corpus is absent.
describe.skipIf(corpusFile.skip)("answer-record assembly through the step 8 declaration", () => {
  it("assembles a declaratively closed empty findings set as an empty array", async () => {
    const plan = planAnswerRecords(STEP8_INPUT);
    const { ledger, receipts } = admitAll(createAnswerRecordLedger(plan), corpusCalls("a"));
    expect(receipts.filter((receipt) => receipt.status !== "admitted")).toEqual([]);
    expect(receipts.at(-1)!.complete).toBe(true);
    const fixture = JSON.parse(
      read(
        "packages/quality/tests/fixtures/documentation-quality-evaluation/review-live-main-f05a81f1-a.json",
      ),
    ) as Record<string, any>;
    const source = fixture;
    const hostLimitation = source.limitations[0] as string;
    let draftSeen: AnswerRecordDraft | undefined;
    // Fixture a's links resolve against its sealed step 5 and step 6 results.
    let REFERENCE_IDS: Record<string, string[]> = {
      "technical-fact": Array.from({ length: 23 }, (_, index) => `FACT-${index + 1}`),
      "technical-issue": ["TECH-001", "TECH-002", "TECH-003", "TECH-004"],
      "review-issue": ["REV-001", "REV-002"],
    };
    const assemble = (records: AnswerRecordLedger) =>
      assembleAnswerRecords({
        ledger: records,
        hostMinted: {
          "run.step-attempt-id": "attempt-1",
          "contract.evaluation-version": "1",
          "host.clock-at-assembly": "2026-10-07T00:00:00Z",
          "selection-receipt.profileModel": source.model_version,
          "selection-receipt.profile": source.profile,
          "evaluate-step-evidence": source.evaluator,
          "selection-receipt.scopeType": "documentation-set",
          "quality-evaluation-target": (field: string) =>
            field.endsWith(".paths") ? ["docs/quickstart.md"] : "docs/quickstart.md",
          "selection-receipt.repositoryRevision": source.target.repository_revision,
          "workflow.finding-owner": "documentation-owner",
          "workflow.finding-status": "open",
        },
        references: { "audience-attempt": { human: [], agent: [] } },
        referenceIds: REFERENCE_IDS,
        renderReference: (namespace, ids) =>
          ids.map((id) => ({
            evidence_class: "grounded-judgment",
            strength: "derived",
            provider_id: "docsfab-host-fact-render",
            locator: `${namespace}:${id}`,
            description: `Linked ${id}.`,
          })),
        derive: (draft): AnswerRecordDerivation => {
          draftSeen = draft;
          const artifact = structuredClone(draft.artifact) as Record<string, any>;
          const evaluation = artifact.evaluation;
          for (const [layer, result] of Object.entries(evaluation.layers as Record<string, any>)) {
            for (const dimension of result.dimensions) dimension.applicability = "required";
            Object.assign(result, {
              decision: source.layers[layer].decision,
              confidence: source.layers[layer].confidence,
              hard_gate_failures: source.layers[layer].hard_gate_failures,
            });
          }
          for (const [key, constraint] of Object.entries(
            evaluation.constraints as Record<string, any>,
          )) {
            constraint.applicability ??= source.constraints[key].applicability;
          }
          Object.assign(evaluation, {
            hard_gate_failures: source.hard_gate_failures,
            overall_decision: source.overall_decision,
            confidence: source.confidence,
            conditions: source.conditions,
          });
          return {
            status: "derived",
            artifact,
            hostParts: {
              "quality:host-limitations": [hostLimitation],
              "quality:coherence-labels": [],
            },
          };
        },
      });
    const assembled = await assemble(ledger);
    expect(assembled.status).toBe("assembled");
    if (assembled.status !== "assembled") return;
    // The admission plan's whole-set skeleton treats these two conditional
    // source dimensions as required, so make the synthetic no-finding review
    // assess them instead of preserving the corpus's not-applicable examples.
    const noFindingCalls = corpusCalls("a")
      .filter((raw) => JSON.parse(raw).type !== "finding")
      .map((raw) => {
        const call = JSON.parse(raw) as {
          type: string;
          key?: string;
          record: Record<string, unknown>;
        };
        if (call.type === "dimension" && call.record.assessment === "not-applicable") {
          call.record = {
            ...call.record,
            assessment: "met",
            confidence: 0.75,
            rationale:
              "The reviewed CLI surface meets this dimension within the selected page scope.",
          };
          return JSON.stringify({ type: call.type, key: call.key, record: call.record });
        }
        return raw;
      });
    const emptyPlan: AnswerRecordPlan = {
      ...plan,
      types: new Map(
        [...plan.types].sort(
          ([left], [right]) => Number(right === "finding") - Number(left === "finding"),
        ),
      ),
    };
    const emptyFindingsLedger = admitAll(
      createAnswerRecordLedger(emptyPlan),
      noFindingCalls,
    ).ledger;
    const emptyFindings = await assemble(emptyFindingsLedger);
    expect(emptyFindings.status).toBe("assembled");
    if (emptyFindings.status === "assembled") {
      expect(emptyFindings.artifact.evaluation).toHaveProperty("findings", []);
      const completionRoot = await mkdtemp(join(tmpdir(), "answer-record-empty-findings-"));
      try {
        const qualityPack = await verifyQualityPackContext({
          qualityDirectory: resolve(repositoryRoot, "packages/runtime/quality"),
          qualityPackDirectory: resolve(repositoryRoot, "packages/runtime/quality-pack"),
          skillCrateDirectory: resolve(repositoryRoot, "packages/runtime/skill-crate"),
        });
        const validator = new QualityValidatorHost({
          store: new DurableArtifactStore(join(completionRoot, "artifacts")),
          selection: { pack: qualityPack } as unknown as SelectedDocumentationQualityProfile,
          temporaryRoot: join(completionRoot, "validator-tmp"),
        });
        const gateAttribution: Record<string, readonly string[]> = {};
        const layerShortfallDecisions: Record<string, string> = {};
        for (const row of emptyFindingsLedger.rows.values()) {
          if (row.type === "dimension" && Array.isArray(row.payload.hard_gate_failures)) {
            gateAttribution[row.key] = row.payload.hard_gate_failures as string[];
          }
          if (
            row.type === "layer-note" &&
            typeof row.payload.layer_shortfall_decision === "string"
          ) {
            layerShortfallDecisions[row.key] = row.payload.layer_shortfall_decision;
          }
        }
        const derived = await validator.derive({
          schemaVersion: 1,
          kind: "docsfab-quality-derivation-input",
          evaluation: emptyFindings.artifact.evaluation as Record<string, unknown>,
          qualityScore: emptyFindings.artifact.qualityScore as Record<string, unknown> | null,
          gateAttribution,
          layerShortfallDecisions,
          textPathGates: null,
        });
        expect(derived.status).toBe("derived");
        if (derived.status !== "derived") return;
        const completion = await validator.validateAnswerRecordCompletion({
          evaluation: derived.evaluation,
          qualityScore: derived.qualityScore,
        });
        expect(completion, JSON.stringify(completion)).toEqual({ status: "valid" });
      } finally {
        await rm(completionRoot, { recursive: true, force: true });
      }
    }
    const evaluation = assembled.artifact.evaluation as Record<string, any>;
    // Dimensions in profile order, keyed by the ledger; record-only fields gone.
    for (const [layer, keys] of Object.entries(byLayer)) {
      expect(evaluation.layers[layer].dimensions.map((d: any) => d.dimension_id)).toEqual(keys);
    }
    expect(JSON.stringify(evaluation)).not.toContain('hard_gate_failures":[],"measures');
    for (const dimension of evaluation.layers.trustworthy_information.dimensions) {
      expect(Object.hasOwn(dimension, "hard_gate_failures")).toBe(false);
    }
    // The draft the derive step saw had no derived member yet.
    const draftEvaluation = draftSeen!.artifact.evaluation as Record<string, any>;
    expect(draftEvaluation.overall_decision).toBeUndefined();
    expect(
      draftEvaluation.layers.trustworthy_information.dimensions[0].applicability,
    ).toBeUndefined();
    expect(draftEvaluation.constraints.global_and_localization_readiness.applicability).toBe(
      source.constraints.global_and_localization_readiness.applicability,
    );
    // Host-known members, findings in key order with host IDs and constants.
    expect(evaluation.evaluation_id).toBe("attempt-1");
    expect(evaluation.target.paths).toEqual(["docs/quickstart.md"]);
    expect(evaluation.constraints.accessibility_and_inclusion.dimension_id).toBe(
      "accessibility-and-inclusion",
    );
    expect(evaluation.findings.map((f: any) => [f.id, f.owner, f.status])).toEqual(
      source.findings.map((_: unknown, index: number) => [
        `F-${index + 1}`,
        "documentation-owner",
        "open",
      ]),
    );
    for (const entry of evaluation.findings)
      expect(Object.hasOwn(entry, "originating_ids")).toBe(false);
    // Composed members: model evidence then host fact items; layer notes; top-level notes.
    const linked = evaluation.findings.flatMap((f: any) =>
      f.evidence.filter((item: any) => item.provider_id === "docsfab-host-fact-render"),
    );
    expect(linked.length).toBeGreaterThan(0);
    // Each layer's limitations are its layer note's (host strings were split
    // out of the corpus notes); an unsent optional note defaults to empty.
    for (const layer of Object.keys(byLayer)) {
      const note = corpusCalls("a")
        .map((raw) => JSON.parse(raw))
        .find((entry) => entry.type === "layer-note" && entry.key === layer);
      expect(evaluation.layers[layer].limitations).toEqual(note?.record.limitations ?? []);
    }
    expect(evaluation.limitations[0]).toBe(hostLimitation);
    expect(evaluation.limitations.filter((entry: string) => entry === hostLimitation)).toHaveLength(
      1,
    );
    expect(evaluation.outcomes).toEqual({ human: [], agent: [] });
    expect(assembled.artifact.qualityScore).toBeNull();
    // Each linked fact and issue renders one host item after the model's evidence (O7).
    const sourceFindings = corpusCalls("a")
      .map((raw) => JSON.parse(raw))
      .filter((entry) => entry.type === "finding");
    evaluation.findings.forEach((entry: any, index: number) => {
      const links = sourceFindings[index].record.originating_ids as string[];
      const rendered = entry.evidence.filter(
        (item: any) => item.provider_id === "docsfab-host-fact-render",
      );
      expect(rendered.map((item: any) => item.description)).toEqual(
        [
          ...links.filter((id) => id.startsWith("FACT-")),
          ...links.filter((id) => id.startsWith("TECH-")),
          ...links.filter((id) => id.startsWith("REV-")),
        ].map((id) => `Linked ${id}.`),
      );
    });
    // A link that no namespace resolves never reaches assembly silently.
    REFERENCE_IDS = { ...REFERENCE_IDS, "technical-fact": ["FACT-1"] };
    await expect(assemble(ledger)).rejects.toThrow(/link reached assembly unresolved/u);
    REFERENCE_IDS = {
      ...REFERENCE_IDS,
      "technical-fact": Array.from({ length: 23 }, (_, index) => `FACT-${index + 1}`),
    };
    // A model note that copies a host limitation is dropped losslessly (N14).
    expect(assembled.droppedDuplicates).toBe(0);
    const note = JSON.parse(corpusCalls("a").find((raw) => raw.includes('"evaluation-note"'))!);
    const copied = admitAll(ledger, [
      call("evaluation-note", {
        ...note.record,
        limitations: [hostLimitation, ...note.record.limitations],
      }),
    ]);
    expect(copied.receipts[0]!.status).toBe("replaced");
    const deduplicated = await assemble(copied.ledger);
    if (deduplicated.status !== "assembled") throw new Error("not assembled");
    expect(deduplicated.droppedDuplicates).toBe(1);
    expect((deduplicated.artifact.evaluation as any).limitations).toEqual(evaluation.limitations);
    // Order-independent: fixed keys go in plan order and findings in key
    // order, so other arrival orders give the same artifact digest.
    const calls = corpusCalls("a");
    const findings = calls.filter((raw) => raw.startsWith('{"type":"finding"'));
    const others = calls.filter((raw) => !findings.includes(raw));
    const scrambled = admitAll(createAnswerRecordLedger(plan), [
      ...findings,
      ...others.reverse(),
    ]).ledger;
    const again = await assemble(scrambled);
    expect(again.status === "assembled" && again.artifactSha256).toBe(assembled.artifactSha256);
    // A finding replaced last keeps its key's position, not its arrival (M8).
    const closingNote = others.find(
      (raw) => (JSON.parse(raw) as { type: string }).type === "evaluation-note",
    )!;
    const openOthers = others.filter((raw) => raw !== closingNote);
    const scrambledOpen = admitAll(createAnswerRecordLedger(plan), [
      ...findings,
      ...openOthers.reverse(),
    ]).ledger;
    const replaced = admitAll(scrambledOpen, [
      call("finding", { ...JSON.parse(findings[0]!).record, severity: "minor" }, "F-1"),
    ]);
    expect(replaced.receipts[0]!.status).toBe("replaced");
    const completedReplacement = admitAll(replaced.ledger, [closingNote]).ledger;
    const reordered = await assemble(completedReplacement);
    if (reordered.status !== "assembled") throw new Error("not assembled");
    expect((reordered.artifact.evaluation as any).findings[0]).toMatchObject({
      id: "F-1",
      severity: "minor",
    });
    const afterClose = admitAll(completedReplacement, [
      call("finding", { ...JSON.parse(findings[0]!).record, severity: "critical" }, "F-1"),
    ]);
    expect(afterClose.receipts[0]).toMatchObject({
      status: "refused",
      code: "answer-record-closed",
    });
    // Withdrawn and sent again last, F-1 still goes first: findings follow
    // key order, never the order records last arrived in (M8).
    const readmitted = admitAll(replaced.ledger, [
      call("finding", null, "F-1"),
      call("finding", JSON.parse(findings[0]!).record, "F-1"),
    ]);
    expect(readmitted.receipts.map((receipt) => receipt.status)).toEqual(["withdrawn", "admitted"]);
    expect([...readmitted.ledger.rows.keys()].at(-1)).toContain("F-1");
    const completedReadmission = admitAll(readmitted.ledger, [closingNote]).ledger;
    const readmittedAssembly = await assemble(completedReadmission);
    if (readmittedAssembly.status !== "assembled") throw new Error("not assembled");
    expect(
      (readmittedAssembly.artifact.evaluation as any).findings.map((entry: any) => entry.id),
    ).toEqual(findings.map((_, index) => `F-${index + 1}`));
  });

  it("returns incomplete with the remaining keys, and open when the derive step leaves a layer to judge", async () => {
    const plan = planAnswerRecords(STEP8_INPUT);
    const partial = admitAll(createAnswerRecordLedger(plan), corpusCalls("a").slice(0, 5)).ledger;
    const input = {
      hostMinted: {},
      references: {},
      referenceIds: {},
      renderReference: () => [],
      derive: (): AnswerRecordDerivation => ({
        status: "open",
        open: ["transferable_understanding"],
      }),
    };
    expect(await assembleAnswerRecords({ ...input, ledger: partial })).toMatchObject({
      status: "incomplete",
    });
  });
});

describe("answer-record core on the fixture-only S2 declaration (F3)", () => {
  const document = parseYaml(
    read("packages/runtime/test/fixtures/answer-records/source-obligation.yaml"),
  );
  const sources = readCatalogSources();
  // The full stack now installs the production contract under this id. This
  // core-only test deliberately substitutes its smaller fixture declaration.
  sources.contracts = sources.contracts.filter(
    (source) => source.document.id !== "source-obligation",
  );
  sources.contracts.push({
    path: "config/model-output/contracts/source-obligation.yaml",
    document,
  });
  const s2 = validateCatalog(sources).catalog.contracts.find(
    (contract: { id: string }) => contract.id === "source-obligation",
  );
  const declaration = {
    ...s2,
    ...s2.records,
    records: s2.records.records,
  } as unknown as AnswerRecordContractDeclaration;
  const dimensions = [
    "commands",
    "configuration",
    "interfaces",
    "behavior",
    "compatibility",
    "limits",
  ];

  function s2Plan(): AnswerRecordPlan {
    return planAnswerRecords({
      declaration,
      skeletons: { dimensions: dimensions.map((key) => ({ key, slot: null })) },
    });
  }

  it("plans, admits, and assembles a source-obligation proposal with runtime rules and no step 8 code", async () => {
    const plan = s2Plan();
    expect(plan.requiredKeys).toBe(7);
    expect(plan.openSets).toBe(0);
    const obligation = (statement: string) => ({
      sourceLocators: ["src/cli.py:10"],
      statement,
      evidenceClass: "direct",
      uncertainty: "none",
    });
    const calls = [
      ...dimensions.map((key, index) =>
        call(
          "dimension",
          index === 0
            ? {
                status: "applicable",
                reason: "r",
                sourceLocators: ["src/cli.py"],
                obligations: [obligation("A"), obligation("B")],
              }
            : {
                status: "unverified",
                reason: `No source for ${key}.`,
                sourceLocators: [],
                obligations: [],
              },
          key,
        ),
      ),
      call("proposal-note", {
        limitations: ["The plan named one source.", "No source for limits."],
      }),
    ];
    const { ledger, receipts } = admitAll(createAnswerRecordLedger(plan), calls);
    expect(receipts.at(-1)).toMatchObject({ status: "admitted", complete: true });
    let serial = 0;
    const assembled = await assembleAnswerRecords({
      ledger,
      hostMinted: {},
      references: {},
      referenceIds: {},
      renderReference: () => [],
      derive: deriveWithRuntimeRules(declaration, {
        "completeness-constant": () => "complete",
        "obligation-ids": () => `OBL-${++serial}`,
        "obligation-dimension": ({ artifact, path }) =>
          ((artifact.proposal as any).dimensions[path[2] as number] as { dimension: string })
            .dimension,
        "unverified-dimension-reasons": ({ artifact }) =>
          ((artifact.proposal as any).dimensions as any[])
            .filter((entry) => entry.status === "unverified")
            .map((entry) => entry.reason),
      }),
    });
    expect(assembled.status).toBe("assembled");
    if (assembled.status !== "assembled") return;
    const proposal = assembled.artifact.proposal as any;
    expect(proposal.completeness).toBe("complete");
    expect(proposal.dimensions.map((entry: any) => entry.dimension)).toEqual(dimensions);
    expect(proposal.dimensions[0].obligations).toEqual([
      { ...obligation("A"), id: "OBL-1", dimension: "commands" },
      { ...obligation("B"), id: "OBL-2", dimension: "commands" },
    ]);
    // Host reasons first; the model's identical copy is dropped losslessly.
    expect(proposal.limitations).toEqual([
      ...dimensions.slice(1).map((key) => `No source for ${key}.`),
      "The plan named one source.",
    ]);
    expect(assembled.droppedDuplicates).toBe(1);
    expect(assembled.artifactSha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(canonicalJson(assembled.artifact)).not.toContain("proposal-note");
  });

  it("refuses a key outside the S2 skeleton and a record type the S2 declaration lacks", () => {
    const { receipts } = admitAll(createAnswerRecordLedger(s2Plan()), [
      call("dimension", { status: "applicable" }, "factual-accuracy"),
      call("finding", { severity: "major" }),
    ]);
    expect(receipts.map((receipt) => [receipt.code, receipt.location])).toEqual([
      ["answer-record-key", "$.key"],
      ["answer-record-key", "$.type"],
    ]);
  });

  it("imports no step 8 or quality module into the core or the runtime derivations", () => {
    for (const path of [
      "packages/runtime/src/harness/answer-records.ts",
      "packages/runtime/src/harness/answer-record-fill.ts",
      "packages/runtime/src/contracts/derivations/index.ts",
    ]) {
      const imports = [...read(path).matchAll(/from "([^"]+)"/gu)].map((match) => match[1]);
      expect(
        imports.filter((target) => /quality|evaluation|review|step8/u.test(target!)),
        path,
      ).toEqual([]);
    }
  });
});

describe("quality rule names (design §1.2 drift guard)", () => {
  it("names only rules quality_decision_policy.RULES implements, each once", () => {
    const module = read("packages/quality/checks/quality_decision_policy.py");
    const table = /^RULES: [^=\n]+= \{\n((?:\s+"[a-z-]+": \w+,\n)+)\}/mu.exec(module)![1]!;
    const implemented = [...table.matchAll(/"([a-z-]+)"/gu)].map((match) => `quality:${match[1]}`);
    const named = new Set([
      ...STEP8.derive.map((entry) => entry.rule),
      ...STEP8.compose.flatMap((entry) =>
        entry.parts.flatMap((part) =>
          "host" in part && !part.host.startsWith("reference:") ? [part.host] : [],
        ),
      ),
    ]);
    expect([...named].filter((rule) => !implemented.includes(rule))).toEqual([]);
    // family-paths-subset is the declaration's subset-of narrowing on
    // documentation_family_evidence.paths, checked per record, not a member rule.
    expect(implemented.filter((rule) => !named.has(rule))).toEqual(["quality:family-paths-subset"]);
    expect(STEP8.records[0]!.narrow["documentation_family_evidence.paths"]).toBe(
      "subset-of:quality-evaluation-target",
    );
  });
});
