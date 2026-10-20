// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  MERGE_RECONCILIATION_CONFLICT_CLASSIFICATIONS,
  MERGE_RECONCILIATION_PROPOSAL_KIND,
  MERGE_RECONCILIATION_SKILLS,
  createMergeReconciliationRuntimeAdapter,
  parseMergeReconciliationJob,
  parseMergeReconciliationResult,
} from "../src/runtime-adapter.mjs";

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);
const SHA_C = "c".repeat(64);
const MERGE = "d".repeat(40);
const SOURCE = "e".repeat(40);

function job(overrides = {}) {
  return {
    schemaVersion: 1,
    kind: "docsfab-merge-reconciliation-job",
    requestKey: "forge-reconcile-request-1",
    attemptId: "attempt-1",
    workId: "merge-work-1",
    deploymentId: "deployment-1",
    projectId: "project-a",
    deploymentEpoch: "epoch-1",
    contextBindingSha256: SHA_A,
    forge: {
      deploymentId: "deployment-1",
      projectId: "project-a",
      deploymentEpoch: "epoch-1",
      provider: "gitlab",
      providerHostSha256: SHA_A,
      providerProjectId: "437040",
      changeId: "652",
      aggregateId: "forge-change-1",
      sourceRevision: SOURCE,
      mergeRevision: MERGE,
      eventSha256: SHA_B,
    },
    modelParent: {
      modelId: "DOCSFAB-PRODUCT",
      version: "v0.28",
      streamVersion: 28,
      sha256: SHA_C,
      locator: `docsfab-model:${SHA_C}`,
    },
    sourceRegistrations: [
      {
        sourceId: "merge-source-1",
        sourceThreadId: "forge-thread-1",
        itemId: "merge-item-1",
        sourceKind: "repository-merge",
        evidenceRole: "behavior",
        version: MERGE,
        representationId: "repository-merge",
        integritySha256: SHA_B,
        locator: `docsfab-source:${SHA_B}`,
      },
      {
        sourceId: "review-source-1",
        sourceThreadId: "review-thread-1",
        itemId: "review-item-1",
        sourceKind: "review",
        evidenceRole: "review",
        version: "review-v1",
        representationId: "review-receipt",
        integritySha256: SHA_A,
        locator: `docsfab-source:${SHA_A}`,
      },
    ],
    ...overrides,
  };
}

function proposal(packetSha256, classifications = MERGE_RECONCILIATION_CONFLICT_CLASSIFICATIONS) {
  const claims = classifications.map((classification, index) => {
    const statement = `Merge claim ${index + 1} is classified as ${classification}.`;
    return {
      claimId: `claim-${index + 1}`,
      relationship: classification,
      action: "unresolved",
      statement,
      statementSha256: digest(statement),
      evidenceIds: [index % 2 === 0 ? "merge-source-1" : "review-source-1"],
    };
  });
  return {
    schemaVersion: 1,
    kind: MERGE_RECONCILIATION_PROPOSAL_KIND,
    packetSha256,
    claims,
    inconsistencies: classifications.map((classification, index) => ({
      conflictId: `conflict-${index + 1}`,
      status: "open",
      classification,
      sourceClaimIds: [`claim-${index + 1}`],
      resolutionOwner: "product-owner",
      authorityKind: "product-decision-owner",
      decisionKind:
        classification === "scope-conflict" ? "scope" :
        classification === "representation-conflict" ? "representation" :
        classification === "unknown" ? "authority" : "intent",
      confidence: "high",
      confidenceBasisSha256: digest(`confidence-${index + 1}`),
      impact: "load-bearing",
      impactBasisSha256: digest(`impact-${index + 1}`),
      blocksTargets: ["product-reference-model"],
      safeSummary: `Safe conflict summary ${index + 1}.`,
      variants: [{
        claimId: `claim-${index + 1}`,
        safeSummary: `Safe variant summary ${index + 1}.`,
        evidenceLocators: [index % 2 === 0 ? `docsfab-source:${SHA_B}` : `docsfab-source:${SHA_A}`],
      }],
      detailLocator: `docsfab-inconsistency:${digest(`conflict-${index + 1}`)}`,
      adjudication: null,
    })),
  };
}

function store() {
  const entries = new Map();
  const key = (identity) =>
    [identity.deploymentId, identity.projectId, identity.deploymentEpoch, identity.attemptId].join("|");
  return {
    entries,
    async getByIdentity(identity) {
      return entries.get(key(identity)) ?? null;
    },
    async put(record) {
      const identityKey = key(record.identity);
      const existing = entries.get(identityKey);
      if (existing) {
        assert.deepEqual(existing, record);
        return existing;
      }
      entries.set(identityKey, structuredClone(record));
      return record;
    },
  };
}

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

function credentialFixtures() {
  return [
    ...["glpat", "gldt", "glrt", "glptt"].map(
      (prefix) => `${prefix}-${"a".repeat(24)}`,
    ),
    ...["ghp_", "gho_", "ghu_", "ghs_", "ghr_", "github_pat_"].map(
      (prefix) => `${prefix}${"a".repeat(24)}`,
    ),
    `xapp-${"a".repeat(24)}`,
    ...["a", "b", "c", "d", "p", "r", "s"].map(
      (kind) => `xox${kind}-${"a".repeat(24)}`,
    ),
    `xoxe-1-${"a".repeat(24)}`,
    `xoxe.xoxb-1-${"a".repeat(24)}`,
    `xoxe.xoxp-1-${"a".repeat(24)}`,
    `nvapi-${"a".repeat(24)}`,
    `sk-${"a".repeat(24)}`,
    `sk-proj-${"a".repeat(24)}`,
    ...[
      "token",
      "secret",
      "password",
      "api_key",
      "api-key",
      "private_token",
      "private-token",
      "authorization",
    ].map((name) => `${name}=syntheticvalue`),
  ];
}

test("one merge job runs the registered source/claim/synthesis procedures and emits bound report-only artifacts", async () => {
  const resultStore = store();
  let captured;
  const runtime = createMergeReconciliationRuntimeAdapter({
    resultStore,
    executor: {
      async execute(input) {
        captured = input;
        return proposal(input.task.workPacket.packetSha256);
      },
    },
  });

  const result = await runtime.reconcile(job());

  assert.deepEqual(captured.procedure.skills, MERGE_RECONCILIATION_SKILLS);
  assert.equal(captured.procedure.order, "register-assess-synthesize-converge");
  assert.equal(captured.task.state, "claimed");
  assert.equal(captured.task.workPacket.inputVersion, 28);
  assert.deepEqual(captured.task.workPacket.inputRefs, [
    `docsfab-model:${SHA_C}`,
    `docsfab-source:${SHA_B}`,
    `docsfab-source:${SHA_A}`,
  ]);
  assert.equal(captured.canonicalContext.job.forge.mergeRevision, MERGE);
  assert.equal(captured.canonicalContext.job.forge.sourceRevision, SOURCE);
  assert.equal(captured.canonicalContext.job.modelParent.sha256, SHA_C);
  assert.equal(captured.canonicalContext.job.contextBindingSha256, SHA_A);
  assert.equal(captured.canonicalContext.executionBoundary.adjudication, false);
  assert.equal(captured.canonicalContext.executionBoundary.mergeModelOrProjection, false);

  assert.equal(result.forge.mergeRevision, MERGE);
  assert.equal(result.sourceRegistrations[0].version, MERGE);
  assert.equal(result.sourceRegistrations[0].integritySha256, SHA_B);
  assert.equal(result.modelParent.sha256, SHA_C);
  assert.equal(result.contextBindingSha256, SHA_A);
  assert.equal(result.receipt.attemptId, "attempt-1");
  assert.equal(result.receipt.packetSha256, result.workflow.packetSha256);
  assert.equal(result.receipt.candidateDeltaSha256, result.candidateDelta.sha256);
  assert.equal(result.receipt.contextBindingSha256, SHA_A);
  assert.equal(result.receipt.approvalState, "candidate");
  assert.equal(result.receipt.adjudicationAction, "none");
  assert.equal(result.receipt.projectionAction, "none");
  assert.deepEqual(result.workflow.skills, MERGE_RECONCILIATION_SKILLS);
  for (const claim of result.claims) {
    assert.ok(Buffer.byteLength(claim.statement, "utf8") <= 2_048);
    assert.equal(claim.statementSha256, digest(claim.statement));
    assert.doesNotMatch(
      claim.statement,
      /(?:xox[baprcds]-|diff --git|\/Users\/|\/home\/|\/root\/|system prompt|persona memory)/iu,
    );
  }
  assert.deepEqual(
    Object.keys(result.measurement.classificationCounts),
    MERGE_RECONCILIATION_CONFLICT_CLASSIFICATIONS,
  );
  for (const classification of MERGE_RECONCILIATION_CONFLICT_CLASSIFICATIONS) {
    assert.equal(result.measurement.classificationCounts[classification], 1);
  }
  assert.deepEqual(result.measurement.selfLoop, {
    observedEligibleEvents: 1,
    suppressedEvents: 0,
    rate: 0,
  });
  assert.deepEqual(result.measurement.falsePositive, {
    state: "unassessed",
    assessedReports: 0,
    falsePositiveReports: 0,
    rate: null,
  });
  assert.deepEqual(result.authority, {
    adjudicated: false,
    modelApproved: false,
    projectionMerged: false,
  });
  assert.equal(resultStore.entries.size, 1);
  assert.deepEqual(parseMergeReconciliationResult(result), result);
});

test("duplicate and concurrent deliveries share one logical executor attempt", async () => {
  const resultStore = store();
  let executeCount = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const runtime = createMergeReconciliationRuntimeAdapter({
    resultStore,
    executor: {
      async execute(input) {
        executeCount += 1;
        await gate;
        return proposal(input.task.workPacket.packetSha256, ["behavior-conflict"]);
      },
    },
  });
  const first = runtime.reconcile(job());
  const second = runtime.reconcile(job());
  release();
  const [left, right] = await Promise.all([first, second]);
  assert.equal(executeCount, 1);
  assert.deepEqual(left, right);

  const replay = await runtime.reconcile(job());
  assert.equal(executeCount, 1);
  assert.deepEqual(replay, left);
  assert.deepEqual(await runtime.getResult({
    deploymentId: "deployment-1",
    projectId: "project-a",
    deploymentEpoch: "epoch-1",
    attemptId: "attempt-1",
  }), left);
});

test("result and in-flight identities isolate the same attempt id across projects and epochs", async () => {
  const resultStore = store();
  let executeCount = 0;
  const runtime = createMergeReconciliationRuntimeAdapter({
    resultStore,
    executor: {
      async execute(input) {
        executeCount += 1;
        return proposal(input.task.workPacket.packetSha256, ["scope-conflict"]);
      },
    },
  });
  const projectA = job();
  const projectB = structuredClone(projectA);
  projectB.projectId = "project-b";
  projectB.deploymentEpoch = "epoch-2";
  projectB.forge.projectId = "project-b";
  projectB.forge.deploymentEpoch = "epoch-2";

  const [resultA, resultB] = await Promise.all([
    runtime.reconcile(projectA),
    runtime.reconcile(projectB),
  ]);
  assert.equal(executeCount, 2);
  assert.equal(resultA.attemptId, "attempt-1");
  assert.equal(resultB.attemptId, "attempt-1");
  assert.equal(resultA.projectId, "project-a");
  assert.equal(resultB.projectId, "project-b");
  assert.equal(resultStore.entries.size, 2);
  assert.equal((await runtime.getResult({
    deploymentId: "deployment-1",
    projectId: "project-a",
    deploymentEpoch: "epoch-1",
    attemptId: "attempt-1",
  })).resultSha256, resultA.resultSha256);
  assert.equal((await runtime.getResult({
    deploymentId: "deployment-1",
    projectId: "project-b",
    deploymentEpoch: "epoch-2",
    attemptId: "attempt-1",
  })).resultSha256, resultB.resultSha256);
  assert.equal(await runtime.getResult({
    deploymentId: "deployment-1",
    projectId: "project-a",
    deploymentEpoch: "epoch-2",
    attemptId: "attempt-1",
  }), null);

  const projectARecord = [...resultStore.entries.values()].find(
    (record) => record.result.projectId === "project-a",
  );
  resultStore.getByIdentity = async () => projectARecord;
  await assert.rejects(
    () => runtime.getResult({
      deploymentId: "deployment-1",
      projectId: "project-b",
      deploymentEpoch: "epoch-2",
      attemptId: "attempt-1",
    }),
    /crosses its composite identity/,
  );
});

test("job registration rejects a merge source or project boundary that is not exact", () => {
  const wrongVersion = job();
  wrongVersion.sourceRegistrations[0].version = SOURCE;
  assert.throws(
    () => parseMergeReconciliationJob(wrongVersion),
    /Merged revision source is not bound/,
  );

  const crossed = job({ projectId: "project-b" });
  assert.throws(
    () => parseMergeReconciliationJob(crossed),
    /crosses its forge project boundary/,
  );

  const wrongModelLocator = job();
  wrongModelLocator.modelParent.locator = `docsfab-model:${SHA_A}`;
  assert.throws(
    () => parseMergeReconciliationJob(wrongModelLocator),
    /model locator does not match its digest/i,
  );

  const wrongSourceLocator = job();
  wrongSourceLocator.sourceRegistrations[0].locator = `docsfab-source:${SHA_C}`;
  assert.throws(
    () => parseMergeReconciliationJob(wrongSourceLocator),
    /Source locator does not match its integrity digest/,
  );
});

test("model locator mismatch is rejected before the knowledge executor or result store", async () => {
  let executorCalls = 0;
  const resultStore = store();
  const runtime = createMergeReconciliationRuntimeAdapter({
    resultStore,
    executor: {
      async execute() {
        executorCalls += 1;
        throw new Error("must not execute");
      },
    },
  });
  const mismatch = job();
  mismatch.modelParent.locator = `docsfab-model:${SHA_A}`;
  await assert.rejects(
    () => runtime.reconcile(mismatch),
    /model locator does not match its digest/i,
  );
  assert.equal(executorCalls, 0);
  assert.equal(resultStore.entries.size, 0);
});

test("JSON-invisible job properties are rejected before executor use or hashing", async () => {
  const mutations = [
    (value) => {
      Object.defineProperty(value.sourceRegistrations, "hiddenCredential", {
        value: `xoxb-${"x".repeat(24)}`,
        enumerable: true,
      });
    },
    (value) => { delete value.sourceRegistrations[1]; },
    (value) => { value.modelParent.version = undefined; },
    (value) => {
      Object.defineProperty(value.modelParent, "hidden", {
        value: "not-enumerable",
        enumerable: false,
      });
    },
    (value) => { value.modelParent[Symbol("hidden")] = "symbol-value"; },
    (value) => { value.modelParent.toJSON = "hook"; },
    (value) => { Object.setPrototypeOf(value.modelParent, null); },
  ];
  for (const mutate of mutations) {
    let executorCalls = 0;
    const resultStore = store();
    const runtime = createMergeReconciliationRuntimeAdapter({
      resultStore,
      executor: {
        async execute() {
          executorCalls += 1;
          throw new Error("must not execute");
        },
      },
    });
    const hostile = job();
    mutate(hostile);
    await assert.rejects(() => runtime.reconcile(hostile));
    assert.equal(executorCalls, 0);
    assert.equal(resultStore.entries.size, 0);
  }
});

test("an executor cannot hide a credential on a proposal array outside canonical JSON", async () => {
  let executorCalls = 0;
  const resultStore = store();
  const runtime = createMergeReconciliationRuntimeAdapter({
    resultStore,
    executor: {
      async execute(input) {
        executorCalls += 1;
        const value = proposal(input.task.workPacket.packetSha256, ["behavior-conflict"]);
        Object.defineProperty(value.claims, "hiddenCredential", {
          value: `xoxb-${"x".repeat(24)}`,
          enumerable: true,
        });
        return value;
      },
    },
  });
  await assert.rejects(
    () => runtime.reconcile(job()),
    /arrays must be dense and index-only/,
  );
  assert.equal(executorCalls, 1);
  assert.equal(resultStore.entries.size, 0);
});

test("stored-result recovery rejects an array-hidden credential before returning it", async () => {
  const resultStore = store();
  const runtime = createMergeReconciliationRuntimeAdapter({
    resultStore,
    executor: {
      async execute(input) {
        return proposal(input.task.workPacket.packetSha256, ["behavior-conflict"]);
      },
    },
  });
  await runtime.reconcile(job());
  const stored = [...resultStore.entries.values()][0];
  Object.defineProperty(stored.result.claims, "hiddenCredential", {
    value: `xoxb-${"x".repeat(24)}`,
    enumerable: true,
  });
  await assert.rejects(
    () => runtime.getResult({
      deploymentId: "deployment-1",
      projectId: "project-a",
      deploymentEpoch: "epoch-1",
      attemptId: "attempt-1",
    }),
    /arrays must be dense and index-only/,
  );
});

test("every host credential family is rejected before real result-store put without echo", async () => {
  for (const token of credentialFixtures()) {
    let putCalls = 0;
    const resultStore = {
      async getByIdentity() { return null; },
      async put() {
        putCalls += 1;
        throw new Error("must not persist a credential-bearing result");
      },
    };
    const runtime = createMergeReconciliationRuntimeAdapter({
      resultStore,
      executor: {
        async execute(input) {
          const value = proposal(input.task.workPacket.packetSha256, ["behavior-conflict"]);
          value.inconsistencies[0].resolutionOwner = token;
          return value;
        },
      },
    });
    await assert.rejects(
      () => runtime.reconcile(job()),
      (error) => {
        assert.equal(String(error).includes(token), false);
        assert.match(String(error), /unsafe content|invalid/u);
        return true;
      },
    );
    assert.equal(putCalls, 0, token.slice(0, 4));
  }
});

test("HTML and Markdown-link claim text is rejected before result-store persistence", async () => {
  for (const statement of [
    "<img src=x onerror=alert(1)>",
    "<script>alert(1)</script>",
    "[x](javascript:alert(1))",
    "![x](https://example.invalid/image.png)",
    "[x](data:text/html,unsafe)",
    "[x](vbscript:msgbox(1))",
    "[review][external]",
  ]) {
    let putCalls = 0;
    const runtime = createMergeReconciliationRuntimeAdapter({
      resultStore: {
        async getByIdentity() { return null; },
        async put() { putCalls += 1; },
      },
      executor: {
        async execute(input) {
          const value = proposal(input.task.workPacket.packetSha256, ["behavior-conflict"]);
          value.claims[0].statement = statement;
          value.claims[0].statementSha256 = digest(statement);
          return value;
        },
      },
    });
    await assert.rejects(() => runtime.reconcile(job()), /unsafe|invalid/u, statement);
    assert.equal(putCalls, 0, statement);
  }
});

test("runtime rejects authority expansion, unknown evidence, raw paths, and credentials", async () => {
  for (const mutate of [
    (value) => { value.inconsistencies[0].adjudication = { disposition: "accept" }; },
    (value) => { value.claims[0].evidenceIds = ["missing-source"]; },
    (value) => { value.inconsistencies[0].detailLocator = "/Users/operator/private.txt"; },
    (value) => { value.inconsistencies[0].resolutionOwner = `xoxb-${"x".repeat(20)}`; },
  ]) {
    const runtime = createMergeReconciliationRuntimeAdapter({
      resultStore: store(),
      executor: {
        async execute(input) {
          const value = proposal(input.task.workPacket.packetSha256, ["intent-conflict"]);
          mutate(value);
          return value;
        },
      },
    });
    await assert.rejects(() => runtime.reconcile(job()));
  }
});

test("result parsing rejects a digest-valid authority or measurement forgery", async () => {
  const runtime = createMergeReconciliationRuntimeAdapter({
    resultStore: store(),
    executor: {
      async execute(input) {
        return proposal(input.task.workPacket.packetSha256, ["scope-conflict"]);
      },
    },
  });
  const result = await runtime.reconcile(job());
  const authorityForgery = structuredClone(result);
  authorityForgery.authority.modelApproved = true;
  assert.throws(() => parseMergeReconciliationResult(authorityForgery), /candidate authority/);

  const measurementForgery = structuredClone(result);
  measurementForgery.measurement.falsePositive.state = "assessed";
  assert.throws(() => parseMergeReconciliationResult(measurementForgery), /cannot claim a live/);
});
