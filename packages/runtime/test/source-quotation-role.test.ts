// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { resolve } from "node:path";
import { registerSourceQuotationScenarios } from "./source-quotation-role.scenarios.js";
import { PUBLIC_QA_INPUTS } from "./helpers/qa-partition-inputs.js";

registerSourceQuotationScenarios({
  ...PUBLIC_QA_INPUTS,
  fixtureRoot: resolve(import.meta.dirname, "fixtures/public-runtime/first-pass-local-cli"),
});
