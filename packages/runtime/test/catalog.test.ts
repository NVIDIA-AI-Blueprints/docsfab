// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  bindableCycleWorkflow,
  getWorkflow,
  isRunnableWorkflowName,
  listWorkflows,
  ROADMAP_DISCOVERY_SEARCH_PLAN,
} from "../src/workflow-registry/catalog.js";
import { loadDeclarativeWorkflowCatalog } from "../src/workflow-registry/declarative.js";
import { DECLARATIVE_WORKFLOW_NAMES } from "../src/workflow-registry/manifest.js";
import { foundationToPatchWorkflow } from "../src/foundation/to-patch-workflow.js";
import { foundationWorkflow } from "../src/foundation/workflow.js";
import { iaAnalysisWorkflow } from "../src/ia/analysis-workflow.js";
import { iaPlanWorkflow } from "../src/ia/plan-workflow.js";
import { siteBootstrapWorkflow } from "../src/site-bootstrap/workflow.js";
import {
  instantiateWorkflowSearchTargets,
  validateWorkflowSearchPlan,
} from "../src/workflow-contracts/search.js";
import { authoringSelectedPath } from "../src/workflow-contracts/authoring-schedule.js";

describe("workflow catalog", () => {
  it("registers domain journeys from their named owning modules", () => {
    expect(getWorkflow("foundation")).toBe(foundationWorkflow);
    expect(getWorkflow("ia-analysis")).toBe(iaAnalysisWorkflow);
    expect(getWorkflow("ia-plan")).toBe(iaPlanWorkflow);
    expect(getWorkflow("site-bootstrap")).toBe(siteBootstrapWorkflow);
    expect(getWorkflow("foundation-to-patch")).toBe(foundationToPatchWorkflow);
  });

  it("binds each manifest-backed domain module to its manifest, not a second definition", () => {
    // `ia/analysis-workflow.ts`, `ia/plan-workflow.ts` and
    // `site-bootstrap/workflow.ts` re-export `getWorkflow(...)`, so the identity
    // assertions above are tautologies for them. This compares each binding
    // against the declarative catalog loaded straight from `workflows/*.json`,
    // so a hand-written definition in a domain module fails here.
    const declarative = loadDeclarativeWorkflowCatalog();
    expect(iaAnalysisWorkflow).toBe(declarative["ia-analysis"]);
    expect(iaPlanWorkflow).toBe(declarative["ia-plan"]);
    expect(siteBootstrapWorkflow).toBe(declarative["site-bootstrap"]);
    // `loadDeclarativeWorkflowCatalog` refuses a name in
    // `DECLARATIVE_WORKFLOW_NAMES` with no manifest file rather than omitting it,
    // so this key comparison holds in both directions.
    expect(Object.keys(declarative).sort()).toEqual([...DECLARATIVE_WORKFLOW_NAMES].sort());
    expect(getWorkflow("site-bootstrap")).toBe(siteBootstrapWorkflow);
  });

  it("lists only crate-bound documentation workflows", () => {
    expect(listWorkflows().map((workflow) => workflow.name)).toEqual([
      "bootstrap",
      "review-documentation",
      "create-documentation",
      "update-documentation",
      "restructure-documentation",
      "readiness",
      "release-documentation-readiness",
      "audit-documentation",
    ]);
    expect(isRunnableWorkflowName("update-documentation")).toBe(true);
    expect(isRunnableWorkflowName("review-documentation")).toBe(true);
    expect(isRunnableWorkflowName("readiness")).toBe(true);
    expect(isRunnableWorkflowName("bootstrap")).toBe(true);
    for (const name of [
      "foundation",
      "foundation-to-patch",
      "ia-analysis",
      "ia-plan",
      "site-bootstrap",
    ]) {
      expect(isRunnableWorkflowName(name)).toBe(false);
    }
    expect(bindableCycleWorkflow("readiness")).toBe("readiness");
    expect(bindableCycleWorkflow("update-documentation")).toBe("update-documentation");
  });

  it("runs the comprehensive evaluation stack once in its own read-only workflow", () => {
    const workflow = getWorkflow("review-documentation");
    expect(workflow.steps.map((step) => step.skill)).toEqual([
      "audit-documentation",
      "verify-technical-accuracy",
      "lint-documentation",
      "verify-technical-accuracy",
      "verify-technical-accuracy",
      "review-documentation",
      "test-audience-understanding",
      "evaluate-document-quality",
    ]);
    expect(workflow.steps.every((step) => step.mode === "read-only")).toBe(true);
    expect(
      workflow.steps.filter((step) => step.skill === "evaluate-document-quality"),
    ).toHaveLength(1);
  });

  it("keeps readiness read-only", () => {
    expect(getWorkflow("readiness").steps.every((step) => step.mode === "read-only")).toBe(true);
    expect(getWorkflow("readiness").steps.map((step) => step.skill)).toEqual([
      "assess-documentation-readiness",
    ]);
  });

  it("keeps foundation read-only through a host operation", () => {
    expect(getWorkflow("foundation").steps.every((step) => step.mode === "read-only")).toBe(true);
    expect(getWorkflow("foundation").steps.map((step) => step.kind)).toEqual(["host-operation"]);
    expect(getWorkflow("foundation").steps.map((step) => step.operation)).toEqual(["foundation"]);
  });

  it("binds creation and restructuring as composed runtime workflows", () => {
    const create = getWorkflow("create-documentation");
    expect(create.schemaVersion).toBe(3);
    expect(create.steps.map((step) => step.id)).toEqual([
      "plan-documentation",
      "derive-source-obligations",
      "write-documentation",
      "lint-documentation",
      "provisional-technical-verification",
      "review-documentation",
      "verify-technical-accuracy",
      "revise-documentation",
      "lint-revised-documentation",
      "provisional-revised-technical-verification",
      "verify-revised-technical-accuracy",
      "review-revised-documentation",
      "test-audience-understanding",
      "evaluate-document-quality",
    ]);
    expect(authoringSelectedPath(create, "retain").steps.map((step) => step.id)).toEqual([
      "plan-documentation",
      "derive-source-obligations",
      "write-documentation",
      "lint-documentation",
      "provisional-technical-verification",
      "review-documentation",
      "verify-technical-accuracy",
      "test-audience-understanding",
      "evaluate-document-quality",
    ]);
    expect(authoringSelectedPath(create, "revise").steps.map((step) => step.id)).toEqual([
      ...create.steps.map((step) => step.id),
    ]);
    expect(create.steps.filter((step) => step.mode === "write").map((step) => step.id)).toEqual([
      "write-documentation",
      "revise-documentation",
    ]);
    expect(
      getWorkflow("update-documentation").steps.map((step) => ({
        skill: step.skill,
        kind: step.kind,
        mode: step.mode,
      })),
    ).toEqual([
      { skill: "plan-documentation", kind: "evaluate", mode: "read-only" },
      { skill: "verify-technical-accuracy", kind: "evaluate", mode: "read-only" },
      { skill: "write-documentation", kind: "inference", mode: "write" },
      { skill: "lint-documentation", kind: "host-operation", mode: "read-only" },
      { skill: "verify-technical-accuracy", kind: "evaluate", mode: "read-only" },
      { skill: "review-documentation", kind: "evaluate", mode: "read-only" },
      { skill: "test-audience-understanding", kind: "evaluate", mode: "read-only" },
      { skill: "evaluate-document-quality", kind: "evaluate", mode: "read-only" },
    ]);
    expect(
      getWorkflow("update-documentation").contextPolicy.steps.every(
        (step) => step.level === "change-scoped",
      ),
    ).toBe(true);
    expect(getWorkflow("create-documentation").steps[0]!.search?.id).toBe(
      "documentation-observation-discovery",
    );
    expect(getWorkflow("update-documentation").steps[0]!.search?.id).toBe(
      "documentation-observation-discovery",
    );
    expect(
      getWorkflow("restructure-documentation").steps.map((step) => ({
        skill: step.skill,
        kind: step.kind,
        mode: step.mode,
      })),
    ).toEqual([
      { skill: "audit-documentation", kind: "evaluate", mode: "read-only" },
      { skill: "plan-documentation", kind: "evaluate", mode: "read-only" },
      { skill: "verify-technical-accuracy", kind: "evaluate", mode: "read-only" },
      { skill: "write-documentation", kind: "inference", mode: "write" },
      { skill: "lint-documentation", kind: "host-operation", mode: "read-only" },
      { skill: "verify-technical-accuracy", kind: "evaluate", mode: "read-only" },
      { skill: "review-documentation", kind: "evaluate", mode: "read-only" },
      { skill: "test-audience-understanding", kind: "evaluate", mode: "read-only" },
      { skill: "evaluate-document-quality", kind: "evaluate", mode: "read-only" },
    ]);
  });

  it("keeps IA planning read-only and site bootstrap write-capable", () => {
    expect(getWorkflow("ia-analysis").steps).toEqual([
      expect.objectContaining({
        kind: "inference",
        skill: "tpl-design-ia",
        mode: "read-only",
      }),
    ]);
    expect(getWorkflow("ia-plan").steps).toEqual([
      expect.objectContaining({
        kind: "host-operation",
        operation: "ia-plan",
        mode: "read-only",
      }),
    ]);
    expect(getWorkflow("ia-plan").contextPolicy.steps).toEqual([
      expect.objectContaining({
        level: "corpus",
        query: "expand",
        allowReadOnlyDegraded: true,
      }),
    ]);
    expect(getWorkflow("site-bootstrap").steps).toEqual([
      expect.objectContaining({
        kind: "host-operation",
        operation: "site-bootstrap",
        mode: "write",
      }),
    ]);
  });

  it("declares valid target-specific search only on discovery steps", () => {
    const integrated = listWorkflows().flatMap((workflow) =>
      workflow.steps.flatMap((step) =>
        step.search ? [{ workflow: workflow.name, step, plan: step.search }] : [],
      ),
    );
    expect(
      integrated.map(({ workflow, step }) => ({
        workflow,
        id: step.id,
        searchMode: step.searchMode,
      })),
    ).toEqual([
      {
        workflow: "review-documentation",
        id: "audit-documentation",
        searchMode: "observe",
      },
      {
        workflow: "review-documentation",
        id: "derive-source-obligations",
        searchMode: "revalidate",
      },
      {
        workflow: "review-documentation",
        id: "lint-documentation",
        searchMode: "reuse",
      },
      {
        workflow: "review-documentation",
        id: "provisional-technical-verification",
        searchMode: "reuse",
      },
      {
        workflow: "review-documentation",
        id: "verify-technical-accuracy",
        searchMode: "revalidate",
      },
      {
        workflow: "review-documentation",
        id: "review-documentation",
        searchMode: "reuse",
      },
      {
        workflow: "review-documentation",
        id: "test-audience-understanding",
        searchMode: "reuse",
      },
      {
        workflow: "review-documentation",
        id: "evaluate-document-quality",
        searchMode: "reuse",
      },
      {
        workflow: "create-documentation",
        id: "plan-documentation",
        searchMode: "observe",
      },
      {
        workflow: "create-documentation",
        id: "derive-source-obligations",
        searchMode: "revalidate",
      },
      {
        workflow: "create-documentation",
        id: "write-documentation",
        searchMode: "revalidate",
      },
      {
        workflow: "create-documentation",
        id: "provisional-technical-verification",
        searchMode: "revalidate",
      },
      {
        workflow: "create-documentation",
        id: "verify-technical-accuracy",
        searchMode: "revalidate",
      },
      {
        workflow: "create-documentation",
        id: "revise-documentation",
        searchMode: "revalidate",
      },
      {
        workflow: "create-documentation",
        id: "provisional-revised-technical-verification",
        searchMode: "revalidate",
      },
      {
        workflow: "create-documentation",
        id: "verify-revised-technical-accuracy",
        searchMode: "revalidate",
      },
      {
        workflow: "create-documentation",
        id: "evaluate-document-quality",
        searchMode: "reuse",
      },
      {
        workflow: "update-documentation",
        id: "plan-documentation",
        searchMode: "observe",
      },
      {
        workflow: "update-documentation",
        id: "derive-source-obligations",
        searchMode: "revalidate",
      },
      {
        workflow: "update-documentation",
        id: "verify-technical-accuracy",
        searchMode: "revalidate",
      },
      {
        workflow: "update-documentation",
        id: "evaluate-document-quality",
        searchMode: "reuse",
      },
      {
        workflow: "restructure-documentation",
        id: "derive-source-obligations",
        searchMode: "observe",
      },
      { workflow: "readiness", id: "assess-readiness", searchMode: "observe" },
      {
        workflow: "release-documentation-readiness",
        id: "assess-release-documentation-readiness",
        searchMode: "observe",
      },
    ]);
    for (const { step, plan } of integrated) {
      if (step.mode === "write") expect(step.searchMode).toBe("revalidate");
      else expect(step.mode).toBe("read-only");
      expect(validateWorkflowSearchPlan(plan)).toEqual(plan);
      expect(
        instantiateWorkflowSearchTargets(plan, {
          identitySha256: "a".repeat(64),
          revision: "b".repeat(40),
        }).length,
      ).toBe(plan.targets.length);
    }
    expect(
      getWorkflow("update-documentation").steps.find((step) => step.id === "write-documentation")!
        .search,
    ).toBeUndefined();
    expect(getWorkflow("create-documentation").steps.at(-1)!.consumesEvidence).toEqual([
      "verify-revised-technical-accuracy",
    ]);
    expect(getWorkflow("update-documentation").steps.at(-1)!.consumesEvidence).toEqual([
      "plan-documentation",
      "lint-documentation",
      "verify-technical-accuracy",
      "review-documentation",
      "test-audience-understanding",
    ]);
    expect(getWorkflow("bootstrap").steps[0]!.search).toBeUndefined();
    expect(getWorkflow("site-bootstrap").steps[0]!.search).toBeUndefined();
  });

  it("keeps release roadmap accounting distinct from source and public readiness", () => {
    expect(validateWorkflowSearchPlan(ROADMAP_DISCOVERY_SEARCH_PLAN)).toEqual(
      ROADMAP_DISCOVERY_SEARCH_PLAN,
    );
    expect(ROADMAP_DISCOVERY_SEARCH_PLAN.id).toBe("release-roadmap-discovery");
    expect(ROADMAP_DISCOVERY_SEARCH_PLAN.targets.map((target) => target.targetKey)).toEqual([
      "release-boundary-documentation-accounting",
    ]);
    expect(JSON.stringify(ROADMAP_DISCOVERY_SEARCH_PLAN)).not.toContain("public readiness");
  });

  it("returns a recursively immutable catalog and search declarations", () => {
    const workflows = listWorkflows();
    const readiness = getWorkflow("readiness");
    const plan = readiness.steps[0]!.search!;
    expect(deeplyFrozen(workflows)).toBe(true);
    expect(deeplyFrozen(readiness)).toBe(true);
    expect(deeplyFrozen(plan)).toBe(true);
    expect(deeplyFrozen(ROADMAP_DISCOVERY_SEARCH_PLAN)).toBe(true);

    expect(() => (workflows as unknown as WorkflowDefinitionForMutation[]).splice(0, 1)).toThrow(
      TypeError,
    );
    expect(() => {
      (plan.targets as unknown as MutableTarget[])[0]!.id = "relabeled";
    }).toThrow(TypeError);
    expect(() => {
      (plan.targets as unknown as MutableTarget[]).splice(0, 1);
    }).toThrow(TypeError);
    expect(() => {
      (plan.targets[0]!.requiredProbes as MutableProbe[])[0]!.strategy = "tracked-text-index";
    }).toThrow(TypeError);
    const rubric = plan.targets.find((target) => target.targetType === "rubric-coverage");
    expect(() => {
      if (!rubric || rubric.targetType !== "rubric-coverage") throw new Error("fixture");
      (rubric.rubric.criteria as MutableCriterion[])[0]!.kind = "accuracy";
    }).toThrow(TypeError);
    expect(getWorkflow("readiness")).toBe(readiness);
    expect(listWorkflows()).toBe(workflows);
  });
});

type WorkflowDefinitionForMutation = {
  steps: unknown[];
};
type MutableTarget = {
  id: string;
};
type MutableProbe = {
  strategy: string;
};
type MutableCriterion = {
  kind: string;
};

function deeplyFrozen(value: unknown, seen = new Set<object>()): boolean {
  if (!value || typeof value !== "object" || seen.has(value)) return true;
  seen.add(value);
  if (!Object.isFrozen(value)) return false;
  return Object.values(Object.getOwnPropertyDescriptors(value)).every(
    (descriptor) => !("value" in descriptor) || deeplyFrozen(descriptor.value, seen),
  );
}
