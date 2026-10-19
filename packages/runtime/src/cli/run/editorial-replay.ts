// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { DurableArtifactStore } from "../../artifacts/index.js";
import { resolveDocsFabRuntimeAssetPaths } from "../../config/runtime-loader.js";
import { createReaderTaskContextSupplier } from "../../execution/task-context.js";
import { verifyQualityPackContext } from "../../quality-pack/manifest.js";
import { parseJsonEvidence } from "../../json-evidence.js";
import type { RunRecord } from "../../records/contracts.js";
import { decodeSavedRunRecord } from "../../records/saved-run-record.js";
import { workflowBranchCoverageDecodeOptionsV1 } from "../../records/composition-execution.js";
import { decodeWorkflowBranchCoverageV1 } from "../../workflow-contracts/branch-coverage.js";
import type { WorkflowOutcomeDecodeOptionsV1 } from "../../workflow-contracts/outcome.js";
import { loadEditorialEvidenceDecodeOptionsFromStoreV1 } from "../../workflow-execution/editorial-evidence-host.js";
import { getWorkflow } from "../../workflow-registry/catalog.js";
import { authorizeSecurityScan } from "../../security/scan-override.js";
import { resolveSecurityScanEffectiveDisposition } from "../../security/scan-disposition.js";

/** Strictly reconstruct current editorial evidence from the run's durable host store. */
export async function loadSavedRunEditorialDecodeOptions(
  record: RunRecord,
  stateDirectory: string,
): Promise<WorkflowOutcomeDecodeOptionsV1 | undefined> {
  const hasEditorialDecision = (record.artifacts ?? []).some(
    (use) => use.role === "output" && use.reference.kind === "editorial-decision",
  );
  const hasEditorialEvidence = record.workflowBranchCoverage !== undefined || hasEditorialDecision;
  const hasSecurityEvidence =
    record.securityScan !== undefined ||
    record.securityScanAuthorization !== undefined ||
    record.securityScanEffectiveDisposition !== undefined;
  if (
    (record.workflow !== "update-documentation" || !hasEditorialEvidence) &&
    !hasSecurityEvidence
  ) {
    return undefined;
  }
  try {
    const workflow = getWorkflow("update-documentation");
    const branchCoverage: WorkflowOutcomeDecodeOptionsV1 = hasEditorialEvidence
      ? {
          decodeWorkflowBranchCoverage: (value, candidateRecord) =>
            decodeWorkflowBranchCoverageV1(
              value,
              workflowBranchCoverageDecodeOptionsV1({
                workflow,
                record: candidateRecord,
                requireComplete: candidateRecord.status === "succeeded",
              }),
            ),
        }
      : {};
    const editorial: WorkflowOutcomeDecodeOptionsV1 = hasEditorialDecision
      ? await (async () => {
          const assets = resolveDocsFabRuntimeAssetPaths();
          const pack = await verifyQualityPackContext(assets);
          const supplier = await createReaderTaskContextSupplier(pack);
          const store = new DurableArtifactStore(resolve(dirname(stateDirectory), "artifacts"));
          return loadEditorialEvidenceDecodeOptionsFromStoreV1({
            store,
            record,
            baselineSha256: supplier.baseline.sha256,
            policy: supplier.policy,
          });
        })()
      : {};
    return {
      ...(hasSecurityEvidence
        ? { authorizeSecurityScan, resolveSecurityScanEffectiveDisposition }
        : {}),
      ...editorial,
      ...branchCoverage,
    };
  } catch (error) {
    throw new Error("Saved run editorial evidence is unavailable or invalid.", { cause: error });
  }
}

const SAFE_RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

/**
 * The decode options a saved run's own record needs before a saved-run
 * publication reads it: `docsfab publish` and `docsfab ship`, with their
 * recovery and replay (#2366). They are the options `docsfab runs show`
 * derives. Without them, an update-documentation record that carries editorial
 * evidence failed to decode, and delivery reported run-record-mismatch.
 * Undefined when the run id is unsafe, the record cannot be read or decoded,
 * or its editorial evidence is unavailable: the publication path then reports
 * its own refusal for it.
 */
export async function loadSavedRunPublicationDecodeOptions(
  stateDirectory: string,
  runId: string,
): Promise<WorkflowOutcomeDecodeOptionsV1 | undefined> {
  if (!SAFE_RUN_ID.test(runId)) return undefined;
  try {
    const record = decodeSavedRunRecord(
      parseJsonEvidence(await readFile(resolve(stateDirectory, `${runId}.json`))),
      runId,
    );
    return await loadSavedRunEditorialDecodeOptions(record, stateDirectory);
  } catch {
    // Missing or unreadable editorial evidence is the publication path's refusal
    // to report (run-record-contract-gap), not an uncoded error from here.
    return undefined;
  }
}

/**
 * The decode options for the saved run that a `docsfab publish <run-id>
 * [--state-dir <dir>]` invocation names (#2366). The publish parsers own every
 * other check of `args`.
 */
export async function publishInvocationDecodeOptions(
  args: readonly string[],
  defaultStateDirectory: string,
): Promise<WorkflowOutcomeDecodeOptionsV1 | undefined> {
  const flag = args.indexOf("--state-dir");
  const value = flag > 0 ? args[flag + 1] : undefined;
  return loadSavedRunPublicationDecodeOptions(
    value ? resolve(value) : defaultStateDirectory,
    args[0] ?? "",
  );
}
