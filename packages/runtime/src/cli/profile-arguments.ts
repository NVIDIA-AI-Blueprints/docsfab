// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { resolve } from "node:path";

import {
  InvalidModelProfileConfigurationError,
  ModelProfileMigrationError,
  type ModelEndpointConfig,
} from "../model/configuration.js";
import {
  loadConfig,
  loadModelEndpointForInspection,
  type DocsFabConfig,
} from "../config/runtime-loader.js";
import { MODEL_CATALOG_FIELDS, type ModelCatalogField } from "../model/catalog-contracts.js";
import {
  serializeModelProfileInspectionPreflight,
  unsupportedApiFormatInspection,
} from "../model/profile-inspection.js";
import { ProfileSeedChoiceRequiredError } from "../model/profile-apply/seed-choice.js";
import { ProfileCliUsageError, strictCliOptions } from "./options.js";
import { projectProfileInspectionPreflight } from "./profile-presentation.js";
import { writeCliPresentation } from "./presentation.js";

export interface ProfileInspectionArguments {
  purpose: "policy" | "judge";
  catalog: boolean;
  json: boolean;
  verbose?: boolean;
}

export interface ProfileApproveArguments {
  purpose: "policy" | "judge";
  inspectionPath: string;
  proposalSha256: string;
  effectiveDate: string;
  reviewAfter: string;
  authorityId: string;
  publicKeyPath: string;
  privateKeyPath: string;
  bundlePath: string;
  conflictFields: ModelCatalogField[];
  apply: boolean;
  confirmPatchSha256?: string;
  confirmBundleSha256?: string;
  receiptPath?: string;
  json: boolean;
}

export function parseProfileApproveArguments(args: string[]): ProfileApproveArguments {
  const flags = new Set(["--judge", "--json", "--apply"]);
  const values = new Set([
    "--inspection",
    "--proposal-sha256",
    "--effective-date",
    "--review-after",
    "--authority-id",
    "--public-key",
    "--private-key",
    "--resolve-conflict",
    "--bundle",
    "--confirm-bundle-sha256",
    "--confirm-patch-sha256",
    "--receipt",
  ]);
  const parsed = strictCliOptions(args, flags, values, new Set(["--resolve-conflict"]));
  const requiredValue = (name: string): string => {
    const found = parsed.values.get(name)?.[0];
    if (!found) throw new ProfileCliUsageError(`profile approve requires ${name} <value>.`);
    return found;
  };
  const apply = parsed.flags.has("--apply");
  const confirm = parsed.values.get("--confirm-patch-sha256")?.[0];
  const confirmBundle = parsed.values.get("--confirm-bundle-sha256")?.[0];
  const receipt = parsed.values.get("--receipt")?.[0];
  if (apply !== Boolean(confirm && confirmBundle && receipt)) {
    throw new ProfileCliUsageError(
      "profile approve mutation requires --apply, --confirm-bundle-sha256, --confirm-patch-sha256, and --receipt together.",
    );
  }
  const conflicts = parsed.values.get("--resolve-conflict") ?? [];
  if (conflicts.some((field) => !MODEL_CATALOG_FIELDS.includes(field as ModelCatalogField))) {
    throw new ProfileCliUsageError("profile approve received an unknown conflict field.");
  }
  const privateKey = parsed.values.get("--private-key")?.[0];
  const proposal = parsed.values.get("--proposal-sha256")?.[0];
  const effectiveDate = parsed.values.get("--effective-date")?.[0];
  const reviewAfter = parsed.values.get("--review-after")?.[0];
  if (apply) {
    if (privateKey || proposal || effectiveDate || reviewAfter || conflicts.length > 0) {
      throw new ProfileCliUsageError(
        "profile approve --apply loads the exact saved bundle and does not accept signing inputs.",
      );
    }
  } else if (!privateKey || !proposal || !effectiveDate || !reviewAfter) {
    throw new ProfileCliUsageError(
      "profile approve preview requires proposal, dates, and --private-key.",
    );
  }
  return {
    purpose: parsed.flags.has("--judge") ? "judge" : "policy",
    inspectionPath: requiredValue("--inspection"),
    proposalSha256: proposal ?? "",
    effectiveDate: effectiveDate ?? "",
    reviewAfter: reviewAfter ?? "",
    authorityId: requiredValue("--authority-id"),
    publicKeyPath: requiredValue("--public-key"),
    privateKeyPath: privateKey ?? "",
    bundlePath: requiredValue("--bundle"),
    conflictFields: conflicts as ModelCatalogField[],
    apply,
    ...(confirm ? { confirmPatchSha256: confirm } : {}),
    ...(confirmBundle ? { confirmBundleSha256: confirmBundle } : {}),
    ...(receipt ? { receiptPath: receipt } : {}),
    json: parsed.flags.has("--json"),
  };
}

export interface ProfileRollbackArguments {
  receiptPath: string;
  apply: boolean;
  confirmRollbackSha256?: string;
  rollbackReceiptPath?: string;
  json: boolean;
}

export interface ProfileSeedArguments {
  preset: string;
  json: boolean;
}

export function parseProfileSeedArguments(args: string[]): ProfileSeedArguments {
  const parsed = strictCliOptions(args, new Set(["--json"]), new Set(["--preset"]), new Set());
  const preset = parsed.values.get("--preset")?.[0];
  // Only an absent --preset is a missing model choice; an empty value is a
  // malformed option and keeps its own refusal below.
  if (preset === undefined) throw new ProfileSeedChoiceRequiredError();
  if (preset.trim().length === 0) {
    throw new ProfileCliUsageError("profile seed requires a non-empty --preset identifier value.");
  }
  return { preset, json: parsed.flags.has("--json") };
}

export const PROFILE_PROBE_VERDICTS = [
  "harness-compatible",
  "reasoning-split-controllable",
  "reasoning-split-uncontrolled",
  "unreachable",
] as const;

export type ProfileProbeVerdict = (typeof PROFILE_PROBE_VERDICTS)[number];

export interface ProfileProbeArguments {
  routeId: string;
  modelId: string;
  live: boolean;
  json: boolean;
}

export interface ProfileDraftArguments {
  routeId: string;
  modelId: string;
  verdict: ProfileProbeVerdict;
  json: boolean;
}

function requiredProfileValue(
  parsed: { values: Map<string, string[]> },
  name: string,
  command: "probe" | "draft",
): string {
  const found = parsed.values.get(name)?.[0];
  if (!found || found.trim().length === 0) {
    throw new ProfileCliUsageError(
      `profile ${command} requires a non-empty ${name} identifier value.`,
    );
  }
  return found;
}

export function parseProfileProbeArguments(args: string[]): ProfileProbeArguments {
  const parsed = strictCliOptions(
    args,
    new Set(["--live", "--json"]),
    new Set(["--route", "--model"]),
    new Set(),
  );
  return {
    routeId: requiredProfileValue(parsed, "--route", "probe"),
    modelId: requiredProfileValue(parsed, "--model", "probe"),
    live: parsed.flags.has("--live"),
    json: parsed.flags.has("--json"),
  };
}

export function parseProfileDraftArguments(args: string[]): ProfileDraftArguments {
  const parsed = strictCliOptions(
    args,
    new Set(["--json"]),
    new Set(["--route", "--model", "--verdict"]),
    new Set(),
  );
  const verdict = requiredProfileValue(parsed, "--verdict", "draft");
  if (!(PROFILE_PROBE_VERDICTS as readonly string[]).includes(verdict)) {
    throw new ProfileCliUsageError(
      "profile draft requires a closed --verdict of harness-compatible, reasoning-split-controllable, reasoning-split-uncontrolled, or unreachable.",
    );
  }
  return {
    routeId: requiredProfileValue(parsed, "--route", "draft"),
    modelId: requiredProfileValue(parsed, "--model", "draft"),
    verdict: verdict as ProfileProbeVerdict,
    json: parsed.flags.has("--json"),
  };
}

export function parseProfileRollbackArguments(args: string[]): ProfileRollbackArguments {
  const parsed = strictCliOptions(
    args,
    new Set(["--json", "--apply"]),
    new Set(["--receipt", "--confirm-rollback-sha256", "--rollback-receipt"]),
    new Set(),
  );
  const receipt = parsed.values.get("--receipt")?.[0];
  if (!receipt)
    throw new ProfileCliUsageError("profile rollback requires --receipt <absolute-path>.");
  const apply = parsed.flags.has("--apply");
  const confirm = parsed.values.get("--confirm-rollback-sha256")?.[0];
  const rollbackReceipt = parsed.values.get("--rollback-receipt")?.[0];
  if (apply !== Boolean(confirm && rollbackReceipt)) {
    throw new ProfileCliUsageError(
      "profile rollback mutation requires --apply, --confirm-rollback-sha256, and --rollback-receipt together.",
    );
  }
  return {
    receiptPath: receipt,
    apply,
    ...(confirm ? { confirmRollbackSha256: confirm } : {}),
    ...(rollbackReceipt ? { rollbackReceiptPath: rollbackReceipt } : {}),
    json: parsed.flags.has("--json"),
  };
}

/** Strict closed parser shared by profile inspection and catalog-aware doctor. */
export function parseProfileInspectionArguments(args: string[]): ProfileInspectionArguments {
  const allowed = new Set(["--judge", "--catalog", "--json", "--verbose"]);
  const seen = new Set<string>();
  for (const argument of args) {
    if (!allowed.has(argument))
      throw new ProfileCliUsageError("Unknown profile inspection option.");
    if (seen.has(argument))
      throw new ProfileCliUsageError(
        `Profile inspection option "${argument}" must not be duplicated.`,
      );
    seen.add(argument);
  }
  if (seen.has("--json") && seen.has("--verbose")) {
    throw new ProfileCliUsageError(
      'Profile inspection options "--json" and "--verbose" cannot be combined.',
    );
  }
  return {
    purpose: seen.has("--judge") ? "judge" : "policy",
    catalog: seen.has("--catalog"),
    json: seen.has("--json"),
    verbose: seen.has("--verbose"),
  };
}

/** A doctor option combination the command does not run, with its fix. */
export class DoctorArgumentsOperatorError extends Error {
  readonly code = "cli-usage";
  readonly nextAction: string;

  constructor(message: string, nextAction: string) {
    super(message);
    this.name = "DoctorArgumentsOperatorError";
    this.nextAction = nextAction;
  }
}

export interface DoctorArguments extends ProfileInspectionArguments {
  live: boolean;
  /** Keep only the selected-use result, material attention, and primary next action. */
  quiet?: true;
  /** Include the complete doctor diagnostic inventory on the human surface. */
  verbose?: true;
  use?: "local-review" | "local-patch" | "draft-mr";
  /**
   * `--answer-submission`: run the answer-submission probe; requires `--live`.
   * Present only when the flag is given, so the shape without it is unchanged.
   */
  answerSubmission?: true;
  /**
   * `--answer-submission-typed-contingency`: let the probe spend on the
   * typed-shell contingency; requires `--answer-submission`. Present only
   * when the flag is given.
   */
  answerSubmissionTypedContingency?: true;
  /**
   * `--answer-records`: run the answer-record premise probe; requires
   * `--live`. Present only when the flag is given.
   */
  answerRecords?: true;
  /** Provider-free exact A/B/C qualification matrix using the production planner. */
  answerRecordQualificationPlan?: true;
  /** Live exact-cell execution through the same planner as qualification-plan-only. */
  answerRecordQualificationCells?: true;
  /** Fingerprint copied from the exact provider-free qualification plan. */
  answerRecordQualificationFingerprint?: string;
  /** Provider-free plan for the one B/6,144/seed-1 diagnostic cell. */
  answerRecordDiagnosticPlan?: true;
  /** Live execution of that single diagnostic cell; never qualification. */
  answerRecordDiagnosticCell?: true;
  /** Fingerprint copied from the provider-free diagnostic plan. */
  answerRecordDiagnosticFingerprint?: string;
  /** `--answer-record-corpus <path>`: the record corpus file; required with `--answer-records`. */
  answerRecordCorpus?: string;
  /** Explicit retained-ledger directory shared by provider-free planning and exact live recording. */
  answerRecordObservationDirectory?: string;
  /**
   * `--answer-record-small-groups`: send only phase K, 2 and 3 records per
   * message; requires `--answer-records`. Present only when the flag is given.
   */
  answerRecordSmallGroups?: true;
  /** `--answer-record-typed`: run slice 1b typed A-t; phase G remains policy-blocked. */
  answerRecordTyped?: true;
  /** `--answer-record-typed-context`: run the seven-request P-padded typed context screen. */
  answerRecordTypedContext?: true;
  /** `--answer-record-typed-context-group-only`: send only the pinned screen's unsent two-call group. */
  answerRecordTypedContextGroupOnly?: true;
  repositoryPath?: string;
}

export function parseDoctorArguments(args: string[]): DoctorArguments {
  const allowed = new Set([
    "--live",
    "--catalog",
    "--judge",
    "--json",
    "--quiet",
    "--verbose",
    "--answer-submission",
    "--answer-submission-typed-contingency",
    "--answer-records",
    "--answer-record-qualification-plan",
    "--answer-record-qualification-cells",
    "--answer-record-diagnostic-plan",
    "--answer-record-diagnostic-cell",
    "--answer-record-small-groups",
    "--answer-record-typed",
    "--answer-record-typed-context",
    "--answer-record-typed-context-group-only",
  ]);
  const allowedValues = new Set([
    "--repo",
    "--answer-record-corpus",
    "--use",
    "--answer-record-observation-dir",
    "--answer-record-qualification-fingerprint",
    "--answer-record-diagnostic-fingerprint",
  ]);
  const flags = new Set<string>();
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (allowed.has(argument)) {
      if (flags.has(argument))
        throw new Error(`Doctor option "${argument}" must not be duplicated.`);
      flags.add(argument);
      continue;
    }
    if (allowedValues.has(argument)) {
      const value = args[index + 1];
      if (!value || value.startsWith("--"))
        throw new Error(`${argument} requires a repository-relative or absolute path value.`);
      if (values.has(argument))
        throw new Error(`Doctor option "${argument}" must not be duplicated.`);
      values.set(argument, value);
      index += 1;
      continue;
    }
    throw new Error("Unknown doctor option.");
  }
  if (flags.has("--judge") && !flags.has("--catalog")) {
    throw new Error("doctor --judge requires --catalog.");
  }
  if (flags.has("--quiet") && flags.has("--verbose")) {
    throw new DoctorArgumentsOperatorError(
      "The doctor --quiet and --verbose options cannot be combined.",
      "Run docsfab doctor with either --quiet or --verbose, not both.",
    );
  }
  if (flags.has("--verbose") && flags.has("--json")) {
    throw new DoctorArgumentsOperatorError(
      "The doctor --verbose and --json options cannot be combined.",
      "Run docsfab doctor --verbose for the detailed human view or docsfab doctor --json for canonical evidence.",
    );
  }
  if (
    (flags.has("--quiet") || flags.has("--verbose")) &&
    [
      "--catalog",
      "--answer-submission",
      "--answer-records",
      "--answer-record-qualification-plan",
      "--answer-record-qualification-cells",
      "--answer-record-diagnostic-plan",
      "--answer-record-diagnostic-cell",
    ].some((flag) => flags.has(flag))
  ) {
    throw new DoctorArgumentsOperatorError(
      "The doctor --quiet and --verbose options apply only to the readiness report; explicit inspections and probes keep their own output.",
      "Run the explicit doctor inspection or probe without --quiet or --verbose.",
    );
  }
  if (flags.has("--answer-submission") && (!flags.has("--live") || flags.has("--catalog"))) {
    throw new DoctorArgumentsOperatorError(
      "The doctor --answer-submission option requires --live and cannot combine with --catalog.",
      "Run docsfab doctor --live --answer-submission without --catalog.",
    );
  }
  if (flags.has("--answer-submission-typed-contingency") && !flags.has("--answer-submission")) {
    throw new DoctorArgumentsOperatorError(
      "The doctor --answer-submission-typed-contingency option requires --live --answer-submission.",
      "Run docsfab doctor --live --answer-submission --answer-submission-typed-contingency.",
    );
  }
  if (
    flags.has("--answer-records") &&
    (!flags.has("--live") || flags.has("--catalog") || flags.has("--answer-submission"))
  ) {
    throw new DoctorArgumentsOperatorError(
      "The doctor --answer-records option requires --live and cannot combine with --catalog or --answer-submission.",
      "Run docsfab doctor --live --answer-records on its own.",
    );
  }
  if (
    flags.has("--answer-record-qualification-plan") &&
    (flags.has("--live") ||
      flags.has("--catalog") ||
      flags.has("--judge") ||
      flags.has("--answer-records") ||
      flags.has("--answer-submission") ||
      flags.has("--answer-submission-typed-contingency") ||
      flags.has("--answer-record-small-groups") ||
      flags.has("--answer-record-typed-context") ||
      flags.has("--answer-record-typed-context-group-only"))
  ) {
    throw new DoctorArgumentsOperatorError(
      "The qualification plan is provider-free and cannot combine with live probe options.",
      "Run docsfab doctor --answer-record-qualification-plan --answer-record-corpus <corpus.json> [--answer-record-typed].",
    );
  }
  if (
    flags.has("--answer-record-diagnostic-plan") &&
    (flags.has("--live") ||
      flags.has("--catalog") ||
      flags.has("--judge") ||
      flags.has("--answer-records") ||
      flags.has("--answer-record-qualification-plan") ||
      flags.has("--answer-record-qualification-cells") ||
      flags.has("--answer-record-diagnostic-cell") ||
      flags.has("--answer-record-small-groups") ||
      flags.has("--answer-record-typed-context") ||
      flags.has("--answer-record-typed-context-group-only"))
  ) {
    throw new DoctorArgumentsOperatorError(
      "The diagnostic plan is provider-free and cannot combine with live probe options or the A/B/C qualification plan.",
      "Run docsfab doctor --answer-record-diagnostic-plan --answer-record-typed --answer-record-corpus <corpus.json> --answer-record-observation-dir <retained-ledger>.",
    );
  }
  if (
    values.has("--answer-record-observation-dir") &&
    !flags.has("--answer-record-qualification-plan") &&
    !(flags.has("--answer-records") && flags.has("--answer-record-qualification-cells")) &&
    !flags.has("--answer-record-diagnostic-plan") &&
    !(flags.has("--answer-records") && flags.has("--answer-record-diagnostic-cell"))
  ) {
    throw new DoctorArgumentsOperatorError(
      "--answer-record-observation-dir is accepted only by the provider-free plan or the exact A/B/C qualification run, where it names the ledger to read and the same directory to reserve and retain results.",
      "Run docsfab doctor --answer-record-qualification-plan --answer-record-corpus <corpus.json> --answer-record-observation-dir <retained-ledger>, or the matching --live --answer-records --answer-record-qualification-cells form.",
    );
  }
  if (
    flags.has("--answer-record-diagnostic-cell") &&
    (!flags.has("--live") ||
      !flags.has("--answer-records") ||
      !flags.has("--answer-record-typed") ||
      flags.has("--answer-record-qualification-cells") ||
      flags.has("--answer-record-small-groups") ||
      flags.has("--answer-record-typed-context") ||
      flags.has("--answer-record-typed-context-group-only"))
  ) {
    throw new DoctorArgumentsOperatorError(
      "The one-cell diagnostic requires its separate live typed answer-record selection and cannot combine with qualification or context screens.",
      "Run docsfab doctor --live --answer-records --answer-record-typed --answer-record-diagnostic-cell --answer-record-diagnostic-fingerprint <sha256>.",
    );
  }
  if (
    flags.has("--answer-record-diagnostic-cell") !==
    values.has("--answer-record-diagnostic-fingerprint")
  ) {
    throw new DoctorArgumentsOperatorError(
      "The live one-cell diagnostic requires the fingerprint from its provider-free plan, and that fingerprint is valid only with the diagnostic cell selector.",
      "Run the provider-free diagnostic plan, then pass --answer-record-diagnostic-cell --answer-record-diagnostic-fingerprint <sha256> to the matching live command.",
    );
  }
  const diagnosticFingerprint = values.get("--answer-record-diagnostic-fingerprint");
  if (diagnosticFingerprint && !/^[a-f0-9]{64}$/u.test(diagnosticFingerprint)) {
    throw new DoctorArgumentsOperatorError(
      "The diagnostic fingerprint must be a lowercase 64-character SHA-256 digest.",
      "Copy the diagnosticFingerprint field from the provider-free diagnostic plan without changing it.",
    );
  }
  if (flags.has("--answer-record-diagnostic-plan") && !flags.has("--answer-record-typed")) {
    throw new DoctorArgumentsOperatorError(
      "The B-cell diagnostic plan requires the typed answer-record shell.",
      "Run docsfab doctor --answer-record-diagnostic-plan --answer-record-typed --answer-record-corpus <corpus.json> --answer-record-observation-dir <retained-ledger>.",
    );
  }
  if (
    flags.has("--answer-record-qualification-cells") &&
    (!flags.has("--live") ||
      !flags.has("--answer-records") ||
      flags.has("--answer-record-small-groups") ||
      flags.has("--answer-record-typed-context") ||
      flags.has("--answer-record-typed-context-group-only"))
  ) {
    throw new DoctorArgumentsOperatorError(
      "Exact qualification cells require the live answer-record probe and cannot combine with other selection screens.",
      "Run docsfab doctor --live --answer-records --answer-record-corpus <corpus.json> --answer-record-qualification-cells [--answer-record-typed].",
    );
  }
  if (flags.has("--answer-record-qualification-cells") && !flags.has("--answer-record-typed")) {
    throw new DoctorArgumentsOperatorError(
      "The exact live qualification matrix requires the typed selection and its retained typed-ledger reservation.",
      "Run docsfab doctor --live --answer-records --answer-record-corpus <corpus.json> --answer-record-typed --answer-record-qualification-cells.",
    );
  }
  if (
    flags.has("--answer-record-qualification-cells") !==
    values.has("--answer-record-qualification-fingerprint")
  ) {
    throw new DoctorArgumentsOperatorError(
      "Exact live qualification requires the fingerprint from the reviewed provider-free plan, and the fingerprint is valid only with exact qualification cells.",
      "Run the provider-free qualification plan, review its qualificationFingerprint, then pass --answer-record-qualification-cells --answer-record-qualification-fingerprint <sha256> to the matching live command.",
    );
  }
  const qualificationFingerprint = values.get("--answer-record-qualification-fingerprint");
  if (qualificationFingerprint && !/^[a-f0-9]{64}$/u.test(qualificationFingerprint)) {
    throw new DoctorArgumentsOperatorError(
      "The qualification fingerprint must be a lowercase 64-character SHA-256 digest.",
      "Copy the qualificationFingerprint field from the provider-free exact plan without changing it.",
    );
  }
  if (flags.has("--answer-record-small-groups") && !flags.has("--answer-records")) {
    throw new DoctorArgumentsOperatorError(
      "The doctor --answer-record-small-groups option requires --live --answer-records.",
      "Run docsfab doctor --live --answer-records --answer-record-corpus <corpus.json> --answer-record-small-groups.",
    );
  }
  if (
    flags.has("--answer-record-typed") &&
    !flags.has("--answer-records") &&
    !flags.has("--answer-record-qualification-plan") &&
    !flags.has("--answer-record-diagnostic-plan")
  ) {
    throw new DoctorArgumentsOperatorError(
      "The doctor --answer-record-typed option requires --live --answer-records.",
      "Run docsfab doctor --live --answer-records --answer-record-corpus <corpus.json> --answer-record-typed.",
    );
  }
  if (flags.has("--answer-record-typed") && flags.has("--answer-record-small-groups")) {
    throw new DoctorArgumentsOperatorError(
      "The doctor --answer-record-typed and --answer-record-small-groups options select different probe plans and cannot be combined.",
      "Run one answer-record probe selection at a time.",
    );
  }
  if (flags.has("--answer-record-typed-context") && !flags.has("--answer-record-typed")) {
    throw new DoctorArgumentsOperatorError(
      "The doctor --answer-record-typed-context option requires --live --answer-records --answer-record-typed.",
      "Run docsfab doctor --live --answer-records --answer-record-corpus <corpus.json> --answer-record-typed --answer-record-typed-context.",
    );
  }
  if (
    flags.has("--answer-record-typed-context-group-only") &&
    (!flags.has("--answer-record-typed") || !flags.has("--answer-record-typed-context"))
  ) {
    throw new DoctorArgumentsOperatorError(
      "The doctor --answer-record-typed-context-group-only option requires --live --answer-records --answer-record-typed --answer-record-typed-context and the exact retained six-singleton observation.",
      "Run docsfab doctor --live --answer-records --answer-record-corpus <corpus.json> --answer-record-typed --answer-record-typed-context --answer-record-typed-context-group-only only after the pinned six-singleton observation is retained.",
    );
  }
  if (
    (flags.has("--answer-records") ||
      flags.has("--answer-record-qualification-plan") ||
      flags.has("--answer-record-diagnostic-plan")) !== values.has("--answer-record-corpus")
  ) {
    throw new DoctorArgumentsOperatorError(
      "The doctor --answer-records and --answer-record-corpus options are given together or not at all.",
      "Run docsfab doctor --live --answer-records --answer-record-corpus <corpus.json>.",
    );
  }
  // `--live` and `--json` combine: the live path emits the same schema-v1
  // record, with live results in `liveConnectivity` and the draft-MR readiness
  // fields.
  const repository = values.get("--repo");
  const use = values.get("--use");
  if (use && !["local-review", "local-patch", "draft-mr"].includes(use)) {
    throw new DoctorArgumentsOperatorError(
      "The doctor --use option accepts local-review, local-patch, or draft-mr as its value.",
      "Run docsfab doctor --use local-review, --use local-patch, or --use draft-mr.",
    );
  }
  return {
    live: flags.has("--live"),
    ...(flags.has("--quiet") ? { quiet: true as const } : {}),
    ...(flags.has("--verbose") ? { verbose: true as const } : {}),
    ...(use ? { use: use as DoctorArguments["use"] } : {}),
    ...(flags.has("--answer-submission") ? { answerSubmission: true as const } : {}),
    ...(flags.has("--answer-submission-typed-contingency")
      ? { answerSubmissionTypedContingency: true as const }
      : {}),
    ...(flags.has("--answer-records") ? { answerRecords: true as const } : {}),
    ...(flags.has("--answer-record-qualification-plan")
      ? { answerRecordQualificationPlan: true as const }
      : {}),
    ...(flags.has("--answer-record-qualification-cells")
      ? { answerRecordQualificationCells: true as const }
      : {}),
    ...(qualificationFingerprint
      ? { answerRecordQualificationFingerprint: qualificationFingerprint }
      : {}),
    ...(flags.has("--answer-record-diagnostic-plan")
      ? { answerRecordDiagnosticPlan: true as const }
      : {}),
    ...(flags.has("--answer-record-diagnostic-cell")
      ? { answerRecordDiagnosticCell: true as const }
      : {}),
    ...(diagnosticFingerprint ? { answerRecordDiagnosticFingerprint: diagnosticFingerprint } : {}),
    ...(values.has("--answer-record-corpus")
      ? { answerRecordCorpus: resolve(values.get("--answer-record-corpus")!) }
      : {}),
    ...(values.has("--answer-record-observation-dir")
      ? {
          answerRecordObservationDirectory: resolve(values.get("--answer-record-observation-dir")!),
        }
      : {}),
    ...(flags.has("--answer-record-small-groups")
      ? { answerRecordSmallGroups: true as const }
      : {}),
    ...(flags.has("--answer-record-typed") ? { answerRecordTyped: true as const } : {}),
    ...(flags.has("--answer-record-typed-context")
      ? { answerRecordTypedContext: true as const }
      : {}),
    ...(flags.has("--answer-record-typed-context-group-only")
      ? { answerRecordTypedContextGroupOnly: true as const }
      : {}),
    catalog: flags.has("--catalog"),
    purpose: flags.has("--judge") ? "judge" : "policy",
    json: flags.has("--json"),
    ...(repository ? { repositoryPath: resolve(repository) } : {}),
  };
}

export function loadProfileInspectionConfig(
  args: ProfileInspectionArguments,
): DocsFabConfig | undefined {
  try {
    const config = loadConfig();
    const endpoint = args.purpose === "judge" ? config.judge : config.model;
    if (endpoint?.apiFormat !== "chat_completions" && endpoint?.apiFormat !== "messages") {
      emitUnsupportedApiFormat(args);
      return undefined;
    }
    return config;
  } catch (error) {
    if (!isOnlyUnsupportedApiFormatIssue(error, args.purpose)) {
      if (error instanceof ModelProfileMigrationError && error.reason === "invalid-profile") {
        throw new InvalidModelProfileConfigurationError(error.issues);
      }
      throw error;
    }
    const report = unsupportedApiFormatInspection(args.purpose);
    if (args.json) console.log(serializeModelProfileInspectionPreflight(report));
    else writeCliPresentation(projectProfileInspectionPreflight(report));
    return undefined;
  }
}

export function loadSelectedProfileInspectionEndpoint(
  args: ProfileInspectionArguments,
): ModelEndpointConfig | undefined {
  try {
    const endpoint = loadModelEndpointForInspection(args.purpose);
    if (endpoint.apiFormat !== "chat_completions" && endpoint.apiFormat !== "messages") {
      emitUnsupportedApiFormat(args);
      return undefined;
    }
    return endpoint;
  } catch (error) {
    if (!isOnlyUnsupportedApiFormatIssue(error, args.purpose)) {
      if (error instanceof ModelProfileMigrationError && error.reason === "invalid-profile") {
        throw new InvalidModelProfileConfigurationError(error.issues);
      }
      throw error;
    }
    const report = unsupportedApiFormatInspection(args.purpose);
    if (args.json) console.log(serializeModelProfileInspectionPreflight(report));
    else writeCliPresentation(projectProfileInspectionPreflight(report));
    return undefined;
  }
}

function emitUnsupportedApiFormat(args: ProfileInspectionArguments): void {
  const report = unsupportedApiFormatInspection(args.purpose);
  if (args.json) console.log(serializeModelProfileInspectionPreflight(report));
  else writeCliPresentation(projectProfileInspectionPreflight(report));
}

export function isOnlyUnsupportedApiFormatIssue(
  error: unknown,
  purpose: "policy" | "judge",
): error is ModelProfileMigrationError {
  if (!(error instanceof ModelProfileMigrationError)) return false;
  const profile = purpose === "judge" ? "JUDGE" : "MODEL";
  const field = purpose === "judge" ? "JUDGE_API_FORMAT" : "MODEL_API_FORMAT";
  return (
    error.issues.length === 1 &&
    error.issues[0]?.profile === profile &&
    error.issues[0].field === field
  );
}
