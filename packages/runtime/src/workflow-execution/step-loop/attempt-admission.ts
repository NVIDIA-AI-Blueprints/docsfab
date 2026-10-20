// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** Durable answer-record checkpoint authority across inference retries. */

import type { QualityAnswerRecordSessionV1 } from "../../execution/contracts.js";
import type {
  AnswerRecordContinuationCheckpointEnvelopeV1,
  AnswerRecordLedgerIndexV1,
  RunRecord,
  StepRunRecord,
} from "../../records/contracts.js";
import {
  resetAuthoringRevisionForRetry,
  type AuthoringRevisionReplayV1,
} from "../revision-accounting-round.js";

interface Checkpoint {
  readonly record: AnswerRecordContinuationCheckpointEnvelopeV1;
  readonly sha256: string;
}

export interface AttemptAdmissionPort {
  readonly record: RunRecord;
  readonly stepRecord: StepRunRecord;
  readonly initialCheckpoint?: Checkpoint;
  readonly initialSourceRunId: string;
  readonly hasContinuation: boolean;
  readonly save: () => Promise<void>;
  readonly publish: () => Promise<void>;
  readonly claim?: () => Promise<void>;
}

export function createAttemptAdmission(port: AttemptAdmissionPort) {
  let latestCheckpoint = port.initialCheckpoint;
  let sourceRunId = port.initialSourceRunId;
  let continuationClaimed = false;

  return {
    get checkpoint() {
      return latestCheckpoint;
    },
    get sourceRunId() {
      return sourceRunId;
    },
    async beginAttempt(attempt: number, revisionReplay?: AuthoringRevisionReplayV1): Promise<void> {
      if (revisionReplay && attempt > 1) await resetAuthoringRevisionForRetry(revisionReplay);
    },
    async onCheckpoint(
      attempt: number,
      checkpoint: AnswerRecordContinuationCheckpointEnvelopeV1,
      sha256: string,
      index: AnswerRecordLedgerIndexV1,
    ): Promise<void> {
      const previousPointer = port.stepRecord.answerRecordCheckpoint;
      const previousIndex = port.stepRecord.answerRecordLedger;
      port.stepRecord.answerRecordCheckpoint = { sha256, sequence: checkpoint.sequence, attempt };
      port.stepRecord.answerRecordLedger = index;
      try {
        await port.save();
      } catch (error) {
        if (previousPointer) port.stepRecord.answerRecordCheckpoint = previousPointer;
        else delete port.stepRecord.answerRecordCheckpoint;
        if (previousIndex) port.stepRecord.answerRecordLedger = previousIndex;
        else delete port.stepRecord.answerRecordLedger;
        throw error;
      }
      // A saved pointer is the recovery authority even if its projection fails.
      latestCheckpoint = { record: checkpoint, sha256 };
      sourceRunId = port.record.id;
      await port.publish();
    },
    async admitSession(session: QualityAnswerRecordSessionV1, attempt: number): Promise<void> {
      if (session.checkpointWasStale()) {
        if (port.hasContinuation) {
          throw new Error("The selected answer-record checkpoint is stale for this route.");
        }
        latestCheckpoint = undefined;
        delete port.stepRecord.answerRecordCheckpoint;
        delete port.stepRecord.answerRecordLedger;
        await port.save();
        await port.publish();
      }
      if (port.hasContinuation && !continuationClaimed) {
        if (!port.claim) {
          throw new Error("The resumed answer-record checkpoint has no host claim boundary.");
        }
        // Claim follows authenticated restore and precedes child pointer publication.
        await port.claim();
        continuationClaimed = true;
      }
      if (port.hasContinuation && latestCheckpoint) {
        await session.materializeContinuationCheckpoint();
      }
      if (latestCheckpoint) {
        const restoredIndex = await session.snapshotIndex();
        if (!restoredIndex) {
          throw new Error("The selected answer-record checkpoint did not restore its exact index.");
        }
        port.stepRecord.answerRecordCheckpoint = {
          sha256: latestCheckpoint.sha256,
          sequence: latestCheckpoint.record.sequence,
          attempt,
        };
        port.stepRecord.answerRecordLedger = restoredIndex;
        await port.save();
        await port.publish();
      }
    },
    async refreshProjection(session?: QualityAnswerRecordSessionV1): Promise<void> {
      const index = await session?.snapshotIndex();
      if (!index) return;
      const pointer = port.stepRecord.answerRecordCheckpoint;
      if (
        (pointer &&
          (pointer.sha256 !== index.checkpoint?.sha256 ||
            pointer.sequence !== index.checkpoint.sequence)) ||
        (!pointer && index.checkpoint)
      ) {
        // Never replace a durable pointer's index with an older in-memory snapshot.
        return;
      }
      port.stepRecord.answerRecordLedger = index;
    },
  };
}
