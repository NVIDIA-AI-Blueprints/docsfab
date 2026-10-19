// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHostAuthorityFactory } from "../contract-kit/index.js";
import type { RunRecordRequestIntentV1 } from "../request-intent/interpret-record.js";
import type { CatalogSkillId } from "../skills/catalog-crate.js";
import type { RunnableWorkflowName } from "../workflow-registry/catalog.js";
import {
  createDocumentationWorkSelection,
  type DocumentationWorkSelectionV1,
} from "./documentation-work-selection.js";

export const DOCUMENTATION_WORK_REFUSAL =
  "Select the appropriate installed DocsFab documentation skill or workflow before repository work. This selection does not change the session's existing permissions.";

export const DOCUMENTATION_WORK_FAILURE_REFUSAL =
  "The active documentation workflow did not succeed. Preserve its objective and use the host's retry, cancel, or resume path before continuing repository work.";

export const DOCUMENTATION_WORK_PREREQUISITE_ACTION =
  "Select the appropriate installed DocsFab documentation skill or workflow, then load the selected skill with docsfab_use_skill before retrying repository work. Existing session permissions still apply.";

/** Observed only while the host checks admission, before any tool executes. */
export class DocumentationWorkPrerequisiteError extends Error {
  constructor() {
    super(DOCUMENTATION_WORK_REFUSAL);
    this.name = "DocumentationWorkPrerequisiteError";
  }
}

/** Ephemeral presentation callbacks; no tool result can supply these facts. */
export interface DocumentationWorkPrerequisiteActivity {
  consume(toolCallId: string, toolName: string): boolean;
  clear(): void;
}

export type DocumentationWorkPhaseV1 = "selected" | "active" | "failed" | "cancelled" | "completed";

export interface DocumentationWorkAuthorityV1 {
  readonly kind: "docsfab-live-documentation-work-host-authority";
}

interface DocumentationWorkVerifier {
  verifyCurrent(): void;
}

const authorities = createHostAuthorityFactory<
  DocumentationWorkAuthorityV1["kind"],
  DocumentationWorkVerifier
>({
  kind: "docsfab-live-documentation-work-host-authority",
  invalidMessage: "The documentation work authority is not host-issued.",
});

/**
 * Host-owned, per-session objective state. Selection is descriptive: every
 * operation still rechecks the existing session's authority through the host
 * verifier. A serialized selection or lookalike authority cannot restore it.
 */
export interface DocumentationWorkStateV1 {
  readonly authority: DocumentationWorkAuthorityV1;
  readonly selection: DocumentationWorkSelectionV1 | undefined;
  readonly phase: DocumentationWorkPhaseV1 | undefined;
  beginTurn(resume?: {
    readonly workflowId: RunnableWorkflowName;
    readonly requestIntent: RunRecordRequestIntentV1 | null;
    readonly directEditFallback?: boolean;
  }): void;
  selectSkill(skillId: CatalogSkillId, requestIntent?: RunRecordRequestIntentV1 | null): void;
  selectWorkflow(
    workflowId: RunnableWorkflowName,
    requestIntent?: RunRecordRequestIntentV1 | null,
  ): void;
  selectSavedResult(runId: string, requestIntent?: RunRecordRequestIntentV1 | null): void;
  markSkillLoaded(skillId: CatalogSkillId): void;
  admitRepositoryTool(): void;
  admitReviewEvidenceTool(): void;
  admitSavedResult(runId: string): void;
  admitWorkflow(workflowId: RunnableWorkflowName): void;
  recordWorkflowOutcome(status: string, error?: string): void;
  clear(): void;
}

export function createDocumentationWorkState(input: {
  readonly skillIds: readonly CatalogSkillId[];
  readonly workflowIds: readonly RunnableWorkflowName[];
  readonly workflowSkillIds: ReadonlyMap<RunnableWorkflowName, readonly string[]>;
  /** Revalidate current mode, grants, scope, and source binding on every use. */
  readonly verifyCurrent: () => void;
}): DocumentationWorkStateV1 {
  let currentSelection: DocumentationWorkSelectionV1 | undefined;
  let currentPhase: DocumentationWorkPhaseV1 | undefined;
  let directEditFallback = false;
  const loadedSkills = new Set<CatalogSkillId>();
  const authority = authorities.create({ verifyCurrent: input.verifyCurrent });

  const verify = () => {
    const verifier = authorities.lookup(authority);
    if (!verifier) {
      throw new Error("The documentation work authority was not issued by this host.");
    }
    verifier.verifyCurrent();
  };
  const installed = { skillIds: input.skillIds, workflowIds: input.workflowIds };
  const select = (selection: DocumentationWorkSelectionV1, preserveLoadedSkills = false) => {
    verify();
    currentSelection = createDocumentationWorkSelection(selection, installed);
    currentPhase = "selected";
    if (!preserveLoadedSkills) loadedSkills.clear();
  };
  const ensureOpen = () => {
    verify();
    if (!currentSelection || !currentPhase) throw new DocumentationWorkPrerequisiteError();
    if (currentPhase === "failed" || currentPhase === "cancelled") {
      throw new Error(DOCUMENTATION_WORK_FAILURE_REFUSAL);
    }
    return currentSelection;
  };

  return {
    authority,
    get selection() {
      return currentSelection;
    },
    get phase() {
      return currentPhase;
    },
    beginTurn(resume) {
      currentSelection = undefined;
      currentPhase = undefined;
      directEditFallback = resume?.directEditFallback === true;
      loadedSkills.clear();
      if (resume) {
        select({
          kind: "workflow",
          workflowId: resume.workflowId,
          basis: "request-semantics",
          requestIntent: resume.requestIntent,
        });
        currentPhase = "active";
      }
    },
    selectSkill(skillId, requestIntent = null) {
      verify();
      if (!input.skillIds.includes(skillId)) throw new Error(DOCUMENTATION_WORK_REFUSAL);
      if (currentSelection?.kind === "workflow") {
        if (currentPhase === "cancelled") throw new Error(DOCUMENTATION_WORK_FAILURE_REFUSAL);
        const workflowSkills = input.workflowSkillIds.get(currentSelection.workflowId) ?? [];
        if (!workflowSkills.includes(skillId)) throw new Error(DOCUMENTATION_WORK_REFUSAL);
        return;
      }
      const skillIds =
        currentSelection?.kind === "skills"
          ? [
              ...currentSelection.skillIds,
              ...(currentSelection.skillIds.includes(skillId) ? [] : [skillId]),
            ]
          : [skillId];
      const preserveLoadedSkills =
        currentSelection?.kind === "skills" &&
        currentSelection.skillIds.includes(skillId) &&
        requestIntent === null &&
        currentPhase !== "failed" &&
        currentPhase !== "cancelled";
      select(
        {
          kind: "skills",
          skillIds,
          basis: "request-semantics",
          requestIntent: requestIntent ?? currentSelection?.requestIntent ?? null,
        },
        preserveLoadedSkills,
      );
    },
    selectWorkflow(workflowId, requestIntent = null) {
      verify();
      // Cancellation ends this turn; a new operator turn may select again.
      if (currentPhase === "cancelled") throw new Error(DOCUMENTATION_WORK_FAILURE_REFUSAL);
      if (!input.workflowIds.includes(workflowId)) throw new Error(DOCUMENTATION_WORK_REFUSAL);
      if (currentSelection?.kind === "skills") {
        const dependencies = input.workflowSkillIds.get(workflowId) ?? [];
        if (!currentSelection.skillIds.every((skillId) => dependencies.includes(skillId))) {
          throw new Error(DOCUMENTATION_WORK_REFUSAL);
        }
      }
      if (currentSelection?.kind === "workflow" && currentSelection.workflowId !== workflowId) {
        throw new Error(DOCUMENTATION_WORK_REFUSAL);
      }
      const preserveLoadedSkills =
        currentPhase !== "failed" &&
        (currentSelection?.kind === "skills" ||
          (currentSelection?.kind === "workflow" && currentSelection.workflowId === workflowId));
      select(
        {
          kind: "workflow",
          workflowId,
          basis: "request-semantics",
          requestIntent: requestIntent ?? currentSelection?.requestIntent ?? null,
        },
        preserveLoadedSkills,
      );
      currentPhase = "active";
    },
    selectSavedResult(runId, requestIntent = null) {
      select({ kind: "inspect-saved-result", runId, requestIntent });
      currentPhase = "active";
    },
    markSkillLoaded(skillId) {
      const selection = ensureOpen();
      const admitted =
        (selection.kind === "skills" && selection.skillIds.includes(skillId)) ||
        (selection.kind === "workflow" &&
          (input.workflowSkillIds.get(selection.workflowId) ?? []).includes(skillId));
      if (!admitted) {
        throw new Error(DOCUMENTATION_WORK_REFUSAL);
      }
      loadedSkills.add(skillId);
      currentPhase = "active";
    },
    admitRepositoryTool() {
      const selection = ensureOpen();
      if (selection.kind === "workflow" && directEditFallback) return;
      if (selection.kind !== "skills" && selection.kind !== "workflow") {
        throw new Error(DOCUMENTATION_WORK_REFUSAL);
      }
      if (loadedSkills.size === 0) throw new DocumentationWorkPrerequisiteError();
    },
    admitReviewEvidenceTool() {
      const selection = ensureOpen();
      if (selection.kind === "skills") {
        if (loadedSkills.size === 0) throw new DocumentationWorkPrerequisiteError();
        return;
      }
      if (selection.kind === "workflow") return;
      throw new Error(DOCUMENTATION_WORK_REFUSAL);
    },
    admitSavedResult(runId) {
      const selection = ensureOpen();
      if (selection.kind !== "inspect-saved-result" || selection.runId !== runId) {
        throw new Error(DOCUMENTATION_WORK_REFUSAL);
      }
    },
    admitWorkflow(workflowId) {
      const selection = ensureOpen();
      if (directEditFallback) throw new Error(DOCUMENTATION_WORK_FAILURE_REFUSAL);
      if (selection.kind !== "workflow" || selection.workflowId !== workflowId) {
        throw new Error(DOCUMENTATION_WORK_REFUSAL);
      }
    },
    recordWorkflowOutcome(status, error) {
      verify();
      const selection = currentSelection;
      if (!selection || selection.kind !== "workflow") {
        throw new Error(DOCUMENTATION_WORK_REFUSAL);
      }
      const nextPhase =
        status === "succeeded"
          ? "completed"
          : status === "failed" || error === "workflow-cancelled"
            ? error === "workflow-cancelled"
              ? "cancelled"
              : "failed"
            : "active";
      if (
        currentPhase === nextPhase &&
        (nextPhase === "completed" || nextPhase === "failed" || nextPhase === "cancelled")
      ) {
        return;
      }
      if (
        currentPhase === "failed" ||
        currentPhase === "cancelled" ||
        currentPhase === "completed"
      ) {
        throw new Error(DOCUMENTATION_WORK_FAILURE_REFUSAL);
      }
      currentPhase = nextPhase;
    },
    clear() {
      currentSelection = undefined;
      currentPhase = undefined;
      directEditFallback = false;
      loadedSkills.clear();
    },
  };
}
