// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Stable public entry for DocsFab init.
 * Implementation lives under ./init/; keep this path for CLI and tests.
 */
export {
  DOCSFAB_PROJECT_CONFIG_FILE,
  type InitDoctorStatus,
  type InitNextAction,
  type InitProviderStatus,
  type DocsFabInitArguments,
  type DocsFabInitDependencies,
  type DocsFabInitMutationBoundary,
  type DocsFabInitMutationHooks,
  type DocsFabInitPlan,
  type DocsFabInitPrompt,
  type DocsFabPrivateRoots,
  type DocsFabProjectConfigV1,
} from "./init/types.js";

export {
  allocateDocsFabPrivateRoots,
  assertDocsFabProjectConfig,
  parseDocsFabInitArguments,
  resolveDocsFabPrivateRoots,
  runDocsFabInit,
} from "./init/plan.js";

export {
  formatInitFailure,
  formatDocsFabInitPlan,
  mapInitFailure,
  serializeInitFailure,
  serializeDocsFabInitPlan,
} from "./init/render.js";

export {
  bootstrapMissingProjectConfigIntoWorkspace,
  planHostDerivedProjectConfig,
  writeProvisionalProjectConfig,
  type FirstRunProjectConfigResult,
  type HostDerivedProjectConfig,
} from "./init/first-run-bootstrap.js";
