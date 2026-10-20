// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createRequire } from "node:module";
import { __INTERNAL } from "vitest/runtime";

import { installCoverageModuleOffset } from "../../scripts/vitest-coverage-module-offset.mjs";

const require = createRequire(import.meta.url);
installCoverageModuleOffset({
  coverage: __INTERNAL.getWorkerState().config.coverage,
  version: require("vitest/package.json").version,
  Evaluator: __INTERNAL.VitestModuleEvaluator,
});
