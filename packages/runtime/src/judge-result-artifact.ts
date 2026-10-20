// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Fail-closed binder for published judge-result.json evidence.
 *
 * Acceptance binding and campaign matching share this exact-key decode so
 * neither CLI can accept extra fields or a drifted semantic-rubric identity.
 */

import { SEMANTIC_RUBRIC_V1 } from "./quality-evaluation/semantic.js";

export const SEMANTIC_RUBRIC_ID = SEMANTIC_RUBRIC_V1.id;
export const SEMANTIC_RUBRIC_VERSION = SEMANTIC_RUBRIC_V1.version;

export const SEMANTIC_RUBRIC_IDENTITY = {
  id: SEMANTIC_RUBRIC_ID,
  version: SEMANTIC_RUBRIC_VERSION,
} as const;

export type SemanticRubricIdentity = typeof SEMANTIC_RUBRIC_IDENTITY;

export type JudgeResultParseKind = "acceptance" | "campaign-acceptance";

export type JudgeArtifactStatus = "passed" | "disagreed" | "skipped" | "error";

export interface PublishedJudgeModel {
  provider: string;
  model: string;
}

export interface PublishedJudgeEnvelope {
  status: JudgeArtifactStatus;
  rubric: SemanticRubricIdentity;
  model?: PublishedJudgeModel;
  score?: number;
}

export interface JudgeResultArtifact {
  schemaVersion: 1;
  acceptanceId: string;
  testedCommit: string;
  judgeProfileStatus: "current" | "stale" | "unknown";
  inputRecords: Array<{ id: string; sha256: string }>;
  fixture: { name: "MVP live readiness acceptance"; version: 1 };
  structural: { passed: true; recordCount: number };
  judge: PublishedJudgeEnvelope;
}

export interface LiveJudgeResult {
  status: JudgeArtifactStatus;
  rubric: { id: string; version: number };
  model?: PublishedJudgeModel;
  score?: number;
}

export interface BoundJudgeEnvelope {
  status: "passed" | "disagreed" | "error";
  rubric: SemanticRubricIdentity;
  model: PublishedJudgeModel;
  score?: number;
}

const ARTIFACT_KEYS = [
  "schemaVersion",
  "acceptanceId",
  "testedCommit",
  "judgeProfileStatus",
  "inputRecords",
  "fixture",
  "structural",
  "judge",
] as const;

const RECORD_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const REVISION = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const ACCEPTANCE_PROVIDER = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,127}$/u;
const ACCEPTANCE_MODEL = /^[A-Za-z0-9][A-Za-z0-9._:@+/~-]{0,255}$/u;
const CAMPAIGN_PROVIDER = /^[a-z0-9][a-z0-9._-]{0,63}$/u;
const CAMPAIGN_MODEL = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/u;
const ACCEPTANCE_STATUSES = new Set<string>(["passed", "disagreed", "skipped", "error"]);
const DECIDED_STATUSES = new Set<string>(["passed", "disagreed"]);
const ACCEPTANCE_PROFILES = new Set<string>(["current", "stale", "unknown"]);
const ACCEPTANCE_FIXTURE_NAME = "MVP live readiness acceptance";

export function parseJudgeResultArtifact(
  value: unknown,
  kind: JudgeResultParseKind = "acceptance",
): JudgeResultArtifact | undefined {
  const campaign = kind === "campaign-acceptance";
  const artifact = plainObject(value);
  if (!artifact || !hasExactKeys(artifact, ARTIFACT_KEYS) || artifact.schemaVersion !== 1) {
    return undefined;
  }
  if (typeof artifact.acceptanceId !== "string" || !RECORD_ID.test(artifact.acceptanceId)) {
    return undefined;
  }
  if (typeof artifact.testedCommit !== "string" || !REVISION.test(artifact.testedCommit)) {
    return undefined;
  }
  if (
    typeof artifact.judgeProfileStatus !== "string" ||
    (campaign
      ? artifact.judgeProfileStatus !== "current"
      : !ACCEPTANCE_PROFILES.has(artifact.judgeProfileStatus))
  ) {
    return undefined;
  }
  const inputRecords = parseInputRecords(artifact.inputRecords, campaign ? 2 : undefined);
  if (!inputRecords) return undefined;
  const fixture = parseAcceptanceFixture(artifact.fixture);
  const structural = parseStructural(artifact.structural, campaign ? 2 : inputRecords.length);
  const judge = parsePublishedJudge(artifact.judge, {
    requireDecided: campaign,
    provider: campaign ? CAMPAIGN_PROVIDER : ACCEPTANCE_PROVIDER,
    model: campaign ? CAMPAIGN_MODEL : ACCEPTANCE_MODEL,
  });
  if (!fixture || !structural || !judge) return undefined;
  return {
    schemaVersion: 1,
    acceptanceId: artifact.acceptanceId,
    testedCommit: artifact.testedCommit,
    judgeProfileStatus: artifact.judgeProfileStatus as JudgeResultArtifact["judgeProfileStatus"],
    inputRecords,
    fixture,
    structural,
    judge,
  };
}

/** Project a live judge outcome into the published envelope, or name the fail-closed code. */
export function bindJudgeResultEnvelope(
  judge: LiveJudgeResult | undefined,
):
  | { ok: true; envelope: BoundJudgeEnvelope }
  | { ok: false; code: "judge-result-missing" | "judge-result-invalid" } {
  if (!judge || judge.status === "skipped") {
    return { ok: false, code: "judge-result-missing" };
  }
  if (
    judge.rubric.id !== SEMANTIC_RUBRIC_ID ||
    judge.rubric.version !== SEMANTIC_RUBRIC_VERSION ||
    !judge.model
  ) {
    return { ok: false, code: "judge-result-invalid" };
  }
  const decided = judge.status === "passed" || judge.status === "disagreed";
  return {
    ok: true,
    envelope: {
      status: judge.status,
      rubric: { ...SEMANTIC_RUBRIC_IDENTITY },
      model: judge.model,
      ...(decided ? { score: judge.score } : {}),
    },
  };
}

function parsePublishedJudge(
  value: unknown,
  options: { requireDecided: boolean; provider: RegExp; model: RegExp },
): PublishedJudgeEnvelope | undefined {
  const judge = plainObject(value);
  if (!judge) return undefined;
  if (options.requireDecided) {
    if (!hasExactKeys(judge, ["status", "rubric", "model", "score"])) return undefined;
  } else if (
    Object.keys(judge).some(
      (key) => key !== "status" && key !== "rubric" && key !== "model" && key !== "score",
    )
  ) {
    return undefined;
  }
  if (typeof judge.status !== "string") return undefined;
  const allowed = options.requireDecided ? DECIDED_STATUSES : ACCEPTANCE_STATUSES;
  const status = parseJudgeStatus(judge.status, allowed);
  if (!status) return undefined;
  const rubric = parseSemanticRubric(judge.rubric);
  if (!rubric) return undefined;
  const decided = status === "passed" || status === "disagreed";
  let model: PublishedJudgeModel | undefined;
  if (judge.model !== undefined || options.requireDecided) {
    model = parseJudgeModel(judge.model, options.provider, options.model);
    if (!model) return undefined;
  }
  if (decided) {
    if (
      typeof judge.score !== "number" ||
      !Number.isFinite(judge.score) ||
      judge.score < 0 ||
      judge.score > 1 ||
      !model
    ) {
      return undefined;
    }
    return { status, rubric, model, score: judge.score };
  }
  if (judge.score !== undefined) return undefined;
  return { status, rubric, ...(model ? { model } : {}) };
}

function parseSemanticRubric(value: unknown): SemanticRubricIdentity | undefined {
  const rubric = plainObject(value);
  if (
    !rubric ||
    !hasExactKeys(rubric, ["id", "version"]) ||
    rubric.id !== SEMANTIC_RUBRIC_ID ||
    rubric.version !== SEMANTIC_RUBRIC_VERSION
  ) {
    return undefined;
  }
  return { ...SEMANTIC_RUBRIC_IDENTITY };
}

function parseJudgeModel(
  value: unknown,
  providerPattern: RegExp,
  modelPattern: RegExp,
): PublishedJudgeModel | undefined {
  const model = plainObject(value);
  if (
    !model ||
    !hasExactKeys(model, ["provider", "model"]) ||
    typeof model.provider !== "string" ||
    !providerPattern.test(model.provider) ||
    typeof model.model !== "string" ||
    !modelPattern.test(model.model) ||
    model.model.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    return undefined;
  }
  return { provider: model.provider, model: model.model };
}

function parseInputRecords(
  value: unknown,
  expectedCount: number | undefined,
): Array<{ id: string; sha256: string }> | undefined {
  if (!Array.isArray(value) || (expectedCount !== undefined && value.length !== expectedCount)) {
    return undefined;
  }
  const records: Array<{ id: string; sha256: string }> = [];
  for (const item of value) {
    const record = plainObject(item);
    if (
      !record ||
      !hasExactKeys(record, ["id", "sha256"]) ||
      typeof record.id !== "string" ||
      !RECORD_ID.test(record.id) ||
      typeof record.sha256 !== "string" ||
      !SHA256.test(record.sha256)
    ) {
      return undefined;
    }
    records.push({ id: record.id, sha256: record.sha256 });
  }
  if (
    new Set(records.map((record) => record.id)).size !== records.length ||
    new Set(records.map((record) => record.sha256)).size !== records.length
  ) {
    return undefined;
  }
  return records;
}

function parseAcceptanceFixture(value: unknown): JudgeResultArtifact["fixture"] | undefined {
  const fixture = plainObject(value);
  if (
    !fixture ||
    !hasExactKeys(fixture, ["name", "version"]) ||
    fixture.name !== ACCEPTANCE_FIXTURE_NAME ||
    fixture.version !== 1
  ) {
    return undefined;
  }
  return { name: ACCEPTANCE_FIXTURE_NAME, version: 1 };
}

function parseStructural(
  value: unknown,
  recordCount: number,
): JudgeResultArtifact["structural"] | undefined {
  const structural = plainObject(value);
  if (
    !structural ||
    !hasExactKeys(structural, ["passed", "recordCount"]) ||
    structural.passed !== true ||
    structural.recordCount !== recordCount
  ) {
    return undefined;
  }
  return { passed: true, recordCount };
}

function parseJudgeStatus(value: string, allowed: Set<string>): JudgeArtifactStatus | undefined {
  if (!allowed.has(value)) return undefined;
  return value as JudgeArtifactStatus;
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).sort().join("\n") === [...keys].sort().join("\n");
}

function plainObject(value: unknown): Record<string, unknown> | undefined {
  return value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
    ? (value as Record<string, unknown>)
    : undefined;
}
