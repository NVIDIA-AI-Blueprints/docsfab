// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { registerLiveAgentFailureGateScenarios } from "./live-agent-workflow-failure-gate.scenarios.js";
import { PUBLIC_LIVE_REQUESTS } from "./helpers/runtime-scenario-inputs.js";

registerLiveAgentFailureGateScenarios(PUBLIC_LIVE_REQUESTS);
