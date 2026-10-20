// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { registerContextRunnerScenarios } from "./context-runner.scenarios.js";
import { populateCodeOnlyRepository } from "./helpers/public-runtime-inputs.js";

registerContextRunnerScenarios({ populateNoDoc: populateCodeOnlyRepository });
