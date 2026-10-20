// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** Callback-local H source observations for the PR custody's single binding. */
import { createHash } from "node:crypto";
import { canonicalDigest } from "../../content-ir/canonical.js";
import { recordExternalInputAccess } from "../../inputs/access.js";
import { citeExternalInput } from "../../inputs/citation.js";
import {
  acquireTrackedSourceObservations,
  type TrackedSourceReaderV1,
} from "../../inputs/source-acquisition.js";
import { SOURCE_EXACT_ORIGINAL_FORM } from "../../inputs/source-evidence.js";
import {
  createGithubPrHOriginalRepresentation,
  GithubPrCustodyError,
  type GithubPrHSourceHostContext,
  type GithubPrHSourceObservations,
} from "../../inputs/local/github-pr-custody.js";
import { sourceExtractionLimits } from "../../inputs/source-extraction.js";

export function failCliPrCustody(code: string): never {
  throw new GithubPrCustodyError(code);
}

export async function acquireCliPrHSourceObservations(input: {
  readonly host: GithubPrHSourceHostContext;
  readonly selection: readonly string[];
  readonly reader: TrackedSourceReaderV1;
  readonly readScope: readonly string[];
}): Promise<GithubPrHSourceObservations> {
  const { host } = input;
  const acquired = await acquireTrackedSourceObservations({
    reader: input.reader,
    externalInputs: host.externalInputs,
    selection: input.selection,
    readScope: input.readScope,
    runIdSha256: host.runIdSha256,
    repository: host.repository,
    requestSha256: host.requestSha256,
    hostPolicySha256: host.policy.policySha256,
    observedAt: host.observedAt,
    limits: sourceExtractionLimits(),
    signal: host.signal,
    createOriginalRepresentation: (bytes) =>
      createGithubPrHOriginalRepresentation(bytes, host.toolOutputCapBytes),
  });
  const entries = new Map(
    acquired.acquired.map((entry) => [entry.observation.observationId, entry]),
  );
  const citations = new Map<string, string>();
  let disposed = false;
  function entry(observationId: string, representationId: string) {
    if (disposed) failCliPrCustody("github-pr-custody-disposed");
    const row = entries.get(observationId);
    const representation = row?.observation.representations.find(
      (candidate) => candidate.representationId === representationId,
    );
    if (!row || !representation) failCliPrCustody("github-pr-h-source-substituted");
    return { row, representation };
  }
  function inputId(observationId: string, representationId: string): string {
    const { row, representation } = entry(observationId, representationId);
    return representation.form === SOURCE_EXACT_ORIGINAL_FORM
      ? (row.observation.originalInputId ?? row.observation.inputId)
      : row.observation.inputId;
  }
  return {
    observations: acquired.acquired.map((row) => row.observation),
    producerScopes: acquired.producerScopes,
    readScope: acquired.readScope,
    handlers: {
      resolveDerivative({ observationId, representationId }) {
        const { row, representation } = entry(observationId, representationId);
        return representation.form === SOURCE_EXACT_ORIGINAL_FORM ? undefined : row.derivative;
      },
      resolveOriginal({ observationId, representationId }) {
        const { row, representation } = entry(observationId, representationId);
        return representation.form === SOURCE_EXACT_ORIGINAL_FORM ? row.original : undefined;
      },
      recordAccess({ observationId, representationId, stepId, spanIds }) {
        const { representation } = entry(observationId, representationId);
        return recordExternalInputAccess(host.externalInputs, {
          inputId: inputId(observationId, representationId),
          stepId,
          outcome: "opened",
          observedContentDigestSha256: representation.sha256,
          accessorId: "docsfab-source-evidence",
          evidenceSha256s: [
            canonicalDigest({
              schemaVersion: 1 as const,
              kind: "docsfab-source-span-selection" as const,
              representationId,
              spanIds: [...spanIds].sort(),
            }),
          ],
        }).observationSha256;
      },
      recordCitation({
        observationId,
        representationId,
        stepId,
        accessObservationSha256s,
        supportedClaimSha256,
      }) {
        const selectedInputId = inputId(observationId, representationId);
        let first: string | undefined;
        for (const accessObservationSha256 of [...accessObservationSha256s].sort()) {
          const key = createHash("sha256")
            .update(
              `${selectedInputId}|${stepId}|${supportedClaimSha256}|${accessObservationSha256}`,
            )
            .digest("hex");
          let digest = citations.get(key);
          if (!digest) {
            const cited = citeExternalInput(host.externalInputs, {
              inputId: selectedInputId,
              stepId,
              role: "evidence",
              supportedClaimSha256,
              accessObservationSha256,
            });
            if (cited.kind !== "docsfab-external-input-citation") {
              failCliPrCustody("github-pr-h-source-citation-detached");
            }
            digest = cited.citationSha256;
            citations.set(key, digest);
          }
          first ??= digest;
        }
        if (!first) failCliPrCustody("github-pr-h-source-citation-access-missing");
        return first;
      },
      dispose() {
        if (disposed) return;
        disposed = true;
        for (const row of entries.values()) {
          row.original.fill(0);
          row.derivative.fill(0);
        }
        entries.clear();
        citations.clear();
      },
    },
  };
}
