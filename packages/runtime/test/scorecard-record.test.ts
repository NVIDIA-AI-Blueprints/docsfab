// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { getWorkflow } from "../src/workflow-registry/catalog.js";
import { canonicalDigest } from "../src/content-ir/canonical.js";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { AgentHarness } from "../src/execution/contracts.js";
import type {
  ModelEvidence,
  ModelProfileEvidence,
  RunRecord,
  ToolActivitySummary,
} from "../src/records/contracts.js";
import { createBoundedBeforeToolCall, summarizeToolFailureCategories } from "../src/harness/pi.js";
import { bindProducedTurnOutputTokens } from "../src/harness/turn-output-evidence.js";
import { PiExecutionLeaseController } from "../src/harness/pi-lease.js";
import { createExecutionLeaseCoordinatorPolicy } from "../src/execution/index.js";
import { canonicalizeJsonEvidence, type JsonEvidenceValue } from "../src/json-evidence.js";
import { fingerprintRejectedReply } from "../src/execution/rejected-reply-shape.js";
import { excerptRejectedReply } from "../src/execution/rejected-reply-excerpt.js";
import { modelProfileEvidenceSha256 } from "../src/model/profile-evidence.js";
import { governProviderTurn } from "../src/model/turn-governor.js";
import { grantedTurnOutputTokens } from "../src/model/context-budget.js";
import {
  decodeModelEvidence as decodeInferenceModelEvidence,
  decodeTools as decodeInferenceTools,
  decodeUsage as decodeInferenceUsage,
  ScorecardRecordError as InferenceEvidenceError,
} from "../src/execution/inference-evidence.js";
import {
  INFERENCE_RETRY_DISPOSITION_UNAVAILABLE,
  PROVIDER_TURN_REPLAY_VETOES,
  readInferenceRetryDisposition,
} from "../src/records/inference-retry-disposition.js";
import {
  decodeInference,
  decodeModelEvidence,
  decodeTools,
  decodeUsage,
  parseScorecardRunRecord,
  ScorecardRecordError,
} from "../src/scorecard-record.js";
import { WorkflowRunner } from "../src/workflow-execution/runner.js";
import { FileRunStore } from "../src/records/file-store.js";
import { authorizeSecurityScan } from "../src/security/scan-override.js";
import {
  RunRecordCompositionError,
  verifyRunRecordComposition,
} from "../src/records/composition-execution.js";
import { asCompositionRecord } from "./helpers/composition-record.js";
import { resolveSecurityScanEffectiveDisposition } from "../src/security/scan-disposition.js";
import {
  createWorkflowOutcome,
  workflowOutcomeStepEvidence,
} from "../src/workflow-contracts/outcome.js";

const REVISION = "a".repeat(40);
const PACKET = "b".repeat(64);
const SECURITY_SCAN_POLICY = {
  authorizeSecurityScan,
  resolveSecurityScanEffectiveDisposition,
} as const;

describe("scorecard readiness record decoder", () => {
  it("preserves the scorecard decoder exports from the inference evidence leaf", () => {
    expect(decodeModelEvidence).toBe(decodeInferenceModelEvidence);
    expect(decodeUsage).toBe(decodeInferenceUsage);
    expect(decodeTools).toBe(decodeInferenceTools);
    expect(ScorecardRecordError).toBe(InferenceEvidenceError);
  });

  it("rejects proxied tool arrays before executing proxy traps", () => {
    const observedTraps: string[] = [];
    const byTool = new Proxy([], {
      get(target, property, receiver) {
        observedTraps.push(`get:${String(property)}`);
        return Reflect.get(target, property, receiver);
      },
      getOwnPropertyDescriptor(target, property) {
        observedTraps.push(`getOwnPropertyDescriptor:${String(property)}`);
        return Reflect.getOwnPropertyDescriptor(target, property);
      },
      getPrototypeOf(target) {
        observedTraps.push("getPrototypeOf");
        return Reflect.getPrototypeOf(target);
      },
      ownKeys(target) {
        observedTraps.push("ownKeys");
        return Reflect.ownKeys(target);
      },
    });

    let failure: unknown;
    try {
      decodeTools({ totalCalls: 0, failedCalls: 0, byTool });
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(ScorecardRecordError);
    expect(failure).toBeInstanceOf(InferenceEvidenceError);
    expect(observedTraps).toEqual([]);
  });

  it("accepts the optional source-citation field, and still refuses an unknown key", () => {
    // Both closed key lists in this module are decoded end to end here, where
    // the readiness fixture lives. The other four lists are covered in
    // `record-source-citations-readers.test.ts`.
    const withField = succeededRecord() as RunRecord & { sourceCitations?: unknown };
    withField.sourceCitations = {
      schemaVersion: 1,
      kind: "docsfab-source-run-citations",
      bindingSha256: "c".repeat(64),
      steps: [],
    };
    const decoded = parseScorecardRunRecord(withField);
    // Accepted by the key list. This decoder rebuilds a typed record from known
    // fields, so it drops the value; that is harmless because `readiness` has one
    // read-only step and cannot carry citations.
    expect(decoded.id).toBe(withField.id);
    expect((decoded as { sourceCitations?: unknown }).sourceCitations).toBeUndefined();

    // Control: acceptance is this field, not a loosened gate.
    const withUnknown = succeededRecord() as RunRecord & { sourceCitationsDraft?: unknown };
    withUnknown.sourceCitationsDraft = {};
    expect(() => parseScorecardRunRecord(withUnknown)).toThrowError(ScorecardRecordError);
  });

  describe("composition-mode readiness records", () => {
    /** The record this run writes in composition mode, with the catalog's current skill. */
    const composedReadiness = async (
      status: "succeeded" | "failed" = "succeeded",
      changes?: RunRecord["changes"],
    ) => {
      const record = status === "succeeded" ? succeededRecord() : localSecurityFailure();
      if (changes) record.changes = changes;
      const definitionSkill = getWorkflow("readiness").steps[0]!.skill;
      record.steps[0]!.skill = definitionSkill as RunRecord["steps"][number]["skill"];
      if (record.steps[0]!.skillEvidence) record.steps[0]!.skillEvidence.id = definitionSkill;
      record.skills = record.skills.map((skill) => ({ ...skill, id: definitionSkill }));
      return asCompositionRecord(record);
    };
    const composition = (record: RunRecord) =>
      ({
        compositionExecution: record.compositionExecution,
        compositionExecutionAggregate: record.compositionExecutionAggregate,
      }) as Record<string, unknown>;

    it("decodes the sealed composition fields of a succeeded run and carries them through", async () => {
      const record = await composedReadiness();
      expect(record.compositionExecutionAggregate).toBeDefined();
      expect(parseScorecardRunRecord(record)).toEqual(record);
      // The runner records every run's changed files; a read-only run's list is empty.
      const withChanges = await composedReadiness("succeeded", { files: [] });
      expect(parseScorecardRunRecord(withChanges)).toEqual(withChanges);
      const mutated = await composedReadiness("succeeded", {
        files: [{ path: "docs/index.md", status: "modified" }],
      });
      expect(() => parseScorecardRunRecord(mutated)).toThrowError(
        new ScorecardRecordError("invalid-scorecard-run-record"),
      );
    });

    it("decodes a failed composition run, which carries no aggregate", async () => {
      const record = await composedReadiness("failed");
      expect(record.compositionExecution).toBeDefined();
      expect(record.compositionExecutionAggregate).toBeUndefined();
      expect(parseScorecardRunRecord(record)).toEqual(record);
    });

    it("refuses an edit after sealing that the omitted-mode reader accepts", async () => {
      const edit = (record: RunRecord) => {
        record.steps[0]!.summary = `${record.steps[0]!.summary} (edited after sealing)`;
      };
      const control = succeededRecord();
      edit(control);
      expect(parseScorecardRunRecord(control)).toEqual(control);
      const record = await composedReadiness();
      edit(record);
      expect(() => parseScorecardRunRecord(record)).toThrowError(
        "Scorecard run record rejected: composition-aggregate-mismatch.",
      );
      expect(() => verifyRunRecordComposition(record, getWorkflow("readiness"))).toThrowError(
        new RunRecordCompositionError("composition-aggregate-mismatch"),
      );
    });

    it("names each binding the verifier refuses", async () => {
      const workflow = getWorkflow("readiness");
      const refusal = (record: RunRecord) => {
        try {
          verifyRunRecordComposition(record, workflow);
        } catch (error) {
          return error instanceof RunRecordCompositionError ? error.code : String(error);
        }
        return "accepted";
      };
      const record = await composedReadiness();
      expect(refusal(record)).toBe("accepted");
      expect(refusal(succeededRecord())).toBe("accepted");

      const orphan = structuredClone(record);
      delete orphan.compositionExecution;
      expect(refusal(orphan)).toBe("composition-aggregate-without-execution");

      const unsealed = structuredClone(record);
      unsealed.compositionExecutionAggregate = undefined;
      delete unsealed.compositionExecutionAggregate;
      expect(refusal(unsealed)).toBe("composition-aggregate-missing");

      // Evidence sealed for this run but another source checkout.
      const otherSource = structuredClone(record);
      otherSource.repository = { ...otherSource.repository, sourcePath: "/private/other-source" };
      expect(refusal(otherSource)).toBe("composition-execution-subject-mismatch");

      const otherRun = await asCompositionRecord({ ...record, id: "run-other" });
      const crossedExecution = { ...record, ...composition(otherRun) } as RunRecord;
      expect(refusal(crossedExecution)).toBe("composition-execution-subject-mismatch");
      const crossedAggregate = structuredClone(record);
      crossedAggregate.compositionExecutionAggregate = structuredClone(
        otherRun.compositionExecutionAggregate,
      );
      expect(refusal(crossedAggregate)).toBe("composition-aggregate-subject-mismatch");

      // An aggregate resealed under another run id, though bound to this evidence.
      const renamed = structuredClone(record) as unknown as Record<string, Record<string, unknown>>;
      renamed.compositionExecutionAggregate!.runId = "run-other";
      reseal(renamed.compositionExecutionAggregate!, "aggregateSha256");
      expect(refusal(renamed as unknown as RunRecord)).toBe(
        "composition-aggregate-subject-mismatch",
      );

      const broken = structuredClone(record) as unknown as Record<string, Record<string, unknown>>;
      broken.compositionExecutionAggregate!.runId = "run-other";
      expect(refusal(broken as unknown as RunRecord)).toBe("composition-aggregate-invalid");

      // A failed run that kept its sealed aggregate (a final save that threw) is
      // still bound to its run; another run's aggregate is not.
      const settled = structuredClone(record);
      settled.status = "failed";
      expect(refusal(settled)).toBe("accepted");
      const settledCrossed = structuredClone(crossedAggregate);
      settledCrossed.status = "failed";
      expect(refusal(settledCrossed)).toBe("composition-aggregate-subject-mismatch");

      // A record sealed against another workflow source refuses by name.
      const drifted = structuredClone(record) as unknown as Record<string, Record<string, any>>;
      const execution = drifted.compositionExecution!;
      execution.workflow = { ...execution.workflow, sourceSha256: "0".repeat(64) };
      execution.digests = { ...execution.digests, workflowSha256: "0".repeat(64) };
      reseal(execution, "evidenceSha256");
      const aggregate = drifted.compositionExecutionAggregate!;
      aggregate.workflow = { ...execution.workflow };
      aggregate.compositionEvidenceSha256 = execution.evidenceSha256;
      reseal(aggregate, "aggregateSha256");
      expect(refusal(drifted as unknown as RunRecord)).toBe("composition-workflow-source-changed");
    });
  });

  it("preserves both historical and current readiness skill identities while refusing unknown identities", () => {
    for (const skill of ["doc-context-analyzer", "assess-documentation-readiness"] as const) {
      const record = succeededRecord();
      record.steps[0]!.skill = skill;
      expect(parseScorecardRunRecord(record).steps[0]!.skill).toBe(skill);
    }
    const forged = succeededRecord();
    forged.steps[0]!.skill = "unregistered-readiness";
    expect(() => parseScorecardRunRecord(forged)).toThrow(ScorecardRecordError);
  });

  it("deeply decodes a succeeded readiness record", () => {
    const record = succeededRecord();
    const decoded = parseScorecardRunRecord(record);

    expect(decoded).toEqual(record);
    expect(decoded.steps[0]!.inference!.attempts[0]!.identity!.repositoryRevision).toBe(REVISION);
  });

  it("round-trips optional physical provider response measurements and rejects malformed evidence", () => {
    const record = succeededRecord();
    const attempt = record.steps[0]!.inference!.attempts[0]!;
    attempt.providerResponses = {
      schemaVersion: 1,
      state: "complete",
      observations: [
        {
          requestSequence: 1,
          disposition: "complete",
          observedBytes: 37,
          httpStatus: 200,
        },
      ],
      pendingRequestSequences: [],
    };
    expect(
      parseScorecardRunRecord(record).steps[0]!.inference!.attempts[0]!.providerResponses,
    ).toEqual(attempt.providerResponses);

    const pending = structuredClone(record);
    pending.steps[0]!.inference!.attempts[0]!.providerResponses = {
      schemaVersion: 1,
      state: "pending",
      observations: [],
      pendingRequestSequences: [1],
    };
    expect(
      parseScorecardRunRecord(pending).steps[0]!.inference!.attempts[0]!.providerResponses?.state,
    ).toBe("pending");

    const malformed = structuredClone(record);
    Object.assign(malformed.steps[0]!.inference!.attempts[0]!.providerResponses!.observations[0]!, {
      rawBody: "no",
    });
    expect(() => parseScorecardRunRecord(malformed)).toThrowError(ScorecardRecordError);

    const duplicateSequence = structuredClone(record);
    duplicateSequence.steps[0]!.inference!.attempts[0]!.providerResponses!.observations.push({
      requestSequence: 1,
      disposition: "cancelled",
      observedBytes: 0,
    });
    expect(() => parseScorecardRunRecord(duplicateSequence)).toThrowError(ScorecardRecordError);
  });

  it("round-trips versioned content-free efficiency evidence and treats legacy absence as unavailable", () => {
    const record = succeededRecord();
    const attempt = record.steps[0]!.inference!.attempts[0]!;
    expect(
      parseScorecardRunRecord(record).steps[0]!.inference!.attempts[0]!.efficiency,
    ).toBeUndefined();
    attempt.efficiency = {
      schemaVersion: 1,
      requests: [{ requestSequence: 1, turn: 1, bodyBytes: 238, bodySha256: "a".repeat(64) }],
      sourceReuse: {
        hits: 1,
        misses: 0,
        seededRanges: 2,
        refusals: 0,
        invalidations: { authorityChange: 0, sourceChange: 0, snapshotChange: 0 },
        rangeMismatches: 0,
      },
    };
    expect(parseScorecardRunRecord(record).steps[0]!.inference!.attempts[0]!.efficiency).toEqual(
      attempt.efficiency,
    );
    const forged = structuredClone(record);
    Object.assign(forged.steps[0]!.inference!.attempts[0]!.efficiency!.requests![0]!, {
      body: "secret",
    });
    expect(() => parseScorecardRunRecord(forged)).toThrowError(ScorecardRecordError);
    attempt.efficiency.requests = null;
    expect(
      parseScorecardRunRecord(record).steps[0]!.inference!.attempts[0]!.efficiency?.requests,
    ).toBeNull();
  });

  it.each(["unknown", "stale"] as const)(
    "round-trips provider-admitted %s context without inventing a host ceiling",
    (status) => {
      const record = succeededRecord();
      const model = modelEvidence();
      const profile = model.profile;
      profile.status = status;
      profile.effectiveLimitReason = status === "unknown" ? "metadata-unknown" : "metadata-stale";
      profile.configuredContextWindow = profile.effectiveContextWindow = 8192;
      profile.configuredMaxInputTokens = profile.effectiveMaxInputTokens = 8192;
      profile.configuredMaxOutputTokens = profile.effectiveMaxOutputTokens = 4096;
      if (status === "unknown") {
        delete profile.approvedSourceSha256;
        delete profile.effectiveDate;
        delete profile.reviewAfter;
      }
      const { sha256: _oldDigest, ...withoutDigest } = profile;
      profile.sha256 = modelProfileEvidenceSha256({ ...model, profile: withoutDigest });
      record.models = [model];
      const step = record.steps[0]!;
      step.model = model;
      const attempt = step.inference!.attempts[0]!;
      attempt.model = model;
      const governed = governProviderTurn({
        context: { messages: [{ role: "user", content: "source evidence ".repeat(8000) }] },
        policy: {
          skipHostContextAdmission: true,
          budget: {
            configuredContextWindow: profile.configuredContextWindow,
            effectiveContextWindow: profile.effectiveContextWindow,
            configuredMaxInputTokens: profile.configuredMaxInputTokens!,
            effectiveMaxInputTokens: profile.effectiveMaxInputTokens!,
            configuredMaxOutputTokens: profile.configuredMaxOutputTokens,
            effectiveMaxOutputTokens: profile.effectiveMaxOutputTokens,
            reservedTokens: profile.requestPolicy.reservedContextTokens,
            requiredMinimumOutputTokens: profile.requestPolicy.minimumOutputTokens,
          },
          maxProviderTurns: 12,
          maxToolCalls: 12,
          maxCompactions: 8,
          minRecentToolTurns: 1,
        },
        state: { providerTurns: 0, toolCalls: 0, toolResults: 0, compactions: 0 },
        evidenceIdentity: attempt.identity!,
        pinnedMessageCount: 0,
      });
      expect(governed.evidence.estimatedInputTokens).toBeGreaterThan(
        profile.effectiveContextWindow,
      );
      expect(governed.evidence.contextAdmission).toBe("provider");
      attempt.turns = [governed.evidence];
      expect(parseScorecardRunRecord(record)).toEqual(record);

      const unmarked = structuredClone(record);
      delete unmarked.steps[0]!.inference!.attempts[0]!.turns![0]!.contextAdmission;
      expect(() => parseScorecardRunRecord(unmarked)).toThrow(ScorecardRecordError);
      const excessOutput = structuredClone(record);
      excessOutput.steps[0]!.inference!.attempts[0]!.turns![0]!.outputTokens =
        profile.effectiveMaxOutputTokens + 1;
      expect(() => parseScorecardRunRecord(excessOutput)).toThrow(ScorecardRecordError);
      const hostProfile = structuredClone(record);
      hostProfile.steps[0]!.inference!.attempts[0]!.model = modelEvidence();
      expect(() => parseScorecardRunRecord(hostProfile)).toThrow(ScorecardRecordError);
    },
  );

  it("decodes an optional evaluator technical digest while preserving older identities", () => {
    const current = succeededRecord();
    current.steps[0]!.inference!.attempts[0]!.identity!.technicalVerificationSha256 = "f".repeat(
      64,
    );
    rehashTurnEvidence(current);
    expect(parseScorecardRunRecord(current)).toEqual(current);

    const historical = succeededRecord();
    expect(
      historical.steps[0]!.inference!.attempts[0]!.identity!.technicalVerificationSha256,
    ).toBeUndefined();
    expect(parseScorecardRunRecord(historical)).toEqual(historical);
  });

  it("cold-imports the whole provisional candidate digest on retained attempts", () => {
    const current = succeededRecord();
    const attempt = current.steps[0]!.inference!.attempts[0]!;
    attempt.identity!.provisionalRichCandidateSha256 = "e".repeat(64);
    // Per-turn normalization deliberately excludes lease-only candidate identity.
    expect(
      parseScorecardRunRecord(current).steps[0]!.inference!.attempts[0]!.identity,
    ).toMatchObject({ provisionalRichCandidateSha256: "e".repeat(64) });

    const malformed = structuredClone(current);
    malformed.steps[0]!.inference!.attempts[0]!.identity!.provisionalRichCandidateSha256 =
      "not-a-digest";
    expect(() => parseScorecardRunRecord(malformed)).toThrow(ScorecardRecordError);

    const legacy = succeededRecord();
    expect(parseScorecardRunRecord(legacy)).toEqual(legacy);
  });

  it("retains strict finalized provider-payload evidence", () => {
    const record = succeededRecord();
    const turn = record.steps[0]!.inference!.attempts[0]!.turns![0]!;
    turn.providerPayloadSchemaVersion = 1;
    turn.requestPolicySha256 = "c".repeat(64);
    turn.finalPayloadSha256 = "d".repeat(64);
    expect(parseScorecardRunRecord(record)).toEqual(record);

    const missingPayload = structuredClone(record);
    delete missingPayload.steps[0]!.inference!.attempts[0]!.turns![0]!.finalPayloadSha256;
    expect(() => parseScorecardRunRecord(missingPayload)).toThrowError(ScorecardRecordError);

    const directProvider = succeededRecord();
    directProvider.steps[0]!.inference!.attempts[0]!.turns![0]!.providerPayloadSchemaVersion = 1;
    directProvider.steps[0]!.inference!.attempts[0]!.turns![0]!.finalPayloadSha256 = "e".repeat(64);
    expect(parseScorecardRunRecord(directProvider)).toEqual(directProvider);
  });

  it("decodes a bounded in-turn retry count only on a finalized turn", () => {
    const finalized = () => {
      const record = succeededRecord();
      const turn = record.steps[0]!.inference!.attempts[0]!.turns![0]!;
      turn.providerPayloadSchemaVersion = 1;
      turn.finalPayloadSha256 = "d".repeat(64);
      return record;
    };

    // Absent means zero retries; the field does not appear for an unretried turn.
    expect(parseScorecardRunRecord(finalized())).toEqual(finalized());

    const retried = finalized();
    retried.steps[0]!.inference!.attempts[0]!.turns![0]!.providerRetries = 2;
    expect(parseScorecardRunRecord(retried)).toEqual(retried);
    expect(
      parseScorecardRunRecord(retried).steps[0]!.inference!.attempts[0]!.turns![0]!.providerRetries,
    ).toBe(2);

    // A retry replays a payload that was finalized and sent, and a recorded
    // retry is a count of attempts, so zero and fractional are not counts.
    for (const invalid of [0, -1, 1.5]) {
      const candidate = finalized();
      candidate.steps[0]!.inference!.attempts[0]!.turns![0]!.providerRetries = invalid;
      expect(() => parseScorecardRunRecord(candidate)).toThrowError(ScorecardRecordError);
    }
    const unfinalized = succeededRecord();
    unfinalized.steps[0]!.inference!.attempts[0]!.turns![0]!.providerRetries = 1;
    expect(() => parseScorecardRunRecord(unfinalized)).toThrowError(ScorecardRecordError);
  });

  it("decodes an empty-turn count only within providerRetries + 1 on a finalized turn", () => {
    // Both directions of the `<= providerRetries + 1` guard are pinned, mirroring
    // the providerRetries controls above.
    const finalized = () => {
      const record = succeededRecord();
      const turn = record.steps[0]!.inference!.attempts[0]!.turns![0]!;
      turn.providerPayloadSchemaVersion = 1;
      turn.finalPayloadSha256 = "d".repeat(64);
      return record;
    };
    const turnOf = (record: RunRecord) => record.steps[0]!.inference!.attempts[0]!.turns![0]!;

    // Accepting controls: a single terminal blank, and a streak whose every
    // blank but the last was replaced by a replay.
    const single = finalized();
    turnOf(single).providerBlankTurns = 1;
    expect(parseScorecardRunRecord(single)).toEqual(single);
    expect(turnOf(parseScorecardRunRecord(single)).providerBlankTurns).toBe(1);
    const streak = finalized();
    turnOf(streak).providerRetries = 2;
    turnOf(streak).providerBlankTurns = 3;
    expect(parseScorecardRunRecord(streak)).toEqual(streak);
    // A blank turn cut at the output limit and its one nudged replay cut the same
    // way: two blanks, one retry, at the bound exactly.
    const lengthCut = finalized();
    turnOf(lengthCut).providerRetries = 1;
    turnOf(lengthCut).providerBlankTurns = 2;
    expect(parseScorecardRunRecord(lengthCut)).toEqual(lengthCut);

    // Every empty turn except the last was replaced by a replay, so the count
    // cannot outrun the retries: three blanks need at least two retries, and
    // two blanks without any retry never happened.
    const outran = finalized();
    turnOf(outran).providerRetries = 1;
    turnOf(outran).providerBlankTurns = 3;
    expect(() => parseScorecardRunRecord(outran)).toThrowError(ScorecardRecordError);
    const unreplayed = finalized();
    turnOf(unreplayed).providerBlankTurns = 2;
    expect(() => parseScorecardRunRecord(unreplayed)).toThrowError(ScorecardRecordError);

    // A recorded blank is a count of empty turns, so zero, negative and
    // fractional are not counts.
    for (const invalid of [0, -1, 1.5]) {
      const candidate = finalized();
      turnOf(candidate).providerBlankTurns = invalid;
      expect(() => parseScorecardRunRecord(candidate)).toThrowError(ScorecardRecordError);
    }
    // An empty turn is a provider answer to a payload that was finalized and
    // sent; a blank on an unfinalized turn did not happen.
    const unfinalizedBlank = succeededRecord();
    turnOf(unfinalizedBlank).providerBlankTurns = 1;
    expect(() => parseScorecardRunRecord(unfinalizedBlank)).toThrowError(ScorecardRecordError);
  });

  it("decodes a replay veto only from the closed vocabulary and only on a sent turn", () => {
    // `providerRetries` says how many physical requests a governed turn spent;
    // this field says which boundary stopped it spending more. Legacy records
    // carry neither and must keep decoding unchanged.
    const finalized = () => {
      const record = succeededRecord();
      const turn = record.steps[0]!.inference!.attempts[0]!.turns![0]!;
      turn.providerPayloadSchemaVersion = 1;
      turn.finalPayloadSha256 = "d".repeat(64);
      return record;
    };
    const turnOf = (record: RunRecord) => record.steps[0]!.inference!.attempts[0]!.turns![0]!;

    // Absent means no replay was refused.
    expect(parseScorecardRunRecord(finalized())).toEqual(finalized());

    // Every member of the shipped vocabulary decodes, so a veto the runtime
    // writes can be read back.
    for (const veto of PROVIDER_TURN_REPLAY_VETOES) {
      const candidate = finalized();
      turnOf(candidate).providerReplayVeto = veto;
      expect(parseScorecardRunRecord(candidate), veto).toEqual(candidate);
      expect(turnOf(parseScorecardRunRecord(candidate)).providerReplayVeto, veto).toBe(veto);
    }

    // An unknown value is refused outright rather than read as though it were
    // understood: "" and a plausible near-miss both fail.
    for (const invalid of ["", "exhausted", "attempts_exhausted", 1]) {
      const candidate = finalized();
      turnOf(candidate).providerReplayVeto = invalid as never;
      expect(() => parseScorecardRunRecord(candidate)).toThrowError(ScorecardRecordError);
    }

    // A refused replay presupposes a request that was finalized and sent; a
    // veto on a turn that issued nothing did not happen.
    const unfinalized = succeededRecord();
    turnOf(unfinalized).providerReplayVeto = "attempts-exhausted";
    expect(() => parseScorecardRunRecord(unfinalized)).toThrowError(ScorecardRecordError);
  });

  it("decodes a closed provider finish reason only on a sent turn", () => {
    const finalized = () => {
      const record = succeededRecord();
      const turn = record.steps[0]!.inference!.attempts[0]!.turns![0]!;
      turn.providerPayloadSchemaVersion = 1;
      turn.finalPayloadSha256 = "d".repeat(64);
      return record;
    };
    const turnOf = (record: RunRecord) => record.steps[0]!.inference!.attempts[0]!.turns![0]!;

    expect(parseScorecardRunRecord(finalized())).toEqual(finalized());
    for (const reason of ["length", "stop", "tool_calls"] as const) {
      const candidate = finalized();
      turnOf(candidate).rawStopReason = reason;
      expect(parseScorecardRunRecord(candidate), reason).toEqual(candidate);
      expect(turnOf(parseScorecardRunRecord(candidate)).rawStopReason, reason).toBe(reason);
    }
    for (const invalid of ["", "absent", "LENGTH", "nvapi-abcdefghijklmnopqrstuvwxyz012345", 1]) {
      const candidate = finalized();
      turnOf(candidate).rawStopReason = invalid as never;
      expect(() => parseScorecardRunRecord(candidate)).toThrowError(ScorecardRecordError);
    }
  });

  it("decodes a clamped output authority only when its arithmetic holds", () => {
    // `outputAuthority` is recorded only where the lease's cumulative output
    // authority bound the turn; the decoder redoes the sums.
    const turnOf = (record: RunRecord) => record.steps[0]!.inference!.attempts[0]!.turns![0]!;
    const authority = (cumulativeOutputTokens: number) => ({
      maxOutputTokens: 128_000,
      cumulativeOutputTokens,
      floorOutputTokens: 1_040,
    });

    // Accepting control: 10,000 remaining of the 16,384 per-turn limit,
    // requested exactly and granted.
    const clamped = succeededRecord();
    turnOf(clamped).requestedOutputTokens = 10_000;
    turnOf(clamped).outputTokens = 10_000;
    turnOf(clamped).outputAuthority = authority(118_000);
    expect(parseScorecardRunRecord(clamped)).toEqual(clamped);
    expect(turnOf(parseScorecardRunRecord(clamped)).outputAuthority).toEqual(authority(118_000));
    // Accepting control at the floor: exactly 1,040 remaining is still a clamp
    // the governor sends, so the decoder must admit it.
    const atFloor = succeededRecord();
    turnOf(atFloor).requestedOutputTokens = 1_040;
    turnOf(atFloor).outputTokens = 1_040;
    turnOf(atFloor).outputAuthority = authority(128_000 - 1_040);
    expect(parseScorecardRunRecord(atFloor)).toEqual(atFloor);

    const rejected = (mutate: (turn: ReturnType<typeof turnOf>) => void) => {
      const candidate = succeededRecord();
      mutate(turnOf(candidate));
      expect(() => parseScorecardRunRecord(candidate)).toThrowError(ScorecardRecordError);
    };
    // A clamp requests exactly the remainder, no more and no less.
    rejected((turn) => {
      turn.requestedOutputTokens = 9_999;
      turn.outputTokens = 9_999;
      turn.outputAuthority = authority(118_000);
    });
    rejected((turn) => {
      turn.outputAuthority = authority(118_000);
    });
    // A remainder that still covers the per-turn limit never binds.
    rejected((turn) => {
      turn.requestedOutputTokens = 20_000;
      turn.outputTokens = 16_384;
      turn.outputAuthority = authority(108_000);
    });
    // The floor sits above the provider minimum, and a remainder under the
    // floor is an exhaustion rather than a clamp.
    rejected((turn) => {
      turn.requestedOutputTokens = 10_000;
      turn.outputTokens = 10_000;
      turn.outputAuthority = { ...authority(118_000), floorOutputTokens: 16 };
    });
    rejected((turn) => {
      turn.requestedOutputTokens = 500;
      turn.outputTokens = 500;
      turn.outputAuthority = authority(127_500);
    });
    // One token under the floor is an exhaustion, so a clamp claimed there is
    // rejected: the boundary the accepting control above admits is exact.
    rejected((turn) => {
      turn.requestedOutputTokens = 1_039;
      turn.outputTokens = 1_039;
      turn.outputAuthority = authority(128_000 - 1_039);
    });
    for (const invalid of [
      { ...authority(118_000), extra: 1 },
      { ...authority(118_000), cumulativeOutputTokens: -1 },
      { ...authority(118_000), maxOutputTokens: 0 },
      { ...authority(118_000), floorOutputTokens: 1.5 },
    ]) {
      rejected((turn) => {
        turn.requestedOutputTokens = 10_000;
        turn.outputTokens = 10_000;
        turn.outputAuthority = invalid as never;
      });
    }
  });

  it("decodes turn outputTokens as tokens produced below the allowance", () => {
    const record = succeededRecord();
    const turn = record.steps[0]!.inference!.attempts[0]!.turns![0]!;
    expect(turn.outputTokens).toBe(50);
    expect(turn.effectiveMaxOutputTokens).toBe(16_384);
    expect(turn.outputTokens).not.toBe(turn.effectiveMaxOutputTokens);
    expect(parseScorecardRunRecord(record)).toEqual(record);
    expect(parseScorecardRunRecord(record).steps[0]!.inference!.attempts[0]!.usage?.output).toBe(
      50,
    );
  });

  it("decodes discarded-plus-landed production that crosses one request grant", () => {
    const record = succeededRecord();
    const turn = record.steps[0]!.inference!.attempts[0]!.turns![0]!;
    turn.providerPayloadSchemaVersion = 1;
    turn.finalPayloadSha256 = "d".repeat(64);
    turn.providerRetries = 1;
    const grant = grantedTurnOutputTokens(turn);
    const aggregate = grant + 4_000;
    record.steps[0]!.inference!.attempts[0]!.turns = bindProducedTurnOutputTokens(
      [turn],
      [aggregate],
    );
    expect(record.steps[0]!.inference!.attempts[0]!.turns![0]!.outputTokens).toBe(aggregate);
    expect(aggregate).toBeGreaterThan(grant);
    expect(parseScorecardRunRecord(record)).toEqual(record);

    const overCeiling = structuredClone(record);
    overCeiling.steps[0]!.inference!.attempts[0]!.turns![0]!.outputTokens = grant * 2 + 1;
    expect(() => parseScorecardRunRecord(overCeiling)).toThrowError(ScorecardRecordError);
    const noRetry = structuredClone(record);
    delete noRetry.steps[0]!.inference!.attempts[0]!.turns![0]!.providerRetries;
    noRetry.steps[0]!.inference!.attempts[0]!.turns![0]!.outputTokens = aggregate;
    expect(() => parseScorecardRunRecord(noRetry)).toThrowError(ScorecardRecordError);
  });

  it("decodes a sent turn whose produced output is unknown rather than the grant", () => {
    const record = succeededRecord();
    const turn = record.steps[0]!.inference!.attempts[0]!.turns![0]!;
    const grant = grantedTurnOutputTokens(turn);
    record.steps[0]!.inference!.attempts[0]!.turns = bindProducedTurnOutputTokens([turn], []);
    expect(record.steps[0]!.inference!.attempts[0]!.turns![0]!.outputTokens).toBeUndefined();
    expect(record.steps[0]!.inference!.attempts[0]!.turns![0]!.outputTokens).not.toBe(grant);
    expect(parseScorecardRunRecord(record)).toEqual(record);
  });

  it("binds terminal lease evidence to its exact attempt, revision, turns, usage, and tools", () => {
    const record = succeededRecord();
    const attempt = record.steps[0]!.inference!.attempts[0]!;
    const binding = {
      inferenceAttempt: 1,
      retriesConsumed: 0,
      repositoryRevision: REVISION,
      providerTurnLedgerSha256: jsonEvidenceDigest(attempt.turns),
      usageSha256: jsonEvidenceDigest(attempt.usage),
      toolsSha256: jsonEvidenceDigest(attempt.tools),
    };
    attempt.executionLease = terminalLeaseEvidence(binding);
    expect(parseScorecardRunRecord(record)).toEqual(record);

    for (const transplanted of [
      terminalLeaseEvidence({ ...binding, inferenceAttempt: 2, retriesConsumed: 1 }),
      terminalLeaseEvidence({ ...binding, repositoryRevision: "f".repeat(40) }),
      terminalLeaseEvidence({ ...binding, providerTurnLedgerSha256: "1".repeat(64) }),
      terminalLeaseEvidence({ ...binding, usageSha256: "2".repeat(64) }),
      terminalLeaseEvidence({ ...binding, toolsSha256: "3".repeat(64) }),
    ]) {
      const candidate = structuredClone(record);
      candidate.steps[0]!.inference!.attempts[0]!.executionLease = transplanted;
      expect(() => parseScorecardRunRecord(candidate)).toThrowError(ScorecardRecordError);
    }
  });

  it("retains a completed provider attempt rejected by the response contract before a successful retry", () => {
    const inference = succeededRecord().steps[0]!.inference!;
    inference.configuredMaxRetries = 1;
    inference.effectiveMaxRetries = 1;
    inference.retryableCategories = ["malformed-response"];
    const first = inference.attempts[0]!;
    const second = structuredClone(first);
    first.outcome = "malformed-response";
    first.retryable = true;
    first.retryScheduled = true;
    first.backoffMs = inference.baseDelayMs;
    second.attempt = 2;
    inference.attempts.push(second);
    for (const attempt of inference.attempts) {
      attempt.executionLease = terminalLeaseEvidence({
        inferenceAttempt: attempt.attempt,
        retriesConsumed: attempt.attempt - 1,
        repositoryRevision: REVISION,
        providerTurnLedgerSha256: jsonEvidenceDigest(attempt.turns),
        usageSha256: jsonEvidenceDigest(attempt.usage),
        toolsSha256: jsonEvidenceDigest(attempt.tools),
      });
    }
    expect(decodeInference(inference)).toEqual(inference);
    first.outcome = "timeout";
    inference.retryableCategories = ["timeout"];
    expect(() => decodeInference(inference)).toThrowError(ScorecardRecordError);
  });

  it("continues to decode a historical successful disabled-writer record", () => {
    const inference = succeededRecord().steps[0]!.inference!;
    inference.replay = "disabled-write-step";
    inference.configuredMaxRetries = 2;
    inference.effectiveMaxRetries = 0;
    inference.retryableCategories = ["throttled", "provider-transient"];
    const attempt = inference.attempts[0]!;
    // Historical disabled-writer success records did not persist settlement
    // evidence or a transport policy block; both remain optional.
    expect(attempt.writeSettlement).toBeUndefined();
    expect(decodeInference(inference, "disabled-write-step")).toEqual(inference);
  });

  it("decodes a host-reset writer's retried malformed reply and nothing wider (#1266)", () => {
    const inference = succeededRecord().steps[0]!.inference!;
    inference.replay = "reset-write-step";
    inference.configuredMaxRetries = 1;
    inference.effectiveMaxRetries = 1;
    inference.retryableCategories = ["malformed-response", "timeout"];
    const first = inference.attempts[0]!;
    const second = structuredClone(first);
    first.outcome = "malformed-response";
    first.retryable = true;
    first.retryScheduled = true;
    first.backoffMs = inference.baseDelayMs;
    first.rejection = {
      code: "revision-accounting-changed-path-mismatch",
      location: "$.changedPaths",
    };
    second.attempt = 2;
    inference.attempts.push(second);
    for (const attempt of inference.attempts) {
      attempt.executionLease = terminalLeaseEvidence({
        inferenceAttempt: attempt.attempt,
        retriesConsumed: attempt.attempt - 1,
        repositoryRevision: REVISION,
        providerTurnLedgerSha256: jsonEvidenceDigest(attempt.turns),
        usageSha256: jsonEvidenceDigest(attempt.usage),
        toolsSha256: jsonEvidenceDigest(attempt.tools),
      });
    }
    expect(decodeInference(inference, "reset-write-step")).toEqual(inference);
    // The same record is not a write step that is never replayed.
    expect(() => decodeInference(inference, "disabled-write-step")).toThrowError(
      ScorecardRecordError,
    );
    // A reset writer keeps the configured budget.
    expect(() =>
      decodeInference({ ...inference, effectiveMaxRetries: 0 }, "reset-write-step"),
    ).toThrowError(ScorecardRecordError);
    // It replays only a malformed reply, whatever else the configured list names.
    const leaseFree = structuredClone(inference);
    for (const attempt of leaseFree.attempts) delete attempt.executionLease;
    expect(decodeInference(leaseFree, "reset-write-step")).toEqual(leaseFree);
    const timedOut = structuredClone(leaseFree);
    timedOut.attempts[0]!.outcome = "timeout";
    delete timedOut.attempts[0]!.rejection;
    expect(decodeInference({ ...timedOut, replay: "read-only" }, "read-only")).toEqual({
      ...timedOut,
      replay: "read-only",
    });
    expect(() => decodeInference(timedOut, "reset-write-step")).toThrowError(ScorecardRecordError);
  });

  /**
   * The rejected reply's shape fingerprint is admitted on a response-contract
   * rejection, refused on any other outcome, and refused when forged to carry text.
   */
  it("decodes a rejected reply shape fingerprint only on a response-contract rejection", () => {
    const inference = succeededRecord().steps[0]!.inference!;
    inference.configuredMaxRetries = 1;
    inference.effectiveMaxRetries = 1;
    inference.retryableCategories = ["malformed-response"];
    const attempt = inference.attempts[0]!;
    attempt.outcome = "malformed-response";
    attempt.retryable = true;
    attempt.retryScheduled = false;
    attempt.rejectedReplyShape = fingerprintRejectedReply(
      '{"review":{"verdict":"pass"}}',
      () => true,
    );
    expect(decodeInference(inference)).toEqual(inference);

    const onSuccess = succeededRecord().steps[0]!.inference!;
    onSuccess.attempts[0]!.rejectedReplyShape = attempt.rejectedReplyShape;
    expect(() => decodeInference(onSuccess)).toThrowError(ScorecardRecordError);

    const forged = structuredClone(inference);
    (forged.attempts[0]!.rejectedReplyShape as unknown as Record<string, unknown>).text =
      "rejected reply prose";
    expect(() => decodeInference(forged)).toThrowError(ScorecardRecordError);
  });

  it("decodes a rejected reply excerpt only beside its fingerprint (#1690)", () => {
    const inference = succeededRecord().steps[0]!.inference!;
    inference.configuredMaxRetries = 1;
    inference.effectiveMaxRetries = 1;
    inference.retryableCategories = ["malformed-response"];
    const attempt = inference.attempts[0]!;
    attempt.outcome = "malformed-response";
    attempt.retryable = true;
    attempt.retryScheduled = false;
    const reply = 'Reasoning first. {"review":';
    attempt.rejectedReplyShape = fingerprintRejectedReply(reply, () => true);
    attempt.rejectedReplyExcerpt = excerptRejectedReply(reply, 512, 0);
    expect(decodeInference(inference)).toEqual(inference);

    const alone = structuredClone(inference);
    delete alone.attempts[0]!.rejectedReplyShape;
    expect(() => decodeInference(alone)).toThrowError(ScorecardRecordError);

    const forged = structuredClone(inference);
    (forged.attempts[0]!.rejectedReplyExcerpt!.segments[0] as { text: string }).text +=
      " and more reply prose";
    expect(() => decodeInference(forged)).toThrowError(ScorecardRecordError);
  });

  it("decodes a judgment row key audit only on an accepted attempt (#1178)", () => {
    const audit = {
      schemaVersion: 1 as const,
      issueJudgments: { rows: 1, undeclaredKeys: 2, namedUndeclaredKeys: ["sourceLocators"] },
      obligationJudgments: { rows: 2, undeclaredKeys: 0, namedUndeclaredKeys: [] },
      replacements: { rows: 0, undeclaredKeys: 0, namedUndeclaredKeys: [] },
    };
    const accepted = succeededRecord().steps[0]!.inference!;
    accepted.attempts[0]!.judgmentRowKeyAudit = audit;
    expect(decodeInference(accepted)).toEqual(accepted);

    const rejected = succeededRecord().steps[0]!.inference!;
    rejected.configuredMaxRetries = 1;
    rejected.effectiveMaxRetries = 1;
    rejected.retryableCategories = ["malformed-response"];
    Object.assign(rejected.attempts[0]!, {
      outcome: "malformed-response",
      retryable: true,
      retryScheduled: false,
      judgmentRowKeyAudit: audit,
    });
    expect(() => decodeInference(rejected)).toThrowError(ScorecardRecordError);

    const forged = succeededRecord().steps[0]!.inference!;
    forged.attempts[0]!.judgmentRowKeyAudit = {
      ...audit,
      issueJudgments: { rows: 1, undeclaredKeys: 1, namedUndeclaredKeys: ["free text key"] },
    };
    expect(() => decodeInference(forged)).toThrowError(ScorecardRecordError);
  });

  it("decodes per-attempt model telemetry and refuses a forged or misplaced one (#1185)", () => {
    const telemetry = {
      schemaVersion: 1 as const,
      finishReason: "stop" as const,
      outputTokens: 7,
      outputAllowance: 4_096,
      providerLatencyMs: 12,
    };
    const accepted = succeededRecord().steps[0]!.inference!;
    accepted.attempts[0]!.modelTelemetry = telemetry;
    expect(decodeInference(accepted)).toEqual(accepted);

    // A provider error ends the attempt it lands in; a succeeded one cannot carry it.
    const misplaced = succeededRecord().steps[0]!.inference!;
    misplaced.attempts[0]!.modelTelemetry = {
      ...telemetry,
      finishReason: "error",
      providerError: { class: "rate-limit", httpStatus: 429 },
    };
    expect(() => decodeInference(misplaced)).toThrowError(ScorecardRecordError);

    const forged = succeededRecord().steps[0]!.inference!;
    forged.attempts[0]!.modelTelemetry = {
      ...telemetry,
      finishReason: "the model decided to stop here",
    } as unknown as typeof telemetry;
    expect(() => decodeInference(forged)).toThrowError(ScorecardRecordError);
  });

  it("retains maxRetriesSource on a decoded inference run artefact", () => {
    const inference = succeededRecord().steps[0]!.inference!;
    inference.maxRetriesSource = "config/limits.yaml";
    expect(decodeInference(inference)).toEqual(inference);
    inference.maxRetriesSource = "not-a-source" as never;
    expect(() => decodeInference(inference)).toThrowError(ScorecardRecordError);
  });

  /**
   * The coded rejection reason is an optional attempt fact on the persisted run
   * record, so a decoder miss would refuse every record containing a rejected
   * source-obligation attempt, wholesale.
   */
  it("decodes an attempt rejection reason, and refuses a forged or over-long one", () => {
    const historical = succeededRecord().steps[0]!.inference!;
    expect(historical.attempts[0]!.rejection).toBeUndefined();
    // A record from before the reason existed decodes byte-identically.
    expect(decodeInference(historical)).toEqual(historical);

    const inference = succeededRecord().steps[0]!.inference!;
    inference.configuredMaxRetries = 1;
    inference.effectiveMaxRetries = 1;
    inference.retryableCategories = ["malformed-response"];
    const attempt = inference.attempts[0]!;
    attempt.outcome = "malformed-response";
    attempt.retryable = true;
    attempt.retryScheduled = false;
    attempt.rejection = { code: "invalid-json", location: "$response" };
    expect(decodeInference(inference)).toEqual(inference);
    expect(decodeInference(inference).attempts[0]!.rejection).toEqual({
      code: "invalid-json",
      location: "$response",
    });

    const half = structuredClone(inference);
    half.attempts[0]!.rejection = { code: "invalid-json" } as never;
    expect(() => decodeInference(half)).toThrowError(ScorecardRecordError);

    const extra = structuredClone(inference);
    extra.attempts[0]!.rejection = {
      code: "invalid-json",
      location: "$response",
      note: "extra",
    } as never;
    expect(() => decodeInference(extra)).toThrowError(ScorecardRecordError);

    // The 256-character bound, at the limit and at the limit plus one. It is
    // exercised on `location` because that is the field whose grammar admits a
    // value that long; the `code` grammar caps far shorter on its own.
    const segment = (length: number): string => `.${"a".repeat(length)}`;
    // 1 (`$`) + 64 + 64 + 64 + 63 = 256.
    const atLimitLocation = `$${segment(63)}${segment(63)}${segment(63)}${segment(62)}`;
    expect(atLimitLocation).toHaveLength(256);
    const atLimit = structuredClone(inference);
    atLimit.attempts[0]!.rejection = { code: "invalid-value", location: atLimitLocation };
    expect(decodeInference(atLimit).attempts[0]!.rejection?.location).toHaveLength(256);

    const overLimit = structuredClone(inference);
    overLimit.attempts[0]!.rejection = { code: "invalid-value", location: `${atLimitLocation}b` };
    expect(`${atLimitLocation}b`).toHaveLength(257);
    expect(() => decodeInference(overLimit)).toThrowError(ScorecardRecordError);

    // Grammar, not vocabulary: free prose cannot be a code, and an indexed
    // location would disclose how much the response contained.
    const prose = structuredClone(inference);
    prose.attempts[0]!.rejection = {
      code: "the model said the token is hunter2 and the path is /srv/docsfab",
      location: "$response",
    };
    expect(() => decodeInference(prose)).toThrowError(ScorecardRecordError);

    const indexed = structuredClone(inference);
    indexed.attempts[0]!.rejection = {
      code: "invalid-value",
      location: "$.dimensions[3].obligations[7].statement",
    };
    expect(() => decodeInference(indexed)).toThrowError(ScorecardRecordError);
  });

  /**
   * The condition's retryability and the policy's decision are two separate
   * optional facts. A record carrying neither still decodes; one that carries
   * one as a copy of the other, or guesses one, does not.
   */
  it("decodes the condition/decision pair and rejects a copied, guessed, or half-written one", () => {
    const historical = succeededRecord().steps[0]!.inference!;
    expect(historical.attempts[0]!.conditionRetryability).toBeUndefined();
    expect(decodeInference(historical)).toEqual(historical);
    expect(readInferenceRetryDisposition(historical.attempts[0]!)).toEqual({
      conditionRetryability: INFERENCE_RETRY_DISPOSITION_UNAVAILABLE,
      retryDecision: INFERENCE_RETRY_DISPOSITION_UNAVAILABLE,
    });

    const inference = succeededRecord().steps[0]!.inference!;
    inference.configuredMaxRetries = 1;
    inference.effectiveMaxRetries = 1;
    inference.retryableCategories = ["malformed-response"];
    const first = inference.attempts[0]!;
    const second = structuredClone(first);
    first.outcome = "malformed-response";
    first.retryable = true;
    first.retryScheduled = true;
    first.backoffMs = inference.baseDelayMs;
    first.conditionRetryability = "eligible";
    first.retryDecision = "retried";
    second.attempt = 2;
    second.conditionRetryability = "not-applicable";
    second.retryDecision = "not-applicable";
    inference.attempts.push(second);
    expect(decodeInference(inference)).toEqual(inference);
    expect(readInferenceRetryDisposition(first)).toEqual({
      conditionRetryability: "eligible",
      retryDecision: "retried",
    });

    const rejected = (mutate: (attempt: (typeof inference)["attempts"][number]) => void): void => {
      const candidate = structuredClone(inference);
      mutate(candidate.attempts[0]!);
      expect(() => decodeInference(candidate)).toThrowError(ScorecardRecordError);
    };
    // The decision copied into the retryability field.
    rejected((attempt) => {
      attempt.conditionRetryability = "retried" as never;
    });
    // An eligible condition claimed terminal.
    rejected((attempt) => {
      attempt.conditionRetryability = "not-eligible";
    });
    // A decision that contradicts the retry this record shows was scheduled.
    rejected((attempt) => {
      attempt.retryDecision = "declined";
    });
    // Half a pair: a reader would have to guess the other half.
    rejected((attempt) => {
      delete attempt.retryDecision;
    });
    rejected((attempt) => {
      delete attempt.conditionRetryability;
    });
  });

  it("rejects re-sealed lease evidence that contradicts attempt tools or outcome", () => {
    const record = succeededRecord();
    const step = record.steps[0]!;
    const attempt = step.inference!.attempts[0]!;
    const successfulTool = {
      totalCalls: 1,
      failedCalls: 0,
      byTool: [{ name: "ls", calls: 1, failures: 0 }],
    };
    record.tools = structuredClone(successfulTool);
    step.tools = structuredClone(successfulTool);
    attempt.tools = structuredClone(successfulTool);
    attempt.turns![0]!.toolCalls = 1;
    attempt.turns![0]!.toolResults = 1;
    const binding = {
      inferenceAttempt: 1,
      retriesConsumed: 0,
      repositoryRevision: REVISION,
      providerTurnLedgerSha256: jsonEvidenceDigest(attempt.turns),
      usageSha256: jsonEvidenceDigest(attempt.usage),
      toolsSha256: jsonEvidenceDigest(attempt.tools),
    };

    const contradictoryTools = structuredClone(record);
    const toolLease = structuredClone(terminalLeaseEvidence(binding));
    toolLease.toolCalls = {
      requested: 1,
      executed: 1,
      succeeded: 0,
      failed: 1,
      denied: 0,
      governanceBlocked: 0,
    };
    rehashLeaseEvidence(toolLease);
    contradictoryTools.steps[0]!.inference!.attempts[0]!.executionLease = toolLease;
    expect(() => parseScorecardRunRecord(contradictoryTools)).toThrowError(ScorecardRecordError);

    const contradictoryOutcome = structuredClone(record);
    const outcomeLease = structuredClone(terminalLeaseEvidence(binding));
    outcomeLease.terminalReason = "provider-terminal";
    outcomeLease.terminalDisposition = "provider-failed";
    rehashLeaseEvidence(outcomeLease);
    contradictoryOutcome.steps[0]!.inference!.attempts[0]!.executionLease = outcomeLease;
    expect(() => parseScorecardRunRecord(contradictoryOutcome)).toThrowError(ScorecardRecordError);
  });

  it("decodes an authentic WorkflowRunner record with Pi-shaped evidence", async () => {
    const model = modelEvidence();
    const currentSkillId = getWorkflow("readiness").steps[0]!.skill;
    const skill = {
      id: currentSkillId,
      contentSha256: "c".repeat(64),
      bundleSha256: "d".repeat(64),
      version: "1.0.0",
      license: "Apache-2.0",
      source: {
        repository: "skill-catalog",
        revision: REVISION,
        path: `packages/skills/${currentSkillId}/SKILL.md`,
      },
      inputs: [{ name: "file_path", description: "File to analyze" }],
      outputs: [{ name: "context_report", description: "Structured analysis" }],
      toolPolicy: {
        declared: [],
        // Preserve the authentic record ordering rather than sorting lexically.
        granted: ["read", "grep", "find", "ls"],
        withheld: [],
      },
    };
    const harness: AgentHarness = {
      inspectSkill: async () => structuredClone(skill),
      runStep: async (input) => {
        const governed = governProviderTurn({
          context: { messages: [{ role: "user", content: "Inspect readiness." }] },
          policy: {
            budget: {
              configuredContextWindow: model.profile.configuredContextWindow,
              effectiveContextWindow: model.profile.effectiveContextWindow,
              configuredMaxInputTokens: 128_000,
              effectiveMaxInputTokens: 128_000,
              configuredMaxOutputTokens: model.profile.configuredMaxOutputTokens,
              effectiveMaxOutputTokens: model.profile.effectiveMaxOutputTokens,
              reservedTokens: model.profile.requestPolicy.reservedContextTokens,
              requiredMinimumOutputTokens: model.profile.requestPolicy.minimumOutputTokens,
            },
            maxProviderTurns: 12,
            maxToolCalls: 12,
            maxCompactions: 8,
            minRecentToolTurns: 1,
          },
          state: { providerTurns: 0, toolCalls: 0, toolResults: 0, compactions: 0 },
          evidenceIdentity: input.evidenceIdentity!,
          pinnedMessageCount: 0,
        });
        return {
          summary: "Repository readiness assessed.",
          model: structuredClone(model),
          skill: structuredClone(skill),
          usage: usage(),
          tools: { ...zeroTools(), failureCategories: [] },
          turns: [governed.evidence],
          providerResponses: {
            schemaVersion: 1,
            state: "complete",
            observations: [
              { requestSequence: 1, disposition: "complete", observedBytes: 12, httpStatus: 200 },
            ],
            pendingRequestSequences: [],
          },
          efficiency: {
            schemaVersion: 1,
            requests: [{ requestSequence: 1, turn: 1, bodyBytes: 123, bodySha256: "e".repeat(64) }],
            sourceReuse: null,
          },
        };
      },
    };
    const packet = {
      schemaVersion: 1,
      digest: PACKET,
      consultedNodeIds: ["node-a"],
    };
    const storeDirectory = await mkdtemp(join(tmpdir(), "docsfab-efficiency-persist-"));
    const store = new FileRunStore(storeDirectory);
    try {
      const record = await new WorkflowRunner({
        harness,
        store,
        repositoryScanner: {
          scan: async () => ({
            ruleSet: "docsfab-local-v2",
            status: "passed",
            scannedFiles: 1,
            binaryFiles: 0,
            findings: [],
          }),
        },
        contextPreflight: {
          preflight: async () => ({
            status: "ready",
            packetDigest: PACKET,
            consultedNodeIds: ["node-a"],
            ontologyVersion: "ontology-v1",
            effectiveDecisionIds: [],
            measurements: {
              byteLength: 1_024,
              estimatedTokens: 256,
              // LocalContextPreflightService uses performance.now(), so this is fractional.
              latencyMs: 4.25,
              nodeCount: 1,
              edgeCount: 0,
              pathCount: 1,
            },
            cache: {
              disposition: "miss",
              keyDigest: "1".repeat(64),
              rebuildAttempted: true,
            },
            packet,
          }),
        },
        id: () => "runner-produced-readiness",
        now: () => new Date("2026-08-04T00:00:00.000Z"),
      }).run({
        workflow: "readiness",
        workspacePath: "/private/disposable",
        repository: {
          sourcePath: "/private/source",
          requestedRevision: "HEAD",
          revision: REVISION,
        },
        allowWrite: false,
      });

      const persisted = await store.get(record.id);
      const decoded = parseScorecardRunRecord(persisted);
      expect(decoded).toEqual(record);
      expect(decoded.steps[0]!.inference!.attempts[0]!.efficiency).toEqual({
        schemaVersion: 1,
        requests: [{ requestSequence: 1, turn: 1, bodyBytes: 123, bodySha256: "e".repeat(64) }],
        sourceReuse: null,
      });
      expect(decoded.skills[0]!.toolPolicy!.granted).toEqual(["read", "grep", "find", "ls"]);
      expect(decoded.steps[0]!.contextPreflight!.measurements!.latencyMs).toBe(4.25);
    } finally {
      await rm(storeDirectory, { recursive: true, force: true });
    }
  });

  it("accepts a scanner-blocked local policy failure without inference", () => {
    const record = localSecurityFailure();

    expect(parseScorecardRunRecord(record)).toEqual(record);
  });

  it("accepts a failed context preflight without inference", () => {
    const record = succeededRecord();
    record.status = "failed";
    record.models = [];
    record.skills = [];
    record.usage = zeroUsage();
    record.tools = zeroTools();
    const step = record.steps[0]!;
    step.status = "failed";
    step.completedAt = step.startedAt;
    step.durationMs = 0;
    step.contextPreflight = { status: "failed", reason: "preflight-internal-failure" };
    step.error = "Context preflight failed.";
    delete step.model;
    delete step.skillEvidence;
    delete step.usage;
    delete step.tools;
    delete step.inference;
    delete step.summary;

    expect(parseScorecardRunRecord(record)).toEqual(record);
  });

  it("decodes a failed record's failure class and refuses a forged or misplaced one (#1186)", () => {
    const failed = (): RunRecord => {
      const record = succeededRecord();
      record.status = "failed";
      record.models = [];
      record.skills = [];
      record.usage = zeroUsage();
      record.tools = zeroTools();
      const step = record.steps[0]!;
      step.status = "failed";
      step.completedAt = step.startedAt;
      step.durationMs = 0;
      step.contextPreflight = { status: "failed", reason: "preflight-internal-failure" };
      step.error = "Context preflight failed.";
      for (const key of ["model", "skillEvidence", "usage", "tools", "inference", "summary"]) {
        delete (step as unknown as Record<string, unknown>)[key];
      }
      return record;
    };
    const failure = { class: "infrastructure", layer: "workflow", code: "uncoded-error" } as const;
    const record = failed();
    record.failure = failure;
    record.steps[0]!.failure = failure;
    expect(parseScorecardRunRecord(record)).toEqual(record);

    const forged = failed();
    forged.failure = { ...failure, class: "transient" } as unknown as typeof failure;
    expect(() => parseScorecardRunRecord(forged)).toThrow(ScorecardRecordError);
    const onSuccess = succeededRecord();
    onSuccess.failure = failure;
    expect(() => parseScorecardRunRecord(onSuccess)).toThrow(ScorecardRecordError);
  });

  it("accepts a valid bounded retry chain", () => {
    const record = succeededRecord();
    const inference = record.steps[0]!.inference!;
    const success = inference.attempts[0]!;
    inference.configuredMaxRetries = 1;
    inference.effectiveMaxRetries = 1;
    inference.attempts = [
      {
        ...structuredClone(success),
        attempt: 1,
        outcome: "timeout",
        retryable: true,
        retryScheduled: true,
        durationMs: 100,
        backoffMs: 100,
        usage: { ...zeroUsage(), turns: 1 },
      },
      {
        ...structuredClone(success),
        attempt: 2,
        durationMs: 500,
      },
    ];
    inference.baseDelayMs = 100;
    inference.maxDelayMs = 1_000;
    const aggregateUsage = { ...usage(), turns: 2 };
    record.usage = structuredClone(aggregateUsage);
    record.steps[0]!.usage = aggregateUsage;
    record.steps[0]!.tools = zeroTools();
    record.steps[0]!.durationMs = 800;

    expect(parseScorecardRunRecord(record).steps[0]!.inference!.attempts).toHaveLength(2);
  });

  it("enforces the production read-only retry relation", () => {
    const record = succeededRecord();
    const inference = record.steps[0]!.inference!;
    inference.configuredMaxRetries = 1;
    inference.effectiveMaxRetries = 0;

    expect(() => parseScorecardRunRecord(record)).toThrowError(ScorecardRecordError);
  });

  it("accepts production-valid degraded and unnecessary read-only context", () => {
    const degraded = succeededRecord();
    degraded.steps[0]!.contextPreflight!.status = "degraded";
    expect(parseScorecardRunRecord(degraded)).toEqual(degraded);

    const unnecessary = succeededRecord();
    unnecessary.steps[0]!.contextPreflight = {
      status: "unnecessary",
      reason: "policy-marked-unnecessary",
    };
    const identity = unnecessary.steps[0]!.inference!.attempts[0]!.identity!;
    delete identity.contextPacketDigest;
    delete identity.consultedNodeIds;
    rehashTurnEvidence(unnecessary);
    expect(parseScorecardRunRecord(unnecessary)).toEqual(unnecessary);
  });

  it("accepts a step that ran without a packet only when it names the budget no packet fit (#1932)", () => {
    const withheld = succeededRecord();
    const ready = withheld.steps[0]!.contextPreflight!;
    withheld.steps[0]!.contextPreflight = {
      status: "degraded",
      reason: "preflight-budget-exceeded",
      limit: {
        name: "context.corpusPacketInputShareBasisPoints",
        unit: "tokens",
        configured: 8_192,
        observed: 9_000,
      },
      ontologyVersion: ready.ontologyVersion!,
      measurements: ready.measurements!,
      cache: ready.cache!,
    };
    const identity = withheld.steps[0]!.inference!.attempts[0]!.identity!;
    delete identity.contextPacketDigest;
    delete identity.consultedNodeIds;
    rehashTurnEvidence(withheld);
    expect(parseScorecardRunRecord(withheld)).toEqual(withheld);

    // The same step without the bound is refused: nothing says why it had no packet.
    const unbounded = structuredClone(withheld);
    const { limit: _limit, ...withoutLimit } = unbounded.steps[0]!.contextPreflight!;
    unbounded.steps[0]!.contextPreflight = {
      ...withoutLimit,
      reason: "navigation-coverage-incomplete",
    };
    expect(() => parseScorecardRunRecord(unbounded)).toThrowError(
      new ScorecardRecordError("invalid-scorecard-run-record"),
    );
  });

  it("accepts a step that ran without a packet when it names its preflight cause (#1924)", () => {
    const withoutPacket = succeededRecord();
    withoutPacket.steps[0]!.contextPreflight = {
      status: "degraded",
      reason: "navigation-alias-refused",
      cause: {
        code: "selected-alias",
        message: "Focused context does not follow a selected alias: docs/latest.md.",
      },
    };
    const identity = withoutPacket.steps[0]!.inference!.attempts[0]!.identity!;
    delete identity.contextPacketDigest;
    delete identity.consultedNodeIds;
    rehashTurnEvidence(withoutPacket);
    expect(parseScorecardRunRecord(withoutPacket)).toEqual(withoutPacket);

    // Without its cause the step says nothing about why it had no packet.
    const silent = structuredClone(withoutPacket);
    delete silent.steps[0]!.contextPreflight!.cause;
    silent.steps[0]!.contextPreflight!.reason = "navigation-coverage-incomplete";
    expect(() => parseScorecardRunRecord(silent)).toThrowError(
      new ScorecardRecordError("invalid-scorecard-run-record"),
    );
  });

  it("accepts SHA-256 repository revisions throughout inference identity", () => {
    const record = succeededRecord();
    const revision = "9".repeat(64);
    record.repository.revision = revision;
    record.steps[0]!.inference!.attempts[0]!.identity!.repositoryRevision = revision;
    rehashTurnEvidence(record);

    expect(parseScorecardRunRecord(record).repository.revision).toBe(revision);
  });

  it("accepts Pi-shaped bounded tool-call stops with supplemental governance-stop", async () => {
    const record = succeededRecord();
    const step = record.steps[0]!;
    const attempt = step.inference!.attempts[0]!;
    const policy = {
      budget: {
        configuredContextWindow: 128_000,
        effectiveContextWindow: 128_000,
        configuredMaxInputTokens: 128_000,
        effectiveMaxInputTokens: 128_000,
        configuredMaxOutputTokens: 16_384,
        effectiveMaxOutputTokens: 16_384,
        reservedTokens: 128,
        requiredMinimumOutputTokens: 16,
      },
      maxProviderTurns: 12,
      maxToolCalls: 12,
      maxCompactions: 8,
      minRecentToolTurns: 1,
    };
    const first = governProviderTurn({
      context: { messages: [{ role: "user", content: "bounded" }] },
      policy,
      state: { providerTurns: 0, toolCalls: 0, toolResults: 0, compactions: 0 },
      evidenceIdentity: attempt.identity!,
      pinnedMessageCount: 1,
    });
    const guard = createBoundedBeforeToolCall(undefined, policy.maxToolCalls);
    const context = {} as Parameters<typeof guard>[0];
    for (let index = 0; index < 13; index += 1) await guard(context);
    const executedCalls = policy.maxToolCalls;
    const tools = {
      totalCalls: executedCalls,
      failedCalls: 0,
      byTool: [{ name: "read", calls: executedCalls, failures: 0 }],
      failureCategories: summarizeToolFailureCategories(0, [], guard.governanceStops()),
    };
    const stopped = governProviderTurn({
      context: { messages: [{ role: "user", content: "bounded" }] },
      policy,
      state: {
        ...first.nextState,
        toolCalls: executedCalls + guard.governanceStops(),
        toolResults: executedCalls,
      },
      evidenceIdentity: attempt.identity!,
      pinnedMessageCount: 1,
    });

    record.status = "failed";
    record.tools = structuredClone(tools);
    step.status = "failed";
    step.error = "Model request failed [context-exhausted; retryable=false].";
    delete step.summary;
    step.tools = structuredClone(tools);
    attempt.outcome = "context-exhausted";
    attempt.retryable = false;
    attempt.retryScheduled = false;
    attempt.tools = structuredClone(tools);
    attempt.turns = [first.evidence, stopped.evidence];

    expect(guard.governanceStops()).toBe(1);
    expect(stopped.evidence).toMatchObject({
      decision: "stop",
      reason: "tool-call-limit",
      toolCalls: 13,
      toolResults: 12,
    });
    expect(parseScorecardRunRecord(record)).toEqual(record);

    // A compaction the governor refused to authorize stops with the budget
    // still available, so the record decoder admits it there and rejects it at
    // the compaction limit, which is what `compaction-limit` means.
    const ineffective = structuredClone(record);
    const ineffectiveTurn = ineffective.steps[0]!.inference!.attempts[0]!.turns![1]!;
    ineffectiveTurn.reason = "compaction-ineffective";
    // Over the input ceiling, which is what makes the stop admissible at all.
    ineffectiveTurn.estimatedInputTokens = ineffectiveTurn.effectiveMaxInputTokens!;
    ineffectiveTurn.availableOutputTokens = Math.max(
      0,
      ineffectiveTurn.effectiveContextWindow -
        ineffectiveTurn.estimatedInputTokens -
        ineffectiveTurn.reservedTokens,
    );
    // The stop is the budget, not the tool ceiling, so there is no supplemental
    // governance-stop to account for and the final turn matches the calls made.
    ineffectiveTurn.toolCalls = 12;
    for (const summary of [
      ineffective.tools,
      ineffective.steps[0]!.tools,
      ineffective.steps[0]!.inference!.attempts[0]!.tools,
    ]) {
      summary!.failureCategories = [];
    }
    expect(parseScorecardRunRecord(ineffective)).toEqual(ineffective);

    // An exhausted output authority is admissible only with less than the floor
    // remaining, must name its authority, and rules out the budget reasons the
    // governor checks after it.
    const exhaustedAuthority = {
      maxOutputTokens: 128_000,
      cumulativeOutputTokens: 127_500,
      floorOutputTokens: 1_040,
    };
    const authorityStop = structuredClone(ineffective);
    const authorityTurn = authorityStop.steps[0]!.inference!.attempts[0]!.turns![1]!;
    authorityTurn.reason = "output-authority-exhausted";
    authorityTurn.outputAuthority = exhaustedAuthority;
    expect(parseScorecardRunRecord(authorityStop)).toEqual(authorityStop);
    const spare = structuredClone(authorityStop);
    // 2,000 remaining is under the per-turn limit but still a floor's worth.
    spare.steps[0]!.inference!.attempts[0]!.turns![1]!.outputAuthority!.cumulativeOutputTokens =
      126_000;
    expect(() => parseScorecardRunRecord(spare)).toThrowError(ScorecardRecordError);
    const unbacked = structuredClone(authorityStop);
    delete unbacked.steps[0]!.inference!.attempts[0]!.turns![1]!.outputAuthority;
    expect(() => parseScorecardRunRecord(unbacked)).toThrowError(ScorecardRecordError);
    const outranked = structuredClone(ineffective);
    outranked.steps[0]!.inference!.attempts[0]!.turns![1]!.outputAuthority = exhaustedAuthority;
    expect(() => parseScorecardRunRecord(outranked)).toThrowError(ScorecardRecordError);

    const pastTheLimit = structuredClone(ineffective);
    pastTheLimit.steps[0]!.inference!.attempts[0]!.turns![1]!.compactions = 8;
    expect(() => parseScorecardRunRecord(pastTheLimit)).toThrow();
  });

  it("decodes governance-stop as a supplemental partition of failedCalls", () => {
    const record = succeededRecord();
    const tools = {
      totalCalls: 3,
      failedCalls: 1,
      byTool: [{ name: "read", calls: 3, failures: 1 }],
      failureCategories: [
        { category: "denied-path" as const, count: 1 },
        { category: "governance-stop" as const, count: 2 },
      ],
    };
    record.tools = structuredClone(tools);
    const step = record.steps[0]!;
    step.tools = structuredClone(tools);
    const attempt = step.inference!.attempts[0]!;
    attempt.tools = structuredClone(tools);
    attempt.turns![0]!.toolCalls = 5;
    attempt.turns![0]!.toolResults = 3;

    // Publication decode uses decodeTools; preflight wraps the same fail-closed path.
    expect(decodeTools(tools)).toEqual(tools);
    expect(parseScorecardRunRecord(record)).toEqual(record);

    const stuffed = structuredClone(record);
    stuffed.tools = {
      ...tools,
      failedCalls: 3,
      byTool: [{ name: "read", calls: 3, failures: 3 }],
    };
    stuffed.steps[0]!.tools = structuredClone(stuffed.tools);
    stuffed.steps[0]!.inference!.attempts[0]!.tools = structuredClone(stuffed.tools);
    expect(() => parseScorecardRunRecord(stuffed)).toThrowError(ScorecardRecordError);

    const mismatched = structuredClone(record);
    mismatched.tools.failureCategories = [
      { category: "denied-path", count: 2 },
      { category: "governance-stop", count: 1 },
    ];
    mismatched.steps[0]!.tools!.failureCategories = structuredClone(
      mismatched.tools.failureCategories,
    );
    mismatched.steps[0]!.inference!.attempts[0]!.tools!.failureCategories = structuredClone(
      mismatched.tools.failureCategories,
    );
    let caught: unknown;
    try {
      parseScorecardRunRecord(mismatched);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ScorecardRecordError);
    expect(String(caught)).toBe("ScorecardRecordError: Scorecard run record rejected.");
    expect(String(caught)).not.toContain("/private");
    expect(String(caught)).not.toContain("denied-path");
  });

  it("counts pre-execution rejections separately from executed tools in a retained turn", () => {
    const record = succeededRecord();
    const tools: ToolActivitySummary = {
      totalCalls: 0,
      failedCalls: 0,
      byTool: [],
      preExecutionRejections: {
        schemaVersion: 1,
        kind: "tool-pre-execution-rejections",
        count: 1,
      },
    };
    record.tools = structuredClone(tools);
    const step = record.steps[0]!;
    step.tools = structuredClone(tools);
    const attempt = step.inference!.attempts[0]!;
    attempt.tools = structuredClone(tools);
    attempt.turns![0]!.toolCalls = 1;
    attempt.turns![0]!.toolResults = 0;

    expect(decodeTools(tools)).toEqual(tools);
    expect(parseScorecardRunRecord(record)).toEqual(record);

    const fabricated = structuredClone(record);
    delete fabricated.steps[0]!.inference!.attempts[0]!.tools.preExecutionRejections;
    expect(() => parseScorecardRunRecord(fabricated)).toThrowError(ScorecardRecordError);
    const doubleCounted = structuredClone(record);
    doubleCounted.steps[0]!.inference!.attempts[0]!.tools.preExecutionRejections = {
      schemaVersion: 1,
      kind: "tool-pre-execution-rejections",
      count: 2,
    };
    expect(() => parseScorecardRunRecord(doubleCounted)).toThrowError(ScorecardRecordError);
  });

  it("decodes a whole run record whose step and attempt tools carry presented", () => {
    // The producer and the decoder guard are tested separately; this drives the
    // `presented`-bearing shape the runner produces through the real parser, so
    // a change that made every such record undecodable fails.
    const record = succeededRecord();
    const offered = ["find", "grep", "ls", "read"];
    for (const step of record.steps) {
      if (step.tools) step.tools.presented = [...offered];
      for (const attempt of step.inference?.attempts ?? []) {
        if (attempt.tools) attempt.tools.presented = [...offered];
      }
    }
    // Decodes, and the field survives the round trip rather than being dropped.
    const parsed = parseScorecardRunRecord(record);
    expect(parsed.steps[0]?.tools?.presented).toEqual(offered);

    // The non-empty-`failureCategories` variant belongs to the delivery decoder,
    // whose normalization branches on that field; see
    // delivery-run-record.test.ts.

    // Negative control: excluding `presented` must not excuse a genuine
    // step-vs-attempt-sum disagreement. The object stays internally consistent
    // (byTool and totalCalls move together); bumping only totalCalls would fail
    // decodeTools' own invariant before reaching the comparison under test.
    const mismatched = succeededRecord();
    const firstStep = mismatched.steps[0]!;
    if (firstStep.tools) {
      firstStep.tools.presented = [...offered];
      firstStep.tools.totalCalls += 1;
      firstStep.tools.byTool = [{ name: "read", calls: 1, failures: 0 }];
    }
    expect(() => parseScorecardRunRecord(mismatched)).toThrowError(ScorecardRecordError);
  });

  it("decodes the presented tool set and rejects one that contradicts recorded calls", () => {
    // `presented` records what the model was actually offered, which is what
    // separates "declined to call write" from "write was never on the wire".
    const base = {
      totalCalls: 3,
      failedCalls: 0,
      byTool: [{ name: "read", calls: 3, failures: 0 }],
    };

    // Absent field still decodes, as in every record written before it existed.
    expect(decodeTools(structuredClone(base))).toEqual(base);

    // The live shape being locked in: write offered, never called.
    const offeredWriteNeverCalled = {
      ...base,
      presented: ["edit", "find", "grep", "ls", "read", "write"],
    };
    expect(decodeTools(structuredClone(offeredWriteNeverCalled))).toEqual(offeredWriteNeverCalled);

    // A tool that recorded calls but was never presented is incoherent: the
    // model cannot call what it was not offered, so the record is lying.
    expect(() => decodeTools({ ...base, presented: ["edit", "write"] })).toThrowError(
      ScorecardRecordError,
    );

    // Written sorted, so an unsorted list did not come from the harness.
    expect(() => decodeTools({ ...base, presented: ["read", "edit"] })).toThrowError(
      ScorecardRecordError,
    );

    // Duplicates would let a forged list pad itself past a membership check.
    expect(() => decodeTools({ ...base, presented: ["read", "read"] })).toThrowError(
      ScorecardRecordError,
    );

    // An empty presented set contradicts three recorded read calls.
    expect(() => decodeTools({ ...base, presented: [] })).toThrowError(ScorecardRecordError);
  });

  it.each([
    [
      "unknown top-level key",
      (record: RunRecord) => {
        (record as unknown as Record<string, unknown>).prompt = "PRIVATE_SENTINEL";
      },
    ],
    [
      "unknown nested key",
      (record: RunRecord) => {
        (
          record.steps[0]!.inference!.attempts[0]!.identity as unknown as Record<string, unknown>
        ).path = "/private/sentinel";
      },
    ],
    [
      "unsafe integer",
      (record: RunRecord) => {
        record.usage.total = Number.MAX_SAFE_INTEGER + 1;
      },
    ],
    [
      "invalid timestamp",
      (record: RunRecord) => {
        record.completedAt = "2026-99-99T00:00:00.000Z";
      },
    ],
    [
      "model profile digest mismatch",
      (record: RunRecord) => {
        record.models[0]!.profile!.sha256 = "0".repeat(64);
      },
    ],
    [
      "evidence digest mismatch",
      (record: RunRecord) => {
        record.steps[0]!.inference!.attempts[0]!.turns![0]!.evidenceDigest = "0".repeat(64);
      },
    ],
    [
      "repository evidence mismatch",
      (record: RunRecord) => {
        record.steps[0]!.inference!.attempts[0]!.identity!.repositoryRevision = "9".repeat(40);
        rehashTurnEvidence(record);
      },
    ],
    [
      "context packet evidence mismatch",
      (record: RunRecord) => {
        record.steps[0]!.inference!.attempts[0]!.identity!.contextPacketDigest = "8".repeat(64);
        rehashTurnEvidence(record);
      },
    ],
    [
      "request policy mismatch",
      (record: RunRecord) => {
        record.steps[0]!.inference!.attempts[0]!.turns![0]!.reservedTokens += 1;
      },
    ],
    [
      "missing v2 budget discriminator",
      (record: RunRecord) => {
        delete record.steps[0]!.inference!.attempts[0]!.turns![0]!.contextBudgetSchemaVersion;
      },
    ],
    [
      "stripped v2 input budget",
      (record: RunRecord) => {
        const turn = record.steps[0]!.inference!.attempts[0]!.turns![0]!;
        delete turn.contextBudgetSchemaVersion;
        delete turn.configuredMaxInputTokens;
        delete turn.effectiveMaxInputTokens;
        delete turn.availableInputTokens;
      },
    ],
    [
      "changed v2 budget discriminator",
      (record: RunRecord) => {
        const turn = record.steps[0]!.inference!.attempts[0]!.turns![0]!;
        (turn as unknown as Record<string, unknown>).contextBudgetSchemaVersion = 1;
      },
    ],
    [
      "duplicate lock-policy tool",
      (record: RunRecord) => {
        record.skills[0]!.toolPolicy!.granted.push("read", "read");
        record.steps[0]!.skillEvidence!.toolPolicy!.granted.push("read", "read");
      },
    ],
    [
      "negative fractional preflight latency",
      (record: RunRecord) => {
        record.steps[0]!.contextPreflight!.measurements!.latencyMs = -0.25;
      },
    ],
    [
      "nonsequential attempt",
      (record: RunRecord) => {
        record.steps[0]!.inference!.attempts[0]!.attempt = 2;
      },
    ],
    [
      "forged retry",
      (record: RunRecord) => {
        record.steps[0]!.inference!.attempts[0]!.retryScheduled = true;
      },
    ],
    [
      "wrong readiness step",
      (record: RunRecord) => {
        record.steps[0]!.id = "readiness";
      },
    ],
    [
      "unsafe security finding path",
      (record: RunRecord) => {
        record.securityScan!.status = "blocked";
        record.securityScan!.findings = [
          { path: "/private/sentinel", ruleId: "credential-secret" },
        ];
      },
    ],
  ])("rejects %s with a content-free error", (_name, mutate) => {
    const record = succeededRecord();
    mutate(record);
    let caught: unknown;
    try {
      parseScorecardRunRecord(record);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ScorecardRecordError);
    expect(String(caught)).toBe("ScorecardRecordError: Scorecard run record rejected.");
    expect(String(caught)).not.toContain("PRIVATE_SENTINEL");
    expect(String(caught)).not.toContain("/private/sentinel");
  });

  it("rejects a malformed local-failure security disposition", () => {
    const record = localSecurityFailure();
    record.securityScanEffectiveDisposition = { status: "passed" };

    expect(() => parseScorecardRunRecord(record)).toThrowError(ScorecardRecordError);
  });

  it("decodes a valid legacy strict-scanner workflow outcome", () => {
    const record = succeededRecord();
    const evidence = workflowOutcomeStepEvidence(record, "assess-readiness");
    record.workflowOutcome = createWorkflowOutcome(
      {
        disposition: "not-ready",
        findings: [
          {
            id: "finding:legacy-scorecard",
            kind: "product-gap",
            severity: "blocking",
            code: "legacy-scorecard-gap",
            evidenceIds: [evidence.id],
          },
        ],
        evidence: [evidence],
        limitations: [],
        openDecisions: [],
        producedArtifacts: [],
      },
      record,
      SECURITY_SCAN_POLICY,
    );

    const decoded = parseScorecardRunRecord(record);
    expect(decoded.workflowOutcome?.disposition).toBe("not-ready");
  });
});

function succeededRecord(): RunRecord {
  const model = modelEvidence();
  const identity = {
    repositoryRevision: REVISION,
    contextPacketDigest: PACKET,
    consultedNodeIds: ["node-a"],
  };
  const startedAt = "2026-08-04T00:00:00.000Z";
  const completedAt = "2026-08-04T00:00:01.000Z";
  const stepStartedAt = "2026-08-04T00:00:00.100Z";
  const stepCompletedAt = "2026-08-04T00:00:00.900Z";
  const skill = {
    id: "doc-context-analyzer",
    contentSha256: "c".repeat(64),
    bundleSha256: "d".repeat(64),
    version: "1.0.0",
    license: "Apache-2.0",
    source: {
      repository: "skills-repository",
      revision: REVISION,
      path: "skills/doc-context-analyzer/SKILL.md",
    },
    toolPolicy: { declared: [], granted: [], withheld: [] },
  };
  const attemptUsage = usage();
  const tools = zeroTools();
  return {
    schemaVersion: 2,
    id: "run-1",
    workflow: "readiness",
    repository: { sourcePath: "/private/source", requestedRevision: "HEAD", revision: REVISION },
    workspace: { strategy: "tracked-export", disposable: true },
    instruction: "Assess readiness.",
    status: "succeeded",
    createdAt: startedAt,
    startedAt,
    completedAt,
    durationMs: 1_000,
    models: [structuredClone(model)],
    skills: [structuredClone(skill)],
    usage: structuredClone(attemptUsage),
    tools: structuredClone(tools),
    securityScan: {
      ruleSet: "docsfab-local-v2",
      status: "passed",
      scannedFiles: 5,
      binaryFiles: 0,
      findings: [],
    },
    securityScanEffectiveDisposition: { status: "passed" },
    steps: [
      {
        id: "assess-readiness",
        title: "Assess repository readiness",
        kind: "inference",
        skill: "doc-context-analyzer",
        mode: "read-only",
        status: "succeeded",
        startedAt: stepStartedAt,
        completedAt: stepCompletedAt,
        durationMs: 800,
        model: structuredClone(model),
        skillEvidence: structuredClone(skill),
        usage: structuredClone(attemptUsage),
        tools: structuredClone(tools),
        contextPreflight: {
          status: "ready",
          packetDigest: PACKET,
          consultedNodeIds: ["node-a"],
          ontologyVersion: "ontology-v1",
          effectiveDecisionIds: [],
          measurements: {
            byteLength: 1_024,
            estimatedTokens: 256,
            latencyMs: 10,
            nodeCount: 1,
            edgeCount: 0,
            pathCount: 1,
          },
          cache: {
            disposition: "miss",
            keyDigest: "1".repeat(64),
            rebuildAttempted: true,
          },
        },
        summary: "Repository readiness assessed.",
        inference: {
          configuredMaxRetries: 0,
          effectiveMaxRetries: 0,
          baseDelayMs: 100,
          maxDelayMs: 1_000,
          retryableCategories: ["timeout"],
          replay: "read-only",
          attempts: [
            {
              attempt: 1,
              outcome: "succeeded",
              retryable: false,
              retryScheduled: false,
              durationMs: 700,
              model: structuredClone(model),
              usage: structuredClone(attemptUsage),
              tools: structuredClone(tools),
              identity,
              turns: [
                {
                  contextBudgetSchemaVersion: 2,
                  turn: 1,
                  toolCalls: 0,
                  toolResults: 0,
                  maxProviderTurns: 12,
                  maxToolCalls: 12,
                  compactions: 0,
                  maxCompactions: 8,
                  configuredContextWindow: 128_000,
                  effectiveContextWindow: 128_000,
                  configuredMaxInputTokens: 128_000,
                  effectiveMaxInputTokens: 128_000,
                  configuredMaxOutputTokens: 16_384,
                  effectiveMaxOutputTokens: 16_384,
                  reservedTokens: 128,
                  estimatedInputTokens: 1_000,
                  availableInputTokens: 127_872,
                  availableOutputTokens: 126_872,
                  requiredMinimumOutputTokens: 16,
                  outputTokens: 50,
                  decision: "proceed",
                  requestDigest: "e".repeat(64),
                  evidenceDigest: digestIdentity(identity),
                },
              ],
            },
          ],
        },
      },
    ],
  };
}

function localSecurityFailure(): RunRecord {
  const record = succeededRecord();
  record.status = "failed";
  delete record.startedAt;
  record.models = [];
  record.skills = [];
  record.usage = zeroUsage();
  record.tools = zeroTools();
  record.securityScan = {
    ruleSet: "docsfab-local-v2",
    status: "blocked",
    scannedFiles: 5,
    binaryFiles: 0,
    findings: [{ path: "fixture.env", ruleId: "credential-assigned-secret" }],
  };
  record.securityScanEffectiveDisposition = { status: "blocked" };
  const step = record.steps[0]!;
  step.status = "pending";
  step.contextPreflight = { status: "unnecessary", reason: "security-scan-not-authorized" };
  delete step.startedAt;
  delete step.completedAt;
  delete step.durationMs;
  delete step.model;
  delete step.skillEvidence;
  delete step.usage;
  delete step.tools;
  delete step.inference;
  delete step.summary;
  return record;
}

function modelEvidence(): ModelEvidence & { profile: ModelProfileEvidence } {
  const provider = "policy-provider";
  const model = "policy/model";
  const profileWithoutDigest: Omit<ModelProfileEvidence, "sha256"> = {
    schemaVersion: 2,
    status: "current",
    configuredContextWindow: 128_000,
    effectiveContextWindow: 128_000,
    configuredMaxInputTokens: 128_000,
    effectiveMaxInputTokens: 128_000,
    configuredMaxOutputTokens: 16_384,
    effectiveMaxOutputTokens: 16_384,
    effectiveLimitReason: "none",
    apiFormat: "chat_completions",
    reasoning: false,
    input: ["text"],
    compatibility: {
      supportsDeveloperRole: true,
      supportsReasoningEffort: false,
      apiFormats: ["chat_completions"],
    },
    requestPolicy: { minimumOutputTokens: 16, reservedContextTokens: 128 },
    costPerMillionTokens: { input: null, output: null, cacheRead: null, cacheWrite: null },
    pricing: "unknown",
    approvedSourceSha256: "f".repeat(64),
    effectiveDate: "2026-08-01",
    reviewAfter: "2026-09-01",
  };
  return {
    provider,
    model,
    profile: {
      ...profileWithoutDigest,
      sha256: modelProfileEvidenceSha256({ provider, model, profile: profileWithoutDigest }),
    },
  };
}

function usage() {
  return { input: 100, output: 50, cacheRead: 25, cacheWrite: 0, total: 175, turns: 1 };
}

function zeroUsage() {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, turns: 0 };
}

function zeroTools() {
  return { totalCalls: 0, failedCalls: 0, byTool: [] };
}

function jsonEvidenceDigest(value: unknown): string {
  return createHash("sha256")
    .update(canonicalizeJsonEvidence(value as JsonEvidenceValue))
    .digest("hex");
}

function terminalLeaseEvidence(binding: {
  inferenceAttempt: number;
  retriesConsumed: number;
  repositoryRevision: string;
  providerTurnLedgerSha256: string;
  usageSha256: string;
  toolsSha256: string;
}) {
  const context = {
    status: "ready" as const,
    availableInputTokens: 128_000,
    requiredInputTokens: 1,
    authoritySha256: "9".repeat(64),
  };
  const subject = new PiExecutionLeaseController({
    policy: createExecutionLeaseCoordinatorPolicy({
      maxCompactions: 4,
      providerLimits: { maxProviderTurns: 64, maxCompactions: 4 },
      cumulative: {
        maxInputTokens: 10_000,
        maxOutputTokens: 10_000,
        maxElapsedMs: 10_000,
      },
    }),
    identity: {
      inferenceAttempt: binding.inferenceAttempt,
      retriesConsumed: binding.retriesConsumed,
      authorizationSha256: "1".repeat(64),
      repositoryRevision: binding.repositoryRevision,
      contextPacketSha256: "2".repeat(64),
      evidenceSha256: "3".repeat(64),
      toolPolicySha256: "4".repeat(64),
      contextAuthoritySha256: context.authoritySha256,
    },
    pricing: {
      status: "known",
      inputMicrousdPerMillionTokens: 100,
      outputMicrousdPerMillionTokens: 200,
      authoritySha256: "5".repeat(64),
    },
    context,
  });
  subject.settleOrdinaryProviderTurn({
    inputTokens: 100,
    outputTokens: 50,
    elapsedMs: 1,
    compactions: 0,
    context,
  });
  subject.complete();
  return subject.evidence(binding);
}

function rehashLeaseEvidence(lease: ReturnType<typeof terminalLeaseEvidence>): void {
  const { evidenceSha256: _discarded, ...body } = lease;
  lease.evidenceSha256 = jsonEvidenceDigest(body);
}

function digestIdentity(identity: {
  repositoryRevision: string;
  contextPacketDigest: string;
  consultedNodeIds: string[];
  technicalVerificationSha256?: string;
}): string {
  return createHash("sha256").update(canonical(identity)).digest("hex");
}

function rehashTurnEvidence(record: RunRecord): void {
  const attempt = record.steps[0]!.inference!.attempts[0]!;
  attempt.turns![0]!.evidenceDigest = digestIdentity(
    attempt.identity as {
      repositoryRevision: string;
      contextPacketDigest: string;
      consultedNodeIds: string[];
      technicalVerificationSha256?: string;
    },
  );
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
    .join(",")}}`;
}

function reseal(value: Record<string, unknown>, digestKey: string): void {
  const body = { ...value };
  delete body[digestKey];
  value[digestKey] = canonicalDigest(body);
}
