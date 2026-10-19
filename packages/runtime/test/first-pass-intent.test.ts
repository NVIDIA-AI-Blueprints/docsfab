// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { registerFirstPassIntentScenarios } from "./first-pass-intent.scenarios.js";
import { PUBLIC_FIRST_PASS_REQUESTS } from "./helpers/runtime-scenario-inputs.js";

registerFirstPassIntentScenarios(PUBLIC_FIRST_PASS_REQUESTS);
