#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { ensureBuiltInProxy } from "./model/outbound-http-policy.js";
import { isProcessEntrypoint } from "./operator/cli-entrypoint.js";
import { reportLocalCliFailure } from "./operator/local-cli-failure.js";
import { main } from "./cli/router.js";

export type { RunArguments } from "./cli/types.js";
export type {
  DoctorArguments,
  ProfileApproveArguments,
  ProfileInspectionArguments,
  ProfileRollbackArguments,
} from "./cli/profile-arguments.js";
export { createPrintProgressHandler } from "./cli/progress.js";
export {
  formatIaPlanContinuation,
  formatIaTaskArguments,
} from "./cli/ia-format.js";
export {
  isOnlyUnsupportedApiFormatIssue,
  parseDoctorArguments,
  parseProfileApproveArguments,
  parseProfileInspectionArguments,
  parseProfileRollbackArguments,
} from "./cli/profile-arguments.js";
export { parseRunArguments } from "./cli/run-arguments.js";
export { parseCommentMrTarget } from "./cli/comment-existing-mr-target.js";
export { executeRunRequest } from "./cli/run-request.js";
export {
  GOLDEN_OUTCOME_REQUEST,
  routeOutcomeRequest,
  buildOutcomeRouteEnvelope,
} from "./cli/outcome-router.js";
export { parseDoArguments, handleDoCommand } from "./cli/commands/do.js";
export {
  formatConfigInspection,
  handleConfigCommand,
  inspectEffectiveConfiguration,
  parseConfigInspectArguments,
} from "./cli/commands/config.js";
export { main };

if (isProcessEntrypoint(import.meta.url)) {
  ensureBuiltInProxy();
  main().catch((error: unknown) => {
    reportLocalCliFailure(error);
    process.exitCode = 1;
  });
}
