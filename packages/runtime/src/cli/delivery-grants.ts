// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { WorkflowName } from "../workflow-contracts/contracts.js";
import { workflowDeliveryCapabilities } from "../workflow-contracts/delivery.js";
import { getWorkflow, RUNNABLE_WORKFLOW_NAMES } from "../workflow-registry/catalog.js";

/** Default `--repo` when omitted: this checkout. */
export const DEFAULT_REPOSITORY_PATH = ".";

/** Default Git remote when opening a draft merge request. */
export const DEFAULT_PUBLICATION_REMOTE = "origin";

function supportsDelivery(workflow: WorkflowName, delivery: "patchOnly" | "draftMr"): boolean {
  return workflowDeliveryCapabilities(getWorkflow(workflow))[delivery];
}

function workflowsSupportingDelivery(delivery: "patchOnly" | "draftMr"): WorkflowName[] {
  return RUNNABLE_WORKFLOW_NAMES.filter((workflow) => supportsDelivery(workflow, delivery));
}

function formatNames(names: readonly string[], conjunction: "and" | "or"): string {
  if (names.length < 2) return names[0] ?? "no workflows";
  return `${names.slice(0, -1).join(", ")}, ${conjunction} ${names[names.length - 1]}`;
}

export function isInteractiveWriteWorkflow(workflow: WorkflowName): boolean {
  return supportsDelivery(workflow, "draftMr");
}

/** Whether the workflow has a local patch delivery adapter. */
export function supportsLocalPatchDelivery(workflow: WorkflowName): boolean {
  return supportsDelivery(workflow, "patchOnly");
}

function workflowsSupportingDeliveryAny(delivery: "patchOnly" | "draftMr"): string {
  return formatNames(workflowsSupportingDelivery(delivery), "or");
}

/**
 * Coded refusals for delivery flags. `delivery-flag-conflict`: two flags, or a
 * flag and its missing prerequisite, cannot apply together.
 * `workflow-delivery-flag-unsupported`: the selected workflow cannot take a
 * write flag, so the run would not do what the flag asks.
 * `publication-prohibition-conflict`: the request says not to publish, but the
 * delivery plan would publish.
 */
export const DELIVERY_FLAG_REFUSAL_CODES = [
  "delivery-flag-conflict",
  "workflow-delivery-flag-unsupported",
  "publication-prohibition-conflict",
] as const;

export type DeliveryFlagRefusalCode = (typeof DELIVERY_FLAG_REFUSAL_CODES)[number];

/** A coded delivery-flag refusal; the operator envelope prints `nextAction`. */
export class DeliveryFlagOperatorError extends Error {
  public constructor(
    public readonly code: DeliveryFlagRefusalCode,
    message: string,
    public readonly nextAction: string,
  ) {
    super(message);
    this.name = "DeliveryFlagOperatorError";
  }
}

/** Delivery flags used to choose local patch or publication behavior. */
export interface WriteDeliveryFlags {
  readonly patchOnly: boolean;
  readonly draftMr: boolean;
}

/**
 * `--patch-only` asks the workflow's patch adapter to retain local output.
 * `--draft-mr` asks an eligible authoring adapter to publish that output.
 * `--allow-write` remains the separate operator write grant.
 */
export function requestsWriteDelivery(flags: WriteDeliveryFlags): boolean {
  return flags.patchOnly || flags.draftMr;
}

/** The coded refusal when the request says not to publish but the plan would publish. */
export function publicationProhibitionConflict(): DeliveryFlagOperatorError {
  return new DeliveryFlagOperatorError(
    "publication-prohibition-conflict",
    "The request or effective instruction says not to publish, but this delivery plan would publish. Pass --patch-only to retain a local patch without publishing.",
    "Pass --patch-only to retain a local patch without publishing.",
  );
}

/** The delivery a publication prohibition is checked against, as `run` and `do` resolve it. */
export interface PublicationDeliveryPlan {
  readonly workflow: WorkflowName;
  readonly grants: InteractiveDeliveryGrants;
  readonly commentMr: boolean;
  readonly dryRun: boolean;
}

/**
 * Whether a delivery plan publishes: it opens a draft merge request, posts a
 * review summary on an existing one, or is the dry run of a write workflow,
 * which previews the default draft merge request.
 */
export function deliveryPlanPublishes(plan: PublicationDeliveryPlan): boolean {
  return (
    plan.grants.draftMr ||
    plan.commentMr ||
    (plan.dryRun && isInteractiveWriteWorkflow(plan.workflow))
  );
}

/**
 * The publication-prohibition check `run` and `do` share, before any GitLab
 * read, model call, or run record: a plan that publishes refuses a request
 * that says not to.
 */
export function assertPublicationNotProhibited(
  prohibited: boolean,
  plan: PublicationDeliveryPlan,
): void {
  if (prohibited && deliveryPlanPublishes(plan)) throw publicationProhibitionConflict();
}

export interface InteractiveDeliveryGrantInput {
  readonly workflow: WorkflowName;
  readonly dryRun: boolean;
  readonly patchOnly: boolean;
  readonly draftMrFlag: boolean;
  readonly allowWriteFlag: boolean;
  readonly commentMr: boolean;
  readonly routeOnly: boolean;
  readonly explicitComposition: boolean;
}

export interface InteractiveDeliveryGrants {
  readonly allowWrite: boolean;
  readonly draftMr: boolean;
}

/** One next action per delivery-flag pair that cannot apply together. */
export const DELIVERY_FLAG_CONFLICT_NEXT_ACTIONS = Object.freeze({
  "dry-run/patch-only":
    "Omit --dry-run to retain a local patch, or omit --patch-only to preview the run without writing.",
  "dry-run/draft-mr":
    "Omit --dry-run to open the draft merge request, or omit --draft-mr to preview the run without writing.",
  "patch-only/draft-mr":
    "Omit --draft-mr to retain a local patch without publishing, or omit --patch-only to open a draft merge request.",
  "patch-only/allow-write":
    "Pass --allow-write with --patch-only to authorize the bootstrap write and retain its patch, or omit --patch-only to run bootstrap without writing.",
  "comment-mr/allow-write":
    "Pass --allow-write with --comment-mr to authorize the bootstrap write and post its review summary.",
  "dry-run/allow-write":
    "Omit --dry-run to write, or omit --allow-write to preview the run without writing.",
  "comment-mr/draft-mr":
    "Omit --draft-mr to post one review summary on the existing merge request, or omit --comment-mr to open a new draft merge request.",
  "comment-mr/patch-only":
    "Omit --patch-only to post one review summary on the existing merge request, or omit --comment-mr to retain a local patch.",
  "dry-run/comment-mr":
    "Omit --dry-run to post the review summary, or omit --comment-mr to preview the run without posting.",
  "route-only/dry-run":
    "Omit --dry-run to preview only the route, or omit --route-only to preview the delivery as well.",
  "route-only/comment-mr":
    "Omit --comment-mr: the route does not depend on it, and --route-only posts nothing.",
  "route-only/remote":
    "Omit --remote: the route does not depend on it, and --route-only publishes nothing.",
  "route-only/allow-write":
    "Omit --allow-write: it does not change the route, and --route-only grants nothing.",
  "remote/no-draft-mr":
    "Omit --remote: it names the remote for a draft merge request, and this run opens none.",
});

export type DeliveryFlagConflict = keyof typeof DELIVERY_FLAG_CONFLICT_NEXT_ACTIONS;

/** The coded refusal for a delivery-flag pair; `message` names the command's flags. */
export function deliveryFlagConflict(
  message: string,
  conflict: DeliveryFlagConflict,
): DeliveryFlagOperatorError {
  return new DeliveryFlagOperatorError(
    "delivery-flag-conflict",
    message,
    DELIVERY_FLAG_CONFLICT_NEXT_ACTIONS[conflict],
  );
}

/**
 * First-use write workflows write and open a draft MR. `--patch-only` and
 * `--dry-run` opt out. `--allow-write` and `--draft-mr` remain accepted.
 * Every refusal is coded, with one next action.
 */
export function resolveInteractiveDeliveryGrants(
  input: InteractiveDeliveryGrantInput,
): InteractiveDeliveryGrants {
  if (input.dryRun && input.patchOnly) {
    throw deliveryFlagConflict(
      "The --dry-run option cannot be combined with --patch-only.",
      "dry-run/patch-only",
    );
  }
  if (input.dryRun && input.draftMrFlag) {
    throw deliveryFlagConflict(
      "The --dry-run option cannot be combined with --draft-mr.",
      "dry-run/draft-mr",
    );
  }
  if (input.patchOnly && input.draftMrFlag) {
    throw deliveryFlagConflict(
      "The --patch-only option cannot be combined with --draft-mr.",
      "patch-only/draft-mr",
    );
  }
  if (input.dryRun && input.allowWriteFlag) {
    throw deliveryFlagConflict(
      "The --dry-run option cannot be combined with --allow-write.",
      "dry-run/allow-write",
    );
  }
  if (input.commentMr && input.draftMrFlag) {
    throw deliveryFlagConflict(
      "The --comment-mr option cannot be combined with --draft-mr; comment mode is not draft-MR creation.",
      "comment-mr/draft-mr",
    );
  }
  if (input.commentMr && input.patchOnly) {
    throw deliveryFlagConflict(
      "The --comment-mr option cannot be combined with --patch-only.",
      "comment-mr/patch-only",
    );
  }
  if (input.dryRun && input.commentMr) {
    throw deliveryFlagConflict(
      "The --dry-run option cannot be combined with --comment-mr.",
      "dry-run/comment-mr",
    );
  }
  if (input.routeOnly) {
    return { allowWrite: false, draftMr: false };
  }

  const delivery = workflowDeliveryCapabilities(getWorkflow(input.workflow));
  if (!delivery.patchOnly) {
    if (input.draftMrFlag) {
      throw new DeliveryFlagOperatorError(
        "workflow-delivery-flag-unsupported",
        `${input.workflow} has no write step to deliver, so it cannot take --draft-mr.`,
        `Omit --draft-mr to run ${input.workflow}, or select ${workflowsSupportingDeliveryAny("draftMr")} to open a draft merge request.`,
      );
    }
    if (input.patchOnly) {
      throw new DeliveryFlagOperatorError(
        "workflow-delivery-flag-unsupported",
        `${input.workflow} has no write step to produce a local patch, so it cannot take --patch-only.`,
        `Omit --patch-only to run ${input.workflow}, or select ${workflowsSupportingDeliveryAny("patchOnly")} to retain a local patch.`,
      );
    }
    return { allowWrite: input.allowWriteFlag, draftMr: false };
  }

  if (input.draftMrFlag && !delivery.draftMr) {
    throw new DeliveryFlagOperatorError(
      "workflow-delivery-flag-unsupported",
      `${input.workflow} produces a local patch but has no draft-MR delivery adapter, so it cannot take --draft-mr.`,
      `Omit --draft-mr to retain the local patch, or select ${workflowsSupportingDeliveryAny("draftMr")} to open a draft merge request.`,
    );
  }

  if (
    !input.allowWriteFlag &&
    delivery.requiresExplicitWriteGrant &&
    (input.patchOnly || input.commentMr)
  ) {
    const selectedMode = input.patchOnly ? "--patch-only" : "--comment-mr";
    throw deliveryFlagConflict(
      `${input.workflow} requires --allow-write to authorize its write step; ${selectedMode} selects delivery but does not grant writes.`,
      input.patchOnly ? "patch-only/allow-write" : "comment-mr/allow-write",
    );
  }

  if (input.dryRun) {
    return { allowWrite: false, draftMr: false };
  }
  if (input.commentMr) {
    return { allowWrite: true, draftMr: false };
  }
  if (delivery.requiresExplicitWriteGrant) {
    return { allowWrite: input.allowWriteFlag, draftMr: false };
  }
  if (input.patchOnly || (input.explicitComposition && !input.draftMrFlag) || !delivery.draftMr) {
    return { allowWrite: true, draftMr: false };
  }
  return { allowWrite: true, draftMr: true };
}

/** Bind `origin` when publishing unless the operator named another remote. */
export function resolvePublicationRemoteName(
  requested: string | undefined,
  draftMr: boolean,
): string | undefined {
  if (!draftMr) {
    if (requested !== undefined) {
      throw deliveryFlagConflict(
        "The --remote option is only used when opening a draft merge request.",
        "remote/no-draft-mr",
      );
    }
    return undefined;
  }
  return requested ?? DEFAULT_PUBLICATION_REMOTE;
}
