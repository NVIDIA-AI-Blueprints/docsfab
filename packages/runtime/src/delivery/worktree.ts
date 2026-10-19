// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Stable public entry for delivery worktree materialize/validate/publish-plan.
 * Implementation lives under ./worktree/; keep this path for CLI and tests.
 */
export {
  ExecFileDeliveryCommandRunner,
  type CleanupDeliveryWorktreeInput,
  type DeliveryCommandResult,
  type DeliveryCommandRunner,
  type DeliveryDiscardAuthorization,
  type DeliveryValidationIsolation,
  type DeliveryValidationIsolationRequest,
  type DeliveryValidationIsolator,
  type DeliveryWorktreeCapability,
  type DeliveryWorktreeReadyAttestation,
  type PrepareDeliveryWorktreeInput,
  type PrepareDeliveryWorktreeResult,
  type PublishedDeliveryCleanupAuthorization,
} from "./worktree/types.js";

export { prepareDeliveryWorktree, readPreservedDeliveryPatch } from "./worktree/materialize.js";

export {
  NestedSandboxIsolationError,
  assertDeliveryWorktreeReadyAttestation,
  inspectReadyDeliveryWorktree,
  nestedExecuteHostMustStayConfined,
  validationIsolationCandidates,
} from "./worktree/validate.js";

export {
  archiveDeliveryWorktree,
  authorizeDeliveryDiscard,
  authorizePublishedDeliveryCleanup,
  cleanupDeliveryWorktree,
} from "./worktree/publish-plan.js";
