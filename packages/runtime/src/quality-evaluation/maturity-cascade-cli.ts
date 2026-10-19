// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { internalContentPath } from "../config/internal-content.js";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { canonicalJson } from "../content-ir/canonical.js";
import {
  evaluateMaturityCascadeFromFiles,
  publishMaturityCascadeReport,
} from "./maturity-cascade-files.js";

interface CliOptions {
  projectRoot: string;
  datasetPath: string;
  baselinePath: string;
  reviewerPolicyPath: string;
  reviewPath: string;
  allowWrite: boolean;
  outputDirectory: string | null;
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  try {
    const options = parseOptions(argv);
    const report = await evaluateMaturityCascadeFromFiles({
      projectRoot: options.projectRoot,
      datasetPath: options.datasetPath,
      baselinePath: options.baselinePath,
      reviewerPolicyPath: options.reviewerPolicyPath,
      reviewPath: options.reviewPath,
    });
    if (options.outputDirectory !== null) {
      if (!options.allowWrite) throw new Error("--output-dir requires --allow-write.");
      const published = await publishMaturityCascadeReport({
        outputDirectory: options.outputDirectory,
        report,
      });
      process.stdout.write(`${canonicalJson({ report, published })}\n`);
    } else {
      process.stdout.write(`${canonicalJson(report)}\n`);
    }
    return report.passed ? 0 : 1;
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : "Maturity cascade evaluation failed."}\n`,
    );
    return 1;
  }
}

function parseOptions(argv: string[]): CliOptions {
  const options: Omit<CliOptions, "projectRoot"> & { projectRoot?: string } = {
    datasetPath: "evaluation/maturity-cascade/dataset-v1.json",
    baselinePath: "evaluation/maturity-cascade/baseline-v1.json",
    reviewerPolicyPath: "evaluation/maturity-cascade/reviewer-policy-v1.json",
    reviewPath: "evaluation/maturity-cascade/review-v1.json",
    allowWrite: false,
    outputDirectory: null,
  };
  const seen = new Set<string>();
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index]!;
    if (seen.has(option)) throw new Error(`Duplicate option: ${option}`);
    seen.add(option);
    if (option === "--allow-write") {
      options.allowWrite = true;
      continue;
    }
    if (
      ![
        "--project-root",
        "--dataset",
        "--baseline",
        "--reviewer-policy",
        "--review",
        "--output-dir",
      ].includes(option)
    ) {
      throw new Error(`Unknown option: ${option}`);
    }
    const value = argv[++index];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${option}.`);
    if (option === "--project-root") options.projectRoot = resolve(value);
    else if (option === "--dataset") options.datasetPath = value;
    else if (option === "--baseline") options.baselinePath = value;
    else if (option === "--reviewer-policy") options.reviewerPolicyPath = value;
    else if (option === "--review") options.reviewPath = value;
    else options.outputDirectory = resolve(value);
  }
  if (options.allowWrite !== (options.outputDirectory !== null)) {
    throw new Error("--allow-write and --output-dir must be supplied together.");
  }
  return {
    ...options,
    projectRoot:
      options.projectRoot ??
      resolve(process.cwd(), "../..", internalContentPath("qualityBenchmarkRuntime")),
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}
