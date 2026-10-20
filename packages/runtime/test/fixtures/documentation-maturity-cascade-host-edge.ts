// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { GitLabRoadmapReader } from "../../src/roadmap/gitlab-readonly.js";
import { buildContentIndexV2 } from "../../src/content-ir/indexer.js";
import {
  assessDocumentationMaturityCascade,
  observeDocumentationMaturityCascadeTracker,
  selectDocumentationMaturityWorkUnit,
} from "../../src/maturity/cascade.js";
import { mapContentIndexToG3, mapRepositoryInventoryToG0 } from "../../src/maturity/evaluators.js";
import { buildRepositoryDiscoveryInventory } from "../../src/repository/inventory.js";
import { prepareRepositoryWorkspace } from "../../src/repository/workspace/materialize.js";

const root = process.argv[2];
if (!root) throw new Error("fixture repository is required");

const workspace = await prepareRepositoryWorkspace(root, "HEAD");
try {
  const repository = {
    sourcePath: workspace.sourcePath,
    requestedRevision: workspace.requestedRevision,
    revision: workspace.revision,
  };
  const inventory = await buildRepositoryDiscoveryInventory({ workspace });
  const mapping = mapRepositoryInventoryToG0({ inventory, repository });
  const g3Mapping =
    process.env.DOCSFAB_CASCADE_G3 === "1"
      ? await mapContentIndexToG3({
          repository,
          policyWorkspace: workspace,
          index: await buildContentIndexV2({ workspace }),
        })
      : null;
  const gateInputs = (["G0", "G1", "G2", "G3", "G4", "G5"] as const).map((gateId) => ({
    gateId,
    repository,
    policyWorkspace: gateId === "G0" ? null : workspace,
    mappings: gateId === "G0" ? [mapping] : gateId === "G3" && g3Mapping ? [g3Mapping] : [],
  }));
  const assessment = await assessDocumentationMaturityCascade({ gateInputs });
  globalThis.fetch = async (): Promise<Response> => {
    throw new Error("mutable global fetch must not be used");
  };
  Date.now = (): number => {
    throw new Error("mutable Date.now must not be used");
  };
  GitLabRoadmapReader.prototype.observe = async (): Promise<never[]> => {
    throw new Error("mutable public reader method must not be used");
  };

  try {
    const observation = await observeDocumentationMaturityCascadeTracker({ assessment, workspace });
    const selection = await selectDocumentationMaturityWorkUnit({
      assessment,
      trackerObservation: observation,
      policyWorkspace: workspace,
    });
    const substitutedAssessment = await assessDocumentationMaturityCascade({ gateInputs });
    let substitutionCode: string | null = null;
    try {
      await selectDocumentationMaturityWorkUnit({
        assessment: substitutedAssessment,
        trackerObservation: observation,
        policyWorkspace: workspace,
      });
    } catch (error) {
      substitutionCode =
        error && typeof error === "object" && "code" in error ? String(error.code) : "unknown";
    }
    process.stdout.write(
      `${JSON.stringify({
        state: selection.outcome.state,
        gateId: selection.outcome.gateId,
        workUnitFingerprint: selection.outcome.workUnit?.workUnitFingerprint ?? null,
        substitutionCode,
        observationSha256: observation.observationSha256,
      })}\n`,
    );
  } catch (error) {
    process.stdout.write(
      `${JSON.stringify({
        errorCode:
          error && typeof error === "object" && "code" in error ? String(error.code) : "unknown",
      })}\n`,
    );
  }
} finally {
  await workspace.dispose();
}
