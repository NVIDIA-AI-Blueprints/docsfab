// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { InferenceEvidenceIdentity, InferenceTurnEvidence } from "../../records/contracts.js";
import type {
  OutputTokenAuthorityInput,
  TurnGovernorPolicy,
  TurnGovernorState,
} from "../turn-governor.js";
import type { ProviderTurnReplayVeto } from "../provider-turn-retry.js";

export interface PendingFinalTurn {
  governance: ActiveTurnGovernance;
  evidence: InferenceTurnEvidence;
  /** Ledger entry written by the first finalized attempt of this governed turn. */
  finalized?: InferenceTurnEvidence;
  retries: number;
  /** Empty provider turns observed for this governed turn, replayed or not. */
  blankTurns: number;
  /**
   * Set when the retry wrapper announced a nudged replay, cleared by the payload
   * hook that finalizes it. While set, the next finalization's payload digest
   * must differ from the first attempt's; an identical digest means the nudge
   * was dropped, and the replay fails closed.
   */
  nudgedReplayPending: boolean;
  /** The first boundary that refused a replay of this governed turn, if any. */
  replayVeto?: ProviderTurnReplayVeto;
}

export interface ActiveTurnGovernance {
  evidenceIdentity: InferenceEvidenceIdentity;
  policy: TurnGovernorPolicy;
  state: TurnGovernorState;
  ledger: InferenceTurnEvidence[];
  beforeProviderTurn?: (turn: InferenceTurnEvidence) => void;
  outputAuthority?: () => OutputTokenAuthorityInput | undefined;
}
