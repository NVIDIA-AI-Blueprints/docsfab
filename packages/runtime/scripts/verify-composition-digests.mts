#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Verify the composition digest chain against the files as they stand.
 *
 * Run this before regenerating anything. Every digest here is asserted to be
 * `canonicalDigest(body-without-its-own-digest-field)`, so a wrong rule shows
 * up on known-good data instead of being sealed into regenerated files, which
 * a self-verifying chain cannot detect.
 */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { canonicalDigest } from "../src/content-ir/canonical.js";
import {
  recordedAnswerSubmissionGaps,
  recordedAnswerSubmissionRecordsEvidenceGaps,
} from "../src/model-composition/answer-submission-record.js";

/** `--root DIR` verifies a copy of the model-compositions directory; tests use it. */
const rootIndex = process.argv.indexOf("--root");
const ROOT = resolve(
  rootIndex >= 0 && process.argv[rootIndex + 1]
    ? process.argv[rootIndex + 1]!
    : resolve(import.meta.dirname, "..", "model-compositions"),
);
const evidenceIndex = process.argv.indexOf("--evidence-root");
const evidenceRoot = resolve(
  evidenceIndex >= 0 && process.argv[evidenceIndex + 1]
    ? process.argv[evidenceIndex + 1]!
    : resolve(import.meta.dirname, "../docs/internal/evidence/answer-record-corpus-2026-10"),
);

function withoutKey(body: Record<string, unknown>, key: string): Record<string, unknown> {
  const { [key]: _dropped, ...rest } = body;
  return rest;
}

let checked = 0;
let mismatched = 0;

function check(label: string, expected: unknown, body: Record<string, unknown>, key: string): void {
  const actual = canonicalDigest(withoutKey(body, key));
  checked += 1;
  if (actual !== expected) {
    mismatched += 1;
    console.error(`  MISMATCH ${label}\n    committed ${String(expected)}\n    recomputed ${actual}`);
  }
}

const projections = JSON.parse(await readFile(resolve(ROOT, "candidate-projections.json"), "utf8"));
for (const candidate of projections.candidates) {
  check(`candidate ${candidate.candidateId}`, candidate.candidateSha256, candidate, "candidateSha256");
}
check("candidate-projections registry", projections.registrySha256, projections, "registrySha256");

const compositions = JSON.parse(await readFile(resolve(ROOT, "composition-registry.json"), "utf8"));
for (const composition of compositions.compositions) {
  check(
    `composition ${composition.compositionId}`,
    composition.compositionSha256,
    composition,
    "compositionSha256",
  );
}
check("composition registry", compositions.registrySha256, compositions, "registrySha256");
// Not a digest: a recorded answer submission must carry every capability
// field, including the probe's `objectMembers`.
const answerSubmissionGaps = recordedAnswerSubmissionGaps(compositions);
for (const gap of answerSubmissionGaps) console.error(`  REFUSED ${gap}`);
const answerSubmissionRecordsGaps = await recordedAnswerSubmissionRecordsEvidenceGaps(
  compositions,
  evidenceRoot,
);
for (const gap of answerSubmissionRecordsGaps) console.error(`  REFUSED ${gap}`);

const adapters = JSON.parse(await readFile(resolve(ROOT, "adapter-registry.json"), "utf8"));
check("adapter registry", adapters.registrySha256, adapters, "registrySha256");

const manifest = JSON.parse(await readFile(resolve(ROOT, "installed-manifest.json"), "utf8"));
check(
  "manifest compositionCeiling",
  manifest.compositionCeilingSha256,
  manifest.compositionCeiling,
  "compositionCeilingSha256",
);
check("installed manifest", manifest.installedManifestSha256, manifest, "installedManifestSha256");

// Asset digests are over file bytes, not canonical bodies -- a different rule,
// and one that key order changes even when canonical digests do not.
const { createHash } = await import("node:crypto");
for (const asset of manifest.assets) {
  const bytes = await readFile(resolve(ROOT, asset.path));
  const actual = createHash("sha256").update(bytes).digest("hex");
  checked += 1;
  if (actual !== asset.fileSha256) {
    mismatched += 1;
    console.error(
      `  MISMATCH asset file ${asset.path}\n    committed ${asset.fileSha256}\n    recomputed ${actual}`,
    );
  }
}

console.log(
  `digest rule checked against ${checked} committed digest(s); ${mismatched} mismatch(es); ${answerSubmissionGaps.length} incomplete answerSubmission field(s); ${answerSubmissionRecordsGaps.length} unproven answerSubmissionRecords qualification(s) in ${ROOT}`,
);
process.exitCode = mismatched === 0 && answerSubmissionGaps.length === 0 && answerSubmissionRecordsGaps.length === 0 ? 0 : 1;
