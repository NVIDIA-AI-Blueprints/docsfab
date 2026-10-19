// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { reportOperatorFailure, wantsJsonFailureOutput } from "../operator/error-envelope.js";
import {
  decodeThreatModelReviewCandidate,
  decodeThreatModelReviewEvidenceRequest,
  GlabThreatModelReviewApi,
  ThreatModelReviewVerificationError,
  verifyThreatModelReviews,
} from "./threat-model-reviews.js";

const candidatePath = resolve("security/threat-model-reviews.v1.json");

async function main(): Promise<void> {
  const positional = process.argv.slice(2).filter((argument) => argument !== "--json");
  const evidencePath = positional[0];
  if (!evidencePath || positional.length !== 1) {
    reportFailure(new ThreatModelReviewVerificationError());
    return;
  }
  try {
    const [candidateBytes, requestBytes] = await Promise.all([
      readFile(candidatePath),
      readFile(resolve(evidencePath)),
    ]);
    const candidate = decodeThreatModelReviewCandidate(candidateBytes);
    const request = decodeThreatModelReviewEvidenceRequest(requestBytes);
    const verified = await verifyThreatModelReviews(
      candidate,
      request,
      new GlabThreatModelReviewApi(process.cwd(), candidate.gitlabHost, candidate.packagePath),
    );
    process.stdout.write(`${JSON.stringify(verified)}\n`);
  } catch (error) {
    reportFailure(error);
  }
}

function reportFailure(error: unknown): void {
  reportOperatorFailure(error, { json: wantsJsonFailureOutput() });
  process.exitCode = 1;
}

await main();
