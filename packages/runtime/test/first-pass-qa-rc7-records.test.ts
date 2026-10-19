// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterAll } from "vitest";
import { registerQaRecordScenarios } from "./first-pass-qa-rc7-records.scenarios.js";
import { preparePublicQaPartition } from "./helpers/public-qa-partition.js";

const fixture = await preparePublicQaPartition();
afterAll(fixture.cleanup);
registerQaRecordScenarios(fixture.inputs);
