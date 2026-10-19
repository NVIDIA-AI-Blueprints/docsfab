// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { canonicalDigest } from "../content-ir/index.js";
import { analyzeDocumentationImpact, type AnalyzeDocumentationImpactInput } from "./analyze.js";
import type { ImpactAnalysis } from "./contracts.js";

export interface FullCorpusSchedulePolicy {
  id: string;
  version: string;
  intervalMs: number;
  digest: string;
}

const SCHEDULE_VALUE = {
  id: "docsfab:full-corpus-impact-schedule",
  version: "1",
  intervalMs: 7 * 24 * 60 * 60 * 1_000,
};

export const DEFAULT_FULL_CORPUS_SCHEDULE: FullCorpusSchedulePolicy = Object.freeze({
  ...SCHEDULE_VALUE,
  digest: canonicalDigest(SCHEDULE_VALUE),
});

export interface ScheduledFullCorpusInput extends Omit<AnalyzeDocumentationImpactInput, "mode"> {
  observedAt: string;
  lastCompletedAt?: string;
  schedule?: FullCorpusSchedulePolicy;
}

export class FullCorpusScheduleError extends Error {
  public constructor(public readonly code: "invalid-schedule" | "not-due") {
    super(`Full-corpus impact analysis failed: ${code}.`);
    this.name = "FullCorpusScheduleError";
  }
}

/** Host scheduler seam: run a full analysis only when its digest-bound interval is due. */
export function runScheduledFullCorpusAnalysis(input: ScheduledFullCorpusInput): ImpactAnalysis {
  const schedule = input.schedule ?? DEFAULT_FULL_CORPUS_SCHEDULE;
  validateSchedule(schedule);
  const observedAt = timestamp(input.observedAt);
  const lastCompletedAt =
    input.lastCompletedAt === undefined ? undefined : timestamp(input.lastCompletedAt);
  if (lastCompletedAt !== undefined && observedAt - lastCompletedAt < schedule.intervalMs) {
    throw new FullCorpusScheduleError("not-due");
  }
  const {
    observedAt: _observedAt,
    lastCompletedAt: _lastCompletedAt,
    schedule: _schedule,
    ...analysisInput
  } = input;
  return analyzeDocumentationImpact({ ...analysisInput, mode: "full" });
}

function validateSchedule(schedule: FullCorpusSchedulePolicy): void {
  const { digest, ...value } = schedule;
  if (
    !schedule.id ||
    !schedule.version ||
    !Number.isSafeInteger(schedule.intervalMs) ||
    schedule.intervalMs <= 0 ||
    !/^[a-f0-9]{64}$/u.test(digest) ||
    canonicalDigest(value) !== digest
  ) {
    throw new FullCorpusScheduleError("invalid-schedule");
  }
}

function timestamp(value: string): number {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)) {
    throw new FullCorpusScheduleError("invalid-schedule");
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    throw new FullCorpusScheduleError("invalid-schedule");
  }
  return parsed;
}
