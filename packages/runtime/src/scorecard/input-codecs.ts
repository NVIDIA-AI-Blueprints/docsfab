// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type {
  ScorecardAcceptanceEvidence,
  ScorecardCampaignDeclarationV1,
  ScorecardJudgeDisposition,
} from "../scorecard.js";
import { parseAcceptanceCheckLimitationRecord } from "../acceptance-check-limitations.js";
import {
  isScorecardIsoDate as validDate,
  isScorecardIsoTimestamp as validTimestamp,
  isScorecardSafeId,
  isScorecardSha256,
} from "../scorecard-validators.js";
import { canonical, REQUIRED_RECORDS, REVISION, ScorecardInputError } from "./value-primitives.js";

const SAFE_MODEL = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/u;
const SAFE_JSON_LEAF = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.json$/u;

function object(value: unknown): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new ScorecardInputError("invalid-campaign");
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): void {
  const expected = [...keys].sort();
  const actual = Object.keys(value).sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new ScorecardInputError("invalid-campaign");
  }
}

function safeOwner(value: unknown): value is string {
  return typeof value === "string" && /^[a-z0-9][a-z0-9-]{1,63}$/u.test(value);
}

export function parseScorecardCampaignDeclaration(value: unknown): ScorecardCampaignDeclarationV1 {
  const root = object(value);
  exactKeys(root, [
    "schemaVersion",
    "campaignId",
    "evaluatedAt",
    "testedCommit",
    "records",
    "judge",
    "remainingWork",
  ]);
  if (
    root.schemaVersion !== 1 ||
    typeof root.campaignId !== "string" ||
    !isScorecardSafeId(root.campaignId) ||
    !validTimestamp(root.evaluatedAt) ||
    typeof root.testedCommit !== "string" ||
    !REVISION.test(root.testedCommit) ||
    !Array.isArray(root.records) ||
    root.records.length !== REQUIRED_RECORDS ||
    !Array.isArray(root.remainingWork) ||
    root.remainingWork.length !== 2
  ) {
    throw new ScorecardInputError("invalid-campaign");
  }
  const records = root.records
    .map((item) => {
      const record = object(item);
      exactKeys(record, ["slot", "file", "id", "sha256"]);
      if (
        !Number.isSafeInteger(record.slot) ||
        Number(record.slot) < 1 ||
        Number(record.slot) > REQUIRED_RECORDS ||
        typeof record.file !== "string" ||
        !SAFE_JSON_LEAF.test(record.file) ||
        typeof record.id !== "string" ||
        !isScorecardSafeId(record.id) ||
        record.file !== `${record.id}.json` ||
        typeof record.sha256 !== "string" ||
        !isScorecardSha256(record.sha256)
      ) {
        throw new ScorecardInputError("invalid-campaign");
      }
      return {
        slot: Number(record.slot),
        file: record.file,
        id: record.id,
        sha256: record.sha256,
      };
    })
    .sort((left, right) => left.slot - right.slot);
  for (const key of ["slot", "file", "id", "sha256"] as const) {
    if (new Set(records.map((record) => String(record[key]))).size !== REQUIRED_RECORDS) {
      throw new ScorecardInputError("invalid-campaign");
    }
  }
  if (records.some((record, index) => record.slot !== index + 1)) {
    throw new ScorecardInputError("invalid-campaign");
  }
  const judge = parseJudge(root.judge);
  const remainingWork = root.remainingWork
    .map((item) => {
      const work = object(item);
      exactKeys(work, ["issue", "scope", "owner", "reason"]);
      if (
        !Number.isSafeInteger(work.issue) ||
        Number(work.issue) <= 0 ||
        (work.scope !== "issue-28-dogfood" && work.scope !== "shared-service") ||
        work.owner !== "docsfab-maintainers" ||
        !["product-validation", "post-mvp-scope", "external-governance"].includes(
          String(work.reason),
        ) ||
        (work.scope === "issue-28-dogfood" && work.issue !== 28)
      ) {
        throw new ScorecardInputError("invalid-campaign");
      }
      return {
        issue: Number(work.issue),
        scope: work.scope as "issue-28-dogfood" | "shared-service",
        owner: work.owner as string,
        reason: work.reason as "product-validation" | "post-mvp-scope" | "external-governance",
      };
    })
    .sort(
      (left, right) =>
        left.issue - right.issue ||
        (left.scope < right.scope ? -1 : left.scope > right.scope ? 1 : 0),
    );
  if (
    !remainingWork.some((item) => item.issue === 28 && item.scope === "issue-28-dogfood") ||
    !remainingWork.some((item) => item.issue === 7 && item.scope === "shared-service") ||
    !remainingWork.some((item) => item.issue === 28 && item.reason === "product-validation") ||
    !remainingWork.some((item) => item.issue === 7 && item.reason === "external-governance")
  ) {
    throw new ScorecardInputError("invalid-campaign");
  }
  return {
    schemaVersion: 1,
    campaignId: root.campaignId,
    evaluatedAt: root.evaluatedAt,
    testedCommit: root.testedCommit,
    records,
    judge,
    remainingWork,
  };
}

function parseJudge(value: unknown): ScorecardJudgeDisposition {
  const judge = object(value);
  if (judge.status === "skipped") {
    exactKeys(judge, ["status", "owner", "issue", "reason", "reviewOn"]);
    if (
      !safeOwner(judge.owner) ||
      judge.issue !== 5 ||
      (judge.reason !== "judge-destination-not-approved" &&
        judge.reason !== "judge-evidence-pending") ||
      !validDate(judge.reviewOn)
    ) {
      throw new ScorecardInputError("invalid-campaign");
    }
    return {
      status: "skipped",
      owner: judge.owner,
      issue: 5,
      reason: judge.reason,
      reviewOn: judge.reviewOn,
    };
  }
  if (judge.status !== "passed" && judge.status !== "disagreed" && judge.status !== "error") {
    throw new ScorecardInputError("invalid-campaign");
  }
  const decided = judge.status === "passed" || judge.status === "disagreed";
  exactKeys(
    judge,
    decided
      ? ["status", "rubric", "model", "score", "evidenceSha256"]
      : ["status", "rubric", "model", "evidenceSha256"],
  );
  const rubric = object(judge.rubric);
  exactKeys(rubric, ["id", "version"]);
  if (
    rubric.id !== "docsfab.semantic-evidence-quality" ||
    rubric.version !== 1 ||
    typeof judge.evidenceSha256 !== "string" ||
    !isScorecardSha256(judge.evidenceSha256)
  ) {
    throw new ScorecardInputError("invalid-campaign");
  }
  const model = object(judge.model);
  exactKeys(model, ["provider", "model"]);
  if (
    typeof model.provider !== "string" ||
    !isScorecardSafeId(model.provider) ||
    typeof model.model !== "string" ||
    !safeModelId(model.model) ||
    (decided &&
      (typeof judge.score !== "number" ||
        !Number.isFinite(judge.score) ||
        judge.score < 0 ||
        judge.score > 1))
  ) {
    throw new ScorecardInputError("invalid-campaign");
  }
  return {
    status: judge.status,
    rubric: { id: rubric.id, version: 1 },
    model: { provider: model.provider, model: model.model },
    ...(decided ? { score: judge.score as number } : {}),
    evidenceSha256: judge.evidenceSha256,
  };
}

function safeModelId(value: string): boolean {
  return (
    SAFE_MODEL.test(value) &&
    value.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..")
  );
}

export function parseScorecardAcceptanceEvidence(
  value: unknown,
  sha256: string,
): ScorecardAcceptanceEvidence {
  if (!isScorecardSha256(sha256)) throw new ScorecardInputError("invalid-acceptance");
  const manifest = object(value);
  const allowed = new Set([
    "schemaVersion",
    "acceptanceId",
    "testedCommit",
    "generatedAt",
    "passed",
    "gates",
    "modelProfiles",
    "phases",
    "checkLimitations",
    "records",
    "judge",
    "rawRecordDirectory",
    "error",
  ]);
  if (
    Object.keys(manifest).some((key) => !allowed.has(key)) ||
    (manifest.checkLimitations !== undefined &&
      !parseAcceptanceCheckLimitationRecord(manifest.checkLimitations)) ||
    manifest.schemaVersion !== 1 ||
    typeof manifest.acceptanceId !== "string" ||
    !isScorecardSafeId(manifest.acceptanceId) ||
    !validTimestamp(manifest.generatedAt) ||
    typeof manifest.testedCommit !== "string" ||
    !REVISION.test(manifest.testedCommit) ||
    typeof manifest.passed !== "boolean"
  ) {
    throw new ScorecardInputError("invalid-acceptance");
  }
  const gates = object(manifest.gates);
  const profiles = object(manifest.modelProfiles);
  if (
    Object.keys(gates).some((key) => key !== "live" && key !== "judge") ||
    typeof gates.live !== "boolean" ||
    typeof gates.judge !== "boolean" ||
    Object.keys(profiles).some((key) => key !== "policy" && key !== "judge") ||
    !["current", "stale", "unknown"].includes(String(profiles.policy)) ||
    !Array.isArray(manifest.phases) ||
    !Array.isArray(manifest.records) ||
    manifest.rawRecordDirectory !== "operator-selected acceptance directory"
  ) {
    throw new ScorecardInputError("invalid-acceptance");
  }
  const phaseIds = [
    "clean-install",
    "check",
    "build",
    "catalog",
    "offline-doctor",
    "live-doctor",
    "live-fixture-readiness",
    "live-self-readiness",
    "judge-smoke",
    "source-integrity",
    "workspace-cleanup",
  ];
  const phases = manifest.phases.map((item) => {
    const phase = object(item);
    const allowedPhaseKeys = new Set([
      "id",
      "status",
      "networked",
      "commit",
      "modelProfileStatus",
      "judgeProfileStatus",
      "durationMs",
      "reason",
    ]);
    if (
      Object.keys(phase).some((key) => !allowedPhaseKeys.has(key)) ||
      typeof phase.id !== "string" ||
      !phaseIds.includes(phase.id) ||
      !["passed", "failed", "skipped"].includes(String(phase.status)) ||
      typeof phase.networked !== "boolean" ||
      phase.commit !== manifest.testedCommit ||
      !["current", "stale", "unknown"].includes(String(phase.modelProfileStatus)) ||
      !Number.isSafeInteger(phase.durationMs) ||
      Number(phase.durationMs) < 0 ||
      (phase.reason !== undefined &&
        (typeof phase.reason !== "string" ||
          phase.reason.length === 0 ||
          phase.reason.length > 256))
    ) {
      throw new ScorecardInputError("invalid-acceptance");
    }
    return phase;
  });
  if (
    new Set(phases.map((phase) => phase.id)).size !== phases.length ||
    phaseIds.some((id) => !phases.some((phase) => phase.id === id)) ||
    phases.some(
      (phase) => phase.id !== "judge-smoke" && phase.modelProfileStatus !== profiles.policy,
    ) ||
    phases.some(
      (phase) =>
        phase.networked !==
        ["live-doctor", "live-fixture-readiness", "live-self-readiness", "judge-smoke"].includes(
          String(phase.id),
        ),
    )
  ) {
    throw new ScorecardInputError("invalid-acceptance");
  }
  const acceptedRecords = validAcceptanceRecords(manifest.records, manifest.testedCommit);
  if (!acceptedRecords) throw new ScorecardInputError("invalid-acceptance");
  if (manifest.passed) {
    if (
      !gates.live ||
      manifest.error !== undefined ||
      phases.some((phase) =>
        phase.id === "judge-smoke"
          ? gates.judge
            ? phase.status !== "passed"
            : phase.status !== "skipped"
          : phase.status !== "passed",
      ) ||
      (gates.judge ? !manifest.judge : manifest.judge !== undefined)
    ) {
      throw new ScorecardInputError("invalid-acceptance");
    }
  } else if (!phases.some((phase) => phase.status === "failed")) {
    throw new ScorecardInputError("invalid-acceptance");
  }
  const judge =
    manifest.judge === undefined
      ? undefined
      : parseAcceptanceJudge(manifest.judge, {
          testedCommit: manifest.testedCommit,
          acceptanceId: manifest.acceptanceId,
          records: manifest.records,
          judgeProfileStatus: profiles.judge,
        });
  if (manifest.passed && judge?.status === "error") {
    throw new ScorecardInputError("invalid-acceptance");
  }
  return {
    sha256,
    testedCommit: manifest.testedCommit,
    generatedAt: manifest.generatedAt,
    passed: manifest.passed,
    live: gates.live,
    policyProfileStatus: profiles.policy as "current" | "stale" | "unknown",
    policyModel: acceptedRecords.policyModel,
    ...(judge ? { judge } : {}),
  };
}

function parseAcceptanceJudge(
  value: unknown,
  expected: {
    testedCommit: string;
    acceptanceId: string;
    records: unknown[];
    judgeProfileStatus: unknown;
  },
): Exclude<ScorecardJudgeDisposition, { status: "skipped" }> {
  const artifact = object(value);
  const allowed = new Set([
    "file",
    "sha256",
    "acceptanceId",
    "testedCommit",
    "judgeProfileStatus",
    "inputRecords",
    "fixture",
    "structural",
    "judge",
  ]);
  if (
    Object.keys(artifact).some((key) => !allowed.has(key)) ||
    artifact.file !== "judge-result.json" ||
    typeof artifact.sha256 !== "string" ||
    !isScorecardSha256(artifact.sha256) ||
    artifact.testedCommit !== expected.testedCommit ||
    artifact.acceptanceId !== expected.acceptanceId ||
    artifact.judgeProfileStatus !== expected.judgeProfileStatus ||
    expected.judgeProfileStatus !== "current" ||
    !Array.isArray(artifact.inputRecords) ||
    artifact.inputRecords.length !== 2 ||
    !artifact.fixture ||
    typeof artifact.fixture !== "object" ||
    !artifact.structural ||
    typeof artifact.structural !== "object"
  ) {
    throw new ScorecardInputError("invalid-acceptance");
  }
  const expectedInputs = expected.records
    .map((item) => {
      const record = item as Record<string, unknown>;
      return `${String(record.id)}:${String(record.sha256)}`;
    })
    .sort();
  const actualInputs = artifact.inputRecords
    .map((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        throw new ScorecardInputError("invalid-acceptance");
      }
      const record = item as Record<string, unknown>;
      if (
        Object.keys(record).some((key) => key !== "id" && key !== "sha256") ||
        typeof record.id !== "string" ||
        !isScorecardSafeId(record.id) ||
        typeof record.sha256 !== "string" ||
        !isScorecardSha256(record.sha256)
      ) {
        throw new ScorecardInputError("invalid-acceptance");
      }
      return `${record.id}:${record.sha256}`;
    })
    .sort();
  const fixture = artifact.fixture as Record<string, unknown>;
  const structural = artifact.structural as Record<string, unknown>;
  if (
    JSON.stringify(actualInputs) !== JSON.stringify(expectedInputs) ||
    fixture.name !== "MVP live readiness acceptance" ||
    fixture.version !== 1 ||
    structural.passed !== true ||
    structural.recordCount !== 2
  ) {
    throw new ScorecardInputError("invalid-acceptance");
  }
  const judge = object(artifact.judge);
  const rubric = object(judge.rubric);
  if (
    !["passed", "disagreed", "error"].includes(String(judge.status)) ||
    rubric.id !== "docsfab.semantic-evidence-quality" ||
    rubric.version !== 1
  ) {
    throw new ScorecardInputError("invalid-acceptance");
  }
  if (judge.status === "error") {
    const model = object(judge.model);
    if (
      typeof model.provider !== "string" ||
      !isScorecardSafeId(model.provider) ||
      typeof model.model !== "string" ||
      !safeModelId(model.model)
    ) {
      throw new ScorecardInputError("invalid-acceptance");
    }
    return {
      status: "error",
      rubric: { id: "docsfab.semantic-evidence-quality", version: 1 },
      model: { provider: model.provider, model: model.model },
      evidenceSha256: artifact.sha256,
    };
  }
  const model = object(judge.model);
  if (
    typeof model.provider !== "string" ||
    !isScorecardSafeId(model.provider) ||
    typeof model.model !== "string" ||
    !safeModelId(model.model) ||
    typeof judge.score !== "number" ||
    !Number.isFinite(judge.score) ||
    judge.score < 0 ||
    judge.score > 1
  ) {
    throw new ScorecardInputError("invalid-acceptance");
  }
  return {
    status: judge.status as "passed" | "disagreed",
    rubric: { id: "docsfab.semantic-evidence-quality", version: 1 },
    model: { provider: model.provider, model: model.model },
    score: judge.score,
    evidenceSha256: artifact.sha256,
  };
}

function validAcceptanceRecords(
  value: unknown[],
  testedCommit: string,
):
  | {
      policyModel: { provider: string; model: string; profileSha256: string };
    }
  | undefined {
  if (value.length !== 2) return undefined;
  const records: Array<Record<string, unknown>> = [];
  const models: Array<{ provider: string; model: string; profileSha256: string }> = [];
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return undefined;
    const record = item as Record<string, unknown>;
    const allowed = new Set([
      "file",
      "sha256",
      "id",
      "workflow",
      "status",
      "revision",
      "scanDisposition",
      "ruleIds",
      "models",
    ]);
    if (
      Object.keys(record).some((key) => !allowed.has(key)) ||
      typeof record.file !== "string" ||
      !SAFE_JSON_LEAF.test(record.file) ||
      typeof record.sha256 !== "string" ||
      !isScorecardSha256(record.sha256) ||
      typeof record.id !== "string" ||
      !isScorecardSafeId(record.id) ||
      record.file !== `${record.id}.json` ||
      record.workflow !== "readiness" ||
      record.status !== "succeeded" ||
      typeof record.revision !== "string" ||
      !REVISION.test(record.revision) ||
      !Array.isArray(record.ruleIds) ||
      record.ruleIds.some((rule) => typeof rule !== "string" || !isScorecardSafeId(rule)) ||
      !Array.isArray(record.models) ||
      record.models.length !== 1
    )
      return undefined;
    const model = record.models[0];
    if (!model || typeof model !== "object" || Array.isArray(model)) return undefined;
    const identity = model as Record<string, unknown>;
    if (
      Object.keys(identity).some(
        (key) => key !== "provider" && key !== "model" && key !== "profileSha256",
      ) ||
      typeof identity.provider !== "string" ||
      !isScorecardSafeId(identity.provider) ||
      typeof identity.model !== "string" ||
      !safeModelId(identity.model) ||
      typeof identity.profileSha256 !== "string" ||
      !isScorecardSha256(identity.profileSha256)
    )
      return undefined;
    models.push({
      provider: identity.provider,
      model: identity.model,
      profileSha256: identity.profileSha256,
    });
    records.push(record);
  }
  if (
    new Set(records.map((record) => record.id)).size !== 2 ||
    new Set(records.map((record) => record.sha256)).size !== 2 ||
    models.some((model) => canonical(model) !== canonical(models[0]))
  )
    return undefined;
  // The whole-repository scan is advisory only: both the self run (blocked
  // findings against DocsFab's tracked credential fixtures) and the clean
  // fixture run record the advisory disposition and no override authorization.
  const self = records.find((record) => record.revision === testedCommit);
  const fixture = records.find((record) => record.revision !== testedCommit);
  return self &&
    fixture &&
    self.scanDisposition === "advisory" &&
    (self.ruleIds as unknown[]).length > 0 &&
    fixture.scanDisposition === "advisory" &&
    (fixture.ruleIds as unknown[]).length === 0
    ? { policyModel: models[0]! }
    : undefined;
}

export function parseScorecardJudgeArtifact(
  value: unknown,
  sha256: string,
  declaration: ScorecardCampaignDeclarationV1,
): Exclude<ScorecardJudgeDisposition, { status: "skipped" }> {
  if (!isScorecardSha256(sha256)) throw new ScorecardInputError("invalid-campaign");
  const artifact = object(value);
  exactKeys(artifact, [
    "schemaVersion",
    "campaignId",
    "testedCommit",
    "inputRecords",
    "fixture",
    "structural",
    "judge",
  ]);
  if (
    artifact.schemaVersion !== 1 ||
    artifact.campaignId !== declaration.campaignId ||
    artifact.testedCommit !== declaration.testedCommit ||
    !Array.isArray(artifact.inputRecords) ||
    artifact.inputRecords.length !== REQUIRED_RECORDS
  ) {
    throw new ScorecardInputError("invalid-campaign");
  }
  const actualInputs = artifact.inputRecords
    .map((item) => {
      const input = object(item);
      exactKeys(input, ["id", "sha256"]);
      if (
        typeof input.id !== "string" ||
        !isScorecardSafeId(input.id) ||
        typeof input.sha256 !== "string" ||
        !isScorecardSha256(input.sha256)
      ) {
        throw new ScorecardInputError("invalid-campaign");
      }
      return { id: input.id, sha256: input.sha256 };
    })
    .sort((left, right) => left.id.localeCompare(right.id));
  const expectedInputs = declaration.records
    .map(({ id, sha256: recordSha256 }) => ({
      id,
      sha256: recordSha256,
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
  if (canonical(actualInputs) !== canonical(expectedInputs)) {
    throw new ScorecardInputError("invalid-campaign");
  }
  const fixture = object(artifact.fixture);
  exactKeys(fixture, ["name", "version"]);
  const structural = object(artifact.structural);
  exactKeys(structural, ["passed", "recordCount"]);
  if (
    fixture.name !== "Multi-turn governed live readiness" ||
    fixture.version !== 1 ||
    structural.passed !== true ||
    structural.recordCount !== REQUIRED_RECORDS
  ) {
    throw new ScorecardInputError("invalid-campaign");
  }
  const judge = object(artifact.judge);
  return parseJudge({ ...judge, evidenceSha256: sha256 }) as Exclude<
    ScorecardJudgeDisposition,
    { status: "skipped" }
  >;
}
