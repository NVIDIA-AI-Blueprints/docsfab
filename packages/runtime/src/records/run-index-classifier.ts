// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Identity of the attempt classifier whose reading `attempt` rows carry: the
 * failure class and code, and the retry decision rule. When it changes,
 * `docsfab runs import` re-projects and readers treat those stale readings as
 * unavailable.
 *
 * The identity hashes the source of `operator/failure-classification` and
 * `operator/retry-disposition` and every local module they reach through
 * static value imports, so any edit changes it, including ones no sample
 * attempt would reveal. Over-invalidation
 * on a pure refactor is accepted because re-importing is cheap. A digest over
 * a probe matrix is folded in to name behavior in the tests.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, extname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { FailureClassificationV1 } from "../operator/failure-class.js";
import {
  classifyInferenceAttempt,
  INFERENCE_CATEGORY_FAILURE_CLASSES,
  INFERENCE_REJECTION_FAILURE_CLASSES,
  OUTPUT_LIMIT_FINISH_REASONS,
  REJECTION_FAMILY_FAILURE_CLASSES,
} from "../operator/failure-classification.js";
import type { InferenceAttemptEvidence } from "./contracts.js";
import { MODEL_FINISH_REASONS, PROVIDER_ERROR_CLASSES } from "./model-telemetry.js";

export type AttemptClassifier = (
  attempt: InferenceAttemptEvidence | undefined,
) => FailureClassificationV1 | undefined;

/** The provider tokens `model/attempt-telemetry.ts` normalizes, plus one it does not recognize. */
const PROBE_RAW_STOP_REASONS = Object.freeze([
  "end_turn",
  "stop_sequence",
  "tool_use",
  "tool_calls",
  "refusal",
  "content_filter",
  "max_output_tokens",
  "completed",
  "incomplete",
  "safety",
  "recitation",
  "unrecognized_probe_token",
]);

/** One status per distinct HTTP meaning the retry taxonomy reads. */
const PROBE_HTTP_STATUSES = Object.freeze([
  400, 401, 403, 404, 408, 409, 413, 422, 425, 429, 500, 502, 503, 504,
]);

/** A rejection code outside every table and one outside the code grammar. */
const PROBE_UNCATALOGUED_REJECTIONS = Object.freeze([
  "uncatalogued-probe-code",
  "Unreadable Probe Code",
]);

function probeAttempts(): {
  readonly label: string;
  readonly attempt: unknown;
}[] {
  const probes: { label: string; attempt: unknown }[] = [];
  const add = (label: string, attempt: Record<string, unknown>) =>
    probes.push({
      label,
      attempt: { attempt: 1, retryable: false, durationMs: 0, ...attempt },
    });
  const rejectionCodes = [
    ...Object.keys(INFERENCE_REJECTION_FAILURE_CLASSES),
    ...Object.keys(REJECTION_FAMILY_FAILURE_CLASSES).map((prefix) => `${prefix}probe`),
    ...PROBE_UNCATALOGUED_REJECTIONS,
  ].sort();
  const stopTokens = [
    ...new Set([
      ...MODEL_FINISH_REASONS,
      ...OUTPUT_LIMIT_FINISH_REASONS,
      ...PROBE_RAW_STOP_REASONS,
    ]),
  ].sort();
  const outcomes = ["succeeded", ...Object.keys(INFERENCE_CATEGORY_FAILURE_CLASSES).sort()];
  for (const outcome of outcomes) {
    add(`${outcome}`, { outcome });
    for (const code of rejectionCodes) {
      add(`${outcome}|rejection=${code}`, {
        outcome,
        rejection: { code, location: "$response" },
      });
    }
    for (const token of stopTokens) {
      add(`${outcome}|rawStopReason=${token}`, {
        outcome,
        turns: [{ rawStopReason: token }],
      });
    }
    for (const finishReason of MODEL_FINISH_REASONS) {
      add(`${outcome}|finishReason=${finishReason}`, {
        outcome,
        modelTelemetry: {
          schemaVersion: 1,
          finishReason,
          providerLatencyMs: 0,
        },
      });
    }
    for (const errorClass of PROVIDER_ERROR_CLASSES) {
      for (const httpStatus of [undefined, ...PROBE_HTTP_STATUSES]) {
        add(`${outcome}|providerError=${errorClass}/${String(httpStatus ?? "none")}`, {
          outcome,
          modelTelemetry: {
            schemaVersion: 1,
            finishReason: "error",
            providerLatencyMs: 0,
            providerError: {
              class: errorClass,
              ...(httpStatus === undefined ? {} : { httpStatus }),
            },
          },
        });
      }
    }
  }
  return probes;
}

export function attemptClassifierDigest(classify: AttemptClassifier): string {
  const hash = createHash("sha256");
  for (const probe of probeAttempts()) {
    let reading: string;
    try {
      const failure = classify(probe.attempt as InferenceAttemptEvidence);
      reading = failure ? `${failure.class}/${failure.layer}/${failure.code}` : "none";
    } catch {
      reading = "throws";
    }
    hash.update(`${probe.label}=${reading}\n`);
  }
  return hash.digest("hex");
}

/** A static `import`/`export ... from "./x.js"` that is not type-only. */
const LOCAL_VALUE_IMPORT =
  /^\s*(?:import|export)\s+(?!type\b)(?:[^;]*?\sfrom\s+)?["'](\.{1,2}\/[^"']+)["']/gmu;

export function classifierEntryFile(): string {
  return operatorModuleFile("failure-classification");
}

/** The module whose reading `retryDecisionRule` carries. */
export function retryRuleEntryFile(): string {
  return operatorModuleFile("retry-disposition");
}

function operatorModuleFile(name: string): string {
  const self = fileURLToPath(import.meta.url);
  return resolve(dirname(self), "..", "operator", `${name}${extname(self)}`);
}

/** Type-only imports carry no behavior and are skipped. */
export function classifierSourceFiles(
  entry: string,
  read: (file: string) => string,
  exists: (file: string) => boolean = existsSync,
): readonly string[] {
  const seen = new Set<string>();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    for (const match of read(file).matchAll(LOCAL_VALUE_IMPORT)) {
      queue.push(resolveImportedFile(file, match[1]!, extname(entry), exists));
    }
  }
  return [...seen].sort();
}

/**
 * A checkout imports `.ts` sources as `.js` and also holds plain `.js`
 * modules, so the entry's own extension is tried before `.js`. An unresolved
 * specifier refuses, so no loaded module drops out of the identity.
 */
function resolveImportedFile(
  importer: string,
  specifier: string,
  extension: string,
  exists: (file: string) => boolean,
): string {
  const target = resolve(dirname(importer), specifier);
  const stem = target.endsWith(".js") ? target.slice(0, -".js".length) : undefined;
  const candidates = stem === undefined ? [target] : [...new Set([`${stem}${extension}`, target])];
  const found = candidates.find((candidate) => exists(candidate));
  if (found === undefined) {
    throw new Error(
      `The run index cannot find attempt classifier module ${specifier} imported by ${importer}.`,
    );
  }
  return found;
}

/** Paths are hashed relative to the source root so the digest is location-independent. */
export function classifierSourceDigest(entry: string, read: (file: string) => string): string {
  const root = dirname(dirname(entry));
  const cache = new Map<string, string>();
  const readOnce = (file: string): string => {
    const cached = cache.get(file);
    if (cached !== undefined) return cached;
    const source = read(file);
    cache.set(file, source);
    return source;
  };
  const hash = createHash("sha256");
  for (const file of classifierSourceFiles(entry, readOnce)) {
    const source = readOnce(file);
    hash.update(`${relative(root, file)}\u0000${String(source.length)}\u0000`);
    hash.update(source);
  }
  return hash.digest("hex");
}

function readSource(file: string): string {
  try {
    return readFileSync(file, "utf8");
  } catch (error) {
    // An attempt class without a classifier identity could go stale unseen.
    throw new Error(
      `The run index cannot read attempt classifier source ${file} to name the classifier.`,
      { cause: error },
    );
  }
}

let current: string | undefined;

/** Computed once per process. */
export function attemptClassifierSha256(): string {
  current ??= createHash("sha256")
    .update(`source=${classifierSourceDigest(classifierEntryFile(), readSource)}\n`)
    .update(`retry-rule-source=${classifierSourceDigest(retryRuleEntryFile(), readSource)}\n`)
    .update(`behavior=${attemptClassifierDigest(classifyInferenceAttempt)}\n`)
    .digest("hex");
  return current;
}
