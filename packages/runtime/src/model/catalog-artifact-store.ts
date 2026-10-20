// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  pinAcceptanceEvidenceDirectory,
  writeAcceptanceJsonExclusive,
  type AcceptanceEvidenceDirectory,
  type AcceptanceEvidenceWriteOptions,
} from "../acceptance-evidence.js";
import type { ModelCatalogObservationV1 } from "./catalog-contracts.js";
import {
  decodeModelCatalogApprovalAuthorization,
  finalizeModelCatalogObservationProvenance,
  type ModelCatalogApprovalAuthorizationV1,
  type ModelCatalogApprovalEvidenceV1,
  type ModelCatalogObservationProvenanceV1,
  type TrustedModelCatalogApprovalAuthority,
} from "./catalog-provenance.js";

export interface ModelCatalogArtifactDirectory {
  readonly evidenceDirectory: AcceptanceEvidenceDirectory;
}

export class ModelCatalogArtifactStoreError extends Error {
  public readonly code = "model-catalog-artifact-store-rejected" as const;

  public constructor() {
    super("Model catalog artifact storage was rejected.");
    this.name = "ModelCatalogArtifactStoreError";
  }
}

/** Pin an existing owner-only directory; this API never repairs unsafe permissions. */
export async function pinModelCatalogArtifactDirectory(
  path: string,
): Promise<ModelCatalogArtifactDirectory> {
  try {
    return { evidenceDirectory: await pinAcceptanceEvidenceDirectory(path) };
  } catch {
    throw new ModelCatalogArtifactStoreError();
  }
}

/**
 * Persist only the normalized allowlisted observation projection. Provider raw
 * payloads are intentionally absent from this API and are never serialized.
 */
export async function retainModelCatalogObservation(input: {
  directory: ModelCatalogArtifactDirectory;
  file: string;
  observation: ModelCatalogObservationV1;
  sourcePath: string;
  writeOptions?: AcceptanceEvidenceWriteOptions;
}): Promise<ModelCatalogObservationProvenanceV1> {
  try {
    const artifact = finalizeModelCatalogObservationProvenance(input);
    await writeAcceptanceJsonExclusive(
      input.directory.evidenceDirectory,
      input.file,
      artifact,
      input.writeOptions,
    );
    return artifact;
  } catch {
    throw new ModelCatalogArtifactStoreError();
  }
}

export async function retainModelCatalogApprovalAuthorization(input: {
  directory: ModelCatalogArtifactDirectory;
  file: string;
  authorization: ModelCatalogApprovalAuthorizationV1;
  approvalEvidence: ModelCatalogApprovalEvidenceV1;
  authority: TrustedModelCatalogApprovalAuthority;
  writeOptions?: AcceptanceEvidenceWriteOptions;
}): Promise<ModelCatalogApprovalAuthorizationV1> {
  try {
    const artifact = decodeModelCatalogApprovalAuthorization(
      input.authorization,
      input.approvalEvidence,
      input.authority,
    );
    await writeAcceptanceJsonExclusive(
      input.directory.evidenceDirectory,
      input.file,
      artifact,
      input.writeOptions,
    );
    return artifact;
  } catch {
    throw new ModelCatalogArtifactStoreError();
  }
}
