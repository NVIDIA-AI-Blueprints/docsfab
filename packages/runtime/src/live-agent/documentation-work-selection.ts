// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { RunRecordRequestIntentV1 } from "../request-intent/interpret-record.js";
import type { CatalogSkillId } from "../skills/catalog-crate.js";
import type { RunnableWorkflowName } from "../workflow-registry/catalog.js";

/** A semantic selection made by the live agent before repository work starts. */
export type DocumentationWorkSelectionV1 =
  | {
      readonly kind: "conversation";
      readonly requestIntent: RunRecordRequestIntentV1 | null;
    }
  | {
      readonly kind: "clarification";
      readonly requestIntent: RunRecordRequestIntentV1 | null;
      readonly question: string;
    }
  | {
      readonly kind: "skills";
      readonly requestIntent: RunRecordRequestIntentV1 | null;
      /** Ordered skills applied to one objective; this list grants no authority. */
      readonly skillIds: readonly CatalogSkillId[];
      readonly basis: "request-semantics" | "documentation-specialist-default";
    }
  | {
      readonly kind: "workflow";
      readonly requestIntent: RunRecordRequestIntentV1 | null;
      readonly workflowId: RunnableWorkflowName;
      readonly basis: "request-semantics" | "documentation-specialist-default";
    }
  | {
      readonly kind: "inspect-saved-result";
      readonly requestIntent: RunRecordRequestIntentV1 | null;
      /** Reference to an existing result; inspection does not schedule work. */
      readonly runId: string;
    };

/**
 * Typed helper for a semantic choice already made by the caller. It checks
 * catalog membership, but is not a decoder for hostile model or persisted data,
 * an admission gate, or a source of execution authority.
 */
export function createDocumentationWorkSelection(
  selection: DocumentationWorkSelectionV1,
  installed: {
    readonly skillIds: readonly CatalogSkillId[];
    readonly workflowIds: readonly RunnableWorkflowName[];
  },
): DocumentationWorkSelectionV1 {
  if (selection.kind === "skills") {
    if (
      selection.skillIds.length === 0 ||
      new Set(selection.skillIds).size !== selection.skillIds.length
    ) {
      throw new Error("Documentation work must name a non-empty, duplicate-free skill sequence.");
    }
    for (const skillId of selection.skillIds) {
      if (!installed.skillIds.includes(skillId)) {
        throw new Error(`Selected documentation skill is not installed: ${skillId}.`);
      }
    }
  }
  if (selection.kind === "workflow" && !installed.workflowIds.includes(selection.workflowId)) {
    throw new Error(`Selected documentation workflow is not installed: ${selection.workflowId}.`);
  }
  if (selection.kind === "clarification" && selection.question.trim().length === 0) {
    throw new Error("A clarification selection must include the question to ask.");
  }
  if (selection.kind === "inspect-saved-result" && selection.runId.trim().length === 0) {
    throw new Error(
      "Saved-result inspection must identify an existing run before it can be inspected.",
    );
  }
  return Object.freeze(
    selection.kind === "skills"
      ? { ...selection, skillIds: Object.freeze([...selection.skillIds]) }
      : { ...selection },
  );
}
