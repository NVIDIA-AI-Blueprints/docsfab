// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Writer/reader parity for top-level run-record fields.
 *
 * A field the runner writes and a closed reader key list refuses turns every
 * such record into a contract gap, so results are not applied or published.
 * The field list comes from `RUN_RECORD_FIELDS`, which the compiler holds
 * exhaustive against `RunRecord`; each reader must admit every field or name
 * the read-only workflow that is the field's only producer.
 */
import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { decodeSavedRunRecord } from "../src/cli/commands/runs.js";
import { limitDefinition } from "../src/config/limits.js";
import {
  decodeSuccessfulCheckoutRunRecord,
  decodeSuccessfulPublicationRunRecord,
  PUBLICATION_RUN_RECORD_KEYS,
  PublicationRunRecordDecodeError,
} from "../src/delivery/run-record.js";
import { boundLiveWorkflowContext } from "../src/live-agent/host.js";
import type { JsonEvidenceValue } from "../src/json-evidence.js";
import type { RunRecord } from "../src/records/contracts.js";
import {
  decodeRunRecordInstructionContext,
  INSTRUCTION_CONTEXT_MAX_CHARS_LIMIT,
  RunRecordInstructionContextError,
} from "../src/records/instruction-context.js";
import { attachRunFailureClassifications } from "../src/operator/failure-classification.js";
import { projectRunIndexRows, RUN_INDEX_LIMITS } from "../src/records/run-index.js";
import {
  RUN_RECORD_FAILED_RUN_FIELDS,
  RUN_RECORD_FIRST_PASS_ONLY_FIELDS,
  RUN_RECORD_FIELD_PRODUCERS,
  RUN_RECORD_FIELDS,
} from "../src/records/run-record-fields.js";
import { type RunRecordReader } from "../src/records/run-record-readers.js";
import { DOC_IMPROVEMENT_RUN_READER } from "../src/doc-improvement.js";
import { SOURCE_AWARE_WORKFLOWS } from "../src/cli/run-arguments.js";
import { decodeRunChangeSources } from "../src/records/change-sources.js";
import { decodeRetainedEvidenceBindings } from "../src/records/retained-evidence-bindings.js";
import { CORPUS_LIVE_RUN_READER } from "../src/quality-evaluation/corpus-live.js";
import { READINESS_RUN_READER, RELEASE_READINESS_RUN_READER } from "../src/scorecard-record.js";
import { getWorkflow } from "../src/workflow-registry/catalog.js";
import { canonicalDigest } from "../src/contract-kit/index.js";
import { createFirstPassReplay } from "../src/records/first-pass-replay.js";

const REVISION = "a".repeat(40);
const RUN_ID = "run-1233-parity";

/**
 * Fields the publication gate refuses on purpose: each is written only by
 * read-only workflows (the single-source producer table), and the gate admits
 * succeeded write workflows only. The test checks that.
 */
const PUBLICATION_READ_ONLY_FIELDS = Object.fromEntries(
  Object.entries(RUN_RECORD_FIELD_PRODUCERS).filter(([, producers]) =>
    producers.every(
      (workflow) => !getWorkflow(workflow).steps.some((step) => step.mode === "write"),
    ),
  ),
);

/**
 * Fields the writer emits only on a failed run. The gate admits succeeded
 * runs only, so it refuses these as it refuses any unknown key; the test
 * checks the writer does not leave one on a record that did not fail.
 */
const PUBLICATION_FAILED_RUN_FIELDS = RUN_RECORD_FAILED_RUN_FIELDS;

/** Every strict reader that derives its key list from a field policy. */
const STRICT_READERS: readonly RunRecordReader[] = [
  RELEASE_READINESS_RUN_READER,
  READINESS_RUN_READER,
  DOC_IMPROVEMENT_RUN_READER,
  CORPUS_LIVE_RUN_READER,
];

/** The shipped publication-gate record shape: a succeeded site-bootstrap write. */
function publicationRecord(extra: Record<string, unknown> = {}): Record<string, unknown> {
  const patch = Buffer.from("diff --git a/README.md b/README.md\n", "utf8");
  const usage = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    total: 0,
    turns: 0,
  };
  const tools = { totalCalls: 0, failedCalls: 0, byTool: [] };
  const reference = {
    kind: "ia-plan",
    schemaVersion: 1,
    digest: "a".repeat(64),
    repositoryRevision: REVISION,
    repositoryContentDigest: "b".repeat(64),
  };
  const artifacts = [{ role: "input", stepId: "apply-site-bootstrap", reference }];
  return {
    schemaVersion: 2,
    id: RUN_ID,
    workflow: "site-bootstrap",
    repository: {
      sourcePath: "/fixtures/parity",
      requestedRevision: "HEAD",
      revision: REVISION,
    },
    workspace: { strategy: "tracked-export", disposable: true },
    instruction: "Bootstrap the documentation site.",
    task: { kind: "site-bootstrap", plan: reference },
    status: "succeeded",
    createdAt: "2026-09-23T00:00:00.000Z",
    startedAt: "2026-09-23T00:00:01.000Z",
    completedAt: "2026-09-23T00:00:02.000Z",
    durationMs: 1000,
    models: [],
    skills: [],
    usage,
    tools,
    securityScan: {
      ruleSet: "credential-rules-v1",
      status: "passed",
      scannedFiles: 1,
      binaryFiles: 0,
      findings: [],
    },
    securityScanEffectiveDisposition: { status: "passed" },
    artifacts,
    steps: [
      {
        id: "apply-site-bootstrap",
        title: "Apply approved site bootstrap",
        kind: "host-operation",
        operation: "site-bootstrap",
        skill: "template-scaffold-site",
        mode: "write",
        status: "succeeded",
        startedAt: "2026-09-23T00:00:01.000Z",
        completedAt: "2026-09-23T00:00:02.000Z",
        durationMs: 1000,
        usage,
        tools,
        contextPreflight: {
          status: "ready",
          packetDigest: "c".repeat(64),
          consultedNodeIds: ["node-a"],
          ontologyVersion: "ontology-v1",
          effectiveDecisionIds: [],
          measurements: {
            byteLength: 1,
            estimatedTokens: 1,
            latencyMs: 0,
            nodeCount: 1,
            edgeCount: 0,
            pathCount: 1,
          },
          cache: {
            disposition: "miss",
            keyDigest: "d".repeat(64),
            rebuildAttempted: true,
          },
        },
        artifacts,
        summary: "Applied approved site plan.",
      },
    ],
    changes: {
      files: [{ path: "README.md", status: "modified" }],
      patch: {
        sha256: createHash("sha256").update(patch).digest("hex"),
        byteLength: patch.byteLength,
        lineCount: 1,
        artifactPath: "/fixtures/parity/run-1233.patch",
        format: "git-diff",
      },
    },
    ...extra,
  };
}

/** The publication record with every writer field present. */
function everyWriterField(): Record<string, unknown> {
  const record = publicationRecord({
    instructionContext: "MR !1076 evidence.",
  });
  for (const field of RUN_RECORD_FIELDS) {
    if (field === "answerRecordDiscovery") continue;
    if (RUN_RECORD_FIRST_PASS_ONLY_FIELDS.includes(field)) continue;
    if (field === "checkoutPersistence") {
      record.checkoutPersistence = {
        schemaVersion: 1,
        kind: "checkout-persistence",
        outcome: "applied",
      };
      continue;
    }
    if (!(field in record)) record[field] = { writerField: field };
  }
  return record;
}

function discoveryWriterRecord(): Record<string, unknown> {
  const record = everyWriterField();
  record.workflow = "review-documentation";
  delete record.task;
  delete record.compositionExecution;
  delete record.compositionExecutionAggregate;
  record.answerRecordDiscovery = answerRecordDiscoveryFixture();
  return record;
}

function answerRecordDiscoveryFixture(): Record<string, unknown> {
  const repositorySourcePath = "/fixtures/parity";
  const hash = "c".repeat(64);
  const limits = {
    contextWindow: 100,
    maxInputTokens: 80,
    maxOutputTokens: 20,
    maxProviderTurns: 2,
    timeoutMs: 1_000,
    maxResponseBytes: 4_096,
  };
  const body = {
    schemaVersion: 1,
    kind: "docsfab-answer-record-discovery-execution/v1",
    qualification: "unqualified",
    statusLabel: "Experimental discovery — not qualified",
    answerRecordRefusalPolicy: "non-exhausting-per-key",
    runBinding: {
      runId: RUN_ID,
      workflow: "review-documentation",
      repositoryRevision: REVISION,
      repositoryIdentitySha256: createHash("sha256").update(repositorySourcePath).digest("hex"),
    },
    composition: {
      id: "composition-fixture",
      installedManifestSha256: hash,
      compositionSha256: hash,
      candidateSha256: hash,
      workflow: { id: "review-documentation", sourceSha256: hash },
      model: { requestedId: "model-fixture", resolvedId: "model-fixture" },
      deployment: {
        routeId: "route-fixture",
        transport: "openai-responses",
        identitySha256: hash,
      },
      requestPolicySha256: null,
    },
    bounds: {
      installedComposition: limits,
      candidateProposed: limits,
      packageCeiling: limits,
      configuredHost: limits,
      effective: {
        providerExecution: {
          maxProviderTurns: limits.maxProviderTurns,
          timeoutMs: limits.timeoutMs,
          maxResponseBytes: limits.maxResponseBytes,
        },
        model: {
          contextWindow: limits.contextWindow,
          maxInputTokens: limits.maxInputTokens,
          maxOutputTokens: limits.maxOutputTokens,
        },
      },
      qualityValidatorTimeoutMs: 1_000,
      answerNow: {
        elapsedShareBasisPoints: 1,
        decodeTokensPerSecond: 1,
        turnLatencyMs: 1,
      },
      requestIntentTimeoutMs: 1_000,
      workflowDeadlineMs: null,
    },
  };
  return { ...body, evidenceSha256: canonicalDigest(body) };
}

describe("run-record writer/reader field parity (#1233)", () => {
  it("names only writer fields in the publication gate and its read-only exclusions", () => {
    const writer = new Set<string>(RUN_RECORD_FIELDS);
    expect(PUBLICATION_RUN_RECORD_KEYS.filter((key) => !writer.has(key))).toEqual([]);
    for (const [field, producers] of Object.entries(PUBLICATION_READ_ONLY_FIELDS)) {
      expect(writer.has(field), field).toBe(true);
      // A stale exclusion would hide a field the gate has since learned to admit.
      if (field === "answerRecordDiscovery") {
        // This one read-only marker is admitted through its dedicated binding
        // decoder; arbitrary read-only run facts remain excluded.
        expect(PUBLICATION_RUN_RECORD_KEYS, field).toContain(field);
      } else {
        expect(PUBLICATION_RUN_RECORD_KEYS, field).not.toContain(field);
      }
      for (const workflow of producers) {
        expect(
          getWorkflow(workflow).steps.some((step) => step.mode === "write"),
          `${field} is produced by ${workflow}`,
        ).toBe(false);
      }
    }
    for (const field of PUBLICATION_FAILED_RUN_FIELDS) {
      expect(writer.has(field), field).toBe(true);
      expect(PUBLICATION_RUN_RECORD_KEYS, field).not.toContain(field);
    }
  });

  it("never leaves a failed-run field on a record that did not fail", () => {
    const record = everyWriterField() as unknown as RunRecord;
    record.failure = { class: "unknown", layer: "workflow", code: "uncoded-error" };
    attachRunFailureClassifications(record);
    for (const field of PUBLICATION_FAILED_RUN_FIELDS) {
      expect(record, field).not.toHaveProperty(field);
    }
    expect(
      publicationCode({ failure: { class: "flake", layer: "workflow", code: "timeout" } }),
    ).toBe("invalid-shape");
  });

  it.each(
    RUN_RECORD_FIELDS.filter(
      (field) =>
        !(field in PUBLICATION_READ_ONLY_FIELDS) && !PUBLICATION_FAILED_RUN_FIELDS.includes(field),
    ),
  )("admits the writer field %s in the delivery and publish gate", (field) => {
    expect(PUBLICATION_RUN_RECORD_KEYS).toContain(field);
  });

  it("shows a saved run carrying every compatible writer field", () => {
    const value = everyWriterField() as unknown as JsonEvidenceValue;
    const decoded = decodeSavedRunRecord(value, RUN_ID);
    expect(Object.keys(decoded).sort()).toEqual(
      RUN_RECORD_FIELDS.filter(
        (field) =>
          field !== "answerRecordDiscovery" && !RUN_RECORD_FIRST_PASS_ONLY_FIELDS.includes(field),
      ).sort(),
    );
  });

  it("shows a saved review run with its mutually exclusive discovery marker", () => {
    const value = discoveryWriterRecord() as unknown as JsonEvidenceValue;
    const decoded = decodeSavedRunRecord(value, RUN_ID);
    expect(decoded.answerRecordDiscovery).toEqual(value.answerRecordDiscovery);
    expect(decoded).not.toHaveProperty("compositionExecution");
    expect(decoded).not.toHaveProperty("compositionExecutionAggregate");
  });

  it("rejects a tampered experimental discovery marker", () => {
    const value = discoveryWriterRecord();
    const marker = value.answerRecordDiscovery as Record<string, unknown>;
    marker.statusLabel = "qualified";
    expect(() => decodeSavedRunRecord(value as unknown as JsonEvidenceValue, RUN_ID)).toThrow(
      /experimental discovery evidence is invalid/u,
    );
  });

  it.each([
    ["every compatible writer field", everyWriterField],
    ["a review run with its discovery marker", discoveryWriterRecord],
  ] as const)("indexes an imported run with %s", (_name, fixture) => {
    const projection = projectRunIndexRows(fixture(), {
      origin: "import",
      snapshotId: "snapshot-1233",
      indexedAt: "2026-09-23T12:00:00.000Z",
      recordSha256: "e".repeat(64),
      fieldMaxChars: limitDefinition(RUN_INDEX_LIMITS.fieldMaxChars).value,
    });
    expect(projection).toMatchObject({ ok: true, runId: RUN_ID });
  });
});

describe("strict reader field policies (#1740)", () => {
  it.each(STRICT_READERS.map((reader) => [reader.reader, reader] as const))(
    "%s declares every writer field and derives its key list from that",
    (_name, reader) => {
      expect(Object.keys(reader.fields).sort()).toEqual([...RUN_RECORD_FIELDS].sort());
      expect([...reader.admittedKeys].sort()).toEqual(
        RUN_RECORD_FIELDS.filter(
          (field) => reader.fields[field] === "decoded" || reader.fields[field] === "admitted",
        ).sort(),
      );
      // Every composition-capable workflow's records carry these; each reader decodes them.
      expect(reader.fields.compositionExecution).toBe("decoded");
      expect(reader.fields.compositionExecutionAggregate).toBe("decoded");
    },
  );

  it.each(STRICT_READERS.map((reader) => [reader.reader, reader] as const))(
    "%s refuses a field only for a reason the writer contract supports",
    (_name, reader) => {
      for (const field of RUN_RECORD_FIELDS) {
        const disposition = reader.fields[field];
        if (disposition === "producer-not-admitted") {
          const producers = RUN_RECORD_FIELD_PRODUCERS[field];
          expect(producers, `${reader.reader}.${field} has single-source producers`).toBeDefined();
          expect(
            producers!.filter((workflow) => reader.workflows.includes(workflow)),
            `${reader.reader} admits a producer of ${field}`,
          ).toEqual([]);
        } else if (disposition === "failed-run-only") {
          expect(RUN_RECORD_FAILED_RUN_FIELDS, field).toContain(field);
          expect(reader.statuses, `${reader.reader} admits failed runs`).not.toContain("failed");
        } else {
          expect(["decoded", "admitted", "unverified"], `${reader.reader}.${field}`).toContain(
            disposition,
          );
        }
      }
    },
  );
});

describe("the retained reader evidence request's reader dispositions", () => {
  it("is decoded where update records are read and unverified where they never are", () => {
    // Update has write steps, so a single-source producer entry would make the
    // publication gate refuse the field.
    expect(RUN_RECORD_FIELD_PRODUCERS).not.toHaveProperty("readerEvidenceRequest");
    expect(PUBLICATION_RUN_RECORD_KEYS).toContain("readerEvidenceRequest");
    expect(DOC_IMPROVEMENT_RUN_READER.workflows).toContain("update-documentation");
    expect(DOC_IMPROVEMENT_RUN_READER.fields.readerEvidenceRequest).toBe("decoded");
    for (const reader of [
      CORPUS_LIVE_RUN_READER,
      READINESS_RUN_READER,
      RELEASE_READINESS_RUN_READER,
    ]) {
      expect(reader.workflows).not.toContain("update-documentation");
      expect(reader.fields.readerEvidenceRequest, reader.reader).toBe("unverified");
    }
  });
});

describe("the change-source citation's reader dispositions", () => {
  it("is decoded where create and update records are read and unverified where they never are", () => {
    // Create and update have write steps, so a single-source producer entry
    // would make the publication gate refuse the field.
    expect(RUN_RECORD_FIELD_PRODUCERS).not.toHaveProperty("changeSources");
    expect(PUBLICATION_RUN_RECORD_KEYS).toContain("changeSources");
    expect(DOC_IMPROVEMENT_RUN_READER.workflows).toContain("update-documentation");
    expect(DOC_IMPROVEMENT_RUN_READER.fields.changeSources).toBe("decoded");
    for (const reader of [
      CORPUS_LIVE_RUN_READER,
      READINESS_RUN_READER,
      RELEASE_READINESS_RUN_READER,
    ]) {
      expect(
        reader.workflows.filter((workflow) =>
          (SOURCE_AWARE_WORKFLOWS as readonly string[]).includes(workflow),
        ),
        reader.reader,
      ).toEqual([]);
      expect(reader.fields.changeSources, reader.reader).toBe("unverified");
    }
  });
});

describe("the delivery and publish gate decodes changeSources", () => {
  const citation = {
    schemaVersion: 1,
    kind: "docsfab-run-change-source",
    sourceKind: "local-range",
    provenance: "local-verified",
    repository: { kind: "local-checkout", identitySha256: "e".repeat(64) },
    objectFormat: "sha1",
    rangeSemantics: "two-dot",
    base: REVISION,
    head: "b".repeat(40),
    mergeBase: REVISION,
    diffFrom: REVISION,
    labels: [],
    fileCount: 1,
    commitCount: 1,
    changeSourceSha256: "f".repeat(64),
    observations: [
      { role: "diff", observationId: "obs-change-diff" },
      { role: "manifest", observationId: "obs-change-manifest" },
    ],
  };

  it("refuses a valid citation on a workflow that never binds a change, and a null or empty one", () => {
    // The fixture is a site-bootstrap write: only create and update bind a change.
    expect(publicationCode({})).toBeUndefined();
    expect(decodeRunChangeSources([citation], "create-documentation")).toHaveLength(1);
    for (const changeSources of [[citation], null, []]) {
      expect(publicationCode({ changeSources }), JSON.stringify(changeSources)).toBe(
        "invalid-shape",
      );
    }
  });
});

describe("the release citation's reader dispositions and publication decode", () => {
  it("is decoded and refused exactly where changeSources is", () => {
    expect(RUN_RECORD_FIELD_PRODUCERS).not.toHaveProperty("changeSourceRelease");
    expect(PUBLICATION_RUN_RECORD_KEYS).toContain("changeSourceRelease");
    expect(DOC_IMPROVEMENT_RUN_READER.fields.changeSourceRelease).toBe("decoded");
    for (const reader of [
      CORPUS_LIVE_RUN_READER,
      READINESS_RUN_READER,
      RELEASE_READINESS_RUN_READER,
    ]) {
      expect(reader.fields.changeSourceRelease, reader.reader).toBe("unverified");
    }
  });

  it("refuses a release citation, or a null one, on a workflow that never binds a change", () => {
    // The fixture is a site-bootstrap write; a page whose every unit was
    // omitted carries the citation alone.
    const citation = {
      schemaVersion: 1,
      kind: "docsfab-run-change-source-release",
      repository: { kind: "local-checkout", identitySha256: "e".repeat(64) },
      objectFormat: "sha1",
      base: REVISION,
      head: "b".repeat(40),
      releaseUnitsSha256: "f".repeat(64),
      observationId: "obs-release-units",
      units: 1,
      pageUnits: 1,
      omittedUnits: 1,
      remainingUnits: 0,
      continuation: null,
    };
    for (const changeSourceRelease of [citation, null]) {
      expect(publicationCode({ changeSourceRelease }), JSON.stringify(changeSourceRelease)).toBe(
        "invalid-shape",
      );
    }
  });
});

function publicationCode(extra: Record<string, unknown>): string | undefined {
  try {
    decodeSuccessfulPublicationRunRecord(publicationRecord(extra));
  } catch (error) {
    return error instanceof PublicationRunRecordDecodeError ? error.code : "unexpected-error";
  }
  return undefined;
}

describe("the delivery gate admits retained CLI retry context", () => {
  it("preserves a successful publication baseline with no retry context", () => {
    const record = publicationRecord();
    expect(Object.hasOwn(record, "retryContext")).toBe(false);

    const decoded = decodeSuccessfulPublicationRunRecord(record);

    expect(Object.hasOwn(decoded, "retryContext")).toBe(false);
    expect(decoded.retryContext).toBeUndefined();
  });

  it("preserves valid selection metadata without making it publication authority", () => {
    const retryContext = {
      schemaVersion: 1,
      reconstructable: false,
      instructionPresent: true,
      deliveryMode: "patch-only",
      allowWrite: true,
      writeGrantExplicit: true,
      releaseGate: false,
    };
    const decoded = decodeSuccessfulPublicationRunRecord(publicationRecord({ retryContext }));
    expect(decoded.retryContext).toEqual(retryContext);
    expect(publicationCode({ retryContext: { ...retryContext, deliveryMode: "unknown" } })).toBe(
      "invalid-shape",
    );
  });
});

describe("the delivery and publish gate admits instructionContext (#1233)", () => {
  const maxChars = limitDefinition(INSTRUCTION_CONTEXT_MAX_CHARS_LIMIT).max;

  it("decodes a record carrying the writer's context, whole or cut at its bound", () => {
    const whole = boundLiveWorkflowContext(
      "  MR !1076 diff\n\u001b[1mevidence\u001b[0m  ",
      maxChars,
    );
    const cut = boundLiveWorkflowContext("x".repeat(maxChars + 5), maxChars);
    expect(cut.omittedChars).toBe(5);
    for (const context of [whole.context, cut.context]) {
      const decoded = decodeSuccessfulPublicationRunRecord(
        publicationRecord({ instructionContext: context }),
      );
      // Carried through, not dropped after the key check.
      expect(decoded.instructionContext).toBe(context);
    }
  });

  it("refuses context the writer cannot produce, and an unknown key", () => {
    const cut = boundLiveWorkflowContext("y".repeat(maxChars + 3), maxChars).context!;
    for (const context of [
      "",
      " padded ",
      42,
      "z".repeat(maxChars + 1),
      // Marker counts that disagree with the kept text.
      cut.replace(/cut at \d+\]$/u, `cut at ${maxChars - 1}]`),
      `${"y".repeat(maxChars + 1)}${cut.slice(maxChars)}`,
    ]) {
      expect(() => decodeRunRecordInstructionContext(context)).toThrow(
        RunRecordInstructionContextError,
      );
      expect(publicationCode({ instructionContext: context })).toBe("invalid-shape");
    }
    expect(publicationCode({ instructionContextDraft: "x" })).toBe("invalid-shape");
  });
});

describe("the delivery and publish gate refuses a first-pass contradiction stop", () => {
  it("refuses a record carrying the question field, and admits the same record without it", () => {
    // Only a needs-input run that never wrote carries the field.
    expect(publicationCode({})).toBeUndefined();
    expect(
      publicationCode({
        firstPassContradiction: {
          schemaVersion: 1,
          code: "contradicted",
          contradictions: [],
          question: { question: "q", options: ["o"], recommendedDefault: "o", consequence: "c" },
        },
      }),
    ).toBe("invalid-shape");
    expect(
      publicationCode({ firstPassContradictionAdmission: { outcome: "repository-only" } }),
    ).toBe("invalid-shape");
    expect(publicationCode({ firstPassChoices: [{ selection: "side" }] })).toBe("invalid-shape");
  });

  it("refuses a valid stop-only replay capsule on an otherwise successful record", () => {
    const replay = createFirstPassReplay({
      snapshot: {},
      support: {},
      targetPaths: ["src/export.ts"],
      assessmentIdentitySha256: "a".repeat(64),
      assessmentBindingSha256: "b".repeat(64),
    });
    const record = publicationRecord({ firstPassReplay: replay });
    expect(publicationCode({})).toBeUndefined();
    expect(publicationCode({ firstPassReplay: replay })).toBe("invalid-shape");
    expect(() => decodeSuccessfulCheckoutRunRecord(record)).toThrowError(
      PublicationRunRecordDecodeError,
    );
  });
});

describe("the retained evidence bindings' reader dispositions and publication decode", () => {
  const bindings = {
    schemaVersion: 1,
    kind: "docsfab-retained-evidence-bindings",
    sources: [{ path: "src/orbit.ts", sha256: createHash("sha256").update("orbit").digest("hex") }],
  };

  it("is decoded where create and update records are read, and unverified by the readers of neither", () => {
    // Create and update have write steps, so a single-source producer entry
    // would make the publication gate refuse the field.
    expect(RUN_RECORD_FIELD_PRODUCERS).not.toHaveProperty("retainedEvidenceBindings");
    expect(PUBLICATION_RUN_RECORD_KEYS).toContain("retainedEvidenceBindings");
    expect(DOC_IMPROVEMENT_RUN_READER.fields.retainedEvidenceBindings).toBe("decoded");
    for (const reader of [
      CORPUS_LIVE_RUN_READER,
      READINESS_RUN_READER,
      RELEASE_READINESS_RUN_READER,
    ]) {
      expect(reader.fields.retainedEvidenceBindings, reader.reader).toBe("unverified");
    }
  });

  it("refuses a valid binding on a workflow that never binds sources, and a null one", () => {
    // The fixture is a site-bootstrap write: only create and update bind sources.
    for (const workflow of SOURCE_AWARE_WORKFLOWS) {
      expect(decodeRetainedEvidenceBindings(bindings, workflow)).toEqual(bindings);
    }
    for (const retainedEvidenceBindings of [bindings, null]) {
      expect(publicationCode({ retainedEvidenceBindings })).toBe("invalid-shape");
    }
  });
});
