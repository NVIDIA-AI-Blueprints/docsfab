#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { runCampaignJudgeCli } from "./campaign-judge.js";
import { reportOperatorFailure, wantsJsonFailureOutput } from "./operator/error-envelope.js";

runCampaignJudgeCli(process.argv.slice(2))
  .then((result) => {
    console.log(JSON.stringify(result));
    process.exitCode = result.exitCode;
  })
  .catch((error: unknown) => {
    reportOperatorFailure(error, { json: wantsJsonFailureOutput() });
    process.exitCode = 1;
  });
