// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { registerContextPreflightScenarios } from "./context-preflight.scenarios.js";
import { populateCodeOnlyRepository } from "./helpers/public-runtime-inputs.js";

registerContextPreflightScenarios({ populateNoDoc: populateCodeOnlyRepository });
