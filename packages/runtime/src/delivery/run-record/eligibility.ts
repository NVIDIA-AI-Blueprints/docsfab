// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { RunRecord } from "../../records/contracts.js";
import {
  decodeRunRecordEditorialEvidence,
  type WorkflowOutcomeDecodeOptionsV1,
} from "../../workflow-contracts/outcome.js";
import { NO_DOCUMENT_CHANGE, PublicationRunRecordDecodeError } from "./contract.js";

export type PublicationRunRecordDecodeOptionsV1 = WorkflowOutcomeDecodeOptionsV1;

/** Delivery policy over an already admitted record; performs no publication side effect. */
export function assertRunRecordEditorialDeliveryEligible(
  record: Readonly<RunRecord>,
  options: PublicationRunRecordDecodeOptionsV1 = {},
): void {
  const editorial = decodeRunRecordEditorialEvidence(record, options);
  if (editorial.state === "current" && editorial.validated?.candidate === "no-change") {
    throw new PublicationRunRecordDecodeError(NO_DOCUMENT_CHANGE);
  }
}
