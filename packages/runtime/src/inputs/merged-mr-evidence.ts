// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Process-local source observations for date-scoped merged-MR diffs.
 *
 * GitLab diffs are not tracked repository files, so they cannot go through the
 * `--source` extractors. This producer mints text/plain observations that the
 * `docsfab_read_source` tools can serve; it registers no `--source` media type.
 */

import { canonicalDigest } from "../content-ir/canonical.js";
import { registerTrackedRepositorySourceInput } from "./access.js";
import type { ExternalInputHostCapability } from "./contracts.js";
import {
  createSourceBinding,
  createSourceObservation,
  digestSourceProducerScopes,
  type SourceBindingV1,
  type SourceObservationV1,
  type SourceRepositoryBindingV1,
} from "./source-evidence.js";
import {
  extractSourceRepresentation,
  sha256Bytes,
  type SourceExtractionSegmentV1,
  type SourceExtractorAdapterV1,
  type SourceExtractionRequestV1,
} from "./source-extraction.js";
import type { GitLabMergedMrDiffBundleV1 } from "./merged-mr-gitlab.js";
import type { MergedMrSelectedV1 } from "./merged-mr-selection.js";

export const GITLAB_MERGED_MR_PRODUCER_ID = "gitlab-merged-mr" as const;
export const GITLAB_MERGED_MR_PRODUCER_VERSION = "1" as const;
export const GITLAB_MERGED_MR_DIFF_MEDIA_TYPE = "text/plain" as const;

/**
 * Splits a diff into spans of whole lines, so a step reads a large diff in
 * windows, and the write step's share of its budget reaches into it, rather
 * than reading the whole diff or none of it.
 */
export const gitlabMergedMrDiffExtractorAdapter: SourceExtractorAdapterV1 = Object.freeze({
  id: "docsfab-gitlab-mr-diff",
  version: "2",
  locatorKind: "text",
  mediaTypes: Object.freeze([GITLAB_MERGED_MR_DIFF_MEDIA_TYPE]),
  defaultOptions: Object.freeze({}),
  extract(request: SourceExtractionRequestV1) {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(request.bytes);
    // A diff at the derivative byte ceiling then stays within the span ceiling.
    const targetBytes = Math.ceil(request.limits.maxDerivativeBytes / request.limits.maxSpans);
    return { segments: wholeLineChunks(text, targetBytes), limitations: [] };
  },
});

/**
 * Chunks of whole lines, each at least `targetBytes` long except the last, cut
 * only at a newline. Rejoined with the newlines they were cut at, the chunks are
 * the text exactly, blank lines included, so every byte of the diff stays in a
 * span. A line longer than the target is a chunk of its own.
 */
function wholeLineChunks(text: string, targetBytes: number): SourceExtractionSegmentV1[] {
  const segments: SourceExtractionSegmentV1[] = [];
  const lines = text.split("\n");
  let chunk: string[] = [];
  let chunkBytes = 0;
  let startByte = 0;
  const flush = () => {
    const chunkText = chunk.join("\n");
    const bytes = Buffer.byteLength(chunkText, "utf8");
    segments.push({
      text: chunkText,
      locator: { kind: "text", startByte, endByte: startByte + bytes },
    });
    // The newline the chunk was cut at belongs to no span.
    startByte += bytes + 1;
    chunk = [];
    chunkBytes = 0;
  };
  lines.forEach((line, index) => {
    chunkBytes += Buffer.byteLength(line, "utf8") + (chunk.length > 0 ? 1 : 0);
    chunk.push(line);
    if (chunkBytes >= targetBytes && index < lines.length - 1) flush();
  });
  const previous = segments.at(-1);
  if (chunk.length === 1 && chunk[0] === "" && previous) {
    // Only the text's final newline is left: it closes the chunk before it.
    previous.text = `${previous.text}\n`;
    if (previous.locator.kind === "text") previous.locator.endByte += 1;
  } else {
    flush();
  }
  return segments;
}

export interface MergedMrDiffOriginalV1 {
  readonly iid: number;
  readonly repositoryPath: string;
  readonly canonicalLocator: string;
  readonly bytes: Uint8Array;
  readonly truncated: boolean;
}

export function renderMergedMrDiffOriginal(
  selected: MergedMrSelectedV1,
  bundle: GitLabMergedMrDiffBundleV1,
): MergedMrDiffOriginalV1 {
  const lines = [
    `# GitLab merge request !${selected.iid}`,
    `# merged_at: ${selected.mergedAt}`,
    `# target_branch: ${selected.targetBranch}`,
    `# commit: ${selected.commitSha ?? "none"}`,
    `# provenance: ${selected.commitProvenance}`,
    ...(selected.evidenceGaps.length > 0
      ? [`# evidence_gaps: ${selected.evidenceGaps.join(",")}`]
      : []),
    ...(bundle.truncated ? ["# limitation: truncated-or-collapsed-diff"] : []),
    "",
  ];
  if (bundle.files.length === 0) {
    lines.push("(no file diffs returned)");
  } else {
    for (const file of bundle.files) {
      const path = file.newPath ?? file.oldPath ?? "(unnamed path)";
      lines.push(`--- ${file.oldPath ?? "/dev/null"}`);
      lines.push(`+++ ${file.newPath ?? "/dev/null"}`);
      if (file.tooLarge || file.collapsed) {
        lines.push(`# ${path} was truncated or collapsed by GitLab`);
      }
      if (file.diff && file.diff.length > 0) {
        lines.push(file.diff);
      }
      lines.push("");
    }
  }
  const body = `${lines.join("\n")}\n`;
  return {
    iid: selected.iid,
    repositoryPath: `gitlab-mr/${selected.iid}.diff`,
    canonicalLocator: `gitlab-merged-mr:!${selected.iid}`,
    bytes: new TextEncoder().encode(body),
    truncated: bundle.truncated || selected.evidenceGaps.includes("truncated-source-page"),
  };
}

export function digestGitlabMergedMrProducerScope(input: {
  readonly repository: SourceRepositoryBindingV1;
  readonly selectedIids: readonly number[];
}): string {
  return canonicalDigest({
    schemaVersion: 1 as const,
    kind: "docsfab-gitlab-merged-mr-read-scope" as const,
    producerId: GITLAB_MERGED_MR_PRODUCER_ID,
    producerVersion: GITLAB_MERGED_MR_PRODUCER_VERSION,
    repositoryIdentitySha256: input.repository.identitySha256,
    selectedIids: [...input.selectedIids].sort((left, right) => left - right),
  });
}

export interface AcquiredMergedMrDiffBindingV1 {
  readonly binding: SourceBindingV1;
  readonly acquired: readonly {
    readonly observation: SourceObservationV1;
    readonly representation: SourceObservationV1["representations"][number];
    readonly derivative: Uint8Array;
    readonly repositoryPath: string;
  }[];
  readonly producerScopes: ReadonlyArray<{ producerId: string; scopeSha256: string }>;
}

export async function acquireMergedMrDiffBinding(input: {
  readonly originals: readonly MergedMrDiffOriginalV1[];
  readonly externalInputs: ExternalInputHostCapability;
  readonly runIdSha256: string;
  readonly repository: SourceRepositoryBindingV1;
  readonly requestSha256: string;
  readonly hostPolicySha256: string;
  readonly observedAt: string;
}): Promise<AcquiredMergedMrDiffBindingV1> {
  if (input.originals.length === 0) {
    throw new Error("Merged-MR diff acquisition requires at least one original.");
  }
  const scopeSha256 = digestGitlabMergedMrProducerScope({
    repository: input.repository,
    selectedIids: input.originals.map((entry) => entry.iid),
  });
  const acquired: AcquiredMergedMrDiffBindingV1["acquired"][number][] = [];
  for (const original of input.originals) {
    const extracted = await extractSourceRepresentation({
      adapter: gitlabMergedMrDiffExtractorAdapter,
      bytes: original.bytes,
      mediaType: GITLAB_MERGED_MR_DIFF_MEDIA_TYPE,
    });
    const originIdSha256 = canonicalDigest({
      schemaVersion: 1 as const,
      kind: "docsfab-gitlab-merged-mr-origin" as const,
      repositoryIdentitySha256: input.repository.identitySha256,
      canonicalLocator: original.canonicalLocator,
    });
    const observationId = `obs-${canonicalDigest({
      schemaVersion: 1 as const,
      kind: "docsfab-source-observation-id" as const,
      originIdSha256,
      revision: input.repository.revision,
      originalSha256: extracted.originalSha256,
      representationSha256: extracted.representation.representationSha256,
    })}`;
    const inputId = `input-${canonicalDigest({
      schemaVersion: 1 as const,
      kind: "docsfab-source-input-id" as const,
      observationId,
    })}`;
    const { entrySha256 } = registerTrackedRepositorySourceInput(input.externalInputs, {
      inputId,
      canonicalLocator: original.canonicalLocator,
      safeTitle: `GitLab merge request !${original.iid}`,
      contentDigestSha256: sha256Bytes(extracted.derivative),
      revision: input.repository.revision,
      producerId: GITLAB_MERGED_MR_PRODUCER_ID,
      producerVersion: GITLAB_MERGED_MR_PRODUCER_VERSION,
    });
    const observation = createSourceObservation({
      observationId,
      originIdSha256,
      inputId,
      registrationSha256: entrySha256,
      runIdSha256: input.runIdSha256,
      repository: input.repository,
      requestSha256: input.requestSha256,
      producerId: GITLAB_MERGED_MR_PRODUCER_ID,
      producerVersion: GITLAB_MERGED_MR_PRODUCER_VERSION,
      producerScopeSha256: scopeSha256,
      acquisitionReceiptSha256: canonicalDigest({
        schemaVersion: 1 as const,
        kind: "docsfab-gitlab-merged-mr-acquisition-receipt" as const,
        producerId: GITLAB_MERGED_MR_PRODUCER_ID,
        iid: original.iid,
        originalSha256: extracted.originalSha256,
        representationSha256: extracted.representation.representationSha256,
        observedAt: input.observedAt,
      }),
      observedAt: input.observedAt,
      original: {
        sha256: extracted.originalSha256,
        byteLength: original.bytes.byteLength,
        mediaType: GITLAB_MERGED_MR_DIFF_MEDIA_TYPE,
        locatorSha256: canonicalDigest({
          schemaVersion: 1 as const,
          kind: "docsfab-gitlab-merged-mr-locator" as const,
          canonicalLocator: original.canonicalLocator,
        }),
        version: {
          kind: "content-digest",
          contentDigestSha256: extracted.originalSha256,
        },
        repositoryPath: original.repositoryPath,
      },
      representations: [extracted.representation],
    });
    acquired.push({
      observation,
      representation: extracted.representation,
      derivative: extracted.derivative,
      repositoryPath: original.repositoryPath,
    });
  }
  const producerScopes = Object.freeze([{ producerId: GITLAB_MERGED_MR_PRODUCER_ID, scopeSha256 }]);
  const binding = createSourceBinding({
    runIdSha256: input.runIdSha256,
    repository: input.repository,
    requestSha256: input.requestSha256,
    hostPolicySha256: input.hostPolicySha256,
    producerScopeSha256: digestSourceProducerScopes(producerScopes),
    parentBindingSha256: null,
    observations: acquired.map((entry) => ({
      observationId: entry.observation.observationId,
      observationSha256: entry.observation.observationSha256,
    })),
    requiredObservationIds: acquired.map((entry) => entry.observation.observationId),
  });
  return {
    binding,
    acquired: Object.freeze(acquired),
    producerScopes,
  };
}

export function documentationAndChangedPaths(bundles: readonly GitLabMergedMrDiffBundleV1[]): {
  readonly documentationPaths: readonly string[];
  readonly changedSourcePaths: readonly string[];
} {
  const documentation = new Set<string>();
  const changed = new Set<string>();
  for (const bundle of bundles) {
    for (const file of bundle.files) {
      const path = file.newPath ?? file.oldPath;
      if (!path || path.startsWith("/") || path.includes("..")) continue;
      if (isDocumentationPath(path)) documentation.add(path);
      else changed.add(path);
    }
  }
  return {
    documentationPaths: Object.freeze([...documentation].sort()),
    changedSourcePaths: Object.freeze([...changed].sort()),
  };
}

function isDocumentationPath(path: string): boolean {
  return (
    /(?:^|\/)(?:docs?|documentation|fern)\//iu.test(path) ||
    /(?:^|\/)(?:readme|changelog|contributing)(?:\.[A-Za-z0-9]+)?$/iu.test(path) ||
    /\.(?:md|mdx|rst|adoc)$/iu.test(path)
  );
}
