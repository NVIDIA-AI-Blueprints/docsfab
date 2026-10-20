// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * How a matrix cell asks `docsfab run` to deliver, derived from the product.
 *
 * The harness never declares delivery per config. A config flag is what sent
 * write cells to a draft merge request, which needs a remote the fixture does
 * not have. The CLI's own grant resolver decides instead, so the harness and
 * the product cannot disagree.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  isInteractiveWriteWorkflow,
  resolveInteractiveDeliveryGrants,
} from "../../src/cli/delivery-grants.ts";
import { harnessRepositoryRoot } from "./repository-root.mjs";

/** The installed workflow manifest that `docsfab run <id>` executes. */
export function workflowManifest(workflowId) {
  if (!/^[a-z][a-z0-9-]*$/u.test(workflowId)) {
    throw new Error(`Workflow id ${JSON.stringify(workflowId)} is not a workflow name.`);
  }
  const path = join(
    harnessRepositoryRoot(),
    "packages",
    "runtime",
    "workflows",
    `${workflowId}.json`,
  );
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`Workflow ${workflowId} has no readable manifest at ${path}: ${error.message}`);
  }
}

/**
 * `interactive-write` (create, update, restructure), `write-step` (another
 * workflow with a write step, which run admission refuses without
 * `--allow-write`), or `read-only`.
 */
export function writeClass(workflowId) {
  if (isInteractiveWriteWorkflow(workflowId)) return "interactive-write";
  const steps = workflowManifest(workflowId).steps ?? [];
  return steps.some((step) => step.mode === "write") ? "write-step" : "read-only";
}

/**
 * The delivery flags for one cell. Every write is retained as a local patch:
 * interactive write workflows take `--patch-only`. Bootstrap combines
 * `--patch-only` with its required `--allow-write` grant; patch selection does
 * not authorize the bootstrap write.
 */
export function deliveryArgs(workflowId) {
  const kind = writeClass(workflowId);
  const args =
    kind === "interactive-write"
      ? ["--patch-only"]
      : kind === "write-step"
        ? ["--patch-only", "--allow-write"]
        : [];
  const grants = resolveInteractiveDeliveryGrants({
    workflow: workflowId,
    dryRun: false,
    patchOnly: args.includes("--patch-only"),
    draftMrFlag: false,
    allowWriteFlag: args.includes("--allow-write"),
    commentMr: false,
    routeOnly: false,
    explicitComposition: false,
  });
  if (grants.draftMr) {
    throw new Error(
      `Delivery for ${workflowId} would open a draft merge request; the matrix only retains local patches.`,
    );
  }
  if (grants.allowWrite !== (kind !== "read-only")) {
    throw new Error(
      `Delivery for ${workflowId} grants allowWrite=${grants.allowWrite} but its contract is ${kind}.`,
    );
  }
  return { writeClass: kind, args };
}
