// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// Wiring contracts joining the harness, run store, and host supplied source evidence.

import type { RunStore } from "../../records/contracts.js";
import type {
  AgentHarness,
  GovernedSkillResolver,
  HostOperationExecutor,
} from "./harness-protocol.js";

/**
 * Host-supplied source-evidence binding: workspace identity, repository content
 * digest, and step policy come from the host, never from a workflow, model
 * output, or issue label.
 */
export interface SourceEvidenceRunnerBinding {
  service: import("../../inputs/source-resolver.js").SourceEvidenceServiceV1;
  workspaceIdentitySha256: string;
  repositoryContentDigest: string;
  policy: import("../../inputs/source-step-policy.js").SourceStepPolicyV1;
  /**
   * How the policy's per-step budget was set, so a partial read or a stop names
   * the limit that bound it. Absent means the declared ceiling.
   */
  readBudgetBasis?: import("../../inputs/source-step-policy.js").SourceReadBudgetBasisV1;
  /**
   * A step gains `docsfab_search_sources` only when its policy admits search
   * and the host wired this factory.
   */
  searcherFactory?: (
    reader: import("../../inputs/source-resolver.js").SourceStepReaderV1,
  ) => import("../../inputs/source-step-search.js").SourceStepSearcherV1;
}

/** A process-local host grant; only the runner's minting module can validate it. */
export interface PrReviewCitationAdmissionV1 {
  readonly kind: "docsfab-pr-review-citation-admission";
}

export interface ExecutionServices {
  harness: AgentHarness;
  skillResolver?: GovernedSkillResolver;
  hostOperations?: HostOperationExecutor;
  store: RunStore;
  /** Process-local source-evidence host service. Never serialized. */
  sourceEvidence?: SourceEvidenceRunnerBinding;
  /** Live, exact-run grant for installed read-only PR review citations. */
  prReviewCitationAdmission?: PrReviewCitationAdmissionV1;
}
