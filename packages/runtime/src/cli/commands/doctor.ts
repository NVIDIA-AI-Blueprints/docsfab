// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { canonicalJson } from "../../content-ir/canonical.js";
import {
  formatLimitsTable,
  inspectLimits,
  loadEffectiveLimitEnvironment,
} from "../../config/limits.js";
import { loadConfig } from "../../config/runtime-loader.js";
import { answerPlanCoverage, formatAnswerPlanLines } from "../../harness/answer-now.js";
import {
  answerRecordObservationDirectory,
  answerRecordProbeExitCode,
  answerRecordProbeResult,
  formatAnswerRecordProbe,
  formatAnswerRecordProbePlan,
  planAnswerRecordDiagnostic,
  planAnswerRecordQualification,
  recordAnswerRecordProbe,
  answerSubmissionProbeExitCode,
  answerSubmissionProbeResult,
  diagnose,
  formatAnswerSubmissionProbe,
  probeConfiguredAnswerSubmission,
  formatDoctorFailure,
  modelProfileClampLines,
  resolveDoctorModelBinding,
  resolveDoctorModelProfile,
  serializeDoctorFailure,
} from "../../doctor.js";
import { modelProfileLimitClampIssues } from "../../model/configuration.js";
import { formatDoctorReadiness, inspectDoctorReadiness } from "../../doctor-readiness.js";
import { inspectAnswerSubmissionRecordsFits } from "./answer-record-fit-doctor.js";
import { renderDoctorPresentation } from "../doctor-presentation.js";
import { canonicalizeJsonEvidence, type JsonEvidenceValue } from "../../json-evidence.js";
import {
  formatModelProfileInspection,
  inspectModelProfile,
  serializeModelProfileInspection,
} from "../../model/profile-inspection.js";
import type { AnswerRecordProbeSelection } from "../../profile/answer-record-probe.js";
import { loadProfileInspectionConfig, parseDoctorArguments } from "../profile-arguments.js";

class DoctorLimitsUsageError extends Error {
  readonly code = "cli-usage";

  constructor(message: string) {
    super(message);
    this.name = "DoctorLimitsUsageError";
  }
}

function takeLimitsFlag(args: string[]): { limits: boolean; rest: string[] } {
  const rest: string[] = [];
  let limits = false;
  for (const argument of args) {
    if (argument === "--limits") {
      if (limits) {
        throw new DoctorLimitsUsageError(
          "The --limits option must not be duplicated on docsfab doctor.",
        );
      }
      limits = true;
      continue;
    }
    rest.push(argument);
  }
  return { limits, rest };
}

/**
 * `docsfab doctor --live --answer-submission`: offline readiness, then
 * the answer-submission probe on the bound request path, and nothing else
 * that spends requests. The retained observation is written beside the run
 * state as its canonical JSON, so the file's SHA-256 is its `evidenceSha256`.
 */
async function runAnswerSubmissionProbe(
  cwd: string,
  json: boolean,
  typedContingency: boolean,
): Promise<void> {
  const readiness = await inspectDoctorReadiness({ cwd, live: false });
  if (readiness.status === "blocked") {
    console.log(
      json
        ? canonicalizeJsonEvidence(readiness as unknown as JsonEvidenceValue)
        : formatDoctorReadiness(readiness),
    );
    process.exitCode = 1;
    return;
  }
  const config = loadConfig();
  const verdict = await probeConfiguredAnswerSubmission(config.model, { typedContingency });
  let observationPath: string | undefined;
  if (verdict.decision !== "not-checked") {
    const directory = resolve(dirname(config.stateDirectory), "answer-submission-probes");
    await mkdir(directory, { recursive: true });
    observationPath = resolve(directory, `${verdict.evidenceSha256}.json`);
    await writeFile(observationPath, canonicalJson(verdict.observation), { mode: 0o600 });
  }
  console.log(
    json
      ? canonicalizeJsonEvidence(
          answerSubmissionProbeResult(verdict, observationPath) as unknown as JsonEvidenceValue,
        )
      : [
          formatDoctorReadiness(readiness),
          ...formatAnswerSubmissionProbe(verdict, observationPath),
        ].join("\n"),
  );
  process.exitCode = answerSubmissionProbeExitCode(verdict);
}

/**
 * `docsfab doctor --live --answer-records`: offline readiness, then the
 * answer-record premise probe on the bound request path, and nothing else
 * that spends requests. Its plan, with the input tokens it will spend, is
 * printed to stderr before the first request, so `--json` stays one record.
 * The retained observation is written beside the run state as its canonical
 * JSON, so the file's SHA-256 is its `evidenceSha256`.
 */
async function runAnswerRecordProbe(
  cwd: string,
  json: boolean,
  corpusPath: string,
  selection: AnswerRecordProbeSelection,
  typedContextMix: boolean,
  typedContextGroupOnly: boolean,
  qualificationCells: boolean,
  qualificationFingerprint: string | undefined,
  diagnosticCell: boolean,
  diagnosticFingerprint: string | undefined,
  observationDirectory: string | undefined,
): Promise<void> {
  const readiness = await inspectDoctorReadiness({ cwd, live: false });
  if (readiness.status === "blocked") {
    console.log(
      json
        ? canonicalizeJsonEvidence(readiness as unknown as JsonEvidenceValue)
        : formatDoctorReadiness(readiness),
    );
    process.exitCode = 1;
    return;
  }
  const config = loadConfig();
  const { verdict, observationPath, warnings } = await recordAnswerRecordProbe(config.model, {
    corpusPath,
    selection,
    ...(qualificationCells ? { qualificationCells: true } : {}),
    ...(qualificationFingerprint
      ? { expectedQualificationFingerprint: qualificationFingerprint }
      : {}),
    ...(diagnosticCell ? { diagnosticCell: true as const } : {}),
    ...(diagnosticFingerprint ? { expectedDiagnosticFingerprint: diagnosticFingerprint } : {}),
    ...(typedContextMix ? { typedContextMix: true } : {}),
    ...(typedContextGroupOnly ? { typedContextGroupOnly: true } : {}),
    observationDirectory:
      observationDirectory ?? answerRecordObservationDirectory(config.stateDirectory),
    onPlan: (plan) => console.error(formatAnswerRecordProbePlan(plan)),
  });
  console.log(
    json
      ? canonicalizeJsonEvidence(
          answerRecordProbeResult(
            verdict,
            observationPath,
            warnings,
          ) as unknown as JsonEvidenceValue,
        )
      : [
          formatDoctorReadiness(readiness),
          ...formatAnswerRecordProbe(verdict, observationPath, warnings),
        ].join("\n"),
  );
  process.exitCode = answerRecordProbeExitCode(verdict);
}

async function runAnswerRecordDiagnosticPlan(
  corpusPath: string,
  observationDirectory: string | undefined,
): Promise<void> {
  const config = loadConfig();
  const result = await planAnswerRecordDiagnostic(config.model, {
    corpusPath,
    observationDirectory:
      observationDirectory ?? answerRecordObservationDirectory(config.stateDirectory),
  });
  console.log(canonicalizeJsonEvidence(result as unknown as JsonEvidenceValue));
  if ("decision" in result) process.exitCode = 1;
}

async function runAnswerRecordQualificationPlan(
  corpusPath: string,
  typed: boolean,
  observationDirectory: string | undefined,
): Promise<void> {
  const config = loadConfig();
  const result = await planAnswerRecordQualification(config.model, {
    corpusPath,
    selection: typed ? "typed" : "premise",
    observationDirectory:
      observationDirectory ?? answerRecordObservationDirectory(config.stateDirectory),
  });
  console.log(canonicalizeJsonEvidence(result as unknown as JsonEvidenceValue));
  if ("decision" in result) process.exitCode = 1;
}

export async function handleDoctorCommand(args: string[]): Promise<void> {
  const { limits, rest } = takeLimitsFlag(args);
  const doctorArgs = parseDoctorArguments(rest);
  const doctorCwd = doctorArgs.repositoryPath ?? process.cwd();
  try {
    if (limits && (doctorArgs.quiet || doctorArgs.verbose)) {
      throw new DoctorLimitsUsageError(
        "The doctor --quiet and --verbose options apply only to the readiness report; --limits keeps its inspection output.",
      );
    }
    if (
      limits &&
      (doctorArgs.answerRecordQualificationPlan || doctorArgs.answerRecordDiagnosticPlan)
    ) {
      throw new DoctorLimitsUsageError(
        "doctor --limits cannot be used with an answer-record qualification or diagnostic plan.",
      );
    }
    if (doctorArgs.answerRecordQualificationPlan && doctorArgs.answerRecordCorpus) {
      await runAnswerRecordQualificationPlan(
        doctorArgs.answerRecordCorpus,
        doctorArgs.answerRecordTyped === true,
        doctorArgs.answerRecordObservationDirectory,
      );
      return;
    }
    if (doctorArgs.answerRecordDiagnosticPlan && doctorArgs.answerRecordCorpus) {
      await runAnswerRecordDiagnosticPlan(
        doctorArgs.answerRecordCorpus,
        doctorArgs.answerRecordObservationDirectory,
      );
      return;
    }
    if (limits) {
      if (doctorArgs.live || doctorArgs.catalog) {
        throw new DoctorLimitsUsageError(
          "doctor --limits cannot combine with --live or --catalog.",
        );
      }
      const limitOptions = { cwd: doctorCwd, environment: loadEffectiveLimitEnvironment() };
      const answerPlan = doctorArgs.json ? null : answerPlanCoverage(limitOptions);
      const answerSubmissionRecordsFits = await inspectAnswerSubmissionRecordsFits({
        environment: limitOptions.environment,
      });
      const report = await inspectLimits({ ...limitOptions, answerSubmissionRecordsFits });
      // Keep the existing limit rows and add a credential-free installed
      // composition fit projection when a records capability is present.
      console.log(
        doctorArgs.json
          ? canonicalizeJsonEvidence(report as unknown as JsonEvidenceValue)
          : [
              formatLimitsTable(report),
              ...(answerPlan ? formatAnswerPlanLines(answerPlan) : []),
            ].join("\n"),
      );
      process.exitCode = report.exitCode;
      return;
    }
    if (doctorArgs.answerSubmission) {
      if (limits) {
        throw new DoctorLimitsUsageError(
          "doctor --limits cannot combine with --live or --answer-submission.",
        );
      }
      await runAnswerSubmissionProbe(
        doctorCwd,
        doctorArgs.json,
        doctorArgs.answerSubmissionTypedContingency === true,
      );
      return;
    }
    if (doctorArgs.answerRecords && doctorArgs.answerRecordCorpus) {
      await runAnswerRecordProbe(
        doctorCwd,
        doctorArgs.json,
        doctorArgs.answerRecordCorpus,
        doctorArgs.answerRecordTyped
          ? "typed"
          : doctorArgs.answerRecordSmallGroups
            ? "small-groups"
            : "premise",
        doctorArgs.answerRecordTypedContext === true,
        doctorArgs.answerRecordTypedContextGroupOnly === true,
        doctorArgs.answerRecordQualificationCells === true,
        doctorArgs.answerRecordQualificationFingerprint,
        doctorArgs.answerRecordDiagnosticCell === true,
        doctorArgs.answerRecordDiagnosticFingerprint,
        doctorArgs.answerRecordObservationDirectory,
      );
      return;
    }
    const readiness = await inspectDoctorReadiness({
      cwd: doctorCwd,
      live: doctorArgs.live,
      use: doctorArgs.use,
    });
    if (readiness.status === "blocked") {
      // Catalog inspect is opt-in. Missing MODEL_API_KEY stays on the inference
      // missing-key NEXT; do not retarget it at --catalog.
      console.log(
        doctorArgs.json
          ? canonicalizeJsonEvidence(readiness as unknown as JsonEvidenceValue)
          : (() => {
              const rendered = renderDoctorPresentation({
                readiness,
                detail: doctorArgs.quiet ? "quiet" : doctorArgs.verbose ? "verbose" : "normal",
              });
              if (rendered.stderr) process.stderr.write(rendered.stderr);
              return rendered.stdout.trimEnd();
            })(),
      );
      process.exitCode = 1;
      return;
    }
    if (doctorArgs.catalog) {
      const config = loadProfileInspectionConfig(doctorArgs);
      if (!config) return;
      const [doctorResult, report] = await Promise.all([
        diagnose(config),
        inspectModelProfile(config, doctorArgs),
      ]);
      // A unique-match bind may reduce the profile; unmatched BYO stays as
      // loaded; binding refusals fail this command. Clamps that bound ride
      // beside the sealed report rather than folding into it, so its digest
      // and decode-time re-derivation stay separate.
      const clampPrefix = doctorArgs.purpose === "judge" ? "JUDGE" : "MODEL";
      const clampSource = clampPrefix === "JUDGE" ? config.judge : config.model;
      const clampProfile = clampSource ? await resolveDoctorModelProfile(clampSource) : undefined;
      if (doctorArgs.json) {
        console.log(
          canonicalizeJsonEvidence({
            schemaVersion: 1,
            kind: "docsfab-doctor-catalog-readiness",
            readiness,
            profile: JSON.parse(serializeModelProfileInspection(report)) as JsonEvidenceValue,
            limitClamps: clampProfile
              ? modelProfileLimitClampIssues(clampProfile, clampPrefix)
              : [],
          } as unknown as JsonEvidenceValue),
        );
      } else {
        console.log(
          [
            formatDoctorReadiness(readiness),
            "",
            "DocsFab configuration: ready (catalog-safe rendering)",
            `Skills: ${doctorResult.skills.length}; context-sources: ${doctorResult.contextSources.length}`,
            formatModelProfileInspection(report),
            ...(clampProfile ? modelProfileClampLines(clampProfile, clampPrefix, "") : []),
          ].join("\n"),
        );
      }
      return;
    }
    if (doctorArgs.json) {
      console.log(canonicalizeJsonEvidence(readiness as unknown as JsonEvidenceValue));
      return;
    }
    const config = loadConfig();
    const result = await diagnose(config);
    const policy = await resolveDoctorModelBinding(config.model);
    const judge = config.judge ? await resolveDoctorModelBinding(config.judge) : undefined;
    // The judge never answers the final quality evaluator, so only the policy
    // model's recorded answer submission is reported.
    const { answerSubmission: _judgeAnswerSubmission, ...judgeBinding } = judge ?? {};
    const rendered = renderDoctorPresentation({
      readiness,
      result: {
        ...result,
        ...policy,
        ...(result.judge && judge ? { judge: { ...result.judge, ...judgeBinding } } : {}),
        liveObservation: readiness.liveConnectivity.provider,
      },
      detail: doctorArgs.quiet ? "quiet" : doctorArgs.verbose ? "verbose" : "normal",
    });
    if (rendered.stdout) console.log(rendered.stdout.trimEnd());
    if (rendered.stderr) process.stderr.write(rendered.stderr);
  } catch (error) {
    console.error(
      doctorArgs.json ? serializeDoctorFailure(error).trimEnd() : formatDoctorFailure(error),
    );
    process.exitCode = 1;
  }
}
