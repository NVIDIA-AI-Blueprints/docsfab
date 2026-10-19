// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export {
  NATIVE_PREFLIGHT_LIMITS,
  NativePreflightHostError,
  createClaudeNativePreflightAdapter,
  createCodexNativePreflightAdapter,
  type NativeCompositionPreflightAdapter,
  type NativeExecutableObservation,
  type NativePreflightHost,
  type NativePreflightProcessObservation,
  type NativePreflightProcessRequest,
  type NativePreflightProcessStatus,
} from "./adapters.js";
export {
  createLocalNativePreflightHost,
  resolveLocalNativeExecutable,
} from "./local-host.js";
export {
  CLAUDE_PREFLIGHT_REPORTED_VERSION,
  CODEX_GPT_6_PREFLIGHT_REPORTED_VERSION,
  CODEX_PREFLIGHT_REPORTED_VERSION,
  CODEX_PREFLIGHT_REPORTED_VERSIONS,
  NATIVE_PREFLIGHT_ADAPTER_VERSION,
  NATIVE_PREFLIGHT_ENVIRONMENT_NAMES,
  NATIVE_PREFLIGHT_FAILURE_CODES,
  NATIVE_PREFLIGHT_INPUT_KIND,
  NATIVE_PREFLIGHT_OBSERVATION_KIND,
  NativePreflightContractError,
  parseNativePreflightInputV1,
  parseNativePreflightObservationV1,
  sealNativePreflightObservationV1,
  type NativeHarnessId,
  type NativeExecutableBasename,
  type NativePreflightAdapterId,
  type NativePreflightContractErrorCode,
  type NativePreflightFailureCode,
  type NativePreflightInputV1,
  type NativePreflightLimitNoticeV1,
  type NativePreflightObservationV1,
  type NativePreflightOperation,
  type NativePreflightProcessEvidence,
  type NativePreflightTerminalCode,
  type NativeRouteId,
} from "./contracts.js";
export {
  buildNativePreflightEnvironment,
  handleCompositionCommand,
  parseCompositionCliArguments,
  type CompositionCliArguments,
  type CompositionCliDependencies,
} from "./cli.js";
