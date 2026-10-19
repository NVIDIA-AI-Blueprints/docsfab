// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
  assertHostedWorkflowCatalog,
  inspectHostedWorkflowCatalog,
} from "../src/host-invoker/workflow-catalog.js";

describe("canonical hosted workflow catalog preflight", () => {
  it("refuses the retained six-step policy and accepts the release-derived eight-step policy", () => {
    const catalog = inspectHostedWorkflowCatalog("review-documentation");
    expect(catalog.writeStepIds).toEqual([]);
    expect(catalog.stepIds).toEqual([
      "audit-documentation",
      "derive-source-obligations",
      "lint-documentation",
      "provisional-technical-verification",
      "verify-technical-accuracy",
      "review-documentation",
      "test-audience-understanding",
      "evaluate-document-quality",
    ]);
    const input = {
      workflow: catalog.workflow,
      stepIds: catalog.stepIds,
      composition: { declaredTools: catalog.declaredTools },
    };
    expect(() =>
      assertHostedWorkflowCatalog({
        ...input,
        stepIds: catalog.stepIds.filter(
          (id) => id !== "derive-source-obligations" && id !== "provisional-technical-verification",
        ),
      }),
    ).toThrow("The hosted runtime step catalog differs from the exact host request.");
    expect(() => assertHostedWorkflowCatalog(input)).not.toThrow();
    expect(() =>
      assertHostedWorkflowCatalog({
        ...input,
        composition: { declaredTools: [...catalog.declaredTools, "write"] },
      }),
    ).toThrow("The installed composition tool set differs from the selected workflow declaration.");
  });

  it("retains exact ordering and exposes write steps without granting them", () => {
    const readOnly = inspectHostedWorkflowCatalog("live-agent-turn");
    expect(readOnly.stepIds).toEqual(["answer-question"]);
    expect(readOnly.writeStepIds).toEqual([]);
    expect(
      inspectHostedWorkflowCatalog("update-documentation").writeStepIds.length,
    ).toBeGreaterThan(0);
    const review = inspectHostedWorkflowCatalog("review-documentation");
    expect(() =>
      assertHostedWorkflowCatalog({
        workflow: review.workflow,
        stepIds: [...review.stepIds].reverse(),
        composition: review,
      }),
    ).toThrow("The hosted runtime step catalog differs from the exact host request.");
  });

  describe("preservation source reader declaration (#2464)", () => {
    const READER = "docsfab_read_preservation_source";
    /**
     * `composition.declaredTools` of `restructure-documentation` in the installed
     * docsfab-pilot dispatcher policy d53da3c24135 (an installed policy seals the
     * tool set when it is activated; it predates the experimental reader).
     */
    const INSTALLED_PILOT_RESTRUCTURE_DECLARED_TOOLS = [
      "canon_affected_docs",
      "canon_conflict_gap",
      "canon_propose_claim",
      "canon_query",
      "canon_submit_artifact",
      "canon_validate_citations",
      "edit",
      "find",
      "grep",
      "ls",
      "read",
      "write",
    ];

    it("keeps the sealed pilot restructure policy valid while preservation evidence is off", () => {
      const installed = {
        workflow: "restructure-documentation" as const,
        stepIds: inspectHostedWorkflowCatalog("restructure-documentation").stepIds,
        composition: { declaredTools: INSTALLED_PILOT_RESTRUCTURE_DECLARED_TOOLS },
      };
      expect(() => assertHostedWorkflowCatalog(installed)).not.toThrow();
      expect(() =>
        assertHostedWorkflowCatalog(installed, { preservationSourceRead: false }),
      ).not.toThrow();
      expect(inspectHostedWorkflowCatalog("restructure-documentation").declaredTools).toEqual(
        INSTALLED_PILOT_RESTRUCTURE_DECLARED_TOOLS,
      );
    });

    it("declares the preservation reader only for an opted-in restructure run", () => {
      const optedIn = inspectHostedWorkflowCatalog("restructure-documentation", {
        preservationSourceRead: true,
      });
      expect(optedIn.declaredTools).toEqual(
        [...INSTALLED_PILOT_RESTRUCTURE_DECLARED_TOOLS, READER].sort(),
      );
      expect(optedIn.stepIds).toEqual(
        inspectHostedWorkflowCatalog("restructure-documentation").stepIds,
      );
      expect(() =>
        assertHostedWorkflowCatalog(
          { workflow: optedIn.workflow, stepIds: optedIn.stepIds, composition: optedIn },
          { preservationSourceRead: true },
        ),
      ).not.toThrow();
      // An installed policy sealed without the reader still refuses an opted-in run.
      expect(() =>
        assertHostedWorkflowCatalog(
          {
            workflow: optedIn.workflow,
            stepIds: optedIn.stepIds,
            composition: { declaredTools: INSTALLED_PILOT_RESTRUCTURE_DECLARED_TOOLS },
          },
          { preservationSourceRead: true },
        ),
      ).toThrow(
        "The installed composition tool set differs from the selected workflow declaration.",
      );
      for (const workflow of [
        "review-documentation",
        "update-documentation",
        "create-documentation",
        "live-agent-turn",
        "reconcile-product-behavior",
      ] as const) {
        expect(
          inspectHostedWorkflowCatalog(workflow, { preservationSourceRead: true }).declaredTools,
          workflow,
        ).toEqual(inspectHostedWorkflowCatalog(workflow).declaredTools);
      }
    });
  });
});
