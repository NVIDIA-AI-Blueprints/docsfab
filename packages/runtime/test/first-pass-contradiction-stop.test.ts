// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterAll } from "vitest";
import { registerContradictionStopScenarios } from "./first-pass-contradiction-stop.scenarios.js";
import { preparePublicQaPartition } from "./helpers/public-qa-partition.js";

const fixture = await preparePublicQaPartition();
afterAll(fixture.cleanup);
registerContradictionStopScenarios(fixture.inputs);
