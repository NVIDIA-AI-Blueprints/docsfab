// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { InferenceStepError } from "../src/execution/contracts.js";
import { getWorkflow } from "../src/workflow-registry/catalog.js";
import {
  assertObservableUpdateSourceLocators,
  validateSourceObligationProposal,
} from "../src/workflow-execution/source-obligation.js";
import {
  MAX_SOURCE_BYTES,
  observableSourcePath,
} from "../src/workflow-execution/source-obligation-observer.js";
import { sourceObligationProposalFixture } from "./helpers/verification.js";

const authority = {
  members: [
    { path: "src/api.ts", mode: 0o644, sourceSha256: "f".repeat(64), byteLength: MAX_SOURCE_BYTES },
    {
      path: "src/large.ts",
      mode: 0o644,
      sourceSha256: "f".repeat(64),
      byteLength: MAX_SOURCE_BYTES + 1,
    },
  ],
};
const observable = observableSourcePath(authority);
const hostKnown = (path: string) => authority.members.some((member) => member.path === path);
const update = { workflow: getWorkflow("update-documentation") };

describe("UPDATE source citation admission", () => {
  it("accepts the exact per-file bound without removing citations", () => {
    const proposal = validateSourceObligationProposal(
      sourceObligationProposalFixture("src/api.ts:1"),
    );
    expect(() =>
      assertObservableUpdateSourceLocators(proposal, update, observable, hostKnown),
    ).not.toThrow();
    expect(proposal.dimensions.every((dimension) => dimension.sourceLocators.length === 1)).toBe(
      true,
    );
  });
  it.each(["src/missing.ts", "src/link.ts", "Users/example-user/checkout/a.md", "src/large.ts"])(
    "refuses unobservable %s with a safe subject",
    (path) => {
      const proposal = validateSourceObligationProposal(
        sourceObligationProposalFixture(`${path}:1`),
      );
      try {
        assertObservableUpdateSourceLocators(proposal, update, observable, hostKnown);
        throw new Error("Expected rejection");
      } catch (error) {
        expect(error).toBeInstanceOf(InferenceStepError);
        expect(error).toMatchObject({
          retryable: true,
          rejection: {
            code: "source-locator-unobservable",
            location: "$.dimensions[].sourceLocators[]",
          },
          rejectionSubject:
            path === "src/large.ts"
              ? { kind: "source-path", path }
              : { kind: "source-path", withheld: "not-host-known" },
        });
        expect((error as Error).message).not.toContain(path);
      }
    },
  );
  it("checks obligation citations as well as dimension citations", () => {
    const proposal = sourceObligationProposalFixture("src/api.ts:1");
    proposal.dimensions[0] = {
      ...proposal.dimensions[0]!,
      status: "applicable",
      sourceLocators: [],
      obligations: [
        {
          dimension: proposal.dimensions[0]!.dimension,
          sourceLocators: ["missing.ts:1"],
          statement: "The parser requires the documented flag.",
          evidenceClass: "source-observation",
          uncertainty: "Read from source; the parser was not executed.",
        },
      ],
    };
    const admitted = validateSourceObligationProposal(proposal);
    expect(() =>
      assertObservableUpdateSourceLocators(admitted, update, observable, hostKnown),
    ).toThrow(
      /source-locator-unobservable.*\$\.dimensions\[\]\.obligations\[\]\.sourceLocators\[\]/,
    );
  });
  it.each(["create-documentation", "review-documentation", "restructure-documentation"])(
    "preserves the %s admission policy",
    (workflow) => {
      const proposal = validateSourceObligationProposal(
        sourceObligationProposalFixture("missing.ts:1"),
      );
      expect(() =>
        assertObservableUpdateSourceLocators(
          proposal,
          { workflow: getWorkflow(workflow) },
          observable,
          hostKnown,
        ),
      ).not.toThrow();
    },
  );
});
