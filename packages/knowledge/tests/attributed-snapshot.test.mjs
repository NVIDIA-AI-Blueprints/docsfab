// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

import {
  emitAttributedSnapshot,
  sealKnowledgeAcceptedSnapshot,
} from "../src/attributed-snapshot.mjs";
import { emitAttributedSnapshot as exportedEmit } from "../src/exports.mjs";

const execFileAsync = promisify(execFile);
const cliPath = fileURLToPath(new URL("../src/cli.mjs", import.meta.url));
const temporaryDirectories = [];

test.after(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function needsInputBody(overrides = {}) {
  return {
    projectId: "PRJ-001",
    modelVersionId: "MODEL-001",
    streamVersion: 4,
    status: "candidate",
    claims: [
      {
        id: "CL-001",
        kind: "intent",
        scope: "Example Product",
        statement: "Onboarding requires an undocumented hub credential.",
        modelState: "unresolved",
        evidenceIds: ["SRC-001"],
      },
    ],
    sources: [{ id: "SRC-001", locator: "readme:README.md" }],
    conflicts: [],
    ...overrides,
  };
}

function attributedAnswer(overrides = {}) {
  return {
    schemaVersion: 1,
    kind: "knowledge-attributed-answer",
    actor: "Jordan Patel",
    authority: "product-decision-owner",
    token: "CL-001",
    statement: "Onboarding requires an API key issued by the hub.",
    ...overrides,
  };
}

function snapshotBytes(body) {
  const snapshot = sealKnowledgeAcceptedSnapshot(body);
  return Buffer.from(`${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
}

test("exported function emits a new snapshot without mutating prior bytes", () => {
  const priorBytes = snapshotBytes(needsInputBody());
  const original = Buffer.from(priorBytes);
  const prior = JSON.parse(priorBytes.toString("utf8"));

  const result = exportedEmit(priorBytes, attributedAnswer());

  assert.deepEqual(priorBytes, original);
  assert.equal(result.priorSnapshotSha256, prior.snapshotSha256);
  assert.notEqual(result.snapshot.snapshotSha256, prior.snapshotSha256);
  assert.notEqual(result.snapshot.modelVersionId, prior.modelVersionId);
  assert.equal(result.snapshot.modelVersionId, "MODEL-002");
  assert.equal(result.snapshot.streamVersion, prior.streamVersion + 1);
  assert.equal(result.snapshot.kind, "knowledge-accepted-snapshot");
  assert.equal(result.snapshot.status, "candidate");
  const answered = result.snapshot.claims.find((claim) => claim.id === "CL-001");
  assert.equal(answered.modelState, "candidate");
  assert.equal(
    answered.statement,
    "Onboarding requires an API key issued by the hub.",
  );
  assert.equal(result.answeredClaimId, "CL-001");
  const serialized = JSON.stringify(result.snapshot);
  assert.equal(serialized.includes("turns"), false);
  assert.equal(serialized.includes("question"), false);
  assert.equal(
    JSON.parse(original.toString("utf8")).snapshotSha256,
    prior.snapshotSha256,
  );
});

test("resolving one claim leaves a remaining unresolved claim needs-input", () => {
  const priorBytes = snapshotBytes(
    needsInputBody({
      claims: [
        {
          id: "CL-001",
          kind: "intent",
          scope: "Example Product",
          statement: "Onboarding is unspecified.",
          modelState: "unresolved",
          evidenceIds: ["SRC-001"],
        },
        {
          id: "CL-002",
          kind: "intent",
          scope: "Example Product",
          statement: "Billing is unspecified.",
          modelState: "unresolved",
          evidenceIds: ["SRC-001"],
        },
      ],
    }),
  );

  const result = emitAttributedSnapshot(priorBytes, attributedAnswer());
  const answered = result.snapshot.claims.find((claim) => claim.id === "CL-001");
  const remaining = result.snapshot.claims.find((claim) => claim.id === "CL-002");
  assert.equal(answered.modelState, "candidate");
  assert.equal(remaining.modelState, "unresolved");
});

test("conflict token supersedes the losing claim and drops the conflict", () => {
  const priorBytes = snapshotBytes(
    needsInputBody({
      claims: [
        {
          id: "CL-001",
          kind: "intent",
          scope: "Example Product",
          statement: "Use a hub API key.",
          modelState: "disputed",
          evidenceIds: ["SRC-001"],
        },
        {
          id: "CL-002",
          kind: "intent",
          scope: "Example Product",
          statement: "Use a local password.",
          modelState: "disputed",
          evidenceIds: ["SRC-001"],
        },
      ],
      conflicts: [{ id: "CF-001", claimIds: ["CL-001", "CL-002"] }],
    }),
  );

  const result = emitAttributedSnapshot(
    priorBytes,
    attributedAnswer({
      token: "CF-001",
      winningClaimId: "CL-001",
      statement: "Use a hub API key issued by the product owner.",
    }),
  );

  assert.deepEqual(result.snapshot.conflicts, []);
  assert.equal(
    result.snapshot.claims.find((claim) => claim.id === "CL-001").modelState,
    "candidate",
  );
  assert.equal(
    result.snapshot.claims.find((claim) => claim.id === "CL-002").modelState,
    "superseded",
  );
  assert.equal(result.answeredClaimId, "CL-001");
});

test("preserves every untouched classified conflict and variant", () => {
  const classification = {
    impact: "load-bearing",
    impactBasisSha256: "b".repeat(64),
    blockingDocumentationPaths: ["docs/about/product.md"],
    resolutionOwner: "product-owner",
    authorityKind: "product-decision-owner",
  };
  const claims = ["CL-001", "CL-002", "CL-003", "CL-004"].map((id, index) => ({
    id,
    kind: "behavior",
    scope: "Example Product",
    statement: `Variant ${String(index + 1)}.`,
    modelState: "disputed",
    evidenceIds: ["SRC-001"],
  }));
  const priorBytes = snapshotBytes(
    needsInputBody({
      claims,
      conflicts: [
        { id: "CF-001", claimIds: ["CL-001", "CL-002"] },
        { id: "CF-002", claimIds: ["CL-003", "CL-004"], classification },
      ],
    }),
  );

  const result = emitAttributedSnapshot(
    priorBytes,
    attributedAnswer({
      token: "CF-001",
      winningClaimId: "CL-001",
      statement: "Variant one is selected.",
    }),
  );

  assert.deepEqual(result.snapshot.conflicts, [
    { id: "CF-002", claimIds: ["CL-003", "CL-004"], classification },
  ]);
  assert.deepEqual(
    result.snapshot.claims.filter((claim) => ["CL-003", "CL-004"].includes(claim.id)),
    claims.filter((claim) => ["CL-003", "CL-004"].includes(claim.id)),
  );
});

test("rejects partial and unsafe knowledge-owned conflict classifications", () => {
  const valid = {
    impact: "load-bearing",
    impactBasisSha256: "b".repeat(64),
    blockingDocumentationPaths: ["docs/about/product.md"],
    resolutionOwner: "product-owner",
    authorityKind: "product-decision-owner",
  };
  const conflictBody = (classification) =>
    needsInputBody({
      claims: [
        needsInputBody().claims[0],
        { ...needsInputBody().claims[0], id: "CL-002" },
      ],
      conflicts: [{ id: "CF-001", claimIds: ["CL-001", "CL-002"], classification }],
    });

  assert.throws(
    () => {
      const { authorityKind: _authorityKind, ...partial } = valid;
      sealKnowledgeAcceptedSnapshot(conflictBody(partial));
    },
    /closed v1 fields/,
  );
  assert.throws(
    () =>
      sealKnowledgeAcceptedSnapshot(
        conflictBody({
          ...valid,
          impact: "advisory",
        }),
      ),
    /impact and blocking documentation paths disagree/,
  );
  assert.throws(
    () =>
      sealKnowledgeAcceptedSnapshot(
        conflictBody({
          ...valid,
          blockingDocumentationPaths: ["../docs/about.md"],
        }),
      ),
    /unsafe/,
  );
  assert.throws(
    () =>
      sealKnowledgeAcceptedSnapshot(
        conflictBody({
          ...valid,
          resolutionOwner: "glpat-abcdefghijklmnopqrstuvwxyz0123",
        }),
      ),
    /credential material/,
  );
});

test("rejects unattributed, already-resolved, and unknown tokens", () => {
  const unresolvedBytes = snapshotBytes(needsInputBody());
  assert.throws(
    () =>
      emitAttributedSnapshot(unresolvedBytes, {
        ...attributedAnswer(),
        actor: "",
      }),
    /actor is required/,
  );
  assert.throws(
    () =>
      emitAttributedSnapshot(unresolvedBytes, {
        ...attributedAnswer(),
        authority: "chat-participant",
      }),
    /product-decision-owner/,
  );
  assert.throws(
    () => emitAttributedSnapshot(unresolvedBytes, attributedAnswer({ token: "CL-999" })),
    /Unknown answered token/,
  );

  const resolvedBytes = snapshotBytes(
    needsInputBody({
      claims: [
        {
          id: "CL-001",
          kind: "intent",
          scope: "Example Product",
          statement: "Onboarding requires a hub API key.",
          modelState: "candidate",
          evidenceIds: ["SRC-001"],
        },
      ],
    }),
  );
  assert.throws(
    () => emitAttributedSnapshot(resolvedBytes, attributedAnswer()),
    /does not need input/,
  );
});

test("CLI writes a new snapshot file and leaves the prior file unchanged", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "knowledge-attributed-"));
  temporaryDirectories.push(root);
  const priorPath = path.join(root, "prior.json");
  const answerPath = path.join(root, "answer.json");
  const outputPath = path.join(root, "next.json");
  const priorBytes = snapshotBytes(needsInputBody());
  await writeFile(priorPath, priorBytes);
  await writeFile(answerPath, `${JSON.stringify(attributedAnswer(), null, 2)}\n`);

  const { stdout } = await execFileAsync(process.execPath, [
    cliPath,
    "apply-answer",
    "--snapshot",
    priorPath,
    "--answer",
    answerPath,
    "--output",
    outputPath,
  ]);

  const afterPrior = await readFile(priorPath);
  assert.deepEqual(afterPrior, priorBytes);
  const emitted = JSON.parse(await readFile(outputPath, "utf8"));
  const receipt = JSON.parse(stdout);
  assert.equal(emitted.kind, "knowledge-accepted-snapshot");
  assert.notEqual(emitted.snapshotSha256, JSON.parse(priorBytes.toString("utf8")).snapshotSha256);
  assert.equal(receipt.snapshotSha256, emitted.snapshotSha256);
  assert.equal(
    emitted.claims.find((claim) => claim.id === "CL-001").modelState,
    "candidate",
  );

  await assert.rejects(
    execFileAsync(process.execPath, [
      cliPath,
      "apply-answer",
      "--snapshot",
      priorPath,
      "--answer",
      answerPath,
      "--output",
      priorPath,
    ]),
    (error) => {
      assert.match(
        `${error.stderr ?? ""}${error.message ?? ""}`,
        /Refusing to overwrite the prior snapshot/,
      );
      return true;
    },
  );
});
