// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve, sep } from "node:path";

import { canonicalJson } from "../content-ir/canonical.js";
import { readStrictJson as readCorpusJsonEvidence } from "./corpus-files.js";
import {
  compareMaturityCascadeKnownAnswers,
  evaluateMaturityCascadeDataset,
  validateMaturityCascadeBaseline,
  validateMaturityCascadeDataset,
  validateMaturityCascadeReview,
  type MaturityCascadeEvaluationReportV1,
  type MaturityCascadeSemanticScorer,
} from "./maturity-cascade.js";

const MAXIMUM_JSON_BYTES = 2 * 1024 * 1024;

export interface MaturityCascadeEvaluationPaths {
  projectRoot: string;
  datasetPath: string;
  baselinePath: string;
  reviewerPolicyPath: string;
  reviewPath: string;
}

/**
 * Runs deterministic observations before loading the known-answer baseline.
 * This ordering makes the oracle unavailable to scanners and selectors.
 */
export async function evaluateMaturityCascadeFromFiles(
  paths: MaturityCascadeEvaluationPaths,
  options: { semanticScorer?: MaturityCascadeSemanticScorer } = {},
): Promise<MaturityCascadeEvaluationReportV1> {
  const projectRoot = await realpath(resolve(paths.projectRoot));
  const dataset = validateMaturityCascadeDataset(
    await readStrictJson(within(projectRoot, paths.datasetPath)),
  );
  const observations = await evaluateMaturityCascadeDataset({
    projectRoot,
    dataset,
    ...(options.semanticScorer ? { semanticScorer: options.semanticScorer } : {}),
  });
  // Known answers are deliberately loaded only after all observations exist.
  const baseline = validateMaturityCascadeBaseline(
    await readStrictJson(within(projectRoot, paths.baselinePath)),
    dataset,
  );
  const review = validateMaturityCascadeReview({
    review: await readStrictJson(within(projectRoot, paths.reviewPath)),
    policy: await readStrictJson(within(projectRoot, paths.reviewerPolicyPath)),
    baseline,
  });
  return compareMaturityCascadeKnownAnswers({ dataset, baseline, review, observations });
}

export async function publishMaturityCascadeReport(input: {
  outputDirectory: string;
  report: MaturityCascadeEvaluationReportV1;
}): Promise<{ jsonPath: string; markdownPath: string }> {
  if (!isAbsolute(input.outputDirectory)) {
    throw new Error("Maturity cascade output directory must be absolute.");
  }
  await mkdir(input.outputDirectory, { recursive: false, mode: 0o700 });
  const jsonPath = join(input.outputDirectory, "report.json");
  const markdownPath = join(input.outputDirectory, "report.md");
  await writeFile(jsonPath, canonicalJson(input.report), { flag: "wx", mode: 0o600 });
  await writeFile(markdownPath, renderReport(input.report), { flag: "wx", mode: 0o600 });
  return { jsonPath, markdownPath };
}

function renderReport(report: MaturityCascadeEvaluationReportV1): string {
  const rows = report.cases.map(
    (item) =>
      `| ${item.caseId} | ${item.selection.state} | ${item.selection.gateId ?? "—"} | ${item.stability.stable ? "yes" : "no"} | ${item.semantic.status} |`,
  );
  return [
    "# Maturity cascade evaluation",
    "",
    `Deterministic result: **${report.passed ? "PASS" : "FAIL"}**`,
    "",
    "Offline deterministic observations are authoritative. Semantic scores are advisory only.",
    "The production GitLab tracker observation boundary is not evaluated by this credential-free corpus.",
    "",
    "| Case | Selection | Gate | Stable | Semantic |",
    "| --- | --- | --- | --- | --- |",
    ...rows,
    "",
    `Authenticated transitions: ${report.transitions.filter((item) => item.passed).length}/${report.transitions.length}`,
    "",
    `Mismatches: ${report.mismatches.length}`,
    "",
    `Report SHA-256: \`${report.reportSha256}\``,
    "",
  ].join("\n");
}

async function readStrictJson(path: string): Promise<unknown> {
  const before = await lstat(path, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || before.size > BigInt(MAXIMUM_JSON_BYTES)) {
    throw new Error("Maturity cascade evidence file is invalid.");
  }
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = await handle.stat({ bigint: true });
    if (
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      opened.size !== before.size ||
      opened.mtimeNs !== before.mtimeNs ||
      opened.ctimeNs !== before.ctimeNs
    ) {
      throw new Error("Maturity cascade evidence file changed while opening.");
    }
  } finally {
    await handle.close();
  }
  const value = await readCorpusJsonEvidence(path, { maximumBytes: MAXIMUM_JSON_BYTES });
  const after = await lstat(path, { bigint: true });
  if (
    after.size !== before.size ||
    after.mtimeNs !== before.mtimeNs ||
    after.ctimeNs !== before.ctimeNs
  ) {
    throw new Error("Maturity cascade evidence file changed while reading.");
  }
  return value;
}

function within(root: string, path: string): string {
  const absolute = isAbsolute(path) ? resolve(path) : resolve(root, path);
  if (absolute !== root && !absolute.startsWith(`${root}${sep}`)) {
    throw new Error("Maturity cascade evidence path escapes the project root.");
  }
  return absolute;
}
