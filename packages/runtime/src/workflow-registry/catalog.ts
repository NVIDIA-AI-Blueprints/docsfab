// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Pin A (named job): validated manifests under `packages/runtime/workflows/`.
 *
 * The catalog is deliberately only an explicit registry. Internal workflows
 * and search declarations live with their owning domains; manifests remain
 * the owner for operator-runnable workflow structure.
 */
import type { WorkflowDefinition, WorkflowName } from "../workflow-contracts/contracts.js";
import { ROADMAP_DISCOVERY_SEARCH_PLAN } from "../roadmap/discovery-search-plan.js";
import { deepFreeze } from "../contract-kit/freeze.js";
import { loadDeclarativeWorkflowCatalog } from "./declarative.js";
import { PUBLIC_WORKFLOW_NAMES, type DeclarativeWorkflowName } from "./manifest.js";

export { ROADMAP_DISCOVERY_SEARCH_PLAN } from "../roadmap/discovery-search-plan.js";

const internalWorkflowCatalog: Readonly<
  Record<Exclude<WorkflowName, DeclarativeWorkflowName>, WorkflowDefinition>
> = deepFreeze({});

let catalogCache: Readonly<Record<WorkflowName, WorkflowDefinition>> | undefined;

function workflowCatalog(): Readonly<Record<WorkflowName, WorkflowDefinition>> {
  const cached = catalogCache;
  if (cached) return cached;

  // One map, not two: the declarative loader owns every search-plan binding,
  // so a manifest that names a plan cannot resolve here and fail there.
  const declarativeWorkflowCatalog = loadDeclarativeWorkflowCatalog();
  const next: Readonly<Record<WorkflowName, WorkflowDefinition>> = deepFreeze({
    ...internalWorkflowCatalog,
    ...declarativeWorkflowCatalog,
  });
  catalogCache = next;
  return next;
}

/**
 * Operator-runnable jobs whose step skills exist in the catalog crate.
 *
 * This is the PUBLIC manifest set, not every manifest: `live-agent-turn` is
 * catalogued and dispatchable by the host spine, but it has no local entry
 * point, so `docsfab run` and `docsfab list` must not offer it.
 */
export const RUNNABLE_WORKFLOW_NAMES = PUBLIC_WORKFLOW_NAMES;

export type RunnableWorkflowName = (typeof RUNNABLE_WORKFLOW_NAMES)[number];

export function isRunnableWorkflowName(value: string): value is RunnableWorkflowName {
  return (RUNNABLE_WORKFLOW_NAMES as readonly string[]).includes(value);
}

/**
 * Live cycles bind public jobs as themselves. Other internals remap to the
 * read-only public job.
 */
export function bindableCycleWorkflow(name: WorkflowName): RunnableWorkflowName {
  if (name === "reconcile-product-behavior") {
    throw new Error(
      "Semantic comparison requires its explicit hosted workflow and approved baseline.",
    );
  }
  if (isRunnableWorkflowName(name)) return name;
  return "review-documentation";
}

export function parkedWorkflowError(name: string): string {
  return `Workflow "${name}" is not bound to a catalog skill. Run "docsfab list".`;
}

let runnableWorkflowListCache: readonly WorkflowDefinition[] | undefined;

export function listWorkflows(): readonly WorkflowDefinition[] {
  const cached = runnableWorkflowListCache;
  if (cached) return cached;
  const catalog = workflowCatalog();
  const next = Object.freeze(RUNNABLE_WORKFLOW_NAMES.map((name) => catalog[name]));
  runnableWorkflowListCache = next;
  return next;
}

export function getWorkflow(name: WorkflowName): WorkflowDefinition {
  return workflowCatalog()[name];
}

/** Every catalogued job, including internals that operators cannot run. */
export function listCatalogWorkflows(): readonly WorkflowDefinition[] {
  return Object.freeze(Object.values(workflowCatalog()));
}

export function isWorkflowName(value: string): value is WorkflowName {
  return value in workflowCatalog();
}
