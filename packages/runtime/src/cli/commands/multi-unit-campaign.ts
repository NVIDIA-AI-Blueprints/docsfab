// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { runMultiUnitCampaignCli } from "../../autonomy/multi-unit-campaign-cli.js";
import { reportOperatorFailure, wantsJsonFailureOutput } from "../../operator/error-envelope.js";

/**
 * `docsfab multi-unit-campaign`: a thin wire into the autonomy dry-run ledger
 * driver.
 */
export async function handleMultiUnitCampaignCommand(args: string[]): Promise<void> {
  try {
    await runMultiUnitCampaignCli(args, {
      cwd: process.cwd(),
      log: (message) => console.log(message),
    });
  } catch (error) {
    reportOperatorFailure(error, { json: wantsJsonFailureOutput(args) });
    process.exitCode = 1;
  }
}
