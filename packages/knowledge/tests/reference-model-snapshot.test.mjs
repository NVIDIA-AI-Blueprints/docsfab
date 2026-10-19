// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createApprovedModelReader, parseReferenceModelSnapshot, verifyApprovedModelContent } from "../src/reference-model-snapshot.mjs";
import { feedbackDigest } from "../src/product-feedback-contracts.mjs";

const fixtureModel = fileURLToPath(new URL("./fixtures/reference-model/", import.meta.url));
const projector = fileURLToPath(new URL("../skills/converge-documentation/scripts/project_model_feedback.py", import.meta.url));
function project(base, projectId, version) {
  const revision = execFileSync("git", ["rev-parse", "HEAD"], { cwd: base, encoding: "utf8" }).trim();
  return parseReferenceModelSnapshot(JSON.parse(execFileSync(process.env.PYTHON ?? "python3", [projector,
    "--root", base, "--project-id", projectId, "--model-id", "DOCSFAB-PRODUCT", "--version", version,
    "--revision", revision], { cwd: base, encoding: "utf8", maxBuffer: 8 * 1024 * 1024, timeout: 120000 })));
}

test("fixture v0.10 source approval can be supplied by a trusted verifier; it cannot approve v0.11", async () => {
  const base = await mkdtemp(join(tmpdir(), "docsfab-fixture-model-"));
  try {
    await cp(fixtureModel, join(base, ".docsfab/reference-model"), { recursive: true });
    const git = (...args) => execFileSync("git", args, { cwd: base, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    git("init", "-q"); git("add", "."); git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-qm", "fixture");
    const older = project(base, "fixture-project", "v0.10"), candidate = project(base, "fixture-project", "v0.11");
    const evidence = older.files.find(file => file.path.includes("/artifacts/sha256/"));
    assert.ok(evidence, "the projected snapshot binds the retained source artifact");
    const bytes = await readFile(join(base, evidence.path));
    assert.equal(createHash("sha256").update(bytes).digest("hex"), evidence.sha256);
    assert.equal(older.modelSha256, "1d61dd01d7ed690f005f66538e6228b10b9eea13099643728e56bfb5156530fb");
    assert.deepEqual(older.openConflicts, []);
    assert.deepEqual(candidate.openConflicts.map(item => item.id), ["CONFLICT-EXAMPLE-001"]);
    const verifyApproval = async request => {
      assert.equal(request.snapshot.snapshotSha256, older.snapshotSha256);
      assert.equal(request.approvalEvidenceSha256, evidence.sha256);
      return { projectId: "fixture-project", modelId: "DOCSFAB-PRODUCT", version: "v0.10", streamVersion: 10,
        modelSha256: older.modelSha256, snapshotSha256: older.snapshotSha256, principalId: "fixture-owner",
        authorityReceiptSha256: feedbackDigest("explicitly-labeled-offline-fixture-authority"),
        approvalEvidenceSha256: evidence.sha256, scope: "model-version" };
    };
    let current = older;
    const reader = createApprovedModelReader({ verifyApproval, loadCurrent: async () => ({
      projectId: "fixture-project", generation: 0, streamVersion: 10, snapshot: current,
      canon: { sha256: current.modelSha256, sourcePath: current.modelPath, gitObjectId: current.modelGitObjectId },
      approvalEvidenceSha256: evidence.sha256 }) });
    const approved = await reader.readCurrent();
    assert.equal(approved.approval.principalId, "fixture-owner");
    const content = await readFile(join(base, older.modelPath), "utf8");
    const contentInput = { content, sourcePath: older.modelPath, gitObjectId: older.modelGitObjectId };
    assert.equal(verifyApprovedModelContent(approved, contentInput).sha256, older.modelSha256);
    assert.throws(() => verifyApprovedModelContent(approved, { ...contentInput, content: content + "\n" }),
      { message: "product-feedback: invalid binding" });
    assert.throws(() => verifyApprovedModelContent(approved, { ...contentInput, sourcePath: candidate.modelPath }),
      { message: "product-feedback: invalid binding" });
    current = candidate;
    await assert.rejects(reader.readCurrent(), { message: "product-feedback: approval verification failed" });
    assert.equal(candidate.state, "candidate");
  } finally { await rm(base, { recursive: true, force: true }); }
});
