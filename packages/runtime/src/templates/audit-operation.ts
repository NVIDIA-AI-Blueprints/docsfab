// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Host operation and outcome projector for the read-only `audit-documentation`
 * workflow: every documentation page in scope is mapped to a governed template
 * and checked with the structural template rules. It never calls a model.
 */
import { resolve } from "node:path";

import { limit } from "../config/limits.js";
import { canonicalizeJsonEvidence, type JsonEvidenceValue } from "../json-evidence.js";
import type {
  AgentHarness,
  HarnessStepInput,
  HarnessStepResult,
  HostOperationExecutor,
} from "../execution/contracts.js";
import type { RunRecord } from "../records/contracts.js";
import {
  buildRepositoryDiscoveryInventory,
  formatRepositoryInventoryLimitations,
  type RepositoryDiscoveryInventoryV1,
} from "../repository/inventory.js";
import {
  RepositoryWorkspaceReadError,
  type RepositoryWorkspace,
} from "../repository/workspace/contracts.js";
import { readTrackedRepositoryFile } from "../repository/workspace/tracked-read.js";
import type {
  WorkflowOutcomeCandidateV1,
  WorkflowOutcomeFindingV1,
  WorkflowOutcomeProjector,
} from "../workflow-contracts/contracts.js";
import {
  defaultInconclusiveWorkflowOutcome,
  workflowOutcomeStepEvidence,
} from "../workflow-contracts/outcome.js";
import { publicDocumentationPaths } from "../workflow-execution/local-review-scope.js";
import {
  auditTemplateConformance,
  retainedTemplateAuditReport,
  TEMPLATE_AUDIT_STEP_ID,
  TEMPLATE_AUDIT_WORKFLOW,
  TEMPLATE_AUDIT_PAGE_BYTES_LIMIT,
  type TemplateAuditInputPage,
  type TemplateAuditScopeV1,
} from "./audit.js";
import { resolveTemplateSet, type TemplateSetCapability } from "./load.js";

/** Runs the structural template audit over the bound workspace. */
export class TemplateAuditHostOperation implements HostOperationExecutor {
  public constructor(
    private readonly workspace: RepositoryWorkspace,
    private readonly templates: TemplateSetCapability,
  ) {}

  public async runStep(input: HarnessStepInput): Promise<HarnessStepResult> {
    if (
      input.workflow.name !== TEMPLATE_AUDIT_WORKFLOW ||
      input.step.id !== TEMPLATE_AUDIT_STEP_ID ||
      input.step.kind !== "host-operation" ||
      input.step.mode !== "read-only" ||
      resolve(input.repositoryPath) !== resolve(this.workspace.path)
    ) {
      throw new Error("The template audit requires the bound repository and audit step.");
    }
    const bundle = resolveTemplateSet(this.templates);
    const inventory = await buildRepositoryDiscoveryInventory({ workspace: this.workspace });
    const documents = publicDocumentationPaths(inventory);
    const named = input.reviewScope ? new Set(input.reviewScope.targetPaths) : undefined;
    const paths = named ? documents.filter((path) => named.has(path)) : documents;
    const sizes = new Map(inventory.files.map((file) => [file.path, file.byteLength]));
    const pageBytes = limit(TEMPLATE_AUDIT_PAGE_BYTES_LIMIT).value;
    const pages: TemplateAuditInputPage[] = [];
    for (const path of paths) {
      input.signal?.throwIfAborted();
      pages.push(await readPage(this.workspace, path, sizes.get(path) ?? undefined, pageBytes));
    }
    const report = auditTemplateConformance({
      bundle,
      pages,
      scope: { kind: named ? "focused-set" : "documentation-set", ...enumerationScope(inventory) },
    });
    const { coverage } = report;
    input.onText?.(
      `Template audit: ${coverage.checked} of ${coverage.enumerated} pages checked, ${coverage.failed} failed, ${coverage.unmapped} unmapped, ${coverage.refused} refused.`,
    );
    return {
      summary: canonicalizeJsonEvidence(report as unknown as JsonEvidenceValue).trimEnd(),
      outcome: "succeeded",
    };
  }
}

/**
 * Whether the inventory listed every tracked entry. Only a structure failure
 * can drop a page from the list; text and navigation gaps cannot.
 */
function enumerationScope(
  inventory: RepositoryDiscoveryInventoryV1,
): Omit<TemplateAuditScopeV1, "kind"> {
  const failures = inventory.failures.filter((failure) => failure.affects.includes("structure"));
  const lines = formatRepositoryInventoryLimitations({ ...inventory, failures });
  const structure = inventory.coverage.structure;
  return {
    enumeration:
      structure.status === "complete" && failures.length === 0 ? "complete" : "incomplete",
    // Unsafe tracked entries are present in the inventory, but cannot be
    // enumerated as auditable pages. Count them alongside entries the
    // inventory itself omitted so the audit's scope explains every gap.
    omittedEntries:
      structure.omittedCount +
      new Set(
        failures
          .filter((failure) => failure.category === "unsafe-tracked-entry")
          .map((failure) => failure.path)
          .filter((path): path is string => path !== undefined),
      ).size,
    limitations: lines.map((line, index) => {
      const path = failures[index]?.path;
      return path && !line.includes(path) ? `${line} (${path})` : line;
    }),
  };
}

async function readPage(
  workspace: RepositoryWorkspace,
  path: string,
  trackedBytes: number | undefined,
  limitBytes: number,
): Promise<TemplateAuditInputPage> {
  let bytes: Buffer;
  try {
    bytes = await readTrackedRepositoryFile(workspace, path, limitBytes);
  } catch (error) {
    if (!(error instanceof RepositoryWorkspaceReadError)) throw error;
    if (error.code !== "oversize") return { path, refused: "page-unreadable" };
    return {
      path,
      refused: "page-too-large",
      limitBytes,
      ...(trackedBytes === undefined ? {} : { observedBytes: trackedBytes }),
    };
  }
  try {
    return { path, content: new TextDecoder("utf-8", { fatal: true }).decode(bytes) };
  } catch {
    // hygiene: refusal — invalid UTF-8 is reported as a refused page, not a failure.
    return { path, refused: "page-not-utf8" };
  }
}

/**
 * The audit's model harness: skill inspection still resolves from the crate,
 * and any inference request is refused, so the workflow cannot reach a provider.
 */
export function withoutInference(harness?: AgentHarness): AgentHarness {
  return {
    ...(harness?.inspectSkill
      ? { inspectSkill: (input: HarnessStepInput) => harness.inspectSkill!(input) }
      : {}),
    async runStep() {
      throw new Error("The template audit has no inference step and cannot call a model.");
    },
  };
}

/** Disposition: ready only when every enumerated page was checked and passed. */
export class TemplateAuditWorkflowOutcomeProjector implements WorkflowOutcomeProjector {
  public async project(record: Readonly<RunRecord>): Promise<WorkflowOutcomeCandidateV1> {
    const report = record.status === "succeeded" ? retainedTemplateAuditReport(record) : undefined;
    if (!report) return defaultInconclusiveWorkflowOutcome(record as RunRecord);
    const evidence = workflowOutcomeStepEvidence(record as RunRecord, TEMPLATE_AUDIT_STEP_ID);
    const limitations = [
      ...(report.coverage.unmapped > 0 ? ["template-audit-unmapped-pages"] : []),
      ...(report.coverage.refused > 0 ? ["template-audit-refused-pages"] : []),
      ...(report.scope.enumeration === "incomplete"
        ? ["template-audit-enumeration-incomplete"]
        : []),
      ...(report.coverage.enumerated === 0 ? ["template-audit-no-pages"] : []),
    ];
    const findings = limitations.map(
      (code): WorkflowOutcomeFindingV1 => ({
        id: `finding:${code}`,
        kind: "evidence-limitation",
        severity: "warning",
        code,
        evidenceIds: [evidence.id],
      }),
    );
    if (report.coverage.failed > 0) {
      findings.push({
        id: "finding:template-structure-errors",
        kind: "product-gap",
        severity: "blocking",
        code: "template-structure-errors",
        evidenceIds: [evidence.id],
      });
    }
    return {
      disposition:
        report.coverage.failed > 0 ? "not-ready" : findings.length > 0 ? "inconclusive" : "ready",
      findings,
      evidence: [evidence],
      limitations,
      openDecisions: [],
      producedArtifacts: [],
    };
  }
}
