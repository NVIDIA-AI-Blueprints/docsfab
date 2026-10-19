// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { RuntimeDerivationRules } from "./index.js";
import {
  hostMintObligationIdentity,
  type SourceObligationLedgerProposalV1,
} from "../../workflow-execution/source-obligation.js";
import type { TechnicalFactDimension } from "../../workflow-execution/review-response.js";

type Proposal = SourceObligationLedgerProposalV1;

function proposalFrom(artifact: Readonly<Record<string, unknown>>): Proposal {
  const proposal = artifact.proposal;
  if (!proposal || typeof proposal !== "object" || Array.isArray(proposal)) {
    throw new Error("The source-obligation records did not assemble a proposal.");
  }
  return proposal as Proposal;
}

function matchingObligation(
  records: Parameters<RuntimeDerivationRules<"source-obligation">["obligation-ids"]>[0]["records"],
  path: readonly (string | number)[],
) {
  return records.find(
    (record) =>
      record.type === "obligation" &&
      record.path !== null &&
      record.path.length === path.length - 1 &&
      record.path.every((part, index) => part === path[index]),
  );
}

export const SOURCE_OBLIGATION_DERIVATIONS: RuntimeDerivationRules<"source-obligation"> = {
  "bounded-not-proven": () => "bounded-not-proven",
  "obligation-ids": ({ artifact, records, path }) => {
    const record = matchingObligation(records, path);
    if (!record?.path || typeof record.path[2] !== "number" || typeof record.path[4] !== "number") {
      throw new Error(
        `The source-obligation id has no assembled record path: ${JSON.stringify({ path, recordPath: record?.path })}.`,
      );
    }
    const rawProposal = proposalFrom(artifact);
    const dimension = rawProposal.dimensions[record.path[2]];
    const obligation = dimension?.obligations[record.path[4]];
    if (!dimension || !obligation) {
      throw new Error("The source-obligation id has no placed obligation row.");
    }
    const minted = hostMintObligationIdentity(rawProposal).dimensions.find(
      (candidate) => candidate.dimension === dimension.dimension,
    );
    return minted?.obligations.find(
      (candidate) =>
        candidate.statement === obligation.statement &&
        candidate.evidenceClass === obligation.evidenceClass &&
        candidate.uncertainty === obligation.uncertainty &&
        candidate.sourceLocators.join("\u0000") === obligation.sourceLocators.join("\u0000"),
    )?.id;
  },
  "obligation-dimension": ({ records, path }) => {
    const record = matchingObligation(records, path);
    if (!record?.slot) throw new Error("The source-obligation record has no host parent slot.");
    return record.slot as TechnicalFactDimension;
  },
  "unverified-dimension-reasons": ({ artifact }) => {
    const proposal = proposalFrom(artifact);
    return proposal.dimensions.flatMap((dimension) =>
      dimension.status === "unverified"
        ? [`Host records ${dimension.dimension} as unverified: ${dimension.reason}`]
        : [],
    );
  },
};
