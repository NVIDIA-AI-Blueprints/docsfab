// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, resolve } from "node:path";

import {
  MAX_COMPOSITION_COMPARISON_RECORDS,
  compareCompositionRunRecordFiles,
  listInstalledModelCompositions,
  loadInstalledModelCompositionAuthority,
  assertCompositionNotRetired,
  resolveInstalledComposition,
  type BoundInstalledComposition,
  type InstalledModelCompositionSummary,
  type CompositionComparisonDecodeOptionsV1,
} from "../model-composition/index.js";
import { loadSavedRunEditorialDecodeOptions } from "../cli/run/editorial-replay.js";
import { renderCliPresentation } from "../cli/presentation.js";
import type { RunRecord } from "../records/contracts.js";
import {
  createClaudeNativePreflightAdapter,
  createCodexNativePreflightAdapter,
  type NativeExecutableObservation,
  type NativePreflightHost,
} from "./adapters.js";
import { canonicalDigest } from "../contract-kit/index.js";
import {
  CLAUDE_PREFLIGHT_REPORTED_VERSION,
  CODEX_GPT_6_PREFLIGHT_REPORTED_VERSION,
  CODEX_PREFLIGHT_REPORTED_VERSION,
  NATIVE_PREFLIGHT_ADAPTER_VERSION,
  NATIVE_PREFLIGHT_INPUT_KIND,
  type NativeExecutableBasename,
  type NativeHarnessId,
  type NativePreflightInputV1,
} from "./contracts.js";
import { createLocalNativePreflightHost, resolveLocalNativeExecutable } from "./local-host.js";
import {
  handlePilotCampaignCommand,
  parsePilotCampaignCliArguments,
  type PilotCampaignCliArguments,
  type PilotCampaignCliDependencies,
} from "./pilot-cli.js";
import {
  projectCompositionComparison,
  projectCompositionList,
  projectCompositionPreflight,
} from "./presentation.js";

const PREFLIGHT_OVERALL_TIMEOUT_MS = 45_000;
const MAX_CLI_ARGUMENTS = 2 + MAX_COMPOSITION_COMPARISON_RECORDS * 2;
const MAX_CLI_ARGUMENT_BYTES = 4096;
/**
 * Codex 0.155.1 executable policy for `openai-gpt-6-sol-codex-preflight`
 * (#1512). The qualifying observation is the live preflight run on
 * 2026-09-28 against a build of the record. Like the 0.147.0 pin, the
 * preflight enforces the reported version, not these executable bytes; they
 * record which binary the pin was taken from.
 */
export const CODEX_0_155_1_EXECUTABLE_POLICY = Object.freeze({
  schemaVersion: 1,
  kind: "docsfab-codex-preflight-executable-policy",
  harnessId: "codex",
  reportedVersion: CODEX_GPT_6_PREFLIGHT_REPORTED_VERSION,
  basenames: ["codex", "codex.exe"],
  qualifyingObservation: {
    observedAt: "2026-09-28",
    executableSha256: "8eaf1ad12fe6bf89b1710330f58900014322c7c5af677e43be116d8ac5fc0a9e",
    identitySha256: "da932e583204c8f039fb6d1012ca2ea01978f32c409792c05a83ce8a3a2fcb7e",
  },
});

/**
 * Codex 0.155.1 harness policy: three fixed commands, no model or workflow
 * egress. This preflight is NOT provider-offline. Its bundled catalog is stale
 * (no gpt-6-sol), so availability is judged against the authenticated account
 * catalog (`codex debug models`, no `--bundled`). Codex fetches that catalog
 * from the provider with the operator's ChatGPT session, and only after
 * authentication is ready. No model request, prompt, repository content, or
 * credential is sent to Codex: the one provider contact is that authenticated
 * catalog read. The catalog entry records what that Codex reported for the
 * requested slug ("GPT-6 Sol · Medium" in the provider notice); the preflight
 * requests no reasoning level, so it is provenance, not an enforced setting.
 * The 0.147.0 pin (`--bundled`) stays provider-offline.
 */
export const CODEX_0_155_1_HARNESS_POLICY = Object.freeze({
  schemaVersion: 1,
  kind: "docsfab-codex-preflight-harness-policy",
  harnessId: "codex",
  adapterId: "codex-preflight",
  reportedVersion: CODEX_GPT_6_PREFLIGHT_REPORTED_VERSION,
  commands: [["--version"], ["login", "status"], ["debug", "models"]],
  catalogSource: "codex-account",
  modelEgress: "unavailable",
  workflowExecution: "unavailable",
  catalogModel: { slug: "gpt-6-sol", defaultReasoningLevel: "medium" },
});

interface CodexPreflightPin {
  readonly reportedVersion: string;
  readonly executablePolicySha256: string;
  readonly environmentPolicySha256: string;
  readonly harnessPolicySha256: string;
}

const CODEX_ENVIRONMENT_POLICY_SHA256 =
  "8c40f0b77cbffae8a8c795f5392a4bd9dfc8227d34bb57c248617cd87576b7a3";

/**
 * Codex pins keyed by the installed Codex adapter record version. 1.0.0 is the
 * sealed 0.147.0 pin, kept byte-for-byte so the retired GPT-5.6 record and the
 * frozen pilot keep binding; 1.1.0 is the 0.155.1 pin derived from the
 * policies above.
 */
export const CODEX_PREFLIGHT_PINS: Readonly<Record<string, CodexPreflightPin>> = Object.freeze({
  "1.0.0": Object.freeze({
    reportedVersion: CODEX_PREFLIGHT_REPORTED_VERSION,
    executablePolicySha256: "04fd94b48afe2d6b4f3b86a5e6af93180c16f9fbb45fa3b7edccf01d302ab837",
    environmentPolicySha256: CODEX_ENVIRONMENT_POLICY_SHA256,
    harnessPolicySha256: "0cf7bff90bb7c0a91786672ae7cdbb4da4afc7c6456152d609d213896114d8e4",
  }),
  "1.1.0": Object.freeze({
    reportedVersion: CODEX_GPT_6_PREFLIGHT_REPORTED_VERSION,
    executablePolicySha256: canonicalDigest(CODEX_0_155_1_EXECUTABLE_POLICY),
    environmentPolicySha256: CODEX_ENVIRONMENT_POLICY_SHA256,
    harnessPolicySha256: canonicalDigest(CODEX_0_155_1_HARNESS_POLICY),
  }),
});

const NATIVE_PREFLIGHT_POLICY = {
  codex: {
    executableVariable: "DOCSFAB_CODEX_EXECUTABLE",
    authenticationAdapterId: "codex-chatgpt-auth",
    authenticationSource: "codex-auth-store",
  },
  "claude-code": {
    executableVariable: "DOCSFAB_CLAUDE_EXECUTABLE",
    authenticationAdapterId: "claude-ai-oauth",
    authenticationSource: "claude-auth-store",
  },
} as const;

const CLAUDE_EXECUTABLE_POLICY_SHA256 =
  "6699a7e5ac176f1feaa044f285a73573d09543689a24a1b910a43fe4ff58fd3a";
const CLAUDE_ENVIRONMENT_POLICY_SHA256 =
  "0b8922709c0ee752fa30c43c1506ea30df395ff7e5b750f073fb091ed8dff7d5";

export type CompositionCliArguments =
  | { readonly command: "list"; readonly json: boolean }
  | { readonly command: "preflight"; readonly compositionId: string; readonly json: boolean }
  | {
      readonly command: "compare";
      readonly recordPaths: readonly string[];
      readonly json: boolean;
    }
  | PilotCampaignCliArguments;

export interface CompositionCliDependencies {
  readonly environment?: NodeJS.ProcessEnv;
  readonly createHost?: () => NativePreflightHost;
  readonly resolveExecutable?: (
    harnessId: NativeHarnessId,
    searchPath: string | undefined,
  ) => Promise<string>;
  readonly pilotCampaign?: Omit<PilotCampaignCliDependencies, "environment" | "log">;
  readonly log?: (message: string) => void;
  readonly comparisonDecodeOptions?: CompositionComparisonDecodeOptionsV1;
}

export function parseCompositionCliArguments(args: readonly string[]): CompositionCliArguments {
  if (
    args.length === 0 ||
    args.length > MAX_CLI_ARGUMENTS ||
    args.some((argument) => argument.length === 0 || argument.length > MAX_CLI_ARGUMENT_BYTES)
  ) {
    throw new Error(
      "docsfab composition requires exactly one list, preflight, compare, or pilot-campaign command.",
    );
  }
  const command = args[0];
  const jsonCount = args.filter((argument) => argument === "--json").length;
  if (jsonCount > 1)
    throw new Error("The --json option must not be duplicated on composition commands.");
  const json = jsonCount === 1;

  if (command === "pilot-campaign") {
    return parsePilotCampaignCliArguments(args.slice(1));
  }

  if (command === "list") {
    const remaining = args.slice(1).filter((argument) => argument !== "--json");
    if (remaining.length !== 0) {
      throw new Error(`Unknown docsfab composition list option "${remaining[0]}".`);
    }
    return { command: "list", json };
  }
  if (command === "compare") {
    const remaining = args.slice(1).filter((argument) => argument !== "--json");
    if (
      remaining.length < 4 ||
      remaining.length > MAX_COMPOSITION_COMPARISON_RECORDS * 2 ||
      remaining.length % 2 !== 0
    ) {
      throw new Error(
        "docsfab composition compare requires 2 to 8 --record <absolute-json> inputs.",
      );
    }
    const recordPaths: string[] = [];
    for (let index = 0; index < remaining.length; index += 2) {
      if (remaining[index] !== "--record" || !isAbsolute(remaining[index + 1] ?? "")) {
        throw new Error(
          "docsfab composition compare requires 2 to 8 --record <absolute-json> inputs.",
        );
      }
      recordPaths.push(remaining[index + 1]!);
    }
    return { command: "compare", recordPaths, json };
  }
  if (command !== "preflight") {
    throw new Error(
      `Unknown docsfab composition command "${command}"; choose a documented command.`,
    );
  }

  const remaining = args.slice(1).filter((argument) => argument !== "--json");
  if (
    remaining.length !== 2 ||
    remaining[0] !== "--composition" ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(remaining[1] ?? "")
  ) {
    throw new Error(
      "docsfab composition preflight requires --composition <installed-composition-id> as one explicit selection.",
    );
  }
  return { command: "preflight", compositionId: remaining[1]!, json };
}

export async function handleCompositionCommand(
  args: readonly string[],
  dependencies: CompositionCliDependencies = {},
): Promise<void> {
  const request = parseCompositionCliArguments(args);
  const log = dependencies.log ?? console.log;

  if (request.command === "pilot-campaign") {
    await handlePilotCampaignCommand(request, {
      ...dependencies.pilotCampaign,
      environment: dependencies.environment ?? process.env,
      log,
    });
    return;
  }

  if (request.command === "compare") {
    const report = await compareCompositionRunRecordFiles(
      request.recordPaths,
      dependencies.comparisonDecodeOptions ?? {
        resolveWorkflowOutcomeDecodeOptions: (record, path) =>
          loadSavedRunEditorialDecodeOptions(record as RunRecord, dirname(path)),
      },
    );
    log(
      request.json
        ? JSON.stringify(report, null, 2)
        : renderCliPresentation(projectCompositionComparison(report)).stdout.trimEnd(),
    );
    if (!report.comparable) process.exitCode = 1;
    return;
  }

  const installed = await loadInstalledModelCompositionAuthority();
  const compositions = listInstalledModelCompositions(installed.authority);

  if (request.command === "list") {
    log(
      request.json
        ? formatCompositionListJson(compositions)
        : renderCliPresentation(projectCompositionList(compositions)).stdout.trimEnd(),
    );
    return;
  }

  // The installed resolver currently verifies a composition and one workflow
  // as a single package binding. Native preflight consumes no workflow; this
  // deterministic anchor exists only to force verification of that full
  // immutable package before the composition is selected.
  const workflowId = installed.snapshot.workflowIds[0];
  if (!workflowId) throw new Error("The installed composition package has no workflow anchor.");
  const composition = resolveInstalledComposition({
    authority: installed.authority,
    compositionId: request.compositionId,
    workflowId,
  });
  assertCompositionNotRetired(composition.composition);
  assertPreflightComposition(composition);

  const harnessId = composition.composition.harness.id as NativeHarnessId;
  const environment = dependencies.environment ?? process.env;
  const nativePolicy = NATIVE_PREFLIGHT_POLICY[harnessId];
  const configuredExecutable = environment[nativePolicy.executableVariable]?.trim();
  if (!configuredExecutable) {
    throw new Error(
      `Native preflight requires the explicit ${nativePolicy.executableVariable} host setting before executable inspection.`,
    );
  }
  const executablePath = await (dependencies.resolveExecutable ?? resolveLocalNativeExecutable)(
    harnessId,
    configuredExecutable,
  );
  const host = (dependencies.createHost ?? createLocalNativePreflightHost)();
  const signal = AbortSignal.timeout(PREFLIGHT_OVERALL_TIMEOUT_MS);
  const executable = await host.inspectExecutable(executablePath, signal);
  const input = buildPreflightInput(composition, executable, environment);
  const adapter =
    harnessId === "codex"
      ? createCodexNativePreflightAdapter(host)
      : createClaudeNativePreflightAdapter(host);
  const result = await adapter.preflight(input, signal);

  log(
    request.json
      ? JSON.stringify(result, null, 2)
      : renderCliPresentation(projectCompositionPreflight(result)).stdout.trimEnd(),
  );
  if (result.terminalCode !== "preflight-ready") process.exitCode = 1;
}

export function buildNativePreflightEnvironment(
  source: NodeJS.ProcessEnv,
): Readonly<Record<string, string>> {
  const result: Record<string, string> = {
    HOME: canonicalHostPath(source.HOME ?? homedir()),
    TMPDIR: canonicalHostPath(source.TMPDIR ?? tmpdir()),
  };
  for (const name of ["LANG", "LC_ALL"] as const) {
    const value = source[name];
    if (value === undefined) continue;
    if (!/^[A-Za-z0-9][A-Za-z0-9._@-]{0,63}$/u.test(value)) {
      throw new Error("The native preflight locale environment contains an invalid host value.");
    }
    result[name] = value;
  }
  for (const name of ["LOGNAME", "USER", "USERNAME"] as const) {
    const value = source[name];
    if (value === undefined) continue;
    if (!/^[A-Za-z0-9][A-Za-z0-9._@+\\-]{0,127}$/u.test(value)) {
      throw new Error("The native preflight user environment contains an invalid host value.");
    }
    result[name] = value;
  }
  return Object.freeze(
    Object.fromEntries(Object.entries(result).sort(([left], [right]) => left.localeCompare(right))),
  );
}

function buildPreflightInput(
  composition: BoundInstalledComposition,
  executable: NativeExecutableObservation,
  sourceEnvironment: NodeJS.ProcessEnv,
): NativePreflightInputV1 {
  const harnessId = composition.composition.harness.id as NativeHarnessId;
  const basename = executable.basename as NativeExecutableBasename;
  if (!matchesHarnessBasename(harnessId, basename)) {
    throw new Error("The resolved native executable does not match the installed harness.");
  }
  return {
    schemaVersion: 1,
    kind: NATIVE_PREFLIGHT_INPUT_KIND,
    harnessId,
    routeId: harnessId === "codex" ? "codex-chatgpt-managed" : "claude-ai-managed",
    executionClass: "preflight-only",
    requestedModel: composition.composition.model.resolvedId,
    executablePath: executable.canonicalPath,
    expectedExecutable: {
      basename,
      sha256: executable.sha256,
      identitySha256: executable.identitySha256,
      reportedVersion:
        harnessId === "codex"
          ? requireCodexPin(composition).reportedVersion
          : CLAUDE_PREFLIGHT_REPORTED_VERSION,
    },
    environment: buildNativePreflightEnvironment(sourceEnvironment),
  };
}

/** The Codex pin selected by the record's adapter record version. */
function requireCodexPin(composition: BoundInstalledComposition): CodexPreflightPin {
  const version = composition.adapters.authentication.version;
  const pin = Object.hasOwn(CODEX_PREFLIGHT_PINS, version)
    ? CODEX_PREFLIGHT_PINS[version]
    : undefined;
  if (!pin || composition.adapters.harness.version !== version) {
    throw new Error("The selected composition is not an installed native preflight composition.");
  }
  return pin;
}

/** The executable, environment, and harness digests each native record must bind. */
function expectedNativePolicy(composition: BoundInstalledComposition):
  | {
      readonly adapterVersion: string;
      readonly executablePolicySha256: string;
      readonly environmentPolicySha256: string;
      readonly harnessPolicySha256: string | undefined;
    }
  | undefined {
  const harnessId = composition.composition.harness.id;
  if (harnessId === "codex") {
    const pin = requireCodexPin(composition);
    return { adapterVersion: composition.adapters.authentication.version, ...pin };
  }
  if (harnessId === "claude-code") {
    return {
      adapterVersion: NATIVE_PREFLIGHT_ADAPTER_VERSION,
      executablePolicySha256: CLAUDE_EXECUTABLE_POLICY_SHA256,
      environmentPolicySha256: CLAUDE_ENVIRONMENT_POLICY_SHA256,
      harnessPolicySha256: undefined,
    };
  }
  return undefined;
}

function assertPreflightComposition(composition: BoundInstalledComposition): void {
  const value = composition.composition;
  const harnessId = value.harness.id;
  const nativePolicy =
    harnessId === "codex" || harnessId === "claude-code"
      ? NATIVE_PREFLIGHT_POLICY[harnessId]
      : undefined;
  const pinned = nativePolicy ? expectedNativePolicy(composition) : undefined;
  if (
    value.status !== "active" ||
    value.executionClass !== "preflight-only" ||
    value.deployment.transport !== "opaque-cli-managed" ||
    value.deployment.bindingKind !== "opaque-cli-managed" ||
    !["codex", "claude-code"].includes(harnessId) ||
    nativePolicy === undefined ||
    value.deployment.routeId !==
      (harnessId === "codex" ? "codex-chatgpt-managed" : "claude-ai-managed") ||
    composition.candidate.status !== "candidate" ||
    composition.candidate.approvalStatus !== "not-approved" ||
    composition.candidate.modelRequest !== "blocked" ||
    composition.adapters.routeEvidence.status !== "preflight-only" ||
    composition.adapters.authentication.status !== "preflight-only" ||
    composition.adapters.authentication.id !== nativePolicy.authenticationAdapterId ||
    pinned === undefined ||
    composition.adapters.authentication.version !== pinned.adapterVersion ||
    composition.adapters.authentication.sourceNames.length !== 1 ||
    composition.adapters.authentication.sourceNames[0] !== nativePolicy.authenticationSource ||
    composition.adapters.authentication.executablePolicySha256 !== pinned.executablePolicySha256 ||
    composition.adapters.authentication.environmentPolicySha256 !==
      pinned.environmentPolicySha256 ||
    (pinned.harnessPolicySha256 !== undefined &&
      (composition.adapters.harness.harnessPolicySha256 !== pinned.harnessPolicySha256 ||
        value.harness.policySha256 !== pinned.harnessPolicySha256)) ||
    composition.adapters.providerConnection.status !== "preflight-only" ||
    composition.adapters.providerConnection.executionClass !== "preflight-only" ||
    composition.adapters.providerConnection.id !==
      (harnessId === "codex" ? "codex-preflight-no-egress" : "claude-code-preflight-no-egress") ||
    composition.adapters.harness.status !== "preflight-only" ||
    composition.adapters.harness.executionClass !== "preflight-only" ||
    composition.adapters.harness.id !==
      (harnessId === "codex" ? "codex-preflight" : "claude-code-preflight") ||
    composition.adapters.harness.version !== pinned.adapterVersion ||
    composition.technicalApproval !== "not-established" ||
    composition.releaseEligible !== false
  ) {
    throw new Error("The selected composition is not an installed native preflight composition.");
  }
}

function matchesHarnessBasename(
  harnessId: NativeHarnessId,
  basename: NativeExecutableBasename,
): boolean {
  return harnessId === "codex"
    ? basename === "codex" || basename === "codex.exe"
    : basename === "claude" || basename === "claude.exe";
}

function canonicalHostPath(value: string): string {
  if (!isAbsolute(value) || /\0/u.test(value)) {
    throw new Error("The native preflight host path must be one canonical absolute path.");
  }
  return resolve(value);
}

function formatCompositionListJson(
  compositions: readonly InstalledModelCompositionSummary[],
): string {
  return JSON.stringify(
    {
      schemaVersion: 1,
      kind: "docsfab-installed-model-composition-list",
      technicalApproval: "not-established",
      releaseEligible: false,
      compositions: compositions.map(publicCompositionSummary),
    },
    null,
    2,
  );
}

/** Public composition facts exclude private retirement evidence. */
function publicCompositionSummary(composition: InstalledModelCompositionSummary) {
  const retirement = composition.retirement;
  return {
    compositionId: composition.compositionId,
    status: composition.status,
    executionClass: composition.executionClass,
    modelId: composition.modelId,
    provider: composition.provider,
    routeId: composition.routeId,
    transport: composition.transport,
    harnessId: composition.harnessId,
    technicalApproval: composition.technicalApproval,
    releaseEligible: composition.releaseEligible,
    ...(retirement
      ? {
          retirement: {
            reason: retirement.reason,
            effectiveAt: retirement.effectiveAt,
            ...(retirement.successorCompositionId !== undefined
              ? { successorCompositionId: retirement.successorCompositionId }
              : {}),
          },
        }
      : {}),
  };
}
