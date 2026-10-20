// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";

/**
 * This old production program is retained as identity evidence, not selected
 * for execution or supplied as product-readable quality guidance. Its locator
 * strings are part of the old authenticated bytes; they grant no input access.
 * Keep this dependency-free contract shared by runtime and source generators.
 */
export const HISTORICAL_QUALITY_PROGRAM = Object.freeze({
  schemaVersion: 1,
  role: "historical-program-identity",
  qualityPath: "checks/validate_package.py",
  qualitySourcePath: "runtime-policy/checks/validate_package.py",
  barId: "check:validate-package",
  byteLength: 7984,
  sha256: "44aa60a611db852f2b350f54fa6d01d5e68bc5eae0c8bd094e6cf5750ddc9c60",
  policy: Object.freeze({
    qualityLockSha256: "c8331ef0fc2f43c7fac05b14a9477cc0271e5244ad5ca9b48b2db39513fdf244",
    manifestSha256: "141dbe3b51d64e3c2625f69516e0578ab9ccf7776ffbadc2ca371bc7d02ec9ac",
    skillLockSha256: "1e2e4ebfd85647c697aa14e82de32168d847bbfbca37f4d7c8323093352e5f33",
  }),
});

/** Supported selections are host-owned roles, never arbitrary locked bars. */
export const QUALITY_EXECUTION_RESOURCES = Object.freeze({
  evaluation: Object.freeze({
    scope: "quality",
    kind: "script",
    path: "checks/validate_documentation_quality_evaluation.py",
  }),
  "quality-score": Object.freeze({
    scope: "quality",
    kind: "script",
    path: "checks/validate_quality_score.py",
  }),
  "report-binding": Object.freeze({
    scope: "skill",
    kind: "script",
    skillId: "evaluate-document-quality",
    path: "scripts/validate_quality_report.py",
  }),
  derivation: Object.freeze({
    scope: "quality",
    kind: "script",
    path: "checks/derive_documentation_quality_evaluation.py",
  }),
  "decision-policy": Object.freeze({
    scope: "quality",
    kind: "module",
    path: "checks/quality_decision_policy.py",
    moduleName: "quality_decision_policy",
  }),
});

export class QualityResourceRoleError extends Error {
  constructor(code) {
    const messages = {
      "historical-program":
        "Historical quality program is retained only to authenticate saved policy identity. Use the source package validation command or an active quality evaluator instead.",
      "unsupported-execution":
        "Quality execution selection is unsupported. Select a declared active evaluator or rule module.",
      "invalid-identity":
        "Historical quality program identity changed or is unavailable. Restore the exact authenticated quality package before continuing.",
    };
    super(messages[code]);
    this.name = "QualityResourceRoleError";
    this.code = code;
  }
}

export function isHistoricalQualityProgramPath(path) {
  return path === HISTORICAL_QUALITY_PROGRAM.qualityPath;
}

export function qualityExecutionResource(selection) {
  if (
    selection === HISTORICAL_QUALITY_PROGRAM.barId ||
    selection === HISTORICAL_QUALITY_PROGRAM.qualityPath ||
    selection === HISTORICAL_QUALITY_PROGRAM.qualitySourcePath
  ) {
    throw new QualityResourceRoleError("historical-program");
  }
  if (typeof selection !== "string" || !Object.hasOwn(QUALITY_EXECUTION_RESOURCES, selection)) {
    throw new QualityResourceRoleError("unsupported-execution");
  }
  return QUALITY_EXECUTION_RESOURCES[selection];
}

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

/** Authenticate the one historical program together with its original pins. */
export function assertHistoricalQualityProgramIdentity(input) {
  try {
    if (
      !input ||
      typeof input !== "object" ||
      Array.isArray(input) ||
      Object.keys(input).sort().join("\n") !==
        ["manifestBytes", "programBytes", "qualityLockBytes", "skillLockBytes"].join("\n")
    ) {
      throw new Error();
    }
    const { programBytes, qualityLockBytes, manifestBytes, skillLockBytes } = input;
    const original = HISTORICAL_QUALITY_PROGRAM;
    if (
      programBytes.byteLength !== original.byteLength ||
      sha256(programBytes) !== original.sha256 ||
      sha256(qualityLockBytes) !== original.policy.qualityLockSha256 ||
      sha256(manifestBytes) !== original.policy.manifestSha256 ||
      sha256(skillLockBytes) !== original.policy.skillLockSha256
    )
      throw new Error();
    const lock = JSON.parse(Buffer.from(qualityLockBytes).toString("utf8"));
    const manifest = JSON.parse(Buffer.from(manifestBytes).toString("utf8"));
    const files = lock.files.filter((file) => file.path === original.qualityPath);
    const bars = lock.bars.filter((bar) => bar.id === original.barId);
    if (
      files.length !== 1 ||
      files[0].sha256 !== original.sha256 ||
      bars.length !== 1 ||
      bars[0].kind !== "check" ||
      bars[0].assetPath !== original.qualityPath ||
      manifest.quality.lockSha256 !== original.policy.qualityLockSha256 ||
      manifest.skillCrate.lockSha256 !== original.policy.skillLockSha256 ||
      manifest.quality.bundleSha256 !== lock.bundleSha256 ||
      !manifest.quality.barIds.includes(original.barId) ||
      manifest.bindingSha256 !==
        sha256(`${original.policy.skillLockSha256}\n${original.policy.qualityLockSha256}\n`)
    )
      throw new Error();
  } catch {
    throw new QualityResourceRoleError("invalid-identity");
  }
}
