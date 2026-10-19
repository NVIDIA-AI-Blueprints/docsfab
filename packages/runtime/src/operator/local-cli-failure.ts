// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { localMissingModelProfileLocator } from "../model/configuration.js";
import {
  type OperatorErrorEnvelope,
  reportOperatorFailure,
  wantsJsonFailureOutput,
} from "./error-envelope.js";

/** Local terminal reporting; shared and hosted failure envelopes remain private. */
export function reportLocalCliFailure(
  error: unknown,
  options: {
    readonly argv?: readonly string[];
    readonly write?: (line: string) => void;
  } = {},
): OperatorErrorEnvelope {
  const argv = options.argv ?? process.argv;
  const json = wantsJsonFailureOutput(argv);
  const write = options.write ?? ((line: string) => console.error(line));
  const envelope = reportOperatorFailure(error, { json, write });
  if (!json && argv[2] === "run") {
    const locator = localMissingModelProfileLocator(error);
    if (locator) write(locator.join("\n"));
  }
  return envelope;
}
