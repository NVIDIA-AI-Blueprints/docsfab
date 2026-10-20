// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, rm } from "node:fs/promises";
import { resolve } from "node:path";

import { limit } from "../../config/limits.js";
import { canonicalJson, sha256 } from "../../content-ir/canonical.js";
import { createContractKit } from "../../contract-kit/index.js";
import { parseJsonEvidence } from "../../json-evidence.js";
import { hostCheckError } from "../quality-check-rejections.js";
import { runBoundedChild } from "./bounded-child.js";
import { ensurePrivateDirectory, verifyRegularDigest, writePrivate } from "./private-files.js";
import { qualityExecutionResource } from "../../quality-pack/resource-roles.js";
import { qualityExecutionPath } from "../../quality-pack/resource-access.js";

/** The deriver's input (`derive_documentation_quality_evaluation.py`). */
export interface QualityDerivationInputV1 {
  readonly schemaVersion: 1;
  readonly kind: "docsfab-quality-derivation-input";
  readonly evaluation: Record<string, unknown>;
  readonly qualityScore: Record<string, unknown> | null;
  /** The gates each dimension or constraint record attributed (O4), by record key. */
  readonly gateAttribution: Readonly<Record<string, readonly string[]>>;
  /** The model's residual decision for a layer the rules leave open (O2), by layer. */
  readonly layerShortfallDecisions: Readonly<Record<string, string>>;
  /** Full-artifact transports provide layer and overall gate attribution directly. */
  readonly textPathGates?: {
    readonly layers: Readonly<Record<string, readonly string[]>>;
    readonly overall: readonly string[];
  } | null;
}

/** Content-free evidence of one derivation spawn: digests of its inputs and output. */
export interface QualityDerivationReceiptV1 {
  readonly program: "python3";
  readonly scriptSha256: string;
  /** The input file, the rule module, and the profile, in that order. */
  readonly inputPayloadSha256s: readonly string[];
  readonly exitCode: number | null;
  readonly outputSha256: string;
}

/** What the deriver decided: every derived member, or the layers its rules leave open. */
export type QualityDerivationOutcomeV1 =
  | {
      readonly status: "derived";
      readonly evaluation: Record<string, unknown>;
      readonly qualityScore: Record<string, unknown> | null;
      readonly hostLimitations: readonly string[];
      readonly coherenceLabels: readonly string[];
      readonly ignoredShortfallDecisions: readonly string[];
    }
  | {
      /** The rules leave these layers open; their residual is requested (O2, §3.4). */
      readonly status: "open";
      readonly openLayers: readonly string[];
      readonly ignoredShortfallDecisions: readonly string[];
    };

export type QualityDerivationV1 = QualityDerivationOutcomeV1 & {
  readonly receipt: QualityDerivationReceiptV1;
};

export type QualityDerivationFailureReason =
  | "input-not-screened"
  | "input-integrity"
  | "deriver-unavailable"
  | "deriver-timeout"
  | "deriver-exit"
  | "output-missing"
  | "output-not-regular"
  | "output-oversize"
  | "output-undecodable"
  | "output-contract";

/**
 * `quality-derivation-failed`: the locked deriver did not produce a usable
 * derivation. A host-kind, terminal stop that means a DocsFab defect (design
 * §1.2, N12); the reason is a closed code, never deriver or model text.
 */
export class QualityDerivationError extends Error {
  public readonly code = "quality-derivation-failed" as const;
  public readonly failureClass = "infrastructure" as const;
  public readonly retryable = false;

  public constructor(public readonly reason: QualityDerivationFailureReason) {
    super(
      `Quality derivation failed (${reason}), which is a DocsFab defect. Report it with the retained run; nothing is retried as model content.`,
    );
    this.name = "QualityDerivationError";
  }
}

export function derivationFailure(reason: QualityDerivationFailureReason): QualityDerivationError {
  return new QualityDerivationError(reason);
}

export interface QualityDerivationExecutionOptions {
  readonly qualityRoot: string;
  readonly temporaryRoot: string;
  readonly qualityFiles: readonly { readonly path: string; readonly sha256: string }[];
  readonly executable: string;
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
}

const DERIVER = qualityExecutionResource("derivation").path;
const RULE_MODULE = qualityExecutionResource("decision-policy").path;
const PROFILE_PATH = "profiles/docsfab-documentation-quality/profile.json";

/** Run one screened derivation using the host's already-selected, locked inputs. */
export async function deriveQuality(
  derivationInput: QualityDerivationInputV1,
  options: QualityDerivationExecutionOptions,
): Promise<QualityDerivationV1> {
  const failWith = (reason: QualityDerivationFailureReason): never => {
    throw new QualityDerivationError(reason);
  };
  const inputBytes = Buffer.from(
    canonicalJson(
      (() => {
        try {
          derivationScreen.assertInert(derivationInput);
          derivationScreen.rejectCredentials(derivationInput);
          return derivationInput;
        } catch {
          return failWith("input-not-screened");
        }
      })(),
    ),
    "utf8",
  );
  let locked: { deriver: string; ruleModule: string; profile: string };
  try {
    locked = {
      deriver: lockedQualityFile(options.qualityFiles, DERIVER),
      ruleModule: lockedQualityFile(options.qualityFiles, RULE_MODULE),
      profile: lockedQualityFile(options.qualityFiles, PROFILE_PATH),
    };
  } catch {
    return failWith("input-integrity");
  }
  const directory = resolve(options.temporaryRoot, `quality-derive-${randomUUID()}`);
  try {
    try {
      await ensurePrivateDirectory(options.temporaryRoot);
      await mkdir(directory, { recursive: false, mode: 0o700 });
    } catch {
      return failWith("input-integrity");
    }
    const inputPath = resolve(directory, "derivation-input.json");
    const outputPath = resolve(directory, "derivation-output.json");
    const inputSha256 = sha256(inputBytes);
    const profilePath = resolve(options.qualityRoot, PROFILE_PATH);
    const deriverPath = qualityExecutionPath("derivation", "script", options);
    try {
      await writePrivate(inputPath, inputBytes);
      await verifyRegularDigest(deriverPath, locked.deriver);
      await verifyRegularDigest(
        qualityExecutionPath("decision-policy", "module", options),
        locked.ruleModule,
      );
      await verifyRegularDigest(profilePath, locked.profile);
      await verifyRegularDigest(inputPath, inputSha256);
    } catch {
      return failWith("input-integrity");
    }
    const result = await runBoundedChild({
      executable: options.executable,
      args: [deriverPath, inputPath, "--profile", profilePath, "--output", outputPath],
      cwd: directory,
      timeoutMs: options.timeoutMs,
      maxOutputBytes: options.maxOutputBytes,
    });
    if (result.outcome === "unavailable") return failWith("deriver-unavailable");
    if (result.timedOut) return failWith("deriver-timeout");
    if (result.outcome !== "passed") return failWith("deriver-exit");
    const bytes = await readBoundedRegular(
      outputPath,
      limit("qualityValidator.maxDerivedArtifactBytes").value,
    );
    if (typeof bytes === "string") return failWith(bytes);
    let output: unknown;
    try {
      output = parseJsonEvidence(bytes);
    } catch {
      return failWith("output-undecodable");
    }
    const derivation = decodeDerivationOutput(output) ?? failWith("output-contract");
    return {
      ...derivation,
      receipt: {
        program: "python3",
        scriptSha256: locked.deriver,
        inputPayloadSha256s: [inputSha256, locked.ruleModule, locked.profile],
        exitCode: result.exitCode,
        outputSha256: sha256(bytes),
      },
    };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function lockedQualityFile(
  qualityFiles: QualityDerivationExecutionOptions["qualityFiles"],
  path: string,
): string {
  const matches = qualityFiles.filter((file) => file.path === path);
  if (matches.length !== 1) throw hostCheckError("validator-lock-entry-missing");
  return matches[0]!.sha256;
}

const derivationScreen = createContractKit({
  // The screen's refusal is the coded derivation failure itself.
  fail: () => {
    throw derivationFailure("input-not-screened");
  },
  inertMode: "strict",
  codes: {
    invalidShape: "input-not-screened",
    invalidValue: "input-not-screened",
    digestMismatch: "input-not-screened",
    credentialMaterial: "input-not-screened",
    schemaMismatch: "input-not-screened",
  },
});

async function readBoundedRegular(
  path: string,
  maxBytes: number,
): Promise<Buffer | QualityDerivationFailureReason> {
  let before: Awaited<ReturnType<typeof lstat>>;
  try {
    before = await lstat(path);
  } catch {
    return "output-missing";
  }
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1)
    return "output-not-regular";
  if (before.size > maxBytes) return "output-oversize";
  const bytes = await readFile(path);
  const after = await lstat(path);
  if (before.ino !== after.ino || before.size !== after.size || bytes.length !== before.size) {
    return "output-not-regular";
  }
  return bytes;
}

function decodeDerivationOutput(value: unknown): QualityDerivationOutcomeV1 | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const output = value as Record<string, unknown>;
  const strings = (entry: unknown) =>
    Array.isArray(entry) && entry.every((item) => typeof item === "string")
      ? (entry as string[])
      : undefined;
  const isObject = (entry: unknown): entry is Record<string, unknown> =>
    Boolean(entry) && typeof entry === "object" && !Array.isArray(entry);
  if (output.schemaVersion !== 1 || output.kind !== "docsfab-quality-derivation-output") {
    return undefined;
  }
  const ignored = strings(output.ignoredShortfallDecisions);
  if (!ignored) return undefined;
  if (output.status === "open") {
    const openLayers = strings(output.openLayers);
    return openLayers && openLayers.length > 0
      ? { status: "open", openLayers, ignoredShortfallDecisions: ignored }
      : undefined;
  }
  const hostLimitations = strings(output.hostLimitations);
  const coherenceLabels = strings(output.coherenceLabels);
  if (
    output.status !== "derived" ||
    !isObject(output.evaluation) ||
    !(output.qualityScore === null || isObject(output.qualityScore)) ||
    !hostLimitations ||
    !coherenceLabels
  ) {
    return undefined;
  }
  return {
    status: "derived",
    evaluation: output.evaluation,
    qualityScore: output.qualityScore as Record<string, unknown> | null,
    hostLimitations,
    coherenceLabels,
    ignoredShortfallDecisions: ignored,
  };
}
